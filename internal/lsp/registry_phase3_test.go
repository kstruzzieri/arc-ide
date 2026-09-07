package lsp

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"firn/internal/lsp/provision"
)

func TestExtensionMap_Rust(t *testing.T) {
	r := NewRegistry()
	if got := r.FamilyForExtension(".rs"); got != "rust" {
		t.Errorf("FamilyForExtension(.rs) = %q, want rust", got)
	}
	if got := r.LanguageIDForExtension(".rs"); got != "rust" {
		t.Errorf("LanguageIDForExtension(.rs) = %q, want rust", got)
	}
}

// With no rust-analyzer on PATH and no managed provisioner, the miss is
// unprovisionable and carries an actionable hint.
func TestResolveRustServer_NotFoundUnprovisionable(t *testing.T) {
	t.Setenv("PATH", "")
	t.Setenv("HOME", t.TempDir())
	r := NewRegistry()
	_, err := r.ServerConfigFor("rust", t.TempDir())
	var miss *ServerMissError
	if !errors.As(err, &miss) {
		t.Fatalf("err = %v, want *ServerMissError", err)
	}
	if miss.Provisionable {
		t.Error("no rust provisioner registered; expected Provisionable=false")
	}
	if !contains(miss.Hint, "rust-analyzer") {
		t.Errorf("hint should mention rust-analyzer, got: %s", miss.Hint)
	}
}

// Once a rust provisioner is registered (cache empty), the miss flips to
// Provisionable so the manager can kick off a managed install.
func TestResolveRustServer_ManagedWhenMissing(t *testing.T) {
	t.Setenv("PATH", "")
	t.Setenv("HOME", t.TempDir())
	r := NewRegistry()
	r.SetProvisioners(map[string]provision.Provisioner{
		"rust": fakeProv{res: provision.Resolution{State: provision.StateMissing}},
	})
	_, err := r.ServerConfigFor("rust", t.TempDir())
	var miss *ServerMissError
	if !errors.As(err, &miss) {
		t.Fatalf("err = %v, want *ServerMissError", err)
	}
	if !miss.Provisionable {
		t.Error("expected Provisionable=true when a rust provisioner exists")
	}
}

// A managed rust-analyzer in the cache is launched directly.
func TestResolveRustServer_ManagedAvailable(t *testing.T) {
	t.Setenv("PATH", "")
	t.Setenv("HOME", t.TempDir())
	r := NewRegistry()
	r.SetProvisioners(map[string]provision.Provisioner{
		"rust": fakeProv{res: provision.Resolution{State: provision.StateAvailable, Path: "/cache/rust-analyzer"}},
	})
	cfg, err := r.ServerConfigFor("rust", "/proj")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cfg.Command != "/cache/rust-analyzer" || cfg.Dir != "/proj" {
		t.Errorf("cfg = %+v", cfg)
	}
}

func TestResolveRustServer_BrokenPathTriggersManagedInstall(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	binDir := t.TempDir()
	broken := filepath.Join(binDir, "rust-analyzer")
	if err := os.WriteFile(broken, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("HOME", t.TempDir())

	r := NewRegistry()
	r.SetProvisioners(map[string]provision.Provisioner{
		"rust": fakeProv{res: provision.Resolution{State: provision.StateMissing}},
	})
	_, err := r.ServerConfigFor("rust", t.TempDir())
	var miss *ServerMissError
	if !errors.As(err, &miss) {
		t.Fatalf("err = %v, want *ServerMissError", err)
	}
	if !miss.Provisionable {
		t.Error("broken rust-analyzer should trigger managed provisioning")
	}
}

// gopls not on PATH and not in the Go bin dirs: with a provisioner registered
// the miss becomes Provisionable (previously always Provisionable=false).
func TestResolveGoServer_ManagedWhenMissing(t *testing.T) {
	orig := goBinarySearchDirs
	goBinarySearchDirs = func() []string { return nil }
	t.Cleanup(func() { goBinarySearchDirs = orig })
	t.Setenv("PATH", "")

	r := NewRegistry()
	r.SetProvisioners(map[string]provision.Provisioner{
		"go": fakeProv{res: provision.Resolution{State: provision.StateMissing}},
	})
	_, err := r.ServerConfigFor("go", t.TempDir())
	var miss *ServerMissError
	if !errors.As(err, &miss) {
		t.Fatalf("err = %v, want *ServerMissError", err)
	}
	if !miss.Provisionable {
		t.Error("expected Provisionable=true when a go provisioner exists")
	}
}

// A managed gopls in the cache is launched directly, in preference to the miss.
func TestResolveGoServer_ManagedAvailable(t *testing.T) {
	orig := goBinarySearchDirs
	goBinarySearchDirs = func() []string { return nil }
	t.Cleanup(func() { goBinarySearchDirs = orig })
	t.Setenv("PATH", "")

	r := NewRegistry()
	r.SetProvisioners(map[string]provision.Provisioner{
		"go": fakeProv{res: provision.Resolution{State: provision.StateAvailable, Path: "/cache/gopls"}},
	})
	cfg, err := r.ServerConfigFor("go", "/proj")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cfg.Command != "/cache/gopls" || cfg.Dir != "/proj" {
		t.Errorf("cfg = %+v", cfg)
	}
}

// typescript-language-server not on PATH: with a provisioner registered the
// miss becomes Provisionable.
func TestResolveTypeScriptServer_ManagedWhenMissing(t *testing.T) {
	t.Setenv("PATH", "")
	r := NewRegistry()
	r.SetProvisioners(map[string]provision.Provisioner{
		"typescript": fakeProv{res: provision.Resolution{State: provision.StateMissing}},
	})
	_, err := r.ServerConfigFor("typescript", t.TempDir())
	var miss *ServerMissError
	if !errors.As(err, &miss) {
		t.Fatalf("err = %v, want *ServerMissError", err)
	}
	if !miss.Provisionable {
		t.Error("expected Provisionable=true when a typescript provisioner exists")
	}
}

// A managed rust-analyzer at ~/.cargo/bin is preferred over a managed download
// so a rustup user's own install wins even when the app is Finder-launched.
func TestResolveRustServer_PrefersCargoBin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a shell script")
	}
	home := t.TempDir()
	cargoBin := filepath.Join(home, ".cargo", "bin")
	if err := os.MkdirAll(cargoBin, 0o755); err != nil {
		t.Fatal(err)
	}
	name := "rust-analyzer"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	bin := filepath.Join(cargoBin, name)
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "")

	r := NewRegistry()
	cfg, err := r.ServerConfigFor("rust", t.TempDir())
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cfg.Command != bin {
		t.Errorf("cfg.Command = %q, want cargo-bin rust-analyzer %q", cfg.Command, bin)
	}
}
