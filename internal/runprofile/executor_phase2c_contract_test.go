//go:build !windows

package runprofile

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func phase2CStatusForProfile(
	t *testing.T,
	spy *emitSpy,
	profileID string,
	state RunState,
) RunStatus {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, status := range spy.statuses() {
			if status.ProfileID == profileID && status.State == state {
				return status
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("profile %q did not reach %q", profileID, state)
	return RunStatus{}
}

func phase2CTerminalStatusForProfile(t *testing.T, spy *emitSpy, profileID string) RunStatus {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, status := range spy.statuses() {
			if status.ProfileID == profileID &&
				(status.State == RunStateStopped || status.State == RunStateFailed || status.State == RunStateSuccess) {
				return status
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("profile %q did not reach a terminal state", profileID)
	return RunStatus{}
}

func TestRunStatusPhase2C_ReasonIsAdditiveAndEmptyByDefault(t *testing.T) {
	status := RunStatus{}
	if got := status.Reason; got != "" {
		t.Fatalf("zero RunStatus reason = %q, want empty", got)
	}
	data, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(data), `"reason"`) {
		t.Fatalf("empty reason was not omitted: %s", data)
	}
}

func TestExecutorPhase2C_UserStopAndExistingStopAllKeepReasonEmpty(t *testing.T) {
	t.Run("exact user stop", func(t *testing.T) {
		spy := &emitSpy{}
		executor := NewExecutor(spy.emit, nil)
		profile := newTestProfile("user-stop", "sleep 30")
		if err := executor.Start(t.TempDir(), profile); err != nil {
			t.Fatalf("Start: %v", err)
		}
		running, ok := spy.waitForState(RunStateRunning, 2*time.Second)
		if !ok {
			t.Fatal("run did not start")
		}
		if err := executor.StopRunInstance(running.RunInstanceID); err != nil {
			t.Fatalf("StopRunInstance: %v", err)
		}
		stopped := phase2BStatusFor(t, spy, running.RunInstanceID, RunStateStopped)
		if got := stopped.Reason; got != "" {
			t.Fatalf("user stop reason = %q, want empty", got)
		}
	})

	t.Run("compatibility StopAll", func(t *testing.T) {
		spy := &emitSpy{}
		executor := NewExecutor(spy.emit, nil)
		profile := newTestProfile("default-stop-all", "sleep 30")
		if err := executor.Start(t.TempDir(), profile); err != nil {
			t.Fatalf("Start: %v", err)
		}
		running, ok := spy.waitForState(RunStateRunning, 2*time.Second)
		if !ok {
			t.Fatal("run did not start")
		}
		if !executor.StopAll(2 * time.Second) {
			t.Fatal("StopAll did not finish")
		}
		stopped := phase2BStatusFor(t, spy, running.RunInstanceID, RunStateStopped)
		if got := stopped.Reason; got != "" {
			t.Fatalf("compatibility StopAll reason = %q, want empty", got)
		}
	})
}

func TestExecutorPhase2C_AdministrativeStopAllReasonsOrdinaryAndCompoundStatuses(t *testing.T) {
	for _, reason := range []string{"workspace-switch", "shutdown"} {
		t.Run("ordinary/"+reason, func(t *testing.T) {
			spy := &emitSpy{}
			executor := NewExecutor(spy.emit, nil)
			profile := newTestProfile("ordinary-"+reason, "sleep 30")
			if err := executor.Start(t.TempDir(), profile); err != nil {
				t.Fatalf("Start: %v", err)
			}
			running, ok := spy.waitForState(RunStateRunning, 2*time.Second)
			if !ok {
				t.Fatal("run did not start")
			}
			if !executor.StopAllWithReason(2*time.Second, reason) {
				t.Fatal("StopAllWithReason did not finish")
			}
			stopped := phase2BStatusFor(t, spy, running.RunInstanceID, RunStateStopped)
			if got := stopped.Reason; got != reason {
				t.Fatalf("administrative stop reason = %q, want %q", got, reason)
			}
		})

		t.Run("compound/"+reason, func(t *testing.T) {
			spy := &emitSpy{}
			executor := NewExecutor(spy.emit, nil)
			leaf := newTestProfile("leaf-"+reason, "sleep 30")
			compound := RunProfile{
				ID:    "compound-" + reason,
				Name:  "Compound",
				Type:  ProfileTypeCompound,
				Steps: []string{leaf.ID},
			}
			if err := executor.StartCompound(t.TempDir(), compound, []RunProfile{leaf}); err != nil {
				t.Fatalf("StartCompound: %v", err)
			}
			running := phase2CStatusForProfile(t, spy, compound.ID, RunStateRunning)
			if !executor.StopAllWithReason(2*time.Second, reason) {
				t.Fatal("StopAllWithReason did not finish")
			}
			stopped := phase2BStatusFor(t, spy, running.RunInstanceID, RunStateStopped)
			if got := stopped.Reason; got != reason {
				t.Fatalf("compound administrative stop reason = %q, want %q", got, reason)
			}
			snapshots := waitForCompoundSnapshot(t, spy, RunStateStopped, 2*time.Second)
			data, err := json.Marshal(snapshots[len(snapshots)-1])
			if err != nil {
				t.Fatalf("Marshal compound snapshot: %v", err)
			}
			if !strings.Contains(string(data), `"reason":"`+reason+`"`) {
				t.Fatalf("compound snapshot omitted administrative reason: %s", data)
			}
		})
	}
}

func TestExecutorPhase2C_ReasonedDrainTagsLiveStateUnderAdmissionLock(t *testing.T) {
	t.Run("ordinary", func(t *testing.T) {
		spy := &emitSpy{}
		executor := NewExecutor(spy.emit, nil)
		profile := newTestProfile("drain-ordinary", "sleep 30")
		if err := executor.Start(t.TempDir(), profile); err != nil {
			t.Fatalf("Start: %v", err)
		}
		running, ok := spy.waitForState(RunStateRunning, 2*time.Second)
		if !ok {
			t.Fatal("run did not start")
		}

		executor.BeginDrainWithReason("workspace-switch")
		executor.mu.Lock()
		got := executor.processes[running.RunInstanceID].status.Reason
		executor.mu.Unlock()
		if got != "workspace-switch" {
			t.Fatalf("reason immediately after drain = %q", got)
		}
		if !executor.StopAllWithReason(2*time.Second, "workspace-switch") {
			t.Fatal("StopAllWithReason did not finish")
		}
		stopped := phase2BStatusFor(t, spy, running.RunInstanceID, RunStateStopped)
		if stopped.Reason != "workspace-switch" {
			t.Fatalf("terminal reason = %q", stopped.Reason)
		}
	})

	t.Run("compound", func(t *testing.T) {
		spy := &emitSpy{}
		executor := NewExecutor(spy.emit, nil)
		leaf := newTestProfile("drain-leaf", "sleep 30")
		compound := RunProfile{
			ID:    "drain-compound",
			Name:  "Drain compound",
			Type:  ProfileTypeCompound,
			Steps: []string{leaf.ID},
		}
		if err := executor.StartCompound(t.TempDir(), compound, []RunProfile{leaf}); err != nil {
			t.Fatalf("StartCompound: %v", err)
		}
		running := phase2CStatusForProfile(t, spy, compound.ID, RunStateRunning)

		executor.BeginDrainWithReason("shutdown")
		executor.mu.Lock()
		cr := executor.compounds[running.RunInstanceID]
		got := cr.status.Reason
		snapshotData, err := json.Marshal(cr.snapshot())
		executor.mu.Unlock()
		if err != nil {
			t.Fatalf("Marshal immediate compound snapshot: %v", err)
		}
		if got != "shutdown" || !strings.Contains(string(snapshotData), `"reason":"shutdown"`) {
			t.Fatalf("compound drain state reason = %q, snapshot = %s", got, snapshotData)
		}
		if !executor.StopAllWithReason(2*time.Second, "shutdown") {
			t.Fatal("StopAllWithReason did not finish")
		}
		terminal := phase2CTerminalStatusForProfile(t, spy, compound.ID)
		if terminal.Reason != "shutdown" {
			t.Fatalf("terminal reason = %q", terminal.Reason)
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			snapshots := compoundSnapshots(spy)
			if len(snapshots) > 0 {
				last := snapshots[len(snapshots)-1]
				if last.State != RunStateRunning {
					if last.Reason != "shutdown" {
						t.Fatalf("terminal compound snapshot reason = %q", last.Reason)
					}
					return
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("compound did not emit a terminal snapshot")
	})
}
