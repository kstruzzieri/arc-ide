//go:build !darwin && !linux && !windows

package filesystem

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Platforms without a no-follow primitive must refuse rather than fall back to
// an ordinary open. Symlink creation usually works on these targets, so the
// portable symlink tests would otherwise assert a refusal reason this build can
// never produce.
func TestOpenReadNoFollowIsRefusedWithoutAPrimitive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	file, err := openReadNoFollow(path, false)
	if file != nil {
		_ = file.Close()
		t.Fatal("openReadNoFollow returned a handle on a platform with no no-follow primitive")
	}
	if !errors.Is(err, ErrNoFollowUnsupported) {
		t.Fatalf("openReadNoFollow error = %v, want ErrNoFollowUnsupported", err)
	}
	if !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("ErrNoFollowUnsupported must stay under the ErrUnsafePath umbrella, got %v", err)
	}
}
