//go:build !windows

package runprofile

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// compoundSnapshots extracts all run:compound payloads emitted to the spy.
func compoundSnapshots(s *emitSpy) []compoundStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []compoundStatus
	for _, e := range s.events {
		if e.event == "run:compound" && len(e.data) > 0 {
			if cs, ok := e.data[0].(compoundStatus); ok {
				out = append(out, cs)
			}
		}
	}
	return out
}

// outputByIdentity returns concatenated output data recorded for a leaf step
// identified by its parent (aggregate) run instance id and step index. Output is
// now routed by explicit RunIdentity fields rather than a parsed synthetic key.
func outputByIdentity(o *outputSpy, parentRunInstanceID string, stepIdx int) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	var combined string
	for _, e := range o.entries {
		if e.identity.ParentRunInstanceID == parentRunInstanceID && e.identity.StepIdx == stepIdx {
			combined += e.data
		}
	}
	return combined
}

// hasCompoundState reports whether any snapshot reached the given aggregate state.
func hasCompoundState(snaps []compoundStatus, state RunState) bool {
	for _, s := range snaps {
		if s.State == state {
			return true
		}
	}
	return false
}

// hasStepState reports whether any snapshot contained a step in the given state.
func hasStepState(snaps []compoundStatus, state CompoundStepState) bool {
	for _, s := range snaps {
		for _, step := range s.Steps {
			if step.State == state {
				return true
			}
		}
	}
	return false
}

// finalStepStates returns the step states from the most recent snapshot.
func finalStepStates(snaps []compoundStatus) []CompoundStepState {
	if len(snaps) == 0 {
		return nil
	}
	last := snaps[len(snaps)-1]
	out := make([]CompoundStepState, len(last.Steps))
	for i, step := range last.Steps {
		out[i] = step.State
	}
	return out
}

// finalStep returns the step at idx from the most recent snapshot.
func finalStep(snaps []compoundStatus, idx int) (compoundStepStatus, bool) {
	if len(snaps) == 0 {
		return compoundStepStatus{}, false
	}
	last := snaps[len(snaps)-1]
	if idx < 0 || idx >= len(last.Steps) {
		return compoundStepStatus{}, false
	}
	return last.Steps[idx], true
}

// waitForCompoundState polls GetStatus until the compound reaches the wanted
// aggregate state or the deadline elapses.
func waitForCompoundState(exec *Executor, id string, want RunState, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		if exec.GetStatus(id).State == want {
			return true
		}
		select {
		case <-deadline:
			return false
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// waitForCompoundSnapshot polls the spy until a run:compound snapshot with the
// wanted aggregate state has been recorded, returning all snapshots seen at
// that point. finishCompound flips GetStatus/run:status terminal BEFORE it
// emits the final snapshot (which is what carries the pending→skipped marks),
// so tests that assert on snapshot contents must gate on the snapshot stream
// itself rather than waitForCompoundState/waitForState.
func waitForCompoundSnapshot(t *testing.T, spy *emitSpy, want RunState, timeout time.Duration) []compoundStatus {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		snaps := compoundSnapshots(spy)
		if len(snaps) > 0 && snaps[len(snaps)-1].State == want {
			return snaps
		}
		time.Sleep(10 * time.Millisecond)
	}
	snaps := compoundSnapshots(spy)
	latest := RunState("<no snapshots>")
	if len(snaps) > 0 {
		latest = snaps[len(snaps)-1].State
	}
	t.Fatalf("timed out waiting for compound snapshot with aggregate state %q (%d snapshots recorded, latest state %q)", want, len(snaps), latest)
	return nil
}

func noopStatus(string, any) {}

func compoundProfile(id string, steps ...string) RunProfile {
	return RunProfile{
		ID:    id,
		Name:  id,
		Type:  ProfileTypeCompound,
		Steps: steps,
	}
}

func waitForTerminalStatus(t *testing.T, e *Executor, profileID string) RunStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		st := e.GetStatus(profileID)
		if st.State == RunStateSuccess || st.State == RunStateFailed || st.State == RunStateStopped {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("profile %q did not reach terminal state", profileID)
	return RunStatus{}
}

// waitForStepRunning polls until the compound's step at stepIdx is marked running
// AND its leaf process is registered in the executor's process map. Waiting for
// the leaf process (not just the step state) keeps the stop tests deterministic:
// the step transitions to running just before startProcess registers the leaf, so
// a Stop issued purely on step state could race the registration. White-box: it
// reads e.activeByProfile / e.compounds / e.processes under e.mu (same package).
func waitForStepRunning(t *testing.T, e *Executor, compoundProfileID string, stepIdx int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		rid := e.activeByProfile[compoundProfileID]
		cr := e.compounds[rid]
		running := false
		if cr != nil && stepIdx >= 0 && stepIdx < len(cr.plan) && cr.plan[stepIdx].step.State == CompoundStepRunning {
			leafRID := cr.plan[stepIdx].step.RunInstanceID
			_, leafRunning := e.processes[leafRID]
			running = leafRunning
		}
		e.mu.Unlock()
		if running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("compound %q step %d did not reach running state", compoundProfileID, stepIdx)
}

func TestExecutorCompoundCapturesResolvedStepSnapshotAtAdmission(t *testing.T) {
	type preparedStep struct {
		command string
		env     string
	}

	executor := NewExecutor(nil, nil)
	firstPrepared := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondPrepared := make(chan preparedStep, 1)
	var (
		starts      int
		releaseOnce sync.Once
	)
	release := func() {
		releaseOnce.Do(func() {
			close(releaseFirst)
		})
	}

	executor.setCommandStartHook(func(cmd *exec.Cmd) error {
		starts++
		switch starts {
		case 1:
			close(firstPrepared)
			<-releaseFirst
		case 2:
			const prefix = "FIRN_PHASE2D_SNAPSHOT="
			value := ""
			for _, item := range cmd.Env {
				if strings.HasPrefix(item, prefix) {
					value = strings.TrimPrefix(item, prefix)
					break
				}
			}
			secondPrepared <- preparedStep{
				command: cmd.Args[len(cmd.Args)-1],
				env:     value,
			}
		}
		return cmd.Start()
	})
	t.Cleanup(func() {
		release()
		executor.StopAll(5 * time.Second)
	})

	steps := []RunProfile{
		newTestProfile("first", "go version"),
		{
			ID:      "second",
			Name:    "second",
			Type:    ProfileTypeSingle,
			Command: "go env GOOS",
			Env: map[string]string{
				"FIRN_PHASE2D_SNAPSHOT": "planned",
			},
		},
	}
	compound := compoundProfile("ci", "first", "second")

	if err := executor.StartCompound(t.TempDir(), compound, steps); err != nil {
		t.Fatalf("StartCompound: %v", err)
	}
	select {
	case <-firstPrepared:
	case <-time.After(5 * time.Second):
		t.Fatal("first step never reached process start")
	}

	// Keep this barrier: the same test runs under -race to verify the
	// coordinator consumes an owned snapshot, not caller memory.
	steps[1].Command = "go env GOARCH"
	steps[1].Env["FIRN_PHASE2D_SNAPSHOT"] = "mutated"
	release()

	var got preparedStep
	select {
	case got = <-secondPrepared:
	case <-time.After(10 * time.Second):
		t.Fatal("second step never reached process start")
	}
	waitForTerminalStatus(t, executor, compound.ID)

	if got.command != "go env GOOS" || got.env != "planned" {
		t.Fatalf("second step used caller mutation: command=%q env=%q", got.command, got.env)
	}
}

func TestExecutor_StartCompoundStopOnFailure(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()
	orderFile := filepath.Join(dir, "order.txt")

	ok1 := newTestProfile("ok1", "printf a >> "+orderFile)
	boom := newTestProfile("boom", "exit 3")
	ok2 := newTestProfile("ok2", "printf c >> "+orderFile)
	compound := compoundProfile("ci", "ok1", "boom", "ok2")

	if err := exec.StartCompound(dir, compound, []RunProfile{ok1, boom, ok2}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	if _, ok := spy.waitForState(RunStateFailed, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate failed state")
	}

	snaps := waitForCompoundSnapshot(t, spy, RunStateFailed, 5*time.Second)

	boomStep, ok := finalStep(snaps, 1)
	if !ok {
		t.Fatal("expected step index 1 in final snapshot")
	}
	if boomStep.State != CompoundStepFailed {
		t.Errorf("boom step state = %q, want %q", boomStep.State, CompoundStepFailed)
	}
	if boomStep.ExitCode != 3 {
		t.Errorf("boom step exit code = %d, want 3", boomStep.ExitCode)
	}

	ok2Step, ok := finalStep(snaps, 2)
	if !ok {
		t.Fatal("expected step index 2 in final snapshot")
	}
	if ok2Step.State != CompoundStepSkipped {
		t.Errorf("ok2 step state = %q, want %q", ok2Step.State, CompoundStepSkipped)
	}

	st := exec.GetStatus("ci")
	if st.State != RunStateFailed {
		t.Errorf("GetStatus state = %q, want %q", st.State, RunStateFailed)
	}
	if st.ExitCode != 3 {
		t.Errorf("GetStatus exit code = %d, want 3", st.ExitCode)
	}

	content, err := os.ReadFile(orderFile)
	if err != nil {
		t.Fatalf("reading order file: %v", err)
	}
	if string(content) != "a" {
		t.Errorf("order.txt = %q, want %q (ok2 should never run)", string(content), "a")
	}
}

func TestExecutor_StartCompoundRunningStepPopulatesWorkingDir(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()
	subDir := filepath.Join(dir, "sub")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}

	step := newTestProfile("worker", "printf done")
	step.WorkingDir = "sub"
	compound := compoundProfile("ci", "worker")

	if err := exec.StartCompound(dir, compound, []RunProfile{step}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}
	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate success state")
	}

	// A running snapshot for step 0 must already carry the resolved working dir,
	// so clickable paths in live output resolve against the step's cwd rather
	// than the workspace root before the step terminates.
	foundRunningWithDir := false
	for _, snap := range compoundSnapshots(spy) {
		for _, s := range snap.Steps {
			if s.Idx == 0 && s.State == CompoundStepRunning && s.WorkingDir == subDir {
				foundRunningWithDir = true
			}
		}
	}
	if !foundRunningWithDir {
		t.Errorf("expected a running snapshot for step 0 with WorkingDir = %q", subDir)
	}
}

func TestExecutor_StartCompoundSetupFailureEmitsStepError(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	first := newTestProfile("first", "echo ok")
	// Non-first step has a non-existent working dir → startProcess fails the cwd check.
	bad := newTestProfile("bad", "echo nope")
	bad.WorkingDir = "does-not-exist"
	third := newTestProfile("third", "echo never")
	compound := compoundProfile("ci", "first", "bad", "third")

	if err := exec.StartCompound(dir, compound, []RunProfile{first, bad, third}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	if _, ok := spy.waitForState(RunStateFailed, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate failed state")
	}

	snaps := waitForCompoundSnapshot(t, spy, RunStateFailed, 5*time.Second)
	badStep, ok := finalStep(snaps, 1)
	if !ok {
		t.Fatal("expected step index 1 in final snapshot")
	}
	if badStep.State != CompoundStepFailed {
		t.Errorf("bad step state = %q, want %q", badStep.State, CompoundStepFailed)
	}
	if badStep.ExitCode != 1 {
		t.Errorf("bad step exit code = %d, want 1", badStep.ExitCode)
	}
	if badStep.ErrorMessage == "" {
		t.Error("bad step ErrorMessage should be non-empty")
	}

	thirdStep, ok := finalStep(snaps, 2)
	if !ok {
		t.Fatal("expected step index 2 in final snapshot")
	}
	if thirdStep.State != CompoundStepSkipped {
		t.Errorf("third step state = %q, want %q", thirdStep.State, CompoundStepSkipped)
	}

	// Setup-error stderr is routed to the failing step's own lane (parent + idx 1).
	stderr := outputByIdentity(out, badStep.ParentRunInstanceID, 1)
	if stderr == "" {
		t.Errorf("expected stderr output for step (parent %q idx 1) describing the setup error", badStep.ParentRunInstanceID)
	}
	if !strings.Contains(stderr, "working directory does not exist") {
		t.Errorf("step stderr = %q, want it to contain the cwd error text", stderr)
	}

	if st := exec.GetStatus("ci"); st.State != RunStateFailed {
		t.Errorf("GetStatus state = %q, want %q", st.State, RunStateFailed)
	}
}

func assertPhase2EAdministrativeCompoundStop(
	t *testing.T,
	terminal RunStatus,
	snaps []compoundStatus,
	out *outputSpy,
	reason string,
) {
	t.Helper()
	if terminal.State != RunStateStopped {
		t.Errorf("aggregate state = %q, want %q", terminal.State, RunStateStopped)
	}
	if terminal.ExitCode != -1 {
		t.Errorf("aggregate exit code = %d, want -1", terminal.ExitCode)
	}
	if terminal.Reason != reason {
		t.Errorf("aggregate reason = %q, want %q", terminal.Reason, reason)
	}

	first, ok := finalStep(snaps, 0)
	if !ok {
		t.Fatal("expected active step index 0 in final snapshot")
	}
	if first.State != CompoundStepStopped {
		t.Errorf("active step state = %q, want %q", first.State, CompoundStepStopped)
	}
	if first.ExitCode != -1 {
		t.Errorf("active step exit code = %d, want -1", first.ExitCode)
	}
	if first.ErrorMessage != "" {
		t.Errorf("active step error message = %q, want empty", first.ErrorMessage)
	}

	later, ok := finalStep(snaps, 1)
	if !ok {
		t.Fatal("expected later step index 1 in final snapshot")
	}
	if later.State != CompoundStepSkipped {
		t.Errorf("later step state = %q, want %q", later.State, CompoundStepSkipped)
	}

	final := snaps[len(snaps)-1]
	if final.State != RunStateStopped {
		t.Errorf("final snapshot state = %q, want %q", final.State, RunStateStopped)
	}
	if final.Reason != reason {
		t.Errorf("final snapshot reason = %q, want %q", final.Reason, reason)
	}
	if got := outputByIdentity(out, first.ParentRunInstanceID, first.Idx); got != "" {
		t.Errorf("administrative invalidation emitted synthetic step output %q", got)
	}
}

func TestExecutorPhase2E_CompoundPreReservationInvalidationStops(t *testing.T) {
	const reason = "workspace-switch"
	spy := &emitSpy{}
	out := &outputSpy{}
	gateEntered := make(chan struct{})
	releaseGate := make(chan struct{})
	var gateOnce sync.Once
	var releaseOnce sync.Once

	exec := NewExecutor(func(event string, data any) {
		spy.emit(event, data)
		if event != "run:compound" {
			return
		}
		snap, ok := data.(compoundStatus)
		if !ok || len(snap.Steps) == 0 || snap.Steps[0].State != CompoundStepRunning {
			return
		}
		gateOnce.Do(func() {
			close(gateEntered)
			<-releaseGate
		})
	}, out.receive)
	release := func() {
		releaseOnce.Do(func() { close(releaseGate) })
	}
	t.Cleanup(func() {
		release()
		exec.StopAllWithReason(2*time.Second, reason) //nolint:errcheck
	})

	first := newTestProfile("first", "sleep 30")
	later := newTestProfile("later", "echo never")
	compound := compoundProfile("ci", first.ID, later.ID)
	if err := exec.StartCompound(t.TempDir(), compound, []RunProfile{first, later}); err != nil {
		t.Fatalf("StartCompound: %v", err)
	}
	select {
	case <-gateEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("compound did not reach the pre-reservation gate")
	}

	exec.BeginDrainWithReason(reason)
	release()

	terminal := waitForTerminalStatus(t, exec, compound.ID)
	snaps := waitForCompoundSnapshot(t, spy, terminal.State, 2*time.Second)
	assertPhase2EAdministrativeCompoundStop(t, terminal, snaps, out, reason)
}

func TestExecutorPhase2E_CompoundReservedStartInvalidationStops(t *testing.T) {
	const reason = "shutdown"
	spy := &emitSpy{}
	out := &outputSpy{}
	startEntered := make(chan struct{})
	releaseStart := make(chan struct{})
	var releaseOnce sync.Once

	executor := NewExecutor(spy.emit, out.receive)
	executor.setCommandStartHook(func(cmd *exec.Cmd) error {
		if err := cmd.Start(); err != nil {
			return err
		}
		close(startEntered)
		<-releaseStart
		return nil
	})
	release := func() {
		releaseOnce.Do(func() { close(releaseStart) })
	}
	t.Cleanup(func() {
		release()
		executor.StopAllWithReason(2*time.Second, reason) //nolint:errcheck
	})

	first := newTestProfile("first", "sleep 30")
	later := newTestProfile("later", "echo never")
	compound := compoundProfile("ci", first.ID, later.ID)
	if err := executor.StartCompound(t.TempDir(), compound, []RunProfile{first, later}); err != nil {
		t.Fatalf("StartCompound: %v", err)
	}
	select {
	case <-startEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("compound did not reach the reserved-start gate")
	}

	executor.BeginDrainWithReason(reason)
	release()

	terminal := waitForTerminalStatus(t, executor, compound.ID)
	snaps := waitForCompoundSnapshot(t, spy, terminal.State, stopGracePeriod+2*time.Second)
	assertPhase2EAdministrativeCompoundStop(t, terminal, snaps, out, reason)
}

func TestExecutor_StopCompoundMidStep(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()
	orderFile := filepath.Join(dir, "order.txt")

	// Long-running first step. It only appends to order.txt AFTER the sleep, so a
	// successful mid-step stop guarantees order.txt never gets "a".
	slow := newTestProfile("slow", "sleep 5; printf a >> "+orderFile)
	after := newTestProfile("after", "printf b >> "+orderFile)
	compound := compoundProfile("ci", "slow", "after")

	if err := exec.StartCompound(dir, compound, []RunProfile{slow, after}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	// Determinism: wait until step 0's leaf process is registered, then stop. This
	// closes the start/stop race window for the test.
	waitForStepRunning(t, exec, "ci", 0)

	stopErr := make(chan error, 1)
	go func() {
		stopErr <- exec.Stop("ci")
	}()

	if err := <-stopErr; err != nil {
		t.Fatalf("Stop returned error: %v", err)
	}

	if !waitForCompoundState(exec, "ci", RunStateStopped, 5*time.Second) {
		t.Fatal("timed out waiting for aggregate stopped state")
	}

	snaps := waitForCompoundSnapshot(t, spy, RunStateStopped, 5*time.Second)
	slowStep, ok := finalStep(snaps, 0)
	if !ok {
		t.Fatal("expected step index 0 in final snapshot")
	}
	if slowStep.State != CompoundStepStopped {
		t.Errorf("slow step state = %q, want %q", slowStep.State, CompoundStepStopped)
	}
	afterStep, ok := finalStep(snaps, 1)
	if !ok {
		t.Fatal("expected step index 1 in final snapshot")
	}
	if afterStep.State != CompoundStepSkipped {
		t.Errorf("after step state = %q, want %q", afterStep.State, CompoundStepSkipped)
	}

	if st := exec.GetStatus("ci"); st.State != RunStateStopped {
		t.Errorf("GetStatus state = %q, want %q", st.State, RunStateStopped)
	}

	if content, err := os.ReadFile(orderFile); err == nil {
		if strings.Contains(string(content), "a") {
			t.Errorf("order.txt = %q, want it to NOT contain \"a\" (slow step was stopped before its append)", string(content))
		}
	}
}

func TestExecutor_StartSingleRejectedWhileCompoundStepRunning(t *testing.T) {
	exec := NewExecutor(noopStatus, nil)
	dir := t.TempDir()
	defer exec.StopAll(2 * time.Second) //nolint:errcheck

	slow := newTestProfile("slow", "sleep 5")
	compound := compoundProfile("ci", "slow")
	steps, err := ResolveSteps(compound, []RunProfile{slow})
	if err != nil {
		t.Fatal(err)
	}

	if err := exec.StartCompound(dir, compound, steps); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}
	waitForStepRunning(t, exec, "ci", 0)

	// "slow" is active as a compound leaf → starting it standalone is rejected.
	err = exec.Start(dir, slow)
	if err == nil {
		t.Fatal("Start returned nil; want already-running error for leaf profile")
	}
	if !strings.Contains(err.Error(), "profile already running: slow") {
		t.Fatalf("Start error = %q, want already-running error for slow", err.Error())
	}
}

func TestExecutor_StopSingleIDStopsCompoundStep(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	slow := newTestProfile("slow", "sleep 5")
	after := newTestProfile("after", "printf never")
	compound := compoundProfile("ci", "slow", "after")

	if err := exec.StartCompound(dir, compound, []RunProfile{slow, after}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}
	waitForStepRunning(t, exec, "ci", 0)

	if err := exec.Stop("slow"); err != nil {
		t.Fatalf("Stop by step profile ID returned error: %v", err)
	}
	if !waitForCompoundState(exec, "ci", RunStateStopped, 5*time.Second) {
		t.Fatal("timed out waiting for aggregate stopped state")
	}

	states := finalStepStates(waitForCompoundSnapshot(t, spy, RunStateStopped, 5*time.Second))
	if len(states) != 2 {
		t.Fatalf("expected 2 step states, got %d", len(states))
	}
	if states[0] != CompoundStepStopped {
		t.Errorf("step0 state = %q, want %q", states[0], CompoundStepStopped)
	}
	if states[1] != CompoundStepSkipped {
		t.Errorf("step1 state = %q, want %q", states[1], CompoundStepSkipped)
	}
}

// TestExecutor_StopCompoundBetweenSteps is hard to hit deterministically in the
// true between-steps gap, so per the plan it is implemented as: step0 sleeps
// briefly, we stop shortly after it starts running, and we assert step0 is
// stopped and step1 is skipped with a stopped aggregate. This still exercises
// the "no step beyond the stopped one runs" invariant that the between-steps
// cancellation guards.
func TestExecutor_StopCompoundBetweenSteps(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()
	orderFile := filepath.Join(dir, "order.txt")

	step0 := newTestProfile("s0", "sleep 0.4")
	step1 := newTestProfile("s1", "printf b >> "+orderFile)
	compound := compoundProfile("ci", "s0", "s1")

	if err := exec.StartCompound(dir, compound, []RunProfile{step0, step1}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	waitForStepRunning(t, exec, "ci", 0)

	stopErr := make(chan error, 1)
	go func() {
		stopErr <- exec.Stop("ci")
	}()

	if err := <-stopErr; err != nil {
		t.Fatalf("Stop returned error: %v", err)
	}

	if !waitForCompoundState(exec, "ci", RunStateStopped, 5*time.Second) {
		t.Fatal("timed out waiting for aggregate stopped state")
	}

	states := finalStepStates(waitForCompoundSnapshot(t, spy, RunStateStopped, 5*time.Second))
	if len(states) != 2 {
		t.Fatalf("expected 2 step states, got %d", len(states))
	}
	if states[0] != CompoundStepStopped {
		t.Errorf("step0 state = %q, want %q", states[0], CompoundStepStopped)
	}
	if states[1] != CompoundStepSkipped {
		t.Errorf("step1 state = %q, want %q", states[1], CompoundStepSkipped)
	}

	if st := exec.GetStatus("ci"); st.State != RunStateStopped {
		t.Errorf("GetStatus state = %q, want %q", st.State, RunStateStopped)
	}
	if _, err := os.Stat(orderFile); err == nil {
		t.Error("order.txt should not exist; step1 must not have run")
	}
}

func TestExecutor_StopAllCancelsCompoundBetweenSteps(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	slow := newTestProfile("slow", "sleep 5")
	after := newTestProfile("after", "echo never")
	compound := compoundProfile("ci", "slow", "after")

	if err := exec.StartCompound(dir, compound, []RunProfile{slow, after}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	waitForStepRunning(t, exec, "ci", 0)

	if !exec.StopAll(2 * time.Second) {
		t.Fatal("StopAll returned false — compound not cleaned up in time")
	}

	st := exec.GetStatus("ci")
	if st.State == RunStateRunning {
		t.Errorf("GetStatus state = %q, want a terminal state (not running)", st.State)
	}
	if st.State != RunStateStopped {
		t.Errorf("GetStatus state = %q, want %q", st.State, RunStateStopped)
	}
}

func TestExecutor_ClearTerminalStatusesClearsCompoundAggregate(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	step1 := newTestProfile("first", "echo a")
	step2 := newTestProfile("second", "echo b")
	compound := compoundProfile("ci", "first", "second")

	if err := exec.StartCompound(dir, compound, []RunProfile{step1, step2}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate success state")
	}
	if st := exec.GetStatus("ci"); st.State != RunStateSuccess {
		t.Fatalf("GetStatus state = %q, want %q", st.State, RunStateSuccess)
	}

	exec.ClearTerminalStatuses()

	if st := exec.GetStatus("ci"); st.State != RunStateIdle {
		t.Errorf("GetStatus state = %q, want %q after ClearTerminalStatuses", st.State, RunStateIdle)
	}
}

func TestExecutor_StartCompoundAllSuccess(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()
	orderFile := filepath.Join(dir, "order.txt")

	step1 := newTestProfile("first", "printf first >> "+orderFile)
	step2 := newTestProfile("second", "printf second >> "+orderFile)
	compound := compoundProfile("ci", "first", "second")

	if err := exec.StartCompound(dir, compound, []RunProfile{step1, step2}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	if _, ok := spy.waitForState(RunStateRunning, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate running state")
	}
	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate success state")
	}

	snaps := waitForCompoundSnapshot(t, spy, RunStateSuccess, 5*time.Second)
	if !hasStepState(snaps, CompoundStepPending) {
		t.Error("expected a snapshot with a pending step")
	}
	if !hasStepState(snaps, CompoundStepRunning) {
		t.Error("expected a snapshot with a running step")
	}
	if !hasCompoundState(snaps, RunStateSuccess) {
		t.Error("expected a final success snapshot")
	}

	if st := exec.GetStatus("ci"); st.State != RunStateSuccess {
		t.Errorf("GetStatus state = %q, want %q", st.State, RunStateSuccess)
	}

	content, err := os.ReadFile(orderFile)
	if err != nil {
		t.Fatalf("reading order file: %v", err)
	}
	if string(content) != "firstsecond" {
		t.Errorf("order.txt = %q, want %q", string(content), "firstsecond")
	}
}

func TestExecutor_StartCompoundSequentialOrder(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()
	orderFile := filepath.Join(dir, "order.txt")

	step1 := newTestProfile("a", "printf A >> "+orderFile)
	step2 := newTestProfile("b", "printf B >> "+orderFile)
	step3 := newTestProfile("c", "printf C >> "+orderFile)
	step4 := newTestProfile("d", "printf D >> "+orderFile)
	compound := compoundProfile("ci", "a", "b", "c", "d")

	if err := exec.StartCompound(dir, compound, []RunProfile{step1, step2, step3, step4}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate success state")
	}

	content, err := os.ReadFile(orderFile)
	if err != nil {
		t.Fatalf("reading order file: %v", err)
	}
	if string(content) != "ABCD" {
		t.Errorf("order.txt = %q, want %q (steps did not run in strict sequence)", string(content), "ABCD")
	}
}

func TestExecutor_GetStatusCompoundRunning(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()
	orderFile := filepath.Join(dir, "order.txt")

	step1 := newTestProfile("slow", "sleep 0.3; printf done >> "+orderFile)
	compound := compoundProfile("ci", "slow")

	if err := exec.StartCompound(dir, compound, []RunProfile{step1}); err != nil {
		t.Fatalf("StartCompound returned error: %v", err)
	}

	if _, ok := spy.waitForState(RunStateRunning, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate running state")
	}

	if st := exec.GetStatus("ci"); st.State != RunStateRunning {
		t.Errorf("GetStatus while running = %q, want %q", st.State, RunStateRunning)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for aggregate success state")
	}

	if st := exec.GetStatus("ci"); st.State != RunStateSuccess {
		t.Errorf("GetStatus after completion = %q, want %q", st.State, RunStateSuccess)
	}
}

func TestExecutor_CompoundDuplicateStepOutputIsolation(t *testing.T) {
	type key struct {
		parent string
		idx    int
	}
	got := map[key][]string{}
	var mu sync.Mutex
	e := NewExecutor(noopStatus, func(id RunIdentity, stream, data string, _ int64) {
		mu.Lock()
		got[key{id.ParentRunInstanceID, id.StepIdx}] = append(got[key{id.ParentRunInstanceID, id.StepIdx}], data)
		mu.Unlock()
	})

	// Compound "ci" runs the SAME profile "build" twice (duplicate step ids).
	build := newTestProfile("build", "echo step")
	compound := compoundProfile("ci", "build", "build")
	steps, err := ResolveSteps(compound, []RunProfile{build})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.StartCompound(t.TempDir(), compound, steps); err != nil {
		t.Fatal(err)
	}
	waitForTerminalStatus(t, e, "ci")

	mu.Lock()
	defer mu.Unlock()
	// Two distinct step records (idx 0 and idx 1) under the same parent.
	parents := map[string]map[int]bool{}
	for k := range got {
		if parents[k.parent] == nil {
			parents[k.parent] = map[int]bool{}
		}
		parents[k.parent][k.idx] = true
	}
	if len(parents) != 1 {
		t.Fatalf("expected one parent run, got %d", len(parents))
	}
	for _, idxs := range parents {
		if !idxs[0] || !idxs[1] {
			t.Fatalf("expected output for step idx 0 and 1, got %v", idxs)
		}
	}
}

func TestExecutor_StopByStepProfileWhileCompoundRuns(t *testing.T) {
	e := NewExecutor(noopStatus, nil)
	slow := newTestProfile("slow", "sleep 5")
	after := newTestProfile("after", "echo after")
	compound := compoundProfile("ci", "slow", "after")
	steps, _ := ResolveSteps(compound, []RunProfile{slow, after})
	if err := e.StartCompound(t.TempDir(), compound, steps); err != nil {
		t.Fatal(err)
	}
	waitForStepRunning(t, e, "ci", 0)

	// Stopping the leaf by its own profile id halts the chain.
	if err := e.Stop("slow"); err != nil {
		t.Fatalf("Stop(slow): %v", err)
	}
	if !waitForCompoundState(e, "ci", RunStateStopped, 5*time.Second) {
		t.Fatalf("compound did not reach stopped state")
	}
	st := e.GetStatus("ci")
	if st.State != RunStateStopped {
		t.Fatalf("compound state = %q, want stopped", st.State)
	}
}

func TestExecutor_StopByCompoundProfile(t *testing.T) {
	e := NewExecutor(noopStatus, nil)
	slow := newTestProfile("slow", "sleep 5")
	compound := compoundProfile("ci", "slow")
	steps, _ := ResolveSteps(compound, []RunProfile{slow})
	if err := e.StartCompound(t.TempDir(), compound, steps); err != nil {
		t.Fatal(err)
	}
	waitForStepRunning(t, e, "ci", 0)
	if err := e.Stop("ci"); err != nil {
		t.Fatalf("Stop(ci): %v", err)
	}
	if e.GetStatus("ci").State != RunStateStopped {
		t.Fatalf("compound not stopped")
	}
}

func TestExecutor_CompoundLeafTerminalStatusNotRetained(t *testing.T) {
	e := NewExecutor(noopStatus, nil)
	build := newTestProfile("build", "true")
	compound := compoundProfile("ci", "build")
	steps, _ := ResolveSteps(compound, []RunProfile{build})
	if err := e.StartCompound(t.TempDir(), compound, steps); err != nil {
		t.Fatal(err)
	}
	waitForTerminalStatus(t, e, "ci")
	// Aggregate retained; leaf profile not.
	if e.GetStatus("ci").State == RunStateIdle {
		t.Fatalf("expected aggregate terminal status retained")
	}
	if e.GetStatus("build").State != RunStateIdle {
		t.Fatalf("compound leaf status leaked into lastStatus")
	}
}

func TestExecutor_CompoundLeafDoesNotClearPriorTopLevelStatus(t *testing.T) {
	e := NewExecutor(noopStatus, nil)
	build := newTestProfile("build", "true")
	root := t.TempDir()

	if err := e.Start(root, build); err != nil {
		t.Fatal(err)
	}
	prior := waitForTerminalStatus(t, e, "build")
	if prior.State != RunStateSuccess {
		t.Fatalf("prior standalone state = %q, want success", prior.State)
	}

	compound := compoundProfile("ci", "build")
	steps, _ := ResolveSteps(compound, []RunProfile{build})
	if err := e.StartCompound(root, compound, steps); err != nil {
		t.Fatal(err)
	}
	waitForTerminalStatus(t, e, "ci")

	st := e.GetStatus("build")
	if st.RunInstanceID != prior.RunInstanceID || st.State != prior.State {
		t.Fatalf("compound leaf cleared prior top-level status: got %#v want prior %#v", st, prior)
	}
}
