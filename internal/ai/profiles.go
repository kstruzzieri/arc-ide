package ai

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/kstruzzieri/go-llm/profiles"
)

// The closed §5.6 Slice C profile transport: the list projection, the SaveAs
// request, and the SaveAs result. The request is a trust boundary and decodes
// strictly (unknown field, unknown member, explicit null = rejection); the
// results are produced here and validated by frontend/src/types/golemConfig.ts.
// The shared corpus in testdata/settings_apply_contract keeps the two sides
// byte-identical. Paths never cross this boundary in either direction.

// ProfileInfo is one §5.6 list row. Store.List user rows carry ID only —
// description and revision stay absent until Load supplies them, never
// invented (§5.3). Curated is derived from the namespace by the producer, so
// the flag can never disagree with the id.
type ProfileInfo struct {
	ID          string `json:"id"`
	Description string `json:"description,omitempty"`
	Curated     bool   `json:"curated"`
	Revision    string `json:"revision,omitempty"`
}

// GolemProfileListResult is the closed §5.6 list union. `limited` carries the
// first maxProjectionEntries rows in stable ID order.
type GolemProfileListResult struct {
	Status string `json:"status"`
	// Profiles MUST be non-empty whenever Status is "loaded" or "limited". That
	// is guaranteed, not merely hoped for: the embedded curated catalog always
	// contributes at least "curated/local" to Store.List, so an empty
	// loaded/limited result is unreachable by construction, and Task 3's
	// TestListGolemProfilesNeverEmpty is the guard that pins it. `omitempty`
	// here is deliberate and depends on that invariant holding — marshaling a
	// genuinely EMPTY slice would silently drop the member and produce
	// {"status":"loaded"}, which is exactly the byte shape the shared corpus
	// records as reject (reject-profile-list-missing-profiles.json), not the
	// accept shape {"status":"loaded","profiles":[]}
	// (accept-profile-list-loaded-empty.json — that fixture documents a wire
	// shape the SCHEMA allows, not one this producer ever emits). Do not "fix"
	// this by dropping omitempty or switching to *[]ProfileInfo — see
	// TestGolemProfileResultsRoundTripTheContract in settings_apply_test.go,
	// which proves every result this producer can actually emit round-trips
	// through the same contract checks a fixture takes.
	Profiles    []ProfileInfo       `json:"profiles,omitempty"`
	Diagnostics []ProfileDiagnostic `json:"diagnostics,omitempty"`
}

// SaveGolemProfileAsRequest is the §5.6 save request. ExpectedRevision is nil
// exactly when the caller omitted it: absent means create-only and present
// means compare-and-replace — there is no empty-string sentinel and no
// overwrite boolean (§5.3), which is why the member is presence-preserving.
type SaveGolemProfileAsRequest struct {
	ID               string  `json:"id"`
	ExpectedRevision *string `json:"expectedRevision,omitempty"`
	AppliedRevision  string  `json:"appliedRevision"`
}

func (r *SaveGolemProfileAsRequest) UnmarshalJSON(data []byte) error {
	var wire struct {
		ID               string         `json:"id"`
		ExpectedRevision optionalString `json:"expectedRevision"`
		AppliedRevision  string         `json:"appliedRevision"`
	}
	if err := strictUnmarshal(data, &wire); err != nil {
		return err
	}
	*r = SaveGolemProfileAsRequest{
		ID:               wire.ID,
		ExpectedRevision: wire.ExpectedRevision.pointer(),
		AppliedRevision:  wire.AppliedRevision,
	}
	return nil
}

// SavedProfile is the saved outcome's identity: the user profile id and the
// revision the store reports for the written bytes.
type SavedProfile struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
}

// GolemProfileSaveResult is the closed §5.6 save union. The two CAS failures
// are distinct conflict kinds: active_revision (the applied configuration
// moved under the caller) and profile_target (the destination profile moved
// or appeared). The durability warning rides the SAVED variant — upstream
// reports it with a nil error, never as a failure.
type GolemProfileSaveResult struct {
	Status      string              `json:"status"`
	Profile     *SavedProfile       `json:"profile,omitempty"`
	Warning     string              `json:"warning,omitempty"`
	Conflict    string              `json:"conflict,omitempty"`
	Diagnostics []ProfileDiagnostic `json:"diagnostics,omitempty"`
}

var userProfileIDPattern = regexp.MustCompile(`^user/[a-z0-9][a-z0-9-]{0,63}$`)

func validUserProfileID(value string) bool { return userProfileIDPattern.MatchString(value) }

// validateSaveGolemProfileAsRequest enforces the request shape and returns the
// closed refusal, or nil when the request may proceed. The UI validates the
// §5.6 grammar before any call, so a refusal here means a bypassing caller: a
// curated-namespace target gets its exact code, and every other shape break —
// including a present-but-empty expectedRevision, which profiles.SaveAs would
// silently read as create-only — gets the deliberately opaque invalid_id.
func validateSaveGolemProfileAsRequest(req SaveGolemProfileAsRequest) *GolemProfileSaveResult {
	if validProfileID(req.ID) && strings.HasPrefix(req.ID, "curated/") {
		return &GolemProfileSaveResult{Status: "diagnostics",
			Diagnostics: []ProfileDiagnostic{{Code: "curated_read_only", ProfileID: req.ID}}}
	}
	if !validUserProfileID(req.ID) {
		return &GolemProfileSaveResult{Status: "diagnostics",
			Diagnostics: []ProfileDiagnostic{{Code: "invalid_id"}}}
	}
	if !validRevision(req.AppliedRevision) ||
		(req.ExpectedRevision != nil && !validRevision(*req.ExpectedRevision)) {
		return &GolemProfileSaveResult{Status: "diagnostics",
			Diagnostics: []ProfileDiagnostic{{Code: "invalid_id"}}}
	}
	return nil
}

// profileStoreDiagnostics maps one store failure onto the closed §5.6 profile
// vocabulary; anything unmapped (including a raw context cancellation, for
// which CodeOf reports nothing) is the store failing, not the profile: "io".
func profileStoreDiagnostics(err error) []ProfileDiagnostic {
	code, ok := profileStoreCodes[profiles.CodeOf(err)]
	if !ok {
		code = "io"
	}
	return []ProfileDiagnostic{{Code: code}}
}

// projectProfileInfos maps store rows into bounded §5.6 rows. The id shape is
// pinned to upstream ParseID by TestProfileIDPatternMatchesUpstreamParseID, so
// no per-row filtering is needed; `curated` is DERIVED from the namespace so
// the flag can never disagree with the id; descriptions are sanitized
// (Cc/Cf -> U+FFFD) and trimmed to the §5.6 byte bound at a rune boundary; a
// revision crosses only in §5.6 shape. User rows arrive ID-only from
// Store.List and stay that way — nothing is invented here.
func projectProfileInfos(rows []profiles.Info) []ProfileInfo {
	out := make([]ProfileInfo, 0, len(rows))
	for _, row := range rows {
		info := ProfileInfo{
			ID:      string(row.ID),
			Curated: strings.HasPrefix(string(row.ID), "curated/"),
		}
		if desc := trimToBytes(sanitizeIdentifier(row.Description), maxProjectionEndpointLen); desc != "" {
			info.Description = desc
		}
		if validRevision(row.Revision) {
			info.Revision = row.Revision
		}
		out = append(out, info)
	}
	return out
}

// ListGolemProfiles projects Store.List into the closed §5.6 list union
// (spec §5.3). It is a pure read — no idle barrier, no snapshot, no write —
// carrying only the lifecycle registration the §5.5 close machine consults,
// so Close waits out an in-flight listing and a closing service refuses new
// ones. `limited` truncates to the first maxProjectionEntries rows in the
// store's stable ID order; the "Too many profiles to display." copy is the
// frontend's, keyed off the status.
func (s *Service) ListGolemProfiles() (GolemProfileListResult, error) {
	const op = "profile-list"
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return GolemProfileListResult{}, s.publicErr(op, fmt.Errorf("%w: profile list rejected", errServiceClosing))
	}
	s.wg.Add(1)
	s.lifecycleMu.Unlock()
	defer s.wg.Done()

	store, err := profiles.DefaultStoreWithOptions(profileStoreOptions())
	if err != nil {
		// The user config directory could not be resolved; there is no store.
		return GolemProfileListResult{Status: "diagnostics",
			Diagnostics: []ProfileDiagnostic{{Code: "io"}}}, nil
	}
	rows, err := store.List(s.baseCtx)
	if err != nil {
		return GolemProfileListResult{Status: "diagnostics",
			Diagnostics: profileStoreDiagnostics(err)}, nil
	}
	infos := projectProfileInfos(rows)
	if len(infos) > maxProjectionEntries {
		return GolemProfileListResult{Status: "limited", Profiles: infos[:maxProjectionEntries]}, nil
	}
	return GolemProfileListResult{Status: "loaded", Profiles: infos}, nil
}

func profileSaveDiagnostics(code string) GolemProfileSaveResult {
	return GolemProfileSaveResult{Status: "diagnostics",
		Diagnostics: []ProfileDiagnostic{{Code: code}}}
}

// profileSaveResult maps one Store.SaveAs outcome onto the closed §5.6 result.
// The nil-error durability path is the one that bites: Persisted==true ALWAYS
// pairs with a nil error, so the warning rides SaveOutcome.Warning and an
// error-only inspection would lose it (§4.8). CodeConflict — create collision,
// stale CAS, or a mid-overwrite vanish — is the profile_target conflict; the
// active_revision conflict is decided earlier, against the applied document.
func profileSaveResult(id string, outcome profiles.SaveOutcome, err error) GolemProfileSaveResult {
	if err == nil {
		result := GolemProfileSaveResult{
			Status:  "saved",
			Profile: &SavedProfile{ID: id, Revision: outcome.Revision},
		}
		if outcome.Warning == profiles.CodeDurability {
			result.Warning = "durability_uncertain"
		}
		return result
	}
	if profiles.CodeOf(err) == profiles.CodeConflict {
		return GolemProfileSaveResult{Status: "conflict", Conflict: "profile_target"}
	}
	diagnostics := profileStoreDiagnostics(err)
	if validProfileID(id) {
		diagnostics[0].ProfileID = id
	}
	return GolemProfileSaveResult{Status: "diagnostics", Diagnostics: diagnostics}
}

// saveDestinationPath mirrors how the upstream DefaultStore computes the file
// a SaveAs would write: UserConfigDir()/go-llm/profiles/<slug>.json. The store
// does not expose its root, so this is a deliberate mirror — the active-alias
// tests stand as the drift gate against the upstream layout. Named exactly so
// a drift can be verified in one hop: it mirrors go-llm's profiles/store.go —
// DefaultStore's root (UserConfigDir()/go-llm) and SaveAs's own destination
// join, filepath.Join(s.root, "profiles", slug+".json"). If upstream ever
// changes either half, this function silently stops matching the file
// Store.SaveAs actually writes.
func saveDestinationPath(id string) (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	slug := strings.TrimPrefix(id, "user/")
	return filepath.Join(base, "go-llm", "profiles", slug+".json"), nil
}

// activeAliasSameFile reports whether the SaveAs destination IS the active
// configuration source, by FILE IDENTITY. Resolved-path string equality is not
// identity: filepath.EvalSymlinks preserves basename spelling, so on macOS's
// default case-insensitive filesystems an active source discovered as
// profiles/MINE.JSON and the user/mine destination resolve to unequal strings
// while naming one file. Two legs (controller ruling, header block):
//   - the destination exists: os.SameFile on both os.Stat results decides.
//   - the destination does not exist (create-only): the destination's parent
//     directory, resolved through EvalSymlinks, is compared by os.SameFile
//     against the resolved active source's parent, plus the basenames under
//     strings.EqualFold. Deliberately conservative: on a case-SENSITIVE
//     filesystem this also refuses a store whose active file differs from the
//     destination only by letter case — a live target one case-flip from a
//     profile slot is an unsafe store too, and the refusal costs one name.
//
// Failures on the ACTIVE side refuse (the file was just parsed; a source that
// cannot be stat'ed cannot be proven distinct from the destination); failures
// on the destination side fall through to "no alias" (no store to write into).
func activeAliasSameFile(destination, activeSource string) bool {
	activeInfo, err := os.Stat(activeSource)
	if err != nil {
		return true
	}
	if destInfo, err := os.Stat(destination); err == nil {
		return os.SameFile(destInfo, activeInfo)
	}
	destParent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return false
	}
	destParentInfo, err := os.Stat(destParent)
	if err != nil {
		return false
	}
	activeResolved, err := filepath.EvalSymlinks(activeSource)
	if err != nil {
		return true
	}
	activeParentInfo, err := os.Stat(filepath.Dir(activeResolved))
	if err != nil {
		return true
	}
	return os.SameFile(destParentInfo, activeParentInfo) &&
		strings.EqualFold(filepath.Base(destination), filepath.Base(activeResolved))
}

// SaveGolemProfileAs duplicates the APPLIED configuration into the user
// profile store (§5.3, §4.8). It is its own service operation: registered
// with the §5.5 close-wait set (closing refusal + waitgroup unit) and reading
// through the binding gate's READ side so it can never interleave with a
// mid-publication settings write — but deliberately NOT under the
// writeSettings barrier: it never touches active publication, runners, or
// conversation-busy gating, so a running Golem turn does not block it.
//
// The document handed to the store is ALWAYS a fresh parse of the active
// target — never the runtime-owned document and never a projection rebuild —
// because upstream SaveAs mutates origin and revision, and because §4.8's
// scrub guarantee is defined on the authored bytes. ClearAllProviderAPIKeys
// runs before Store.SaveAs sees the document; there is no enumerate-then-clear
// substitute (§5.2c).
func (s *Service) SaveGolemProfileAs(req SaveGolemProfileAsRequest) (GolemProfileSaveResult, error) {
	const op = "profile-save"
	s.lifecycleMu.Lock()
	if s.closing {
		s.lifecycleMu.Unlock()
		return GolemProfileSaveResult{}, s.publicErr(op, fmt.Errorf("%w: profile save rejected", errServiceClosing))
	}
	s.wg.Add(1)
	s.lifecycleMu.Unlock()
	defer s.wg.Done()

	s.bindingGate.RLock()
	defer s.bindingGate.RUnlock()
	if s.isClosing() {
		return GolemProfileSaveResult{}, s.publicErr(op, fmt.Errorf("%w: profile save rejected", errServiceClosing))
	}

	if refusal := validateSaveGolemProfileAsRequest(req); refusal != nil {
		return *refusal, nil
	}

	// Read-side capture: one fresh discovery + parse decides everything below.
	doc, loaded, err := loadAgentConfigDocument()
	if err != nil {
		// Missing, unreadable, or invalid: no valid applied source to
		// duplicate (§4.8 refuses Save for Missing and Invalid alike).
		return profileSaveDiagnostics("active_config_invalid"), nil
	}
	if projection := buildSettingsProjection(loaded, nil); projection.State != "ready" {
		// Limited (read-only or unsafe identifiers): §4.8's duplicate-era rule
		// — Save requires a valid applied source at state 'ready'.
		return profileSaveDiagnostics("active_config_invalid"), nil
	}
	if loaded.Revision != req.AppliedRevision {
		return GolemProfileSaveResult{Status: "conflict", Conflict: "active_revision"}, nil
	}
	// Active-alias gate (controller ruling, header block): a destination that
	// IS the active configuration source — GO_LLM_CONFIG pointing into the
	// store directly, through a symlink, or under a case-varied spelling —
	// would make this "profile save" a silent scrubbed replacement of the LIVE
	// target under the read gate, with no settings publication and no runner
	// retirement. That store arrangement is refused as unsafe; active bytes
	// are never touched. The comparison is FILE IDENTITY (activeAliasSameFile),
	// never resolved-path string equality — EvalSymlinks preserves spelling,
	// so string equality misses the case alias on macOS's default filesystems.
	destination, destErr := saveDestinationPath(req.ID)
	if destErr != nil {
		return profileSaveDiagnostics("io"), nil
	}
	if activeAliasSameFile(destination, loaded.SourcePath) {
		return GolemProfileSaveResult{Status: "diagnostics",
			Diagnostics: []ProfileDiagnostic{{Code: "store_unsafe", ProfileID: req.ID}}}, nil
	}
	if err := doc.ClearAllProviderAPIKeys(); err != nil {
		// A document that refuses the scrub mutation cannot be sanitized.
		return profileSaveDiagnostics("active_config_invalid"), nil
	}

	store, err := profiles.DefaultStoreWithOptions(profileStoreOptions())
	if err != nil {
		return profileSaveDiagnostics("io"), nil
	}
	if req.ExpectedRevision == nil {
		// §5.6: while the list is limited a CREATE is refused with
		// profile_limit; replacing an existing profile by exact id/revision
		// stays available. The count condition is exactly the limited
		// condition, so the two gates cannot drift.
		rows, listErr := store.List(s.baseCtx)
		if listErr != nil {
			return GolemProfileSaveResult{Status: "diagnostics",
				Diagnostics: profileStoreDiagnostics(listErr)}, nil
		}
		if len(rows) > maxProjectionEntries {
			return profileSaveDiagnostics("profile_limit"), nil
		}
	}
	outcome, err := store.SaveAs(s.baseCtx, profiles.ID(req.ID), doc, derefString(req.ExpectedRevision))
	return profileSaveResult(req.ID, outcome, err), nil
}
