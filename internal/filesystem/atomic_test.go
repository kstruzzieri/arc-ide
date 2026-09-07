package filesystem

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestWriteFileAtomicCleansTempAfterRenameFailure(t *testing.T) {
	renameErr := errors.New("rename failed")
	var tempPath, removedPath string
	mock := &Mock{
		WriteFileFunc: func(path string, _ []byte, mode fs.FileMode) error {
			tempPath = path
			if mode.Perm() != 0o600 {
				t.Fatalf("temp mode = %o, want 0600", mode.Perm())
			}
			return nil
		},
		RenameFunc: func(_, _ string) error { return renameErr },
		RemoveFunc: func(path string) error {
			removedPath = path
			return nil
		},
	}

	err := WriteFileAtomic(mock, "/data/state.json", []byte("{}"), 0o600)
	if !errors.Is(err, renameErr) {
		t.Fatalf("WriteFileAtomic error = %v, want rename error", err)
	}
	if !strings.HasPrefix(tempPath, "/data/state.json.") || removedPath != tempPath {
		t.Fatalf("temp %q was not cleaned up; removed %q", tempPath, removedPath)
	}
}

// syncRecorder proves WriteFileAtomic drives the durable seam when one exists:
// data fsynced before the rename, directory fsynced after.
type syncRecorder struct {
	FileSystem
	order []string
}

func (s *syncRecorder) WriteFileSync(path string, data []byte, perm fs.FileMode) error {
	s.order = append(s.order, "write-sync")
	return s.WriteFile(path, data, perm)
}

func (s *syncRecorder) SyncDir(string) error {
	s.order = append(s.order, "sync-dir")
	return nil
}

func (s *syncRecorder) Rename(oldpath, newpath string) error {
	s.order = append(s.order, "rename")
	return s.FileSystem.Rename(oldpath, newpath)
}

func TestWriteFileAtomicFsyncsDataBeforeRenameAndDirAfter(t *testing.T) {
	dir := t.TempDir()
	recorder := &syncRecorder{FileSystem: NewOS()}
	path := filepath.Join(dir, "record.json")
	if err := WriteFileAtomic(recorder, path, []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	want := []string{"write-sync", "rename", "sync-dir"}
	if !reflect.DeepEqual(recorder.order, want) {
		t.Fatalf("durability order = %v, want %v", recorder.order, want)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != `{"a":1}` {
		t.Fatalf("ReadFile = %q, %v", data, err)
	}
}

func TestWriteFileAtomicStillWorksWithoutADurableSeam(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "record.json")
	// Mock implements neither WriteFileSync nor SyncDir.
	written := map[string][]byte{}
	mock := &Mock{
		WriteFileFunc: func(p string, data []byte, _ fs.FileMode) error {
			written[p] = data
			return nil
		},
		RenameFunc: func(oldpath, newpath string) error {
			written[newpath] = written[oldpath]
			delete(written, oldpath)
			return nil
		},
	}
	if err := WriteFileAtomic(mock, path, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFileAtomic without durable seam: %v", err)
	}
	if string(written[path]) != "x" {
		t.Fatalf("fallback write did not publish: %v", written)
	}
}

// The real OS write must refuse to land on a path that already exists, so a
// pre-planted temp name can never be reused.
func TestOSWriteFileSyncRefusesAnExistingPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "taken")
	if err := os.WriteFile(path, []byte("squatter"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := NewOS().WriteFileSync(path, []byte("new"), 0o600); err == nil {
		t.Fatal("WriteFileSync overwrote an existing path")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "squatter" {
		t.Fatalf("existing file was modified: %q", data)
	}
}

// writeSyncOnlyFS implements only the WriteFileSync half of the durable seam.
type writeSyncOnlyFS struct{ FileSystem }

func (writeSyncOnlyFS) WriteFileSync(string, []byte, fs.FileMode) error { return nil }

// syncDirOnlyFS implements only the SyncDir half of the durable seam.
type syncDirOnlyFS struct{ FileSystem }

func (syncDirOnlyFS) SyncDir(string) error { return nil }

func TestSyncDirectoryFailsClosedWithoutFullDurability(t *testing.T) {
	for name, fsys := range map[string]FileSystem{
		"no seam":         &Mock{},
		"write-sync only": writeSyncOnlyFS{&Mock{}},
		"sync-dir only":   syncDirOnlyFS{&Mock{}},
	} {
		if err := SyncDirectory(fsys, "/anywhere"); !errors.Is(err, ErrDurabilityUnavailable) {
			t.Errorf("%s: SyncDirectory = %v, want ErrDurabilityUnavailable", name, err)
		}
	}
}

// syncDirRecorderFS has the full seam and records the delegated path/result.
type syncDirRecorderFS struct {
	FileSystem
	path string
	err  error
}

func (syncDirRecorderFS) WriteFileSync(string, []byte, fs.FileMode) error { return nil }

func (s *syncDirRecorderFS) SyncDir(path string) error {
	s.path = path
	return s.err
}

func TestSyncDirectoryDelegatesAndPropagatesErrors(t *testing.T) {
	rec := &syncDirRecorderFS{FileSystem: &Mock{}}
	if err := SyncDirectory(rec, "/data"); err != nil || rec.path != "/data" {
		t.Fatalf("SyncDirectory = %v, delegated path %q, want nil and /data", err, rec.path)
	}
	rec.err = errors.New("sync refused")
	if err := SyncDirectory(rec, "/data"); !errors.Is(err, rec.err) {
		t.Fatalf("SyncDirectory = %v, want the seam's error", err)
	}
}

func TestSyncDirectoryOnTheRealFilesystem(t *testing.T) {
	if err := SyncDirectory(NewOS(), t.TempDir()); err != nil {
		t.Fatalf("SyncDirectory on a real directory: %v", err)
	}
	if err := SyncDirectory(NewOS(), filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("SyncDirectory on a missing directory returned nil")
	}
	if runtime.GOOS == "windows" {
		file := filepath.Join(t.TempDir(), "file")
		if err := os.WriteFile(file, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := SyncDirectory(NewOS(), file); !errors.Is(err, ErrPathTypeMismatch) {
			t.Fatalf("SyncDirectory on a regular file = %v, want ErrPathTypeMismatch", err)
		}
	}
}

func TestEnsureDirPermTightensAPreexistingLooseDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows os.Chmod models only the read-only attribute, not POSIX mode bits")
	}
	root := t.TempDir()
	dir := filepath.Join(root, "firn")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := EnsureDirPerm(NewOS(), dir, 0o700); err != nil {
		t.Fatalf("EnsureDirPerm: %v", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatalf("Lstat: %v", err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %o, want 0700 (MkdirAll alone leaves an existing dir untouched)", info.Mode().Perm())
	}
}

func TestEnsureDirPermRejectsANonDirectoryAndToleratesAMock(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows os.Chmod models only the read-only attribute, not POSIX mode bits")
	}
	root := t.TempDir()
	file := filepath.Join(root, "notadir")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// MkdirAll itself refuses a plain file; the point is that it is reported.
	if err := EnsureDirPerm(NewOS(), file, 0o700); err == nil {
		t.Fatal("EnsureDirPerm on a file returned nil")
	}

	// A symlink pointing at a directory is the case MkdirAll accepts: it stats
	// through the link and sees a directory. Chmod would then re-mode the target
	// outside the tree Firn owns, so Lstat has to catch it.
	target := filepath.Join(root, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	requireSymlinks(t)
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	// EnsureDirPerm has no no-follow open to refuse with; Lstat catching the
	// wrong type is exactly the guard under test here.
	if err := EnsureDirPerm(NewOS(), link, 0o700); !errors.Is(err, ErrPathTypeMismatch) {
		t.Fatalf("EnsureDirPerm on a symlinked dir = %v, want ErrPathTypeMismatch", err)
	}
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatalf("Lstat target: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("symlink target was re-moded to %o", info.Mode().Perm())
	}
	// A filesystem with no Chmod seam must still get its directory rather than
	// failing the caller's save.
	if err := EnsureDirPerm(&Mock{}, "/anywhere", 0o700); err != nil {
		t.Fatalf("EnsureDirPerm on a mock = %v, want nil", err)
	}
}
