//go:build darwin || linux || windows

// Restricted to the platforms with a real no-follow implementation. Everywhere
// else openReadNoFollow is the stub in open_nofollow_fallback.go, which refuses
// every path outright — open_nofollow_fallback_test.go covers that contract.

package filesystem

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// This is the only test that proves openReadNoFollow itself refuses a link.
// Everything else in the tree reaches ErrUnsafePath through an Lstat type check
// several layers up, which would still pass if the no-follow open silently
// started traversing — so this must run on every platform that ships a real
// implementation, Windows included.
func TestOpenReadNoFollowRefusesSymlink(t *testing.T) {
	requireSymlinks(t)

	for _, tc := range []struct {
		name      string
		directory bool
		seed      func(t *testing.T, target string)
	}{
		{
			name: "file",
			seed: func(t *testing.T, target string) {
				if err := os.WriteFile(target, []byte("secret"), 0o600); err != nil {
					t.Fatalf("WriteFile: %v", err)
				}
			},
		},
		{
			name:      "directory",
			directory: true,
			seed: func(t *testing.T, target string) {
				if err := os.Mkdir(target, 0o700); err != nil {
					t.Fatalf("Mkdir: %v", err)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "target")
			tc.seed(t, target)
			link := filepath.Join(root, "link")
			if err := os.Symlink(target, link); err != nil {
				t.Fatalf("Symlink: %v", err)
			}

			file, err := openReadNoFollow(link, tc.directory)
			if file != nil {
				_ = file.Close()
			}
			// ErrSymlinkRefused, not merely ErrUnsafePath: the umbrella is also
			// what a downstream type check returns, so asserting it would not
			// distinguish "the open refused" from "something later noticed".
			if !errors.Is(err, ErrSymlinkRefused) {
				t.Fatalf("openReadNoFollow(%s) error = %v, want ErrSymlinkRefused", tc.name, err)
			}
			if !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("ErrSymlinkRefused must stay under the ErrUnsafePath umbrella, got %v", err)
			}
		})
	}
}

// The bounded readers are the callers that matter, so pin that a link is still
// refused once the refusal has travelled back up through them.
func TestBoundedReadsRefuseSymlinks(t *testing.T) {
	requireSymlinks(t)

	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("secret"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	fileLink := filepath.Join(root, "file-link")
	if err := os.Symlink(target, fileLink); err != nil {
		t.Fatalf("Symlink(file): %v", err)
	}
	targetDir := filepath.Join(root, "target-dir")
	if err := os.Mkdir(targetDir, 0o700); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	dirLink := filepath.Join(root, "dir-link")
	if err := os.Symlink(targetDir, dirLink); err != nil {
		t.Fatalf("Symlink(dir): %v", err)
	}

	if _, _, err := NewOS().ReadFileLimited(fileLink, 10); !errors.Is(err, ErrSymlinkRefused) {
		t.Fatalf("ReadFileLimited error = %v, want ErrSymlinkRefused", err)
	}
	if _, err := NewOS().ReadDirLimited(dirLink, 10); !errors.Is(err, ErrSymlinkRefused) {
		t.Fatalf("ReadDirLimited error = %v, want ErrSymlinkRefused", err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile(target): %v", err)
	}
	if string(data) != "secret" {
		t.Fatalf("symlink target was modified: %q", data)
	}
}

// An ordinary file asked for as a directory is a type mismatch, not a refused
// link. On unix both arrive as ENOTDIR — O_DIRECTORY fires before O_NOFOLLOW can
// raise ELOOP — so this pins that the two are told apart rather than lumped
// together under the louder reason.
func TestReadDirLimitedOnAPlainFileIsATypeMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	_, err := NewOS().ReadDirLimited(path, 10)
	if !errors.Is(err, ErrPathTypeMismatch) {
		t.Fatalf("ReadDirLimited on a plain file = %v, want ErrPathTypeMismatch", err)
	}
	if errors.Is(err, ErrSymlinkRefused) {
		t.Fatalf("a plain file must not be reported as a refused symlink: %v", err)
	}
}

// The mirror of the case above, and the one Windows used to get wrong: opening a
// directory there needs FILE_FLAG_BACKUP_SEMANTICS, without which CreateFile
// fails before any type check and the caller sees a raw PathError instead of the
// ErrPathTypeMismatch unix returns for the same input.
func TestReadFileLimitedOnADirectoryIsATypeMismatch(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "dir")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}

	_, _, err := NewOS().ReadFileLimited(dir, 10)
	if !errors.Is(err, ErrPathTypeMismatch) {
		t.Fatalf("ReadFileLimited on a directory = %v, want ErrPathTypeMismatch", err)
	}
}
