package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"firn/internal/appstate"
	"firn/internal/filesystem"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// The fakes below stand in for the runtime's window and window manager. The
// real *application.WebviewWindow must keep satisfying the same interface, or
// the production handles and these fakes have drifted apart.
var _ application.Window = (*application.WebviewWindow)(nil)

// ---------------------------------------------------------------------------
// Fake native window
// ---------------------------------------------------------------------------

// fakeNative extends B1's fakeWindow with the lifecycle surface. Every native
// call runs `reenter`, which reads App state: a caller that still holds
// golemWinMu deadlocks here, which is exactly the rule the state machine must
// never break.
type fakeNative struct {
	fakeWindow

	mu         sync.Mutex
	calls      []string
	hooks      map[events.WindowEventType][]func(*application.WindowEvent)
	bounds     application.Rect
	minimised  bool
	maximised  bool
	fullscreen bool
	reenter    func()
	// onRun runs inside Run(), which is where the production code registers and
	// starts the window. It is the only point a test can act between publishing
	// the bootstrapping state and OpenGolemWindow returning.
	onRun func()
	// dispatched is every custom event delivered to THIS window: the relay
	// targets the recipient, so which fake holds an envelope is the assertion.
	dispatched []*application.CustomEvent
}

// DispatchWailsEvent is the per-window leg of Wails' event fan-out. Not
// recorded in `calls`: tests compare those to the exact native calls a
// transition makes, and delivery is not one of them.
func (f *fakeNative) DispatchWailsEvent(event *application.CustomEvent) {
	f.mu.Lock()
	f.dispatched = append(f.dispatched, event)
	f.mu.Unlock()
	f.probe()
}

// received returns the relay envelopes delivered to this window, in order.
func (f *fakeNative) received() []GolemWindowEnvelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []GolemWindowEnvelope
	for _, event := range f.dispatched {
		if event.Name != eventGolemWindowMessage {
			continue
		}
		envelope, ok := event.Data.(GolemWindowEnvelope)
		if !ok {
			panic(fmt.Sprintf("%s payload = %T, want GolemWindowEnvelope", eventGolemWindowMessage, event.Data))
		}
		out = append(out, envelope)
	}
	return out
}

func newFakeNative(id uint, name string) *fakeNative {
	return &fakeNative{fakeWindow: fakeWindow{id: id, name: name}}
}

func (f *fakeNative) probe() {
	f.mu.Lock()
	r := f.reenter
	f.mu.Unlock()
	if r != nil {
		r()
	}
}

func (f *fakeNative) record(name string) {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	f.mu.Unlock()
	f.probe()
}

func (f *fakeNative) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeNative) countOf(name string) int {
	n := 0
	for _, call := range f.recorded() {
		if call == name {
			n++
		}
	}
	return n
}

func (f *fakeNative) Show() application.Window { f.record("show"); return f }
func (f *fakeNative) Focus()                   { f.record("focus") }
func (f *fakeNative) Close()                   { f.record("close") }
func (f *fakeNative) UnMinimise()              { f.record("unminimise") }
func (f *fakeNative) Restore()                 { f.record("restore") }
func (f *fakeNative) SetSize(w, h int) application.Window {
	f.record("setSize")
	return f
}

func (f *fakeNative) Run() {
	f.record("run")
	f.mu.Lock()
	onRun := f.onRun
	f.mu.Unlock()
	if onRun != nil {
		onRun()
	}
}

func (f *fakeNative) IsMinimised() bool {
	f.probe()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.minimised
}

func (f *fakeNative) IsMaximised() bool {
	f.probe()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maximised
}

func (f *fakeNative) IsFullscreen() bool {
	f.probe()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fullscreen
}

func (f *fakeNative) Bounds() application.Rect {
	f.probe()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bounds
}

func (f *fakeNative) setFrame(r application.Rect) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bounds = r
}

func (f *fakeNative) RegisterHook(
	eventType events.WindowEventType,
	callback func(event *application.WindowEvent),
) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.hooks == nil {
		f.hooks = map[events.WindowEventType][]func(*application.WindowEvent){}
	}
	f.hooks[eventType] = append(f.hooks[eventType], callback)
	index := len(f.hooks[eventType]) - 1
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.hooks[eventType][index] = nil
	}
}

// fire delivers one hook event and reports whether a hook cancelled it.
func (f *fakeNative) fire(eventType events.WindowEventType) bool {
	f.mu.Lock()
	hooks := append([](func(*application.WindowEvent)){}, f.hooks[eventType]...)
	f.mu.Unlock()
	event := application.NewWindowEvent()
	for _, hook := range hooks {
		if hook == nil {
			continue
		}
		hook(event)
	}
	return event.IsCancelled()
}

func (f *fakeNative) hookCount(eventType events.WindowEventType) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	live := 0
	for _, hook := range f.hooks[eventType] {
		if hook != nil {
			live++
		}
	}
	return live
}

// ---------------------------------------------------------------------------
// Fake timer
// ---------------------------------------------------------------------------

type fakeTimer struct {
	mu      sync.Mutex
	delay   time.Duration
	fn      func()
	stopped bool
	fired   bool
}

func (t *fakeTimer) Stop() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	already := t.stopped || t.fired
	t.stopped = true
	return !already
}

// fire runs the callback the way a live timer would: a stopped timer stays
// silent.
func (t *fakeTimer) fire() {
	t.mu.Lock()
	if t.stopped || t.fired {
		t.mu.Unlock()
		return
	}
	t.fired = true
	fn := t.fn
	t.mu.Unlock()
	fn()
}

// fireRegardless models the runtime race the generation check exists for: a
// timer that had already fired into the runtime before Stop reached it.
func (t *fakeTimer) fireRegardless() {
	t.mu.Lock()
	fn := t.fn
	t.mu.Unlock()
	fn()
}

func (t *fakeTimer) isStopped() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stopped
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type golemEvent struct {
	name string
	data any
}

type golemHarness struct {
	t       *testing.T
	app     *App
	mainWin *fakeNative

	// filesMu guards the mock filesystem: the retirement observer writes
	// app.json from its own goroutine while the test reads it.
	filesMu sync.Mutex
	files   map[string][]byte

	mu       sync.Mutex
	events   []golemEvent
	created  []*fakeNative
	present  map[uint]bool
	timers   []*fakeTimer
	screens  []application.Rect
	nextID   uint
	failNext bool
	options  []application.WebviewWindowOptions
	onCreate func(*fakeNative)
}

var golemTestFirnDir = filepath.FromSlash("/home/user/.firn")

func newGolemHarness(t *testing.T) *golemHarness {
	t.Helper()

	dirs := map[string]bool{}
	h := &golemHarness{
		t:       t,
		mainWin: newFakeNative(1, golemWindowNameMain),
		files:   map[string][]byte{},
		present: map[uint]bool{},
		screens: []application.Rect{{X: 0, Y: 0, Width: 2560, Height: 1440}},
		nextID:  100,
	}
	mockFS := &filesystem.Mock{
		ReadFileFunc: func(path string) ([]byte, error) {
			data, ok := h.readFile(path)
			if !ok {
				return nil, fs.ErrNotExist
			}
			return data, nil
		},
		WriteFileFunc: func(path string, data []byte, _ fs.FileMode) error {
			h.writeFile(path, data)
			return nil
		},
		RemoveFunc: func(path string) error { h.removeFile(path); return nil },
		RenameFunc: func(oldPath, newPath string) error {
			data, ok := h.readFile(oldPath)
			if !ok {
				return fs.ErrNotExist
			}
			h.writeFile(newPath, data)
			h.removeFile(oldPath)
			return nil
		},
		MkdirAllFunc: func(path string, _ fs.FileMode) error {
			h.filesMu.Lock()
			defer h.filesMu.Unlock()
			dirs[path] = true
			return nil
		},
		ReadDirFunc: func(path string) ([]fs.DirEntry, error) {
			h.filesMu.Lock()
			defer h.filesMu.Unlock()
			if !dirs[path] {
				return nil, fs.ErrNotExist
			}
			return nil, nil
		},
	}

	app := &App{
		mainWindow:    h.mainWin,
		appStateStore: appstate.NewStore(mockFS, golemTestFirnDir),
	}
	app.emitFn = func(event string, data any) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.events = append(h.events, golemEvent{name: event, data: data})
	}
	app.screenBounds = func() []application.Rect {
		h.mu.Lock()
		defer h.mu.Unlock()
		return append([]application.Rect(nil), h.screens...)
	}
	app.golemWindowPresent = func(id uint) bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return h.present[id]
	}
	app.golemWindowFactory = func(options application.WebviewWindowOptions) application.Window {
		h.mu.Lock()
		if h.failNext {
			h.failNext = false
			h.mu.Unlock()
			return nil
		}
		id := h.nextID
		h.nextID++
		window := newFakeNative(id, options.Name)
		window.reenter = func() { _ = app.golemStateSnapshot() }
		h.created = append(h.created, window)
		h.options = append(h.options, options)
		h.present[id] = true
		onCreate := h.onCreate
		h.mu.Unlock()
		if onCreate != nil {
			onCreate(window)
		}
		return window
	}
	app.golemAfterFunc = func(d time.Duration, fn func()) golemTimer {
		timer := &fakeTimer{delay: d, fn: fn}
		h.mu.Lock()
		h.timers = append(h.timers, timer)
		h.mu.Unlock()
		return timer
	}
	// The satellite is never registered with a live manager in tests; the fake
	// manager map above is the only membership the observer reads.
	h.app = app
	h.mainWin.reenter = func() { _ = app.golemStateSnapshot() }
	return h
}

func (h *golemHarness) satellite() *fakeNative {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.created) == 0 {
		h.t.Fatal("no satellite window was created")
	}
	return h.created[len(h.created)-1]
}

func (h *golemHarness) createdCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.created)
}

func (h *golemHarness) lastOptions() application.WebviewWindowOptions {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.options) == 0 {
		h.t.Fatal("no window options were built")
	}
	return h.options[len(h.options)-1]
}

func (h *golemHarness) retire(id uint) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.present, id)
}

func (h *golemHarness) isPresent(id uint) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.present[id]
}

func (h *golemHarness) setScreens(screens []application.Rect) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.screens = screens
}

// onNewWindow installs a callback the fake factory runs on each window it
// builds, before OpenGolemWindow has installed the handle.
func (h *golemHarness) onNewWindow(fn func(*fakeNative)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onCreate = fn
}

func (h *golemHarness) failFactoryOnce() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.failNext = true
}

func (h *golemHarness) liveTimers() []*fakeTimer {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]*fakeTimer(nil), h.timers...)
}

// pendingTimer returns the most recent timer that is neither stopped nor fired.
func (h *golemHarness) pendingTimer() *fakeTimer {
	timers := h.liveTimers()
	for i := len(timers) - 1; i >= 0; i-- {
		timers[i].mu.Lock()
		live := !timers[i].stopped && !timers[i].fired
		timers[i].mu.Unlock()
		if live {
			return timers[i]
		}
	}
	h.t.Fatal("no pending timer")
	return nil
}

func (h *golemHarness) modeEvents() []GolemWindowState {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []GolemWindowState
	for _, e := range h.events {
		if e.name != eventGolemWindowMode {
			continue
		}
		state, ok := e.data.(GolemWindowState)
		if !ok {
			h.t.Fatalf("%s payload = %T, want GolemWindowState", eventGolemWindowMode, e.data)
		}
		out = append(out, state)
	}
	return out
}

// relayed is every envelope delivered to any window: main's first, then each
// satellite's in creation order. Per-window delivery is asserted through
// fakeNative.received.
func (h *golemHarness) relayed() []GolemWindowEnvelope {
	h.mu.Lock()
	windows := append([]*fakeNative{h.mainWin}, h.created...)
	h.mu.Unlock()
	var out []GolemWindowEnvelope
	for _, window := range windows {
		out = append(out, window.received()...)
	}
	return out
}

func (h *golemHarness) readFile(path string) ([]byte, bool) {
	h.filesMu.Lock()
	defer h.filesMu.Unlock()
	data, ok := h.files[path]
	if !ok {
		return nil, false
	}
	return append([]byte(nil), data...), true
}

func (h *golemHarness) writeFile(path string, data []byte) {
	h.filesMu.Lock()
	defer h.filesMu.Unlock()
	h.files[path] = append([]byte(nil), data...)
}

func (h *golemHarness) removeFile(path string) {
	h.filesMu.Lock()
	defer h.filesMu.Unlock()
	delete(h.files, path)
}

func (h *golemHarness) appStatePath() string {
	return filepath.Join(golemTestFirnDir, "app.json")
}

func (h *golemHarness) savedState() (appstate.State, bool) {
	data, ok := h.readFile(h.appStatePath())
	if !ok {
		return appstate.State{}, false
	}
	var file struct {
		Version int            `json:"version"`
		State   appstate.State `json:"state"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		h.t.Fatalf("saved app.json is not parseable: %v", err)
	}
	return file.State, true
}

// savedMode is the mode currently on disk, or "" when nothing is saved.
func (h *golemHarness) savedMode() string {
	state, ok := h.savedState()
	if !ok {
		return ""
	}
	return state.GolemWindow.Mode
}

func (h *golemHarness) mainCtx() context.Context { return ctxForWindow(h.mainWin) }
func (h *golemHarness) satCtx() context.Context  { return ctxForWindow(h.satellite()) }
func (h *golemHarness) state() GolemWindowState  { return h.app.golemStateSnapshot() }
func (h *golemHarness) phase() GolemWindowPhase  { return h.state().Phase }
func (h *golemHarness) mode() string             { return h.state().Mode }
func (h *golemHarness) instance() uint64         { return h.state().Instance }
func (h *golemHarness) handoff() uint64          { return h.state().Handoff }
func (h *golemHarness) viewMessage(rev uint64) GolemWindowMessage {
	return GolemWindowMessage{
		Kind: "view", Instance: h.instance(), Revision: rev,
		Payload: json.RawMessage(fmt.Sprintf(`{"rev":%d}`, rev)),
	}
}

// undock drives a complete main → satellite handover and leaves the harness in
// the ready/undocked state, so the re-dock tests start from a real one.
func (h *golemHarness) undock() {
	h.t.Helper()
	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		h.t.Fatalf("OpenGolemWindow: %v", err)
	}
	if _, err := h.app.BootstrapGolemWindow(h.satCtx()); err != nil {
		h.t.Fatalf("BootstrapGolemWindow: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), h.viewMessage(1)); err != nil {
		h.t.Fatalf("view: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), GolemWindowMessage{
		Kind: "drafts", Instance: h.instance(), Handoff: h.handoff(), ID: 41,
		Payload: json.RawMessage(`{"c1":"hello"}`),
	}); err != nil {
		h.t.Fatalf("drafts: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "ready", Instance: h.instance(), Handoff: h.handoff(), Revision: 41,
		Payload: json.RawMessage(`null`),
	}); err != nil {
		h.t.Fatalf("ready: %v", err)
	}
	if h.phase() != golemPhaseReady || h.mode() != appstate.ModeUndocked {
		h.t.Fatalf("after undock: phase=%s mode=%s, want ready/undocked", h.phase(), h.mode())
	}
}

// transferBackToMain replays the re-dock draft handover: the satellite posts
// its final map and main acknowledges it successfully.
func (h *golemHarness) transferBackToMain(id uint64, ok bool) {
	h.t.Helper()
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "drafts", Instance: h.instance(), Handoff: h.handoff(), ID: id,
		Payload: json.RawMessage(`{"c1":"bye"}`),
	}); err != nil {
		h.t.Fatalf("satellite drafts: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), GolemWindowMessage{
		Kind: "ack", Instance: h.instance(), Handoff: h.handoff(), Revision: id,
		Payload: json.RawMessage(fmt.Sprintf(`{"id":%d,"ok":%t}`, id, ok)),
	}); err != nil {
		h.t.Fatalf("main transfer ack: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Pure placement
// ---------------------------------------------------------------------------

func TestClampGolemBoundsKeepsControlsReachable(t *testing.T) {
	screens := []application.Rect{
		{X: -1440, Y: 0, Width: 1440, Height: 900},
		{X: 0, Y: 0, Width: 2560, Height: 1440},
	}
	for _, tc := range []struct {
		name string
		in   appstate.GolemWindow
	}{
		{"negative monitor", appstate.GolemWindow{X: -1400, Y: 100, Width: 480, Height: 720}},
		{"removed monitor oversized", appstate.GolemWindow{X: 9000, Y: 9000, Width: 6000, Height: 4000}},
		{"left overflow", appstate.GolemWindow{X: -1800, Y: 20, Width: 700, Height: 720}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := placeGolemWindow(tc.in, screens, screens[1])
			if err != nil {
				t.Fatal(err)
			}
			reachable := false
			for _, screen := range screens {
				if got.X >= screen.X && got.Y >= screen.Y &&
					got.Width > 0 && got.Height > 0 &&
					got.Width <= screen.Width && got.Height <= screen.Height &&
					got.X-screen.X <= screen.Width-got.Width && got.Y-screen.Y <= screen.Height-got.Height {
					reachable = true
				}
			}
			if !reachable {
				t.Fatalf("unreachable frame: %+v", got)
			}
			if tc.name == "negative monitor" && got.X != -1400 {
				t.Fatalf("reachable negative coordinate changed: %+v", got)
			}
		})
	}
}

func TestPlaceGolemWindowDefaultsAndDegenerateWorkAreas(t *testing.T) {
	full := application.Rect{X: 0, Y: 0, Width: 2560, Height: 1440}

	t.Run("no saved bounds centers at the default size", func(t *testing.T) {
		got, err := placeGolemWindow(appstate.GolemWindow{}, []application.Rect{full}, full)
		if err != nil {
			t.Fatal(err)
		}
		if got.Width != golemWindowDefaultWidth || got.Height != golemWindowDefaultHeight {
			t.Fatalf("size = %dx%d, want %dx%d", got.Width, got.Height,
				golemWindowDefaultWidth, golemWindowDefaultHeight)
		}
		if got.X != (2560-golemWindowDefaultWidth)/2 || got.Y != (1440-golemWindowDefaultHeight)/2 {
			t.Fatalf("origin = %d,%d, want centred", got.X, got.Y)
		}
	})

	t.Run("tiny work area shrinks below the normal minimum", func(t *testing.T) {
		tiny := application.Rect{X: 0, Y: 0, Width: 300, Height: 400}
		got, err := placeGolemWindow(appstate.GolemWindow{}, []application.Rect{tiny}, tiny)
		if err != nil {
			t.Fatal(err)
		}
		if got.Width != 300 || got.Height != 400 {
			t.Fatalf("size = %dx%d, want the whole 300x400 work area", got.Width, got.Height)
		}
	})

	// §5.3: a frame below 380x520 is only permitted while the reachable work
	// area is itself smaller, so a display that can fit the normal minimums
	// restores them.
	t.Run("saved 300x400 on a full display restores 380x520", func(t *testing.T) {
		got, err := placeGolemWindow(
			appstate.GolemWindow{X: 100, Y: 100, Width: 300, Height: 400},
			[]application.Rect{full}, full)
		if err != nil {
			t.Fatal(err)
		}
		if got.Width != golemWindowMinWidth || got.Height != golemWindowMinHeight {
			t.Fatalf("size = %dx%d, want the normal minimums %dx%d",
				got.Width, got.Height, golemWindowMinWidth, golemWindowMinHeight)
		}
		options := golemWindowOptions(got)
		if options.MinWidth != golemWindowMinWidth || options.MinHeight != golemWindowMinHeight {
			t.Fatalf("options minimums = %dx%d, want %dx%d",
				options.MinWidth, options.MinHeight, golemWindowMinWidth, golemWindowMinHeight)
		}
	})

	t.Run("saved 300x400 on a 320x460 work area stays small", func(t *testing.T) {
		small := application.Rect{X: 0, Y: 0, Width: 320, Height: 460}
		got, err := placeGolemWindow(
			appstate.GolemWindow{X: 0, Y: 0, Width: 300, Height: 400},
			[]application.Rect{small}, small)
		if err != nil {
			t.Fatal(err)
		}
		if got.Width != small.Width || got.Height != small.Height {
			t.Fatalf("size = %dx%d, want the whole %dx%d work area",
				got.Width, got.Height, small.Width, small.Height)
		}
		options := golemWindowOptions(got)
		if options.MinWidth != small.Width || options.MinHeight != small.Height {
			t.Fatalf("options minimums = %dx%d, want the work area %dx%d",
				options.MinWidth, options.MinHeight, small.Width, small.Height)
		}
	})

	t.Run("no screens is a reported placement error", func(t *testing.T) {
		if _, err := placeGolemWindow(appstate.GolemWindow{}, nil, application.Rect{}); err == nil {
			t.Fatal("placeGolemWindow with no work area returned nil error")
		}
	})

	t.Run("overflowing saved coordinates do not wrap", func(t *testing.T) {
		const huge = int(^uint(0) >> 1)
		got, err := placeGolemWindow(
			appstate.GolemWindow{X: huge, Y: huge, Width: 480, Height: 720},
			[]application.Rect{full}, full)
		if err != nil {
			t.Fatal(err)
		}
		if got.X < full.X || got.X > full.X+full.Width-got.Width {
			t.Fatalf("X = %d, want inside the work area", got.X)
		}
	})
}

// ---------------------------------------------------------------------------
// Bounded retirement observer
// ---------------------------------------------------------------------------

func TestWaitGolemWindowRemoved(t *testing.T) {
	for _, name := range []string{"absent", "removed", "timeout", "cancel"} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var present atomic.Bool
				present.Store(name != "absent")
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan error, 1)
				go func() {
					done <- waitGolemWindowRemoved(ctx, 7, func(id uint) bool {
						if id != 7 {
							t.Errorf("looked up %d, want retiring ID 7", id)
						}
						return present.Load()
					})
				}()
				synctest.Wait()
				if name != "absent" {
					select {
					case err := <-done:
						t.Fatalf("completed while still present: %v", err)
					default:
					}
				}
				var want error
				switch name {
				case "removed":
					present.Store(false)
					time.Sleep(20 * time.Millisecond)
				case "timeout":
					time.Sleep(2 * time.Second)
					want = context.DeadlineExceeded
				case "cancel":
					cancel()
					want = context.Canceled
				}
				synctest.Wait()
				select {
				case err := <-done:
					if !errors.Is(err, want) {
						t.Fatalf("got %v, want %v", err, want)
					}
				default:
					t.Fatal("observer did not finish")
				}
			})
		})
	}
}

// ---------------------------------------------------------------------------
// Undock
// ---------------------------------------------------------------------------

func TestUndockBarrier(t *testing.T) {
	h := newGolemHarness(t)

	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("OpenGolemWindow: %v", err)
	}

	satellite := h.satellite()
	options := h.lastOptions()
	if !options.Hidden {
		t.Error("the bootstrapping window was not created hidden")
	}
	if options.InitialPosition != application.WindowXY {
		t.Errorf("InitialPosition = %v, want application.WindowXY", options.InitialPosition)
	}
	if options.Name != golemWindowNameGolem || options.URL != golemWindowURL {
		t.Errorf("options name/url = %q/%q", options.Name, options.URL)
	}
	if satellite.hookCount(events.Common.WindowClosing) == 0 {
		t.Error("no WindowClosing hook was installed on the satellite")
	}
	if satellite.countOf("run") != 1 {
		t.Errorf("satellite run count = %d, want 1", satellite.countOf("run"))
	}
	// The handle and hooks exist before the satellite's first bootstrap call.
	if _, err := h.app.BootstrapGolemWindow(h.satCtx()); err != nil {
		t.Fatalf("BootstrapGolemWindow: %v", err)
	}
	if h.phase() != golemPhaseBootstrapped {
		t.Fatalf("phase = %s, want %s", h.phase(), golemPhaseBootstrapped)
	}

	// Repeated Open while bootstrapping creates once and shows nothing.
	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("second OpenGolemWindow: %v", err)
	}
	if h.createdCount() != 1 {
		t.Fatalf("created %d windows, want 1", h.createdCount())
	}
	if satellite.countOf("show") != 0 || satellite.countOf("focus") != 0 {
		t.Errorf("hidden bootstrap window was shown/focused: %v", satellite.recorded())
	}
	if h.mode() != appstate.ModeDocked {
		t.Errorf("mode = %s before readiness, want docked", h.mode())
	}

	instance, handoff := h.instance(), h.handoff()

	// Ready without a view is refused.
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "ready", Instance: instance, Handoff: handoff, Revision: 41,
		Payload: json.RawMessage(`null`),
	}); err == nil {
		t.Fatal("ready was accepted with no published view")
	}

	if err := h.app.PostGolemWindowMessage(h.mainCtx(), h.viewMessage(1)); err != nil {
		t.Fatalf("view: %v", err)
	}

	// Ready without the recorded main draft id is refused.
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "ready", Instance: instance, Handoff: handoff, Revision: 41,
		Payload: json.RawMessage(`null`),
	}); err == nil {
		t.Fatal("ready was accepted before main transferred its drafts")
	}
	if h.mode() != appstate.ModeDocked || satellite.countOf("show") != 0 {
		t.Fatal("a refused ready changed mode or revealed the window")
	}

	if err := h.app.PostGolemWindowMessage(h.mainCtx(), GolemWindowMessage{
		Kind: "drafts", Instance: instance, Handoff: handoff, ID: 41,
		Payload: json.RawMessage(`{"c1":"hello"}`),
	}); err != nil {
		t.Fatalf("drafts: %v", err)
	}

	// Wrong draft id is still refused.
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "ready", Instance: instance, Handoff: handoff, Revision: 40,
		Payload: json.RawMessage(`null`),
	}); err == nil {
		t.Fatal("ready with a mismatched draft id was accepted")
	}

	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "ready", Instance: instance, Handoff: handoff, Revision: 41,
		Payload: json.RawMessage(`null`),
	}); err != nil {
		t.Fatalf("ready: %v", err)
	}

	if h.phase() != golemPhaseReady || h.mode() != appstate.ModeUndocked {
		t.Fatalf("phase/mode = %s/%s, want ready/undocked", h.phase(), h.mode())
	}
	if satellite.countOf("show") != 1 || satellite.countOf("focus") != 1 {
		t.Errorf("reveal calls = %v, want one show and one focus", satellite.recorded())
	}
	// A duplicate valid ready is harmless.
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "ready", Instance: instance, Handoff: handoff, Revision: 41,
		Payload: json.RawMessage(`null`),
	}); err != nil {
		t.Fatalf("duplicate ready: %v", err)
	}
	if saved, ok := h.savedState(); !ok || saved.GolemWindow.Mode != appstate.ModeUndocked {
		t.Fatalf("saved state = %+v, ok=%t, want undocked", saved, ok)
	}
	// The bootstrap deadline is cancelled by readiness.
	for _, timer := range h.liveTimers() {
		if !timer.isStopped() {
			t.Error("a transition timer survived readiness")
		}
	}
}

func TestRejectedTransitionLeavesStateUntouched(t *testing.T) {
	h := newGolemHarness(t)
	h.undock()
	before := h.state()
	satellite := h.satellite()
	instance, handoff := before.Instance, before.Handoff

	stale := &fakeNative{fakeWindow: fakeWindow{id: 999, name: golemWindowNameGolem}}
	other := &fakeNative{fakeWindow: fakeWindow{id: 998, name: golemWindowNameMain}}

	cases := []struct {
		name string
		run  func() error
	}{
		{"old same-name native caller", func() error {
			return h.app.PostGolemWindowMessage(ctxForWindow(stale), GolemWindowMessage{
				Kind: "action", Instance: instance, ID: 1, Payload: json.RawMessage(`{"type":"select"}`),
			})
		}},
		{"replaced main caller", func() error {
			return h.app.PostGolemWindowMessage(ctxForWindow(other), h.viewMessage(9))
		}},
		{"stale instance", func() error {
			return h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
				Kind: "action", Instance: instance - 1, ID: 2, Payload: json.RawMessage(`{"type":"select"}`),
			})
		}},
		{"stale handoff on drafts", func() error {
			return h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
				Kind: "drafts", Instance: instance, Handoff: handoff + 7, ID: 3,
				Payload: json.RawMessage(`{}`),
			})
		}},
		{"stale view revision", func() error {
			return h.app.PostGolemWindowMessage(h.mainCtx(), h.viewMessage(1))
		}},
		{"confirm before a close request", func() error {
			return h.app.ConfirmGolemWindowClose(h.satCtx(), instance, handoff)
		}},
		{"bootstrap from main", func() error {
			_, err := h.app.BootstrapGolemWindow(h.mainCtx())
			return err
		}},
		{"open from the satellite", func() error {
			return h.app.OpenGolemWindow(h.satCtx())
		}},
		{"focus from the satellite", func() error {
			return h.app.FocusGolemWindow(h.satCtx())
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.run(); err == nil {
				t.Fatal("rejected transition returned a nil error")
			}
			if got := h.state(); got != before {
				t.Fatalf("state = %+v, want unchanged %+v", got, before)
			}
			if satellite.countOf("close") != 0 {
				t.Fatal("a rejected transition closed the window")
			}
		})
	}

	// An action before readiness needs its own hidden bootstrap, so it runs
	// against a fresh harness rather than the undocked one above.
	t.Run("action before ready", func(t *testing.T) {
		fresh := newGolemHarness(t)
		if err := fresh.app.OpenGolemWindow(fresh.mainCtx()); err != nil {
			t.Fatalf("OpenGolemWindow: %v", err)
		}
		if _, err := fresh.app.BootstrapGolemWindow(fresh.satCtx()); err != nil {
			t.Fatalf("BootstrapGolemWindow: %v", err)
		}
		if fresh.phase() != golemPhaseBootstrapped {
			t.Fatalf("phase = %s, want %s", fresh.phase(), golemPhaseBootstrapped)
		}
		untouched := fresh.state()

		err := fresh.app.PostGolemWindowMessage(fresh.satCtx(), GolemWindowMessage{
			Kind: "action", Instance: fresh.instance(), ID: 1,
			Payload: json.RawMessage(`{"type":"select"}`),
		})

		if err == nil {
			t.Fatal("an action was accepted before the window was ready")
		}
		if got := fresh.state(); got != untouched {
			t.Fatalf("state = %+v, want unchanged %+v", got, untouched)
		}
		if len(fresh.relayed()) != 0 {
			t.Fatalf("relayed %d messages, want none", len(fresh.relayed()))
		}
		if fresh.satellite().countOf("show") != 0 {
			t.Fatal("a rejected action revealed the hidden window")
		}
	})

	// A newer view is retained; the older one above never replaced it.
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), h.viewMessage(4)); err != nil {
		t.Fatalf("newer view: %v", err)
	}
	boot, err := h.app.BootstrapGolemWindow(h.satCtx())
	if err != nil {
		t.Fatalf("BootstrapGolemWindow: %v", err)
	}
	if boot.Revision != 4 {
		t.Fatalf("retained view revision = %d, want 4", boot.Revision)
	}
}

func TestBootstrapTimeoutAndAbort(t *testing.T) {
	t.Run("deadline closes the hidden attempt", func(t *testing.T) {
		h := newGolemHarness(t)
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("OpenGolemWindow: %v", err)
		}
		satellite := h.satellite()
		h.pendingTimer().fire()

		if satellite.countOf("close") != 1 {
			t.Fatalf("close calls = %d, want 1", satellite.countOf("close"))
		}
		// Close() returning is not destruction: the phase stays closing until
		// the fake manager retires the captured id.
		if h.phase() == golemPhaseClosed {
			t.Fatal("phase reached closed before the manager retired the window")
		}
		h.retire(satellite.id)
		waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
		if h.mode() != appstate.ModeDocked {
			t.Fatalf("mode = %s after abort, want docked", h.mode())
		}

		// A late callback from the retired instance cannot affect a retry.
		lateInstance, lateHandoff := uint64(1), uint64(1)
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("retry OpenGolemWindow: %v", err)
		}
		if h.createdCount() != 2 {
			t.Fatalf("created %d windows, want 2", h.createdCount())
		}
		if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
			Kind: "abort", Instance: lateInstance, Handoff: lateHandoff,
			Payload: json.RawMessage(`{"reason":"late"}`),
		}); err == nil {
			t.Fatal("a late abort from the retired instance was accepted")
		}
		if h.phase() != golemPhaseBootstrapping {
			t.Fatalf("phase = %s, want the replacement still bootstrapping", h.phase())
		}
	})

	t.Run("explicit abort", func(t *testing.T) {
		h := newGolemHarness(t)
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("OpenGolemWindow: %v", err)
		}
		satellite := h.satellite()
		if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
			Kind: "abort", Instance: h.instance(), Handoff: h.handoff(),
			Payload: json.RawMessage(`{"reason":"chat owner unavailable"}`),
		}); err != nil {
			t.Fatalf("abort: %v", err)
		}
		if satellite.countOf("close") != 1 {
			t.Fatalf("abort issued %d closes, want 1", satellite.countOf("close"))
		}
		h.retire(satellite.id)
		waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
		if h.mode() != appstate.ModeDocked {
			t.Fatalf("mode = %s, want docked", h.mode())
		}
		// Another attempt is permitted.
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("reopen after abort: %v", err)
		}
	})

	// The window is published as bootstrapping before it is registered and run,
	// so a close landing in that gap finds an un-run window: Close() is a no-op,
	// the manager never knew the id, and the observer retires the instance and
	// releases the hooks while OpenGolemWindow is still inside Run(). Open must
	// notice on its way out and destroy what it started.
	t.Run("a close before registration leaves no orphan window", func(t *testing.T) {
		h := newGolemHarness(t)
		h.onNewWindow(func(window *fakeNative) {
			window.onRun = func() {
				// Absent from the manager: exactly what an un-run window is.
				h.retire(window.id)
				if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
					t.Errorf("CloseGolemWindow during bootstrap: %v", err)
				}
				waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
			}
		})

		err := h.app.OpenGolemWindow(h.mainCtx())

		if err == nil {
			t.Fatal("OpenGolemWindow returned nil after its attempt was retired")
		}
		satellite := h.satellite()
		if satellite.countOf("close") != 2 {
			t.Fatalf("close calls = %d, want the aborted close plus the orphan destroy",
				satellite.countOf("close"))
		}
		if h.createdCount() != 1 {
			t.Fatalf("created %d windows, want 1", h.createdCount())
		}
		if h.phase() != golemPhaseClosed || h.mode() != appstate.ModeDocked {
			t.Fatalf("phase/mode = %s/%s, want closed/docked", h.phase(), h.mode())
		}
		closed := 0
		for _, state := range h.modeEvents() {
			if state.Phase == golemPhaseClosed {
				closed++
			}
		}
		if closed != 1 {
			t.Fatalf("emitted %d closed transitions, want 1", closed)
		}
	})

	t.Run("factory failure keeps main docked and stays retryable", func(t *testing.T) {
		h := newGolemHarness(t)
		h.failFactoryOnce()
		if err := h.app.OpenGolemWindow(h.mainCtx()); err == nil {
			t.Fatal("OpenGolemWindow returned nil after the factory refused")
		}
		if h.phase() != golemPhaseClosed || h.mode() != appstate.ModeDocked {
			t.Fatalf("phase/mode = %s/%s, want closed/docked", h.phase(), h.mode())
		}
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("retry after factory failure: %v", err)
		}
	})
}

// ---------------------------------------------------------------------------
// Re-dock
// ---------------------------------------------------------------------------

func TestReDockBarrierAndRetry(t *testing.T) {
	h := newGolemHarness(t)
	// The two-second retirement cap is the production constant; the deliberate
	// timeout leg below is the only place these tests wait on it.
	h.undock()
	satellite := h.satellite()
	firstHandoff := h.handoff()

	// Native close and binding close converge on one closing transition.
	if cancelled := satellite.fire(events.Common.WindowClosing); !cancelled {
		t.Fatal("the satellite WindowClosing hook did not cancel native destruction")
	}
	if h.phase() != golemPhaseClosing {
		t.Fatalf("phase = %s after a native close, want closing", h.phase())
	}
	if err := h.app.CloseGolemWindow(h.satCtx()); err != nil {
		t.Fatalf("CloseGolemWindow during closing: %v", err)
	}
	if h.handoff() != firstHandoff+1 {
		t.Fatalf("handoff = %d, want exactly one increment from %d", h.handoff(), firstHandoff)
	}
	if satellite.countOf("close") != 0 {
		t.Fatal("closing issued a native Close before the drafts were acknowledged")
	}

	// Ordinary action acknowledgements may still drain.
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), GolemWindowMessage{
		Kind: "ack", Instance: h.instance(), Revision: 5, Payload: json.RawMessage(`{"id":5,"ok":true}`),
	}); err != nil {
		t.Fatalf("draining ack during closing: %v", err)
	}

	// Confirm without a successful transfer ack is refused.
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err == nil {
		t.Fatal("ConfirmGolemWindowClose succeeded with no transfer ack")
	}

	// A refused transfer ack returns to ready with satellite input intact.
	h.transferBackToMain(70, false)
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err == nil {
		t.Fatal("ConfirmGolemWindowClose succeeded on a failed transfer ack")
	}
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "abort", Instance: h.instance(), Handoff: h.handoff(),
		Payload: json.RawMessage(`{"reason":"transfer refused"}`),
	}); err != nil {
		t.Fatalf("abort of the re-dock: %v", err)
	}
	if h.phase() != golemPhaseReady || h.mode() != appstate.ModeUndocked {
		t.Fatalf("phase/mode = %s/%s after a failed transfer, want ready/undocked", h.phase(), h.mode())
	}
	if satellite.countOf("close") != 0 {
		t.Fatal("a failed re-dock destroyed the satellite")
	}
	staleHandoff := h.handoff()

	// A second request gets a new handoff.
	if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("second CloseGolemWindow: %v", err)
	}
	if h.handoff() == staleHandoff {
		t.Fatalf("handoff = %d, want a fresh one for the second request", h.handoff())
	}
	// A delayed confirm carrying the first request's handoff cannot finish it.
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), staleHandoff); err == nil {
		t.Fatal("a stale-handoff confirm was accepted")
	}

	h.transferBackToMain(71, true)
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
		t.Fatalf("ConfirmGolemWindowClose: %v", err)
	}
	if satellite.countOf("close") != 1 {
		t.Fatalf("authorized close issued %d native closes, want 1", satellite.countOf("close"))
	}

	// After authorization a retirement timeout retains closing and blocks Open.
	waitForGolem(t, func() bool { return h.app.golemRetirementFailed() })
	if h.phase() != golemPhaseClosing {
		t.Fatalf("phase = %s after a retirement timeout, want closing", h.phase())
	}
	if err := h.app.OpenGolemWindow(h.mainCtx()); err == nil {
		t.Fatal("OpenGolemWindow succeeded while a close was still retiring")
	}
	if h.createdCount() != 1 {
		t.Fatalf("created %d windows, want 1", h.createdCount())
	}
}

func TestCloseCompletionAndReopen(t *testing.T) {
	t.Run("manager membership outlives Close and gates reopening", func(t *testing.T) {
		h := newGolemHarness(t)
		h.undock()
		satellite := h.satellite()
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("CloseGolemWindow: %v", err)
		}
		h.transferBackToMain(80, true)
		if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
			t.Fatalf("ConfirmGolemWindowClose: %v", err)
		}
		// Close() returned, but the id is still in the manager.
		if !h.isPresent(satellite.id) {
			t.Fatal("the harness retired the id before the observer could see it")
		}
		if h.phase() != golemPhaseClosing {
			t.Fatalf("phase = %s, want closing until the manager retires the id", h.phase())
		}
		if err := h.app.OpenGolemWindow(h.mainCtx()); err == nil {
			t.Fatal("an immediate Open was allowed during retirement")
		}
		if satellite.countOf("focus") != 1 {
			t.Fatalf("the retiring handle was focused again: %v", satellite.recorded())
		}

		h.retire(satellite.id)
		waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
		if h.mode() != appstate.ModeDocked {
			t.Fatalf("mode = %s, want docked", h.mode())
		}
		waitForGolem(t, func() bool { return h.savedMode() == appstate.ModeDocked })
		// Exactly one closed transition.
		closed := 0
		for _, state := range h.modeEvents() {
			if state.Phase == golemPhaseClosed {
				closed++
			}
		}
		if closed != 1 {
			t.Fatalf("emitted %d closed transitions, want 1", closed)
		}
		// Reopening now creates a second window; the old hook must not consume
		// the replacement's bypass.
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("reopen: %v", err)
		}
		replacement := h.satellite()
		if replacement.id == satellite.id {
			t.Fatal("the replacement reused the retired window")
		}
		if cancelled := satellite.fire(events.Common.WindowClosing); cancelled {
			t.Fatal("the retired window's hook cancelled a close it no longer owns")
		}
		if replacement.countOf("close") != 0 {
			t.Fatal("the retired hook closed the replacement")
		}
	})

	t.Run("timeout keeps closing and an explicit retry completes it", func(t *testing.T) {
		h := newGolemHarness(t)
		h.undock()
		satellite := h.satellite()
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("CloseGolemWindow: %v", err)
		}
		h.transferBackToMain(81, true)
		if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
			t.Fatalf("ConfirmGolemWindowClose: %v", err)
		}
		waitForGolem(t, func() bool { return h.app.golemRetirementFailed() })
		if h.phase() != golemPhaseClosing {
			t.Fatalf("phase = %s after the retirement timeout, want closing", h.phase())
		}

		h.retire(satellite.id)
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("recovery CloseGolemWindow: %v", err)
		}
		waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
		if satellite.countOf("close") != 1 {
			t.Fatalf("recovery reissued Close (%d calls), want 1", satellite.countOf("close"))
		}
	})

	t.Run("shutdown clearing the manager never re-docks", func(t *testing.T) {
		h := newGolemHarness(t)
		h.undock()
		satellite := h.satellite()
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("CloseGolemWindow: %v", err)
		}
		h.transferBackToMain(82, true)
		if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
			t.Fatalf("ConfirmGolemWindowClose: %v", err)
		}
		h.app.closeMu.Lock()
		h.app.closePhase = closePermitted
		h.app.closeMu.Unlock()
		h.retire(satellite.id)

		waitForGolem(t, func() bool { return !h.app.golemObserving() })
		if h.mode() != appstate.ModeUndocked {
			t.Fatalf("mode = %s after a permitted quit, want the undocked preference kept", h.mode())
		}
		if h.mainWin.countOf("show") != 0 {
			t.Fatal("permitted quit revealed the main window")
		}
	})
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

func TestFocusMainWindow(t *testing.T) {
	t.Run("minimised main restores before showing", func(t *testing.T) {
		h := newGolemHarness(t)
		h.mainWin.minimised = true
		h.app.focusMainWindow()
		want := []string{"unminimise", "show", "focus"}
		if got := h.mainWin.recorded(); !equalStrings(got, want) {
			t.Fatalf("calls = %v, want %v", got, want)
		}
	})

	t.Run("ordinary main shows and focuses", func(t *testing.T) {
		h := newGolemHarness(t)
		h.app.focusMainWindow()
		if got := h.mainWin.recorded(); !equalStrings(got, []string{"show", "focus"}) {
			t.Fatalf("calls = %v, want show then focus", got)
		}
	})

	t.Run("absent main and permitted quit do nothing", func(t *testing.T) {
		bare := &App{}
		bare.focusMainWindow() // must not panic

		h := newGolemHarness(t)
		h.app.closeMu.Lock()
		h.app.closePhase = closePermitted
		h.app.closeMu.Unlock()
		h.app.focusMainWindow()
		if got := h.mainWin.recorded(); len(got) != 0 {
			t.Fatalf("calls = %v during a permitted quit, want none", got)
		}
	})

	t.Run("a validated openConfig action focuses main before relaying", func(t *testing.T) {
		h := newGolemHarness(t)
		h.undock()
		h.mainWin.mu.Lock()
		h.mainWin.calls = nil
		h.mainWin.mu.Unlock()

		if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
			Kind: "action", Instance: h.instance(), ID: 9,
			Payload: json.RawMessage(`{"type":"openConfig"}`),
		}); err != nil {
			t.Fatalf("openConfig action: %v", err)
		}
		if got := h.mainWin.recorded(); !equalStrings(got, []string{"show", "focus"}) {
			t.Fatalf("main calls = %v, want show then focus", got)
		}
		relayed := h.mainWin.received()
		if len(relayed) == 0 {
			t.Fatal("the openConfig action was not relayed to main")
		}
		last := relayed[len(relayed)-1]
		if last.From != golemWindowRoleSatellite || last.Message.ID != 9 {
			t.Fatalf("relayed envelope = %+v", last)
		}

		// Any other action leaves main alone.
		h.mainWin.mu.Lock()
		h.mainWin.calls = nil
		h.mainWin.mu.Unlock()
		if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
			Kind: "action", Instance: h.instance(), ID: 10,
			Payload: json.RawMessage(`{"type":"openConfigX"}`),
		}); err != nil {
			t.Fatalf("ordinary action: %v", err)
		}
		if got := h.mainWin.recorded(); len(got) != 0 {
			t.Fatalf("main calls = %v for an ordinary action, want none", got)
		}
	})
}

// ---------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------

func TestQuitDuringTransfer(t *testing.T) {
	h := newGolemHarness(t)
	h.undock()
	satellite := h.satellite()
	satellite.setFrame(application.Rect{X: 120, Y: 60, Width: 500, Height: 800})

	if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("CloseGolemWindow: %v", err)
	}
	instance, handoff := h.instance(), h.handoff()
	// The transfer completed; only the satellite's confirm is still pending
	// when the quit lands, so the refusals below are the quit's doing.
	h.transferBackToMain(90, true)

	// The real path: the close drain permits the quit and saves the frame
	// before asking the platform to quit. beta.16's shutdown never dispatches
	// the satellite's WindowClosing hook (cleanup nils the window map under the
	// lock the event consumer needs), so nothing else would save it.
	h.app.quitFn = func() {}
	h.app.permitAndQuit()
	if !h.app.quitPermitted() {
		t.Fatal("permitAndQuit did not permit the quit")
	}
	// Saved by the drain itself, before any hook could run.
	saved, ok := h.savedState()
	if !ok {
		t.Fatal("the drain saved nothing before the platform quit")
	}
	// Should a runtime dispatch the hook after all, it allows the close.
	if cancelled := satellite.fire(events.Common.WindowClosing); cancelled {
		t.Fatal("the Golem hook cancelled a close during a permitted quit")
	}
	if h.mode() != appstate.ModeUndocked {
		t.Fatalf("mode = %s, want the pre-quit undocked preference", h.mode())
	}
	if saved.GolemWindow.Mode != appstate.ModeUndocked {
		t.Fatalf("saved mode = %s, want undocked", saved.GolemWindow.Mode)
	}
	if saved.GolemWindow.Width != 500 || saved.GolemWindow.Height != 800 {
		t.Fatalf("saved bounds = %+v, want the last normal frame", saved.GolemWindow)
	}
	for _, timer := range h.liveTimers() {
		if !timer.isStopped() {
			t.Error("a transition timer survived the permitted quit")
		}
	}

	// Pending callbacks cannot turn a permitted quit into a re-dock or a reveal.
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), instance, handoff); err == nil {
		t.Fatal("ConfirmGolemWindowClose was accepted during a permitted quit")
	}
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "abort", Instance: instance, Handoff: handoff,
		Payload: json.RawMessage(`{"reason":"late"}`),
	}); err == nil {
		t.Fatal("an abort was accepted during a permitted quit")
	}
	if h.mode() != appstate.ModeUndocked {
		t.Fatalf("mode = %s after late callbacks, want undocked", h.mode())
	}
	if h.mainWin.countOf("show") != 0 || satellite.countOf("show") != 1 {
		t.Fatalf("a window was revealed during the quit: main=%v satellite=%v",
			h.mainWin.recorded(), satellite.recorded())
	}
}

// TestQuitDuringRestoreKeepsUndockedPreference pins spec §5.3 "not persisting
// mode: docked" for the window the startup restore has not finished opening.
// The live mode is docked until `ready` commits the undock, so nothing that
// runs inside the restore's bootstrap may write that live mode over the saved
// undocked preference: the restore attempt is not news, and the placed frame
// came out of the very file it would overwrite.
//
// The quit is only one of the writers. The bounds hooks are installed before
// Run(), and every platform moves the window while creating it (Windows
// setPosition → WM_MOVE → WindowDidMove; macOS installs the delegate in
// windowNew and then setPosition), so the debounced geometry save fires during
// the bootstrap on an ordinary launch. Both writers go through the same
// uncommitted check, so the sub-test drives the creation move as well.
func TestQuitDuringRestoreKeepsUndockedPreference(t *testing.T) {
	const saved = `{"version":1,"state":{"golemWindow":` +
		`{"mode":"undocked","x":40,"y":50,"width":500,"height":760}}}`
	for _, tc := range []struct {
		name      string
		bootstrap bool
		phase     GolemWindowPhase
	}{
		{"bootstrapping", false, golemPhaseBootstrapping},
		{"bootstrapped", true, golemPhaseBootstrapped},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newGolemHarness(t)
			h.writeFile(h.appStatePath(), []byte(saved))
			h.app.loadGolemWindowPreference()
			if !h.state().RestorePending {
				t.Fatal("an undocked preference did not mark the restore pending")
			}
			if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
				t.Fatalf("OpenGolemWindow: %v", err)
			}
			if tc.bootstrap {
				if _, err := h.app.BootstrapGolemWindow(h.satCtx()); err != nil {
					t.Fatalf("BootstrapGolemWindow: %v", err)
				}
			}
			if h.phase() != tc.phase {
				t.Fatalf("phase = %s, want %s", h.phase(), tc.phase)
			}
			if h.mode() != appstate.ModeDocked {
				t.Fatalf("mode = %s during the restore, want docked until ready", h.mode())
			}

			// The platform's own creation move, at the frame it just placed.
			satellite := h.satellite()
			satellite.setFrame(application.Rect{X: 41, Y: 51, Width: 500, Height: 760})
			armed := len(h.liveTimers())
			satellite.fire(events.Common.WindowDidMove)
			if got := len(h.liveTimers()); got != armed {
				t.Fatalf("the creation move armed %d bounds save(s) during the bootstrap, want none",
					got-armed)
			}
			// And the debounced write refuses on its own, however it is reached.
			h.app.captureGolemFrame(h.instance())
			if got := h.savedMode(); got != appstate.ModeUndocked {
				t.Fatalf("the creation move saved mode %q, want the undocked preference kept", got)
			}

			h.app.quitFn = func() {}
			h.app.permitAndQuit()

			state, ok := h.savedState()
			if !ok {
				t.Fatal("the quit removed the saved preference")
			}
			if state.GolemWindow.Mode != appstate.ModeUndocked {
				t.Fatalf("saved mode = %s, want the undocked preference the restore came from",
					state.GolemWindow.Mode)
			}
			if state.GolemWindow.X != 40 || state.GolemWindow.Y != 50 ||
				state.GolemWindow.Width != 500 || state.GolemWindow.Height != 760 {
				t.Fatalf("saved bounds = %+v, want the saved frame untouched", state.GolemWindow)
			}
			for _, timer := range h.liveTimers() {
				if !timer.isStopped() {
					t.Error("a transition timer survived the permitted quit")
				}
			}
		})
	}
}

func TestCanceledQuitChangesNeitherModeNorInput(t *testing.T) {
	h := newGolemHarness(t)
	h.undock()
	before := h.state()

	h.app.closeMu.Lock()
	h.app.closePhase = closeAwaitingFrontend
	h.app.closeMu.Unlock()
	if cancelled := h.satellite().fire(events.Common.WindowClosing); !cancelled {
		t.Fatal("an unpermitted close was not cancelled")
	}
	h.app.closeMu.Lock()
	h.app.closePhase = closeIdle
	h.app.closeMu.Unlock()

	if h.mode() != before.Mode {
		t.Fatalf("mode = %s, want %s", h.mode(), before.Mode)
	}
	if h.satellite().countOf("close") != 0 {
		t.Fatal("a cancelled quit destroyed the satellite")
	}
}

// TestQuitAfterCloseAuthorizationSavesDocked pins the drain's mode choice: once
// the close is authorized the drafts are main's, so a quit landing before the
// window has retired persists docked rather than the pre-transfer undocked.
func TestQuitAfterCloseAuthorizationSavesDocked(t *testing.T) {
	h := newGolemHarness(t)
	h.undock()
	if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("CloseGolemWindow: %v", err)
	}
	h.transferBackToMain(90, true)
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
		t.Fatalf("ConfirmGolemWindowClose: %v", err)
	}
	// The window is still in the manager: the retirement has not completed.
	h.app.quitFn = func() {}
	h.app.permitAndQuit()
	saved, ok := h.savedState()
	if !ok {
		t.Fatal("the quit path saved nothing")
	}
	if saved.GolemWindow.Mode != appstate.ModeDocked {
		t.Fatalf("saved mode = %s, want docked once the close was authorized", saved.GolemWindow.Mode)
	}
}

// ---------------------------------------------------------------------------
// Relay routing
// ---------------------------------------------------------------------------

// TestRelayTargetsTheRecipientWindow pins that a message goes to the other
// window only: main never receives its own projection back, and the satellite
// never receives its own action echo.
func TestRelayTargetsTheRecipientWindow(t *testing.T) {
	h := newGolemHarness(t)
	h.undock()
	satellite := h.satellite()
	if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "action", Instance: h.instance(), ID: 1,
		Payload: json.RawMessage(`{"type":"select","conversationId":"c1"}`),
	}); err != nil {
		t.Fatalf("action: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), GolemWindowMessage{
		Kind: "ack", Instance: h.instance(), ID: 1, Revision: 1,
		Payload: json.RawMessage(`{"id":1,"ok":true}`),
	}); err != nil {
		t.Fatalf("ack: %v", err)
	}

	toMain := h.mainWin.received()
	if len(toMain) == 0 {
		t.Fatal("nothing was delivered to main")
	}
	for _, envelope := range toMain {
		if envelope.From != golemWindowRoleSatellite {
			t.Fatalf("main received its own %s back: %+v", envelope.Message.Kind, envelope)
		}
	}
	toSatellite := satellite.received()
	if len(toSatellite) == 0 {
		t.Fatal("nothing was delivered to the satellite")
	}
	for _, envelope := range toSatellite {
		if envelope.From != golemWindowRoleMain {
			t.Fatalf("the satellite received its own %s back: %+v", envelope.Message.Kind, envelope)
		}
	}
	kinds := func(envelopes []GolemWindowEnvelope) []string {
		var out []string
		for _, e := range envelopes {
			out = append(out, e.Message.Kind)
		}
		return out
	}
	if got := kinds(toSatellite); !equalStrings(got, []string{"view", "drafts", "ack"}) {
		t.Fatalf("satellite received %v, want main's view, drafts and ack", got)
	}
	if got := kinds(toMain); !equalStrings(got, []string{"ready", "action"}) {
		t.Fatalf("main received %v, want the satellite's ready and action", got)
	}
	// The lifecycle state stays app-wide.
	if len(h.modeEvents()) == 0 {
		t.Fatal("no window state reached the app-wide bus")
	}
}

// ---------------------------------------------------------------------------
// Startup restore
// ---------------------------------------------------------------------------

// TestRestoreShowsWithoutFocus pins spec §7 for the startup restore of a saved
// undocked window: it is shown, never focused, and the window the user was
// working in gets the keyboard back. Every platform's Show() makes the window
// it reveals key WITHIN the app (macOS makeKeyAndOrderFront, Windows SW_SHOW,
// Linux gtk_window_present) without activating the app, so "no Focus() call" is
// not enough on its own — the restore orders main back in front afterwards with
// the same Show(). Focus() is the one call that would activate Firn over
// whatever the user switched to (macOS activateIgnoringOtherApps:YES, Windows
// SetForegroundWindow), so the restore path must never make it, on either
// window, whether or not main happened to be key. A user's own undock, and an
// explicit open of the live window, still focus the satellite.
func TestRestoreShowsWithoutFocus(t *testing.T) {
	h := newGolemHarness(t)
	h.writeFile(h.appStatePath(), []byte(
		`{"version":1,"state":{"golemWindow":{"mode":"undocked","x":40,"y":50,"width":500,"height":760}}}`))
	h.app.loadGolemWindowPreference()
	if !h.state().RestorePending {
		t.Fatal("an undocked preference did not mark the restore pending")
	}
	h.undock()
	satellite := h.satellite()
	if got := satellite.recorded(); !equalStrings(got, []string{"run", "show"}) {
		t.Fatalf("restore made %v, want run then show alone (no focus)", got)
	}
	if got := h.mainWin.recorded(); !equalStrings(got, []string{"show"}) {
		t.Fatalf("main made %v, want one show alone: key back inside the app, never an activation",
			got)
	}
	h.mainWin.mu.Lock()
	h.mainWin.calls = nil
	h.mainWin.mu.Unlock()
	// An explicit open of the live window is the user's gesture.
	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("OpenGolemWindow while ready: %v", err)
	}
	if got := satellite.recorded(); !equalStrings(got, []string{"run", "show", "show", "focus"}) {
		t.Fatalf("explicit open made %v, want show then focus", got)
	}

	// The next undock after a re-dock is not a restore any more.
	if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("CloseGolemWindow: %v", err)
	}
	h.transferBackToMain(90, true)
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
		t.Fatalf("ConfirmGolemWindowClose: %v", err)
	}
	h.retire(satellite.id)
	waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
	h.undock()
	if got := h.satellite().recorded(); !equalStrings(got, []string{"run", "show", "focus"}) {
		t.Fatalf("a user undock made %v, want show then focus", got)
	}
}

// TestRestoreLeavesMinimisedMainAlone is the other half of §7: the hand-back is
// an ordering move inside the app, not a reason to put a window the user put
// away back on screen. A minimised main is left minimised — the satellite keeps
// key, which is a smaller intrusion than un-minimising main would be — and no
// window is ever un-minimised, shown or focused on main's behalf.
func TestRestoreLeavesMinimisedMainAlone(t *testing.T) {
	h := newGolemHarness(t)
	h.writeFile(h.appStatePath(), []byte(
		`{"version":1,"state":{"golemWindow":{"mode":"undocked","x":40,"y":50,"width":500,"height":760}}}`))
	h.app.loadGolemWindowPreference()
	h.mainWin.minimised = true
	h.undock()

	if got := h.satellite().recorded(); !equalStrings(got, []string{"run", "show"}) {
		t.Fatalf("restore made %v, want run then show alone", got)
	}
	if got := h.mainWin.recorded(); len(got) != 0 {
		t.Fatalf("main made %v while minimised, want no native call at all", got)
	}
}

// ---------------------------------------------------------------------------
// Preference load failures reach the user
// ---------------------------------------------------------------------------

// TestLoadFailureIsPublishedAsReason pins spec §3.2 "report a read/write
// failure": an unreadable app.json names itself on the startup snapshot, so
// main can tell the user, and the next attempt clears it like any reason.
func TestLoadFailureIsPublishedAsReason(t *testing.T) {
	h := newGolemHarness(t)
	h.writeFile(h.appStatePath(), []byte(`{"version":1,"state":{"golemWindow":{"mode":"undocked",}}}`))
	h.app.loadGolemWindowPreference()

	loaded := h.lastModeEvent()
	if loaded.Phase != golemPhaseClosed || loaded.Mode != appstate.ModeDocked {
		t.Fatalf("startup state = %s/%s, want closed/docked", loaded.Phase, loaded.Mode)
	}
	if !strings.Contains(loaded.Reason, "could not be read") || !strings.Contains(loaded.Reason, "parsing app state") {
		t.Fatalf("startup reason = %q, want the load failure named", loaded.Reason)
	}
	if got, err := h.app.GetGolemWindowState(h.mainCtx()); err != nil || got.Reason != loaded.Reason {
		t.Fatalf("GetGolemWindowState = %+v, %v; want the load reason readable", got, err)
	}
	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("OpenGolemWindow: %v", err)
	}
	if got := h.lastModeEvent(); got.Reason != "" {
		t.Fatalf("a fresh attempt still carries %q, want the reason cleared", got.Reason)
	}
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

func TestBoundsSaveOrdering(t *testing.T) {
	h := newGolemHarness(t)
	h.undock()
	satellite := h.satellite()

	satellite.setFrame(application.Rect{X: 10, Y: 20, Width: 460, Height: 700})
	satellite.fire(events.Common.WindowDidResize)
	geometry := h.pendingTimer()
	geometry.fire()

	// Minimised/maximised/fullscreen frames never replace the normal one.
	for _, mutate := range []func(){
		func() { satellite.minimised = true },
		func() { satellite.minimised = false; satellite.maximised = true },
		func() { satellite.maximised = false; satellite.fullscreen = true },
	} {
		mutate()
		satellite.setFrame(application.Rect{X: 0, Y: 0, Width: 2560, Height: 1440})
		satellite.fire(events.Common.WindowDidResize)
		h.pendingTimer().fire()
	}
	satellite.fullscreen = false

	if got := h.app.golemLastNormalFrame(); got.Width != 460 || got.Height != 700 || got.X != 10 || got.Y != 20 {
		t.Fatalf("last normal frame = %+v, want the 460x700 frame", got)
	}

	// A stale geometry save cannot overwrite a newer docked save.
	satellite.setFrame(application.Rect{X: 33, Y: 44, Width: 400, Height: 600})
	satellite.fire(events.Common.WindowDidMove)
	stale := h.pendingTimer()

	if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("CloseGolemWindow: %v", err)
	}
	if !stale.isStopped() {
		t.Error("the pending geometry timer was not stopped by the close transition")
	}
	h.transferBackToMain(95, true)
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
		t.Fatalf("ConfirmGolemWindowClose: %v", err)
	}
	h.retire(satellite.id)
	waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
	waitForGolem(t, func() bool { return h.savedMode() == appstate.ModeDocked })

	// The already-fired old timer now runs against a newer docked save.
	stale.fireRegardless()
	after, _ := h.savedState()
	if after.GolemWindow.Mode != appstate.ModeDocked {
		t.Fatalf("stale geometry save overwrote the docked mode: %+v", after.GolemWindow)
	}
}

func TestCorruptAppStateStaysByteForBytePreserved(t *testing.T) {
	h := newGolemHarness(t)
	corrupt := []byte(`{"version":99,"state":{"golemWindow":{"mode":"undocked"}}}`)
	h.writeFile(h.appStatePath(), corrupt)

	h.app.loadGolemWindowPreference()
	if h.mode() != appstate.ModeDocked || h.phase() != golemPhaseClosed {
		t.Fatalf("state = %s/%s after an unreadable file, want docked/closed", h.mode(), h.phase())
	}
	h.undock()

	if got, _ := h.readFile(h.appStatePath()); string(got) != string(corrupt) {
		t.Fatalf("app.json = %s, want it byte-for-byte preserved", got)
	}
}

func TestLoadGolemWindowPreferenceMarksRestorePending(t *testing.T) {
	h := newGolemHarness(t)
	h.writeFile(h.appStatePath(), []byte(
		`{"version":1,"state":{"golemWindow":{"mode":"undocked","x":40,"y":50,"width":500,"height":760}}}`))

	h.app.loadGolemWindowPreference()
	state := h.state()
	if !state.RestorePending {
		t.Fatal("an undocked preference did not mark the restore pending")
	}
	if state.Mode != appstate.ModeDocked || state.Phase != golemPhaseClosed {
		t.Fatalf("state = %s/%s before the restore, want docked/closed", state.Mode, state.Phase)
	}

	// The first attempted restore clears the pending flag, so a failure cannot
	// become an automatic reopen loop.
	h.failFactoryOnce()
	if err := h.app.OpenGolemWindow(h.mainCtx()); err == nil {
		t.Fatal("OpenGolemWindow returned nil after the factory refused")
	}
	if h.state().RestorePending {
		t.Fatal("restorePending survived the first attempted restore")
	}

	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("second OpenGolemWindow: %v", err)
	}
	options := h.lastOptions()
	if options.X != 40 || options.Y != 50 || options.Width != 500 || options.Height != 760 {
		t.Fatalf("restored options = %+v, want the persisted frame", options)
	}
	if options.MinWidth != golemWindowMinWidth || options.MinHeight != golemWindowMinHeight {
		t.Fatalf("minimums = %dx%d, want %dx%d",
			options.MinWidth, options.MinHeight, golemWindowMinWidth, golemWindowMinHeight)
	}
	if !options.UseApplicationMenu {
		t.Error("UseApplicationMenu was not set on the satellite window")
	}
	if !strings.Contains(options.Title, "Golem") {
		t.Errorf("Title = %q, want the Golem window title", options.Title)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The three readers below exist only for these tests, so they live here rather
// than widening the production surface. They take the same lock the state
// machine does and make no native call.

// golemObserving reports whether the bounded retirement observer is running.
func (a *App) golemObserving() bool {
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	return a.golemWin.observing
}

// golemRetirementFailed reports a close whose captured native id never left the
// window manager within the bounded wait. The phase stays closing until an
// explicit recovery request rechecks that same id.
func (a *App) golemRetirementFailed() bool {
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	return a.golemWin.retirementFailed
}

// golemLastNormalFrame is the most recent non-minimised, non-maximised,
// non-fullscreen frame held in memory.
func (a *App) golemLastNormalFrame() appstate.GolemWindow {
	a.golemWinMu.Lock()
	defer a.golemWinMu.Unlock()
	return a.golemWin.lastNormal
}

// waitForGolem polls an in-process condition the bounded observer settles
// asynchronously. It never sleeps on wall-clock behaviour under test: the
// observer's own clock is the production one, and this only bounds the test.
func waitForGolem(t *testing.T, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition never became true")
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Shared wire fixture
// ---------------------------------------------------------------------------

// golemWireFixture mirrors frontend/src/__tests__/fixtures/golemWindowWire.json.
// The same file is read by relayCore.test.ts, which asserts the TS cores EMIT
// exactly these messages; this side proves Go COMMITS them. A field that moves
// on either side fails one suite or the other instead of only the live app.
type golemWireFixture struct {
	Instance uint64 `json:"instance"`
	Undock   struct {
		Handoff uint64               `json:"handoff"`
		Views   []GolemWindowMessage `json:"views"`
		Drafts  GolemWindowMessage   `json:"drafts"`
		Ready   GolemWindowMessage   `json:"ready"`
	} `json:"undock"`
	Redock struct {
		Handoff uint64             `json:"handoff"`
		Drafts  GolemWindowMessage `json:"drafts"`
		Ack     GolemWindowMessage `json:"ack"`
	} `json:"redock"`
}

func TestGolemWindowWireFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("frontend", "src", "__tests__", "fixtures", "golemWindowWire.json"))
	if err != nil {
		t.Fatalf("shared wire fixture: %v", err)
	}
	var wire golemWireFixture
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatalf("shared wire fixture is not parseable: %v", err)
	}

	h := newGolemHarness(t)
	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("OpenGolemWindow: %v", err)
	}
	if _, err := h.app.BootstrapGolemWindow(h.satCtx()); err != nil {
		t.Fatalf("BootstrapGolemWindow: %v", err)
	}
	if h.instance() != wire.Instance || h.handoff() != wire.Undock.Handoff {
		t.Fatalf("live instance/handoff = %d/%d, the fixture names %d/%d",
			h.instance(), h.handoff(), wire.Instance, wire.Undock.Handoff)
	}
	for _, view := range wire.Undock.Views {
		if err := h.app.PostGolemWindowMessage(h.mainCtx(), view); err != nil {
			t.Fatalf("fixture view %d: %v", view.Revision, err)
		}
	}
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), wire.Undock.Drafts); err != nil {
		t.Fatalf("fixture main drafts: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.satCtx(), wire.Undock.Ready); err != nil {
		t.Fatalf("fixture ready was refused: %v", err)
	}
	if h.phase() != golemPhaseReady || h.mode() != appstate.ModeUndocked {
		t.Fatalf("after the fixture ready: phase=%s mode=%s, want ready/undocked", h.phase(), h.mode())
	}
	waitForGolem(t, func() bool { return h.savedMode() == appstate.ModeUndocked })

	satellite := h.satellite()
	if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("CloseGolemWindow: %v", err)
	}
	if h.phase() != golemPhaseClosing || h.handoff() != wire.Redock.Handoff {
		t.Fatalf("after the re-dock request: phase=%s handoff=%d, the fixture names closing/%d",
			h.phase(), h.handoff(), wire.Redock.Handoff)
	}
	if err := h.app.PostGolemWindowMessage(h.satCtx(), wire.Redock.Drafts); err != nil {
		t.Fatalf("fixture satellite drafts: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), wire.Redock.Ack); err != nil {
		t.Fatalf("fixture transfer ack was refused: %v", err)
	}
	if err := h.app.ConfirmGolemWindowClose(h.satCtx(), wire.Instance, wire.Redock.Handoff); err != nil {
		t.Fatalf("ConfirmGolemWindowClose after the fixture ack: %v", err)
	}
	if satellite.countOf("close") != 1 {
		t.Fatalf("authorized close issued %d native closes, want 1", satellite.countOf("close"))
	}
	h.retire(satellite.id)
	waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
	if h.mode() != appstate.ModeDocked {
		t.Fatalf("mode = %s after the fixture re-dock, want docked", h.mode())
	}
}

// ---------------------------------------------------------------------------
// Failure reasons on the published state
// ---------------------------------------------------------------------------

func (h *golemHarness) lastModeEvent() GolemWindowState {
	h.t.Helper()
	events := h.modeEvents()
	if len(events) == 0 {
		h.t.Fatal("no window state was emitted")
	}
	return events[len(events)-1]
}

func TestGolemStateCarriesFailureReasons(t *testing.T) {
	t.Run("bootstrap deadline names itself on closing and closed, and the next open clears it", func(t *testing.T) {
		h := newGolemHarness(t)
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("OpenGolemWindow: %v", err)
		}
		satellite := h.satellite()
		h.pendingTimer().fire()
		if got := h.lastModeEvent(); got.Phase != golemPhaseClosing || got.Reason != "bootstrap deadline expired" {
			t.Fatalf("after the bootstrap deadline: phase=%s reason=%q, want closing/\"bootstrap deadline expired\"", got.Phase, got.Reason)
		}
		h.retire(satellite.id)
		waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
		if got := h.lastModeEvent(); got.Phase != golemPhaseClosed || got.Reason != "bootstrap deadline expired" {
			t.Fatalf("closed after the deadline: phase=%s reason=%q, want the deadline text kept", got.Phase, got.Reason)
		}
		if got, err := h.app.GetGolemWindowState(h.mainCtx()); err != nil || got.Reason != "bootstrap deadline expired" {
			t.Fatalf("GetGolemWindowState = %+v, %v; want the deadline reason readable after the fact", got, err)
		}
		if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("retry OpenGolemWindow: %v", err)
		}
		if got := h.lastModeEvent(); got.Phase != golemPhaseBootstrapping || got.Reason != "" {
			t.Fatalf("a fresh attempt published phase=%s reason=%q, want bootstrapping with no reason", got.Phase, got.Reason)
		}
	})

	t.Run("re-dock deadline names itself on ready and the next request clears it", func(t *testing.T) {
		h := newGolemHarness(t)
		h.undock()
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("CloseGolemWindow: %v", err)
		}
		h.pendingTimer().fire()
		if got := h.lastModeEvent(); got.Phase != golemPhaseReady || got.Reason != "draft transfer deadline expired" {
			t.Fatalf("after the transfer deadline: phase=%s reason=%q, want ready/\"draft transfer deadline expired\"", got.Phase, got.Reason)
		}
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("second CloseGolemWindow: %v", err)
		}
		if got := h.lastModeEvent(); got.Phase != golemPhaseClosing || got.Reason != "" {
			t.Fatalf("a fresh re-dock published phase=%s reason=%q, want closing with no reason", got.Phase, got.Reason)
		}
	})

	t.Run("a relayed abort reason is the one published", func(t *testing.T) {
		h := newGolemHarness(t)
		h.undock()
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("CloseGolemWindow: %v", err)
		}
		if err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
			Kind: "abort", Instance: h.instance(), Handoff: h.handoff(),
			Payload: json.RawMessage(`{"reason":"transfer refused by the window"}`),
		}); err != nil {
			t.Fatalf("abort: %v", err)
		}
		if got := h.lastModeEvent(); got.Phase != golemPhaseReady || got.Reason != "transfer refused by the window" {
			t.Fatalf("after the abort: phase=%s reason=%q, want ready with the abort text", got.Phase, got.Reason)
		}
	})

	t.Run("a stalled retirement publishes closing with a reason and the retry clears it", func(t *testing.T) {
		h := newGolemHarness(t)
		h.undock()
		satellite := h.satellite()
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("CloseGolemWindow: %v", err)
		}
		h.transferBackToMain(90, true)
		if err := h.app.ConfirmGolemWindowClose(h.satCtx(), h.instance(), h.handoff()); err != nil {
			t.Fatalf("ConfirmGolemWindowClose: %v", err)
		}
		authorized := h.lastModeEvent()
		if authorized.Phase != golemPhaseClosing || authorized.Reason != "" {
			t.Fatalf("after authorization: phase=%s reason=%q, want closing with no reason", authorized.Phase, authorized.Reason)
		}
		// The two-second retirement cap is the production constant.
		waitForGolem(t, func() bool { return h.app.golemRetirementFailed() })
		waitForGolem(t, func() bool { return h.lastModeEvent().StateRevision > authorized.StateRevision })
		stalled := h.lastModeEvent()
		if stalled.Phase != golemPhaseClosing || !strings.Contains(stalled.Reason, "has not closed within") {
			t.Fatalf("after the retirement cap: phase=%s reason=%q, want closing with the stall reason", stalled.Phase, stalled.Reason)
		}
		if got, err := h.app.GetGolemWindowState(h.mainCtx()); err != nil || got.Reason != stalled.Reason {
			t.Fatalf("GetGolemWindowState = %+v, %v; want the stall reason readable after the fact", got, err)
		}

		// The retry is published: the rail disables Dock again while the fresh
		// observer runs, instead of offering a retry that looks ignored.
		if err := h.app.CloseGolemWindow(h.mainCtx()); err != nil {
			t.Fatalf("retry CloseGolemWindow: %v", err)
		}
		retrying := h.lastModeEvent()
		if retrying.Phase != golemPhaseClosing || retrying.Reason != "" || retrying.StateRevision <= stalled.StateRevision {
			t.Fatalf("after the retry request: phase=%s reason=%q revision=%d, want a newer closing with no reason (stalled at %d)",
				retrying.Phase, retrying.Reason, retrying.StateRevision, stalled.StateRevision)
		}
		h.retire(satellite.id)
		waitForGolem(t, func() bool { return h.phase() == golemPhaseClosed })
		if got := h.lastModeEvent(); got.Phase != golemPhaseClosed || got.Reason != "" {
			t.Fatalf("after the retry: phase=%s reason=%q, want closed with no reason", got.Phase, got.Reason)
		}
	})
}

// TestFirstUndockPersistsPlacedFrame pins that the first save after a fresh
// undock writes the frame the window was actually placed at, never 0x0.
func TestFirstUndockPersistsPlacedFrame(t *testing.T) {
	h := newGolemHarness(t)
	h.undock()
	options := h.lastOptions()
	waitForGolem(t, func() bool { return h.savedMode() == appstate.ModeUndocked })
	saved, ok := h.savedState()
	if !ok {
		t.Fatal("nothing was saved after the undock")
	}
	got := saved.GolemWindow
	if got.Width <= 0 || got.Height <= 0 {
		t.Fatalf("saved frame = %+v, want a real frame, not an empty one", got)
	}
	want := appstate.GolemWindow{X: options.X, Y: options.Y, Width: options.Width, Height: options.Height}
	if got.X != want.X || got.Y != want.Y || got.Width != want.Width || got.Height != want.Height {
		t.Fatalf("saved frame = %+v, want the placed frame %+v", got, want)
	}
	if held := h.app.golemLastNormalFrame(); held != want {
		t.Fatalf("lastNormal = %+v, want the placed frame %+v", held, want)
	}
}

// ---------------------------------------------------------------------------
// A bootstrap that never reached ready owns no drafts to hand back
// ---------------------------------------------------------------------------

// TestNeverReadySatelliteCannotTransferDrafts pins spec §5.1/§5.2: an instance
// that bootstrapped but never committed ready holds main's map only as a
// deferred transfer, so its "final map" on the abort's closing is empty. Go
// refuses that transfer and the close confirmation outright, on the same
// `mode` marker both frontends read (it flips to undocked only on ready).
func TestNeverReadySatelliteCannotTransferDrafts(t *testing.T) {
	h := newGolemHarness(t)
	if err := h.app.OpenGolemWindow(h.mainCtx()); err != nil {
		t.Fatalf("OpenGolemWindow: %v", err)
	}
	if _, err := h.app.BootstrapGolemWindow(h.satCtx()); err != nil {
		t.Fatalf("BootstrapGolemWindow: %v", err)
	}
	if err := h.app.PostGolemWindowMessage(h.mainCtx(), GolemWindowMessage{
		Kind: "drafts", Instance: h.instance(), Handoff: h.handoff(), ID: 1,
		Payload: json.RawMessage(`{"c1":"docked text"}`),
	}); err != nil {
		t.Fatalf("main drafts: %v", err)
	}
	instance, handoff := h.instance(), h.handoff()
	// No view was ever published, so ready never came; the deadline aborts.
	h.pendingTimer().fire()
	if h.phase() != golemPhaseClosing || h.mode() != appstate.ModeDocked {
		t.Fatalf("after the abort: phase=%s mode=%s, want closing/docked", h.phase(), h.mode())
	}

	// The satellite's own outbound id is 1 as well: the collision that let
	// main record an empty map as the re-dock transfer before this guard.
	err := h.app.PostGolemWindowMessage(h.satCtx(), GolemWindowMessage{
		Kind: "drafts", Instance: instance, Handoff: handoff, ID: 1,
		Payload: json.RawMessage(`{}`),
	})
	if err == nil || !strings.Contains(err.Error(), "never became ready") {
		t.Fatalf("satellite drafts during an aborted bootstrap = %v, want a never-ready refusal", err)
	}
	for _, envelope := range h.relayed() {
		if envelope.From == golemWindowRoleSatellite && envelope.Message.Kind == "drafts" {
			t.Fatalf("an empty satellite map was relayed to main: %+v", envelope)
		}
	}
	err = h.app.ConfirmGolemWindowClose(h.satCtx(), instance, handoff)
	if err == nil || !strings.Contains(err.Error(), "never became ready") {
		t.Fatalf("ConfirmGolemWindowClose during an aborted bootstrap = %v, want a never-ready refusal", err)
	}
	if h.phase() != golemPhaseClosing {
		t.Fatalf("phase = %s after the refusals, want closing untouched", h.phase())
	}
}
