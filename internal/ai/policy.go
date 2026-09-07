package ai

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"firn/internal/filesystem"
	agenttools "github.com/kstruzzieri/go-llm/agent/tools"
	"gopkg.in/yaml.v3"
)

// policyManifestLimit bounds each manifest read; enforcement happens during
// the read via filesystem.ReadFileBounded, which also rejects symlinked and
// non-regular manifests.
const policyManifestLimit = 256 << 10

// Manifest rules are capped across both supported files before compilation;
// every rule can compile to at most two patterns. The separate pattern cap is
// defense in depth if compileRule's expansion changes later.
const (
	maxManifestRules  = 512
	maxPolicyPatterns = 1024
)

// Segment caps bound both sides of one pattern match so hostile manifests and
// tool paths cannot inflate its memo table or recursion depth.
const (
	maxRuleSegments      = 64
	maxCandidateSegments = 256
	// Windows extended paths top out below 128 KiB when represented as UTF-8.
	// Checking raw bytes first bounds the normalization copies on every OS.
	maxCandidateBytes = 128 << 10
)

// policyManifestLabels are the only manifest locations consulted and the only
// values ever placed in PolicyWarning.Path.
var policyManifestLabels = []string{"ai-kit.yaml", "docs/ai/ai-kit.yaml"}

// Fixed user-visible warning categories. Never raw error text, never manifest
// values; raw causes are logged host-side only.
const (
	warnManifestMissing    = "no AI policy manifest found; only built-in protections apply"
	warnManifestEmpty      = "AI policy manifest defines no sensitive paths; only built-in protections apply"
	warnManifestUnreadable = "AI policy manifest could not be read; its rules were ignored"
	warnManifestMalformed  = "AI policy manifest could not be parsed; its rules were ignored"
	warnRuleRejected       = "AI policy manifest contains an invalid sensitive path rule; it was ignored"
	warnRuleLimitExceeded  = "AI policy manifest contains too many sensitive path rules; workspace file access was denied"
)

var (
	// errPolicyDenied is the host-side denial cause. go-llm's tool layer maps
	// any guard error to its own fixed model-visible message.
	errPolicyDenied = errors.New("path denied by firn scope policy")
	// errPolicyDetached is the stable denial while no repository is attached.
	errPolicyDetached = errors.New("reopen repository to resume file access")
)

// firnSensitiveFloor is the immutable deny floor. Repository policy can only
// add rules, never subtract these. The **/x plus **/x/** pairs matter: the
// go-llm guard contract passes only the final cleaned relative path, never
// its ancestors, so descendants must be denied by pattern.
var firnSensitiveFloor = []string{
	"**/.env*",
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
	"**/id_rsa*",
	"**/id_ed25519*",
	"**/id_ecdsa*",
	"**/id_dsa*",
	"**/credentials",
	"**/credentials.*",
	"**/*credential*",
	"**/*credential*/**",
	"**/*secret*",
	"**/*secret*/**",
	".git",
	".git/**",
	"**/.git",
	"**/.git/**",
	".firn",
	".firn/**",
	"**/.firn",
	"**/.firn/**",
	".agent",
	".agent/**",
	"**/.agent",
	"**/.agent/**",
}

var floorPatterns = func() [][]string {
	pats := make([][]string, len(firnSensitiveFloor))
	for i, rule := range firnSensitiveFloor {
		pats[i] = strings.Split(rule, "/")
	}
	return pats
}()

// PolicyWarning is a UI-visible policy load problem. Path is a fixed
// repo-relative manifest label only; Message is a fixed category string.
type PolicyWarning struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// ScopePolicy is the fail-closed read-egress policy for one bound repository:
// the immutable floor plus the current additive manifest rules, protected
// config sources, and load warnings. Guards issued by Guard read live state,
// so Reload/Detach/Attach affect every already-issued closure.
type ScopePolicy struct {
	fsys     filesystem.FileSystem
	repoRoot string

	mu         sync.Mutex
	detached   bool
	additive   [][]string
	warnings   []PolicyWarning
	protected  map[string]struct{} // lowercased slash repo-relative exact denies; never reloaded
	identities []fs.FileInfo       // protected config sources; hard-link aliases share identity
}

// LoadScopePolicy builds the policy for repoRoot and performs the initial
// bounded manifest load. Load failure of any kind retains the floor.
// repoRoot must be the canonical (EvalSymlinks) repository root — the same
// root the go-llm Workspace resolves — or the Rel-based containment in
// ProtectConfigSource/Watches and the guard's prefix mapping diverge.
func LoadScopePolicy(fsys filesystem.FileSystem, repoRoot string) *ScopePolicy {
	p := &ScopePolicy{fsys: fsys, repoRoot: repoRoot, protected: make(map[string]struct{})}
	p.Reload()
	return p
}

// Reload re-reads the manifests and replaces the additive rules and warnings.
// The floor and protected config sources are untouched.
func (p *ScopePolicy) Reload() {
	rules, warnings := loadManifests(p.fsys, p.repoRoot)
	p.mu.Lock()
	p.additive = rules
	p.warnings = warnings
	p.mu.Unlock()
}

// Detach makes every issued guard fail closed for all file paths until Attach.
func (p *ScopePolicy) Detach() {
	p.mu.Lock()
	p.detached = true
	p.mu.Unlock()
}

// Attach performs a bounded manifest reload, then restores ordinary
// floor-plus-additive evaluation.
func (p *ScopePolicy) Attach() {
	rules, warnings := loadManifests(p.fsys, p.repoRoot)
	p.mu.Lock()
	p.additive = rules
	p.warnings = warnings
	p.detached = false
	p.mu.Unlock()
}

// Warnings returns a copy of the current load warnings.
func (p *ScopePolicy) Warnings() []PolicyWarning {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]PolicyWarning(nil), p.warnings...)
}

// Watches reports whether absPath is one of the manifest locations this
// policy reloads from. Comparison is case-insensitive: a spurious reload
// trigger is harmless, a missed one is not.
func (p *ScopePolicy) Watches(absPath string) bool {
	cleaned := filepath.Clean(absPath)
	for _, label := range policyManifestLabels {
		if strings.EqualFold(cleaned, filepath.Join(p.repoRoot, filepath.FromSlash(label))) {
			return true
		}
	}
	return false
}

// ProtectConfigSource permanently denies workspace access to a config source
// file. Input must be an absolute, NUL-free, lexically canonical path. A source
// on a different Windows volume is unreachable because hard links cannot cross
// volumes; every same-volume source keeps its identity so an in-repo hard-link
// alias is denied. Protected paths survive Reload. For a contained source,
// exact path protection is installed before file-identity lookup, so a lookup
// error cannot reopen the known config name.
func (p *ScopePolicy) ProtectConfigSource(canonicalSourcePath string) error {
	if strings.IndexByte(canonicalSourcePath, 0) >= 0 {
		return errors.New("config source path contains a NUL byte")
	}
	if !filepath.IsAbs(canonicalSourcePath) {
		return errors.New("config source path is not absolute")
	}
	if filepath.Clean(canonicalSourcePath) != canonicalSourcePath {
		return errors.New("config source path is not lexically canonical")
	}
	rel, err := filepath.Rel(p.repoRoot, canonicalSourcePath)
	if err != nil {
		return nil // different volume: hard links cannot cross into the workspace
	}
	contained := rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
	if contained {
		key := strings.ToLower(strings.ReplaceAll(filepath.ToSlash(rel), `\`, "/"))
		p.mu.Lock()
		p.protected[key] = struct{}{}
		p.mu.Unlock()
	}

	info, err := filesystem.Lstat(p.fsys, canonicalSourcePath)
	if errors.Is(err, fs.ErrNotExist) {
		// A missing file has no inode, so no hard-link alias can exist, and the
		// exact-path deny above already covers the name. Erroring here would
		// take the whole workspace unavailable (Status maps this to InitError)
		// on every re-protect after the config file is deleted, even though the
		// cached target is still valid.
		return nil
	}
	if err != nil {
		// Any other lookup failure (e.g. permissions) means an existing file
		// whose identity we cannot record: a hard-link alias could slip the
		// deny, so fail closed.
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, protected := range p.identities {
		if os.SameFile(protected, info) {
			return nil
		}
	}
	p.identities = append(p.identities, info)
	return nil
}

// Guard returns the go-llm scope guard for a workspace rooted at the canonical
// workspaceRel (slash-relative to the repository root, "" for the repository
// itself). Alternate rels retain additive rules written against an in-repo
// symlink's detected path. The closure reads live policy state on every call.
func (p *ScopePolicy) Guard(workspaceRel string, alternateRels ...string) agenttools.ScopeGuard {
	prefix, ok := workspacePrefix(workspaceRel)
	if !ok {
		return func(string, bool) error { return errPolicyDenied }
	}
	prefixes := [][]string{prefix}
	seen := map[string]struct{}{strings.Join(prefix, "/"): {}}
	for _, rel := range alternateRels {
		if rel == "" {
			continue
		}
		prefix, ok := workspacePrefix(rel)
		if !ok {
			// ponytail: a workspace rel with ".." is an identity-layer bug; fail
			// closed for everything rather than guess a repo-relative mapping.
			return func(string, bool) error { return errPolicyDenied }
		}
		key := strings.Join(prefix, "/")
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		prefixes = append(prefixes, prefix)
	}
	return func(rel string, _ bool) error {
		return p.check(prefixes, workspaceRel, rel)
	}
}

// check evaluates one candidate. Runs under the policy mutex: matching is
// cheap and the lock keeps Reload/Detach/ProtectConfigSource race-free.
func (p *ScopePolicy) check(prefixes [][]string, workspaceRel, rel string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.detached {
		return errPolicyDetached
	}
	candidates := make([][]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		segs, ok := candidateSegments(prefix, rel)
		if !ok {
			return errPolicyDenied // oversized, absolute, escaping, or NUL input: fail closed
		}
		candidates = append(candidates, segs)
		joined := strings.Join(segs, "/")
		for prot := range p.protected {
			if joined == prot || strings.HasPrefix(joined, prot+"/") {
				return errPolicyDenied
			}
		}
	}
	if len(p.identities) > 0 {
		// ponytail: phase-one Golem has read-only file tools. Before adding any
		// mutating or exec tool, go-llm needs a post-open FileInfo guard so a
		// concurrent path swap cannot race this identity check.
		candidate := filepath.Join(p.repoRoot, filepath.FromSlash(workspaceRel), filepath.FromSlash(rel))
		if info, err := filesystem.Lstat(p.fsys, candidate); err == nil {
			for _, protected := range p.identities {
				if os.SameFile(protected, info) {
					return errPolicyDenied
				}
			}
		}
	}
	for _, segs := range candidates {
		for _, pat := range floorPatterns {
			if matchPattern(pat, segs) {
				return errPolicyDenied
			}
		}
		for _, pat := range p.additive {
			if matchPattern(pat, segs) {
				return errPolicyDenied
			}
		}
	}
	return nil
}

// workspacePrefix normalizes a repo-relative workspace directory into
// lowercase slash segments. ok is false when the input carries a ".."
// component.
func workspacePrefix(workspaceRel string) ([]string, bool) {
	var prefix []string
	for _, seg := range strings.Split(strings.ToLower(strings.ReplaceAll(workspaceRel, `\`, "/")), "/") {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return nil, false
		}
		prefix = append(prefix, seg)
	}
	return prefix, true
}

// candidateSegments converts a tool-relative path into lowercase slash
// repo-relative segments. Both separators are treated as separators and the
// result is lowercased so neither separator tricks nor case can bypass a
// denial on any platform. ok is false for NUL, absolute, or escaping input.
func candidateSegments(prefix []string, rel string) ([]string, bool) {
	if len(rel) > maxCandidateBytes || strings.IndexByte(rel, 0) >= 0 {
		return nil, false
	}
	s := strings.ToLower(strings.ReplaceAll(rel, `\`, "/"))
	if strings.HasPrefix(s, "/") || (len(s) >= 2 && s[1] == ':') {
		return nil, false
	}
	segs := append([]string(nil), prefix...)
	if len(segs) > maxCandidateSegments {
		return nil, false
	}
	for _, seg := range strings.Split(s, "/") {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return nil, false
		}
		segs = append(segs, seg)
		if len(segs) > maxCandidateSegments {
			return nil, false
		}
	}
	return segs, true
}

// matchPattern matches pattern segments against path segments. "**" matches
// zero or more whole segments; every other segment goes through path.Match.
// States are memoized on (patternIndex, pathIndex) so stacked "**" segments
// stay polynomial. No suffix matching.
func matchPattern(pat, name []string) bool {
	w := len(name) + 1
	memo := make([]int8, (len(pat)+1)*w) // 0 unknown, 1 match, 2 no match
	var rec func(pi, ni int) bool
	rec = func(pi, ni int) bool {
		idx := pi*w + ni
		if v := memo[idx]; v != 0 {
			return v == 1
		}
		var ok bool
		switch {
		case pi == len(pat):
			ok = ni == len(name)
		case pat[pi] == "**":
			ok = rec(pi+1, ni) || (ni < len(name) && rec(pi, ni+1))
		case ni < len(name):
			m, err := path.Match(pat[pi], name[ni])
			ok = err == nil && m && rec(pi+1, ni+1)
		}
		if ok {
			memo[idx] = 1
		} else {
			memo[idx] = 2
		}
		return ok
	}
	return rec(0, 0)
}

// policyManifest is the only manifest shape parsed: top-level sensitive_paths.
type policyManifest struct {
	SensitivePaths []string `yaml:"sensitive_paths"`
}

// loadManifests reads both supported manifests and unions their valid rules.
// Ordinary failures contribute a fixed-category warning and no rules from the
// affected manifest. A rule-count overflow discards the union and denies all.
func loadManifests(fsys filesystem.FileSystem, repoRoot string) ([][]string, []PolicyWarning) {
	var rules [][]string
	var warnings []PolicyWarning
	found := false
	rawRuleCount := 0
	for _, label := range policyManifestLabels {
		full := filepath.Join(repoRoot, filepath.FromSlash(label))
		data, _, err := filesystem.ReadFileBounded(fsys, full, policyManifestLimit)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			found = true
			log.Printf("ai: policy manifest %s unreadable: %v", label, err)
			warnings = append(warnings, PolicyWarning{Path: label, Message: warnManifestUnreadable})
			continue
		}
		found = true
		var doc policyManifest
		if err := yaml.Unmarshal(data, &doc); err != nil {
			log.Printf("ai: policy manifest %s malformed: %v", label, err)
			warnings = append(warnings, PolicyWarning{Path: label, Message: warnManifestMalformed})
			continue
		}
		if len(doc.SensitivePaths) > maxManifestRules-rawRuleCount {
			return manifestRuleOverflow(label)
		}
		rawRuleCount += len(doc.SensitivePaths)
		accepted := 0
		for _, raw := range doc.SensitivePaths {
			pats, ok := compileRule(raw)
			if !ok {
				log.Printf("ai: policy manifest %s: rejected sensitive path rule %q", label, raw)
				warnings = append(warnings, PolicyWarning{Path: label, Message: warnRuleRejected})
				continue
			}
			if len(pats) > maxPolicyPatterns-len(rules) {
				return manifestRuleOverflow(label)
			}
			rules = append(rules, pats...)
			accepted++
		}
		if accepted == 0 {
			warnings = append(warnings, PolicyWarning{Path: label, Message: warnManifestEmpty})
		}
	}
	if !found {
		warnings = append(warnings, PolicyWarning{Path: policyManifestLabels[0], Message: warnManifestMissing})
	}
	return rules, warnings
}

// manifestRuleOverflow discards every partially loaded additive rule and
// warning. One cheap deny-all pattern fails closed; one fixed warning keeps
// UI-visible state bounded independently of hostile manifest contents.
func manifestRuleOverflow(label string) ([][]string, []PolicyWarning) {
	log.Printf("ai: policy manifest %s exceeds the sensitive path rule limit", label)
	return [][]string{{"**"}}, []PolicyWarning{{Path: label, Message: warnRuleLimitExceeded}}
}

// compileRule validates and compiles one additive rule into its pattern and,
// unless it already ends in "**", a descendant "/**" variant — the guard is
// never called for ancestors, so a rule naming a directory must deny its
// contents itself. Absolute, NUL, ".." and invalid-glob rules are rejected.
func compileRule(raw string) ([][]string, bool) {
	if strings.IndexByte(raw, 0) >= 0 {
		return nil, false
	}
	s := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(raw, `\`, "/")))
	s = strings.TrimRight(s, "/")
	if s == "" || s == "." {
		return nil, false
	}
	if strings.HasPrefix(s, "/") || (len(s) >= 2 && s[1] == ':') {
		return nil, false
	}
	var segs []string
	for _, seg := range strings.Split(s, "/") {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return nil, false
		}
		if seg == "**" {
			// "**/**" ≡ "**" (each matches zero or more segments): collapse so
			// a hostile manifest cannot stack thousands of "**" segments into
			// a per-guard-call matcher blowup under the policy mutex.
			if len(segs) > 0 && segs[len(segs)-1] == "**" {
				continue
			}
		} else if _, err := path.Match(seg, "probe"); err != nil {
			return nil, false
		}
		segs = append(segs, seg)
	}
	if len(segs) == 0 || len(segs) > maxRuleSegments {
		return nil, false
	}
	patterns := [][]string{segs}
	if segs[len(segs)-1] != "**" {
		desc := make([]string, len(segs)+1)
		copy(desc, segs)
		desc[len(segs)] = "**"
		patterns = append(patterns, desc)
	}
	return patterns, true
}
