package ai

import (
	"regexp"
	"strings"
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
