package appstate

import (
	"encoding/json"
	"errors"
	"firn/internal/filesystem"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// Same byte-for-byte mock discipline as internal/workspace/store_test.go.
func newMockFS(t *testing.T) (*filesystem.Mock, map[string][]byte) {
	t.Helper()
	files := map[string][]byte{}
	dirs := map[string]bool{}
	return &filesystem.Mock{
		ReadFileFunc: func(path string) ([]byte, error) {
			data, ok := files[path]
			if !ok {
				return nil, fs.ErrNotExist
			}
			return data, nil
		},
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			if perm != 0o600 {
				t.Errorf("WriteFile perm = %v, want 0600", perm)
			}
			files[path] = data
			return nil
		},
		RemoveFunc: func(path string) error { delete(files, path); return nil },
		RenameFunc: func(oldPath, newPath string) error {
			data, ok := files[oldPath]
			if !ok {
				return fs.ErrNotExist
			}
			files[newPath] = data
			delete(files, oldPath)
			return nil
		},
		MkdirAllFunc: func(path string, perm fs.FileMode) error {
			if perm != 0o700 {
				t.Errorf("MkdirAll perm = %v, want 0700", perm)
			}
			dirs[path] = true
			return nil
		},
		ReadDirFunc: func(path string) ([]fs.DirEntry, error) {
			if !dirs[path] {
				return nil, fs.ErrNotExist
			}
			return nil, nil
		},
	}, files
}

var firnDir = filepath.FromSlash("/home/user/.firn")

func TestLoadMissingFileIsDockedDefault(t *testing.T) {
	fsys, _ := newMockFS(t)
	s := NewStore(fsys, firnDir)
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != Default() {
		t.Fatalf("Load() = %+v, want %+v", got, Default())
	}
}

func TestSaveThenLoadRoundTripsNegativeCoordinates(t *testing.T) {
	fsys, files := newMockFS(t)
	s := NewStore(fsys, firnDir)
	want := State{GolemWindow: GolemWindow{Mode: ModeUndocked, X: -1440, Y: 120, Width: 480, Height: 720}}
	if err := s.Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	path := filepath.Join(firnDir, "app.json")
	if _, ok := files[path]; !ok {
		t.Fatalf("app.json not written; files = %v", keys(files))
	}
	if !strings.Contains(string(files[path]), `"x": -1440`) {
		t.Fatalf("x not persisted verbatim: %s", files[path])
	}
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != want {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
}

func TestLoadNormalizesInvalidModeAndRejectsUnknownVersion(t *testing.T) {
	fsys, files := newMockFS(t)
	path := filepath.Join(firnDir, "app.json")
	files[path] = []byte(`{"version":1,"state":{"golemWindow":{"mode":"sideways","x":1,"y":2,"width":3,"height":4}}}`)
	s := NewStore(fsys, firnDir)
	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.GolemWindow.Mode != ModeDocked {
		t.Fatalf("invalid mode must normalize to docked, got %q", got.GolemWindow.Mode)
	}

	files[path] = []byte(`{"version":2,"state":{}}`)
	if _, err := s.Load(); !errors.Is(err, ErrUnknownVersion) {
		t.Fatalf("unknown version: err = %v, want ErrUnknownVersion", err)
	}
	before := string(files[path])
	if err := s.Save(Default()); !errors.Is(err, ErrUnknownVersion) {
		t.Fatalf("Save after future-version Load = %v, want blocked write", err)
	}
	if string(files[path]) != before {
		t.Fatal("future file changed after a later window preference save")
	}
}

// A missing or non-positive version is a corrupt or partial file, not one a
// newer Firn wrote: the latch is the same, the message must not blame the
// future.
func TestLoadTreatsVersionBelowOneAsCorrupt(t *testing.T) {
	for _, raw := range []string{`{}`, `{"version":0,"state":{}}`, `{"version":-1,"state":{}}`} {
		fsys, files := newMockFS(t)
		path := filepath.Join(firnDir, "app.json")
		files[path] = []byte(raw)
		s := NewStore(fsys, firnDir)
		_, err := s.Load()
		if err == nil || errors.Is(err, ErrUnknownVersion) {
			t.Fatalf("Load(%s) = %v, want a corrupt-file error that is not ErrUnknownVersion", raw, err)
		}
		if !strings.Contains(err.Error(), "version") {
			t.Fatalf("Load(%s) = %v, want the version named", raw, err)
		}
		if saveErr := s.Save(Default()); saveErr == nil || errors.Is(saveErr, ErrUnknownVersion) {
			t.Fatalf("Save after Load(%s) = %v, want the same corrupt-file latch", raw, saveErr)
		}
		if string(files[path]) != raw {
			t.Fatalf("file %s changed by a blocked Save", raw)
		}

		// The never-loaded probe reaches the same verdict.
		fresh := NewStore(fsys, firnDir)
		if probeErr := fresh.Save(Default()); probeErr == nil || errors.Is(probeErr, ErrUnknownVersion) {
			t.Fatalf("Save without Load over %s = %v, want the corrupt-file latch", raw, probeErr)
		}
	}
}

func TestSaveDisabledWithoutFirnDir(t *testing.T) {
	fsys, _ := newMockFS(t)
	s := NewStore(fsys, "")
	if err := s.Save(Default()); err == nil {
		t.Fatal("Save with no firnDir must fail loudly rather than write a relative path")
	}
	if _, err := s.Load(); err != nil {
		t.Fatalf("Load with no firnDir must still answer defaults: %v", err)
	}
}

func TestSaveWritesVersionedEnvelope(t *testing.T) {
	fsys, files := newMockFS(t)
	s := NewStore(fsys, firnDir)
	if err := s.Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	var sf StateFile
	if err := json.Unmarshal(files[filepath.Join(firnDir, "app.json")], &sf); err != nil {
		t.Fatal(err)
	}
	if sf.Version != 1 {
		t.Fatalf("Version = %d, want 1", sf.Version)
	}
}

func TestLoadReadErrorBlocksSubsequentSaveAndBytesUnchanged(t *testing.T) {
	fsys, files := newMockFS(t)
	path := filepath.Join(firnDir, "app.json")
	files[path] = []byte(`not json`)
	s := NewStore(fsys, firnDir)
	before := string(files[path])
	if _, err := s.Load(); err == nil {
		t.Fatal("Load with malformed JSON must return an error")
	}
	if err := s.Save(Default()); err == nil {
		t.Fatal("Save after a failed Load must stay blocked to avoid clobbering an unreadable file")
	}
	if string(files[path]) != before {
		t.Fatal("malformed file was modified by a blocked Save")
	}
}

func TestSaveWithoutLoadProbesExistingFileAndBlocksOnFutureVersion(t *testing.T) {
	fsys, files := newMockFS(t)
	path := filepath.Join(firnDir, "app.json")
	files[path] = []byte(`{"version":2,"state":{}}`)
	before := string(files[path])
	s := NewStore(fsys, firnDir)
	// No Load() call: Save must still refuse to clobber a future-version file.
	if err := s.Save(Default()); !errors.Is(err, ErrUnknownVersion) {
		t.Fatalf("Save without a prior Load = %v, want ErrUnknownVersion", err)
	}
	if string(files[path]) != before {
		t.Fatal("future-version file changed by a Save that never called Load")
	}
}

func TestSaveWithoutLoadAndNoExistingFileWritesNormally(t *testing.T) {
	fsys, files := newMockFS(t)
	s := NewStore(fsys, firnDir)
	// No Load() call and no file on disk: Save must proceed.
	if err := s.Save(Default()); err != nil {
		t.Fatalf("Save without a prior Load and no existing file: %v", err)
	}
	path := filepath.Join(firnDir, "app.json")
	if _, ok := files[path]; !ok {
		t.Fatalf("app.json not written; files = %v", keys(files))
	}
}

func TestSaveAtomicWriteFailureLeavesFileUnchanged(t *testing.T) {
	fsys, files := newMockFS(t)
	path := filepath.Join(firnDir, "app.json")
	files[path] = []byte(`{"version":1,"state":{"golemWindow":{"mode":"docked"}}}`)
	before := string(files[path])
	fsys.RenameFunc = func(oldPath, newPath string) error { return errors.New("rename failed") }
	s := NewStore(fsys, firnDir)
	if err := s.Save(Default()); err == nil {
		t.Fatal("Save must propagate an atomic-write (rename) failure")
	}
	if string(files[path]) != before {
		t.Fatal("file changed despite a failed atomic rename")
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
