package runprofile

import (
	"encoding/json"
	"errors"
	"firn/internal/filesystem"
	"fmt"
	"io/fs"
	"path/filepath"
	"sync"
)

const profilesFileName = ".firn/run-profiles.json"

// profilesFileVersion is the current on-disk schema version. v2 adds workspace
// ownership fields and workspace-scoped detected IDs. v1 files are migrated on
// load (see migrateV1Profiles). v3 adds profileState; as of the recency-sidecar
// split, profileState carries adoption only — run recency lives in the sidecar.
const profilesFileVersion = 3

// recencyFileName / recencyFileVersion identify the run-recency sidecar. Run
// recency is volatile and written once per run, so it is kept out of
// run-profiles.json: stamping a run must not rewrite profile definitions.
const recencyFileName = ".firn/run-recency.json"
const recencyFileVersion = 1

// Store manages persistent storage of run profiles. Durable config (profile
// definitions + adoption) lives in run-profiles.json; volatile run recency
// lives in the run-recency.json sidecar. In memory the two are merged into a
// single per-profile ProfileUIState map.
type Store struct {
	fs            filesystem.FileSystem
	workspaceRoot string
	mu            sync.RWMutex
	profiles      []RunProfile
	state         map[string]ProfileUIState
	scope         MigrationScope
	// Warnings collects non-fatal load issues (e.g. a v1->v2 migration that
	// could not be written back to a read-only directory). The migrated data is
	// still usable in memory; callers surface these rather than failing the load.
	Warnings []string
}

// SetScope assigns the owning-workspace identity used when migrating a legacy
// v1 file loaded by this store. Call before Load.
func (s *Store) SetScope(scope MigrationScope) {
	s.scope = scope
}

// NewStore creates a Store for the given workspace root directory.
func NewStore(fsys filesystem.FileSystem, workspaceRoot string) *Store {
	return &Store{
		fs:            fsys,
		workspaceRoot: workspaceRoot,
		profiles:      []RunProfile{},
		state:         map[string]ProfileUIState{},
	}
}

// Load reads profiles from disk. Returns empty list (not error) if file doesn't exist.
func (s *Store) Load() ([]RunProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.Warnings = nil

	path := filepath.Join(s.workspaceRoot, profilesFileName)
	data, err := s.fs.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// No profiles file, but a recency sidecar may still exist on its own
			// (a run was recorded for a detected profile that was never saved).
			s.profiles = []RunProfile{}
			s.state = map[string]ProfileUIState{}
			s.loadRecencyLocked()
			return s.profiles, nil
		}
		return nil, fmt.Errorf("reading profiles file: %w", err)
	}

	var pf ProfilesFile
	if err := json.Unmarshal(data, &pf); err != nil {
		return nil, fmt.Errorf("parsing profiles file: %w", err)
	}

	s.state = map[string]ProfileUIState{}
	switch pf.Version {
	case 1:
		migrated, changed := migrateV1Profiles(orEmptyProfiles(pf.Profiles), s.scope)
		s.profiles = migrated
		if changed {
			// Persist is best-effort: a successful migration must not be lost
			// just because the directory is read-only. Keep the migrated data
			// in memory and record a warning instead of failing the load.
			if err := s.persist(); err != nil {
				s.Warnings = append(s.Warnings, fmt.Sprintf("could not write migrated profiles to %s: %v", path, err))
			}
		}
	case 2:
		// v2 → v3: additive upgrade; profileState stays empty.
		s.profiles = orEmptyProfiles(pf.Profiles)
	case profilesFileVersion:
		s.profiles = orEmptyProfiles(pf.Profiles)
		if pf.ProfileState != nil {
			// Store takes ownership of the unmarshalled map (pf is function-local).
			s.state = pf.ProfileState
		}
	default:
		return nil, fmt.Errorf("unsupported profiles file version: %d (expected 1-%d)", pf.Version, profilesFileVersion)
	}

	// Merge run recency from the sidecar (authoritative over any legacy recency
	// embedded in an older profiles file).
	s.loadRecencyLocked()

	return s.copyProfiles(), nil
}

// loadRecencyLocked merges run recency from the sidecar into s.state. If the
// sidecar is absent but the profiles file carried legacy recency (pre-split
// v3), it migrates that recency into the sidecar once so it survives the
// profiles file dropping recency on its next write. Best-effort: a read/parse
// failure degrades to a warning, never a failed load. Caller holds s.mu.
func (s *Store) loadRecencyLocked() {
	path := filepath.Join(s.workspaceRoot, recencyFileName)
	data, err := s.fs.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			if hasRecency(s.state) {
				if werr := s.writeRecencyLocked(s.state); werr != nil {
					s.Warnings = append(s.Warnings, fmt.Sprintf("could not migrate recency to %s: %v", path, werr))
				}
			}
			return
		}
		s.Warnings = append(s.Warnings, fmt.Sprintf("could not read recency sidecar %s: %v", path, err))
		return
	}

	var rf RecencyFile
	if err := json.Unmarshal(data, &rf); err != nil {
		s.Warnings = append(s.Warnings, fmt.Sprintf("could not parse recency sidecar %s: %v", path, err))
		return
	}

	// The sidecar is the sole authority for recency. Drop any legacy recency a
	// pre-split profiles file embedded before applying it, so a timestamp the
	// sidecar no longer lists (e.g. pruned) does not linger.
	for id, st := range s.state {
		if st.LastRunAt == 0 {
			continue
		}
		st.LastRunAt = 0
		if st.Adopted {
			s.state[id] = st
		} else {
			delete(s.state, id) // was recency-only; nothing left to keep
		}
	}
	for id, ts := range rf.Recency {
		st := s.state[id]
		st.LastRunAt = ts
		s.state[id] = st
	}
}

// Save upserts a profile by ID and persists to disk.
func (s *Store) Save(profile RunProfile) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Apply to a fresh slice so a persist failure can restore the prior in-memory
	// state — otherwise memory and disk diverge (and the emit-on-change path would
	// surface a profile that was never written).
	prev := s.profiles
	updated := make([]RunProfile, len(s.profiles))
	copy(updated, s.profiles)

	found := false
	for i, p := range updated {
		if p.ID == profile.ID {
			updated[i] = profile
			found = true
			break
		}
	}
	if !found {
		updated = append(updated, profile)
	}
	s.profiles = updated

	if err := s.persist(); err != nil {
		s.profiles = prev
		return err
	}
	return nil
}

// Delete removes a profile by ID and persists to disk.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := -1
	for i, p := range s.profiles {
		if p.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return fmt.Errorf("profile not found: %s", id)
	}

	// Remove into a fresh slice so a persist failure can restore the original
	// (the prior in-place splice mutated the backing array, corrupting any rollback).
	prev := s.profiles
	updated := make([]RunProfile, 0, len(s.profiles)-1)
	updated = append(updated, s.profiles[:idx]...)
	updated = append(updated, s.profiles[idx+1:]...)
	s.profiles = updated

	if err := s.persist(); err != nil {
		s.profiles = prev
		return err
	}
	return nil
}

// GetAll returns a copy of all stored profiles.
func (s *Store) GetAll() []RunProfile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.copyProfiles()
}

// Contains reports whether a saved profile with the given ID exists, without
// deep-copying the profile list (unlike GetAll).
func (s *Store) Contains(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.profiles {
		if s.profiles[i].ID == id {
			return true
		}
	}
	return false
}

// Pin converts a detected profile to a user profile and persists it.
func (s *Store) Pin(profile RunProfile) error {
	profile.Source = ProfileSourceUser
	profile.DetectedFrom = ""
	return s.Save(profile)
}

// SetAdopted sets the per-workspace adoption flag for a profile ID and persists.
// Clearing adoption on an entry with no recency drops the entry to keep the map tidy.
func (s *Store) SetAdopted(id string, adopted bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := copyProfileState(s.state)
	st := next[id]
	st.Adopted = adopted
	if !st.Adopted && st.LastRunAt == 0 {
		delete(next, id)
	} else {
		next[id] = st
	}
	return s.persistProfiles(next)
}

// RecordRun stamps the last-run timestamp (epoch millis) for a profile ID and
// persists it to the recency sidecar. The write is synchronous and tiny — it
// records one timestamp without rewriting profile definitions — and the
// in-memory value is rolled back if the write fails, so the caller (and its
// logs) observe the error.
func (s *Store) RecordRun(id string, ts int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := copyProfileState(s.state)
	st := next[id]
	st.LastRunAt = max(st.LastRunAt, ts)
	next[id] = st
	return s.persistRecency(next)
}

// PruneState drops profileState entries whose ID is not in validIDs, except
// adopted entries — those survive so a workspace's working set is not lost when
// a detected profile temporarily disappears (e.g. a git branch switch). Pruned
// entries are recency-only (adopted entries are kept), so only the recency
// sidecar is rewritten, and only when something was actually removed.
func (s *Store) PruneState(validIDs map[string]bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := copyProfileState(s.state)
	changed := false
	for id, st := range next {
		if validIDs[id] || st.Adopted {
			continue
		}
		delete(next, id)
		changed = true
	}
	if !changed {
		return nil
	}
	return s.persistRecency(next)
}

// GetState returns a copy of the per-profile UI state map.
func (s *Store) GetState() map[string]ProfileUIState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]ProfileUIState, len(s.state))
	for k, v := range s.state {
		out[k] = v
	}
	return out
}

// persist writes the profiles file (definitions + adoption) for the current
// in-memory state.
func (s *Store) persist() error {
	return s.persistProfiles(s.state)
}

// persistProfiles writes run-profiles.json (definitions + adoption) for the
// given state and, on success, commits the state to memory. Used by the durable
// config writers (Save/Delete/Pin/SetAdopted).
func (s *Store) persistProfiles(state map[string]ProfileUIState) error {
	if err := s.writeProfilesLocked(state); err != nil {
		return err
	}
	s.state = state
	return nil
}

// persistRecency writes the run-recency sidecar for the given state and, on
// success, commits the state to memory. Used by the hot path (RecordRun) and by
// prune, neither of which touch profile definitions or adoption.
func (s *Store) persistRecency(state map[string]ProfileUIState) error {
	if err := s.writeRecencyLocked(state); err != nil {
		return err
	}
	s.state = state
	return nil
}

// writeProfilesLocked atomically writes profile definitions plus adoption flags
// to run-profiles.json. Recency is intentionally excluded — it lives in the
// sidecar — so this file changes only on user actions, not on every run. Caller
// holds s.mu.
func (s *Store) writeProfilesLocked(state map[string]ProfileUIState) error {
	profiles := s.profiles
	if profiles == nil {
		profiles = []RunProfile{}
	}
	pf := ProfilesFile{
		Version:      profilesFileVersion,
		Profiles:     profiles,
		ProfileState: adoptionState(state),
	}
	data, err := json.MarshalIndent(pf, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling profiles: %w", err)
	}
	return s.atomicWriteLocked(profilesFileName, data)
}

// writeRecencyLocked atomically writes the run-recency sidecar. This is the hot
// path (one write per run); it is deliberately tiny and never rewrites profile
// definitions. Caller holds s.mu.
func (s *Store) writeRecencyLocked(state map[string]ProfileUIState) error {
	rf := RecencyFile{
		Version: recencyFileVersion,
		Recency: recencyMap(state),
	}
	data, err := json.MarshalIndent(rf, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling recency: %w", err)
	}
	return s.atomicWriteLocked(recencyFileName, data)
}

// atomicWriteLocked writes data to <root>/<relName> via a sibling temp file and
// a rename, so a torn write can never corrupt the destination — important
// because the recency sidecar is written frequently. Caller holds s.mu.
func (s *Store) atomicWriteLocked(relName string, data []byte) error {
	dir := filepath.Join(s.workspaceRoot, ".firn")
	if err := s.fs.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating .firn directory: %w", err)
	}
	finalPath := filepath.Join(s.workspaceRoot, relName)
	tmpPath := finalPath + ".tmp"
	if err := s.fs.WriteFile(tmpPath, data, fs.FileMode(0o644)); err != nil {
		return fmt.Errorf("writing temp file %s: %w", relName, err)
	}
	if err := s.fs.Rename(tmpPath, finalPath); err != nil {
		return fmt.Errorf("renaming %s into place: %w", relName, err)
	}
	return nil
}

// adoptionState projects the durable adoption flags out of the combined UI
// state; recency is excluded (it lives in the sidecar).
func adoptionState(state map[string]ProfileUIState) map[string]ProfileUIState {
	out := map[string]ProfileUIState{}
	for id, st := range state {
		if st.Adopted {
			out[id] = ProfileUIState{Adopted: true}
		}
	}
	return out
}

// recencyMap projects last-run timestamps out of the combined UI state.
func recencyMap(state map[string]ProfileUIState) map[string]int64 {
	out := map[string]int64{}
	for id, st := range state {
		if st.LastRunAt != 0 {
			out[id] = st.LastRunAt
		}
	}
	return out
}

// hasRecency reports whether any entry carries a last-run timestamp.
func hasRecency(state map[string]ProfileUIState) bool {
	for _, st := range state {
		if st.LastRunAt != 0 {
			return true
		}
	}
	return false
}

// orEmptyProfiles returns a non-nil slice for a possibly-nil profile list.
func orEmptyProfiles(p []RunProfile) []RunProfile {
	if p == nil {
		return []RunProfile{}
	}
	return p
}

func copyProfileState(in map[string]ProfileUIState) map[string]ProfileUIState {
	out := make(map[string]ProfileUIState, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func (s *Store) copyProfiles() []RunProfile {
	out := make([]RunProfile, len(s.profiles))
	for i, p := range s.profiles {
		out[i] = deepCopyProfile(p)
	}
	return out
}

// deepCopyProfile returns a fully independent copy of a RunProfile,
// cloning all reference-type fields (maps, slices).
func deepCopyProfile(p RunProfile) RunProfile {
	if p.Env != nil {
		env := make(map[string]string, len(p.Env))
		for k, v := range p.Env {
			env[k] = v
		}
		p.Env = env
	}
	if p.EnvVariants != nil {
		variants := make(EnvVariants, len(p.EnvVariants))
		copy(variants, p.EnvVariants)
		p.EnvVariants = variants
	}
	if p.Tags != nil {
		tags := make([]ProfileTag, len(p.Tags))
		copy(tags, p.Tags)
		p.Tags = tags
	}
	if p.Steps != nil {
		steps := make([]string, len(p.Steps))
		copy(steps, p.Steps)
		p.Steps = steps
	}
	return p
}
