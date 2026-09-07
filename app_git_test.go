package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"firn/internal/git/gittest"
)

// isolatedGitEnv strips the repository-local GIT_* variables (so an inherited
// GIT_DIR from a linked worktree cannot redirect these test git commands into
// the real repo) and pins config to /dev/null. Package main cannot reach the
// git package's unexported scrubGitEnv, so this mirrors it locally.
func isolatedGitEnv() []string {
	env := make([]string, 0, len(os.Environ())+6)
	for _, v := range os.Environ() {
		switch {
		case strings.HasPrefix(v, "GIT_DIR="),
			strings.HasPrefix(v, "GIT_WORK_TREE="),
			strings.HasPrefix(v, "GIT_INDEX_FILE="),
			strings.HasPrefix(v, "GIT_COMMON_DIR="),
			strings.HasPrefix(v, "GIT_OBJECT_DIRECTORY="):
			continue
		}
		env = append(env, v)
	}
	return append(env,
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
}

func initGitRepoForApp(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-b", "main"},
		{"config", "user.name", "Test"},
		{"config", "user.email", "test@example.com"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = isolatedGitEnv()
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestGitCommitMessageAvailable_UsesEmbeddedRuntime(t *testing.T) {
	if !NewApp().GitCommitMessageAvailable() {
		t.Fatal("GitCommitMessageAvailable() = false, want true without a binary")
	}
}

func TestGitGenerateCommitMessage_Binding(t *testing.T) {
	dir := initGitRepoForApp(t)
	gittest.Start(t, "feat: add f.txt", nil)
	app := NewApp()
	if err := app.GitStage(dir, []string{"f.txt"}); err != nil {
		t.Fatal(err)
	}

	msg, err := app.GitGenerateCommitMessage(dir)

	if err != nil {
		t.Fatalf("GitGenerateCommitMessage() error = %v", err)
	}
	if msg != "feat: add f.txt" {
		t.Errorf("msg = %q", msg)
	}
}

func TestGitStatus_Binding(t *testing.T) {
	dir := initGitRepoForApp(t)
	app := NewApp()

	st, err := app.GitStatus(dir)

	if err != nil {
		t.Fatalf("GitStatus() error = %v", err)
	}
	if !st.IsRepo || st.Branch != "main" {
		t.Errorf("status = %+v, want IsRepo=true Branch=main", st)
	}
	if len(st.Files) != 1 || st.Files[0].Index != "?" {
		t.Errorf("Files = %+v, want one untracked entry", st.Files)
	}
}

func TestGitStageAndCommit_Binding(t *testing.T) {
	dir := initGitRepoForApp(t)
	app := NewApp()

	if err := app.GitStage(dir, []string{"f.txt"}); err != nil {
		t.Fatalf("GitStage() error = %v", err)
	}
	if _, err := app.GitCommit(dir, "first commit", false); err != nil {
		t.Fatalf("GitCommit() error = %v", err)
	}

	st, _ := app.GitStatus(dir)
	if len(st.Files) != 0 {
		t.Errorf("Files after commit = %+v, want empty", st.Files)
	}
}

func TestGitFileHunksAndApply_Binding(t *testing.T) {
	dir := initGitRepoForApp(t)
	app := NewApp()
	_ = app.GitStage(dir, []string{"f.txt"})
	if _, err := app.GitCommit(dir, "init", false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x\ny\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	fh, err := app.GitFileHunks(dir, "f.txt", false)
	if err != nil {
		t.Fatalf("GitFileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 1 {
		t.Fatalf("hunks = %d, want 1 (%+v)", len(fh.Hunks), fh.Hunks)
	}

	if err := app.GitApplyHunk(dir, fh.Hunks[0].Patch, false); err != nil {
		t.Fatalf("GitApplyHunk() error = %v", err)
	}

	st, _ := app.GitStatus(dir)
	if len(st.Files) != 1 || st.Files[0].Index != "M" {
		t.Errorf("Files = %+v, want f.txt staged-modified", st.Files)
	}
}

func TestGitBranchesAndCheckout_Binding(t *testing.T) {
	dir := initGitRepoForApp(t)
	app := NewApp()
	_ = app.GitStage(dir, []string{"f.txt"})
	if _, err := app.GitCommit(dir, "init", false); err != nil {
		t.Fatal(err)
	}

	if err := app.GitCheckout(dir, "feature/y", true); err != nil {
		t.Fatalf("GitCheckout(create) error = %v", err)
	}
	branches, err := app.GitBranches(dir)
	if err != nil {
		t.Fatalf("GitBranches() error = %v", err)
	}
	if len(branches) != 2 {
		t.Errorf("branches = %v, want 2", branches)
	}
}

// makeAppConflict builds a real merge conflict in a temp repo and returns dir.
func makeAppConflict(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(allowFail bool, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = isolatedGitEnv()
		if out, err := cmd.CombinedOutput(); err != nil && !allowFail {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(s string) {
		if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run(false, "init", "-b", "main")
	run(false, "config", "user.name", "Test")
	run(false, "config", "user.email", "test@example.com")
	write("base\n")
	run(false, "add", ".")
	run(false, "commit", "-m", "base")
	run(false, "checkout", "-b", "feature")
	write("theirs\n")
	run(false, "commit", "-am", "theirs")
	run(false, "checkout", "main")
	write("ours\n")
	run(false, "commit", "-am", "ours")
	run(true, "merge", "feature") // conflicts
	return dir
}

func TestGitMergeBindings_SnapshotStagesHeadsResolve(t *testing.T) {
	dir := makeAppConflict(t)
	app := NewApp()

	snap, err := app.GitConflictSnapshot(dir, "f.txt")
	if err != nil {
		t.Fatalf("GitConflictSnapshot() error = %v", err)
	}
	if len(snap.Regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(snap.Regions))
	}

	heads, err := app.GitMergeHeads(dir)
	if err != nil {
		t.Fatalf("GitMergeHeads() error = %v", err)
	}
	if heads.Operation != "merge" {
		t.Errorf("Operation = %q, want merge", heads.Operation)
	}

	stages, err := app.GitConflictStages(dir, "f.txt")
	if err != nil {
		t.Fatalf("GitConflictStages() error = %v", err)
	}
	if stages.Ours == nil || stages.Theirs == nil {
		t.Errorf("stages incomplete: %+v", stages)
	}

	if err := app.GitResolveConflictSide(dir, "f.txt", "ours"); err != nil {
		t.Fatalf("GitResolveConflictSide() error = %v", err)
	}
	st, _ := app.GitStatus(dir)
	for _, f := range st.Files {
		if f.Unmerged {
			t.Errorf("f.txt still unmerged after resolve: %+v", f)
		}
	}
}

func TestApp_GitConflictState_Binding(t *testing.T) {
	dir := makeAppConflict(t)
	app := NewApp()

	state, err := app.GitConflictState(dir, "f.txt")

	if err != nil {
		t.Fatalf("GitConflictState() error = %v", err)
	}
	if state.SourceVersion == "" {
		t.Error("SourceVersion is empty")
	}
	if state.Snapshot == nil || len(state.Snapshot.Regions) != 1 {
		t.Errorf("Snapshot = %+v, want one region", state.Snapshot)
	}
	if state.Heads == nil || state.Heads.Operation != "merge" {
		t.Errorf("Heads = %+v, want a merge operation", state.Heads)
	}
}

func TestApp_GitConflictGuards_MismatchIsNotAnError(t *testing.T) {
	dir := makeAppConflict(t)
	app := NewApp()
	state, err := app.GitConflictState(dir, "f.txt")
	if err != nil {
		t.Fatal(err)
	}
	stale := state.SourceVersion + "-stale"

	write, err := app.GitWriteConflictResult(dir, "f.txt", stale, "resolved\n", "utf-8", "lf")
	if err != nil {
		t.Fatalf("GitWriteConflictResult() error = %v, want a clean mismatch", err)
	}
	if write.Applied {
		t.Error("write Applied = true, want false")
	}

	stage, err := app.GitStageConflictResult(dir, "f.txt", stale)
	if err != nil {
		t.Fatalf("GitStageConflictResult() error = %v, want a clean mismatch", err)
	}
	if stage.Applied {
		t.Error("stage Applied = true, want false")
	}

	side, err := app.GitApplyConflictSide(dir, "f.txt", "ours", stale)
	if err != nil {
		t.Fatalf("GitApplyConflictSide() error = %v, want a clean mismatch", err)
	}
	if side.Applied {
		t.Error("side Applied = true, want false")
	}

	st, _ := app.GitStatus(dir)
	unmerged := false
	for _, f := range st.Files {
		if f.Unmerged {
			unmerged = true
		}
	}
	if !unmerged {
		t.Error("f.txt is no longer unmerged, want every refused mutation to be a no-op")
	}
}

func TestApp_GitConflictGuards_SucceedWithTheLiveVersion(t *testing.T) {
	dir := makeAppConflict(t)
	app := NewApp()
	state, err := app.GitConflictState(dir, "f.txt")
	if err != nil {
		t.Fatal(err)
	}

	write, err := app.GitWriteConflictResult(dir, "f.txt", state.SourceVersion, "resolved\n", "utf-8", "lf")
	if err != nil || !write.Applied {
		t.Fatalf("GitWriteConflictResult() = %+v, err = %v, want applied", write, err)
	}
	stage, err := app.GitStageConflictResult(dir, "f.txt", write.SourceVersion)
	if err != nil || !stage.Applied {
		t.Fatalf("GitStageConflictResult() = %+v, err = %v, want applied", stage, err)
	}

	st, _ := app.GitStatus(dir)
	for _, f := range st.Files {
		if f.Unmerged {
			t.Errorf("f.txt still unmerged after guarded write and stage: %+v", f)
		}
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "resolved\n" {
		t.Errorf("worktree content = %q, want the resolved result", got)
	}
}

func TestApp_GitConflictState_OperationalErrorStillErrors(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	app := NewApp()

	// Not a repository at all: an operational failure must remain an error and
	// never be reported as a benign version mismatch.
	if _, err := app.GitConflictState(t.TempDir(), "f.txt"); err == nil {
		t.Fatal("GitConflictState(non-repo) error = nil, want an operational error")
	}
}
