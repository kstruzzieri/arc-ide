package runhistory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"

	"firn/internal/filesystem"
	"github.com/google/uuid"
)

const (
	phase2CMaxRecordBytes  = 10 << 20
	phase2CWorkspaceTarget = 20 << 20
)

var phase2CWorkspacePath = filepath.FromSlash("/repo")

// Golden, not recomputed. The workspace ID names a directory on disk in every
// install that has ever recorded a run; changing how it is derived orphans that
// history silently, with no error and no migration. Recomputing sha256 here
// would assert only that the code does what the code does. The value differs per
// platform because the derivation hashes the cleaned native path.
var phase2CWorkspaceIDForRepo = map[string]string{
	"windows": "c6642de6e88ccf8d", // sha256(`\repo`)[:8]
}[runtime.GOOS]

func init() {
	if phase2CWorkspaceIDForRepo == "" {
		phase2CWorkspaceIDForRepo = "816fc349d3faebf8" // sha256("/repo")[:8]
	}
}

func phase2CWorkspaceDir(t *testing.T, store *Store) string {
	t.Helper()
	dir, err := store.workspaceDir(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("workspaceDir: %v", err)
	}
	return dir
}

func phase2CExpectedWorkspaceDir(home string) string {
	return filepath.Join(home, "run-history", phase2CWorkspaceIDForRepo)
}

func phase2COrdinaryInput(profileID string, completedAt int64, text string) RecordInput {
	input := RecordInput{
		Kind:        RecordKindOrdinary,
		ProfileID:   profileID,
		ProfileName: "Build",
		State:       "success",
		ExitCode:    0,
		StartedAt:   completedAt - 100,
		CompletedAt: completedAt,
		WorkingDir:  phase2CWorkspacePath,
		Entries: []OutputEntry{{
			Stream:    "stdout",
			Text:      text,
			Timestamp: completedAt,
		}},
	}
	epochJSON, _ := json.Marshal(map[string]uint64{"workspaceEpoch": 77})
	_ = json.Unmarshal(epochJSON, &input)
	return input
}

func phase2CRecordFiles(t *testing.T, workspaceDir string) []string {
	t.Helper()
	entries, err := os.ReadDir(workspaceDir)
	if err != nil {
		t.Fatalf("ReadDir(%q): %v", workspaceDir, err)
	}
	var paths []string
	for _, entry := range entries {
		if entry.Name() != "index.json" && strings.HasSuffix(entry.Name(), ".json") {
			paths = append(paths, filepath.Join(workspaceDir, entry.Name()))
		}
	}
	sort.Strings(paths)
	return paths
}

func phase2CAssertNoSensitiveSchemaKeys(t *testing.T, value any) {
	t.Helper()
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "command") ||
				strings.Contains(lower, "env") ||
				lower == "pid" ||
				strings.Contains(lower, "runinstance") ||
				strings.Contains(lower, "workspaceepoch") ||
				strings.Contains(lower, "launchseq") {
				t.Fatalf("persisted history contains forbidden schema key %q", key)
			}
			phase2CAssertNoSensitiveSchemaKeys(t, child)
		}
	case []any:
		for _, child := range value {
			phase2CAssertNoSensitiveSchemaKeys(t, child)
		}
	}
}

func TestStorePhase2C_WritesPrivateVersionedLazyRecordAndDerivedIndex(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)

	input := phase2COrdinaryInput("build", 1_000, "ok\n")
	inputData, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("Marshal(input): %v", err)
	}
	var inputSchema map[string]any
	if err := json.Unmarshal(inputData, &inputSchema); err != nil {
		t.Fatalf("input is not valid JSON: %v", err)
	}
	if inputSchema["workspaceEpoch"] != float64(77) {
		t.Fatalf("input workspaceEpoch = %#v, want 77", inputSchema["workspaceEpoch"])
	}

	saved, err := store.Append(phase2CWorkspacePath, input)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	parsedID, err := uuid.Parse(saved.HistoryID)
	if err != nil || parsedID.Version() != 7 {
		t.Fatalf("history ID = %q, want UUIDv7: %v", saved.HistoryID, err)
	}

	workspaceDir := phase2CExpectedWorkspaceDir(home)
	if actual := phase2CWorkspaceDir(t, store); actual != workspaceDir {
		t.Fatalf("workspaceDir = %q, want %q", actual, workspaceDir)
	}
	dirInfo, err := os.Stat(workspaceDir)
	if err != nil {
		t.Fatalf("Stat(workspace history dir): %v", err)
	}
	// Windows reports writable directories as 0777 and cannot express POSIX 0700.
	if runtime.GOOS != "windows" && dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("workspace history dir mode = %v, want 0700", dirInfo.Mode().Perm())
	}
	recordPath := filepath.Join(workspaceDir, saved.HistoryID+".json")
	recordInfo, err := os.Stat(recordPath)
	if err != nil {
		t.Fatalf("Stat(record): %v", err)
	}
	// Windows reports writable files as 0666 and cannot express POSIX 0600.
	if runtime.GOOS != "windows" && recordInfo.Mode().Perm() != 0o600 {
		t.Fatalf("record mode = %v, want 0600", recordInfo.Mode().Perm())
	}

	data, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatalf("ReadFile(record): %v", err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatalf("record is not valid JSON: %v", err)
	}
	if schema["version"] != float64(1) {
		t.Fatalf("record version = %#v, want 1", schema["version"])
	}
	phase2CAssertNoSensitiveSchemaKeys(t, schema)

	snapshot, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snapshot.Version != 1 || len(snapshot.Summaries) != 1 {
		t.Fatalf("snapshot = %#v, want v1 with one summary", snapshot)
	}
	indexData, err := os.ReadFile(filepath.Join(workspaceDir, "index.json"))
	if err != nil {
		t.Fatalf("ReadFile(index): %v", err)
	}
	indexInfo, err := os.Stat(filepath.Join(workspaceDir, "index.json"))
	if err != nil {
		t.Fatalf("Stat(index): %v", err)
	}
	// Windows reports writable files as 0666 and cannot express POSIX 0600.
	if runtime.GOOS != "windows" && indexInfo.Mode().Perm() != 0o600 {
		t.Fatalf("index mode = %v, want 0600", indexInfo.Mode().Perm())
	}
	var indexSchema map[string]any
	if err := json.Unmarshal(indexData, &indexSchema); err != nil {
		t.Fatalf("index is not valid JSON: %v", err)
	}
	phase2CAssertNoSensitiveSchemaKeys(t, indexSchema)
	if _, hasEntries := indexSchema["entries"]; hasEntries {
		t.Fatalf("derived index eagerly contains rich output: %s", indexData)
	}
	record, err := store.GetRecord(phase2CWorkspacePath, saved.HistoryID)
	if err != nil || len(record.Entries) != 1 || record.Entries[0].Text != "ok\n" {
		t.Fatalf("lazy GetRecord = %#v, err = %v", record, err)
	}
}

func TestStorePhase2C_AppendRejectsInvalidBoundedRecordBeforePublishing(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	input := phase2COrdinaryInput("build", 1_500, "must not persist\n")
	input.State = ""

	if _, err := store.Append(phase2CWorkspacePath, input); err == nil {
		t.Error("Append accepted an invalid persisted record")
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	if _, err := os.Stat(workspaceDir); err == nil {
		if files := phase2CRecordFiles(t, workspaceDir); len(files) != 0 {
			t.Errorf("Append published %d canonical record files, want 0", len(files))
		}
	} else if !os.IsNotExist(err) {
		t.Fatalf("stat run history workspace: %v", err)
	}
	snapshot, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snapshot.Summaries) != 0 || snapshot.Warning != "" {
		t.Fatalf("Snapshot = %#v; invalid input must remain unpublished without a corrupt warning", snapshot)
	}
}

func TestStorePhase2C_ReconcilesStaleIndexAndUsesStableSameMillisecondOrder(t *testing.T) {
	home := t.TempDir()
	first := NewStore(filesystem.NewOS(), home)
	second := NewStore(filesystem.NewOS(), home)
	inputA := phase2COrdinaryInput("build", 2_000, "a\n")
	inputB := phase2COrdinaryInput("build", 2_000, "b\n")

	savedA, err := first.Append(phase2CWorkspacePath, inputA)
	if err != nil {
		t.Fatalf("first Append: %v", err)
	}
	workspaceDir := phase2CWorkspaceDir(t, first)
	indexPath := filepath.Join(workspaceDir, "index.json")
	staleIndex, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatalf("read one-record index: %v", err)
	}
	savedB, err := second.Append(phase2CWorkspacePath, inputB)
	if err != nil {
		t.Fatalf("second-store Append: %v", err)
	}
	if savedA.HistoryID == savedB.HistoryID {
		t.Fatalf("second store reused history ID %q", savedA.HistoryID)
	}

	if err := os.WriteFile(indexPath, staleIndex, 0o600); err != nil {
		t.Fatalf("restore stale valid index: %v", err)
	}

	// A valid but stale derived index must reconcile against both canonical
	// files. Same-millisecond UUIDv7 order need only remain stable across fresh
	// loads; it is not asserted to be chronological.
	one, err := NewStore(filesystem.NewOS(), home).Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("stale-index Snapshot: %v", err)
	}
	two, err := NewStore(filesystem.NewOS(), home).Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("second reconciled Snapshot: %v", err)
	}
	if len(one.Summaries) != 2 {
		t.Fatalf("reconciled summaries = %d, want 2", len(one.Summaries))
	}
	recovered := map[string]bool{
		one.Summaries[0].HistoryID: true,
		one.Summaries[1].HistoryID: true,
	}
	if !recovered[savedA.HistoryID] || !recovered[savedB.HistoryID] {
		t.Fatalf("stale-index reconciliation lost a canonical record: %#v", one.Summaries)
	}
	if one.Summaries[0].HistoryID != two.Summaries[0].HistoryID ||
		one.Summaries[1].HistoryID != two.Summaries[1].HistoryID {
		t.Fatalf("same-millisecond order changed: %#v then %#v", one.Summaries, two.Summaries)
	}
}

func TestStorePhase2C_RetainsFiveRichRecordsAndFiftySummariesWithMonotonicRedaction(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	var firstID string
	for i := 1; i <= 51; i++ {
		saved, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", int64(i), "line\n"))
		if err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
		if i == 1 {
			firstID = saved.HistoryID
		}
	}

	snapshot, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snapshot.Summaries) != 50 {
		t.Fatalf("summary count = %d, want 50", len(snapshot.Summaries))
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	if got := len(phase2CRecordFiles(t, workspaceDir)); got != 50 {
		t.Fatalf("canonical record count = %d, want 50", got)
	}
	richCount := 0
	for _, summary := range snapshot.Summaries {
		if summary.OutputAvailable {
			richCount++
		}
	}
	if richCount != 5 {
		t.Fatalf("rich summary count = %d, want 5", richCount)
	}
	if snapshot.Summaries[0].OutputAvailable {
		t.Fatal("oldest retained summary still claims rich output")
	}

	newest := snapshot.Summaries[len(snapshot.Summaries)-1]
	if err := store.ClearRecord(phase2CWorkspacePath, newest.HistoryID); err != nil {
		t.Fatalf("ClearRecord: %v", err)
	}
	afterClear, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot after clear: %v", err)
	}
	cleared := afterClear.Summaries[len(afterClear.Summaries)-1]
	if cleared.HistoryID != newest.HistoryID || cleared.OutputAvailable {
		t.Fatalf("clear did not leave a summary-only tombstone: %#v", cleared)
	}
	redacted, err := store.GetRecord(phase2CWorkspacePath, newest.HistoryID)
	if err != nil {
		t.Fatalf("GetRecord after clear: %v", err)
	}
	if len(redacted.Entries) != 0 || redacted.WorkingDir != "" {
		t.Fatalf("cleared canonical record retained rich data: %#v", redacted)
	}

	// The 51st-summary pruning is the only operation here that removes a
	// canonical record entirely.
	if _, err := store.GetRecord(phase2CWorkspacePath, firstID); err == nil {
		t.Fatal("oldest record survived the 50-summary cap")
	}

	if err := store.ClearAll(phase2CWorkspacePath); err != nil {
		t.Fatalf("ClearAll: %v", err)
	}
	afterClearAll, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot after ClearAll: %v", err)
	}
	for _, summary := range afterClearAll.Summaries {
		if summary.OutputAvailable {
			t.Fatalf("ClearAll left rich output available: %#v", summary)
		}
	}
}

func TestStorePhase2C_BudgetsHugeUTF8EntryAndKeepsWorkspaceAtTarget(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	huge := strings.Repeat("界", 4_000_000) // 12 MB UTF-8 in one OutputEntry.

	for i, profileID := range []string{"one", "two", "three"} {
		input := phase2COrdinaryInput(profileID, int64(3_000+i), huge)
		for entry := 1; entry <= 10_000; entry++ {
			input.Entries = append(input.Entries, OutputEntry{
				Stream:    "stdout",
				Text:      "bounded",
				Timestamp: int64(entry),
			})
		}
		saved, err := store.Append(phase2CWorkspacePath, input)
		if err != nil {
			t.Fatalf("Append huge record %d: %v", i, err)
		}
		record, err := store.GetRecord(phase2CWorkspacePath, saved.HistoryID)
		if err != nil {
			t.Fatalf("GetRecord huge record %d: %v", i, err)
		}
		if len(record.Entries) > 10_000 {
			t.Fatalf("entry count = %d, want <= 10000", len(record.Entries))
		}
	}

	workspaceDir := phase2CWorkspaceDir(t, store)
	var total int64
	allFiles, err := os.ReadDir(workspaceDir)
	if err != nil {
		t.Fatalf("ReadDir(workspace): %v", err)
	}
	for _, entry := range allFiles {
		if !entry.Type().IsRegular() {
			continue
		}
		path := filepath.Join(workspaceDir, entry.Name())
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("Stat(%q): %v", path, err)
		}
		if entry.Name() != "index.json" && info.Size() > phase2CMaxRecordBytes {
			t.Fatalf("record %q size = %d, want <= %d", path, info.Size(), phase2CMaxRecordBytes)
		}
		total += info.Size()
		if entry.Name() != "index.json" {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("ReadFile(%q): %v", path, err)
			}
			if !utf8.Valid(data) {
				t.Fatalf("record %q is not valid UTF-8 after truncating one huge entry", path)
			}
		}
	}
	if total > phase2CWorkspaceTarget {
		t.Fatalf("rich workspace bytes = %d, want <= %d", total, phase2CWorkspaceTarget)
	}
}

func TestStorePhase2C_EmptyHomeCorruptIndexRecoveryAndUnsupportedVersion(t *testing.T) {
	store := NewStore(filesystem.NewOS(), "")
	if _, err := store.Snapshot(phase2CWorkspacePath); err == nil || !strings.Contains(err.Error(), "home") {
		t.Fatalf("Snapshot with empty home error = %v, want visible home-resolution failure", err)
	}

	home := t.TempDir()
	store = NewStore(filesystem.NewOS(), home)
	saved, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 5_000, "recover\n"))
	if err != nil {
		t.Fatalf("seed Append: %v", err)
	}
	workspaceDir := phase2CWorkspaceDir(t, store)
	indexPath := filepath.Join(workspaceDir, "index.json")
	if err := os.WriteFile(indexPath, []byte("{recover-me"), 0o600); err != nil {
		t.Fatalf("seed corrupt index: %v", err)
	}
	store = NewStore(filesystem.NewOS(), home)
	recovered, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot did not self-heal corrupt derived index: %v", err)
	}
	if recovered.Warning == "" {
		t.Fatal("corrupt derived-index recovery did not surface a nonfatal warning")
	}
	if len(recovered.Summaries) != 1 || recovered.Summaries[0].HistoryID != saved.HistoryID {
		t.Fatalf("recovered snapshot = %#v, want seeded canonical record", recovered)
	}
	if _, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 5_100, "after recovery\n")); err != nil {
		t.Fatalf("Append after corrupt-index reconciliation: %v", err)
	}

	unsupported := []byte(`{"version":99,"summaries":[]}`)
	if err := os.WriteFile(indexPath, unsupported, 0o600); err != nil {
		t.Fatalf("seed unsupported index: %v", err)
	}
	store = NewStore(filesystem.NewOS(), home)
	if _, err := store.Snapshot(phase2CWorkspacePath); err == nil {
		t.Fatal("unsupported newer index version did not produce a visible error")
	}
	if _, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 5_200, "blocked\n")); err == nil {
		t.Fatal("append overwrote an unsupported newer index")
	}
	got, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatalf("read preserved unsupported index: %v", err)
	}
	if string(got) != string(unsupported) {
		t.Fatalf("unsupported index changed to %q", got)
	}
}

func TestStorePhase2C_CompoundAggregateAndStepAreAlwaysBoundedSummaryOnly(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	entries := make([]OutputEntry, 10_001)
	for i := range entries {
		entries[i] = OutputEntry{Stream: "stdout", Text: "must not persist", Timestamp: int64(i)}
	}

	for _, kind := range []RecordKind{RecordKindCompoundAggregate, RecordKindCompoundStep} {
		input := phase2COrdinaryInput("build", 6_000+int64(len(kind)), "ignored")
		input.Kind = kind
		input.WorkingDir = filepath.FromSlash("/sensitive/compound/path")
		input.Entries = entries
		saved, err := store.Append(phase2CWorkspacePath, input)
		if err != nil {
			t.Fatalf("Append(%s): %v", kind, err)
		}
		record, err := store.GetRecord(phase2CWorkspacePath, saved.HistoryID)
		if err != nil {
			t.Fatalf("GetRecord(%s): %v", kind, err)
		}
		if record.OutputAvailable || len(record.Entries) != 0 || record.WorkingDir != "" {
			t.Fatalf("%s retained rich payload: %#v", kind, record)
		}
	}

	snapshot, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snapshot.Summaries) != 2 {
		t.Fatalf("compound summary count = %d, want 2", len(snapshot.Summaries))
	}
}
