package filesystem

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Windows only grants SeCreateSymbolicLinkPrivilege under Developer Mode or
// elevation. Probe once so an unsupported host skips for exactly that reason and
// every other os.Symlink failure stays a hard failure.
//
// Untagged on purpose: open_nofollow_test.go is restricted to the platforms with
// a real no-follow implementation, but atomic_test.go needs this on every one.
var symlinkSupported = func() bool {
	dir, err := os.MkdirTemp("", "firn-symlink-probe")
	if err != nil {
		return false
	}
	defer func() { _ = os.RemoveAll(dir) }()
	target := filepath.Join(dir, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		return false
	}
	return os.Symlink(target, filepath.Join(dir, "link")) == nil
}()

func requireSymlinks(t *testing.T) {
	t.Helper()
	if !symlinkSupported {
		t.Skipf("symlink creation is unavailable on %s", runtime.GOOS)
	}
}
