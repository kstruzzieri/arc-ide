//go:build windows

package filesystem

import (
	"fmt"
	"os"
)

// syncDir is a no-op on Windows. FlushFileBuffers rejects directory handles, so
// there is no supported way to flush a directory's entries; MoveFileEx already
// orders the rename's metadata against the file data we fsynced before it.
func syncDir(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: %s is not a directory", ErrPathTypeMismatch, path)
	}
	return nil
}
