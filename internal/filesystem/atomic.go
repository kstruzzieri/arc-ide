package filesystem

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
)

// ErrDurabilityUnavailable reports that the filesystem cannot force a
// directory's entries to stable storage. Callers whose correctness depends on
// durability (the remote consent store) must treat this as failure, unlike
// WriteFileAtomic's best-effort fallback.
var ErrDurabilityUnavailable = errors.New("filesystem directory sync unavailable")

// SyncDirectory flushes a directory's entries through the durable seam. A
// filesystem lacking either half of the WriteFileSync+SyncDir capability
// cannot promise durability at all, so the call fails closed rather than
// silently succeeding.
func SyncDirectory(fsys FileSystem, path string) error {
	durable, ok := fsys.(durableFileSystem)
	if !ok {
		return ErrDurabilityUnavailable
	}
	return durable.SyncDir(path)
}

// durableFileSystem is implemented by filesystems that can force data to stable
// storage. Mocks that do not implement it fall back to plain writes, which stay
// atomic against concurrent readers but not against power loss.
type durableFileSystem interface {
	// WriteFileSync writes data and fsyncs the file before returning.
	WriteFileSync(path string, data []byte, perm fs.FileMode) error
	// SyncDir flushes a directory's entries so a completed rename survives a crash.
	SyncDir(path string) error
}

// WriteFileAtomic writes data to a unique sibling temp file and renames it over
// path. On a filesystem that supports it the temp file is fsynced before the
// rename and the parent directory is fsynced after, so a crash leaves either the
// previous contents or the new ones — never a torn or empty file. Rename alone is
// atomic for concurrent readers but says nothing about power loss: POSIX permits
// the directory entry to reach disk before the data blocks do.
func WriteFileAtomic(fsys FileSystem, path string, data []byte, perm fs.FileMode) error {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return fmt.Errorf("creating atomic write temp name: %w", err)
	}
	tempPath := path + "." + hex.EncodeToString(suffix[:])
	defer func() { _ = fsys.Remove(tempPath) }()

	durable, _ := fsys.(durableFileSystem)
	write := fsys.WriteFile
	if durable != nil {
		write = durable.WriteFileSync
	}
	if err := write(tempPath, data, perm); err != nil {
		return fmt.Errorf("writing atomic temp file: %w", err)
	}
	if err := fsys.Rename(tempPath, path); err != nil {
		return fmt.Errorf("renaming atomic temp file: %w", err)
	}
	if durable != nil {
		// The bytes are already durable; this only publishes the rename. A
		// platform that cannot sync a directory handle reports nil.
		if err := durable.SyncDir(filepath.Dir(path)); err != nil {
			return fmt.Errorf("syncing directory after atomic rename: %w", err)
		}
	}
	return nil
}
