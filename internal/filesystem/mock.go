package filesystem

import (
	"fmt"
	"io/fs"
)

// Mock is a test implementation of the FileSystem interface.
type Mock struct {
	ReadDirFunc   func(path string) ([]fs.DirEntry, error)
	ReadFileFunc  func(path string) ([]byte, error)
	WriteFileFunc func(path string, data []byte, perm fs.FileMode) error
	StatFunc      func(path string) (fs.FileInfo, error)
	MkdirAllFunc  func(path string, perm fs.FileMode) error
	RemoveFunc    func(path string) error
	RenameFunc    func(oldpath, newpath string) error
}

func (m *Mock) ReadDir(path string) ([]fs.DirEntry, error) {
	if m.ReadDirFunc != nil {
		return m.ReadDirFunc(path)
	}
	return nil, nil
}

func (m *Mock) ReadFile(path string) ([]byte, error) {
	if m.ReadFileFunc != nil {
		return m.ReadFileFunc(path)
	}
	return nil, nil
}

func (m *Mock) WriteFile(path string, data []byte, perm fs.FileMode) error {
	if m.WriteFileFunc != nil {
		return m.WriteFileFunc(path, data, perm)
	}
	return nil
}

func (m *Mock) Stat(path string) (fs.FileInfo, error) {
	if m.StatFunc != nil {
		return m.StatFunc(path)
	}
	// A nil FileInfo with a nil error is not a valid fs.Stat result: success
	// means the info is dereferenceable, and every caller does dereference it —
	// filesystem.Lstat falls back to Stat, so an unset StatFunc used to hand a
	// nil info to code that immediately called IsDir() or Mode() on it. Report a
	// not-exist error instead so a test missing a stub fails where the gap is.
	return nil, fmt.Errorf("%w: Mock.StatFunc is not set for %s", fs.ErrNotExist, path)
}

func (m *Mock) MkdirAll(path string, perm fs.FileMode) error {
	if m.MkdirAllFunc != nil {
		return m.MkdirAllFunc(path, perm)
	}
	return nil
}

func (m *Mock) Remove(path string) error {
	if m.RemoveFunc != nil {
		return m.RemoveFunc(path)
	}
	return nil
}

func (m *Mock) Rename(oldpath, newpath string) error {
	if m.RenameFunc != nil {
		return m.RenameFunc(oldpath, newpath)
	}
	return nil
}
