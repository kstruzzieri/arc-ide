package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestService_FileHunks_StageSingleHunk is the tracer: a real `git diff` for a
// one-line modification parses into exactly one hunk, and replaying that hunk's
// patch through `git apply --cached` stages it — proving the full round-trip.
func TestService_FileHunks_StageSingleHunk(t *testing.T) {
	requireGit(t)
	dir := initRepo(t) // README.md committed as "hello\n"
	writeFile(t, dir, "README.md", "hello\nworld\n")
	svc := NewService()

	fh, err := svc.FileHunks(ctx(), dir, "README.md", false) // unstaged
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 1 {
		t.Fatalf("hunks = %d, want 1 (%+v)", len(fh.Hunks), fh.Hunks)
	}
	if !strings.Contains(fh.Hunks[0].Patch, "+world") {
		t.Errorf("hunk patch missing +world:\n%s", fh.Hunks[0].Patch)
	}

	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[0].Patch, false); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}

	st, _ := svc.Status(ctx(), dir)
	n := countWhere(st.Files, func(f FileChange) bool {
		return f.Path == "README.md" && f.Index == "M"
	})
	if n != 1 {
		t.Errorf("staged-modified README.md = %d, want 1 (files %+v)", n, st.Files)
	}
}

// TestService_FileHunks_UnstageSingleHunk drives the staged side: a staged
// change parses from `git diff --cached`, and reverse-applying its hunk unstages
// it — the index returns to HEAD while the worktree edit survives.
func TestService_FileHunks_UnstageSingleHunk(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	writeFile(t, dir, "README.md", "hello\nworld\n")
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"README.md"}); err != nil {
		t.Fatal(err)
	}

	fh, err := svc.FileHunks(ctx(), dir, "README.md", true) // staged
	if err != nil {
		t.Fatalf("FileHunks(staged) error = %v", err)
	}
	if len(fh.Hunks) != 1 {
		t.Fatalf("staged hunks = %d, want 1 (%+v)", len(fh.Hunks), fh.Hunks)
	}

	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[0].Patch, true); err != nil {
		t.Fatalf("ApplyPatch(reverse) error = %v", err)
	}

	st, _ := svc.Status(ctx(), dir)
	f := findFile(st.Files, "README.md")
	if f == nil {
		t.Fatalf("README.md missing from status %+v", st.Files)
	}
	if f.Index == "M" {
		t.Errorf("README.md still staged after unstage (index=%q)", f.Index)
	}
	if f.Worktree != "M" {
		t.Errorf("worktree edit lost: worktree=%q, want M", f.Worktree)
	}
}

// TestService_FileHunks_StageOneOfTwo is the crux: a file with two separate
// hunks, staging only the second must move that hunk into the index and leave
// the first untouched. Proves single-hunk selection applies against the live
// index and that NewStart anchors each hunk correctly.
func TestService_FileHunks_StageOneOfTwo(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	// 20 lines with edits at line 2 and line 19: two separate hunks.
	var base, edited strings.Builder
	for i := 1; i <= 20; i++ {
		fmt.Fprintf(&base, "%d\n", i)
		switch i {
		case 2:
			edited.WriteString("TWO\n")
		case 19:
			edited.WriteString("NINETEEN\n")
		default:
			fmt.Fprintf(&edited, "%d\n", i)
		}
	}
	writeFile(t, dir, "nums.txt", base.String())
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"nums.txt"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "add nums")
	writeFile(t, dir, "nums.txt", edited.String())

	fh, err := svc.FileHunks(ctx(), dir, "nums.txt", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 2 {
		t.Fatalf("hunks = %d, want 2 (%+v)", len(fh.Hunks), fh.Hunks)
	}
	// Zero-context hunks anchor exactly at their changed lines.
	if fh.Hunks[0].NewStart != 2 {
		t.Errorf("hunk[0].NewStart = %d, want 2", fh.Hunks[0].NewStart)
	}
	if fh.Hunks[1].NewStart != 19 {
		t.Errorf("hunk[1].NewStart = %d, want 19", fh.Hunks[1].NewStart)
	}

	// Stage only the second hunk (NINETEEN), not the first (TWO).
	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[1].Patch, false); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}

	index, err := svc.FileAtRev(ctx(), dir, ":0", "nums.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(base.String(), "19\n", "NINETEEN\n", 1) // only line 19 staged
	if index.Content != want {
		t.Errorf("index content = %q, want %q", index.Content, want)
	}
}

// TestService_FileHunks_NearbyEditsStayIndependent is the user-visible crux of
// zero-context hunks: two edits only four lines apart would coalesce into one
// hunk under the default 3-line context (their windows overlap), leaving one
// staging control for two visually separate changes. Each change block must be
// its own hunk, anchored at its own line, and independently stageable.
func TestService_FileHunks_NearbyEditsStayIndependent(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	var base, edited strings.Builder
	for i := 1; i <= 10; i++ {
		fmt.Fprintf(&base, "%d\n", i)
		switch i {
		case 2:
			edited.WriteString("TWO\n")
		case 6:
			edited.WriteString("SIX\n")
		default:
			fmt.Fprintf(&edited, "%d\n", i)
		}
	}
	writeFile(t, dir, "nums.txt", base.String())
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"nums.txt"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "add nums")
	writeFile(t, dir, "nums.txt", edited.String())

	fh, err := svc.FileHunks(ctx(), dir, "nums.txt", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 2 {
		t.Fatalf("hunks = %d, want 2 for edits 4 lines apart (%+v)", len(fh.Hunks), fh.Hunks)
	}
	if fh.Hunks[0].NewStart != 2 || fh.Hunks[1].NewStart != 6 {
		t.Errorf(
			"NewStarts = %d, %d, want 2 and 6 (buttons must sit on the changed lines)",
			fh.Hunks[0].NewStart, fh.Hunks[1].NewStart,
		)
	}

	// Stage only the second edit; the first stays unstaged.
	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[1].Patch, false); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
	index, err := svc.FileAtRev(ctx(), dir, ":0", "nums.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(base.String(), "6\n", "SIX\n", 1)
	if index.Content != want {
		t.Errorf("index content = %q, want only SIX staged %q", index.Content, want)
	}
}

// TestService_FileHunks_LaterInsertionStagesAtRightLine is the anchoring
// regression a pure zero-context diff cannot survive: an insertion hunk has an
// empty preimage, so `git apply` cannot offset-search and anchors blindly at
// the recorded line number. With two insertions, staging ONLY the later one
// against an index that lacks the earlier one landed the line one row off —
// silent index corruption. Context lines give git an anchor to search with.
func TestService_FileHunks_LaterInsertionStagesAtRightLine(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	var base strings.Builder
	for i := 1; i <= 10; i++ {
		fmt.Fprintf(&base, "%d\n", i)
	}
	writeFile(t, dir, "nums.txt", base.String())
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"nums.txt"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "add nums")
	// Insert A after line 1 and B after line 8.
	edited := "1\nA\n2\n3\n4\n5\n6\n7\n8\nB\n9\n10\n"
	writeFile(t, dir, "nums.txt", edited)

	fh, err := svc.FileHunks(ctx(), dir, "nums.txt", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 2 {
		t.Fatalf("hunks = %d, want 2 (%+v)", len(fh.Hunks), fh.Hunks)
	}

	// Stage ONLY the second insertion; it must land after "8", not after "9".
	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[1].Patch, false); err != nil {
		t.Fatalf("ApplyPatch(hunk B) error = %v", err)
	}
	index, err := svc.FileAtRev(ctx(), dir, ":0", "nums.txt")
	if err != nil {
		t.Fatal(err)
	}
	want := "1\n2\n3\n4\n5\n6\n7\n8\nB\n9\n10\n"
	if index.Content != want {
		t.Errorf("index content = %q, want %q (insertion misanchored)", index.Content, want)
	}
}

// TestService_FileHunks_ButtonsAnchorOnChangedLines: hunk anchors must point
// at the first CHANGED line, not the leading context line the unified diff
// includes, so the staging buttons align with the change-gutter bars.
func TestService_FileHunks_ButtonsAnchorOnChangedLines(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	var base, edited strings.Builder
	for i := 1; i <= 10; i++ {
		fmt.Fprintf(&base, "%d\n", i)
		if i == 5 {
			edited.WriteString("FIVE\n")
		} else {
			fmt.Fprintf(&edited, "%d\n", i)
		}
	}
	writeFile(t, dir, "nums.txt", base.String())
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"nums.txt"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "add nums")
	writeFile(t, dir, "nums.txt", edited.String())

	fh, err := svc.FileHunks(ctx(), dir, "nums.txt", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 1 {
		t.Fatalf("hunks = %d, want 1 (%+v)", len(fh.Hunks), fh.Hunks)
	}
	if fh.Hunks[0].NewStart != 5 || fh.Hunks[0].NewLines != 1 {
		t.Errorf(
			"anchor = start %d lines %d, want 5/1 (changed line, context excluded)",
			fh.Hunks[0].NewStart, fh.Hunks[0].NewLines,
		)
	}
}

// TestService_FileHunks_TopOfFileDeletionAnchorsAtLineOne: deleting the first
// line must yield an anchor the UI can render (>= 1); a raw zero-context diff
// reported new-start 0 and the gutter dropped the button entirely.
func TestService_FileHunks_TopOfFileDeletionAnchorsAtLineOne(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	writeFile(t, dir, "d.txt", "gone\nkeep1\nkeep2\n")
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"d.txt"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "add d")
	writeFile(t, dir, "d.txt", "keep1\nkeep2\n")

	fh, err := svc.FileHunks(ctx(), dir, "d.txt", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 1 {
		t.Fatalf("hunks = %d, want 1 (%+v)", len(fh.Hunks), fh.Hunks)
	}
	if fh.Hunks[0].NewStart < 1 {
		t.Errorf("NewStart = %d, want >= 1 so the gutter can anchor it", fh.Hunks[0].NewStart)
	}
	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[0].Patch, false); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
	index, _ := svc.FileAtRev(ctx(), dir, ":0", "d.txt")
	if index.Content != "keep1\nkeep2\n" {
		t.Errorf("index content = %q, want top deletion staged", index.Content)
	}
}

// TestService_FileHunks_ConflictedFileHasNoHunks: an unmerged file produces a
// combined diff (diff --cc, @@@ headers) whose hunks are not applyable
// patches; the conflict banner owns that state, so no per-hunk controls.
func TestService_FileHunks_ConflictedFileHasNoHunks(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	writeFile(t, dir, "c.txt", "base\n")
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"c.txt"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "side")
	writeFile(t, dir, "c.txt", "side\n")
	gitCmd(t, dir, "commit", "-am", "side")
	gitCmd(t, dir, "checkout", "-")
	writeFile(t, dir, "c.txt", "main\n")
	gitCmd(t, dir, "commit", "-am", "main")
	// Merge conflicts; git merge exits non-zero, which gitCmd would fail on.
	cmd := exec.Command("git", "-C", dir, "merge", "side")
	cmd.Env = scrubGitEnv(os.Environ())
	_ = cmd.Run()

	fh, err := svc.FileHunks(ctx(), dir, "c.txt", false)
	if err != nil {
		t.Fatalf("FileHunks(conflicted) error = %v", err)
	}
	if len(fh.Hunks) != 0 {
		t.Errorf("hunks = %d, want 0 for an unmerged file (%+v)", len(fh.Hunks), fh.Hunks)
	}
}

// TestService_FileHunks_DeletionHunk covers a hunk that only removes lines
// (new-side count 0): it must parse, anchor at the surviving line, and stage.
func TestService_FileHunks_DeletionHunk(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	writeFile(t, dir, "d.txt", "keep1\ndrop\nkeep2\n")
	svc := NewService()
	if err := svc.Stage(ctx(), dir, []string{"d.txt"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "add d")
	writeFile(t, dir, "d.txt", "keep1\nkeep2\n") // drop the middle line

	fh, err := svc.FileHunks(ctx(), dir, "d.txt", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 1 {
		t.Fatalf("hunks = %d, want 1 (%+v)", len(fh.Hunks), fh.Hunks)
	}
	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[0].Patch, false); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
	index, _ := svc.FileAtRev(ctx(), dir, ":0", "d.txt")
	if index.Content != "keep1\nkeep2\n" {
		t.Errorf("index content = %q, want deletion staged", index.Content)
	}
}

// TestService_FileHunks_BinaryHasNoHunks: a binary change yields no hunks
// (the diff view already renders a binary state) rather than crashing.
func TestService_FileHunks_BinaryHasNoHunks(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "b.bin"), []byte{0, 1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", "b.bin")
	gitCmd(t, dir, "commit", "-m", "add bin")
	if err := os.WriteFile(filepath.Join(dir, "b.bin"), []byte{0, 9, 9, 9}, 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewService()

	fh, err := svc.FileHunks(ctx(), dir, "b.bin", false)
	if err != nil {
		t.Fatalf("FileHunks(binary) error = %v", err)
	}
	if len(fh.Hunks) != 0 {
		t.Errorf("hunks = %d, want 0 for a binary change", len(fh.Hunks))
	}
}

// TestService_FileHunks_NoChangesEmpty: a clean file has no hunks and never
// returns a nil slice (stable JSON for the bindings).
func TestService_FileHunks_NoChangesEmpty(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	svc := NewService()

	fh, err := svc.FileHunks(ctx(), dir, "README.md", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if fh.Hunks == nil || len(fh.Hunks) != 0 {
		t.Errorf("Hunks = %#v, want empty non-nil slice", fh.Hunks)
	}
}

func TestService_FileHunks_PinsApplyableDiffOutput(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	svc := NewService()
	writeFile(t, dir, "README.md", "1\n2\n3\n4\n5\n")
	if err := svc.Stage(ctx(), dir, []string{"README.md"}); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "commit", "-m", "expand readme")
	gitCmd(t, dir, "config", "diff.context", "10")
	gitCmd(t, dir, "config", "diff.noprefix", "true")
	writeFile(t, dir, "README.md", "1\n2\nTHREE\n4\n5\n")

	fh, err := svc.FileHunks(ctx(), dir, "README.md", false)
	if err != nil {
		t.Fatalf("FileHunks() error = %v", err)
	}
	if len(fh.Hunks) != 1 {
		t.Fatalf("hunks = %d, want 1 (%+v)", len(fh.Hunks), fh.Hunks)
	}
	if !strings.Contains(fh.Hunks[0].Patch, "diff --git a/README.md b/README.md") {
		t.Fatalf("patch did not keep default prefixes:\n%s", fh.Hunks[0].Patch)
	}
	if !strings.Contains(fh.Hunks[0].Patch, "@@ -2,3 +2,3 @@") {
		t.Fatalf("patch did not override diff.context config with one-line context:\n%s", fh.Hunks[0].Patch)
	}
	if err := svc.ApplyPatch(ctx(), dir, fh.Hunks[0].Patch, false); err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
}

// TestService_ApplyPatch_RejectsNonPatch guards the bindings boundary: junk
// never reaches `git apply`.
func TestService_ApplyPatch_RejectsNonPatch(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	svc := NewService()

	if err := svc.ApplyPatch(ctx(), dir, "rm -rf /\n", false); err == nil {
		t.Error("ApplyPatch() accepted non-patch input, want rejection")
	}
}

// TestService_FileHunks_RejectsTraversalPath: path validation matches the rest
// of the service — no absolute or escaping paths reach a git argv.
func TestService_FileHunks_RejectsTraversalPath(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	svc := NewService()

	if _, err := svc.FileHunks(ctx(), dir, "../escape.txt", false); err == nil {
		t.Error("FileHunks() accepted traversal path, want rejection")
	}
}

func findFile(files []FileChange, path string) *FileChange {
	for i := range files {
		if files[i].Path == path {
			return &files[i]
		}
	}
	return nil
}
