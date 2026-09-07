package filesystem

import (
	"fmt"
	"io/fs"
)

type limitedFileReader interface {
	ReadFileLimited(path string, limit int64) ([]byte, fs.FileInfo, error)
}

type limitedDirReader interface {
	ReadDirLimited(path string, limit int) ([]fs.DirEntry, error)
}

// ReadFileBounded uses a hard-limited reader when the filesystem provides one.
func ReadFileBounded(fsys FileSystem, path string, limit int64) ([]byte, fs.FileInfo, error) {
	if reader, ok := fsys.(limitedFileReader); ok {
		return reader.ReadFileLimited(path, limit)
	}
	info, err := Lstat(fsys, path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, info, fmt.Errorf("%w: %s is not a regular file", ErrPathTypeMismatch, path)
	}
	if info.Size() > limit {
		return nil, info, fmt.Errorf("file exceeds %d bytes", limit)
	}
	data, err := fsys.ReadFile(path)
	if err != nil {
		return nil, info, err
	}
	if int64(len(data)) > limit {
		return nil, info, fmt.Errorf("file exceeds %d bytes", limit)
	}
	return data, info, nil
}

// ReadDirBounded uses a hard entry limit when the filesystem provides one.
func ReadDirBounded(fsys FileSystem, path string, limit int) ([]fs.DirEntry, error) {
	if reader, ok := fsys.(limitedDirReader); ok {
		return reader.ReadDirLimited(path, limit)
	}
	info, err := Lstat(fsys, path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: %s is not a directory", ErrPathTypeMismatch, path)
	}
	entries, err := fsys.ReadDir(path)
	if err != nil {
		return nil, err
	}
	if len(entries) > limit {
		return nil, fmt.Errorf("directory exceeds %d entries", limit)
	}
	return entries, nil
}
