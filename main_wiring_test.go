package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// main() is the one place the App is joined to the v3 runtime, and none of
// that wiring is reachable from a unit test: application.New starts a real
// platform app. So the wiring is checked structurally instead. Every clause
// below is load-bearing, and silently losing one breaks a whole feature with
// no failing test:
//
//   - Services / application.NewService(app): without it the generated
//     bindings resolve to nothing and the entire frontend API is dead.
//   - ShouldQuit: app.shouldQuit: the §5.5 close handshake's OS edge. Absent,
//     Cmd+Q quits immediately and skips the drain.
//   - app.v3app and app.mainWindow: the handles (*App).emit, (*App).quit,
//     ToggleMaximize and OpenFolderDialog need; unset, they all no-op.
//   - the events.Common.WindowClosing hook calling app.handleMainWindowClosing:
//     without it the close button bypasses the handshake entirely.
//   - wapp.Menu.Set(buildAppMenu(app, wapp)): the only registration of the
//     global menu. Absent, Navigate/Workspace vanish on every platform, and
//     macOS also loses the AppMenu/EditMenu roles that wire Cmd+C/V/X/A into
//     the webview's responder chain.
//   - WebviewWindowOptions.Name: golemWindowNameMain: #271 verifies every bound
//     window call against a live handle's id AND name. Without the name, main
//     matches nothing and every Golem window binding refuses its own caller.
//   - app.golemWindowFactory / app.screenBounds / app.golemWindowPresent: the
//     three native seams the #271 window machine needs. They are installed once
//     here rather than lazily inside a concurrent bound call; unset, undocking
//     is impossible and a close can never observe its own retirement.
//   - app.loadGolemWindowPreference(): the one read of the persisted Golem
//     window mode. Absent, an undocked window is never restored after a restart.
//   - WebviewWindowOptions.UseApplicationMenu: true: Windows attaches the
//     global menu (Navigate/Workspace) to a window only when this is true;
//     absent, that build silently loses the menu and its accelerators. Linux
//     already falls back to the global menu on its own, and macOS ignores the
//     flag and always uses the NSApp menu.
//
// The matching is deliberately shallow - identifiers and selector paths, not
// types - so it states the shape of the wiring without duplicating main.go.

const mainWiringFile = "main.go"

// selectorPath renders an identifier or a chain of selectors as a dotted
// string ("app.v3app", "events.Common.WindowClosing"), or "" for anything
// else.
func selectorPath(expr ast.Expr) string {
	switch node := expr.(type) {
	case *ast.Ident:
		return node.Name
	case *ast.SelectorExpr:
		prefix := selectorPath(node.X)
		if prefix == "" {
			return ""
		}
		return prefix + "." + node.Sel.Name
	default:
		return ""
	}
}

// containsCallTo reports whether node contains a call whose callee is exactly
// the given dotted selector path. When args is non-nil the call's arguments
// must also render to exactly those selector paths.
func containsCallTo(node ast.Node, path string, args ...string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if selectorPath(call.Fun) != path {
			return true
		}
		if args != nil {
			if len(call.Args) != len(args) {
				return true
			}
			for i, want := range args {
				if selectorPath(call.Args[i]) != want {
					return true
				}
			}
		}
		found = true
		return false
	})
	return found
}

// fieldValue returns the value of the named field in any composite literal
// under node, or nil when the field is absent.
func fieldValue(node ast.Node, field string) ast.Expr {
	var value ast.Expr
	ast.Inspect(node, func(n ast.Node) bool {
		kv, ok := n.(*ast.KeyValueExpr)
		if !ok {
			return true
		}
		if key, isIdent := kv.Key.(*ast.Ident); isIdent && key.Name == field {
			value = kv.Value
			return false
		}
		return true
	})
	return value
}

// mainWindowOptionField returns the value of one field of the
// application.WebviewWindowOptions literal. fieldValue is not enough for Name:
// application.Options carries one too, and it is written first.
func mainWindowOptionField(node ast.Node, field string) ast.Expr {
	var value ast.Expr
	ast.Inspect(node, func(n ast.Node) bool {
		lit, ok := n.(*ast.CompositeLit)
		if !ok || selectorPath(lit.Type) != "application.WebviewWindowOptions" {
			return true
		}
		for _, element := range lit.Elts {
			kv, isPair := element.(*ast.KeyValueExpr)
			if !isPair {
				continue
			}
			if key, isIdent := kv.Key.(*ast.Ident); isIdent && key.Name == field {
				value = kv.Value
				return false
			}
		}
		return true
	})
	return value
}

// assignsTo reports whether node contains an assignment whose left-hand side
// is the given dotted selector path.
func assignsTo(node ast.Node, path string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		assign, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for _, lhs := range assign.Lhs {
			if selectorPath(lhs) == path {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

// registersWindowClosingHook reports whether node contains a RegisterHook call
// for events.Common.WindowClosing whose handler calls
// app.handleMainWindowClosing.
func registersWindowClosingHook(node ast.Node) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if !strings.HasSuffix(selectorPath(call.Fun), ".RegisterHook") || len(call.Args) != 2 {
			return true
		}
		if selectorPath(call.Args[0]) != "events.Common.WindowClosing" {
			return true
		}
		if containsCallTo(call.Args[1], "app.handleMainWindowClosing") {
			found = true
			return false
		}
		return true
	})
	return found
}

// callsMenuSet reports whether node registers the menu buildAppMenu returns as
// the global application menu. UseApplicationMenu on its own attaches nothing:
// the framework also needs an application menu to have been set.
func callsMenuSet(node ast.Node) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if !strings.HasSuffix(selectorPath(call.Fun), ".Menu.Set") || len(call.Args) != 1 {
			return true
		}
		if containsCallTo(call.Args[0], "buildAppMenu") {
			found = true
			return false
		}
		return true
	})
	return found
}

// scanMainWiring returns one description per missing wiring clause, or an
// empty slice when main() wires everything.
func scanMainWiring(fn *ast.FuncDecl) []string {
	var missing []string

	services := fieldValue(fn.Body, "Services")
	if services == nil || !containsCallTo(services, "application.NewService", "app") {
		missing = append(missing, "Options.Services must register application.NewService(app)")
	}

	if shouldQuit := fieldValue(fn.Body, "ShouldQuit"); selectorPath(shouldQuit) != "app.shouldQuit" {
		missing = append(missing, "Options.ShouldQuit must be app.shouldQuit")
	}
	if !assignsTo(fn.Body, "app.v3app") {
		missing = append(missing, "main must assign app.v3app")
	}
	if !assignsTo(fn.Body, "app.mainWindow") {
		missing = append(missing, "main must assign app.mainWindow")
	}
	if !callsMenuSet(fn.Body) {
		missing = append(missing, "main must call wapp.Menu.Set(buildAppMenu(app, wapp))")
	}
	if useAppMenu := fieldValue(fn.Body, "UseApplicationMenu"); selectorPath(useAppMenu) != "true" {
		missing = append(missing, "WebviewWindowOptions must set UseApplicationMenu: true")
	}
	if !registersWindowClosingHook(fn.Body) {
		missing = append(missing, "main must register events.Common.WindowClosing calling app.handleMainWindowClosing")
	}

	if name := mainWindowOptionField(fn.Body, "Name"); selectorPath(name) != "golemWindowNameMain" {
		missing = append(missing, "WebviewWindowOptions must set Name: golemWindowNameMain")
	}
	for _, seam := range []string{"app.golemWindowFactory", "app.screenBounds", "app.golemWindowPresent"} {
		if !assignsTo(fn.Body, seam) {
			missing = append(missing, "main must assign "+seam)
		}
	}
	if !containsCallTo(fn.Body, "app.loadGolemWindowPreference") {
		missing = append(missing, "main must call app.loadGolemWindowPreference()")
	}

	return missing
}

// parseMainFunc returns the `func main()` declaration in src, which is read
// from mainWiringFile when src is nil.
func parseMainFunc(t *testing.T, name string, src any) *ast.FuncDecl {
	t.Helper()

	file, err := parser.ParseFile(token.NewFileSet(), name, src, 0)
	if err != nil {
		t.Fatalf("parser.ParseFile(%s) error = %v, want nil", name, err)
	}
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.Name == "main" && fn.Body != nil {
			return fn
		}
	}
	t.Fatalf("%s declares no func main() with a body", name)
	return nil
}

func TestMainWiresTheAppIntoTheV3Runtime(t *testing.T) {
	t.Parallel()

	missing := scanMainWiring(parseMainFunc(t, mainWiringFile, nil))

	if len(missing) > 0 {
		t.Fatalf("main() wiring gaps:\n%s", strings.Join(missing, "\n"))
	}
}

// screenWindow is a main window that reports which display it is on.
type screenWindow struct {
	fakeWindow
	screen *application.Screen
	err    error
}

func (w *screenWindow) GetScreen() (*application.Screen, error) { return w.screen, w.err }

// §5.3 centres a satellite whose saved display is gone on main's screen, and
// placement treats the first work area as that fallback. So main's screen has
// to lead, with the primary next for when main reports no screen at all.
func TestGolemScreenAreasPutMainsScreenFirst(t *testing.T) {
	t.Parallel()

	primary := application.Rect{X: 0, Y: 0, Width: 2560, Height: 1440}
	secondary := application.Rect{X: -1440, Y: 0, Width: 1440, Height: 900}
	tertiary := application.Rect{X: 2560, Y: 0, Width: 1920, Height: 1080}
	mains := application.Rect{X: 4480, Y: 0, Width: 1280, Height: 800}
	screens := []*application.Screen{
		{WorkArea: secondary},
		{WorkArea: primary, IsPrimary: true},
		nil,
		{WorkArea: tertiary},
	}
	named := func(rects []application.Rect) string { return fmt.Sprintf("%+v", rects) }

	for _, tc := range []struct {
		name       string
		mainWindow application.Window
		want       []application.Rect
	}{
		{
			name:       "main's screen leads, then the primary, then the rest",
			mainWindow: &screenWindow{fakeWindow: fakeWindow{id: 1, name: golemWindowNameMain}, screen: &application.Screen{WorkArea: mains}},
			want:       []application.Rect{mains, primary, secondary, tertiary},
		},
		{
			name:       "no main window falls back to the primary",
			mainWindow: nil,
			want:       []application.Rect{primary, secondary, tertiary},
		},
		{
			name:       "an unreported screen falls back to the primary",
			mainWindow: &screenWindow{fakeWindow: fakeWindow{id: 1, name: golemWindowNameMain}, err: fmt.Errorf("no screen")},
			want:       []application.Rect{primary, secondary, tertiary},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := golemScreenAreas(screens, tc.mainWindow)

			if named(got) != named(tc.want) {
				t.Fatalf("golemScreenAreas = %s, want %s", named(got), named(tc.want))
			}
		})
	}
}

// The guard is only worth having if it fails when the wiring goes: each
// fixture below drops exactly one clause from an otherwise complete main().
func TestMainWiringGuardDetectsMissingWiring(t *testing.T) {
	t.Parallel()

	const complete = `package main
func main() {
	app := NewApp()
	wapp := application.New(application.Options{
		Services:   []application.Service{application.NewService(app)},
		ShouldQuit: app.shouldQuit,
	})
	app.v3app = wapp
	app.golemWindowFactory = newGolemWindow
	app.screenBounds = golemScreens
	app.golemWindowPresent = golemPresent
	wapp.Menu.Set(buildAppMenu(app, wapp))
	win := wapp.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:               golemWindowNameMain,
		UseApplicationMenu: true,
	})
	app.mainWindow = win
	app.loadGolemWindowPreference()
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		app.handleMainWindowClosing(e.Cancel)
	})
	_ = wapp.Run()
}
`

	if missing := scanMainWiring(parseMainFunc(t, "complete.go", complete)); len(missing) > 0 {
		t.Fatalf("scanMainWiring(complete fixture) = %v, want no gaps", missing)
	}

	mutations := map[string]string{
		"hook removed": `win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		app.handleMainWindowClosing(e.Cancel)
	})`,
		"hook handler gutted":          "app.handleMainWindowClosing(e.Cancel)",
		"services removed":             "Services:   []application.Service{application.NewService(app)},",
		"should-quit removed":          "ShouldQuit: app.shouldQuit,",
		"v3app unassigned":             "app.v3app = wapp",
		"main window unassigned":       "app.mainWindow = win",
		"menu set removed":             "wapp.Menu.Set(buildAppMenu(app, wapp))",
		"use application menu removed": "UseApplicationMenu: true,",
		"main window name removed":     "Name:               golemWindowNameMain,",
		"window factory unassigned":    "app.golemWindowFactory = newGolemWindow",
		"screen seam unassigned":       "app.screenBounds = golemScreens",
		"manager seam unassigned":      "app.golemWindowPresent = golemPresent",
		"preference load removed":      "app.loadGolemWindowPreference()",
	}

	for name, removed := range mutations {
		t.Run(name, func(t *testing.T) {
			mutated := strings.Replace(complete, removed, "", 1)
			if mutated == complete {
				t.Fatalf("fixture mutation %q did not change the source", name)
			}

			missing := scanMainWiring(parseMainFunc(t, "mutated.go", mutated))

			if len(missing) == 0 {
				t.Errorf("scanMainWiring(%q fixture) found no gap, want one", name)
			}
		})
	}
}
