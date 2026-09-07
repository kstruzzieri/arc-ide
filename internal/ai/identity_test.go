package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"firn/internal/filesystem"
)

// newRepo creates a real on-disk repo dir with a root go.mod and a nested
// frontend workspace, returning its path (not canonicalized).
func newRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	writeFile(t, filepath.Join(repo, "go.mod"), "module x\n")
	writeFile(t, filepath.Join(repo, "frontend", "package.json"), `{"dependencies":{"react":"^18"}}`)
	return repo
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func canonical(t *testing.T, path string) string {
	t.Helper()
	c, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestBindingsCanonicalAliases(t *testing.T) {
	repo := newRepo(t)
	if err := os.Mkdir(filepath.Join(repo, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(repo, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	root := canonical(t, repo)
	wantKey := sha256.Sum256([]byte(root))
	want := hex.EncodeToString(wantKey[:])

	aliases := []struct {
		name string
		path string
	}{
		{"absolute", repo},
		// Concatenation, not filepath.Join: Join would Clean away "sub/.." and
		// Bind would receive an already-clean path.
		{"lexical", filepath.Join(repo, "sub") + string(filepath.Separator) + ".."},
		{"symlink", link},
	}
	for _, alias := range aliases {
		t.Run(alias.name, func(t *testing.T) {
			b := NewBindings(filesystem.NewOS())
			id, err := b.Bind(alias.path)
			if err != nil {
				t.Fatalf("Bind(%q): %v", alias.path, err)
			}
			if id.RepoKey != want {
				t.Errorf("RepoKey = %q, want full SHA-256 of canonical root %q", id.RepoKey, want)
			}
		})
	}
}

func TestBindingsBindErrors(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "plain.txt")
	writeFile(t, file, "not a dir")

	for _, tc := range []struct {
		name string
		path string
	}{
		{"missing", filepath.Join(dir, "does-not-exist")},
		{"not a directory", file},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := NewBindings(filesystem.NewOS())
			if _, err := b.Bind(tc.path); !errors.Is(err, ErrWorkspaceUnavailable) {
				t.Errorf("Bind(%q) error = %v, want ErrWorkspaceUnavailable", tc.path, err)
			}
		})
	}
}

func TestBindingsEpochs(t *testing.T) {
	repoA := newRepo(t)
	repoB := newRepo(t)
	b := NewBindings(filesystem.NewOS())

	idA1, err := b.Bind(repoA)
	if err != nil {
		t.Fatal(err)
	}
	if idA1.RepoEpoch == 0 {
		t.Fatal("first Bind allocated epoch 0")
	}

	// Repeated Bind of the same repo is an idempotent refresh.
	idA1b, err := b.Bind(repoA)
	if err != nil {
		t.Fatal(err)
	}
	if idA1b != idA1 {
		t.Errorf("repeated Bind(A) = %+v, want unchanged %+v", idA1b, idA1)
	}

	// A -> B -> A: three strictly increasing epochs.
	idB, err := b.Bind(repoB)
	if err != nil {
		t.Fatal(err)
	}
	idA2, err := b.Bind(repoA)
	if err != nil {
		t.Fatal(err)
	}
	if idA1.RepoEpoch >= idB.RepoEpoch || idB.RepoEpoch >= idA2.RepoEpoch {
		t.Errorf("epochs not increasing: A=%d B=%d A=%d", idA1.RepoEpoch, idB.RepoEpoch, idA2.RepoEpoch)
	}
	if idA2.RepoKey != idA1.RepoKey {
		t.Errorf("rebind changed RepoKey: %q vs %q", idA2.RepoKey, idA1.RepoKey)
	}

	// A -> Unbind -> A advances the epoch.
	b.Unbind()
	if _, ok := b.Current(); ok {
		t.Error("Current() reports a binding after Unbind")
	}
	idA3, err := b.Bind(repoA)
	if err != nil {
		t.Fatal(err)
	}
	if idA3.RepoEpoch <= idA2.RepoEpoch {
		t.Errorf("epoch after Unbind = %d, want > %d", idA3.RepoEpoch, idA2.RepoEpoch)
	}

	cur, ok := b.Current()
	if !ok || cur != idA3 {
		t.Errorf("Current() = %+v %v, want %+v true", cur, ok, idA3)
	}
}

func TestBindingsResolve(t *testing.T) {
	repo := newRepo(t)
	root := canonical(t, repo)
	b := NewBindings(filesystem.NewOS())
	id, err := b.Bind(repo)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		workspaceID  string
		wantToolRoot string
		wantRel      string
	}{
		{"project", root, ""},
		{"root:go", root, ""},
		{"frontend", canonical(t, filepath.Join(repo, "frontend")), "frontend"},
	} {
		t.Run(tc.workspaceID, func(t *testing.T) {
			rw, err := b.Resolve(id.RepoEpoch, tc.workspaceID)
			if err != nil {
				t.Fatalf("Resolve(%d, %q): %v", id.RepoEpoch, tc.workspaceID, err)
			}
			if rw.ToolRoot != tc.wantToolRoot {
				t.Errorf("ToolRoot = %q, want %q", rw.ToolRoot, tc.wantToolRoot)
			}
			if rw.RepoRoot != root {
				t.Errorf("RepoRoot = %q, want %q", rw.RepoRoot, root)
			}
			if rw.WorkspaceRel != tc.wantRel {
				t.Errorf("WorkspaceRel = %q, want %q", rw.WorkspaceRel, tc.wantRel)
			}
			if rw.workspaceLexicalRel != "" {
				t.Errorf("workspaceLexicalRel = %q, want no alternate for a canonical workspace", rw.workspaceLexicalRel)
			}
			if rw.WorkspaceID != tc.workspaceID {
				t.Errorf("WorkspaceID = %q, want %q", rw.WorkspaceID, tc.workspaceID)
			}
			if rw.RepositoryIdentity != id {
				t.Errorf("RepositoryIdentity = %+v, want %+v", rw.RepositoryIdentity, id)
			}
			if rw.WorkspaceName == "" {
				t.Error("WorkspaceName is empty")
			}
		})
	}

	t.Run("unknown workspace", func(t *testing.T) {
		if _, err := b.Resolve(id.RepoEpoch, "nope"); !errors.Is(err, ErrRequestRejected) {
			t.Errorf("error = %v, want ErrRequestRejected", err)
		}
	})
	t.Run("zero epoch", func(t *testing.T) {
		if _, err := b.Resolve(0, "project"); !errors.Is(err, ErrRequestRejected) {
			t.Errorf("error = %v, want ErrRequestRejected", err)
		}
	})
	t.Run("stale epoch", func(t *testing.T) {
		other := newRepo(t)
		if _, err := b.Bind(other); err != nil {
			t.Fatal(err)
		}
		if _, err := b.Resolve(id.RepoEpoch, "project"); !errors.Is(err, ErrRequestRejected) {
			t.Errorf("error = %v, want ErrRequestRejected", err)
		}
	})
	t.Run("unbound", func(t *testing.T) {
		unbound := NewBindings(filesystem.NewOS())
		if _, err := unbound.Resolve(1, "project"); !errors.Is(err, ErrWorkspaceUnavailable) {
			t.Errorf("error = %v, want ErrWorkspaceUnavailable", err)
		}
	})
	t.Run("unbound after Unbind", func(t *testing.T) {
		bb := NewBindings(filesystem.NewOS())
		id, err := bb.Bind(newRepo(t))
		if err != nil {
			t.Fatal(err)
		}
		bb.Unbind()
		if _, err := bb.Resolve(id.RepoEpoch, "project"); !errors.Is(err, ErrWorkspaceUnavailable) {
			t.Errorf("error = %v, want ErrWorkspaceUnavailable", err)
		}
	})
}

// TestBindingsProjectIDNotShadowed proves a repo subdirectory literally named
// "project" (whose detected workspace ID collides with the synthetic whole-repo
// entry) cannot narrow Resolve("project") to the subdirectory.
func TestBindingsProjectIDNotShadowed(t *testing.T) {
	repo := newRepo(t)
	writeFile(t, filepath.Join(repo, "project", "go.mod"), "module p\n")

	b := NewBindings(filesystem.NewOS())
	id, err := b.Bind(repo)
	if err != nil {
		t.Fatal(err)
	}
	rw, err := b.Resolve(id.RepoEpoch, "project")
	if err != nil {
		t.Fatal(err)
	}
	if want := canonical(t, repo); rw.ToolRoot != want {
		t.Errorf("ToolRoot = %q, want whole-repo root %q (shadowed by project/ subdir)", rw.ToolRoot, want)
	}
	if rw.WorkspaceRel != "" {
		t.Errorf("WorkspaceRel = %q, want \"\"", rw.WorkspaceRel)
	}
}

// TestBindingsFailedBindKeepsBinding proves a failed Bind does not disturb the
// current binding: identity, Current, and Resolve all keep working.
func TestBindingsFailedBindKeepsBinding(t *testing.T) {
	repo := newRepo(t)
	b := NewBindings(filesystem.NewOS())
	id, err := b.Bind(repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Bind(filepath.Join(repo, "does-not-exist")); !errors.Is(err, ErrWorkspaceUnavailable) {
		t.Fatalf("Bind(missing) error = %v, want ErrWorkspaceUnavailable", err)
	}
	cur, ok := b.Current()
	if !ok || cur != id {
		t.Errorf("Current() after failed Bind = %+v %v, want %+v true", cur, ok, id)
	}
	if _, err := b.Resolve(id.RepoEpoch, "project"); err != nil {
		t.Errorf("Resolve after failed Bind: %v", err)
	}
}

// TestBindingsResolveSymlinkEscape swaps a detected nested workspace directory
// for a symlink after Bind, proving Resolve re-verifies the canonical toolRoot
// against the repo root at request time.
func TestBindingsResolveSymlinkEscape(t *testing.T) {
	repo := newRepo(t)
	outside := t.TempDir()
	service := filepath.Join(repo, "service")
	writeFile(t, filepath.Join(service, "go.mod"), "module svc\n")

	b := NewBindings(filesystem.NewOS())
	id, err := b.Bind(repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Resolve(id.RepoEpoch, "service"); err != nil {
		t.Fatalf("pre-swap Resolve: %v", err)
	}

	// Swap the workspace dir for a symlink pointing outside the repo.
	if err := os.RemoveAll(service); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, service); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := b.Resolve(id.RepoEpoch, "service"); !errors.Is(err, ErrRequestRejected) {
		t.Errorf("escaping toolRoot error = %v, want ErrRequestRejected", err)
	}

	// A symlink that stays inside the repo is allowed and canonicalized.
	if err := os.Remove(service); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(repo, "frontend"), service); err != nil {
		t.Fatal(err)
	}
	rw, err := b.Resolve(id.RepoEpoch, "service")
	if err != nil {
		t.Fatalf("inside-repo symlink Resolve: %v", err)
	}
	if want := canonical(t, filepath.Join(repo, "frontend")); rw.ToolRoot != want {
		t.Errorf("ToolRoot = %q, want canonical inside target %q", rw.ToolRoot, want)
	}
	if rw.WorkspaceRel != "frontend" {
		t.Errorf("WorkspaceRel = %q, want canonical policy prefix %q", rw.WorkspaceRel, "frontend")
	}
	if rw.workspaceLexicalRel != "service" {
		t.Errorf("workspaceLexicalRel = %q, want detected policy prefix %q", rw.workspaceLexicalRel, "service")
	}
}

func TestBindingsJSONExposesNoPaths(t *testing.T) {
	const secret = string(os.PathSeparator) + "secret-root"
	values := map[string]any{
		"RepositoryIdentity":   RepositoryIdentity{RepoKey: "k", RepoEpoch: 2},
		"ConversationIdentity": ConversationIdentity{RepoEpoch: 2, WorkspaceID: "w", ConversationID: "c"},
		"RunIdentity":          RunIdentity{RepoEpoch: 2, WorkspaceID: "w", ConversationID: "c", RunID: "r"},
		"ResolvedWorkspace": ResolvedWorkspace{
			RepositoryIdentity:  RepositoryIdentity{RepoKey: "k", RepoEpoch: 2},
			WorkspaceID:         "w",
			WorkspaceName:       "W",
			WorkspaceRel:        "w",
			workspaceLexicalRel: secret,
			RepoRoot:            secret,
			ToolRoot:            secret,
		},
	}
	for name, v := range values {
		t.Run(name, func(t *testing.T) {
			data, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			got := string(data)
			if strings.Contains(got, secret) {
				t.Errorf("marshaled %s leaks a filesystem root: %s", name, got)
			}
			for _, banned := range []string{"RepoRoot", "repoRoot", "ToolRoot", "toolRoot", "Path", "path"} {
				if strings.Contains(got, `"`+banned+`"`) {
					t.Errorf("marshaled %s contains root/path field %q: %s", name, banned, got)
				}
			}
		})
	}
}

func TestBindingsConcurrentAccess(t *testing.T) {
	repoA := newRepo(t)
	repoB := newRepo(t)
	b := NewBindings(filesystem.NewOS())
	if _, err := b.Bind(repoA); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		repo := repoA
		if i%2 == 1 {
			repo = repoB
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				id, err := b.Bind(repo)
				if err != nil {
					t.Error(err)
					return
				}
				_, _ = b.Resolve(id.RepoEpoch, "project") // stale epochs are expected here
				b.Current()
			}
		}()
	}
	wg.Wait()
	b.Unbind()
}

func TestConversationID(t *testing.T) {
	id := ConversationID("key", "ws")
	if !strings.HasPrefix(id, "golem-") {
		t.Errorf("ConversationID = %q, want golem- prefix", id)
	}
	digest := strings.TrimPrefix(id, "golem-")
	if len(digest) != sha256.Size*2 {
		t.Errorf("digest length = %d, want %d hex chars", len(digest), sha256.Size*2)
	}
	if _, err := hex.DecodeString(digest); err != nil {
		t.Errorf("digest is not hex: %v", err)
	}

	if ConversationID("key", "ws") != id {
		t.Error("not deterministic for identical inputs")
	}
	if ConversationID("other", "ws") == id {
		t.Error("same ID across different repositories")
	}
	if ConversationID("key", "other") == id {
		t.Error("same ID across different workspaces")
	}
	if ConversationID("ab", "c") == ConversationID("a", "bc") {
		t.Error("repoKey/workspaceID boundary is ambiguous")
	}
}

// TestConversationIDStableAcrossEpochs proves the conversation ID survives a
// rebind (new epoch, same canonical repo) while stale-epoch requests still fail.
func TestConversationIDStableAcrossEpochs(t *testing.T) {
	repoA := newRepo(t)
	repoB := newRepo(t)
	b := NewBindings(filesystem.NewOS())

	idA1, err := b.Bind(repoA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Bind(repoB); err != nil {
		t.Fatal(err)
	}
	idA2, err := b.Bind(repoA)
	if err != nil {
		t.Fatal(err)
	}

	if idA1.RepoEpoch == idA2.RepoEpoch {
		t.Fatal("rebind did not advance the epoch")
	}
	if ConversationID(idA1.RepoKey, "project") != ConversationID(idA2.RepoKey, "project") {
		t.Error("conversation ID changed across epochs of the same repository")
	}
	if _, err := b.Resolve(idA1.RepoEpoch, "project"); !errors.Is(err, ErrRequestRejected) {
		t.Errorf("stale epoch error = %v, want ErrRequestRejected", err)
	}
}
