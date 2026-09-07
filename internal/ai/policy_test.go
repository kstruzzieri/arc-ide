package ai

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"firn/internal/filesystem"
	"github.com/kstruzzieri/go-llm/agent"
	agenttools "github.com/kstruzzieri/go-llm/agent/tools"
)

// scopeDeniedMsg is go-llm's fixed model-visible denial text (agent/tools
// errScopeDenied). Tool results for guarded paths must carry exactly this.
const scopeDeniedMsg = "path denied by workspace policy"

// floorProbes are paths every floor rule set must deny regardless of manifest
// state. Each maps to at least one firnSensitiveFloor pattern.
var floorProbes = []string{
	".env",
	"cfg/.env.local",
	"tls/server.pem",
	"tls/server.key",
	"b.p12",
	"b.pfx",
	"ssh/id_rsa",
	"ssh/id_ed25519",
	"ssh/id_ecdsa.pub",
	"id_dsa",
	"home/credentials",
	"home/credentials.ini",
	".git-credentials",
	"my-credentials.json",
	"secrets/token.txt",
	".git",
	".git/config",
	"sub/.git/HEAD",
	".firn",
	".firn/golem-consent.json",
	".agent",
	".agent/receipts/x",
	"sub/.agent/y",
}

// allowedProbes are ordinary source paths that must stay reachable.
var allowedProbes = []string{
	"main.go",
	"internal/ai/policy.go",
	"docs/readme.md",
	"frontend/src/app.tsx",
	"environment.go",
	"keys.go",
}

func newPolicyRepo(t *testing.T) string {
	t.Helper()
	return canonical(t, t.TempDir())
}

func mustDeny(t *testing.T, g agenttools.ScopeGuard, path string) {
	t.Helper()
	if err := g(path, false); err == nil {
		t.Errorf("read of %q allowed, want denied", path)
	}
	if err := g(path, true); err == nil {
		t.Errorf("write of %q allowed, want denied", path)
	}
}

func mustAllow(t *testing.T, g agenttools.ScopeGuard, path string) {
	t.Helper()
	if err := g(path, false); err != nil {
		t.Errorf("read of %q denied (%v), want allowed", path, err)
	}
	if err := g(path, true); err != nil {
		t.Errorf("write of %q denied (%v), want allowed", path, err)
	}
}

func writeManifest(t *testing.T, repo, label, content string) {
	t.Helper()
	writeFile(t, filepath.Join(repo, filepath.FromSlash(label)), content)
}

func newScopedTools(t *testing.T, root string, g agenttools.ScopeGuard) map[string]agent.Tool {
	t.Helper()
	ws, err := agenttools.NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	ws.SetScopeGuard(g)
	byName := map[string]agent.Tool{}
	for _, tl := range agenttools.NewFileToolsForWorkspace(ws) {
		byName[tl.Spec().Name] = tl
	}
	for _, name := range []string{"read_file", "search", "glob", "list"} {
		if byName[name] == nil {
			t.Fatalf("missing tool %q", name)
		}
	}
	return byName
}

func invokeTool(t *testing.T, tl agent.Tool, args string) agent.ToolResult {
	t.Helper()
	res, err := tl.Invoke(context.Background(), json.RawMessage(args))
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	return res
}

func TestScopePolicyFloorSurvivesManifestFailures(t *testing.T) {
	const marker = "ZZRAWMANIFESTMARKER"
	cases := []struct {
		name  string
		setup func(t *testing.T, repo string)
	}{
		{"absent", func(t *testing.T, repo string) {}},
		{"emptyList", func(t *testing.T, repo string) {
			writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths: []\n")
		}},
		{"permissive", func(t *testing.T, repo string) {
			writeManifest(t, repo, "ai-kit.yaml", "unrelated: true\n")
		}},
		{"oversized", func(t *testing.T, repo string) {
			writeManifest(t, repo, "ai-kit.yaml", strings.Repeat("#", (256<<10)+1))
		}},
		{"symlinked", func(t *testing.T, repo string) {
			real := filepath.Join(t.TempDir(), "real.yaml")
			writeFile(t, real, "sensitive_paths: [\"extra/**\"]\n")
			if err := os.Symlink(real, filepath.Join(repo, "ai-kit.yaml")); err != nil {
				t.Skipf("symlinks unavailable: %v", err)
			}
		}},
		{"nonRegular", func(t *testing.T, repo string) {
			if err := os.MkdirAll(filepath.Join(repo, "ai-kit.yaml"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{"malformed", func(t *testing.T, repo string) {
			writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths: [unclosed "+marker+"\n")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := newPolicyRepo(t)
			tc.setup(t, repo)
			p := LoadScopePolicy(filesystem.NewOS(), repo)
			g := p.Guard("")
			for _, probe := range floorProbes {
				mustDeny(t, g, probe)
			}
			for _, probe := range allowedProbes {
				mustAllow(t, g, probe)
			}
			warnings := p.Warnings()
			if len(warnings) == 0 {
				t.Fatal("no warnings issued")
			}
			for _, w := range warnings {
				if w.Path != "ai-kit.yaml" && w.Path != "docs/ai/ai-kit.yaml" {
					t.Errorf("warning path %q is not a fixed manifest label", w.Path)
				}
				if strings.Contains(w.Message, repo) || strings.Contains(w.Path, repo) {
					t.Errorf("warning leaks repository root: %+v", w)
				}
				if strings.Contains(w.Message, marker) {
					t.Errorf("warning leaks raw manifest text: %+v", w)
				}
			}
		})
	}
}

func TestScopePolicyManifestUnion(t *testing.T) {
	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - internal/private/**\n")
	writeManifest(t, repo, "docs/ai/ai-kit.yaml", "sensitive_paths:\n  - vendor-keys/**\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")

	mustDeny(t, g, "internal/private/x.go")
	mustDeny(t, g, "vendor-keys/a/b")
	// Floor is never subtracted by manifest content.
	for _, probe := range floorProbes {
		mustDeny(t, g, probe)
	}
	mustAllow(t, g, "internal/public.go")
	mustAllow(t, g, "main.go")
}

func TestScopePolicyDoubleStarDepth(t *testing.T) {
	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - internal/private/**\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")

	// ** matches zero descendant levels (the directory itself) and many.
	mustDeny(t, g, "internal/private")
	mustDeny(t, g, "internal/private/a")
	mustDeny(t, g, "internal/private/a/b/c")
	mustAllow(t, g, "internal")
	mustAllow(t, g, "internal/privatezz")
	mustAllow(t, g, "internal/priv.txt")
}

func TestScopePolicyWorkspacePrefix(t *testing.T) {
	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - frontend/config-private.yaml\n  - private/**\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)

	focused := p.Guard("frontend", "")
	// Tool-relative paths are converted to repo-relative before matching.
	mustDeny(t, focused, "config-private.yaml")
	mustDeny(t, focused, "secret.txt") // frontend/secret.txt hits the floor
	mustAllow(t, focused, "src/app.tsx")
	mustAllow(t, focused, "private/readme.md") // an empty alternate is not the repository root

	root := p.Guard("")
	mustDeny(t, root, "frontend/config-private.yaml")
	mustDeny(t, root, "private/readme.md")
	mustAllow(t, root, "config-private.yaml") // rule names the frontend copy only
}

func TestScopePolicySeparatorAndCaseNoBypass(t *testing.T) {
	repo := newPolicyRepo(t)
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")

	for _, probe := range []string{
		"SECRETS/TOKEN.TXT",
		".GIT/config",
		`secrets\token.txt`,
		`.git\config`,
		"My-Credentials.JSON",
		"SSH/ID_RSA",
	} {
		mustDeny(t, g, probe)
	}
	for _, probe := range allowedProbes {
		mustAllow(t, g, probe)
	}
}

func TestScopePolicyRejectedRules(t *testing.T) {
	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml",
		"sensitive_paths:\n"+
			"  - /abs/deny\n"+
			"  - ../escape\n"+
			"  - \"bad[glob\"\n"+
			"  - \"nul\\0rule\"\n"+
			"  - ok-extra/**\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")

	// The valid rule holds; rejected rules contribute nothing.
	mustDeny(t, g, "ok-extra/x")
	mustAllow(t, g, "abs/deny")
	mustAllow(t, g, "escape")
	warnings := p.Warnings()
	if len(warnings) < 4 {
		t.Fatalf("warnings = %d, want one per rejected rule (4): %+v", len(warnings), warnings)
	}
	for _, w := range warnings {
		for _, leak := range []string{"/abs/deny", "escape", "bad[glob", "nul"} {
			if strings.Contains(w.Message, leak) {
				t.Errorf("warning leaks rejected rule text %q: %+v", leak, w)
			}
		}
	}
}

func TestScopePolicyWarningsCopy(t *testing.T) {
	repo := newPolicyRepo(t)
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	first := p.Warnings()
	if len(first) == 0 {
		t.Fatal("expected a missing-manifest warning")
	}
	first[0].Message = "mutated"
	first[0].Path = "mutated"
	second := p.Warnings()
	if second[0].Message == "mutated" || second[0].Path == "mutated" {
		t.Fatal("Warnings() exposed internal slice, want a copy")
	}
}

func TestScopePolicyReloadUpdatesIssuedGuard(t *testing.T) {
	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - alpha/**\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")

	mustDeny(t, g, "alpha/x")
	mustAllow(t, g, "beta/x")

	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - beta/**\n")
	p.Reload()

	// The already-issued closure observes the reloaded rule set: additive rules
	// are current-manifest state, only floor and protected sources are immutable.
	mustDeny(t, g, "beta/x")
	mustAllow(t, g, "alpha/x")
	for _, probe := range floorProbes {
		mustDeny(t, g, probe)
	}
}

func TestScopePolicyProtectConfigSource(t *testing.T) {
	t.Run("invalidInput", func(t *testing.T) {
		repo := newPolicyRepo(t)
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		sep := string(filepath.Separator)
		for _, bad := range []string{
			"",
			"relative.yaml",
			"relative/config.yaml",
			repo + sep + "a\x00b.yaml",
			repo + sep + ".." + sep + "cfg.yaml",
			repo + sep + "." + sep + "cfg.yaml",
			repo + sep + sep + "cfg.yaml",
		} {
			if err := p.ProtectConfigSource(bad); err == nil {
				t.Errorf("ProtectConfigSource(%q) = nil, want error", bad)
			}
		}
	})

	t.Run("outsideRootNamesakeAllowed", func(t *testing.T) {
		repo := newPolicyRepo(t)
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		g := p.Guard("")
		outside := filepath.Join(canonical(t, t.TempDir()), "golem-config.yaml")
		writeFile(t, outside, "provider: test\n")
		if err := p.ProtectConfigSource(outside); err != nil {
			t.Fatalf("ProtectConfigSource(outside) = %v", err)
		}
		mustAllow(t, g, "golem-config.yaml")
	})

	t.Run("outsideRootHardLinkAlias", func(t *testing.T) {
		const marker = "ZZEXTERNALCONFIGMARKER"
		repo := newPolicyRepo(t)
		source := filepath.Join(canonical(t, t.TempDir()), "golem-config.yaml")
		writeFile(t, source, marker+"\n")
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		if err := p.ProtectConfigSource(source); err != nil {
			t.Fatalf("ProtectConfigSource(outside) = %v", err)
		}
		alias := filepath.Join(repo, "ordinary.txt")
		if err := os.Link(source, alias); err != nil {
			t.Skipf("cross-directory hard links unavailable here: %v", err)
		}

		g := p.Guard("")
		mustDeny(t, g, "ordinary.txt")
		tools := newScopedTools(t, repo, g)
		if res := invokeTool(t, tools["read_file"], `{"path":"ordinary.txt"}`); !res.IsError || res.Content != scopeDeniedMsg {
			t.Errorf("read_file external hard-link alias = %+v, want scope denial", res)
		}
	})

	t.Run("differentVolumeWindows", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("windows-only: volumes do not exist elsewhere")
		}
		repo := newPolicyRepo(t)
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		vol := filepath.VolumeName(repo)
		other := `Q:\golem\config.yaml`
		if strings.EqualFold(vol, "Q:") {
			other = `R:\golem\config.yaml`
		}
		if err := p.ProtectConfigSource(other); err != nil {
			t.Fatalf("ProtectConfigSource(%q) = %v, want nil no-op", other, err)
		}
	})

	t.Run("containedDeny", func(t *testing.T) {
		const marker = "ZZCONFIGMARKER"
		repo := newPolicyRepo(t)
		writeFile(t, filepath.Join(repo, "custom-golem.yaml"), "provider: x # "+marker+"\n")
		writeFile(t, filepath.Join(repo, "main.go"), "package main\n")
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		g := p.Guard("") // issued before ProtectConfigSource

		mustAllow(t, g, "custom-golem.yaml")
		if err := p.ProtectConfigSource(filepath.Join(repo, "custom-golem.yaml")); err != nil {
			t.Fatalf("ProtectConfigSource: %v", err)
		}
		mustDeny(t, g, "custom-golem.yaml")

		tools := newScopedTools(t, repo, g)
		if res := invokeTool(t, tools["read_file"], `{"path":"custom-golem.yaml"}`); !res.IsError || res.Content != scopeDeniedMsg {
			t.Errorf("read_file = %+v, want scope denial", res)
		}
		if res := invokeTool(t, tools["list"], `{"path":"."}`); strings.Contains(res.Content, "custom-golem.yaml") {
			t.Errorf("list exposes protected config source: %q", res.Content)
		}
		if res := invokeTool(t, tools["glob"], `{"pattern":"**"}`); strings.Contains(res.Content, "custom-golem.yaml") {
			t.Errorf("glob exposes protected config source: %q", res.Content)
		}
		if res := invokeTool(t, tools["search"], `{"pattern":"`+marker+`"}`); res.Content != "no matches" {
			t.Errorf("search = %q, want no matches", res.Content)
		}

		// Repo policy reload can never remove a protected config source.
		p.Reload()
		mustDeny(t, g, "custom-golem.yaml")
	})

	t.Run("missingSourceToleratedButStillDenied", func(t *testing.T) {
		// A missing file has no inode, so no hard-link alias can exist and the
		// exact-path deny fully covers the name. Erroring here would take the
		// workspace unavailable on every re-protect after the config file is
		// deleted (the cached target outlives the file), so the lookup miss is
		// tolerated — but the name must stay denied, including after the file
		// is recreated.
		repo := newPolicyRepo(t)
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		g := p.Guard("")
		source := filepath.Join(repo, "missing-golem.yaml")

		if err := p.ProtectConfigSource(source); err != nil {
			t.Fatalf("ProtectConfigSource missing source = %v, want tolerated", err)
		}
		mustDeny(t, g, "missing-golem.yaml")

		writeFile(t, source, "recreated\n")
		mustDeny(t, g, "missing-golem.yaml")
	})

	t.Run("hardLinkAlias", func(t *testing.T) {
		const marker = "ZZHARDLINKEDCONFIGMARKER"
		repo := newPolicyRepo(t)
		source := filepath.Join(repo, "custom-golem.yaml")
		alias := filepath.Join(repo, "ordinary.txt")
		writeFile(t, source, marker+"\n")

		p := LoadScopePolicy(filesystem.NewOS(), repo)
		if err := p.ProtectConfigSource(source); err != nil {
			t.Fatalf("ProtectConfigSource: %v", err)
		}
		// Create the alias after protection: enforcement must follow the saved
		// file identity, not a one-time enumeration of names.
		if err := os.Link(source, alias); err != nil {
			t.Skipf("hard links unavailable here: %v", err)
		}
		g := p.Guard("")
		mustDeny(t, g, "custom-golem.yaml") // preserve exact-path denial

		tools := newScopedTools(t, repo, g)
		if res := invokeTool(t, tools["read_file"], `{"path":"ordinary.txt"}`); !res.IsError || res.Content != scopeDeniedMsg {
			t.Errorf("read_file alias = %+v, want scope denial", res)
		}
		if res := invokeTool(t, tools["list"], `{"path":"."}`); strings.Contains(res.Content, "ordinary.txt") {
			t.Errorf("list exposes hard-link alias: %q", res.Content)
		}
		if res := invokeTool(t, tools["glob"], `{"pattern":"**"}`); strings.Contains(res.Content, "ordinary.txt") {
			t.Errorf("glob exposes hard-link alias: %q", res.Content)
		}
		if res := invokeTool(t, tools["search"], `{"pattern":"`+marker+`"}`); res.Content != "no matches" {
			t.Errorf("search alias = %q, want no matches", res.Content)
		}
	})

	t.Run("literalBackslashHardLinkAlias", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("backslash is a path separator on Windows")
		}
		repo := newPolicyRepo(t)
		source := filepath.Join(repo, "custom-golem.yaml")
		const aliasName = `ordinary\alias.txt`
		writeFile(t, source, "provider: test\n")

		p := LoadScopePolicy(filesystem.NewOS(), repo)
		if err := p.ProtectConfigSource(source); err != nil {
			t.Fatalf("ProtectConfigSource: %v", err)
		}
		if err := os.Link(source, filepath.Join(repo, aliasName)); err != nil {
			t.Skipf("hard links unavailable here: %v", err)
		}
		args, err := json.Marshal(map[string]string{"path": aliasName})
		if err != nil {
			t.Fatal(err)
		}
		if res := invokeTool(t, newScopedTools(t, repo, p.Guard(""))["read_file"], string(args)); !res.IsError || res.Content != scopeDeniedMsg {
			t.Errorf("read_file literal-backslash alias = %+v, want scope denial", res)
		}
	})

	t.Run("literalBackslashExactPathSurvivesReplacement", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("backslash is a path separator on Windows")
		}
		repo := newPolicyRepo(t)
		const sourceName = `custom\golem.yaml`
		source := filepath.Join(repo, sourceName)
		writeFile(t, source, "provider: old\n")

		p := LoadScopePolicy(filesystem.NewOS(), repo)
		if err := p.ProtectConfigSource(source); err != nil {
			t.Fatalf("ProtectConfigSource: %v", err)
		}
		if err := os.Remove(source); err != nil {
			t.Fatal(err)
		}
		writeFile(t, source, "provider: replacement\n")
		mustDeny(t, p.Guard(""), sourceName)
	})
}

func TestScopePolicyDetachAttach(t *testing.T) {
	repo := newPolicyRepo(t)
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")
	mustAllow(t, g, "main.go")

	p.Detach()
	for _, probe := range []string{"main.go", ".env", "anything/else.txt"} {
		err := g(probe, false)
		if err == nil {
			t.Fatalf("detached guard allowed %q", probe)
		}
		if !strings.Contains(err.Error(), "reopen repository to resume file access") {
			t.Fatalf("detached denial = %q, want stable reopen message", err)
		}
	}

	// Attach performs a bounded reload before restoring evaluation.
	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - gamma/**\n")
	p.Attach()
	mustAllow(t, g, "main.go")
	mustDeny(t, g, "gamma/x")
	mustDeny(t, g, ".env")
}

func TestScopePolicyWatches(t *testing.T) {
	repo := newPolicyRepo(t)
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	if !p.Watches(filepath.Join(repo, "ai-kit.yaml")) {
		t.Error("Watches(ai-kit.yaml) = false")
	}
	if !p.Watches(filepath.Join(repo, "docs", "ai", "ai-kit.yaml")) {
		t.Error("Watches(docs/ai/ai-kit.yaml) = false")
	}
	if p.Watches(filepath.Join(repo, "other.yaml")) {
		t.Error("Watches(other.yaml) = true")
	}
	if p.Watches(filepath.Join(canonical(t, t.TempDir()), "ai-kit.yaml")) {
		t.Error("Watches(elsewhere/ai-kit.yaml) = true")
	}
}

func TestScopePolicyFourToolsHideGitAndSensitiveFixtures(t *testing.T) {
	const credMarker = "ZZCREDMARKERA"
	const secMarker = "ZZSECMARKERB"

	t.Run("standardCheckout", func(t *testing.T) {
		repo := newPolicyRepo(t)
		files := map[string]string{
			".git/config":              "[remote \"origin\"]\n\turl = https://token:" + credMarker + "@example.com/repo.git\n",
			".git/HEAD":                "ref: refs/heads/main\n",
			"main.go":                  "package main\n",
			"secrets/token.txt":        secMarker + "\n",
			".agent/receipts/x":        "receipt\n",
			".firn/golem-consent.json": "{}\n",
			"nested/.env.local":        "KEY=" + secMarker + "\n",
			"my-credentials.json":      "{\"cred\":\"" + secMarker + "\"}\n",
			"id_dsa":                   secMarker + "\n",
		}
		for rel, content := range files {
			writeFile(t, filepath.Join(repo, filepath.FromSlash(rel)), content)
		}
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		tools := newScopedTools(t, repo, p.Guard(""))

		for _, denied := range []string{
			".git/config", "secrets/token.txt", ".agent/receipts/x",
			".firn/golem-consent.json", "nested/.env.local", "my-credentials.json", "id_dsa",
		} {
			res := invokeTool(t, tools["read_file"], `{"path":"`+denied+`"}`)
			if !res.IsError || res.Content != scopeDeniedMsg {
				t.Errorf("read_file(%q) = %+v, want scope denial", denied, res)
			}
		}
		if res := invokeTool(t, tools["read_file"], `{"path":"main.go"}`); res.IsError || !strings.Contains(res.Content, "package main") {
			t.Errorf("read_file(main.go) = %+v, want content", res)
		}

		for _, dir := range []string{".git", "secrets", ".agent", ".firn"} {
			if res := invokeTool(t, tools["list"], `{"path":"`+dir+`"}`); !res.IsError || res.Content != scopeDeniedMsg {
				t.Errorf("list(%q) = %+v, want scope denial", dir, res)
			}
		}
		listRoot := invokeTool(t, tools["list"], `{"path":"."}`)
		if listRoot.IsError || !strings.Contains(listRoot.Content, "main.go") {
			t.Fatalf("list(.) = %+v, want main.go visible", listRoot)
		}
		globAll := invokeTool(t, tools["glob"], `{"pattern":"**"}`)
		if globAll.IsError || !strings.Contains(globAll.Content, "main.go") {
			t.Fatalf("glob(**) = %+v, want main.go visible", globAll)
		}
		for _, hidden := range []string{".git", "secrets", ".agent", ".firn", ".env.local", "credentials", "id_dsa"} {
			if strings.Contains(listRoot.Content, hidden) {
				t.Errorf("list(.) exposes %q: %q", hidden, listRoot.Content)
			}
			if strings.Contains(globAll.Content, hidden) {
				t.Errorf("glob(**) exposes %q: %q", hidden, globAll.Content)
			}
		}
		for _, pattern := range []string{credMarker, secMarker} {
			if res := invokeTool(t, tools["search"], `{"pattern":"`+pattern+`"}`); res.Content != "no matches" {
				t.Errorf("search(%q) = %q, want no matches", pattern, res.Content)
			}
		}
	})

	t.Run("linkedWorktreeGitFile", func(t *testing.T) {
		repo := newPolicyRepo(t)
		writeFile(t, filepath.Join(repo, ".git"), "gitdir: /home/user/main/.git/worktrees/wt\n")
		writeFile(t, filepath.Join(repo, "main.go"), "package main\n")
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		tools := newScopedTools(t, repo, p.Guard(""))

		res := invokeTool(t, tools["read_file"], `{"path":".git"}`)
		if !res.IsError || res.Content != scopeDeniedMsg || strings.Contains(res.Content, "gitdir") {
			t.Errorf("read_file(.git) = %+v, want scope denial", res)
		}
		// A regular .git file is not caught by the walker's directory ignore
		// set, so only the guard hides it here.
		if res := invokeTool(t, tools["list"], `{"path":"."}`); strings.Contains(res.Content, ".git") {
			t.Errorf("list(.) exposes regular .git file: %q", res.Content)
		}
		if res := invokeTool(t, tools["glob"], `{"pattern":"**"}`); strings.Contains(res.Content, ".git") {
			t.Errorf("glob(**) exposes regular .git file: %q", res.Content)
		}
		if res := invokeTool(t, tools["search"], `{"pattern":"gitdir"}`); res.Content != "no matches" {
			t.Errorf("search(gitdir) = %q, want no matches", res.Content)
		}
	})
}

func TestScopePolicyStackedDoubleStarCollapses(t *testing.T) {
	stacked := strings.Repeat("**/", 3000) + "x"
	pats, ok := compileRule(stacked)
	if !ok {
		t.Fatal("compileRule rejected stacked ** rule, want collapsed accept")
	}
	// Collapsed to "**/x" plus its "/**" descendant variant — never the
	// thousands of stacked segments the manifest shipped.
	if len(pats[0]) != 2 || pats[0][0] != "**" || pats[0][1] != "x" {
		t.Fatalf("compiled pattern = %v, want [** x]", pats[0])
	}
	for _, pat := range pats {
		if len(pat) > 3 {
			t.Fatalf("compiled pattern kept stacked segments: %d segments", len(pat))
		}
	}

	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml",
		"sensitive_paths:\n  - \""+stacked+"\"\n  - \"**/**/marker.txt\"\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")

	// Collapsing preserves semantics: **/**/x still denies a/b/x and x.
	mustDeny(t, g, "a/b/x")
	mustDeny(t, g, "x")
	mustDeny(t, g, "a/b/marker.txt")
	mustDeny(t, g, "marker.txt")
	mustAllow(t, g, "a/b/y")

	deep := strings.TrimSuffix(strings.Repeat("d/", 50), "/") + "/file.txt"
	start := time.Now()
	for i := 0; i < 1000; i++ {
		if err := g(deep, false); err != nil {
			t.Fatalf("deep path denied: %v", err)
		}
	}
	// Generous bound: collapsed patterns make this microseconds; the
	// pre-collapse blowup made it seconds.
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("1000 guard calls on a deep path took %v", elapsed)
	}
}

func TestScopePolicySegmentCapRejectsRule(t *testing.T) {
	long := strings.TrimSuffix(strings.Repeat("seg/", 70), "/")
	if _, ok := compileRule(long); ok {
		t.Fatal("compileRule accepted a 70-segment rule, want cap rejection")
	}
	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - "+long+"\n  - ok-extra/**\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")

	mustDeny(t, g, "ok-extra/x")
	mustAllow(t, g, long) // over-cap rule contributed nothing
	found := false
	for _, w := range p.Warnings() {
		if w.Message == warnRuleRejected {
			found = true
		}
	}
	if !found {
		t.Fatalf("no rejected-rule warning for over-cap rule: %+v", p.Warnings())
	}
}

func TestScopePolicyCandidateSegmentCapFailsClosed(t *testing.T) {
	p := LoadScopePolicy(filesystem.NewOS(), newPolicyRepo(t))
	g := p.Guard("")
	mustAllow(t, g, strings.TrimSuffix(strings.Repeat("ok/", 256), "/"))
	mustDeny(t, g, strings.TrimSuffix(strings.Repeat("too-deep/", 257), "/"))
}

func TestScopePolicyCandidateByteCapFailsClosed(t *testing.T) {
	const maxWindowsUTF8PathBytes = 128 << 10
	p := LoadScopePolicy(filesystem.NewOS(), newPolicyRepo(t))
	g := p.Guard("")
	if err := g(strings.Repeat("a", maxWindowsUTF8PathBytes), false); err != nil {
		t.Fatalf("candidate at the byte cap was denied: %v", err)
	}
	if err := g(strings.Repeat("a", maxWindowsUTF8PathBytes+1), false); err == nil {
		t.Fatal("candidate over the byte cap was allowed")
	}
	if err := g(strings.Repeat("./", maxWindowsUTF8PathBytes/2+1), false); err == nil {
		t.Fatal("oversized separator run was allowed")
	}
}

func TestScopePolicyManifestRuleCapFailsClosed(t *testing.T) {
	const (
		atCap       = 512
		overCap     = atCap + 1
		wantWarning = "AI policy manifest contains too many sensitive path rules; workspace file access was denied"
	)

	t.Run("atCap", func(t *testing.T) {
		repo := newPolicyRepo(t)
		writeManifest(t, repo, "ai-kit.yaml",
			"sensitive_paths:\n"+strings.Repeat("  - bounded-sensitive\n", atCap))
		p := LoadScopePolicy(filesystem.NewOS(), repo)
		g := p.Guard("")
		p.mu.Lock()
		patternCount := len(p.additive)
		p.mu.Unlock()
		if patternCount != 1024 {
			t.Fatalf("compiled patterns = %d, want boundary count 1024", patternCount)
		}
		mustDeny(t, g, "bounded-sensitive/child.txt")
		mustAllow(t, g, "ordinary.txt")
		for _, warning := range p.Warnings() {
			if warning.Message == wantWarning {
				t.Fatalf("at-cap manifest was rejected: %+v", p.Warnings())
			}
		}
	})

	tests := []struct {
		name      string
		rootRules string
		docRules  string
		wantPath  string
	}{
		{
			name:      "validEntries",
			rootRules: strings.Repeat("  - repeated-sensitive\n", overCap),
			wantPath:  "ai-kit.yaml",
		},
		{
			name:      "invalidEntries",
			rootRules: strings.Repeat("  - ../escape\n", overCap),
			wantPath:  "ai-kit.yaml",
		},
		{
			name:      "totalAcrossManifests",
			rootRules: strings.Repeat("  - root-sensitive\n", atCap/2),
			docRules:  strings.Repeat("  - docs-sensitive\n", atCap/2+1),
			wantPath:  "docs/ai/ai-kit.yaml",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repo := newPolicyRepo(t)
			writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n"+tc.rootRules)
			if tc.docRules != "" {
				writeManifest(t, repo, "docs/ai/ai-kit.yaml", "sensitive_paths:\n"+tc.docRules)
			}
			p := LoadScopePolicy(filesystem.NewOS(), repo)
			p.mu.Lock()
			patternCount := len(p.additive)
			p.mu.Unlock()
			if patternCount != 1 {
				t.Fatalf("overflow compiled patterns = %d, want one bounded deny-all pattern", patternCount)
			}
			mustDeny(t, p.Guard(""), "ordinary.txt")
			warnings := p.Warnings()
			if len(warnings) != 1 || warnings[0].Path != tc.wantPath || warnings[0].Message != wantWarning {
				t.Fatalf("warnings = %+v, want one fixed overflow warning for %q", warnings, tc.wantPath)
			}
		})
	}
}

func TestScopePolicyMatcherProperties(t *testing.T) {
	cases := []struct {
		pat, path string
		want      bool
	}{
		{"**/**/**", "a", true}, // equivalent to **
		{"**/**/**", "a/b/c/d", true},
		{"**", "a", true},
		{"**", "a/b/c/d", true},
		{"a/**/b", "a/b", true}, // ** matches zero segments
		{"a/**/b", "a/x/b", true},
		{"a/**/b", "a/x/y/b", true},
		{"a/**/b", "a/b/c", false}, // trailing literal is anchored
		{"a/**/b", "b", false},
		{"a/**/b", "a", false},
		{"**/mid/**/leaf.txt", "mid/leaf.txt", true},
		{"**/mid/**/leaf.txt", "x/mid/y/z/leaf.txt", true},
		{"**/mid/**/leaf.txt", "mid/other.txt", false},
		{"**/mid/**/leaf.txt", "leaf.txt", false},
	}
	for _, c := range cases {
		got := matchPattern(strings.Split(c.pat, "/"), strings.Split(c.path, "/"))
		if got != c.want {
			t.Errorf("matchPattern(%q, %q) = %v, want %v", c.pat, c.path, got, c.want)
		}
	}
}

func TestScopePolicyConcurrentGuardAndMutation(t *testing.T) {
	repo := newPolicyRepo(t)
	writeManifest(t, repo, "ai-kit.yaml", "sensitive_paths:\n  - alpha/**\n")
	p := LoadScopePolicy(filesystem.NewOS(), repo)
	g := p.Guard("")
	cfg := filepath.Join(repo, "cfg.yaml")
	writeFile(t, cfg, "provider: test\n")

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			for _, probe := range []string{"main.go", ".env", "alpha/x", "docs/readme.md"} {
				_ = g(probe, false)
				_ = g(probe, true)
			}
		}
	}()
	go func() {
		defer wg.Done()
		defer close(stop)
		for i := 0; i < 200; i++ {
			p.Reload()
			p.Detach()
			p.Attach()
			if err := p.ProtectConfigSource(cfg); err != nil {
				t.Errorf("ProtectConfigSource: %v", err)
				return
			}
			_ = p.Warnings()
		}
	}()
	wg.Wait()

	p.Detach()
	err := g("main.go", false)
	if err == nil || !strings.Contains(err.Error(), "reopen repository to resume file access") {
		t.Fatalf("post-Detach guard = %v, want detached denial", err)
	}
}
