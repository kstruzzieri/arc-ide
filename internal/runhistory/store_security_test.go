package runhistory

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"firn/internal/filesystem"
	"github.com/google/uuid"
)

const phase2CValidIndexRecordJSON = `{"historyId":"01900000-0000-7000-8000-000000000001","kind":"ordinary","profileId":"build","profileName":"Build","state":"success","exitCode":0,"startedAt":1,"completedAt":2,"outputAvailable":true,"size":1,"modifiedAt":1}`

// Windows only grants SeCreateSymbolicLinkPrivilege under Developer Mode or
// elevation. Probe the capability once, up front, so an unsupported host skips
// for exactly that reason and every other os.Symlink failure stays a hard
// failure. Skipping on any error instead would let a real regression — a bad
// recordPath, a missing parent — pass as "unsupported" on the Windows job.
var symlinkSupported = func() bool {
	dir, err := os.MkdirTemp("", "firn-symlink-probe")
	if err != nil {
		return false
	}
	defer func() { _ = os.RemoveAll(dir) }()
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		return false
	}
	return os.Symlink(target, filepath.Join(dir, "link")) == nil
}()

func requireSymlinks(t *testing.T) {
	t.Helper()
	if !symlinkSupported {
		t.Skipf("symlink creation is unavailable on %s", runtime.GOOS)
	}
}

func TestStorePhase2C_RefusesSymlinkedArchiveDirectory(t *testing.T) {
	requireSymlinks(t)
	historyID, err := uuid.NewV7()
	if err != nil {
		t.Fatalf("NewV7: %v", err)
	}
	tests := map[string]func(*Store) error{
		"Snapshot": func(store *Store) error {
			_, err := store.Snapshot(phase2CWorkspacePath)
			return err
		},
		"Append": func(store *Store) error {
			_, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("build", 1, "secret"))
			return err
		},
		"ClearRecord": func(store *Store) error {
			return store.ClearRecord(phase2CWorkspacePath, historyID.String())
		},
		"ClearAll": func(store *Store) error {
			return store.ClearAll(phase2CWorkspacePath)
		},
	}
	for component := range map[string]struct{}{"firn": {}, "run-history": {}, "workspace": {}} {
		for name, operation := range tests {
			t.Run(component+"/"+name, func(t *testing.T) {
				home := t.TempDir()
				target := t.TempDir()
				marker := filepath.Join(target, "outside")
				if err := os.WriteFile(marker, []byte("unchanged"), 0o600); err != nil {
					t.Fatalf("write marker: %v", err)
				}
				firnDir := filepath.Join(home, "firn")
				store := NewStore(filesystem.NewOS(), firnDir)
				dir, err := store.workspaceDir(phase2CWorkspacePath)
				if err != nil {
					t.Fatalf("workspaceDir: %v", err)
				}
				var symlinkPath string
				switch component {
				case "firn":
					symlinkPath = firnDir
				case "run-history":
					if err := os.MkdirAll(firnDir, 0o700); err != nil {
						t.Fatalf("MkdirAll(firn): %v", err)
					}
					symlinkPath = filepath.Dir(dir)
				case "workspace":
					if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
						t.Fatalf("MkdirAll(run-history): %v", err)
					}
					symlinkPath = dir
				}
				if err := os.Symlink(target, symlinkPath); err != nil {
					t.Fatalf("Symlink: %v", err)
				}

				if err := operation(store); !errors.Is(err, filesystem.ErrPathTypeMismatch) {
					t.Fatalf("%s error = %v, want ErrPathTypeMismatch", name, err)
				}
				entries, err := os.ReadDir(target)
				if err != nil {
					t.Fatalf("ReadDir(target): %v", err)
				}
				if len(entries) != 1 || entries[0].Name() != "outside" {
					t.Fatalf("redirected target was modified: %#v", entries)
				}
			})
		}
	}
}

// The three owned paths are refused by two different guards, and naming which
// one is the point: the index is read through the bounded reader, so the
// no-follow open refuses it outright, while a canonical record and an owned temp
// are typed by Lstat during reconciliation before any open happens. Asserting
// the umbrella hid that split, and hid that the "index" case is the only one
// here that exercises openReadNoFollow at all.
func TestStorePhase2C_RefusesSymlinkedOwnedFiles(t *testing.T) {
	requireSymlinks(t)
	tests := map[string]error{
		"index":     filesystem.ErrSymlinkRefused,
		"canonical": filesystem.ErrPathTypeMismatch,
		"temp":      filesystem.ErrPathTypeMismatch,
	}
	for name, wantErr := range tests {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			store := NewStore(filesystem.NewOS(), home)
			dir, err := store.workspaceDir(phase2CWorkspacePath)
			if err != nil {
				t.Fatalf("workspaceDir: %v", err)
			}
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatalf("MkdirAll: %v", err)
			}
			target := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(target, []byte("unchanged"), 0o600); err != nil {
				t.Fatalf("write target: %v", err)
			}
			historyID, err := uuid.NewV7()
			if err != nil {
				t.Fatalf("NewV7: %v", err)
			}
			var path string
			switch name {
			case "index":
				path = filepath.Join(dir, "index.json")
			case "canonical":
				path = recordPath(dir, historyID.String())
			case "temp":
				path = recordPath(dir, historyID.String()) + ".0123456789abcdef"
			}
			if err := os.Symlink(target, path); err != nil {
				t.Fatalf("Symlink: %v", err)
			}

			if _, err := store.Snapshot(phase2CWorkspacePath); !errors.Is(err, wantErr) {
				t.Fatalf("Snapshot error = %v, want %v", err, wantErr)
			}
			data, err := os.ReadFile(target)
			if err != nil {
				t.Fatalf("ReadFile(target): %v", err)
			}
			if string(data) != "unchanged" {
				t.Fatalf("redirected target was modified: %q", data)
			}
		})
	}
}

func TestStorePhase2C_RefusesOwnedDirectories(t *testing.T) {
	for _, name := range []string{"index", "canonical", "temp"} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			store := NewStore(filesystem.NewOS(), home)
			dir, err := store.workspaceDir(phase2CWorkspacePath)
			if err != nil {
				t.Fatalf("workspaceDir: %v", err)
			}
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatalf("MkdirAll: %v", err)
			}
			historyID, err := uuid.NewV7()
			if err != nil {
				t.Fatalf("NewV7: %v", err)
			}
			var path string
			switch name {
			case "index":
				path = filepath.Join(dir, "index.json")
			case "canonical":
				path = recordPath(dir, historyID.String())
			case "temp":
				path = recordPath(dir, historyID.String()) + ".0123456789abcdef"
			}
			if err := os.Mkdir(path, 0o700); err != nil {
				t.Fatalf("Mkdir(owned path): %v", err)
			}

			if _, err := store.Snapshot(phase2CWorkspacePath); !errors.Is(err, filesystem.ErrPathTypeMismatch) {
				t.Fatalf("Snapshot error = %v, want ErrPathTypeMismatch", err)
			}
		})
	}
}

func TestStorePhase2C_FIFOsReturnPromptly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("FIFOs are not portable on Windows")
	}
	mkfifo, err := exec.LookPath("mkfifo")
	if err != nil {
		t.Skip("mkfifo is unavailable")
	}
	tests := []string{"index.json", "canonical"}
	for _, name := range tests {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			store := NewStore(filesystem.NewOS(), home)
			dir, err := store.workspaceDir(phase2CWorkspacePath)
			if err != nil {
				t.Fatalf("workspaceDir: %v", err)
			}
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatalf("MkdirAll: %v", err)
			}
			path := filepath.Join(dir, name)
			if name == "canonical" {
				historyID, err := uuid.NewV7()
				if err != nil {
					t.Fatalf("NewV7: %v", err)
				}
				path = recordPath(dir, historyID.String())
			}
			if output, err := exec.Command(mkfifo, path).CombinedOutput(); err != nil {
				t.Fatalf("mkfifo: %v: %s", err, output)
			}

			done := make(chan error, 1)
			go func() {
				_, err := store.Snapshot(phase2CWorkspacePath)
				done <- err
			}()
			select {
			case err := <-done:
				if !errors.Is(err, filesystem.ErrPathTypeMismatch) {
					t.Fatalf("Snapshot error = %v, want ErrPathTypeMismatch", err)
				}
			case <-time.After(500 * time.Millisecond):
				writer, openErr := os.OpenFile(path, os.O_WRONLY, 0)
				if openErr == nil {
					_ = writer.Close()
				}
				<-done
				t.Fatal("Snapshot blocked opening a FIFO")
			}
		})
	}
}

func TestStorePhase2C_CanonicalRecordLimitSelfHeals(t *testing.T) {
	home := t.TempDir()
	seed := NewStore(filesystem.NewOS(), home)
	seed.canonicalRecordLimit = 3
	for i := 1; i <= 3; i++ {
		if _, err := seed.Append(phase2CWorkspacePath, phase2COrdinaryInput("profile", int64(i), "saved")); err != nil {
			t.Fatalf("seed Append %d: %v", i, err)
		}
	}

	store := NewStore(filesystem.NewOS(), home)
	store.canonicalRecordLimit = 2
	snapshot, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot one over limit: %v", err)
	}
	if len(snapshot.Summaries) != 2 ||
		snapshot.Summaries[0].CompletedAt != 2 ||
		snapshot.Summaries[1].CompletedAt != 3 {
		t.Fatalf("reconciled summaries = %#v, want newest two", snapshot.Summaries)
	}
	if _, err := store.Append(phase2CWorkspacePath, phase2COrdinaryInput("profile", 4, "saved")); err != nil {
		t.Fatalf("Append over limit: %v", err)
	}
	snapshot, err = store.Snapshot(phase2CWorkspacePath)
	if err != nil || len(snapshot.Summaries) != 2 || snapshot.Summaries[1].CompletedAt != 4 {
		t.Fatalf("post-Append Snapshot = %#v, err = %v", snapshot, err)
	}
	if err := store.ClearAll(phase2CWorkspacePath); err != nil {
		t.Fatalf("ClearAll after pruning: %v", err)
	}
}

func TestStorePhase2C_DecodersRejectExcessiveCardinality(t *testing.T) {
	var record strings.Builder
	record.WriteString(`{"version":1,"historyId":"01900000-0000-7000-8000-000000000001","kind":"ordinary","profileId":"build","profileName":"Build","state":"completed","outputAvailable":true,"entries":[`)
	for i := 0; i < maxEntries+1; i++ {
		if i > 0 {
			record.WriteByte(',')
		}
		record.WriteString(`{"stream":"stdout","text":"x","timestamp":1}`)
	}
	record.WriteString(`]}`)
	if _, err := decodeRecord([]byte(record.String()), maxEntries); err == nil ||
		!strings.Contains(err.Error(), "more than") {
		t.Fatalf("record decoder cardinality error = %v", err)
	}

	var index strings.Builder
	index.WriteString(`{"version":1,"records":[`)
	for i := 0; i < maxCanonicalRecords+1; i++ {
		if i > 0 {
			index.WriteByte(',')
		}
		index.WriteString(phase2CValidIndexRecordJSON)
	}
	index.WriteString(`]}`)
	if _, err := decodeIndex([]byte(index.String()), maxCanonicalRecords); err == nil ||
		!strings.Contains(err.Error(), "more than") {
		t.Fatalf("index decoder cardinality error = %v", err)
	}
}

func TestStorePhase2C_DecodeIndexRejectsDuplicateRecordArrays(t *testing.T) {
	data := []byte(
		`{"version":1,"records":[` + phase2CValidIndexRecordJSON + `,` +
			phase2CValidIndexRecordJSON + `],"records":[` +
			phase2CValidIndexRecordJSON + `,` + phase2CValidIndexRecordJSON + `]}`,
	)
	if _, err := decodeIndex(data, 2); err == nil {
		t.Fatal("decodeIndex accepted duplicate records arrays that reset the cardinality limit")
	}
}

func TestStorePhase2C_DecoderRejectsInvalidDurableSchemas(t *testing.T) {
	valid := Record{
		Version: storeVersion,
		Summary: Summary{
			HistoryID:       "01900000-0000-7000-8000-000000000001",
			Kind:            RecordKindOrdinary,
			ProfileID:       "build",
			ProfileName:     "Build",
			State:           "completed",
			OutputAvailable: true,
		},
		WorkingDir: phase2CWorkspacePath,
		Entries:    []OutputEntry{{Stream: "stdout", Text: "ok"}},
	}
	tests := map[string]Record{
		"invalid kind": func() Record {
			record := valid
			record.Kind = "unknown"
			return record
		}(),
		"oversized profile ID": func() Record {
			record := valid
			record.ProfileID = strings.Repeat("x", (4<<10)+1)
			return record
		}(),
		"compound rich payload": func() Record {
			record := valid
			record.Kind = RecordKindCompoundStep
			return record
		}(),
		"redacted rich payload": func() Record {
			record := valid
			record.OutputAvailable = false
			return record
		}(),
	}
	for name, record := range tests {
		t.Run(name, func(t *testing.T) {
			data, err := json.Marshal(record)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if _, err := decodeRecord(data, maxEntries); err == nil {
				t.Fatal("record decoder accepted invalid durable schema")
			}
		})
	}
}

// uuid.Parse also accepts the "urn:uuid:", braced, and unhyphenated encodings of
// a v7 UUID. Each names a different file under recordPath, and ':' opens an NTFS
// alternate data stream on Windows, so only the canonical form is a valid ID.
func TestStorePhase2C_RejectsNonCanonicalHistoryIDEncodings(t *testing.T) {
	// Hex letters in every group so the uppercase encoding is a distinct string.
	canonical := "019abcde-0000-7000-8abc-0000000000ff"
	if err := validateHistoryID(canonical); err != nil {
		t.Fatalf("canonical ID must stay valid: %v", err)
	}
	for _, historyID := range []string{
		"urn:uuid:" + canonical,
		"{" + canonical + "}",
		strings.ReplaceAll(canonical, "-", ""),
		strings.ToUpper(canonical),
	} {
		if err := validateHistoryID(historyID); err == nil {
			t.Errorf("validateHistoryID(%q) = nil, want error (resolves to %q)",
				historyID, recordPath("dir", historyID))
		}
		if _, ok := canonicalHistoryID(historyID + ".json"); ok {
			t.Errorf("canonicalHistoryID(%q.json) accepted a non-canonical managed name", historyID)
		}
	}

	dir := t.TempDir()
	store := NewStore(filesystem.NewOS(), dir)
	workspace := filepath.Join(dir, "ws")
	summary, err := store.Append(workspace, RecordInput{
		Kind: RecordKindOrdinary, ProfileID: "build", ProfileName: "Build", State: "success",
		Entries: []OutputEntry{{Stream: "stdout", Text: "hello"}},
	})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if _, err := store.GetRecord(workspace, "urn:uuid:"+summary.HistoryID); err == nil {
		t.Fatal("GetRecord accepted a urn:uuid: encoding of a stored record")
	}
	if err := store.ClearRecord(workspace, "{"+summary.HistoryID+"}"); err == nil {
		t.Fatal("ClearRecord accepted a braced encoding of a stored record")
	}
	if _, err := store.GetRecord(workspace, summary.HistoryID); err != nil {
		t.Fatalf("canonical GetRecord must still succeed: %v", err)
	}
}

// ~/.firn predates run history on any install that ran a managed language
// server, and MkdirAll leaves an existing directory's mode alone. A 0755 parent
// leaves the whole 0700 archive tree traversable by other local accounts.
func TestStorePhase2C_TightensAPreexistingLooseFirnTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows os.Chmod models only the read-only attribute, not POSIX mode bits")
	}
	home := t.TempDir()
	firnDir := filepath.Join(home, ".firn")
	if err := os.MkdirAll(filepath.Join(firnDir, "run-history"), 0o755); err != nil {
		t.Fatalf("seed legacy 0755 tree: %v", err)
	}

	store := NewStore(filesystem.NewOS(), firnDir)
	if _, err := store.Append(phase2CWorkspacePath, RecordInput{
		Kind: RecordKindOrdinary, ProfileID: "build", ProfileName: "Build", State: "success",
	}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	for _, dir := range []string{firnDir, filepath.Join(firnDir, "run-history")} {
		info, err := os.Lstat(dir)
		if err != nil {
			t.Fatalf("Lstat %s: %v", dir, err)
		}
		if info.Mode().Perm() != 0o700 {
			t.Errorf("%s mode = %o, want 0700", dir, info.Mode().Perm())
		}
	}
}

// Output dropped to fit the record budget must be marked, or the archived run
// renders as complete and Diff invents a tail difference against a full run.
func TestStorePhase2C_MarksTruncatedOutput(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)

	small, err := store.Append(phase2CWorkspacePath, RecordInput{
		Kind: RecordKindOrdinary, ProfileID: "build", ProfileName: "Build", State: "success",
		Entries: []OutputEntry{{Stream: "stdout", Text: "short"}},
	})
	if err != nil {
		t.Fatalf("Append small: %v", err)
	}
	if small.Truncated {
		t.Error("a record that fits must not be marked truncated")
	}

	// One entry per megabyte, well past the 10 MiB record ceiling.
	oversized := make([]OutputEntry, 32)
	for i := range oversized {
		oversized[i] = OutputEntry{Stream: "stdout", Text: strings.Repeat("x", 1<<20)}
	}
	big, err := store.Append(phase2CWorkspacePath, RecordInput{
		Kind: RecordKindOrdinary, ProfileID: "build", ProfileName: "Build", State: "success",
		Entries: oversized,
	})
	if err != nil {
		t.Fatalf("Append oversized: %v", err)
	}
	if !big.Truncated {
		t.Fatal("dropped output was not marked truncated")
	}

	// The flag must survive the round trip, and reconciliation must read it back
	// off the index rather than losing it.
	record, err := store.GetRecord(phase2CWorkspacePath, big.HistoryID)
	if err != nil {
		t.Fatalf("GetRecord: %v", err)
	}
	if !record.Truncated {
		t.Fatal("round trip lost the truncation flag")
	}
	// The budget sheds text before it sheds whole entries, so compare bytes
	// rather than entry counts.
	var savedBytes, sourceBytes int
	for _, entry := range record.Entries {
		savedBytes += len(entry.Text)
	}
	for _, entry := range oversized {
		sourceBytes += len(entry.Text)
	}
	if savedBytes >= sourceBytes {
		t.Fatalf("nothing was actually dropped: saved %d of %d bytes", savedBytes, sourceBytes)
	}
	snapshot, err := store.Snapshot(phase2CWorkspacePath)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	for _, summary := range snapshot.Summaries {
		if summary.HistoryID == big.HistoryID && !summary.Truncated {
			t.Fatal("index summary lost the truncation flag")
		}
	}
}

// A caller that already dropped output before crossing the binding reports it,
// and redaction clears a flag that no longer describes anything.
func TestStorePhase2C_CarriesCallerTruncationAndClearsItOnRedaction(t *testing.T) {
	home := t.TempDir()
	store := NewStore(filesystem.NewOS(), home)
	saved, err := store.Append(phase2CWorkspacePath, RecordInput{
		Kind: RecordKindOrdinary, ProfileID: "build", ProfileName: "Build", State: "success",
		Entries: []OutputEntry{{Stream: "stdout", Text: "kept"}}, Truncated: true,
	})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if !saved.Truncated {
		t.Fatal("caller-reported truncation was dropped")
	}
	if err := store.ClearRecord(phase2CWorkspacePath, saved.HistoryID); err != nil {
		t.Fatalf("ClearRecord: %v", err)
	}
	record, err := store.GetRecord(phase2CWorkspacePath, saved.HistoryID)
	if err != nil {
		t.Fatalf("GetRecord: %v", err)
	}
	if record.OutputAvailable || record.Truncated {
		t.Fatalf("redacted record kept output state: available=%v truncated=%v",
			record.OutputAvailable, record.Truncated)
	}
}
