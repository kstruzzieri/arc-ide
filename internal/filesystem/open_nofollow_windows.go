//go:build windows

package filesystem

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileAttributeTagInfo mirrors FILE_ATTRIBUTE_TAG_INFO. x/sys/windows exports the
// info class but not the struct, and it is two DWORDs with a stable ABI.
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// reparseTagNameSurrogate is IsReparseTagNameSurrogate: the tag names another
// entity in the namespace, so following it leaves the tree Firn owns. It marks
// symlinks and mount points (junctions) and, deliberately, not the reparse points
// that merely decorate a real file — OneDrive placeholders, Data Dedup,
// WIM-backed files — which must keep working.
const reparseTagNameSurrogate = 0x20000000

func openReadNoFollow(path string, directory bool) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	access := uint32(syscall.GENERIC_READ)
	// FILE_FLAG_BACKUP_SEMANTICS is required for any directory handle, including
	// the one a caller gets by handing ReadFileLimited a directory by mistake.
	// Without it CreateFile fails outright and that caller sees a raw PathError
	// rather than the ErrPathTypeMismatch unix reports for the same input. It
	// grants nothing extra unless the process holds SeBackupPrivilege.
	flags := uint32(syscall.FILE_FLAG_OPEN_REPARSE_POINT | syscall.FILE_FLAG_BACKUP_SEMANTICS)
	if directory {
		access = syscall.FILE_LIST_DIRECTORY
	}
	handle, err := syscall.CreateFile(
		name,
		access,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		flags,
		0,
	)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	// FILE_FLAG_OPEN_REPARSE_POINT is only the half of O_NOFOLLOW that declines to
	// traverse; unlike O_NOFOLLOW it then hands back the link itself rather than
	// failing. Refuse here so the primitive matches the unix ELOOP path instead of
	// leaving it to a caller to notice.
	//
	// Ask the handle for its tag rather than Lstat'ing the path again. The tag is
	// the only thing that separates a junction from a cloud placeholder — since Go
	// 1.23 os.Lstat reports both as ModeIrregular and reserves ModeSymlink for
	// IO_REPARSE_TAG_SYMLINK alone — and reading it off the open handle cannot be
	// raced by a swap the way a second path lookup can.
	var tagInfo fileAttributeTagInfo
	if err := windows.GetFileInformationByHandleEx(
		windows.Handle(handle),
		windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&tagInfo)),
		uint32(unsafe.Sizeof(tagInfo)),
	); err != nil {
		_ = syscall.CloseHandle(handle)
		return nil, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	if tagInfo.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 &&
		tagInfo.ReparseTag&reparseTagNameSurrogate != 0 {
		_ = syscall.CloseHandle(handle)
		return nil, fmt.Errorf("%w: %s", ErrSymlinkRefused, path)
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = syscall.CloseHandle(handle)
		return nil, fmt.Errorf("opening %s returned an invalid handle", path)
	}
	return file, nil
}
