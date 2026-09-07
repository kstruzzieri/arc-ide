package main

import (
	"context"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// --- v3 quit edges (ShouldQuit / WindowClosing) ------------------------------
//
// v2 asked "prevent this close?" on OnBeforeClose; v3 asks the inverse question
// on ShouldQuit, and the drain's own Quit comes back through the same callback.
// That is what closePermitted exists for: the §5.5 machine keeps its three
// phases and gains one terminal phase that lets exactly that quit through.
// The rows below cover the v3-only edges — the inverted phase table, the main
// window's close button, and the service startup hook — on top of the §5.5
// handshake rows in app_test.go, whose helpers they reuse.

// A quit request that arrives while the drain is running must not be allowed
// through: the drain has not finished yet, so the window would close on top of
// an in-flight teardown. Only permitAndQuit opens that door.
func TestShouldQuitRefusesWhileDrainingAndAllowsOncePermitted(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)
	before := snapshotCloseState(t, app)

	app.closeMu.Lock()
	app.closePhase = closeDraining
	app.closeMu.Unlock()

	if app.shouldQuit() {
		t.Error("a quit request during the drain must be refused until the drain permits it")
	}
	if app.quitPermitted() {
		t.Error("quitPermitted() = true while draining, want false")
	}
	events, quits := probe.snapshot()
	if len(events) != 0 || quits != 0 {
		t.Errorf("events = %v, quits = %d; a request during the drain must re-emit and re-drain nothing", events, quits)
	}
	if got := snapshotCloseState(t, app); got != before {
		t.Errorf("state = %+v, want the untouched %+v", got, before)
	}

	app.closeMu.Lock()
	app.closePhase = closePermitted
	app.closeMu.Unlock()

	if !app.shouldQuit() {
		t.Error("a quit request must be allowed once the drain has permitted it")
	}
	if !app.quitPermitted() {
		t.Error("quitPermitted() = false in the permitted phase, want true")
	}
}

// permitAndQuit must reach the permitted phase before it asks the platform to
// quit: the platform answers by calling shouldQuit, and a request that arrives
// while the machine still says "draining" is refused — the app would never exit.
func TestPermitAndQuitPermitsBeforeItQuits(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)
	permittedAtQuit := false
	app.quitFn = func() {
		permittedAtQuit = app.quitPermitted()
		probe.recordQuit()
	}

	if app.quitPermitted() {
		t.Fatal("a fresh app must not permit quitting")
	}

	app.permitAndQuit()

	if !permittedAtQuit {
		t.Error("the platform quit was requested before the machine permitted it; shouldQuit would refuse it")
	}
	if quits := probe.quitCount(); quits != 1 {
		t.Errorf("quits = %d, want exactly 1", quits)
	}
}

// The main window's close button is the same handshake as Cmd+Q, not a second
// path: it cancels the window close and hands the decision to the machine.
func TestMainWindowClosingRoutesThroughTheQuitHandshake(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)
	cancels := 0
	cancel := func() { cancels++ }

	app.handleMainWindowClosing(cancel)

	if cancels != 1 {
		t.Fatalf("cancels = %d, want 1: the first press only asks the frontend", cancels)
	}
	events, quits := probe.snapshot()
	if len(events) != 1 || events[0] != "app:beforeclose" {
		t.Fatalf("events = %v, want exactly one app:beforeclose", events)
	}
	if quits != 0 {
		t.Errorf("quits = %d, want 0: awaiting_frontend quits nothing", quits)
	}
	if app.quitPermitted() {
		t.Error("the first press must not permit quitting")
	}

	// Second press: amendment 11's user-driven force quit. The window close is
	// still cancelled — the drain's own quit is what ends the app.
	app.handleMainWindowClosing(cancel)
	if cancels != 2 {
		t.Fatalf("cancels = %d, want 2: the forced drain still cancels the window close", cancels)
	}
	probe.waitForQuit(t)
	if !app.quitPermitted() {
		t.Error("the completed drain must permit quitting")
	}
	if events, _ := probe.snapshot(); len(events) != 1 {
		t.Errorf("events = %v, want no second app:beforeclose", events)
	}

	// Once permitted, the closing window is the app quitting: nothing to cancel.
	app.handleMainWindowClosing(cancel)
	if cancels != 2 {
		t.Errorf("cancels = %d, want 2: a permitted close must not be cancelled", cancels)
	}
}

// The whole v3 round trip: refuse, let the frontend finish, drain, then allow
// the drain's own quit back through — one event, one quit.
func TestShouldQuitEndToEndPermitsTheDrainsOwnQuit(t *testing.T) {
	app, probe := newCloseApp(t, time.Hour)

	if app.shouldQuit() {
		t.Fatal("the first quit request must be refused while the frontend prepares")
	}
	app.ConfirmBeforeCloseReady()
	probe.waitForQuit(t)

	if !app.shouldQuit() {
		t.Error("the quit the drain itself requested must be allowed through")
	}
	events, quits := probe.snapshot()
	if len(events) != 1 || events[0] != "app:beforeclose" {
		t.Errorf("events = %v, want exactly one app:beforeclose", events)
	}
	if quits != 1 {
		t.Errorf("quits = %d, want exactly 1", quits)
	}
}

// ServiceStartup is the v3 replacement for OnStartup: it must store the same
// application context and run the same wiring, or every a.ctx consumer and the
// services built in startup are missing.
func TestServiceStartupStoresTheApplicationContext(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GO_LLM_CONFIG", "")
	app := NewApp()
	t.Cleanup(app.closeAIService)

	type ctxKey struct{}
	ctx := context.WithValue(context.Background(), ctxKey{}, "firn")

	if err := app.ServiceStartup(ctx, application.ServiceOptions{}); err != nil {
		t.Fatalf("ServiceStartup error = %v, want nil", err)
	}

	if app.ctx == nil || app.ctx.Value(ctxKey{}) != "firn" {
		t.Errorf("app.ctx = %v, want the context ServiceStartup received", app.ctx)
	}
	if app.executor == nil || app.lspManager == nil || app.aiService == nil {
		t.Error("ServiceStartup did not run startup's wiring (executor, LSP manager, Golem service)")
	}
}
