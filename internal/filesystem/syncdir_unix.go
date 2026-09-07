//go:build !windows

package filesystem

import "os"

// syncDir fsyncs a directory so a rename into it is durable. Opening a directory
// read-only and calling fsync is the POSIX way to flush its entries.
func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	err = dir.Sync()
	if closeErr := dir.Close(); err == nil {
		err = closeErr
	}
	return err
}
