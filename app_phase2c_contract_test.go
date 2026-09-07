//go:build !windows

package main

import (
	"encoding/json"
	"firn/internal/filesystem"
	"firn/internal/runhistory"
	"firn/internal/runprofile"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"firn/internal/workspace"
)

type phase2CBlockingMkdirFS struct {
	filesystem.FileSystem
	entered chan struct{}
	release chan struct{}
	mu      sync.Mutex
	blocked bool
}

func (blocking *phase2CBlockingMkdirFS) MkdirAll(path string, perm fs.FileMode) error {
	blocking.mu.Lock()
	shouldBlock := !blocking.blocked
	blocking.blocked = true
	blocking.mu.Unlock()
	if shouldBlock {
		close(blocking.entered)
		<-blocking.release
	}
	return blocking.FileSystem.MkdirAll(path, perm)
}

func phase2CRecordInputWithEpoch(t *testing.T, epoch uint64) runhistory.RecordInput {
	t.Helper()
	input := runhistory.RecordInput{
		Kind:        runhistory.RecordKindOrdinary,
		ProfileID:   "build",
		ProfileName: "Build",
		State:       "success",
		StartedAt:   100,
		CompletedAt: 200,
	}
	data, err := json.Marshal(map[string]uint64{"workspaceEpoch": epoch})
	if err != nil {
		t.Fatalf("Marshal(workspaceEpoch): %v", err)
	}
	if err := json.Unmarshal(data, &input); err != nil {
		t.Fatalf("Unmarshal(workspaceEpoch): %v", err)
	}
	return input
}

type phase2CStatusLog struct {
	mu       sync.Mutex
	statuses []runprofile.RunStatus
}

func (log *phase2CStatusLog) emit(event string, data any) {
	if event != "run:status" {
		return
	}
	status, ok := data.(runprofile.RunStatus)
	if !ok {
		return
	}
	log.mu.Lock()
	defer log.mu.Unlock()
	log.statuses = append(log.statuses, status)
}

func (log *phase2CStatusLog) waitFor(
	t *testing.T,
	runInstanceID string,
	state runprofile.RunState,
) runprofile.RunStatus {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		log.mu.Lock()
		for _, status := range log.statuses {
			if status.State == state &&
				(runInstanceID == "" || status.RunInstanceID == runInstanceID) {
				log.mu.Unlock()
				return status
			}
		}
		log.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("run %q did not reach %q", runInstanceID, state)
	return runprofile.RunStatus{}
}

func TestAppPhase2C_WorkspaceSwitchUsesAdministrativeStopReason(t *testing.T) {
	log := &phase2CStatusLog{}
	app := NewApp()
	app.executor = runprofile.NewExecutor(log.emit, nil)
	app.emitFn = func(string, any) {}
	firstRoot := t.TempDir()
	secondRoot := t.TempDir()
	if err := app.LoadRunProfiles(firstRoot); err != nil {
		t.Fatalf("LoadRunProfiles(first): %v", err)
	}
	result, err := app.SaveRunProfile(runprofile.RunProfile{
		ID:          "switching",
		Name:        "Switching",
		Type:        runprofile.ProfileTypeSingle,
		Source:      runprofile.ProfileSourceUser,
		Command:     "sleep 30",
		WorkspaceID: "project",
	})
	if err != nil || !result.Valid {
		t.Fatalf("SaveRunProfile: result=%#v err=%v", result, err)
	}
	if err := app.StartRunProfile("switching"); err != nil {
		t.Fatalf("StartRunProfile: %v", err)
	}
	running := log.waitFor(t, "", runprofile.RunStateRunning)

	if err := app.LoadRunProfiles(secondRoot); err != nil {
		t.Fatalf("LoadRunProfiles(second): %v", err)
	}
	stopped := log.waitFor(t, running.RunInstanceID, runprofile.RunStateStopped)
	if got := stopped.Reason; got != "workspace-switch" {
		t.Fatalf("workspace-switch reason = %q, want %q", got, "workspace-switch")
	}
}

func TestAppPhase2C_HomeResolutionFailureIsVisibleAndNeverUsesRelativeFirn(t *testing.T) {
	t.Setenv("HOME", "")
	cwd := t.TempDir()
	t.Chdir(cwd)

	app := NewApp()
	err := app.SaveWorkspaceState(workspace.State{
		WorkspacePath: "/repo",
		WorkspaceName: "Repo",
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "home") {
		t.Errorf("SaveWorkspaceState error = %v, want explicit home-resolution error", err)
	}
	if _, statErr := os.Stat(filepath.Join(cwd, ".firn")); !os.IsNotExist(statErr) {
		t.Errorf("relative .firn was created when HOME was unavailable: %v", statErr)
	}
}

func TestAppPhase2C_BeforeCloseCallsReasonedStopAllWithShutdownLiteral(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "app.go", nil, 0)
	if err != nil {
		t.Fatalf("parse app.go: %v", err)
	}
	// The stop lives in the drain the §5.5 machine starts, not in the shouldQuit
	// edge itself: the first quit request only asks the frontend.
	var drain *ast.FuncDecl
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Name.Name == "startCloseDrain" {
			drain = function
			break
		}
	}
	if drain == nil {
		t.Fatal("app.go has no startCloseDrain method")
	}

	found := false
	ast.Inspect(drain.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) != 2 {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "StopAllWithReason" {
			return true
		}
		reason, ok := call.Args[1].(*ast.BasicLit)
		if ok && reason.Kind == token.STRING && reason.Value == `"shutdown"` {
			found = true
		}
		return true
	})
	if !found {
		t.Fatal(`startCloseDrain must call StopAllWithReason(timeout, "shutdown")`)
	}
}

func TestAppPhase2C_AdministrativeDrainTagsBeforeStopping(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "app.go", nil, 0)
	if err != nil {
		t.Fatalf("parse app.go: %v", err)
	}
	required := map[string]string{
		"beginRunShutdown":      "shutdown",
		"loadRunProfilesLocked": "workspace-switch",
	}
	for functionName, reason := range required {
		found := false
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Name.Name != functionName {
				continue
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok || len(call.Args) != 1 {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || selector.Sel.Name != "BeginDrainWithReason" {
					return true
				}
				literal, ok := call.Args[0].(*ast.BasicLit)
				if ok && literal.Kind == token.STRING && literal.Value == `"`+reason+`"` {
					found = true
				}
				return true
			})
		}
		if !found {
			t.Errorf("%s must atomically begin drain with reason %q", functionName, reason)
		}
	}
}

func TestAppPhase2C_WailsRunHistorySurfaceUsesActiveWorkspace(t *testing.T) {
	var _ func(*App) (runhistory.Snapshot, error) = (*App).GetRunHistorySnapshot                         //nolint:staticcheck // Exact Wails signature contract.
	var _ func(*App, runhistory.RecordInput) (runhistory.Summary, error) = (*App).AppendRunHistoryRecord //nolint:staticcheck // Exact Wails signature contract.
	var _ func(*App, string) (runhistory.Record, error) = (*App).GetRunHistoryRecord                     //nolint:staticcheck // Exact Wails signature contract.
	var _ func(*App, string) error = (*App).ClearRunHistoryRecord                                        //nolint:staticcheck // Exact Wails signature contract.
	var _ func(*App) error = (*App).ClearAllRunHistory                                                   //nolint:staticcheck // Exact Wails signature contract.
}

func TestAppPhase2C_StalledAppendDoesNotBlockSwitchAndStaysInCapturedWorkspace(t *testing.T) {
	baseFS := filesystem.NewOS()
	blockingFS := &phase2CBlockingMkdirFS{
		FileSystem: baseFS,
		entered:    make(chan struct{}),
		release:    make(chan struct{}),
	}
	app := NewApp()
	app.executor = runprofile.NewExecutor(func(string, any) {}, nil)
	app.emitFn = func(string, any) {}
	workspaceA := t.TempDir()
	workspaceB := t.TempDir()
	if err := app.LoadRunProfiles(workspaceA); err != nil {
		t.Fatalf("LoadRunProfiles(A): %v", err)
	}
	epochA := app.executor.CurrentEpoch()
	historyRoot := t.TempDir()
	app.runHistoryStore = runhistory.NewStore(blockingFS, historyRoot)
	inputA := phase2CRecordInputWithEpoch(t, epochA)

	appendDone := make(chan error, 1)
	go func() {
		_, err := app.AppendRunHistoryRecord(inputA)
		appendDone <- err
	}()
	<-blockingFS.entered

	loadDone := make(chan error, 1)
	go func() {
		loadDone <- app.LoadRunProfiles(workspaceB)
	}()
	select {
	case err := <-loadDone:
		if err != nil {
			t.Fatalf("LoadRunProfiles(B): %v", err)
		}
	case <-time.After(time.Second):
		close(blockingFS.release)
		<-appendDone
		t.Fatal("LoadRunProfiles(B) blocked behind workspace A history I/O")
	}

	close(blockingFS.release)
	if err := <-appendDone; err != nil {
		t.Fatalf("AppendRunHistoryRecord: %v", err)
	}
	snapshotA, err := app.runHistoryStore.Snapshot(workspaceA)
	if err != nil || len(snapshotA.Summaries) != 1 {
		t.Fatalf("Snapshot(A) = %#v, err = %v; want captured append", snapshotA, err)
	}
	snapshotB, err := app.runHistoryStore.Snapshot(workspaceB)
	if err != nil || len(snapshotB.Summaries) != 0 {
		t.Fatalf("Snapshot(B) = %#v, err = %v; want no captured A append", snapshotB, err)
	}
}

func TestAppPhase2C_LatePriorEpochAppendIsRejectedFromActiveWorkspace(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(func(string, any) {}, nil)
	app.emitFn = func(string, any) {}
	workspaceA := t.TempDir()
	workspaceB := t.TempDir()
	if err := app.LoadRunProfiles(workspaceA); err != nil {
		t.Fatalf("LoadRunProfiles(A): %v", err)
	}
	epochA := app.executor.CurrentEpoch()
	if err := app.LoadRunProfiles(workspaceB); err != nil {
		t.Fatalf("LoadRunProfiles(B): %v", err)
	}
	app.runHistoryStore = runhistory.NewStore(filesystem.NewOS(), t.TempDir())

	_, err := app.AppendRunHistoryRecord(phase2CRecordInputWithEpoch(t, epochA))
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "epoch") {
		t.Fatalf("late AppendRunHistoryRecord error = %v, want epoch mismatch", err)
	}
	snapshot, snapshotErr := app.runHistoryStore.Snapshot(workspaceB)
	if snapshotErr != nil || len(snapshot.Summaries) != 0 {
		t.Fatalf("Snapshot(B) = %#v, err = %v; late A record was misattributed", snapshot, snapshotErr)
	}
}

func TestAppPhase2C_BeginRunShutdownDoesNotWaitForProfileLoadLock(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(nil, nil)
	app.profileMu.Lock()
	done := make(chan struct{})
	go func() {
		app.beginRunShutdown()
		close(done)
	}()

	select {
	case <-done:
		app.profileMu.Unlock()
	case <-time.After(500 * time.Millisecond):
		app.profileMu.Unlock()
		<-done
		t.Fatal("beginRunShutdown waited for the profile load lock")
	}
}

func TestAppPhase2C_ShutdownDrainStillPersistsPreShutdownEpochRecords(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(func(string, any) {}, nil)
	app.emitFn = func(string, any) {}
	workspacePath := t.TempDir()
	if err := app.LoadRunProfiles(workspacePath); err != nil {
		t.Fatalf("LoadRunProfiles: %v", err)
	}
	app.runHistoryStore = runhistory.NewStore(filesystem.NewOS(), t.TempDir())
	acceptedEpoch := app.executor.CurrentEpoch()

	// Closing advances the epoch to shut admission, but the frontend's
	// best-effort drain runs afterwards and still carries records the frontend
	// accepted before the close. They belong to the same workspace.
	app.beginRunShutdown()
	if drained := app.executor.CurrentEpoch(); drained == acceptedEpoch {
		t.Fatalf("beginRunShutdown did not advance the epoch (still %d)", drained)
	}

	summary, err := app.AppendRunHistoryRecord(phase2CRecordInputWithEpoch(t, acceptedEpoch))
	if err != nil {
		t.Fatalf("queued pre-shutdown record was dropped by the close drain: %v", err)
	}
	if summary.HistoryID == "" {
		t.Fatalf("summary = %#v, want a durable history ID", summary)
	}
	snapshot, snapshotErr := app.runHistoryStore.Snapshot(workspacePath)
	if snapshotErr != nil || len(snapshot.Summaries) != 1 {
		t.Fatalf("Snapshot = %#v, err = %v; want the drained record persisted", snapshot, snapshotErr)
	}
}

func TestAppPhase2C_PreShutdownEpochAppendAfterWorkspaceLoadStaysInCapturedWorkspace(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(func(string, any) {}, nil)
	app.emitFn = func(string, any) {}
	workspaceA := t.TempDir()
	workspaceB := t.TempDir()
	if err := app.LoadRunProfiles(workspaceA); err != nil {
		t.Fatalf("LoadRunProfiles(A): %v", err)
	}
	epochA := app.executor.CurrentEpoch()
	app.runHistoryStore = runhistory.NewStore(filesystem.NewOS(), t.TempDir())

	app.beginRunShutdown()
	if err := app.LoadRunProfiles(workspaceB); err != nil {
		t.Fatalf("LoadRunProfiles(B) after shutdown: %v", err)
	}
	saved, err := app.AppendRunHistoryRecord(phase2CRecordInputWithEpoch(t, epochA))
	if err != nil {
		t.Fatalf("queued pre-shutdown AppendRunHistoryRecord: %v", err)
	}

	snapshotA, err := app.runHistoryStore.Snapshot(workspaceA)
	if err != nil || len(snapshotA.Summaries) != 1 ||
		snapshotA.Summaries[0].HistoryID != saved.HistoryID {
		t.Fatalf("Snapshot(A) = %#v, err = %v; want queued record %q", snapshotA, err, saved.HistoryID)
	}
	snapshotB, err := app.runHistoryStore.Snapshot(workspaceB)
	if err != nil || len(snapshotB.Summaries) != 0 {
		t.Fatalf("Snapshot(B) = %#v, err = %v; want no workspace A record", snapshotB, err)
	}
}

func TestAppPhase2C_ShutdownDrainStillRejectsOtherWorkspaceEpochs(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(func(string, any) {}, nil)
	app.emitFn = func(string, any) {}
	workspaceA := t.TempDir()
	workspaceB := t.TempDir()
	if err := app.LoadRunProfiles(workspaceA); err != nil {
		t.Fatalf("LoadRunProfiles(A): %v", err)
	}
	epochA := app.executor.CurrentEpoch()
	if err := app.LoadRunProfiles(workspaceB); err != nil {
		t.Fatalf("LoadRunProfiles(B): %v", err)
	}
	app.runHistoryStore = runhistory.NewStore(filesystem.NewOS(), t.TempDir())
	app.beginRunShutdown()

	// Shutdown widens acceptance by exactly the epoch it superseded, never by
	// an epoch belonging to a workspace the user already left.
	_, err := app.AppendRunHistoryRecord(phase2CRecordInputWithEpoch(t, epochA))
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "epoch") {
		t.Fatalf("shutdown-time AppendRunHistoryRecord error = %v, want epoch mismatch", err)
	}
	snapshot, snapshotErr := app.runHistoryStore.Snapshot(workspaceB)
	if snapshotErr != nil || len(snapshot.Summaries) != 0 {
		t.Fatalf("Snapshot(B) = %#v, err = %v; workspace A record was misattributed", snapshot, snapshotErr)
	}
}
