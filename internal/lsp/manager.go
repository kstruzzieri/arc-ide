package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"firn/internal/lsp/provision"
	"firn/internal/lsp/pythonenv"
)

// errNoWorkspaceRoot signals that an LSP method was called before
// SetWorkspaceRoot. Only DidOpen surfaces this to the caller; other entry
// points treat it as a silent no-op.
var errNoWorkspaceRoot = errors.New("no workspace root set")

const (
	// serverShutdownTimeout is the time allowed for a single server to shut down gracefully.
	serverShutdownTimeout = 5 * time.Second
	// maxCrashRetries is the maximum number of crash recovery attempts before giving up.
	maxCrashRetries = 5
	// maxCrashBackoff caps the exponential backoff duration.
	maxCrashBackoff = 30 * time.Second
	// crashRestartTimeout is the timeout for a crash-recovery server restart.
	crashRestartTimeout = 30 * time.Second
)

// ServerStatus represents the current status of a language server.
type ServerStatus struct {
	Family                      string   `json:"family"`
	Workspace                   string   `json:"workspace"`
	Command                     string   `json:"command,omitempty"`
	State                       string   `json:"state"` // "starting", "ready", "stopping", "stopped", "error"
	Error                       string   `json:"error,omitempty"`
	CompletionTriggerCharacters []string `json:"completionTriggerCharacters,omitempty"`
	SetupState                  string   `json:"setupState,omitempty"` // ready|missing_server|missing_interpreter|misconfigured_env|config_degraded|retryable|provisioning|offline|provision_failed
	InterpreterPath             string   `json:"interpreterPath,omitempty"`
	ProjectRoot                 string   `json:"projectRoot,omitempty"`
	ConfigSource                string   `json:"configSource,omitempty"`
	ExtraPaths                  []string `json:"extraPaths,omitempty"`
	PythonVersion               string   `json:"pythonVersion,omitempty"`
	Action                      string   `json:"action,omitempty"` // create_venv|select_interpreter|retry|""
	DetailCode                  string   `json:"detailCode,omitempty"`
	ProvisionPct                int      `json:"provisionPct,omitempty"` // 0-100 during managed install
}

// EventEmitter is the callback signature for emitting events to the frontend.
type EventEmitter func(event string, data any)

// Manager owns workspace-scoped language server instances.
type Manager struct {
	registry       *Registry
	emitter        EventEmitter
	configProvider WorkspaceConfigProvider

	mu      sync.Mutex
	servers map[serverKey]*serverEntry

	// docKeys maps an open document URI to the serverKey of the server
	// that owns it. Populated by DidOpen after ensureServer succeeds, used
	// by serverForPath / DidClose to skip the project-root filesystem walk
	// on every subsequent call (DidChange, DidSave, Hover, Definition,
	// Complete, ResolveCompletionItem). Removed when the document's
	// refCount hits zero.
	//
	// The plan explicitly defers hot-migration when a marker appears mid-
	// session, so caching the resolved root is consistent with the spec:
	// the next open/reopen picks up the new root.
	docKeys map[string]serverKey

	// workspaceRoot is the active workspace root path (not URI).
	workspaceRoot string

	// stopped is set by ShutdownAll to prevent crash-recovery restarts
	// from resurrecting servers after intentional teardown.
	stopped bool

	// provisioners maps a language family to its managed provisioner. Populated
	// by SetProvisioners and shared with the registry so a resolver miss can be
	// classified as provisionable. Set once via SetProvisioners before the first
	// DidOpen and not mutated after; reads are unsynchronized on that basis.
	provisioners map[string]provision.Provisioner

	// provisionMu guards provisioning. It is intentionally separate from mu so
	// an in-flight install never blocks document routing on the hot path.
	provisionMu sync.Mutex
	// provisioning tracks families with an install in flight (single-flight).
	provisioning map[string]bool

	// pendingProvisionDocs tracks documents opened while a managed server is
	// installing. Once the server starts, these URIs are sent via lsp:reconnect
	// so the frontend replays didOpen with current buffer content.
	pendingProvisionDocs map[serverKey]map[string]bool

	// ctx is the manager's lifetime context, cancelled by ShutdownAll so
	// background installs stop when the workspace is torn down.
	ctx    context.Context
	cancel context.CancelFunc

	// interpreterOverrides maps a workspace/project root -> manual interpreter
	// path. In-memory only; Task 12b persists/seeds it from workspace state.
	// Wired into the envConfigProvider override hook via overrideForRoot.
	overrideMu           sync.RWMutex
	interpreterOverrides map[string]string
}

// serverKey identifies a unique server instance by language family and workspace.
type serverKey struct {
	family    string
	workspace string
}

// docState tracks an open document's reference count and latest version.
type docState struct {
	refCount int
	version  int
}

// serverEntry tracks a running server and its open documents.
type serverEntry struct {
	client     *Client
	config     *ServerConfig
	openDocs   map[string]*docState // URI -> state
	crashCount int
	lastCrash  time.Time
	stopping   bool
}

// NewManager creates a new LSP manager with the given event emitter.
func NewManager(emitter EventEmitter) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		registry:             NewRegistry(),
		emitter:              emitter,
		configProvider:       newEnvConfigProvider(),
		servers:              make(map[serverKey]*serverEntry),
		docKeys:              make(map[string]serverKey),
		provisioning:         make(map[string]bool),
		pendingProvisionDocs: make(map[serverKey]map[string]bool),
		ctx:                  ctx,
		cancel:               cancel,
		interpreterOverrides: make(map[string]string),
	}
	// Wire the manual interpreter override into env resolution. The
	// configProvider field is the interface type; the override hook lives only
	// on the concrete provider, so assert before wiring.
	if ep, ok := m.configProvider.(*envConfigProvider); ok {
		ep.SetInterpreterOverrideFunc(m.overrideForRoot)
	}
	return m
}

// SetProvisioners injects managed provisioners and forwards them to the registry
// so a resolver miss can be classified as provisionable.
func (m *Manager) SetProvisioners(p map[string]provision.Provisioner) {
	m.provisioners = p
	m.registry.SetProvisioners(p)
}

// SetWorkspaceRoot updates the active workspace root path.
// This does NOT shut down existing servers — call ShutdownAll first if switching workspaces.
//
// The stored root is cleaned and made absolute. This invariant lets later
// boundary comparisons (e.g. pathContains for crash-recovery guards) treat
// the workspace prefix consistently regardless of whether the caller passed
// a trailing separator or a relative path.
func (m *Manager) SetWorkspaceRoot(root string) {
	cleaned := root
	if root != "" {
		if abs, err := filepath.Abs(root); err == nil {
			cleaned = filepath.Clean(abs)
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.workspaceRoot = cleaned
	m.stopped = false
	// Refresh the lifetime context: a workspace switch cancels installs scoped
	// to the previous root and gives the new root a live context to provision
	// under (also revives the manager after a ShutdownAll teardown).
	if m.cancel != nil {
		m.cancel()
	}
	m.ctx, m.cancel = context.WithCancel(context.Background())
}

// WorkspaceRoot returns the current workspace root path.
func (m *Manager) WorkspaceRoot() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.workspaceRoot
}

// DidOpen handles a document being opened. Starts a server if needed,
// then sends textDocument/didOpen to the appropriate server.
func (m *Manager) DidOpen(ctx context.Context, path, languageID string, version int, content string) error {
	ext := filepath.Ext(path)
	family := m.registry.FamilyForExtension(ext)
	if family == "" {
		return nil // unsupported file type — no-op
	}

	if languageID == "" {
		languageID = m.registry.LanguageIDForExtension(ext)
	}

	uri, err := FileToURI(path)
	if err != nil {
		return fmt.Errorf("invalid path %q: %w", path, err)
	}

	workspace, err := m.projectRootForPath(family, path)
	if err != nil {
		if errors.Is(err, errNoWorkspaceRoot) {
			return fmt.Errorf("no workspace root set")
		}
		// Path outside the active workspace or otherwise unresolvable: skip
		// silently so files opened transiently outside the LSP scope (e.g.,
		// preview of a sibling repo) do not surface noisy errors.
		return nil
	}

	key := serverKey{family: family, workspace: workspace}
	if !m.serverRunning(key) {
		m.trackPendingProvisionDoc(key, uri)
	}

	entry, err := m.ensureServer(ctx, family, workspace)
	if err != nil {
		m.untrackPendingProvisionDoc(uri)
		return err
	}
	if entry == nil {
		// A managed install is in flight (provisionable miss). DidOpen is
		// non-blocking: restartFamily emits lsp:reconnect once the cache is
		// populated, and the frontend re-sends current content.
		return nil
	}
	m.untrackPendingProvisionDoc(uri)

	m.mu.Lock()
	ds, exists := entry.openDocs[uri]
	if exists {
		ds.refCount++
		ds.version = version
	} else {
		entry.openDocs[uri] = &docState{refCount: 1, version: version}
	}
	// Cache the resolved key so that DidChange / DidSave / Hover /
	// Definition / Complete / ResolveCompletionItem can route this URI
	// without re-walking the filesystem on every keystroke.
	m.docKeys[uri] = serverKey{family: family, workspace: workspace}
	m.mu.Unlock()

	// Only send didOpen to the server on the first open
	if !exists {
		return entry.client.DidOpen(uri, languageID, version, content)
	}
	return nil
}

// DidChange forwards content changes to the appropriate server.
// Returns early if the document has not been opened via DidOpen (e.g., during
// the gap between crash recovery and frontend reconnect).
func (m *Manager) DidChange(path string, version int, changes []TextDocumentContentChangeEvent) error {
	entry, uri, _ := m.serverForPath(path)
	if entry == nil {
		return nil
	}

	m.mu.Lock()
	ds, ok := entry.openDocs[uri]
	if !ok {
		m.mu.Unlock()
		return nil // document not tracked — skip to avoid LSP sequencing violation
	}
	ds.version = version
	m.mu.Unlock()

	return entry.client.DidChange(uri, version, changes)
}

// DidSave forwards save notification to the appropriate server.
// Returns early if the document has not been opened via DidOpen.
func (m *Manager) DidSave(path string) error {
	entry, uri, _ := m.serverForPath(path)
	if entry == nil {
		return nil
	}

	m.mu.Lock()
	_, ok := entry.openDocs[uri]
	m.mu.Unlock()
	if !ok {
		return nil // document not tracked — skip
	}

	return entry.client.DidSave(uri)
}

// DidClose forwards close notification and decrements the document reference count.
// Shuts down the server when no documents remain open.
func (m *Manager) DidClose(ctx context.Context, path string) error {
	ext := filepath.Ext(path)
	family := m.registry.FamilyForExtension(ext)
	if family == "" {
		return nil
	}

	uri, err := FileToURI(path)
	if err != nil {
		return fmt.Errorf("invalid path %q: %w", path, err)
	}
	if m.untrackPendingProvisionDoc(uri) {
		return nil
	}

	m.mu.Lock()
	// Use the cached key from DidOpen rather than re-resolving the project
	// root — the document's owning server is fixed at open time.
	key, cached := m.docKeys[uri]
	if !cached {
		// Document was never opened (or already fully closed). Silent no-op.
		m.mu.Unlock()
		return nil
	}
	entry, ok := m.servers[key]
	if !ok {
		// Server already torn down (workspace switch, crash, etc.). Clean up
		// the stale cache entry and bail.
		delete(m.docKeys, uri)
		m.mu.Unlock()
		return nil
	}

	ds, docExists := entry.openDocs[uri]
	if !docExists {
		delete(m.docKeys, uri)
		m.mu.Unlock()
		return nil
	}

	ds.refCount--
	if ds.refCount <= 0 {
		delete(entry.openDocs, uri)
		delete(m.docKeys, uri)
	}
	shouldShutdown := len(entry.openDocs) == 0
	m.mu.Unlock()

	// Only send didClose to the server when the last reference is removed
	if ds.refCount <= 0 {
		if err := entry.client.DidClose(uri); err != nil {
			log.Printf("lsp: didClose failed for %s: %v", uri, err)
		}
	}

	// Shut down server if no more documents are open.
	// shutdownServerIfEmpty re-checks under lock in case a concurrent DidOpen added a document.
	if shouldShutdown {
		shutCtx, cancel := context.WithTimeout(context.Background(), serverShutdownTimeout)
		defer cancel()
		m.shutdownServerIfEmpty(shutCtx, key)
	}

	return nil
}

// Hover sends a hover request for the given file position.
func (m *Manager) Hover(ctx context.Context, path string, line, character int) (*Hover, error) {
	entry, uri, key := m.serverForPath(path)
	if entry == nil {
		return nil, nil
	}
	result, err := entry.client.Hover(ctx, uri, line, character)
	if err != nil {
		m.logRequestFailure(key, "textDocument/hover", err)
	}
	return result, err
}

// Definition sends a go-to-definition request for the given file position.
func (m *Manager) Definition(ctx context.Context, path string, line, character int) ([]Location, error) {
	entry, uri, key := m.serverForPath(path)
	if entry == nil {
		return nil, nil
	}
	result, err := entry.client.Definition(ctx, uri, line, character)
	if err != nil {
		m.logRequestFailure(key, "textDocument/definition", err)
	}
	return result, err
}

// DocumentSymbol sends a documentSymbol request for the given file and returns
// its normalized symbol tree. Returns nil when no server covers the file.
func (m *Manager) DocumentSymbol(ctx context.Context, path string) ([]DocumentSymbol, error) {
	entry, uri, key := m.serverForPath(path)
	if entry == nil {
		return nil, nil
	}
	// Skip servers that don't advertise documentSymbol support. The Structure
	// view fetches on every file switch and (debounced) edit, so blindly
	// sending the request to a server that will reject it would spam
	// request-failure logs and surface a misleading error state to the user.
	if !documentSymbolSupported(entry.client.ServerCapabilities().DocumentSymbolProvider) {
		return nil, nil
	}
	result, err := entry.client.DocumentSymbol(ctx, uri)
	if err != nil {
		m.logRequestFailure(key, "textDocument/documentSymbol", err)
	}
	return result, err
}

// Complete sends a completion request for the given file position.
func (m *Manager) Complete(ctx context.Context, path string, line, character int, triggerChar string) (*CompletionList, error) {
	entry, uri, key := m.serverForPath(path)
	if entry == nil {
		return nil, nil
	}
	result, err := entry.client.Complete(ctx, uri, line, character, triggerChar)
	if err != nil {
		m.logRequestFailure(key, "textDocument/completion", err)
	}
	return result, err
}

// ResolveCompletionItem resolves additional metadata for a completion item.
func (m *Manager) ResolveCompletionItem(ctx context.Context, path string, item CompletionItem) (*CompletionItem, error) {
	entry, _, key := m.serverForPath(path)
	if entry == nil {
		return nil, nil
	}
	result, err := entry.client.ResolveCompletionItem(ctx, item)
	if err != nil {
		m.logRequestFailure(key, "completionItem/resolve", err)
	}
	return result, err
}

// GetStatus returns the status of all running language servers.
func (m *Manager) GetStatus() []ServerStatus {
	m.mu.Lock()

	statuses := make([]ServerStatus, 0, len(m.servers))
	for key, entry := range m.servers {
		state := "ready"
		switch entry.client.State() {
		case ClientStateInitializing:
			state = "starting"
		case ClientStateShuttingDown:
			state = "stopping"
		case ClientStateStopped:
			state = "stopped"
		}
		if entry.stopping {
			state = "stopping"
		}

		status := ServerStatus{
			Family:    key.family,
			Workspace: key.workspace,
			Command:   entry.config.Command,
			State:     state,
		}
		if state == "ready" {
			status.CompletionTriggerCharacters = completionTriggerChars(entry)
		}
		statuses = append(statuses, status)
	}
	m.mu.Unlock()

	for i := range statuses {
		m.enrichPythonSetup(&statuses[i])
	}

	return statuses
}

// ShutdownAll gracefully shuts down all running language servers.
// Used during workspace switches and app close.
func (m *Manager) ShutdownAll(timeout time.Duration) {
	m.mu.Lock()
	m.stopped = true
	cancel := m.cancel
	m.pendingProvisionDocs = nil
	keys := make([]serverKey, 0, len(m.servers))
	for key := range m.servers {
		keys = append(keys, key)
	}
	m.mu.Unlock()

	// Cancel the lifetime context so any in-flight managed install stops.
	if cancel != nil {
		cancel()
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var wg sync.WaitGroup
	for _, key := range keys {
		wg.Add(1)
		go func(k serverKey) {
			defer wg.Done()
			m.shutdownServer(ctx, k)
		}(key)
	}
	wg.Wait()
}

// --- internal ---

// ensureServer returns an existing server or starts a new one for the given family/workspace.
func (m *Manager) ensureServer(ctx context.Context, family, workspace string) (*serverEntry, error) {
	key := serverKey{family: family, workspace: workspace}

	m.mu.Lock()
	if entry, ok := m.servers[key]; ok {
		m.mu.Unlock()
		return entry, nil
	}
	m.mu.Unlock()

	// Resolve server config
	config, err := m.registry.ServerConfigFor(family, workspace)
	if err != nil {
		// A managed provisioner can serve this family: kick off an async install
		// rather than hard-failing the file open. The server starts once the
		// cache is populated (see restartFamily).
		var miss *ServerMissError
		if errors.As(err, &miss) && miss.Provisionable && m.provisioners[family] != nil {
			m.beginProvision(family, workspace)
			return nil, nil
		}
		m.emitStatus(family, workspace, "error", err.Error(), defaultServerCommand(family))
		return nil, err
	}

	return m.startServer(ctx, key, config)
}

// provisionCtx returns the manager's lifetime context, falling back to a
// background context when the manager was built via a struct literal (some
// tests) rather than NewManager. The install goroutine derives cancellation
// from this so workspace teardown (ShutdownAll) stops in-flight installs.
//
// m.ctx is rewritten under m.mu by SetWorkspaceRoot, so the read is locked.
// Both call sites evaluate this as a plain argument before any further lock is
// taken, so there is no nested-lock path.
func (m *Manager) provisionCtx() context.Context {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx != nil {
		return m.ctx
	}
	return context.Background()
}

// beginProvision installs a family's managed server in the background, emitting
// status transitions. Single-flight per family: a second open of the same
// family while an install is in flight is a no-op.
func (m *Manager) beginProvision(family, projectRoot string) {
	prov := m.provisioners[family]
	if prov == nil {
		return
	}

	m.provisionMu.Lock()
	if m.provisioning == nil {
		m.provisioning = map[string]bool{}
	}
	if m.provisioning[family] {
		m.provisionMu.Unlock()
		return
	}
	m.provisioning[family] = true
	m.provisionMu.Unlock()

	m.emitProvisionStatus(family, projectRoot, "provisioning", "", "", 0)

	go func() {
		res := prov.Install(m.provisionCtx(), func(p provision.Progress) {
			m.emitProvisionStatus(family, projectRoot, "provisioning", "", "", p.Pct)
		})

		m.provisionMu.Lock()
		m.provisioning[family] = false
		m.provisionMu.Unlock()

		switch res.State {
		case provision.StateAvailable:
			// Cache is populated — re-run the normal start path.
			m.restartFamily(family, projectRoot)
		case provision.StateOffline:
			m.emitProvisionStatus(family, projectRoot, "offline", "retry", "download_offline", 0)
		case provision.StateChecksumFailed:
			m.emitProvisionStatus(family, projectRoot, "provision_failed", "retry", "checksum_mismatch", 0)
		case provision.StateUnsupported:
			// No retry: an unsupported platform fails identically every time.
			m.emitProvisionStatus(family, projectRoot, "provision_failed", "", "unsupported_platform", 0)
		default:
			m.emitProvisionStatus(family, projectRoot, "provision_failed", "retry", "provision_error", 0)
		}
	}()
}

// RetryProvision re-attempts a managed install (frontend Retry action) keyed
// to the same project root the failed auto-provision used, so a nested
// monorepo sub-project retries the right scope. An empty projectRoot falls
// back to the workspace root (older callers and root-level workspaces).
func (m *Manager) RetryProvision(family, projectRoot string) error {
	if _, ok := m.provisioners[family]; !ok {
		return fmt.Errorf("no managed provisioner for %q", family)
	}
	if projectRoot == "" {
		projectRoot = m.WorkspaceRoot()
	}
	m.beginProvision(family, projectRoot)
	return nil
}

// restartFamily re-runs the normal start path for a family after a successful
// provision. It reuses ensureServer so the server is launched and a ready
// status emitted exactly as a first open would. Errors are logged; the start
// path already emits an error status on failure.
func (m *Manager) restartFamily(family, projectRoot string) {
	entry, err := m.ensureServer(m.provisionCtx(), family, projectRoot)
	if err != nil {
		log.Printf("lsp: post-provision start failed family=%s root=%q: %v", family, projectRoot, err)
		return
	}
	if entry != nil {
		m.emitPendingProvisionReconnect(serverKey{family: family, workspace: projectRoot})
	}
}

// restartRunningFamily restarts a server only if one is currently running for
// the given family/root. Used after an interpreter-override change so the new
// interpreter takes effect. When no server is running it is a safe no-op — a
// future DidOpen starts the server with the override already applied.
func (m *Manager) restartRunningFamily(family, projectRoot string) {
	key := serverKey{family: family, workspace: projectRoot}
	m.mu.Lock()
	_, running := m.servers[key]
	m.mu.Unlock()
	if !running {
		return
	}
	shutCtx, cancel := context.WithTimeout(context.Background(), serverShutdownTimeout)
	m.shutdownServer(shutCtx, key)
	cancel()
	m.restartFamily(family, projectRoot)
}

// overrideForRoot is the lookup wired into envConfigProvider.SetInterpreterOverrideFunc.
func (m *Manager) overrideForRoot(projectRoot string) string {
	m.overrideMu.RLock()
	defer m.overrideMu.RUnlock()
	return m.interpreterOverrides[projectRoot]
}

// SeedInterpreterOverride sets an override WITHOUT restarting servers (used at
// workspace load to apply a persisted choice before the first DidOpen).
func (m *Manager) SeedInterpreterOverride(projectRoot, interpreterPath string) {
	m.overrideMu.Lock()
	if !validInterpreterPath(interpreterPath) {
		if interpreterPath != "" {
			log.Printf("lsp: ignoring persisted interpreter override for %q: %q missing or a directory", projectRoot, interpreterPath)
		}
		delete(m.interpreterOverrides, projectRoot)
	} else {
		m.interpreterOverrides[projectRoot] = interpreterPath
	}
	m.overrideMu.Unlock()
}

// SetInterpreterOverride validates the path, stores the override, and restarts
// the python server for that root so the new interpreter takes effect.
// Returns an error if interpreterPath does not exist / is a directory.
func (m *Manager) SetInterpreterOverride(projectRoot, interpreterPath string) error {
	// Override paths bypass the discovery layer's stat validation, so validate
	// here: the env layer trusts whatever this map returns.
	if !validInterpreterPath(interpreterPath) {
		return fmt.Errorf("interpreter not found: %q", interpreterPath)
	}

	m.overrideMu.Lock()
	m.interpreterOverrides[projectRoot] = interpreterPath
	m.overrideMu.Unlock()

	m.restartRunningFamily("python", projectRoot)
	return nil
}

func validInterpreterPath(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// ClearInterpreterOverride removes the override and restarts python for that root.
func (m *Manager) ClearInterpreterOverride(projectRoot string) error {
	m.overrideMu.Lock()
	delete(m.interpreterOverrides, projectRoot)
	m.overrideMu.Unlock()

	m.restartRunningFamily("python", projectRoot)
	return nil
}

// DoctorReport summarizes python LSP setup for a workspace so the UI can render
// actionable choices from one call.
type DoctorReport struct {
	Family            string   `json:"family"`
	InterpreterPath   string   `json:"interpreterPath,omitempty"`
	InterpreterSource string   `json:"interpreterSource,omitempty"`
	Override          string   `json:"override,omitempty"`
	Candidates        []string `json:"candidates"`
}

// Doctor returns the resolved interpreter + override + candidate interpreters
// for the given workspace root (python family).
func (m *Manager) Doctor(projectRoot string) DoctorReport {
	env := pythonEnvFromProvider(m.configProvider, projectRoot)
	override := m.overrideForRoot(projectRoot)

	rep := DoctorReport{
		Family:            "python",
		InterpreterPath:   env.InterpreterPath,
		InterpreterSource: env.Source,
		Override:          override,
	}

	// Build a deduped candidate list, dropping empties. Best-effort: discovery
	// and LookPath errors are ignored.
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		rep.Candidates = append(rep.Candidates, p)
	}

	add(env.InterpreterPath)
	add(override)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if interp, _, ok := pythonenv.DiscoverInterpreter(ctx, projectRoot, osRunner); ok {
		add(interp)
	}
	cancel()

	if p, err := exec.LookPath("python3"); err == nil {
		add(p)
	}
	if p, err := exec.LookPath("python"); err == nil {
		add(p)
	}

	return rep
}

// emitProvisionStatus emits an lsp:status event describing a managed-install
// transition. It mirrors emitStatus's contract (called without m.mu held) but
// carries the typed setup fields the provisioning cards need. The LSP State is
// "starting" while provisioning and "error" once an install fails so existing
// frontend state machines treat it sensibly.
func (m *Manager) emitProvisionStatus(family, projectRoot, setupState, action, detailCode string, pct int) {
	if m.emitter == nil {
		return
	}
	state := "starting"
	if setupState == "offline" || setupState == "provision_failed" {
		state = "error"
	}
	m.emitter("lsp:status", ServerStatus{
		Family:       family,
		Workspace:    projectRoot,
		State:        state,
		ProjectRoot:  projectRoot,
		SetupState:   setupState,
		Action:       action,
		DetailCode:   detailCode,
		ProvisionPct: pct,
	})
}

func (m *Manager) serverRunning(key serverKey) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.servers[key]
	return ok
}

func (m *Manager) trackPendingProvisionDoc(key serverKey, uri string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pendingProvisionDocs == nil {
		m.pendingProvisionDocs = make(map[serverKey]map[string]bool)
	}
	docs := m.pendingProvisionDocs[key]
	if docs == nil {
		docs = make(map[string]bool)
		m.pendingProvisionDocs[key] = docs
	}
	docs[uri] = true
}

func (m *Manager) untrackPendingProvisionDoc(uri string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, docs := range m.pendingProvisionDocs {
		if docs[uri] {
			delete(docs, uri)
			if len(docs) == 0 {
				delete(m.pendingProvisionDocs, key)
			}
			return true
		}
	}
	return false
}

func (m *Manager) emitPendingProvisionReconnect(key serverKey) {
	m.mu.Lock()
	docsByURI := m.pendingProvisionDocs[key]
	if len(docsByURI) == 0 {
		m.mu.Unlock()
		return
	}
	documents := make([]string, 0, len(docsByURI))
	for uri := range docsByURI {
		documents = append(documents, uri)
	}
	delete(m.pendingProvisionDocs, key)
	m.mu.Unlock()

	if m.emitter != nil {
		m.emitter("lsp:reconnect", map[string]any{
			"family":    key.family,
			"workspace": key.workspace,
			"documents": documents,
		})
	}
}

// startServer launches a new language server process and initializes it.
func (m *Manager) startServer(ctx context.Context, key serverKey, config *ServerConfig) (*serverEntry, error) {
	m.emitStatus(key.family, key.workspace, "starting", "", config.Command)

	transport, err := NewStdioTransport(config.Command, config.Dir, config.Args...)
	if err != nil {
		m.emitStatus(key.family, key.workspace, "error", err.Error(), config.Command)
		return nil, fmt.Errorf("start server %s: %w", config.Command, err)
	}

	entry := &serverEntry{
		config:   config,
		openDocs: make(map[string]*docState),
	}

	client := NewClient(transport, func(method string, params json.RawMessage) {
		m.handleNotification(key, method, params)
	})
	entry.client = client
	client.SetServerRequestHandler(m.serverRequestHandler(key))

	rootURI, err := FileToURI(key.workspace)
	if err != nil {
		_ = transport.Close()
		m.emitStatus(key.family, key.workspace, "error", err.Error(), config.Command)
		return nil, fmt.Errorf("invalid workspace path %q: %w", key.workspace, err)
	}
	if err := client.Initialize(ctx, rootURI, config.InitOptions); err != nil {
		// Close waits for the child process and stderr copier so diagnostics are complete.
		_ = transport.Close()
		errMsg := err.Error()
		if stderr := transport.Stderr(); stderr != "" {
			errMsg = fmt.Sprintf("%s (server stderr: %s)", errMsg, strings.TrimSpace(stderr))
		}
		m.emitStatus(key.family, key.workspace, "error", errMsg, config.Command)
		return nil, fmt.Errorf("initialize %s: %s", config.Command, errMsg)
	}

	m.mu.Lock()
	if m.stopped || !pathContains(m.workspaceRoot, key.workspace) {
		m.mu.Unlock()
		shutCtx, cancel := context.WithTimeout(context.Background(), serverShutdownTimeout)
		defer cancel()
		m.doShutdown(shutCtx, key, entry)
		return nil, fmt.Errorf("server start abandoned for %s/%s: workspace changed or manager stopped", key.family, key.workspace)
	}
	// Double-check: another goroutine may have started the server while we were initializing
	if existing, ok := m.servers[key]; ok {
		m.mu.Unlock()
		shutCtx, cancel := context.WithTimeout(context.Background(), serverShutdownTimeout)
		defer cancel()
		_ = client.Shutdown(shutCtx)
		return existing, nil
	}
	m.servers[key] = entry
	m.mu.Unlock()

	m.emitStatus(key.family, key.workspace, "ready", "", config.Command)

	// Monitor for unexpected server exit
	go m.monitorServer(key, entry)

	return entry, nil
}

// shutdownServerIfEmpty shuts down a server only if it still has no open documents.
// Used by DidClose to guard against a concurrent DidOpen that reopened a document
// between the DidClose unlock and this call.
func (m *Manager) shutdownServerIfEmpty(ctx context.Context, key serverKey) {
	m.mu.Lock()
	entry, ok := m.servers[key]
	if !ok || entry.stopping || len(entry.openDocs) > 0 {
		m.mu.Unlock()
		return
	}
	entry.stopping = true
	delete(m.servers, key)
	m.mu.Unlock()

	m.doShutdown(ctx, key, entry)
}

// shutdownServer unconditionally shuts down a server.
// Used by ShutdownAll and workspace switching.
func (m *Manager) shutdownServer(ctx context.Context, key serverKey) {
	m.mu.Lock()
	entry, ok := m.servers[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	if entry.stopping {
		m.mu.Unlock()
		return
	}
	entry.stopping = true
	delete(m.servers, key)
	m.mu.Unlock()

	m.doShutdown(ctx, key, entry)
}

// doShutdown performs the actual client shutdown and emits status events.
func (m *Manager) doShutdown(ctx context.Context, key serverKey, entry *serverEntry) {

	m.emitStatus(key.family, key.workspace, "stopping", "", entry.config.Command)

	if err := entry.client.Shutdown(ctx); err != nil {
		log.Printf("lsp: shutdown %s/%s failed: %v", key.family, key.workspace, err)
	}

	m.emitStatus(key.family, key.workspace, "stopped", "", entry.config.Command)
}

// monitorServer watches for unexpected server process exit and attempts restart.
func (m *Manager) monitorServer(key serverKey, entry *serverEntry) {
	<-entry.client.Done()

	m.mu.Lock()
	current, ok := m.servers[key]
	if !ok || current != entry || entry.stopping {
		m.mu.Unlock()
		return
	}

	// Server crashed — check backoff
	entry.crashCount++
	entry.lastCrash = time.Now()

	if entry.crashCount > maxCrashRetries {
		delete(m.servers, key)
		m.mu.Unlock()
		m.emitStatus(key.family, key.workspace, "error",
			fmt.Sprintf("server crashed %d times, giving up", entry.crashCount), entry.config.Command)
		m.emitError(key.family, key.workspace,
			fmt.Sprintf("Language server for %s crashed repeatedly. Check that %s is installed correctly.",
				key.family, entry.config.Command))
		return
	}

	// Calculate backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
	backoff := time.Second * time.Duration(1<<(entry.crashCount-1))
	if backoff > maxCrashBackoff {
		backoff = maxCrashBackoff
	}

	// Save open doc URIs for reconnect notification
	openDocURIs := make([]string, 0, len(entry.openDocs))
	for uri := range entry.openDocs {
		openDocURIs = append(openDocURIs, uri)
	}
	config := entry.config
	crashCount := entry.crashCount
	lastCrash := entry.lastCrash
	delete(m.servers, key)
	m.mu.Unlock()

	log.Printf("lsp: %s server crashed (attempt %d), restarting in %v", key.family, crashCount, backoff)
	m.emitStatus(key.family, key.workspace, "error",
		fmt.Sprintf("server crashed, restarting in %v (attempt %d/%d)", backoff, crashCount, maxCrashRetries), config.Command)

	time.Sleep(backoff)

	// After backoff, verify the manager hasn't been shut down and the project
	// root is still inside the active workspace. Without this check, a
	// ShutdownAll or a workspace switch during the sleep would still result in
	// a stray server being resurrected.
	m.mu.Lock()
	if m.stopped || !pathContains(m.workspaceRoot, key.workspace) {
		m.mu.Unlock()
		log.Printf("lsp: skipping %s restart — manager stopped or workspace changed", key.family)
		return
	}
	m.mu.Unlock()

	// Restart
	ctx, cancel := context.WithTimeout(context.Background(), crashRestartTimeout)
	defer cancel()

	newEntry, err := m.startServer(ctx, key, config)
	if err != nil {
		log.Printf("lsp: restart %s failed: %v", key.family, err)
		return
	}

	// Carry over crash count
	m.mu.Lock()
	newEntry.crashCount = crashCount
	newEntry.lastCrash = lastCrash
	m.mu.Unlock()

	// Emit lsp:reconnect so the frontend re-sends document content.
	// Do NOT re-open documents with empty content — let the frontend handle it.
	if m.emitter != nil {
		m.emitter("lsp:reconnect", map[string]any{
			"family":    key.family,
			"workspace": key.workspace,
			"documents": openDocURIs,
		})
	}
}

// serverForPath finds the server entry responsible for the given file path.
// For TypeScript-family files the lookup is keyed by the detected project
// root, so nested packages route to their own server instance.
//
// Hot-path callers (DidChange/DidSave/Hover/Definition/Complete) call this
// per keystroke or per request; it MUST avoid filesystem I/O. The cache
// populated by DidOpen makes the common case a single map lookup. The
// fallback resolution path runs only for unopened documents, which the
// existing API contract treats as no-ops anyway.
func (m *Manager) serverForPath(path string) (*serverEntry, string, serverKey) {
	ext := filepath.Ext(path)
	family := m.registry.FamilyForExtension(ext)
	if family == "" {
		return nil, "", serverKey{}
	}

	uri, err := FileToURI(path)
	if err != nil {
		return nil, "", serverKey{}
	}

	m.mu.Lock()
	if key, cached := m.docKeys[uri]; cached {
		entry, ok := m.servers[key]
		if !ok {
			// Server was torn down out from under the cache — clean up.
			delete(m.docKeys, uri)
			m.mu.Unlock()
			return nil, "", key
		}
		m.mu.Unlock()
		return entry, uri, key
	}
	m.mu.Unlock()

	// Fallback for documents that were never DidOpen'd through this manager.
	// Existing callers (DidChange/DidSave/Hover/etc.) already treat a nil
	// entry as a silent no-op, so this branch effectively just preserves
	// "unknown document → no server" semantics rather than crashing.
	workspace, rerr := m.projectRootForPath(family, path)
	if rerr != nil {
		return nil, "", serverKey{}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	key := serverKey{family: family, workspace: workspace}
	entry, ok := m.servers[key]
	if !ok {
		return nil, "", key
	}
	return entry, uri, key
}

// projectRootForPath returns the workspace key for the given file path.
// For language families with project markers this is the nearest project root
// found by upward walk, bounded by the active workspace. Families without
// marker detection return the active workspace root unchanged.
//
// Must be called WITHOUT the manager lock held — it performs filesystem
// stat calls during marker probing.
//
// Returns errNoWorkspaceRoot if SetWorkspaceRoot has not been called, or
// ErrPathOutsideWorkspace (wrapped via ResolveProjectRoot) if the file is
// outside the active workspace.
func (m *Manager) projectRootForPath(family, path string) (string, error) {
	m.mu.Lock()
	workspace := m.workspaceRoot
	m.mu.Unlock()

	if workspace == "" {
		return "", errNoWorkspaceRoot
	}

	markers := projectRootMarkers(family)
	if len(markers) == 0 {
		return workspace, nil
	}
	return ResolveProjectRoot(path, workspace, markers, projectRootSkipDirs(family))
}

// projectRootMarkers returns the marker filenames used to detect a project
// root for the given language family. Returning an empty slice means root
// detection is disabled for the family and callers should use the active
// workspace root directly.
func projectRootMarkers(family string) []string {
	switch family {
	case "typescript":
		return []string{"tsconfig.json", "jsconfig.json", "package.json"}
	case "go":
		return []string{"go.mod"}
	case "python":
		return []string{"pyproject.toml", "requirements.txt", "setup.py"}
	case "rust":
		return []string{"Cargo.toml"}
	}
	return nil
}

// projectRootSkipDirs returns directory segments whose marker matches must
// be ignored during project-root resolution for the given family.
//
// For TypeScript this returns ["node_modules"] so that navigating into a
// dependency (e.g. via go-to-definition) does NOT spawn a per-dependency
// LSP server rooted at node_modules/<dep>/package.json. Instead the walk
// continues through node_modules until it finds the consuming package's
// project root above.
func projectRootSkipDirs(family string) []string {
	switch family {
	case "typescript":
		return []string{"node_modules"}
	}
	return nil
}

func (m *Manager) logRequestFailure(key serverKey, method string, err error) {
	log.Printf("lsp: request failed method=%s family=%s workspace=%q error=%v", method, key.family, key.workspace, err)
}

func defaultServerCommand(family string) string {
	switch family {
	case "typescript":
		return "typescript-language-server"
	case "go":
		return "gopls"
	case "python":
		return "pyright-langserver"
	case "rust":
		return "rust-analyzer"
	default:
		return ""
	}
}

// handleNotification processes server notifications and emits events.
func (m *Manager) handleNotification(key serverKey, method string, params json.RawMessage) {
	switch method {
	case "textDocument/publishDiagnostics":
		if m.emitter == nil {
			return
		}
		// Drop stale diagnostics: if the server sends diagnostics with a version
		// older than what we've tracked, the frontend has already moved past them.
		var diagParams PublishDiagnosticsParams
		if err := json.Unmarshal(params, &diagParams); err != nil {
			log.Printf("lsp: failed to parse diagnostics: %v", err)
			return
		}

		m.mu.Lock()
		if m.stopped || !pathContains(m.workspaceRoot, key.workspace) {
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()

		if diagParams.Version > 0 {
			m.mu.Lock()
			entry, ok := m.servers[key]
			if ok {
				if ds, docOk := entry.openDocs[diagParams.URI]; docOk && diagParams.Version < ds.version {
					m.mu.Unlock()
					return // stale diagnostics — drop
				}
			}
			m.mu.Unlock()
		}
		// Wrap diagnostics with workspace context so the frontend can
		// filter stale events after workspace switches.
		m.emitter("lsp:diagnostics", map[string]any{
			"workspace":   key.workspace,
			"uri":         diagParams.URI,
			"version":     diagParams.Version,
			"diagnostics": diagParams.Diagnostics,
		})
	}
}

// serverRequestHandler returns a ServerRequestHandler bound to a server key.
// It answers workspace/configuration via the configProvider and declines all
// other server-to-client methods (the client then replies -32601).
func (m *Manager) serverRequestHandler(key serverKey) ServerRequestHandler {
	return func(method string, params json.RawMessage) (any, bool, *JSONRPCError) {
		if method != "workspace/configuration" {
			return nil, false, nil
		}
		var cfgParams ConfigurationParams
		if err := json.Unmarshal(params, &cfgParams); err != nil {
			return nil, true, &JSONRPCError{Code: -32602, Message: "invalid workspace/configuration params: " + err.Error()}
		}
		return m.configProvider.Configuration(key.family, key.workspace, cfgParams.Items), true, nil
	}
}

// emitStatus emits an lsp:status event. Must NOT be called while m.mu is held
// (enrichPythonSetup performs filesystem detection for the Python family).
func (m *Manager) emitStatus(family, workspace, state, errMsg string, command ...string) {
	if m.emitter == nil {
		return
	}
	status := ServerStatus{
		Family:    family,
		Workspace: workspace,
		State:     state,
		Error:     errMsg,
	}
	if len(command) > 0 {
		status.Command = command[0]
	}
	if state == "ready" {
		m.mu.Lock()
		key := serverKey{family: family, workspace: workspace}
		if entry, ok := m.servers[key]; ok {
			status.CompletionTriggerCharacters = completionTriggerChars(entry)
		}
		m.mu.Unlock()
	}
	m.enrichPythonSetup(&status)
	m.emitter("lsp:status", status)
}

// enrichPythonSetup populates typed setup-status fields for the Python family
// so the frontend can render an actionable card instead of a raw error string.
// Other families are left untouched.
func (m *Manager) enrichPythonSetup(status *ServerStatus) {
	if status.Family != "python" {
		return
	}

	switch status.State {
	case "error":
		status.ProjectRoot = status.Workspace
		errLower := strings.ToLower(status.Error)
		cmdBase := strings.ToLower(filepath.Base(status.Command))
		if cmdBase != "" && strings.Contains(errLower, cmdBase) && strings.Contains(errLower, "not found") {
			status.SetupState = "missing_server"
			status.DetailCode = "server_not_found"
		} else {
			status.SetupState = "retryable"
			status.DetailCode = "server_start_failed"
			status.Action = "retry"
		}
	case "ready":
		status.ProjectRoot = status.Workspace
		env := pythonEnvFromProvider(m.configProvider, status.Workspace)
		status.InterpreterPath = env.InterpreterPath
		status.ExtraPaths = env.ExtraPaths
		status.PythonVersion = env.PythonVersion
		switch {
		case env.InterpreterPath == "":
			status.ConfigSource = "none"
		case env.Source == "override":
			status.ConfigSource = "override"
		default:
			status.ConfigSource = "detected"
		}
		switch {
		case len(env.Diagnostics) > 0:
			status.SetupState = "misconfigured_env"
			status.DetailCode = "venv_without_interpreter"
			status.Action = "select_interpreter"
		case env.Source == "none" || env.InterpreterPath == "":
			status.SetupState = "missing_interpreter"
			status.DetailCode = "no_interpreter"
			status.Action = "create_venv"
		case env.Confidence == "low":
			status.SetupState = "config_degraded"
			status.DetailCode = "system_fallback"
			status.Action = "select_interpreter"
		default:
			status.SetupState = "ready"
		}
	}
}

// emitError emits an lsp:error event with a user-facing message.
func (m *Manager) emitError(family, workspace, message string) {
	if m.emitter == nil {
		return
	}
	m.emitter("lsp:error", map[string]string{
		"family":    family,
		"workspace": workspace,
		"message":   message,
	})
}

// completionTriggerChars extracts trigger characters from a server's completion capabilities.
func completionTriggerChars(entry *serverEntry) []string {
	raw := entry.client.ServerCapabilities().CompletionProvider
	if len(raw) == 0 {
		return nil
	}
	var opts CompletionProviderOptions
	if err := json.Unmarshal(raw, &opts); err != nil {
		return nil
	}
	return opts.TriggerCharacters
}

func documentSymbolSupported(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var enabled bool
	if err := json.Unmarshal(raw, &enabled); err == nil {
		return enabled
	}
	return true
}
