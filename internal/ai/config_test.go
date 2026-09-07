package ai

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/provider"
)

// sandboxAgentConfigEnv points every discovery location at a throwaway home so
// no test can see or touch the developer's real go-llm configuration.
func sandboxAgentConfigEnv(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("USERPROFILE", home)
	t.Setenv("AppData", filepath.Join(home, "AppData", "Roaming"))
	unsetenv(t, "GO_LLM_CONFIG")
	return home
}

// unsetenv unsets key for the test and restores the original value after.
func unsetenv(t *testing.T, key string) {
	t.Helper()
	if old, ok := os.LookupEnv(key); ok {
		t.Setenv(key, old) // registers restoration of the original value
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("Unsetenv(%s): %v", key, err)
		}
	}
}

// writeMinimalAgentConfig writes a valid go-llm config whose chat model name
// identifies which discovery source produced it.
func writeMinimalAgentConfig(t *testing.T, dir, name, modelName string) string {
	t.Helper()
	content := fmt.Sprintf(`{
  "providers": {"ollama": {"base_url": "http://localhost:11434"}},
  "models": {"chat": {"name": %q, "type": "dense"}},
  "defaults": {"chat": "chat"}
}`, modelName)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing config fixture: %v", err)
	}
	return path
}

// writeAgentConfigBody writes an arbitrary models.json body to a throwaway
// fixture path.
func writeAgentConfigBody(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write models.json: %v", err)
	}
	return path
}

// canonicalPath resolves a fixture path the way discovery must: absolute and
// symlink-free (t.TempDir on macOS lives under the /tmp -> /private/tmp link).
func canonicalPath(t *testing.T, path string) string {
	t.Helper()
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatalf("Abs(%s): %v", path, err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s): %v", abs, err)
	}
	return resolved
}

func TestLoadDefaultAgentConfigEnvOverridesCWDWithArbitraryFilename(t *testing.T) {
	sandboxAgentConfigEnv(t)
	work := t.TempDir()
	t.Chdir(work)
	writeMinimalAgentConfig(t, work, "models.json", "cwd-model")

	envPath := writeMinimalAgentConfig(t, t.TempDir(), "weird-name-42.conf", "env-model")
	t.Setenv("GO_LLM_CONFIG", envPath)

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	if got := loaded.Config.Models["chat"].Name; got != "env-model" {
		t.Fatalf("loaded model %q, want the env-selected config", got)
	}
	if want := canonicalPath(t, envPath); loaded.SourcePath != want {
		t.Fatalf("SourcePath = %q, want %q", loaded.SourcePath, want)
	}
}

func TestLoadDefaultAgentConfigFallsBackToCWD(t *testing.T) {
	sandboxAgentConfigEnv(t)
	work := t.TempDir()
	t.Chdir(work)
	path := writeMinimalAgentConfig(t, work, "models.json", "cwd-model")

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	if got := loaded.Config.Models["chat"].Name; got != "cwd-model" {
		t.Fatalf("loaded model %q, want the CWD config", got)
	}
	if want := canonicalPath(t, path); loaded.SourcePath != want {
		t.Fatalf("SourcePath = %q, want %q", loaded.SourcePath, want)
	}
}

func TestLoadDefaultAgentConfigFallsBackToUserConfigDir(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())

	configDir, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("UserConfigDir: %v", err)
	}
	dir := filepath.Join(configDir, "go-llm")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	writeMinimalAgentConfig(t, dir, "models.json", "user-config-model")

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	if got := loaded.Config.Models["chat"].Name; got != "user-config-model" {
		t.Fatalf("loaded model %q, want the user-config-dir config", got)
	}
}

func TestLoadDefaultAgentConfigFallsBackToLegacyHomePath(t *testing.T) {
	home := sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	// Keep os.UserConfigDir away from ~/.config so the legacy step is the one
	// that can match on Linux too.
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-elsewhere"))

	dir := filepath.Join(home, ".config", "go-llm")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	writeMinimalAgentConfig(t, dir, "models.json", "legacy-model")

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	if got := loaded.Config.Models["chat"].Name; got != "legacy-model" {
		t.Fatalf("loaded model %q, want the legacy home config", got)
	}
}

func TestLoadDefaultAgentConfigCanonicalizesSymlinkedSources(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())

	target := writeMinimalAgentConfig(t, t.TempDir(), "real-models.json", "target-model")
	link := filepath.Join(t.TempDir(), "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unsupported here: %v", err)
	}
	t.Setenv("GO_LLM_CONFIG", link)

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	if want := canonicalPath(t, target); loaded.SourcePath != want {
		t.Fatalf("SourcePath = %q, want symlink-resolved %q", loaded.SourcePath, want)
	}
	if strings.Contains(loaded.SourcePath, "link.json") {
		t.Fatalf("SourcePath %q still names the symlink", loaded.SourcePath)
	}
}

func TestLoadDefaultAgentConfigEmptyEnvFailsWithoutFallthrough(t *testing.T) {
	sandboxAgentConfigEnv(t)
	work := t.TempDir()
	t.Chdir(work)
	writeMinimalAgentConfig(t, work, "models.json", "cwd-model")
	t.Setenv("GO_LLM_CONFIG", "")

	if _, err := loadDefaultAgentConfig(); !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("loadDefaultAgentConfig = %v, want ErrAgentConfigInvalid (no fallthrough to ./models.json)", err)
	}
}

func TestLoadDefaultAgentConfigFailsWhenNoSourceExists(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())

	if _, err := loadDefaultAgentConfig(); !errors.Is(err, ErrAgentConfigMissing) {
		t.Fatalf("loadDefaultAgentConfig = %v, want ErrAgentConfigMissing", err)
	}
}

func TestLoadDefaultAgentConfigErrorsNeverNameTheSource(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())

	dir := t.TempDir()
	bad := filepath.Join(dir, "broken-models.json")
	if err := os.WriteFile(bad, []byte(`{"providers": {`), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Setenv("GO_LLM_CONFIG", bad)

	_, err := loadDefaultAgentConfig()
	if !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("loadDefaultAgentConfig = %v, want ErrAgentConfigInvalid", err)
	}
	msg := err.Error()
	if strings.Contains(msg, bad) || strings.Contains(msg, dir) || strings.Contains(msg, "broken-models") {
		t.Fatalf("error %q leaks the source path", msg)
	}
}

const documentAgentJSON = `{
  "providers": {"local": {"base_url": "http://localhost:11434"}},
  "models": {"agent-m": {"name": "m", "provider": "local", "type": "dense",
    "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`

const duplicateProviderDocumentJSON = `{
  "providers": {
    "local": {"base_url": "http://localhost:11434"},
    "local": {"base_url": "http://localhost:11435"}
  },
  "models": {"agent-m": {"name": "m", "provider": "local", "type": "dense",
    "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`

func TestLoadDefaultAgentConfigCapturesDocumentFacts(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	path := writeAgentConfigBody(t, documentAgentJSON)
	t.Setenv("GO_LLM_CONFIG", path)

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	wantRevision := sha256.Sum256(raw)
	if loaded.Revision != hex.EncodeToString(wantRevision[:]) {
		t.Fatalf("revision = %q", loaded.Revision)
	}
	if loaded.ReadOnly || loaded.HasConfigDiagnostic || loaded.Config == nil {
		t.Fatalf("loaded facts = %+v", loaded)
	}
}

func TestLoadDefaultAgentConfigCapturesReadOnlyDiagnostic(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	t.Setenv("GO_LLM_CONFIG", writeAgentConfigBody(t, duplicateProviderDocumentJSON))

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("duplicate-key document must load: %v", err)
	}
	if !loaded.ReadOnly ||
		loaded.ReadOnlyDiagnostic.Code != config.CodeDuplicateKeys ||
		loaded.ReadOnlyDiagnostic.SubjectKind != config.SubjectProvider ||
		loaded.ReadOnlyDiagnostic.Subject != "local" {
		t.Fatalf("read-only facts = %+v", loaded)
	}
}

func TestLoadDefaultAgentConfigDoesNotLogFailureDetails(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())

	const marker = "FIRN_LOAD_SECRET_MARKER"
	unsetenv(t, marker)

	var logs bytes.Buffer
	previousOutput := log.Writer()
	previousFlags := log.Flags()
	previousPrefix := log.Prefix()
	log.SetOutput(&logs)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(previousOutput)
		log.SetFlags(previousFlags)
		log.SetPrefix(previousPrefix)
	})

	dir := t.TempDir()
	path := filepath.Join(dir, "models-"+marker+".json")
	body := `{
  "providers": {
    "h": {
      "base_url": "http://localhost:1",
      "api_key": "${FIRN_LOAD_SECRET_MARKER}"
    }
  },
  "models": {
    "agent-m": {
      "name": "m",
      "provider": "h",
      "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"]
    }
  },
  "defaults": {"agent": "agent-m"}
}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", path)

	_, err := loadDefaultAgentConfig()
	if !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("load error = %v", err)
	}
	// A bounded, code-only line is logged host-side — never the raw error,
	// the source path, or a secret/dir marker.
	wantLog := "ai: agent config load failed: code=key_reference_unavailable\n"
	if got := logs.String(); got != wantLog {
		t.Fatalf("LoadDocument failure log = %q, want %q", got, wantLog)
	}
	if strings.Contains(logs.String(), marker) || strings.Contains(logs.String(), dir) {
		t.Fatalf("LoadDocument failure log leaks details: %q", logs.String())
	}
	if strings.Contains(err.Error(), marker) || strings.Contains(err.Error(), dir) {
		t.Fatalf("returned error leaks load details: %q", err)
	}

	missing := filepath.Join(dir, "missing-"+marker+".json")
	t.Setenv("GO_LLM_CONFIG", missing)
	_, err = loadDefaultAgentConfig()
	if !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("source error = %v", err)
	}

	got := logs.String()
	if !strings.Contains(got, "ai: agent config source rejected") {
		t.Fatalf("fixed source-rejection log missing: %q", got)
	}
	if strings.Contains(got, marker) || strings.Contains(got, dir) {
		t.Fatalf("source-rejection log leaks details: %q", got)
	}
	if strings.Contains(err.Error(), marker) || strings.Contains(err.Error(), dir) {
		t.Fatalf("returned source error leaks details: %q", err)
	}
}

// agentFixture exercises every field ResolveAgentTarget must carry: a Remote
// primary provider with sampling options and think overrides, plus a Local
// fallback that must be ignored completely.
const agentFixture = `{
  "providers": {
    "remote": {
      "base_url": "HTTP://Api.Example.com:80/v1/",
      "api_format": "openai-compat",
      "api_key": "sk-live-secret",
      "timeout": "90s"
    },
    "ollama": {"base_url": "http://localhost:11434"}
  },
  "models": {
    "coder": {
      "name": "big-coder",
      "provider": "remote",
      "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"],
      "fallbacks": ["local-fb"],
      "options": {"temperature": 0.2, "top_p": 0.9, "top_k": 40},
      "think_mode": "toggle",
      "think_tags": {"open": "<reason>", "close": "</reason>"}
    },
    "local-fb": {
      "name": "small-local",
      "provider": "ollama",
      "type": "dense",
      "capabilities": ["chat", "stream", "tool_call"]
    }
  },
  "defaults": {"agent": "coder", "chat": "local-fb"}
}`

func loadFixtureConfig(t *testing.T, content string) *config.Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func digestOf(providerName, canonicalEndpoint string) string {
	sum := sha256.Sum256([]byte(providerName + "\x00" + canonicalEndpoint))
	return hex.EncodeToString(sum[:])
}

func TestResolveAgentTargetSelectsRemotePrimaryIgnoringLocalFallback(t *testing.T) {
	cfg := loadFixtureConfig(t, agentFixture)
	target, err := ResolveAgentTarget(cfg)
	if err != nil {
		t.Fatalf("ResolveAgentTarget: %v", err)
	}
	dest := target.destination
	if dest.Provider != "remote" || dest.Model != "big-coder" {
		t.Fatalf("destination %+v, want the remote primary, never the local fallback", dest)
	}
	if dest.Endpoint != "http://api.example.com/v1" {
		t.Fatalf("Endpoint = %q, want canonical http://api.example.com/v1", dest.Endpoint)
	}
	if dest.Classification != "remote" {
		t.Fatalf("Classification = %q, want remote", dest.Classification)
	}
	if want := digestOf("remote", "http://api.example.com/v1"); dest.Digest != want {
		t.Fatalf("Digest = %q, want %q", dest.Digest, want)
	}
	if target.apiFormat != "openai-compat" || target.apiKey != "sk-live-secret" {
		t.Fatalf("apiFormat/apiKey = %q/%q not preserved", target.apiFormat, target.apiKey)
	}
	if target.timeout != 90*time.Second {
		t.Fatalf("timeout = %v, want 90s", target.timeout)
	}
	if target.model.Name != "big-coder" {
		t.Fatalf("model = %+v, want the primary model config", target.model)
	}
	opts := target.model.Options
	if opts == nil || *opts.Temperature != 0.2 || *opts.TopP != 0.9 || *opts.TopK != 40 {
		t.Fatalf("sampling options not preserved: %+v", opts)
	}
	if target.thinkMode == nil || *target.thinkMode != provider.ThinkToggle {
		t.Fatalf("thinkMode = %v, want toggle", target.thinkMode)
	}
	if target.thinkTags == nil || target.thinkTags.Open != "<reason>" || target.thinkTags.Close != "</reason>" {
		t.Fatalf("thinkTags = %+v, want <reason>/</reason>", target.thinkTags)
	}
}

func TestResolveAgentTargetDigestNeverIncludesAPIKey(t *testing.T) {
	cfg := loadFixtureConfig(t, agentFixture)
	rotated := loadFixtureConfig(t, strings.Replace(agentFixture, "sk-live-secret", "sk-other-key", 1))

	a, err := ResolveAgentTarget(cfg)
	if err != nil {
		t.Fatalf("ResolveAgentTarget: %v", err)
	}
	b, err := ResolveAgentTarget(rotated)
	if err != nil {
		t.Fatalf("ResolveAgentTarget(rotated key): %v", err)
	}
	if a.destination.Digest != b.destination.Digest {
		t.Fatal("digest changed when only the API key changed")
	}
	if strings.Contains(a.destination.Digest, "sk-live") {
		t.Fatal("digest embeds the API key")
	}
}

func TestResolveAgentTargetRequiresAgentRoleAndProvider(t *testing.T) {
	// No "agent" default at all: RoleForUseCase("agent") has no fallback chain.
	noAgent := loadFixtureConfig(t, `{
  "providers": {"ollama": {"base_url": "http://localhost:11434"}},
  "models": {"chat": {"name": "m", "type": "dense", "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"chat": "chat"}
}`)
	if _, err := ResolveAgentTarget(noAgent); !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("no agent default: err = %v, want ErrAgentConfigInvalid", err)
	}

	// Programmatic configs can dangle references config.Load would reject.
	dangling := &config.Config{
		Providers: map[string]config.ProviderConfig{},
		Models: map[string]config.ModelConfig{
			"agent-role": {Name: "m", Provider: "nope", Type: "dense", Capabilities: []string{"chat", "stream", "tool_call"}},
		},
		Defaults: map[string]string{"agent": "agent-role"},
	}
	if _, err := ResolveAgentTarget(dangling); !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("missing provider: err = %v, want ErrAgentConfigInvalid", err)
	}

	empty := &config.Config{
		Providers: map[string]config.ProviderConfig{"ollama": {BaseURL: "http://localhost:11434"}},
		Models: map[string]config.ModelConfig{
			"agent-role": {Name: "m", Type: "dense", Capabilities: []string{"chat", "stream", "tool_call"}},
		},
		Defaults: map[string]string{"agent": "agent-role"},
	}
	if _, err := ResolveAgentTarget(empty); !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("empty provider: err = %v, want ErrAgentConfigInvalid", err)
	}
}

func TestResolveAgentTargetRequiresChatStreamAndToolCall(t *testing.T) {
	// Derived dense capabilities are chat|generate|stream — tool_call is never
	// derived, so an agent model without explicit capabilities must be refused.
	derived := loadFixtureConfig(t, `{
  "providers": {"ollama": {"base_url": "http://localhost:11434"}},
  "models": {"chat": {"name": "m", "type": "dense"}},
  "defaults": {"agent": "chat", "chat": "chat"}
}`)
	if _, err := ResolveAgentTarget(derived); !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("derived caps: err = %v, want ErrAgentConfigInvalid", err)
	}

	partial := loadFixtureConfig(t, `{
  "providers": {"ollama": {"base_url": "http://localhost:11434"}},
  "models": {"chat": {"name": "m", "type": "dense", "capabilities": ["chat", "stream"]}},
  "defaults": {"agent": "chat", "chat": "chat"}
}`)
	if _, err := ResolveAgentTarget(partial); !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("missing tool_call: err = %v, want ErrAgentConfigInvalid", err)
	}
}

func TestResolveAgentTargetRejectsAnUnnormalizableEndpoint(t *testing.T) {
	// config.Load accepts a query string on base_url; normalization must not.
	cfg := loadFixtureConfig(t, `{
  "providers": {"ollama": {"base_url": "http://localhost:11434?x=1"}},
  "models": {"chat": {"name": "m", "type": "dense", "capabilities": ["chat", "stream", "tool_call"]}},
  "defaults": {"agent": "chat", "chat": "chat"}
}`)
	if _, err := ResolveAgentTarget(cfg); !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("query endpoint: err = %v, want ErrAgentConfigInvalid", err)
	}
}

func TestResolveAgentTargetSourcePathNeverReachesTheDestination(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-models.json")
	if err := os.WriteFile(path, []byte(agentFixture), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Setenv("GO_LLM_CONFIG", path)

	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("loadDefaultAgentConfig: %v", err)
	}
	target, err := ResolveAgentTarget(loaded.Config)
	if err != nil {
		t.Fatalf("ResolveAgentTarget: %v", err)
	}
	marshaled, err := json.Marshal(target.destination)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(marshaled), dir) || strings.Contains(string(marshaled), "agent-models") {
		t.Fatalf("ProviderDestination JSON %s leaks the config source path", marshaled)
	}
}

func TestNormalizeEndpointCanonicalForms(t *testing.T) {
	cases := []struct {
		raw   string
		want  string
		local bool
	}{
		{"http://EXAMPLE.com", "http://example.com", false},
		{"HTTP://Example.Com:80/", "http://example.com", false},
		{"https://example.com:443/v1/", "https://example.com/v1", false},
		{"http://example.com:8080", "http://example.com:8080", false},
		{"http://example.com:443", "http://example.com:443", false},
		{"https://example.com:80", "https://example.com:80", false},
		{"http://example.com/v1///", "http://example.com/v1", false},
		{"http://[::1]:11434/api/", "http://[::1]:11434/api", true},
		{"HTTP://[::1]", "http://[::1]", true},
		{"https://[2001:DB8::1]/v1", "https://[2001:db8::1]/v1", false},
		{"http://[2001:0db8:0:0:0:0:0:1]:8080/v1", "http://[2001:db8::1]:8080/v1", false},
		{"http://localhost:11434", "http://localhost:11434", true},
		{"http://LOCALHOST", "http://localhost", true},
		{"http://127.0.0.1:11434", "http://127.0.0.1:11434", true},
		{"http://127.99.3.4", "http://127.99.3.4", true},
		{"http://0.0.0.0:11434", "http://0.0.0.0:11434", false},
		{"http://192.168.1.5:11434", "http://192.168.1.5:11434", false},
		{"http://10.0.0.2", "http://10.0.0.2", false},
		{"http://my-gpu-box:11434", "http://my-gpu-box:11434", false},
		{"http://8.8.8.8", "http://8.8.8.8", false},
	}
	for _, tc := range cases {
		got, local, err := NormalizeEndpoint(tc.raw)
		if err != nil {
			t.Errorf("NormalizeEndpoint(%q): %v", tc.raw, err)
			continue
		}
		if got != tc.want || local != tc.local {
			t.Errorf("NormalizeEndpoint(%q) = %q, local=%v; want %q, local=%v", tc.raw, got, local, tc.want, tc.local)
		}
		// Canonical output must be a fixed point: Grant and consent-file
		// validation both re-normalize and require the identical string.
		again, againLocal, err := NormalizeEndpoint(got)
		if err != nil {
			t.Errorf("NormalizeEndpoint(%q) rejected its own canonical output: %v", got, err)
			continue
		}
		if again != got || againLocal != local {
			t.Errorf("canonical %q is not a fixed point: re-normalized to %q, local=%v", got, again, againLocal)
		}
	}
}

func TestNormalizeEndpointEquivalence(t *testing.T) {
	a, _, err := NormalizeEndpoint("HTTP://Host.Example.com:80/v1/")
	if err != nil {
		t.Fatalf("NormalizeEndpoint: %v", err)
	}
	b, _, err := NormalizeEndpoint("http://host.example.com/v1")
	if err != nil {
		t.Fatalf("NormalizeEndpoint: %v", err)
	}
	if a != b {
		t.Fatalf("equivalent endpoints normalized differently: %q vs %q", a, b)
	}
	// D10/R3: equivalent IPv6 spellings collapse to the same canonical host,
	// matching destination/v1's net.ParseIP(host).String() normalization.
	c, _, err := NormalizeEndpoint("http://[2001:0db8::1]")
	if err != nil {
		t.Fatalf("NormalizeEndpoint: %v", err)
	}
	d, _, err := NormalizeEndpoint("http://[2001:db8::1]")
	if err != nil {
		t.Fatalf("NormalizeEndpoint: %v", err)
	}
	if c != d {
		t.Fatalf("equivalent IPv6 spellings normalized differently: %q vs %q", c, d)
	}
}

// TestNormalizeEndpointPathEscapingFixedPoint: a raw bidi/control rune in the
// PATH (not the host) is not rejected by NormalizeEndpoint -- only the host
// is guarded -- but url.EscapedPath percent-escapes it, so the canonical
// output never carries the raw rune and that escaped form is a fixed point
// under re-normalization (the same "canonical must be a fixed point"
// invariant TestNormalizeEndpointCanonicalForms pins for hosts).
func TestNormalizeEndpointPathEscapingFixedPoint(t *testing.T) {
	raw := "http://example.com/agent\u202em"
	canonical, _, err := NormalizeEndpoint(raw)
	if err != nil {
		t.Fatalf("NormalizeEndpoint: %v", err)
	}
	if strings.ContainsRune(canonical, '\u202e') {
		t.Fatalf("canonical endpoint carries a raw bidi rune in the path: %q", canonical)
	}
	if !strings.Contains(canonical, "%") {
		t.Fatalf("canonical endpoint did not percent-escape the path rune: %q", canonical)
	}
	again, _, err := NormalizeEndpoint(canonical)
	if err != nil {
		t.Fatalf("NormalizeEndpoint rejected its own canonical output: %v", err)
	}
	if again != canonical {
		t.Fatalf("canonical %q is not a fixed point: re-normalized to %q", canonical, again)
	}
}

func TestNormalizeEndpointRejections(t *testing.T) {
	rejects := []string{
		"",
		"http://user@example.com",
		"http://user:pw@example.com",
		"ftp://example.com",
		"ws://example.com",
		"file:///etc/passwd",
		"http://",
		"http:///v1",
		"http://example.com?x=1",
		"http://example.com/?",
		"http://example.com/#frag",
		"http://example.com#frag",
		"http://[fe80::1%25en0]:11434", // IPv6 zone ID: no consent identity
		"/relative/path",
		"example.com",
		"http://ex\u202eample.com", // RLO
		"http://ex\u200fample.com", // RLM
		"http://ex\u200bample.com", // zero-width space
		"http://ex\u0430mple.com",  // Cyrillic "a" homoglyph
		"http://\uff45xample.com",  // fullwidth "e" homoglyph
		"http://example\u3002com",  // ideographic full stop as a dot lookalike
		"https://h/v1/../admin",    // dot-segment: rejected by destination/v1
		"https://h/./x",            // dot-segment: rejected by destination/v1
		"https://h/v1/%2e%2e/x",    // escaped dot-segment: same rejection
	}
	for _, raw := range rejects {
		if got, _, err := NormalizeEndpoint(raw); err == nil {
			t.Errorf("NormalizeEndpoint(%q) = %q, want error", raw, got)
		}
	}
	// A punycode-encoded internationalized host is plain ASCII and must still
	// be accepted -- the guard rejects non-ASCII runes, not non-Latin scripts.
	if got, _, err := NormalizeEndpoint("http://xn--e1aybc.example.com"); err != nil {
		t.Fatalf("punycode host rejected: %v", err)
	} else if got != "http://xn--e1aybc.example.com" {
		t.Fatalf("punycode host canonicalized wrong: %q", got)
	}
	// A clean host must still normalize once the Cc/Cf host check is added.
	if got, _, err := NormalizeEndpoint("http://example.com"); err != nil || got != "http://example.com" {
		t.Fatalf("clean host regressed: got %q, err %v", got, err)
	}
}

func TestDiscoverAgentConfigSourceReportsOrigin(t *testing.T) {
	t.Run("env override", func(t *testing.T) {
		sandboxAgentConfigEnv(t)
		t.Chdir(t.TempDir())
		p := filepath.Join(t.TempDir(), "models.json")
		if err := os.WriteFile(p, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GO_LLM_CONFIG", p)
		src, origin, err := discoverAgentConfigSource()
		if err != nil || src != p || origin != originEnv {
			t.Fatalf("got src=%q origin=%q err=%v; want %q %q nil", src, origin, err, p, originEnv)
		}
	})

	t.Run("env set but empty", func(t *testing.T) {
		sandboxAgentConfigEnv(t)
		t.Chdir(t.TempDir())
		t.Setenv("GO_LLM_CONFIG", "")
		_, origin, err := discoverAgentConfigSource()
		if !errors.Is(err, ErrAgentConfigInvalid) || origin != originEnv {
			t.Fatalf("got origin=%q err=%v; want %q ErrAgentConfigInvalid", origin, err, originEnv)
		}
	})

	t.Run("working directory", func(t *testing.T) {
		sandboxAgentConfigEnv(t)
		wd := t.TempDir()
		t.Chdir(wd)
		if err := os.WriteFile(filepath.Join(wd, "models.json"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		src, origin, err := discoverAgentConfigSource()
		if err != nil || src != "models.json" || origin != originWorkingDirectory {
			t.Fatalf("got src=%q origin=%q err=%v", src, origin, err)
		}
	})

	t.Run("user config dir", func(t *testing.T) {
		sandboxAgentConfigEnv(t)
		t.Chdir(t.TempDir())
		cfgDir, err := os.UserConfigDir() // resolves under the sandboxed home
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(cfgDir, "go-llm", "models.json")
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		src, origin, err := discoverAgentConfigSource()
		if err != nil || src != p || origin != originUserConfig {
			t.Fatalf("got src=%q origin=%q err=%v; want %q %q", src, origin, err, p, originUserConfig)
		}
	})

	t.Run("legacy home config", func(t *testing.T) {
		home := sandboxAgentConfigEnv(t)
		t.Chdir(t.TempDir())
		// Point XDG somewhere empty so the user-config branch misses and only
		// ~/.config (legacy) hits. On darwin UserConfigDir is HOME/Library/...
		// which the sandbox also leaves empty, so the same setup holds.
		t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "empty-xdg"))
		p := filepath.Join(home, ".config", "go-llm", "models.json")
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		src, origin, err := discoverAgentConfigSource()
		if err != nil || src != p || origin != originLegacy {
			t.Fatalf("got src=%q origin=%q err=%v; want %q %q", src, origin, err, p, originLegacy)
		}
	})

	t.Run("missing everywhere", func(t *testing.T) {
		sandboxAgentConfigEnv(t)
		t.Chdir(t.TempDir())
		_, origin, err := discoverAgentConfigSource()
		if !errors.Is(err, ErrAgentConfigMissing) || origin != originNone {
			t.Fatalf("got origin=%q err=%v; want %q ErrAgentConfigMissing", origin, err, originNone)
		}
	})
}

func TestLoadDefaultAgentConfigClassifiesJSONSyntax(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	dir := t.TempDir()
	p := filepath.Join(dir, "models.json")
	if err := os.WriteFile(p, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", p)
	loaded, err := loadDefaultAgentConfig()
	if !errors.Is(err, ErrAgentConfigInvalid) {
		t.Fatalf("want ErrAgentConfigInvalid, got %v", err)
	}
	if !errors.Is(err, errConfigJSONSyntax) {
		t.Fatalf("want errConfigJSONSyntax in chain, got %v", err)
	}
	if loaded.Origin != originEnv || loaded.LexicalPath != p {
		t.Fatalf("partial loadedAgentConfig missing origin/lexical: %+v", loaded)
	}
	if loaded.SourcePath != canonicalPath(t, p) {
		t.Fatalf("SourcePath = %q, want the canonicalized source even on load failure", loaded.SourcePath)
	}
	if strings.Contains(err.Error(), p) || strings.Contains(err.Error(), dir) {
		t.Fatalf("error text leaks path: %q", err.Error())
	}
	if !loaded.HasConfigDiagnostic ||
		loaded.ConfigDiagnostic.Code != config.CodeParseError ||
		loaded.ConfigDiagnostic.SubjectKind != config.SubjectNone ||
		loaded.ConfigDiagnostic.Subject != "" {
		t.Fatalf("ConfigDiagnostic = %+v", loaded.ConfigDiagnostic)
	}
}

func TestLoadDefaultAgentConfigTypeMismatchStaysCoarse(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	p := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(p, []byte(`{"providers": 3}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", p)
	loaded, err := loadDefaultAgentConfig()
	if !errors.Is(err, ErrAgentConfigInvalid) || errors.Is(err, errConfigJSONSyntax) {
		t.Fatalf("type mismatch must be coarse without the JSON-syntax sentinel: %v", err)
	}
	if !loaded.HasConfigDiagnostic ||
		loaded.ConfigDiagnostic.Code != config.CodeParseError ||
		loaded.ConfigDiagnostic.SubjectKind != config.SubjectNone ||
		loaded.ConfigDiagnostic.Subject != "" {
		t.Fatalf("ConfigDiagnostic = %+v", loaded.ConfigDiagnostic)
	}
	projection := buildSettingsProjection(loaded, err)
	if projection.State != "invalid" || len(projection.Diagnostics) != 1 ||
		projection.Diagnostics[0].Code != codeConfigInvalid || !projection.Diagnostics[0].Blocking {
		t.Fatalf("buildSettingsProjection(type mismatch) = %+v, want invalid config_invalid", projection)
	}
}

func TestLoadDefaultAgentConfigUnsetEnvKeyStaysCoarse(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	unsetenv(t, "FIRN_TEST_UNSET_KEY_263")
	p := filepath.Join(t.TempDir(), "models.json")
	cfg := `{
  "providers": {"h": {"base_url": "http://localhost:1", "api_key": "${FIRN_TEST_UNSET_KEY_263}"}},
  "models": {"agent-m": {"name": "m", "provider": "h", "type": "dense", "capabilities": ["chat","stream","tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`
	if err := os.WriteFile(p, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_LLM_CONFIG", p)
	loaded, err := loadDefaultAgentConfig()
	if !errors.Is(err, ErrAgentConfigInvalid) || errors.Is(err, errConfigJSONSyntax) {
		t.Fatalf("unset ${ENV} must be coarse config-invalid: %v", err)
	}
	if strings.Contains(err.Error(), "FIRN_TEST_UNSET_KEY_263") {
		t.Fatalf("error text leaks the env var name: %q", err.Error())
	}
	if loaded.Origin != originEnv {
		t.Fatalf("partial origin = %q", loaded.Origin)
	}
	if !loaded.HasConfigDiagnostic ||
		loaded.ConfigDiagnostic.Code != config.CodeKeyReferenceUnavailable ||
		loaded.ConfigDiagnostic.SubjectKind != config.SubjectProvider ||
		loaded.ConfigDiagnostic.Subject != "h" {
		t.Fatalf("ConfigDiagnostic = %+v", loaded.ConfigDiagnostic)
	}
}

func TestLoadDefaultAgentConfigResolvesSymlinkKeepingLexical(t *testing.T) {
	sandboxAgentConfigEnv(t)
	t.Chdir(t.TempDir())
	realDir := t.TempDir()
	real := filepath.Join(realDir, "real-models.json")
	cfg := `{
  "providers": {"h": {"base_url": "http://localhost:1"}},
  "models": {"agent-m": {"name": "m", "provider": "h", "type": "dense", "capabilities": ["chat","stream","tool_call"]}},
  "defaults": {"agent": "agent-m"}
}`
	if err := os.WriteFile(real, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "models.json")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	t.Setenv("GO_LLM_CONFIG", link)
	loaded, err := loadDefaultAgentConfig()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.LexicalPath != link {
		t.Fatalf("LexicalPath = %q, want the pre-resolution path %q", loaded.LexicalPath, link)
	}
	want := canonicalPath(t, real)
	if loaded.SourcePath != want {
		t.Fatalf("SourcePath = %q, want resolved %q", loaded.SourcePath, want)
	}
}
