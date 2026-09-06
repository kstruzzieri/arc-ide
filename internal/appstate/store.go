// Package appstate persists machine-scoped application preferences that are
// not tied to any repository: today, the Golem window's docked/undocked mode
// and its last normal bounds (#271 spec §3.2). It never stores transcripts,
// drafts, or consent.
package appstate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"

	"firn/internal/filesystem"
)

const (
	ModeDocked   = "docked"
	ModeUndocked = "undocked"
	fileName     = "app.json"
	version      = 1
)

// ErrUnknownVersion reports a file written by a newer Firn. The caller must
// leave the file alone and run on defaults.
var ErrUnknownVersion = errors.New("appstate: unknown file version")

// GolemWindow is the persisted window preference. Bounds are Wails logical
// coordinates and may be negative on displays left of / above the primary.
type GolemWindow struct {
	Mode   string `json:"mode"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// HasBounds reports whether a normal frame was ever saved.
func (w GolemWindow) HasBounds() bool { return w.Width > 0 && w.Height > 0 }

// State is the complete persisted app state.
type State struct {
	GolemWindow GolemWindow `json:"golemWindow"`
}

// StateFile is the on-disk JSON format with a version envelope.
type StateFile struct {
	Version int   `json:"version"`
	State   State `json:"state"`
}

// Default is the state a fresh install runs on.
func Default() State {
	return State{GolemWindow: GolemWindow{Mode: ModeDocked}}
}

// Store reads and writes ~/.firn/app.json. Writes are serialized and atomic.
type Store struct {
	fs   filesystem.FileSystem
	dir  string
	path string

	mu sync.Mutex
	// writeBlocked is latched after an unreadable/unparseable/future-version
	// existing file, so this session never overwrites content it could not
	// faithfully read back.
	writeBlocked error
}

// NewStore creates a Store rooted at firnDir. An empty firnDir disables
// writes (no home directory) while Load still answers defaults.
func NewStore(fsys filesystem.FileSystem, firnDir string) *Store {
	s := &Store{fs: fsys, dir: firnDir}
	if strings.TrimSpace(firnDir) != "" {
		s.path = filepath.Join(firnDir, fileName)
	}
	return s
}

// Load returns the saved state, Default() when no file exists, and
// ErrUnknownVersion (file untouched) for a newer envelope. An invalid mode
// normalizes to docked; other fields are validated by the window code.
func (s *Store) Load() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return Default(), nil
	}
	data, err := s.fs.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Default(), nil
		}
		s.writeBlocked = fmt.Errorf("reading app state: %w", err)
		return Default(), s.writeBlocked
	}
	var sf StateFile
	if err := json.Unmarshal(data, &sf); err != nil {
		s.writeBlocked = fmt.Errorf("parsing app state: %w", err)
		return Default(), s.writeBlocked
	}
	if sf.Version != version {
		s.writeBlocked = fmt.Errorf("%w: %d", ErrUnknownVersion, sf.Version)
		return Default(), s.writeBlocked
	}
	if sf.State.GolemWindow.Mode != ModeUndocked {
		sf.State.GolemWindow.Mode = ModeDocked
	}
	return sf.State, nil
}

// Save writes the state atomically (temp file + rename) with 0600, tightening
// ~/.firn to 0700 the way the workspace store does.
func (s *Store) Save(state State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.writeBlocked != nil {
		return fmt.Errorf("app state writes disabled to preserve existing file: %w", s.writeBlocked)
	}
	if s.path == "" {
		return fmt.Errorf("home directory unavailable: app state storage is disabled")
	}
	if state.GolemWindow.Mode != ModeUndocked {
		state.GolemWindow.Mode = ModeDocked
	}
	if err := filesystem.EnsureDirPerm(s.fs, s.dir, 0o700); err != nil {
		return fmt.Errorf("creating state directory: %w", err)
	}
	data, err := json.MarshalIndent(StateFile{Version: version, State: state}, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling app state: %w", err)
	}
	if err := filesystem.WriteFileAtomic(s.fs, s.path, data, fs.FileMode(0o600)); err != nil {
		return fmt.Errorf("writing app state: %w", err)
	}
	return nil
}
