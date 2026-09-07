package ai

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/kstruzzieri/go-llm/config"
)

// Defense in depth for the raw Golem read path. Since the frontend adapter
// routes the object-returning Golem calls through the runtime's raw Call.ByID
// (frontend/src/wails/bindings.ts), the wire-contract validators see exactly
// what Go marshals -- nothing defaults a missing key and nothing rewrites a
// null collection to []. Two producer-side properties therefore have to hold,
// and both are asserted here rather than repaired on the frontend:
//
//   - every required key is always emitted (an `omitempty` that crept onto a
//     required field drops its key at the zero value), and
//   - every required collection -- slice or map -- marshals as [] / {}, never
//     null.
//
// The required-key property is checked two ways, because neither way alone is
// enough:
//
//   - Fixture round trip (TestContractResultsKeepEveryWireKey). Decode an
//     accept fixture into its Go type, marshal it back, diff the key sets at
//     every level. This reaches nested paths, but only DETECTS an omitempty
//     where some fixture happens to carry the Go zero value at that path --
//     omitempty drops nothing otherwise, and most key paths in the accept
//     corpora never carry a zero value.
//   - Zero-value marshal (TestContractResultsEmitRequiredKeysWhenZeroValued).
//     Marshal a zero-valued instance of each result type and require every
//     required top-level key to survive. Unconditional -- an omitempty on a
//     required scalar is caught whatever the fixtures hold -- but top-level
//     only, since a zero value carries no nested document to walk.

// ---------------------------------------------------------------------------
// Required keys
// ---------------------------------------------------------------------------

// contractResultTarget returns a fresh decode target for one result document
// of the shared apply corpus, or nil for the request documents (those are
// inputs; the frontend never parses one as a call result).
func contractResultTarget(document string) any {
	switch document {
	case "apply_result":
		return &SettingsApplyResult{}
	case "cancel_result":
		return &CancelSettingsApplyResult{}
	case "profile_load_result":
		return &GolemProfileLoadResult{}
	default:
		return nil
	}
}

// jsonKeys reports every object key present in v, addressed by path.
func jsonKeys(v any, where string, out map[string]bool) {
	switch typed := v.(type) {
	case map[string]any:
		for key, child := range typed {
			out[where+"."+key] = true
			jsonKeys(child, where+"."+key, out)
		}
	case []any:
		for i, child := range typed {
			jsonKeys(child, fmt.Sprintf("%s[%d]", where, i), out)
		}
	}
}

func decodedKeys(t *testing.T, raw []byte, where string) map[string]bool {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	keys := map[string]bool{}
	jsonKeys(v, "", keys)
	return keys
}

// checkKeyParity decodes raw into target, marshals it back, and reports every
// key the round trip lost or invented. A key lost here is a key the frontend
// validator would reject as missing, because it now sees the raw payload.
func checkKeyParity(t *testing.T, raw []byte, target any, where string) {
	t.Helper()
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatalf("%s: decode: %v", where, err)
	}
	round, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("%s: marshal: %v", where, err)
	}
	want := decodedKeys(t, raw, where)
	got := decodedKeys(t, round, where)
	var lost, added []string
	for key := range want {
		if !got[key] {
			lost = append(lost, key)
		}
	}
	for key := range got {
		if !want[key] {
			added = append(added, key)
		}
	}
	sort.Strings(lost)
	sort.Strings(added)
	if len(lost) > 0 {
		t.Errorf("%s: round trip dropped %v (a required field grew an omitempty tag)", where, lost)
	}
	if len(added) > 0 {
		t.Errorf("%s: round trip invented %v", where, added)
	}
}

// fixtureDoc is one accept fixture's payload plus the file it came from, so an
// error still names the fixture after the corpora are grouped by document.
type fixtureDoc struct {
	file string
	raw  json.RawMessage
}

// acceptFixtureDocuments groups every accept fixture of the two shared corpora
// by its document kind: the projection corpus under "projection", the apply
// corpus under its own `document` field.
func acceptFixtureDocuments(t *testing.T) map[string][]fixtureDoc {
	t.Helper()
	docs := map[string][]fixtureDoc{}

	projections, err := filepath.Glob(filepath.Join("testdata", "settings_contract", "accept-*.json"))
	if err != nil || len(projections) == 0 {
		t.Fatalf("projection corpus missing: %v (%d files)", err, len(projections))
	}
	for _, file := range projections {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var entry struct {
			Projection json.RawMessage `json:"projection"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		docs["projection"] = append(docs["projection"], fixtureDoc{file: file, raw: entry.Projection})
	}

	results, err := filepath.Glob(filepath.Join("testdata", "settings_apply_contract", "accept-*.json"))
	if err != nil || len(results) == 0 {
		t.Fatalf("apply corpus missing: %v (%d files)", err, len(results))
	}
	for _, file := range results {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var fixture applyFixture
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		docs[fixture.Document] = append(docs[fixture.Document], fixtureDoc{file: file, raw: fixture.Value})
	}
	return docs
}

// TestContractResultsKeepEveryWireKey replays every accept fixture of the two
// shared corpora through its Go result type: what comes back out must carry
// the same keys, at every level, that the fixture carried in. The required set
// is the fixtures' own, so nothing here is a hand-maintained list.
func TestContractResultsKeepEveryWireKey(t *testing.T) {
	docs := acceptFixtureDocuments(t)
	for _, doc := range docs["projection"] {
		checkKeyParity(t, doc.raw, &SettingsProjection{}, doc.file)
	}

	covered := 0
	for document, fixtures := range docs {
		if document == "projection" {
			continue
		}
		for _, doc := range fixtures {
			target := contractResultTarget(document)
			if target == nil {
				continue
			}
			covered++
			checkKeyParity(t, doc.raw, target, doc.file)
		}
	}
	if covered == 0 {
		t.Fatal("apply corpus carries no result fixtures")
	}
}

// ---------------------------------------------------------------------------
// Required keys at the zero value
// ---------------------------------------------------------------------------

// topLevelKeys returns the object keys of one JSON document.
func topLevelKeys(t *testing.T, raw []byte, where string) map[string]bool {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	keys := map[string]bool{}
	for key := range doc {
		keys[key] = true
	}
	return keys
}

func sortedKeys(keys map[string]bool) []string {
	out := make([]string, 0, len(keys))
	for key := range keys {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

// corpusRequiredKeys returns the top-level keys EVERY accept fixture of a
// document carries -- the corpus' own statement of what a result of that type
// always has to carry. Data-derived, like the round trip above.
func corpusRequiredKeys(t *testing.T, fixtures []fixtureDoc, where string) []string {
	t.Helper()
	if len(fixtures) == 0 {
		t.Fatalf("%s: no accept fixtures", where)
	}
	var required map[string]bool
	for _, doc := range fixtures {
		keys := topLevelKeys(t, doc.raw, doc.file)
		if required == nil {
			required = keys
			continue
		}
		for key := range required {
			if !keys[key] {
				delete(required, key)
			}
		}
	}
	return sortedKeys(required)
}

// taggedRequiredKeys reads the required top-level keys off the struct tags, for
// the result types no corpus covers: every exported field with a json name, no
// omitempty, and a non-pointer type -- a nil pointer marshals as null, which is
// a value, not a missing key.
func taggedRequiredKeys(typ reflect.Type) []string {
	keys := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !field.IsExported() || field.Type.Kind() == reflect.Pointer {
			continue
		}
		tag := strings.Split(field.Tag.Get("json"), ",")
		name := tag[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		optional := false
		for _, opt := range tag[1:] {
			if opt == "omitempty" {
				optional = true
			}
		}
		if !optional {
			keys[name] = true
		}
	}
	return sortedKeys(keys)
}

// TestContractResultsEmitRequiredKeysWhenZeroValued marshals a ZERO-VALUED
// instance of every contract result type the frontend validators consume and
// requires each required top-level key to survive. Unlike the fixture round
// trip this does not depend on a fixture happening to carry the Go zero value
// at that path, so an `omitempty` on any required scalar is caught whatever the
// corpora hold.
//
// Two structural limits, both deliberate:
//
//   - Top-level only. A zero value carries no nested document, so nested
//     required keys stay the round trip's job.
//   - For the three types with no fixture corpus (Status, SettingsReloadResult,
//     TurnAdmission) the required set is read off the struct tags, which the
//     marshal obeys by construction. That leg pins the shape against a custom
//     MarshalJSON, a dropped json tag or a rename, but an added omitempty
//     shrinks the expectation along with the output and would slip through.
//     Only a fixture corpus closes that, and those three have none.
func TestContractResultsEmitRequiredKeysWhenZeroValued(t *testing.T) {
	docs := acceptFixtureDocuments(t)
	cases := []struct {
		name     string
		zero     any
		required []string
		derived  string
	}{
		{"SettingsProjection", &SettingsProjection{},
			corpusRequiredKeys(t, docs["projection"], "projection"), "corpus"},
		{"SettingsApplyResult", &SettingsApplyResult{},
			corpusRequiredKeys(t, docs["apply_result"], "apply_result"), "corpus"},
		{"CancelSettingsApplyResult", &CancelSettingsApplyResult{},
			corpusRequiredKeys(t, docs["cancel_result"], "cancel_result"), "corpus"},
		{"GolemProfileLoadResult", &GolemProfileLoadResult{},
			corpusRequiredKeys(t, docs["profile_load_result"], "profile_load_result"), "corpus"},
		{"Status", &Status{}, taggedRequiredKeys(reflect.TypeOf(Status{})), "tags"},
		{"SettingsReloadResult", &SettingsReloadResult{},
			taggedRequiredKeys(reflect.TypeOf(SettingsReloadResult{})), "tags"},
		{"TurnAdmission", &TurnAdmission{}, taggedRequiredKeys(reflect.TypeOf(TurnAdmission{})), "tags"},
	}
	for _, tc := range cases {
		if len(tc.required) == 0 {
			t.Errorf("%s: derived no required keys from the %s -- the check would be vacuous", tc.name, tc.derived)
			continue
		}
		raw, err := json.Marshal(tc.zero)
		if err != nil {
			t.Fatalf("%s: marshal: %v", tc.name, err)
		}
		emitted := topLevelKeys(t, raw, tc.name)
		var missing []string
		for _, key := range tc.required {
			if !emitted[key] {
				missing = append(missing, key)
			}
		}
		if len(missing) > 0 {
			t.Errorf("%s: zero value omits required keys %v (%s-derived) -- an omitempty on a required field",
				tc.name, missing, tc.derived)
		}
	}
}

// ---------------------------------------------------------------------------
// Required collections
// ---------------------------------------------------------------------------

// requiredNilCollections walks v and returns the path of every slice or map
// field whose json tag has no omitempty -- a required array or object by
// contract -- that is nil, and would therefore marshal as null.
func requiredNilCollections(v reflect.Value, where string, out *[]string) {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			requiredNilCollections(v.Elem(), where, out)
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			field := v.Type().Field(i)
			if !field.IsExported() {
				continue
			}
			tag := strings.Split(field.Tag.Get("json"), ",")
			name := tag[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = field.Name
			}
			optional := false
			for _, opt := range tag[1:] {
				if opt == "omitempty" {
					optional = true
				}
			}
			child := v.Field(i)
			path := where + "." + name
			isCollection := child.Kind() == reflect.Slice || child.Kind() == reflect.Map
			if isCollection && !optional && child.IsNil() {
				*out = append(*out, path)
			}
			requiredNilCollections(child, path, out)
		}
	case reflect.Slice:
		for i := 0; i < v.Len(); i++ {
			requiredNilCollections(v.Index(i), fmt.Sprintf("%s[%d]", where, i), out)
		}
	case reflect.Map:
		for _, key := range v.MapKeys() {
			requiredNilCollections(v.MapIndex(key), fmt.Sprintf("%s[%v]", where, key.Interface()), out)
		}
	}
}

func assertNoRequiredNilCollections(t *testing.T, where string, value any) {
	t.Helper()
	var nils []string
	requiredNilCollections(reflect.ValueOf(value), where, &nils)
	if len(nils) > 0 {
		sort.Strings(nils)
		t.Errorf("%s: nil required collections %v marshal as null, but the contract says array", where, nils)
	}
}

// TestContractResultCollectionsNeverMarshalNull exercises the real producers --
// not hand-built literals -- and asserts none of them hands the Wails layer a
// nil required collection.
//
// What this leg does NOT reach. TurnAdmission and its members declare no
// required collection at all, so the walk has nothing to check there and no
// TurnAdmission producer is exercised below; if one is ever added, add its
// producer here. TestContractResultsKeepEveryWireKey would NOT start caring:
// it iterates only the fixture-backed result documents (apply_result /
// cancel_result / profile_load_result -- see contractResultTarget), and there
// is no TurnAdmission fixture anywhere under testdata/.
//
// Three of the result types the frontend validators consume have no key-parity
// corpus at all: TurnAdmission, Status and SettingsReloadResult. Status and
// SettingsReloadResult are still covered here (Service.Status /
// Service.ReloadSettings below), and all three by the zero-value marshal in
// TestContractResultsEmitRequiredKeysWhenZeroValued. TurnAdmission has nothing
// else on the Go side; on the frontend it is covered only by the routing and
// payload-identity assertions in golemRawCalls.test.ts, which prove the payload
// arrives untouched but assert nothing about which keys it carries.
func TestContractResultCollectionsNeverMarshalNull(t *testing.T) {
	// The pure projection builder, on the branches that carry no entities.
	assertNoRequiredNilCollections(t, "missing",
		buildSettingsProjection(loadedAgentConfig{Origin: originUserConfig}, ErrAgentConfigMissing))
	assertNoRequiredNilCollections(t, "invalid",
		buildSettingsProjection(loadedAgentConfig{Origin: originUserConfig}, ErrAgentConfigInvalid))
	// A syntactically fine document with no providers, models or defaults: the
	// ready branch with every collection legitimately empty.
	empty := buildSettingsProjection(projectionLoaded(&config.Config{}), nil)
	assertNoRequiredNilCollections(t, "ready-empty", empty)
	assertNoRequiredNilCollections(t, "ready-empty-clone", empty.clone())
	// A populated document, so the per-model capability slices are walked too.
	populated := buildSettingsProjection(projectionLoaded(projectionConfig()), nil)
	assertNoRequiredNilCollections(t, "ready", populated)
	assertNoRequiredNilCollections(t, "ready-clone", populated.clone())

	// The service-level producers behind GetGolemSettings, ReloadGolemSettings,
	// GetGolemStatus and CancelGolemSettingsApply. ProfileDraftProjection is
	// not built here: LoadGolemProfile copies its collections straight off a
	// SettingsProjection, which the cases above already cover.
	h := newServiceHarness(t, "http://127.0.0.1:1")
	settings, err := h.svc.Settings()
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	assertNoRequiredNilCollections(t, "Service.Settings", settings)

	reloaded, err := h.svc.ReloadSettings()
	if err != nil {
		t.Fatalf("ReloadSettings: %v", err)
	}
	assertNoRequiredNilCollections(t, "Service.ReloadSettings", reloaded)

	status, err := h.svc.Status(StatusRequest{})
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	assertNoRequiredNilCollections(t, "Service.Status", status)

	assertNoRequiredNilCollections(t, "Service.CancelSettingsApply", h.svc.CancelSettingsApply("no-such-token"))
}
