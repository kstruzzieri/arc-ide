package filesystem

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadFileBoundedUsesHardByteLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "payload")
	if err := os.WriteFile(path, []byte("123456"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, _, err := ReadFileBounded(NewOS(), path, 5); err == nil {
		t.Fatal("ReadFileBounded accepted a file beyond its limit")
	}
	data, info, err := ReadFileBounded(NewOS(), path, 6)
	if err != nil {
		t.Fatalf("ReadFileBounded exact limit: %v", err)
	}
	if string(data) != "123456" || info.Size() != 6 {
		t.Fatalf("bounded read = %q, size %d", data, info.Size())
	}
}

func TestReadDirBoundedUsesHardEntryLimit(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a", "b", "c"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatalf("WriteFile(%s): %v", name, err)
		}
	}

	if _, err := ReadDirBounded(NewOS(), dir, 2); err == nil {
		t.Fatal("ReadDirBounded accepted a directory beyond its limit")
	}
	entries, err := ReadDirBounded(NewOS(), dir, 3)
	if err != nil {
		t.Fatalf("ReadDirBounded exact limit: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("entry count = %d, want 3", len(entries))
	}
}
