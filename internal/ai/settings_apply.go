package ai

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/profiles"
	"github.com/kstruzzieri/go-llm/provider"
)

// The closed settings WRITE transport (spec §5.6). Requests are the trust
// boundary: everything below decodes strictly (unknown field, unknown union
// member, or explicit null is a rejection, never a silently dropped value) and
// validates against the same bounds the read-only projection uses. The shared
// corpus in testdata/settings_apply_contract keeps this and
// frontend/src/types/golemConfig.ts byte-identical.
//
// Key VALUES cross frontend -> backend inside SettingsApplyRequest.Keys and
// nowhere else. No result type below has a member that can carry one.

const (
	// maxApplyKeyValueBytes bounds an API key value (§5.6: 1..4096 UTF-8
	// bytes). Everything else reuses the projection bounds so one change can
	// never move a limit on only one side of the boundary.
	maxApplyKeyValueBytes = 4096
	// maxChallengeTokenBytes bounds the opaque consent-challenge token.
	maxChallengeTokenBytes = 256
	// maxModelFactNumber is the §5.6 numeric-fact ceiling (int32 max).
	maxModelFactNumber = 2147483647
)

// Change kinds. The set is closed: an unknown kind is a contract break.
const (
	changeKindRoute            = "route"
	changeKindRouteUnassign    = "route-unassign"
	changeKindProviderAdd      = "provider-add"
	changeKindProviderUpdate   = "provider-update"
	changeKindProviderRemove   = "provider-remove"
	changeKindProviderKeySet   = "provider-key-set"
	changeKindProviderKeyClear = "provider-key-clear"
	changeKindRoleRemove       = "role-remove"
)

var changeKinds = map[string]bool{
	changeKindRoute: true, changeKindRouteUnassign: true,
	changeKindProviderAdd: true, changeKindProviderUpdate: true,
	changeKindProviderRemove: true, changeKindProviderKeySet: true,
	changeKindProviderKeyClear: true, changeKindRoleRemove: true,
}

// Stable change-identity namespaces (spec §3.3). There are exactly four, and
// they are NOT the change kinds: provider add/update/remove share one provider
// identity, and key set/clear share the independent key identity, so an add and
// a key operation on one provider can coexist.
const (
	identityRoute       = "route"
	identityProvider    = "provider"
	identityProviderKey = "provider-key"
	identityRole        = "role"
)

var changeIdentityNamespaces = map[string]bool{
	identityRoute: true, identityProvider: true,
	identityProviderKey: true, identityRole: true,
}

// Apply source kinds.
const (
	applySourceApplied = "applied"
	applySourceProfile = "profile"
	applySourceBlank   = "blank"
)

// Drop fields (§5.2b): the model-specific members a real retarget would lose.
const (
	dropFieldSlots     = "slots"
	dropFieldThinkTags = "think_tags"
)

var (
	revisionPattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	profileIDPattern = regexp.MustCompile(`^(curated|user)/[a-z0-9][a-z0-9-]{0,63}$`)

	modelFactTypes  = map[string]bool{"dense": true, "moe": true, "embedding": true}
	applyThinkModes = map[string]bool{
		"": true, "none": true, "always": true, "toggle": true, "auto": true,
	}
	applyAPIFormats = map[string]bool{"ollama": true, "openai-compat": true}
)

// Boundary errors are fixed strings. A request field can hold anything the
// frontend sent, so no error below interpolates one: these values reach the
// host log, and §5.4 keeps user content out of it.
var (
	errApplyUnknownKind       = errors.New("settings apply: unknown union member")
	errApplyMissingField      = errors.New("settings apply: required field missing")
	errApplyNullField         = errors.New("settings apply: null is not a value")
	errApplyInvalidField      = errors.New("settings apply: field is out of contract")
	errApplyRevision          = errors.New("settings apply: target revision does not match the call")
	errApplyBounds            = errors.New("settings apply: collection is out of bounds")
	errApplyDuplicateChange   = errors.New("settings apply: duplicate or contradictory change identity")
	errApplyKeyCorrespondence = errors.New("settings apply: keys do not correspond 1:1 with key-set changes")
	errApplyKeyValue          = errors.New("settings apply: key values must be non-empty literals")
)

// applyMode distinguishes the entry points. Apply targets an existing
// document and REQUIRES a target revision; Create establishes a new one and
// forbids both the revision and the applied source. GrantOnly writes no
// document at all — it approves destinations and nothing else, so the
// settings-write path refuses a challenge issued under it.
type applyMode int

const (
	applyModeExisting applyMode = iota
	applyModeCreate
	applyModeGrantOnly
)

// ---------------------------------------------------------------------------
// Presence-preserving scalars. encoding/json cannot otherwise tell an absent
// optional from a typed zero, and the frontend validator can (Object.hasOwn) —
// so the two would disagree on `{"contextWindow": 0}`. An explicit null is a
// rejection, not an absence: the frontend omits what it did not touch.
// ---------------------------------------------------------------------------

type optionalString struct {
	Value string
	Set   bool
}

func (o *optionalString) UnmarshalJSON(data []byte) error {
	if isJSONNull(data) {
		return errApplyNullField
	}
	if err := json.Unmarshal(data, &o.Value); err != nil {
		return err
	}
	o.Set = true
	return nil
}

func (o optionalString) pointer() *string {
	if !o.Set {
		return nil
	}
	value := o.Value
	return &value
}

// optionalStringSlice is the same guarantee for an optional ARRAY member.
// Decoding null straight into a []string silently yields nil — indistinguishable
// from an absent key — so the confirmation arrays would accept null in Go while
// the frontend rejects it.
type optionalStringSlice struct {
	Values []string
	Set    bool
}

func (o *optionalStringSlice) UnmarshalJSON(data []byte) error {
	if isJSONNull(data) {
		return errApplyNullField
	}
	if err := json.Unmarshal(data, &o.Values); err != nil {
		return err
	}
	o.Set = true
	return nil
}

// slice returns nil when absent and the decoded (never nil) array when present,
// so an explicitly empty array stays distinguishable from an omitted one.
func (o optionalStringSlice) slice() []string {
	if !o.Set {
		return nil
	}
	if o.Values == nil {
		return []string{}
	}
	return o.Values
}

// optionalChanges is the same guarantee for the request's changes member.
// Decoding null straight into a []Change silently yields nil —
// indistinguishable from an absent key — and the profile source's empty-set
// exemption then accepted both, while the frontend mirror (readCappedArray)
// rejects them. Null is refused here; absence survives as a nil slice for
// validateSettingsApplyRequest to refuse, where absence is still visible.
type optionalChanges struct {
	Values []Change
	Set    bool
}

func (o *optionalChanges) UnmarshalJSON(data []byte) error {
	if isJSONNull(data) {
		return errApplyNullField
	}
	if err := json.Unmarshal(data, &o.Values); err != nil {
		return err
	}
	o.Set = true
	return nil
}

// slice mirrors optionalStringSlice.slice: nil exactly when absent.
func (o optionalChanges) slice() []Change {
	if !o.Set {
		return nil
	}
	if o.Values == nil {
		return []Change{}
	}
	return o.Values
}

type optionalInt struct {
	Value int
	Set   bool
}

func (o *optionalInt) UnmarshalJSON(data []byte) error {
	if isJSONNull(data) {
		return errApplyNullField
	}
	if err := json.Unmarshal(data, &o.Value); err != nil {
		return err
	}
	o.Set = true
	return nil
}

func (o optionalInt) pointer() *int {
	if !o.Set {
		return nil
	}
	value := o.Value
	return &value
}

func isJSONNull(data []byte) bool {
	return string(bytes.TrimSpace(data)) == "null"
}

// strictUnmarshal is the one decode primitive: unknown fields are errors, and
// trailing content after the value is an error too.
func strictUnmarshal(data []byte, target any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return err
	}
	if dec.More() {
		return errApplyInvalidField
	}
	return nil
}

// ---------------------------------------------------------------------------
// Request transport
// ---------------------------------------------------------------------------

// SettingsApplyRequest is the complete staged write. TargetRevision is nil
// exactly when the caller omitted it (Create); Changes and Keys are non-null
// collections.
type SettingsApplyRequest struct {
	TargetRevision *string           `json:"targetRevision,omitempty"`
	Source         ApplySource       `json:"source"`
	Changes        []Change          `json:"changes"`
	Keys           map[string]string `json:"keys"`
}

func (r *SettingsApplyRequest) UnmarshalJSON(data []byte) error {
	var wire struct {
		TargetRevision optionalString    `json:"targetRevision"`
		Source         ApplySource       `json:"source"`
		Changes        optionalChanges   `json:"changes"`
		Keys           map[string]string `json:"keys"`
	}
	if err := strictUnmarshal(data, &wire); err != nil {
		return err
	}
	*r = SettingsApplyRequest{
		TargetRevision: wire.TargetRevision.pointer(),
		Source:         wire.Source,
		Changes:        wire.Changes.slice(),
		Keys:           wire.Keys,
	}
	return nil
}

// ApplySource is the closed source union: the applied document, a stored
// profile at a known revision, or a blank bootstrap.
type ApplySource struct {
	Kind           string `json:"kind"`
	ProfileID      string `json:"profileId,omitempty"`
	SourceRevision string `json:"sourceRevision,omitempty"`
}

func (s *ApplySource) UnmarshalJSON(data []byte) error {
	var probe struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	switch probe.Kind {
	case applySourceApplied, applySourceBlank:
		var wire struct {
			Kind string `json:"kind"`
		}
		if err := strictUnmarshal(data, &wire); err != nil {
			return err
		}
		*s = ApplySource{Kind: wire.Kind}
	case applySourceProfile:
		var wire struct {
			Kind           string `json:"kind"`
			ProfileID      string `json:"profileId"`
			SourceRevision string `json:"sourceRevision"`
		}
		if err := strictUnmarshal(data, &wire); err != nil {
			return err
		}
		*s = ApplySource(wire)
	default:
		return errApplyUnknownKind
	}
	return nil
}

// ModelFacts is a route change's complete model description. The optional
// members are nil exactly when the caller omitted them; upstream reads a nil
// numeric fact as zero.
type ModelFacts struct {
	Provider      string  `json:"provider"`
	Model         string  `json:"model"`
	Type          string  `json:"type"`
	Parameters    *string `json:"parameters,omitempty"`
	ContextWindow *int    `json:"contextWindow,omitempty"`
	Dimensions    *int    `json:"dimensions,omitempty"`
}

func (f *ModelFacts) UnmarshalJSON(data []byte) error {
	var wire struct {
		Provider      string         `json:"provider"`
		Model         string         `json:"model"`
		Type          string         `json:"type"`
		Parameters    optionalString `json:"parameters"`
		ContextWindow optionalInt    `json:"contextWindow"`
		Dimensions    optionalInt    `json:"dimensions"`
	}
	if err := strictUnmarshal(data, &wire); err != nil {
		return err
	}
	*f = ModelFacts{
		Provider: wire.Provider, Model: wire.Model, Type: wire.Type,
		Parameters:    wire.Parameters.pointer(),
		ContextWindow: wire.ContextWindow.pointer(),
		Dimensions:    wire.Dimensions.pointer(),
	}
	return nil
}

// Change is one staged mutation. Only the members its Kind declares are ever
// populated: UnmarshalJSON decodes each variant through its own strict struct,
// so a member borrowed from another variant is an unknown field. Required
// members are enforced at decode time (that is the only place absence and a
// typed zero are still distinguishable); validateChange then enforces value
// rules. The backend never sends a Change to the frontend, so there is no
// matching MarshalJSON.
type Change struct {
	Kind                   string           `json:"kind"`
	UseCase                string           `json:"useCase,omitempty"`
	Role                   string           `json:"role,omitempty"`
	Name                   string           `json:"name,omitempty"`
	Endpoint               *string          `json:"endpoint,omitempty"`
	APIFormat              *string          `json:"apiFormat,omitempty"`
	ModelFacts             *ModelFacts      `json:"modelFacts,omitempty"`
	CapabilityFacts        *CapabilityFacts `json:"capabilityFacts,omitempty"`
	ExposedCaps            []string         `json:"exposedCaps,omitempty"`
	ThinkMode              string           `json:"thinkMode,omitempty"`
	ConfirmUnknown         bool             `json:"confirmUnknown,omitempty"`
	ConfirmUnknownUseCases []string         `json:"confirmUnknownUseCases,omitempty"`
	ConfirmDrops           []string         `json:"confirmDrops,omitempty"`
}

func (c *Change) UnmarshalJSON(data []byte) error {
	var probe struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	switch probe.Kind {
	case changeKindRoute:
		return c.unmarshalRoute(data)
	case changeKindRouteUnassign:
		var wire struct {
			Kind    string `json:"kind"`
			UseCase string `json:"useCase"`
		}
		if err := strictUnmarshal(data, &wire); err != nil {
			return err
		}
		*c = Change{Kind: wire.Kind, UseCase: wire.UseCase}
	case changeKindProviderAdd:
		var wire struct {
			Kind      string         `json:"kind"`
			Name      string         `json:"name"`
			Endpoint  optionalString `json:"endpoint"`
			APIFormat optionalString `json:"apiFormat"`
		}
		if err := strictUnmarshal(data, &wire); err != nil {
			return err
		}
		if !wire.Endpoint.Set {
			return errApplyMissingField
		}
		*c = Change{Kind: wire.Kind, Name: wire.Name,
			Endpoint: wire.Endpoint.pointer(), APIFormat: wire.APIFormat.pointer()}
	case changeKindProviderUpdate:
		var wire struct {
			Kind      string         `json:"kind"`
			Name      string         `json:"name"`
			Endpoint  optionalString `json:"endpoint"`
			APIFormat optionalString `json:"apiFormat"`
		}
		if err := strictUnmarshal(data, &wire); err != nil {
			return err
		}
		*c = Change{Kind: wire.Kind, Name: wire.Name,
			Endpoint: wire.Endpoint.pointer(), APIFormat: wire.APIFormat.pointer()}
	case changeKindProviderRemove, changeKindProviderKeySet, changeKindProviderKeyClear:
		var wire struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		}
		if err := strictUnmarshal(data, &wire); err != nil {
			return err
		}
		*c = Change{Kind: wire.Kind, Name: wire.Name}
	case changeKindRoleRemove:
		var wire struct {
			Kind string `json:"kind"`
			Role string `json:"role"`
		}
		if err := strictUnmarshal(data, &wire); err != nil {
			return err
		}
		*c = Change{Kind: wire.Kind, Role: wire.Role}
	default:
		return errApplyUnknownKind
	}
	return nil
}

func (c *Change) unmarshalRoute(data []byte) error {
	var wire struct {
		Kind                   string              `json:"kind"`
		UseCase                string              `json:"useCase"`
		ModelFacts             *ModelFacts         `json:"modelFacts"`
		CapabilityFacts        *CapabilityFacts    `json:"capabilityFacts"`
		ExposedCaps            []string            `json:"exposedCaps"`
		ThinkMode              *string             `json:"thinkMode"`
		ConfirmUnknown         *bool               `json:"confirmUnknown"`
		ConfirmUnknownUseCases optionalStringSlice `json:"confirmUnknownUseCases"`
		ConfirmDrops           optionalStringSlice `json:"confirmDrops"`
	}
	if err := strictUnmarshal(data, &wire); err != nil {
		return err
	}
	// Every member above without a `?` in §5.6 is required. A nil here is
	// either an absent key or an explicit null; both are contract breaks.
	if wire.ModelFacts == nil || wire.CapabilityFacts == nil || wire.ExposedCaps == nil ||
		wire.ThinkMode == nil || wire.ConfirmUnknown == nil {
		return errApplyMissingField
	}
	*c = Change{
		Kind: wire.Kind, UseCase: wire.UseCase,
		ModelFacts: wire.ModelFacts, CapabilityFacts: wire.CapabilityFacts,
		ExposedCaps: wire.ExposedCaps, ThinkMode: *wire.ThinkMode,
		ConfirmUnknown:         *wire.ConfirmUnknown,
		ConfirmUnknownUseCases: wire.ConfirmUnknownUseCases.slice(),
		ConfirmDrops:           wire.ConfirmDrops.slice(),
	}
	return nil
}

// ConfirmSettingsApplyRequest is Call 2. Call 1 retained no request, so the
// frontend resends the whole thing alongside the opaque challenge token.
type ConfirmSettingsApplyRequest struct {
	ChallengeToken string               `json:"challengeToken"`
	Request        SettingsApplyRequest `json:"request"`
}

func (r *ConfirmSettingsApplyRequest) UnmarshalJSON(data []byte) error {
	var wire struct {
		ChallengeToken string               `json:"challengeToken"`
		Request        SettingsApplyRequest `json:"request"`
	}
	if err := strictUnmarshal(data, &wire); err != nil {
		return err
	}
	*r = ConfirmSettingsApplyRequest(wire)
	return nil
}

// ---------------------------------------------------------------------------
// Result transport. Produced by the backend, validated by
// frontend/src/types/golemConfig.ts; the status decides which members exist.
// ---------------------------------------------------------------------------

// SettingsApplyResult is the closed apply/create/confirm outcome.
type SettingsApplyResult struct {
	Status         string              `json:"status"`
	Projection     *SettingsProjection `json:"projection,omitempty"`
	Warning        string              `json:"warning,omitempty"`
	Challenge      *ApplyChallenge     `json:"challenge,omitempty"`
	Drops          []ChangeDropSet     `json:"drops,omitempty"`
	Conflict       string              `json:"conflict,omitempty"`
	ConsentOutcome string              `json:"consentOutcome,omitempty"`
	Diagnostics    []Diagnostic        `json:"diagnostics,omitempty"`
}

// ApplyChallenge is the consent handshake. The token is opaque and single-use;
// the record behind it holds no document, path, or key. Destinations lists
// every NEW remote destination the write would open, digest-sorted (spec D8).
// Present iff the result status is consent_required.
type ApplyChallenge struct {
	Token        string             `json:"token"`
	ExpiresAt    int64              `json:"expiresAt"`
	Destinations []ApplyDestination `json:"destinations"`
}

// ApplyDestination is the bounded egress identity shown in the consent
// prompt — never an API key, never a path. Classification is always "remote"
// (local destinations never challenge). Provenance names the routing hops
// that reach it ("agent", "agent (recommendation)"); Model is empty when the
// hop names a provider and no model.
type ApplyDestination struct {
	Provider       string   `json:"provider"`
	Model          string   `json:"model"`
	Endpoint       string   `json:"endpoint"`
	Classification string   `json:"classification"`
	Provenance     []string `json:"provenance"`
}

// ChangeDropSet names one staged change and the model-specific fields a real
// retarget would drop. ChangeID is the §3.3 stable identity (changeStableID).
type ChangeDropSet struct {
	ChangeID string   `json:"changeId"`
	Fields   []string `json:"fields"`
}

// CancelSettingsApplyResult has exactly one success variant; cancel is
// idempotent, so an absent or expired token is already cancelled.
type CancelSettingsApplyResult struct {
	Status string `json:"status"`
}

// DestinationGrantsResult is the closed result of the grant-only approval
// flow (spec D13). It approves destinations and authorizes NO document write,
// so it carries no projection, no diagnostics, and no conflict kind: the
// status alone says what happened.
//
//	none             nothing to approve — no configuration, or every remote
//	                 the agent route reaches is already granted
//	consent_required the challenge below lists what would be opened
//	granted          the whole approved batch is durably recorded
//	uncertain        the batch write failed; see ConsentStore.GrantMany
//	conflict         the token is unknown, expired, cancelled, issued by the
//	                 settings-write flow, or no longer describes the ACTIVE
//	                 configuration
//	busy             a turn is running; nothing was consumed, retry the token
//	unavailable      consent storage cannot authorize or record anything
//	config_invalid   the active configuration could not be loaded
//
// Challenge is present iff Status is consent_required.
type DestinationGrantsResult struct {
	Status    string          `json:"status"`
	Challenge *ApplyChallenge `json:"challenge,omitempty"`
}

// ProfileDraftProjection is a profile preview: the settings projection minus
// sourceOrigin and revision, always credential-free.
type ProfileDraftProjection struct {
	State       string               `json:"state"`
	ReadOnly    bool                 `json:"readOnly"`
	Editable    bool                 `json:"editable"`
	Routes      []RouteProjection    `json:"routes"`
	Models      []ModelProjection    `json:"models"`
	Providers   []ProviderProjection `json:"providers"`
	Diagnostics []Diagnostic         `json:"diagnostics"`
}

// ProfileDiagnostic is the closed profile-store finding. Paths never cross.
type ProfileDiagnostic struct {
	Code      string `json:"code"`
	ProfileID string `json:"profileId,omitempty"`
}

// GolemProfileLoadResult carries a draft preview plus the provenance the
// frontend needs to stage a profile-source Apply.
type GolemProfileLoadResult struct {
	Status         string                  `json:"status"`
	ProfileID      string                  `json:"profileId,omitempty"`
	SourceRevision string                  `json:"sourceRevision,omitempty"`
	Projection     *ProfileDraftProjection `json:"projection,omitempty"`
	Diagnostics    []ProfileDiagnostic     `json:"diagnostics,omitempty"`
}

// ---------------------------------------------------------------------------
// Profile source (§5.3). One loader serves both the preview and the Apply, so
// no caller can ever hold a profile Document that has not been scrubbed.
// ---------------------------------------------------------------------------

// profileEnvSentinel is the fixed, non-secret value the profile loader
// substitutes for EVERY ${NAME} api_key reference a profile authors. Its whole
// purpose is to let a reference PARSE — an unresolved one is refused during
// construction, and a profile Firn cannot even open is a profile Firn cannot
// preview or sanitize. The document is scrubbed before anything reads it back,
// so the substituted value is never projected, saved, or applied. It is
// deliberately not os.LookupEnv: reading the real variable would materialize a
// live secret Firn has no use for (§5.3 — "without obtaining a secret"), and
// the expansion is discarded either way. Malformed references still fail:
// go-llm rejects them before the lookup runs.
const profileEnvSentinel = "firn-profile-env-sentinel"

// profileStoreOptions is the §5.3 sanitization seam threaded into every profile
// Document the store parses.
func profileStoreOptions() config.DocumentOptions {
	return config.DocumentOptions{
		LookupEnv: func(string) (string, bool) { return profileEnvSentinel, true },
	}
}

// profileStoreCodes maps the store's bounded error vocabulary onto the §5.6
// profile diagnostic codes, which are deliberately like-named. The two codes a
// save resolves differently — conflict becomes a conflict result and
// durability_uncertain becomes a warning — are absent here, so anything
// unmapped (including a raw context cancellation, for which CodeOf reports
// nothing) falls through to "io" rather than inventing copy.
var profileStoreCodes = map[profiles.ErrorCode]string{
	profiles.CodeInvalidID:       "invalid_id",
	profiles.CodeNotFound:        "not_found",
	profiles.CodeCuratedReadOnly: "curated_read_only",
	profiles.CodeStoreUnsafe:     "store_unsafe",
	profiles.CodeIO:              "io",
	profiles.CodeConfigInvalid:   "config_invalid",
}

// loadProfileDocument freshly loads one profile and returns it already stripped
// of every provider credential, together with the RAW source revision captured
// before the scrub. Load and scrub are one step on purpose: no caller can
// obtain a profile Document whose keys are still present, so the §5.3 ordering
// rule (clear before any Config()/projection access) cannot be violated by a
// future caller that forgets it. The returned code is "" on success and
// otherwise a §5.6 profile diagnostic code; a read-only document is
// config_invalid, because the scrub is a mutation and a document that refuses
// every mutation cannot be sanitized at all.
func loadProfileDocument(ctx context.Context, id string) (doc *config.Document, revision string, code string) {
	store, err := profiles.DefaultStoreWithOptions(profileStoreOptions())
	if err != nil {
		// The user config directory could not be resolved; there is no store.
		return nil, "", "io"
	}
	doc, err = store.Load(ctx, profiles.ID(id))
	if err != nil {
		mapped, ok := profileStoreCodes[profiles.CodeOf(err)]
		if !ok {
			mapped = "io"
		}
		return nil, "", mapped
	}
	revision = doc.Revision()
	if err := doc.ClearAllProviderAPIKeys(); err != nil {
		return nil, "", "config_invalid"
	}
	return doc, revision, ""
}

// LoadGolemProfile returns the §5.6 closed load result: a credential-free draft
// preview plus the provenance a profile-origin Apply must send back. Slice B
// calls it only for the fixed curated bootstrap; the loader itself is the one
// profile-loading path, so Slice C's selector adds no second one.
func LoadGolemProfile(ctx context.Context, id string) GolemProfileLoadResult {
	doc, revision, code := loadProfileDocument(ctx, id)
	if code != "" {
		d := ProfileDiagnostic{Code: code}
		// The id rides along only when it is one — an id the contract rejects
		// is exactly the one that must not be echoed as a ProfileID.
		if validProfileID(id) {
			d.ProfileID = id
		}
		return GolemProfileLoadResult{Status: "diagnostics", Diagnostics: []ProfileDiagnostic{d}}
	}
	// First read of the document, and it is already scrubbed. ReadOnly stays
	// false by construction: a read-only document could not have been scrubbed.
	p := buildSettingsProjection(loadedAgentConfig{Config: doc.Config(), Revision: revision}, nil)
	return GolemProfileLoadResult{
		Status: "loaded", ProfileID: id, SourceRevision: revision,
		Projection: &ProfileDraftProjection{
			State: p.State, ReadOnly: p.ReadOnly, Editable: p.Editable,
			Routes: p.Routes, Models: p.Models, Providers: p.Providers,
			Diagnostics: p.Diagnostics,
		},
	}
}

// profileSourceDocument is the profile branch of the shared preparation
// pipeline: repeat the load, compare the source's OWN revision (independent of
// the target's), and refuse a source Firn cannot write from. The staged changes
// then run against the scrubbed document, so a profile Apply clears every
// active credential unless the same request restages a literal replacement.
func profileSourceDocument(ctx context.Context, req SettingsApplyRequest) (*config.Document, map[string]bool, *SettingsApplyResult) {
	doc, revision, code := loadProfileDocument(ctx, req.Source.ProfileID)
	switch code {
	case "":
	case "invalid_id":
		// Unreachable while validateApplySource and the store share one id
		// shape, but §5.6 names the mapping, so it is stated rather than
		// collapsed into the unavailable bucket.
		return nil, nil, blockingDiagnostics(Diagnostic{Code: codeInvalidArgument})
	case "not_found":
		return nil, nil, conflictProfileSource()
	case "config_invalid":
		return nil, nil, blockingDiagnostics(Diagnostic{Code: codeConfigInvalid})
	default:
		// store_unsafe, io, and anything unmapped: the store itself, not the
		// profile, is what failed.
		return nil, nil, blockingDiagnostics(Diagnostic{Code: codeProfileSourceUnavailable})
	}
	if revision != req.Source.SourceRevision {
		return nil, nil, conflictProfileSource()
	}
	// The source carries every mutation this Apply makes, so it faces the same
	// two write gates the active target faces (§5.2) — recomputed here on the
	// document as it is right now, never on what the draft preview reported.
	p := buildSettingsProjection(loadedAgentConfig{Config: doc.Config(), Revision: revision}, nil)
	if p.State != "ready" {
		return nil, nil, limitedResult(p.Diagnostics)
	}
	return doc, nil, nil
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

// validRequestIdentifier is the §5.6 Identifier rule, measured the same way
// the projection measures it: non-empty, at most maxProjectionIdentifierLen
// UTF-8 BYTES, and free of Cc/Cf runes. sanitizeIdentifier is the single
// definition of that rune set, so an identifier survives it unchanged exactly
// when it is safe to emit.
func validRequestIdentifier(value string) bool {
	return value != "" && len(value) <= maxProjectionIdentifierLen &&
		sanitizeIdentifier(value) == value
}

// validRequestEndpoint bounds an authored endpoint. It stays ASCII for the
// same reason the projection's does: a non-ASCII host is a homoglyph risk and
// is never resolvable as authored (punycode is the supported form).
func validRequestEndpoint(value string) bool {
	if value == "" || len(value) > maxProjectionEndpointLen {
		return false
	}
	return !strings.ContainsFunc(value, func(r rune) bool {
		return r < 0x20 || r > 0x7E
	})
}

func validRevision(value string) bool { return revisionPattern.MatchString(value) }

func validProfileID(value string) bool { return profileIDPattern.MatchString(value) }

// validKeyValue: 1..4096 UTF-8 bytes and literal-only. A value containing
// "${" is refused backend-side even though go-llm would expand it — Firn
// stages literals, and an environment reference here would be a credential
// the user cannot see.
func validKeyValue(value string) bool {
	return value != "" && len(value) <= maxApplyKeyValueBytes && !strings.Contains(value, "${")
}

// canonicalCapabilityNames reports whether values are known capability names
// in canonical order with no duplicates. A nil or empty list is canonical;
// callers check presence separately.
func canonicalCapabilityNames(values []string) bool {
	previous := -1
	for _, value := range values {
		index := slices.Index(provider.CanonicalCapabilityNames, value)
		if index <= previous {
			return false
		}
		previous = index
	}
	return true
}

// capabilitySubset reports whether every entry of values appears in known
// (§5.6 `caps ⊆ knownCaps`).
func capabilitySubset(values, known []string) bool {
	for _, value := range values {
		if !slices.Contains(known, value) {
			return false
		}
	}
	return true
}

// canonicalDropFields: non-empty, unique, ascending, drawn from the closed
// drop vocabulary. Ascending byte order puts "slots" before "think_tags".
func canonicalDropFields(values []string) bool {
	if len(values) == 0 || len(values) > 2 {
		return false
	}
	for i, value := range values {
		if value != dropFieldSlots && value != dropFieldThinkTags {
			return false
		}
		if i > 0 && values[i-1] >= value {
			return false
		}
	}
	return true
}

// sortedUniqueIdentifiers: every entry is an Identifier, strictly ascending in
// UTF-8 byte order, and the list is within the collection bound.
func sortedUniqueIdentifiers(values []string) bool {
	if len(values) == 0 || len(values) > maxProjectionEntries {
		return false
	}
	for i, value := range values {
		if !validRequestIdentifier(value) {
			return false
		}
		if i > 0 && values[i-1] >= value {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

// validateSettingsApplyRequest enforces every §5.6 request rule that survives
// decoding: entry-point rules, bounds, value contracts, stable-identity
// uniqueness, and the exact key-set/keys bijection. Semantic feasibility
// (does the role exist, does the model meet the floor) belongs to the
// preparation pipeline, not here.
func validateSettingsApplyRequest(req SettingsApplyRequest, mode applyMode) error {
	if err := validateApplySource(req.Source, mode); err != nil {
		return err
	}
	switch mode {
	case applyModeExisting:
		if req.TargetRevision == nil || !validRevision(*req.TargetRevision) {
			return errApplyRevision
		}
	case applyModeCreate:
		if req.TargetRevision != nil {
			return errApplyRevision
		}
	}
	// Both collections are PRESENT, non-null, and bounded — the frontend
	// mirror (readCappedArray) rejects a null or absent member, so a nil
	// slice here is a missing member, never an empty set.
	if req.Changes == nil || len(req.Changes) > maxProjectionEntries {
		return errApplyBounds
	}
	// An empty change set is a write only from a profile source: the loaded,
	// scrubbed profile document IS the change (§3.3 makes a source replacement
	// dirty on its own, and §5.2's "apply all remaining mutations" is
	// well-formed at zero). An applied source with no change asks for nothing,
	// and a blank one cannot form a BootstrapSpec.
	if len(req.Changes) == 0 && req.Source.Kind != applySourceProfile {
		return errApplyBounds
	}
	if req.Keys == nil || len(req.Keys) > maxProjectionEntries {
		return errApplyBounds
	}
	for name, value := range req.Keys {
		if !validRequestIdentifier(name) {
			return errApplyInvalidField
		}
		if !validKeyValue(value) {
			return errApplyKeyValue
		}
	}

	identities := map[string]bool{}
	keySets := map[string]bool{}
	removedProviders := map[string]bool{}
	keyedProviders := map[string]bool{}
	for _, change := range req.Changes {
		if err := validateChange(change); err != nil {
			return err
		}
		id := changeStableID(change)
		if identities[id] {
			return errApplyDuplicateChange
		}
		identities[id] = true
		switch change.Kind {
		case changeKindProviderRemove:
			removedProviders[change.Name] = true
		case changeKindProviderKeySet:
			keySets[change.Name] = true
			keyedProviders[change.Name] = true
		case changeKindProviderKeyClear:
			keyedProviders[change.Name] = true
		}
	}
	// Removing a provider and touching its key in the same Apply contradict:
	// the key operation would target an entity this same request deletes.
	for name := range removedProviders {
		if keyedProviders[name] {
			return errApplyDuplicateChange
		}
	}
	// Exact 1:1 correspondence: every provider-key-set carries exactly one
	// key value, and no other change (and no stray entry) may carry one.
	if len(keySets) != len(req.Keys) {
		return errApplyKeyCorrespondence
	}
	for name := range keySets {
		if _, ok := req.Keys[name]; !ok {
			return errApplyKeyCorrespondence
		}
	}
	return nil
}

func validateApplySource(source ApplySource, mode applyMode) error {
	switch source.Kind {
	case applySourceApplied:
		// Create establishes a document that does not exist yet, so there is
		// no applied source to copy from.
		if mode == applyModeCreate {
			return errApplyUnknownKind
		}
	case applySourceBlank:
	case applySourceProfile:
		if !validProfileID(source.ProfileID) || !validRevision(source.SourceRevision) {
			return errApplyInvalidField
		}
		return nil
	default:
		return errApplyUnknownKind
	}
	if source.ProfileID != "" || source.SourceRevision != "" {
		return errApplyInvalidField
	}
	return nil
}

// changeStableID is the §3.3 stable change identity — `<namespace>:<identity>`
// over exactly the four namespaces above. It is the one identity vocabulary:
// duplicate/contradiction detection keys on it, and the drop sets a preparation
// pipeline reports name changes with it (one id per semantic target, never one
// per change kind). Splitting on the FIRST ":" recovers the namespace exactly,
// because no namespace contains one.
func changeStableID(change Change) string {
	switch change.Kind {
	case changeKindRoute, changeKindRouteUnassign:
		return identityRoute + ":" + change.UseCase
	case changeKindProviderAdd, changeKindProviderUpdate, changeKindProviderRemove:
		return identityProvider + ":" + change.Name
	case changeKindProviderKeySet, changeKindProviderKeyClear:
		return identityProviderKey + ":" + change.Name
	case changeKindRoleRemove:
		return identityRole + ":" + change.Role
	}
	// Unreachable: validateChange rejects an unknown kind first.
	return ""
}

func validateChange(change Change) error {
	switch change.Kind {
	case changeKindRoute:
		return validateRouteChange(change)
	case changeKindRouteUnassign:
		if !validRequestIdentifier(change.UseCase) {
			return errApplyInvalidField
		}
	case changeKindProviderAdd:
		if !validRequestIdentifier(change.Name) ||
			change.Endpoint == nil || !validRequestEndpoint(*change.Endpoint) {
			return errApplyInvalidField
		}
		if change.APIFormat != nil && !applyAPIFormats[*change.APIFormat] {
			return errApplyInvalidField
		}
	case changeKindProviderUpdate:
		if !validRequestIdentifier(change.Name) {
			return errApplyInvalidField
		}
		// An update that touches nothing is not a change.
		if change.Endpoint == nil && change.APIFormat == nil {
			return errApplyMissingField
		}
		if change.Endpoint != nil && !validRequestEndpoint(*change.Endpoint) {
			return errApplyInvalidField
		}
		if change.APIFormat != nil && !applyAPIFormats[*change.APIFormat] {
			return errApplyInvalidField
		}
	case changeKindProviderRemove, changeKindProviderKeySet, changeKindProviderKeyClear:
		if !validRequestIdentifier(change.Name) {
			return errApplyInvalidField
		}
	case changeKindRoleRemove:
		if !validRequestIdentifier(change.Role) {
			return errApplyInvalidField
		}
	default:
		return errApplyUnknownKind
	}
	return nil
}

func validateRouteChange(change Change) error {
	if !validRequestIdentifier(change.UseCase) || !applyThinkModes[change.ThinkMode] {
		return errApplyInvalidField
	}
	if change.ModelFacts == nil || change.CapabilityFacts == nil || change.ExposedCaps == nil {
		return errApplyMissingField
	}
	// An empty exposure is a break, not a clear: overrideCapabilities would
	// hand upstream a nil override and the model's capabilities would derive
	// from its type again — never the empty set the client showed.
	if len(change.ExposedCaps) == 0 {
		return errApplyInvalidField
	}
	facts := *change.ModelFacts
	if !validRequestIdentifier(facts.Provider) || !validRequestIdentifier(facts.Model) ||
		!modelFactTypes[facts.Type] {
		return errApplyInvalidField
	}
	if facts.Parameters != nil && !validRequestIdentifier(*facts.Parameters) {
		return errApplyInvalidField
	}
	for _, number := range []*int{facts.ContextWindow, facts.Dimensions} {
		if number != nil && (*number < 1 || *number > maxModelFactNumber) {
			return errApplyInvalidField
		}
	}
	caps := *change.CapabilityFacts
	if caps.Caps == nil || caps.KnownCaps == nil {
		return errApplyMissingField
	}
	if !canonicalCapabilityNames(caps.Caps) || !canonicalCapabilityNames(caps.KnownCaps) ||
		!canonicalCapabilityNames(change.ExposedCaps) {
		return errApplyInvalidField
	}
	if !capabilitySubset(caps.Caps, caps.KnownCaps) ||
		!capabilitySubset(change.ExposedCaps, caps.KnownCaps) {
		return errApplyInvalidField
	}
	// Confirmation arrays are omitted when empty and must otherwise be the
	// exact backend-derived set; shape is checked here, equality when the
	// preparation pipeline knows what it derived.
	if change.ConfirmUnknownUseCases != nil && !sortedUniqueIdentifiers(change.ConfirmUnknownUseCases) {
		return errApplyInvalidField
	}
	if change.ConfirmDrops != nil && !canonicalDropFields(change.ConfirmDrops) {
		return errApplyInvalidField
	}
	return nil
}

// validateConfirmSettingsApplyRequest validates Call 2: an opaque bounded
// token plus the complete original request, revalidated in the mode the
// challenge was issued for.
func validateConfirmSettingsApplyRequest(req ConfirmSettingsApplyRequest, mode applyMode) error {
	if !validChallengeTokenShape(req.ChallengeToken) {
		return errApplyInvalidField
	}
	return validateSettingsApplyRequest(req.Request, mode)
}

// ---------------------------------------------------------------------------
// Preparation pipeline (spec §5.2, Call 1).
//
// ONE function serves Apply and Confirm: fresh-load the active target, compare
// its independent CAS token, build the source document, run every staged
// mutation in the dependency-safe order, and check Firn's floors and
// projection bounds. It returns the prepared document plus non-secret
// metadata, or the exact result the caller returns verbatim.
//
// It NEVER writes bytes and NEVER retains prepared state: Call 2 re-runs the
// whole thing from fresh reads, which is the only reliable way to keep the two
// validation paths from drifting.
// ---------------------------------------------------------------------------

// The §5.6 consent outcomes. `unchanged` is the value before any new Grant is
// attempted — preparation never grants, so it is the only one preparation can
// report. `recorded` follows a successful Grant and `uncertain` a failed one,
// whose atomic writer may have renamed bytes before failing.
const (
	consentUnchanged = "unchanged"
	consentRecorded  = "recorded"
	consentUncertain = "uncertain"
)

// settingsWriteTarget is the authorized identity of the file a prepared write
// would replace: the canonical (symlink-free) path the document was actually
// read from, the discovery branch that selected it, and the revision that was
// compared. The path is backend-only and never crosses the Wails boundary
// (§5.4). Create carries the fixed bootstrap destination with no revision —
// there is no document to compare against yet.
type settingsWriteTarget struct {
	path     string
	origin   sourceOrigin
	revision string
}

// identityDigest is the canonical identity of the file a write would publish:
// the discovery branch plus the canonical path, and nothing else. A consent
// challenge retains this digest instead of the path, so a token issued for one
// file can never authorize a write to another — and no path is retained.
func (t settingsWriteTarget) identityDigest() string {
	return sha256Hex([]byte(string(t.origin) + "\x00" + t.path))
}

// createTargetPath is the fixed Create destination. Create is offered only for
// config_missing, which under the current discovery order means $GO_LLM_CONFIG
// is unset and no candidate exists — so the file to establish is always the
// platform user config location (§5.2).
func createTargetPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "go-llm", "models.json"), nil
}

// preparedSettingsApply is one non-writing preparation outcome: the complete
// mutated document plus the metadata the save and consent steps need. prior is
// the freshly loaded active config as it was BEFORE the mutations (nil for
// Create), so the caller can resolve the pre- and post-apply destinations.
type preparedSettingsApply struct {
	doc    *config.Document
	target settingsWriteTarget
	prior  *config.Config
}

func prepareSettingsApply(ctx context.Context, req SettingsApplyRequest, mode applyMode) (*preparedSettingsApply, *SettingsApplyResult) {
	// The request is the trust boundary and Confirm resends it in full, so
	// both entry points revalidate here rather than trusting Call 1's verdict.
	if err := validateSettingsApplyRequest(req, mode); err != nil {
		// A bad key VALUE earns its own code. The editor pre-checks the rule, so
		// a request that still carries one came from a caller that bypassed the
		// UI, and "API keys must be non-empty literal values" is the answer they
		// need. Every other boundary break stays the deliberately opaque
		// invalid_argument: the request is a trust boundary, not a linter.
		code := codeInvalidArgument
		if errors.Is(err, errApplyKeyValue) {
			code = codeKeyValueInvalid
		}
		return nil, blockingDiagnostics(Diagnostic{Code: code})
	}
	target, active, result := loadApplyTarget(mode, req.TargetRevision)
	if result != nil {
		return nil, result
	}
	var prior *config.Config
	if active != nil {
		prior = active.Config() // pre-mutation snapshot; Config returns a copy
	}
	doc, consumed, result := applySourceDocument(ctx, req, active)
	if result != nil {
		return nil, result
	}
	if result := applyStagedChanges(doc, req, consumed); result != nil {
		return nil, result
	}
	if result := checkPreparedDocument(doc, req); result != nil {
		return nil, result
	}
	return &preparedSettingsApply{doc: doc, target: target, prior: prior}, nil
}

// loadApplyTarget freshly loads the active target and compares the caller's
// independent CAS token — or, for Create, establishes that no target exists at
// all. Both write gates are recomputed here on the document as it is right
// now: go-llm's own ReadOnly and Firn's identity-safety editable, which is
// exactly what "state is not ready" means. A cached snapshot is never
// consulted, so a UI that was bypassed cannot smuggle a stale gate through.
// A target that moved out from under the draft splits three ways (§5.6): it is
// gone, or a Create found one where there was none -> conflict:'target'; it is
// newly unreadable -> config_invalid; it is newly read-only or carries an
// identifier Firn cannot write -> limited. Only the conflict raised on a target
// that DID reload safely may carry a projection.
func loadApplyTarget(mode applyMode, wantRevision *string) (settingsWriteTarget, *config.Document, *SettingsApplyResult) {
	doc, loaded, err := loadAgentConfigDocument()
	if mode == applyModeCreate {
		// Create is offered only for config_missing. A target that appeared —
		// readable or not — is the Create race, and an unreadable one was never
		// safely reloaded, so it carries no projection.
		if errors.Is(err, ErrAgentConfigMissing) {
			// Nothing was discovered, so the recomputed state is `missing` and
			// the recomputed origin is `none` — the only pair Create is offered
			// for. Under that discovery outcome the destination is fixed
			// (§5.2); resolving it here is what gives the write a canonical
			// target identity to bind consent to.
			path, perr := createTargetPath()
			if perr != nil {
				return settingsWriteTarget{}, nil, blockingDiagnostics(Diagnostic{Code: codeConfigSaveFailed})
			}
			return settingsWriteTarget{path: path, origin: originNone}, nil, nil
		}
		if err != nil {
			return settingsWriteTarget{}, nil, conflictTarget(nil)
		}
		projection := buildSettingsProjection(loaded, nil)
		return settingsWriteTarget{}, nil, conflictTarget(&projection)
	}
	if err != nil {
		// Gone or moved. Existence is the honest test, not the sentinel: a set
		// $GO_LLM_CONFIG naming a deleted file fails discovery as "invalid",
		// because the override always decides the source.
		if errors.Is(err, ErrAgentConfigMissing) || !targetPathExists(loaded.LexicalPath) {
			return settingsWriteTarget{}, nil, conflictTarget(nil)
		}
		// Newly invalid: the draft was built on a document that no longer
		// parses or validates. Not a conflict — there is nothing to reconcile
		// against until the file is repaired externally.
		return settingsWriteTarget{}, nil, blockingDiagnostics(Diagnostic{Code: codeConfigInvalid})
	}
	projection := buildSettingsProjection(loaded, nil)
	if wantRevision == nil || *wantRevision != loaded.Revision {
		return settingsWriteTarget{}, nil, conflictTarget(&projection)
	}
	// Both write gates, recomputed on the document as it is right now: go-llm's
	// own ReadOnly and Firn's identity-safety editable, which together are what
	// "state is not ready" means. A cached snapshot is never consulted, so a UI
	// that was bypassed cannot smuggle a stale gate through.
	if projection.State != "ready" {
		return settingsWriteTarget{}, nil, limitedResult(projection.Diagnostics)
	}
	return settingsWriteTarget{
		path: loaded.SourcePath, origin: loaded.Origin, revision: loaded.Revision,
	}, doc, nil
}

// targetPathExists reports whether the discovered source is still there at all.
// The lexical path is classification-only — it is never written to.
func targetPathExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Lstat(path)
	return err == nil
}

// activeGrantTarget returns the active configuration's identity — the same
// settingsWriteTarget the apply path binds, so a token can never authorize
// against a different file — alongside what was loaded. The mutable Document
// is deliberately dropped: the approve flow reads, and never writes.
// ErrAgentConfigMissing is reported separately from every other load failure:
// no configuration means there is nothing to approve, while a broken one must
// never read as "nothing to approve" (R3).
func activeGrantTarget() (target settingsWriteTarget, loaded loadedAgentConfig, missing bool, err error) {
	_, loaded, err = loadAgentConfigDocument()
	if err != nil {
		return settingsWriteTarget{}, loaded, errors.Is(err, ErrAgentConfigMissing), err
	}
	return settingsWriteTarget{path: loaded.SourcePath, origin: loaded.Origin, revision: loaded.Revision}, loaded, false, nil
}

// applySourceDocument produces the document the staged changes run against and
// the stable ids of any change the source itself already consumed.
func applySourceDocument(ctx context.Context, req SettingsApplyRequest, active *config.Document) (*config.Document, map[string]bool, *SettingsApplyResult) {
	switch req.Source.Kind {
	case applySourceApplied:
		if active == nil {
			// Unreachable: Create forbids the applied source, and Apply either
			// loaded a document or already returned a result.
			return nil, nil, blockingDiagnostics(Diagnostic{Code: codeInvalidArgument})
		}
		return active, nil, nil
	case applySourceBlank:
		return blankSourceDocument(req)
	case applySourceProfile:
		return profileSourceDocument(ctx, req)
	}
	return nil, nil, blockingDiagnostics(Diagnostic{Code: codeInvalidArgument})
}

// blankSourceDocument extracts the two seed changes a blank draft needs — one
// provider add plus the agent route that references it — and consumes them
// into NewDocument. They are never replayed; every other change then runs once
// in the normal mutation order. The agent floor is NOT checked here: the
// finished document is what has to satisfy it, and checkPreparedDocument
// checks exactly that, once, for every routed floor use case.
func blankSourceDocument(req SettingsApplyRequest) (*config.Document, map[string]bool, *SettingsApplyResult) {
	var agentRoute, seedProvider *Change
	for i := range req.Changes {
		if req.Changes[i].Kind == changeKindRoute && req.Changes[i].UseCase == useCaseAgent {
			agentRoute = &req.Changes[i]
			break
		}
	}
	if agentRoute == nil {
		return nil, nil, blockingDiagnostics(Diagnostic{Code: codeAgentRoleMissing})
	}
	facts := *agentRoute.ModelFacts
	for i := range req.Changes {
		if req.Changes[i].Kind == changeKindProviderAdd && req.Changes[i].Name == facts.Provider {
			seedProvider = &req.Changes[i]
			break
		}
	}
	if seedProvider == nil {
		return nil, nil, blockingDiagnostics(Diagnostic{
			Code: codeProviderNotFound, SubjectKind: "provider", SubjectName: facts.Provider,
		})
	}
	role, ok := generateRoleName(useCaseAgent, nil)
	if !ok {
		return nil, nil, blockingDiagnostics(Diagnostic{Code: codeInvalidArgument})
	}
	doc, err := config.NewDocument(config.BootstrapSpec{
		ProviderName: seedProvider.Name,
		Provider: config.ProviderSpec{
			BaseURL: *seedProvider.Endpoint, APIFormat: derefString(seedProvider.APIFormat),
		},
		Role: role,
		Model: config.ModelSpec{
			Name: facts.Model, Type: facts.Type, Parameters: derefString(facts.Parameters),
			ContextWindow: derefInt(facts.ContextWindow), Dimensions: derefInt(facts.Dimensions),
			Capabilities: overrideCapabilities(agentRoute.ExposedCaps), ThinkMode: agentRoute.ThinkMode,
		},
	}, config.DocumentOptions{})
	if err != nil {
		return nil, nil, actionDiagnostics(err)
	}
	return doc, map[string]bool{
		changeStableID(*agentRoute):   true,
		changeStableID(*seedProvider): true,
	}, nil
}

// ---------------------------------------------------------------------------
// Route classification. A route change is use-case-keyed, but what it does to
// the document depends on what that use case resolves to today.
// ---------------------------------------------------------------------------

type routeAction int

const (
	// routeCreate: nothing is bound, so a new role is born and then bound.
	routeCreate routeAction = iota
	// routeFork: the current role also serves someone else, so the complete
	// authored role is forked and only this use case moves.
	routeFork
	// routeRetarget: the current role serves this use case alone.
	routeRetarget
	// routeOverride: same model — a selector-wide capability/think edit that
	// must NOT go through SetRoleModel (whose replace semantics would clear
	// the omitted ThinkTags and Slots).
	routeOverride
)

type routePlan struct {
	change   Change
	selector modelSelector
	action   routeAction
	role     string // the role the use case resolves to today ("" when unbound)
	newRole  string // the generated role for create/fork
	drops    []string
}

// planRouteChanges classifies every route change against the pre-mutation
// document, derives the generated role names, and runs the two non-writing
// handshakes — exact drop confirmation and exact unknown-use-case
// confirmation — before anything mutates.
func planRouteChanges(base *config.Config, changes []Change, consumed map[string]bool) ([]routePlan, *SettingsApplyResult) {
	routes := stagedChanges(changes, consumed, changeKindRoute)
	routed, _ := roleUsage(base)
	fallbacks := fallbackReferencedRoles(base)
	taken := make(map[string]bool, len(base.Models))
	for role := range base.Models {
		taken[role] = true
	}

	plans := make([]routePlan, 0, len(routes))
	var drops []ChangeDropSet
	for _, change := range routes {
		facts := *change.ModelFacts
		plan := routePlan{
			change:   change,
			selector: modelSelector{provider: facts.Provider, model: facts.Model},
		}
		role, bound := base.Defaults[change.UseCase]
		current, exists := base.Models[role]
		switch {
		case !bound || !exists:
			plan.action = routeCreate
		case sameModelFacts(current, facts):
			plan.action, plan.role = routeOverride, role
		case len(routed[role]) > 1 || fallbacks[role]:
			plan.action, plan.role = routeFork, role
		default:
			plan.action, plan.role = routeRetarget, role
		}
		if plan.action == routeFork || plan.action == routeRetarget {
			plan.drops = roleDropSet(current)
		}
		if plan.action == routeCreate || plan.action == routeFork {
			name, ok := generateRoleName(change.UseCase, taken)
			if !ok {
				return nil, blockingDiagnostics(Diagnostic{
					Code: codeInvalidArgument, SubjectKind: "use_case", SubjectName: change.UseCase,
				})
			}
			plan.newRole, taken[name] = name, true
		}
		if !slices.Equal(plan.drops, change.ConfirmDrops) {
			if len(plan.drops) == 0 {
				// Nothing is dropped, so the stale confirmation cannot even be
				// expressed as a drop set.
				return nil, blockingDiagnostics(Diagnostic{
					Code: codeInvalidArgument, SubjectKind: "use_case", SubjectName: change.UseCase,
				})
			}
			drops = append(drops, ChangeDropSet{
				ChangeID: changeStableID(change), Fields: plan.drops,
			})
		}
		plans = append(plans, plan)
	}
	if len(drops) > 0 {
		return nil, &SettingsApplyResult{Status: "drop_confirmation_required", Drops: drops}
	}
	if result := verifyRouteConfirmations(base, routed, plans); result != nil {
		return nil, result
	}
	if result := verifySelectorGroups(plans); result != nil {
		return nil, result
	}
	return plans, nil
}

// verifyRouteConfirmations checks the request's unknown-use-case
// acknowledgement against the set Firn derives itself: every default the
// mutation affects that has no Firn capability floor. The frontend cannot be
// trusted to compute it, and a mismatch means the user was shown a different
// set than the one about to change.
//
// The required set is derived PER SELECTOR, not per use case (§3.3: the field
// is selector-scoped and must be byte-identical across every staged route on
// one provider+model). Deriving it per use case would make a legitimate
// request unsatisfiable — two floorless use cases staged onto one model would
// each require their own value while the selector check requires one shared
// value.
func verifyRouteConfirmations(base *config.Config, routed map[string][]string, plans []routePlan) *SettingsApplyResult {
	affected := map[modelSelector]map[string]bool{}
	for _, plan := range plans {
		group, ok := affected[plan.selector]
		if !ok {
			group = map[string]bool{}
			affected[plan.selector] = group
		}
		group[plan.change.UseCase] = true
		for role := range gateRolesFor(base, plan) {
			for _, useCase := range routed[role] {
				group[useCase] = true
			}
		}
	}
	unknown := map[modelSelector][]string{}
	for selector, group := range affected {
		names := make([]string, 0, len(group))
		for useCase := range group {
			if _, ok := firnUseCaseFloors[useCase]; !ok {
				names = append(names, useCase)
			}
		}
		slices.Sort(names)
		unknown[selector] = names
	}
	for _, plan := range plans {
		required := unknown[plan.selector]
		if !slices.Equal(required, plan.change.ConfirmUnknownUseCases) ||
			(len(required) > 0 && !plan.change.ConfirmUnknown) {
			return blockingDiagnostics(Diagnostic{
				Code: codeEligibilityUnknown, SubjectKind: "use_case", SubjectName: plan.change.UseCase,
			})
		}
	}
	return nil
}

// gateRolesFor mirrors upstream's eligibility gate: the role being changed,
// plus — when the change asserts an explicit capability override, or is itself
// selector-wide — every role already sharing the target selector, because that
// override becomes their persisted truth too.
func gateRolesFor(base *config.Config, plan routePlan) map[string]bool {
	roles := map[string]bool{}
	if plan.role != "" {
		roles[plan.role] = true
	}
	if plan.action == routeOverride || len(plan.change.ExposedCaps) > 0 {
		for role, m := range base.Models {
			if (modelSelector{provider: m.Provider, model: m.Name}) == plan.selector {
				roles[role] = true
			}
		}
	}
	return roles
}

// verifySelectorGroups enforces §3.3 backend-side: every staged route pointing
// at one provider+model must carry byte-identical selector-scoped fields,
// because they compile into ONE selector-wide truth.
func verifySelectorGroups(plans []routePlan) *SettingsApplyResult {
	first := map[modelSelector]Change{}
	for _, plan := range plans {
		other, seen := first[plan.selector]
		if !seen {
			first[plan.selector] = plan.change
			continue
		}
		if !sameSelectorFields(other, plan.change) {
			return blockingDiagnostics(Diagnostic{
				Code: codeSelectorConflict, SubjectKind: "model", SubjectName: plan.selector.model,
			})
		}
	}
	return nil
}

func sameSelectorFields(a, b Change) bool {
	return slices.Equal(a.ExposedCaps, b.ExposedCaps) &&
		slices.Equal(a.CapabilityFacts.Caps, b.CapabilityFacts.Caps) &&
		slices.Equal(a.CapabilityFacts.KnownCaps, b.CapabilityFacts.KnownCaps) &&
		slices.Equal(a.ConfirmUnknownUseCases, b.ConfirmUnknownUseCases) &&
		a.ThinkMode == b.ThinkMode && a.ConfirmUnknown == b.ConfirmUnknown
}

// ---------------------------------------------------------------------------
// Mutation. Dependency-safe order, removals last: provider adds/updates ->
// key set/clear -> role create/fork/retarget/override and bind -> unbind and
// guarded role removal -> provider removal.
// ---------------------------------------------------------------------------

func applyStagedChanges(doc *config.Document, req SettingsApplyRequest, consumed map[string]bool) *SettingsApplyResult {
	base := doc.Config() // pre-mutation view: classification only
	plans, result := planRouteChanges(base, req.Changes, consumed)
	if result != nil {
		return result
	}

	for _, change := range stagedChanges(req.Changes, consumed, changeKindProviderAdd) {
		if err := doc.AddProvider(change.Name, config.ProviderSpec{
			BaseURL: *change.Endpoint, APIFormat: derefString(change.APIFormat),
		}); err != nil {
			return actionDiagnostics(err)
		}
	}
	for _, change := range stagedChanges(req.Changes, consumed, changeKindProviderUpdate) {
		// UpdateProvider replaces the complete authored value, so the edit has
		// to be overlaid onto AuthoredProvider — otherwise an endpoint change
		// would silently erase the format, the timeout, and the stored key.
		spec, err := doc.AuthoredProvider(change.Name)
		if err != nil {
			return actionDiagnostics(err)
		}
		if change.Endpoint != nil {
			spec.BaseURL = *change.Endpoint
		}
		if change.APIFormat != nil {
			spec.APIFormat = *change.APIFormat
		}
		if err := doc.UpdateProvider(change.Name, spec); err != nil {
			return actionDiagnostics(err)
		}
	}
	for _, change := range stagedChanges(req.Changes, consumed, changeKindProviderKeySet) {
		// The 1:1 keys bijection is a validated request invariant.
		if err := doc.SetProviderAPIKey(change.Name, req.Keys[change.Name]); err != nil {
			return actionDiagnostics(err)
		}
	}
	for _, change := range stagedChanges(req.Changes, consumed, changeKindProviderKeyClear) {
		if err := doc.ClearProviderAPIKey(change.Name); err != nil {
			return actionDiagnostics(err)
		}
	}
	if result := applyRoutePlans(doc, plans); result != nil {
		return result
	}
	for _, change := range stagedChanges(req.Changes, consumed, changeKindRouteUnassign) {
		// The agent route is Firn's own run path: §4.3 never offers Unassign
		// for it, and §5.2 makes the backend enforce that independently of the
		// reducer. go-llm deliberately leaves the floor host-side, so this is
		// the only gate between a bypassed UI and an unrunnable configuration.
		if change.UseCase == useCaseAgent {
			return blockingDiagnostics(Diagnostic{Code: codeAgentRoleMissing})
		}
		if err := doc.UnbindUseCase(change.UseCase); err != nil {
			return actionDiagnostics(err)
		}
	}
	// Only explicit removals run here. The spec also allows auto-removing a
	// role this same Apply generated and then orphaned, which no valid request
	// can produce: a route change and a route-unassign share one stable
	// identity, so a use case cannot be both rebound and unbound in one
	// request, and nothing else can orphan a role born in this batch.
	for _, change := range stagedChanges(req.Changes, consumed, changeKindRoleRemove) {
		if err := doc.RemoveRole(change.Role); err != nil {
			return actionDiagnostics(err)
		}
	}
	for _, change := range stagedChanges(req.Changes, consumed, changeKindProviderRemove) {
		if err := doc.RemoveProvider(change.Name); err != nil {
			return actionDiagnostics(err)
		}
	}
	return nil
}

// applyRoutePlans runs the role-level mutations, then exactly one override per
// selector, then the binds for the roles it created.
func applyRoutePlans(doc *config.Document, plans []routePlan) *SettingsApplyResult {
	binds := make([][2]string, 0, len(plans))
	overrides := make([]routePlan, 0, len(plans))
	overridden := map[modelSelector]bool{}
	for _, plan := range plans {
		facts := roleFacts(plan.change)
		opts, err := roleOptions(plan)
		if err != nil {
			// Unreachable: request validation already requires canonical
			// capability names from the closed vocabulary.
			return blockingDiagnostics(Diagnostic{Code: codeInvalidArgument})
		}
		switch plan.action {
		case routeCreate:
			if err := doc.AddRoleModel(plan.newRole, facts, opts); err != nil {
				return actionDiagnostics(err)
			}
			binds = append(binds, [2]string{plan.change.UseCase, plan.newRole})
		case routeFork:
			if err := doc.ForkRoleModel(plan.role, plan.newRole, facts, config.ForkRoleModelOpts{
				SetRoleModelOpts: opts, ConfirmDrops: plan.change.ConfirmDrops,
			}); err != nil {
				return forkRefusal(plan, err)
			}
			binds = append(binds, [2]string{plan.change.UseCase, plan.newRole})
		case routeRetarget:
			if _, err := doc.SetRoleModel(plan.role, facts, opts); err != nil {
				return actionDiagnostics(err)
			}
		case routeOverride:
			if !overridden[plan.selector] {
				overridden[plan.selector] = true
				overrides = append(overrides, plan)
			}
		}
	}
	for _, plan := range overrides {
		caps, known, err := changeCapabilities(plan.change)
		if err != nil {
			return blockingDiagnostics(Diagnostic{Code: codeInvalidArgument})
		}
		if err := doc.SetRoleOverrides(
			provider.ModelKey{Provider: plan.selector.provider, Model: plan.selector.model},
			config.RoleOverrides{
				Capabilities: overrideCapabilities(plan.change.ExposedCaps),
				ThinkMode:    plan.change.ThinkMode,
			},
			config.SetRoleOverridesOpts{
				Requirements: floorRequirements(), Caps: caps, KnownMask: known,
				ConfirmUnknown: plan.change.ConfirmUnknown,
			}); err != nil {
			return actionDiagnostics(err)
		}
	}
	for _, bind := range binds {
		if err := doc.BindUseCase(bind[0], bind[1]); err != nil {
			return actionDiagnostics(err)
		}
	}
	return nil
}

// checkPreparedDocument is the last non-writing gate. NewDocument and
// BindUseCase guarantee go-llm validity only, so the FINISHED document must
// still resolve Firn's agent and satisfy every configured Firn floor; and a
// result Firn could not project is a result Firn must not write blind.
func checkPreparedDocument(doc *config.Document, req SettingsApplyRequest) *SettingsApplyResult {
	cfg := doc.Config()
	// Keep the request-local verdict for an explicitly routed use case. The
	// completed-document checks below cover changes whose effects are indirect.
	for _, change := range req.Changes {
		if change.Kind != changeKindRoute {
			continue
		}
		floor, ok := firnUseCaseFloors[change.UseCase]
		if !ok {
			continue
		}
		if !routeMeetsFloor(cfg, change.UseCase, floor) {
			return blockingDiagnostics(Diagnostic{
				Code: codeEligibilityIneligible, SubjectKind: "use_case", SubjectName: change.UseCase,
			})
		}
	}
	if _, err := ResolveAgentTarget(cfg); err != nil {
		if diagnostics := agentRouteDiagnostics(cfg); len(diagnostics) > 0 {
			return blockingDiagnostics(diagnostics...)
		}
		if diagnostic, ok := selectedAgentBlockingDiagnostic(cfg); ok {
			return blockingDiagnostics(diagnostic)
		}
		return blockingDiagnostics(Diagnostic{Code: codeConfigInvalid})
	}
	for _, useCase := range slices.Sorted(maps.Keys(cfg.Defaults)) {
		floor, ok := firnUseCaseFloors[useCase]
		if ok && !routeMeetsFloor(cfg, useCase, floor) {
			return blockingDiagnostics(Diagnostic{
				Code: codeEligibilityIneligible, SubjectKind: "use_case", SubjectName: useCase,
			})
		}
	}
	// §5.6: the post-mutation document is projected here, and a result that
	// would exceed a projection bound returns `limited` before consent/save —
	// the same status the load-time bound check returns, for the same reason.
	if exceedsProjectionBounds(cfg) {
		return limitedResult([]Diagnostic{{Code: codeProjectionLimited}})
	}
	return nil
}

func routeMeetsFloor(cfg *config.Config, useCase string, floor provider.Capability) bool {
	role, ok := cfg.RoleForUseCase(useCase)
	if !ok {
		return false
	}
	m := cfg.RoleConfig(role)
	if m == nil {
		return false
	}
	caps, err := provider.ParseCapsStrict(m.ResolvedCapabilities())
	return err == nil && caps.Has(floor)
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

// stagedChanges returns every change of one kind that the source did not
// consume, ordered by stable identity so one request always mutates in one
// order regardless of how the frontend arranged the array.
func stagedChanges(changes []Change, consumed map[string]bool, kind string) []Change {
	out := make([]Change, 0, len(changes))
	for _, change := range changes {
		if change.Kind == kind && !consumed[changeStableID(change)] {
			out = append(out, change)
		}
	}
	slices.SortFunc(out, func(a, b Change) int {
		return strings.Compare(changeStableID(a), changeStableID(b))
	})
	return out
}

func roleFacts(change Change) config.ModelFacts {
	facts := *change.ModelFacts
	return config.ModelFacts{
		Key:           provider.ModelKey{Provider: facts.Provider, Model: facts.Model},
		Type:          facts.Type,
		Parameters:    derefString(facts.Parameters),
		ContextWindow: derefInt(facts.ContextWindow),
		Dimensions:    derefInt(facts.Dimensions),
	}
}

func roleOptions(plan routePlan) (config.SetRoleModelOpts, error) {
	caps, known, err := changeCapabilities(plan.change)
	if err != nil {
		return config.SetRoleModelOpts{}, err
	}
	return config.SetRoleModelOpts{
		Requirements: floorRequirements(),
		Caps:         caps,
		KnownMask:    known,
		// A role that does not exist yet is routed by nothing, so upstream's
		// gate can only ever return unknown/no_requirements for it. The
		// eligibility question for the route being created is answered instead
		// by the exact unknown-use-case confirmation above and by Firn's floor
		// check on the finished document; an INELIGIBLE verdict — an override
		// that would break a live sibling route — is still refused here.
		ConfirmUnknown: plan.change.ConfirmUnknown || plan.newRole != "",
		Capabilities:   overrideCapabilities(plan.change.ExposedCaps),
		ThinkMode:      plan.change.ThinkMode,
	}, nil
}

func changeCapabilities(change Change) (caps, known provider.Capability, err error) {
	if caps, err = provider.ParseCapsStrict(change.CapabilityFacts.Caps); err != nil {
		return 0, 0, err
	}
	known, err = provider.ParseCapsStrict(change.CapabilityFacts.KnownCaps)
	return caps, known, err
}

// floorRequirements is the per-call copy of the floor table handed to
// upstream's eligibility gate. The gate reads only the affected use cases, and
// a use case Firn has no floor for evaluates as unknown by design.
func floorRequirements() map[string]provider.Capability {
	return maps.Clone(firnUseCaseFloors)
}

// overrideCapabilities maps the exposed-capability contract onto upstream's
// override semantics: a non-empty list is the explicit selector-wide override,
// an empty one clears it so capabilities derive from the model type again —
// which validateRouteChange refuses, so no request reaches that branch.
func overrideCapabilities(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	return append([]string(nil), values...)
}

// sameModelFacts reports whether the change asks for the model the role
// already has. Only then is the edit selector-scoped, and only then may it use
// SetRoleOverrides, which preserves every omitted authored field.
func sameModelFacts(m config.ModelConfig, facts ModelFacts) bool {
	return m.Provider == facts.Provider && m.Name == facts.Model && m.Type == facts.Type &&
		m.Parameters == derefString(facts.Parameters) &&
		m.ContextWindow == derefInt(facts.ContextWindow) &&
		m.Dimensions == derefInt(facts.Dimensions)
}

// roleDropSet is the exact set of projection-hidden fields a real retarget
// drops, computed the way upstream computes it for a fork: Slots can never be
// re-asserted onto a different model, and Firn never re-asserts ThinkTags
// (their values never cross the boundary). Ascending order puts "slots" first.
func roleDropSet(m config.ModelConfig) []string {
	var out []string
	if m.Slots != 0 {
		out = append(out, dropFieldSlots)
	}
	if m.ThinkTags != nil {
		out = append(out, dropFieldThinkTags)
	}
	return out
}

func fallbackReferencedRoles(cfg *config.Config) map[string]bool {
	refs := map[string]bool{}
	for _, m := range cfg.Models {
		for _, fallback := range m.Fallbacks {
			refs[fallback] = true
		}
	}
	return refs
}

// generateRoleName derives a new role name backend-side: "<useCase>-m", then
// "-m-2", "-m-3", …. The use-case prefix is trimmed at a UTF-8 rune boundary
// so the whole identifier stays inside the 256-byte bound, and candidates
// dedupe against the authored roles UNION every name generated earlier in the
// same preparation batch — two use cases whose trimmed prefixes coincide must
// not resolve to one role. Sanitized display values are never an input.
func generateRoleName(useCase string, taken map[string]bool) (string, bool) {
	for attempt := 1; attempt <= maxProjectionEntries+1; attempt++ {
		suffix := "-m"
		if attempt > 1 {
			suffix += "-" + strconv.Itoa(attempt)
		}
		name := trimToBytes(useCase, maxProjectionIdentifierLen-len(suffix)) + suffix
		if !taken[name] {
			return name, true
		}
	}
	return "", false
}

// trimToBytes cuts s to at most limit bytes without splitting a rune.
func trimToBytes(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(s) <= limit {
		return s
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit]
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

// ---------------------------------------------------------------------------
// Consent identity (spec §5.2). A challenge is only as safe as what Call 2
// recomputes and compares, so every value below is derived from a fresh
// preparation — never from anything the frontend sent back or the backend
// stored.
// ---------------------------------------------------------------------------

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// newChallengeToken is the cryptographically random, single-use, opaque token.
// rand.Text is base32 (26 chars, ~130 bits): inside the §5.6 byte bound and
// already a safe Identifier, so it needs no escaping to reach the UI.
func newChallengeToken() string { return rand.Text() }

// validChallengeTokenShape is the §5.6 token rule, checked before the token is
// used to look anything up: opaque, 1..256 UTF-8 bytes, control-free.
func validChallengeTokenShape(token string) bool {
	return token != "" && len(token) <= maxChallengeTokenBytes &&
		sanitizeIdentifier(token) == token
}

// constantTimeEqual compares two fixed-shape identity strings without leaking
// how far they matched.
func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// newRemoteDestinations returns, digest-sorted, every remote destination in
// post that is neither reachable in pre nor already durably granted (D8). The
// order is post's own, which reachableDestinations already sorts by digest. A
// nil pre treats every ungranted reachable remote as new (D13): with no prior
// document there is no destination the user has already been living with.
func newRemoteDestinations(pre, post []ReachableDestination, consent *ConsentStore) []ReachableDestination {
	prior := make(map[string]bool, len(pre))
	for _, d := range pre {
		prior[d.Destination.Digest] = true
	}
	var out []ReachableDestination
	for _, d := range post {
		if d.Destination.Classification != "remote" || prior[d.Destination.Digest] ||
			consent.Has(d.Destination.Digest) {
			continue
		}
		out = append(out, d)
	}
	return out
}

// applyDestinations renders the challenge entries. Every identifier
// interpolated into one passes the projection sanitizer (I10): renderHop's own
// literals are fixed vocabulary and need none, the Source it interpolates
// does, and endpoints are already canonical.
func applyDestinations(missing []ReachableDestination) []ApplyDestination {
	out := make([]ApplyDestination, 0, len(missing))
	for _, d := range missing {
		provenance := make([]string, 0, len(d.Hops))
		for _, h := range d.Hops {
			h.Source = sanitizeIdentifier(h.Source)
			provenance = append(provenance, renderHop(h))
		}
		out = append(out, ApplyDestination{
			Provider:       sanitizeIdentifier(d.Destination.Provider),
			Model:          sanitizeIdentifier(d.Destination.Model),
			Endpoint:       d.Destination.Endpoint,
			Classification: d.Destination.Classification,
			Provenance:     provenance,
		})
	}
	return out
}

// destinationsOf drops the provenance, leaving the consent identities.
func destinationsOf(set []ReachableDestination) []ProviderDestination {
	out := make([]ProviderDestination, 0, len(set))
	for _, d := range set {
		out = append(out, d.Destination)
	}
	return out
}

// canonicalApplyDigest is the consent identity of one staged write: the
// operation kind, the target revision, the profile provenance, every
// non-secret change field in stable-identity order, the provider names key
// operations touch, the backend target-identity digest, and the COMPLETE
// pre/post reachable destination sets. Key VALUES are deliberately excluded —
// approving a destination is not approving a secret, and §5.4 forbids
// retaining one — so a resend that rotates a key still matches the challenge
// it answers.
func canonicalApplyDigest(req SettingsApplyRequest, mode applyMode, targetDigest string, pre, post []ProviderDestination) string {
	changes := append([]Change(nil), req.Changes...)
	slices.SortFunc(changes, func(a, b Change) int {
		return strings.Compare(changeStableID(a), changeStableID(b))
	})
	keyNames := make([]string, 0, len(req.Keys))
	for name := range req.Keys {
		keyNames = append(keyNames, name)
	}
	slices.Sort(keyNames)
	raw, err := json.Marshal(struct {
		Operation      int                   `json:"operation"`
		TargetRevision string                `json:"targetRevision"`
		Source         ApplySource           `json:"source"`
		Changes        []Change              `json:"changes"`
		KeyNames       []string              `json:"keyNames"`
		TargetDigest   string                `json:"targetDigest"`
		Pre            []ProviderDestination `json:"pre"`
		Post           []ProviderDestination `json:"post"`
	}{
		Operation: int(mode), TargetRevision: derefString(req.TargetRevision), Source: req.Source,
		Changes: changes, KeyNames: keyNames, TargetDigest: targetDigest, Pre: pre, Post: post,
	})
	if err != nil {
		// Unreachable: every member above is a plain JSON value. Fail closed
		// with a digest no recomputation can reproduce, never with a constant
		// two failing sides would agree on.
		return sha256Hex([]byte(newChallengeToken()))
	}
	return sha256Hex(raw)
}

// saveOutcome classifies one Step-S save. It returns the applied warning when
// the bytes are live and otherwise the exact §5.6 refusal. The three
// save-layer codes are mapped HERE and never through actionDiagnostics, which
// has no case for them and would fall through to config_invalid: a revision
// conflict and a Create race are conflicts, and durability uncertainty is a
// warning on a published write, never a failure.
func saveOutcome(err error) (warning string, refusal *SettingsApplyResult) {
	if err == nil {
		return "", nil
	}
	if errors.Is(err, config.ErrDurabilityUncertain) {
		return "durability_uncertain", nil
	}
	if d, ok := config.DiagnosticOf(err); ok {
		switch d.Code {
		case config.CodeRevisionConflict, config.CodeTargetExists:
			// The target moved under a write that had already passed every
			// preparation gate. It carries no projection: nothing was reloaded.
			return "", conflictTarget(nil)
		}
	}
	return "", blockingDiagnostics(Diagnostic{Code: codeConfigSaveFailed})
}

// conflictChallenge reports that the consent challenge no longer authorizes
// this write: the token is absent, expired, cancelled, already consumed, or
// the fresh preparation no longer matches what the user approved. It never
// carries a projection — the active target may not have moved at all.
func conflictChallenge(outcome string) *SettingsApplyResult {
	return &SettingsApplyResult{Status: "conflict", Conflict: "challenge", ConsentOutcome: outcome}
}

// withConsentOutcome stamps the grant outcome onto the two result variants
// §5.6 lets carry one. A failure AFTER a durable grant must still say the
// approval was recorded; the other variants are all reached before any grant.
func withConsentOutcome(r *SettingsApplyResult, outcome string) *SettingsApplyResult {
	if r.Status == "conflict" || r.Status == "diagnostics" {
		r.ConsentOutcome = outcome
	}
	return r
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

// blockingDiagnostics builds the §5.6 diagnostics result: every subject is
// sanitized and bounded before it can reach the UI or the host log, and the
// array is canonically ordered and duplicate-free like the projection's.
func blockingDiagnostics(ds ...Diagnostic) *SettingsApplyResult {
	return &SettingsApplyResult{
		Status: "diagnostics", ConsentOutcome: consentUnchanged,
		Diagnostics: canonicalDiagnostics(ds, true),
	}
}

// limitedResult refuses a write because the target itself is not writable —
// go-llm read-only, a Firn-unwritable identifier, or a document Firn cannot
// project. The projection's own diagnostics say which.
func limitedResult(ds []Diagnostic) *SettingsApplyResult {
	out := canonicalDiagnostics(ds, false)
	if len(out) == 0 {
		out = canonicalDiagnostics([]Diagnostic{{Code: codeProjectionLimited}}, false)
	}
	return &SettingsApplyResult{Status: "limited", Diagnostics: out}
}

// conflictTarget reports that the active target moved: it is gone, it appeared
// where Create expected nothing, or its revision is not the one the draft was
// built on. A projection rides along ONLY when the target was safely reloaded
// (§5.6), so the UI can recover without a second call; otherwise it is nil.
func conflictTarget(projection *SettingsProjection) *SettingsApplyResult {
	return &SettingsApplyResult{
		Status: "conflict", Conflict: "target", Projection: projection,
		ConsentOutcome: consentUnchanged,
	}
}

// conflictProfileSource reports that the profile the draft was built on is gone
// or has moved. It never carries a projection: the moved document is the
// SOURCE, and the active target's projection would not help the UI reconcile
// it — the frontend reloads the profile instead.
func conflictProfileSource() *SettingsApplyResult {
	return &SettingsApplyResult{
		Status: "conflict", Conflict: "profile_source", ConsentOutcome: consentUnchanged,
	}
}

// forkRefusal turns an upstream fork refusal into the right result: a drop
// refusal is the non-writing drop_confirmation_required handshake (upstream is
// the authority on the exact set), anything else is a typed diagnostic.
func forkRefusal(plan routePlan, err error) *SettingsApplyResult {
	if fields, ok := config.DropSetOf(err); ok && canonicalDropFields(fields) {
		return &SettingsApplyResult{Status: "drop_confirmation_required",
			Drops: []ChangeDropSet{{ChangeID: changeStableID(plan.change), Fields: fields}}}
	}
	return actionDiagnostics(err)
}

// actionDiagnostics maps an upstream MUTATION failure onto the closed Firn
// vocabulary. Spec §5.1 defers the nine action-only codes to "Phase 3 action
// responses" — this is that mapping, and it is deliberately NOT
// mapConfigDiagnostic, which fails those codes closed because they cannot
// arise from a load. The three codes the pinned upstream added after §5.6
// froze the Firn vocabulary (role_exists, role_in_use, use_case_not_found) map
// onto the closest existing meaning rather than inventing copy the total
// message map does not have.
func actionDiagnostics(err error) *SettingsApplyResult {
	d, ok := config.DiagnosticOf(err)
	if !ok {
		return blockingDiagnostics(Diagnostic{Code: codeConfigInvalid})
	}
	mapped := Diagnostic{SubjectKind: actionSubjectKind(d.SubjectKind), SubjectName: d.Subject}
	if mapped.SubjectKind == "" {
		mapped.SubjectName = ""
	}
	switch d.Code {
	case config.CodeInvalidArgument, config.CodeRoleExists, config.CodeRoleInUse:
		mapped.Code = codeInvalidArgument
	case config.CodeRoleNotFound, config.CodeUseCaseNotFound:
		mapped.Code = codeRoleNotFound
	case config.CodeProviderExists:
		mapped.Code = codeProviderExists
	case config.CodeProviderInUse:
		mapped.Code = codeProviderInUse
	case config.CodeEligibilityIneligible:
		mapped.Code = codeEligibilityIneligible
	case config.CodeEligibilityUnknown:
		mapped.Code = codeEligibilityUnknown
	default:
		// Everything else keeps the single load-time mapping table.
		return blockingDiagnostics(mapConfigDiagnostic(d))
	}
	return blockingDiagnostics(mapped)
}

func actionSubjectKind(kind config.SubjectKind) string {
	switch kind {
	case config.SubjectProvider:
		return "provider"
	case config.SubjectRole:
		return "role"
	case config.SubjectUseCase:
		return "use_case"
	case config.SubjectNone:
	}
	return ""
}

func canonicalDiagnostics(ds []Diagnostic, blocking bool) []Diagnostic {
	out := make([]Diagnostic, 0, len(ds))
	for _, d := range ds {
		d.SubjectName = sanitizeIdentifier(d.SubjectName)
		d = boundSubject(d)
		if blocking {
			d.Blocking = true
		}
		out = append(out, d)
	}
	sortDiagnostics(out)
	return slices.Compact(out)
}
