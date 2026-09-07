package workspace

import (
	"firn/internal/filesystem"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

func TestStorePhase2C_SaveUsesUniqueAtomicTempsThroughSharedFilesystemSeam(t *testing.T) {
	var writes []string
	var writeModes []fs.FileMode
	var renames [][2]string
	var mkdirModes []fs.FileMode
	var mkdirPaths []string
	mockFS := &filesystem.Mock{
		MkdirAllFunc: func(path string, mode fs.FileMode) error {
			mkdirPaths = append(mkdirPaths, path)
			mkdirModes = append(mkdirModes, mode)
			return nil
		},
		WriteFileFunc: func(path string, _ []byte, mode fs.FileMode) error {
			writes = append(writes, path)
			writeModes = append(writeModes, mode)
			return nil
		},
		RenameFunc: func(oldPath, newPath string) error {
			renames = append(renames, [2]string{oldPath, newPath})
			return nil
		},
	}
	baseDir := filepath.FromSlash("/home/user/.firn/workspaces")
	store := NewStore(mockFS, baseDir)
	state := testState(filepath.FromSlash("/repo"), "Repo")

	if err := store.Save(state); err != nil {
		t.Fatalf("first Save: %v", err)
	}
	if err := store.Save(state); err != nil {
		t.Fatalf("second Save: %v", err)
	}

	finalPath := filepath.Join(baseDir, pathToID(state.WorkspacePath)+".json")
	if len(renames) != 2 {
		t.Fatalf("atomic rename count = %d, want 2; writes = %v", len(renames), writes)
	}
	// Two directories per Save: ~/.firn and ~/.firn/workspaces. The parent is
	// covered because MkdirAll leaves an existing directory's mode alone, so an
	// install that already created ~/.firn at 0755 would keep a world-traversable
	// parent over the 0600 state files.
	if len(mkdirModes) != 4 {
		t.Fatalf("MkdirAll count = %d, want 4", len(mkdirModes))
	}
	for i, mode := range mkdirModes {
		if mode.Perm() != 0o700 {
			t.Fatalf("MkdirAll %d mode = %o, want 0700", i, mode.Perm())
		}
	}
	if mkdirPaths[0] != filepath.Dir(baseDir) || mkdirPaths[1] != baseDir {
		t.Fatalf("MkdirAll paths = %v, want the .firn parent before the workspaces dir", mkdirPaths)
	}
	if renames[0][1] != finalPath || renames[1][1] != finalPath {
		t.Fatalf("rename destinations = %v, want %q", renames, finalPath)
	}
	if renames[0][0] == renames[1][0] ||
		!strings.HasPrefix(renames[0][0], finalPath+".") ||
		!strings.HasPrefix(renames[1][0], finalPath+".") {
		t.Fatalf("temp paths are not unique siblings of %q: %v", finalPath, renames)
	}
	for i, path := range writes {
		if path == finalPath {
			t.Fatalf("write %d targeted final path directly", i)
		}
		if writeModes[i].Perm() != 0o600 {
			t.Fatalf("write %d mode = %o, want 0600", i, writeModes[i].Perm())
		}
	}
}
