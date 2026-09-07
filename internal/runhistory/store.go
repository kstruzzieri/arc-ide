package runhistory

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"firn/internal/filesystem"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	storeVersion          = 1
	maxSummaries          = 50
	maxRichRecords        = 5
	maxEntries            = 10_000
	maxRecordBytes        = 10 << 20
	maxIndexBytes         = maxRecordBytes
	workspaceByteTarget   = 20 << 20
	maxWorkspaceEntries   = 20_000
	maxCanonicalRecords   = 10_000
	maxReconcileReadBytes = workspaceByteTarget
	staleTempAge          = 5 * time.Minute
)

type RecordKind string

const (
	RecordKindOrdinary          RecordKind = "ordinary"
	RecordKindCompoundAggregate RecordKind = "compound-aggregate"
	RecordKindCompoundStep      RecordKind = "compound-step"
)

type OutputEntry struct {
	Stream    string `json:"stream"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
}

type RecordInput struct {
	Kind           RecordKind    `json:"kind"`
	ProfileID      string        `json:"profileId"`
	ProfileName    string        `json:"profileName"`
	State          string        `json:"state"`
	ExitCode       int           `json:"exitCode"`
	StartedAt      int64         `json:"startedAt"`
	CompletedAt    int64         `json:"completedAt"`
	WorkspaceEpoch uint64        `json:"workspaceEpoch,omitempty"`
	WorkingDir     string        `json:"workingDir,omitempty"`
	Entries        []OutputEntry `json:"entries,omitempty"`
	// Truncated reports that the caller already dropped output to fit the record
	// budget. The store ORs its own truncation into it, so the stored flag covers
	// losses on both sides of the binding.
	Truncated bool `json:"truncated,omitempty"`
}

type Summary struct {
	HistoryID       string     `json:"historyId"`
	Kind            RecordKind `json:"kind"`
	ProfileID       string     `json:"profileId"`
	ProfileName     string     `json:"profileName"`
	State           string     `json:"state"`
	ExitCode        int        `json:"exitCode"`
	StartedAt       int64      `json:"startedAt"`
	CompletedAt     int64      `json:"completedAt"`
	OutputAvailable bool       `json:"outputAvailable"`
	// Truncated marks a record whose saved output is a prefix of what the run
	// actually produced. It rides on the summary (not just the record) so the
	// index carries it and the UI can warn before loading, which matters most for
	// Diff: comparing a truncated run against a complete one invents differences.
	Truncated bool `json:"truncated,omitempty"`
}

type Record struct {
	Version int `json:"version"`
	Summary
	WorkingDir string        `json:"workingDir,omitempty"`
	Entries    []OutputEntry `json:"entries,omitempty"`
}

type Snapshot struct {
	Version   int       `json:"version"`
	Summaries []Summary `json:"summaries"`
	Warning   string    `json:"warning,omitempty"`
}

type indexRecord struct {
	Summary
	Size       int64 `json:"size"`
	ModifiedAt int64 `json:"modifiedAt"`
}

type indexFile struct {
	Version int           `json:"version"`
	Records []indexRecord `json:"records"`
}

type storedRecord struct {
	Record
	size       int64
	modifiedAt int64
}

type ownedCanonicalProblem struct {
	path string
	size int64
}

type reconcileResult struct {
	records      []storedRecord
	problems     []ownedCanonicalProblem
	anomalyBytes int64
	warning      string
}

type canonicalFile struct {
	path string
	id   string
	info fs.FileInfo
}

type Store struct {
	fs                   filesystem.FileSystem
	firnDir              string
	indexByteLimit       int64
	canonicalRecordLimit int
	locksMu              sync.Mutex
	workspaceLocks       map[string]*workspaceLock
}

type workspaceLock struct {
	mu   sync.Mutex
	refs int
}

func NewStore(fsys filesystem.FileSystem, firnDir string) *Store {
	return &Store{
		fs:                   fsys,
		firnDir:              firnDir,
		indexByteLimit:       maxIndexBytes,
		canonicalRecordLimit: maxCanonicalRecords,
		workspaceLocks:       make(map[string]*workspaceLock),
	}
}

func (s *Store) Snapshot(workspacePath string) (Snapshot, error) {
	dir, unlock, err := s.lockWorkspace(workspacePath)
	if err != nil {
		return Snapshot{}, err
	}
	defer unlock()
	exists, err := s.validateArchiveDir(dir)
	if err != nil {
		return Snapshot{}, err
	}
	if !exists {
		return Snapshot{Version: storeVersion, Summaries: []Summary{}}, nil
	}
	reconciled, err := s.reconcileLocked(dir, false)
	if err != nil {
		return Snapshot{}, err
	}
	records, indexWarning, err := s.enforceLimitsLocked(dir, reconciled.records)
	if err != nil {
		return Snapshot{}, err
	}
	warning := joinWarnings(reconciled.warning, indexWarning)
	if artifactQuotaExceeded(records, reconciled.anomalyBytes, s.indexByteLimit) {
		warning = joinWarnings(warning, "owned unreadable run history artifacts exceed the workspace target")
	}
	return snapshotFor(records, warning), nil
}

func (s *Store) Append(workspacePath string, input RecordInput) (Summary, error) {
	dir, unlock, err := s.lockWorkspace(workspacePath)
	if err != nil {
		return Summary{}, err
	}
	defer unlock()
	exists, err := s.validateArchiveDir(dir)
	if err != nil {
		return Summary{}, err
	}
	if !exists {
		if err := s.createArchiveDirLocked(dir); err != nil {
			return Summary{}, err
		}
	}
	if exists, err := s.validateArchiveDir(dir); err != nil {
		return Summary{}, err
	} else if !exists {
		return Summary{}, fmt.Errorf("creating run history directory did not create %s", dir)
	}
	reconciled, err := s.reconcileLocked(dir, false)
	if err != nil {
		return Summary{}, err
	}
	records, _, err := s.enforceLimitsLocked(dir, reconciled.records)
	if err != nil {
		return Summary{}, err
	}
	record, data, err := buildRecord(input)
	if err != nil {
		return Summary{}, err
	}
	prospective := append(append([]storedRecord(nil), records...), storedRecord{
		Record:     record,
		size:       int64(len(data)),
		modifiedAt: time.Now().UnixNano(),
	})
	if reconciled.anomalyBytes > 0 &&
		managedBytes(prospective, s.indexByteLimit)+reconciled.anomalyBytes > workspaceByteTarget {
		// Usually a temp file left by a crash mid-write. Those are reclaimed once
		// they age past staleTempAge, so say so rather than reading as permanent.
		return Summary{}, fmt.Errorf(
			"run history is holding %d bytes of unreadable saved runs and cannot save more; "+
				"leftovers from an interrupted write are cleaned up automatically within %s",
			reconciled.anomalyBytes, staleTempAge)
	}

	path := recordPath(dir, record.HistoryID)
	if err := s.writeFileAtomicLocked(dir, path, data); err != nil {
		return Summary{}, fmt.Errorf("writing run history record: %w", err)
	}
	// Past the atomic rename the record is durable, so the two post-write
	// failure paths below report success only when the rollback could NOT undo
	// it: an unremovable file is still on disk and the next load will surface
	// it, and telling the frontend otherwise would drop output it could show.
	// A successful rollback means nothing was published, so that is an error.
	info, err := s.regularFileInfo(path)
	if err != nil {
		if rollbackErr := s.removeOwnedFileLocked(dir, path); rollbackErr == nil {
			return Summary{}, fmt.Errorf("reading published run history record: %w", err)
		}
		return record.Summary, nil
	}
	records = append(records, storedRecord{
		Record:     record,
		size:       info.Size(),
		modifiedAt: info.ModTime().UnixNano(),
	})
	records, _, err = s.enforceLimitsLocked(dir, records)
	if err != nil {
		if rollbackErr := s.removeOwnedFileLocked(dir, path); rollbackErr == nil {
			return Summary{}, err
		}
		if committed, _, readErr := s.readStoredRecord(path, maxRecordBytes); readErr == nil {
			return committed.Summary, nil
		}
		return record.Summary, nil
	}
	for _, retained := range records {
		if retained.HistoryID == record.HistoryID {
			return retained.Summary, nil
		}
	}
	return Summary{}, fmt.Errorf("new run history record was not retained")
}

func (s *Store) GetRecord(workspacePath, historyID string) (Record, error) {
	dir, unlock, err := s.lockWorkspace(workspacePath)
	if err != nil {
		return Record{}, err
	}
	defer unlock()
	if err := validateHistoryID(historyID); err != nil {
		return Record{}, err
	}
	exists, err := s.validateArchiveDir(dir)
	if err != nil {
		return Record{}, err
	}
	if !exists {
		return Record{}, fs.ErrNotExist
	}
	stored, _, err := s.readStoredRecord(recordPath(dir, historyID), maxRecordBytes)
	return stored.Record, err
}

func (s *Store) ClearRecord(workspacePath, historyID string) error {
	dir, unlock, err := s.lockWorkspace(workspacePath)
	if err != nil {
		return err
	}
	defer unlock()
	if err := validateHistoryID(historyID); err != nil {
		return err
	}
	exists, err := s.validateArchiveDir(dir)
	if err != nil {
		return err
	}
	if !exists {
		return fs.ErrNotExist
	}
	reconciled, err := s.reconcileLocked(dir, false)
	if err != nil {
		return err
	}
	found := false
	for i := range reconciled.records {
		if reconciled.records[i].HistoryID != historyID {
			continue
		}
		found = true
		reconciled.records[i], err = s.redactLocked(dir, reconciled.records[i], true)
		if err != nil {
			return err
		}
		break
	}
	for _, problem := range reconciled.problems {
		if filepath.Base(problem.path) != historyID+".json" {
			continue
		}
		found = true
		if err := s.removeOwnedFileLocked(dir, problem.path); err != nil {
			return fmt.Errorf("removing unreadable run history record: %w", err)
		}
	}
	if !found {
		return fs.ErrNotExist
	}
	_, _, err = s.enforceLimitsLocked(dir, reconciled.records)
	return err
}

func (s *Store) ClearAll(workspacePath string) error {
	dir, unlock, err := s.lockWorkspace(workspacePath)
	if err != nil {
		return err
	}
	defer unlock()
	exists, err := s.validateArchiveDir(dir)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	reconciled, err := s.reconcileLocked(dir, true)
	if err != nil {
		return err
	}
	for _, problem := range reconciled.problems {
		if err := s.removeOwnedFileLocked(dir, problem.path); err != nil {
			return fmt.Errorf("removing unreadable run history record: %w", err)
		}
	}
	for i := range reconciled.records {
		reconciled.records[i], err = s.redactLocked(dir, reconciled.records[i], true)
		if err != nil {
			return err
		}
	}
	_, _, err = s.enforceLimitsLocked(dir, reconciled.records)
	return err
}

func (s *Store) workspaceDir(workspacePath string) (string, error) {
	if strings.TrimSpace(s.firnDir) == "" {
		return "", fmt.Errorf("home directory unavailable: run history storage is disabled")
	}
	if strings.TrimSpace(workspacePath) == "" {
		return "", fmt.Errorf("no active workspace")
	}
	cleaned := filepath.Clean(workspacePath)
	sum := sha256.Sum256([]byte(cleaned))
	return filepath.Join(s.firnDir, "run-history", hex.EncodeToString(sum[:8])), nil
}

func (s *Store) lockWorkspace(workspacePath string) (string, func(), error) {
	dir, err := s.workspaceDir(workspacePath)
	if err != nil {
		return "", nil, err
	}
	s.locksMu.Lock()
	lock := s.workspaceLocks[dir]
	if lock == nil {
		lock = &workspaceLock{}
		s.workspaceLocks[dir] = lock
	}
	lock.refs++
	s.locksMu.Unlock()

	lock.mu.Lock()
	return dir, func() {
		lock.mu.Unlock()
		s.locksMu.Lock()
		lock.refs--
		if lock.refs == 0 && s.workspaceLocks[dir] == lock {
			delete(s.workspaceLocks, dir)
		}
		s.locksMu.Unlock()
	}, nil
}

func (s *Store) reconcileLocked(dir string, clearAll bool) (reconcileResult, error) {
	index, indexWarning, err := s.readIndexLocked(dir)
	if err != nil {
		return reconcileResult{}, err
	}
	entries, err := filesystem.ReadDirBounded(s.fs, dir, maxWorkspaceEntries)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return reconcileResult{records: []storedRecord{}, warning: indexWarning}, nil
		}
		return reconcileResult{}, fmt.Errorf("reading run history directory: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	result := reconcileResult{warning: indexWarning}
	var canonical []canonicalFile
	var warnings []string
	now := time.Now()
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(dir, name)
		if name == "index.json" {
			continue
		}
		if isOwnedTempName(name) {
			info, infoErr := s.regularFileInfo(path)
			if infoErr != nil {
				return reconcileResult{}, fmt.Errorf("reading owned run history temp: %w", infoErr)
			}
			if clearAll {
				if err := s.removeOwnedFileLocked(dir, path); err != nil {
					return reconcileResult{}, fmt.Errorf("removing owned run history temp: %w", err)
				}
				continue
			}
			if now.Sub(info.ModTime()) >= staleTempAge {
				if err := s.removeOwnedFileLocked(dir, path); err != nil {
					warnings = append(warnings, fmt.Sprintf("%s: stale temp cleanup failed: %v", name, err))
					result.anomalyBytes += info.Size()
				}
			} else {
				warnings = append(warnings, fmt.Sprintf("%s: active or recent owned temp retained", name))
				result.anomalyBytes += info.Size()
			}
			continue
		}
		historyID, ok := canonicalHistoryID(name)
		if !ok {
			if entry.IsDir() {
				continue
			}
			warnings = append(warnings, fmt.Sprintf("%s: unmanaged file ignored", name))
			continue
		}
		info, infoErr := s.regularFileInfo(path)
		if infoErr != nil {
			if errors.Is(infoErr, filesystem.ErrUnsafePath) {
				return reconcileResult{}, fmt.Errorf("reading run history record metadata: %w", infoErr)
			}
			result.problems = append(result.problems, ownedCanonicalProblem{path: path})
			warnings = append(warnings, fmt.Sprintf("%s: %v", name, infoErr))
			continue
		}
		canonical = append(canonical, canonicalFile{path: path, id: historyID, info: info})
	}
	indexed := make(map[string]indexRecord, len(index))
	for _, record := range index {
		indexed[record.HistoryID] = record
	}
	var readBytes int64
	for _, file := range canonical {
		if cached, ok := indexed[file.id]; ok &&
			cached.Size == file.info.Size() &&
			cached.ModifiedAt == file.info.ModTime().UnixNano() {
			result.records = append(result.records, storedRecord{
				Record: Record{Version: storeVersion, Summary: cached.Summary},
				size:   cached.Size, modifiedAt: cached.ModifiedAt,
			})
			continue
		}
		remaining := maxReconcileReadBytes - readBytes
		if remaining <= 0 {
			result.problems = append(result.problems, ownedCanonicalProblem{path: file.path, size: file.info.Size()})
			result.anomalyBytes += file.info.Size()
			warnings = append(warnings, fmt.Sprintf("%s: reconciliation read budget exceeded", filepath.Base(file.path)))
			continue
		}
		readLimit := remaining
		if readLimit > maxRecordBytes {
			readLimit = maxRecordBytes
		}
		record, openedInfo, readErr := s.readStoredRecord(file.path, readLimit)
		problemSize := file.info.Size()
		if openedInfo != nil {
			problemSize = openedInfo.Size()
			readBytes += openedInfo.Size()
		}
		if readErr != nil {
			if errors.Is(readErr, fs.ErrNotExist) {
				continue
			}
			if errors.Is(readErr, filesystem.ErrUnsafePath) {
				return reconcileResult{}, fmt.Errorf("reading run history record: %w", readErr)
			}
			result.problems = append(result.problems, ownedCanonicalProblem{path: file.path, size: problemSize})
			result.anomalyBytes += problemSize
			warnings = append(warnings, fmt.Sprintf("%s: %v", filepath.Base(file.path), readErr))
			continue
		}
		if record.HistoryID != file.id {
			result.problems = append(result.problems, ownedCanonicalProblem{path: file.path, size: record.size})
			result.anomalyBytes += record.size
			warnings = append(warnings, fmt.Sprintf("%s: history ID mismatch", filepath.Base(file.path)))
			continue
		}
		result.records = append(result.records, record)
	}
	sortStoredRecords(result.records)
	result.warning = joinWarnings(result.warning, strings.Join(warnings, "; "))
	return result, nil
}

func (s *Store) readIndexLocked(dir string) ([]indexRecord, string, error) {
	path := filepath.Join(dir, "index.json")
	data, _, err := filesystem.ReadFileBounded(s.fs, path, s.indexByteLimit)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, "", nil
		}
		if errors.Is(err, filesystem.ErrUnsafePath) {
			return nil, "", fmt.Errorf("reading run history index: %w", err)
		}
		return nil, "repaired unreadable or oversized run history index", nil
	}
	var version struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &version); err != nil {
		return nil, "repaired corrupt run history index", nil
	}
	if version.Version > storeVersion {
		return nil, "", fmt.Errorf("unsupported run history index version: %d", version.Version)
	}
	envelope, err := decodeIndex(data, s.recordLimit())
	if err != nil {
		return nil, "repaired corrupt run history index", nil
	}
	if envelope.Version != storeVersion || envelope.Records == nil {
		return nil, "repaired corrupt run history index", nil
	}
	records := envelope.Records
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if err := validateIndexRecord(record); err != nil {
			return nil, "repaired corrupt run history index", nil
		}
		if _, duplicate := seen[record.HistoryID]; duplicate {
			return nil, "repaired corrupt run history index", nil
		}
		seen[record.HistoryID] = struct{}{}
	}
	return records, "", nil
}

func (s *Store) readStoredRecord(path string, limit int64) (storedRecord, fs.FileInfo, error) {
	data, info, err := filesystem.ReadFileBounded(s.fs, path, limit)
	if err != nil {
		return storedRecord{}, info, err
	}
	record, err := decodeRecord(data, maxEntries)
	if err != nil {
		return storedRecord{}, info, fmt.Errorf("parsing run history record: %w", err)
	}
	return storedRecord{
		Record: record, size: info.Size(), modifiedAt: info.ModTime().UnixNano(),
	}, info, nil
}

func decodeIndex(data []byte, recordLimit int) (indexFile, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := expectJSONDelimiter(decoder, '{'); err != nil {
		return indexFile{}, err
	}
	var index indexFile
	seenKeys := make(map[string]struct{})
	for decoder.More() {
		key, err := nextJSONKey(decoder)
		if err != nil {
			return indexFile{}, err
		}
		if _, duplicate := seenKeys[key]; duplicate {
			return indexFile{}, fmt.Errorf("duplicate run history index field %q", key)
		}
		seenKeys[key] = struct{}{}
		switch key {
		case "version":
			if err := decoder.Decode(&index.Version); err != nil {
				return indexFile{}, err
			}
		case "records":
			if err := expectJSONDelimiter(decoder, '['); err != nil {
				return indexFile{}, err
			}
			index.Records = make([]indexRecord, 0)
			for decoder.More() {
				if len(index.Records) >= recordLimit {
					return indexFile{}, fmt.Errorf("run history index contains more than %d records", recordLimit)
				}
				var record indexRecord
				if err := decoder.Decode(&record); err != nil {
					return indexFile{}, err
				}
				if err := validateIndexRecord(record); err != nil {
					return indexFile{}, err
				}
				index.Records = append(index.Records, record)
			}
			if err := expectJSONDelimiter(decoder, ']'); err != nil {
				return indexFile{}, err
			}
		default:
			var discarded json.RawMessage
			if err := decoder.Decode(&discarded); err != nil {
				return indexFile{}, err
			}
		}
	}
	if err := expectJSONDelimiter(decoder, '}'); err != nil {
		return indexFile{}, err
	}
	if err := expectJSONEOF(decoder); err != nil {
		return indexFile{}, err
	}
	return index, nil
}

func decodeRecord(data []byte, entryLimit int) (Record, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := expectJSONDelimiter(decoder, '{'); err != nil {
		return Record{}, err
	}
	var record Record
	for decoder.More() {
		key, err := nextJSONKey(decoder)
		if err != nil {
			return Record{}, err
		}
		switch key {
		case "version":
			err = decoder.Decode(&record.Version)
		case "historyId":
			err = decoder.Decode(&record.HistoryID)
		case "kind":
			err = decoder.Decode(&record.Kind)
		case "profileId":
			err = decoder.Decode(&record.ProfileID)
		case "profileName":
			err = decoder.Decode(&record.ProfileName)
		case "state":
			err = decoder.Decode(&record.State)
		case "exitCode":
			err = decoder.Decode(&record.ExitCode)
		case "startedAt":
			err = decoder.Decode(&record.StartedAt)
		case "completedAt":
			err = decoder.Decode(&record.CompletedAt)
		case "outputAvailable":
			err = decoder.Decode(&record.OutputAvailable)
		case "truncated":
			err = decoder.Decode(&record.Truncated)
		case "workingDir":
			err = decoder.Decode(&record.WorkingDir)
		case "entries":
			err = decodeEntries(decoder, &record.Entries, entryLimit)
		default:
			var discarded json.RawMessage
			err = decoder.Decode(&discarded)
		}
		if err != nil {
			return Record{}, err
		}
	}
	if err := expectJSONDelimiter(decoder, '}'); err != nil {
		return Record{}, err
	}
	if err := expectJSONEOF(decoder); err != nil {
		return Record{}, err
	}
	if err := validateRecord(record, entryLimit); err != nil {
		return Record{}, err
	}
	return record, nil
}

func decodeEntries(decoder *json.Decoder, entries *[]OutputEntry, limit int) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token == nil {
		return nil
	}
	if token != json.Delim('[') {
		return fmt.Errorf("run history entries must be an array")
	}
	for decoder.More() {
		if len(*entries) >= limit {
			return fmt.Errorf("run history record contains more than %d entries", limit)
		}
		var entry OutputEntry
		if err := decoder.Decode(&entry); err != nil {
			return err
		}
		*entries = append(*entries, entry)
	}
	return expectJSONDelimiter(decoder, ']')
}

func expectJSONDelimiter(decoder *json.Decoder, want json.Delim) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token != want {
		return fmt.Errorf("expected JSON delimiter %q", want)
	}
	return nil
}

func nextJSONKey(decoder *json.Decoder) (string, error) {
	token, err := decoder.Token()
	if err != nil {
		return "", err
	}
	key, ok := token.(string)
	if !ok {
		return "", fmt.Errorf("expected JSON object key")
	}
	return key, nil
}

func expectJSONEOF(decoder *json.Decoder) error {
	var trailing json.RawMessage
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("unexpected trailing JSON value")
	}
	return err
}

func validateIndexRecord(record indexRecord) error {
	if err := validateSummary(record.Summary); err != nil {
		return err
	}
	if record.Size < 0 {
		return fmt.Errorf("run history index record size is negative")
	}
	return nil
}

func validateRecord(record Record, entryLimit int) error {
	if record.Version != storeVersion {
		return fmt.Errorf("unsupported run history record version: %d", record.Version)
	}
	if err := validateSummary(record.Summary); err != nil {
		return err
	}
	if len(record.WorkingDir) > 32<<10 {
		return fmt.Errorf("run history working directory exceeds its limit")
	}
	if len(record.Entries) > entryLimit {
		return fmt.Errorf("run history record contains more than %d entries", entryLimit)
	}
	for _, entry := range record.Entries {
		if len(entry.Stream) > 32 {
			return fmt.Errorf("run history output stream exceeds its limit")
		}
	}
	if record.Kind != RecordKindOrdinary &&
		(record.OutputAvailable || record.WorkingDir != "" || len(record.Entries) > 0) {
		return fmt.Errorf("compound run history records must be summary-only")
	}
	if !record.OutputAvailable && (record.WorkingDir != "" || len(record.Entries) > 0) {
		return fmt.Errorf("redacted run history records must be summary-only")
	}
	return nil
}

func validateSummary(summary Summary) error {
	if err := validateHistoryID(summary.HistoryID); err != nil {
		return err
	}
	if !validRecordKind(summary.Kind) {
		return fmt.Errorf("unsupported run history record kind %q", summary.Kind)
	}
	if strings.TrimSpace(summary.ProfileID) == "" || len(summary.ProfileID) > 4<<10 {
		return fmt.Errorf("run history profile ID is empty or exceeds its limit")
	}
	if len(summary.ProfileName) > 4<<10 {
		return fmt.Errorf("run history profile name exceeds its limit")
	}
	if strings.TrimSpace(summary.State) == "" || len(summary.State) > 128 {
		return fmt.Errorf("run history state is empty or exceeds its limit")
	}
	return nil
}

func (s *Store) enforceLimitsLocked(dir string, records []storedRecord) ([]storedRecord, string, error) {
	sortStoredRecords(records)
	if removeCount := len(records) - s.recordLimit(); removeCount > 0 {
		for _, record := range records[:removeCount] {
			if err := s.removeOwnedFileLocked(dir, recordPath(dir, record.HistoryID)); err != nil {
				return records, "", fmt.Errorf("pruning canonical run history limit: %w", err)
			}
		}
		records = records[removeCount:]
	}

	counts := map[string]int{}
	for _, record := range records {
		counts[record.ProfileID]++
	}
	kept := records[:0]
	for _, record := range records {
		if counts[record.ProfileID] > maxSummaries {
			if err := s.removeOwnedFileLocked(dir, recordPath(dir, record.HistoryID)); err != nil {
				return records, "", fmt.Errorf("pruning run history summary: %w", err)
			}
			counts[record.ProfileID]--
			continue
		}
		kept = append(kept, record)
	}
	records = kept

	richCounts := map[string]int{}
	for _, record := range records {
		if record.OutputAvailable {
			richCounts[record.ProfileID]++
		}
	}
	for i := range records {
		if records[i].OutputAvailable && richCounts[records[i].ProfileID] > maxRichRecords {
			redacted, err := s.redactLocked(dir, records[i], false)
			if err != nil {
				return records, "", err
			}
			records[i] = redacted
			richCounts[records[i].ProfileID]--
		}
	}

	var err error
	records, err = s.pruneToIndexBudgetLocked(dir, records)
	if err != nil {
		return records, "", err
	}
	for managedBytes(records, s.indexByteLimit) > workspaceByteTarget {
		changed := false
		for i := range records {
			if !records[i].OutputAvailable {
				continue
			}
			redacted, err := s.redactLocked(dir, records[i], false)
			if err != nil {
				return records, "", err
			}
			records[i] = redacted
			changed = true
			break
		}
		if changed {
			continue
		}
		if len(records) == 0 {
			return records, "", fmt.Errorf("run history index exceeds workspace byte target")
		}
		if err := s.removeOwnedFileLocked(dir, recordPath(dir, records[0].HistoryID)); err != nil {
			return records, "", fmt.Errorf("pruning run history workspace budget: %w", err)
		}
		records = records[1:]
	}
	records, err = s.pruneToIndexBudgetLocked(dir, records)
	if err != nil {
		return records, "", err
	}
	data, err := marshalIndex(records)
	if err != nil {
		return records, "", err
	}
	if int64(len(data)) > s.indexByteLimit {
		return records, "", fmt.Errorf("run history index exceeds %d bytes", s.indexByteLimit)
	}
	if err := s.writeFileAtomicLocked(dir, filepath.Join(dir, "index.json"), data); err != nil {
		if errors.Is(err, filesystem.ErrUnsafePath) {
			return records, "", err
		}
		return records, fmt.Sprintf("run history index will self-heal: %v", err), nil
	}
	return records, "", nil
}

func (s *Store) pruneToIndexBudgetLocked(dir string, records []storedRecord) ([]storedRecord, error) {
	data, err := marshalIndex(records)
	if err != nil {
		return records, err
	}
	if int64(len(data)) <= s.indexByteLimit {
		return records, nil
	}
	if len(records) == 0 {
		return records, fmt.Errorf("run history index cannot fit within %d bytes", s.indexByteLimit)
	}
	low, high := 1, len(records)
	for low < high {
		mid := low + (high-low)/2
		candidate, err := marshalIndex(records[mid:])
		if err != nil {
			return records, err
		}
		if int64(len(candidate)) <= s.indexByteLimit {
			high = mid
		} else {
			low = mid + 1
		}
	}
	candidate, err := marshalIndex(records[low:])
	if err != nil {
		return records, err
	}
	if int64(len(candidate)) > s.indexByteLimit {
		return records, fmt.Errorf("run history index cannot fit within %d bytes", s.indexByteLimit)
	}
	for _, record := range records[:low] {
		if err := s.removeOwnedFileLocked(dir, recordPath(dir, record.HistoryID)); err != nil {
			return records, fmt.Errorf("pruning run history index budget: %w", err)
		}
	}
	return records[low:], nil
}

func (s *Store) redactLocked(dir string, record storedRecord, force bool) (storedRecord, error) {
	if !force && !record.OutputAvailable && record.WorkingDir == "" && len(record.Entries) == 0 {
		return record, nil
	}
	record.OutputAvailable = false
	record.WorkingDir = ""
	record.Entries = nil
	// No output left to be a prefix of, so the flag would only mislead the UI.
	record.Truncated = false
	data, err := json.Marshal(record.Record)
	if err != nil {
		return record, fmt.Errorf("marshaling redacted run history record: %w", err)
	}
	path := recordPath(dir, record.HistoryID)
	if err := s.writeFileAtomicLocked(dir, path, data); err != nil {
		return record, fmt.Errorf("redacting run history record: %w", err)
	}
	info, err := s.regularFileInfo(path)
	if err != nil {
		return record, fmt.Errorf("reading redacted run history record: %w", err)
	}
	record.size = info.Size()
	record.modifiedAt = info.ModTime().UnixNano()
	return record, nil
}

func marshalIndex(records []storedRecord) ([]byte, error) {
	indexRecords := make([]indexRecord, len(records))
	for i := range records {
		indexRecords[i] = indexRecord{
			Summary: records[i].Summary, Size: records[i].size, ModifiedAt: records[i].modifiedAt,
		}
	}
	data, err := json.Marshal(indexFile{Version: storeVersion, Records: indexRecords})
	if err != nil {
		return nil, fmt.Errorf("marshaling run history index: %w", err)
	}
	return data, nil
}

func managedBytes(records []storedRecord, indexLimit int64) int64 {
	var total int64
	for _, record := range records {
		total += record.size
	}
	data, err := marshalIndex(records)
	if err != nil {
		return total + indexLimit + 1
	}
	return total + int64(len(data))
}

func artifactQuotaExceeded(records []storedRecord, anomalyBytes, indexLimit int64) bool {
	return anomalyBytes > 0 &&
		managedBytes(records, indexLimit)+anomalyBytes > workspaceByteTarget
}

func buildRecord(input RecordInput) (Record, []byte, error) {
	if !validRecordKind(input.Kind) {
		return Record{}, nil, fmt.Errorf("unsupported run history record kind %q", input.Kind)
	}
	if strings.TrimSpace(input.ProfileID) == "" {
		return Record{}, nil, fmt.Errorf("run history profile ID must not be empty")
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Record{}, nil, fmt.Errorf("creating run history ID: %w", err)
	}
	record := Record{
		Version: storeVersion,
		Summary: Summary{
			HistoryID:       id.String(),
			Kind:            input.Kind,
			ProfileID:       boundedString(input.ProfileID, 4<<10),
			ProfileName:     boundedString(input.ProfileName, 4<<10),
			State:           boundedString(input.State, 128),
			ExitCode:        input.ExitCode,
			StartedAt:       input.StartedAt,
			CompletedAt:     input.CompletedAt,
			OutputAvailable: input.Kind == RecordKindOrdinary,
		},
	}
	if input.Kind == RecordKindOrdinary {
		// The caller truncates against the same budget before crossing the
		// binding; carry its verdict so the flag covers losses on both sides.
		record.Truncated = input.Truncated
		record.WorkingDir = boundedString(input.WorkingDir, 32<<10)
		empty, err := json.Marshal(record)
		if err != nil {
			return Record{}, nil, fmt.Errorf("marshaling run history envelope: %w", err)
		}
		remaining := maxRecordBytes - len(empty) - 1024
		limit := len(input.Entries)
		if limit > maxEntries {
			limit = maxEntries
			record.Truncated = true
		}
		for i := 0; i < limit && remaining > 128; i++ {
			entry := input.Entries[i]
			entry.Stream = boundedString(entry.Stream, 32)
			// Budget and UTF-8-truncate each entry before the one whole-record
			// marshal, so an arbitrarily large OutputEntry cannot force an
			// equally large temporary serialized record allocation.
			entry.Text = boundedString(entry.Text, (remaining-128)/6)
			if entry.Text != input.Entries[i].Text {
				record.Truncated = true
			}
			encoded, err := json.Marshal(entry)
			if err != nil {
				return Record{}, nil, fmt.Errorf("marshaling run history output entry: %w", err)
			}
			if len(encoded)+1 > remaining {
				record.Truncated = true
				break
			}
			record.Entries = append(record.Entries, entry)
			remaining -= len(encoded) + 1
		}
		// A budget too tight to hold every entry drops the tail silently
		// otherwise; the loop above only flags the entry it stopped on.
		if len(record.Entries) < len(input.Entries) {
			record.Truncated = true
		}
	}
	if err := validateRecord(record, maxEntries); err != nil {
		return Record{}, nil, err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return Record{}, nil, fmt.Errorf("marshaling run history record: %w", err)
	}
	if len(data) > maxRecordBytes {
		return Record{}, nil, fmt.Errorf("run history record exceeds %d bytes", maxRecordBytes)
	}
	return record, data, nil
}

func boundedString(value string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(value) > maxBytes {
		value = value[:maxBytes]
		for len(value) > 0 && !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	if !utf8.ValidString(value) {
		value = strings.ToValidUTF8(value, "\uFFFD")
	}
	return value
}

func snapshotFor(records []storedRecord, warning string) Snapshot {
	summaries := make([]Summary, len(records))
	for i := range records {
		summaries[i] = records[i].Summary
	}
	return Snapshot{Version: storeVersion, Summaries: summaries, Warning: warning}
}

func sortStoredRecords(records []storedRecord) {
	sort.Slice(records, func(i, j int) bool {
		if records[i].CompletedAt != records[j].CompletedAt {
			return records[i].CompletedAt < records[j].CompletedAt
		}
		return records[i].HistoryID < records[j].HistoryID
	})
}

func validRecordKind(kind RecordKind) bool {
	return kind == RecordKindOrdinary ||
		kind == RecordKindCompoundAggregate ||
		kind == RecordKindCompoundStep
}

// validateHistoryID accepts only the canonical hyphenated form uuid.NewV7
// produces. uuid.Parse also accepts the "urn:uuid:", braced, and unhyphenated
// encodings, and each of those names a *different* file under recordPath, so
// admitting them would let one logical ID address several paths and would put
// ':' and '{}' into managed filenames (a ':' names an NTFS alternate data
// stream on Windows).
func validateHistoryID(historyID string) error {
	id, err := uuid.Parse(historyID)
	if err != nil || id.Version() != 7 || id.String() != historyID {
		return fmt.Errorf("invalid run history ID %q", historyID)
	}
	return nil
}

func canonicalHistoryID(name string) (string, bool) {
	if !strings.HasSuffix(name, ".json") || name == "index.json" {
		return "", false
	}
	historyID := strings.TrimSuffix(name, ".json")
	return historyID, validateHistoryID(historyID) == nil
}

func isOwnedTempName(name string) bool {
	dot := strings.LastIndexByte(name, '.')
	if dot < 0 || len(name)-dot-1 != 16 {
		return false
	}
	if _, err := hex.DecodeString(name[dot+1:]); err != nil {
		return false
	}
	base := name[:dot]
	if base == "index.json" {
		return true
	}
	_, ok := canonicalHistoryID(base)
	return ok
}

func removeIfExists(fsys filesystem.FileSystem, path string) error {
	info, err := filesystem.Lstat(fsys, path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%w: %s is not a regular file", filesystem.ErrPathTypeMismatch, path)
	}
	err = fsys.Remove(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// createArchiveDirLocked creates the archive path one component at a time so
// every level Firn owns ends up at 0700. MkdirAll leaves an existing directory's
// mode alone, and ~/.firn predates run history on any install that already ran a
// managed language server, so it is commonly still 0755 — which would leave the
// whole archive tree traversable by other local accounts.
func (s *Store) createArchiveDirLocked(dir string) error {
	historyDir := filepath.Join(s.firnDir, "run-history")
	owned := []string{s.firnDir, historyDir}
	if parent := filepath.Dir(dir); parent != historyDir {
		owned = append(owned, parent)
	}
	owned = append(owned, dir)
	for _, path := range owned {
		if err := filesystem.EnsureDirPerm(s.fs, path, 0o700); err != nil {
			return fmt.Errorf("creating run history directory: %w", err)
		}
	}
	return nil
}

func (s *Store) validateArchiveDir(dir string) (bool, error) {
	historyDir := filepath.Join(s.firnDir, "run-history")
	paths := []string{s.firnDir, historyDir}
	if parent := filepath.Dir(dir); parent != historyDir {
		paths = append(paths, parent)
	}
	paths = append(paths, dir)
	for _, path := range paths {
		info, err := filesystem.Lstat(s.fs, path)
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, fmt.Errorf("reading run history directory: %w", err)
		}
		if !info.IsDir() {
			return false, fmt.Errorf("%w: %s is not a directory", filesystem.ErrPathTypeMismatch, path)
		}
	}
	return true, nil
}

func (s *Store) regularFileInfo(path string) (fs.FileInfo, error) {
	info, err := filesystem.Lstat(s.fs, path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: %s is not a regular file", filesystem.ErrPathTypeMismatch, path)
	}
	return info, nil
}

func (s *Store) writeFileAtomicLocked(dir, path string, data []byte) error {
	exists, err := s.validateArchiveDir(dir)
	if err != nil {
		return err
	}
	if !exists {
		return fs.ErrNotExist
	}
	if _, err := s.regularFileInfo(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return filesystem.WriteFileAtomic(s.fs, path, data, 0o600)
}

func (s *Store) removeOwnedFileLocked(dir, path string) error {
	exists, err := s.validateArchiveDir(dir)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	return removeIfExists(s.fs, path)
}

func (s *Store) recordLimit() int {
	if s.canonicalRecordLimit > 0 {
		return s.canonicalRecordLimit
	}
	return maxCanonicalRecords
}

func joinWarnings(warnings ...string) string {
	var nonempty []string
	for _, warning := range warnings {
		if strings.TrimSpace(warning) != "" {
			nonempty = append(nonempty, warning)
		}
	}
	return strings.Join(nonempty, "; ")
}

func recordPath(dir, historyID string) string {
	return filepath.Join(dir, historyID+".json")
}
