package runprofile

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// CompoundStepState represents the lifecycle state of a single step within a
// compound run. It is distinct from RunState so the frontend can render per-step
// progress (including pending/skipped) independent of the aggregate state.
type CompoundStepState string

const (
	CompoundStepPending CompoundStepState = "pending"
	CompoundStepRunning CompoundStepState = "running"
	CompoundStepSuccess CompoundStepState = "success"
	CompoundStepFailed  CompoundStepState = "failed"
	CompoundStepSkipped CompoundStepState = "skipped"
	CompoundStepStopped CompoundStepState = "stopped"
)

// compoundStepStatus is the per-step payload carried inside a compoundStatus.
type compoundStepStatus struct {
	Idx                 int               `json:"idx"`
	RunInstanceID       string            `json:"runInstanceId"`
	ParentRunInstanceID string            `json:"parentRunInstanceId"`
	ProfileID           string            `json:"profileId"`
	Name                string            `json:"name"`
	State               CompoundStepState `json:"state"`
	ExitCode            int               `json:"exitCode"`
	WorkingDir          string            `json:"workingDir"`
	DurationMs          int64             `json:"durationMs"`
	StartedAt           int64             `json:"startedAt,omitempty"`
	EndedAt             int64             `json:"endedAt,omitempty"`
	ErrorMessage        string            `json:"errorMessage,omitempty"`
	WorkspaceEpoch      uint64            `json:"workspaceEpoch"`
	LaunchSeq           uint64            `json:"launchSeq"`
}

// compoundStatus is the run:compound event payload describing the full state of
// a compound run.
type compoundStatus struct {
	RunInstanceID  string               `json:"runInstanceId"`
	CompoundID     string               `json:"compoundId"`
	Name           string               `json:"name"`
	State          RunState             `json:"state"`
	CurrentStep    int                  `json:"currentStep"`
	Steps          []compoundStepStatus `json:"steps"`
	WorkspaceEpoch uint64               `json:"workspaceEpoch"`
	LaunchSeq      uint64               `json:"launchSeq"`
	Reason         string               `json:"reason,omitempty"`
}

type executionNode struct {
	// profile is a deep-copied launch snapshot and is immutable after admission.
	profile RunProfile
	// step carries this occurrence's identity and lifecycle state. Executor.mu
	// guards every read and write.
	step compoundStepStatus
}

// compoundRun tracks an in-flight compound execution. Mutable fields are
// guarded by Executor.mu; executionNode.profile remains immutable.
type compoundRun struct {
	cancel  context.CancelFunc
	status  RunStatus
	plan    []executionNode
	current int
	name    string
	done    chan struct{}
}

// snapshot builds an immutable compoundStatus from the current compoundRun.
// The caller MUST hold Executor.mu. The steps slice is deep-copied so the
// emitted payload is never mutated by subsequent step transitions.
func (cr *compoundRun) snapshot() compoundStatus {
	steps := make([]compoundStepStatus, len(cr.plan))
	for i := range cr.plan {
		steps[i] = cr.plan[i].step
	}
	return compoundStatus{
		RunInstanceID:  cr.status.RunInstanceID,
		CompoundID:     cr.status.ProfileID,
		Name:           cr.name,
		State:          cr.status.State,
		CurrentStep:    cr.current,
		Steps:          steps,
		WorkspaceEpoch: cr.status.WorkspaceEpoch,
		LaunchSeq:      cr.status.LaunchSeq,
		Reason:         cr.status.Reason,
	}
}

// emitCompound emits a run:compound event with the given snapshot.
func (e *Executor) emitCompound(snap compoundStatus) {
	if e.emitFn != nil {
		e.emitFn("run:compound", snap)
	}
}

// StartCompound executes a compound profile's resolved steps sequentially.
// Steps are pre-resolved (compound ID → []RunProfile) at the binding level.
// The coordinator runs asynchronously, mirroring single-profile Start.
//
// This implements the all-success path. Failure and stop semantics are layered
// on in a later task; the loop is structured so non-success leaf results break
// out cleanly without panicking.
//
// This is the current-epoch convenience form of StartCompoundAtEpoch; see the
// note on Start. Prefer StartCompoundAtEpoch outside tests.
func (e *Executor) StartCompound(workspaceRoot string, compound RunProfile, steps []RunProfile) error {
	return e.StartCompoundAtEpoch(e.CurrentEpoch(), workspaceRoot, compound, steps)
}

// StartCompoundAtEpoch admits a compound aggregate only for the current open
// workspace. Individual step setup and spawn failures remain asynchronous.
func (e *Executor) StartCompoundAtEpoch(epoch uint64, workspaceRoot string, compound RunProfile, steps []RunProfile) error {
	if workspaceRoot == "" {
		return fmt.Errorf("no workspace loaded")
	}
	if err := e.checkAdmission(epoch); err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())

	e.mu.Lock()
	if err := e.checkAdmissionLocked(epoch); err != nil {
		e.mu.Unlock()
		cancel()
		return err
	}
	e.refreshActiveProfileLocked(compound.ID)
	if _, exists := e.activeByProfile[compound.ID]; exists {
		e.mu.Unlock()
		cancel()
		return fmt.Errorf("compound already running: %s", compound.ID)
	}
	for _, reservation := range e.reservations {
		if reservation.identity.ProfileID == compound.ID {
			e.mu.Unlock()
			cancel()
			return fmt.Errorf("compound already running: %s", compound.ID)
		}
	}

	aggregateID := e.nextRunInstanceIDLocked()
	aggregateIdentity := RunIdentity{
		RunInstanceID:  aggregateID,
		ProfileID:      compound.ID,
		WorkspaceEpoch: epoch,
		LaunchSeq:      e.nextRunSeq,
	}
	// Snapshot definitions now, but preflight each node only when scheduled:
	// earlier steps may intentionally create a later cwd or environment file.
	plan := make([]executionNode, len(steps))
	for i, step := range steps {
		profile := deepCopyProfile(step)
		// nextRunInstanceIDLocked bumps nextRunSeq, so reading it afterwards
		// yields this step's own launch sequence. Steps order against ordinary
		// runs by the same monotonic counter rather than a placeholder zero.
		stepRunInstanceID := e.nextRunInstanceIDLocked()
		plan[i] = executionNode{
			profile: profile,
			step: compoundStepStatus{
				Idx:                 i,
				RunInstanceID:       stepRunInstanceID,
				ParentRunInstanceID: aggregateID,
				ProfileID:           profile.ID,
				Name:                profile.Name,
				State:               CompoundStepPending,
				WorkspaceEpoch:      epoch,
				LaunchSeq:           e.nextRunSeq,
			},
		}
	}

	cr := &compoundRun{
		cancel: cancel,
		status: RunStatus{
			RunIdentity: aggregateIdentity,
			State:       RunStateRunning,
		},
		plan:    plan,
		current: 0,
		name:    compound.Name,
		done:    make(chan struct{}),
	}
	e.compounds[aggregateID] = cr
	e.activeByProfile[compound.ID] = aggregateID

	running := cr.status
	initialSnap := cr.snapshot()
	e.mu.Unlock()

	e.emit(running)
	e.emitCompound(initialSnap)

	go e.runCompound(ctx, workspaceRoot, cr)
	return nil
}

// runCompound is the coordinator goroutine. It runs each step sequentially,
// emitting a run:compound snapshot on every transition. It computes a final
// aggregate (state, exitCode) and hands it to finishCompound, which marks any
// still-pending steps skipped.
//
// Aggregate exit code conventions:
//   - success → 0
//   - failed  → the failing step's exit code; 1 for setup/spawn errors
//   - stopped → the stopped leaf's exit code if available, otherwise sentinel
//     -1 (between-steps cancel with no leaf → -1)
func (e *Executor) runCompound(ctx context.Context, workspaceRoot string, cr *compoundRun) {
	state := RunStateSuccess
	exitCode := 0

	for i := range cr.plan {
		// Cancellation observed before this step starts. The step at index i is
		// still pending, so it and all later steps are marked skipped by
		// finishCompound. No leaf exists yet → sentinel exit code -1.
		if ctx.Err() != nil {
			state = RunStateStopped
			exitCode = -1
			break
		}

		// Transition: step → running, and capture this step's execution identity
		// from the preassigned status (both reads are guarded fields) in the same
		// locked section.
		e.mu.Lock()
		node := &cr.plan[i]
		cr.current = i
		node.step.State = CompoundStepRunning
		node.step.StartedAt = time.Now().UnixMilli()
		profile := node.profile
		stepIdentity := RunIdentity{
			RunInstanceID:       node.step.RunInstanceID,
			ProfileID:           profile.ID,
			ParentRunInstanceID: cr.status.RunInstanceID,
			StepIdx:             i,
			WorkspaceEpoch:      cr.status.WorkspaceEpoch,
			LaunchSeq:           node.step.LaunchSeq,
		}
		runningSnap := cr.snapshot()
		e.mu.Unlock()
		e.emitCompound(runningSnap)

		rp, err := e.startProcess(stepIdentity, profile, workspaceRoot)
		if err != nil {
			if errors.Is(err, errRunAdmissionInvalidated) {
				e.mu.Lock()
				step := &cr.plan[i].step
				step.State = CompoundStepStopped
				step.ExitCode = -1
				step.EndedAt = time.Now().UnixMilli()
				step.DurationMs = step.EndedAt - step.StartedAt
				stopSnap := cr.snapshot()
				e.mu.Unlock()
				e.emitCompound(stopSnap)

				state = RunStateStopped
				exitCode = -1
				break
			}

			// Setup/spawn failure: record the error on the step, surface it as a
			// stderr chunk for this step's output lane, and fail the aggregate.
			e.mu.Lock()
			step := &cr.plan[i].step
			step.State = CompoundStepFailed
			step.ExitCode = 1
			step.EndedAt = time.Now().UnixMilli()
			step.DurationMs = step.EndedAt - step.StartedAt
			step.ErrorMessage = err.Error()
			failSnap := cr.snapshot()
			e.mu.Unlock()

			if e.outputFn != nil {
				e.outputFn(stepIdentity, "stderr", err.Error()+"\n", time.Now().UnixMilli())
			}
			e.emitCompound(failSnap)

			state = RunStateFailed
			exitCode = 1
			break
		}

		// Publish the resolved working directory while the step is still running so
		// clickable file paths in live output resolve against the step's own cwd
		// (not the workspace root). startProcess has resolved it; emit an updated
		// running snapshot before waitProcess begins draining output.
		e.mu.Lock()
		cr.plan[i].step.WorkingDir = rp.workingDir
		runningDirSnap := cr.snapshot()
		e.mu.Unlock()
		e.emitCompound(runningDirSnap)

		// Close the start/stop race: a cancel that arrived in the window between
		// the running-transition unlock and the process registration inside
		// startProcess could be missed by an external Stop. signalStop marks the
		// leaf stopped, sends SIGTERM, and escalates to SIGKILL after the grace
		// period (via a watchdog) so a TERM-ignoring child cannot leave the
		// following waitProcess — and thus Stop/restart/StopAll — blocked.
		if ctx.Err() != nil {
			e.signalStop(rp)
		}

		res := e.waitProcess(rp, false, false)

		if res.state != RunStateSuccess {
			// Non-success leaf result (failed or stopped). Record the terminal
			// step state, emit, and break with the matching aggregate.
			e.mu.Lock()
			now := time.Now().UnixMilli()
			step := &cr.plan[i].step
			step.State = leafStepState(res.state)
			step.ExitCode = res.exitCode
			step.WorkingDir = res.workingDir
			step.EndedAt = now
			step.DurationMs = now - step.StartedAt
			brokeSnap := cr.snapshot()
			e.mu.Unlock()
			e.emitCompound(brokeSnap)

			if res.state == RunStateStopped {
				// res.exitCode is typically -1 for a signalled process, which
				// satisfies the stopped sentinel.
				state = RunStateStopped
				exitCode = res.exitCode
			} else {
				state = RunStateFailed
				exitCode = res.exitCode
			}
			break
		}

		// Transition: step → success.
		e.mu.Lock()
		now := time.Now().UnixMilli()
		step := &cr.plan[i].step
		step.State = CompoundStepSuccess
		step.ExitCode = res.exitCode
		step.WorkingDir = res.workingDir
		step.EndedAt = now
		step.DurationMs = now - step.StartedAt
		successSnap := cr.snapshot()
		e.mu.Unlock()
		e.emitCompound(successSnap)
	}

	e.finishCompound(cr, state, exitCode)
}

// finishCompound finalizes a compound run. Any still-pending steps are marked
// skipped, the aggregate status is set to the computed (state, exitCode), it is
// retained as the terminal status, the in-flight entry is removed, and the
// terminal aggregate + final compound snapshot are emitted.
func (e *Executor) finishCompound(cr *compoundRun, state RunState, exitCode int) {
	e.mu.Lock()
	for i := range cr.plan {
		if cr.plan[i].step.State == CompoundStepPending {
			cr.plan[i].step.State = CompoundStepSkipped
		}
	}
	cr.status.State = state
	cr.status.ExitCode = exitCode
	terminal := cr.status
	e.retainTerminalStatusLocked(terminal)
	finalSnap := cr.snapshot()
	delete(e.compounds, cr.status.RunInstanceID)
	e.refreshActiveProfileLocked(cr.status.ProfileID)
	e.mu.Unlock()

	e.emit(terminal)
	e.emitCompound(finalSnap)
	close(cr.done)
}

// leafStepState maps a leaf process RunState onto a CompoundStepState.
func leafStepState(state RunState) CompoundStepState {
	switch state {
	case RunStateSuccess:
		return CompoundStepSuccess
	case RunStateStopped:
		return CompoundStepStopped
	default:
		return CompoundStepFailed
	}
}
