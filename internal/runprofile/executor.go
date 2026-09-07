package runprofile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ErrRunInstanceNotRunning reports that an exact-target control referenced a run
// instance that is no longer live. Exact controls surface it; profile-level
// controls may treat it as "nothing to replace" and start fresh instead.
var ErrRunInstanceNotRunning = errors.New("run instance not running")

var errRunAdmissionInvalidated = errors.New("run admission invalidated")

// RunState represents the lifecycle state of a profile execution.
type RunState string

const (
	RunStateIdle    RunState = "idle"
	RunStateRunning RunState = "running"
	RunStateStopped RunState = "stopped" // user-initiated stop
	RunStateFailed  RunState = "failed"  // non-zero exit code
	RunStateSuccess RunState = "success" // exit code 0
)

const stopGracePeriod = 3 * time.Second

// RunStatus is emitted to the frontend on every state transition.
type RunStatus struct {
	RunIdentity
	State     RunState `json:"state"`
	ExitCode  int      `json:"exitCode"`
	Pid       int      `json:"pid,omitempty"`
	Timestamp int64    `json:"timestamp"`
	Reason    string   `json:"reason,omitempty"`
}

// OutputChunk is the run:output event payload. It embeds RunIdentity so output
// routes by explicit fields rather than a parsed synthetic profile id.
type OutputChunk struct {
	RunIdentity
	Stream    string `json:"stream"`
	Data      string `json:"data"`
	Timestamp int64  `json:"timestamp"`
}

// OutputFunc receives streaming process output for one execution instance.
// stream is "stdout" or "stderr". data is the raw chunk. timestamp is the Unix
// millisecond time when the data was read.
// The caller is responsible for buffering or backpressure.
type OutputFunc func(id RunIdentity, stream, data string, timestamp int64)

// StatusFunc emits run status events. In production the app wires this to its
// own (*App).emit seam, the single choke point for Wails event emission.
type StatusFunc func(event string, data any)

// Executor manages the lifecycle of running profiles.
type Executor struct {
	mu                         sync.Mutex
	nextRunSeq                 uint64
	workspaceEpoch             uint64
	draining                   bool
	processes                  map[string]*runningProcess    // keyed by runInstanceId
	reservations               map[string]*launchReservation // keyed by runInstanceId
	activeByProfile            map[string]string             // profileId -> newest active runInstanceId
	compounds                  map[string]*compoundRun       // keyed by aggregate runInstanceId
	lastStatus                 map[string]RunStatus          // keyed by runInstanceId (top-level only)
	terminalStatusIDsByProfile map[string][]string
	commandStart               func(*exec.Cmd) error
	emitFn                     StatusFunc
	outputFn                   OutputFunc
}

type processResult struct {
	state      RunState
	exitCode   int
	workingDir string
}

// runningProcess tracks a single running profile execution.
type runningProcess struct {
	cmd        *exec.Cmd
	identity   RunIdentity
	status     RunStatus
	stopped    bool          // set by Stop — tells Wait goroutine to use RunStateStopped
	done       chan struct{} // closed when process exits and cleanup is complete
	stopOnce   sync.Once
	stdout     io.ReadCloser
	stderr     io.ReadCloser
	workingDir string
}

type launchReservation struct {
	identity              RunIdentity
	replacesRunInstanceID string
	done                  chan struct{}
	invalid               bool
}

// NewExecutor creates an Executor.
// emitFn emits Wails events (or a test spy).
// outputFn receives stdout/stderr chunks (nil = drain silently).
func NewExecutor(emitFn StatusFunc, outputFn OutputFunc) *Executor {
	return &Executor{
		processes:                  make(map[string]*runningProcess),
		reservations:               make(map[string]*launchReservation),
		activeByProfile:            make(map[string]string),
		compounds:                  make(map[string]*compoundRun),
		lastStatus:                 make(map[string]RunStatus),
		terminalStatusIDsByProfile: make(map[string][]string),
		commandStart:               func(cmd *exec.Cmd) error { return cmd.Start() },
		emitFn:                     emitFn,
		outputFn:                   outputFn,
	}
}

// Start begins executing a run profile. Profile resolution (ID → RunProfile)
// happens at the app.go binding level. The executor receives the resolved profile.
//
// This is the current-epoch convenience form of StartAtEpoch. Production callers
// go through StartAtEpoch with the epoch they resolved alongside the profile, so
// that a workspace switch between resolution and launch is rejected; reading the
// epoch here instead means a concurrent BeginDrain is only caught by the
// re-check inside StartAtEpoch. Prefer StartAtEpoch outside tests.
func (e *Executor) Start(workspaceRoot string, profile RunProfile) error {
	return e.StartAtEpoch(e.CurrentEpoch(), workspaceRoot, profile)
}

// CurrentEpoch returns the workspace epoch used to bind new admissions.
func (e *Executor) CurrentEpoch() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.workspaceEpoch
}

// BeginDrain atomically advances workspace identity and closes admission.
func (e *Executor) BeginDrain() uint64 {
	return e.BeginDrainWithReason("")
}

// BeginDrainWithReason closes admission and tags every live top-level status
// in the same critical section, so a drain-boundary completion keeps its
// administrative reason.
func (e *Executor) BeginDrainWithReason(reason string) uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.workspaceEpoch++
	e.draining = true
	e.setAdministrativeReasonLocked(reason)
	for _, reservation := range e.reservations {
		reservation.invalid = true
	}
	return e.workspaceEpoch
}

func (e *Executor) setAdministrativeReasonLocked(reason string) {
	for _, rp := range e.processes {
		rp.status.Reason = reason
	}
	for _, cr := range e.compounds {
		cr.status.Reason = reason
	}
}

// EndDrain reopens admission for the successfully loaded workspace.
func (e *Executor) EndDrain(epoch uint64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if epoch != e.workspaceEpoch {
		return fmt.Errorf("workspace epoch mismatch: got %d, current %d", epoch, e.workspaceEpoch)
	}
	e.draining = false
	return nil
}

// StartAtEpoch begins an ordinary run only if its workspace identity is still
// current and admission is open.
func (e *Executor) StartAtEpoch(epoch uint64, workspaceRoot string, profile RunProfile) error {
	if profile.Type == ProfileTypeCompound {
		return fmt.Errorf("compound profiles require resolved steps: %s", profile.ID)
	}
	if err := e.checkAdmission(epoch); err != nil {
		return err
	}
	identity := RunIdentity{ProfileID: profile.ID, WorkspaceEpoch: epoch}
	rp, err := e.startProcess(identity, profile, workspaceRoot)
	if err != nil {
		return err
	}

	e.emit(rp.status)
	go e.waitProcess(rp, true, true)
	return nil
}

func (e *Executor) checkAdmission(epoch uint64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.checkAdmissionLocked(epoch)
}

func (e *Executor) checkAdmissionLocked(epoch uint64) error {
	if epoch != e.workspaceEpoch {
		return fmt.Errorf("workspace epoch mismatch: got %d, current %d: %w", epoch, e.workspaceEpoch, errRunAdmissionInvalidated)
	}
	if e.draining {
		return fmt.Errorf("run admission is paused for workspace drain: %w", errRunAdmissionInvalidated)
	}
	return nil
}

type preparedProcess struct {
	cmd        *exec.Cmd
	stdout     io.ReadCloser
	stderr     io.ReadCloser
	workingDir string
}

// startProcess launches one execution. identity.RunInstanceID is the unique key
// under which the process is registered. For single runs identity is built by
// Start; for compound steps it is preassigned by StartCompound and carries
// ParentRunInstanceID + StepIdx.
func (e *Executor) startProcess(identity RunIdentity, profile RunProfile, workspaceRoot string) (*runningProcess, error) {
	if err := e.checkAdmission(identity.WorkspaceEpoch); err != nil {
		return nil, err
	}
	prepared, err := prepareProcess(profile, workspaceRoot)
	if err != nil {
		return nil, err
	}

	e.mu.Lock()
	if err := e.checkAdmissionLocked(identity.WorkspaceEpoch); err != nil {
		e.mu.Unlock()
		prepared.closePipes()
		return nil, err
	}
	if identity.RunInstanceID == "" {
		identity.RunInstanceID = e.nextRunInstanceIDLocked()
		identity.LaunchSeq = e.nextRunSeq
	}
	if err := e.reserveProcessLocked(identity); err != nil {
		e.mu.Unlock()
		prepared.closePipes()
		return nil, err
	}
	reservation := &launchReservation{
		identity: identity,
		done:     make(chan struct{}),
	}
	e.reservations[identity.RunInstanceID] = reservation
	e.mu.Unlock()

	return e.startReservedProcess(prepared, reservation)
}

func (e *Executor) startReservedProcess(prepared *preparedProcess, reservation *launchReservation) (*runningProcess, error) {
	e.mu.Lock()
	identity := reservation.identity
	invalid := reservation.invalid ||
		identity.WorkspaceEpoch != e.workspaceEpoch ||
		e.draining ||
		e.reservations[identity.RunInstanceID] != reservation
	startCommand := e.commandStart
	e.mu.Unlock()
	if invalid {
		prepared.closePipes()
		e.finishReservation(reservation)
		return nil, fmt.Errorf("%w before process start", errRunAdmissionInvalidated)
	}

	if err := startCommand(prepared.cmd); err != nil {
		prepared.closePipes()
		e.finishReservation(reservation)
		return nil, fmt.Errorf("starting process: %w", err)
	}

	e.mu.Lock()
	invalid = reservation.invalid ||
		identity.WorkspaceEpoch != e.workspaceEpoch ||
		e.draining ||
		e.reservations[identity.RunInstanceID] != reservation
	if invalid {
		reservation.invalid = true
		e.mu.Unlock()
		e.reapInvalidatedProcess(prepared)
		e.finishReservation(reservation)
		return nil, fmt.Errorf("%w during process start", errRunAdmissionInvalidated)
	}

	rp := &runningProcess{
		cmd:      prepared.cmd,
		identity: identity,
		status: RunStatus{
			RunIdentity: identity,
			State:       RunStateRunning,
			Pid:         prepared.cmd.Process.Pid,
		},
		done:       make(chan struct{}),
		stdout:     prepared.stdout,
		stderr:     prepared.stderr,
		workingDir: prepared.workingDir,
	}
	e.processes[identity.RunInstanceID] = rp
	delete(e.reservations, identity.RunInstanceID)
	e.activeByProfile[identity.ProfileID] = identity.RunInstanceID
	e.mu.Unlock()
	close(reservation.done)

	return rp, nil
}

func prepareProcess(profile RunProfile, workspaceRoot string) (*preparedProcess, error) {
	if workspaceRoot == "" {
		return nil, fmt.Errorf("no workspace loaded")
	}
	if strings.TrimSpace(profile.Command) == "" {
		return nil, fmt.Errorf("profile has no command: %s", profile.ID)
	}

	effectiveDir, err := resolveWorkingDir(workspaceRoot, profile.WorkingDir)
	if err != nil {
		return nil, err
	}

	env, err := buildEnv(profile, effectiveDir)
	if err != nil {
		return nil, err
	}

	cmd := shellCommand(profile.Command)
	cmd.Dir = effectiveDir
	cmd.Env = env
	setSysProcAttr(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("creating stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdout.Close()
		return nil, fmt.Errorf("creating stderr pipe: %w", err)
	}
	return &preparedProcess{
		cmd:        cmd,
		stdout:     stdout,
		stderr:     stderr,
		workingDir: effectiveDir,
	}, nil
}

func (p *preparedProcess) closePipes() {
	_ = p.stdout.Close()
	_ = p.stderr.Close()
}

func (e *Executor) reserveProcessLocked(identity RunIdentity) error {
	return e.reserveProcessCapacityLocked(identity, "")
}

func (e *Executor) reserveProcessCapacityLocked(identity RunIdentity, replacedRunInstanceID string) error {
	if _, exists := e.processes[identity.RunInstanceID]; exists {
		return fmt.Errorf("run instance already exists: %s", identity.RunInstanceID)
	}
	if _, exists := e.reservations[identity.RunInstanceID]; exists {
		return fmt.Errorf("run instance already reserved: %s", identity.RunInstanceID)
	}

	ordinary := 0
	// Live instances counted below. A pending replacement for one of them shares
	// that instance's slot rather than claiming a second one — an exact restart
	// stops its target before promoting the replacement, so the pair can never be
	// running at the same time.
	countedProcesses := make(map[string]bool, len(e.processes))
	for runInstanceID, rp := range e.processes {
		if runInstanceID == replacedRunInstanceID {
			continue
		}
		if rp.identity.ProfileID != identity.ProfileID {
			continue
		}
		if identity.ParentRunInstanceID != "" || rp.identity.ParentRunInstanceID != "" {
			return fmt.Errorf("profile already running: %s", identity.ProfileID)
		}
		ordinary++
		countedProcesses[runInstanceID] = true
	}
	for _, reservation := range e.reservations {
		if reservation.identity.ProfileID != identity.ProfileID {
			continue
		}
		if identity.ParentRunInstanceID != "" || reservation.identity.ParentRunInstanceID != "" {
			return fmt.Errorf("profile already running: %s", identity.ProfileID)
		}
		// Without this, restarting both live siblings concurrently fails: the
		// second restart counts the first restart's reservation on top of the
		// original it is replacing and hits the cap, even though the settled
		// state is still two runs. Once the replaced instance has exited it is
		// no longer counted above, so the reservation claims the slot itself.
		if reservation.replacesRunInstanceID != "" && countedProcesses[reservation.replacesRunInstanceID] {
			continue
		}
		ordinary++
	}
	for _, compound := range e.compounds {
		if compound.status.ProfileID == identity.ProfileID {
			return fmt.Errorf("profile already running: %s", identity.ProfileID)
		}
		for _, node := range compound.plan {
			step := node.step
			if step.ProfileID == identity.ProfileID &&
				step.State == CompoundStepRunning &&
				step.RunInstanceID != identity.RunInstanceID {
				return fmt.Errorf("profile already running: %s", identity.ProfileID)
			}
		}
	}
	if identity.ParentRunInstanceID == "" && ordinary >= 2 {
		return fmt.Errorf("profile already running: %s", identity.ProfileID)
	}
	return nil
}

func (e *Executor) reserveReplacement(epoch uint64, profile RunProfile, replacedRunInstanceID string) (*launchReservation, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.checkAdmissionLocked(epoch); err != nil {
		return nil, err
	}
	replaced := e.processes[replacedRunInstanceID]
	if replaced == nil {
		return nil, fmt.Errorf("%w: %s", ErrRunInstanceNotRunning, replacedRunInstanceID)
	}
	if replaced.identity.ParentRunInstanceID != "" {
		return nil, fmt.Errorf("exact restart requires an ordinary run: %s", replacedRunInstanceID)
	}
	if replaced.identity.ProfileID != profile.ID {
		return nil, fmt.Errorf("run instance %s belongs to profile %s", replacedRunInstanceID, replaced.identity.ProfileID)
	}
	for _, reservation := range e.reservations {
		if reservation.replacesRunInstanceID == replacedRunInstanceID {
			return nil, fmt.Errorf("run instance restart already pending: %s", replacedRunInstanceID)
		}
	}

	identity := RunIdentity{
		RunInstanceID:  e.nextRunInstanceIDLocked(),
		ProfileID:      profile.ID,
		WorkspaceEpoch: epoch,
		LaunchSeq:      e.nextRunSeq,
	}
	if err := e.reserveProcessCapacityLocked(identity, replacedRunInstanceID); err != nil {
		return nil, err
	}
	reservation := &launchReservation{
		identity:              identity,
		replacesRunInstanceID: replacedRunInstanceID,
		done:                  make(chan struct{}),
	}
	e.reservations[identity.RunInstanceID] = reservation
	return reservation, nil
}

func (e *Executor) finishReservation(reservation *launchReservation) {
	e.mu.Lock()
	if e.reservations[reservation.identity.RunInstanceID] == reservation {
		delete(e.reservations, reservation.identity.RunInstanceID)
	}
	e.mu.Unlock()
	close(reservation.done)
}

// reapInvalidatedProcess kills and reaps a process that was spawned but whose
// admission was invalidated before promotion. The reap is bounded: this runs on
// the path that closes reservation.done, which StopAll blocks on, so a kill that
// does not land (taskkill failure on Windows, an already-reparented group) must
// not wedge a workspace switch. A stuck Wait is left to its own goroutine.
func (e *Executor) reapInvalidatedProcess(prepared *preparedProcess) {
	if prepared.cmd.Process != nil {
		_ = forceKillProcessGroup(prepared.cmd.Process.Pid)
	}
	prepared.closePipes()
	reaped := make(chan struct{})
	go func() {
		_ = prepared.cmd.Wait()
		close(reaped)
	}()
	select {
	case <-reaped:
	case <-time.After(stopGracePeriod):
	}
}

func (e *Executor) setCommandStartHook(hook func(*exec.Cmd) error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if hook == nil {
		e.commandStart = func(cmd *exec.Cmd) error { return cmd.Start() }
		return
	}
	e.commandStart = hook
}

func (e *Executor) waitProcess(rp *runningProcess, emitStatus bool, retainStatus bool) processResult {
	batcher := newOutputBatcher(e.outputFn, 16*time.Millisecond)
	var pipesWg sync.WaitGroup
	pipesWg.Add(2)
	go e.drainPipe(&pipesWg, rp.identity, "stdout", rp.stdout, batcher)
	go e.drainPipe(&pipesWg, rp.identity, "stderr", rp.stderr, batcher)

	pipesWg.Wait()
	batcher.Close()
	exitCode := waitExitCode(rp.cmd)

	e.mu.Lock()
	stopped := rp.stopped
	if stopped {
		rp.status.State = RunStateStopped
	} else if exitCode == 0 {
		rp.status.State = RunStateSuccess
	} else {
		rp.status.State = RunStateFailed
	}
	rp.status.ExitCode = exitCode
	rp.status.Pid = 0
	status := rp.status
	if retainStatus {
		e.retainTerminalStatusLocked(status)
	}
	delete(e.processes, rp.identity.RunInstanceID)
	e.refreshActiveProfileLocked(rp.identity.ProfileID)
	e.mu.Unlock()

	if emitStatus {
		e.emit(status)
	}
	close(rp.done)

	return processResult{
		state:      status.State,
		exitCode:   exitCode,
		workingDir: rp.workingDir,
	}
}

func (e *Executor) retainTerminalStatusLocked(status RunStatus) {
	profileID := status.ProfileID
	e.lastStatus[status.RunInstanceID] = status
	ids := e.terminalStatusIDsByProfile[profileID]
	found := false
	for _, id := range ids {
		if id == status.RunInstanceID {
			found = true
			break
		}
	}
	if !found {
		ids = append(ids, status.RunInstanceID)
	}
	// At most three entries reach this sort, so an in-place insertion policy is
	// simpler than another persistent ordering structure.
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && e.lastStatus[ids[j-1]].LaunchSeq > e.lastStatus[ids[j]].LaunchSeq; j-- {
			ids[j-1], ids[j] = ids[j], ids[j-1]
		}
	}
	for len(ids) > 2 {
		delete(e.lastStatus, ids[0])
		ids = ids[1:]
	}
	e.terminalStatusIDsByProfile[profileID] = ids
}

func (e *Executor) refreshActiveProfileLocked(profileID string) {
	var (
		selectedID  string
		selectedSeq uint64
		found       bool
	)
	for id, rp := range e.processes {
		if rp.identity.ProfileID != profileID {
			continue
		}
		if !found || rp.identity.LaunchSeq >= selectedSeq {
			selectedID, selectedSeq, found = id, rp.identity.LaunchSeq, true
		}
	}
	for id, compound := range e.compounds {
		if compound.status.ProfileID != profileID {
			continue
		}
		if !found || compound.status.LaunchSeq >= selectedSeq {
			selectedID, selectedSeq, found = id, compound.status.LaunchSeq, true
		}
	}
	if found {
		e.activeByProfile[profileID] = selectedID
	} else {
		delete(e.activeByProfile, profileID)
	}
}

// Stop terminates a running profile. Sends SIGTERM, waits up to 3 seconds,
// then escalates to SIGKILL. Blocks until the process is fully cleaned up.
//
// If profileID refers to an in-flight compound run, the compound is cancelled
// (preventing the next step from starting), the currently-running leaf (if any)
// is stopped via the leaf path, and Stop blocks until the coordinator finishes.
func (e *Executor) Stop(profileID string) error {
	e.mu.Lock()
	e.refreshActiveProfileLocked(profileID)
	rid, ok := e.activeByProfile[profileID]
	if !ok {
		e.mu.Unlock()
		return nil
	}
	if process := e.processes[rid]; process != nil && process.identity.ParentRunInstanceID != "" {
		rid = process.identity.ParentRunInstanceID
	}
	_, compound := e.compounds[rid]
	e.mu.Unlock()
	if compound {
		return e.stopCompoundRunInstance(rid)
	}
	return e.StopRunInstance(rid)
}

func (e *Executor) stopCompoundRunInstance(runInstanceID string) error {
	e.mu.Lock()
	cr := e.compounds[runInstanceID]
	if cr == nil {
		e.mu.Unlock()
		return nil
	}
	var leaf *runningProcess
	if cr.current >= 0 && cr.current < len(cr.plan) {
		leaf = e.processes[cr.plan[cr.current].step.RunInstanceID]
	}
	cancel := cr.cancel
	done := cr.done
	e.mu.Unlock()
	cancel()
	if leaf != nil {
		e.signalStop(leaf)
	}
	<-done
	return nil
}

// StopRunInstance stops exactly one ordinary execution and is idempotent for
// terminal or unknown run instance IDs.
func (e *Executor) StopRunInstance(runInstanceID string) error {
	e.mu.Lock()
	if _, compound := e.compounds[runInstanceID]; compound {
		e.mu.Unlock()
		return fmt.Errorf("exact stop requires an ordinary run: %s", runInstanceID)
	}
	rp := e.processes[runInstanceID]
	if rp != nil && rp.identity.ParentRunInstanceID != "" {
		e.mu.Unlock()
		return fmt.Errorf("exact stop requires an ordinary run: %s", runInstanceID)
	}
	e.mu.Unlock()
	if rp == nil {
		return nil
	}
	e.signalStop(rp)
	<-rp.done
	return nil
}

// RestartAtEpoch reserves a replacement for the selected ordinary execution
// before stopping it, so another launch cannot steal the released capacity.
func (e *Executor) RestartAtEpoch(epoch uint64, workspaceRoot string, profile RunProfile, runInstanceID string) error {
	if err := e.checkAdmission(epoch); err != nil {
		return err
	}
	if profile.Type == ProfileTypeCompound {
		return fmt.Errorf("exact restart requires an ordinary run: %s", runInstanceID)
	}
	prepared, err := prepareProcess(profile, workspaceRoot)
	if err != nil {
		return err
	}
	reservation, err := e.reserveReplacement(epoch, profile, runInstanceID)
	if err != nil {
		prepared.closePipes()
		return err
	}
	if err := e.StopRunInstance(runInstanceID); err != nil {
		prepared.closePipes()
		e.finishReservation(reservation)
		return err
	}
	rp, err := e.startReservedProcess(prepared, reservation)
	if err != nil {
		return err
	}
	e.emit(rp.status)
	go e.waitProcess(rp, true, true)
	return nil
}

// RestartCompoundAtEpoch restarts the active aggregate for a compound profile.
func (e *Executor) RestartCompoundAtEpoch(epoch uint64, workspaceRoot string, compound RunProfile, steps []RunProfile) error {
	if err := e.checkAdmission(epoch); err != nil {
		return err
	}
	if err := e.Stop(compound.ID); err != nil {
		return err
	}
	return e.StartCompoundAtEpoch(epoch, workspaceRoot, compound, steps)
}

// ProfileIDForRunInstance resolves live and retained top-level executions
// without exposing executor maps to the app binding.
func (e *Executor) ProfileIDForRunInstance(runInstanceID string) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.profileIDForRunInstanceLocked(runInstanceID)
}

func (e *Executor) profileIDForRunInstanceLocked(runInstanceID string) (string, bool) {
	if rp, ok := e.processes[runInstanceID]; ok {
		if rp.identity.ParentRunInstanceID != "" {
			return "", false
		}
		return rp.identity.ProfileID, true
	}
	if cr, ok := e.compounds[runInstanceID]; ok {
		return cr.status.ProfileID, true
	}
	if status, ok := e.lastStatus[runInstanceID]; ok {
		return status.ProfileID, true
	}
	if reservation, ok := e.reservations[runInstanceID]; ok {
		return reservation.identity.ProfileID, true
	}
	return "", false
}

// signalStop sends SIGTERM to a leaf's process group exactly once and escalates
// to SIGKILL after stopGracePeriod if it has not exited. The escalation runs in
// a watchdog goroutine, so this is non-blocking: callers that own rp.done (the
// compound coordinator, which closes it via waitProcess) can call this and keep
// going, while callers that need full cleanup wait on rp.done afterward. Using
// rp.stopOnce ensures a single SIGTERM + single escalation even when both an
// external Stop and the coordinator's start/stop-race fallback target the leaf.
func (e *Executor) signalStop(rp *runningProcess) {
	rp.stopOnce.Do(func() {
		e.mu.Lock()
		rp.stopped = true
		e.mu.Unlock()

		pid := rp.cmd.Process.Pid
		_ = killProcessGroup(pid)

		go func() {
			select {
			case <-rp.done:
			case <-time.After(stopGracePeriod):
				_ = forceKillProcessGroup(pid)
			}
		}()
	})
}

// StopAll terminates all running profiles within the given timeout.
// Returns true if all processes (and compound coordinators) were cleaned up
// before the deadline.
//
// Compound current-step leaves are already in e.processes, so they are included
// in the process copy and receive SIGTERM. Each compound coordinator is also
// cancelled so the next step cannot start, and StopAll waits on every compound
// done channel in addition to every process done channel.
func (e *Executor) StopAll(timeout time.Duration) bool {
	return e.StopAllWithReason(timeout, "")
}

// StopAllWithReason stops all running profiles and attaches an administrative
// reason to their terminal aggregate statuses.
func (e *Executor) StopAllWithReason(timeout time.Duration, reason string) bool {
	e.mu.Lock()
	if len(e.processes) == 0 && len(e.compounds) == 0 && len(e.reservations) == 0 {
		e.mu.Unlock()
		return true
	}

	// Copy entries for concurrent stop
	type entry struct {
		id string
		rp *runningProcess
	}
	entries := make([]entry, 0, len(e.processes))
	for id, rp := range e.processes {
		entries = append(entries, entry{id, rp})
	}

	// Copy compound coordinators (cancel + done) for concurrent cancellation.
	type compoundEntry struct {
		cancel context.CancelFunc
		done   chan struct{}
	}
	compoundEntries := make([]compoundEntry, 0, len(e.compounds))
	for _, cr := range e.compounds {
		compoundEntries = append(compoundEntries, compoundEntry{cancel: cr.cancel, done: cr.done})
	}
	reservationDone := make([]chan struct{}, 0, len(e.reservations))
	for _, reservation := range e.reservations {
		reservation.invalid = true
		reservationDone = append(reservationDone, reservation.done)
	}

	e.setAdministrativeReasonLocked(reason)
	// Mark all processes as stopped
	for _, ent := range entries {
		ent.rp.stopped = true
	}
	e.mu.Unlock()

	// Cancel every compound coordinator (prevents the next step starting).
	for _, ce := range compoundEntries {
		ce.cancel()
	}

	// Send SIGTERM to all
	for _, ent := range entries {
		pid := ent.rp.cmd.Process.Pid
		_ = killProcessGroup(pid)
	}

	halfway := timeout / 2
	deadline := time.After(timeout)
	halfwayTimer := time.After(halfway)

	// Collect done channels (processes + compound coordinators). The collector
	// also selects on stopWaiting so it cannot leak if a survivor never exits:
	// on a deadline miss we close stopWaiting and the goroutine returns instead
	// of blocking forever on a wedged done channel.
	allDone := make(chan struct{})
	stopWaiting := make(chan struct{})
	go func() {
		waitDone := func(ch <-chan struct{}) bool {
			select {
			case <-ch:
				return true
			case <-stopWaiting:
				return false
			}
		}
		for _, ent := range entries {
			if !waitDone(ent.rp.done) {
				return
			}
		}
		for _, ce := range compoundEntries {
			if !waitDone(ce.done) {
				return
			}
		}
		for _, done := range reservationDone {
			if !waitDone(done) {
				return
			}
		}
		close(allDone)
	}()

	// Wait for halfway point — escalate survivors to SIGKILL
	select {
	case <-allDone:
		return true
	case <-halfwayTimer:
		// Force-kill any survivors
		e.mu.Lock()
		for _, ent := range entries {
			if _, stillRunning := e.processes[ent.id]; stillRunning {
				pid := ent.rp.cmd.Process.Pid
				_ = forceKillProcessGroup(pid)
			}
		}
		e.mu.Unlock()
	}

	// Wait for full deadline
	select {
	case <-allDone:
		return true
	case <-deadline:
		close(stopWaiting)
		return false
	}
}

// GetStatus returns the current run status of a profile.
// Returns the terminal status (success/failed/stopped) if the profile has
// completed but has not been restarted, or RunStateIdle if never started.
func (e *Executor) GetStatus(profileID string) RunStatus {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.refreshActiveProfileLocked(profileID)
	if rid, ok := e.activeByProfile[profileID]; ok {
		if rp, running := e.processes[rid]; running {
			return rp.status
		}
		if cr, running := e.compounds[rid]; running {
			return cr.status
		}
	}
	ids := e.terminalStatusIDsByProfile[profileID]
	if len(ids) > 0 {
		return e.lastStatus[ids[len(ids)-1]]
	}
	return RunStatus{RunIdentity: RunIdentity{ProfileID: profileID}, State: RunStateIdle}
}

// ClearTerminalStatuses removes all retained terminal statuses.
// Called on workspace switch so stale results from the previous workspace
// cannot leak into a new workspace that reuses the same profile IDs.
func (e *Executor) ClearTerminalStatuses() {
	e.mu.Lock()
	defer e.mu.Unlock()
	clear(e.lastStatus)
	clear(e.terminalStatusIDsByProfile)
}

// emit sends a status event via the configured StatusFunc.
func (e *Executor) emit(status RunStatus) {
	status.Timestamp = time.Now().UnixMilli()
	if e.emitFn != nil {
		e.emitFn("run:status", status)
	}
}

// drainPipe reads from a pipe and forwards chunks to the output batcher.
func (e *Executor) drainPipe(wg *sync.WaitGroup, id RunIdentity, stream string, pipe io.ReadCloser, batcher *outputBatcher) {
	defer wg.Done()
	buf := make([]byte, 4096)
	for {
		n, err := pipe.Read(buf)
		if n > 0 {
			batcher.Write(id, stream, string(buf[:n]), time.Now().UnixMilli())
		}
		if err != nil {
			return
		}
	}
}

// resolveWorkingDir converts a profile workingDir into an absolute path.
// Empty workingDir defaults to workspaceRoot. Relative paths are resolved
// against workspaceRoot. Validates the directory exists.
func resolveWorkingDir(workspaceRoot, workingDir string) (string, error) {
	var resolved string
	switch {
	case workingDir == "":
		resolved = workspaceRoot
	case filepath.IsAbs(workingDir):
		resolved = workingDir
	default:
		resolved = filepath.Join(workspaceRoot, workingDir)
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("working directory does not exist: %s", resolved)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("working directory is not a directory: %s", resolved)
	}
	return resolved, nil
}

// buildEnv merges environment sources in precedence order:
// os.Environ() → profile.Env → profile.EnvFile → active variant env file.
// Relative env file paths are resolved against effectiveWorkingDir.
func buildEnv(profile RunProfile, effectiveWorkingDir string) ([]string, error) {
	// Start with current environment
	envMap := make(map[string]string)
	for _, entry := range os.Environ() {
		if idx := strings.IndexByte(entry, '='); idx >= 0 {
			envMap[entry[:idx]] = entry[idx+1:]
		}
	}

	// Layer 2: inline profile env
	for k, v := range profile.Env {
		envMap[k] = v
	}

	// Layer 3: base env file
	if err := mergeEnvFile(envMap, profile.EnvFile, effectiveWorkingDir); err != nil {
		return nil, err
	}

	// Layer 4: active variant env file
	variantEnvFile, err := activeVariantEnvFile(profile)
	if err != nil {
		return nil, err
	}
	if err := mergeEnvFile(envMap, variantEnvFile, effectiveWorkingDir); err != nil {
		return nil, err
	}

	// Convert back to slice
	result := make([]string, 0, len(envMap))
	for k, v := range envMap {
		result = append(result, k+"="+v)
	}
	return result, nil
}

func mergeEnvFile(envMap map[string]string, envFilePath string, effectiveWorkingDir string) error {
	if strings.TrimSpace(envFilePath) == "" {
		return nil
	}
	resolved := envFilePath
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(effectiveWorkingDir, resolved)
	}
	fileEnv, err := ParseEnvFile(resolved)
	if err != nil {
		return err
	}
	for k, v := range fileEnv {
		envMap[k] = v
	}
	return nil
}

func activeVariantEnvFile(profile RunProfile) (string, error) {
	if strings.TrimSpace(profile.ActiveVariant) == "" {
		return "", nil
	}
	variant, ok := findEnvVariant(profile.EnvVariants, profile.ActiveVariant)
	if !ok {
		return "", fmt.Errorf("env variant %q not found for profile %s", profile.ActiveVariant, profile.ID)
	}
	return variant.EnvFile, nil
}

// waitExitCode waits for the command to finish and extracts the exit code.
func waitExitCode(cmd *exec.Cmd) int {
	err := cmd.Wait()
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return 1
}
