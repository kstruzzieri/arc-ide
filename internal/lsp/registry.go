package lsp

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"firn/internal/lsp/provision"
)

// ServerMissError is returned when no server binary could be resolved. When
// Provisionable is true a managed provisioner exists for the family, so the
// manager can trigger an async install instead of surfacing a raw error.
type ServerMissError struct {
	Family        string
	Provisionable bool
	Hint          string // human guidance for the unprovisionable case
}

func (e *ServerMissError) Error() string {
	if e.Hint != "" {
		return e.Hint
	}
	return fmt.Sprintf("no language server found for %q", e.Family)
}

// ServerConfig describes how to launch a language server for a given language family.
type ServerConfig struct {
	// LanguageFamily groups related languages under one server (e.g., "typescript" covers .ts, .tsx, .js, .jsx).
	LanguageFamily string
	// Command is the executable name.
	Command string
	// Args are the command-line arguments.
	Args []string
	// Dir is the working directory for the spawned process.
	// Language servers often resolve configs (tsconfig.json, etc.) relative to their cwd.
	Dir string
	// InitOptions, if non-nil, is sent as initializationOptions in the LSP initialize request.
	InitOptions any
}

// Registry maps file extensions and language contexts to server configurations.
type Registry struct {
	provisioners map[string]provision.Provisioner
}

// NewRegistry creates a new language server registry.
func NewRegistry() *Registry {
	return &Registry{provisioners: map[string]provision.Provisioner{}}
}

// SetProvisioners wires managed provisioners (called once by the manager).
func (r *Registry) SetProvisioners(p map[string]provision.Provisioner) { r.provisioners = p }

// managedOrMiss consults the family provisioner's cache (Resolve, never network).
// When a managed binary is present it returns a ServerConfig; otherwise a typed
// ServerMissError whose Provisionable reflects whether a provisioner exists.
func (r *Registry) managedOrMiss(family, projectRoot, hint string) (*ServerConfig, error) {
	prov, ok := r.provisioners[family]
	if ok {
		if res := prov.Resolve(); res.State == provision.StateAvailable {
			return &ServerConfig{
				LanguageFamily: family,
				Command:        res.Path,
				Args:           res.Args,
				Dir:            projectRoot,
			}, nil
		}
	}
	return nil, &ServerMissError{Family: family, Provisionable: ok, Hint: hint}
}

// langInfo pairs an LSP languageId with its server family.
type langInfo struct {
	languageID string
	family     string
}

// extensionMap is the single source of truth for extension → language/family mapping.
var extensionMap = map[string]langInfo{
	".ts":  {"typescript", "typescript"},
	".tsx": {"typescriptreact", "typescript"},
	".js":  {"javascript", "typescript"},
	".jsx": {"javascriptreact", "typescript"},
	".mts": {"typescript", "typescript"},
	".cts": {"typescript", "typescript"},
	".mjs": {"javascript", "typescript"},
	".cjs": {"javascript", "typescript"},
	".go":  {"go", "go"},
	".py":  {"python", "python"},
	".pyw": {"python", "python"},
	".pyi": {"python", "python"},
	".rs":  {"rust", "rust"},
}

// LanguageIDForExtension returns the LSP languageId for the given file extension.
// Returns empty string if the extension is not recognized.
func (r *Registry) LanguageIDForExtension(ext string) string {
	if info, ok := extensionMap[strings.ToLower(ext)]; ok {
		return info.languageID
	}
	return ""
}

// FamilyForExtension returns the server family for the given file extension.
// Returns empty string if the extension is not recognized.
func (r *Registry) FamilyForExtension(ext string) string {
	if info, ok := extensionMap[strings.ToLower(ext)]; ok {
		return info.family
	}
	return ""
}

// ServerConfigFor returns the server configuration for a given language
// family and project root. The project root is whatever the caller has
// resolved for the file being opened — for TypeScript that's the nearest
// directory with tsconfig.json / jsconfig.json / package.json bounded by the
// active workspace; for Go/Python it is the nearest go.mod / Python project
// marker, falling back to the active workspace root when no marker exists.
//
// Binary lookups (e.g. node_modules/.bin/typescript-language-server) and
// local-TypeScript discovery use this project root, so monorepo packages get
// their own per-package server installation when one exists.
func (r *Registry) ServerConfigFor(family, projectRoot string) (*ServerConfig, error) {
	switch family {
	case "typescript":
		return r.resolveTypeScriptServer(projectRoot)
	case "go":
		return r.resolveGoServer(projectRoot)
	case "python":
		return r.resolvePythonServer(projectRoot)
	case "rust":
		return r.resolveRustServer(projectRoot)
	default:
		return nil, fmt.Errorf("no language server configured for %q", family)
	}
}

func projectLocalNodeBin(projectRoot, binary string) string {
	localBin := filepath.Join(projectRoot, "node_modules", ".bin", binary)
	if runtime.GOOS == "windows" {
		localBin += ".cmd"
	}
	return localBin
}

// resolveTypeScriptServer finds and configures typescript-language-server.
// The projectRoot argument is the detected nearest TS/JS project root, not
// necessarily the active workspace root. Lookup order:
//  1. <projectRoot>/node_modules/.bin/typescript-language-server
//  2. System PATH (with initOptions.tsserver.path pointing at any
//     <projectRoot>/node_modules/typescript/lib that exists, so the project's
//     own TypeScript version is preferred over whatever the global server
//     bundles).
func (r *Registry) resolveTypeScriptServer(projectRoot string) (*ServerConfig, error) {
	binary := "typescript-language-server"

	// 1. Check project-local node_modules/.bin/
	if path, err := exec.LookPath(projectLocalNodeBin(projectRoot, binary)); err == nil {
		return &ServerConfig{
			LanguageFamily: "typescript",
			Command:        path,
			Args:           []string{"--stdio"},
			Dir:            projectRoot,
		}, nil
	}

	// 2. Fall back to system PATH
	path, err := exec.LookPath(binary)
	if err != nil {
		// 3. No system server: offer a managed install when one is available,
		// otherwise return an actionable manual-install hint.
		return r.managedOrMiss("typescript", projectRoot, "typescript-language-server not found. Firn can install it automatically, "+
			"or add it with \"npm install -g typescript-language-server typescript\" or as a project dependency.")
	}

	args := []string{"--stdio"}

	// 3. If the project has its own TypeScript lib, point the system server at
	// it via initializationOptions.tsserver.path. This ensures the server uses
	// the project's TS version rather than whatever TypeScript the global
	// server bundles. (The --tsserver-path CLI flag was removed in
	// typescript-language-server v4+.)
	// TODO: Gate behind workspace trust when trust system is implemented.
	var initOpts any
	localTSLib := filepath.Join(projectRoot, "node_modules", "typescript", "lib")
	if _, statErr := os.Stat(filepath.Join(localTSLib, "tsserver.js")); statErr == nil {
		initOpts = map[string]any{
			"tsserver": map[string]any{
				"path": localTSLib,
			},
		}
	}

	return &ServerConfig{
		LanguageFamily: "typescript",
		Command:        path,
		Args:           args,
		Dir:            projectRoot,
		InitOptions:    initOpts,
	}, nil
}

// resolveGoServer finds and configures gopls.
// When the app is launched outside a terminal (e.g. from Finder or Dock),
// macOS does not populate PATH with shell-specific entries like $HOME/go/bin.
// We fall back to well-known Go binary directories in that case.
func (r *Registry) resolveGoServer(projectRoot string) (*ServerConfig, error) {
	path, err := exec.LookPath("gopls")
	if err != nil {
		path = findGoBinary("gopls")
		if path == "" {
			// No system gopls: offer a managed install (via `go install`) when one
			// is available, otherwise return an actionable manual-install hint.
			return r.managedOrMiss("go", projectRoot, "gopls not found. Firn can install it automatically (requires the Go toolchain), "+
				"or install it with \"go install golang.org/x/tools/gopls@latest\" and add it to PATH.")
		}
	}

	return &ServerConfig{
		LanguageFamily: "go",
		Command:        path,
		Dir:            projectRoot,
	}, nil
}

// resolveRustServer finds and configures rust-analyzer. Lookup order:
//  1. System PATH.
//  2. ~/.cargo/bin (rustup installs land here but are absent from the PATH a
//     Finder/Dock-launched app inherits, mirroring the gopls fallback).
//  3. A managed install when a rust provisioner is registered, otherwise an
//     actionable manual-install hint.
func (r *Registry) resolveRustServer(projectRoot string) (*ServerConfig, error) {
	path, err := exec.LookPath("rust-analyzer")
	if err != nil {
		path = findCargoBinary("rust-analyzer")
	}
	if path != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		probe := exec.CommandContext(ctx, path, "--version")
		probe.Dir = projectRoot
		err = probe.Run()
		cancel()
		if err != nil {
			// A discovered binary that cannot run --version is a broken rustup
			// proxy (a stale shim for an uninstalled component is the common
			// case). Record why we bypass it before falling through to the
			// managed installer, so the decision is diagnosable in the field.
			log.Printf("lsp: ignoring rust-analyzer at %q: version probe failed: %v", path, err)
		}
	}
	if path == "" || err != nil {
		return r.managedOrMiss("rust", projectRoot, "rust-analyzer not found. Firn can install it automatically, "+
			"or install it with \"rustup component add rust-analyzer\" and add it to PATH.")
	}

	return &ServerConfig{
		LanguageFamily: "rust",
		Command:        path,
		Dir:            projectRoot,
	}, nil
}

// findCargoBinary looks for a Rust binary under ~/.cargo/bin, covering the
// Finder/Dock launch case where the shell PATH (with ~/.cargo/bin) is absent.
func findCargoBinary(name string) string {
	binName := name
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	candidate := filepath.Join(home, ".cargo", "bin", binName)
	if isExecutableFile(candidate) {
		return candidate
	}
	return ""
}

// goBinarySearchDirs returns the directories findGoBinary scans. It is a
// package variable so tests can override it to make binary resolution
// deterministic regardless of what is installed on the host machine.
var goBinarySearchDirs = defaultGoBinarySearchDirs

// defaultGoBinarySearchDirs lists the well-known Go binary directories searched
// when the app is launched from Finder/Dock on macOS and the user's shell PATH
// (containing $HOME/go/bin, etc.) is not available.
func defaultGoBinarySearchDirs() []string {
	homeDir, homeErr := os.UserHomeDir()
	if homeErr != nil {
		return nil
	}

	dirs := []string{
		filepath.Join(homeDir, "go", "bin"),
		filepath.Join(homeDir, ".local", "bin"),
	}
	if runtime.GOOS == "windows" {
		return dirs
	}
	return append(dirs,
		"/usr/local/go/bin",
		"/opt/homebrew/bin", // Apple Silicon Homebrew
		"/usr/local/bin",    // Intel Homebrew / system
	)
}

// findGoBinary searches common Go binary directories for a given binary name.
// This covers the case where the app is launched from Finder/Dock on macOS
// and the user's shell PATH (containing $HOME/go/bin, etc.) is not available.
func findGoBinary(name string) string {
	binName := name
	if runtime.GOOS == "windows" {
		binName = name + ".exe"
	}

	for _, dir := range goBinarySearchDirs() {
		candidate := filepath.Join(dir, binName)
		if isExecutableFile(candidate) {
			return candidate
		}
	}

	return ""
}

// isExecutableFile reports whether path is a regular, executable file. It
// mirrors the executability check exec.LookPath performs so the fallback does
// not return a non-executable candidate (which would fail later at cmd.Start)
// and skip a genuinely runnable candidate further down the list.
func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}

	// On Windows executability is determined by extension, not mode bits; the
	// candidate list already appends ".exe", so a regular file is sufficient.
	if runtime.GOOS == "windows" {
		return true
	}

	return info.Mode().Perm()&0o111 != 0
}

// resolvePythonServer finds and configures pyright-langserver.
func (r *Registry) resolvePythonServer(projectRoot string) (*ServerConfig, error) {
	binary := "pyright-langserver"

	if path, ok := resolvePythonVirtualEnvBinary(projectRoot, binary); ok {
		return &ServerConfig{
			LanguageFamily: "python",
			Command:        path,
			Args:           []string{"--stdio"},
			Dir:            projectRoot,
		}, nil
	}

	if path, err := exec.LookPath(projectLocalNodeBin(projectRoot, binary)); err == nil {
		return &ServerConfig{
			LanguageFamily: "python",
			Command:        path,
			Args:           []string{"--stdio"},
			Dir:            projectRoot,
		}, nil
	}

	if path, err := exec.LookPath(binary); err == nil {
		return &ServerConfig{
			LanguageFamily: "python",
			Command:        path,
			Args:           []string{"--stdio"},
			Dir:            projectRoot,
		}, nil
	}

	return r.managedOrMiss("python", projectRoot,
		"Python language server not found. Firn can install it automatically, "+
			"or add basedpyright/pyright as a project dependency.")
}

func resolvePythonVirtualEnvBinary(projectRoot, binary string) (string, bool) {
	for _, venv := range pythonVirtualEnvDirs(projectRoot) {
		for _, candidate := range pythonVirtualEnvBinaryCandidates(venv, binary) {
			if path, err := exec.LookPath(candidate); err == nil {
				return path, true
			}
		}
	}
	return "", false
}

func pythonVirtualEnvDirs(projectRoot string) []string {
	dirs := make([]string, 0, 3)
	if active := os.Getenv("VIRTUAL_ENV"); active != "" {
		dirs = append(dirs, active)
	}
	if projectRoot != "" {
		dirs = append(dirs,
			filepath.Join(projectRoot, ".venv"),
			filepath.Join(projectRoot, "venv"),
		)
	}
	return dirs
}

func pythonVirtualEnvBinaryCandidates(venv, binary string) []string {
	if runtime.GOOS == "windows" {
		scriptsDir := filepath.Join(venv, "Scripts")
		return []string{
			filepath.Join(scriptsDir, binary+".exe"),
			filepath.Join(scriptsDir, binary+".cmd"),
			filepath.Join(scriptsDir, binary+".bat"),
			filepath.Join(scriptsDir, binary),
		}
	}
	return []string{filepath.Join(venv, "bin", binary)}
}
