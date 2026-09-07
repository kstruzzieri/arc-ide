package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestAppEmitIsNotVariadic and TestAppEmitFnIsNotVariadic make the "emit is a
// single-payload call, compiler-enforced" claim self-verifying: if (*App).emit
// or the App.emitFn field ever regains a variadic ...any parameter, these
// fail directly via reflection, without relying on the AST guard below to
// notice the drift.
func TestAppEmitIsNotVariadic(t *testing.T) {
	t.Parallel()

	got := reflect.TypeOf((*App).emit).IsVariadic()
	if got {
		t.Errorf("reflect.TypeOf((*App).emit).IsVariadic() = %t, want false", got)
	}
}

func TestAppEmitFnIsNotVariadic(t *testing.T) {
	t.Parallel()

	field, ok := reflect.TypeOf(App{}).FieldByName("emitFn")
	if !ok {
		t.Fatal("reflect.TypeOf(App{}).FieldByName(\"emitFn\") not found")
	}
	if field.Type.IsVariadic() {
		t.Error("App.emitFn is variadic, want fixed func(string, any)")
	}
}

func TestEmitTerminalOutputSinglePayload(t *testing.T) {
	a := NewApp()
	var gotEvent string
	var gotData any
	a.emitFn = func(event string, data any) {
		gotEvent = event
		gotData = data
	}

	a.emitTerminalOutput("term-1", "hello")

	if gotEvent != "terminal:output" {
		t.Fatalf("event = %q, want terminal:output", gotEvent)
	}
	ev, ok := gotData.(TerminalOutputEvent)
	if !ok {
		t.Fatalf("payload type = %T, want TerminalOutputEvent", gotData)
	}
	if ev.TermID != "term-1" || ev.Data != "hello" {
		t.Fatalf("payload = %+v", ev)
	}

	b, err := json.Marshal(gotData)
	if err != nil || string(b) != `{"termId":"term-1","data":"hello"}` {
		t.Fatalf("wire shape = %s (err %v), want exact keys termId/data - Terminal.tsx depends on them", b, err)
	}
}

// The functions below enforce a single choke point for Wails event emission:
// only (*App).emit in root app.go may push an event to the frontend. v2 had one
// emit surface (the runtime.EventsEmit package function); v3 has several
// methods, all reachable from the handles App now holds - EventManager.Emit and
// EventManager.EmitEvent on a.v3app.Event, and the variadic
// WebviewWindow.EmitEvent on a.mainWindow, which would put two payloads on the
// wire and break the single-payload contract Terminal.tsx depends on. So the
// guard keys on the METHOD NAME and ignores the receiver: any selector named
// Emit or EmitEvent, called or taken as a method value, on anything, is an
// emission. That catches a.v3app.Event.EmitEvent(ev), a.mainWindow.EmitEvent(…),
// application.Get().Event.Emit(…), and a hoisted manager
// (bus := a.v3app.Event; bus.Emit(…)) alike, whatever a file called its import -
// which is also why the v2 alias and dot-import rules are gone: no import name
// takes part in the decision any more.
//
// Being name-based makes the rule deliberately broad. Census at d85e854: the
// repo declares no Emit or EmitEvent method or interface method of its own and
// has no such call site outside the seam, so there are no false positives
// today. A future in-repo type that grows an Emit/EmitEvent method trips this
// guard loudly - and that is the intended outcome: rename it, or widen the
// guard deliberately, never bypass it silently. Its limits are the limits of
// any static scan: an emission reached by reflection or by a method name built
// at run time is out of scope, as it was under v2.
//
// The scan is anti-vacuous: TestOnlyAppEmitReferencesWailsEventsEmit fails
// if it finds zero allowed references (its `allowed == 0` check), so renaming
// or moving the seam, or breaking its fixed shape, fails loudly instead of
// silently disabling the guard.
const wailsApplicationImportPath = "github.com/wailsapp/wails/v3/pkg/application"

var eventEmitScanSkipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"frontend":     true,
	".claude":      true,
	".superpowers": true,
	"testdata":     true,
}

const eventEmitScanRoot = "."

func isAppEmitSeam(path string, fn *ast.FuncDecl) bool {
	if filepath.Clean(path) != "app.go" || fn.Name.Name != "emit" || fn.Recv == nil || len(fn.Recv.List) != 1 {
		return false
	}
	ptr, ok := fn.Recv.List[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	receiver, ok := ptr.X.(*ast.Ident)
	return ok && receiver.Name == "App"
}

// eventEmitSelector reports whether expr selects one of v3's emit methods by
// name, on any receiver: EventManager.Emit, EventManager.EmitEvent, or
// WebviewWindow.EmitEvent. Receiver-agnostic on purpose - see the rule above.
func eventEmitSelector(expr ast.Expr) (*ast.SelectorExpr, bool) {
	sel, ok := expr.(*ast.SelectorExpr)
	if !ok {
		return nil, false
	}
	return sel, sel.Sel.Name == "Emit" || sel.Sel.Name == "EmitEvent"
}

// validAppEmitCall reports whether call is the fixed-shape
// a.v3app.Event.Emit(event) or a.v3app.Event.Emit(event, data) invocation the
// seam is allowed to make, and if not, a reason naming the specific defect.
// It must be Emit on the app's own event manager - not EmitEvent, not the
// window emitter, not a hoisted local standing in for the manager - and every
// argument must be the exact identifier emit's own signature received, so the
// payload in particular cannot be a literal nil: that would let the seam
// smuggle a hardcoded no-payload emission in place of actually forwarding the
// caller's data.
func validAppEmitCall(sel *ast.SelectorExpr, call *ast.CallExpr) (bool, string) {
	if call.Ellipsis.IsValid() {
		return false, "must not spread its arguments with ellipsis"
	}
	const receiverRule = "must emit through a.v3app.Event.Emit"
	if sel.Sel.Name != "Emit" {
		return false, receiverRule
	}
	bus, busOK := sel.X.(*ast.SelectorExpr)
	if !busOK || bus.Sel.Name != "Event" {
		return false, receiverRule
	}
	host, hostOK := bus.X.(*ast.SelectorExpr)
	if !hostOK {
		return false, receiverRule
	}
	receiver, receiverOK := host.X.(*ast.Ident)
	if !receiverOK || receiver.Name != "a" || host.Sel.Name != "v3app" {
		return false, receiverRule
	}
	if len(call.Args) != 1 && len(call.Args) != 2 {
		return false, "must be a fixed 1- or 2-argument call"
	}
	event, eventOK := call.Args[0].(*ast.Ident)
	if !eventOK || event.Name != "event" {
		return false, "first argument must be the forwarded event identifier"
	}
	if len(call.Args) == 1 {
		return true, ""
	}
	data, ok := call.Args[1].(*ast.Ident)
	if !ok || data.Name != "data" {
		return false, "second argument must be the forwarded data identifier, not a literal"
	}
	return true, ""
}

func scanWailsEventsEmitFile(fset *token.FileSet, path string, file *ast.File) (int, []string) {
	var violations []string

	var seam *ast.BlockStmt
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Body != nil && isAppEmitSeam(path, fn) {
			seam = fn.Body
			break
		}
	}

	seamCalls := make(map[*ast.SelectorExpr]bool)
	shapes := make(map[int]int)
	if seam != nil {
		ast.Inspect(seam, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := eventEmitSelector(call.Fun)
			if !ok {
				return true
			}
			valid, reason := validAppEmitCall(sel, call)
			seamCalls[sel] = valid
			if valid {
				shapes[len(call.Args)]++
			} else {
				pos := fset.Position(call.Pos())
				violations = append(violations, fmt.Sprintf("%s:%d: %s in (*App).emit %s", pos.Filename, pos.Line, sel.Sel.Name, reason))
			}
			return true
		})
		if shapes[1] != 1 || shapes[2] != 1 {
			violations = append(violations, fmt.Sprintf("%s: (*App).emit must contain exactly one payload-free and one single-payload a.v3app.Event.Emit call", path))
		}
	}

	allowed := 0
	ast.Inspect(file, func(node ast.Node) bool {
		sel, ok := node.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		_, isEventEmit := eventEmitSelector(sel)
		if !isEventEmit {
			return true
		}
		if seam != nil && seam.Pos() <= sel.Pos() && sel.End() <= seam.End() {
			if valid, directCall := seamCalls[sel]; directCall {
				if valid {
					allowed++
				}
				return true
			}
			pos := fset.Position(sel.Pos())
			violations = append(violations, fmt.Sprintf("%s:%d: %s in (*App).emit must be called directly", pos.Filename, pos.Line, sel.Sel.Name))
			return true
		}
		pos := fset.Position(sel.Pos())
		violations = append(violations, fmt.Sprintf("%s:%d: %s referenced outside (*App).emit", pos.Filename, pos.Line, sel.Sel.Name))
		return true
	})
	return allowed, violations
}

// Every v3 emit surface, on every receiver, must be caught outside the seam:
// the aliased package handle, the App's own field, the variadic window
// emitter, the CustomEvent overload, a manager hoisted into a local, and a
// method value that is never even called.
func TestWailsEventsEmitGuardDetectsEmitOutsideTheSeam(t *testing.T) {
	t.Parallel()

	bypasses := map[string]string{
		"aliased package call": `func bypass() { wailsapp.Get().Event.Emit("terminal:output") }`,
		"stored method value":  `func bypass(a *App) { send := a.v3app.Event.Emit; _ = send }`,
		"window emit event":    `func bypass(a *App, data any) { a.mainWindow.EmitEvent("terminal:output", data, data) }`,
		"custom event":         `func bypass(a *App, ev *wailsapp.CustomEvent) { a.v3app.Event.EmitEvent(ev) }`,
		"hoisted manager":      `func bypass(a *App, event string) { bus := a.v3app.Event; bus.Emit(event) }`,
	}

	for name, body := range bypasses {
		t.Run(name, func(t *testing.T) {
			source := "package main\nimport wailsapp \"" + wailsApplicationImportPath + "\"\n" + body
			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, "bypass.go", source, 0)
			if err != nil {
				t.Fatalf("parser.ParseFile(bypass fixture) error = %v, want nil", err)
			}
			_, violations := scanWailsEventsEmitFile(fset, "bypass.go", file)
			if len(violations) != 1 {
				t.Errorf("len(scanWailsEventsEmitFile(bypass fixture).violations) = %d, want 1", len(violations))
			}
		})
	}
}

func TestWailsEventsEmitGuardRejectsInvalidSeamReferences(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"method value":   `func (a *App) emit(event string, data any) { send := a.v3app.Event.Emit; _ = send }`,
		"extra argument": `func (a *App) emit(event string, data any) { a.v3app.Event.Emit(event, data, data) }`,
		"ellipsis":       `func (a *App) emit(event string, data any) { args := []any{data}; a.v3app.Event.Emit(event, args...) }`,
		"nil payload": `func (a *App) emit(event string, data any) {
			if data == nil { a.v3app.Event.Emit(event); return }
			a.v3app.Event.Emit(event, nil)
		}`,
		"foreign bus": `func (a *App) emit(event string, data any) {
			if data == nil { application.Get().Event.Emit(event); return }
			application.Get().Event.Emit(event, data)
		}`,
		"hoisted manager": `func (a *App) emit(event string, data any) {
			bus := a.v3app.Event
			if data == nil { bus.Emit(event); return }
			bus.Emit(event, data)
		}`,
		"window emit event": `func (a *App) emit(event string, data any) {
			if data == nil { a.mainWindow.EmitEvent(event); return }
			a.mainWindow.EmitEvent(event, data)
		}`,
	}

	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			source := "package main\nimport \"" + wailsApplicationImportPath + "\"\n" + body
			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, "app.go", source, 0)
			if err != nil {
				t.Fatalf("parser.ParseFile(invalid seam fixture) error = %v, want nil", err)
			}
			_, violations := scanWailsEventsEmitFile(fset, "app.go", file)
			if len(violations) == 0 {
				t.Error("scanWailsEventsEmitFile(invalid seam fixture) returned no violations")
			}
		})
	}
}

func TestOnlyAppEmitReferencesWailsEventsEmit(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	allowed := 0
	var violations []string

	err := filepath.WalkDir(eventEmitScanRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if eventEmitScanSkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			violations = append(violations, fmt.Sprintf("%s: parse error: %v", path, err))
			return nil
		}
		fileAllowed, fileViolations := scanWailsEventsEmitFile(fset, path, file)
		allowed += fileAllowed
		violations = append(violations, fileViolations...)
		return nil
	})
	if err != nil {
		t.Fatalf("walk repository for production .go files: %v", err)
	}

	if allowed == 0 {
		violations = append(violations, "guard found no a.v3app.Event.Emit reference inside (*App).emit")
	}
	if len(violations) > 0 {
		t.Fatalf("direct Wails event-emission violations:\n%s", strings.Join(violations, "\n"))
	}
}
