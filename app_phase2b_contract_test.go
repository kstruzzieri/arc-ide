package main

import (
	"errors"
	"firn/internal/filesystem"
	"firn/internal/runprofile"
	"io/fs"
	"testing"
	"time"
)

type phase2BEpochExecutor interface {
	CurrentEpoch() uint64
	StartAtEpoch(uint64, string, runprofile.RunProfile) error
}

func TestLoadRunProfilesFailureKeepsAdmissionClosedUntilSuccessfulRetry(t *testing.T) {
	oldRoot := t.TempDir()
	brokenRoot := t.TempDir()
	retryRoot := t.TempDir()
	loadErr := errors.New("workspace unavailable")
	mockFS := &filesystem.Mock{
		ReadFileFunc: func(string) ([]byte, error) { return nil, fs.ErrNotExist },
		StatFunc:     func(string) (fs.FileInfo, error) { return nil, fs.ErrNotExist },
	}

	executor := runprofile.NewExecutor(nil, nil)
	t.Cleanup(func() { executor.StopAll(2 * time.Second) }) //nolint:errcheck
	epochExecutor, ok := any(executor).(phase2BEpochExecutor)
	if !ok {
		t.Fatal("Executor must expose epoch-bound admission for workspace load transitions")
	}
	app := NewApp()
	app.osFS = mockFS
	app.executor = executor
	loadAttempt := 0
	app.loadRunProfilesFn = func(manager *runprofile.ProjectRunProfileManager) error {
		loadAttempt++
		if loadAttempt == 2 {
			return loadErr
		}
		return manager.Load()
	}

	if err := app.LoadRunProfiles(oldRoot); err != nil {
		t.Fatalf("initial LoadRunProfiles: %v", err)
	}
	oldEpoch := epochExecutor.CurrentEpoch()
	if err := app.LoadRunProfiles(brokenRoot); !errors.Is(err, loadErr) {
		t.Fatalf("failed LoadRunProfiles error = %v, want %v", err, loadErr)
	}

	profile := runprofile.RunProfile{
		ID:      "build",
		Name:    "Build",
		Type:    runprofile.ProfileTypeSingle,
		Source:  runprofile.ProfileSourceUser,
		Command: "go version",
	}
	failedEpoch := epochExecutor.CurrentEpoch()
	if failedEpoch == oldEpoch {
		t.Fatalf("failed workspace switch kept epoch %d; each workspace identity must be distinct", oldEpoch)
	}
	if err := epochExecutor.StartAtEpoch(failedEpoch, brokenRoot, profile); err == nil {
		t.Fatal("failed workspace load reopened executor admission")
	}

	if err := app.LoadRunProfiles(retryRoot); err != nil {
		t.Fatalf("retry LoadRunProfiles: %v", err)
	}
	retryEpoch := epochExecutor.CurrentEpoch()
	if retryEpoch == failedEpoch || retryEpoch == oldEpoch {
		t.Fatalf(
			"retry workspace epoch = %d, want identity distinct from old %d and failed %d",
			retryEpoch,
			oldEpoch,
			failedEpoch,
		)
	}
	if err := epochExecutor.StartAtEpoch(oldEpoch, retryRoot, profile); err == nil {
		t.Fatal("successful retry admitted the original workspace epoch")
	}
	if err := epochExecutor.StartAtEpoch(failedEpoch, retryRoot, profile); err == nil {
		t.Fatal("successful retry admitted the failed workspace epoch")
	}
	if err := epochExecutor.StartAtEpoch(retryEpoch, retryRoot, profile); err != nil {
		t.Fatalf("successful retry did not reopen executor admission: %v", err)
	}
}

func TestRestartRunProfilePropagatesCompoundDrainErrorWithoutRecordingRecency(t *testing.T) {
	app := NewApp()
	app.executor = runprofile.NewExecutor(nil, nil)
	app.emitFn = func(string, any) {}
	t.Cleanup(func() { app.executor.StopAll(2 * time.Second) }) //nolint:errcheck
	root := t.TempDir()
	if err := app.LoadRunProfiles(root); err != nil {
		t.Fatalf("LoadRunProfiles: %v", err)
	}

	leaf := runprofile.RunProfile{
		ID:          "leaf",
		Name:        "Leaf",
		Type:        runprofile.ProfileTypeSingle,
		Command:     "go version",
		WorkspaceID: "project",
	}
	compound := runprofile.RunProfile{
		ID:          "compound",
		Name:        "Compound",
		Type:        runprofile.ProfileTypeCompound,
		Steps:       []string{leaf.ID},
		WorkspaceID: "project",
	}
	for _, profile := range []runprofile.RunProfile{leaf, compound} {
		result, err := app.SaveRunProfile(profile)
		if err != nil || !result.Valid {
			t.Fatalf("SaveRunProfile(%s): result=%#v err=%v", profile.ID, result, err)
		}
	}

	app.executor.BeginDrain()
	if err := app.RestartRunProfile(compound.ID); err == nil {
		t.Fatal("compound restart swallowed the executor drain error")
	}
	if got := app.GetRunProfilesSnapshot().ProfileState[compound.ID].LastRunAt; got != 0 {
		t.Fatalf("failed compound restart recorded recency %d", got)
	}
}
