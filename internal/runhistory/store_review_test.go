package runhistory

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"firn/internal/filesystem"
	"github.com/google/uuid"
)

type phase2CTrackingFS struct {
	filesystem.FileSystem
	mu    sync.Mutex
	reads map[string]int
}

func (f *phase2CTrackingFS) count(path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads[path]++
}

func (f *phase2CTrackingFS) ReadFile(path string) ([]byte, error) {
	f.count(path)
	return f.FileSystem.ReadFile(path)
}

func (f *phase2CTrackingFS) ReadFileLimited(path string, limit int64) ([]byte, fs.FileInfo, error) {
	f.count(path)
	info, err := f.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if info.Size() > limit {
		return nil, info, errors.New("file exceeds limit")
	}
	data, err := f.FileSystem.ReadFile(path)
	return data, info, err
}

func (f *phase2CTrackingFS) ReadDirLimited(path string, limit int) ([]fs.DirEntry, error) {
	entries, err := f.ReadDir(path)
	if len(entries) > limit {
		return nil, errors.New("directory exceeds limit")
	}
	return entries, err
}

func (f *phase2CTrackingFS) readCount(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads[path]
}

type phase2CStaleSizeFS struct {
	filesystem.FileSystem
	mu              sync.Mutex
	staleSizes      map[string]int64
	recordReads     map[string]int
	successfulBytes int64
}

func (f *phase2CStaleSizeFS) ReadFileLimited(path string, limit int64) ([]byte, fs.FileInfo, error) {
	data, info, err := filesystem.ReadFileBounded(f.FileSystem, path, limit)
	if isPhase2CCanonicalPath(path) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.recordReads[path]++
		if err == nil {
			f.successfulBytes += int64(len(data))
		}
	}
	return data, info, err
}

func (f *phase2CStaleSizeFS) ReadDirLimited(path string, limit int) ([]fs.DirEntry, error) {
	entries, err := filesystem.ReadDirBounded(f.FileSystem, path, limit)
	if err != nil {
		return nil, err
	}
	for i, entry := range entries {
		staleSize, ok := f.staleSizes[filepath.Join(path, entry.Name())]
		if ok {
			entries[i] = phase2CStaleSizeDirEntry{DirEntry: entry, size: staleSize}
		}
	}
	return entries, nil
}

func (f *phase2CStaleSizeFS) recordReadCount(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.recordReads[path]
}

func (f *phase2CStaleSizeFS) readTotals() (int, int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var reads int
	for _, count := range f.recordReads {
		reads += count
	}
	return reads, f.successfulBytes
}

type phase2CStaleSizeDirEntry struct {
	fs.DirEntry
	size int64
}

func (e phase2CStaleSizeDirEntry) Info() (fs.FileInfo, error) {
	info, err := e.DirEntry.Info()
	if err != nil {
		return nil, err
	}
	return phase2CStaleSizeFileInfo{FileInfo: info, size: e.size}, nil
}

type phase2CStaleSizeFileInfo struct {
	fs.FileInfo
	size int64
}

func (i phase2CStaleSizeFileInfo) Size() int64 {
	return i.size
}

type phase2CIndexRenameFailureFS struct {
	filesystem.FileSystem
}

type phase2CBlockingFirstMkdirFS struct {
	filesystem.FileSystem
	mu      sync.Mutex
	blocked bool
	entered chan struct{}
	release chan struct{}
}

func (f *phase2CBlockingFirstMkdirFS) MkdirAll(path string, perm fs.FileMode) error {
	f.mu.Lock()
	shouldBlock := !f.blocked
	f.blocked = true
	f.mu.Unlock()
	if shouldBlock {
		close(f.entered)
		<-f.release
	}
	return f.FileSystem.MkdirAll(path, perm)
}

func (f *phase2CIndexRenameFailureFS) Rename(oldPath, newPath string) error {
	if filepath.Base(newPath) == "index.json" {
		return errors.New("index rename failed")
	}
	return f.FileSystem.Rename(oldPath, newPath)
}

type phase2CRemoveRaceFS struct {
	filesystem.FileSystem
	once sync.Once
}

func (f *phase2CRemoveRaceFS) Remove(path string) error {
	if isPhase2CCanonicalPath(path) {
		var raced bool
		f.once.Do(func() {
			raced = true
			_ = f.FileSystem.Remove(path)
		})
		if raced {
			return fs.ErrNotExist
		}
	}
	return f.FileSystem.Remove(path)
}

type phase2CRemoveFailureFS struct {
	filesystem.FileSystem
	once sync.Once
}

func (f *phase2CRemoveFailureFS) Remove(path string) error {
	if isPhase2CCanonicalPath(path) {
		var failed bool
		f.once.Do(func() { failed = true })
		if failed {
			return errors.New("canonical remove failed")
		}
	}
	return f.FileSystem.Remove(path)
}

func isPhase2CCanonicalPath(path string) bool {
	name := filepath.Base(path)
	if name == "index.json" || !strings.HasSuffix(name, ".json") {
		return false
	}
	id, err := uuid.Parse(strings.TrimSuffix(name, ".json"))
	return err == nil && id.Version() == 7
}

func TestStorePhase2C_StalledWorkspaceDoesNotBlockAnotherWorkspace(t *testing.T) {
	blockingFS := &phase2CBlockingFirstMkdirFS{
		FileSystem: filesystem.NewOS(),
		entered:    make(chan struct{}),
		release:    make(chan struct{}),
	}
	store := NewStore(blockingFS, t.TempDir())
	appendA := make(chan error, 1)
	go func() {
		_, err := store.Append(filepath.FromSlash("/workspace-a"), phase2COrdinaryInput("build", 100, "A"))
		appendA <- err
	}()
	<-blockingFS.entered

	appendB := make(chan error, 1)
	go func() {
		_, err := store.Append(filepath.FromSlash("/workspace-b"), phase2COrdinaryInput("build", 200, "B"))
		appendB <- err
	}()
	select {
	case err := <-appendB:
		if err != nil {
			close(blockingFS.release)
			<-appendA
			t.Fatalf("Append(B): %v", err)
		}
	case <-time.After(time.Second):
		close(blockingFS.release)
		<-appendA
		t.Fatal("workspace B history blocked behind stalled workspace A")
	}

	close(blockingFS.release)
	if err := <-appendA; err != nil {
		t.Fatalf("Append(A): %v", err)
	}
}

func TestStorePhase2C_UnreadableOwnedBytesWarnWithoutPruningHealthyHistory(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	saved, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 7_000, "keep me\n"))
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	badID, err := uuid.NewV7()
	if err != nil {
		t.Fatalf("NewV7: %v", err)
	}
	badPath := filepath.Join(workspaceDir, badID.String()+".json")
	if err := os.WriteFile(badPath, []byte(`{"secret":"retained output"`), 0o600); err != nil {
		t.Fatalf("write corrupt canonical: %v", err)
	}
	if err := os.Truncate(badPath, phase2CWorkspaceTarget+1); err != nil {
		t.Fatalf("inflate corrupt canonical: %v", err)
	}
	foreignPath := filepath.Join(workspaceDir, "foreign-cache.bin")
	if err := os.WriteFile(foreignPath, []byte("not owned"), 0o600); err != nil {
		t.Fatalf("write foreign file: %v", err)
	}

	snapshot, err := NewStore(filesystem.NewOS(), home).Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snapshot.Warning == "" {
		t.Fatal("unreadable owned bytes did not surface a warning")
	}
	if len(snapshot.Summaries) != 1 ||
		snapshot.Summaries[0].HistoryID != saved.HistoryID ||
		!snapshot.Summaries[0].OutputAvailable {
		t.Fatalf("healthy history was pruned for unrelated bytes: %#v", snapshot.Summaries)
	}
	if _, err := os.Stat(foreignPath); err != nil {
		t.Fatalf("unmanaged file was removed: %v", err)
	}
}

func TestStorePhase2C_ClearAllPurgesUnreadableCanonicalAndOwnedTemps(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	saved, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 7_100, "clear me\n"))
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	badID, err := uuid.NewV7()
	if err != nil {
		t.Fatalf("NewV7: %v", err)
	}
	badPath := filepath.Join(workspaceDir, badID.String()+".json")
	if err := os.WriteFile(badPath, []byte(`{"secret":"retained output"`), 0o600); err != nil {
		t.Fatalf("write corrupt canonical: %v", err)
	}
	tempPath := filepath.Join(workspaceDir, saved.HistoryID+".json.0123456789abcdef")
	if err := os.WriteFile(tempPath, []byte(`{"secret":"crash output"}`), 0o600); err != nil {
		t.Fatalf("write owned temp: %v", err)
	}

	if err := NewStore(filesystem.NewOS(), home).ClearAll(phase2CWorkspacePath); err != nil {
		t.Fatalf("ClearAll: %v", err)
	}
	if _, err := os.Stat(badPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("corrupt canonical survived ClearAll: %v", err)
	}
	if _, err := os.Stat(tempPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("owned temp survived ClearAll: %v", err)
	}
	record, err := store.GetRecord(phase2CWorkspacePath, saved.HistoryID)
	if err != nil {
		t.Fatalf("GetRecord: %v", err)
	}
	if record.OutputAvailable || len(record.Entries) != 0 || record.WorkingDir != "" {
		t.Fatalf("valid record was not tombstoned: %#v", record)
	}
}

func TestStorePhase2C_SnapshotCleansOnlyStaleOwnedTemps(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	saved, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 7_200, "ok\n"))
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	stalePath := filepath.Join(workspaceDir, saved.HistoryID+".json.1111111111111111")
	freshPath := filepath.Join(workspaceDir, "index.json.2222222222222222")
	if err := os.WriteFile(stalePath, []byte("stale"), 0o600); err != nil {
		t.Fatalf("write stale temp: %v", err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(stalePath, old, old); err != nil {
		t.Fatalf("age stale temp: %v", err)
	}
	if err := os.WriteFile(freshPath, []byte("fresh"), 0o600); err != nil {
		t.Fatalf("write fresh temp: %v", err)
	}

	snapshot, err := NewStore(filesystem.NewOS(), home).Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snapshot.Warning == "" {
		t.Fatal("fresh owned temp did not surface a warning")
	}
	if _, err := os.Stat(stalePath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("stale owned temp survived reconciliation: %v", err)
	}
	if _, err := os.Stat(freshPath); err != nil {
		t.Fatalf("fresh owned temp was removed: %v", err)
	}
}

func TestStorePhase2C_IndexedUnchangedRecordIsNotRereadDuringStaleReconciliation(t *testing.T) {
	home := t.TempDir()
	base := filesystem.NewOS()
	store := NewStore(base, home)
	savedA, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 7_300, "a\n"))
	if err != nil {
		t.Fatalf("Append A: %v", err)
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	indexPath := filepath.Join(workspaceDir, "index.json")
	staleIndex, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatalf("read one-record index: %v", err)
	}
	savedB, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 7_400, "b\n"))
	if err != nil {
		t.Fatalf("Append B: %v", err)
	}
	if err := os.WriteFile(indexPath, staleIndex, 0o600); err != nil {
		t.Fatalf("restore stale index: %v", err)
	}

	tracking := &phase2CTrackingFS{FileSystem: base, reads: map[string]int{}}
	snapshot, err := NewStore(tracking, home).Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snapshot.Summaries) != 2 {
		t.Fatalf("summary count = %d, want 2", len(snapshot.Summaries))
	}
	pathA := filepath.Join(workspaceDir, savedA.HistoryID+".json")
	pathB := filepath.Join(workspaceDir, savedB.HistoryID+".json")
	if got := tracking.readCount(pathA); got != 0 {
		t.Fatalf("unchanged indexed record reads = %d, want 0", got)
	}
	if got := tracking.readCount(pathB); got != 1 {
		t.Fatalf("missing index record reads = %d, want 1", got)
	}
}

func TestStorePhase2C_ReconciliationUsesOpenedFileSizesForAggregateReadBudget(t *testing.T) {
	home := t.TempDir()
	base := filesystem.NewOS()
	store := NewStore(base, home)
	cached, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("cached", 7_450, "cached\n"))
	if err != nil {
		t.Fatalf("seed cached record: %v", err)
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	cachedPath := filepath.Join(workspaceDir, cached.HistoryID+".json")

	staleSizes := map[string]int64{}
	for i := 0; i < 3; i++ {
		historyID, err := uuid.NewV7()
		if err != nil {
			t.Fatalf("NewV7: %v", err)
		}
		path := filepath.Join(workspaceDir, historyID.String()+".json")
		record := Record{
			Version: storeVersion,
			Summary: Summary{
				HistoryID:       historyID.String(),
				Kind:            RecordKindOrdinary,
				ProfileID:       "missing-" + string(rune('a'+i)),
				ProfileName:     "missing",
				State:           "completed",
				StartedAt:       int64(7_500 + i),
				CompletedAt:     int64(7_500 + i),
				OutputAvailable: true,
			},
			WorkingDir: phase2CWorkspacePath,
			Entries:    []OutputEntry{{Stream: "stdout", Text: "large\n", Timestamp: int64(7_500 + i)}},
		}
		phase2CWritePaddedRecord(t, path, record, maxRecordBytes)
		staleSizes[path] = 1
	}

	tracking := &phase2CStaleSizeFS{
		FileSystem:  base,
		staleSizes:  staleSizes,
		recordReads: map[string]int{},
	}
	snapshot, err := NewStore(tracking, home).Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if got := tracking.recordReadCount(cachedPath); got != 0 {
		t.Fatalf("unchanged indexed record reads = %d, want 0", got)
	}
	reads, bytes := tracking.readTotals()
	if reads != 2 {
		t.Fatalf("changed record reads = %d, want 2 before aggregate budget exhaustion", reads)
	}
	if bytes != maxReconcileReadBytes {
		t.Fatalf("successful record read bytes = %d, want %d", bytes, maxReconcileReadBytes)
	}
	if snapshot.Warning == "" {
		t.Fatal("aggregate read budget exhaustion did not surface a warning")
	}
}

func TestStorePhase2C_DerivedIndexFailureAfterPublishReturnsCommittedSuccess(t *testing.T) {
	home := t.TempDir()
	base := filesystem.NewOS()
	store := NewStore(base, home)
	if _, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 7_500, "a\n")); err != nil {
		t.Fatalf("seed Append: %v", err)
	}

	failing := NewStore(&phase2CIndexRenameFailureFS{FileSystem: base}, home)
	saved, err := failing.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 7_600, "b\n"))
	if err != nil {
		t.Fatalf("Append returned an error after canonical publish: %v", err)
	}
	record, err := NewStore(base, home).GetRecord(phase2CWorkspacePath, saved.HistoryID)
	if err != nil || record.HistoryID != saved.HistoryID {
		t.Fatalf("committed canonical record = %#v, err = %v", record, err)
	}
}

func TestStorePhase2C_PruneNotExistRaceIsSuccessful(t *testing.T) {
	home := t.TempDir()
	base := filesystem.NewOS()
	store := NewStore(base, home)
	for i := 0; i < 50; i++ {
		if _, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", int64(8_000+i), "line\n")); err != nil {
			t.Fatalf("seed Append %d: %v", i, err)
		}
	}

	racing := NewStore(&phase2CRemoveRaceFS{FileSystem: base}, home)
	if _, err := racing.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 8_100, "line\n")); err != nil {
		t.Fatalf("Append lost a concurrent prune race: %v", err)
	}
	snapshot, err := NewStore(base, home).Snapshot(phase2CWorkspacePath)
	if err != nil || len(snapshot.Summaries) != 50 {
		t.Fatalf("post-race Snapshot = %#v, err = %v", snapshot, err)
	}
}

func TestStorePhase2C_SubstantivePostPublishFailureRollsBackNewCanonical(t *testing.T) {
	home := t.TempDir()
	base := filesystem.NewOS()
	store := NewStore(base, home)
	for i := 0; i < 50; i++ {
		if _, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", int64(9_000+i), "line\n")); err != nil {
			t.Fatalf("seed Append %d: %v", i, err)
		}
	}
	workspaceDir := phase2CWorkspaceDir(t, store)

	failing := NewStore(&phase2CRemoveFailureFS{FileSystem: base}, home)
	if _, err := failing.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 9_100, "line\n")); err == nil {
		t.Fatal("Append succeeded despite substantive retention failure")
	}
	if got := len(phase2CRecordFiles(t, workspaceDir)); got != 50 {
		t.Fatalf("canonical records after failed Append = %d, want 50", got)
	}
}

func TestStorePhase2C_AppendReturnsPostEnforcementSummary(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	for i := 1; i <= 5; i++ {
		if _, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", int64(10_000+i), "newer\n")); err != nil {
			t.Fatalf("seed Append %d: %v", i, err)
		}
	}

	saved, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 9_999, "oldest\n"))
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if saved.OutputAvailable {
		t.Fatalf("Append returned pre-enforcement rich summary: %#v", saved)
	}
	record, err := store.GetRecord(phase2CWorkspacePath, saved.HistoryID)
	if err != nil || record.OutputAvailable {
		t.Fatalf("retained record = %#v, err = %v", record, err)
	}
}

func phase2CWritePaddedRecord(t *testing.T, path string, record Record, size int64) {
	t.Helper()
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("Marshal record: %v", err)
	}
	if int64(len(data)) > size {
		t.Fatalf("record size = %d, want <= %d", len(data), size)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		t.Fatalf("write record: %v", err)
	}
	padding := make([]byte, 32<<10)
	for i := range padding {
		padding[i] = ' '
	}
	for remaining := size - int64(len(data)); remaining > 0; {
		chunk := int64(len(padding))
		if remaining < chunk {
			chunk = remaining
		}
		if _, err := file.Write(padding[:int(chunk)]); err != nil {
			_ = file.Close()
			t.Fatalf("pad record: %v", err)
		}
		remaining -= chunk
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close record: %v", err)
	}
}

func TestStorePhase2C_SmallIndexBudgetPrunesBeforeWriteWithoutWedging(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	store.indexByteLimit = 700

	for i := 0; i < 8; i++ {
		input := phase2COrdinaryInput("profile-"+strings.Repeat("x", 80)+string(rune('a'+i)), int64(11_000+i), "ok\n")
		input.ProfileName = strings.Repeat("name", 40)
		if _, err := store.Append(phase2CWorkspacePath, input); err != nil {
			t.Fatalf("Append %d wedged on index budget: %v", i, err)
		}
	}
	snapshot, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot after index pruning: %v", err)
	}
	if len(snapshot.Summaries) == 0 {
		t.Fatal("index budgeting pruned every summary")
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	info, err := os.Stat(filepath.Join(workspaceDir, "index.json"))
	if err != nil {
		t.Fatalf("Stat(index): %v", err)
	}
	if info.Size() > store.indexByteLimit {
		t.Fatalf("index size = %d, want <= %d", info.Size(), store.indexByteLimit)
	}
}
