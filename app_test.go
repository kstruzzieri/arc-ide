package main

import (
	"context"
	"firn/internal/runprofile"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestMain sandboxes the home directory for the whole package. startup opens
// the Golem consent store under <home>/.firn, which creates that directory and
// tightens its permissions, and the workspace and run-history stores write
// there too; without this the suite would reach into the developer's real home
// directory. USERPROFILE covers Windows, where os.UserHomeDir ignores HOME.
// Individual tests still override HOME with t.Setenv when they need to.
func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "firn-test-home")
	if err != nil {
		log.Fatalf("sandbox home directory: %v", err)
	}
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if err := os.Setenv(key, home); err != nil {
			log.Fatalf("sandbox %s: %v", key, err)
		}
	}
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}

func TestNewApp(t *testing.T) {
	app := NewApp()
	if app == nil {
		t.Error("NewApp() returned nil")
	}
}

func TestStartup(t *testing.T) {
	app := NewApp()
	ctx := context.Background()

	// startup should not panic and should store context
	app.startup(ctx)

	if app.ctx == nil {
		t.Error("startup() did not store context")
	}
}

// GetWorkspaceInfo is the Golem repository binding call. Before startup there
// is no service to bind against, so it must reject rather than panic.
func TestGetWorkspaceInfoBeforeStartup(t *testing.T) {
	app := NewApp()

	info, err := app.GetWorkspaceInfo(t.TempDir())
	if err == nil {
		t.Fatal("expected a rejection before startup, got nil")
	}
	if info != (WorkspaceInfo{}) {
		t.Errorf("Expected zero WorkspaceInfo, got %+v", info)
	}
}

func TestWorkspaceInfoStruct(t *testing.T) {
	info := WorkspaceInfo{
		Name:      "test-project",
		Path:      "/path/to/project",
		RepoKey:   "0f9a",
		RepoEpoch: 3,
	}

	if info.Name != "test-project" {
		t.Errorf("Expected Name 'test-project', got %q", info.Name)
	}
	if info.Path != "/path/to/project" {
		t.Errorf("Expected Path '/path/to/project', got %q", info.Path)
	}
	if info.RepoKey != "0f9a" {
		t.Errorf("Expected RepoKey '0f9a', got %q", info.RepoKey)
	}
	if info.RepoEpoch != 3 {
		t.Errorf("Expected RepoEpoch 3, got %d", info.RepoEpoch)
	}
}

// StartRunProfile must guard a nil executor the same way StopRunProfile does,
// rather than dereferencing it and panicking before the app has started up.
func TestStartRunProfileNilExecutor(t *testing.T) {
	app := &App{}

	err := app.StartRunProfile("any-id")
	if err == nil {
		t.Fatal("expected error when executor is nil, got nil")
	}
	if !strings.Contains(err.Error(), "not initialized") {
		t.Fatalf("expected 'not initialized' error, got %v", err)
	}
}

func newLoadedAppForProfiles(t *testing.T) *App {
	t.Helper()
	app := NewApp()
	app.ctx = context.Background()
	tmp := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmp, "package.json"),
		[]byte(`{"scripts":{"dev":"vite"}}`), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	if err := app.LoadRunProfiles(tmp); err != nil {
		t.Fatalf("LoadRunProfiles: %v", err)
	}
	return app
}

// countEvent filters a captured emit slice down to a single event name, so a
// count-based assertion isn't broken by an unrelated subsystem's emit landing
// in the same sink.
func countEvent(events []string, name string) int {
	n := 0
	for _, e := range events {
		if e == name {
			n++
		}
	}
	return n
}

func TestSaveRunProfileEmitsOnlyWhenValid(t *testing.T) {
	app := newLoadedAppForProfiles(t)
	all := app.GetAllRunProfiles()
	if len(all) == 0 {
		t.Fatal("expected a detected profile from package.json")
	}
	wsID := all[0].WorkspaceID

	var events []string
	app.emitFn = func(event string, _ any) { events = append(events, event) }

	// Invalid: empty name → no emit.
	res, err := app.SaveRunProfile(runprofile.RunProfile{
		ID: "user-dev", Type: runprofile.ProfileTypeSingle, Command: "vite", WorkspaceID: wsID,
	})
	if err != nil {
		t.Fatalf("unexpected transport error: %v", err)
	}
	if res.Valid {
		t.Fatal("expected invalid result for empty name")
	}
	if n := countEvent(events, "runprofiles:changed"); n != 0 {
		t.Fatalf("expected no runprofiles:changed emit on invalid save, got %v", events)
	}

	// Valid: emits exactly one runprofiles:changed.
	res, err = app.SaveRunProfile(runprofile.RunProfile{
		ID: "user-dev", Name: "Dev", Type: runprofile.ProfileTypeSingle,
		Command: "vite", WorkspaceID: wsID,
	})
	if err != nil || !res.Valid {
		t.Fatalf("valid save failed: err=%v res=%+v", err, res)
	}
	if n := countEvent(events, "runprofiles:changed"); n != 1 {
		t.Fatalf("expected one runprofiles:changed, got %v", events)
	}
}

func TestDeleteRunProfileEmitsOnSuccess(t *testing.T) {
	app := newLoadedAppForProfiles(t)
	wsID := app.GetAllRunProfiles()[0].WorkspaceID

	// Set emitFn before the seed save so the valid save is captured here
	// instead of reaching the real (*App).emit seam.
	var events []string
	app.emitFn = func(event string, _ any) { events = append(events, event) }

	if _, err := app.SaveRunProfile(runprofile.RunProfile{
		ID: "user-dev", Name: "Dev", Type: runprofile.ProfileTypeSingle,
		Command: "vite", WorkspaceID: wsID,
	}); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	// Discard the seed-save emit; only count events from here.
	events = nil

	if err := app.DeleteRunProfile("user-dev"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(events) != 1 || events[0] != "runprofiles:changed" {
		t.Fatalf("expected one emit on delete, got %v", events)
	}

	events = nil
	if err := app.DeleteRunProfile("does-not-exist"); err == nil {
		t.Fatal("expected error deleting missing profile")
	}
	if len(events) != 0 {
		t.Fatalf("expected no emit on failed delete, got %v", events)
	}
}

func TestApp_DetectWorkspaces(t *testing.T) {
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, "frontend"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "frontend", "package.json"), []byte(`{"devDependencies":{"vite":"5.0.0"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	defs, err := app.DetectWorkspaces(repo)
	if err != nil {
		t.Fatalf("DetectWorkspaces error: %v", err)
	}
	if len(defs) != 2 {
		t.Fatalf("got %d defs, want 2 (project + frontend): %+v", len(defs), defs)
	}
	if defs[0].ID != "project" {
		t.Errorf("defs[0].ID = %q, want project", defs[0].ID)
	}
	if defs[1].ID != "frontend" || defs[1].Accent != "frontend" {
		t.Errorf("defs[1] = %+v, want frontend/frontend", defs[1])
	}
}

// --- Spec §5.5 app-close state machine ---------------------------------------
// idle → awaiting_frontend → draining → permitted, driven from the v3
// ShouldQuit edge (app.shouldQuit). The v3-only edges live in app_close_test.go.

// closeProbe observes everything the close machine does that a test can see:
// the events it emits and the final Quit it hands to Wails. Both are recorded
// off the drain goroutine, so every read takes the mutex.
type closeProbe struct {
	mu     sync.Mutex
	events []string
	quits  int
	quit   chan struct{}
}

func (p *closeProbe) emit(event string, _ any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, event)
}

// recordQuit stands in for the platform quit, which cannot run outside a live
// Wails application. The channel is buffered so a second (contract-violating)
// quit is still counted rather than blocking the drain goroutine.
func (p *closeProbe) recordQuit() {
	p.mu.Lock()
	p.quits++
	p.mu.Unlock()
	select {
	case p.quit <- struct{}{}:
	default:
	}
}

func (p *closeProbe) snapshot() (events []string, quits int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.events...), p.quits
}

func (p *closeProbe) quitCount() int {
	_, quits := p.snapshot()
	return quits
}

// waitForQuit fails the test unless the drain reaches its final quit.
func (p *closeProbe) waitForQuit(t *testing.T) {
	t.Helper()
	select {
	case <-p.quit:
	case <-time.After(5 * time.Second):
		t.Fatal("the drain never reached the platform quit")
	}
}

// closeSnapshot is the app state a cancelled close must leave untouched.
type closeSnapshot struct {
	runShutdown bool
	epoch       uint64
	aiAlive     bool
}

func snapshotCloseState(t *testing.T, app *App) closeSnapshot {
	t.Helper()
	app.closeMu.Lock()
	shutdown := app.runShutdown
	app.closeMu.Unlock()
	// Settings is the cheapest liveness probe on the Golem service: it is
	// side-effect free and returns the closing projection error once the AI
	// shutdown has run.
	_, err := app.GetGolemSettings()
	return closeSnapshot{runShutdown: shutdown, epoch: app.executor.CurrentEpoch(), aiAlive: err == nil}
}

// newCloseApp starts a fully wired App whose close machine is runnable in a
// test: events go to the probe, the final Quit is observed instead of executed,
// and the amendment-11 backstop is whatever the row needs.
func newCloseApp(t *testing.T, backstop time.Duration) (*App, *closeProbe) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GO_LLM_CONFIG", "")
	probe := &closeProbe{quit: make(chan struct{}, 4)}
	app := NewApp()
	app.emitFn = probe.emit
	app.quitFn = probe.recordQuit
	app.closeBackstopOverride = backstop
	app.startup(context.Background())
	t.Cleanup(app.closeAIService)
	return app, probe
}

// First close asks the frontend and nothing else: one event, no teardown, no
// deadline. Everything the drain touches must still be exactly as it was.
func TestCloseHandshakeFirstCloseOnlyAsksTheFrontend(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)
	before := snapshotCloseState(t, app)

	if app.shouldQuit() {
		t.Fatal("the first quit request must be refused while the frontend prepares")
	}

	events, quits := probe.snapshot()
	if len(events) != 1 || events[0] != "app:beforeclose" {
		t.Fatalf("events = %v, want exactly one app:beforeclose", events)
	}
	if quits != 0 {
		t.Errorf("quits = %d, want 0: awaiting_frontend starts no deadline", quits)
	}
	if got := snapshotCloseState(t, app); got != before {
		t.Errorf("state = %+v, want the untouched %+v: awaiting_frontend starts no teardown", got, before)
	}
}

// Confirm alone enters draining, and it does so exactly once however many
// times it (or a later close) arrives. An immediate Confirm is the fast
// no-op path: nothing to prepare, so the drain starts without any wait.
func TestCloseHandshakeConfirmDrainsExactlyOnce(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)
	before := snapshotCloseState(t, app)

	app.shouldQuit()
	app.ConfirmBeforeCloseReady()
	probe.waitForQuit(t)

	app.ConfirmBeforeCloseReady() // idempotent
	if !app.shouldQuit() {
		t.Error("a quit request after the drain permitted it must be allowed so the final Quit can close the window")
	}
	// Give a stray second drain time to land before counting.
	time.Sleep(50 * time.Millisecond)
	if quits := probe.quitCount(); quits != 1 {
		t.Errorf("quits = %d, want exactly 1", quits)
	}

	after := snapshotCloseState(t, app)
	if !after.runShutdown {
		t.Error("the drain did not close run admission")
	}
	if after.epoch == before.epoch {
		t.Errorf("workspace epoch = %d, want the drain to advance it past %d", after.epoch, before.epoch)
	}
	if after.aiAlive {
		t.Error("the drain did not shut the Golem service down")
	}
	events, _ := probe.snapshot()
	if len(events) != 1 {
		t.Errorf("events = %v, want the single app:beforeclose", events)
	}
}

// Confirm before any close request is a no-op: there is no handshake to finish.
func TestCloseHandshakeConfirmWithoutACloseIsANoOp(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)
	before := snapshotCloseState(t, app)

	app.ConfirmBeforeCloseReady()
	time.Sleep(50 * time.Millisecond)

	if quits := probe.quitCount(); quits != 0 {
		t.Errorf("quits = %d, want 0", quits)
	}
	if got := snapshotCloseState(t, app); got != before {
		t.Errorf("state = %+v, want the untouched %+v", got, before)
	}
}

// Cancel returns the machine to idle without touching run admission, the AI
// service, or the shutdown flag — and it clears the backstop, so a handshake
// the user dismissed never force-quits behind their back.
func TestCloseHandshakeCancelReturnsToIdleAndTouchesNothing(t *testing.T) {
	app, probe := newCloseApp(t, 40*time.Millisecond)
	before := snapshotCloseState(t, app)

	app.shouldQuit()
	app.CancelBeforeClose()
	app.CancelBeforeClose() // idempotent

	// Idle again, so the next close is a fresh first close — and the second
	// handshake gets a backstop it will never reach. The first handshake's
	// timer is still counting down: unless the cancel disarmed it, it fires
	// mid-handshake and force-quits a close the user is still answering.
	app.closeBackstopOverride = time.Hour
	if app.shouldQuit() {
		t.Fatal("the quit request after a cancel must be refused like any first request")
	}
	time.Sleep(200 * time.Millisecond) // well past the abandoned backstop

	if quits := probe.quitCount(); quits != 0 {
		t.Errorf("quits = %d, want 0: the cancelled handshake's backstop must be disarmed", quits)
	}
	if got := snapshotCloseState(t, app); got != before {
		t.Errorf("state = %+v, want the untouched %+v", got, before)
	}
	events, _ := probe.snapshot()
	if len(events) != 2 {
		t.Errorf("events = %v, want one app:beforeclose per close request", events)
	}
	app.CancelBeforeClose()
}

// Amendment 11, escape hatch 1: a second OS close while awaiting is a
// deterministic user-driven force quit. It emits no second event.
func TestCloseHandshakeSecondCloseForcesTheDrain(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)
	logged := captureGolemLog(t)

	app.shouldQuit()
	if app.shouldQuit() {
		t.Fatal("the forced drain must still refuse the request; its own Quit ends the app")
	}
	probe.waitForQuit(t)

	events, quits := probe.snapshot()
	if len(events) != 1 {
		t.Errorf("events = %v, want no second app:beforeclose", events)
	}
	if quits != 1 {
		t.Errorf("quits = %d, want exactly 1", quits)
	}
	if !strings.Contains(logged(), closeLogPrefix) {
		t.Errorf("host log %q does not record the forced drain", logged())
	}
	after := snapshotCloseState(t, app)
	if !after.runShutdown || after.aiAlive {
		t.Errorf("state = %+v, want a completed teardown", after)
	}
	if !app.shouldQuit() {
		t.Error("a quit request after the drain permitted it must be allowed")
	}
}

// Amendment 11, escape hatch 2: a renderer that never answers is drained by the
// backend backstop, host-logged.
func TestCloseHandshakeBackstopDrainsADeadRenderer(t *testing.T) {
	app, probe := newCloseApp(t, 20*time.Millisecond)
	logged := captureGolemLog(t)

	app.shouldQuit()
	probe.waitForQuit(t)

	if !strings.Contains(logged(), closeLogPrefix) {
		t.Errorf("host log %q does not record the backstop fallback", logged())
	}
	events, quits := probe.snapshot()
	if len(events) != 1 {
		t.Errorf("events = %v, want the single app:beforeclose", events)
	}
	if quits != 1 {
		t.Errorf("quits = %d, want exactly 1", quits)
	}
	if after := snapshotCloseState(t, app); !after.runShutdown || after.aiAlive {
		t.Errorf("state = %+v, want a completed teardown", after)
	}
}

// The backstop never doubles a handshake that completed normally: Confirm
// clears it, so the timer that outlives the drain changes nothing.
func TestCloseHandshakeConfirmClearsTheBackstop(t *testing.T) {
	app, probe := newCloseApp(t, 20*time.Millisecond)

	app.shouldQuit()
	app.ConfirmBeforeCloseReady()
	probe.waitForQuit(t)

	time.Sleep(120 * time.Millisecond) // well past the backstop
	if quits := probe.quitCount(); quits != 1 {
		t.Errorf("quits = %d, want exactly 1: the backstop must not re-drain", quits)
	}
}

// The 60-second production backstop is deliberately long: a live dirty-draft
// prompt must never be force-closed by a short timer.
func TestCloseHandshakeBackstopDefaultsToSixtySeconds(t *testing.T) {
	if closeHandshakeBackstop != 60*time.Second {
		t.Errorf("closeHandshakeBackstop = %v, want 60s", closeHandshakeBackstop)
	}
	app := &App{}
	if got := app.backstopDelay(); got != closeHandshakeBackstop {
		t.Errorf("backstopDelay() = %v, want the %v production value", got, closeHandshakeBackstop)
	}
}

// A cancelled folder dialog also answers with an empty path, so a missing
// application host must be an error: returning ("", nil) would let the
// frontend read "the dialog never opened" as "the user changed their mind".
func TestOpenFolderDialogWithoutHostReturnsError(t *testing.T) {
	app := NewApp()

	path, err := app.OpenFolderDialog()

	if err == nil {
		t.Fatal("OpenFolderDialog() error = nil, want one when v3app is unset")
	}
	if !strings.Contains(err.Error(), "application host not initialised") {
		t.Errorf("OpenFolderDialog() error = %q, want it to name the uninitialised host", err)
	}
	if path != "" {
		t.Errorf("OpenFolderDialog() path = %q, want empty", path)
	}
}
