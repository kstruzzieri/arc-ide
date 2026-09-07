package filesystem

import (
	"errors"
	"io/fs"
	"path/filepath"
	"testing"
)

func TestWriteFile_BasicWrite(t *testing.T) {
	var writtenPath string
	var writtenData []byte

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			writtenPath = path
			writtenData = data
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found") // New file
		},
	}

	writer := NewFileWriter(mockFS)
	err := writer.WriteFileWithOptions("/test/file.txt", "Hello, World!", nil)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if writtenPath != "/test/file.txt" {
		t.Errorf("Expected path '/test/file.txt', got %q", writtenPath)
	}
	if string(writtenData) != "Hello, World!" {
		t.Errorf("Expected content 'Hello, World!', got %q", string(writtenData))
	}
}

func TestWriteFile_PreservesUTF8(t *testing.T) {
	var writtenData []byte

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			writtenData = data
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{Encoding: "utf-8"}
	err := writer.WriteFileWithOptions("/test/file.txt", "café", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	// UTF-8 encoding of "café"
	expected := []byte("café")
	if string(writtenData) != string(expected) {
		t.Errorf("Expected UTF-8 content, got %v", writtenData)
	}
}

func TestWriteFile_PreservesUTF8BOM(t *testing.T) {
	var writtenData []byte

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			writtenData = data
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{Encoding: "utf-8-bom"}
	err := writer.WriteFileWithOptions("/test/file.txt", "Hello", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	// Should have UTF-8 BOM prefix
	if len(writtenData) < 3 || writtenData[0] != 0xEF || writtenData[1] != 0xBB || writtenData[2] != 0xBF {
		t.Error("Expected UTF-8 BOM prefix")
	}
	if string(writtenData[3:]) != "Hello" {
		t.Errorf("Expected content 'Hello' after BOM, got %q", string(writtenData[3:]))
	}
}

func TestWriteFile_PreservesUTF16LE(t *testing.T) {
	var writtenData []byte

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			writtenData = data
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{Encoding: "utf-16le"}
	err := writer.WriteFileWithOptions("/test/file.txt", "Hi", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	// Should have UTF-16 LE BOM (FF FE) followed by "Hi" in UTF-16 LE
	if len(writtenData) < 2 || writtenData[0] != 0xFF || writtenData[1] != 0xFE {
		t.Error("Expected UTF-16 LE BOM prefix")
	}
	// "Hi" in UTF-16 LE: H=0x48,0x00 i=0x69,0x00
	expected := []byte{0xFF, 0xFE, 'H', 0x00, 'i', 0x00}
	if len(writtenData) != len(expected) {
		t.Errorf("Expected %d bytes, got %d", len(expected), len(writtenData))
	}
}

func TestWriteFile_PreservesUTF16BE(t *testing.T) {
	var writtenData []byte

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			writtenData = data
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{Encoding: "utf-16be"}
	err := writer.WriteFileWithOptions("/test/file.txt", "Hi", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	// Should have UTF-16 BE BOM (FE FF) followed by "Hi" in UTF-16 BE
	if len(writtenData) < 2 || writtenData[0] != 0xFE || writtenData[1] != 0xFF {
		t.Error("Expected UTF-16 BE BOM prefix")
	}
	// "Hi" in UTF-16 BE: H=0x00,0x48 i=0x00,0x69
	expected := []byte{0xFE, 0xFF, 0x00, 'H', 0x00, 'i'}
	if len(writtenData) != len(expected) {
		t.Errorf("Expected %d bytes, got %d", len(expected), len(writtenData))
	}
}

func TestWriteFile_PreservesLF(t *testing.T) {
	var writtenData []byte

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			writtenData = data
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{LineEndings: "lf"}
	// Input has CRLF, should be converted to LF
	err := writer.WriteFileWithOptions("/test/file.txt", "line1\r\nline2\r\n", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	expected := "line1\nline2\n"
	if string(writtenData) != expected {
		t.Errorf("Expected LF line endings %q, got %q", expected, string(writtenData))
	}
}

func TestWriteFile_PreservesCRLF(t *testing.T) {
	var writtenData []byte

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			writtenData = data
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{LineEndings: "crlf"}
	// Input has LF, should be converted to CRLF
	err := writer.WriteFileWithOptions("/test/file.txt", "line1\nline2\n", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	expected := "line1\r\nline2\r\n"
	if string(writtenData) != expected {
		t.Errorf("Expected CRLF line endings %q, got %q", expected, string(writtenData))
	}
}

func TestWriteFile_CreatesBackup(t *testing.T) {
	var backupCreated bool
	var backupPath string

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			return nil
		},
		ReadFileFunc: func(path string) ([]byte, error) {
			if path == "/test/file.txt" {
				return []byte("original content"), nil
			}
			return nil, errors.New("not found")
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			if path == "/test/file.txt" {
				return &mockFileInfo{size: 16}, nil // File exists
			}
			return nil, errors.New("not found")
		},
	}

	// Override WriteFileFunc to track backup
	originalWrite := mockFS.WriteFileFunc
	mockFS.WriteFileFunc = func(path string, data []byte, perm fs.FileMode) error {
		if path == "/test/file.txt.bak" {
			backupCreated = true
			backupPath = path
		}
		return originalWrite(path, data, perm)
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{CreateBackup: true}
	err := writer.WriteFileWithOptions("/test/file.txt", "new content", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !backupCreated {
		t.Error("Expected backup file to be created")
	}
	if backupPath != "/test/file.txt.bak" {
		t.Errorf("Expected backup path '/test/file.txt.bak', got %q", backupPath)
	}
}

func TestWriteFile_NoBackupWhenDisabled(t *testing.T) {
	var backupCreated bool

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			if path == "/test/file.txt.bak" {
				backupCreated = true
			}
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			if path == "/test/file.txt" {
				return &mockFileInfo{size: 16}, nil // File exists
			}
			return nil, errors.New("not found")
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{CreateBackup: false}
	err := writer.WriteFileWithOptions("/test/file.txt", "new content", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if backupCreated {
		t.Error("Backup should not be created when disabled")
	}
}

func TestWriteFile_NoBackupForNewFile(t *testing.T) {
	var backupCreated bool

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			if path == "/test/file.txt.bak" {
				backupCreated = true
			}
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found") // New file
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{CreateBackup: true}
	err := writer.WriteFileWithOptions("/test/file.txt", "new content", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if backupCreated {
		t.Error("Backup should not be created for new files")
	}
}

func TestWriteFile_PermissionError(t *testing.T) {
	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			return errors.New("permission denied")
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
	}

	writer := NewFileWriter(mockFS)
	err := writer.WriteFileWithOptions("/test/file.txt", "content", nil)

	if err == nil {
		t.Error("Expected permission error")
	}
}

func TestWriteFile_CreatesParentDirectories(t *testing.T) {
	var mkdirCalled bool
	var mkdirPath string

	mockFS := &Mock{
		WriteFileFunc: func(path string, data []byte, perm fs.FileMode) error {
			return nil
		},
		StatFunc: func(path string) (fs.FileInfo, error) {
			return nil, errors.New("file not found")
		},
		MkdirAllFunc: func(path string, perm fs.FileMode) error {
			mkdirCalled = true
			mkdirPath = path
			return nil
		},
	}

	writer := NewFileWriter(mockFS)
	opts := &WriteOptions{CreateDirs: true}
	path := filepath.FromSlash("/test/nested/dir/file.txt")
	err := writer.WriteFileWithOptions(path, "content", opts)

	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !mkdirCalled {
		t.Error("Expected MkdirAll to be called")
	}
	if want := filepath.Dir(path); mkdirPath != want {
		t.Errorf("Expected mkdir path %q, got %q", want, mkdirPath)
	}
}
