package workspace

import (
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

// Store manages persistent storage of workspace state in ~/.firn/workspaces/.
// Each workspace is stored as a separate JSON file named by a SHA-256 hash
// of the workspace path (first 16 hex chars).
type Store struct {
	fs      filesystem.FileSystem
	baseDir string // e.g., "/Users/alice/.firn/workspaces"
	mu      sync.RWMutex
}

// NewStore creates a Store that persists workspace state files under baseDir.
func NewStore(fsys filesystem.FileSystem, baseDir string) *Store {
	return &Store{
		fs:      fsys,
		baseDir: baseDir,
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

	path := filepath.Join(s.baseDir, pathToID(state.WorkspacePath)+".json")
	if err := filesystem.WriteFileAtomic(s.fs, path, data, fs.FileMode(0o600)); err != nil {
		return fmt.Errorf("writing workspace state file: %w", err)
	}

	return nil
}

// Load reads saved state for a workspace path.
// Returns nil, nil if no saved state exists (first time opening).
func (s *Store) Load(workspacePath string) (*State, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if strings.TrimSpace(s.baseDir) == "" {
		return nil, fmt.Errorf("home directory unavailable: workspace storage is disabled")
	}
	path := filepath.Join(s.baseDir, pathToID(workspacePath)+".json")
	data, err := s.fs.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading workspace state file: %w", err)
	}

	var sf StateFile
	if err := json.Unmarshal(data, &sf); err != nil {
		return nil, fmt.Errorf("parsing workspace state file: %w", err)
	}

	if sf.Version != 1 {
		return nil, fmt.Errorf("unsupported workspace state version: %d (expected 1)", sf.Version)
	}

	return &sf.State, nil
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
