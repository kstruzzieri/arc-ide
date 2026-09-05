package ai

import (
	"errors"
	"slices"
	"sort"
	"strings"
	"unicode"

	"github.com/kstruzzieri/go-llm/agent"
	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/provider"
)

// Response bounds for the settings projection (mirrored exactly by the
// frontend validators and the testdata/settings_contract corpus). All string
// limits are UTF-8 BYTE counts — the TypeScript mirror measures
// TextEncoder-encoded byte length, never UTF-16 code units — so the two
// validators agree on every input. Exceeding a bound never redefines go-llm
// validity: the runtime target still resolves, the projection is withheld as
// state "limited" instead.
const (
	maxProjectionEntries       = 256
	maxProjectionIdentifierLen = 256
	maxProjectionEndpointLen   = 1024
	// maxProjectionDiagnostics is the contract cap (fixed by the TS validator
	// and the shared corpus — never raise it without a breaking-change
	// review). appendDiagnostic always emits, in order, at most one
	// agent/document-state diagnostic (agentRouteDiagnostics or
	// selectedAgentBlockingDiagnostic), then the readOnly diagnostic, then
	// the not-editable diagnostic, BEFORE the up-to-maxProjectionEntries
	// per-provider provider_endpoint_unsupported notices. The builder can
	// therefore want up to maxProjectionEntries+3 entries; appendDiagnostic
	// silently drops whatever doesn't fit past the cap. That's safe: a
	// blocking agent/readOnly/not-editable diagnostic always lands within
	// the first few appends and is never the one truncated, and a dropped
	// non-blocking provider notice is cosmetic — that provider's row still
	// projects (classification "unknown", endpoint ""), just without its
	// own diagnostic line.
	maxProjectionDiagnostics = maxProjectionEntries + 1
)

// Slice A diagnostic-code allowlist. The frontend validator mirrors this list
// byte-for-byte; grow both sides in the same change.
const (
	codeConfigMissing               = "config_missing"
	codeJSONInvalid                 = "json_invalid"
	codeConfigInvalid               = "config_invalid"
	codeAgentRoleMissing            = "agent_role_missing"
	codeAgentCapsInsufficient       = "agent_capabilities_insufficient"
	codeProviderEndpointUnsupported = "provider_endpoint_unsupported"
	codeProjectionLimited           = "projection_limited"
	codeDuplicateKeys               = "duplicate_keys"
	codeProviderRequired            = "provider_required"
	codeProviderNameInvalid         = "provider_name_invalid"
	codeProviderEndpointInvalid     = "provider_endpoint_invalid"
	codeProviderFormatInvalid       = "provider_format_invalid"
	codeSlotPolicyInvalid           = "slot_policy_invalid"
	codeModelInvalid                = "model_invalid"
	codeThinkInvalid                = "think_invalid"
	codeProviderNotFound            = "provider_not_found"
	codeDefaultsInvalid             = "defaults_invalid"
	codeKeyReferenceMalformed       = "key_reference_malformed"
	codeKeyReferenceUnavailable     = "key_reference_unavailable"
	codeSelectorConflict            = "selector_conflict"
	codeIdentifierNotEditable       = "identifier_not_editable"
	// Slice B write/action codes. They never arise from a load: the apply
	// pipeline maps upstream action failures onto them, and request validation
	// maps its one caller-actionable break — a key value that is empty or not a
	// literal — onto codeKeyValueInvalid. They share one vocabulary with the
	// projection because they share one SettingsDiagnostic type across the
	// boundary (spec §5.6).
	codeInvalidArgument          = "invalid_argument"
	codeRoleNotFound             = "role_not_found"
	codeProviderExists           = "provider_exists"
	codeProviderInUse            = "provider_in_use"
	codeEligibilityIneligible    = "eligibility_ineligible"
	codeEligibilityUnknown       = "eligibility_unknown"
	codeKeyValueInvalid          = "key_value_invalid"
	codeProfileSourceUnavailable = "profile_source_unavailable"
	codeConsentStoreFailed       = "consent_store_failed"
	codeConfigSaveFailed         = "config_save_failed"
)

// settingsDiagnosticCodes enumerates every code the builder can emit, in the
// contract's canonical order.
var settingsDiagnosticCodes = []string{
	codeConfigMissing,
	codeJSONInvalid,
	codeConfigInvalid,
	codeAgentRoleMissing,
	codeAgentCapsInsufficient,
	codeProviderEndpointUnsupported,
	codeProjectionLimited,
	codeDuplicateKeys,
	codeProviderRequired,
	codeProviderNameInvalid,
	codeProviderEndpointInvalid,
	codeProviderFormatInvalid,
	codeSlotPolicyInvalid,
	codeModelInvalid,
	codeThinkInvalid,
	codeProviderNotFound,
	codeDefaultsInvalid,
	codeKeyReferenceMalformed,
	codeKeyReferenceUnavailable,
	codeSelectorConflict,
	codeIdentifierNotEditable,
	codeInvalidArgument,
	codeRoleNotFound,
	codeProviderExists,
	codeProviderInUse,
	codeEligibilityIneligible,
	codeEligibilityUnknown,
	codeKeyValueInvalid,
	codeProfileSourceUnavailable,
	codeConsentStoreFailed,
	codeConfigSaveFailed,
}

// firnUseCaseFloors is THE Firn capability floor table: the minimum a model
// must support for a use case Firn itself drives. It is the one Go source of
// truth (testdata/settings_use_case_floors.json is the same table, shared with
// the TypeScript mirror), and the agent row is the run path's own value so
// a write can never accept a model the runtime would then refuse. A use case
// absent from this table has no Firn requirement — upstream's eligibility gate
// evaluates it as unknown, and the request must confirm it explicitly
// (§3.3 confirmUnknownUseCases).
var firnUseCaseFloors = map[string]provider.Capability{
	useCaseAgent:           requiredAgentCaps,
	"chat":                 agent.ModelCallCapabilities(false),
	"embedding":            provider.CapEmbed,
	config.UseCasePlanning: agent.ModelCallCapabilities(true),
}

// useCaseAgent is the one use case Firn's own run path resolves.
const useCaseAgent = "agent"

// SettingsProjection is the Wails-facing read-only view of the effective Golem
// configuration. It never carries filesystem paths, raw JSON, API keys,
// environment variable names, or raw go-llm error text. Revision is present
// only for Ready/Limited (a loaded document); ReadOnly is the go-llm document
// fact, Editable is the Firn identity-safety fact — they can diverge (a
// duplicate-only document is ReadOnly but still Editable).
type SettingsProjection struct {
	State        string               `json:"state"`        // missing | invalid | limited | ready
	SourceOrigin string               `json:"sourceOrigin"` // none | env | working_directory | user_config | legacy
	Revision     string               `json:"revision,omitempty"`
	ReadOnly     bool                 `json:"readOnly"`
	Editable     bool                 `json:"editable"`
	Routes       []RouteProjection    `json:"routes"`
	Models       []ModelProjection    `json:"models"`
	Providers    []ProviderProjection `json:"providers"`
	Diagnostics  []Diagnostic         `json:"diagnostics"`
}

// CapabilityFacts pairs a model's resolved capabilities with the full
// canonical vocabulary, so the frontend can render both "has" and "could
// have" without hard-coding the capability list.
type CapabilityFacts struct {
	Caps      []string `json:"caps"`
	KnownCaps []string `json:"knownCaps"`
}

// SettingsReloadResult is the Wails-facing reload outcome. Busy means the
// idle barrier rejected the reload and Projection is the unchanged current
// snapshot's.
type SettingsReloadResult struct {
	Busy       bool               `json:"busy"`
	Projection SettingsProjection `json:"projection"`
}

// RouteProjection is one defaults.* entry: use case -> model role.
type RouteProjection struct {
	UseCase string `json:"useCase"`
	Role    string `json:"role"`
}

// ModelProjection is one models-map entry. Role is the map key (a role name);
// ModelName is the provider's model ID — different namespaces, both shown.
// EffectiveCapabilities/CapabilityFacts.Caps are this model's own canonical
// ResolvedCapabilities(); ExposedCapabilities is what a selector-sharing
// mutation would actually apply (selectorCapabilityOverrides). RoutedUseCases
// lists every use case reaching this role (directly or through a fallback
// chain); Removable is true when nothing references it.
//
// HasThinkTags/HasSlots are EXISTENCE facts only: a real model retarget drops
// these authored, model-specific members, so the editor has to disclose the
// loss before staging. The values themselves never cross the boundary.
type ModelProjection struct {
	Role                  string          `json:"role"`
	ModelName             string          `json:"modelName"`
	Provider              string          `json:"provider"`
	Type                  string          `json:"type"`
	Parameters            string          `json:"parameters,omitempty"`
	ContextWindow         int             `json:"contextWindow,omitempty"`
	Dimensions            int             `json:"dimensions,omitempty"`
	EffectiveCapabilities []string        `json:"effectiveCapabilities"`
	CapabilityFacts       CapabilityFacts `json:"capabilityFacts"`
	ExposedCapabilities   []string        `json:"exposedCapabilities"`
	ThinkMode             string          `json:"thinkMode"`
	RoutedUseCases        []string        `json:"routedUseCases"`
	HasThinkTags          bool            `json:"hasThinkTags"`
	HasSlots              bool            `json:"hasSlots"`
	Removable             bool            `json:"removable"`
}

// clone deep-copies every slice a projection owns. Settings() and
// ReloadSettings() hand their value to the Wails layer, which may keep or edit
// it; without this, one caller's edit would rewrite the cached snapshot that
// the next caller reads.
func (p SettingsProjection) clone() SettingsProjection {
	out := p
	out.Routes = slices.Clone(p.Routes)
	out.Providers = slices.Clone(p.Providers)
	out.Diagnostics = slices.Clone(p.Diagnostics)
	out.Models = slices.Clone(p.Models)
	for i := range out.Models {
		m := &out.Models[i]
		m.EffectiveCapabilities = slices.Clone(m.EffectiveCapabilities)
		m.ExposedCapabilities = slices.Clone(m.ExposedCapabilities)
		m.RoutedUseCases = slices.Clone(m.RoutedUseCases)
		m.CapabilityFacts.Caps = slices.Clone(m.CapabilityFacts.Caps)
		m.CapabilityFacts.KnownCaps = slices.Clone(m.CapabilityFacts.KnownCaps)
	}
	return out
}

// ProviderProjection is one provider. Endpoint is the NormalizeEndpoint
// canonical form, "" when not derivable (Classification then "unknown").
// CredentialState is presence, not a usability promise. reference_unavailable
// is not producible by the current loader (an unresolved ${ENV} key
// reference hard-fails the whole document load, so no provider ever reaches
// this projection with a dangling reference); it is retained because the
// spec closes the enum.
type ProviderProjection struct {
	Name            string `json:"name"`
	Endpoint        string `json:"endpoint"`
	Classification  string `json:"classification"` // local | remote | unknown
	APIFormat       string `json:"apiFormat"`
	CredentialState string `json:"credentialState"` // none | available | reference_unavailable
}

// Diagnostic is one allowlisted configuration finding. SubjectName is a
// length-bounded role/model/provider/use_case name; never a path or value.
type Diagnostic struct {
	Code        string `json:"code"`
	SubjectKind string `json:"subjectKind"` // "" | role | model | provider | use_case
	SubjectName string `json:"subjectName"`
	Blocking    bool   `json:"blocking"`
}

// mapConfigDiagnostic maps a go-llm config.Diagnostic onto the closed Slice-A
// Firn diagnostic vocabulary. Every upstream ErrorCode this pinned go-llm
// version can emit (config/diagnostic.go) is listed explicitly; an unknown
// code — a future upstream addition not yet reviewed — fails closed onto
// codeConfigInvalid rather than leaking an unreviewed string across the
// boundary. The mapping table lives in
// testdata/settings_diagnostic_mapping.json and is shared with the frontend
// test via the same fixture file.
func mapConfigDiagnostic(d config.Diagnostic) Diagnostic {
	subjectKind, subjectName := "", ""
	switch d.SubjectKind {
	case config.SubjectProvider:
		subjectKind, subjectName = "provider", d.Subject
	case config.SubjectRole:
		subjectKind, subjectName = "role", d.Subject
	case config.SubjectUseCase:
		subjectKind, subjectName = "use_case", d.Subject
	case config.SubjectNone:
	}

	switch d.Code {
	case config.CodeConfigNotFound:
		return Diagnostic{Code: codeConfigMissing, Blocking: true}
	case config.CodeParseError:
		return Diagnostic{Code: codeJSONInvalid, Blocking: true}
	case config.CodeConfigDiscoveryInvalid, config.CodeIO, config.CodeRenderError:
		return Diagnostic{Code: codeConfigInvalid, Blocking: true}
	}

	code, blocking := "", true
	switch d.Code {
	case config.CodeDuplicateKeys:
		code, blocking = codeDuplicateKeys, false
	case config.CodeProviderRequired:
		code = codeProviderRequired
	case config.CodeProviderNameInvalid:
		code = codeProviderNameInvalid
	case config.CodeProviderEndpointInvalid:
		code = codeProviderEndpointInvalid
	case config.CodeProviderFormatInvalid:
		code = codeProviderFormatInvalid
	case config.CodeSlotPolicyInvalid:
		code = codeSlotPolicyInvalid
	case config.CodeModelInvalid:
		code = codeModelInvalid
	case config.CodeThinkInvalid:
		code = codeThinkInvalid
	case config.CodeProviderNotFound:
		code = codeProviderNotFound
	case config.CodeDefaultsInvalid:
		code = codeDefaultsInvalid
	case config.CodeKeyReferenceMalformed:
		code = codeKeyReferenceMalformed
	case config.CodeKeyReferenceUnavailable:
		code = codeKeyReferenceUnavailable
	case config.CodeSelectorConflict:
		code = codeSelectorConflict
	default:
		return Diagnostic{Code: codeConfigInvalid, Blocking: true}
	}

	return Diagnostic{Code: code, SubjectKind: subjectKind,
		SubjectName: subjectName, Blocking: blocking}
}

// sanitizeIdentifier replaces control and bidirectional-format runes with
// U+FFFD before an identifier crosses the boundary: a config key carrying
// RLO/LRO or C0/C1 controls could otherwise visually spoof diagnostic and
// model names in the UI. Category Cc and Cf cover both.
func sanitizeIdentifier(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.In(r, unicode.Cc, unicode.Cf) {
			return '\uFFFD'
		}
		return r
	}, s)
}

// sanitizeProjectionIdentifiers scrubs every projected identifier in place —
// the one pass every build path funnels through, so no emit site can forget
// it. Endpoints are excluded: NormalizeEndpoint's URL parse already
// constrains them, and effectiveCapabilities come from the canonical
// vocabulary. Bounds were measured on the sanitized form
// (exceedsProjectionBounds, boundSubject), so the scrub can never push a
// field over a limit.
func sanitizeProjectionIdentifiers(p SettingsProjection) SettingsProjection {
	for i := range p.Routes {
		r := &p.Routes[i]
		r.UseCase, r.Role = sanitizeIdentifier(r.UseCase), sanitizeIdentifier(r.Role)
	}
	for i := range p.Models {
		m := &p.Models[i]
		m.Role = sanitizeIdentifier(m.Role)
		m.ModelName = sanitizeIdentifier(m.ModelName)
		m.Provider = sanitizeIdentifier(m.Provider)
		m.Type = sanitizeIdentifier(m.Type)
		m.ThinkMode = sanitizeIdentifier(m.ThinkMode)
		m.Parameters = sanitizeIdentifier(m.Parameters)
		for j := range m.RoutedUseCases {
			m.RoutedUseCases[j] = sanitizeIdentifier(m.RoutedUseCases[j])
		}
	}
	for i := range p.Providers {
		pr := &p.Providers[i]
		pr.Name, pr.APIFormat = sanitizeIdentifier(pr.Name), sanitizeIdentifier(pr.APIFormat)
	}
	for i := range p.Diagnostics {
		p.Diagnostics[i].SubjectName = sanitizeIdentifier(p.Diagnostics[i].SubjectName)
	}
	return p
}

// projectedOrigin maps a backend sourceOrigin onto the boundary vocabulary
// explicitly — the sourceOrigin contract forbids raw pass-through, so an
// unknown or zero value collapses to "none" instead of leaking a new string
// into the frontend enum.
func projectedOrigin(origin sourceOrigin) string {
	switch origin {
	case originEnv, originWorkingDirectory, originUserConfig, originLegacy:
		return string(origin)
	default:
		return string(originNone)
	}
}

// emptyProjection returns a projection with empty (non-nil) collections so
// the boundary never serializes null where the contract says array.
func emptyProjection(state string, origin sourceOrigin) SettingsProjection {
	return SettingsProjection{
		State:        state,
		SourceOrigin: projectedOrigin(origin),
		Routes:       []RouteProjection{},
		Models:       []ModelProjection{},
		Providers:    []ProviderProjection{},
		Diagnostics:  []Diagnostic{},
	}
}

// buildSettingsProjection maps one load outcome onto the safe projection.
// Pure: no I/O, no service state. loadErr non-nil means loaded.Config is nil.
// Every path funnels through sanitizeProjectionIdentifiers so no identifier
// can carry a control or bidi-format rune across the boundary.
func buildSettingsProjection(loaded loadedAgentConfig, loadErr error) SettingsProjection {
	return finalizeSettingsProjection(assembleSettingsProjection(loaded, loadErr))
}

// assembleSettingsProjection builds the projection from raw config values;
// buildSettingsProjection sanitizes what it returns.
func assembleSettingsProjection(loaded loadedAgentConfig, loadErr error) SettingsProjection {
	if loadErr != nil {
		// The origin is the discovery branch that SELECTED a source, not a
		// claim that the source loaded: a target named by $GO_LLM_CONFIG that
		// is not there is still the env target, and the masthead has to name
		// it. A discovery that matched nothing already reports originNone.
		if errors.Is(loadErr, ErrAgentConfigMissing) {
			p := emptyProjection("missing", loaded.Origin)
			p.Diagnostics = append(p.Diagnostics, Diagnostic{Code: codeConfigMissing, Blocking: true})
			return p
		}
		if loaded.HasConfigDiagnostic && loaded.ConfigDiagnostic.Code == config.CodeConfigNotFound {
			// mapConfigDiagnostic maps this code to codeConfigMissing; emitting
			// it under state "invalid" would be a self-contradicting pair.
			p := emptyProjection("missing", loaded.Origin)
			p.Diagnostics = append(p.Diagnostics, Diagnostic{Code: codeConfigMissing, Blocking: true})
			return p
		}
		p := emptyProjection("invalid", loaded.Origin)
		if loaded.HasConfigDiagnostic {
			d := mapConfigDiagnostic(loaded.ConfigDiagnostic)
			if loaded.ConfigDiagnostic.Code == config.CodeParseError &&
				!errors.Is(loadErr, errConfigJSONSyntax) {
				d.Code = codeConfigInvalid
			}
			d.Blocking = true
			p.Diagnostics = append(p.Diagnostics, boundSubject(d))
			return p
		}
		code := codeConfigInvalid
		if errors.Is(loadErr, errConfigJSONSyntax) {
			code = codeJSONInvalid
		}
		p.Diagnostics = append(p.Diagnostics, Diagnostic{Code: code, Blocking: true})
		return p
	}

	cfg := loaded.Config
	if cfg == nil {
		// Contract slip (loadErr == nil implies Config != nil): degrade to the
		// invalid projection rather than panicking a Wails call.
		p := emptyProjection("invalid", loaded.Origin)
		p.Diagnostics = append(p.Diagnostics, Diagnostic{Code: codeConfigInvalid, Blocking: true})
		return p
	}
	p := emptyProjection("ready", loaded.Origin)
	p.Revision, p.ReadOnly = loaded.Revision, loaded.ReadOnly
	editable, withhold, offenseKind, offenseSubject := projectionIdentityStatus(cfg)
	p.Editable = editable

	appendDiagnostic := func(d Diagnostic) {
		if len(p.Diagnostics) < maxProjectionDiagnostics {
			p.Diagnostics = append(p.Diagnostics, boundSubject(d))
		}
	}
	agentDiagnostics := agentRouteDiagnostics(cfg)
	for _, d := range agentDiagnostics {
		appendDiagnostic(d)
	}
	if len(agentDiagnostics) == 0 {
		if d, ok := selectedAgentBlockingDiagnostic(cfg); ok {
			appendDiagnostic(d)
		}
	}
	if loaded.ReadOnly {
		// mapConfigDiagnostic fails an unknown future code closed onto
		// {config_invalid, Blocking:true} — correct for the load-FAILURE path,
		// but this is a successfully loaded, live document; force the mirror
		// image of that deliberate choice so an unreviewed read-only reason
		// never renders as "rejected while loading" over entities that did
		// load and still project.
		d := mapConfigDiagnostic(loaded.ReadOnlyDiagnostic)
		d.Blocking = false
		appendDiagnostic(d)
	}
	if !p.Editable {
		appendDiagnostic(Diagnostic{
			Code: codeIdentifierNotEditable, SubjectKind: offenseKind, SubjectName: offenseSubject,
		})
	}
	if withhold {
		p.State = "limited"
		return p
	}
	if exceedsProjectionBounds(cfg) {
		p.State = "limited"
		appendDiagnostic(Diagnostic{Code: codeProjectionLimited})
		return p
	}

	for useCase, role := range cfg.Defaults {
		p.Routes = append(p.Routes, RouteProjection{UseCase: useCase, Role: role})
	}

	overrides := selectorCapabilityOverrides(cfg)
	routed, referenced := roleUsage(cfg)
	for role, m := range cfg.Models {
		effective := canonicalizeCapabilities(m.ResolvedCapabilities())
		var exposed []string
		if override, ok := overrides[modelSelector{provider: m.Provider, model: m.Name}]; ok {
			exposed = append([]string{}, override...)
		} else {
			exposed = append([]string{}, effective...)
		}
		p.Models = append(p.Models, ModelProjection{
			Role: role, ModelName: m.Name, Provider: m.Provider, Type: m.Type,
			Parameters: m.Parameters, ContextWindow: m.ContextWindow, Dimensions: m.Dimensions,
			EffectiveCapabilities: append([]string{}, effective...),
			CapabilityFacts: CapabilityFacts{
				Caps:      append([]string{}, effective...),
				KnownCaps: append([]string{}, provider.CanonicalCapabilityNames...),
			},
			ExposedCapabilities: exposed, ThinkMode: m.ThinkMode,
			RoutedUseCases: append([]string{}, routed[role]...),
			HasThinkTags:   m.ThinkTags != nil,
			HasSlots:       m.Slots != 0,
			Removable:      !referenced[role],
		})
	}

	providerNames := make([]string, 0, len(cfg.Providers))
	for name := range cfg.Providers {
		providerNames = append(providerNames, name)
	}
	sort.Strings(providerNames)
	agentProvider := selectedAgentProvider(cfg)
	for _, name := range providerNames {
		pc := cfg.Providers[name]
		row := ProviderProjection{Name: name, APIFormat: pc.APIFormat, CredentialState: "none"}
		if pc.APIKey != "" {
			row.CredentialState = "available"
		}
		endpoint, local, err := NormalizeEndpoint(pc.BaseURL)
		switch {
		case err != nil:
			row.Classification = "unknown"
			appendDiagnostic(Diagnostic{
				Code: codeProviderEndpointUnsupported, SubjectKind: "provider",
				SubjectName: name, Blocking: name == agentProvider,
			})
		case local:
			row.Endpoint, row.Classification = endpoint, "local"
		default:
			row.Endpoint, row.Classification = endpoint, "remote"
		}
		p.Providers = append(p.Providers, row)
	}
	if p.ReadOnly || !p.Editable {
		p.State = "limited"
	}
	return p
}

// modelSelector is the (provider, model name) pair that go-llm treats as one
// mutation target: two roles sharing a selector must agree on any explicit
// Capabilities value (validation guarantees it), but can still expose
// different derived capabilities from their own ResolvedCapabilities().
type modelSelector struct {
	provider string
	model    string
}

// projectionIdentityStatus inspects every identity go-llm treats as a
// mutation target — defaults keys/role values, model role keys/model
// names/provider names and references, fallback role names, provider map
// keys, and only non-empty optional parameters. editable is false when a
// required identity is empty or any inspected value changes under
// sanitizeIdentifier (bidi/control spoofing); bounds stay centralized in
// exceedsProjectionBounds. withhold is true for an empty required identity,
// or when two distinct raw use cases, roles, or providers become equal after
// sanitization, or when two distinct raw (provider, model name) mutation
// selectors become the same sanitized selector — any of these would let a
// future write target the wrong entity. An absent optional parameter is
// valid and never sets either flag.
//
// offenseKind/offenseSubject name the FIRST identity that made editable
// false, so the emitted diagnostic isn't a dead end: offenseKind is one of
// "use_case"/"role"/"model"/"provider" per the namespace being inspected
// ("model" covers both model-name and parameters offenses), and
// offenseSubject is that identity's sanitized, bounded form (safe to emit
// as-is). A collision necessarily involves at least one individually
// malformed raw value (two clean values can never sanitize to the same
// string), so it is always named this way too — no separate instrumentation
// needed. An empty-required-identity offense has nothing to name: both stay
// unset for it.
func projectionIdentityStatus(cfg *config.Config) (editable, withhold bool, offenseKind, offenseSubject string) {
	editable = true
	offenseRecorded := false
	recordOffense := func(kind, subject string) {
		if !offenseRecorded {
			offenseKind, offenseSubject, offenseRecorded = kind, subject, true
		}
	}
	inspect := func(kind, value string, required bool) {
		if required && value == "" {
			editable, withhold = false, true
			recordOffense(kind, "") // nothing to name
			return
		}
		if sanitizeIdentifier(value) != value {
			editable = false
			recordOffense(kind, sanitizeIdentifier(value))
		}
	}
	addTarget := func(kind string, namespace map[string]string, value string) {
		inspect(kind, value, true)
		emitted := sanitizeIdentifier(value)
		if raw, ok := namespace[emitted]; ok && raw != value {
			withhold = true
		}
		namespace[emitted] = value
	}

	useCases := map[string]string{}
	roles := map[string]string{}
	providers := map[string]string{}
	modelSelectors := map[modelSelector]modelSelector{}
	addModelSelector := func(providerName, modelName string) {
		raw := modelSelector{provider: providerName, model: modelName}
		emitted := modelSelector{
			provider: sanitizeIdentifier(providerName),
			model:    sanitizeIdentifier(modelName),
		}
		if previous, ok := modelSelectors[emitted]; ok && previous != raw {
			withhold = true
		}
		modelSelectors[emitted] = raw
	}
	defaultKeys := make([]string, 0, len(cfg.Defaults))
	for useCase := range cfg.Defaults {
		defaultKeys = append(defaultKeys, useCase)
	}
	sort.Strings(defaultKeys)
	for _, useCase := range defaultKeys {
		role := cfg.Defaults[useCase]
		addTarget("use_case", useCases, useCase)
		addTarget("role", roles, role)
	}
	modelRoles := make([]string, 0, len(cfg.Models))
	for role := range cfg.Models {
		modelRoles = append(modelRoles, role)
	}
	sort.Strings(modelRoles)
	for _, role := range modelRoles {
		m := cfg.Models[role]
		addTarget("role", roles, role)
		inspect("model", m.Name, true)
		addTarget("provider", providers, m.Provider)
		addModelSelector(m.Provider, m.Name)
		if m.Parameters != "" {
			inspect("model", m.Parameters, false)
		}
		fallbacks := m.Fallbacks
		if len(fallbacks) > maxProjectionEntries {
			fallbacks = fallbacks[:maxProjectionEntries]
		}
		for _, fallback := range fallbacks {
			addTarget("role", roles, fallback)
		}
	}
	providerNames := make([]string, 0, len(cfg.Providers))
	for name := range cfg.Providers {
		providerNames = append(providerNames, name)
	}
	sort.Strings(providerNames)
	for _, name := range providerNames {
		addTarget("provider", providers, name)
	}
	return editable, withhold, offenseKind, offenseSubject
}

// selectorCapabilityOverrides groups sorted roles by (provider, model name)
// selector and retains only the first non-empty explicit Capabilities value
// (validation guarantees any other explicit value on the same selector
// agrees). A role with no selector override projects its own
// ResolvedCapabilities() as ExposedCapabilities instead. Every returned array
// is canonical, copied, and non-nil.
func selectorCapabilityOverrides(cfg *config.Config) map[modelSelector][]string {
	roles := make([]string, 0, len(cfg.Models))
	for role := range cfg.Models {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	overrides := make(map[modelSelector][]string)
	for _, role := range roles {
		m := cfg.Models[role]
		if len(m.Capabilities) == 0 {
			continue
		}
		selector := modelSelector{provider: m.Provider, model: m.Name}
		if _, exists := overrides[selector]; !exists {
			overrides[selector] = canonicalizeCapabilities(m.Capabilities)
		}
	}
	return overrides
}

// roleUsage walks each sorted explicit default through role fallbacks,
// first-seen per use case. routed[role] is the sorted, unique set of use
// cases reaching role (directly or through a fallback chain). referenced
// includes every default target and every fallback target, even inside an
// orphan chain (a fallback target that is not itself a configured model) —
// removable is !referenced[role].
func roleUsage(cfg *config.Config) (map[string][]string, map[string]bool) {
	routed := make(map[string][]string, len(cfg.Models))
	referenced := make(map[string]bool, len(cfg.Models))
	for _, m := range cfg.Models {
		for _, fallback := range m.Fallbacks {
			referenced[fallback] = true
		}
	}
	useCases := make([]string, 0, len(cfg.Defaults))
	for useCase := range cfg.Defaults {
		useCases = append(useCases, useCase)
	}
	sort.Strings(useCases)
	for _, useCase := range useCases {
		seen := map[string]bool{}
		var walk func(string)
		walk = func(role string) {
			if seen[role] {
				return
			}
			seen[role], referenced[role] = true, true
			m, ok := cfg.Models[role]
			if !ok {
				return
			}
			routed[role] = append(routed[role], useCase)
			for _, fallback := range m.Fallbacks {
				walk(fallback)
			}
		}
		walk(cfg.Defaults[useCase])
	}
	return routed, referenced
}

// finalizeSettingsProjection is the single pass every build path funnels
// through: sanitize every identifier, sort every entity/routed-use-case/
// diagnostic array on its emitted value, and drop exact duplicate
// diagnostics. It never deduplicates colliding entities — assembly's
// identity-withhold check (projectionIdentityStatus) already withholds those
// upstream.
func finalizeSettingsProjection(p SettingsProjection) SettingsProjection {
	p = sanitizeProjectionIdentifiers(p)
	sort.Slice(p.Routes, func(i, j int) bool {
		return p.Routes[i].UseCase < p.Routes[j].UseCase
	})
	sort.Slice(p.Models, func(i, j int) bool { return p.Models[i].Role < p.Models[j].Role })
	for i := range p.Models {
		sort.Strings(p.Models[i].RoutedUseCases)
	}
	sort.Slice(p.Providers, func(i, j int) bool { return p.Providers[i].Name < p.Providers[j].Name })
	sortDiagnostics(p.Diagnostics)
	unique := p.Diagnostics[:0]
	for _, d := range p.Diagnostics {
		if len(unique) == 0 || unique[len(unique)-1] != d {
			unique = append(unique, d)
		}
	}
	p.Diagnostics = unique
	return p
}

// exceedsProjectionBounds reports whether any collection, identifier, or
// derived endpoint is over the response bounds. Identifier bounds are
// measured on the SANITIZED form (sanitize-then-bound): sanitizeIdentifier
// maps every scrubbed rune to U+FFFD (3 UTF-8 bytes), which can grow a
// 1-byte control past the limit, and what the ready path emits is the
// sanitized value — so the bound must be checked on exactly that. Endpoints
// are never sanitized and are measured as derived.
func exceedsProjectionBounds(cfg *config.Config) bool {
	if len(cfg.Defaults) > maxProjectionEntries ||
		len(cfg.Models) > maxProjectionEntries ||
		len(cfg.Providers) > maxProjectionEntries {
		return true
	}
	over := func(s string) bool { return len(sanitizeIdentifier(s)) > maxProjectionIdentifierLen }
	for useCase, role := range cfg.Defaults {
		if over(useCase) || over(role) {
			return true
		}
	}
	for role, m := range cfg.Models {
		if over(role) || over(m.Name) || over(m.Provider) || over(m.Type) || over(m.ThinkMode) {
			return true
		}
		if m.Parameters != "" && over(m.Parameters) {
			return true
		}
		if m.ContextWindow < 0 || m.ContextWindow > 2147483647 ||
			m.Dimensions < 0 || m.Dimensions > 2147483647 {
			return true
		}
		if len(m.Fallbacks) > maxProjectionEntries {
			return true
		}
		for _, fallback := range m.Fallbacks {
			if over(fallback) {
				return true
			}
		}
	}
	for name, pc := range cfg.Providers {
		if over(name) || over(pc.APIFormat) {
			return true
		}
		if endpoint, _, err := NormalizeEndpoint(pc.BaseURL); err == nil && len(endpoint) > maxProjectionEndpointLen {
			return true
		}
	}
	return false
}

// selectedAgentProvider names the provider on the agent route, "" when the
// route is incomplete.
func selectedAgentProvider(cfg *config.Config) string {
	role, ok := cfg.RoleForUseCase(useCaseAgent)
	if !ok {
		return ""
	}
	m := cfg.RoleConfig(role)
	if m == nil {
		return ""
	}
	return m.Provider
}

// selectedAgentBlockingDiagnostic returns the agent provider's endpoint
// diagnostic, with its subject bounded (dropped when over the identifier
// limit). The caller only reaches this after agentRouteDiagnostics(cfg) has
// already returned empty, so it never needs to re-check the role/capability
// diagnostics agentRouteDiagnostics itself covers.
func selectedAgentBlockingDiagnostic(cfg *config.Config) (Diagnostic, bool) {
	if name := selectedAgentProvider(cfg); name != "" {
		if pc := cfg.Provider(name); pc != nil {
			if _, _, err := NormalizeEndpoint(pc.BaseURL); err != nil {
				return boundSubject(Diagnostic{
					Code:        codeProviderEndpointUnsupported,
					SubjectKind: "provider",
					SubjectName: name,
					Blocking:    true,
				}), true
			}
		}
	}
	return Diagnostic{}, false
}

// boundSubject drops the subject when its SANITIZED form is over the
// identifier bound — the scrub can grow a raw in-bound name past the limit,
// and the sanitized value is what gets emitted (sanitize-then-bound, same
// order as exceedsProjectionBounds).
func boundSubject(d Diagnostic) Diagnostic {
	if len(sanitizeIdentifier(d.SubjectName)) > maxProjectionIdentifierLen {
		d.SubjectKind = ""
		d.SubjectName = ""
	}
	return d
}

// agentRouteDiagnostics re-states ResolveAgentTarget's role/capability checks
// as diagnostics. Endpoint problems are reported per provider by the caller.
func agentRouteDiagnostics(cfg *config.Config) []Diagnostic {
	role, ok := cfg.RoleForUseCase(useCaseAgent)
	if !ok {
		return []Diagnostic{{Code: codeAgentRoleMissing, Blocking: true}}
	}
	m := cfg.RoleConfig(role)
	if m == nil || m.Provider == "" || cfg.Provider(m.Provider) == nil {
		return []Diagnostic{{Code: codeAgentRoleMissing, SubjectKind: "role", SubjectName: role, Blocking: true}}
	}
	caps, err := provider.ParseCapsStrict(m.ResolvedCapabilities())
	if err != nil {
		// Unreachable post-Load (validate rejects unknown capabilities); the
		// coarse load-failure path owns that case. Guard anyway.
		return []Diagnostic{{Code: codeAgentCapsInsufficient, SubjectKind: "model", SubjectName: role, Blocking: true}}
	}
	if !caps.Has(requiredAgentCaps) {
		return []Diagnostic{{Code: codeAgentCapsInsufficient, SubjectKind: "model", SubjectName: role, Blocking: true}}
	}
	return nil
}

// canonicalizeCapabilities lowercases, deduplicates, and orders tokens by the
// canonical vocabulary; ResolvedCapabilities preserves user case/order/dups,
// which must not leak shape into the contract.
func canonicalizeCapabilities(tokens []string) []string {
	caps, err := provider.ParseCapsStrict(tokens)
	if err != nil {
		return []string{} // unreachable post-Load validation; render no chips
	}
	out := make([]string, 0, len(provider.CanonicalCapabilityNames))
	for _, name := range provider.CanonicalCapabilityNames {
		bit, err := provider.ParseCapsStrict([]string{name})
		if err != nil {
			continue
		}
		if caps.Has(bit) {
			out = append(out, name)
		}
	}
	return out
}

// sortDiagnostics: blocking first, then code, then subject kind, then subject
// name — a deterministic tie-break across both subject fields.
func sortDiagnostics(ds []Diagnostic) {
	sort.Slice(ds, func(i, j int) bool {
		if ds[i].Blocking != ds[j].Blocking {
			return ds[i].Blocking
		}
		if ds[i].Code != ds[j].Code {
			return ds[i].Code < ds[j].Code
		}
		if ds[i].SubjectKind != ds[j].SubjectKind {
			return ds[i].SubjectKind < ds[j].SubjectKind
		}
		return ds[i].SubjectName < ds[j].SubjectName
	})
}
