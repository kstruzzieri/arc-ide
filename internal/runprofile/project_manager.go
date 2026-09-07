package runprofile

import (
	"firn/internal/filesystem"
	"firn/internal/workspace"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// storeUnit is one detection-target root (a workspace's relDir) with its own
// saved-profile store, detector, and last detection snapshot.
type storeUnit struct {
	relDir   string
	ownerID  string
	store    *Store
	detector *Detector
	detected []RunProfile
}

// ProjectRunProfileManager is the repo-scoped coordinator: it detects run
// profiles across every workspace at load, stamps ownership, scopes detected
// IDs, routes persistence to the owning workspace's store, and presents one
// combined repo-wide profile list. It is the app-facing contract (replacing the
// single-workspace Manager).
type ProjectRunProfileManager struct {
	repoRoot string
	fs       filesystem.FileSystem

	mu          sync.RWMutex
	units       map[string]*storeUnit             // keyed by relDir
	order       []string                          // relDirs in display order
	ownerRelDir map[string]string                 // workspaceId -> relDir
	ownerDefs   map[string]workspace.WorkspaceDef // workspaceId -> def
	warnings    []string                          // non-fatal issues from the last Load
}

// NewProjectManager creates a coordinator rooted at the opened repo.
func NewProjectManager(fsys filesystem.FileSystem, repoRoot string) *ProjectRunProfileManager {
	return &ProjectRunProfileManager{
		repoRoot:    repoRoot,
		fs:          fsys,
		units:       map[string]*storeUnit{},
		ownerRelDir: map[string]string{},
		ownerDefs:   map[string]workspace.WorkspaceDef{},
	}
}

// Load detects workspaces, then builds one unit per detection target.
//
// The whole working set is built into local maps first and swapped into place
// under the lock only after the build completes, so a failure mid-build can
// never leave the coordinator in a half-populated state. A single workspace
// whose saved-profile store cannot be read (corrupt JSON, unreadable file)
// degrades to a warning — its detected profiles still surface and the rest of
// the repo is unaffected. Only a failure to enumerate the repo's workspaces is
// fatal, since without that there is nothing to load.
func (m *ProjectRunProfileManager) Load() error {
	defs, err := workspace.DetectWorkspaces(m.fs, m.repoRoot)
	if err != nil {
		return fmt.Errorf("detect workspaces: %w", err)
	}

	units := map[string]*storeUnit{}
	var order []string
	ownerRelDir := map[string]string{}
	ownerDefs := map[string]workspace.WorkspaceDef{}
	var warnings []string

	// Repo-root owner: the typed root-marker def if present, else project.
	rootOwner := workspace.WorkspaceDef{ID: "project", Name: "Project", RelDir: ""}
	for _, d := range defs {
		if d.RelDir == "" && d.ID != "project" {
			rootOwner = d // "root:<type>"
			break
		}
	}

	for _, d := range defs {
		ownerRelDir[d.ID] = d.RelDir
		ownerDefs[d.ID] = d
	}

	// Distinct detection targets (relDirs) and the owner def for each.
	targetOwner := map[string]workspace.WorkspaceDef{"": rootOwner}
	for _, d := range defs {
		if d.RelDir == "" {
			continue
		}
		if _, ok := targetOwner[d.RelDir]; !ok {
			targetOwner[d.RelDir] = d
		}
	}

	for relDir, owner := range targetOwner {
		root := m.repoRoot
		if relDir != "" {
			root = filepath.Join(m.repoRoot, relDir)
		}
		scope := MigrationScope{
			WorkspaceID:     owner.ID,
			WorkspaceName:   owner.Name,
			WorkspaceRelDir: relDir,
		}

		store := NewStore(m.fs, root)
		store.SetScope(scope)
		saved, err := store.Load()
		if err != nil {
			// Degrade, don't fail the whole repo: keep the unit so its detected
			// profiles still surface, and record why its saved profiles are gone.
			warnings = append(warnings, fmt.Sprintf("workspace %q: could not load saved profiles: %v", owner.ID, err))
		}
		warnings = append(warnings, store.Warnings...)

		det := NewDetector(m.fs, root)
		det.SetScope(scope)
		detected := det.DetectAll()
		warnings = append(warnings, det.Warnings...)

		// Drop profileState entries whose profile no longer exists (saved or
		// detected), so recency for deleted profiles does not accumulate.
		// Adopted entries are preserved through temporary branch churn.
		valid := make(map[string]bool, len(saved)+len(detected))
		for _, p := range saved {
			valid[p.ID] = true
		}
		for _, p := range detected {
			valid[p.ID] = true
		}
		if err := store.PruneState(valid); err != nil {
			warnings = append(warnings, fmt.Sprintf("workspace %q: could not prune stale profile state: %v", owner.ID, err))
		}

		units[relDir] = &storeUnit{
			relDir:   relDir,
			ownerID:  owner.ID,
			store:    store,
			detector: det,
			detected: detected,
		}
		order = append(order, relDir)
	}

	// Repo root first, then subdir relDirs ascending — deterministic regardless
	// of map iteration order above.
	sort.SliceStable(order, func(i, j int) bool {
		if order[i] == "" {
			return true
		}
		if order[j] == "" {
			return false
		}
		return order[i] < order[j]
	})

	m.mu.Lock()
	m.units = units
	m.order = order
	m.ownerRelDir = ownerRelDir
	m.ownerDefs = ownerDefs
	m.warnings = warnings
	m.mu.Unlock()
	return nil
}

// Warnings returns a copy of the non-fatal issues recorded by the last Load
// (e.g. an unreadable workspace store, or a migration that could not be written
// back). The combined list is otherwise complete and usable.
func (m *ProjectRunProfileManager) Warnings() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]string, len(m.warnings))
	copy(out, m.warnings)
	return out
}

// GetAllProfiles merges every unit's (saved + non-shadowed detected) into one
// repo-wide list, in unit display order.
func (m *ProjectRunProfileManager) GetAllProfiles() []RunProfile {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var merged []RunProfile
	for _, relDir := range m.order {
		merged = append(merged, m.combineUnitLocked(m.units[relDir])...)
	}
	if merged == nil {
		merged = []RunProfile{}
	}
	return merged
}

// combineUnitLocked replicates Manager merge semantics for one unit: saved
// profiles first, then detected profiles whose ID is not shadowed by a saved
// one. Saved profiles are owner-normalized in case of legacy gaps.
func (m *ProjectRunProfileManager) combineUnitLocked(u *storeUnit) []RunProfile {
	if u == nil {
		return nil
	}
	saved := u.store.GetAll()
	savedIDs := map[string]bool{}

	out := make([]RunProfile, 0, len(saved)+len(u.detected))
	for _, p := range saved {
		savedIDs[p.ID] = true
		out = append(out, m.normalizeOwner(p, u))
	}
	for _, d := range u.detected {
		if savedIDs[d.ID] {
			continue
		}
		out = append(out, d)
	}
	return out
}

// normalizeOwner fills missing ownership on a saved profile from its unit owner.
func (m *ProjectRunProfileManager) normalizeOwner(p RunProfile, u *storeUnit) RunProfile {
	if p.WorkspaceID == "" {
		def := m.ownerDefs[u.ownerID]
		p.WorkspaceID = u.ownerID
		p.WorkspaceName = def.Name
		p.WorkspaceRelDir = u.relDir
	}
	if p.WorkingDir == "" && u.relDir != "" {
		p.WorkingDir = u.relDir
	}
	return p
}

// unitAndOwnerForWorkspaceLocked resolves a workspace id to its owning unit and
// the exact owner def to persist. Empty id routes to the repo-root unit owner for
// backward compatibility; non-empty ids preserve the requested owner even when
// multiple owners share one unit (e.g. "project" and "root:go").
func (m *ProjectRunProfileManager) unitAndOwnerForWorkspaceLocked(workspaceID string) (*storeUnit, workspace.WorkspaceDef, bool) {
	if workspaceID == "" {
		u := m.units[""]
		if u == nil {
			return nil, workspace.WorkspaceDef{}, false
		}
		return u, m.ownerDefs[u.ownerID], true
	}

	relDir, ok := m.ownerRelDir[workspaceID]
	if !ok {
		return nil, workspace.WorkspaceDef{}, false
	}
	u := m.units[relDir]
	if u == nil {
		return nil, workspace.WorkspaceDef{}, false
	}
	return u, m.ownerDefs[workspaceID], true
}

// unitForProfileIDLocked finds the unit that currently owns a profile id
// (searching saved then detected across units). The saved lookup uses
// Store.Contains to avoid deep-copying every unit's profile list.
func (m *ProjectRunProfileManager) unitForProfileIDLocked(id string) *storeUnit {
	for _, relDir := range m.order {
		u := m.units[relDir]
		if u.store.Contains(id) {
			return u
		}
		for _, d := range u.detected {
			if d.ID == id {
				return u
			}
		}
	}
	return nil
}

// profileIDExistsOutsideUnitLocked prevents ambiguous ID-only operations. Public
// runtime and mutation APIs still address profiles by ID only, so saved profile
// IDs must be globally unique across units.
func (m *ProjectRunProfileManager) profileIDExistsOutsideUnitLocked(id string, allowed *storeUnit) bool {
	for _, relDir := range m.order {
		u := m.units[relDir]
		if u == nil || u == allowed {
			continue
		}
		if u.store.Contains(id) {
			return true
		}
		for _, d := range u.detected {
			if d.ID == id {
				return true
			}
		}
	}
	return false
}

// ValidateProfile validates a profile and additionally checks that its target
// workspace is known to this repo, so the frontend's pre-save validation
// matches what SaveProfile will actually accept. An empty workspaceId is valid
// (it routes to the repo-root owner).
func (m *ProjectRunProfileManager) ValidateProfile(p RunProfile) ValidationResult {
	result := Validate(p)
	if !result.Valid {
		return result
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, _, ok := m.unitAndOwnerForWorkspaceLocked(p.WorkspaceID); !ok {
		return ValidationResult{Valid: false, Errors: []ValidationError{
			{Field: "workspaceId", Message: fmt.Sprintf("unknown workspace: %q", p.WorkspaceID)},
		}}
	}
	return result
}

// SaveProfile validates and saves a profile to its owning workspace store.
func (m *ProjectRunProfileManager) SaveProfile(p RunProfile) (ValidationResult, error) {
	result := Validate(p)
	if !result.Valid {
		return result, nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	unit, owner, ok := m.unitAndOwnerForWorkspaceLocked(p.WorkspaceID)
	if !ok || unit == nil {
		return ValidationResult{Valid: false, Errors: []ValidationError{
			{Field: "workspaceId", Message: fmt.Sprintf("unknown workspace: %q", p.WorkspaceID)},
		}}, nil
	}
	if m.profileIDExistsOutsideUnitLocked(p.ID, unit) {
		return ValidationResult{Valid: false, Errors: []ValidationError{
			{Field: "id", Message: fmt.Sprintf("profile id already exists in another workspace: %s", p.ID)},
		}}, nil
	}

	p.Source = ProfileSourceUser
	p.WorkspaceID = owner.ID
	p.WorkspaceName = owner.Name
	p.WorkspaceRelDir = owner.RelDir
	if p.WorkingDir == "" && unit.relDir != "" {
		p.WorkingDir = unit.relDir
	}

	if err := unit.store.Save(p); err != nil {
		return result, err
	}
	return result, nil
}

// DeleteProfile removes a saved profile, routing by the profile's owning unit.
func (m *ProjectRunProfileManager) DeleteProfile(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	unit := m.unitForProfileIDLocked(id)
	if unit == nil {
		return fmt.Errorf("profile not found: %s", id)
	}
	return unit.store.Delete(id)
}

// PinProfile converts a detected profile to a saved one in its owning unit.
func (m *ProjectRunProfileManager) PinProfile(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, relDir := range m.order {
		u := m.units[relDir]
		for i := range u.detected {
			if u.detected[i].ID == id {
				return u.store.Pin(u.detected[i])
			}
		}
	}
	return fmt.Errorf("detected profile not found: %s", id)
}

// UnpinProfile removes a saved (pinned) profile so the detected twin resurfaces.
func (m *ProjectRunProfileManager) UnpinProfile(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	unit := m.unitForProfileIDLocked(id)
	if unit == nil {
		return fmt.Errorf("profile not found: %s", id)
	}
	if err := unit.store.Delete(id); err != nil {
		return fmt.Errorf("unpin profile %s: %w", id, err)
	}
	return nil
}

// SetActiveVariant updates a profile's env variant, routing saved profiles to
// their store and detected profiles to the in-memory snapshot.
func (m *ProjectRunProfileManager) SetActiveVariant(id string, variant string) error {
	activeVariant := strings.TrimSpace(variant)

	m.mu.Lock()
	defer m.mu.Unlock()

	unit := m.unitForProfileIDLocked(id)
	if unit == nil {
		return fmt.Errorf("profile not found: %s", id)
	}

	for _, profile := range unit.store.GetAll() {
		if profile.ID != id {
			continue
		}
		if err := ensureActiveVariantAllowed(profile, activeVariant); err != nil {
			return err
		}
		profile.ActiveVariant = activeVariant
		return unit.store.Save(profile)
	}
	for i := range unit.detected {
		if unit.detected[i].ID != id {
			continue
		}
		if err := ensureActiveVariantAllowed(unit.detected[i], activeVariant); err != nil {
			return err
		}
		unit.detected[i].ActiveVariant = activeVariant
		return nil
	}
	return fmt.Errorf("profile not found: %s", id)
}

// ReDetect re-runs detection for every unit and returns the combined detected
// snapshot (saved profiles excluded), matching the legacy Manager.ReDetect
// contract used by App.DetectRunProfiles.
func (m *ProjectRunProfileManager) ReDetect() []RunProfile {
	m.mu.Lock()
	defer m.mu.Unlock()
	var detected []RunProfile
	for _, relDir := range m.order {
		u := m.units[relDir]
		u.detected = u.detector.DetectAll()
		detected = append(detected, u.detected...)
	}
	if detected == nil {
		detected = []RunProfile{}
	}
	return detected
}

// HandleFileChange re-detects only the workspace that owns the changed config
// file (longest relDir prefix match). Returns true if a unit re-detected.
func (m *ProjectRunProfileManager) HandleFileChange(path string) bool {
	if !IsConfigFile(filepath.Base(path)) {
		return false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	rel, err := filepath.Rel(m.repoRoot, path)
	if err != nil {
		rel = ""
	}
	// relDir keys are forward-slash (workspace detection uses path.Join for
	// portability), so normalize the OS-separator rel path before matching.
	dir := filepath.ToSlash(filepath.Dir(rel))
	if dir == "." {
		dir = ""
	}

	best := ""
	bestLen := -1
	for relDir := range m.units {
		if relDir == "" {
			if bestLen < 0 {
				best, bestLen = "", 0
			}
			continue
		}
		if hasPathPrefix(dir, relDir) && len(relDir) > bestLen {
			best, bestLen = relDir, len(relDir)
		}
	}

	unit, ok := m.units[best]
	if !ok || unit == nil {
		return false
	}
	unit.detected = unit.detector.DetectAll()
	return true
}

// RunProfilesSnapshot is the combined repo-wide view consumed by the frontend:
// the merged profile list plus per-profile UI state keyed by (globally unique)
// profile ID. It is the single hydration contract for initial load and the
// runprofiles:changed event.
type RunProfilesSnapshot struct {
	Profiles       []RunProfile              `json:"profiles"`
	ProfileState   map[string]ProfileUIState `json:"profileState"`
	WorkspaceEpoch uint64                    `json:"workspaceEpoch"`
}

// Snapshot returns the merged profile list and the union of every unit's
// per-profile UI state. IDs are workspace-scoped and globally unique (Phase 1),
// so a flat merged map is unambiguous.
func (m *ProjectRunProfileManager) Snapshot() RunProfilesSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var merged []RunProfile
	state := map[string]ProfileUIState{}
	for _, relDir := range m.order {
		u := m.units[relDir]
		merged = append(merged, m.combineUnitLocked(u)...)
		if u == nil {
			continue
		}
		for k, v := range u.store.GetState() {
			state[k] = v
		}
	}
	if merged == nil {
		merged = []RunProfile{}
	}
	return RunProfilesSnapshot{Profiles: merged, ProfileState: state}
}

// AdoptProfile marks a profile (by ID) as adopted into the owning workspace's working set.
func (m *ProjectRunProfileManager) AdoptProfile(id string) error { return m.setAdopted(id, true) }

// UnadoptProfile clears the adoption flag for a profile (by ID).
func (m *ProjectRunProfileManager) UnadoptProfile(id string) error { return m.setAdopted(id, false) }

func (m *ProjectRunProfileManager) setAdopted(id string, adopted bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	unit := m.unitForProfileIDLocked(id)
	if unit == nil {
		return fmt.Errorf("profile not found: %s", id)
	}
	return unit.store.SetAdopted(id, adopted)
}

// RecordRun stamps run recency (epoch millis) for a profile (by ID) in its owning workspace store.
func (m *ProjectRunProfileManager) RecordRun(id string, ts int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	unit := m.unitForProfileIDLocked(id)
	if unit == nil {
		return fmt.Errorf("profile not found: %s", id)
	}
	return unit.store.RecordRun(id, ts)
}

// hasPathPrefix reports whether p is within the directory prefix (forward-slash
// aware), e.g. hasPathPrefix("backend/python/sub", "backend/python") == true.
func hasPathPrefix(p, prefix string) bool {
	if prefix == "" {
		return true
	}
	return p == prefix || strings.HasPrefix(p, prefix+"/")
}
