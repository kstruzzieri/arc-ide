package main

import (
	"context"
	"firn/internal/git"
	"time"
)

// Timeouts for git bindings. Local plumbing is fast; pull/push cross the
// network; message generation waits on a local LLM.
const (
	gitLocalTimeout    = 15 * time.Second
	gitNetworkTimeout  = 120 * time.Second
	gitGenerateTimeout = 180 * time.Second
)

// gitCtx derives a bounded context from the Wails app context so operations
// die with the window and never hang a binding forever.
func (a *App) gitCtx(timeout time.Duration) (context.Context, context.CancelFunc) {
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, timeout)
}

// GitStatus returns the repository snapshot for the repo containing root.
// IsRepo=false (with no error) means root is not inside a git repository or
// git is not installed; the frontend hides git UI in that case.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitStatus(root string) (git.RepoStatus, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.Status(ctx, root)
}

// GitStage adds repo-root-relative paths to the index.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitStage(root string, paths []string) error {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.Stage(ctx, root, paths)
}

// GitIntentToAdd marks untracked repo-root-relative paths intent-to-add
// (git add -N): tracked as empty index blobs, content left unstaged so the
// file diffs normally and can be staged hunk-by-hunk.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitIntentToAdd(root string, paths []string) error {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.IntentToAdd(ctx, root, paths)
}

// GitUnstage removes repo-root-relative paths from the index.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitUnstage(root string, paths []string) error {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.Unstage(ctx, root, paths)
}

// GitCommit records staged changes; amend replaces the previous commit.
// Returns git's summary line for display.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitCommit(root, message string, amend bool) (string, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.Commit(ctx, root, message, amend)
}

// GitPull integrates the upstream branch. Conflict output is returned as an
// error message for the UI.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitPull(root string) (string, error) {
	ctx, cancel := a.gitCtx(gitNetworkTimeout)
	defer cancel()
	return a.gitService.Pull(ctx, root)
}

// GitPush publishes the current branch, setting an origin upstream on the
// first push of a new branch.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitPush(root string) (string, error) {
	ctx, cancel := a.gitCtx(gitNetworkTimeout)
	defer cancel()
	return a.gitService.Push(ctx, root)
}

// GitBranches lists local branch names.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitBranches(root string) ([]string, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.Branches(ctx, root)
}

// GitCheckout switches branches, creating the branch first when create is
// set. Dirty-file overwrite errors surface verbatim.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitCheckout(root, branch string, create bool) error {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.Checkout(ctx, root, branch, create)
}

// GitFileAtRev returns file content at a revision ("HEAD", ":0" for the
// index) with binary/too-large flags the diff UI special-cases. Paths new at
// that revision return empty content for diffing.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitFileAtRev(root, rev, path string) (git.FileContent, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.FileAtRev(ctx, root, rev, path)
}

// GitFileHunks returns the per-hunk breakdown of a file's diff. staged=false
// yields working-tree-vs-index hunks (stageable); staged=true yields
// index-vs-HEAD hunks (unstageable). Each hunk carries a standalone patch for
// GitApplyHunk.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitFileHunks(root, path string, staged bool) (git.FileHunks, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.FileHunks(ctx, root, path, staged)
}

// GitApplyHunk stages (reverse=false) or unstages (reverse=true) a single hunk
// by applying its patch to the index with `git apply --cached`.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitApplyHunk(root, patch string, reverse bool) error {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.ApplyPatch(ctx, root, patch, reverse)
}

// GitConflictSnapshot returns a conflicted file's content, encoding, line
// endings, and parsed conflict regions in one read, for the merge resolution
// surface. Binary or too-large files, and malformed markers, return an error so
// the frontend falls back to the plain conflict playbook.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitConflictSnapshot(root, path string) (git.ConflictSnapshot, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.ConflictSnapshot(ctx, root, path)
}

// GitMergeHeads returns the two sides (ours/theirs) and operation type of the
// in-progress merge, rebase, or cherry-pick, for the resolution card headers.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitMergeHeads(root string) (git.MergeHeads, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.MergeHeads(ctx, root)
}

// GitConflictStages reports which index stages (base/ours/theirs) exist for a
// conflicted path plus a binary flag, so the frontend can choose a text or
// whole-file-side resolution UI.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitConflictStages(root, path string) (git.ConflictStages, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.ConflictStages(ctx, root, path)
}

// GitConflictState returns one coherent read of a conflicted path — index
// stages, the text snapshot when the conflict is text-mergeable, the operation
// heads, and the opaque source version that identifies exactly that state. The
// merge surface uses it for both open and revalidation, and passes the version
// back to the guarded mutations below.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitConflictState(root, path string) (git.ConflictState, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.ConflictState(ctx, root, path)
}

// GitWriteConflictResult writes a resolved text result to the working tree only
// while the file still matches expectedSourceVersion. Applied=false means the
// file changed underneath the caller and nothing was written; the returned
// version is the live one.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitWriteConflictResult(root, path, expectedSourceVersion, content, encoding, lineEndings string) (git.ConflictGuardResult, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.WriteConflictResult(ctx, root, path, expectedSourceVersion, content, encoding, lineEndings)
}

// GitStageConflictResult stages a conflicted path's working-tree state (content
// or deletion) only while it still matches expectedSourceVersion. A failed
// stage mutates nothing, so a retry can reuse the same version.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitStageConflictResult(root, path, expectedSourceVersion string) (git.ConflictGuardResult, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.StageConflictResult(ctx, root, path, expectedSourceVersion)
}

// GitApplyConflictSide applies one whole-file side to the working tree without
// staging, only while the path still matches expectedSourceVersion. The
// returned version is what the following GitStageConflictResult must present.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitApplyConflictSide(root, path, side, expectedSourceVersion string) (git.ConflictGuardResult, error) {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.ApplyConflictSide(ctx, root, path, side, expectedSourceVersion)
}

// GitResolveConflictSide finalizes a whole-file conflict by taking one side
// ("ours" or "theirs"): the side's content is checked out and staged, or the
// path is removed and its deletion staged when that side is a deletion.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitResolveConflictSide(root, path, side string) error {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitService.ResolveConflictSide(ctx, root, path, side)
}

// GitCommitMessageAvailable reports whether embedded AI commit-message
// generation is available.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitCommitMessageAvailable() bool {
	ctx, cancel := a.gitCtx(gitLocalTimeout)
	defer cancel()
	return a.gitMsgGen.Available(ctx)
}

// GitGenerateCommitMessage produces a commit message for the staged diff via
// the embedded golem runtime.
// This is exposed to the frontend via Wails bindings.
func (a *App) GitGenerateCommitMessage(root string) (string, error) {
	ctx, cancel := a.gitCtx(gitGenerateTimeout)
	defer cancel()
	diff, err := a.gitService.StagedDiff(ctx, root)
	if err != nil {
		return "", err
	}
	return a.gitMsgGen.Generate(ctx, root, diff)
}
