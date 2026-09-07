//go:build !windows

package runprofile

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// emitSpy collects emitted events for test assertions.
type emitSpy struct {
	mu     sync.Mutex
	events []emitEvent
}

type emitEvent struct {
	event string
	data  []any
}

func (s *emitSpy) emit(event string, data any) {
	var args []any
	if data != nil {
		args = []any{data}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, emitEvent{event: event, data: args})
}

func (s *emitSpy) statuses() []RunStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []RunStatus
	for _, e := range s.events {
		if e.event == "run:status" && len(e.data) > 0 {
			if st, ok := e.data[0].(RunStatus); ok {
				result = append(result, st)
			}
		}
	}
	return result
}

func (s *emitSpy) waitForState(state RunState, timeout time.Duration) (RunStatus, bool) {
	deadline := time.After(timeout)
	for {
		for _, st := range s.statuses() {
			if st.State == state {
				return st, true
			}
		}
		select {
		case <-deadline:
			return RunStatus{}, false
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// outputSpy collects output for test assertions.
type outputSpy struct {
	mu      sync.Mutex
	entries []outputEntry
}

type outputEntry struct {
	identity  RunIdentity
	stream    string
	data      string
	timestamp int64
}

func (o *outputSpy) receive(id RunIdentity, stream, data string, timestamp int64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.entries = append(o.entries, outputEntry{id, stream, data, timestamp})
}

func (o *outputSpy) combined() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	var sb strings.Builder
	for _, e := range o.entries {
		sb.WriteString(e.data)
	}
	return sb.String()
}

func (o *outputSpy) streamContent(stream string) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	var sb strings.Builder
	for _, e := range o.entries {
		if e.stream == stream {
			sb.WriteString(e.data)
		}
	}
	return sb.String()
}

func newTestProfile(id, command string) RunProfile {
	return RunProfile{
		ID:      id,
		Name:    id,
		Type:    ProfileTypeSingle,
		Command: command,
	}
}

func waitForTerminalInstanceID(t *testing.T, e *Executor, profileID string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		st := e.GetStatus(profileID)
		if st.State == RunStateSuccess || st.State == RunStateFailed || st.State == RunStateStopped {
			return st.RunInstanceID
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("profile %q did not reach a terminal state", profileID)
	return ""
}

func TestExecutor_StartSuccess(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-echo", "echo hello")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	// Should transition to running, then success
	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	statuses := spy.statuses()
	if len(statuses) < 2 {
		t.Fatalf("expected at least 2 status events, got %d", len(statuses))
	}
	if statuses[0].State != RunStateRunning {
		t.Errorf("first state = %q, want %q", statuses[0].State, RunStateRunning)
	}
	if statuses[len(statuses)-1].ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", statuses[len(statuses)-1].ExitCode)
	}
}

func TestExecutor_StartFailure(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-fail", "exit 1")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	st, ok := spy.waitForState(RunStateFailed, 5*time.Second)
	if !ok {
		t.Fatal("timed out waiting for failed state")
	}
	if st.ExitCode != 1 {
		t.Errorf("exit code = %d, want 1", st.ExitCode)
	}
}

func TestExecutor_StartCompoundRejected(t *testing.T) {
	exec := NewExecutor(nil, nil)
	dir := t.TempDir()

	profile := RunProfile{
		ID:   "compound-test",
		Name: "compound",
		Type: ProfileTypeCompound,
	}
	err := exec.Start(dir, profile)
	if err == nil {
		t.Fatal("expected error for compound profile")
	}
	if !strings.Contains(err.Error(), "compound profiles require resolved steps") {
		t.Errorf("error = %q, want compound rejection message", err.Error())
	}
}

func TestExecutor_SignalStopEscalatesToSIGKILL(t *testing.T) {
	exec := NewExecutor(nil, nil)
	dir := t.TempDir()
	// Trap SIGTERM so the child can only be ended by a SIGKILL escalation.
	profile := newTestProfile("stubborn", "trap '' TERM; sleep 30")

	rp, err := exec.startProcess(RunIdentity{RunInstanceID: "stubborn", ProfileID: "stubborn"}, profile, dir)
	if err != nil {
		t.Fatalf("startProcess returned error: %v", err)
	}
	go exec.waitProcess(rp, false, false)

	// Non-blocking: SIGTERM now, SIGKILL after the grace period via watchdog.
	exec.signalStop(rp)

	select {
	case <-rp.done:
		// Escalation killed the TERM-ignoring child and cleanup completed.
	case <-time.After(stopGracePeriod + 5*time.Second):
		t.Fatal("signalStop did not escalate to SIGKILL; process survived past grace period")
	}
}

func TestExecutor_StopGraceful(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-sleep", "sleep 60")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateRunning, 5*time.Second); !ok {
		t.Fatal("timed out waiting for running state")
	}

	if err := exec.Stop("test-sleep"); err != nil {
		t.Fatal(err)
	}

	st, ok := spy.waitForState(RunStateStopped, 5*time.Second)
	if !ok {
		t.Fatal("timed out waiting for stopped state")
	}
	if st.State != RunStateStopped {
		t.Errorf("state = %q, want %q", st.State, RunStateStopped)
	}
}

func TestExecutor_StopSetsStoppedFlag(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-stopped-flag", "sleep 60")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateRunning, 5*time.Second); !ok {
		t.Fatal("timed out waiting for running state")
	}

	if err := exec.Stop("test-stopped-flag"); err != nil {
		t.Fatal(err)
	}

	// The final state should be "stopped", not "failed" (even though the process
	// was killed with a signal which normally produces a non-zero exit)
	st, ok := spy.waitForState(RunStateStopped, 5*time.Second)
	if !ok {
		t.Fatal("timed out waiting for stopped state")
	}
	if st.State != RunStateStopped {
		t.Errorf("state = %q, want %q — stop flag was not respected", st.State, RunStateStopped)
	}
}

func TestExecutor_SameProfileCapacityIsTwo(t *testing.T) {
	exec := NewExecutor(nil, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-dup", "sleep 60")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}
	if err := exec.Start(dir, profile); err != nil {
		t.Fatalf("second same-profile start: %v", err)
	}
	defer exec.StopAll(2 * time.Second) //nolint:errcheck

	err := exec.Start(dir, profile)
	if err == nil {
		t.Fatal("expected third same-profile start to be rejected")
	}
	if !strings.Contains(err.Error(), "already running") {
		t.Errorf("error = %q, want 'already running'", err.Error())
	}
}

func TestExecutor_StopNonExistent(t *testing.T) {
	exec := NewExecutor(nil, nil)
	// Stop is idempotent: stopping an unknown/idle profile is a no-op (#103).
	if err := exec.Stop("bogus-id"); err != nil {
		t.Fatalf("Stop on idle profile returned error: %v", err)
	}
}

func TestExecutor_EnvVars(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	profile := newTestProfile("test-env", "env")
	profile.Env = map[string]string{
		"FIRN_TEST_VAR": "hello_from_firn",
	}
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	output := out.combined()
	if !strings.Contains(output, "FIRN_TEST_VAR=hello_from_firn") {
		t.Errorf("env output does not contain FIRN_TEST_VAR=hello_from_firn\noutput:\n%s", output)
	}
}

func TestExecutor_WorkingDirDefault(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	profile := newTestProfile("test-pwd", "pwd")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	output := strings.TrimSpace(out.combined())
	// Resolve symlinks for macOS /private/var/folders... vs /var/folders...
	resolvedDir, _ := filepath.EvalSymlinks(dir)
	resolvedOutput, _ := filepath.EvalSymlinks(output)
	if resolvedOutput != resolvedDir {
		t.Errorf("pwd = %q, want %q", resolvedOutput, resolvedDir)
	}
}

func TestExecutor_WorkingDirRelative(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	subdir := filepath.Join(dir, "frontend")
	if err := os.MkdirAll(subdir, 0755); err != nil {
		t.Fatal(err)
	}

	profile := newTestProfile("test-pwd-rel", "pwd")
	profile.WorkingDir = "frontend"
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	output := strings.TrimSpace(out.combined())
	resolvedSubdir, _ := filepath.EvalSymlinks(subdir)
	resolvedOutput, _ := filepath.EvalSymlinks(output)
	if resolvedOutput != resolvedSubdir {
		t.Errorf("pwd = %q, want %q", resolvedOutput, resolvedSubdir)
	}
}

func TestExecutor_InvalidWorkingDir(t *testing.T) {
	exec := NewExecutor(nil, nil)

	profile := newTestProfile("test-bad-dir", "echo hello")
	profile.WorkingDir = "/nonexistent/directory"
	err := exec.Start("/tmp", profile)
	if err == nil {
		t.Fatal("expected error for invalid working directory")
	}
	if !strings.Contains(err.Error(), "working directory does not exist") {
		t.Errorf("error = %q, want 'working directory does not exist'", err.Error())
	}
}

func TestExecutor_EnvFileMerge(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	// Create .env file with SHARED_VAR and FILE_VAR.
	envContent := "SHARED_VAR=from_file\nFILE_VAR=file_only\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(envContent), 0644); err != nil {
		t.Fatal(err)
	}

	profile := newTestProfile("test-env-merge", "env")
	profile.EnvFile = ".env"
	profile.Env = map[string]string{
		"SHARED_VAR": "from_inline",
		"INLINE_VAR": "inline_only",
	}
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	output := out.combined()
	if !strings.Contains(output, "SHARED_VAR=from_file") {
		t.Errorf("SHARED_VAR should be from_file (env file wins over inline env), output:\n%s", output)
	}
	if !strings.Contains(output, "FILE_VAR=file_only") {
		t.Errorf("FILE_VAR should be present from env file, output:\n%s", output)
	}
	if !strings.Contains(output, "INLINE_VAR=inline_only") {
		t.Errorf("INLINE_VAR should be present from inline env, output:\n%s", output)
	}
}

func TestExecutor_ActiveVariantEnvFileMerge(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("SHARED_VAR=from_base_file\nBASE_ONLY=base\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env.staging"), []byte("SHARED_VAR=from_variant\nVARIANT_ONLY=staging\n"), 0644); err != nil {
		t.Fatal(err)
	}

	profile := newTestProfile("test-env-variant", "env")
	profile.Env = map[string]string{
		"SHARED_VAR": "from_inline",
		"INLINE_VAR": "inline",
	}
	profile.EnvFile = ".env"
	profile.EnvVariants = []EnvVariant{
		{Name: "staging", EnvFile: ".env.staging"},
	}
	profile.ActiveVariant = "staging"

	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	output := out.combined()
	if !strings.Contains(output, "SHARED_VAR=from_variant") {
		t.Errorf("SHARED_VAR should come from active variant env file, output:\n%s", output)
	}
	if !strings.Contains(output, "BASE_ONLY=base") {
		t.Errorf("BASE_ONLY should come from base env file, output:\n%s", output)
	}
	if !strings.Contains(output, "VARIANT_ONLY=staging") {
		t.Errorf("VARIANT_ONLY should come from active variant env file, output:\n%s", output)
	}
	if !strings.Contains(output, "INLINE_VAR=inline") {
		t.Errorf("INLINE_VAR should come from profile env, output:\n%s", output)
	}
}

func TestExecutor_ActiveVariantEnvFileRelativeToWorkingDir(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	subdir := filepath.Join(dir, "frontend")
	if err := os.MkdirAll(subdir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subdir, ".env.dev"), []byte("WORKDIR_VARIANT=dev\n"), 0644); err != nil {
		t.Fatal(err)
	}

	profile := newTestProfile("test-env-variant-workdir", "env")
	profile.WorkingDir = "frontend"
	profile.EnvVariants = []EnvVariant{
		{Name: "dev", EnvFile: ".env.dev"},
	}
	profile.ActiveVariant = "dev"

	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	output := out.combined()
	if !strings.Contains(output, "WORKDIR_VARIANT=dev") {
		t.Errorf("WORKDIR_VARIANT should be loaded relative to effective working dir, output:\n%s", output)
	}
}

func TestExecutor_ActiveVariantMissing(t *testing.T) {
	exec := NewExecutor(nil, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-env-variant-missing", "echo hello")
	profile.EnvVariants = []EnvVariant{
		{Name: "dev", EnvFile: ".env.dev"},
	}
	profile.ActiveVariant = "staging"

	err := exec.Start(dir, profile)
	if err == nil {
		t.Fatal("expected error for missing active env variant")
	}
	if !strings.Contains(err.Error(), `env variant "staging" not found`) {
		t.Errorf("error = %q, want missing variant message", err.Error())
	}
}

func TestExecutor_EnvFileRelativePath(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	// Create .env.local in workspace root
	envContent := "LOCAL_VAR=found_it\n"
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte(envContent), 0644); err != nil {
		t.Fatal(err)
	}

	profile := newTestProfile("test-env-rel", "env")
	profile.EnvFile = ".env.local"
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	output := out.combined()
	if !strings.Contains(output, "LOCAL_VAR=found_it") {
		t.Errorf("LOCAL_VAR should be present from .env.local, output:\n%s", output)
	}
}

func TestExecutor_EnvFileNotFound(t *testing.T) {
	exec := NewExecutor(nil, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-env-missing", "echo hello")
	profile.EnvFile = ".env.nonexistent"
	err := exec.Start(dir, profile)
	if err == nil {
		t.Fatal("expected error for missing env file")
	}
}

func TestExecutor_ProcessGroupKill(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	// Start a shell that spawns a child. Both should die on Stop.
	profile := newTestProfile("test-pgkill", "sh -c 'sleep 60 & sleep 60'")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateRunning, 5*time.Second); !ok {
		t.Fatal("timed out waiting for running state")
	}

	// Give the child processes a moment to spawn
	time.Sleep(100 * time.Millisecond)

	if err := exec.Stop("test-pgkill"); err != nil {
		t.Fatal(err)
	}

	// Process should be stopped
	st, ok := spy.waitForState(RunStateStopped, 5*time.Second)
	if !ok {
		t.Fatal("timed out waiting for stopped state")
	}
	if st.State != RunStateStopped {
		t.Errorf("state = %q, want %q", st.State, RunStateStopped)
	}
}

func TestExecutor_StopAll(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	// Start two long-running profiles
	for i := 0; i < 2; i++ {
		profile := newTestProfile(fmt.Sprintf("test-stopall-%d", i), "sleep 60")
		if err := exec.Start(dir, profile); err != nil {
			t.Fatal(err)
		}
	}

	// Wait for both to be running
	time.Sleep(100 * time.Millisecond)

	ok := exec.StopAll(5 * time.Second)
	if !ok {
		t.Fatal("StopAll returned false — processes not cleaned up in time")
	}

	// Verify both report stopped (terminal status persists)
	for i := 0; i < 2; i++ {
		st := exec.GetStatus(fmt.Sprintf("test-stopall-%d", i))
		if st.State != RunStateStopped {
			t.Errorf("profile %d state = %q, want %q", i, st.State, RunStateStopped)
		}
	}
}

func TestExecutor_GetStatusRunning(t *testing.T) {
	exec := NewExecutor(nil, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-getstatus", "sleep 60")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}
	defer exec.Stop("test-getstatus") //nolint:errcheck

	// Brief pause for the start goroutine
	time.Sleep(50 * time.Millisecond)

	st := exec.GetStatus("test-getstatus")
	if st.State != RunStateRunning {
		t.Errorf("state = %q, want %q", st.State, RunStateRunning)
	}
	if st.Pid == 0 {
		t.Error("pid should be non-zero for a running process")
	}
}

func TestExecutor_GetStatusAfterSuccess(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-persist", "echo done")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	st := exec.GetStatus("test-persist")
	if st.State != RunStateSuccess {
		t.Errorf("state = %q, want %q — terminal status should persist", st.State, RunStateSuccess)
	}
	if st.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", st.ExitCode)
	}
}

func TestExecutor_GetStatusAfterFailure(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-fail-persist", "exit 42")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateFailed, 5*time.Second); !ok {
		t.Fatal("timed out waiting for failed state")
	}

	st := exec.GetStatus("test-fail-persist")
	if st.State != RunStateFailed {
		t.Errorf("state = %q, want %q", st.State, RunStateFailed)
	}
	if st.ExitCode != 42 {
		t.Errorf("exit code = %d, want 42", st.ExitCode)
	}
}

func TestExecutor_GetStatusClearedOnRestart(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	// Run a failing profile
	profile := newTestProfile("test-clear", "exit 1")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}
	if _, ok := spy.waitForState(RunStateFailed, 5*time.Second); !ok {
		t.Fatal("timed out waiting for failed state")
	}

	// Terminal status should be failed
	st := exec.GetStatus("test-clear")
	if st.State != RunStateFailed {
		t.Errorf("state = %q, want %q", st.State, RunStateFailed)
	}

	// Restart the same profile ID with a successful command
	profile2 := newTestProfile("test-clear", "echo ok")
	if err := exec.Start(dir, profile2); err != nil {
		t.Fatal(err)
	}
	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	// Should now show success, not the old failed status
	st = exec.GetStatus("test-clear")
	if st.State != RunStateSuccess {
		t.Errorf("state = %q, want %q — old terminal status should be cleared on restart", st.State, RunStateSuccess)
	}
}

func TestExecutor_ClearTerminalStatuses(t *testing.T) {
	spy := &emitSpy{}
	exec := NewExecutor(spy.emit, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-clear-all", "echo done")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}
	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	// Terminal status should persist
	st := exec.GetStatus("test-clear-all")
	if st.State != RunStateSuccess {
		t.Fatalf("state = %q, want %q", st.State, RunStateSuccess)
	}

	// Clear all terminal statuses (simulates workspace switch)
	exec.ClearTerminalStatuses()

	// Should now return idle
	st = exec.GetStatus("test-clear-all")
	if st.State != RunStateIdle {
		t.Errorf("state = %q, want %q after ClearTerminalStatuses", st.State, RunStateIdle)
	}
}

func TestExecutor_GetStatusIdle(t *testing.T) {
	exec := NewExecutor(nil, nil)

	st := exec.GetStatus("never-started")
	if st.State != RunStateIdle {
		t.Errorf("state = %q, want %q", st.State, RunStateIdle)
	}
	if st.ProfileID != "never-started" {
		t.Errorf("profileID = %q, want %q", st.ProfileID, "never-started")
	}
}

func TestExecutor_EmptyCommand(t *testing.T) {
	exec := NewExecutor(nil, nil)
	dir := t.TempDir()

	profile := newTestProfile("test-empty", "")
	err := exec.Start(dir, profile)
	if err == nil {
		t.Fatal("expected error for empty command")
	}
	if !strings.Contains(err.Error(), "no command") {
		t.Errorf("error = %q, want 'no command'", err.Error())
	}
}

func TestExecutor_NoWorkspaceRoot(t *testing.T) {
	exec := NewExecutor(nil, nil)
	profile := newTestProfile("test", "echo hello")
	err := exec.Start("", profile)
	if err == nil {
		t.Fatal("expected error for empty workspace root")
	}
	if !strings.Contains(err.Error(), "no workspace loaded") {
		t.Errorf("error = %q, want 'no workspace loaded'", err.Error())
	}
}

func TestExecutor_OutputCallback(t *testing.T) {
	spy := &emitSpy{}
	out := &outputSpy{}
	exec := NewExecutor(spy.emit, out.receive)
	dir := t.TempDir()

	profile := newTestProfile("test-output", "echo stdout_test && echo stderr_test >&2")
	if err := exec.Start(dir, profile); err != nil {
		t.Fatal(err)
	}

	if _, ok := spy.waitForState(RunStateSuccess, 5*time.Second); !ok {
		t.Fatal("timed out waiting for success state")
	}

	stdout := out.streamContent("stdout")
	stderr := out.streamContent("stderr")
	if !strings.Contains(stdout, "stdout_test") {
		t.Errorf("stdout should contain 'stdout_test', got: %q", stdout)
	}
	if !strings.Contains(stderr, "stderr_test") {
		t.Errorf("stderr should contain 'stderr_test', got: %q", stderr)
	}
}

func TestExecutor_SingleRunHasInstanceIDAndActiveLookup(t *testing.T) {
	var statuses []RunStatus
	e := NewExecutor(func(_ string, data any) {
		if s, ok := data.(RunStatus); ok {
			statuses = append(statuses, s)
		}
	}, nil)

	p := newTestProfile("echoer", "echo hi")
	if err := e.Start(t.TempDir(), p); err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Active lookup reflects the run while it is alive or just after.
	st := e.GetStatus("echoer")
	if st.RunInstanceID == "" {
		t.Fatalf("expected a runInstanceId, got empty")
	}
	if st.ProfileID != "echoer" {
		t.Fatalf("profileId = %q, want echoer", st.ProfileID)
	}
}

func TestExecutor_ThirdSameProfileStartRejected(t *testing.T) {
	e := NewExecutor(nil, nil)
	p := newTestProfile("slow", "sleep 2")
	root := t.TempDir()
	if err := e.Start(root, p); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	if err := e.Start(root, p); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if err := e.Start(root, p); err == nil {
		t.Fatalf("expected third start to be rejected")
	}
	e.StopAll(2 * time.Second) //nolint:errcheck
}

func TestExecutor_RerunGetsNewInstanceID(t *testing.T) {
	e := NewExecutor(nil, nil)
	p := newTestProfile("once", "true")
	root := t.TempDir()
	if err := e.Start(root, p); err != nil {
		t.Fatal(err)
	}
	id1 := waitForTerminalInstanceID(t, e, "once")
	if err := e.Start(root, p); err != nil {
		t.Fatal(err)
	}
	id2 := waitForTerminalInstanceID(t, e, "once")
	if id1 == id2 || id1 == "" || id2 == "" {
		t.Fatalf("expected distinct instance ids, got %q and %q", id1, id2)
	}
}

func TestExecutor_StopIdleIsNoop(t *testing.T) {
	e := NewExecutor(nil, nil)
	if err := e.Stop("bogus-id"); err != nil {
		t.Fatalf("Stop on idle profile returned error: %v", err)
	}
}
