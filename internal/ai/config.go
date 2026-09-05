package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/kstruzzieri/go-llm/agent"
	"github.com/kstruzzieri/go-llm/config"
	"github.com/kstruzzieri/go-llm/provider"
)

// ErrAgentConfigMissing reports that no go-llm configuration source exists at
// any discovery location. Returned error strings never contain the selected
// source path or config bytes; loadDefaultAgentConfig logs at most a fixed
// string or a diagnostic code host-side, never the raw cause.
var ErrAgentConfigMissing = errors.New("agent configuration missing")

// ErrAgentConfigInvalid reports that a discovered configuration source could
// not be read, parsed, validated, or resolved to a usable agent target.
// Returned error strings never contain the selected source path or config
// bytes; loadDefaultAgentConfig logs at most a fixed string or a diagnostic
// code host-side, never the raw cause.
var ErrAgentConfigInvalid = errors.New("agent configuration invalid")

// errConfigJSONSyntax marks a load failure whose root cause is malformed JSON
// (errors.As *json.SyntaxError on config.LoadDocument's return). Backend-only: it is
// chained ALONGSIDE ErrAgentConfigInvalid so SanitizeError is unchanged and
// the settings projection can classify json_invalid without string matching.
var errConfigJSONSyntax = errors.New("agent configuration is not valid JSON")

// sourceOrigin classifies which discovery branch produced the config source.
// Values are the Wails-facing sourceOrigin vocabulary. The zero value is not
// part of the contract: any consumer projecting an origin across the boundary
// must map every value explicitly and never pass the raw string through.
type sourceOrigin string

const (
	originNone             sourceOrigin = "none"
	originEnv              sourceOrigin = "env"
	originWorkingDirectory sourceOrigin = "working_directory"
	originUserConfig       sourceOrigin = "user_config"
	originLegacy           sourceOrigin = "legacy"
)

// loadedAgentConfig couples a validated go-llm config with the file it came
// from and the document-level facts LoadDocument exposes. SourcePath
// (canonical) and LexicalPath (as discovered, pre-symlink resolution) are
// backend-only and must never cross the Wails boundary. On a load failure the
// Config is nil but Origin and the paths are still populated as far as
// discovery got, so the settings projection can name the source class
// without re-running discovery. ConfigDiagnostic/ReadOnlyDiagnostic are
// boundary-safe (config.DiagnosticOf): never a path, raw JSON, key value, or
// go-llm error text.
type loadedAgentConfig struct {
	Config              *config.Config
	SourcePath          string
	LexicalPath         string
	Origin              sourceOrigin
	Revision            string
	ReadOnly            bool
	ReadOnlyDiagnostic  config.Diagnostic
	ConfigDiagnostic    config.Diagnostic
	HasConfigDiagnostic bool
}

// loadDefaultAgentConfig discovers the go-llm provider config exactly the way
// the pinned go-llm config.Default does — $GO_LLM_CONFIG, ./models.json, the
// platform user config dir, then the legacy ~/.config path — without invoking
// config.Default itself, because Firn needs the selected source path back.
// The selected file is canonicalized and handed to config.LoadDocument
// exactly once. No discovery step performs network I/O.
func loadDefaultAgentConfig() (loadedAgentConfig, error) {
	_, loaded, err := loadAgentConfigDocument()
	return loaded, err
}

// loadAgentConfigDocument is loadDefaultAgentConfig plus the Document itself.
// A write needs the mutable document AND the canonical identity of the file it
// came from, and both must come from ONE discovery + canonicalize + load: the
// document is read from the RESOLVED path, so a symlink repointed after
// discovery cannot slip a different file between the identity check and the
// read, and a later save targets exactly the file this call read.
func loadAgentConfigDocument() (*config.Document, loadedAgentConfig, error) {
	source, origin, err := discoverAgentConfigSource()
	if err != nil {
		return nil, loadedAgentConfig{Origin: origin}, err
	}
	loaded := loadedAgentConfig{LexicalPath: source, Origin: origin}
	resolved, err := canonicalizeConfigSource(source)
	if err != nil {
		log.Print("ai: agent config source rejected")
		return nil, loaded, fmt.Errorf("%w: source is not a readable regular file", ErrAgentConfigInvalid)
	}
	loaded.SourcePath = resolved
	doc, err := config.LoadDocument(resolved)
	if err != nil {
		if d, ok := config.DiagnosticOf(err); ok {
			loaded.ConfigDiagnostic = d
			loaded.HasConfigDiagnostic = true
			log.Printf("ai: agent config load failed: code=%s", d.Code)
		} else {
			log.Print("ai: agent config load failed")
		}
		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) {
			return nil, loaded, fmt.Errorf("%w: %w", ErrAgentConfigInvalid, errConfigJSONSyntax)
		}
		return nil, loaded, fmt.Errorf("%w: configuration failed to load", ErrAgentConfigInvalid)
	}
	loaded.Config = doc.Config()
	loaded.Revision = doc.Revision()
	if d, ok := doc.ReadOnly(); ok {
		loaded.ReadOnly = true
		loaded.ReadOnlyDiagnostic = d
	}
	return doc, loaded, nil
}

// discoverAgentConfigSource mirrors the pinned go-llm discovery order and
// reports which branch matched. A set $GO_LLM_CONFIG always decides —
// set-but-empty is an error, never a fallthrough, matching go-llm.
func discoverAgentConfigSource() (string, sourceOrigin, error) {
	if envPath, ok := os.LookupEnv("GO_LLM_CONFIG"); ok {
		if envPath == "" {
			return "", originEnv, fmt.Errorf("%w: config override variable is set but empty", ErrAgentConfigInvalid)
		}
		return envPath, originEnv, nil
	}
	if _, err := os.Stat("models.json"); err == nil {
		return "models.json", originWorkingDirectory, nil
	}
	if configDir, err := os.UserConfigDir(); err == nil {
		path := filepath.Join(configDir, "go-llm", "models.json")
		if _, err := os.Stat(path); err == nil {
			return path, originUserConfig, nil
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		path := filepath.Join(home, ".config", "go-llm", "models.json")
		if _, err := os.Stat(path); err == nil {
			return path, originLegacy, nil
		}
	}
	return "", originNone, fmt.Errorf("%w: no configuration found at any discovery location", ErrAgentConfigMissing)
}

// canonicalizeConfigSource resolves a discovered source to an absolute,
// symlink-free regular file.
func canonicalizeConfigSource(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(resolved)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("config source %q is not a regular file", resolved)
	}
	return resolved, nil
}

// ProviderDestination identifies where agent traffic would go. It is safe to
// cross the Wails boundary: no API key, no filesystem paths.
type ProviderDestination struct {
	Provider       string `json:"provider"`
	Model          string `json:"model"`
	Endpoint       string `json:"endpoint"`
	Classification string `json:"classification"` // local | remote
	Digest         string `json:"digest"`
}

// providerTarget is the backend-only resolved agent target. The API key never
// crosses the Wails boundary, so the type and every field stay unexported.
type providerTarget struct {
	destination ProviderDestination
	apiFormat   string
	apiKey      string
	timeout     time.Duration
	model       config.ModelConfig
	thinkMode   *provider.ThinkMode
	thinkTags   *provider.ThinkTags
}

// requiredAgentCaps is the capability set the agent role's primary model must
// declare, expressed via upstream's shared call-shape calculation so a go-llm
// change propagates here instead of stranding a stale copy. tool_call is
// never type-derived, so configs must state it.
var requiredAgentCaps = agent.ModelCallCapabilities(true)

// ResolveAgentTarget resolves the single agent destination from cfg: the
// "agent" use-case's primary model and provider only. The chat run path's
// caller (fixedModelCaller) is physically single-target — the primary IS
// that consumer's complete reachable set — so its consent decision binds to
// exactly one destination. Multi-destination reachability (fallback chains,
// recommendation routing) is governed by reachableDestinations, the batch
// apply challenge, the grant-only approval op, and the generator's
// DestinationPolicy, not here. No network or DNS call is made.
func ResolveAgentTarget(cfg *config.Config) (providerTarget, error) {
	role, ok := cfg.RoleForUseCase(useCaseAgent)
	if !ok {
		return providerTarget{}, fmt.Errorf("%w: no agent use-case configured", ErrAgentConfigInvalid)
	}
	model := cfg.RoleConfig(role)
	if model == nil {
		return providerTarget{}, fmt.Errorf("%w: agent role has no model", ErrAgentConfigInvalid)
	}
	if model.Provider == "" {
		return providerTarget{}, fmt.Errorf("%w: agent model has no provider", ErrAgentConfigInvalid)
	}
	prov := cfg.Provider(model.Provider)
	if prov == nil {
		return providerTarget{}, fmt.Errorf("%w: agent model's provider is not configured", ErrAgentConfigInvalid)
	}
	caps, err := provider.ParseCapsStrict(model.ResolvedCapabilities())
	if err != nil {
		log.Printf("ai: agent model capabilities rejected: %v", err)
		return providerTarget{}, fmt.Errorf("%w: agent model capabilities are not canonical", ErrAgentConfigInvalid)
	}
	if !caps.Has(requiredAgentCaps) {
		return providerTarget{}, fmt.Errorf("%w: agent model must support chat, stream, and tool_call", ErrAgentConfigInvalid)
	}
	endpoint, local, err := NormalizeEndpoint(prov.BaseURL)
	if err != nil {
		log.Printf("ai: agent provider endpoint rejected: %v", err)
		return providerTarget{}, fmt.Errorf("%w: agent provider endpoint is not a usable URL", ErrAgentConfigInvalid)
	}
	var thinkMode *provider.ThinkMode
	if model.ThinkMode != "" {
		mode, err := provider.ParseThinkModeStrict(model.ThinkMode)
		if err != nil {
			return providerTarget{}, fmt.Errorf("%w: agent model think_mode is invalid", ErrAgentConfigInvalid)
		}
		thinkMode = &mode
	}
	var thinkTags *provider.ThinkTags
	if model.ThinkTags != nil {
		thinkTags = &provider.ThinkTags{Open: model.ThinkTags.Open, Close: model.ThinkTags.Close}
	}
	classification := "remote"
	if local {
		classification = "local"
	}
	return providerTarget{
		destination: ProviderDestination{
			Provider:       model.Provider,
			Model:          model.Name,
			Endpoint:       endpoint,
			Classification: classification,
			Digest:         destinationDigest(model.Provider, endpoint),
		},
		apiFormat: prov.APIFormat,
		apiKey:    prov.APIKey,
		timeout:   prov.Timeout.Duration,
		model:     *model,
		thinkMode: thinkMode,
		thinkTags: thinkTags,
	}, nil
}

// destinationDigest is the fixed consent identity of a destination: SHA-256
// over the canonical provider name, NUL, and the canonical endpoint. The API
// key is never an input.
func destinationDigest(providerName, canonicalEndpoint string) string {
	sum := sha256.Sum256([]byte(providerName + "\x00" + canonicalEndpoint))
	return hex.EncodeToString(sum[:])
}

// NormalizeEndpoint canonicalizes an HTTP(S) endpoint URL and classifies it as
// Local or Remote without any DNS resolution. Local means the host is exactly
// "localhost", a 127.0.0.0/8 literal, or ::1; everything else — 0.0.0.0, LAN
// addresses, ordinary hostnames, public IPs — is Remote. Userinfo, non-HTTP
// schemes, missing hosts, queries, and fragments are rejected. Error strings
// never include the raw input.
func NormalizeEndpoint(raw string) (canonical string, local bool, err error) {
	if raw == "" {
		return "", false, errors.New("endpoint is empty")
	}
	if strings.Contains(raw, "#") {
		return "", false, errors.New("endpoint must not carry a fragment")
	}
	u, err := url.ParseRequestURI(raw)
	if err != nil {
		return "", false, errors.New("endpoint is not an absolute URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false, errors.New("endpoint scheme must be http or https")
	}
	if u.Opaque != "" {
		return "", false, errors.New("endpoint must not be opaque")
	}
	if u.User != nil {
		return "", false, errors.New("endpoint must not carry userinfo")
	}
	if u.RawQuery != "" || u.ForceQuery {
		return "", false, errors.New("endpoint must not carry a query")
	}
	host := strings.ToLower(u.Hostname())
	if strings.ContainsFunc(host, func(r rune) bool { return unicode.In(r, unicode.Cc, unicode.Cf) }) {
		return "", false, errors.New("endpoint host must not carry control or format characters")
	}
	// A non-ASCII host (Cyrillic/fullwidth/ideographic-dot homoglyphs, etc.)
	// is never resolvable as-is and a confusable one could visually spoof a
	// trusted domain in the consent prompt or config view. Reject it outright
	// rather than rendering it — an internationalized host must be supplied
	// as its ASCII punycode form (xn--...), which passes through unchanged.
	if strings.ContainsFunc(host, func(r rune) bool { return r > unicode.MaxASCII }) {
		return "", false, errors.New("endpoint host must be ASCII; use punycode for internationalized hosts")
	}
	if host == "" {
		return "", false, errors.New("endpoint must include a host")
	}
	// An IPv6 zone ID is meaningless as a consent identity, and its escaped
	// form ("%25en0" -> "%en0") would make the canonical output fail its own
	// re-normalization — canonical must be a fixed point.
	if strings.Contains(host, "%") {
		return "", false, errors.New("endpoint host must not carry a zone ID")
	}
	// Equivalent IP spellings are the same endpoint, so collapsing them is a
	// safe merge — and destination/v1 does the same, so the consent digest
	// stays spelling-independent and matches the policy identity it feeds.
	ip := net.ParseIP(host)
	if ip != nil {
		host = ip.String()
	}
	hostPart := host
	if strings.Contains(host, ":") { // IPv6 literal: rebracket
		hostPart = "[" + host + "]"
	}
	port := u.Port()
	var defaultPort string
	switch scheme {
	case "http":
		defaultPort = "80"
	case "https":
		defaultPort = "443"
	}
	if port != "" && port != defaultPort {
		hostPart += ":" + port
	}
	path := strings.TrimRight(u.EscapedPath(), "/")
	// A base path carrying "." or ".." segments misdescribes its own scope
	// and is rejected by go-llm's destination/v1 canonicalization; accepting
	// it here would store a consent grant upstream can never admit. Both
	// spellings are checked, matching upstream: a server may resolve "%2e%2e"
	// as a dot segment even though the escaped form does not look like one.
	if hasDotSegment(path) || hasDotSegment(strings.TrimRight(u.Path, "/")) {
		return "", false, errors.New("endpoint path must not contain \".\" or \"..\" segments")
	}
	local = host == "localhost" || (ip != nil && ip.IsLoopback())
	return scheme + "://" + hostPart + path, local, nil
}

func hasDotSegment(path string) bool {
	for _, seg := range strings.Split(path, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}
