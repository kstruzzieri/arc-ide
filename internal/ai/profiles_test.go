package ai

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

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
	rows := []profiles.Info{
		// A control rune is scrubbed, an oversized description is trimmed at a
		// rune boundary, and a malformed revision never crosses.
		{ID: "curated/local", Curated: true,
			Description: "bad\u202edesc " + strings.Repeat("x", 2000), Revision: "not-a-revision"},
		{ID: "user/clean", Description: "\u0007"},
	}
	infos := projectProfileInfos(rows)
	if strings.Contains(infos[0].Description, "\u202e") {
		t.Fatal("bidi rune crossed the boundary")
	}
	if len(infos[0].Description) > maxProjectionEndpointLen {
		t.Fatalf("description = %d bytes", len(infos[0].Description))
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
