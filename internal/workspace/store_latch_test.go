package workspace

import (
	"encoding/json"
	"errors"
	"firn/internal/filesystem"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// A file this session could not read back faithfully must never be replaced
// by defaults on the next Save (#290). The latch is per workspace file, the
// error names the file so the user can find it, and a healthy sibling
// workspace keeps saving.
func TestStoreLoadFailureBlocksSaveAndPreservesBytes(t *testing.T) {
	cases := map[string]string{
		// #271's pointer bool, hand-edited into a string.
		"type mismatch":   `{"version":1,"state":{"workspacePath":"/project","layout":{"golemCollapsed":"false"}}}`,
		"malformed":       `{invalid`,
		"missing version": `{"state":{"workspacePath":"/project"}}`,
		// A newer Firn's schema: the type change must not be what gets reported.
		"future": `{"version":2,"state":{"workspacePath":"/project","layout":{"panelSizes":{"left":{"px":260}}}}}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			mockFS := newMockFS()
			path := filepath.Join(testWorkspaceBaseDir, pathToID("/project")+".json")
			_ = mockFS.WriteFile(path, []byte(raw), 0o644)

			store := NewStore(mockFS, testWorkspaceBaseDir)
			_, err := store.Load("/project")
			if err == nil {
				t.Fatal("Load must reject the file")
			}
			if !strings.Contains(err.Error(), path) {
				t.Errorf("Load error must name the file, got: %v", err)
			}
			if name == "type mismatch" && !strings.Contains(err.Error(), "golemCollapsed") {
				t.Errorf("Load error must name the failing field, got: %v", err)
			}
			// A missing or zero version is a corrupt file, never a newer Firn.
			if name == "missing version" && !strings.Contains(err.Error(), "missing or invalid version") {
				t.Errorf("Load error must call a missing version corrupt, got: %v", err)
			}
			if name == "missing version" && strings.Contains(err.Error(), "unsupported") {
				t.Errorf("Load error must not blame a newer Firn for a missing version, got: %v", err)
			}
			// A newer version is reported as such even when its schema no longer
			// decodes, so the remedy never tells the user to remove a live file.
			if name == "future" && !strings.Contains(err.Error(), "unsupported workspace state version") {
				t.Errorf("Load error must report a newer version, not a decode failure, got: %v", err)
			}

			saveErr := store.Save(testState("/project", "project"))
			if saveErr == nil {
				t.Fatal("Save after a failed Load must be refused")
			}
			if !strings.Contains(saveErr.Error(), "preserve") || !strings.Contains(saveErr.Error(), err.Error()) {
				t.Errorf("Save error must state the consequence and carry the Load failure, got: %v", saveErr)
			}
			// The remedy follows the cause: a newer Firn's file is for that
			// Firn, never "fix or remove"; everything else is repairable.
			if name == "future" {
				if !errors.Is(saveErr, ErrUnknownVersion) || !strings.Contains(saveErr.Error(), "newer Firn") || strings.Contains(saveErr.Error(), "fix or remove") {
					t.Errorf("Save refusal for a newer file must point at that Firn, got: %v", saveErr)
				}
			} else if !strings.Contains(saveErr.Error(), "fix or remove it, then restart Firn") {
				t.Errorf("Save refusal must carry the repair remedy, got: %v", saveErr)
			}
			if got, _ := mockFS.ReadFile(path); string(got) != raw {
				t.Fatalf("file bytes changed by a blocked Save:\n got: %s\nwant: %s", got, raw)
			}

			if err := store.Save(testState("/other", "other")); err != nil {
				t.Fatalf("Save for an unaffected workspace must proceed: %v", err)
			}
			if got, _ := mockFS.ReadFile(path); string(got) != raw {
				t.Fatal("sibling Save touched the blocked file")
			}

			// The latch holds for the session even after the file reads
			// cleanly again: the backend loads these files on its own (LSP
			// seeding, interpreter persist) while the frontend may still be
			// running on defaults from its failed load, so a later clean
			// read is no proof that the in-memory session reflects the file.
			fixed, _ := json.Marshal(StateFile{Version: 1, State: testState("/project", "project")})
			_ = mockFS.WriteFile(path, fixed, 0o644)
			if _, err := store.Load("/project"); err != nil {
				t.Fatalf("Load of the repaired file: %v", err)
			}
			if err := store.Save(testState("/project", "defaults")); err == nil {
				t.Fatal("Save must stay refused after a clean reload within the same session")
			}
			if got, _ := mockFS.ReadFile(path); string(got) != string(fixed) {
				t.Fatal("repaired file changed by a Save that should have been refused")
			}
		})
	}
}

// An unreadable file (permissions, I/O) latches the same way as an
// unparseable one: the store cannot know what it would be overwriting.
func TestStoreLoadReadErrorBlocksSave(t *testing.T) {
	mockFS := &filesystem.Mock{
		ReadFileFunc: func(path string) ([]byte, error) {
			return nil, errors.New("I/O error")
		},
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			t.Fatalf("Save must not write after a read failure (wrote %s)", path)
			return nil
		},
	}
	store := NewStore(mockFS, testWorkspaceBaseDir)
	if _, err := store.Load("/project"); err == nil {
		t.Fatal("expected error when ReadFile fails")
	}
	if err := store.Save(testState("/project", "project")); err == nil || !strings.Contains(err.Error(), "preserve") {
		t.Fatalf("Save after a read failure = %v, want the preserve-file refusal", err)
	}
}

// A Store that saves a workspace it never loaded has not seen what is on
// disk: it probes the file first and reaches the same latch, while a missing
// file still lets the first Save through.
func TestStoreSaveWithoutLoadProbesExistingFile(t *testing.T) {
	mockFS := newMockFS()
	path := filepath.Join(testWorkspaceBaseDir, pathToID("/project")+".json")
	raw := `{"version":1,"state":{"layout":{"golemCollapsed":"false"}}}`
	_ = mockFS.WriteFile(path, []byte(raw), 0o644)

	store := NewStore(mockFS, testWorkspaceBaseDir)
	if err := store.Save(testState("/project", "project")); err == nil {
		t.Fatal("Save over an unreadable file must be refused even without a prior Load")
	}
	if got, _ := mockFS.ReadFile(path); string(got) != raw {
		t.Fatal("file bytes changed by a Save that never called Load")
	}

	if err := store.Save(testState("/fresh", "fresh")); err != nil {
		t.Fatalf("Save with no existing file must proceed: %v", err)
	}
	if _, err := mockFS.ReadFile(filepath.Join(testWorkspaceBaseDir, pathToID("/fresh")+".json")); err != nil {
		t.Fatalf("fresh workspace file not written: %v", err)
	}

	// The probe must not over-block: a valid file the store never loaded is
	// overwritten by the first Save as before.
	validPath := filepath.Join(testWorkspaceBaseDir, pathToID("/valid")+".json")
	valid, _ := json.Marshal(StateFile{Version: 1, State: testState("/valid", "before")})
	_ = mockFS.WriteFile(validPath, valid, 0o644)
	if err := NewStore(mockFS, testWorkspaceBaseDir).Save(testState("/valid", "after")); err != nil {
		t.Fatalf("Save over a valid never-loaded file must proceed: %v", err)
	}
	if got, _ := mockFS.ReadFile(validPath); !strings.Contains(string(got), `"after"`) {
		t.Fatalf("valid never-loaded file was not overwritten, got: %s", got)
	}
}

// Zero bytes hold no session: an empty file reads as absent and the first
// Save fills it, instead of stranding the workspace behind an empty file.
func TestStoreEmptyFileReadsAsAbsent(t *testing.T) {
	mockFS := newMockFS()
	path := filepath.Join(testWorkspaceBaseDir, pathToID("/project")+".json")
	_ = mockFS.WriteFile(path, []byte(" \n"), 0o644)

	store := NewStore(mockFS, testWorkspaceBaseDir)
	state, err := store.Load("/project")
	if err != nil || state != nil {
		t.Fatalf("Load of an empty file = (%v, %v), want (nil, nil)", state, err)
	}
	if err := store.Save(testState("/project", "project")); err != nil {
		t.Fatalf("Save over an empty file must proceed: %v", err)
	}
	if got, _ := mockFS.ReadFile(path); !strings.Contains(string(got), `"version": 1`) {
		t.Fatalf("empty file not replaced by a saved session, got: %s", got)
	}
}
