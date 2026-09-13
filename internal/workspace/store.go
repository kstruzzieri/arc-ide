package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"firn/internal/filesystem"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ErrUnknownVersion reports a state file written by a newer Firn. Save keeps
// refusing for the session; the remedy is that Firn, or removing the file
// and restarting, never "fix" it.
var ErrUnknownVersion = errors.New("unsupported workspace state version")

// Store manages persistent storage of workspace state in ~/.firn/workspaces/.
// Each workspace is stored as a separate JSON file named by a SHA-256 hash
// of the workspace path (first 16 hex chars).
type Store struct {
	fs      filesystem.FileSystem
	baseDir string // e.g., "/Users/alice/.firn/workspaces"
	mu      sync.RWMutex
	// seen records the workspace files (by file id) this session has read.
	// Save probes a file it never loaded, so it cannot clobber one it never saw.
	seen map[string]bool
	// writeBlocked latches, per workspace file, the latest read failure
	// (unreadable, unparseable, or future-version) for the rest of the
	// session: Save then refuses to overwrite content this session could not
	// read back faithfully (#290). A later successful read never clears it,
	// because the backend reads these files on its own (LSP seeding) while
	// the frontend may still be running on defaults from its failed load.
	writeBlocked map[string]error
}

// NewStore creates a Store that persists workspace state files under baseDir.
func NewStore(fsys filesystem.FileSystem, baseDir string) *Store {
	return &Store{
		fs:           fsys,
		baseDir:      baseDir,
		seen:         map[string]bool{},
		writeBlocked: map[string]error{},
	}
}

// Save persists workspace state to disk. It sets LastOpened automatically.
func (s *Store) Save(state State) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if strings.TrimSpace(s.baseDir) == "" {
		return fmt.Errorf("home directory unavailable: workspace storage is disabled")
	}
	if state.WorkspacePath == "" {
		return fmt.Errorf("workspace path must not be empty")
	}

	id := pathToID(state.WorkspacePath)
	path := filepath.Join(s.baseDir, id+".json")
	if !s.seen[id] {
		_, _ = s.readLocked(id, path) // latches writeBlocked on failure
	}
	if blocked := s.writeBlocked[id]; blocked != nil {
		if errors.Is(blocked, ErrUnknownVersion) {
			return fmt.Errorf("workspace saving disabled for this session to preserve a state file written by a newer Firn (open the workspace with that Firn, or remove the file and restart Firn to start fresh): %w", blocked)
		}
		return fmt.Errorf("workspace saving disabled for this session to preserve the existing state file (fix or remove it, then restart Firn): %w", blocked)
	}

	state.LastOpened = time.Now().UTC().Format(time.RFC3339)

	// Ensure nil slices serialize as [] not null
	if state.Editor.OpenFiles == nil {
		state.Editor.OpenFiles = []FileState{}
	}
	if state.Explorer.ExpandedPaths == nil {
		state.Explorer.ExpandedPaths = []string{}
	}
	if state.Explorer.TreeSnapshot == nil {
		state.Explorer.TreeSnapshot = []filesystem.FileEntry{}
	}

	// Tighten ~/.firn as well as ~/.firn/workspaces. MkdirAll leaves an existing
	// directory's mode alone, so installs created before these paths moved to
	// 0700 would keep 0755 — and a 0755 parent leaves the 0600 state files
	// readable-by-path for every other local account.
	if parent := filepath.Dir(s.baseDir); parent != "" && parent != s.baseDir {
		if err := filesystem.EnsureDirPerm(s.fs, parent, 0o700); err != nil {
			return fmt.Errorf("creating workspaces directory: %w", err)
		}
	}
	if err := filesystem.EnsureDirPerm(s.fs, s.baseDir, 0o700); err != nil {
		return fmt.Errorf("creating workspaces directory: %w", err)
	}

	sf := StateFile{
		Version: 1,
		State:   state,
	}

	data, err := json.MarshalIndent(sf, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling workspace state: %w", err)
	}

	if err := filesystem.WriteFileAtomic(s.fs, path, data, fs.FileMode(0o600)); err != nil {
		return fmt.Errorf("writing workspace state file: %w", err)
	}

	return nil
}

// Load reads saved state for a workspace path.
// Returns nil, nil if no saved state exists (first time opening) or the
// file is empty. Any other failure names the file and blocks Save for it
// for the rest of the session.
func (s *Store) Load(workspacePath string) (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if strings.TrimSpace(s.baseDir) == "" {
		return nil, fmt.Errorf("home directory unavailable: workspace storage is disabled")
	}
	id := pathToID(workspacePath)
	sf, err := s.readLocked(id, filepath.Join(s.baseDir, id+".json"))
	if err != nil || sf == nil {
		return nil, err
	}
	return &sf.State, nil
}

// readLocked decodes one workspace file under s.mu, marks it seen, and
// latches writeBlocked for it on any failure short of absence.
func (s *Store) readLocked(id, path string) (*StateFile, error) {
	s.seen[id] = true

	data, err := s.fs.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, s.block(id, fmt.Errorf("reading workspace state file %s: %w", path, err))
	}

	// Zero bytes hold no session to preserve (a truncated or never-filled
	// file, never Firn's own atomic write), so treat it as absent rather than
	// stranding the workspace behind a hash-named empty file.
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, nil
	}

	// Read the version envelope before the full document: a newer Firn's
	// schema must be reported as newer, not as corrupt, or the remedy would
	// tell the user to remove a live session file.
	var envelope struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, s.block(id, fmt.Errorf("parsing workspace state file %s: %w", path, err))
	}

	// Versions start at 1: a missing, zero or negative one is a corrupt or
	// partial file, never proof of a newer Firn.
	switch {
	case envelope.Version == 1:
	case envelope.Version < 1:
		return nil, s.block(id, fmt.Errorf("parsing workspace state file %s: missing or invalid version %d", path, envelope.Version))
	default:
		return nil, s.block(id, fmt.Errorf("%w in %s: %d (expected 1)", ErrUnknownVersion, path, envelope.Version))
	}

	var sf StateFile
	if err := json.Unmarshal(data, &sf); err != nil {
		return nil, s.block(id, fmt.Errorf("parsing workspace state file %s: %w", path, err))
	}

	return &sf, nil
}

func (s *Store) block(id string, err error) error {
	s.writeBlocked[id] = err
	return err
}

// ListRecent returns summaries of all saved workspaces sorted by last opened
// (most recent first). If limit <= 0, all workspaces are returned.
func (s *Store) ListRecent(limit int) ([]Summary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if strings.TrimSpace(s.baseDir) == "" {
		return nil, fmt.Errorf("home directory unavailable: workspace storage is disabled")
	}
	entries, err := s.fs.ReadDir(s.baseDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []Summary{}, nil
		}
		return nil, fmt.Errorf("reading workspaces directory: %w", err)
	}

	var summaries []Summary
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		path := filepath.Join(s.baseDir, entry.Name())
		data, err := s.fs.ReadFile(path)
		if err != nil {
			continue // skip unreadable files
		}

		var sf StateFile
		if err := json.Unmarshal(data, &sf); err != nil {
			continue // skip corrupt files
		}

		summaries = append(summaries, Summary{
			Name:       sf.State.WorkspaceName,
			Path:       sf.State.WorkspacePath,
			LastOpened: sf.State.LastOpened,
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].LastOpened > summaries[j].LastOpened
	})

	if limit > 0 && len(summaries) > limit {
		summaries = summaries[:limit]
	}

	return summaries, nil
}

// pathToID returns a deterministic, filesystem-safe identifier for a workspace path.
// Uses the first 16 hex chars of SHA-256(filepath.Clean(path)).
func pathToID(workspacePath string) string {
	cleaned := filepath.Clean(workspacePath)
	h := sha256.Sum256([]byte(cleaned))
	return hex.EncodeToString(h[:8])
}
