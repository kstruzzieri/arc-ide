//go:build windows

package filesystem

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A junction is the reparse point that symlink tests do not cover: it redirects
// like a symlink but, since Go 1.23, os.Lstat reports it as ModeIrregular rather
// than ModeSymlink, so any refusal keyed on ModeSymlink lets it through. It also
// needs no privilege to create, unlike a symlink, which makes it the more likely
// thing to actually find pointed at a user's archive directory.
func TestOpenReadNoFollowRefusesJunction(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("Mkdir(target): %v", err)
	}
	if err := os.WriteFile(filepath.Join(target, "outside"), []byte("unchanged"), 0o600); err != nil {
		t.Fatalf("seed marker: %v", err)
	}
	junction := filepath.Join(root, "junction")
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", junction, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v: %s", err, output)
	}

	// Confirm the premise rather than assuming it: if a future Go release starts
	// reporting junctions as ModeSymlink again, this test should say so instead of
	// quietly passing for the wrong reason.
	info, err := os.Lstat(junction)
	if err != nil {
		t.Fatalf("Lstat(junction): %v", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Logf("note: this Go reports junctions as ModeSymlink (mode=%v)", info.Mode())
	}

	for _, directory := range []bool{true, false} {
		file, err := openReadNoFollow(junction, directory)
		if file != nil {
			_ = file.Close()
		}
		if !errors.Is(err, ErrSymlinkRefused) {
			t.Fatalf("openReadNoFollow(junction, directory=%v) = %v, want ErrSymlinkRefused", directory, err)
		}
	}
	if _, err := NewOS().ReadDirLimited(junction, 10); !errors.Is(err, ErrSymlinkRefused) {
		t.Fatalf("ReadDirLimited(junction) = %v, want ErrSymlinkRefused", err)
	}
	if _, _, err := NewOS().ReadFileLimited(junction, 10); !errors.Is(err, ErrSymlinkRefused) {
		t.Fatalf("ReadFileLimited(junction) = %v, want ErrSymlinkRefused", err)
	}
	if data, err := os.ReadFile(filepath.Join(target, "outside")); err != nil || string(data) != "unchanged" {
		t.Fatalf("junction target was disturbed: %q, err = %v", data, err)
	}
}
