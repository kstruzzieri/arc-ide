//go:build darwin || linux

package filesystem

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func openReadNoFollow(path string, directory bool) (*os.File, error) {
	flags := syscall.O_RDONLY | syscall.O_CLOEXEC | syscall.O_NONBLOCK | syscall.O_NOFOLLOW
	if directory {
		flags |= syscall.O_DIRECTORY
	}
	fd, err := syscall.Open(path, flags, 0)
	if err != nil {
		// O_NOFOLLOW reports a refused link as ELOOP, unambiguously.
		if errors.Is(err, syscall.ELOOP) {
			return nil, fmt.Errorf("%w: %s", ErrSymlinkRefused, path)
		}
		// ENOTDIR is ambiguous and the errno alone cannot resolve it: with
		// O_DIRECTORY set, both a plain file and a symlink (of any target type)
		// come back ENOTDIR, because the directory check fires before O_NOFOLLOW
		// gets to raise ELOOP. It also covers a non-directory mid-path component.
		// Ask Lstat which one it was, the same way the Windows implementation
		// decodes a reparse tag. If Lstat cannot say, report the mismatch we do
		// know about rather than claiming a link we have not seen.
		if errors.Is(err, syscall.ENOTDIR) {
			if link, lerr := os.Lstat(path); lerr == nil && link.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("%w: %s", ErrSymlinkRefused, path)
			}
			return nil, fmt.Errorf("%w: %s is not a directory", ErrPathTypeMismatch, path)
		}
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("opening %s returned an invalid descriptor", path)
	}
	return file, nil
}
