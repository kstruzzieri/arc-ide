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
	// loaded is set once Load has run. Save probes the existing file itself
	// when this is still false, so a Store that writes without ever loading
	// cannot clobber a file it never read (spec §3.2).
	loaded bool
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
	s.loaded = true
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
	if err := checkVersion(sf.Version); err != nil {
		s.writeBlocked = err
		return Default(), s.writeBlocked
	}
	if sf.State.GolemWindow.Mode != ModeUndocked {
		sf.State.GolemWindow.Mode = ModeDocked
	}
	return sf.State, nil
}

// Save writes the state atomically (temp file + rename) with 0600, tightening
// ~/.firn to 0700 the way the workspace store does.
//
// A Store that writes without ever calling Load has not yet seen whatever is
// on disk. Rather than trust a zero-value writeBlocked, Save probes the
// existing file itself the first time, so it can never overwrite a
// future-version app.json a newer Firn wrote (spec §3.2).
func (s *Store) Save(state State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.loaded {
		if s.path != "" {
			s.probeExistingVersion()
		}
		s.loaded = true
	}
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
	if err := filesystem.WriteFileAtomic(s.fs, s.path, data, 0o600); err != nil {
		return fmt.Errorf("writing app state: %w", err)
	}
	return nil
}

// probeExistingVersion reads only the version envelope of an existing file
// ahead of a never-loaded Store's first write, latching writeBlocked with the
// same wrapped errors Load would produce for an unreadable, unparseable, or
// future-version file. A missing file latches nothing: Save may proceed.
func (s *Store) probeExistingVersion() {
	data, err := s.fs.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return
		}
		s.writeBlocked = fmt.Errorf("reading app state: %w", err)
		return
	}
	var envelope struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		s.writeBlocked = fmt.Errorf("parsing app state: %w", err)
		return
	}
	s.writeBlocked = checkVersion(envelope.Version)
}

// checkVersion classifies a file's version envelope. Versions start at 1, so
// a missing, zero or negative one is a corrupt or partial file — never proof
// of a newer Firn — and is reported as such; only a positive unknown version
// is ErrUnknownVersion. Both latch writes for the session.
func checkVersion(v int) error {
	switch {
	case v == version:
		return nil
	case v < 1:
		return fmt.Errorf("parsing app state: missing or invalid version %d", v)
	default:
		return fmt.Errorf("%w: %d", ErrUnknownVersion, v)
	}
}
