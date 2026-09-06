package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"firn/internal/appstate"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// #271 spec §5 — the Golem window contract. Go owns the native window, the
// mode, and the relay; it never interprets a projection or an action payload.

const (
	golemWindowNameMain   = "main"
	golemWindowNameGolem  = "golem"
	golemWindowMaxPayload = 4 << 20

	golemWindowRoleMain      = "main"
	golemWindowRoleSatellite = "satellite"

	eventGolemWindowMode    = "golem:window-mode"
	eventGolemWindowMessage = "golem:window-message"

	// golemWindowURL is the satellite route inside the same Vite bundle.
	golemWindowURL   = "/#/golem-window"
	golemWindowTitle = "Firn — Golem"

	golemWindowMinWidth      = 380
	golemWindowMinHeight     = 520
	golemWindowDefaultWidth  = 480
	golemWindowDefaultHeight = 720

	// golemTransitionDeadline bounds both the undock bootstrap and the re-dock
	// draft transfer. It is independent of ordinary action completion.
	golemTransitionDeadline = 10 * time.Second
	// golemBoundsDebounce coalesces a move/resize burst into one geometry read
	// (spec §5.3 "save normal bounds on debounced move/resize"). Derived from
	// the two things it sits between: an interactive drag delivers events at
	// frame rate, so anything under ~100 ms is not a debounce, and the quit
	// path saves the live frame itself (saveGolemFrameForShutdown), so the only
	// cost of waiting is one extra native geometry read per burst. 400 ms is
	// one full burst of moves at drag speed with a margin, and an order of
	// magnitude inside the 2 s retirement cap this file already accepts as
	// "quick enough for a user to notice nothing".
	golemBoundsDebounce = 400 * time.Millisecond
	// golemRetirementPoll / golemRetirementCap bound the close-only observer.
	golemRetirementPoll = 20 * time.Millisecond
	golemRetirementCap  = 2 * time.Second
	// golemAbortReasonMax bounds the display reason carried by an abort, in
	// bytes. Derived from the frontend's own display bound: both hosts cut a
	// message to MAX_ERROR_CHARS = 200 UTF-16 code units (types/golem.ts), and
	// 512 bytes holds 200 characters of any two-byte script with room for the
	// three-byte ones common in CJK prose, while keeping the state Go retains
	// and re-publishes on every snapshot far below the 4 MiB relay cap.
	golemAbortReasonMax = 512
)

// golemTimer is the only thing the window machine needs from a timer, so tests
// can inject a deterministic one through App.golemAfterFunc.
type golemTimer interface{ Stop() bool }

// golemWindowRuntime is the live window state. Every field is guarded by
// App.golemWinMu. No native call, no disk write and no callback into the App
// may run while that mutex is held.
//
// Lock order: read quitPermitted() (which takes closeMu) BEFORE acquiring
// golemWinMu, never the other way round. Hooks and timer callbacks follow the
// same order.
type golemWindowRuntime struct {
	mode           string
	phase          GolemWindowPhase
	instance       uint64
	handoff        uint64
	stateRevision  uint64
	restorePending bool
	// restoring marks the live attempt as the startup restore of a saved
	// undocked window rather than a user's undock: it is shown without taking
	// focus (§7), because nobody asked for it just now.
	restoring bool
	// reason explains the most recent failed transition (a deadline, an abort,
	// a stalled retirement) to both hosts, or — before any attempt — why the
	// saved preference could not be read (§3.2); the next attempt clears it.
	reason string

	// instanceSeq and handoffSeq only ever increase, so a retired attempt's
	// number can never be handed to a replacement.
	instanceSeq uint64
	handoffSeq  uint64

	// handle/handleID are the current satellite. unhook releases its hooks.
	handle   application.Window
	handleID uint
	unhook   []func()

	// view is the latest projection main published, retained for bootstrap.
	view         json.RawMessage
	viewRevision uint64

	// transferID is the draft-map message id recorded for the current handoff
	// (main's map on undock, the satellite's final map on re-dock);
	// transferAcked records a successful main ack of that exact id.
	transferID    uint64
	transferAcked bool

	// lastNormal is the most recent non-minimised, non-maximised,
	// non-fullscreen frame. saveGen orders disk writes.
	lastNormal appstate.GolemWindow
	saveGen    uint64

	deadline  golemTimer
	saveTimer golemTimer

	// retiring* and closeAuthorized are the per-instance close authorization.
	// A bypass belongs to exactly this handle and instance, never to a later
	// window that happens to reuse the name.
	retiringID       uint
	retiringInstance uint64
	retiringHandoff  uint64
	closeAuthorized  bool
	observing        bool
	retirementFailed bool
	observerCancel   context.CancelFunc
}

// snapshot renders the state both windows read. An App that never loaded a
// preference still reports the docked/closed default.
func (r *golemWindowRuntime) snapshot() GolemWindowState {
	mode := r.mode
	if mode != appstate.ModeUndocked {
		mode = appstate.ModeDocked
	}
	phase := r.phase
	if phase == "" {
		phase = golemPhaseClosed
	}
	return GolemWindowState{
		Mode:           mode,
		Phase:          phase,
		Instance:       r.instance,
		RestorePending: r.restorePending,
		StateRevision:  r.stateRevision,
		Handoff:        r.handoff,
		Reason:         r.reason,
	}
}

// transition bumps the revision consumers use to reject a stale snapshot and
// returns the state to emit once the lock is released.
func (r *golemWindowRuntime) transition() GolemWindowState {
	r.stateRevision++
	r.saveGen++
	return r.snapshot()
}

// GolemWindowPhase is the live phase of the Golem window.
type GolemWindowPhase string

const (
	golemPhaseClosed        GolemWindowPhase = "closed"
	golemPhaseBootstrapping GolemWindowPhase = "bootstrapping"
	golemPhaseBootstrapped  GolemWindowPhase = "bootstrapped"
	golemPhaseReady         GolemWindowPhase = "ready"
	golemPhaseClosing       GolemWindowPhase = "closing"
)

// GolemWindowState is what both windows read; emitted on every transition.
type GolemWindowState struct {
	Mode           string           `json:"mode"`
	Phase          GolemWindowPhase `json:"phase"`
	Instance       uint64           `json:"instance"`
	RestorePending bool             `json:"restorePending"`
	StateRevision  uint64           `json:"stateRevision"`
	Handoff        uint64           `json:"handoff"`
	// Reason is Go's own text for the failure that produced this state: a
	// deadline, a relayed abort, or a retirement that stalled after the close
	// was authorized. Empty on every successful transition.
	Reason string `json:"reason,omitempty"`
}

// GolemWindowMessage is one relayed message. Kind fixes the payload type on
// the frontend; Go validates only the envelope.
type GolemWindowMessage struct {
	Kind     string          `json:"kind"`
	Instance uint64          `json:"instance"`
	Handoff  uint64          `json:"handoff"`
	ID       uint64          `json:"id"`
	Revision uint64          `json:"revision"`
	Payload  json.RawMessage `json:"payload"`
}

// GolemWindowEnvelope is the emitted form: the message plus the verified
// sender role, so a receiver never trusts a self-declared origin.
type GolemWindowEnvelope struct {
	From    string             `json:"from"`
	Message GolemWindowMessage `json:"message"`
}

// GolemWindowBootstrap is the satellite's first read: current state plus the
// latest projection main published (null before the first publish).
type GolemWindowBootstrap struct {
	State    GolemWindowState `json:"state"`
	View     json.RawMessage  `json:"view"`
	Revision uint64           `json:"revision"`
}

// golemWindowKinds maps a kind to the roles allowed to send it.
var golemWindowKinds = map[string]map[string]bool{
	"view":   {golemWindowRoleMain: true},
	"ack":    {golemWindowRoleMain: true, golemWindowRoleSatellite: true},
	"drafts": {golemWindowRoleMain: true, golemWindowRoleSatellite: true},
	"action": {golemWindowRoleSatellite: true},
	"ready":  {golemWindowRoleSatellite: true},
	"abort":  {golemWindowRoleMain: true, golemWindowRoleSatellite: true},
}

// asLiveWindow normalizes a typed-nil *application.WebviewWindow boxed into
// the application.Window interface to a true nil interface. A nil pointer
// stored in a non-nil interface still passes `handle != nil`, and calling
// handle.ID() then dereferences the nil receiver (webview_window.go's ID
// reads a struct field) — so this guard must run before any nil check below.
func asLiveWindow(w application.Window) application.Window {
	if ww, ok := w.(*application.WebviewWindow); ok && ww == nil {
		return nil
	}
	return w
}

// callerRole identifies the actual live handle from beta.16 WindowKey.
// Pass nil for an absent handle, never a typed nil pointer in an interface —
// but a typed nil is normalized defensively rather than trusted from callers.
func callerRole(ctx context.Context, mainWindow, satelliteWindow application.Window) (string, error) {
	mainWindow = asLiveWindow(mainWindow)
	satelliteWindow = asLiveWindow(satelliteWindow)
	window, _ := ctx.Value(application.WindowKey).(application.Window)
	if window == nil {
		return "", fmt.Errorf("golem window: caller window unknown")
	}
	if mainWindow != nil && window.ID() == mainWindow.ID() && window.Name() == mainWindow.Name() {
		return golemWindowRoleMain, nil
	}
	if satelliteWindow != nil && window.ID() == satelliteWindow.ID() && window.Name() == satelliteWindow.Name() {
		return golemWindowRoleSatellite, nil
	}
	return "", fmt.Errorf("golem window: caller is not a current Firn window")
}

// validateGolemWindowMessage enforces the envelope contract: known kind, the
// sender's role may use it, the message targets the live window instance,
// id-bearing kinds carry one, and the payload is bounded.
func validateGolemWindowMessage(msg GolemWindowMessage, from string, instance uint64) error {
	roles, ok := golemWindowKinds[msg.Kind]
	if !ok {
		return fmt.Errorf("golem window: unknown kind %q", msg.Kind)
	}
	if !roles[from] {
		return fmt.Errorf("golem window: kind %s not allowed from %s", msg.Kind, from)
	}
	if msg.Instance != instance || instance == 0 {
		return fmt.Errorf("golem window: stale window instance %d (current %d)", msg.Instance, instance)
	}
	if (msg.Kind == "action" || msg.Kind == "drafts") && msg.ID == 0 {
		return fmt.Errorf("golem window: %s requires an id", msg.Kind)
	}
	if len(msg.Payload) > golemWindowMaxPayload {
		return fmt.Errorf("golem window: payload too large (%d bytes)", len(msg.Payload))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Seams and small accessors
// ---------------------------------------------------------------------------

// golemAfter arms a transition timer through the injectable seam so tests can
// drive ordering without wall-clock sleeps.
func (a *App) golemAfter(d time.Duration, fn func()) golemTimer {
	if a.golemAfterFunc != nil {
		return a.golemAfterFunc(d, fn)
	}
	return time.AfterFunc(d, fn)
}

func stopGolemTimer(t golemTimer) {
	if t != nil {
		t.Stop()
	}
}

// golemStateSnapshot reads the live state under the lock.
func (a *App) golemStateSnapshot() GolemWindowState {
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	return a.golemWin.snapshot()
}

// golemCallerRole verifies the runtime caller against the live handles. The
// handles are snapshotted under the lock and compared outside it.
func (a *App) golemCallerRole(ctx context.Context) (string, error) {
	a.golemWinMu.Lock()
	satellite := a.golemWin.handle
	a.golemWinMu.Unlock()
	return callerRole(ctx, a.mainWindow, satellite)
}

func (a *App) emitGolemState(state GolemWindowState) {
	a.emit(eventGolemWindowMode, state)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// saveGolemPreference serializes app.json writes and drops one that carries an
// older generation than a write already applied: a mutex alone would still let
// a stale captured undocked state overwrite a later docked save. Failures keep
// the UI usable and never overwrite a file that could not be read faithfully.
func (a *App) saveGolemPreference(gen uint64, window appstate.GolemWindow) {
	a.golemSaveMu.Lock()
	defer a.golemSaveMu.Unlock()
	if gen < a.golemSavedGen {
		log.Printf("firn: dropping stale golem window save (generation %d < %d)", gen, a.golemSavedGen)
		return
	}
	a.golemSavedGen = gen
	if a.appStateStore == nil {
		log.Printf("firn: golem window preference not saved: no app state store")
		return
	}
	if err := a.appStateStore.Save(appstate.State{GolemWindow: window}); err != nil {
		log.Printf("firn: golem window preference not saved: %v", err)
	}
}

// loadGolemWindowPreference reads the persisted preference once at startup.
// Live state is docked/closed before Load runs and stays that way on its error
// path; an undocked preference only marks a restore as pending, because the
// frontend restores the window itself once its chat owner is ready.
func (a *App) loadGolemWindowPreference() {
	a.golemWinMu.Lock()
	a.golemWin.mode = appstate.ModeDocked
	a.golemWin.phase = golemPhaseClosed
	a.golemWinMu.Unlock()

	if a.appStateStore == nil {
		log.Printf("firn: golem window preference unavailable: no app state store")
		return
	}
	state, err := a.appStateStore.Load()
	if err != nil {
		log.Printf("firn: golem window preference not read, running on defaults: %v", err)
	}

	a.golemWinMu.Lock()
	a.golemWin.lastNormal = state.GolemWindow
	a.golemWin.restorePending = state.GolemWindow.Mode == appstate.ModeUndocked
	if err != nil {
		// §3.2: reported, not only logged. The startup snapshot is the one
		// state main installs before any attempt, so its reason is the channel
		// this failure has; the store keeps refusing writes for the session, and
		// the text says so.
		// The consequence leads: boundedGolemMessage cuts this text at 200
		// characters, and a long Go error must only ever cost its own tail, never
		// the half that tells the user what it means for the session.
		a.golemWin.reason = fmt.Sprintf(
			"This session runs docked and will not save window changes: the Golem window preference could not be read (%v).",
			err)
	}
	loaded := a.golemWin.snapshot()
	a.golemWinMu.Unlock()
	a.emitGolemState(loaded)
}

// ---------------------------------------------------------------------------
// Pure placement
// ---------------------------------------------------------------------------

// placeGolemWindow picks a reachable frame for the satellite. It is pure: the
// caller supplies the display work areas and the fallback area to centre on
// when the saved display is gone. Negative origins stay valid; file-provided
// coordinates are compared in 64-bit so a hostile value cannot wrap.
func placeGolemWindow(saved appstate.GolemWindow, screens []application.Rect, fallback application.Rect) (appstate.GolemWindow, error) {
	areas := make([]application.Rect, 0, len(screens)+1)
	for _, screen := range screens {
		if screen.Width > 0 && screen.Height > 0 {
			areas = append(areas, screen)
		}
	}
	hasFallback := fallback.Width > 0 && fallback.Height > 0
	if hasFallback {
		areas = append(areas, fallback)
	}
	if len(areas) == 0 {
		return appstate.GolemWindow{}, fmt.Errorf("golem window: no display work area is available for placement")
	}

	width, height := saved.Width, saved.Height
	if width <= 0 {
		width = golemWindowDefaultWidth
	}
	if height <= 0 {
		height = golemWindowDefaultHeight
	}

	target := areas[0]
	if hasFallback {
		target = fallback
	}
	centred := true
	if saved.HasBounds() {
		best := int64(0)
		for _, area := range areas {
			if overlap := golemOverlapArea(saved.X, saved.Y, width, height, area); overlap > best {
				best, target, centred = overlap, area, false
			}
		}
	}

	// §5.3: restore the normal minimums whenever the chosen work area can fit
	// them, so a frame saved while a display was tiny does not stay cramped on a
	// display that is not. A smaller work area lowers the minimum to itself.
	width = max(width, min(golemWindowMinWidth, target.Width))
	height = max(height, min(golemWindowMinHeight, target.Height))

	// Clamp the size to the chosen work area before positioning, so the frame
	// and its titlebar controls are always reachable on it.
	if width > target.Width {
		width = target.Width
	}
	if height > target.Height {
		height = target.Height
	}

	var x, y int
	if centred {
		x = target.X + (target.Width-width)/2
		y = target.Y + (target.Height-height)/2
	} else {
		x = clampGolemAxis(saved.X, target.X, target.X+target.Width-width)
		y = clampGolemAxis(saved.Y, target.Y, target.Y+target.Height-height)
	}
	return appstate.GolemWindow{Mode: saved.Mode, X: x, Y: y, Width: width, Height: height}, nil
}

// golemOverlapArea is the intersection area of a candidate frame with one work
// area, computed in 64-bit so extreme saved coordinates cannot overflow.
func golemOverlapArea(x, y, width, height int, area application.Rect) int64 {
	left := max(int64(x), int64(area.X))
	top := max(int64(y), int64(area.Y))
	right := min(int64(x)+int64(width), int64(area.X)+int64(area.Width))
	bottom := min(int64(y)+int64(height), int64(area.Y)+int64(area.Height))
	if right <= left || bottom <= top {
		return 0
	}
	return (right - left) * (bottom - top)
}

func clampGolemAxis(value, low, high int) int {
	if high < low {
		high = low
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// golemWindowOptions builds the satellite's native options from a placement
// result. The minimums drop below the normal 380x520 only when the reachable
// work area itself is smaller.
func golemWindowOptions(frame appstate.GolemWindow) application.WebviewWindowOptions {
	return application.WebviewWindowOptions{
		Name:            golemWindowNameGolem,
		Title:           golemWindowTitle,
		URL:             golemWindowURL,
		Hidden:          true,
		InitialPosition: application.WindowXY,
		X:               frame.X,
		Y:               frame.Y,
		Width:           frame.Width,
		Height:          frame.Height,
		MinWidth:        min(golemWindowMinWidth, frame.Width),
		MinHeight:       min(golemWindowMinHeight, frame.Height),
		// The same ground and Mac appearance as the main window (main.go).
		BackgroundColour:   firnWindowBackground,
		UseApplicationMenu: true,
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBar{
				AppearsTransparent: true,
				HideTitle:          true,
				FullSizeContent:    true,
			},
			Appearance: application.NSAppearanceNameDarkAqua,
		},
	}
}

// ---------------------------------------------------------------------------
// Bounded retirement observer
// ---------------------------------------------------------------------------

// waitGolemWindowRemoved waits for one authorized close to actually retire.
// Close() returning is not destruction: the framework's own listener runs
// markAsDestroyed, then the native close, and only then Window.Remove, so
// absence of the captured native id from the window manager is the completion
// signal.
func waitGolemWindowRemoved(ctx context.Context, retiringID uint, present func(uint) bool) error {
	// ponytail: no portable retired-window event in beta.16; bounded close-only
	// polling can be replaced when Wails supplies that completion event.
	waitCtx, cancel := context.WithTimeout(ctx, golemRetirementCap)
	defer cancel()
	ticker := time.NewTicker(golemRetirementPoll)
	defer ticker.Stop()
	for {
		if err := waitCtx.Err(); err != nil {
			return err
		}
		if !present(retiringID) {
			return nil
		}
		select {
		case <-waitCtx.Done():
			return waitCtx.Err()
		case <-ticker.C:
		}
	}
}

// observeGolemRetirement runs outside every state and UI lock. Success retires
// only the instance it was started for; cancellation, supersession and a
// permitted quit perform no ownership mutation at all.
func (a *App) observeGolemRetirement(ctx context.Context, id uint, instance, handoff uint64) {
	present := a.golemWindowPresent
	if present == nil {
		present = func(uint) bool { return false }
	}
	err := waitGolemWindowRemoved(ctx, id, present)

	// Lock order: quitPermitted (closeMu) is always read before golemWinMu.
	quitting := a.quitPermitted()

	a.golemWinMu.Lock()
	a.golemWin.observing = false
	if a.golemWin.retiringID != id || a.golemWin.retiringInstance != instance ||
		a.golemWin.retiringHandoff != handoff || !a.golemWin.closeAuthorized {
		a.golemWinMu.Unlock()
		return
	}
	if quitting {
		// Wails' shutdown queues every close and then clears its window map, so
		// absence during a permitted quit proves nothing about a re-dock — and
		// the drain cancelling this observer is not a stall to report either.
		a.golemWinMu.Unlock()
		return
	}
	if err != nil {
		// Published, not only logged: the phase stays closing, and the reason
		// is what lets main offer the retry (CloseGolemWindow re-arms this
		// observer) instead of a Dock button that is disabled for good.
		a.golemWin.retirementFailed = true
		a.golemWin.reason = fmt.Sprintf("The Golem window has not closed within %s; the close is still pending.",
			golemRetirementCap)
		state := a.golemWin.transition()
		a.golemWinMu.Unlock()
		log.Printf("firn: golem window %d has not retired within %s; the close is still pending",
			id, golemRetirementCap)
		a.emitGolemState(state)
		return
	}
	unhook := a.golemWin.unhook
	frame := a.golemWin.lastNormal
	state := a.golemWin.retireLocked()
	gen := a.golemWin.saveGen
	a.golemWinMu.Unlock()

	releaseGolemHooks(unhook)
	a.saveGolemPreference(gen, appstate.GolemWindow{
		Mode: appstate.ModeDocked, X: frame.X, Y: frame.Y, Width: frame.Width, Height: frame.Height,
	})
	a.emitGolemState(state)
}

func releaseGolemHooks(unhook []func()) {
	for _, off := range unhook {
		if off != nil {
			off()
		}
	}
}

// uncommittedLocked reports that the live mode is not persistable yet: it only
// turns undocked at `ready`, so while an attempt is bootstrapping it still reads
// docked even when the file on disk says undocked and the frame in hand came out
// of that same file. Nothing newer than the file exists to write, and writing the
// live mode would silently drop the preference a restore is serving (§5.3 "not
// persisting mode: docked"). Every writer of snapshot().Mode asks this first.
// Call with golemWinMu held.
func (r *golemWindowRuntime) uncommittedLocked() bool {
	return r.phase == golemPhaseBootstrapping || r.phase == golemPhaseBootstrapped
}

// retireLocked clears exactly the retired instance and commits docked mode. It
// never releases hooks itself; the caller does that after unlocking.
func (r *golemWindowRuntime) retireLocked() GolemWindowState {
	r.unhook = nil
	r.handle, r.handleID = nil, 0
	r.phase = golemPhaseClosed
	r.mode = appstate.ModeDocked
	r.restoring = false
	r.instance, r.handoff = 0, 0
	r.view, r.viewRevision = nil, 0
	r.transferID, r.transferAcked = 0, false
	r.closeAuthorized = false
	r.retiringID, r.retiringInstance, r.retiringHandoff = 0, 0, 0
	r.retirementFailed = false
	r.observerCancel = nil
	r.observing = false
	stopGolemTimer(r.deadline)
	r.deadline = nil
	stopGolemTimer(r.saveTimer)
	r.saveTimer = nil
	return r.transition()
}

// ---------------------------------------------------------------------------
// Native reads
// ---------------------------------------------------------------------------

// readGolemFrame reads the live satellite geometry outside the state lock and
// reports whether it is a normal frame. Minimised, maximised and fullscreen
// frames must never replace the saved one.
func (a *App) readGolemFrame() (appstate.GolemWindow, bool) {
	a.golemWinMu.Lock()
	handle := asLiveWindow(a.golemWin.handle)
	a.golemWinMu.Unlock()
	if handle == nil {
		return appstate.GolemWindow{}, false
	}
	if handle.IsMinimised() || handle.IsMaximised() || handle.IsFullscreen() {
		return appstate.GolemWindow{}, false
	}
	rect := handle.Bounds()
	if rect.Width <= 0 || rect.Height <= 0 {
		return appstate.GolemWindow{}, false
	}
	return appstate.GolemWindow{X: rect.X, Y: rect.Y, Width: rect.Width, Height: rect.Height}, true
}

// revealGolemWindow restores, shows and focuses the satellite. Never called
// with golemWinMu held.
func (a *App) revealGolemWindow(handle application.Window) {
	if handle = a.showGolemWindow(handle); handle != nil {
		handle.Focus()
	}
}

// showGolemWindow restores and shows the satellite without asking for focus:
// the startup restore of a saved window is nobody's gesture (§7), so it must
// not take the caret from whichever window the user is working in. Answers
// the live handle, or nil when there is none.
func (a *App) showGolemWindow(handle application.Window) application.Window {
	handle = asLiveWindow(handle)
	if handle == nil {
		return nil
	}
	if handle.IsMinimised() {
		handle.UnMinimise()
	}
	handle.Show()
	return handle
}

// focusMainWindow brings main forward and gives it the keyboard, for the two
// gestures that ask for it by name: a validated satellite config request, and
// the native menu handlers. It is deliberately not on the startup restore path
// — Focus() activates the whole application (§7 forbids that), which is why the
// restore hands key back with Show() alone. mainWindow is installed once before
// App startup; call this with no lifecycle or state mutex held.
func (a *App) focusMainWindow() {
	if a.quitPermitted() {
		return
	}
	window := asLiveWindow(a.mainWindow)
	if window == nil {
		return
	}
	if window.IsMinimised() {
		window.UnMinimise()
	}
	window.Show()
	window.Focus()
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

// installGolemHooks captures this exact handle and instance, so a retired
// window's hooks can never act on a replacement.
func (a *App) installGolemHooks(window application.Window, instance uint64, id uint) []func() {
	return []func(){
		window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
			a.handleGolemWindowClosing(instance, id, event.Cancel)
		}),
		window.RegisterHook(events.Common.WindowDidMove, func(*application.WindowEvent) {
			a.scheduleGolemBoundsSave(instance)
		}),
		window.RegisterHook(events.Common.WindowDidResize, func(*application.WindowEvent) {
			a.scheduleGolemBoundsSave(instance)
		}),
	}
}

// handleGolemWindowClosing is the satellite's WindowClosing hook. The one
// close this instance authorized passes through; anything else is cancelled
// and turned into the same re-dock request the binding makes. It never calls
// shouldQuit and never starts a second quit handshake.
//
// A permitted quit allows destruction. beta.16's cleanup never actually
// dispatches this hook for it (App.cleanup Close()es every window and nils
// the window map under the same lock the event consumer needs, so the queued
// WindowClosing finds no window), which is why the drain saves the frame
// itself in saveGolemFrameForShutdown before the platform quit; the save here
// is only a fallback for a runtime that does dispatch it.
func (a *App) handleGolemWindowClosing(instance uint64, id uint, cancel func()) {
	if a.quitPermitted() {
		a.saveGolemFrameForQuit(instance, id)
		return
	}

	a.golemWinMu.Lock()
	authorized := a.golemWin.closeAuthorized &&
		a.golemWin.retiringInstance == instance && a.golemWin.retiringID == id
	current := a.golemWin.instance == instance && a.golemWin.handleID == id
	a.golemWinMu.Unlock()

	if authorized || !current {
		// The bypass belongs to the captured closing instance alone, and a
		// retired window's hook owns nothing it could cancel.
		return
	}
	cancel()
	if err := a.requestGolemReDock(instance); err != nil {
		log.Printf("firn: golem window native close refused: %v", err)
	}
}

// saveGolemFrameForShutdown is the close drain's last Golem step, run once the
// quit is permitted and before the platform tears the windows down (§5.3
// "quit saves bounds"). It runs on the drain goroutine, so the native geometry
// read is safe, and it is the only reliable point: see handleGolemWindowClosing
// for why the hook cannot be that.
func (a *App) saveGolemFrameForShutdown() {
	a.golemWinMu.Lock()
	instance, id := a.golemWin.instance, a.golemWin.handleID
	a.golemWinMu.Unlock()
	if instance == 0 {
		return
	}
	a.saveGolemFrameForQuit(instance, id)
}

// saveGolemFrameForQuit is the permitted-quit path: save the last normal frame,
// stop every transition, save and retirement timer, and change nothing else.
// The saved mode is the one the drafts are in: an authorized close has already
// handed them to main, so a quit landing between the authorization and the
// retirement persists docked, exactly what the retirement would have.
//
// A quit that lands while an attempt is still bootstrapping writes nothing at
// all: see uncommittedLocked for why the live mode is not the news it looks
// like there.
func (a *App) saveGolemFrameForQuit(instance uint64, id uint) {
	frame, normal := a.readGolemFrame()

	a.golemWinMu.Lock()
	if a.golemWin.instance != instance || a.golemWin.handleID != id {
		a.golemWinMu.Unlock()
		return
	}
	if normal {
		a.golemWin.lastNormal = frame
	}
	stopGolemTimer(a.golemWin.deadline)
	a.golemWin.deadline = nil
	stopGolemTimer(a.golemWin.saveTimer)
	a.golemWin.saveTimer = nil
	if a.golemWin.observerCancel != nil {
		a.golemWin.observerCancel()
		a.golemWin.observerCancel = nil
	}
	a.golemWin.saveGen++
	gen := a.golemWin.saveGen
	saved := a.golemWin.lastNormal
	mode := a.golemWin.snapshot().Mode
	if a.golemWin.closeAuthorized {
		mode = appstate.ModeDocked
	}
	uncommitted := a.golemWin.uncommittedLocked()
	a.golemWinMu.Unlock()

	if uncommitted {
		// The timers above are stopped and saveGen is spent, so no later save can
		// land either; the file keeps exactly the preference it already held.
		return
	}
	a.saveGolemPreference(gen, appstate.GolemWindow{
		Mode: mode, X: saved.X, Y: saved.Y, Width: saved.Width, Height: saved.Height,
	})
}

// scheduleGolemBoundsSave debounces a move/resize burst into one geometry read.
// The hooks are installed before Run(), and every platform moves the window
// while creating it (Windows setPosition → WM_MOVE; macOS installs the delegate
// in windowNew and then setPosition), so this fires for a window that is still
// Hidden and has no user-driven geometry to debounce yet. Nothing is armed
// while the mode is uncommitted; captureGolemFrame checks again when it runs.
func (a *App) scheduleGolemBoundsSave(instance uint64) {
	if a.quitPermitted() {
		return
	}
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	if a.golemWin.instance != instance || a.golemWin.closeAuthorized ||
		a.golemWin.uncommittedLocked() {
		return
	}
	stopGolemTimer(a.golemWin.saveTimer)
	a.golemWin.saveTimer = a.golemAfter(golemBoundsDebounce, func() { a.captureGolemFrame(instance) })
}

// captureGolemFrame reads the geometry outside the state lock and installs it
// only if the capturing instance is still current.
func (a *App) captureGolemFrame(instance uint64) {
	if a.quitPermitted() {
		return
	}
	frame, normal := a.readGolemFrame()
	if !normal {
		return
	}
	a.golemWinMu.Lock()
	if a.golemWin.instance != instance {
		a.golemWinMu.Unlock()
		return
	}
	a.golemWin.lastNormal = frame
	if a.golemWin.uncommittedLocked() {
		// The frame is worth remembering; the mode beside it is not writable yet
		// (uncommittedLocked). Spending no generation leaves the file exactly as
		// the restore found it.
		a.golemWinMu.Unlock()
		return
	}
	a.golemWin.saveGen++
	gen := a.golemWin.saveGen
	mode := a.golemWin.snapshot().Mode
	a.golemWinMu.Unlock()

	a.saveGolemPreference(gen, appstate.GolemWindow{
		Mode: mode, X: frame.X, Y: frame.Y, Width: frame.Width, Height: frame.Height,
	})
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

// golemTransitionTimeout is the one bounded deadline shared by the undock
// bootstrap and the re-dock transfer. It is independent of ordinary action
// completion, and it can never undo an authorized close.
func (a *App) golemTransitionTimeout(instance, handoff uint64) {
	if a.quitPermitted() {
		return
	}
	a.golemWinMu.Lock()
	stale := a.golemWin.instance != instance || a.golemWin.handoff != handoff ||
		a.golemWin.closeAuthorized
	phase := a.golemWin.phase
	a.golemWinMu.Unlock()
	if stale {
		return
	}

	var err error
	switch phase {
	case golemPhaseBootstrapping, golemPhaseBootstrapped:
		err = a.abortGolemAttempt(instance, handoff, "bootstrap deadline expired")
	case golemPhaseClosing:
		err = a.restoreGolemReady(instance, handoff, "draft transfer deadline expired")
	default:
		return
	}
	if err != nil {
		log.Printf("firn: golem window transition deadline could not be applied: %v", err)
	}
}

// abortGolemAttempt closes a hidden bootstrap through the same verified
// completion path an ordinary close uses. It never transfers satellite drafts:
// the satellite has never owned any.
func (a *App) abortGolemAttempt(instance, handoff uint64, reason string) error {
	a.golemWinMu.Lock()
	if a.golemWin.instance != instance || a.golemWin.handoff != handoff {
		current, currentHandoff := a.golemWin.instance, a.golemWin.handoff
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: abort names instance %d/handoff %d, current is %d/%d (%s)",
			instance, handoff, current, currentHandoff, reason)
	}
	if a.golemWin.phase != golemPhaseBootstrapping && a.golemWin.phase != golemPhaseBootstrapped {
		phase := a.golemWin.phase
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: abort is not allowed in phase %s (%s)", phase, reason)
	}
	// Carried by the closing and closed states this abort produces, so main
	// reports the real cause rather than a generic "closed before ready".
	a.golemWin.reason = reason
	a.golemWinMu.Unlock()

	log.Printf("firn: golem window bootstrap aborted: %s", reason)
	return a.authorizeGolemClose(instance)
}

// restoreGolemReady is the authoritative closing→ready transition. It applies
// only before native-close authorization: after it, nothing may restore ready.
// Satellite input ownership is untouched.
func (a *App) restoreGolemReady(instance, handoff uint64, reason string) error {
	a.golemWinMu.Lock()
	if a.golemWin.instance != instance || a.golemWin.handoff != handoff ||
		a.golemWin.phase != golemPhaseClosing || a.golemWin.closeAuthorized {
		phase := a.golemWin.phase
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: cannot return to ready from phase %s for instance %d/handoff %d (%s)",
			phase, instance, handoff, reason)
	}
	a.golemWin.phase = golemPhaseReady
	a.golemWin.transferID, a.golemWin.transferAcked = 0, false
	a.golemWin.reason = reason
	stopGolemTimer(a.golemWin.deadline)
	a.golemWin.deadline = nil
	state := a.golemWin.transition()
	a.golemWinMu.Unlock()

	log.Printf("firn: golem window re-dock returned to ready: %s", reason)
	a.emitGolemState(state)
	return nil
}

// requestGolemReDock is the single closing transition both the binding and the
// native close hook converge on. Repeated requests do not stack; a request made
// while a stalled retirement is outstanding rechecks that same captured id with
// a fresh bounded observer instead of reissuing Close.
func (a *App) requestGolemReDock(instance uint64) error {
	a.golemWinMu.Lock()
	if a.golemWin.instance != instance {
		current := a.golemWin.instance
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: close request names instance %d, current is %d", instance, current)
	}

	switch a.golemWin.phase {
	case golemPhaseClosed:
		a.golemWinMu.Unlock()
		return nil

	case golemPhaseClosing:
		retry := a.golemWin.closeAuthorized && a.golemWin.retirementFailed && !a.golemWin.observing
		if !retry {
			a.golemWinMu.Unlock()
			return nil
		}
		a.golemWin.retirementFailed = false
		a.golemWin.reason = ""
		a.golemWin.observing = true
		observerCtx, cancel := context.WithCancel(context.Background())
		a.golemWin.observerCancel = cancel
		id := a.golemWin.retiringID
		retiringHandoff := a.golemWin.retiringHandoff
		// Published: a closing with the reason cleared is how both hosts learn
		// the retry is running, so the rail disables Dock again meanwhile.
		state := a.golemWin.transition()
		a.golemWinMu.Unlock()
		a.emitGolemState(state)
		go func() {
			// The stored cancel is for a permitted quit; this one just releases
			// the context once the observer is done either way.
			defer cancel()
			a.observeGolemRetirement(observerCtx, id, instance, retiringHandoff)
		}()
		return nil

	case golemPhaseBootstrapping, golemPhaseBootstrapped:
		handoff := a.golemWin.handoff
		a.golemWinMu.Unlock()
		return a.abortGolemAttempt(instance, handoff, "close requested during bootstrap")

	case golemPhaseReady:
		// fall through to the ready→closing transition below
	default:
		phase := a.golemWin.phase
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: close is not allowed in phase %s", phase)
	}

	a.golemWin.phase = golemPhaseClosing
	a.golemWin.handoffSeq++
	a.golemWin.handoff = a.golemWin.handoffSeq
	a.golemWin.transferID, a.golemWin.transferAcked = 0, false
	a.golemWin.reason = ""
	stopGolemTimer(a.golemWin.saveTimer)
	a.golemWin.saveTimer = nil
	stopGolemTimer(a.golemWin.deadline)
	handoff := a.golemWin.handoff
	a.golemWin.deadline = a.golemAfter(golemTransitionDeadline, func() {
		a.golemTransitionTimeout(instance, handoff)
	})
	state := a.golemWin.transition()
	a.golemWinMu.Unlock()

	a.emitGolemState(state)
	return nil
}

// authorizeGolemClose grants this instance the one native close it is allowed,
// issues it outside every lock, and arms the bounded retirement observer. Once
// it returns, a late abort or transfer timeout can no longer restore ready.
func (a *App) authorizeGolemClose(instance uint64) error {
	frame, normal := a.readGolemFrame()

	a.golemWinMu.Lock()
	if a.golemWin.instance != instance {
		current := a.golemWin.instance
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: close authorization names instance %d, current is %d", instance, current)
	}
	if a.golemWin.closeAuthorized {
		a.golemWinMu.Unlock()
		return nil
	}
	handle := asLiveWindow(a.golemWin.handle)
	if handle == nil {
		// Creation never produced a handle, so there is nothing to retire and
		// no observer to arm.
		unhook := a.golemWin.unhook
		state := a.golemWin.retireLocked()
		a.golemWinMu.Unlock()
		releaseGolemHooks(unhook)
		a.emitGolemState(state)
		return nil
	}
	if normal {
		a.golemWin.lastNormal = frame
	}
	a.golemWin.phase = golemPhaseClosing
	a.golemWin.closeAuthorized = true
	a.golemWin.retiringID = a.golemWin.handleID
	a.golemWin.retiringInstance = instance
	a.golemWin.retiringHandoff = a.golemWin.handoff
	a.golemWin.retirementFailed = false
	a.golemWin.observing = true
	stopGolemTimer(a.golemWin.deadline)
	a.golemWin.deadline = nil
	stopGolemTimer(a.golemWin.saveTimer)
	a.golemWin.saveTimer = nil
	observerCtx, cancel := context.WithCancel(context.Background())
	a.golemWin.observerCancel = cancel
	id, retiringHandoff := a.golemWin.retiringID, a.golemWin.retiringHandoff
	state := a.golemWin.transition()
	a.golemWinMu.Unlock()

	a.emitGolemState(state)
	handle.Close()
	go func() {
		// The stored cancel is for a permitted quit; this one just releases the
		// context once the observer is done either way.
		defer cancel()
		a.observeGolemRetirement(observerCtx, id, instance, retiringHandoff)
	}()
	return nil
}

// ---------------------------------------------------------------------------
// Message acceptance
// ---------------------------------------------------------------------------

// checkGolemHandoff enforces the transfer generation: ordinary traffic carries
// handoff 0, lifecycle traffic carries the current nonzero handoff, and an ack
// may be either an ordinary drain ack or the transfer ack.
func checkGolemHandoff(msg GolemWindowMessage, handoff uint64) error {
	switch msg.Kind {
	case "drafts", "ready", "abort":
		if msg.Handoff == 0 || msg.Handoff != handoff {
			return fmt.Errorf("golem window: %s carries handoff %d, current is %d", msg.Kind, msg.Handoff, handoff)
		}
	case "ack":
		if msg.Handoff != 0 && msg.Handoff != handoff {
			return fmt.Errorf("golem window: ack carries handoff %d, current is %d", msg.Handoff, handoff)
		}
	default:
		if msg.Handoff != 0 {
			return fmt.Errorf("golem window: ordinary %s must carry handoff 0, got %d", msg.Kind, msg.Handoff)
		}
	}
	return nil
}

// golemAckAccepted reads the `ok` flag of an ack payload. A transfer ack that
// does not say so is not a successful transfer.
func golemAckAccepted(payload json.RawMessage) (bool, error) {
	var ack struct {
		OK *bool `json:"ok"`
	}
	if err := json.Unmarshal(payload, &ack); err != nil {
		return false, fmt.Errorf("golem window: ack payload is not readable: %w", err)
	}
	if ack.OK == nil {
		return false, fmt.Errorf("golem window: ack payload carries no ok flag")
	}
	return *ack.OK, nil
}

// golemAbortReason reads the bounded display reason of an abort payload.
func golemAbortReason(payload json.RawMessage) (string, error) {
	var abort struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(payload, &abort); err != nil {
		return "", fmt.Errorf("golem window: abort payload is not readable: %w", err)
	}
	reason := strings.TrimSpace(abort.Reason)
	if reason == "" {
		return "", fmt.Errorf("golem window: abort payload carries no reason")
	}
	if len(reason) > golemAbortReasonMax {
		// Same byte bound, but never cut through a multi-byte rune: back up to
		// the last rune start so the reason stays displayable text.
		cut := golemAbortReasonMax
		for cut > 0 && !utf8.RuneStart(reason[cut]) {
			cut--
		}
		reason = reason[:cut]
	}
	return reason, nil
}

// golemActionIsOpenConfig reports whether the payload is exactly
// {"type":"openConfig"} — nothing else may move main's focus.
func golemActionIsOpenConfig(payload json.RawMessage) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil || len(fields) != 1 {
		return false
	}
	raw, ok := fields["type"]
	if !ok {
		return false
	}
	var kind string
	return json.Unmarshal(raw, &kind) == nil && kind == "openConfig"
}

func (a *App) acceptGolemView(instance uint64, msg GolemWindowMessage) error {
	if len(msg.Payload) == 0 || string(msg.Payload) == "null" {
		return fmt.Errorf("golem window: view carries no projection")
	}
	if msg.Revision == 0 {
		return fmt.Errorf("golem window: view requires a revision")
	}
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	if a.golemWin.instance != instance {
		return fmt.Errorf("golem window: view names retired instance %d", instance)
	}
	if msg.Revision <= a.golemWin.viewRevision {
		return fmt.Errorf("golem window: view revision %d is not newer than the retained %d",
			msg.Revision, a.golemWin.viewRevision)
	}
	a.golemWin.view = append(json.RawMessage(nil), msg.Payload...)
	a.golemWin.viewRevision = msg.Revision
	return nil
}

// acceptGolemDrafts records the draft-map id for the current handoff: main's
// map while the satellite is bootstrapping, the satellite's final map while it
// is re-docking.
func (a *App) acceptGolemDrafts(instance uint64, from string, msg GolemWindowMessage) error {
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	if a.golemWin.instance != instance {
		return fmt.Errorf("golem window: drafts name retired instance %d", instance)
	}
	phase := a.golemWin.phase
	if from == golemWindowRoleMain {
		if phase != golemPhaseBootstrapping && phase != golemPhaseBootstrapped {
			return fmt.Errorf("golem window: main may only transfer drafts while the window bootstraps, not in phase %s", phase)
		}
	} else if phase != golemPhaseClosing {
		return fmt.Errorf("golem window: the Golem window may only transfer drafts while re-docking, not in phase %s", phase)
	} else if a.golemWin.mode != appstate.ModeUndocked {
		// An aborted bootstrap closes through the same closing phase, but the
		// satellite never owned main's map (mode flips to undocked only on
		// ready), so the "final map" it would return is empty. Installing it
		// would erase the docked composer (§5.1).
		return fmt.Errorf("golem window: the Golem window never became ready, so it has no drafts to return")
	}
	if a.golemWin.transferID != 0 && a.golemWin.transferID != msg.ID {
		return fmt.Errorf("golem window: draft transfer id %d replaces the recorded %d for this handoff",
			msg.ID, a.golemWin.transferID)
	}
	a.golemWin.transferID = msg.ID
	a.golemWin.transferAcked = false
	return nil
}

// acceptGolemAck records a successful main acknowledgement of the satellite's
// final draft map. Ordinary drain acks carry handoff 0 and are relayed only.
func (a *App) acceptGolemAck(instance uint64, from string, msg GolemWindowMessage) error {
	if msg.Handoff == 0 {
		return nil
	}
	if from != golemWindowRoleMain {
		return fmt.Errorf("golem window: only main acknowledges a draft transfer")
	}
	accepted, err := golemAckAccepted(msg.Payload)
	if err != nil {
		return err
	}
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	if a.golemWin.instance != instance || a.golemWin.phase != golemPhaseClosing {
		return fmt.Errorf("golem window: a transfer ack is not allowed in phase %s", a.golemWin.phase)
	}
	if a.golemWin.transferID == 0 || msg.Revision != a.golemWin.transferID {
		return fmt.Errorf("golem window: transfer ack names id %d, the recorded final draft id is %d",
			msg.Revision, a.golemWin.transferID)
	}
	a.golemWin.transferAcked = accepted
	return nil
}

// acceptGolemAction admits satellite actions while the window is ready, and
// while it drains during a re-dock. A validated openConfig focuses main before
// the action is relayed; main still owns the actual config-tab action.
func (a *App) acceptGolemAction(instance uint64, msg GolemWindowMessage) error {
	a.golemWinMu.Lock()
	live := a.golemWin.instance == instance &&
		(a.golemWin.phase == golemPhaseReady || a.golemWin.phase == golemPhaseClosing)
	phase := a.golemWin.phase
	a.golemWinMu.Unlock()
	if !live {
		return fmt.Errorf("golem window: actions are not accepted in phase %s", phase)
	}
	if golemActionIsOpenConfig(msg.Payload) {
		a.focusMainWindow()
	}
	return nil
}

// acceptGolemReady is the authoritative undock commit. No ready state is
// published before a valid view exists and the satellite confirms the exact
// recorded main draft id for the current handoff.
func (a *App) acceptGolemReady(instance uint64, msg GolemWindowMessage) error {
	if a.quitPermitted() {
		return fmt.Errorf("golem window: the application is quitting; readiness is not committed")
	}

	a.golemWinMu.Lock()
	if a.golemWin.instance != instance {
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: ready names retired instance %d", instance)
	}
	if a.golemWin.phase == golemPhaseReady {
		// A mismatch here is currently unreachable — only a re-dock resets the
		// transfer id, and that leaves ready — but the check is kept so a future
		// reset reports the duplicate rather than silently accepting it.
		recorded := a.golemWin.transferID
		a.golemWinMu.Unlock()
		if msg.Revision != recorded {
			return fmt.Errorf("golem window: ready names draft id %d, the recorded transfer is %d",
				msg.Revision, recorded)
		}
		return nil
	}
	if a.golemWin.phase != golemPhaseBootstrapped {
		phase := a.golemWin.phase
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: ready is not allowed in phase %s", phase)
	}
	if len(a.golemWin.view) == 0 {
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: no projection has been published for this instance yet")
	}
	if a.golemWin.transferID == 0 || msg.Revision != a.golemWin.transferID {
		recorded := a.golemWin.transferID
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: ready names draft id %d, the recorded main transfer is %d",
			msg.Revision, recorded)
	}

	a.golemWin.phase = golemPhaseReady
	a.golemWin.mode = appstate.ModeUndocked
	a.golemWin.restorePending = false
	stopGolemTimer(a.golemWin.deadline)
	a.golemWin.deadline = nil
	handle := a.golemWin.handle
	restoring := a.golemWin.restoring
	frame := a.golemWin.lastNormal
	state := a.golemWin.transition()
	gen := a.golemWin.saveGen
	a.golemWinMu.Unlock()

	a.saveGolemPreference(gen, appstate.GolemWindow{
		Mode: appstate.ModeUndocked, X: frame.X, Y: frame.Y, Width: frame.Width, Height: frame.Height,
	})
	a.emitGolemState(state)
	if restoring {
		// §7: a startup restore is not the user's gesture, so the window may
		// appear but must never take OS focus. Skipping Focus() is not enough on
		// its own — every platform's Show() makes the window it reveals key
		// within the app (macOS makeKeyAndOrderFront:, Windows SW_SHOW, Linux
		// gtk_window_present) — so main is ordered back in front afterwards with
		// that same Show(). It is the same call the satellite just made, and it
		// is deliberately not Focus(): Focus activates the whole application over
		// whatever the user switched to (macOS activateIgnoringOtherApps:YES,
		// Windows SetForegroundWindow), which is exactly what §7 forbids. So the
		// hand-back is unconditional — main's key status is never read, and there
		// is nothing to go stale between the two calls. A minimised main is left
		// alone: un-minimising a window the user put away would be a larger
		// intrusion than the satellite keeping key. On one display the restored
		// window ends up behind main when their frames overlap; the rail's
		// "Focus Golem window" is the way to it.
		a.showGolemWindow(handle)
		if main := asLiveWindow(a.mainWindow); main != nil && !main.IsMinimised() {
			main.Show()
		}
	} else {
		a.revealGolemWindow(handle)
	}
	return nil
}

// acceptGolemAbort applies only to the matching active handoff and can never
// undo a committed readiness, an authorized close, or a permitted quit.
func (a *App) acceptGolemAbort(instance uint64, msg GolemWindowMessage) error {
	if a.quitPermitted() {
		return fmt.Errorf("golem window: the application is quitting; abort changes nothing")
	}
	reason, err := golemAbortReason(msg.Payload)
	if err != nil {
		return err
	}

	a.golemWinMu.Lock()
	current := a.golemWin.instance == instance && a.golemWin.handoff == msg.Handoff
	authorized := a.golemWin.closeAuthorized
	phase := a.golemWin.phase
	a.golemWinMu.Unlock()

	if !current || authorized {
		return fmt.Errorf("golem window: abort names a transition that can no longer be undone (phase %s)", phase)
	}
	switch phase {
	case golemPhaseBootstrapping, golemPhaseBootstrapped:
		return a.abortGolemAttempt(instance, msg.Handoff, reason)
	case golemPhaseClosing:
		return a.restoreGolemReady(instance, msg.Handoff, reason)
	default:
		return fmt.Errorf("golem window: abort is not allowed in phase %s", phase)
	}
}

// ---------------------------------------------------------------------------
// Bound methods
// ---------------------------------------------------------------------------

// GetGolemWindowState returns the live window state. Both current windows read
// it; consumers reject a snapshot whose stateRevision is older than one they
// already applied.
// This is exposed to the frontend via Wails bindings.
func (a *App) GetGolemWindowState(ctx context.Context) (GolemWindowState, error) {
	if _, err := a.golemCallerRole(ctx); err != nil {
		return GolemWindowState{}, err
	}
	return a.golemStateSnapshot(), nil
}

// OpenGolemWindow undocks the Golem chat into its own native window. It is
// idempotent: a repeated call during bootstrap returns the same in-progress
// attempt, and a call while ready restores and focuses the live window.
// This is exposed to the frontend via Wails bindings.
func (a *App) OpenGolemWindow(ctx context.Context) error {
	if a.quitPermitted() {
		return fmt.Errorf("golem window: the application is quitting")
	}
	role, err := a.golemCallerRole(ctx)
	if err != nil {
		return err
	}
	if role != golemWindowRoleMain {
		return fmt.Errorf("golem window: only the main window may open the Golem window")
	}

	a.golemWinMu.Lock()
	switch a.golemWin.phase {
	case golemPhaseReady:
		handle := a.golemWin.handle
		a.golemWinMu.Unlock()
		a.revealGolemWindow(handle)
		return nil
	case golemPhaseBootstrapping, golemPhaseBootstrapped:
		a.golemWinMu.Unlock()
		return nil
	case golemPhaseClosing:
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: a re-dock is still completing; retry once it finishes")
	}

	// closed → bootstrapping: reserve a fresh instance and handoff and reset
	// every projection and transfer counter this attempt owns.
	a.golemWin.instanceSeq++
	a.golemWin.handoffSeq++
	a.golemWin.instance = a.golemWin.instanceSeq
	a.golemWin.handoff = a.golemWin.handoffSeq
	a.golemWin.phase = golemPhaseBootstrapping
	// Startup restoration stays pending only until the first attempted restore,
	// so a failure cannot become an automatic reopen loop. The attempt remembers
	// that it is the restore: ready then shows the window without focusing it.
	a.golemWin.restoring = a.golemWin.restorePending
	a.golemWin.restorePending = false
	a.golemWin.view, a.golemWin.viewRevision = nil, 0
	a.golemWin.transferID, a.golemWin.transferAcked = 0, false
	a.golemWin.retirementFailed = false
	a.golemWin.reason = ""
	instance, handoff := a.golemWin.instance, a.golemWin.handoff
	saved := a.golemWin.lastNormal
	a.golemWinMu.Unlock()

	window, frame, err := a.createGolemWindow(saved, instance)
	if err != nil {
		a.abandonGolemOpen(instance)
		return err
	}
	id := window.ID()
	unhook := a.installGolemHooks(window, instance, id)

	a.golemWinMu.Lock()
	if a.golemWin.instance != instance || a.golemWin.phase != golemPhaseBootstrapping ||
		a.golemWin.handle != nil {
		a.golemWinMu.Unlock()
		releaseGolemHooks(unhook)
		window.Close()
		return fmt.Errorf("golem window: open attempt %d was superseded", instance)
	}
	a.golemWin.handle = window
	a.golemWin.handleID = id
	a.golemWin.unhook = unhook
	// The placed frame is the window's real geometry until a move or resize
	// reads a live one, so the first save after a fresh undock never persists
	// an empty frame.
	a.golemWin.lastNormal = frame
	a.golemWin.deadline = a.golemAfter(golemTransitionDeadline, func() {
		a.golemTransitionTimeout(instance, handoff)
	})
	state := a.golemWin.transition()
	a.golemWinMu.Unlock()

	// Published only once the handle and its hooks exist, and before the
	// window can run and ask to bootstrap.
	a.emitGolemState(state)
	if a.v3app != nil {
		a.v3app.Window.Add(window)
	}
	window.Run()

	// A close or abort that landed in the gap above found an un-run window:
	// Close() was a no-op and the manager never knew the id, so the observer
	// already retired the instance and released the hooks. What ran here is then
	// an orphan, and only this Close — after Run, with no hooks left to cancel
	// it — actually destroys it.
	a.golemWinMu.Lock()
	retired := a.golemWin.instance != instance || a.golemWin.handle != window
	a.golemWinMu.Unlock()
	if retired {
		window.Close()
		return fmt.Errorf("golem window: open attempt %d was retired before its window ran", instance)
	}
	return nil
}

// createGolemWindow resolves the placement and builds the unstarted window,
// answering with the frame it was placed at. Every call here is native, so
// none of it runs under golemWinMu.
func (a *App) createGolemWindow(saved appstate.GolemWindow, instance uint64) (application.Window, appstate.GolemWindow, error) {
	if a.golemWindowFactory == nil {
		return nil, appstate.GolemWindow{}, fmt.Errorf("golem window: no window factory is installed")
	}
	var screens []application.Rect
	if a.screenBounds != nil {
		screens = a.screenBounds()
	}
	fallback := application.Rect{}
	if len(screens) > 0 {
		fallback = screens[0]
	}
	frame, err := placeGolemWindow(saved, screens, fallback)
	if err != nil {
		return nil, appstate.GolemWindow{}, err
	}
	window := asLiveWindow(a.golemWindowFactory(golemWindowOptions(frame)))
	if window == nil {
		return nil, appstate.GolemWindow{}, fmt.Errorf("golem window: the window factory produced no window for attempt %d", instance)
	}
	return window, frame, nil
}

// abandonGolemOpen rolls a reservation back to closed when creation failed
// before any handle or hook existed. The instance number is never reused.
func (a *App) abandonGolemOpen(instance uint64) {
	a.golemWinMu.Lock()
	if a.golemWin.instance != instance || a.golemWin.handle != nil ||
		a.golemWin.phase != golemPhaseBootstrapping {
		a.golemWinMu.Unlock()
		return
	}
	state := a.golemWin.retireLocked()
	a.golemWinMu.Unlock()
	a.emitGolemState(state)
}

// FocusGolemWindow restores, shows and focuses a ready Golem window. Closed is
// a no-op, and an in-progress transition never exposes the hidden window.
// This is exposed to the frontend via Wails bindings.
func (a *App) FocusGolemWindow(ctx context.Context) error {
	role, err := a.golemCallerRole(ctx)
	if err != nil {
		return err
	}
	if role != golemWindowRoleMain {
		return fmt.Errorf("golem window: only the main window may focus the Golem window")
	}
	a.golemWinMu.Lock()
	handle := a.golemWin.handle
	ready := a.golemWin.phase == golemPhaseReady
	a.golemWinMu.Unlock()
	if !ready {
		return nil
	}
	a.revealGolemWindow(handle)
	return nil
}

// CloseGolemWindow requests a re-dock. It does not destroy the window: the
// satellite still owns its input until it has transferred its final draft map
// and confirmed the close.
// This is exposed to the frontend via Wails bindings.
func (a *App) CloseGolemWindow(ctx context.Context) error {
	if a.quitPermitted() {
		return fmt.Errorf("golem window: the application is quitting")
	}
	if _, err := a.golemCallerRole(ctx); err != nil {
		return err
	}
	// A retiring instance is still the live one: only a completed retirement
	// clears it, and that also clears the closing phase this recovers.
	a.golemWinMu.Lock()
	instance := a.golemWin.instance
	a.golemWinMu.Unlock()
	if instance == 0 {
		return nil
	}
	return a.requestGolemReDock(instance)
}

// ConfirmGolemWindowClose is the current satellite reporting that main has
// acknowledged its final draft map. It grants the one per-instance native close
// authorization; nothing else may destroy the window.
// This is exposed to the frontend via Wails bindings.
func (a *App) ConfirmGolemWindowClose(ctx context.Context, instance uint64, handoff uint64) error {
	if a.quitPermitted() {
		return fmt.Errorf("golem window: the application is quitting; the close is not confirmed")
	}
	role, err := a.golemCallerRole(ctx)
	if err != nil {
		return err
	}
	if role != golemWindowRoleSatellite {
		return fmt.Errorf("golem window: only the Golem window may confirm its own close")
	}

	a.golemWinMu.Lock()
	if a.golemWin.instance != instance || a.golemWin.handoff != handoff {
		current, currentHandoff := a.golemWin.instance, a.golemWin.handoff
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: confirm names instance %d/handoff %d, current is %d/%d",
			instance, handoff, current, currentHandoff)
	}
	if a.golemWin.mode != appstate.ModeUndocked {
		// Before the idempotent short-circuit: an aborted bootstrap already
		// holds its close authorization, and a confirm from a window that never
		// became ready is not a repeat of that, it is a transfer that never was.
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: the Golem window never became ready, so there is no transfer to confirm")
	}
	if a.golemWin.closeAuthorized {
		a.golemWinMu.Unlock()
		return nil
	}
	if a.golemWin.phase != golemPhaseClosing {
		phase := a.golemWin.phase
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: confirm is not allowed in phase %s", phase)
	}
	if a.golemWin.transferID == 0 || !a.golemWin.transferAcked {
		a.golemWinMu.Unlock()
		return fmt.Errorf("golem window: main has not acknowledged the final draft map")
	}
	a.golemWinMu.Unlock()

	return a.authorizeGolemClose(instance)
}

// BootstrapGolemWindow is the satellite's first read: the live state plus the
// latest projection main published. It is idempotent for the current instance.
// This is exposed to the frontend via Wails bindings.
func (a *App) BootstrapGolemWindow(ctx context.Context) (GolemWindowBootstrap, error) {
	role, err := a.golemCallerRole(ctx)
	if err != nil {
		return GolemWindowBootstrap{}, err
	}
	if role != golemWindowRoleSatellite {
		return GolemWindowBootstrap{}, fmt.Errorf("golem window: only the Golem window may bootstrap")
	}

	a.golemWinMu.Lock()
	if a.golemWin.phase == golemPhaseClosed {
		a.golemWinMu.Unlock()
		return GolemWindowBootstrap{}, fmt.Errorf("golem window: there is no live Golem window instance")
	}
	advanced := a.golemWin.phase == golemPhaseBootstrapping
	if advanced {
		a.golemWin.phase = golemPhaseBootstrapped
	}
	state := a.golemWin.snapshot()
	if advanced {
		state = a.golemWin.transition()
	}
	boot := GolemWindowBootstrap{
		State:    state,
		View:     a.golemWin.view,
		Revision: a.golemWin.viewRevision,
	}
	a.golemWinMu.Unlock()

	if advanced {
		a.emitGolemState(state)
	}
	return boot, nil
}

// PostGolemWindowMessage relays one message between the two windows. Go
// validates the envelope, the sender's role, the live instance, the transfer
// generation and the phase; it never interprets a projection or an action.
// This is exposed to the frontend via Wails bindings.
func (a *App) PostGolemWindowMessage(ctx context.Context, msg GolemWindowMessage) error {
	role, err := a.golemCallerRole(ctx)
	if err != nil {
		return err
	}

	a.golemWinMu.Lock()
	instance := a.golemWin.instance
	handoff := a.golemWin.handoff
	phase := a.golemWin.phase
	a.golemWinMu.Unlock()

	if err := validateGolemWindowMessage(msg, role, instance); err != nil {
		return err
	}
	if phase == golemPhaseClosed {
		return fmt.Errorf("golem window: there is no live window to relay %s to", msg.Kind)
	}
	if err := checkGolemHandoff(msg, handoff); err != nil {
		return err
	}

	switch msg.Kind {
	case "view":
		err = a.acceptGolemView(instance, msg)
	case "drafts":
		err = a.acceptGolemDrafts(instance, role, msg)
	case "ack":
		err = a.acceptGolemAck(instance, role, msg)
	case "action":
		err = a.acceptGolemAction(instance, msg)
	case "ready":
		err = a.acceptGolemReady(instance, msg)
	case "abort":
		err = a.acceptGolemAbort(instance, msg)
	default:
		err = fmt.Errorf("golem window: kind %q has no relay rule", msg.Kind)
	}
	if err != nil {
		return err
	}
	return a.relayGolemEnvelope(GolemWindowEnvelope{From: role, Message: msg})
}

// relayGolemEnvelope delivers one accepted message to the other window only.
// The app-wide event bus fans every emit out to both windows, which made main
// JSON-parse its own projection on every publish and the satellite parse every
// action echo; WebviewWindow.DispatchWailsEvent is the per-window leg of that
// same fan-out (event_manager.go dispatch → listener.DispatchWailsEvent).
// The lifecycle state (golem:window-mode) stays app-wide: both windows read it.
//
// Two consequences of skipping the app-wide mailbox, both deliberate:
//   - A relayed message may arrive BEFORE the state emitted just ahead of it
//     (Event.Emit queues on the single frontendEvents mailbox; this call does
//     not). That is the normal order here, not an exception: acceptGolemReady
//     emits ready then relays it, and requestGolemReDock emits closing before
//     the satellite's drafts follow. Both relays hold an envelope that names a
//     revision they have not seen and replay it after the state catches up,
//     and the satellite buffers everything until its own bootstrap answers, so
//     nothing is delivered against a stale snapshot. Both holds are bounded —
//     PENDING_ENVELOPE_LIMIT = 32 envelopes in main, SATELLITE_STARTUP_BUFFER =
//     64 in the satellite — and an overflow fails loudly (main toasts and drops
//     the envelope, the satellite fails its startup) rather than delivering the
//     message against a snapshot it does not match.
//   - The bound call now blocks on the recipient's own event queue instead of
//     the app-wide mailbox. A satellite whose UI thread is not draining (a
//     macOS window drag is a tracking loop) stalls this relay alone, where it
//     used to park every window's events behind the same queue.
func (a *App) relayGolemEnvelope(envelope GolemWindowEnvelope) error {
	a.golemWinMu.Lock()
	satellite := asLiveWindow(a.golemWin.handle)
	a.golemWinMu.Unlock()

	target, name := asLiveWindow(a.mainWindow), golemWindowNameMain
	if envelope.From == golemWindowRoleMain {
		target, name = satellite, golemWindowNameGolem
	}
	if target == nil {
		if envelope.Message.Kind == "view" {
			// Retained by acceptGolemView and served by BootstrapGolemWindow:
			// a projection that arrives before the handle exists is delivered by
			// the bootstrap, not lost.
			return nil
		}
		return fmt.Errorf("golem window: no live %s window to relay %s to", name, envelope.Message.Kind)
	}
	target.DispatchWailsEvent(&application.CustomEvent{Name: eventGolemWindowMessage, Data: envelope})
	return nil
}
