package filesystem

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
)

// OS implements FileSystem using the real OS filesystem.
type OS struct{}

// NewOS creates a new OS filesystem implementation.
func NewOS() *OS {
	return &OS{}
}

func (o *OS) ReadDir(path string) ([]fs.DirEntry, error) {
	return os.ReadDir(path)
}

func (o *OS) ReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (o *OS) ReadFileLimited(path string, limit int64) ([]byte, fs.FileInfo, error) {
	file, err := openReadNoFollow(path, false)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, info, fmt.Errorf("%w: %s is not a regular file", ErrPathTypeMismatch, path)
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, info, err
	}
	if !before.Mode().IsRegular() || !os.SameFile(before, info) {
		return nil, info, fmt.Errorf("%w: %s changed before open", ErrPathChanged, path)
	}
	if info.Size() > limit {
		return nil, info, fmt.Errorf("file exceeds %d bytes", limit)
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, info, err
	}
	if int64(len(data)) > limit {
		return nil, info, fmt.Errorf("file exceeds %d bytes", limit)
	}
	if int64(len(data)) != info.Size() {
		return nil, info, fmt.Errorf("file changed during bounded read")
	}
	return data, info, nil
}

func (o *OS) ReadDirLimited(path string, limit int) ([]fs.DirEntry, error) {
	dir, err := openReadNoFollow(path, true)
	if err != nil {
		return nil, err
	}
	defer func() { _ = dir.Close() }()
	opened, err := dir.Stat()
	if err != nil {
		return nil, err
	}
	if !opened.IsDir() {
		return nil, fmt.Errorf("%w: %s is not a directory", ErrPathTypeMismatch, path)
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || !os.SameFile(before, opened) {
		return nil, fmt.Errorf("%w: %s changed before open", ErrPathChanged, path)
	}
	entries, err := dir.ReadDir(limit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > limit {
		return nil, fmt.Errorf("directory exceeds %d entries", limit)
	}
	return entries, nil
}

func (o *OS) WriteFile(path string, data []byte, perm fs.FileMode) error {
	return os.WriteFile(path, data, perm)
}

// WriteFileSync writes data and flushes it to stable storage before returning,
// so a following rename cannot publish a directory entry whose blocks are still
// only in the page cache. O_EXCL refuses to reuse an existing path: callers pass
// a freshly randomized temp name, so a collision means something else owns it.
func (o *OS) WriteFileSync(path string, data []byte, perm fs.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// SyncDir flushes a directory's entries so a completed rename survives a crash.
func (o *OS) SyncDir(path string) error {
	return syncDir(path)
}

func (o *OS) Chmod(path string, mode fs.FileMode) error {
	return os.Chmod(path, mode)
}

func (o *OS) Stat(path string) (fs.FileInfo, error) {
	return os.Stat(path)
}

func (o *OS) Lstat(path string) (fs.FileInfo, error) {
	return os.Lstat(path)
}

func (o *OS) MkdirAll(path string, perm fs.FileMode) error {
	return os.MkdirAll(path, perm)
}

func (o *OS) Remove(path string) error {
	return os.Remove(path)
}

func (o *OS) Rename(oldpath, newpath string) error {
	return os.Rename(oldpath, newpath)
}
