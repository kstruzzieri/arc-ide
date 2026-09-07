//go:build !windows

package runprofile

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func phase2BStatusFor(t *testing.T, spy *emitSpy, runInstanceID string, state RunState) RunStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, status := range spy.statuses() {
			if status.RunInstanceID == runInstanceID && status.State == state {
				return status
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("run %q did not reach state %q", runInstanceID, state)
	return RunStatus{}
}

func phase2BRunningIDs(t *testing.T, spy *emitSpy, profileID string, want int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		statuses := make([]RunStatus, 0, want)
		seen := map[string]bool{}
		for _, status := range spy.statuses() {
			if status.ProfileID == profileID && status.State == RunStateRunning && !seen[status.RunInstanceID] {
				seen[status.RunInstanceID] = true
				statuses = append(statuses, status)
			}
		}
		if len(statuses) == want {
			sort.Slice(statuses, func(i, j int) bool {
				return phase2BLaunchSeq(t, statuses[i]) < phase2BLaunchSeq(t, statuses[j])
			})
			ids := make([]string, len(statuses))
			for i, status := range statuses {
				ids[i] = status.RunInstanceID
			}
			return ids
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("profile %q did not produce %d distinct running events", profileID, want)
	return nil
}

func phase2BNextRunningID(t *testing.T, spy *emitSpy, profileID string, seen map[string]bool) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, status := range spy.statuses() {
			if status.ProfileID == profileID && status.State == RunStateRunning && !seen[status.RunInstanceID] {
				seen[status.RunInstanceID] = true
				return status.RunInstanceID
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("profile %q did not produce another running event", profileID)
	return ""
}

func phase2BEventCount(spy *emitSpy) int {
	spy.mu.Lock()
	defer spy.mu.Unlock()
	return len(spy.events)
}

// phase2BLaunchSeq is for ordinary top-level launches, whose sequence is
// non-zero. Compound leaves intentionally use zero and must not call it.
func phase2BLaunchSeq(t *testing.T, status RunStatus) uint64 {
	t.Helper()
	if status.LaunchSeq == 0 {
		t.Fatalf("status %#v has no non-zero launchSeq", status)
	}
	return status.LaunchSeq
}

func phase2BTerminalIndexContainsRunID(executor *Executor, runInstanceID string) bool {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	for _, ids := range executor.terminalStatusIDsByProfile {
		for _, id := range ids {
			if id == runInstanceID {
				return true
			}
		}
	}
	return false
}

func phase2BRetainedStatuses(executor *Executor, profileID string) map[string]RunStatus {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	statuses := make(map[string]RunStatus)
	for key, status := range executor.lastStatus {
		if status.ProfileID == profileID {
			statuses[key] = status
		}
	}
	return statuses
}

func phase2BCompoundLeafID(t *testing.T, executor *Executor, aggregateID string) string {
	t.Helper()
	executor.mu.Lock()
	defer executor.mu.Unlock()
	compound := executor.compounds[aggregateID]
	if compound == nil || compound.current < 0 || compound.current >= len(compound.plan) {
		t.Fatalf("compound %q has no current leaf", aggregateID)
	}
	return compound.plan[compound.current].step.RunInstanceID
}

func phase2BStopRunInstance(t *testing.T, exec *Executor, runInstanceID string) error {
	t.Helper()
	return exec.StopRunInstance(runInstanceID)
}

func phase2BCurrentEpoch(t *testing.T, exec *Executor) uint64 {
	t.Helper()
	return exec.CurrentEpoch()
}

func phase2BBeginDrain(t *testing.T, exec *Executor) uint64 {
	t.Helper()
	return exec.BeginDrain()
}

func phase2BEndDrain(t *testing.T, exec *Executor, epoch uint64) error {
	t.Helper()
	return exec.EndDrain(epoch)
}

func phase2BStartAtEpoch(t *testing.T, exec *Executor, epoch uint64, root string, profile RunProfile) error {
	t.Helper()
	return exec.StartAtEpoch(epoch, root, profile)
}

func phase2BRestartAtEpoch(t *testing.T, exec *Executor, epoch uint64, root string, profile RunProfile, runInstanceID string) error {
	t.Helper()
	return exec.RestartAtEpoch(epoch, root, profile, runInstanceID)
}

// The command-start dependency is the narrow seam needed to deterministically
// pause or fail cmd.Start after admission has reserved capacity.
func phase2BSetCommandStartHook(t *testing.T, executor *Executor, hook func(*exec.Cmd) error) {
	t.Helper()
	executor.setCommandStartHook(hook)
}

func TestExecutorPhase2B_TwoSameProfileRunsHaveDistinctCanonicalLaunches(t *testing.T) {
	spy := &emitSpy{}
	output := &outputSpy{}
	exec := NewExecutor(spy.emit, output.receive)
	profile := newTestProfile("parallel", "printf running; sleep 30")

	if err := exec.Start(t.TempDir(), profile); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	firstID := phase2BRunningIDs(t, spy, profile.ID, 1)[0]
	firstStatus := phase2BStatusFor(t, spy, firstID, RunStateRunning)
	if err := exec.Start(t.TempDir(), profile); err != nil {
		t.Fatalf("second same-profile Start: %v", err)
	}
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	ids := phase2BRunningIDs(t, spy, profile.ID, 2)
	secondID := ""
	for _, id := range ids {
		if id != firstID {
			secondID = id
			break
		}
	}
	if secondID == "" {
		t.Fatalf("same-profile launches reused run id %q", firstID)
	}
	secondStatus := phase2BStatusFor(t, spy, secondID, RunStateRunning)
	if first, second := phase2BLaunchSeq(t, firstStatus), phase2BLaunchSeq(t, secondStatus); first >= second {
		t.Fatalf("launch sequences = %d, %d; want strictly increasing canonical order", first, second)
	}
}

func TestExecutorPhase2B_ThirdSameProfileStartRejectsBeforeAnyEvent(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	profile := newTestProfile("capacity", "sleep 30")
	root := t.TempDir()
	rejectedMarker := filepath.Join(root, "third-spawned")
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	for i := 0; i < 2; i++ {
		if err := exec.Start(root, profile); err != nil {
			t.Fatalf("Start #%d: %v", i+1, err)
		}
	}
	phase2BRunningIDs(t, spy, profile.ID, 2)
	before := phase2BEventCount(spy)
	rejected := newTestProfile(profile.ID, fmt.Sprintf("printf rejected > %q; exec sleep 30", rejectedMarker))
	if err := exec.Start(root, rejected); err == nil {
		t.Fatal("third same-profile start succeeded; backend capacity must be two")
	}
	if after := phase2BEventCount(spy); after != before {
		t.Fatalf("rejected third start emitted %d events, want zero", after-before)
	}
	exec.mu.Lock()
	registered := len(exec.processes)
	exec.mu.Unlock()
	if registered != 2 {
		t.Fatalf("rejected third start left %d registered processes, want exactly two", registered)
	}
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(rejectedMarker); err == nil {
			t.Fatal("rejected third start spawned an unregistered survivor")
		} else if !os.IsNotExist(err) {
			t.Fatalf("probe rejected-start marker: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestExecutorPhase2B_ConcurrentSiblingOutputRemainsIsolatedByRunInstance(t *testing.T) {
	spy := &emitSpy{}
	output := &outputSpy{}
	exec := NewExecutor(spy.emit, output.receive)
	root := t.TempDir()
	gate := filepath.Join(root, "stream")
	const lines = 3000
	command := func(prefix string) string {
		return fmt.Sprintf(
			"while [ ! -e %q ]; do sleep 0.01; done; i=0; while [ \"$i\" -lt %d ]; do printf '%s:%%05d\\n' \"$i\"; i=$((i+1)); done",
			gate,
			lines,
			prefix,
		)
	}
	profile := newTestProfile("streaming", command("A"))

	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	firstID := phase2BRunningIDs(t, spy, profile.ID, 1)[0]
	profile.Command = command("B")
	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	secondID := phase2BRunningIDs(t, spy, profile.ID, 2)[1]
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatalf("open streaming gate: %v", err)
	}
	phase2BStatusFor(t, spy, firstID, RunStateSuccess)
	phase2BStatusFor(t, spy, secondID, RunStateSuccess)

	output.mu.Lock()
	entries := append([]outputEntry(nil), output.entries...)
	output.mu.Unlock()
	byRun := map[string]string{}
	for _, entry := range entries {
		if entry.identity.RunInstanceID != firstID && entry.identity.RunInstanceID != secondID {
			t.Fatalf("output routed to unexpected run %q", entry.identity.RunInstanceID)
		}
		byRun[entry.identity.RunInstanceID] += entry.data
	}
	if got := strings.Count(byRun[firstID], "A:"); got != lines {
		t.Errorf("first run emitted %d/%d distinguishable lines", got, lines)
	}
	if strings.Contains(byRun[firstID], "B:") {
		t.Error("second sibling output was routed into the first run")
	}
	if got := strings.Count(byRun[secondID], "B:"); got != lines {
		t.Errorf("second run emitted %d/%d distinguishable lines", got, lines)
	}
	if strings.Contains(byRun[secondID], "A:") {
		t.Error("first sibling output was routed into the second run")
	}
}

func TestExecutorPhase2B_CapacityAdmissionIsAtomicAcrossConcurrentStarts(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	profile := newTestProfile("atomic-capacity", "sleep 30")
	root := t.TempDir()
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	start := make(chan struct{})
	results := make(chan error, 3)
	var ready sync.WaitGroup
	ready.Add(3)
	for range 3 {
		go func() {
			ready.Done()
			<-start
			results <- exec.Start(root, profile)
		}()
	}
	ready.Wait()
	close(start)

	successes := 0
	failures := 0
	for range 3 {
		if err := <-results; err != nil {
			failures++
		} else {
			successes++
		}
	}
	if successes != 2 || failures != 1 {
		t.Fatalf("concurrent starts = %d successes, %d failures; want atomic capacity of two", successes, failures)
	}
	phase2BRunningIDs(t, spy, profile.ID, 2)
}

func TestExecutorPhase2B_ProfileStopAndRestartTargetNewestButExactStopCanTargetOlder(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	profile := newTestProfile("target", "sleep 30")
	root := t.TempDir()
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	first := phase2BRunningIDs(t, spy, profile.ID, 1)[0]
	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	ids := phase2BRunningIDs(t, spy, profile.ID, 2)
	newest := ids[1]

	if err := exec.Stop(profile.ID); err != nil {
		t.Fatalf("profile Stop: %v", err)
	}
	phase2BStatusFor(t, spy, newest, RunStateStopped)
	if status := exec.GetStatus(profile.ID); status.RunInstanceID != first || status.State != RunStateRunning {
		t.Fatalf("profile Stop stopped %q but current status = %#v; want older sibling %q still running", newest, status, first)
	}
	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("profile restart Start: %v", err)
	}
	ids = phase2BRunningIDs(t, spy, profile.ID, 3)
	restarted := ids[2]
	if restarted == first || restarted == newest {
		t.Fatalf("restart reused prior run instance %q", restarted)
	}
	if status := exec.GetStatus(profile.ID); status.RunInstanceID != restarted || status.State != RunStateRunning {
		t.Fatalf("restart current status = %#v, want new run %q running", status, restarted)
	}

	if err := phase2BStopRunInstance(t, exec, first); err != nil {
		t.Fatalf("exact StopRunInstance(%q): %v", first, err)
	}
	phase2BStatusFor(t, spy, first, RunStateStopped)
	if err := phase2BStopRunInstance(t, exec, first); err != nil {
		t.Fatalf("repeated exact stop must be idempotent: %v", err)
	}
	if err := phase2BStopRunInstance(t, exec, "unknown-rid"); err != nil {
		t.Fatalf("unknown exact stop must be idempotent: %v", err)
	}
}

func TestExecutorPhase2B_ExactRestartReplacesOnlySelectedSibling(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	profile := newTestProfile("exact-restart", "sleep 30")
	root := t.TempDir()
	epoch := phase2BCurrentEpoch(t, exec)
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	if err := phase2BStartAtEpoch(t, exec, epoch, root, profile); err != nil {
		t.Fatalf("first StartAtEpoch: %v", err)
	}
	if err := phase2BStartAtEpoch(t, exec, epoch, root, profile); err != nil {
		t.Fatalf("second StartAtEpoch: %v", err)
	}
	initial := phase2BRunningIDs(t, spy, profile.ID, 2)
	selected := initial[0]
	sibling := initial[1]

	if err := phase2BRestartAtEpoch(t, exec, epoch, root, profile, selected); err != nil {
		t.Fatalf("exact RestartAtEpoch(%q): %v", selected, err)
	}
	allRunning := phase2BRunningIDs(t, spy, profile.ID, 3)
	replacement := allRunning[2]

	selectedStopped := false
	for _, status := range spy.statuses() {
		if status.RunInstanceID == selected && status.State == RunStateStopped {
			selectedStopped = true
		}
		if status.RunInstanceID == sibling {
			switch status.State {
			case RunStateSuccess, RunStateFailed, RunStateStopped:
				t.Fatalf("exact restart terminated live sibling %q: %#v", sibling, status)
			}
		}
	}
	if !selectedStopped {
		t.Fatalf("exact restart did not stop selected run %q", selected)
	}
	replacementStatus := phase2BStatusFor(t, spy, replacement, RunStateRunning)
	siblingStatus := phase2BStatusFor(t, spy, sibling, RunStateRunning)
	if phase2BLaunchSeq(t, replacementStatus) <= phase2BLaunchSeq(t, siblingStatus) {
		t.Fatal("replacement launch sequence did not advance beyond its surviving sibling")
	}
	if status := exec.GetStatus(profile.ID); status.RunInstanceID != replacement || status.State != RunStateRunning {
		t.Fatalf("profile status = %#v, want replacement %q running", status, replacement)
	}
}

func TestExecutorPhase2B_ExactRestartRetainsItsCapacitySlot(t *testing.T) {
	spy := &emitSpy{}
	terminalEntered := make(chan struct{})
	releaseTerminal := make(chan struct{})
	var selected string
	var blockOnce sync.Once
	exec := NewExecutor(func(event string, data any) {
		spy.emit(event, data)
		if event != "run:status" {
			return
		}
		status, ok := data.(RunStatus)
		if ok && status.RunInstanceID == selected && status.State == RunStateStopped {
			blockOnce.Do(func() {
				close(terminalEntered)
				<-releaseTerminal
			})
		}
	}, nil)
	profile := newTestProfile("restart-capacity", "sleep 30")
	root := t.TempDir()
	epoch := exec.CurrentEpoch()
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	for range 2 {
		if err := exec.StartAtEpoch(epoch, root, profile); err != nil {
			t.Fatalf("seed StartAtEpoch: %v", err)
		}
	}
	initial := phase2BRunningIDs(t, spy, profile.ID, 2)
	selected = initial[0]
	sibling := initial[1]

	restartDone := make(chan error, 1)
	go func() {
		restartDone <- exec.RestartAtEpoch(epoch, root, profile, selected)
	}()
	select {
	case <-terminalEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("restart did not reach selected-run cleanup")
	}

	intruderErr := exec.StartAtEpoch(epoch, root, profile)
	close(releaseTerminal)
	restartErr := <-restartDone

	if intruderErr == nil {
		t.Error("concurrent start stole the exact restart's reserved capacity slot")
	}
	if restartErr != nil {
		t.Fatalf("exact restart lost its reserved capacity slot: %v", restartErr)
	}
	running := phase2BRunningIDs(t, spy, profile.ID, 3)
	replacement := running[2]
	if replacement == selected || replacement == sibling {
		t.Fatalf("replacement reused an existing identity: %q", replacement)
	}
	if status := exec.GetStatus(profile.ID); status.RunInstanceID != replacement || status.State != RunStateRunning {
		t.Fatalf("profile status = %#v, want replacement %q running", status, replacement)
	}
}

func TestExecutorPhase2B_DrainInvalidatesAndWaitsForExactRestartReservation(t *testing.T) {
	spy := &emitSpy{}
	terminalEntered := make(chan struct{})
	releaseTerminal := make(chan struct{})
	var selected string
	var blockOnce sync.Once
	exec := NewExecutor(func(event string, data any) {
		spy.emit(event, data)
		if event != "run:status" {
			return
		}
		status, ok := data.(RunStatus)
		if ok && status.RunInstanceID == selected && status.State == RunStateStopped {
			blockOnce.Do(func() {
				close(terminalEntered)
				<-releaseTerminal
			})
		}
	}, nil)
	profile := newTestProfile("restart-drain", "sleep 30")
	root := t.TempDir()
	epoch := exec.CurrentEpoch()
	for range 2 {
		if err := exec.StartAtEpoch(epoch, root, profile); err != nil {
			t.Fatalf("seed StartAtEpoch: %v", err)
		}
	}
	selected = phase2BRunningIDs(t, spy, profile.ID, 2)[0]

	restartDone := make(chan error, 1)
	go func() {
		restartDone <- exec.RestartAtEpoch(epoch, root, profile, selected)
	}()
	select {
	case <-terminalEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("restart did not reach selected-run cleanup")
	}

	exec.BeginDrain()
	stopDone := make(chan bool, 1)
	go func() {
		stopDone <- exec.StopAll(2 * time.Second)
	}()
	select {
	case <-stopDone:
		t.Fatal("StopAll returned before the exact-restart reservation drained")
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseTerminal)
	if err := <-restartDone; err == nil {
		t.Fatal("drain-invalidated exact restart succeeded")
	}
	select {
	case ok := <-stopDone:
		if !ok {
			t.Fatal("StopAll failed after exact-restart reservation drained")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("StopAll did not wait for exact-restart reservation cleanup")
	}
	running := map[string]bool{}
	for _, status := range spy.statuses() {
		if status.ProfileID == profile.ID && status.State == RunStateRunning {
			running[status.RunInstanceID] = true
		}
	}
	if len(running) != 2 {
		t.Fatalf("drain-invalidated restart emitted a replacement: %v", running)
	}
}

func TestExecutorPhase2B_ExactRIDControlsRejectCompoundLeaves(t *testing.T) {
	run := func(t *testing.T, action func(*Executor, uint64, string, RunProfile, string) error) {
		t.Helper()
		spy := &emitSpy{}
		exec := NewExecutor(spy.emit, nil)
		root := t.TempDir()
		leaf := newTestProfile("compound-leaf", "sleep 30")
		compound := compoundProfile("compound-owner", leaf.ID)
		epoch := exec.CurrentEpoch()
		if err := exec.StartCompoundAtEpoch(epoch, root, compound, []RunProfile{leaf}); err != nil {
			t.Fatalf("StartCompoundAtEpoch: %v", err)
		}
		t.Cleanup(func() { exec.Stop(compound.ID) }) //nolint:errcheck
		aggregateID := phase2BRunningIDs(t, spy, compound.ID, 1)[0]
		waitForStepRunning(t, exec, compound.ID, 0)
		leafID := phase2BCompoundLeafID(t, exec, aggregateID)
		before := phase2BEventCount(spy)

		if err := action(exec, epoch, root, leaf, leafID); err == nil {
			t.Fatal("exact RID control accepted a compound leaf")
		}
		time.Sleep(50 * time.Millisecond)

		exec.mu.Lock()
		aggregate := exec.compounds[aggregateID]
		leafProcess := exec.processes[leafID]
		aggregateRunning := aggregate != nil && aggregate.status.State == RunStateRunning
		leafRunning := leafProcess != nil && !leafProcess.stopped
		standaloneLeaves := 0
		for _, process := range exec.processes {
			if process.identity.ProfileID == leaf.ID && process.identity.ParentRunInstanceID == "" {
				standaloneLeaves++
			}
		}
		exec.mu.Unlock()
		if !aggregateRunning {
			t.Fatalf("rejected exact control changed compound aggregate %q", aggregateID)
		}
		if !leafRunning {
			t.Fatalf("rejected exact control stopped compound leaf %q", leafID)
		}
		if standaloneLeaves != 0 {
			t.Fatalf("rejected exact control launched %d standalone leaf runs", standaloneLeaves)
		}
		if after := phase2BEventCount(spy); after != before {
			t.Fatalf("rejected exact control emitted %d events, want zero", after-before)
		}
	}

	t.Run("stop", func(t *testing.T) {
		run(t, func(exec *Executor, _ uint64, _ string, _ RunProfile, leafID string) error {
			return exec.StopRunInstance(leafID)
		})
	})
	t.Run("restart", func(t *testing.T) {
		run(t, func(exec *Executor, epoch uint64, root string, leaf RunProfile, leafID string) error {
			return exec.RestartAtEpoch(epoch, root, leaf, leafID)
		})
	})
}

func TestExecutorPhase2B_GetStatusKeepsNewestLaunchAfterReverseCompletion(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	marker := filepath.Join(root, "first-started")
	profile := newTestProfile("reverse", fmt.Sprintf("if [ ! -e %q ]; then : > %q; sleep 0.5; else exit 0; fi", marker, marker))

	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	first := phase2BRunningIDs(t, spy, profile.ID, 1)[0]
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first run did not establish reverse-completion marker")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	ids := phase2BRunningIDs(t, spy, profile.ID, 2)
	newest := ids[1]
	phase2BStatusFor(t, spy, newest, RunStateSuccess)
	phase2BStatusFor(t, spy, first, RunStateSuccess)

	if status := exec.GetStatus(profile.ID); status.RunInstanceID != newest || status.State != RunStateSuccess {
		t.Fatalf("GetStatus = %#v, want newest launched terminal run %q", status, newest)
	}
}

func TestExecutorPhase2B_StartingSiblingRetainsEarlierTerminalStatus(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	profile := newTestProfile("retain-terminal", "exit 0")
	seen := map[string]bool{}

	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	firstID := phase2BNextRunningID(t, spy, profile.ID, seen)
	phase2BStatusFor(t, spy, firstID, RunStateSuccess)

	profile.Command = "sleep 30"
	if err := exec.Start(root, profile); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck
	phase2BNextRunningID(t, spy, profile.ID, seen)

	retained := phase2BRetainedStatuses(exec, profile.ID)
	if status, ok := retained[firstID]; !ok || status.State != RunStateSuccess {
		t.Fatalf("starting a live sibling removed terminal run %q: retained=%#v", firstID, retained)
	}
}

func TestExecutorPhase2B_RetainsOnlyTwoNewestLaunchedTerminalStatuses(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	profile := newTestProfile("terminal-cap", "exit 0")
	ids := make([]string, 0, 3)
	seen := map[string]bool{}

	for launch := 1; launch <= 3; launch++ {
		if err := exec.Start(root, profile); err != nil {
			t.Fatalf("Start #%d: %v", launch, err)
		}
		id := phase2BNextRunningID(t, spy, profile.ID, seen)
		phase2BStatusFor(t, spy, id, RunStateSuccess)
		ids = append(ids, id)
	}

	retained := phase2BRetainedStatuses(exec, profile.ID)
	if len(retained) != 2 {
		t.Fatalf("retained terminal count = %d, want cap of two: %#v", len(retained), retained)
	}
	if _, ok := retained[ids[0]]; ok {
		t.Errorf("oldest terminal run %q survived the two-entry cap", ids[0])
	}
	for _, id := range ids[1:] {
		if status, ok := retained[id]; !ok || status.State != RunStateSuccess {
			t.Errorf("newer terminal run %q missing from retained statuses: %#v", id, retained)
		}
	}
}

func TestExecutorPhase2B_ClearTerminalStatusesClearsRetainedAndProfileIndexes(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	profile := newTestProfile("clear-terminal-indexes", "exit 0")
	ids := make([]string, 0, 2)
	seen := map[string]bool{}

	for launch := 1; launch <= 2; launch++ {
		if err := exec.Start(root, profile); err != nil {
			t.Fatalf("Start #%d: %v", launch, err)
		}
		id := phase2BNextRunningID(t, spy, profile.ID, seen)
		phase2BStatusFor(t, spy, id, RunStateSuccess)
		ids = append(ids, id)
	}

	if retained := phase2BRetainedStatuses(exec, profile.ID); len(retained) != 2 {
		t.Errorf("precondition: retained terminal count = %d, want two: %#v", len(retained), retained)
	}
	for _, id := range ids {
		if !phase2BTerminalIndexContainsRunID(exec, id) {
			t.Errorf("precondition: per-profile terminal index does not reference %q", id)
		}
	}

	exec.ClearTerminalStatuses()

	if retained := phase2BRetainedStatuses(exec, profile.ID); len(retained) != 0 {
		t.Errorf("ClearTerminalStatuses left retained statuses: %#v", retained)
	}
	for _, id := range ids {
		if phase2BTerminalIndexContainsRunID(exec, id) {
			t.Errorf("ClearTerminalStatuses left terminal index reference to %q", id)
		}
	}
}

func TestExecutorPhase2B_PreflightFailureDoesNotConsumeCapacity(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	broken := newTestProfile("retryable", "sleep 30")
	broken.EnvFile = "missing.env"

	if err := exec.Start(root, broken); err == nil {
		t.Fatal("start with missing env file succeeded")
	}
	if got := phase2BEventCount(spy); got != 0 {
		t.Fatalf("failed spawn emitted %d events, want zero", got)
	}
	valid := newTestProfile("retryable", "sleep 30")
	if err := exec.Start(root, valid); err != nil {
		t.Fatalf("start after preflight failure: %v", err)
	}
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck
	phase2BRunningIDs(t, spy, valid.ID, 1)
}

func TestExecutorPhase2B_PostReservationSpawnFailureReleasesReservation(t *testing.T) {
	spy := &emitSpy{}
	executor := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	sentinel := errors.New("cmd start failed")
	phase2BSetCommandStartHook(t, executor, func(*exec.Cmd) error { return sentinel })

	if err := executor.Start(root, newTestProfile("spawn-failure", "sleep 30")); !errors.Is(err, sentinel) {
		t.Fatalf("post-reservation Start error = %v, want %v", err, sentinel)
	}
	if got := phase2BEventCount(spy); got != 0 {
		t.Fatalf("post-reservation spawn failure emitted %d events, want zero", got)
	}
	phase2BSetCommandStartHook(t, executor, func(cmd *exec.Cmd) error { return cmd.Start() })
	if err := executor.Start(root, newTestProfile("spawn-failure", "sleep 30")); err != nil {
		t.Fatalf("start after post-reservation failure: %v", err)
	}
	t.Cleanup(func() { executor.StopAll(2 * time.Second) }) //nolint:errcheck
	phase2BRunningIDs(t, spy, "spawn-failure", 1)
}

func TestExecutorPhase2B_StopAllStopsTwoSameProfileSiblings(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	profile := newTestProfile("stop-all", "sleep 30")
	root := t.TempDir()

	for i := 0; i < 2; i++ {
		if err := exec.Start(root, profile); err != nil {
			t.Fatalf("Start #%d: %v", i+1, err)
		}
	}
	ids := phase2BRunningIDs(t, spy, profile.ID, 2)
	if !exec.StopAll(2 * time.Second) {
		t.Fatal("StopAll did not reap both same-profile siblings")
	}
	for _, id := range ids {
		phase2BStatusFor(t, spy, id, RunStateStopped)
	}
}

func TestExecutorPhase2B_WorkspaceBoundaryRejectsOldEpochBeforeSpawn(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	oldEpoch := phase2BCurrentEpoch(t, exec)
	newEpoch := phase2BBeginDrain(t, exec)

	if err := phase2BStartAtEpoch(t, exec, oldEpoch, t.TempDir(), newTestProfile("stale", "sleep 30")); err == nil {
		t.Fatal("stale epoch start succeeded")
	}
	if err := phase2BStartAtEpoch(t, exec, newEpoch, t.TempDir(), newTestProfile("draining", "sleep 30")); err == nil {
		t.Fatal("current-epoch start succeeded while admission was draining")
	}
	if got := phase2BEventCount(spy); got != 0 {
		t.Fatalf("rejected workspace-boundary starts emitted %d events, want zero", got)
	}
	if err := phase2BEndDrain(t, exec, newEpoch); err != nil {
		t.Fatalf("EndDrain: %v", err)
	}
	if err := phase2BStartAtEpoch(t, exec, newEpoch, t.TempDir(), newTestProfile("reopened", "sleep 30")); err != nil {
		t.Fatalf("current-epoch start after successful drain: %v", err)
	}
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck
}

func TestExecutorPhase2B_RestartPropagatesDrainAndEpochErrorsWithoutNewEvents(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	profile := newTestProfile("stale-restart", "sleep 30")
	oldEpoch := phase2BCurrentEpoch(t, exec)
	if err := phase2BStartAtEpoch(t, exec, oldEpoch, root, profile); err != nil {
		t.Fatalf("StartAtEpoch: %v", err)
	}
	id := phase2BRunningIDs(t, spy, profile.ID, 1)[0]
	newEpoch := phase2BBeginDrain(t, exec)
	before := phase2BEventCount(spy)
	if err := phase2BRestartAtEpoch(t, exec, newEpoch, root, profile, id); err == nil {
		t.Fatal("current-epoch restart succeeded while admission was draining")
	}
	if after := phase2BEventCount(spy); after != before {
		t.Fatalf("draining restart emitted %d events, want zero", after-before)
	}
	if status := exec.GetStatus(profile.ID); status.RunInstanceID != id || status.State != RunStateRunning {
		t.Fatalf("drain-rejected restart changed original run: %#v", status)
	}
	if !exec.StopAll(2 * time.Second) {
		t.Fatal("StopAll did not drain restart's original execution")
	}
	if err := phase2BEndDrain(t, exec, newEpoch); err != nil {
		t.Fatalf("EndDrain: %v", err)
	}
	if err := phase2BStartAtEpoch(t, exec, newEpoch, root, profile); err != nil {
		t.Fatalf("current-epoch StartAtEpoch after drain: %v", err)
	}
	currentID := phase2BRunningIDs(t, spy, profile.ID, 2)[1]
	t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck

	before = phase2BEventCount(spy)
	if err := phase2BRestartAtEpoch(t, exec, oldEpoch, root, profile, currentID); err == nil {
		t.Fatal("stale-epoch restart succeeded after admission reopened")
	}
	if after := phase2BEventCount(spy); after != before {
		t.Fatalf("stale-epoch restart emitted %d events, want zero", after-before)
	}
	if status := exec.GetStatus(profile.ID); status.RunInstanceID != currentID || status.State != RunStateRunning {
		t.Fatalf("epoch-rejected restart changed current run: %#v", status)
	}
}

func TestExecutorPhase2B_DrainInvalidatesStalePreflightBeforeReservation(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	root := t.TempDir()
	fifo := filepath.Join(root, "launch.env")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	marker := filepath.Join(root, "spawned")
	profile := newTestProfile("pending", fmt.Sprintf("printf spawned > %q; sleep 30", marker))
	profile.EnvFile = fifo
	epoch := phase2BCurrentEpoch(t, exec)

	startDone := make(chan error, 1)
	go func() { startDone <- phase2BStartAtEpoch(t, exec, epoch, root, profile) }()

	// Wait until Start has opened the FIFO for reading without depending on a
	// private reservation map. A nonblocking writer succeeds only with a reader.
	var writer *os.File
	deadline := time.Now().Add(2 * time.Second)
	for writer == nil && time.Now().Before(deadline) {
		fd, err := syscall.Open(fifo, syscall.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			writer = os.NewFile(uintptr(fd), fifo)
			break
		}
		if err != syscall.ENXIO {
			t.Fatalf("open fifo writer: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if writer == nil {
		t.Fatal("Start did not reach pre-spawn environment read")
	}

	phase2BBeginDrain(t, exec)
	stopDone := make(chan bool, 1)
	go func() { stopDone <- exec.StopAll(2 * time.Second) }()
	select {
	case ok := <-stopDone:
		if !ok {
			t.Fatal("StopAll failed while a launch reservation was pending")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("StopAll blocked behind pending pre-spawn work")
	}
	if _, err := writer.WriteString("X=1\n"); err != nil {
		t.Fatalf("release fifo reader: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close fifo writer: %v", err)
	}
	if err := <-startDone; err == nil {
		t.Fatal("pending launch succeeded after StopAll invalidated its epoch")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("pending launch spawned after StopAll; expected immediate kill/reap before any command output")
	}
	if got := phase2BEventCount(spy); got != 0 {
		t.Fatalf("invalidated pending launch emitted %d events, want zero", got)
	}
}

func TestExecutorPhase2B_DrainInvalidatesPostSpawnReservationAndReapsBeforePromotion(t *testing.T) {
	spy := &emitSpy{}
	output := &outputSpy{}
	executor := NewExecutor(spy.emit, output.receive)
	root := t.TempDir()
	pidFile := filepath.Join(root, "child.pid")
	epoch := phase2BCurrentEpoch(t, executor)

	hookEntered := make(chan struct{})
	releaseStart := make(chan struct{})
	phase2BSetCommandStartHook(t, executor, func(cmd *exec.Cmd) error {
		if err := cmd.Start(); err != nil {
			return err
		}
		close(hookEntered)
		<-releaseStart
		return nil
	})

	// yes immediately fills the unpromoted stdout pipe and inherits ignored
	// SIGTERM. The invalidation path must close/drain pipes and kill immediately.
	profile := newTestProfile(
		"post-spawn",
		fmt.Sprintf("trap '' TERM; echo $$ > %q; exec yes x", pidFile),
	)
	startDone := make(chan error, 1)
	go func() { startDone <- phase2BStartAtEpoch(t, executor, epoch, root, profile) }()
	select {
	case <-hookEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("post-spawn hook was not reached")
	}

	var pid int
	var pidBytes []byte
	pidDeadline := time.Now().Add(2 * time.Second)
	for pid <= 0 && time.Now().Before(pidDeadline) {
		var err error
		pidBytes, err = os.ReadFile(pidFile)
		if err != nil && !os.IsNotExist(err) {
			t.Fatalf("read child pid: %v", err)
		}
		if err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(pidBytes)))
		}
		if pid <= 0 {
			time.Sleep(5 * time.Millisecond)
		}
	}
	if pid <= 0 {
		t.Fatalf("child did not publish a valid pid: %q", pidBytes)
	}

	// Enter drain explicitly; StopAll must consume the already-invalidated
	// reservation, not define the epoch policy itself.
	phase2BBeginDrain(t, executor)

	stopDone := make(chan bool, 1)
	go func() { stopDone <- executor.StopAll(2 * time.Second) }()
	select {
	case <-stopDone:
		t.Fatal("StopAll returned before the invalidated reservation drained")
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseStart)
	if err := <-startDone; err == nil {
		t.Fatal("invalidated post-spawn reservation returned success")
	}
	select {
	case ok := <-stopDone:
		if !ok {
			t.Fatal("StopAll did not complete after reservation drain")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("StopAll did not wait for post-spawn cleanup")
	}
	// kill(pid, 0) also succeeds for a zombie. Requiring ESRCH proves the child
	// was reaped before Start/StopAll reported cleanup complete, not merely killed.
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatalf("post-spawn child %d survived epoch invalidation", pid)
	} else if err != syscall.ESRCH {
		t.Fatalf("probe child %d after invalidation: %v, want ESRCH", pid, err)
	}
	if got := phase2BEventCount(spy); got != 0 {
		t.Fatalf("invalidated post-spawn reservation emitted %d status events, want zero", got)
	}
	output.mu.Lock()
	defer output.mu.Unlock()
	if len(output.entries) != 0 {
		t.Fatalf("invalidated post-spawn reservation emitted %d output chunks, want zero", len(output.entries))
	}
}

func TestExecutorPhase2B_CompoundAndOrdinaryRemainMutuallyExclusiveBothDirections(t *testing.T) {
	t.Run("ordinary cannot join active compound leaf", func(t *testing.T) {
		exec := NewExecutor(noopStatus, nil)
		root := t.TempDir()
		leaf := newTestProfile("shared", "sleep 30")
		compound := compoundProfile("compound", leaf.ID)
		if err := exec.StartCompound(root, compound, []RunProfile{leaf}); err != nil {
			t.Fatalf("StartCompound: %v", err)
		}
		t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck
		waitForStepRunning(t, exec, compound.ID, 0)
		if err := exec.Start(root, leaf); err == nil {
			t.Fatal("ordinary start joined active compound leaf")
		}
	})

	t.Run("compound leaf cannot join active ordinary", func(t *testing.T) {
		spy := &emitSpy{}
		output := &outputSpy{}
		exec := NewExecutor(spy.emit, output.receive)
		root := t.TempDir()
		leaf := newTestProfile("shared", "sleep 30")
		if err := exec.Start(root, leaf); err != nil {
			t.Fatalf("ordinary Start: %v", err)
		}
		t.Cleanup(func() { exec.StopAll(2 * time.Second) }) //nolint:errcheck
		compound := compoundProfile("compound", leaf.ID)
		if err := exec.StartCompound(root, compound, []RunProfile{leaf}); err != nil {
			t.Fatalf("StartCompound must admit its aggregate and fail the conflicting leaf asynchronously: %v", err)
		}
		if !waitForCompoundState(exec, compound.ID, RunStateFailed, 5*time.Second) {
			t.Fatal("compound aggregate did not fail after conflicting leaf admission")
		}
		for _, status := range spy.statuses() {
			if status.ProfileID == leaf.ID && status.State == RunStateRunning && status.ParentRunInstanceID != "" {
				t.Fatalf("compound emitted a running leaf status despite ordinary overlap: %#v", status)
			}
		}
	})
}
