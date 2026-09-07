//go:build darwin || linux

package filesystem

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestOpenReadNoFollowDoesNotBlockOnFIFO(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pipe")
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Fatalf("Mkfifo: %v", err)
	}

	type result struct {
		file *os.File
		err  error
	}
	done := make(chan result, 1)
	go func() {
		file, err := openReadNoFollow(path, false)
		done <- result{file: file, err: err}
	}()

	select {
	case opened := <-done:
		if opened.err != nil {
			t.Fatalf("openReadNoFollow: %v", opened.err)
		}
		_ = opened.file.Close()
	case <-time.After(500 * time.Millisecond):
		t.Fatal("openReadNoFollow blocked on a FIFO")
	}

	// A FIFO opens fine under O_NONBLOCK; the type check downstream is what
	// refuses it, so this asserts the mismatch reason rather than a link refusal.
	if _, _, err := NewOS().ReadFileLimited(path, 1); !errors.Is(err, ErrPathTypeMismatch) {
		t.Fatalf("ReadFileLimited error = %v, want ErrPathTypeMismatch", err)
	}
}

// Symlink refusal moved to open_nofollow_test.go so Windows runs it too.
