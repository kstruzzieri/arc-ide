package filesystem

import (
	"bytes"
	"unicode/utf16"
	"unicode/utf8"
)

// FileContent represents the result of reading a file with metadata.
type FileContent struct {
	Content     string `json:"content"`
	Encoding    string `json:"encoding"`    // "utf-8", "utf-8-bom", "utf-16le", "utf-16be", "latin-1"
	LineEndings string `json:"lineEndings"` // "lf", "crlf", "cr", "mixed", "none"
	Size        int64  `json:"size"`
	IsBinary    bool   `json:"isBinary"`
}

// FileReader provides file reading functionality with encoding detection.
type FileReader struct {
	fs FileSystem
}

// NewFileReader creates a new FileReader with the given filesystem.
func NewFileReader(fs FileSystem) *FileReader {
	return &FileReader{fs: fs}
}

// ReadFileWithMetadata reads a file and returns its content with metadata.
// It detects encoding, line endings, and whether the file is binary.
func (r *FileReader) ReadFileWithMetadata(path string) (*FileContent, error) {
	data, err := r.fs.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return r.DecodeBytes(data), nil
}

// DecodeBytes runs the same detection and decoding ReadFileWithMetadata applies,
// against bytes the caller already holds. Callers that must decode the exact
// bytes they hashed or otherwise inspected use this so a second read cannot
// substitute different content; there is no separate decoder to drift from.
func (r *FileReader) DecodeBytes(data []byte) *FileContent {
	result := &FileContent{
		Size: int64(len(data)),
	}

	// Handle empty files
	if len(data) == 0 {
		result.Encoding = "utf-8"
		result.LineEndings = "none"
		result.Content = ""
		return result
	}

	// Detect encoding and decode content
	content, encoding := r.detectAndDecode(data)
	result.Encoding = encoding
	result.Content = content

	// Check decoded content so UTF-16 text is not rejected for its raw NUL bytes.
	result.IsBinary = r.isBinary([]byte(content))

	// Detect line endings (only for text files)
	if !result.IsBinary {
		result.LineEndings = r.detectLineEndings(content)
	} else {
		result.LineEndings = "none"
	}

	return result
}

// detectAndDecode detects the encoding and decodes the content to UTF-8 string.
func (r *FileReader) detectAndDecode(data []byte) (string, string) {
	// Check for BOMs
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		// UTF-8 BOM
		return string(data[3:]), "utf-8-bom"
	}

	if len(data) >= 2 {
		if data[0] == 0xFF && data[1] == 0xFE {
			// UTF-16 LE BOM
			return r.decodeUTF16LE(data[2:]), "utf-16le"
		}
		if data[0] == 0xFE && data[1] == 0xFF {
			// UTF-16 BE BOM
			return r.decodeUTF16BE(data[2:]), "utf-16be"
		}
	}

	// No BOM - check if valid UTF-8
	if utf8.Valid(data) {
		return string(data), "utf-8"
	}

	// Not valid UTF-8 - assume Latin-1 and convert
	return r.decodeLatin1(data), "latin-1"
}

// decodeUTF16LE decodes UTF-16 Little Endian to UTF-8 string.
func (r *FileReader) decodeUTF16LE(data []byte) string {
	if len(data)%2 != 0 {
		// Odd number of bytes, truncate last byte
		data = data[:len(data)-1]
	}

	u16s := make([]uint16, len(data)/2)
	for i := 0; i < len(data); i += 2 {
		u16s[i/2] = uint16(data[i]) | uint16(data[i+1])<<8
	}

	return string(utf16.Decode(u16s))
}

// decodeUTF16BE decodes UTF-16 Big Endian to UTF-8 string.
func (r *FileReader) decodeUTF16BE(data []byte) string {
	if len(data)%2 != 0 {
		// Odd number of bytes, truncate last byte
		data = data[:len(data)-1]
	}

	u16s := make([]uint16, len(data)/2)
	for i := 0; i < len(data); i += 2 {
		u16s[i/2] = uint16(data[i])<<8 | uint16(data[i+1])
	}

	return string(utf16.Decode(u16s))
}

// decodeLatin1 converts Latin-1 (ISO-8859-1) bytes to UTF-8 string.
func (r *FileReader) decodeLatin1(data []byte) string {
	// Latin-1 bytes map directly to Unicode code points 0-255
	runes := make([]rune, len(data))
	for i, b := range data {
		runes[i] = rune(b)
	}
	return string(runes)
}

// isBinary checks if the data contains null bytes (indicating binary content).
// Only checks the first 8KB for performance.
func (r *FileReader) isBinary(data []byte) bool {
	checkLen := min(len(data), 8192)
	return bytes.Contains(data[:checkLen], []byte{0x00})
}

// detectLineEndings analyzes the content and returns the line ending type.
func (r *FileReader) detectLineEndings(content string) string {
	hasCRLF := bytes.Contains([]byte(content), []byte("\r\n"))
	hasLF := bytes.Contains([]byte(content), []byte("\n"))
	hasCR := bytes.Contains([]byte(content), []byte("\r"))

	// Check for CRLF first (since it contains both CR and LF)
	if hasCRLF {
		// Check if there are standalone LF or CR (not part of CRLF)
		// Remove all CRLF and check what's left
		withoutCRLF := bytes.ReplaceAll([]byte(content), []byte("\r\n"), []byte(""))
		hasStandaloneLF := bytes.Contains(withoutCRLF, []byte("\n"))
		hasStandaloneCR := bytes.Contains(withoutCRLF, []byte("\r"))

		if hasStandaloneLF || hasStandaloneCR {
			return "mixed"
		}
		return "crlf"
	}

	if hasLF && hasCR {
		return "mixed"
	}

	if hasLF {
		return "lf"
	}

	if hasCR {
		return "cr"
	}

	return "none"
}
