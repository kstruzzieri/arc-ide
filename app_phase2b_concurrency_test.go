//go:build !windows

package main

import (
	"firn/internal/runprofile"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

func phase2BOpenFIFOForBlockedReader(t *testing.T, path string) *os.File {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		fd, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			return os.NewFile(uintptr(fd), path)
		}
		if err != syscall.ENXIO {
			t.Fatalf("open fifo writer: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("launch did not reach blocked preflight")
	return nil
}

func TestAppPhase2B_ShutdownClosesAdmissionBeforeStopAll(t *testing.T) {
	var eventMu sync.Mutex
	statusEvents := 0
	executor := runprofile.NewExecutor(func(event string, _ any) {
		if event == "run:status" {
			eventMu.Lock()
			statusEvents++
			eventMu.Unlock()
		}
	}, nil)
	app := &App{executor: executor}
	root := t.TempDir()
	fifo := filepath.Join(root, "launch.env")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	marker := filepath.Join(root, "spawned")
	profile := runprofile.RunProfile{
		ID:      "shutdown-race",
		Name:    "Shutdown race",
		Type:    runprofile.ProfileTypeSingle,
		Command: fmt.Sprintf("printf spawned > %q; sleep 30", marker),
		EnvFile: fifo,
	}
	epoch := executor.CurrentEpoch()
	startDone := make(chan error, 1)
	go func() {
		startDone <- executor.StartAtEpoch(epoch, root, profile)
	}()
	writer := phase2BOpenFIFOForBlockedReader(t, fifo)

	app.beginRunShutdown()
	if !app.executor.StopAll(500 * time.Millisecond) {
		t.Fatal("shutdown StopAll did not finish")
	}
	if _, err := writer.WriteString("X=1\n"); err != nil {
		t.Fatalf("release blocked preflight: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close fifo writer: %v", err)
	}
	if err := <-startDone; err == nil {
		t.Fatal("preflight launch succeeded after shutdown completed")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("preflight launch spawned after shutdown")
	} else if !os.IsNotExist(err) {
		t.Fatalf("probe shutdown marker: %v", err)
	}
	eventMu.Lock()
	defer eventMu.Unlock()
	if statusEvents != 0 {
		t.Fatalf("shutdown-rejected launch emitted %d status events", statusEvents)
	}
}

func TestAppPhase2B_ShutdownAdmissionCannotBeReopenedByWorkspaceLoad(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(nil, nil)
	t.Cleanup(func() { app.executor.StopAll(2 * time.Second) }) //nolint:errcheck

	app.beginRunShutdown()
	root := t.TempDir()
	if err := app.LoadRunProfiles(root); err != nil {
		t.Fatalf("LoadRunProfiles after shutdown: %v", err)
	}

	profile := runprofile.RunProfile{
		ID:      "post-shutdown",
		Name:    "Post shutdown",
		Type:    runprofile.ProfileTypeSingle,
		Command: "sleep 30",
	}
	if err := app.executor.StartAtEpoch(app.executor.CurrentEpoch(), root, profile); err == nil {
		t.Fatal("workspace load reopened run admission after shutdown")
	}
}

func TestAppPhase2B_RecencyUsesLaunchAttemptOrderNotSpawnCompletion(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(nil, nil)
	app.emitFn = func(string, any) {}
	t.Cleanup(func() { app.executor.StopAll(2 * time.Second) }) //nolint:errcheck
	root := t.TempDir()
	if err := app.LoadRunProfiles(root); err != nil {
		t.Fatalf("LoadRunProfiles: %v", err)
	}

	fifo := filepath.Join(root, "launch.env")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	blocked := runprofile.RunProfile{
		ID:          "profile-p",
		Name:        "Profile P",
		Type:        runprofile.ProfileTypeSingle,
		Command:     "sleep 1",
		EnvFile:     fifo,
		WorkspaceID: "project",
	}
	later := runprofile.RunProfile{
		ID:          "profile-q",
		Name:        "Profile Q",
		Type:        runprofile.ProfileTypeSingle,
		Command:     "sleep 1",
		WorkspaceID: "project",
	}
	for _, profile := range []runprofile.RunProfile{blocked, later} {
		result, err := app.SaveRunProfile(profile)
		if err != nil || !result.Valid {
			t.Fatalf("SaveRunProfile(%s): result=%#v err=%v", profile.ID, result, err)
		}
	}

	firstDone := make(chan error, 1)
	go func() {
		firstDone <- app.StartRunProfile(blocked.ID)
	}()
	writer := phase2BOpenFIFOForBlockedReader(t, fifo)

	unblocked := blocked
	unblocked.EnvFile = ""
	if result, err := app.SaveRunProfile(unblocked); err != nil || !result.Valid {
		t.Fatalf("unblock saved profile: result=%#v err=%v", result, err)
	}
	if err := app.StartRunProfile(unblocked.ID); err != nil {
		t.Fatalf("newer same-profile start: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	if err := app.StartRunProfile(later.ID); err != nil {
		t.Fatalf("later profile start: %v", err)
	}
	time.Sleep(10 * time.Millisecond)

	if _, err := writer.WriteString("X=1\n"); err != nil {
		t.Fatalf("release older start: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close fifo writer: %v", err)
	}
	if err := <-firstDone; err != nil {
		t.Fatalf("older delayed start: %v", err)
	}

	state := app.GetRunProfilesSnapshot().ProfileState
	if p, q := state[blocked.ID].LastRunAt, state[later.ID].LastRunAt; p >= q {
		t.Fatalf("reverse spawn completion moved profile P recency (%d) ahead of later profile Q (%d)", p, q)
	}
}
