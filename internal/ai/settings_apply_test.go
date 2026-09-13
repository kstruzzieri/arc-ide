package ai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"firn/internal/filesystem"
	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/profiles"
	"github.com/kstruzzieri/go-llm/provider"
)

// ---------------------------------------------------------------------------
// Result-side oracles. Apply/cancel/profile results are PRODUCED by Go and
// consumed by the TypeScript validator, so the closed rules live here as a
// test twin of frontend/src/types/golemConfig.ts; the shared corpus
// (testdata/settings_apply_contract) keeps the two honest. Request validation
// is the opposite direction — it is production code in settings_apply.go,
// because the request is the trust boundary.
// ---------------------------------------------------------------------------

var applyConsentOutcomes = map[string]bool{"unchanged": true, "recorded": true, "uncertain": true}

var applyConflictKinds = map[string]bool{"target": true, "profile_source": true, "challenge": true}

// validChallengeToken mirrors the §5.6 rule: opaque, 1..256 UTF-8 bytes, and
// (like every other string that reaches the UI) free of control runes.
func validChallengeToken(token string) bool {
	return token != "" && len(token) <= maxChallengeTokenBytes &&
		sanitizeIdentifier(token) == token
}

// validChangeID checks the stable change identity carried by a drop set:
// "<namespace>:<identifier>" over the four §3.3 namespaces. A bare identifier,
// an unknown namespace, or a CHANGE KIND used as one ("provider-key-set:"
// rather than "provider-key:") is a contract break, not a bounded string.
func validChangeID(id string) bool {
	namespace, identity, ok := strings.Cut(id, ":")
	return ok && changeIdentityNamespaces[namespace] && validRequestIdentifier(identity)
}

func validateDropSets(drops []ChangeDropSet) error {
	if len(drops) == 0 || len(drops) > maxProjectionEntries {
		return fmt.Errorf("drops = %d entries", len(drops))
	}
	seen := map[string]bool{}
	for i, drop := range drops {
		if !validChangeID(drop.ChangeID) {
			return fmt.Errorf("drops[%d].changeId = %q", i, drop.ChangeID)
		}
		if seen[drop.ChangeID] {
			return fmt.Errorf("drops[%d] repeats change id %q", i, drop.ChangeID)
		}
		seen[drop.ChangeID] = true
		if !canonicalDropFields(drop.Fields) {
			return fmt.Errorf("drops[%d].fields = %v", i, drop.Fields)
		}
	}
	return nil
}

// maxChallengeProvenanceBytes bounds one rendered provenance hop: at most two
// bounded identifiers joined by a fixed literal. It lives with the oracle
// because the oracle is the only thing that consults it — renderHop's inputs
// are fixed vocabulary today (reachableDestinations only ever builds hops from
// useCaseAgent), so no production path can exceed it and a constant sitting in
// settings_apply.go would read as a ceiling nothing enforces. If a hop ever
// interpolates a configuration-supplied identifier, the bound has to become a
// real check inside applyDestinations, not just this assertion.
const maxChallengeProvenanceBytes = 2*maxProjectionIdentifierLen + 32

func validateApplyChallenge(c *ApplyChallenge) error {
	if c == nil {
		return fmt.Errorf("challenge missing")
	}
	if !validChallengeToken(c.Token) {
		return fmt.Errorf("challenge token")
	}
	// expiresAt is a Unix-millisecond instant: positive, and inside the range
	// JavaScript can represent exactly (the frontend reads it as a number).
	if c.ExpiresAt < 1 || c.ExpiresAt > 9007199254740991 {
		return fmt.Errorf("challenge expiresAt = %d", c.ExpiresAt)
	}
	// Every NEW remote destination the write would open. A challenge that
	// lists none is not a consent question, and a local destination is never
	// one. The model is ABSENT on a destination reached by upstream's
	// recommendation route, which names a provider and no model at all.
	if len(c.Destinations) == 0 || len(c.Destinations) > maxProjectionEntries {
		return fmt.Errorf("challenge destinations = %d entries", len(c.Destinations))
	}
	for i, d := range c.Destinations {
		if !validRequestIdentifier(d.Provider) || !validRequestEndpoint(d.Endpoint) ||
			d.Classification != "remote" || (d.Model != "" && !validRequestIdentifier(d.Model)) {
			return fmt.Errorf("challenge destinations[%d] = %+v", i, d)
		}
		if len(d.Provenance) == 0 || len(d.Provenance) > maxProjectionEntries {
			return fmt.Errorf("challenge destinations[%d].provenance = %d entries", i, len(d.Provenance))
		}
		for j, hop := range d.Provenance {
			if hop == "" || len(hop) > maxChallengeProvenanceBytes || sanitizeIdentifier(hop) != hop {
				return fmt.Errorf("challenge destinations[%d].provenance[%d] = %q", i, j, hop)
			}
		}
	}
	return nil
}

// validateSettingsApplyResult enforces the §5.6 result union: the status
// decides exactly which optional members may be present, and every absent
// member must stay absent (a busy result carrying a projection is a contract
// break, not a harmless extra).
func validateSettingsApplyResult(r SettingsApplyResult) error {
	present := map[string]bool{
		"projection":     r.Projection != nil,
		"warning":        r.Warning != "",
		"challenge":      r.Challenge != nil,
		"drops":          r.Drops != nil,
		"conflict":       r.Conflict != "",
		"consentOutcome": r.ConsentOutcome != "",
		"diagnostics":    r.Diagnostics != nil,
	}
	allowed := map[string][]string{
		"applied":                    {"projection", "warning"},
		"consent_required":           {"challenge"},
		"drop_confirmation_required": {"drops"},
		"conflict":                   {"conflict", "projection", "consentOutcome"},
		"diagnostics":                {"diagnostics", "consentOutcome"},
		"busy":                       {},
		"limited":                    {"diagnostics"},
	}
	names, ok := allowed[r.Status]
	if !ok {
		return fmt.Errorf("status %q", r.Status)
	}
	for name, isPresent := range present {
		if isPresent && !contains(names, name) {
			return fmt.Errorf("status %q carries %q", r.Status, name)
		}
	}

	switch r.Status {
	case "applied":
		if r.Projection == nil {
			return fmt.Errorf("applied without a projection")
		}
		if r.Warning != "" && r.Warning != "durability_uncertain" {
			return fmt.Errorf("warning %q", r.Warning)
		}
		return validateSettingsProjection(*r.Projection)
	case "consent_required":
		return validateApplyChallenge(r.Challenge)
	case "drop_confirmation_required":
		return validateDropSets(r.Drops)
	case "conflict":
		if !applyConflictKinds[r.Conflict] || !applyConsentOutcomes[r.ConsentOutcome] {
			return fmt.Errorf("conflict %q/%q", r.Conflict, r.ConsentOutcome)
		}
		if r.Projection != nil {
			return validateSettingsProjection(*r.Projection)
		}
		return nil
	case "diagnostics":
		if !applyConsentOutcomes[r.ConsentOutcome] {
			return fmt.Errorf("consentOutcome %q", r.ConsentOutcome)
		}
		if len(r.Diagnostics) == 0 {
			return fmt.Errorf("diagnostics result carries none")
		}
		for i, d := range r.Diagnostics {
			if !d.Blocking {
				return fmt.Errorf("diagnostics[%d] is not blocking", i)
			}
		}
		return validateDiagnostics(r.Diagnostics)
	case "limited":
		if len(r.Diagnostics) == 0 {
			return fmt.Errorf("limited result carries no diagnostics")
		}
		return validateDiagnostics(r.Diagnostics)
	}
	return nil
}

func validateCancelSettingsApplyResult(r CancelSettingsApplyResult) error {
	if r.Status != "cancelled" {
		return fmt.Errorf("cancel status %q", r.Status)
	}
	return nil
}

// validateProfileDraftProjection reuses the full-projection oracle: a draft is
// exactly a projection minus sourceOrigin and revision, so the two omitted
// fields are supplied here and every remaining rule (entity order, capability
// facts, limited cause, ready writability) is checked once, in one place.
// The draft-only rules are the state subset and the credential-free promise.
func validateProfileDraftProjection(d ProfileDraftProjection) error {
	if d.State != "ready" && d.State != "limited" {
		return fmt.Errorf("draft state %q", d.State)
	}
	for i, p := range d.Providers {
		if p.CredentialState != "none" {
			return fmt.Errorf("draft provider[%d] carries credential state %q", i, p.CredentialState)
		}
	}
	return validateSettingsProjection(SettingsProjection{
		State: d.State, SourceOrigin: "none", Revision: testSettingsRevision,
		ReadOnly: d.ReadOnly, Editable: d.Editable, Routes: d.Routes,
		Models: d.Models, Providers: d.Providers, Diagnostics: d.Diagnostics,
	})
}

var profileDiagnosticCodes = map[string]bool{
	"invalid_id": true, "not_found": true, "curated_read_only": true,
	"store_unsafe": true, "io": true, "config_invalid": true,
	"active_config_invalid": true, "profile_limit": true,
}

func validateGolemProfileLoadResult(r GolemProfileLoadResult) error {
	switch r.Status {
	case "loaded":
		if r.Diagnostics != nil {
			return fmt.Errorf("loaded result carries diagnostics")
		}
		if !validProfileID(r.ProfileID) || !validRevision(r.SourceRevision) {
			return fmt.Errorf("profile %q/%q", r.ProfileID, r.SourceRevision)
		}
		if r.Projection == nil {
			return fmt.Errorf("loaded result carries no projection")
		}
		return validateProfileDraftProjection(*r.Projection)
	case "diagnostics":
		if r.ProfileID != "" || r.SourceRevision != "" || r.Projection != nil {
			return fmt.Errorf("diagnostics result carries loaded members")
		}
		return validateProfileDiagnosticList(r.Diagnostics)
	}
	return fmt.Errorf("profile load status %q", r.Status)
}

func validateProfileDiagnosticList(ds []ProfileDiagnostic) error {
	if len(ds) == 0 || len(ds) > maxProjectionEntries {
		return fmt.Errorf("profile diagnostics = %d", len(ds))
	}
	for i, d := range ds {
		if !profileDiagnosticCodes[d.Code] {
			return fmt.Errorf("profile diagnostic[%d] code %q", i, d.Code)
		}
		if d.ProfileID != "" && !validProfileID(d.ProfileID) {
			return fmt.Errorf("profile diagnostic[%d] id %q", i, d.ProfileID)
		}
	}
	return nil
}

// validateGolemProfileListResult enforces the §5.6 list union: bounded,
// ascending-unique ids, curated flag agreeing with the namespace, bounded
// non-empty descriptions, and §5.6-shaped revisions.
func validateGolemProfileListResult(r GolemProfileListResult) error {
	switch r.Status {
	case "loaded", "limited":
		if r.Diagnostics != nil {
			return fmt.Errorf("%s result carries diagnostics", r.Status)
		}
		if r.Profiles == nil || len(r.Profiles) > maxProjectionEntries {
			return fmt.Errorf("profiles = %d entries", len(r.Profiles))
		}
		for i, p := range r.Profiles {
			if !validProfileID(p.ID) {
				return fmt.Errorf("profiles[%d].id %q", i, p.ID)
			}
			if p.Curated != strings.HasPrefix(p.ID, "curated/") {
				return fmt.Errorf("profiles[%d] curated flag disagrees with namespace", i)
			}
			if len(p.Description) > maxProjectionEndpointLen {
				return fmt.Errorf("profiles[%d] description over bound", i)
			}
			if p.Revision != "" && !validRevision(p.Revision) {
				return fmt.Errorf("profiles[%d].revision %q", i, p.Revision)
			}
			if i > 0 && r.Profiles[i-1].ID >= p.ID {
				return fmt.Errorf("profiles out of order at %d", i)
			}
		}
		return nil
	case "diagnostics":
		if r.Profiles != nil {
			return fmt.Errorf("diagnostics result carries profiles")
		}
		return validateProfileDiagnosticList(r.Diagnostics)
	}
	return fmt.Errorf("list status %q", r.Status)
}

var profileSaveConflicts = map[string]bool{"active_revision": true, "profile_target": true}

func validateGolemProfileSaveResult(r GolemProfileSaveResult) error {
	switch r.Status {
	case "saved":
		if r.Conflict != "" || r.Diagnostics != nil {
			return fmt.Errorf("saved result carries refusal members")
		}
		if r.Profile == nil || !validUserProfileID(r.Profile.ID) || !validRevision(r.Profile.Revision) {
			return fmt.Errorf("saved profile %+v", r.Profile)
		}
		if r.Warning != "" && r.Warning != "durability_uncertain" {
			return fmt.Errorf("warning %q", r.Warning)
		}
		return nil
	case "conflict":
		if r.Profile != nil || r.Warning != "" || r.Diagnostics != nil {
			return fmt.Errorf("conflict result carries saved members")
		}
		if !profileSaveConflicts[r.Conflict] {
			return fmt.Errorf("conflict %q", r.Conflict)
		}
		return nil
	case "diagnostics":
		if r.Profile != nil || r.Warning != "" || r.Conflict != "" {
			return fmt.Errorf("diagnostics result carries saved members")
		}
		return validateProfileDiagnosticList(r.Diagnostics)
	}
	return fmt.Errorf("save status %q", r.Status)
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Raw-shape checks. Typed decoding erases the difference between an absent key
// and a typed zero value, so the fixtures that turn on presence (a required
// boolean, an optional string that must never be emitted empty) are checked
// against the raw JSON — the same split settings_test.go's structuralCheck
// already draws for the projection.
// ---------------------------------------------------------------------------

func nonEmptyOptionalString(object map[string]json.RawMessage, key, where string) error {
	if _, ok := object[key]; !ok {
		return nil
	}
	value, err := contractStringField(object, key, where)
	if err != nil {
		return err
	}
	if value == "" {
		return fmt.Errorf("%s.%s is present but empty", where, key)
	}
	return nil
}

func applyResultStructuralCheck(raw json.RawMessage) error {
	root, err := contractObject(raw, "result")
	if err != nil {
		return err
	}
	if _, err := contractStringField(root, "status", "result"); err != nil {
		return err
	}
	if err := nonEmptyOptionalString(root, "warning", "result"); err != nil {
		return err
	}
	if _, ok := root["diagnostics"]; ok {
		if err := diagnosticsStructuralCheck(root, "result"); err != nil {
			return err
		}
	}
	if _, ok := root["projection"]; ok {
		return structuralCheck(root["projection"])
	}
	return nil
}

func profileLoadStructuralCheck(raw json.RawMessage) error {
	root, err := contractObject(raw, "profileLoad")
	if err != nil {
		return err
	}
	if _, err := contractStringField(root, "status", "profileLoad"); err != nil {
		return err
	}
	for _, key := range []string{"profileId", "sourceRevision"} {
		if err := nonEmptyOptionalString(root, key, "profileLoad"); err != nil {
			return err
		}
	}
	if _, ok := root["diagnostics"]; ok {
		if err := profileDiagnosticsStructuralCheck(root, "profileLoad"); err != nil {
			return err
		}
	}
	if _, ok := root["projection"]; ok {
		return draftStructuralCheck(root["projection"])
	}
	return nil
}

// profileDiagnosticsStructuralCheck is the raw-shape half of profile
// diagnostics validation, shared by the load, list, and save walkers: `code`
// is a present string and `profileId`, when present, is a non-empty string —
// typed decoding reads null and "" as the same absent value.
func profileDiagnosticsStructuralCheck(root map[string]json.RawMessage, where string) error {
	entries, err := contractArrayField(root, "diagnostics", where)
	if err != nil {
		return err
	}
	for i, entry := range entries {
		at := fmt.Sprintf("%s.diagnostics[%d]", where, i)
		fields, err := contractObject(entry, at)
		if err != nil {
			return err
		}
		if _, err := contractStringField(fields, "code", at); err != nil {
			return err
		}
		if err := nonEmptyOptionalString(fields, "profileId", at); err != nil {
			return err
		}
	}
	return nil
}

// profileListStructuralCheck guards what typed decoding erases: a required
// boolean's raw presence, present-but-null/empty optional strings, and
// diagnostic member shapes.
func profileListStructuralCheck(raw json.RawMessage) error {
	root, err := contractObject(raw, "profileList")
	if err != nil {
		return err
	}
	if _, err := contractStringField(root, "status", "profileList"); err != nil {
		return err
	}
	if _, ok := root["diagnostics"]; ok {
		if err := profileDiagnosticsStructuralCheck(root, "profileList"); err != nil {
			return err
		}
	}
	if _, ok := root["profiles"]; !ok {
		return nil
	}
	entries, err := contractArrayField(root, "profiles", "profileList")
	if err != nil {
		return err
	}
	for i, entry := range entries {
		where := fmt.Sprintf("profileList.profiles[%d]", i)
		fields, err := contractObject(entry, where)
		if err != nil {
			return err
		}
		if _, err := contractStringField(fields, "id", where); err != nil {
			return err
		}
		if err := contractBoolField(fields, "curated", where); err != nil {
			return err
		}
		for _, key := range []string{"description", "revision"} {
			if err := nonEmptyOptionalString(fields, key, where); err != nil {
				return err
			}
		}
	}
	return nil
}

func profileSaveResultStructuralCheck(raw json.RawMessage) error {
	root, err := contractObject(raw, "profileSave")
	if err != nil {
		return err
	}
	if _, err := contractStringField(root, "status", "profileSave"); err != nil {
		return err
	}
	for _, key := range []string{"warning", "conflict"} {
		if err := nonEmptyOptionalString(root, key, "profileSave"); err != nil {
			return err
		}
	}
	// A present `profile` member must be an object with non-empty id/revision
	// strings on the RAW bytes: `profile: null` on a conflict result decodes to
	// the same nil pointer as absence, and null/empty member values decode to
	// the same "" the validators treat as fine for the conflict variants.
	if member, ok := root["profile"]; ok {
		fields, err := contractObject(member, "profileSave.profile")
		if err != nil {
			return err
		}
		for _, key := range []string{"id", "revision"} {
			value, err := contractStringField(fields, key, "profileSave.profile")
			if err != nil {
				return err
			}
			if value == "" {
				return fmt.Errorf("profileSave.profile.%s is empty", key)
			}
		}
	}
	if _, ok := root["diagnostics"]; ok {
		if err := profileDiagnosticsStructuralCheck(root, "profileSave"); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// The shared corpus.
// ---------------------------------------------------------------------------

type applyFixture struct {
	Verdict  string          `json:"verdict"`
	Document string          `json:"document"`
	Mode     string          `json:"mode"`
	Value    json.RawMessage `json:"value"`
}

func fixtureApplyMode(f applyFixture) (applyMode, error) {
	switch f.Mode {
	case "apply":
		return applyModeExisting, nil
	case "create":
		return applyModeCreate, nil
	}
	return applyModeExisting, fmt.Errorf("mode %q", f.Mode)
}

// checkApplyFixture returns nil exactly when every layer accepts the fixture.
// Requests go through plain json.Unmarshal on purpose: that is what the Wails
// binding does, so this proves the strict decoding lives on the TYPES (their
// UnmarshalJSON) rather than in a decoder only the tests configure.
func checkApplyFixture(f applyFixture) error {
	switch f.Document {
	case "apply_request":
		mode, err := fixtureApplyMode(f)
		if err != nil {
			return err
		}
		var req SettingsApplyRequest
		if err := json.Unmarshal(f.Value, &req); err != nil {
			return err
		}
		return validateSettingsApplyRequest(req, mode)
	case "confirm_request":
		mode, err := fixtureApplyMode(f)
		if err != nil {
			return err
		}
		var req ConfirmSettingsApplyRequest
		if err := json.Unmarshal(f.Value, &req); err != nil {
			return err
		}
		return validateConfirmSettingsApplyRequest(req, mode)
	case "apply_result":
		if err := applyResultStructuralCheck(f.Value); err != nil {
			return err
		}
		var result SettingsApplyResult
		if err := strictDecodeFixture(f.Value, &result); err != nil {
			return err
		}
		return validateSettingsApplyResult(result)
	case "cancel_result":
		var result CancelSettingsApplyResult
		if err := strictDecodeFixture(f.Value, &result); err != nil {
			return err
		}
		return validateCancelSettingsApplyResult(result)
	case "profile_load_result":
		if err := profileLoadStructuralCheck(f.Value); err != nil {
			return err
		}
		var result GolemProfileLoadResult
		if err := strictDecodeFixture(f.Value, &result); err != nil {
			return err
		}
		return validateGolemProfileLoadResult(result)
	case "profile_list_result":
		if err := profileListStructuralCheck(f.Value); err != nil {
			return err
		}
		var result GolemProfileListResult
		if err := strictDecodeFixture(f.Value, &result); err != nil {
			return err
		}
		return validateGolemProfileListResult(result)
	case "profile_save_request":
		// Plain json.Unmarshal on purpose: that is the Wails decode path, so
		// this proves strictness lives on the production type's UnmarshalJSON
		// (§4.8 — never only in test decoders).
		var req SaveGolemProfileAsRequest
		if err := json.Unmarshal(f.Value, &req); err != nil {
			return err
		}
		if refusal := validateSaveGolemProfileAsRequest(req); refusal != nil {
			return fmt.Errorf("save request refused: %s", refusal.Diagnostics[0].Code)
		}
		return nil
	case "profile_save_result":
		if err := profileSaveResultStructuralCheck(f.Value); err != nil {
			return err
		}
		var result GolemProfileSaveResult
		if err := strictDecodeFixture(f.Value, &result); err != nil {
			return err
		}
		return validateGolemProfileSaveResult(result)
	}
	return fmt.Errorf("document %q", f.Document)
}

func strictDecodeFixture(raw json.RawMessage, target any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(target)
}

func TestSettingsApplyContractCorpus(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("testdata", "settings_apply_contract", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("apply corpus missing: %v (%d files)", err, len(files))
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var fixture applyFixture
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		checkErr := checkApplyFixture(fixture)
		switch fixture.Verdict {
		case "accept":
			if checkErr != nil {
				t.Fatalf("%s: accept fixture rejected: %v", file, checkErr)
			}
		case "reject":
			if checkErr == nil {
				t.Fatalf("%s: reject fixture passed every check", file)
			}
		default:
			t.Fatalf("%s: verdict %q", file, fixture.Verdict)
		}
	}
}

// TestApplyCorpusCoversEveryVariant fails when a union member loses its
// fixtures: the corpus is the contract, so a silently deleted variant must not
// pass as "all fixtures green".
func TestApplyCorpusCoversEveryVariant(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("testdata", "settings_apply_contract", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	documents := map[string]int{}
	kinds := map[string]int{}
	statuses := map[string]int{}
	listStatuses := map[string]int{}
	saveStatuses := map[string]int{}
	saveConflicts := map[string]int{}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var fixture applyFixture
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatal(err)
		}
		documents[fixture.Document]++
		if fixture.Verdict != "accept" {
			continue
		}
		var probe struct {
			Status   string `json:"status"`
			Conflict string `json:"conflict"`
			Changes  []struct {
				Kind string `json:"kind"`
			} `json:"changes"`
		}
		if err := json.Unmarshal(fixture.Value, &probe); err == nil {
			switch {
			case fixture.Document == "apply_result" && probe.Status != "":
				statuses[probe.Status]++
			case fixture.Document == "profile_list_result" && probe.Status != "":
				listStatuses[probe.Status]++
			case fixture.Document == "profile_save_result" && probe.Status != "":
				saveStatuses[probe.Status]++
				if probe.Conflict != "" {
					saveConflicts[probe.Conflict]++
				}
			}
			for _, change := range probe.Changes {
				kinds[change.Kind]++
			}
		}
	}
	for _, document := range []string{
		"apply_request", "confirm_request", "apply_result", "cancel_result",
		"profile_load_result", "profile_list_result", "profile_save_request",
		"profile_save_result",
	} {
		if documents[document] == 0 {
			t.Fatalf("corpus has no %s fixture", document)
		}
	}
	for kind := range changeKinds {
		if kinds[kind] == 0 {
			t.Fatalf("corpus accepts no %q change", kind)
		}
	}
	for _, status := range []string{
		"applied", "consent_required", "drop_confirmation_required", "conflict",
		"diagnostics", "busy", "limited",
	} {
		if statuses[status] == 0 {
			t.Fatalf("corpus accepts no %q result", status)
		}
	}
	for _, status := range []string{"loaded", "limited", "diagnostics"} {
		if listStatuses[status] == 0 {
			t.Fatalf("corpus accepts no %q profile list result", status)
		}
	}
	for _, status := range []string{"saved", "conflict", "diagnostics"} {
		if saveStatuses[status] == 0 {
			t.Fatalf("corpus accepts no %q profile save result", status)
		}
	}
	for _, kind := range []string{"active_revision", "profile_target"} {
		if saveConflicts[kind] == 0 {
			t.Fatalf("corpus accepts no %q save conflict", kind)
		}
	}
}

// TestGolemProfileResultsRoundTripTheContract closes the gap
// TestSettingsApplyContractCorpus leaves open: that test only ever DECODES
// corpus bytes into the production types, so it can never catch a producer
// whose own MARSHALED output the same contract would reject. This test goes
// the other direction — it builds every REACHABLE GolemProfileListResult and
// GolemProfileSaveResult (the shapes the real producer can emit, never an
// unreachable empty loaded/limited list — see the Profiles field comment on
// GolemProfileListResult in profiles.go), marshals each with json.Marshal
// (the same encoding/json the Wails runtime uses), and runs the resulting
// bytes back through the exact three-layer contract path a fixture takes:
// the structural check, then a strict decode, then the result validator.
func TestGolemProfileResultsRoundTripTheContract(t *testing.T) {
	curated := ProfileInfo{
		ID: "curated/local", Description: "Vetted local llama-swap lineup",
		Curated: true, Revision: testSettingsRevision,
	}
	user := ProfileInfo{ID: "user/mine", Curated: false}

	listCases := map[string]GolemProfileListResult{
		"loaded":      {Status: "loaded", Profiles: []ProfileInfo{curated, user}},
		"limited":     {Status: "limited", Profiles: []ProfileInfo{curated, user}},
		"diagnostics": {Status: "diagnostics", Diagnostics: []ProfileDiagnostic{{Code: "io"}}},
	}
	for name, result := range listCases {
		t.Run("list/"+name, func(t *testing.T) {
			raw, err := json.Marshal(result)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if err := profileListStructuralCheck(raw); err != nil {
				t.Fatalf("structural check rejected published output: %v (%s)", err, raw)
			}
			var decoded GolemProfileListResult
			if err := strictDecodeFixture(raw, &decoded); err != nil {
				t.Fatalf("strict decode rejected published output: %v (%s)", err, raw)
			}
			if err := validateGolemProfileListResult(decoded); err != nil {
				t.Fatalf("validator rejected published output: %v (%s)", err, raw)
			}
		})
	}

	saveCases := map[string]GolemProfileSaveResult{
		"saved": {Status: "saved", Profile: &SavedProfile{ID: "user/mine", Revision: testSettingsRevision}},
		"saved-with-warning": {
			Status: "saved", Profile: &SavedProfile{ID: "user/mine", Revision: testSettingsRevision},
			Warning: "durability_uncertain",
		},
		"conflict":    {Status: "conflict", Conflict: "active_revision"},
		"diagnostics": {Status: "diagnostics", Diagnostics: []ProfileDiagnostic{{Code: "profile_limit"}}},
	}
	for name, result := range saveCases {
		t.Run("save/"+name, func(t *testing.T) {
			raw, err := json.Marshal(result)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if err := profileSaveResultStructuralCheck(raw); err != nil {
				t.Fatalf("structural check rejected published output: %v (%s)", err, raw)
			}
			var decoded GolemProfileSaveResult
			if err := strictDecodeFixture(raw, &decoded); err != nil {
				t.Fatalf("strict decode rejected published output: %v (%s)", err, raw)
			}
			if err := validateGolemProfileSaveResult(decoded); err != nil {
				t.Fatalf("validator rejected published output: %v (%s)", err, raw)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Focused request-validation tests: the boundary rules the corpus states as
// verdicts, restated as behavior with an explicit expectation.
// ---------------------------------------------------------------------------

func applyRequestJSON(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "settings_apply_contract", name))
	if err != nil {
		t.Fatal(err)
	}
	var fixture applyFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture.Value
}

// TestApplyRequestRejectsUnknownFieldsThroughPlainUnmarshal proves the Wails
// decoding path (encoding/json with no test-only decoder options) rejects an
// unknown field. Without UnmarshalJSON on the request types, Wails would
// silently drop it.
func TestApplyRequestRejectsUnknownFieldsThroughPlainUnmarshal(t *testing.T) {
	cases := []string{
		"reject-apply-request-unknown-top-key.json",
		"reject-apply-request-unknown-change-key.json",
		"reject-apply-request-cross-variant-field.json",
		"reject-apply-request-source-unknown-key.json",
		"reject-apply-request-route-model-facts-unknown-key.json",
		"reject-apply-request-route-capability-facts-unknown-key.json",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			var req SettingsApplyRequest
			if err := json.Unmarshal(applyRequestJSON(t, name), &req); err == nil {
				t.Fatal("plain json.Unmarshal accepted an unknown field")
			}
		})
	}
}

// TestApplyRequestKeysNeverEscape locks the trust boundary from the other
// side: a decoded request holds key VALUES, and nothing that leaves the
// backend may carry them. Results are marshaled here to prove the result union
// has no member that could hold one.
func TestApplyRequestKeysNeverEscapeInResults(t *testing.T) {
	var req SettingsApplyRequest
	if err := json.Unmarshal(applyRequestJSON(t, "accept-apply-request-every-change-kind.json"), &req); err != nil {
		t.Fatal(err)
	}
	if req.Keys["hosted"] == "" {
		t.Fatalf("fixture no longer carries a key value: %+v", req.Keys)
	}
	results := []SettingsApplyResult{
		{Status: "busy"},
		{Status: "applied", Projection: &SettingsProjection{
			State: "ready", SourceOrigin: "user_config", Revision: testSettingsRevision,
			Editable: true, Routes: []RouteProjection{}, Models: []ModelProjection{},
			Providers: []ProviderProjection{}, Diagnostics: []Diagnostic{},
		}},
		{Status: "consent_required", Challenge: &ApplyChallenge{
			Token: "opaque", ExpiresAt: 1, Destinations: []ApplyDestination{{
				Provider: "hosted", Model: "wire-model",
				Endpoint: "https://api.example.com/v1", Classification: "remote",
				Provenance: []string{"agent"},
			}},
		}},
	}
	for i, result := range results {
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), req.Keys["hosted"]) ||
			strings.Contains(string(encoded), "sk-") {
			t.Fatalf("result %d leaks key material: %s", i, encoded)
		}
	}
}

func TestApplyRequestModeRules(t *testing.T) {
	base := func() SettingsApplyRequest {
		var req SettingsApplyRequest
		if err := json.Unmarshal(applyRequestJSON(t, "accept-apply-request-minimal.json"), &req); err != nil {
			t.Fatal(err)
		}
		return req
	}
	t.Run("apply requires a target revision", func(t *testing.T) {
		req := base()
		req.TargetRevision = nil
		if err := validateSettingsApplyRequest(req, applyModeExisting); err == nil {
			t.Fatal("apply accepted a request without targetRevision")
		}
	})
	t.Run("create forbids a target revision", func(t *testing.T) {
		req := base()
		req.Source = ApplySource{Kind: "blank"}
		if err := validateSettingsApplyRequest(req, applyModeCreate); err == nil {
			t.Fatal("create accepted a targetRevision")
		}
	})
	t.Run("create forbids the applied source", func(t *testing.T) {
		req := base()
		req.TargetRevision = nil
		if err := validateSettingsApplyRequest(req, applyModeCreate); err == nil {
			t.Fatal("create accepted source:applied")
		}
	})
}

// TestApplyRequestIdentifierByteBoundary: the bound is UTF-8 BYTES, so a
// multi-byte rune must be counted as its encoded length on both sides of the
// boundary. 128 two-byte runes are exactly at the limit; one more byte is over.
func TestApplyRequestIdentifierByteBoundary(t *testing.T) {
	if !validRequestIdentifier(strings.Repeat("é", 128)) {
		t.Fatal("256-byte identifier rejected")
	}
	if validRequestIdentifier(strings.Repeat("é", 128) + "a") {
		t.Fatal("257-byte identifier accepted")
	}
	if validRequestIdentifier(strings.Repeat("é", 129)) {
		t.Fatal("258-byte identifier accepted")
	}
}

func TestApplyRequestKeyValueRules(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "literal", value: "sk-literal", want: true},
		{name: "at limit", value: strings.Repeat("k", 4096), want: true},
		{name: "empty", value: ""},
		{name: "over limit", value: strings.Repeat("k", 4097)},
		{name: "interpolated", value: "${OPENAI_API_KEY}"},
		{name: "embedded interpolation", value: "prefix-${X}"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validKeyValue(tc.value); got != tc.want {
				t.Fatalf("validKeyValue(%d bytes) = %v, want %v", len(tc.value), got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Preparation pipeline (spec §5.2 Call 1). Every row runs against a REAL
// document loaded from a real file: the pipeline's whole job is to produce the
// exact document a later save would write, so a hand-built fake would prove
// nothing about upstream's mutation semantics. Every row also asserts the
// target file is byte-identical afterwards — preparation never writes.
// ---------------------------------------------------------------------------

// applyTargetConfigJSON is the shared write fixture.
//   - "shared" is routed by two use cases and carries the projection-hidden
//     slots + think_tags, so retargeting it must fork AND confirm both drops;
//   - "solo" is routed by one use case, so retargeting it stays in place;
//   - "pinned" is routed by one use case AND carries the hidden fields, the
//     one shape upstream has no drop gate for (SetRoleModel just clears them);
//   - "orphan" is unrouted and is the only reference to provider "spare",
//     so removing both proves removals run role-before-provider;
//   - "unused" is referenced by nothing and is removable on its own.
const applyTargetConfigJSON = `{
  "providers": {
    "ollama": {"base_url": "http://localhost:11434"},
    "remote": {"base_url": "https://api.example.com/v1", "api_format": "openai-compat",
               "api_key": "sk-live-secret", "timeout": "90s", "slot_discovery": true},
    "spare": {"base_url": "http://localhost:11500"},
    "unused": {"base_url": "http://localhost:11600"}
  },
  "models": {
    "shared": {"name": "shared-model", "provider": "remote", "type": "dense",
               "capabilities": ["chat", "stream", "tool_call"], "slots": 2,
               "think_mode": "toggle", "think_tags": {"open": "<a>", "close": "</a>"}},
    "solo": {"name": "solo-model", "provider": "ollama", "type": "dense",
             "capabilities": ["chat", "stream", "tool_call"]},
    "pinned": {"name": "pinned-model", "provider": "remote", "type": "dense",
               "capabilities": ["chat", "stream", "tool_call"], "slots": 3,
               "think_tags": {"open": "<b>", "close": "</b>"}},
    "orphan": {"name": "orphan-model", "provider": "spare", "type": "dense",
               "capabilities": ["chat", "stream"]}
  },
  "defaults": {"agent": "solo", "chat": "shared", "summarize": "shared", "verify": "pinned"}
}`

// stageApplyTarget makes body the active target and returns its path.
func stageApplyTarget(t *testing.T, body string) string {
	t.Helper()
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	path := writeAgentConfigBody(t, body)
	t.Setenv("GO_LLM_CONFIG", path)
	return path
}

// Profile fixtures. keyedProfileJSON carries all three authored api_key forms
// at once — a literal, a reference to an ambient-SET variable, and a reference
// to an ambient-UNSET one — because §5.3 promises every one of them is gone
// before the document is ever projected or applied.
const (
	profileSetEnvName    = "FIRN_PROFILE_SET_KEY"
	profileUnsetEnvName  = "FIRN_PROFILE_UNSET_KEY"
	profileAmbientSecret = "sk-ambient-secret"
	profileLiteralSecret = "sk-profile-literal"
)

const keyedProfileJSON = `{
  "providers": {
    "literal": {"base_url": "https://api.example.com/v1", "api_format": "openai-compat",
      "api_key": "sk-profile-literal"},
    "resolved": {"base_url": "https://api.example.net/v1", "api_format": "openai-compat",
      "api_key": "${FIRN_PROFILE_SET_KEY}"},
    "unset": {"base_url": "https://api.example.org/v1", "api_format": "openai-compat",
      "api_key": "${FIRN_PROFILE_UNSET_KEY}"},
    "local": {"base_url": "http://localhost:11434"}
  },
  "models": {"agent-m": {"name": "profile-model", "provider": "local", "type": "dense",
    "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`

// malformedRefProfileJSON has an unterminated reference: the sentinel resolves
// every syntactically valid NAME, and a malformed reference must still fail.
const malformedRefProfileJSON = `{
  "providers": {"broken": {"base_url": "https://api.example.com/v1", "api_key": "${OPEN"}},
  "models": {"agent-m": {"name": "m", "provider": "broken", "type": "dense",
    "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`

// unwritableProfileJSON adds an unreferenced provider whose name carries a
// bidi-format rune: go-llm runs the document, but Firn cannot represent that
// name as a writable Identifier. The draft is therefore limited, and an Apply
// from it is refused before any mutation by the same gate the active target
// faces (§5.2 — readOnly || !editable, recomputed on both).
var unwritableProfileJSON = strings.Replace(keyedProfileJSON,
	`"local": {"base_url": "http://localhost:11434"}`,
	`"local": {"base_url": "http://localhost:11434"},`+"\n    "+
		`"spa\u202ere": {"base_url": "http://localhost:11500"}`, 1)

// profileBodyRevision is the independent revision oracle: a Document's revision
// is the sha256 of the bytes it was loaded from, so the fixture body alone
// decides what a caller must send back as sourceRevision.
func profileBodyRevision(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

// userProfileStoreRoot is the go-llm store root under the sandboxed config
// environment — the same directory the profile loader resolves for itself.
func userProfileStoreRoot(t *testing.T) string {
	t.Helper()
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("user config dir: %v", err)
	}
	return filepath.Join(base, "go-llm")
}

// stageUserProfile writes body as the user profile "user/<slug>". The mode
// matters: the store refuses a group- or world-accessible profiles directory.
func stageUserProfile(t *testing.T, slug, body string) {
	t.Helper()
	dir := filepath.Join(userProfileStoreRoot(t), "profiles")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("stage profile dir: %v", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("stage profile dir mode: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, slug+".json"), []byte(body), 0o600); err != nil {
		t.Fatalf("stage profile: %v", err)
	}
}

// assertNoCredentialLeak marshals a boundary value and scans it for every
// string the profile path must never emit: the loader's own sentinel, either
// fixture secret, both environment variable NAMES, and the authored member
// that carries a key at all.
func assertNoCredentialLeak(t *testing.T, what string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s: %v", what, err)
	}
	for _, forbidden := range []string{
		profileEnvSentinel, profileAmbientSecret, profileLiteralSecret,
		profileSetEnvName, profileUnsetEnvName, "api_key", "${",
	} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("%s carries %q: %s", what, forbidden, raw)
		}
	}
}

func stagedTargetRevision(t *testing.T) string {
	t.Helper()
	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("stage target: %v", err)
	}
	return loaded.Revision
}

// canonicalCaps orders capability names the way the request contract requires.
func canonicalCaps(names ...string) []string { return canonicalizeCapabilities(names) }

// routeChange builds a valid route change with the model facts of a dense
// model and matching capability facts; rows override what they exercise.
func routeChange(useCase, providerName, modelName string, caps ...string) Change {
	ordered := canonicalCaps(caps...)
	return Change{
		Kind: changeKindRoute, UseCase: useCase,
		ModelFacts:      &ModelFacts{Provider: providerName, Model: modelName, Type: "dense"},
		CapabilityFacts: &CapabilityFacts{Caps: ordered, KnownCaps: append([]string{}, provider.CanonicalCapabilityNames...)},
		ExposedCaps:     ordered,
	}
}

// confirmUnknown marks a route change as acknowledging the use cases Firn has
// no capability floor for.
func confirmUnknown(change Change, useCases ...string) Change {
	change.ConfirmUnknown = true
	change.ConfirmUnknownUseCases = append([]string{}, useCases...)
	slices.Sort(change.ConfirmUnknownUseCases)
	return change
}

func stringPtr(value string) *string { return &value }

// readTargetBytes reports the target file's content and whether it exists at
// all, so a row that deletes the target can still assert nothing was written.
func readTargetBytes(t *testing.T, path string) ([]byte, bool) {
	t.Helper()
	if path == "" {
		return nil, false
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, false
	}
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	return raw, true
}

type prepareCase struct {
	name     string
	document string // "" => applyTargetConfigJSON
	create   bool
	revision *string // "" => the staged target's own revision
	source   *ApplySource
	changes  []Change
	keys     map[string]string
	// profile, when set, is staged as the user profile "user/staged". A
	// profile-source row that leaves SourceRevision empty gets the staged
	// body's real revision; a row proving the CAS check sets its own.
	profile string
	// disturb runs after the draft's revision is captured and before prepare:
	// it is how a row makes the target move under the request.
	disturb          func(t *testing.T, path string)
	wantStatus       string // "" => prepared, no result
	wantConflict     string
	wantCodes        []string
	wantDrops        []ChangeDropSet
	wantNoProjection bool
	check            func(t *testing.T, cfg *config.Config)
}

func runPrepareCase(t *testing.T, tc prepareCase) {
	t.Helper()
	body := tc.document
	if body == "" {
		body = applyTargetConfigJSON
	}
	mode, revision, path := applyModeExisting, tc.revision, ""
	if tc.create {
		mode = applyModeCreate
		sandboxAgentConfigEnv(t)
		t.Chdir(t.TempDir())
	} else {
		path = stageApplyTarget(t, body)
		if revision == nil {
			revision = stringPtr(stagedTargetRevision(t))
		}
	}
	if tc.profile != "" {
		stageUserProfile(t, "staged", tc.profile)
	}
	if tc.disturb != nil {
		tc.disturb(t, path)
	}
	before, hadTarget := readTargetBytes(t, path)

	source := ApplySource{Kind: applySourceApplied}
	if tc.source != nil {
		source = *tc.source
	}
	if source.Kind == applySourceProfile && source.SourceRevision == "" {
		source.SourceRevision = profileBodyRevision(tc.profile)
	}
	keys := tc.keys
	if keys == nil {
		keys = map[string]string{}
	}
	prepared, result := prepareSettingsApply(context.Background(), SettingsApplyRequest{
		TargetRevision: revision, Source: source, Changes: tc.changes, Keys: keys,
	}, mode)

	if after, stillThere := readTargetBytes(t, path); stillThere != hadTarget || !bytes.Equal(before, after) {
		t.Fatal("preparation wrote to the target file")
	}

	if tc.wantStatus == "" {
		if result != nil {
			t.Fatalf("prepare refused: %+v", *result)
		}
		if prepared == nil || prepared.doc == nil {
			t.Fatal("prepare returned no document")
		}
		if tc.check != nil {
			tc.check(t, prepared.doc.Config())
		}
		return
	}
	if prepared != nil {
		t.Fatalf("prepare returned a document when it must return %q", tc.wantStatus)
	}
	if result == nil {
		t.Fatalf("prepare accepted a request that must return %q", tc.wantStatus)
	}
	if err := validateSettingsApplyResult(*result); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, *result)
	}
	if result.Status != tc.wantStatus {
		t.Fatalf("status = %q, want %q (%+v)", result.Status, tc.wantStatus, *result)
	}
	if tc.wantCodes != nil {
		codes := make([]string, 0, len(result.Diagnostics))
		for _, d := range result.Diagnostics {
			codes = append(codes, d.Code)
		}
		if !slices.Equal(codes, tc.wantCodes) {
			t.Fatalf("diagnostic codes = %v, want %v", codes, tc.wantCodes)
		}
	}
	if tc.wantDrops != nil {
		if len(result.Drops) != len(tc.wantDrops) {
			t.Fatalf("drops = %+v, want %+v", result.Drops, tc.wantDrops)
		}
		for i, want := range tc.wantDrops {
			got := result.Drops[i]
			if got.ChangeID != want.ChangeID || !slices.Equal(got.Fields, want.Fields) {
				t.Fatalf("drops[%d] = %+v, want %+v", i, got, want)
			}
		}
	}
	if tc.wantConflict != "" && result.Conflict != tc.wantConflict {
		t.Fatalf("conflict = %q, want %q (%+v)", result.Conflict, tc.wantConflict, *result)
	}
	// A conflict may carry a projection only when the target reloaded safely.
	if tc.wantNoProjection && result.Projection != nil {
		t.Fatalf("result carries a projection for a target that was not safely reloaded: %+v", *result)
	}
}

func TestPrepareSettingsApply(t *testing.T) {
	cases := []prepareCase{
		{
			name:    "provider add",
			changes: []Change{{Kind: changeKindProviderAdd, Name: "extra", Endpoint: stringPtr("http://localhost:11700")}},
			check: func(t *testing.T, cfg *config.Config) {
				if got := cfg.Providers["extra"].BaseURL; got != "http://localhost:11700" {
					t.Fatalf("added provider base url = %q", got)
				}
			},
		},
		{
			// UpdateProvider replaces the whole authored value, so an endpoint
			// edit that did not start from AuthoredProvider would silently drop
			// the format, the timeout, and the stored key.
			name: "provider update overlays the authored value",
			changes: []Change{{Kind: changeKindProviderUpdate, Name: "remote",
				Endpoint: stringPtr("https://api2.example.com/v1")}},
			check: func(t *testing.T, cfg *config.Config) {
				p := cfg.Providers["remote"]
				if p.BaseURL != "https://api2.example.com/v1" || p.APIFormat != "openai-compat" ||
					p.APIKey != "sk-live-secret" || p.Timeout.Duration != 90*time.Second {
					t.Fatalf("updated provider = %+v", p)
				}
			},
		},
		{
			name:    "provider remove",
			changes: []Change{{Kind: changeKindProviderRemove, Name: "unused"}},
			check: func(t *testing.T, cfg *config.Config) {
				if _, ok := cfg.Providers["unused"]; ok {
					t.Fatal("removed provider still present")
				}
			},
		},
		{
			name:    "literal key set",
			changes: []Change{{Kind: changeKindProviderKeySet, Name: "ollama"}},
			keys:    map[string]string{"ollama": "sk-new-value"},
			check: func(t *testing.T, cfg *config.Config) {
				if got := cfg.Providers["ollama"].APIKey; got != "sk-new-value" {
					t.Fatalf("provider key = %q", got)
				}
			},
		},
		{
			name:    "key clear",
			changes: []Change{{Kind: changeKindProviderKeyClear, Name: "remote"}},
			check: func(t *testing.T, cfg *config.Config) {
				if got := cfg.Providers["remote"].APIKey; got != "" {
					t.Fatalf("cleared provider key = %q", got)
				}
			},
		},
		{
			// "solo" serves only the agent route, so the retarget stays in the
			// same role and creates nothing.
			name:    "unique-role retarget",
			changes: []Change{routeChange("agent", "remote", "other-model", "chat", "stream", "tool_call")},
			check: func(t *testing.T, cfg *config.Config) {
				if cfg.Defaults["agent"] != "solo" || len(cfg.Models) != 4 {
					t.Fatalf("defaults/models = %v / %d roles", cfg.Defaults, len(cfg.Models))
				}
				m := cfg.Models["solo"]
				if m.Name != "other-model" || m.Provider != "remote" {
					t.Fatalf("retargeted role = %+v", m)
				}
			},
		},
		{
			// "shared" also serves summarize, so retargeting chat must fork the
			// complete authored role and leave the sibling route untouched.
			name: "shared-role fork",
			changes: []Change{func() Change {
				c := confirmUnknown(routeChange("chat", "ollama", "fork-model", "chat", "stream"), "summarize")
				c.ConfirmDrops = []string{dropFieldSlots, dropFieldThinkTags}
				return c
			}()},
			check: func(t *testing.T, cfg *config.Config) {
				if cfg.Defaults["chat"] != "chat-m" || cfg.Defaults["summarize"] != "shared" {
					t.Fatalf("defaults = %v", cfg.Defaults)
				}
				forked := cfg.Models["chat-m"]
				if forked.Name != "fork-model" || forked.Provider != "ollama" ||
					forked.ThinkTags != nil || forked.Slots != 0 {
					t.Fatalf("forked role = %+v", forked)
				}
				source := cfg.Models["shared"]
				if source.Name != "shared-model" || source.ThinkTags == nil || source.Slots != 2 {
					t.Fatalf("source role changed: %+v", source)
				}
			},
		},
		{
			name: "new-role assignment",
			changes: []Change{confirmUnknown(
				routeChange("vision", "ollama", "vision-model", "chat", "stream"), "vision")},
			check: func(t *testing.T, cfg *config.Config) {
				if cfg.Defaults["vision"] != "vision-m" || cfg.Models["vision-m"].Name != "vision-model" {
					t.Fatalf("defaults = %v, models = %v", cfg.Defaults, cfg.Models)
				}
			},
		},
		{
			// planning is a Firn capability floor (tool-bearing), unlike vision
			// above: routing it needs no confirmUnknown at all.
			name:    "planning route satisfies the floor",
			changes: []Change{routeChange("planning", "ollama", "planning-model", "chat", "stream", "tool_call")},
			check: func(t *testing.T, cfg *config.Config) {
				if cfg.Defaults["planning"] != "planning-m" || cfg.Models["planning-m"].Name != "planning-model" {
					t.Fatalf("defaults = %v, models = %v", cfg.Defaults, cfg.Models)
				}
			},
		},
		{
			// The planning floor requires tool_call; carving it off is refused
			// before any mutation, same as the agent/chat floor rejections.
			name:       "planning route below the floor is refused",
			changes:    []Change{routeChange("planning", "ollama", "planning-model", "chat", "stream")},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeEligibilityIneligible},
		},
		{
			// Firn derives the affected defaults outside its floor table; a
			// request that does not confirm exactly that set is stale.
			name:       "unknown use case not confirmed",
			changes:    []Change{routeChange("vision", "ollama", "vision-model", "chat", "stream")},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeEligibilityUnknown},
		},
		{
			name: "unknown use-case confirmation must be exact",
			changes: []Change{confirmUnknown(
				routeChange("vision", "ollama", "vision-model", "chat", "stream"), "summarize", "vision")},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeEligibilityUnknown},
		},
		{
			// A real retarget drops the source role's projection-hidden fields;
			// without the exact confirmation nothing may mutate.
			name:       "drop confirmation required",
			changes:    []Change{confirmUnknown(routeChange("chat", "ollama", "fork-model", "chat", "stream"), "summarize")},
			wantStatus: "drop_confirmation_required",
			wantDrops: []ChangeDropSet{{ChangeID: identityRoute + ":chat",
				Fields: []string{dropFieldSlots, dropFieldThinkTags}}},
		},
		{
			name: "partial drop confirmation is refused",
			changes: []Change{func() Change {
				c := confirmUnknown(routeChange("chat", "ollama", "fork-model", "chat", "stream"), "summarize")
				c.ConfirmDrops = []string{dropFieldThinkTags}
				return c
			}()},
			wantStatus: "drop_confirmation_required",
			wantDrops: []ChangeDropSet{{ChangeID: identityRoute + ":chat",
				Fields: []string{dropFieldSlots, dropFieldThinkTags}}},
		},
		{
			// A unique-role retarget has no upstream drop gate at all —
			// SetRoleModel simply clears the omitted fields — so Firn's own
			// pre-check is the only thing between the user and the loss.
			name:       "unique-role retarget still requires the drop confirmation",
			changes:    []Change{confirmUnknown(routeChange("verify", "ollama", "verify-model", "chat", "stream"), "verify")},
			wantStatus: "drop_confirmation_required",
			wantDrops: []ChangeDropSet{{ChangeID: identityRoute + ":verify",
				Fields: []string{dropFieldSlots, dropFieldThinkTags}}},
		},
		{
			name: "unique-role retarget with the exact drops",
			changes: []Change{func() Change {
				c := confirmUnknown(routeChange("verify", "ollama", "verify-model", "chat", "stream"), "verify")
				c.ConfirmDrops = []string{dropFieldSlots, dropFieldThinkTags}
				return c
			}()},
			check: func(t *testing.T, cfg *config.Config) {
				m := cfg.Models["pinned"]
				if cfg.Defaults["verify"] != "pinned" || m.Name != "verify-model" ||
					m.Slots != 0 || m.ThinkTags != nil {
					t.Fatalf("retargeted role = %+v (defaults %v)", m, cfg.Defaults)
				}
			},
		},
		{
			// Nothing is dropped, so a stale confirmation cannot be expressed
			// as a drop set and the request is simply invalid.
			name: "drop confirmation without a drop",
			changes: []Change{func() Change {
				c := routeChange("agent", "remote", "other-model", "chat", "stream", "tool_call")
				c.ConfirmDrops = []string{dropFieldThinkTags}
				return c
			}()},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeInvalidArgument},
		},
		{
			// Both use cases keep the selector and only change the exposed
			// contract, so exactly one selector-wide override runs and the
			// projection-hidden fields survive (SetRoleModel would clear them).
			name: "selector override coalescing",
			changes: []Change{
				func() Change {
					c := confirmUnknown(routeChange("chat", "remote", "shared-model", "chat", "stream"), "summarize")
					c.ThinkMode = "none"
					return c
				}(),
				func() Change {
					c := confirmUnknown(routeChange("summarize", "remote", "shared-model", "chat", "stream"), "summarize")
					c.ThinkMode = "none"
					return c
				}(),
			},
			check: func(t *testing.T, cfg *config.Config) {
				m := cfg.Models["shared"]
				if !slices.Equal(m.Capabilities, []string{"chat", "stream"}) || m.ThinkMode != "none" {
					t.Fatalf("override = %+v", m)
				}
				if m.ThinkTags == nil || m.Slots != 2 {
					t.Fatalf("override cleared hidden fields: %+v", m)
				}
				if cfg.Defaults["chat"] != "shared" || cfg.Defaults["summarize"] != "shared" {
					t.Fatalf("defaults = %v", cfg.Defaults)
				}
			},
		},
		{
			name: "selector-scoped fields must agree",
			changes: []Change{
				confirmUnknown(routeChange("chat", "remote", "shared-model", "chat", "stream"), "summarize"),
				confirmUnknown(routeChange("summarize", "remote", "shared-model", "chat", "stream", "tool_call"), "summarize"),
			},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeSelectorConflict},
		},
		{
			// The chat floor is chat+stream; carving stream off breaks a live
			// route and must be refused before any mutation.
			name: "floor rejection",
			changes: []Change{
				confirmUnknown(routeChange("chat", "remote", "shared-model", "chat"), "summarize"),
				confirmUnknown(routeChange("summarize", "remote", "shared-model", "chat"), "summarize"),
			},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeEligibilityIneligible},
		},
		{
			name: "unassign then guarded remove",
			changes: []Change{
				{Kind: changeKindRouteUnassign, UseCase: "chat"},
				{Kind: changeKindRouteUnassign, UseCase: "summarize"},
				{Kind: changeKindRoleRemove, Role: "shared"},
			},
			check: func(t *testing.T, cfg *config.Config) {
				if _, ok := cfg.Defaults["chat"]; ok {
					t.Fatal("chat is still routed")
				}
				if _, ok := cfg.Models["shared"]; ok {
					t.Fatal("removed role still present")
				}
			},
		},
		{
			name:       "role removal stays guarded",
			changes:    []Change{{Kind: changeKindRoleRemove, Role: "shared"}},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeInvalidArgument},
		},
		{
			name:       "unassigning an unbound use case is refused",
			changes:    []Change{{Kind: changeKindRouteUnassign, UseCase: "vision"}},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeRoleNotFound},
		},
		{
			name:       "duplicate provider target",
			changes:    []Change{{Kind: changeKindProviderAdd, Name: "ollama", Endpoint: stringPtr("http://localhost:11434")}},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeProviderExists},
		},
		{
			// Removals run role-before-provider and additions run
			// provider-before-role: staged in the exact reverse order, the
			// request still applies.
			name: "mutation ordering",
			changes: []Change{
				{Kind: changeKindProviderRemove, Name: "spare"},
				{Kind: changeKindRoleRemove, Role: "orphan"},
				{Kind: changeKindProviderKeySet, Name: "extra"},
				confirmUnknown(routeChange("vision", "extra", "vision-model", "chat", "stream"), "vision"),
				{Kind: changeKindProviderAdd, Name: "extra", Endpoint: stringPtr("http://localhost:11700")},
			},
			keys: map[string]string{"extra": "sk-extra"},
			check: func(t *testing.T, cfg *config.Config) {
				if _, ok := cfg.Providers["spare"]; ok {
					t.Fatal("spare provider survived")
				}
				if _, ok := cfg.Models["orphan"]; ok {
					t.Fatal("orphan role survived")
				}
				if cfg.Providers["extra"].APIKey != "sk-extra" || cfg.Defaults["vision"] != "vision-m" {
					t.Fatalf("providers = %v, defaults = %v", cfg.Providers, cfg.Defaults)
				}
			},
		},
		{
			name:       "stale target revision",
			revision:   stringPtr(strings.Repeat("a", 64)),
			changes:    []Change{{Kind: changeKindProviderRemove, Name: "unused"}},
			wantStatus: "conflict",
		},
		{
			name:       "read-only target",
			document:   duplicateProviderDocumentJSON,
			changes:    []Change{{Kind: changeKindProviderAdd, Name: "extra", Endpoint: stringPtr("http://localhost:11700")}},
			wantStatus: "limited",
			wantCodes:  []string{codeDuplicateKeys},
		},
		{
			// A bidi-format rune in a role key: go-llm still runs this
			// document, but Firn cannot represent it as a writable Identifier.
			name: "target with an unwritable identifier",
			document: strings.Replace(applyTargetConfigJSON, `"orphan": {`,
				`"orph\u202ean": {`, 1),
			changes:    []Change{{Kind: changeKindProviderAdd, Name: "extra", Endpoint: stringPtr("http://localhost:11700")}},
			wantStatus: "limited",
			wantCodes:  []string{codeIdentifierNotEditable},
		},
		{
			// §5.6: a post-mutation document over a projection bound returns
			// limited before consent/save — the same status the load-time
			// bound check returns.
			name:       "post-mutation projection overflow",
			document:   manyProviderConfigJSON(maxProjectionEntries),
			changes:    []Change{{Kind: changeKindProviderAdd, Name: "extra", Endpoint: stringPtr("http://localhost:11700")}},
			wantStatus: "limited",
			wantCodes:  []string{codeProjectionLimited},
		},
		{
			// The target parsed when the draft was built and does not now:
			// there is nothing to reconcile against, so it is not a conflict.
			name:    "target became unreadable",
			changes: []Change{{Kind: changeKindProviderRemove, Name: "unused"}},
			disturb: func(t *testing.T, path string) {
				if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeConfigInvalid},
		},
		{
			name:    "target disappeared",
			changes: []Change{{Kind: changeKindProviderRemove, Name: "unused"}},
			disturb: func(t *testing.T, path string) {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus:       "conflict",
			wantNoProjection: true,
		},
		{
			// §4.3 never offers Unassign for the agent route and §5.2 makes the
			// backend enforce that independently of the reducer.
			name:       "the agent route cannot be unassigned",
			changes:    []Change{{Kind: changeKindRouteUnassign, UseCase: "agent"}},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeAgentRoleMissing},
		},
		{
			// §3.3 scopes the confirmation to the SELECTOR: two floorless use
			// cases staged onto one model share one required set, and a
			// per-use-case set would make the request unsatisfiable.
			name: "two floorless use cases on one selector",
			changes: []Change{
				confirmUnknown(routeChange("vision", "ollama", "multi-model", "chat", "stream"), "audio", "vision"),
				confirmUnknown(routeChange("audio", "ollama", "multi-model", "chat", "stream"), "audio", "vision"),
			},
			check: func(t *testing.T, cfg *config.Config) {
				vision, audio := cfg.Defaults["vision"], cfg.Defaults["audio"]
				if vision != "vision-m" || audio != "audio-m" {
					t.Fatalf("defaults = %v", cfg.Defaults)
				}
				if cfg.Models[vision].Name != "multi-model" || cfg.Models[audio].Name != "multi-model" {
					t.Fatalf("models = %v", cfg.Models)
				}
			},
		},
		{
			name: "per-use-case confirmation on a shared selector is refused",
			changes: []Change{
				confirmUnknown(routeChange("vision", "ollama", "multi-model", "chat", "stream"), "vision"),
				confirmUnknown(routeChange("audio", "ollama", "multi-model", "chat", "stream"), "audio"),
			},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeEligibilityUnknown},
		},
		{
			// The prepared document is the PROFILE's, scrubbed of every key
			// form — the active target supplies only the write identity.
			name:    "profile source replaces the document credential-free",
			profile: keyedProfileJSON,
			source:  &ApplySource{Kind: applySourceProfile, ProfileID: "user/staged"},
			changes: []Change{{Kind: changeKindProviderRemove, Name: "unset"}},
			check: func(t *testing.T, cfg *config.Config) {
				if _, ok := cfg.Providers["remote"]; ok {
					t.Fatalf("the active target leaked into the source: %v", cfg.Providers)
				}
				if _, ok := cfg.Providers["unset"]; ok {
					t.Fatal("staged provider removal did not run against the profile")
				}
				if cfg.Defaults["agent"] != "agent-m" || cfg.Models["agent-m"].Name != "profile-model" {
					t.Fatalf("defaults = %v, models = %v", cfg.Defaults, cfg.Models)
				}
				for name, p := range cfg.Providers {
					if p.APIKey != "" {
						t.Fatalf("provider %q kept a credential", name)
					}
				}
			},
		},
		{
			name:    "stale profile source revision",
			profile: keyedProfileJSON,
			source: &ApplySource{Kind: applySourceProfile, ProfileID: "user/staged",
				SourceRevision: strings.Repeat("b", 64)},
			changes:          []Change{{Kind: changeKindProviderRemove, Name: "unset"}},
			wantStatus:       "conflict",
			wantConflict:     "profile_source",
			wantNoProjection: true,
		},
		{
			name: "missing profile source",
			source: &ApplySource{Kind: applySourceProfile, ProfileID: "user/absent",
				SourceRevision: strings.Repeat("c", 64)},
			changes:          []Change{{Kind: changeKindProviderRemove, Name: "unset"}},
			wantStatus:       "conflict",
			wantConflict:     "profile_source",
			wantNoProjection: true,
		},
		{
			name:       "invalid profile content",
			profile:    `{"providers": {}}`,
			source:     &ApplySource{Kind: applySourceProfile, ProfileID: "user/staged"},
			changes:    []Change{{Kind: changeKindProviderRemove, Name: "unset"}},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeConfigInvalid},
		},
		{
			// A duplicate-key profile loads but refuses every mutation, and the
			// scrub is the first mutation an Apply owes it.
			name:       "read-only profile source",
			profile:    duplicateProviderDocumentJSON,
			source:     &ApplySource{Kind: applySourceProfile, ProfileID: "user/staged"},
			changes:    []Change{{Kind: changeKindProviderRemove, Name: "unused"}},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeConfigInvalid},
		},
		{
			name:       "malformed key reference in a profile source",
			profile:    malformedRefProfileJSON,
			source:     &ApplySource{Kind: applySourceProfile, ProfileID: "user/staged"},
			changes:    []Change{{Kind: changeKindProviderAdd, Name: "extra", Endpoint: stringPtr("http://localhost:11700")}},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeConfigInvalid},
		},
		{
			// The source faces the write gate too: a UI that offered this
			// profile anyway is refused before the first mutation.
			name:       "profile source with an unwritable identifier",
			profile:    unwritableProfileJSON,
			source:     &ApplySource{Kind: applySourceProfile, ProfileID: "user/staged"},
			changes:    []Change{{Kind: changeKindProviderRemove, Name: "unset"}},
			wantStatus: "limited",
			wantCodes:  []string{codeIdentifierNotEditable},
		},
		{
			name:   "blank create seeds one provider and the agent route",
			create: true,
			source: &ApplySource{Kind: applySourceBlank},
			changes: []Change{
				{Kind: changeKindProviderAdd, Name: "ollama", Endpoint: stringPtr("http://localhost:11434")},
				routeChange("agent", "ollama", "seed-model", "chat", "stream", "tool_call"),
			},
			check: func(t *testing.T, cfg *config.Config) {
				if len(cfg.Providers) != 1 || cfg.Providers["ollama"].BaseURL != "http://localhost:11434" {
					t.Fatalf("providers = %v", cfg.Providers)
				}
				if cfg.Defaults["agent"] != "agent-m" || cfg.Models["agent-m"].Name != "seed-model" {
					t.Fatalf("defaults = %v, models = %v", cfg.Defaults, cfg.Models)
				}
			},
		},
		{
			// The two seed changes are consumed by the bootstrap; every other
			// change still runs exactly once, in the normal order.
			name:   "blank create applies the remaining changes once",
			create: true,
			source: &ApplySource{Kind: applySourceBlank},
			changes: []Change{
				{Kind: changeKindProviderAdd, Name: "ollama", Endpoint: stringPtr("http://localhost:11434")},
				{Kind: changeKindProviderAdd, Name: "second", Endpoint: stringPtr("https://api.example.com/v1")},
				{Kind: changeKindProviderKeySet, Name: "second"},
				routeChange("agent", "ollama", "seed-model", "chat", "stream", "tool_call"),
			},
			keys: map[string]string{"second": "sk-second"},
			check: func(t *testing.T, cfg *config.Config) {
				if len(cfg.Providers) != 2 || cfg.Providers["second"].APIKey != "sk-second" {
					t.Fatalf("providers = %v", cfg.Providers)
				}
				if len(cfg.Models) != 1 || cfg.Defaults["agent"] != "agent-m" {
					t.Fatalf("models = %v, defaults = %v", cfg.Models, cfg.Defaults)
				}
			},
		},
		{
			name:   "blank create without an agent route",
			create: true,
			source: &ApplySource{Kind: applySourceBlank},
			changes: []Change{
				{Kind: changeKindProviderAdd, Name: "ollama", Endpoint: stringPtr("http://localhost:11434")},
				confirmUnknown(routeChange("vision", "ollama", "seed-model", "chat", "stream"), "vision"),
			},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeAgentRoleMissing},
		},
		{
			name:       "blank create without the seed provider",
			create:     true,
			source:     &ApplySource{Kind: applySourceBlank},
			changes:    []Change{routeChange("agent", "ollama", "seed-model", "chat", "stream", "tool_call")},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeProviderNotFound},
		},
		{
			// NewDocument guarantees schema validity only; the agent floor is
			// Firn's and is checked on the finished document.
			name:   "blank create floor rejection",
			create: true,
			source: &ApplySource{Kind: applySourceBlank},
			changes: []Change{
				{Kind: changeKindProviderAdd, Name: "ollama", Endpoint: stringPtr("http://localhost:11434")},
				routeChange("agent", "ollama", "seed-model", "chat", "stream"),
			},
			wantStatus: "diagnostics",
			wantCodes:  []string{codeEligibilityIneligible},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { runPrepareCase(t, tc) })
	}
}

// manyProviderConfigJSON builds a document with count providers — the exact
// projection ceiling, so one more provider overflows it.
func manyProviderConfigJSON(count int) string {
	var b strings.Builder
	b.WriteString(`{"providers": {"ollama": {"base_url": "http://localhost:11434"}`)
	for i := 1; i < count; i++ {
		fmt.Fprintf(&b, `, "p%03d": {"base_url": "http://localhost:%d"}`, i, 12000+i)
	}
	b.WriteString(`}, "models": {"agent-m": {"name": "m", "provider": "ollama", "type": "dense",` +
		` "capabilities": ["chat", "stream", "tool_call"]}}, "defaults": {"agent": "agent-m"}}`)
	return b.String()
}

// profileSourceRequest is one profile-origin Apply against the staged target.
func profileSourceRequest(targetRevision, sourceRevision string, changes []Change,
	keys map[string]string) SettingsApplyRequest {
	if keys == nil {
		keys = map[string]string{}
	}
	// nil here means "zero staged changes", which the wire contract spells as
	// an explicit empty array — a nil Changes is a MISSING member and refused.
	if changes == nil {
		changes = []Change{}
	}
	return SettingsApplyRequest{
		TargetRevision: stringPtr(targetRevision),
		Source: ApplySource{Kind: applySourceProfile, ProfileID: "user/staged",
			SourceRevision: sourceRevision},
		Changes: changes, Keys: keys,
	}
}

// TestPrepareProfileSourceRevisionsAreIndependent: §5.3 keeps the active
// target's CAS token and the profile source's separate. Neither is accepted in
// the other's slot, and the conflict names the document that actually moved.
func TestPrepareProfileSourceRevisionsAreIndependent(t *testing.T) {
	stageApplyTarget(t, applyTargetConfigJSON)
	targetRevision := stagedTargetRevision(t)
	stageUserProfile(t, "staged", keyedProfileJSON)
	sourceRevision := profileBodyRevision(keyedProfileJSON)
	if targetRevision == sourceRevision {
		t.Fatal("fixture: the two documents must have different revisions")
	}
	changes := []Change{{Kind: changeKindProviderRemove, Name: "unset"}}

	cases := []struct {
		name             string
		target, source   string
		wantConflict     string
		wantNoProjection bool
	}{
		{name: "each token in its own slot", target: targetRevision, source: sourceRevision},
		{
			name:   "the source token does not satisfy the target",
			target: sourceRevision, source: sourceRevision, wantConflict: "target",
		},
		{
			name:   "the target token does not satisfy the source",
			target: targetRevision, source: targetRevision, wantConflict: "profile_source",
			wantNoProjection: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prepared, result := prepareSettingsApply(context.Background(),
				profileSourceRequest(tc.target, tc.source, changes, nil), applyModeExisting)
			if tc.wantConflict == "" {
				if result != nil {
					t.Fatalf("prepare refused a matching pair: %+v", *result)
				}
				if prepared == nil || prepared.target.revision != targetRevision {
					t.Fatalf("prepared target = %+v", prepared)
				}
				return
			}
			if prepared != nil {
				t.Fatal("a conflicted request must not produce a document")
			}
			if result == nil {
				t.Fatal("prepare accepted a mismatched revision")
			}
			if err := validateSettingsApplyResult(*result); err != nil {
				t.Fatalf("result is not contract-valid: %v (%+v)", err, *result)
			}
			if result.Status != "conflict" || result.Conflict != tc.wantConflict {
				t.Fatalf("result = %+v, want conflict %q", *result, tc.wantConflict)
			}
			if tc.wantNoProjection && result.Projection != nil {
				t.Fatalf("profile-source conflict carries an active-target projection: %+v", *result)
			}
			assertNoCredentialLeak(t, "conflict result", *result)
		})
	}
}

// TestPrepareProfileApplyClearsCredentialsUnlessReplaced is the §5.3 hard rule
// in both directions: a profile Apply erases every active credential, and the
// only key that survives is one the SAME request restages literally. The
// assertion runs on the bytes an Apply would publish, not just the effective
// view, because the authored document is what reaches disk.
func TestPrepareProfileApplyClearsCredentialsUnlessReplaced(t *testing.T) {
	stageApplyTarget(t, applyTargetConfigJSON)
	targetRevision := stagedTargetRevision(t)
	t.Setenv(profileSetEnvName, profileAmbientSecret)
	unsetenv(t, profileUnsetEnvName)
	stageUserProfile(t, "staged", keyedProfileJSON)

	const replacement = "sk-restaged-literal"
	prepared, result := prepareSettingsApply(context.Background(), profileSourceRequest(
		targetRevision, profileBodyRevision(keyedProfileJSON),
		[]Change{{Kind: changeKindProviderKeySet, Name: "literal"}},
		map[string]string{"literal": replacement}), applyModeExisting)
	if result != nil {
		t.Fatalf("prepare refused: %+v", *result)
	}
	cfg := prepared.doc.Config()
	if got := cfg.Providers["literal"].APIKey; got != replacement {
		t.Fatalf("restaged key = %q, want the request's literal", got)
	}
	for _, name := range []string{"resolved", "unset", "local"} {
		if got := cfg.Providers[name].APIKey; got != "" {
			t.Fatalf("provider %q kept a credential (%d bytes) the request did not restage", name, len(got))
		}
	}

	published := filepath.Join(t.TempDir(), "models.json")
	if err := prepared.doc.SaveNew(published); err != nil {
		t.Fatalf("publish prepared document: %v", err)
	}
	raw, err := os.ReadFile(published)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		profileEnvSentinel, profileAmbientSecret, profileLiteralSecret,
		profileSetEnvName, profileUnsetEnvName, "${",
	} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("published bytes carry %q:\n%s", forbidden, raw)
		}
	}
	if strings.Count(string(raw), "api_key") != 1 || !strings.Contains(string(raw), replacement) {
		t.Fatalf("published bytes must carry exactly the restaged key:\n%s", raw)
	}
}

// TestPrepareProfileSourceWithNoChangesPublishesTheScrubbedProfile: the whole
// curated bootstrap. A profile source with ZERO staged changes is a well-formed
// write — the loaded, scrubbed document is the change — so the pipeline must
// carry it end to end: the source loads, the credential scrub runs, the floor
// and projection-bound checks run on the result, and the published bytes are
// the profile with every key form gone.
func TestPrepareProfileSourceWithNoChangesPublishesTheScrubbedProfile(t *testing.T) {
	stageApplyTarget(t, applyTargetConfigJSON)
	targetRevision := stagedTargetRevision(t)
	t.Setenv(profileSetEnvName, profileAmbientSecret)
	unsetenv(t, profileUnsetEnvName)
	stageUserProfile(t, "staged", keyedProfileJSON)

	prepared, result := prepareSettingsApply(context.Background(), profileSourceRequest(
		targetRevision, profileBodyRevision(keyedProfileJSON), nil, nil), applyModeExisting)
	if result != nil {
		t.Fatalf("a zero-change profile apply is a write, not a refusal: %+v", *result)
	}
	cfg := prepared.doc.Config()
	// The profile's own shape survived: this is the profile document, not the
	// active target it replaces.
	if _, ok := cfg.Providers["literal"]; !ok {
		t.Fatalf("prepared document is not the profile: providers = %v", cfg.Providers)
	}
	for name, p := range cfg.Providers {
		if p.APIKey != "" {
			t.Fatalf("provider %q kept a credential (%d bytes) through a zero-change apply", name, len(p.APIKey))
		}
	}

	published := filepath.Join(t.TempDir(), "models.json")
	if err := prepared.doc.SaveNew(published); err != nil {
		t.Fatalf("publish prepared document: %v", err)
	}
	raw, err := os.ReadFile(published)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		profileEnvSentinel, profileAmbientSecret, profileLiteralSecret,
		profileSetEnvName, profileUnsetEnvName, "api_key", "${",
	} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("published bytes carry %q:\n%s", forbidden, raw)
		}
	}
}

func TestPrepareSettingsApplyRejectsZeroChangeProfileWithoutRunnableAgent(t *testing.T) {
	tests := []struct {
		name     string
		profile  string
		wantCode string
	}{
		{
			name: "missing agent route",
			profile: `{
  "providers": {"local": {"base_url": "http://localhost:11434"}},
  "models": {"chat-m": {"name": "chat-model", "provider": "local", "type": "dense"}},
  "defaults": {"chat": "chat-m"}
}`,
			wantCode: codeAgentRoleMissing,
		},
		{
			name: "agent below capability floor",
			profile: `{
  "providers": {"local": {"base_url": "http://localhost:11434"}},
  "models": {"agent-m": {"name": "agent-model", "provider": "local", "type": "dense",
    "capabilities": ["chat", "stream"]}},
  "defaults": {"agent": "agent-m"}
}`,
			wantCode: codeAgentCapsInsufficient,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stageApplyTarget(t, applyTargetConfigJSON)
			targetRevision := stagedTargetRevision(t)
			stageUserProfile(t, "staged", tt.profile)

			prepared, result := prepareSettingsApply(context.Background(), profileSourceRequest(
				targetRevision, profileBodyRevision(tt.profile), nil, nil), applyModeExisting)

			if prepared != nil {
				t.Errorf("prepareSettingsApply(%q) prepared a document, want refusal", tt.name)
			}
			if result == nil {
				t.Fatalf("prepareSettingsApply(%q) result = nil, want diagnostics", tt.name)
			}
			if result.Status != "diagnostics" || len(result.Diagnostics) != 1 ||
				result.Diagnostics[0].Code != tt.wantCode {
				t.Errorf("prepareSettingsApply(%q) = %+v, want one %s diagnostic", tt.name, *result, tt.wantCode)
			}
		})
	}
}

// TestPrepareRefusesABadKeyValueByItsOwnCode: the UI pre-checks key values, so
// a request still carrying a bad one bypassed it — and gets the code that says
// what is wrong rather than the opaque catch-all.
func TestPrepareRefusesABadKeyValueByItsOwnCode(t *testing.T) {
	stageApplyTarget(t, applyTargetConfigJSON)
	targetRevision := stagedTargetRevision(t)
	for _, tc := range []struct {
		name  string
		value string
	}{
		{"interpolation", "${OPENAI_API_KEY}"},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prepared, result := prepareSettingsApply(context.Background(), SettingsApplyRequest{
				TargetRevision: stringPtr(targetRevision),
				Source:         ApplySource{Kind: applySourceApplied},
				Changes:        []Change{{Kind: changeKindProviderKeySet, Name: "ollama"}},
				Keys:           map[string]string{"ollama": tc.value},
			}, applyModeExisting)
			if prepared != nil {
				t.Fatal("a refused request must not produce a document")
			}
			if err := validateSettingsApplyResult(*result); err != nil {
				t.Fatalf("result is not contract-valid: %v (%+v)", err, *result)
			}
			if result.Status != "diagnostics" || len(result.Diagnostics) != 1 ||
				result.Diagnostics[0].Code != codeKeyValueInvalid {
				t.Fatalf("result = %+v, want a single key_value_invalid", *result)
			}
		})
	}

	// Every other boundary break stays deliberately opaque.
	_, result := prepareSettingsApply(context.Background(), SettingsApplyRequest{
		TargetRevision: stringPtr(targetRevision),
		Source:         ApplySource{Kind: applySourceApplied},
		Changes:        []Change{{Kind: changeKindProviderRemove, Name: "unused"}},
		Keys:           map[string]string{"ollama": "sk-stray"},
	}, applyModeExisting)
	if result.Diagnostics[0].Code != codeInvalidArgument {
		t.Fatalf("a stray key entry = %+v, want invalid_argument", *result)
	}
}

// TestApplyRequestEmptyChangesBySource: the empty change set is source-
// conditional. Only a profile source carries a document of its own.
func TestApplyRequestEmptyChangesBySource(t *testing.T) {
	cases := []struct {
		name   string
		mode   applyMode
		source ApplySource
		want   bool
	}{
		{"applied", applyModeExisting, ApplySource{Kind: applySourceApplied}, false},
		{"blank", applyModeCreate, ApplySource{Kind: applySourceBlank}, false},
		{"profile apply", applyModeExisting, ApplySource{Kind: applySourceProfile,
			ProfileID: "curated/local", SourceRevision: strings.Repeat("a", 64)}, true},
		{"profile create", applyModeCreate, ApplySource{Kind: applySourceProfile,
			ProfileID: "curated/local", SourceRevision: strings.Repeat("a", 64)}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := SettingsApplyRequest{Source: tc.source, Changes: []Change{}, Keys: map[string]string{}}
			if tc.mode == applyModeExisting {
				req.TargetRevision = stringPtr(strings.Repeat("b", 64))
			}
			err := validateSettingsApplyRequest(req, tc.mode)
			if (err == nil) != tc.want {
				t.Fatalf("validate(empty changes, %s) err = %v, want accepted = %v", tc.name, err, tc.want)
			}
		})
	}
}

// TestPrepareProfileSourceStoreUnsafe: an unsafe or unreadable profile STORE is
// what `profile_source_unavailable` is reserved for (§5.6) — not a missing
// profile, which is a conflict, and not invalid content, which is config_invalid.
func TestPrepareProfileSourceStoreUnsafe(t *testing.T) {
	stageApplyTarget(t, applyTargetConfigJSON)
	targetRevision := stagedTargetRevision(t)
	root := userProfileStoreRoot(t)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	// A regular file where the profiles directory belongs: unsafe on every
	// platform, and it needs no symlink privileges to stage.
	if err := os.WriteFile(filepath.Join(root, "profiles"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	prepared, result := prepareSettingsApply(context.Background(), profileSourceRequest(
		targetRevision, strings.Repeat("d", 64),
		[]Change{{Kind: changeKindProviderRemove, Name: "unused"}}, nil), applyModeExisting)
	if prepared != nil {
		t.Fatal("an unsafe store must not produce a document")
	}
	if err := validateSettingsApplyResult(*result); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, *result)
	}
	if result.Status != "diagnostics" || len(result.Diagnostics) != 1 ||
		result.Diagnostics[0].Code != codeProfileSourceUnavailable {
		t.Fatalf("result = %+v", *result)
	}
}

// TestLoadGolemProfileCurated: the fixed curated bootstrap Slice B ships. The
// revision is the catalog's own digest of the embedded bytes, reached by an
// independent path.
func TestLoadGolemProfileCurated(t *testing.T) {
	sandboxAgentConfigEnv(t)
	result := LoadGolemProfile(context.Background(), "curated/local")
	if err := validateGolemProfileLoadResult(result); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, result)
	}
	if result.Status != "loaded" || result.ProfileID != "curated/local" {
		t.Fatalf("result = %+v", result)
	}
	infos, err := profiles.NewStore(t.TempDir()).List(context.Background())
	if err != nil {
		t.Fatalf("catalog list: %v", err)
	}
	var want string
	for _, info := range infos {
		if info.ID == "curated/local" {
			want = info.Revision
		}
	}
	if want == "" {
		t.Fatal("the catalog no longer carries curated/local")
	}
	if result.SourceRevision != want {
		t.Fatalf("sourceRevision = %q, want the catalog digest %q", result.SourceRevision, want)
	}
	if result.Projection.State != "ready" || result.Projection.ReadOnly || !result.Projection.Editable {
		t.Fatalf("draft = %+v", *result.Projection)
	}
	if len(result.Projection.Providers) == 0 || len(result.Projection.Routes) == 0 {
		t.Fatalf("draft carries no document: %+v", *result.Projection)
	}
	assertNoCredentialLeak(t, "curated load result", result)
}

// TestLoadGolemProfileScrubsEveryCredentialForm: the sentinel lets an
// ambient-UNSET reference parse, and the scrub then erases the literal, the
// resolved reference, and the sentinel alike before anything is projected.
func TestLoadGolemProfileScrubsEveryCredentialForm(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Setenv(profileSetEnvName, profileAmbientSecret)
	unsetenv(t, profileUnsetEnvName)
	stageUserProfile(t, "keyed", keyedProfileJSON)

	// Without the loader's fixed lookup these same bytes refuse at parse: the
	// sentinel is the only reason an unset reference is loadable at all.
	if _, err := config.ParseDocument([]byte(keyedProfileJSON),
		config.Origin{Source: config.OriginProfile}, config.DocumentOptions{}); err == nil {
		t.Fatal("an ambient parse of an unset reference must fail")
	}

	result := LoadGolemProfile(context.Background(), "user/keyed")
	if err := validateGolemProfileLoadResult(result); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, result)
	}
	if result.Status != "loaded" {
		t.Fatalf("result = %+v", result)
	}
	if result.SourceRevision != profileBodyRevision(keyedProfileJSON) {
		t.Fatalf("sourceRevision = %q, want the raw source digest", result.SourceRevision)
	}
	if len(result.Projection.Providers) != 4 {
		t.Fatalf("draft providers = %+v", result.Projection.Providers)
	}
	assertNoCredentialLeak(t, "profile load result", result)
}

// TestLoadGolemProfileLimitedDraft: a draft is 'limited' or 'ready' and never
// anything else, and an identifier Firn cannot write is a preview it may still
// show — the refusal belongs to the Apply, not to the preview.
func TestLoadGolemProfileLimitedDraft(t *testing.T) {
	sandboxAgentConfigEnv(t)
	stageUserProfile(t, "unwritable", unwritableProfileJSON)

	result := LoadGolemProfile(context.Background(), "user/unwritable")
	if err := validateGolemProfileLoadResult(result); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, result)
	}
	if result.Status != "loaded" {
		t.Fatalf("result = %+v", result)
	}
	draft := *result.Projection
	if draft.State != "limited" || draft.Editable {
		t.Fatalf("draft = %+v", draft)
	}
	if len(draft.Diagnostics) != 1 || draft.Diagnostics[0].Code != codeIdentifierNotEditable {
		t.Fatalf("draft diagnostics = %+v", draft.Diagnostics)
	}
	assertNoCredentialLeak(t, "limited draft result", result)
}

// TestLoadGolemProfileDiagnostics maps every store and content failure onto the
// closed §5.6 profile vocabulary. No filesystem path crosses.
func TestLoadGolemProfileDiagnostics(t *testing.T) {
	cases := []struct {
		name     string
		stage    func(t *testing.T)
		id       string
		wantCode string
		wantNoID bool
	}{
		{name: "malformed id", id: "curated/Local", wantCode: "invalid_id", wantNoID: true},
		{name: "unnamespaced id", id: "local", wantCode: "invalid_id", wantNoID: true},
		{name: "unknown curated profile", id: "curated/absent", wantCode: "not_found"},
		{name: "unknown user profile", id: "user/absent", wantCode: "not_found"},
		{
			name:     "invalid profile content",
			stage:    func(t *testing.T) { stageUserProfile(t, "broken", `{"providers": {}}`) },
			id:       "user/broken",
			wantCode: "config_invalid",
		},
		{
			name:     "malformed key reference",
			stage:    func(t *testing.T) { stageUserProfile(t, "broken", malformedRefProfileJSON) },
			id:       "user/broken",
			wantCode: "config_invalid",
		},
		{
			// It loads, but every mutation is refused — including the scrub the
			// preview owes it, so no draft can be built from it.
			name:     "read-only profile",
			stage:    func(t *testing.T) { stageUserProfile(t, "broken", duplicateProviderDocumentJSON) },
			id:       "user/broken",
			wantCode: "config_invalid",
		},
		{
			name: "unsafe profile store",
			stage: func(t *testing.T) {
				root := userProfileStoreRoot(t)
				if err := os.MkdirAll(root, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "profiles"),
					[]byte("not a directory"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			id:       "user/anything",
			wantCode: "store_unsafe",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sandboxAgentConfigEnv(t)
			if tc.stage != nil {
				tc.stage(t)
			}
			result := LoadGolemProfile(context.Background(), tc.id)
			if err := validateGolemProfileLoadResult(result); err != nil {
				t.Fatalf("result is not contract-valid: %v (%+v)", err, result)
			}
			if result.Status != "diagnostics" || len(result.Diagnostics) != 1 {
				t.Fatalf("result = %+v", result)
			}
			d := result.Diagnostics[0]
			if d.Code != tc.wantCode {
				t.Fatalf("code = %q, want %q", d.Code, tc.wantCode)
			}
			wantID := tc.id
			if tc.wantNoID {
				wantID = ""
			}
			if d.ProfileID != wantID {
				t.Fatalf("profileId = %q, want %q", d.ProfileID, wantID)
			}
		})
	}
}

// TestPrepareGeneratesDistinctRoleNames: two new routes in one request never
// collide, including when the 256-byte trim makes their use-case prefixes
// identical (amendment 10 — candidates dedupe against authored roles UNION
// every name generated earlier in the same batch).
func TestPrepareGeneratesDistinctRoleNames(t *testing.T) {
	long := func(suffix string) string {
		return strings.Repeat("u", maxProjectionIdentifierLen-len(suffix)) + suffix
	}
	first, second := long("ab"), long("cd")
	// A multi-byte use case forces the prefix trim onto a rune boundary.
	multibyte := strings.Repeat("…", 85) + "x" // 256 bytes

	stageApplyTarget(t, applyTargetConfigJSON)
	revision := stagedTargetRevision(t)
	prepared, result := prepareSettingsApply(context.Background(), SettingsApplyRequest{
		TargetRevision: &revision, Source: ApplySource{Kind: applySourceApplied},
		Changes: []Change{
			confirmUnknown(routeChange(first, "ollama", "one", "chat", "stream"), first),
			confirmUnknown(routeChange(second, "ollama", "two", "chat", "stream"), second),
			confirmUnknown(routeChange(multibyte, "ollama", "three", "chat", "stream"), multibyte),
		},
		Keys: map[string]string{},
	}, applyModeExisting)
	if result != nil {
		t.Fatalf("prepare refused: %+v", *result)
	}
	cfg := prepared.doc.Config()
	names := map[string]bool{}
	for _, useCase := range []string{first, second, multibyte} {
		role, ok := cfg.Defaults[useCase]
		if !ok {
			t.Fatalf("use case %q was not bound", truncateForLog(useCase))
		}
		if names[role] {
			t.Fatalf("role %q was generated twice", truncateForLog(role))
		}
		names[role] = true
		if len(role) > maxProjectionIdentifierLen || !utf8.ValidString(role) {
			t.Fatalf("generated role is %d bytes, valid utf8 = %v", len(role), utf8.ValidString(role))
		}
		if _, ok := cfg.Models[role]; !ok {
			t.Fatalf("generated role %q has no model", truncateForLog(role))
		}
	}
}

func truncateForLog(value string) string {
	if len(value) <= 24 {
		return value
	}
	return value[:24] + "..."
}

// TestPrepareTargetsTheCanonicalActiveSource: discovery data is lexical and
// classification-only. The prepared target is the canonical file the document
// was actually read from, and a revision captured before a symlink swap can
// never authorize a write to the file the link now names.
func TestPrepareTargetsTheCanonicalActiveSource(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	dir := t.TempDir()
	real := filepath.Join(dir, "real.json")
	if err := os.WriteFile(real, []byte(applyTargetConfigJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "other.json")
	if err := os.WriteFile(other, []byte(duplicateProviderDocumentJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", link)
	revision := stagedTargetRevision(t)

	request := SettingsApplyRequest{
		TargetRevision: &revision, Source: ApplySource{Kind: applySourceApplied},
		Changes: []Change{{Kind: changeKindProviderRemove, Name: "unused"}},
		Keys:    map[string]string{},
	}
	prepared, result := prepareSettingsApply(context.Background(), request, applyModeExisting)
	if result != nil {
		t.Fatalf("prepare refused: %+v", *result)
	}
	if want := canonicalPath(t, real); prepared.target.path != want {
		t.Fatalf("prepared target = %q, want the canonical source %q", prepared.target.path, want)
	}
	if prepared.target.revision != revision || prepared.target.origin != originEnv {
		t.Fatalf("prepared target metadata = %+v", prepared.target)
	}

	// The lexical path now names a different document: the captured revision
	// belongs to a file this request may no longer write.
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, link); err != nil {
		t.Fatal(err)
	}
	swapped, result := prepareSettingsApply(context.Background(), request, applyModeExisting)
	if swapped != nil || result == nil || result.Status != "conflict" || result.Conflict != "target" {
		t.Fatalf("swapped source prepared %v with result %+v", swapped != nil, result)
	}
}

// TestFirnUseCaseFloorsAreOneTable: the floor table is the single Go source of
// truth and the shared fixture the TypeScript mirror is tested against; drift
// on either side is a contract break.
func TestFirnUseCaseFloorsAreOneTable(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "settings_use_case_floors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		UseCase      string   `json:"useCase"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != len(firnUseCaseFloors) {
		t.Fatalf("fixture has %d rows, table has %d", len(rows), len(firnUseCaseFloors))
	}
	for _, row := range rows {
		floor, ok := firnUseCaseFloors[row.UseCase]
		if !ok {
			t.Fatalf("fixture use case %q is not in the table", row.UseCase)
		}
		want, err := provider.ParseCapsStrict(row.Capabilities)
		if err != nil {
			t.Fatalf("fixture capabilities %v: %v", row.Capabilities, err)
		}
		if floor != want {
			t.Fatalf("floor for %q = %v, fixture says %v", row.UseCase, floor.Names(), row.Capabilities)
		}
	}
	// The agent floor has exactly one definition: the run path's own constant.
	if firnUseCaseFloors["agent"] != requiredAgentCaps {
		t.Fatal("the agent floor diverged from requiredAgentCaps")
	}
}

// ---------------------------------------------------------------------------
// Settings writes (spec §5.2 Call 1, Call 2, and Step S). Every row drives the
// real Service against a real target file: the idle barrier, the consent
// store, the save, and the snapshot publication ARE the behaviour under test,
// so nothing below fakes them.
// ---------------------------------------------------------------------------

// remoteAgentTargetJSON is the shared write fixture with the agent ALREADY
// routed at the remote provider, so an unrelated edit leaves the resolved
// destination unchanged.
var remoteAgentTargetJSON = strings.Replace(applyTargetConfigJSON, `"agent": "solo"`, `"agent": "shared"`, 1)

// remoteProfileJSON is a credential-free profile whose agent route is remote:
// applying it changes the destination, which is what makes it a consent case.
const remoteProfileJSON = `{
  "providers": {"remote": {"base_url": "https://api.example.com/v1", "api_format": "openai-compat"}},
  "models": {"agent-m": {"name": "profile-remote-model", "provider": "remote", "type": "dense",
    "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`

const applyRemoteEndpoint = "https://api.example.com/v1"

// remoteApplyDestination is the destination the remote route change below
// resolves to — the consent identity a matrix row can pre-grant.
func remoteApplyDestination() ProviderDestination {
	return ProviderDestination{
		Provider: "remote", Model: "apply-remote-model", Endpoint: applyRemoteEndpoint,
		Classification: "remote", Digest: destinationDigest("remote", applyRemoteEndpoint),
	}
}

// remoteAgentRoute retargets the agent use case at a model NO other role uses,
// so the change needs no unknown-use-case acknowledgement and the only thing
// it changes is where agent traffic would go.
func remoteAgentRoute() Change {
	return routeChange(useCaseAgent, "remote", "apply-remote-model", "chat", "stream", "tool_call")
}

func localAgentRoute() Change {
	return routeChange(useCaseAgent, "ollama", "apply-local-model", "chat", "stream", "tool_call")
}

// fallbackChainTargetJSON is the write fixture whose agent role reaches two
// FALLBACKS besides its own model. Both fallback providers are local today,
// so pointing them at remote endpoints opens two new destinations at once
// while the agent route itself never moves — the shape a single-destination
// consent question cannot express, and the only honest way to open a batch
// (the agent route can never be unbound through apply).
const fallbackChainTargetJSON = `{
  "providers": {
    "ollama": {"base_url": "http://localhost:11434"},
    "alpha": {"base_url": "http://localhost:11501", "api_format": "openai-compat"},
    "beta": {"base_url": "http://localhost:11502", "api_format": "openai-compat"}
  },
  "models": {
    "agent-m": {"name": "agent-model", "provider": "ollama", "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"], "fallbacks": ["alpha-m", "beta-m"]},
    "alpha-m": {"name": "alpha-model", "provider": "alpha", "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"]},
    "beta-m": {"name": "beta-model", "provider": "beta", "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"]}
  },
  "defaults": {"agent": "agent-m"}
}`

const (
	alphaFallbackEndpoint = "https://alpha.example.com/v1"
	betaFallbackEndpoint  = "https://beta.example.net/v1"
)

// remoteFallbackTargetJSON is the same document with both fallbacks ALREADY
// remote: its reachable set holds two remote destinations the user has never
// been asked about, which is what makes a set-preserving edit on it the I8
// case.
var remoteFallbackTargetJSON = strings.NewReplacer(
	"http://localhost:11501", alphaFallbackEndpoint,
	"http://localhost:11502", betaFallbackEndpoint,
).Replace(fallbackChainTargetJSON)

// remoteFallbackChanges retargets both fallback providers at remote endpoints
// without touching the agent route or any model.
func remoteFallbackChanges() []Change {
	return []Change{
		{Kind: changeKindProviderUpdate, Name: "alpha", Endpoint: stringPtr(alphaFallbackEndpoint)},
		{Kind: changeKindProviderUpdate, Name: "beta", Endpoint: stringPtr(betaFallbackEndpoint)},
	}
}

// wantFallbackDestinations is the exact challenge listing those changes must
// produce: both new remotes, DIGEST-sorted, each reached by the plain agent
// hop.
func wantFallbackDestinations() []ApplyDestination {
	alpha := ApplyDestination{Provider: "alpha", Model: "alpha-model", Endpoint: alphaFallbackEndpoint,
		Classification: "remote", Provenance: []string{"agent"}}
	beta := ApplyDestination{Provider: "beta", Model: "beta-model", Endpoint: betaFallbackEndpoint,
		Classification: "remote", Provenance: []string{"agent"}}
	if destinationDigest("beta", betaFallbackEndpoint) < destinationDigest("alpha", alphaFallbackEndpoint) {
		return []ApplyDestination{beta, alpha}
	}
	return []ApplyDestination{alpha, beta}
}

func sameApplyDestinations(got, want []ApplyDestination) bool {
	return slices.EqualFunc(got, want, func(a, b ApplyDestination) bool {
		return a.Provider == b.Provider && a.Model == b.Model && a.Endpoint == b.Endpoint &&
			a.Classification == b.Classification && slices.Equal(a.Provenance, b.Provenance)
	})
}

type applyHarness struct {
	svc  *Service
	rec  *emitRecorder
	path string // the staged target ("" for a Create sandbox)
}

// newApplyHarness stages body as the active target — body "" leaves the
// sandbox empty for Create — and builds a Service on the REAL discovery path.
func newApplyHarness(t *testing.T, body string) *applyHarness {
	t.Helper()
	return newApplyHarnessWithConsent(t, body, filepath.Join(t.TempDir(), "consent", "grants.json"))
}

// newApplyHarnessWithConsent is newApplyHarness with an explicit consent path;
// an empty one makes every Grant fail, which is the uncertain-outcome case.
func newApplyHarnessWithConsent(t *testing.T, body, consentPath string) *applyHarness {
	t.Helper()
	h := &applyHarness{rec: &emitRecorder{}}
	if body == "" {
		sandboxAgentConfigEnv(t)
		t.Chdir(t.TempDir())
	} else {
		h.path = stageApplyTarget(t, body)
	}
	h.svc = NewService(context.Background(), filesystem.NewOS(), consentPath, h.rec.emit)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := h.svc.Close(ctx); err != nil {
			t.Errorf("cleanup Close: %v", err)
		}
	})
	return h
}

// request builds an applied-source request against the target's CURRENT
// revision — the shape the frontend sends and, unchanged, resends on Confirm.
func (h *applyHarness) request(t *testing.T, changes ...Change) SettingsApplyRequest {
	t.Helper()
	req := SettingsApplyRequest{
		Source: ApplySource{Kind: applySourceApplied}, Changes: changes, Keys: map[string]string{},
	}
	if h.path != "" {
		req.TargetRevision = stringPtr(stagedTargetRevision(t))
	}
	return req
}

func (h *applyHarness) targetBytes(t *testing.T) []byte {
	t.Helper()
	raw, _ := readTargetBytes(t, h.path)
	return raw
}

// challenge runs Call 1 and returns the issued token, failing the test if the
// call did anything other than ask for consent.
func (h *applyHarness) challenge(t *testing.T, req SettingsApplyRequest) string {
	t.Helper()
	res, err := h.svc.ApplySettings(req)
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	if err := validateSettingsApplyResult(res); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
	}
	if res.Status != "consent_required" {
		t.Fatalf("status = %q, want consent_required (%+v)", res.Status, res)
	}
	return res.Challenge.Token
}

func (h *applyHarness) confirm(t *testing.T, token string, req SettingsApplyRequest) SettingsApplyResult {
	t.Helper()
	res, err := h.svc.ConfirmSettingsApply(ConfirmSettingsApplyRequest{ChallengeToken: token, Request: req})
	if err != nil {
		t.Fatalf("ConfirmSettingsApply: %v", err)
	}
	if err := validateSettingsApplyResult(res); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
	}
	return res
}

// pendingRecord reaches into the challenge map so a test can assert what the
// backend retained.
func (h *applyHarness) pendingRecord(t *testing.T, token string) *settingsChallengeRecord {
	t.Helper()
	h.svc.challengeMu.Lock()
	defer h.svc.challengeMu.Unlock()
	rec, ok := h.svc.pendingApplies[token]
	if !ok {
		t.Fatal("no pending challenge record for the issued token")
	}
	return rec
}

// markConversationBusy puts one conversation into a non-idle state, which is
// exactly what the idle barrier refuses.
func markConversationBusy(svc *Service, id string, state convState) {
	conv := svc.conversationFor(id)
	conv.mu.Lock()
	conv.state = state
	conv.mu.Unlock()
}

func TestApplySettingsRejectsAgentProviderEndpointMadeUnusable(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	before := h.targetBytes(t)

	res, err := h.svc.ApplySettings(h.request(t, Change{
		Kind: changeKindProviderUpdate, Name: "ollama", Endpoint: stringPtr("ftp://example.com"),
	}))
	if err != nil {
		t.Fatalf("ApplySettings(provider endpoint): %v", err)
	}
	if res.Status != "diagnostics" || len(res.Diagnostics) != 1 ||
		res.Diagnostics[0].Code != codeProviderEndpointUnsupported {
		t.Errorf("ApplySettings(provider endpoint) = %+v, want one %s diagnostic",
			res, codeProviderEndpointUnsupported)
	}
	if got := h.targetBytes(t); !bytes.Equal(got, before) {
		t.Errorf("ApplySettings(provider endpoint) target bytes changed, want unchanged")
	}
}

func TestApplySettingsRejectsSelectorOverrideThatBreaksAnotherFirnUseCase(t *testing.T) {
	const target = `{
  "providers": {"ollama": {"base_url": "http://localhost:11434"}},
  "models": {
    "agent-m": {"name": "agent-model", "provider": "ollama", "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"]},
    "embed-m": {"name": "shared-model", "provider": "ollama", "type": "dense",
      "capabilities": ["chat", "stream", "embed"]},
    "summary-m": {"name": "shared-model", "provider": "ollama", "type": "dense",
      "capabilities": ["chat", "stream", "embed"]}
  },
  "defaults": {"agent": "agent-m", "embedding": "embed-m", "summarize": "summary-m"}
}`
	h := newApplyHarness(t, target)
	before := h.targetBytes(t)
	// An override asserting the shared selector without embed, below
	// embedding's floor. Upstream's SetRoleOverrides gate refuses it during the
	// mutation, naming the first matching ROLE; the use-case-subject refusal
	// (checkPreparedDocument) is reached only when that gate passes — which an
	// empty exposure did, by clearing to the type defaults, before
	// validateRouteChange refused the empty list (see the apply corpus).
	change := confirmUnknown(
		routeChange("summarize", "ollama", "shared-model", "chat", "stream"),
		"summarize",
	)

	res, err := h.svc.ApplySettings(h.request(t, change))
	if err != nil {
		t.Fatalf("ApplySettings(selector override): %v", err)
	}
	if res.Status != "diagnostics" || len(res.Diagnostics) != 1 ||
		res.Diagnostics[0].Code != codeEligibilityIneligible ||
		res.Diagnostics[0].SubjectKind != "role" ||
		res.Diagnostics[0].SubjectName != "embed-m" ||
		!res.Diagnostics[0].Blocking {
		t.Errorf("ApplySettings(selector override) = %+v, want blocking embed-m %s diagnostic",
			res, codeEligibilityIneligible)
	}
	if got := h.targetBytes(t); !bytes.Equal(got, before) {
		t.Errorf("ApplySettings(selector override) target bytes changed, want unchanged")
	}
}

// TestCheckPreparedDocumentNamesAnIndirectlyBrokenUseCase pins the completed-
// document loop: a Firn floor the request never names but the finished
// document no longer meets is reported on THAT use case. The apply path
// reaches this loop only when upstream's own gate passed (see the selector
// override test above, where it does not).
func TestCheckPreparedDocumentNamesAnIndirectlyBrokenUseCase(t *testing.T) {
	doc, err := config.ParseDocument([]byte(`{
  "providers": {"ollama": {"base_url": "http://localhost:11434"}},
  "models": {
    "agent-m": {"name": "agent-model", "provider": "ollama", "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"]},
    "embed-m": {"name": "shared-model", "provider": "ollama", "type": "dense",
      "capabilities": ["chat", "stream"]}
  },
  "defaults": {"agent": "agent-m", "embedding": "embed-m"}
}`), config.Origin{Source: config.OriginProfile}, config.DocumentOptions{})
	if err != nil {
		t.Fatalf("ParseDocument: %v", err)
	}
	res := checkPreparedDocument(doc, SettingsApplyRequest{})
	if res == nil || res.Status != "diagnostics" || len(res.Diagnostics) != 1 ||
		res.Diagnostics[0].Code != codeEligibilityIneligible ||
		res.Diagnostics[0].SubjectKind != "use_case" ||
		res.Diagnostics[0].SubjectName != "embedding" {
		t.Fatalf("checkPreparedDocument = %+v, want embedding %s diagnostic",
			res, codeEligibilityIneligible)
	}
}

// TestApplySettingsConsentMatrix: only a CHANGED, ungranted, remote agent
// destination takes a challenge. Everything else — unchanged, local, or
// already granted — publishes straight through, and the challenge itself
// writes nothing.
func TestApplySettingsConsentMatrix(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		change     Change
		grant      bool
		wantStatus string
	}{
		{
			name: "unchanged remote destination skips the challenge",
			body: remoteAgentTargetJSON,
			change: Change{Kind: changeKindProviderAdd, Name: "extra",
				Endpoint: stringPtr("http://localhost:11700")},
			wantStatus: "applied",
		},
		{name: "local destination skips the challenge", change: localAgentRoute(), wantStatus: "applied"},
		{name: "already granted remote destination skips the challenge", change: remoteAgentRoute(),
			grant: true, wantStatus: "applied"},
		{name: "changed ungranted remote destination challenges", change: remoteAgentRoute(),
			wantStatus: "consent_required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := tc.body
			if body == "" {
				body = applyTargetConfigJSON
			}
			h := newApplyHarness(t, body)
			if tc.grant {
				if err := h.svc.consent.Grant(remoteApplyDestination()); err != nil {
					t.Fatalf("seed grant: %v", err)
				}
			}
			before := h.targetBytes(t)
			res, err := h.svc.ApplySettings(h.request(t, tc.change))
			if err != nil {
				t.Fatalf("ApplySettings: %v", err)
			}
			if err := validateSettingsApplyResult(res); err != nil {
				t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
			}
			if res.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q (%+v)", res.Status, tc.wantStatus, res)
			}
			after := h.targetBytes(t)
			if tc.wantStatus == "consent_required" {
				if !bytes.Equal(before, after) {
					t.Fatal("consent_required wrote to the target")
				}
				if h.svc.consent.Has(remoteApplyDestination().Digest) {
					t.Fatal("consent_required recorded a grant")
				}
				return
			}
			if bytes.Equal(before, after) {
				t.Fatal("an applied result left the target unchanged")
			}
			if !tc.grant && h.svc.consent.Has(remoteApplyDestination().Digest) {
				t.Fatal("a skipped challenge granted a destination anyway")
			}
		})
	}
}

// TestApplySettingsChallengesTheWholeNewRemoteBatch: a write that opens more
// than one new remote destination asks about ALL of them at once, and the
// single confirmation commits the whole batch durably. Nothing here unbinds
// the agent route: what moves is where two of its fallbacks point.
func TestApplySettingsChallengesTheWholeNewRemoteBatch(t *testing.T) {
	consentPath := filepath.Join(t.TempDir(), "consent", "grants.json")
	h := newApplyHarnessWithConsent(t, fallbackChainTargetJSON, consentPath)
	req := h.request(t, remoteFallbackChanges()...)
	before := h.targetBytes(t)

	res, err := h.svc.ApplySettings(req)
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	if err := validateSettingsApplyResult(res); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
	}
	if res.Status != "consent_required" {
		t.Fatalf("status = %q, want consent_required (%+v)", res.Status, res)
	}
	if want := wantFallbackDestinations(); !sameApplyDestinations(res.Challenge.Destinations, want) {
		t.Fatalf("challenge destinations = %+v, want %+v", res.Challenge.Destinations, want)
	}
	if !bytes.Equal(before, h.targetBytes(t)) {
		t.Fatal("the challenge wrote to the target")
	}
	for _, dest := range wantFallbackDestinations() {
		if h.svc.consent.Has(destinationDigest(dest.Provider, dest.Endpoint)) {
			t.Fatalf("the challenge granted %s", dest.Provider)
		}
	}

	confirmed := h.confirm(t, res.Challenge.Token, req)
	if confirmed.Status != "applied" {
		t.Fatalf("confirm = %+v, want applied", confirmed)
	}
	if bytes.Equal(before, h.targetBytes(t)) {
		t.Fatal("the confirmation published nothing")
	}
	// Durable, not merely in memory: only a store reopened from the same file
	// proves the whole batch survived the write.
	reopened, err := OpenConsentStore(filesystem.NewOS(), consentPath)
	if err != nil {
		t.Fatalf("reopen consent store: %v", err)
	}
	for _, dest := range wantFallbackDestinations() {
		if !reopened.Has(destinationDigest(dest.Provider, dest.Endpoint)) {
			t.Fatalf("the reopened store holds no grant for %q", dest.Provider)
		}
	}
}

// TestApplySettingsSkipsTheChallengeWhenTheReachableSetIsUnchanged (I8):
// consent is asked about the SET. An edit that leaves every reachable
// destination exactly where it was publishes on the first call — even though
// the set holds remote destinations that carry no grant, because the user has
// already been living with them.
func TestApplySettingsSkipsTheChallengeWhenTheReachableSetIsUnchanged(t *testing.T) {
	h := newApplyHarness(t, remoteFallbackTargetJSON)
	before := h.targetBytes(t)

	res, err := h.svc.ApplySettings(h.request(t, Change{Kind: changeKindProviderAdd,
		Name: "extra", Endpoint: stringPtr("http://localhost:11700")}))
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	if err := validateSettingsApplyResult(res); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
	}
	if res.Status != "applied" || res.Challenge != nil {
		t.Fatalf("res = %+v, want applied with no challenge", res)
	}
	if bytes.Equal(before, h.targetBytes(t)) {
		t.Fatal("an applied result left the target unchanged")
	}
	for _, dest := range wantFallbackDestinations() {
		if h.svc.consent.Has(destinationDigest(dest.Provider, dest.Endpoint)) {
			t.Fatalf("a skipped challenge granted %q anyway", dest.Provider)
		}
	}
}

// TestSettingsWriteChallengeAccompaniesOnlyConsentRequired (§5.6): the
// challenge is present IFF the status is consent_required, checked against
// the real service across every terminal status one sweep can reach.
func TestSettingsWriteChallengeAccompaniesOnlyConsentRequired(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	stale := h.request(t, remoteAgentRoute())
	stale.TargetRevision = stringPtr(strings.Repeat("0", 64))

	var results []SettingsApplyResult
	add := func(res SettingsApplyResult, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("settings write: %v", err)
		}
		results = append(results, res)
	}
	add(h.svc.ApplySettings(h.request(t, remoteAgentRoute()))) // consent_required
	add(h.svc.ApplySettings(stale))                            // conflict:target
	add(h.svc.ConfirmSettingsApply(ConfirmSettingsApplyRequest{
		ChallengeToken: "never-issued", Request: h.request(t, remoteAgentRoute())})) // conflict:challenge
	add(h.svc.ApplySettings(h.request(t, localAgentRoute()))) // applied

	statuses := map[string]bool{}
	for i, res := range results {
		if err := validateSettingsApplyResult(res); err != nil {
			t.Fatalf("result %d is not contract-valid: %v (%+v)", i, err, res)
		}
		if (res.Challenge != nil) != (res.Status == "consent_required") {
			t.Fatalf("result %d status %q carries challenge=%v", i, res.Status, res.Challenge != nil)
		}
		statuses[res.Status] = true
	}
	for _, want := range []string{"consent_required", "conflict", "applied"} {
		if !statuses[want] {
			t.Fatalf("the sweep never produced a %q result: %v", want, statuses)
		}
	}
}

// TestConfirmSettingsApplyRefusesAGrantOnlyChallenge: a grant-only challenge
// approves destinations and authorizes no document write, so the settings
// write path refuses its token outright and consumes it. The malformed row is
// what pins the refusal to the mode rather than to a later check: the request
// never reaches validation, so the answer is the §5.2 conflict and not an
// argument diagnostic.
func TestConfirmSettingsApplyRefusesAGrantOnlyChallenge(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mangle func(req *SettingsApplyRequest)
	}{
		{name: "well-formed resend"},
		{name: "malformed resend", mangle: func(req *SettingsApplyRequest) { req.Changes = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newApplyHarness(t, applyTargetConfigJSON)
			req := h.request(t, remoteAgentRoute())
			if tc.mangle != nil {
				tc.mangle(&req)
			}
			before := h.targetBytes(t)
			token := h.svc.installSettingsChallenge(&settingsChallengeRecord{
				expiresAt: h.svc.now().Add(consentChallengeTTL).UnixMilli(),
				mode:      applyModeGrantOnly,
			})

			res := h.confirm(t, token, req)
			if res.Status != "conflict" || res.Conflict != "challenge" ||
				res.ConsentOutcome != consentUnchanged {
				t.Fatalf("res = %+v, want conflict:challenge/unchanged", res)
			}
			if !bytes.Equal(before, h.targetBytes(t)) {
				t.Fatal("a grant-only challenge wrote to the target")
			}
			if h.svc.consent.Has(remoteApplyDestination().Digest) {
				t.Fatal("a grant-only challenge granted through the settings path")
			}
			h.svc.challengeMu.Lock()
			_, live := h.svc.pendingApplies[token]
			h.svc.challengeMu.Unlock()
			if live {
				t.Fatal("the refused grant-only token is still live")
			}
		})
	}
}

// TestCanonicalApplyDigestBindsDestinationSets (F10): the request digest binds
// the destination SETS themselves — proven directly, because an end-to-end
// mutation trips revision identity first.
func TestCanonicalApplyDigestBindsDestinationSets(t *testing.T) {
	req := SettingsApplyRequest{
		Source: ApplySource{Kind: applySourceApplied}, Changes: []Change{localAgentRoute()},
		TargetRevision: stringPtr(strings.Repeat("a", 64)), Keys: map[string]string{},
	}
	a := ProviderDestination{Provider: "hosted", Endpoint: "https://api.example.com", Classification: "remote",
		Digest: destinationDigest("hosted", "https://api.example.com")}
	b := ProviderDestination{Provider: "backup", Endpoint: "https://alt.example.net", Classification: "remote",
		Digest: destinationDigest("backup", "https://alt.example.net")}
	base := canonicalApplyDigest(req, applyModeExisting, "target", []ProviderDestination{a}, []ProviderDestination{a})
	post := canonicalApplyDigest(req, applyModeExisting, "target", []ProviderDestination{a}, []ProviderDestination{a, b})
	pre := canonicalApplyDigest(req, applyModeExisting, "target", []ProviderDestination{a, b}, []ProviderDestination{a})
	if base == post || base == pre || post == pre {
		t.Fatal("the digest must change when either destination set changes")
	}
}

// TestConfirmSettingsApplyPublishes: Call 2 resends the full request, records
// the grant, publishes, and consumes the token exactly once.
func TestConfirmSettingsApplyPublishes(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	req := h.request(t, remoteAgentRoute())
	token := h.challenge(t, req)
	before := h.targetBytes(t)
	beforeEmits := h.rec.count(EventGolemStatusChanged)

	res := h.confirm(t, token, req)
	if res.Status != "applied" || res.Warning != "" {
		t.Fatalf("confirm = %+v, want applied", res)
	}
	if res.Projection == nil || res.Projection.Revision == stagedTargetRevisionOf(before) {
		t.Fatalf("projection did not advance: %+v", res.Projection)
	}
	if bytes.Equal(before, h.targetBytes(t)) {
		t.Fatal("confirm published nothing")
	}
	if !h.svc.consent.Has(remoteApplyDestination().Digest) {
		t.Fatal("confirm did not record the grant")
	}
	if got := h.rec.count(EventGolemStatusChanged); got != beforeEmits+1 {
		t.Fatalf("status-changed emits = %d, want %d", got, beforeEmits+1)
	}
	// The published snapshot is the one every other caller now reads.
	settings, err := h.svc.Settings()
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if settings.Revision != res.Projection.Revision {
		t.Fatalf("snapshot revision %q != published %q", settings.Revision, res.Projection.Revision)
	}

	// Single use: the token is gone, and that verdict beats the stale target
	// revision the same request now carries.
	published := h.targetBytes(t)
	again := h.confirm(t, token, req)
	if again.Status != "conflict" || again.Conflict != "challenge" ||
		again.ConsentOutcome != consentUnchanged {
		t.Fatalf("replayed confirm = %+v, want conflict:challenge", again)
	}
	if !bytes.Equal(published, h.targetBytes(t)) {
		t.Fatal("a replayed confirm wrote again")
	}
}

// stagedTargetRevisionOf is the independent revision oracle for raw bytes.
func stagedTargetRevisionOf(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// TestConfirmSettingsApplyMismatches: every way Call 2 can stop describing
// what the user approved refuses the write, and each one consumes the token.
func TestConfirmSettingsApplyMismatches(t *testing.T) {
	t.Run("request digest", func(t *testing.T) {
		h := newApplyHarness(t, applyTargetConfigJSON)
		req := h.request(t, remoteAgentRoute())
		token := h.challenge(t, req)
		before := h.targetBytes(t)
		// A valid request that is not the approved one.
		tampered := h.request(t, remoteAgentRoute(),
			Change{Kind: changeKindProviderAdd, Name: "extra", Endpoint: stringPtr("http://localhost:11700")})
		res := h.confirm(t, token, tampered)
		if res.Status != "conflict" || res.Conflict != "challenge" {
			t.Fatalf("res = %+v, want conflict:challenge", res)
		}
		if !bytes.Equal(before, h.targetBytes(t)) {
			t.Fatal("a mismatched confirm wrote to the target")
		}
		if h.svc.consent.Has(remoteApplyDestination().Digest) {
			t.Fatal("a mismatched confirm granted the destination")
		}
	})

	t.Run("target identity", func(t *testing.T) {
		h := newApplyHarness(t, applyTargetConfigJSON)
		req := h.request(t, remoteAgentRoute())
		token := h.challenge(t, req)
		// Same bytes, therefore the same revision — a different FILE. Only the
		// target-identity digest can catch this.
		moved := writeAgentConfigBody(t, applyTargetConfigJSON)
		t.Setenv("GO_LLM_CONFIG", moved)
		res := h.confirm(t, token, req)
		if res.Status != "conflict" || res.Conflict != "challenge" {
			t.Fatalf("res = %+v, want conflict:challenge", res)
		}
		if raw, _ := readTargetBytes(t, moved); !bytes.Equal([]byte(applyTargetConfigJSON), raw) {
			t.Fatal("a moved target was written anyway")
		}
	})

	t.Run("profile source", func(t *testing.T) {
		h := newApplyHarness(t, applyTargetConfigJSON)
		stageUserProfile(t, "staged", remoteProfileJSON)
		req := h.request(t, Change{Kind: changeKindProviderAdd, Name: "extra",
			Endpoint: stringPtr("http://localhost:11700")})
		req.Source = ApplySource{Kind: applySourceProfile, ProfileID: "user/staged",
			SourceRevision: profileBodyRevision(remoteProfileJSON)}
		token := h.challenge(t, req)
		before := h.targetBytes(t)
		stageUserProfile(t, "staged", strings.Replace(remoteProfileJSON,
			"profile-remote-model", "profile-moved-model", 1))
		res := h.confirm(t, token, req)
		if res.Status != "conflict" || res.Conflict != "profile_source" ||
			res.ConsentOutcome != consentUnchanged {
			t.Fatalf("res = %+v, want conflict:profile_source/unchanged", res)
		}
		if !bytes.Equal(before, h.targetBytes(t)) {
			t.Fatal("a moved profile source wrote to the target")
		}
		// The token was consumed by that terminal result.
		replay := h.confirm(t, token, req)
		if replay.Conflict != "challenge" {
			t.Fatalf("replay = %+v, want conflict:challenge", replay)
		}
	})
}

// TestSettingsChallengeExpires: the existing 10-minute TTL invalidates the
// token, and an expired confirmation writes nothing.
func TestSettingsChallengeExpires(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	clk := &fakeClock{t: time.Now()}
	h.svc.now = clk.Now
	req := h.request(t, remoteAgentRoute())
	token := h.challenge(t, req)
	before := h.targetBytes(t)

	clk.advance(consentChallengeTTL + time.Minute)
	res := h.confirm(t, token, req)
	if res.Status != "conflict" || res.Conflict != "challenge" {
		t.Fatalf("res = %+v, want conflict:challenge", res)
	}
	if !bytes.Equal(before, h.targetBytes(t)) {
		t.Fatal("an expired confirmation wrote to the target")
	}
}

// TestCancelSettingsApply: cancel is idempotent, invalidates the token, and
// never writes.
func TestCancelSettingsApply(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	req := h.request(t, remoteAgentRoute())
	token := h.challenge(t, req)
	before := h.targetBytes(t)

	for _, call := range []string{"first", "second"} {
		res := h.svc.CancelSettingsApply(token)
		if err := validateCancelSettingsApplyResult(res); err != nil {
			t.Fatalf("%s cancel: %v (%+v)", call, err, res)
		}
	}
	// An unknown token is already cancelled.
	if res := h.svc.CancelSettingsApply("never-issued"); res.Status != "cancelled" {
		t.Fatalf("unknown-token cancel = %+v", res)
	}
	res := h.confirm(t, token, req)
	if res.Status != "conflict" || res.Conflict != "challenge" {
		t.Fatalf("confirm after cancel = %+v, want conflict:challenge", res)
	}
	if !bytes.Equal(before, h.targetBytes(t)) {
		t.Fatal("cancel or a cancelled confirmation wrote to the target")
	}
}

// TestCancelSettingsApplyIgnoresTheIdleBarrier (Amendment 9): cancel takes the
// settings-challenge mutex and nothing else, so it returns immediately even
// while a turn holds the barrier.
func TestCancelSettingsApplyIgnoresTheIdleBarrier(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	req := h.request(t, remoteAgentRoute())
	token := h.challenge(t, req)

	h.svc.bindingGate.Lock() // stands in for a turn holding the barrier
	done := make(chan CancelSettingsApplyResult, 1)
	go func() { done <- h.svc.CancelSettingsApply(token) }()
	select {
	case res := <-done:
		if res.Status != "cancelled" {
			t.Errorf("cancel = %+v", res)
		}
	case <-time.After(5 * time.Second):
		h.svc.bindingGate.Unlock()
		t.Fatal("cancel blocked on the idle barrier")
	}
	h.svc.bindingGate.Unlock()

	res := h.confirm(t, token, req)
	if res.Conflict != "challenge" {
		t.Fatalf("confirm after barrier cancel = %+v", res)
	}
}

// TestSettingsWriteBusyRetainsTheToken: busy is the one nonterminal
// confirmation result, so the same token still works once the barrier clears.
func TestSettingsWriteBusyRetainsTheToken(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	req := h.request(t, remoteAgentRoute())
	token := h.challenge(t, req)
	before := h.targetBytes(t)

	markConversationBusy(h.svc, "busy-conversation", stateRunning)
	res := h.confirm(t, token, req)
	if res.Status != "busy" {
		t.Fatalf("busy confirm = %+v", res)
	}
	applyRes, err := h.svc.ApplySettings(h.request(t, localAgentRoute()))
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	if applyRes.Status != "busy" {
		t.Fatalf("busy apply = %+v", applyRes)
	}
	if !bytes.Equal(before, h.targetBytes(t)) {
		t.Fatal("a busy result wrote to the target")
	}

	markConversationBusy(h.svc, "busy-conversation", stateIdle)
	res = h.confirm(t, token, req)
	if res.Status != "applied" {
		t.Fatalf("retried confirm = %+v, want applied", res)
	}
}

// TestSettingsChallengeRetainsNothingSecret: the record holds only the token,
// expiry, operation, two digests, and the destinations being granted. Key
// values are outside the consent identity entirely, so a rotated key still
// confirms.
func TestSettingsChallengeRetainsNothingSecret(t *testing.T) {
	const staged = "sk-staged-secret"
	h := newApplyHarness(t, applyTargetConfigJSON)
	req := h.request(t, remoteAgentRoute(), Change{Kind: changeKindProviderKeySet, Name: "remote"})
	req.Keys = map[string]string{"remote": staged}
	res, err := h.svc.ApplySettings(req)
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	if err := validateSettingsApplyResult(res); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
	}
	if res.Status != "consent_required" {
		t.Fatalf("status = %q, want consent_required", res.Status)
	}
	token := res.Challenge.Token
	challengeRaw, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal challenge result: %v", err)
	}
	for _, forbidden := range []string{staged, "sk-live-secret", h.path} {
		if strings.Contains(string(challengeRaw), forbidden) {
			t.Fatalf("challenge result carries %q: %s", forbidden, challengeRaw)
		}
	}

	// The destination identities being granted are deliberately retained
	// (§5.2); a key value, the request, the document, and the target path
	// are not.
	dump := fmt.Sprintf("%+v", *h.pendingRecord(t, token))
	for _, forbidden := range []string{staged, "sk-live-secret", h.path, "provider-key-set"} {
		if strings.Contains(dump, forbidden) {
			t.Fatalf("challenge record retains %q: %s", forbidden, dump)
		}
	}

	// The resend rotates the key value; the consent identity cannot notice.
	rotated := req
	rotated.Keys = map[string]string{"remote": "sk-rotated-secret"}
	res = h.confirm(t, token, rotated)
	if res.Status != "applied" {
		t.Fatalf("rotated-key confirm = %+v, want applied", res)
	}
	published := h.targetBytes(t)
	if !bytes.Contains(published, []byte("sk-rotated-secret")) {
		t.Fatal("the rotated key was not applied")
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	for _, forbidden := range []string{staged, "sk-rotated-secret", "sk-live-secret", h.path} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("result carries %q: %s", forbidden, raw)
		}
	}
}

// TestConfirmSettingsApplyGrantOutcomes: a grant failure blocks the save and
// reports `uncertain`; a save failure AFTER a durable grant still reports that
// the approval was recorded.
func TestConfirmSettingsApplyGrantOutcomes(t *testing.T) {
	t.Run("grant failure blocks the write", func(t *testing.T) {
		// No consent path at all: Has is false and Grant always fails.
		h := newApplyHarnessWithConsent(t, applyTargetConfigJSON, "")
		req := h.request(t, remoteAgentRoute())
		token := h.challenge(t, req)
		before := h.targetBytes(t)

		res := h.confirm(t, token, req)
		if res.Status != "diagnostics" || res.ConsentOutcome != consentUncertain {
			t.Fatalf("res = %+v, want diagnostics/uncertain", res)
		}
		if len(res.Diagnostics) != 1 || res.Diagnostics[0].Code != codeConsentStoreFailed {
			t.Fatalf("diagnostics = %+v", res.Diagnostics)
		}
		if !bytes.Equal(before, h.targetBytes(t)) {
			t.Fatal("a failed grant still published the configuration")
		}
	})

	t.Run("save failure after a recorded grant", func(t *testing.T) {
		h := newApplyHarness(t, applyTargetConfigJSON)
		req := h.request(t, remoteAgentRoute())
		token := h.challenge(t, req)
		before := h.targetBytes(t)

		dir := filepath.Dir(h.path)
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Fatalf("chmod target dir: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

		res := h.confirm(t, token, req)
		if res.Status != "diagnostics" || res.ConsentOutcome != consentRecorded {
			t.Fatalf("res = %+v, want diagnostics/recorded", res)
		}
		if len(res.Diagnostics) != 1 || res.Diagnostics[0].Code != codeConfigSaveFailed {
			t.Fatalf("diagnostics = %+v", res.Diagnostics)
		}
		if !h.svc.consent.Has(remoteApplyDestination().Digest) {
			t.Fatal("the grant was not durable")
		}
		if !bytes.Equal(before, h.targetBytes(t)) {
			t.Fatal("a failed save changed the target")
		}
	})
}

// TestSaveOutcomeClassification: the three save-layer codes never reach
// actionDiagnostics — §5.6 turns them into a conflict, an applied warning, and
// a config_save_failed diagnostic respectively.
func TestSaveOutcomeClassification(t *testing.T) {
	cases := []struct {
		name        string
		err         error
		wantWarning string
		wantStatus  string
		wantCode    string
	}{
		{name: "published", err: nil},
		{name: "durability uncertain",
			err:         fmt.Errorf("wrapped: %w", config.ErrDurabilityUncertain),
			wantWarning: "durability_uncertain"},
		{name: "revision conflict", err: fmt.Errorf("wrapped: %w", config.ErrRevisionConflict),
			wantStatus: "conflict"},
		{name: "target exists", err: targetExistsError(t), wantStatus: "conflict"},
		{name: "io", err: errors.New("disk on fire"), wantStatus: "diagnostics",
			wantCode: codeConfigSaveFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			warning, refusal := saveOutcome(tc.err)
			if warning != tc.wantWarning {
				t.Fatalf("warning = %q, want %q", warning, tc.wantWarning)
			}
			if tc.wantStatus == "" {
				if refusal != nil {
					t.Fatalf("refusal = %+v, want none", *refusal)
				}
				return
			}
			if refusal == nil {
				t.Fatalf("no refusal, want %q", tc.wantStatus)
			}
			if err := validateSettingsApplyResult(*refusal); err != nil {
				t.Fatalf("refusal is not contract-valid: %v (%+v)", err, *refusal)
			}
			if refusal.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", refusal.Status, tc.wantStatus)
			}
			if refusal.Status == "conflict" && refusal.Conflict != "target" {
				t.Fatalf("conflict = %q, want target", refusal.Conflict)
			}
			if tc.wantCode != "" &&
				(len(refusal.Diagnostics) != 1 || refusal.Diagnostics[0].Code != tc.wantCode) {
				t.Fatalf("diagnostics = %+v, want %q", refusal.Diagnostics, tc.wantCode)
			}
		})
	}
}

// targetExistsError produces a real upstream target_exists failure rather than
// a hand-built one, so the classification is pinned to the API's own error.
func targetExistsError(t *testing.T) error {
	t.Helper()
	doc, err := config.NewDocument(config.BootstrapSpec{
		ProviderName: "ollama",
		Provider:     config.ProviderSpec{BaseURL: "http://localhost:11434"},
		Role:         "agent-m",
		Model: config.ModelSpec{Name: "m", Type: "dense",
			Capabilities: []string{"chat", "stream", "tool_call"}},
	}, config.DocumentOptions{})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	path := writeAgentConfigBody(t, applyTargetConfigJSON)
	err = doc.SaveNew(path)
	if err == nil {
		t.Fatal("SaveNew over an existing file must fail")
	}
	return err
}

// TestSettingsWritePublicationRetiresRunners: the barrier is held through save,
// snapshot publication, AND runner retirement, so no cached runner survives a
// configuration change.
func TestSettingsWritePublicationRetiresRunners(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	runner := &fakeRunner{}
	conv := h.svc.conversationFor("cached-runner")
	conv.mu.Lock()
	conv.runner = &runnerRecord{runner: runner}
	conv.mu.Unlock()

	res, err := h.svc.ApplySettings(h.request(t, localAgentRoute()))
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	if res.Status != "applied" {
		t.Fatalf("res = %+v, want applied", res)
	}
	if runner.closedCount() != 1 {
		t.Fatalf("cached runner closed %d times, want 1", runner.closedCount())
	}
	conv.mu.Lock()
	cached := conv.runner
	conv.mu.Unlock()
	if cached != nil {
		t.Fatal("a retired runner is still cached")
	}
}

// TestCreateSettingsPublishesTheBootstrapTarget: Create establishes the user
// config destination itself and relies on SaveNew for create-only 0600.
func TestCreateSettingsPublishesTheBootstrapTarget(t *testing.T) {
	h := newApplyHarness(t, "")
	res, err := h.svc.CreateSettings(bootstrapRequest())
	if err != nil {
		t.Fatalf("CreateSettings: %v", err)
	}
	if err := validateSettingsApplyResult(res); err != nil {
		t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
	}
	if res.Status != "applied" {
		t.Fatalf("res = %+v, want applied", res)
	}
	path := mustCreateTargetPath(t)
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("created target: %v", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("created target mode = %v", info.Mode())
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("created parent: %v", err)
	}
	if parent.Mode().Perm()&0o077 != 0 {
		t.Fatalf("created parent mode = %v", parent.Mode())
	}
	if res.Projection.State != "ready" || res.Projection.SourceOrigin != "user_config" {
		t.Fatalf("projection = %+v", *res.Projection)
	}
}

// TestCreateSettingsRefusesUnsafeTargets: a target discovery cannot see is
// still a target, and a parent that is not a real private directory is not a
// place Firn establishes a configuration.
func TestCreateSettingsRefusesUnsafeTargets(t *testing.T) {
	t.Run("existing target discovery cannot see", func(t *testing.T) {
		h := newApplyHarness(t, "")
		path := mustCreateTargetPath(t)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("parent: %v", err)
		}
		if err := os.Symlink(filepath.Join(t.TempDir(), "absent.json"), path); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		res, err := h.svc.CreateSettings(bootstrapRequest())
		if err != nil {
			t.Fatalf("CreateSettings: %v", err)
		}
		if err := validateSettingsApplyResult(res); err != nil {
			t.Fatalf("result is not contract-valid: %v (%+v)", err, res)
		}
		if res.Status != "conflict" || res.Conflict != "target" {
			t.Fatalf("res = %+v, want conflict:target", res)
		}
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("the dangling symlink was replaced: %v %v", info, err)
		}
	})

	t.Run("symlinked parent", func(t *testing.T) {
		h := newApplyHarness(t, "")
		path := mustCreateTargetPath(t)
		elsewhere := t.TempDir()
		if err := os.MkdirAll(filepath.Dir(filepath.Dir(path)), 0o700); err != nil {
			t.Fatalf("grandparent: %v", err)
		}
		if err := os.Symlink(elsewhere, filepath.Dir(path)); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		res, err := h.svc.CreateSettings(bootstrapRequest())
		if err != nil {
			t.Fatalf("CreateSettings: %v", err)
		}
		if res.Status != "diagnostics" || len(res.Diagnostics) != 1 ||
			res.Diagnostics[0].Code != codeConfigSaveFailed {
			t.Fatalf("res = %+v, want config_save_failed diagnostics", res)
		}
		if _, err := os.Lstat(filepath.Join(elsewhere, "models.json")); err == nil {
			t.Fatal("a configuration was written through the symlinked parent")
		}
	})
}

// bootstrapRequest is the fixed blank bootstrap: one provider plus the agent
// route that references it, which is exactly what NewDocument consumes.
func bootstrapRequest() SettingsApplyRequest {
	return SettingsApplyRequest{
		Source: ApplySource{Kind: applySourceBlank},
		Changes: []Change{
			{Kind: changeKindProviderAdd, Name: "ollama", Endpoint: stringPtr("http://localhost:11434")},
			routeChange(useCaseAgent, "ollama", "bootstrap-model", "chat", "stream", "tool_call"),
		},
		Keys: map[string]string{},
	}
}

func mustCreateTargetPath(t *testing.T) string {
	t.Helper()
	path, err := createTargetPath()
	if err != nil {
		t.Fatalf("create target path: %v", err)
	}
	return path
}

// TestReloadSettingsDoesNotConsumeASettingsChallenge: reload is not a consent
// decision — only Cancel, expiry, or a terminal Confirm invalidates a token.
func TestReloadSettingsDoesNotConsumeASettingsChallenge(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	req := h.request(t, remoteAgentRoute())
	token := h.challenge(t, req)

	res, err := h.svc.ReloadSettings()
	if err != nil || res.Busy {
		t.Fatalf("ReloadSettings: %+v %v", res, err)
	}
	confirmed := h.confirm(t, token, req)
	if confirmed.Status != "applied" {
		t.Fatalf("confirm after reload = %+v, want applied", confirmed)
	}
}

// TestSettingsWriteConcurrency: Apply, Confirm, Reload, Cancel, and Close run
// simultaneously. The barrier must serialize them into contract-valid results
// with no torn target — the race detector checks the rest.
func TestSettingsWriteConcurrency(t *testing.T) {
	h := newApplyHarness(t, applyTargetConfigJSON)
	req := h.request(t, remoteAgentRoute())
	token := h.challenge(t, req)

	other := h.request(t, localAgentRoute()) // built here: no t call runs in a goroutine
	var wg sync.WaitGroup
	results := make(chan SettingsApplyResult, 2)
	start := make(chan struct{}) // release all five at once
	wg.Add(5)
	go func() {
		defer wg.Done()
		<-start
		res, err := h.svc.ApplySettings(other)
		if err == nil {
			results <- res
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		res, err := h.svc.ConfirmSettingsApply(ConfirmSettingsApplyRequest{ChallengeToken: token, Request: req})
		if err == nil {
			results <- res
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		_, _ = h.svc.ReloadSettings()
	}()
	go func() {
		defer wg.Done()
		<-start
		h.svc.CancelSettingsApply(token)
	}()
	go func() {
		defer wg.Done()
		<-start
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := h.svc.Close(ctx); err != nil {
			t.Errorf("concurrent Close: %v", err)
		}
	}()
	close(start)
	wg.Wait()
	close(results)
	for res := range results {
		if err := validateSettingsApplyResult(res); err != nil {
			t.Fatalf("concurrent result is not contract-valid: %v (%+v)", err, res)
		}
	}
	// Whatever landed, the target is one complete document.
	if _, err := loadDefaultAgentConfig(); err != nil {
		t.Fatalf("target no longer loads: %v", err)
	}
}
