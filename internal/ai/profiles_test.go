package ai

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

	"firn/internal/filesystem"

	"github.com/kstruzzieri/go-llm/profiles"
)

// TestProfileIDPatternMatchesUpstreamParseID pins Firn's ProfileID shape to
// the upstream store's ParseID, the way TestCapabilityVocabularyPinned pins
// the capability set: if the grammars ever diverge, a listed row could fail
// Firn's closed transport, and this is the drift gate that says so first.
func TestProfileIDPatternMatchesUpstreamParseID(t *testing.T) {
	cases := []string{
		"curated/local", "user/mine", "user/a", "curated/a-b-c", "user/0-9",
		"user/", "user/-lead", "User/mine", "user/UPPER", "mine", "curated//x",
		"user/" + strings.Repeat("a", 64), "user/" + strings.Repeat("a", 65),
		"other/mine", "user/mine.json",
	}
	for _, id := range cases {
		_, err := profiles.ParseID(id)
		if got, want := validProfileID(id), err == nil; got != want {
			t.Errorf("validProfileID(%q) = %v, upstream ParseID accepts = %v", id, got, want)
		}
	}
}

func TestProjectProfileInfos(t *testing.T) {
	rev := strings.Repeat("a", 64)
	rows := []profiles.Info{
		{ID: "curated/local", Description: "Vetted", Curated: true, Revision: rev},
		{ID: "user/mine"},
	}
	infos := projectProfileInfos(rows)
	if len(infos) != 2 {
		t.Fatalf("projected %d rows, want 2", len(infos))
	}
	if infos[0].ID != "curated/local" || !infos[0].Curated ||
		infos[0].Description != "Vetted" || infos[0].Revision != rev {
		t.Fatalf("curated row = %+v", infos[0])
	}
	// §4.8: user rows are id only — nothing invented. The marshaled form is
	// the contract, so absence is asserted on the bytes.
	raw, err := json.Marshal(infos[1])
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"description", "revision"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("user row carries %q: %s", forbidden, raw)
		}
	}
	if infos[1].Curated {
		t.Fatal("user row marked curated")
	}
}

func TestProjectProfileInfosSanitizesAndBounds(t *testing.T) {
	// The oversized description is NOT a plain ASCII repeat: a 3-byte rune
	// (U+4E16) is placed straddling the maxProjectionEndpointLen byte
	// boundary. An ASCII-only fixture would pass even if the trim split a
	// rune mid-byte — every ASCII byte is already a rune boundary — so it
	// proves nothing about the rune-boundary claim below. Layout: an 11-byte
	// sanitized prefix ("bad\uFFFDdesc "), 1011 ASCII filler bytes (reaching
	// byte offset 1022), then the 3-byte rune occupying bytes [1022,1025) —
	// which straddles the 1024-byte limit — plus trailing content so the
	// string exceeds the bound and trimming actually runs.
	const prefix = "bad\u202edesc " // sanitizes to "bad\uFFFDdesc " (11 bytes)
	oversized := prefix + strings.Repeat("x", 1011) + "\u4e16" + "tail"
	rows := []profiles.Info{
		// A control/bidi rune is scrubbed, the oversized description is
		// trimmed at a rune boundary (never splitting the straddling rune
		// above), and a malformed revision never crosses.
		{ID: "curated/local", Curated: true, Description: oversized, Revision: "not-a-revision"},
		{ID: "user/clean", Description: "\u0007"},
	}
	infos := projectProfileInfos(rows)
	if strings.Contains(infos[0].Description, "\u202e") {
		t.Fatal("bidi rune crossed the boundary")
	}
	if len(infos[0].Description) > maxProjectionEndpointLen {
		t.Fatalf("description = %d bytes", len(infos[0].Description))
	}
	// The trim landed on a rune boundary: a naive byte slice at exactly
	// maxProjectionEndpointLen would land inside the straddling rune's UTF-8
	// encoding and produce invalid UTF-8 here.
	if !utf8.ValidString(infos[0].Description) {
		t.Fatalf("description split a rune at the trim boundary: %q", infos[0].Description)
	}
	// The straddling rune is entirely excluded (never emitted partially): the
	// trimmed description is exactly the sanitized prefix plus filler, ending
	// before byte offset 1022.
	if want := len(prefix) + 1011; len(infos[0].Description) != want {
		t.Fatalf("trimmed description = %d bytes, want %d (prefix+filler, rune excluded)",
			len(infos[0].Description), want)
	}
	if infos[0].Revision != "" {
		t.Fatalf("malformed revision crossed: %q", infos[0].Revision)
	}
	// A description that sanitizes to replacement runes only is still content;
	// one that was ONLY a control rune becomes U+FFFD, stays non-empty, and is
	// bounded — nothing here may invent an absent member or drop a present one
	// beyond the documented scrub.
	if infos[1].ID != "user/clean" {
		t.Fatalf("row identity changed: %+v", infos[1])
	}
	if infos[1].Description != "\ufffd" {
		t.Fatalf("control-only description = %q, want U+FFFD", infos[1].Description)
	}
}

func newProfilesTestService(t *testing.T) *Service {
	t.Helper()
	svc := NewService(t.Context(), filesystem.NewOS(), filepath.Join(t.TempDir(), "consent", "grants.json"), nil)
	t.Cleanup(func() { _ = svc.Close(t.Context()) })
	return svc
}

func TestListGolemProfilesCuratedAndUser(t *testing.T) {
	sandboxAgentConfigEnv(t)
	stageUserProfile(t, "mine", keyedProfileJSON)
	svc := newProfilesTestService(t)

	result, err := svc.ListGolemProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "loaded" {
		t.Fatalf("status %q, diagnostics %+v", result.Status, result.Diagnostics)
	}
	if err := validateGolemProfileListResult(result); err != nil {
		t.Fatalf("list violates the §5.6 oracle: %v", err)
	}
	if len(result.Profiles) < 2 {
		t.Fatalf("profiles = %+v", result.Profiles)
	}
	if result.Profiles[0].ID != "curated/local" || !result.Profiles[0].Curated {
		t.Fatalf("first row = %+v, want the embedded curated/local", result.Profiles[0])
	}
	if result.Profiles[0].Description == "" || !validRevision(result.Profiles[0].Revision) {
		t.Fatalf("curated row lost its catalog metadata: %+v", result.Profiles[0])
	}
	last := result.Profiles[len(result.Profiles)-1]
	if last.ID != "user/mine" || last.Curated || last.Description != "" || last.Revision != "" {
		t.Fatalf("user row = %+v, want id-only", last)
	}
}

// The production list can never be empty: the curated catalog is embedded at
// build time, so an empty store still lists curated/local. The wire schema
// tolerates an empty array (corpus), but the producer never emits one — this
// is what lets `profiles,omitempty` stay safe.
func TestListGolemProfilesNeverEmpty(t *testing.T) {
	sandboxAgentConfigEnv(t)
	svc := newProfilesTestService(t)
	result, err := svc.ListGolemProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "loaded" || len(result.Profiles) == 0 {
		t.Fatalf("empty-store list = %+v", result)
	}
}

func TestListGolemProfilesLimited(t *testing.T) {
	sandboxAgentConfigEnv(t)
	// curated/local plus 256 user rows = 257 total -> limited, first 256 in
	// stable ID order (curated block first, then sorted user block).
	for i := 0; i < 256; i++ {
		stageUserProfile(t, "p-"+threeDigits(i), keyedProfileJSON)
	}
	svc := newProfilesTestService(t)

	result, err := svc.ListGolemProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "limited" {
		t.Fatalf("status %q, want limited", result.Status)
	}
	if len(result.Profiles) != maxProjectionEntries {
		t.Fatalf("limited list carries %d rows", len(result.Profiles))
	}
	if result.Profiles[0].ID != "curated/local" {
		t.Fatalf("first limited row = %+v", result.Profiles[0])
	}
	if err := validateGolemProfileListResult(result); err != nil {
		t.Fatalf("limited list violates the oracle: %v", err)
	}
}

func threeDigits(i int) string {
	digits := []byte{'0' + byte(i/100), '0' + byte((i/10)%10), '0' + byte(i%10)}
	return string(digits)
}

func assertStoreUnsafeList(t *testing.T, svc *Service) {
	t.Helper()
	result, err := svc.ListGolemProfiles()
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "diagnostics" || len(result.Diagnostics) != 1 ||
		result.Diagnostics[0].Code != "store_unsafe" {
		t.Fatalf("unsafe-store list = %+v", result)
	}
}

// The portable unsafe-store fixture (Slice B's TestPrepareProfileSourceStoreUnsafe
// shape): a regular file where the profiles directory belongs is unsafe on
// EVERY platform and needs no permission bits or symlink privileges.
func TestListGolemProfilesStoreUnsafe(t *testing.T) {
	sandboxAgentConfigEnv(t)
	root := userProfileStoreRoot(t)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "profiles"),
		[]byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertStoreUnsafeList(t, newProfilesTestService(t))
}

// The Unix-only variant: loose directory modes. Upstream does not enforce
// Unix permission bits on Windows, so chmod 0755 produces no store_unsafe
// there — this cell is skipped rather than asserted wrongly.
func TestListGolemProfilesStoreUnsafePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("upstream does not enforce Unix permission bits on Windows")
	}
	sandboxAgentConfigEnv(t)
	stageUserProfile(t, "mine", keyedProfileJSON)
	if err := os.Chmod(filepath.Join(userProfileStoreRoot(t), "profiles"), 0o755); err != nil {
		t.Fatal(err)
	}
	assertStoreUnsafeList(t, newProfilesTestService(t))
}

func TestListGolemProfilesClosing(t *testing.T) {
	sandboxAgentConfigEnv(t)
	svc := newProfilesTestService(t)
	if err := svc.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ListGolemProfiles(); err == nil {
		t.Fatal("a closing service must refuse the list with an error")
	}
}

// keyedTargetJSON is an ACTIVE target carrying both authored key forms Firn
// recognizes (a literal and a set-env reference) plus one unknown member with
// secret-looking content. §4.8's scrub guarantee is scoped to RECOGNIZED
// api_key members: both key forms must vanish from a saved profile, and the
// unknown member must SURVIVE — profiles are key-scrubbed, not certified
// secret-free.
const keyedTargetJSON = `{
  "providers": {
    "literal": {"base_url": "https://api.example.com/v1", "api_format": "openai-compat",
      "api_key": "sk-profile-literal"},
    "resolved": {"base_url": "https://api.example.net/v1", "api_format": "openai-compat",
      "api_key": "${FIRN_PROFILE_SET_KEY}"},
    "local": {"base_url": "http://localhost:11434"}
  },
  "models": {"agent-m": {"name": "target-model", "provider": "local", "type": "dense",
    "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "agent-m"},
  "x_note": {"token": "sk-unknown-member"}
}`

func stageKeyedSaveTarget(t *testing.T) (revision string) {
	t.Helper()
	stageApplyTarget(t, keyedTargetJSON)
	t.Setenv(profileSetEnvName, profileAmbientSecret)
	return stagedTargetRevision(t)
}

func TestSaveGolemProfileAsCreatesScrubbedProfile(t *testing.T) {
	revision := stageKeyedSaveTarget(t)
	svc := newProfilesTestService(t)

	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "saved" || result.Profile == nil || result.Profile.ID != "user/mine" {
		t.Fatalf("save = %+v", result)
	}
	if err := validateGolemProfileSaveResult(result); err != nil {
		t.Fatalf("save violates the §5.6 oracle: %v", err)
	}

	saved, readErr := os.ReadFile(filepath.Join(userProfileStoreRoot(t), "profiles", "mine.json"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	// §4.8 mutation scan, scoped to the recognized-key guarantee: every
	// literal AND ${ENV} api_key form is gone from the saved bytes…
	for _, forbidden := range []string{
		profileLiteralSecret, profileAmbientSecret, profileSetEnvName, "${", "api_key",
	} {
		if strings.Contains(string(saved), forbidden) {
			t.Fatalf("saved profile carries %q:\n%s", forbidden, saved)
		}
	}
	// …while the unknown member survives canonical save by design.
	if !strings.Contains(string(saved), "sk-unknown-member") {
		t.Fatal("unknown member did not survive the canonical save; the honesty scope moved")
	}
	// The reported revision is the revision OF THE SAVED BYTES.
	if result.Profile.Revision != profileBodyRevision(string(saved)) {
		t.Fatalf("saved revision %q does not hash the written bytes", result.Profile.Revision)
	}
	// The ACTIVE target was not mutated: the fresh-parse rule means the
	// runtime document and the on-disk target keep their keys.
	target, _ := os.ReadFile(os.Getenv("GO_LLM_CONFIG"))
	if !strings.Contains(string(target), profileLiteralSecret) {
		t.Fatal("the active target lost its literal key: the runtime document was handed to the store")
	}
}

func TestSaveGolemProfileAsActiveRevisionConflict(t *testing.T) {
	stageKeyedSaveTarget(t)
	svc := newProfilesTestService(t)
	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", AppliedRevision: strings.Repeat("f", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "conflict" || result.Conflict != "active_revision" {
		t.Fatalf("stale-revision save = %+v", result)
	}
}

func TestSaveGolemProfileAsCreateCollision(t *testing.T) {
	revision := stageKeyedSaveTarget(t)
	stageUserProfile(t, "mine", keyedProfileJSON)
	svc := newProfilesTestService(t)
	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "conflict" || result.Conflict != "profile_target" {
		t.Fatalf("create collision = %+v", result)
	}
}

func TestSaveGolemProfileAsOverwriteCAS(t *testing.T) {
	revision := stageKeyedSaveTarget(t)
	stageUserProfile(t, "mine", keyedProfileJSON)
	svc := newProfilesTestService(t)

	// The §4.8 acquisition step captures the collider's RAW revision — the
	// same value loadProfileDocument reports before the scrub.
	colliderRevision := profileBodyRevision(keyedProfileJSON)

	stale := strings.Repeat("e", 64)
	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", ExpectedRevision: stringPtr(stale), AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "conflict" || result.Conflict != "profile_target" {
		t.Fatalf("stale overwrite = %+v", result)
	}

	result, err = svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", ExpectedRevision: stringPtr(colliderRevision), AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "saved" {
		t.Fatalf("CAS overwrite = %+v", result)
	}
	saved, readErr := os.ReadFile(filepath.Join(userProfileStoreRoot(t), "profiles", "mine.json"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !strings.Contains(string(saved), "target-model") {
		t.Fatal("overwrite did not replace the profile with the applied configuration")
	}
	// §4.8 mutation scan, mirroring TestSaveGolemProfileAsCreatesScrubbedProfile:
	// overwrite is the DESTRUCTIVE direction and the only credential-guarantee
	// path that previously had no mutation scan at all. The collider this
	// replaces (keyedProfileJSON) itself carries every one of these forbidden
	// strings, so this scan also proves the OLD collider bytes are gone, not
	// merely that the new bytes happen to lack them.
	for _, forbidden := range []string{
		profileLiteralSecret, profileAmbientSecret, profileSetEnvName, "${", "api_key",
	} {
		if strings.Contains(string(saved), forbidden) {
			t.Fatalf("overwritten profile carries %q:\n%s", forbidden, saved)
		}
	}
}

// stageAliasedActiveTarget makes the ACTIVE configuration source the store's
// own destination file for user/mine — directly, or through a symlinked
// GO_LLM_CONFIG. Because a Document's revision is the sha256 of its loaded
// bytes, the destination revision and the applied revision are the SAME value
// here, which is exactly what makes a confirmed overwrite reach the store
// without the alias gate. With caseVaried, GO_LLM_CONFIG spells the SAME file
// as MINE.JSON: EvalSymlinks preserves that spelling, so the resolved active
// path and the resolved destination are UNEQUAL strings naming one file — the
// alias only os.SameFile catches (skipped where the filesystem does not fold
// case; the deterministic fold leg has its own test below).
func stageAliasedActiveTarget(t *testing.T, viaSymlink, caseVaried bool) (revision string) {
	t.Helper()
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	profilesDir := filepath.Join(userProfileStoreRoot(t), "profiles")
	if err := os.MkdirAll(profilesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(profilesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(profilesDir, "mine.json")
	if err := os.WriteFile(destination, []byte(keyedTargetJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	spelled := destination
	if caseVaried {
		spelled = filepath.Join(profilesDir, "MINE.JSON")
		if _, err := os.Stat(spelled); err != nil {
			t.Skip("case-sensitive filesystem: MINE.JSON does not open mine.json here")
		}
	}
	target := spelled
	if viaSymlink {
		target = filepath.Join(t.TempDir(), "models.json")
		if err := os.Symlink(spelled, target); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("GO_LLM_CONFIG", target)
	t.Setenv(profileSetEnvName, profileAmbientSecret)
	return stagedTargetRevision(t)
}

func assertActiveAliasRefused(t *testing.T, revision string) {
	t.Helper()
	svc := newProfilesTestService(t)
	activePath := filepath.Join(userProfileStoreRoot(t), "profiles", "mine.json")
	before, err := os.ReadFile(activePath)
	if err != nil {
		t.Fatal(err)
	}
	// The dangerous form: a confirmed overwrite whose expectedRevision matches
	// the destination — without the gate, Store.SaveAs would replace the
	// ACTIVE file with its scrubbed copy under the read gate.
	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", ExpectedRevision: stringPtr(revision), AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "diagnostics" || len(result.Diagnostics) != 1 ||
		result.Diagnostics[0].Code != "store_unsafe" || result.Diagnostics[0].ProfileID != "user/mine" {
		t.Fatalf("aliased save = %+v, want the bounded store_unsafe refusal", result)
	}
	after, err := os.ReadFile(activePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("the refusal touched the active configuration bytes")
	}
	if !strings.Contains(string(after), profileLiteralSecret) {
		t.Fatal("the active target lost its literal key: the scrubbed copy reached the store")
	}
}

// TestSaveGolemProfileAsRefusesActiveAlias: a destination that IS the
// active configuration source is refused with store_unsafe (controller ruling,
// header block) — never scrubbed-and-replaced under the read gate.
func TestSaveGolemProfileAsRefusesActiveAlias(t *testing.T) {
	revision := stageAliasedActiveTarget(t, false, false)
	assertActiveAliasRefused(t, revision)
}

func TestSaveGolemProfileAsRefusesActiveAliasSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink staging needs privileges on Windows")
	}
	revision := stageAliasedActiveTarget(t, true, false)
	assertActiveAliasRefused(t, revision)
}

// The case alias: the active source discovered through a case-varied
// GO_LLM_CONFIG (profiles/MINE.JSON) IS user/mine's destination on macOS's
// default case-insensitive filesystems, while every resolved-path string
// comparison says otherwise. Only file identity refuses it.
func TestSaveGolemProfileAsRefusesActiveAliasCaseVaried(t *testing.T) {
	revision := stageAliasedActiveTarget(t, false, true)
	assertActiveAliasRefused(t, revision)
}

func TestSaveGolemProfileAsRefusesActiveAliasCaseVariedSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink staging needs privileges on Windows")
	}
	revision := stageAliasedActiveTarget(t, true, true)
	assertActiveAliasRefused(t, revision)
}

// The absent-destination leg is deliberately conservative (controller ruling,
// header block): parents matching by file identity plus case-folded basenames
// refuse, so even on a case-SENSITIVE filesystem a store whose ACTIVE file
// differs from a profile destination only by letter case is an unsafe store.
// Deterministic on every filesystem: on a folding one the destination exists
// and os.SameFile refuses; on a non-folding one it does not exist and the
// case-folded parent comparison refuses.
func TestSaveGolemProfileAsRefusesCaseFoldedCreateDestination(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	profilesDir := filepath.Join(userProfileStoreRoot(t), "profiles")
	if err := os.MkdirAll(profilesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(profilesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(profilesDir, "OTHER.JSON")
	if err := os.WriteFile(active, []byte(keyedTargetJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", active)
	t.Setenv(profileSetEnvName, profileAmbientSecret)
	revision := stagedTargetRevision(t)
	svc := newProfilesTestService(t)

	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/other", AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "diagnostics" || len(result.Diagnostics) != 1 ||
		result.Diagnostics[0].Code != "store_unsafe" || result.Diagnostics[0].ProfileID != "user/other" {
		t.Fatalf("case-folded create = %+v, want the bounded store_unsafe refusal", result)
	}
	after, readErr := os.ReadFile(active)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(after) != keyedTargetJSON {
		t.Fatal("the refusal touched the active configuration bytes")
	}
}

func TestSaveGolemProfileAsRequestShapeRefusals(t *testing.T) {
	revision := stageKeyedSaveTarget(t)
	svc := newProfilesTestService(t)
	rows := []struct {
		name string
		req  SaveGolemProfileAsRequest
		code string
	}{
		{"curated namespace", SaveGolemProfileAsRequest{ID: "curated/local", AppliedRevision: revision}, "curated_read_only"},
		{"bad id", SaveGolemProfileAsRequest{ID: "user/UPPER", AppliedRevision: revision}, "invalid_id"},
		{"bare slug", SaveGolemProfileAsRequest{ID: "mine", AppliedRevision: revision}, "invalid_id"},
		{"malformed applied revision", SaveGolemProfileAsRequest{ID: "user/mine", AppliedRevision: "123"}, "invalid_id"},
		// §5.3: no empty-string sentinel — present-and-empty must never reach
		// the store, where it would silently mean create-only.
		{"empty expected revision", SaveGolemProfileAsRequest{ID: "user/mine", ExpectedRevision: stringPtr(""), AppliedRevision: revision}, "invalid_id"},
	}
	for _, row := range rows {
		result, err := svc.SaveGolemProfileAs(row.req)
		if err != nil {
			t.Fatalf("%s: %v", row.name, err)
		}
		if result.Status != "diagnostics" || len(result.Diagnostics) != 1 ||
			result.Diagnostics[0].Code != row.code {
			t.Fatalf("%s = %+v, want %s", row.name, result, row.code)
		}
	}
}

func TestSaveGolemProfileAsRefusesMissingActive(t *testing.T) {
	// Missing: no applied source at all (§4.8 — Save refused).
	sandboxAgentConfigEnv(t)
	svc := newProfilesTestService(t)
	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", AppliedRevision: strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "diagnostics" || result.Diagnostics[0].Code != "active_config_invalid" {
		t.Fatalf("missing-target save = %+v", result)
	}
}

func TestSaveGolemProfileAsRefusesLimitedActive(t *testing.T) {
	// A read-only (duplicate keys) target is Limited: not a valid applied
	// source at state 'ready' (§4.8 duplicate-era rule).
	stageApplyTarget(t, duplicateProviderDocumentJSON)
	revision := stagedTargetRevision(t)
	svc := newProfilesTestService(t)
	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "diagnostics" || result.Diagnostics[0].Code != "active_config_invalid" {
		t.Fatalf("limited-target save = %+v", result)
	}
}

func TestSaveGolemProfileAsProfileLimitOnCreateOnly(t *testing.T) {
	revision := stageKeyedSaveTarget(t)
	for i := 0; i < 256; i++ {
		stageUserProfile(t, "p-"+threeDigits(i), keyedProfileJSON)
	}
	svc := newProfilesTestService(t)

	// 257 total rows: the list is limited, so a CREATE is refused…
	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/one-more", AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "diagnostics" || result.Diagnostics[0].Code != "profile_limit" {
		t.Fatalf("over-limit create = %+v", result)
	}
	// …while replacing an existing profile by exact id/revision stays open.
	result, err = svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/p-000", ExpectedRevision: stringPtr(profileBodyRevision(keyedProfileJSON)),
		AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "saved" {
		t.Fatalf("over-limit overwrite = %+v", result)
	}
}

// The durability warning is the nil-error path (§4.8): SaveOutcome.Persisted
// pairs with a nil error and the bounded warning code. The store cannot be
// driven into that state from here, so the mapping is pinned as a pure table.
func TestProfileSaveResultMapping(t *testing.T) {
	rev := strings.Repeat("c", 64)
	rows := []struct {
		name    string
		outcome profiles.SaveOutcome
		err     error
		want    GolemProfileSaveResult
	}{
		{"saved", profiles.SaveOutcome{Persisted: true, Revision: rev}, nil,
			GolemProfileSaveResult{Status: "saved", Profile: &SavedProfile{ID: "user/mine", Revision: rev}}},
		{"saved with durability warning", profiles.SaveOutcome{Persisted: true, Warning: profiles.CodeDurability, Revision: rev}, nil,
			GolemProfileSaveResult{Status: "saved", Profile: &SavedProfile{ID: "user/mine", Revision: rev}, Warning: "durability_uncertain"}},
	}
	for _, row := range rows {
		got := profileSaveResult("user/mine", row.outcome, row.err)
		if got.Status != row.want.Status || got.Warning != row.want.Warning ||
			(got.Profile == nil) != (row.want.Profile == nil) ||
			(got.Profile != nil && *got.Profile != *row.want.Profile) {
			t.Fatalf("%s = %+v, want %+v", row.name, got, row.want)
		}
	}
}

func TestSaveGolemProfileAsRunsWhileConversationsBusy(t *testing.T) {
	revision := stageKeyedSaveTarget(t)
	svc := newProfilesTestService(t)
	// A running conversation owns the idle barrier; writeSettings would answer
	// busy. Save is deliberately NOT under that barrier (§5.3).
	conv := svc.conversationFor("busy-conversation")
	conv.mu.Lock()
	conv.state = stateRunning
	conv.mu.Unlock()
	t.Cleanup(func() {
		conv.mu.Lock()
		conv.state = stateIdle
		conv.mu.Unlock()
	})

	result, err := svc.SaveGolemProfileAs(SaveGolemProfileAsRequest{
		ID: "user/mine", AppliedRevision: revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "saved" {
		t.Fatalf("busy-time save = %+v, want saved (no idle barrier)", result)
	}
}
