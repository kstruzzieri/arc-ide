package main

import (
	"context"
	"errors"
	"firn/internal/ai"
	"firn/internal/appstate"
	"firn/internal/filesystem"
	"firn/internal/git"
	"firn/internal/lsp"
	"firn/internal/lsp/provision"
	"firn/internal/runhistory"
	"firn/internal/runprofile"
	"firn/internal/search"
	"firn/internal/terminal"
	"firn/internal/watcher"
	"firn/internal/workspace"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	stdruntime "runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// App represents the main application structure for Firn IDE.
// It holds the application context for Wails runtime interactions.
type App struct {
	ctx                  context.Context
	dirReader            *filesystem.DirectoryReader
	fileReader           *filesystem.FileReader
	fileWriter           *filesystem.FileWriter
	fileWatcher          watcher.Watcher
	termManager          *terminal.Manager
	profileMu            sync.RWMutex
	profileManager       *runprofile.ProjectRunProfileManager
	profileWorkspaceRoot string
	loadRunProfilesFn    func(*runprofile.ProjectRunProfileManager) error
	// emitFn lets tests observe emitted events. nil in production → the v3 event bus.
	emitFn func(event string, data any)
	// quitFn lets tests observe the drain's final quit, which cannot run
	// outside a live Wails application. nil in production → v3app.Quit.
	quitFn func()
	// v3app and mainWindow are the v3 host handles, set in main() before Run.
	// Both are nil in tests, so every use of them is nil-guarded.
	v3app *application.App
	// mainWindow is stored as the runtime interface, not the concrete window,
	// so #271's caller verification can be exercised against a fake handle.
	mainWindow      application.Window
	executor        *runprofile.Executor
	osFS            filesystem.FileSystem
	workspaceStore  *workspace.Store
	runHistoryStore *runhistory.Store
	appStateStore   *appstate.Store
	lspManager      *lsp.Manager
	searchManager   *search.Manager
	gitService      *git.Service
	gitMsgGen       *git.MessageGenerator
	aiService       *ai.Service
	// firnDir is the ~/.firn state root, or "" when no home/config directory
	// is available. An empty firnDir must never become a relative path: state
	// that needs it is simply unavailable.
	firnDir string
	closeMu sync.Mutex
	// closePhase is the spec §5.5 close machine. Guarded by closeMu.
	closePhase closeState
	// closeBackstopTimer forces the drain when the frontend never answers.
	// Guarded by closeMu; nil outside awaiting_frontend.
	closeBackstopTimer *time.Timer
	// closeBackstopOverride shortens the backstop for tests. Zero = production.
	closeBackstopOverride time.Duration
	runShutdown           bool
	// activeHistoryWorkspace and activeHistoryEpoch mirror the successfully
	// loaded profile workspace for shutdown capture. Guarded by closeMu.
	activeHistoryWorkspace string
	activeHistoryEpoch     uint64
	// shutdownHistoryWorkspace and shutdownHistoryEpoch identify the workspace
	// as it stood immediately before the shutdown drain advanced it. Guarded by
	// closeMu.
	shutdownHistoryWorkspace string
	shutdownHistoryEpoch     uint64

	// #271 Golem satellite window. golemWinMu guards golemWin alone; no native
	// call, no disk write and no callback into the App may run while it is
	// held, and quitPermitted() (closeMu) is always read before it.
	golemWinMu sync.Mutex
	golemWin   golemWindowRuntime
	// golemSaveMu serializes app.json writes; golemSavedGen drops a write that
	// carries an older generation than one already applied.
	golemSaveMu   sync.Mutex
	golemSavedGen uint64
	// Last reported save failure, cleared on success; guarded by golemSaveMu.
	golemSaveError string
	// Native seams, installed once in main() before Run. Tests inject them
	// directly; they are never mutated from a concurrent bound call.
	golemWindowFactory func(application.WebviewWindowOptions) application.Window
	screenBounds       func() []application.Rect
	golemWindowPresent func(uint) bool
	// golemAfterFunc is the test seam for the bounded transition timers. A nil
	// value means the production clock.
	golemAfterFunc func(time.Duration, func()) golemTimer
}

// closeState is the spec §5.5 app-close state machine. The first OS close
// enters awaiting_frontend and changes nothing else; only the frontend's
// answer (or one of the amendment-11 escape hatches) enters draining, which is
// the single state where teardown, the two-second deadline, and Quit happen.
//
// closePermitted is the v3 terminal state. v2 answered "prevent this close?"
// and let the drain's own Quit past by allowing the close while draining; v3
// asks the inverse question on ShouldQuit and routes the drain's Quit back
// through the same callback, so the drain has to record that it finished
// before it asks the platform to quit — otherwise its own request is refused
// and the app never exits.
type closeState int

const (
	closeIdle closeState = iota
	closeAwaitingFrontend
	closeDraining
	closePermitted
)

// closeHandshakeBackstop bounds awaiting_frontend for a renderer that never
// answers. It is deliberately long: the handshake can be sitting on a modal
// dirty-draft prompt, and a short timer would force-quit over the user's
// unanswered question. The escape hatch for an impatient user is their second
// close request, not a stopwatch.
const closeHandshakeBackstop = 60 * time.Second

// closeLogPrefix starts every host-side close-machine log line, so the
// fallbacks below are greppable and the tests can observe the production value.
const closeLogPrefix = "app: close "

// NewApp creates and returns a new App instance.
func NewApp() *App {
	osFS := filesystem.NewOS()

	// Create file watcher with default config
	watcherConfig := watcher.WatcherConfig{
		DebounceMs: 100,
	}
	fw, _ := watcher.NewFSNotifyWatcher(watcherConfig)

	firnDir := ""
	workspaceBaseDir := ""
	if homeDir, err := os.UserHomeDir(); err == nil && homeDir != "" {
		firnDir = filepath.Join(homeDir, ".firn")
		workspaceBaseDir = filepath.Join(firnDir, "workspaces")
	}

	return &App{
		dirReader:       filesystem.NewDirectoryReader(osFS),
		fileReader:      filesystem.NewFileReader(osFS),
		fileWriter:      filesystem.NewFileWriter(osFS),
		fileWatcher:     fw,
		termManager:     terminal.NewManager(),
		osFS:            osFS,
		firnDir:         firnDir,
		workspaceStore:  workspace.NewStore(osFS, workspaceBaseDir),
		runHistoryStore: runhistory.NewStore(osFS, firnDir),
		appStateStore:   appstate.NewStore(osFS, firnDir),
		searchManager:   search.NewManager(),
		gitService:      git.NewService(),
		gitMsgGen:       git.NewMessageGenerator(),
	}
}

// ServiceStartup is the v3 service lifecycle hook Wails calls before the window
// serves the frontend — the same ordering v2's OnStartup had. It exists only to
// adapt that signature onto startup.
func (a *App) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	a.startup(ctx)
	return nil
}

// startup is called by Wails when the application starts, through
// ServiceStartup. It stores the context the services it wires below hang off.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.executor = runprofile.NewExecutor(
		a.emit,
		func(id runprofile.RunIdentity, stream, data string, timestamp int64) {
			a.emit("run:output", runprofile.OutputChunk{
				RunIdentity: id,
				Stream:      stream,
				Data:        data,
				Timestamp:   timestamp,
			})
		},
	)
	a.lspManager = lsp.NewManager(a.emit)
	a.wireLSPProvisioners()

	// Golem chat. Without a ~/.firn root there is no consent path at all: an
	// empty path makes ai.ConsentStore fail closed instead of writing a
	// relative .firn, so Local chat keeps working while Remote stays degraded
	// and cannot grant consent.
	consentPath := ""
	if a.firnDir == "" {
		// ai.ConsentStore returns before its own log line on an empty path, so
		// this is the only host-side record of the degradation.
		log.Printf(golemLogPrefix + "consent unavailable: no home directory")
	} else {
		consentPath = filepath.Join(a.firnDir, "golem-consent.json")
	}
	a.aiService = ai.NewService(ctx, a.osFS, consentPath, a.emit)
	a.gitMsgGen.SetDestinationPolicySource(a.aiService.DestinationPolicy)
}

// wireLSPProvisioners builds and registers the managed-server provisioners on
// the LSP manager. When the home directory is unavailable, provisioners are skipped
// gracefully — managed installs simply won't be offered, while interpreter/env
// wiring still works.
func (a *App) wireLSPProvisioners() {
	if a.lspManager == nil {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return
	}
	cacheRoot := filepath.Join(home, ".firn", "servers")
	pyProv := provision.NewPythonProvisioner(cacheRoot, stdruntime.GOOS, stdruntime.GOARCH, provision.PythonDeps{
		LookPath: exec.LookPath,
		RunUV: func(ctx context.Context, uv string, args, env []string) error {
			cmd := exec.CommandContext(ctx, uv, args...)
			cmd.Env = env
			return cmd.Run()
		},
		// Fetch nil -> defaultFetch (real download+verify+unzip).
	})
	goProv := provision.NewGoProvisioner(cacheRoot, stdruntime.GOOS, stdruntime.GOARCH, provision.GoDeps{
		LookPath: exec.LookPath,
		RunGo: func(ctx context.Context, goBin string, args, env []string) error {
			cmd := exec.CommandContext(ctx, goBin, args...)
			cmd.Env = env
			return cmd.Run()
		},
	})
	rustProv := provision.NewRustProvisioner(cacheRoot, stdruntime.GOOS, stdruntime.GOARCH, provision.RustDeps{
		// Fetch nil -> defaultRustFetch (real download+verify+gunzip/unzip).
	})
	tsProv := provision.NewTypeScriptProvisioner(cacheRoot, stdruntime.GOOS, stdruntime.GOARCH, provision.TypeScriptDeps{
		// Fetch nil -> defaultTypeScriptFetch (real download+verify+untar/unzip).
	})
	a.lspManager.SetProvisioners(map[string]provision.Provisioner{
		"python":     pyProv,
		"go":         goProv,
		"rust":       rustProv,
		"typescript": tsProv,
	})
}

// shouldQuit is the v3 Options.ShouldQuit callback: it answers every quit
// request — Cmd+Q, the application menu, and the main window's close button via
// handleMainWindowClosing — and it is the OS edge of the §5.5 machine:
//
//   - idle: enter awaiting_frontend, emit one app:beforeclose, arm the
//     backstop, and refuse the quit. No teardown, no deadline — the frontend
//     may still finish a settings write, resolve an unsaved draft, or cancel.
//   - awaiting_frontend: a second request is the user asking again
//     (amendment 11), so it forces the drain. It emits no second event.
//   - draining: refuse; the teardown is still running and only the drain's own
//     permitted quit may end the app.
//   - permitted: allow, so the quit the finished drain requested goes through.
func (a *App) shouldQuit() bool {
	a.closeMu.Lock()
	switch a.closePhase {
	case closePermitted:
		a.closeMu.Unlock()
		return true
	case closeDraining:
		a.closeMu.Unlock()
		return false
	case closeAwaitingFrontend:
		a.closeMu.Unlock()
		a.enterCloseDrain("second close request")
		return false
	default:
		a.closePhase = closeAwaitingFrontend
		a.closeBackstopTimer = time.AfterFunc(a.backstopDelay(), func() {
			a.enterCloseDrain("frontend never answered")
		})
		a.closeMu.Unlock()
		a.emit("app:beforeclose", nil)
		return false
	}
}

// quitPermitted reports whether the drain has finished and its quit may pass.
func (a *App) quitPermitted() bool {
	a.closeMu.Lock()
	defer a.closeMu.Unlock()
	return a.closePhase == closePermitted
}

// handleMainWindowClosing routes the main window's close button into the same
// machine rather than letting the window close on its own: closing the only
// window would tear the UI down while the drain is still running. It cancels
// the close and asks the machine, which emits the handshake event on the first
// press and forces the drain on the second. Once permitted, the window is
// closing because the app is quitting, so there is nothing to cancel.
// #271 secondary windows own their own close behaviour; only this hook is
// wired to the main window.
func (a *App) handleMainWindowClosing(cancel func()) {
	if a.quitPermitted() {
		return
	}
	cancel()
	_ = a.shouldQuit()
}

// backstopDelay is the production backstop unless a test shortened it.
func (a *App) backstopDelay() time.Duration {
	if a.closeBackstopOverride > 0 {
		return a.closeBackstopOverride
	}
	return closeHandshakeBackstop
}

// ConfirmBeforeCloseReady signals that the frontend finished its close
// preparation — settings writes settled, secrets cleared, state flushed — and
// the app may tear down. It is the only ordinary way into draining, it starts
// the teardown exactly once, and it is a no-op when no close is pending.
// This is exposed to the frontend via Wails bindings.
func (a *App) ConfirmBeforeCloseReady() {
	// No reason: this is the handshake completing normally, not a fallback.
	a.enterCloseDrain("")
}

// CancelBeforeClose abandons a pending close and returns the machine to idle.
// Nothing has been torn down at this point, so there is nothing to restore:
// run admission, searches, the Golem service, and the language servers were
// never touched. Idempotent, and a no-op once draining has begun.
// This is exposed to the frontend via Wails bindings.
func (a *App) CancelBeforeClose() {
	a.closeMu.Lock()
	defer a.closeMu.Unlock()
	if a.closePhase != closeAwaitingFrontend {
		return
	}
	a.closePhase = closeIdle
	a.stopCloseBackstopLocked()
}

// enterCloseDrain moves awaiting_frontend → draining exactly once and starts
// the teardown. It reports whether this call is the one that started it, which
// is what makes confirm/second-close/backstop races harmless.
//
// A non-empty reason is one of the amendment-11 fallbacks, host-logged before
// the teardown begins — both so the record survives a crash mid-drain, and so
// only the call that actually forced the transition writes a line.
func (a *App) enterCloseDrain(reason string) bool {
	a.closeMu.Lock()
	if a.closePhase != closeAwaitingFrontend {
		a.closeMu.Unlock()
		return false
	}
	a.closePhase = closeDraining
	a.stopCloseBackstopLocked()
	a.closeMu.Unlock()
	if reason != "" {
		log.Printf(closeLogPrefix+"draining without the frontend handshake: %s", reason)
	}
	a.startCloseDrain()
	return true
}

// stopCloseBackstopLocked disarms the backstop. The caller holds closeMu.
func (a *App) stopCloseBackstopLocked() {
	if a.closeBackstopTimer != nil {
		a.closeBackstopTimer.Stop()
		a.closeBackstopTimer = nil
	}
}

// startCloseDrain runs the shutdown fan-out and quits. Runner cleanup, LSP
// shutdown, and the Golem service close run concurrently, bounded by a
// two-second outer deadline; the frontend has already flushed by the time the
// machine reaches this state.
func (a *App) startCloseDrain() {
	a.beginRunShutdown()

	// Cancel any in-flight workspace searches before the runner/LSP shutdown
	// goroutines run. CancelAll is synchronous (it only signals contexts; the
	// rg processes wind down via exec.CommandContext), so it does not need its
	// own deadline like the runner/LSP paths do.
	if a.searchManager != nil {
		a.searchManager.CancelAll()
	}

	go func() {
		runnerDone := make(chan struct{})
		go func() {
			if a.executor != nil {
				_ = a.executor.StopAllWithReason(1500*time.Millisecond, "shutdown")
			}
			close(runnerDone)
		}()

		lspDone := make(chan struct{})
		go func() {
			if a.lspManager != nil {
				a.lspManager.ShutdownAll(1500 * time.Millisecond)
			}
			close(lspDone)
		}()

		aiDone := make(chan struct{})
		go func() {
			a.closeAIService()
			close(aiDone)
		}()

		deadline := time.After(2 * time.Second)
		runnerDoneCh := runnerDone
		lspDoneCh := lspDone
		aiDoneCh := aiDone

		for runnerDoneCh != nil || lspDoneCh != nil || aiDoneCh != nil {
			select {
			case <-runnerDoneCh:
				runnerDoneCh = nil
			case <-lspDoneCh:
				lspDoneCh = nil
			case <-aiDoneCh:
				aiDoneCh = nil
			case <-deadline:
				a.permitAndQuit()
				return
			}
		}

		a.permitAndQuit()
	}()
}

// permitAndQuit ends the drain: it records that the teardown is done and only
// then asks the platform to quit. The order matters — the platform answers by
// calling shouldQuit, which refuses anything that is not already permitted.
func (a *App) permitAndQuit() {
	a.closeMu.Lock()
	a.closePhase = closePermitted
	a.closeMu.Unlock()
	// The Golem window's frame is saved here, on the drain goroutine, because
	// the platform's own shutdown never reaches that window's closing hook
	// (see handleGolemWindowClosing). closeMu is released first: the save reads
	// quitPermitted() itself and takes golemWinMu after it.
	a.saveGolemFrameForShutdown()
	a.quit()
}

// quit asks the v3 application to quit, or routes to quitFn when set (tests).
func (a *App) quit() {
	if a.quitFn != nil {
		a.quitFn()
		return
	}
	// Same nil-host window as emit: a quit that lands before startup has no
	// platform to ask, so record it rather than letting the drain look like
	// it succeeded.
	if a.v3app == nil {
		log.Printf("firn: quit requested before the application host was initialised; nothing to quit")
		return
	}
	a.v3app.Quit()
}

// closeAIService shuts the Golem service down inside the close drain's budget.
// It is idempotent and a no-op before startup, so a second close (or a close
// that races the shutdown drain) costs nothing.
func (a *App) closeAIService() {
	if a.aiService == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	// Close returns the raw ctx.Err() on deadline and an already-sanitized
	// public error for runner-close failures. Nothing is returned to the UI
	// during shutdown; golemError is here only to host-log the raw cause.
	if err := a.aiService.Close(ctx); err != nil {
		_ = a.golemError(err)
	}
}

// beginRunShutdown closes run admission for shutdown. BeginDrainWithReason
// advances the workspace epoch, so the epoch in flight when the close began is
// captured first: the frontend's best-effort drain runs after this and still
// carries records stamped with it. The path and epoch are captured together so
// a later compatible workspace load cannot redirect those records.
func (a *App) beginRunShutdown() {
	a.closeMu.Lock()
	defer a.closeMu.Unlock()
	a.runShutdown = true
	a.shutdownHistoryWorkspace = a.activeHistoryWorkspace
	a.shutdownHistoryEpoch = a.activeHistoryEpoch
	if a.executor != nil {
		a.executor.BeginDrainWithReason("shutdown")
	}
}

// shutdownHistoryWorkspaceFor reports the workspace paired with the epoch that
// beginRunShutdown superseded. Only that immutable pair remains writable.
func (a *App) shutdownHistoryWorkspaceFor(epoch uint64) (string, bool) {
	a.closeMu.Lock()
	defer a.closeMu.Unlock()
	return a.shutdownHistoryWorkspace, a.runShutdown &&
		a.shutdownHistoryWorkspace != "" &&
		a.shutdownHistoryEpoch != 0 &&
		epoch == a.shutdownHistoryEpoch
}

// WorkspaceInfo identifies the repository the Golem chat is bound to. Path is
// the canonical root the backend authorized, never the caller's input, and all
// four fields are zero when nothing is bound.
type WorkspaceInfo struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	RepoKey   string `json:"repoKey"`
	RepoEpoch uint64 `json:"repoEpoch"`
}

// errGolemUnavailable marks calls that arrive before startup created the
// service. It is deliberately not an ai sentinel: it projects to the catch-all.
var errGolemUnavailable = errors.New("golem service is not initialized")

// golemLogPrefix starts every host-side Golem log line App writes, as distinct
// from internal/ai's own "ai: golem ..." lines. Named so the contract is
// greppable and the test can observe the production value instead of
// duplicating it.
const golemLogPrefix = "app: golem "

// golemError host-logs the raw Golem cause and returns only its fixed public
// projection, so no repository root, config or consent path, or credential
// text can cross the Wails boundary.
//
// ai.Service errors arrive already projected. Re-projecting one would collapse
// its selected message onto the generic catch-all — ai.PublicError carries no
// sentinel to match — so an already-public error is passed through as it
// stands and only unprojected causes are sanitized here.
func (a *App) golemError(err error) error {
	if err == nil {
		return nil
	}
	// errors.As, not a type assertion: the projection survives wrapping.
	var public ai.PublicError
	if !errors.As(err, &public) {
		public = ai.SanitizeError(err)
	}
	// The standard logger, as internal/ai already uses for host-only Golem
	// diagnostics and as every host-side log line does since the v3 migration:
	// the v3 application logger lives on the app handle, which is nil until
	// main() builds it, so it cannot record the calls that land before startup —
	// exactly the ones worth recording.
	log.Printf(golemLogPrefix+"%s: %v", public.Code, err)
	return public
}

// GetWorkspaceInfo binds repoPath as the current Golem repository and returns
// its canonical root plus repository identity. An empty repoPath unbinds and
// returns empty values. Rebinding the same root keeps the epoch; unbinding and
// binding again advances it, which invalidates every request built on the old
// one. This is exposed to the frontend via Wails bindings.
func (a *App) GetWorkspaceInfo(repoPath string) (WorkspaceInfo, error) {
	if a.aiService == nil {
		return WorkspaceInfo{}, a.golemError(errGolemUnavailable)
	}
	if repoPath == "" {
		a.aiService.UnbindRepository()
		return WorkspaceInfo{}, nil
	}
	// The service canonicalizes and returns the root it authorized, so the
	// root reported back is that value itself rather than a recomputation of
	// it. A failed bind leaves the previous binding untouched.
	identity, root, err := a.aiService.BindRepository(repoPath)
	if err != nil {
		return WorkspaceInfo{}, a.golemError(err)
	}
	return WorkspaceInfo{
		Name:      filepath.Base(root),
		Path:      root,
		RepoKey:   identity.RepoKey,
		RepoEpoch: identity.RepoEpoch,
	}, nil
}

// GetGolemStatus returns the Golem status for one workspace of the bound
// repository. Request and response cross the boundary unchanged and neither
// carries a filesystem path.
// This is exposed to the frontend via Wails bindings.
func (a *App) GetGolemStatus(req ai.StatusRequest) (ai.Status, error) {
	if a.aiService == nil {
		return ai.Status{}, a.golemError(errGolemUnavailable)
	}
	status, err := a.aiService.Status(req)
	if err != nil {
		return ai.Status{}, a.golemError(err)
	}
	return status, nil
}

// RunGolemTurn submits one chat turn for admission. It returns as soon as the
// turn is accepted or a consent decision is needed; run output arrives on the
// golem:event and golem:run-status events.
// This is exposed to the frontend via Wails bindings.
func (a *App) RunGolemTurn(req ai.TurnRequest) (ai.TurnAdmission, error) {
	if a.aiService == nil {
		return ai.TurnAdmission{}, a.golemError(errGolemUnavailable)
	}
	admission, err := a.aiService.StartTurn(a.ctx, req)
	if err != nil {
		return ai.TurnAdmission{}, a.golemError(err)
	}
	return admission, nil
}

// CancelGolemRun cancels the run named by identity, or declines its pending
// consent challenge. It reports whether anything matched.
// This is exposed to the frontend via Wails bindings.
func (a *App) CancelGolemRun(identity ai.RunIdentity) (bool, error) {
	if a.aiService == nil {
		return false, a.golemError(errGolemUnavailable)
	}
	canceled, err := a.aiService.Cancel(identity)
	if err != nil {
		return false, a.golemError(err)
	}
	return canceled, nil
}

// GetGolemSettings returns the read-only settings projection of the current
// effective Golem configuration. It carries no filesystem paths, raw JSON,
// keys, or raw error text; diagnostics travel in-band as allowlisted codes.
// This is exposed to the frontend via Wails bindings.
func (a *App) GetGolemSettings() (ai.SettingsProjection, error) {
	if a.aiService == nil {
		return ai.SettingsProjection{}, a.golemError(errGolemUnavailable)
	}
	projection, err := a.aiService.Settings()
	if err != nil {
		return ai.SettingsProjection{}, a.golemError(err)
	}
	return projection, nil
}

// ReloadGolemSettings rebuilds the effective configuration snapshot under the
// idle barrier. Busy=true reports a rejected reload with the unchanged
// current projection.
// This is exposed to the frontend via Wails bindings.
func (a *App) ReloadGolemSettings() (ai.SettingsReloadResult, error) {
	if a.aiService == nil {
		return ai.SettingsReloadResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.ReloadSettings()
	if err != nil {
		return ai.SettingsReloadResult{}, a.golemError(err)
	}
	return result, nil
}

// ApplyGolemSettings is Call 1 of the §5.2 write handshake against the existing
// configuration target. The request carries the staged changes and, for
// provider-key operations, the literal key values; those are applied and
// dropped, and never appear in the result, an event, or a log line. Every
// outcome — including a refusal — is a closed §5.6 domain result; only a
// missing service is an error.
// This is exposed to the frontend via Wails bindings.
func (a *App) ApplyGolemSettings(req ai.SettingsApplyRequest) (ai.SettingsApplyResult, error) {
	if a.aiService == nil {
		return ai.SettingsApplyResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.ApplySettings(req)
	if err != nil {
		return ai.SettingsApplyResult{}, a.golemError(err)
	}
	return result, nil
}

// CreateGolemSettings is Call 1 for a missing target: the backend derives the
// destination itself, so no path crosses the boundary in either direction.
// This is exposed to the frontend via Wails bindings.
func (a *App) CreateGolemSettings(req ai.SettingsApplyRequest) (ai.SettingsApplyResult, error) {
	if a.aiService == nil {
		return ai.SettingsApplyResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.CreateSettings(req)
	if err != nil {
		return ai.SettingsApplyResult{}, a.golemError(err)
	}
	return result, nil
}

// ConfirmGolemSettingsApply is Call 2: the frontend resends the complete
// request alongside the opaque challenge token, because Call 1 retained none of
// it. One binding serves both entry points — the operation kind comes from the
// challenge record, not from the caller.
// This is exposed to the frontend via Wails bindings.
func (a *App) ConfirmGolemSettingsApply(req ai.ConfirmSettingsApplyRequest) (ai.SettingsApplyResult, error) {
	if a.aiService == nil {
		return ai.SettingsApplyResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.ConfirmSettingsApply(req)
	if err != nil {
		return ai.SettingsApplyResult{}, a.golemError(err)
	}
	return result, nil
}

// CancelGolemSettingsApply invalidates one issued challenge. It is idempotent:
// an absent, expired, or already consumed token is already cancelled, so the
// single success variant is the only domain outcome.
// This is exposed to the frontend via Wails bindings.
func (a *App) CancelGolemSettingsApply(challengeToken string) (ai.CancelSettingsApplyResult, error) {
	if a.aiService == nil {
		return ai.CancelSettingsApplyResult{}, a.golemError(errGolemUnavailable)
	}
	return a.aiService.CancelSettingsApply(challengeToken), nil
}

// PrepareGolemDestinationGrants is Call 1 of the grant-only approval
// handshake: it lists every remote destination the ACTIVE configuration's agent
// route reaches that the user has not already approved. It takes no argument —
// there is nothing to stage — and writes nothing. Every outcome is a closed
// domain result; only a missing service is an error.
// This is exposed to the frontend via Wails bindings.
func (a *App) PrepareGolemDestinationGrants() (ai.DestinationGrantsResult, error) {
	if a.aiService == nil {
		return ai.DestinationGrantsResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.PrepareDestinationGrants()
	if err != nil {
		return ai.DestinationGrantsResult{}, a.golemError(err)
	}
	return result, nil
}

// ConfirmGolemDestinationGrants is Call 2: the opaque challenge token is the
// whole request, because Call 1 staged nothing to resend. It records the
// approved batch and writes no configuration. Cancelling instead is
// CancelGolemSettingsApply — the challenge map is mode-blind, so the approve
// flow needs no cancel binding of its own.
// This is exposed to the frontend via Wails bindings.
func (a *App) ConfirmGolemDestinationGrants(challengeToken string) (ai.DestinationGrantsResult, error) {
	if a.aiService == nil {
		return ai.DestinationGrantsResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.ConfirmDestinationGrants(challengeToken)
	if err != nil {
		return ai.DestinationGrantsResult{}, a.golemError(err)
	}
	return result, nil
}

// LoadGolemProfile returns one profile's credential-free draft preview plus the
// provenance a profile-origin Apply must send back. The loader clears every
// provider key before anything reads the document, so no profile secret can
// reach this result. The service guard is the same one the other Golem
// bindings use: a profile draft is useless without a service to apply it to,
// and a.ctx exists exactly when that service does.
// This is exposed to the frontend via Wails bindings.
func (a *App) LoadGolemProfile(profileID string) (ai.GolemProfileLoadResult, error) {
	if a.aiService == nil {
		return ai.GolemProfileLoadResult{}, a.golemError(errGolemUnavailable)
	}
	return ai.LoadGolemProfile(a.ctx, profileID), nil
}

// ListGolemProfiles returns the closed §5.6 profile list projection: the
// curated catalog block followed by the user block, bounded and in stable ID
// order. Paths never cross Wails, and user rows carry id only until Load.
// Every outcome is a closed domain result; only a missing service is an error.
// This is exposed to the frontend via Wails bindings.
func (a *App) ListGolemProfiles() (ai.GolemProfileListResult, error) {
	if a.aiService == nil {
		return ai.GolemProfileListResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.ListGolemProfiles()
	if err != nil {
		return ai.GolemProfileListResult{}, a.golemError(err)
	}
	return result, nil
}

// SaveGolemProfileAs duplicates the applied configuration into the user
// profile store as a credential-scrubbed named profile (§5.3). Absent
// expectedRevision is create-only; present is compare-and-replace against the
// stored profile's revision. It never touches the staged draft, the active
// publication, or the run barrier. Every outcome is a closed §5.6 domain
// result; only a missing service is an error.
// This is exposed to the frontend via Wails bindings.
func (a *App) SaveGolemProfileAs(req ai.SaveGolemProfileAsRequest) (ai.GolemProfileSaveResult, error) {
	if a.aiService == nil {
		return ai.GolemProfileSaveResult{}, a.golemError(errGolemUnavailable)
	}
	result, err := a.aiService.SaveGolemProfileAs(req)
	if err != nil {
		return ai.GolemProfileSaveResult{}, a.golemError(err)
	}
	return result, nil
}

// ReadDirectory reads a directory and returns its contents as a tree structure.
// This is exposed to the frontend via Wails bindings.
func (a *App) ReadDirectory(path string) ([]filesystem.FileEntry, error) {
	return a.dirReader.ReadDirectory(path)
}

// ReadDirectoryShallow reads a single directory level (immediate children only).
// Used for lazy tree loading — child directories are returned without their
// own children populated.
func (a *App) ReadDirectoryShallow(path string, rootPath string) ([]filesystem.FileEntry, error) {
	return a.dirReader.ReadDirectoryShallow(path, rootPath)
}

// ReadFile reads a file and returns its contents with metadata.
// Detects encoding (UTF-8, UTF-16, Latin-1) and line endings.
// This is exposed to the frontend via Wails bindings.
func (a *App) ReadFile(path string) (*filesystem.FileContent, error) {
	return a.fileReader.ReadFileWithMetadata(path)
}

// WriteFile writes content to a file with optional encoding and line ending settings.
// This is exposed to the frontend via Wails bindings.
func (a *App) WriteFile(path string, content string, encoding string, lineEndings string, createBackup bool) error {
	opts := &filesystem.WriteOptions{
		Encoding:     encoding,
		LineEndings:  lineEndings,
		CreateBackup: createBackup,
		CreateDirs:   true,
	}
	return a.fileWriter.WriteFileWithOptions(path, content, opts)
}

// StartWatching starts watching the given path for file changes.
// Events are emitted to the frontend via "file:changed" event.
// This is exposed to the frontend via Wails bindings.
func (a *App) StartWatching(path string) error {
	return a.fileWatcher.Watch(a.ctx, path, a.handleWatchEvent)
}

// handleWatchEvent fans one debounced filesystem change out to the frontend,
// the Golem scope policy, and run-profile re-detection.
func (a *App) handleWatchEvent(event watcher.FileEvent) {
	a.emit("file:changed", event)

	// Golem scope manifests reload in place. The notice is payload-free so no
	// policy path crosses the boundary, and it is emitted only for a manifest
	// the current binding actually watches.
	if a.aiService != nil && a.aiService.ReloadPolicy(event.Path) {
		a.emit(ai.EventGolemStatusChanged, nil)
	}

	// Reactive run profile re-detection on config file changes
	a.profileMu.RLock()
	if a.profileManager == nil {
		a.profileMu.RUnlock()
		return
	}

	changed := a.profileManager.HandleFileChange(event.Path)
	var snap runprofile.RunProfilesSnapshot
	if changed {
		snap = a.runProfilesSnapshot(a.profileManager)
	}
	a.profileMu.RUnlock()

	if changed {
		a.emit("runprofiles:changed", snap)
	}
}

// StopWatching stops watching for file changes.
// This is exposed to the frontend via Wails bindings.
func (a *App) StopWatching() error {
	return a.fileWatcher.Stop()
}

// IsWatching returns true if currently watching a path.
// This is exposed to the frontend via Wails bindings.
func (a *App) IsWatching() bool {
	return a.fileWatcher.IsWatching()
}

// GetWatchedPath returns the currently watched path.
// This is exposed to the frontend via Wails bindings.
func (a *App) GetWatchedPath() string {
	return a.fileWatcher.WatchedPath()
}

// OpenFolderDialog opens a native folder picker dialog.
// Returns the selected folder path, or empty string if cancelled.
// This is exposed to the frontend via Wails bindings.
func (a *App) OpenFolderDialog() (string, error) {
	// A cancelled dialog also returns an empty path, so a missing host must
	// surface as an error rather than as a silent, indistinguishable cancel.
	if a.v3app == nil {
		return "", errors.New("folder dialog unavailable: application host not initialised")
	}
	return a.v3app.Dialog.OpenFile().
		// macOS ignores open-panel titles; the call still applies elsewhere.
		SetTitle("Open Folder").
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
}

// ToggleMaximize toggles the window between maximized and restored states.
// This is exposed to the frontend via Wails bindings.
func (a *App) ToggleMaximize() {
	if a.mainWindow != nil {
		a.mainWindow.ToggleMaximise()
	}
}

// TerminalOutputEvent is the single payload for "terminal:output". The v2
// two-argument emit (id, data) was retired in #273 Task 0 so every event
// carries at most one payload (the v3 event bridge relies on this).
type TerminalOutputEvent struct {
	TermID string `json:"termId"`
	Data   string `json:"data"`
}

func (a *App) emitTerminalOutput(id, data string) {
	a.emit("terminal:output", TerminalOutputEvent{TermID: id, Data: data})
}

// CreateTerminal creates a new terminal whose shell starts in dir — the loaded
// workspace root — instead of the app process's own working directory. An
// empty or missing dir inherits the process default.
// This is exposed to the frontend via Wails bindings.
func (a *App) CreateTerminal(dir string) (string, error) {
	id, err := a.termManager.Create(dir)
	if err != nil {
		log.Printf("CreateTerminal failed: %v", err)
		return "", err
	}

	// Re-lookup can race a concurrent CloseTerminal; a vanished session just
	// means there is no output to stream — never a nil-deref in the goroutine.
	if session, ok := a.termManager.Get(id); ok {
		go session.ReadLoop(func(data string) {
			a.emitTerminalOutput(id, data)
		})
	}

	return id, nil
}

// WriteTerminal passes strings from JS
// This is exposed to the frontend via Wails bindings.
func (a *App) WriteTerminal(id string, data string) error {
	return a.termManager.Write(id, []byte(data))
}

// ResizeTerminal passes the new dimensions of the terminal window
// This is exposed to the frontend via Wails bindings.
func (a *App) ResizeTerminal(id string, rows uint16, cols uint16) error {
	return a.termManager.Resize(id, rows, cols)
}

// CloseTerminal terminates the terminal session and removes it from the manager.
// This is exposed to the frontend via Wails bindings.
func (a *App) CloseTerminal(id string) error {
	return a.termManager.Close(id)
}

// LoadRunProfiles initializes or reinitializes the run profile manager for the given workspace path.
// If switching workspaces while profiles are running, stops all running profiles first.
// This is exposed to the frontend via Wails bindings.
func (a *App) LoadRunProfiles(workspacePath string) error {
	// Always sync LSP workspace root, even if profile loading fails.
	// The user has switched workspaces — LSP must follow regardless.
	if a.lspManager != nil {
		a.SetLSPWorkspaceRoot(workspacePath)
	}

	return a.loadRunProfilesLocked(workspacePath)
}

// loadRunProfilesLocked performs the profile loading under profileMu.
func (a *App) loadRunProfilesLocked(workspacePath string) error {
	a.profileMu.Lock()
	defer a.profileMu.Unlock()

	switchingWorkspace := a.profileManager == nil || a.profileWorkspaceRoot != workspacePath
	var epoch uint64
	if a.executor != nil {
		if switchingWorkspace {
			// Admission closes before shutdown begins. Advancing the epoch alone is
			// not enough: a launch for the new epoch must not enter mid-drain.
			epoch = a.executor.BeginDrainWithReason("workspace-switch")
		} else {
			epoch = a.executor.CurrentEpoch()
		}
	}

	if switchingWorkspace && a.executor != nil {
		if ok := a.executor.StopAllWithReason(4*time.Second, "workspace-switch"); !ok {
			return fmt.Errorf("failed to stop running profiles before switching workspace")
		}
		a.executor.ClearTerminalStatuses()
	}

	manager := a.profileManager
	if switchingWorkspace {
		manager = runprofile.NewProjectManager(a.osFS, workspacePath)
	}

	load := manager.Load
	if a.loadRunProfilesFn != nil {
		load = func() error { return a.loadRunProfilesFn(manager) }
	}
	if err := load(); err != nil {
		return err
	}

	a.closeMu.Lock()
	if switchingWorkspace {
		a.profileManager = manager
		a.profileWorkspaceRoot = workspacePath
	}
	a.activeHistoryWorkspace = a.profileWorkspaceRoot
	a.activeHistoryEpoch = epoch
	var endDrainErr error
	if a.executor != nil {
		if !a.runShutdown {
			endDrainErr = a.executor.EndDrain(epoch)
		}
	}
	a.closeMu.Unlock()
	if endDrainErr != nil {
		return endDrainErr
	}
	// Surface non-fatal load issues (unreadable workspace store, migration that
	// could not be written back) instead of swallowing them. A degraded load
	// still yields a usable profile list.
	for _, w := range manager.Warnings() {
		log.Printf("run profiles: %s", w)
	}
	return nil
}

// GetAllRunProfiles returns all run profiles (saved + detected, deduplicated).
// This is exposed to the frontend via Wails bindings.
func (a *App) GetAllRunProfiles() []runprofile.RunProfile {
	a.profileMu.RLock()
	defer a.profileMu.RUnlock()

	if a.profileManager == nil {
		return []runprofile.RunProfile{}
	}
	return a.profileManager.GetAllProfiles()
}

// GetRunProfilesSnapshot returns the combined profile list plus per-profile UI
// state (adoption + run recency). This is the P2 hydration contract.
// This is exposed to the frontend via Wails bindings.
func (a *App) GetRunProfilesSnapshot() runprofile.RunProfilesSnapshot {
	a.profileMu.RLock()
	defer a.profileMu.RUnlock()
	if a.profileManager == nil {
		snap := runprofile.RunProfilesSnapshot{Profiles: []runprofile.RunProfile{}, ProfileState: map[string]runprofile.ProfileUIState{}}
		if a.executor != nil {
			snap.WorkspaceEpoch = a.executor.CurrentEpoch()
		}
		return snap
	}
	return a.runProfilesSnapshot(a.profileManager)
}

// AdoptRunProfile adds a profile to its workspace working set and emits an update.
// This is exposed to the frontend via Wails bindings.
func (a *App) AdoptRunProfile(id string) error {
	return a.mutateAndEmitProfiles(func(m *runprofile.ProjectRunProfileManager) error { return m.AdoptProfile(id) })
}

// UnadoptRunProfile removes a profile from its workspace working set and emits an update.
// This is exposed to the frontend via Wails bindings.
func (a *App) UnadoptRunProfile(id string) error {
	return a.mutateAndEmitProfiles(func(m *runprofile.ProjectRunProfileManager) error { return m.UnadoptProfile(id) })
}

// emit sends a Wails event with zero or one payload, or routes to emitFn when set (tests).
// In production, a nil payload means no Wails payload argument.
// Callers must pass an untyped nil for zero-payload events. A typed nil pointer boxed into
// this any parameter (e.g. a nil *Foo) is non-nil once boxed, so it would fail the data == nil
// check below and serialize as a JSON null on the wire instead of omitting the payload
// argument. All current call sites pass struct values, never pointers, into data (verified
// 2026-09-01).
func (a *App) emit(event string, data any) {
	if a.emitFn != nil {
		a.emitFn(event, data)
		return
	}
	// The host is nil before application.New runs (and in tests that build an
	// App directly). Dropping the event is the only option, but say so: a
	// swallowed handshake event is otherwise invisible.
	if a.v3app == nil {
		log.Printf("firn: dropping event %q emitted before the application host was initialised", event)
		return
	}
	if data == nil {
		a.v3app.Event.Emit(event)
		return
	}
	a.v3app.Event.Emit(event, data)
}

func (a *App) runProfilesSnapshot(manager *runprofile.ProjectRunProfileManager) runprofile.RunProfilesSnapshot {
	snap := manager.Snapshot()
	if a.executor != nil {
		snap.WorkspaceEpoch = a.executor.CurrentEpoch()
	}
	return snap
}

// mutateAndEmitProfiles runs a manager mutation under the app read lock, then emits the full snapshot on success. Centralizes the lock/emit dance shared by pin/unpin/variant/adopt/unadopt.
func (a *App) mutateAndEmitProfiles(fn func(*runprofile.ProjectRunProfileManager) error) error {
	a.profileMu.RLock()
	if a.profileManager == nil {
		a.profileMu.RUnlock()
		return fmt.Errorf("no workspace loaded")
	}
	if err := fn(a.profileManager); err != nil {
		a.profileMu.RUnlock()
		return err
	}
	snap := a.runProfilesSnapshot(a.profileManager)
	a.profileMu.RUnlock()
	a.emit("runprofiles:changed", snap)
	return nil
}

// SaveRunProfile validates and saves a run profile, emitting runprofiles:changed
// on a successful, valid save. This is exposed to the frontend via Wails bindings.
func (a *App) SaveRunProfile(profile runprofile.RunProfile) (runprofile.ValidationResult, error) {
	a.profileMu.RLock()
	if a.profileManager == nil {
		a.profileMu.RUnlock()
		return runprofile.ValidationResult{Valid: false, Errors: []runprofile.ValidationError{
			{Field: "workspace", Message: "no workspace loaded"},
		}}, nil
	}
	result, err := a.profileManager.SaveProfile(profile)
	var snap runprofile.RunProfilesSnapshot
	shouldEmit := err == nil && result.Valid
	if shouldEmit {
		snap = a.runProfilesSnapshot(a.profileManager)
	}
	a.profileMu.RUnlock()
	if shouldEmit {
		a.emit("runprofiles:changed", snap)
	}
	return result, err
}

// DeleteRunProfile removes a saved run profile by ID, emitting runprofiles:changed
// on success. This is exposed to the frontend via Wails bindings.
func (a *App) DeleteRunProfile(id string) error {
	a.profileMu.RLock()
	if a.profileManager == nil {
		a.profileMu.RUnlock()
		return fmt.Errorf("no workspace loaded")
	}
	err := a.profileManager.DeleteProfile(id)
	var snap runprofile.RunProfilesSnapshot
	if err == nil {
		snap = a.runProfilesSnapshot(a.profileManager)
	}
	a.profileMu.RUnlock()
	if err == nil {
		a.emit("runprofiles:changed", snap)
	}
	return err
}

// PinRunProfile converts a detected profile to a saved profile and emits an update event.
// This is exposed to the frontend via Wails bindings.
func (a *App) PinRunProfile(id string) error {
	return a.mutateAndEmitProfiles(func(m *runprofile.ProjectRunProfileManager) error { return m.PinProfile(id) })
}

// UnpinRunProfile reverts a saved (pinned) profile back to detected status.
// This is exposed to the frontend via Wails bindings.
func (a *App) UnpinRunProfile(id string) error {
	return a.mutateAndEmitProfiles(func(m *runprofile.ProjectRunProfileManager) error { return m.UnpinProfile(id) })
}

// SetActiveVariant selects the env variant for a run profile and emits the updated profile list.
// This is exposed to the frontend via Wails bindings.
func (a *App) SetActiveVariant(profileID string, variant string) error {
	return a.mutateAndEmitProfiles(func(m *runprofile.ProjectRunProfileManager) error {
		return m.SetActiveVariant(profileID, variant)
	})
}

// ValidateRunProfile validates a run profile without saving it.
// This is exposed to the frontend via Wails bindings.
func (a *App) ValidateRunProfile(profile runprofile.RunProfile) runprofile.ValidationResult {
	a.profileMu.RLock()
	defer a.profileMu.RUnlock()

	// Use the coordinator so the workspace-membership check matches what
	// SaveRunProfile will accept; fall back to the pure validator when no
	// workspace is loaded.
	if a.profileManager == nil {
		return runprofile.Validate(profile)
	}
	return a.profileManager.ValidateProfile(profile)
}

// DetectRunProfiles re-runs auto-detection and returns detected profiles.
// This is exposed to the frontend via Wails bindings.
func (a *App) DetectRunProfiles() []runprofile.RunProfile {
	a.profileMu.RLock()
	defer a.profileMu.RUnlock()

	if a.profileManager == nil {
		return []runprofile.RunProfile{}
	}
	return a.profileManager.ReDetect()
}

// SaveWorkspaceState saves workspace state for session restore.
// This is exposed to the frontend via Wails bindings.
func (a *App) SaveWorkspaceState(state workspace.State) error {
	return a.workspaceStore.Save(state)
}

// LoadWorkspaceState loads saved state for a workspace path.
// Returns nil if no saved state exists (first time opening).
// This is exposed to the frontend via Wails bindings.
func (a *App) LoadWorkspaceState(workspacePath string) (*workspace.State, error) {
	return a.workspaceStore.Load(workspacePath)
}

// ListRecentWorkspaces returns summaries of recently opened workspaces.
// This is exposed to the frontend via Wails bindings.
func (a *App) ListRecentWorkspaces() ([]workspace.Summary, error) {
	return a.workspaceStore.ListRecent(0)
}

// GetRunHistorySnapshot returns the active workspace's persisted run summaries.
func (a *App) GetRunHistorySnapshot() (runhistory.Snapshot, error) {
	workspacePath, err := a.activeRunHistoryWorkspace()
	if err != nil {
		return runhistory.Snapshot{}, err
	}
	return a.runHistoryStore.Snapshot(workspacePath)
}

// AppendRunHistoryRecord persists a terminal run for the active workspace.
func (a *App) AppendRunHistoryRecord(record runhistory.RecordInput) (runhistory.Summary, error) {
	a.profileMu.RLock()
	workspacePath, err := a.activeRunHistoryWorkspaceLocked()
	var workspaceEpoch uint64
	if a.executor != nil {
		workspaceEpoch = a.executor.CurrentEpoch()
	}
	a.profileMu.RUnlock()
	if err != nil {
		return runhistory.Summary{}, err
	}
	if record.WorkspaceEpoch != 0 && record.WorkspaceEpoch != workspaceEpoch {
		if shutdownWorkspace, ok := a.shutdownHistoryWorkspaceFor(record.WorkspaceEpoch); ok {
			workspacePath = shutdownWorkspace
		} else {
			return runhistory.Summary{}, fmt.Errorf(
				"run history workspace epoch mismatch: got %d, current %d",
				record.WorkspaceEpoch,
				workspaceEpoch,
			)
		}
	}
	return a.runHistoryStore.Append(workspacePath, record)
}

// GetRunHistoryRecord lazily loads one rich record from the active workspace.
func (a *App) GetRunHistoryRecord(historyID string) (runhistory.Record, error) {
	workspacePath, err := a.activeRunHistoryWorkspace()
	if err != nil {
		return runhistory.Record{}, err
	}
	return a.runHistoryStore.GetRecord(workspacePath, historyID)
}

// ClearRunHistoryRecord durably redacts one active-workspace record.
func (a *App) ClearRunHistoryRecord(historyID string) error {
	workspacePath, err := a.activeRunHistoryWorkspace()
	if err != nil {
		return err
	}
	return a.runHistoryStore.ClearRecord(workspacePath, historyID)
}

// ClearAllRunHistory durably redacts all active-workspace records.
func (a *App) ClearAllRunHistory() error {
	workspacePath, err := a.activeRunHistoryWorkspace()
	if err != nil {
		return err
	}
	return a.runHistoryStore.ClearAll(workspacePath)
}

func (a *App) activeRunHistoryWorkspaceLocked() (string, error) {
	if a.profileWorkspaceRoot == "" {
		return "", fmt.Errorf("no active workspace")
	}
	return a.profileWorkspaceRoot, nil
}

func (a *App) activeRunHistoryWorkspace() (string, error) {
	a.profileMu.RLock()
	defer a.profileMu.RUnlock()
	return a.activeRunHistoryWorkspaceLocked()
}

// DetectWorkspaces scans the repo at repoPath for focused workspaces.
// Returns the synthetic "Project" entry followed by detected workspaces.
func (a *App) DetectWorkspaces(repoPath string) ([]workspace.WorkspaceDef, error) {
	return workspace.DetectWorkspaces(a.osFS, repoPath)
}

// StartRunProfile starts executing a run profile by ID.
// This is exposed to the frontend via Wails bindings.
func (a *App) StartRunProfile(profileID string) error {
	if a.executor == nil {
		return fmt.Errorf("application not initialized")
	}
	launchedAt := nowMillis()
	profile, profiles, workspaceRoot, epoch, err := a.resolveRunProfile(profileID)
	if err != nil {
		return err
	}
	if err := a.startRunProfileAtEpoch(epoch, workspaceRoot, profile, profiles); err != nil {
		return err
	}
	a.recordRunProfile(profileID, launchedAt)
	return nil
}

func (a *App) resolveRunProfile(profileID string) (runprofile.RunProfile, []runprofile.RunProfile, string, uint64, error) {
	a.profileMu.RLock()
	defer a.profileMu.RUnlock()
	if a.profileManager == nil {
		return runprofile.RunProfile{}, nil, "", 0, fmt.Errorf("no workspace loaded")
	}
	profiles := a.profileManager.GetAllProfiles()
	for _, profile := range profiles {
		if profile.ID == profileID {
			return profile, profiles, a.profileWorkspaceRoot, a.executor.CurrentEpoch(), nil
		}
	}
	return runprofile.RunProfile{}, nil, "", 0, fmt.Errorf("profile not found: %s", profileID)
}

func (a *App) startRunProfileAtEpoch(epoch uint64, workspaceRoot string, profile runprofile.RunProfile, profiles []runprofile.RunProfile) error {
	if profile.Type != runprofile.ProfileTypeCompound {
		return a.executor.StartAtEpoch(epoch, workspaceRoot, profile)
	}
	steps, err := runprofile.ResolveSteps(profile, profiles)
	if err != nil {
		return err
	}
	return a.executor.StartCompoundAtEpoch(epoch, workspaceRoot, profile, steps)
}

func (a *App) recordRunProfile(profileID string, launchedAt int64) {
	a.profileMu.RLock()
	if a.profileManager == nil {
		a.profileMu.RUnlock()
		return
	}
	err := a.profileManager.RecordRun(profileID, launchedAt)
	var snap runprofile.RunProfilesSnapshot
	if err == nil {
		snap = a.runProfilesSnapshot(a.profileManager)
	}
	a.profileMu.RUnlock()
	if err != nil {
		log.Printf("could not record run recency for %s: %v", profileID, err)
		return
	}
	a.emit("runprofiles:changed", snap)
}

// StopRunProfile stops a running profile (SIGTERM → 3s → SIGKILL).
// The id resolves via the executor's active-run table: a single profile's id
// stops that run; a compound profile's id cancels the coordinator and stops the
// current step's leaf; a step profile's own id stops just that leaf (which halts
// the surrounding compound). An idle/unknown id is a no-op (returns nil).
// This is exposed to the frontend via Wails bindings.
func (a *App) StopRunProfile(profileID string) error {
	if a.executor == nil {
		return fmt.Errorf("application not initialized")
	}
	return a.executor.Stop(profileID)
}

// StopRunInstance stops exactly one ordinary execution. Unknown or already
// terminal run IDs are idempotent no-ops.
// This is exposed to the frontend via Wails bindings.
func (a *App) StopRunInstance(runInstanceID string) error {
	if a.executor == nil {
		return fmt.Errorf("application not initialized")
	}
	return a.executor.StopRunInstance(runInstanceID)
}

// RestartRunProfile stops then starts a profile.
// If the profile is not currently running, it just starts it.
// Stop, drain, and workspace-epoch errors are propagated; a failed stop or
// invalid admission never starts a replacement.
// This is exposed to the frontend via Wails bindings.
func (a *App) RestartRunProfile(profileID string) error {
	if a.executor == nil {
		return fmt.Errorf("application not initialized")
	}
	launchedAt := nowMillis()
	profile, profiles, workspaceRoot, epoch, err := a.resolveRunProfile(profileID)
	if err != nil {
		return err
	}
	if profile.Type == runprofile.ProfileTypeCompound {
		steps, resolveErr := runprofile.ResolveSteps(profile, profiles)
		if resolveErr != nil {
			return resolveErr
		}
		err = a.executor.RestartCompoundAtEpoch(epoch, workspaceRoot, profile, steps)
	} else {
		status := a.executor.GetStatus(profileID)
		if status.State == runprofile.RunStateRunning {
			err = a.executor.RestartAtEpoch(epoch, workspaceRoot, profile, status.RunInstanceID)
			if errors.Is(err, runprofile.ErrRunInstanceNotRunning) {
				// The run reached a terminal state between GetStatus and the
				// replacement reservation. Profile-level restart still means
				// "make this profile run", so start fresh instead of failing.
				err = a.executor.StartAtEpoch(epoch, workspaceRoot, profile)
			}
		} else {
			err = a.executor.StartAtEpoch(epoch, workspaceRoot, profile)
		}
	}
	if err == nil {
		a.recordRunProfile(profileID, launchedAt)
	}
	return err
}

// RestartRunInstance replaces exactly one selected ordinary execution while
// leaving same-profile siblings untouched.
// This is exposed to the frontend via Wails bindings.
func (a *App) RestartRunInstance(runInstanceID string) error {
	if a.executor == nil {
		return fmt.Errorf("application not initialized")
	}
	launchedAt := nowMillis()

	a.profileMu.RLock()
	if a.profileManager == nil {
		a.profileMu.RUnlock()
		return fmt.Errorf("no workspace loaded")
	}
	profileID, ok := a.executor.ProfileIDForRunInstance(runInstanceID)
	if !ok {
		a.profileMu.RUnlock()
		return fmt.Errorf("run instance not found: %s", runInstanceID)
	}
	profiles := a.profileManager.GetAllProfiles()
	workspaceRoot := a.profileWorkspaceRoot
	epoch := a.executor.CurrentEpoch()
	a.profileMu.RUnlock()

	var profile runprofile.RunProfile
	found := false
	for _, candidate := range profiles {
		if candidate.ID == profileID {
			profile = candidate
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("profile not found: %s", profileID)
	}
	if profile.Type == runprofile.ProfileTypeCompound {
		return fmt.Errorf("exact restart requires an ordinary run: %s", runInstanceID)
	}
	if err := a.executor.RestartAtEpoch(epoch, workspaceRoot, profile, runInstanceID); err != nil {
		return err
	}
	a.recordRunProfile(profileID, launchedAt)
	return nil
}

// GetRunStatus returns the current run status of a profile. A compound
// profile's id returns its aggregate status. Returns the retained terminal
// status if the profile finished but has not been restarted, or RunStateIdle
// if it is not running and has no retained status.
// This is exposed to the frontend via Wails bindings.
func (a *App) GetRunStatus(profileID string) runprofile.RunStatus {
	if a.executor == nil {
		return runprofile.RunStatus{RunIdentity: runprofile.RunIdentity{ProfileID: profileID}, State: runprofile.RunStateIdle}
	}
	return a.executor.GetStatus(profileID)
}

// --- LSP bindings ---

// LSPDidOpen notifies the LSP manager that a document was opened.
// The frontend is the source of truth for version numbers.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPDidOpen(path, languageID string, version int, content string) error {
	if a.lspManager == nil {
		return fmt.Errorf("LSP not initialized")
	}
	return a.lspManager.DidOpen(a.ctx, path, languageID, version, content)
}

// LSPDidChange notifies the LSP manager that a document changed.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPDidChange(path string, version int, contentChanges []lsp.TextDocumentContentChangeEvent) error {
	if a.lspManager == nil {
		return fmt.Errorf("LSP not initialized")
	}
	return a.lspManager.DidChange(path, version, contentChanges)
}

// LSPDidSave notifies the LSP manager that a document was saved.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPDidSave(path string) error {
	if a.lspManager == nil {
		return fmt.Errorf("LSP not initialized")
	}
	return a.lspManager.DidSave(path)
}

// LSPDidClose notifies the LSP manager that a document was closed.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPDidClose(path string) error {
	if a.lspManager == nil {
		return fmt.Errorf("LSP not initialized")
	}
	return a.lspManager.DidClose(a.ctx, path)
}

// LSPHover requests hover information for a position in a document.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPHover(path string, line, character int) (*lsp.Hover, error) {
	if a.lspManager == nil {
		return nil, fmt.Errorf("LSP not initialized")
	}
	ctx, cancel := context.WithTimeout(a.ctx, lsp.DefaultRequestTimeout)
	defer cancel()
	return a.lspManager.Hover(ctx, path, line, character)
}

// LSPDefinition requests go-to-definition for a position in a document.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPDefinition(path string, line, character int) ([]lsp.Location, error) {
	if a.lspManager == nil {
		return nil, fmt.Errorf("LSP not initialized")
	}
	ctx, cancel := context.WithTimeout(a.ctx, lsp.DefaultRequestTimeout)
	defer cancel()
	return a.lspManager.Definition(ctx, path, line, character)
}

// LSPDocumentSymbol requests the document symbols (structure/outline) for a file.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPDocumentSymbol(path string) ([]lsp.DocumentSymbol, error) {
	if a.lspManager == nil {
		return nil, fmt.Errorf("LSP not initialized")
	}
	ctx, cancel := context.WithTimeout(a.ctx, lsp.DefaultRequestTimeout)
	defer cancel()
	return a.lspManager.DocumentSymbol(ctx, path)
}

// LSPComplete requests completion items for a position in a document.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPComplete(path string, line, character int, triggerCharacter string) (*lsp.CompletionList, error) {
	if a.lspManager == nil {
		return nil, fmt.Errorf("LSP not initialized")
	}
	ctx, cancel := context.WithTimeout(a.ctx, lsp.DefaultRequestTimeout)
	defer cancel()
	return a.lspManager.Complete(ctx, path, line, character, triggerCharacter)
}

// LSPResolveCompletionItem requests additional detail for a completion item.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPResolveCompletionItem(path string, item lsp.CompletionItem) (*lsp.CompletionItem, error) {
	if a.lspManager == nil {
		return nil, fmt.Errorf("LSP not initialized")
	}
	ctx, cancel := context.WithTimeout(a.ctx, lsp.DefaultRequestTimeout)
	defer cancel()
	return a.lspManager.ResolveCompletionItem(ctx, path, item)
}

// GetLSPStatus returns the status of all running language servers.
// This is exposed to the frontend via Wails bindings.
func (a *App) GetLSPStatus() []lsp.ServerStatus {
	if a.lspManager == nil {
		return []lsp.ServerStatus{}
	}
	return a.lspManager.GetStatus()
}

// lspWorkspaceSwitchTimeout is the time allowed for LSP servers to shut down during a workspace switch.
const lspWorkspaceSwitchTimeout = 3 * time.Second

// SetLSPWorkspaceRoot updates the LSP manager's workspace root.
// Called when the workspace changes — shuts down old servers first.
// This is exposed to the frontend via Wails bindings.
func (a *App) SetLSPWorkspaceRoot(workspacePath string) {
	if a.lspManager == nil {
		return
	}
	a.lspManager.ShutdownAll(lspWorkspaceSwitchTimeout)
	a.lspManager.SetWorkspaceRoot(workspacePath)

	// Seed any persisted interpreter override so it applies before the first
	// file opens. Best-effort: a load error or absent state just means no
	// override to seed.
	if st, err := a.workspaceStore.Load(workspacePath); err == nil && st != nil && st.LSP.InterpreterOverride != "" {
		a.lspManager.SeedInterpreterOverride(workspacePath, st.LSP.InterpreterOverride)
	}
}

// --- LSP Phase 2 bindings (managed provisioning + interpreter override) ---

// LSPDoctor returns interpreter candidates + current override for a workspace.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPDoctor(workspacePath string) (lsp.DoctorReport, error) {
	if a.lspManager == nil {
		return lsp.DoctorReport{}, fmt.Errorf("LSP not initialized")
	}
	return a.lspManager.Doctor(workspacePath), nil
}

// LSPSetInterpreter validates + persists a manual interpreter override for the
// workspace and re-wires/restarts the affected server.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPSetInterpreter(workspacePath, interpreterPath string) error {
	if a.lspManager == nil {
		return fmt.Errorf("LSP not initialized")
	}
	// Validate + apply in the manager first (it stat-checks the path and restarts).
	if err := a.lspManager.SetInterpreterOverride(workspacePath, interpreterPath); err != nil {
		return err
	}
	// Persist only after a successful apply.
	return a.persistLSPInterpreter(workspacePath, interpreterPath)
}

// LSPClearInterpreter removes the override and re-detects.
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPClearInterpreter(workspacePath string) error {
	if a.lspManager == nil {
		return fmt.Errorf("LSP not initialized")
	}
	if err := a.lspManager.ClearInterpreterOverride(workspacePath); err != nil {
		return err
	}
	return a.persistLSPInterpreter(workspacePath, "") // empty clears it
}

// LSPRetryProvision re-attempts a managed server install for a family, keyed
// to the project root the failing status reported (empty falls back to the
// workspace root).
// This is exposed to the frontend via Wails bindings.
func (a *App) LSPRetryProvision(family, projectRoot string) error {
	if a.lspManager == nil {
		return fmt.Errorf("LSP not initialized")
	}
	return a.lspManager.RetryProvision(family, projectRoot)
}

// persistLSPInterpreter writes the interpreter override into the workspace's
// persisted state (~/.firn/workspaces). interpreterPath=="" clears it.
func (a *App) persistLSPInterpreter(workspacePath, interpreterPath string) error {
	st, err := a.workspaceStore.Load(workspacePath)
	if err != nil {
		return err
	}
	if st == nil {
		st = &workspace.State{WorkspacePath: workspacePath}
	}
	st.LSP.InterpreterOverride = interpreterPath
	return a.workspaceStore.Save(*st)
}

// --- Search bindings ---

// SearchWorkspace runs a workspace text search via ripgrep and returns a
// typed response. Status discriminates between success, no-matches,
// missing-tool, invalid-regex, canceled, and failed states; the frontend
// renders distinct UI for each. The Wails context is passed through so the
// search aborts when the application context is canceled (window close).
// This is exposed to the frontend via Wails bindings.
func (a *App) SearchWorkspace(request search.SearchRequest) search.SearchResponse {
	if a.searchManager == nil {
		return search.SearchResponse{
			RequestID: request.RequestID,
			Status:    search.StatusFailed,
			Message:   "search service not initialized",
			Files:     []search.FileResult{},
		}
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return a.searchManager.Search(ctx, request)
}

// CancelSearch aborts an in-flight search by RequestID. It is a no-op when
// no search with that id is active, which is the expected state after a
// successful response was already delivered.
// This is exposed to the frontend via Wails bindings.
func (a *App) CancelSearch(requestID string) {
	if a.searchManager == nil {
		return
	}
	a.searchManager.Cancel(requestID)
}

// nowMillis returns the current time as Unix milliseconds.
func nowMillis() int64 { return time.Now().UnixMilli() }
