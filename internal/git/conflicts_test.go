package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// parseConflictRegions is the pure core: given decoded file text, it returns
// the conflict regions or an error for malformed markers. No git, no disk.

func TestParseConflictRegions_TwoWayMergeStyle(t *testing.T) {
	content := "" +
		"line before\n" +
		"<<<<<<< HEAD\n" +
		"ours a\n" +
		"ours b\n" +
		"=======\n" +
		"theirs a\n" +
		">>>>>>> feature\n" +
		"line after\n"

	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("parseConflictRegions error = %v", err)
	}
	want := []ConflictRegion{{
		Index:      0,
		StartLine:  2,
		EndLine:    7,
		Ours:       []string{"ours a", "ours b"},
		Base:       []string{},
		Theirs:     []string{"theirs a"},
		HasBase:    false,
		OursLabel:  "HEAD",
		TheirLabel: "feature",
	}}
	if !reflect.DeepEqual(regions, want) {
		t.Errorf("regions =\n%+v\nwant\n%+v", regions, want)
	}
}

func TestParseConflictRegions_Diff3StyleHasBase(t *testing.T) {
	content := "" +
		"<<<<<<< HEAD\n" +
		"ours\n" +
		"||||||| merged common ancestors\n" +
		"base line\n" +
		"=======\n" +
		"theirs\n" +
		">>>>>>> other\n"

	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("parseConflictRegions error = %v", err)
	}
	if len(regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(regions))
	}
	r := regions[0]
	if !r.HasBase {
		t.Errorf("HasBase = false, want true")
	}
	if !reflect.DeepEqual(r.Base, []string{"base line"}) {
		t.Errorf("Base = %v, want [base line]", r.Base)
	}
	if !reflect.DeepEqual(r.Ours, []string{"ours"}) || !reflect.DeepEqual(r.Theirs, []string{"theirs"}) {
		t.Errorf("Ours/Theirs = %v / %v", r.Ours, r.Theirs)
	}
}

func TestParseConflictRegions_MultipleRegionsIndexed(t *testing.T) {
	content := "" +
		"a\n" +
		"<<<<<<< HEAD\n" +
		"o1\n" +
		"=======\n" +
		"t1\n" +
		">>>>>>> b\n" +
		"middle\n" +
		"<<<<<<< HEAD\n" +
		"o2\n" +
		"=======\n" +
		"t2\n" +
		">>>>>>> b\n"

	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("parseConflictRegions error = %v", err)
	}
	if len(regions) != 2 {
		t.Fatalf("regions = %d, want 2", len(regions))
	}
	if regions[0].Index != 0 || regions[1].Index != 1 {
		t.Errorf("indices = %d,%d want 0,1", regions[0].Index, regions[1].Index)
	}
	if regions[0].StartLine != 2 || regions[1].StartLine != 8 {
		t.Errorf("start lines = %d,%d want 2,8", regions[0].StartLine, regions[1].StartLine)
	}
}

func TestParseConflictRegions_EmptySideKeepsEmptySlice(t *testing.T) {
	// Incoming side deletes everything: theirs is empty (a real delete/modify
	// within a marker block). Must be an empty non-nil slice, never nil.
	content := "" +
		"<<<<<<< HEAD\n" +
		"kept\n" +
		"=======\n" +
		">>>>>>> b\n"

	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("parseConflictRegions error = %v", err)
	}
	if got := regions[0].Theirs; got == nil || len(got) != 0 {
		t.Errorf("Theirs = %#v, want empty non-nil slice", got)
	}
}

func TestParseConflictRegions_NoMarkersReturnsEmpty(t *testing.T) {
	regions, err := parseConflictRegions("just\nplain\ntext\n", defaultMarkerSize)
	if err != nil {
		t.Fatalf("parseConflictRegions error = %v", err)
	}
	if len(regions) != 0 {
		t.Errorf("regions = %d, want 0", len(regions))
	}
}

func TestParseConflictRegions_UnterminatedIsError(t *testing.T) {
	content := "<<<<<<< HEAD\nours\n=======\ntheirs\n" // no >>>>>>>
	if _, err := parseConflictRegions(content, defaultMarkerSize); err == nil {
		t.Fatal("parseConflictRegions(unterminated) error = nil, want error")
	}
}

func TestParseConflictRegions_NestedStartIsError(t *testing.T) {
	content := "<<<<<<< HEAD\nours\n<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> b\n"
	if _, err := parseConflictRegions(content, defaultMarkerSize); err == nil {
		t.Fatal("parseConflictRegions(nested) error = nil, want error")
	}
}

func TestParseConflictRegions_SeparatorWithoutOpeningIsContent(t *testing.T) {
	// A ======= with no preceding <<<<<<< opening is ordinary content (e.g. a
	// Markdown heading underline), not a conflict and not an error.
	content := "plain\n=======\nmore\n"
	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("parseConflictRegions(no opening) error = %v, want nil", err)
	}
	if len(regions) != 0 {
		t.Errorf("regions = %d, want 0", len(regions))
	}
}

// ── ConflictSnapshot integration (real git) ──

// makeConflict builds a repo whose file `f.txt` has a real merge conflict on
// the given side content, and returns the repo dir. diff3 controls conflict
// style. base/ours/theirs are file bodies.
func makeConflict(t *testing.T, base, ours, theirs string, diff3 bool) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	if diff3 {
		gitCmd(t, dir, "config", "merge.conflictStyle", "diff3")
	}
	writeFile(t, dir, "f.txt", base)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", theirs)
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", ours)
	gitCmd(t, dir, "commit", "-am", "ours")
	// merge conflicts; git exits non-zero, which gitCmd would fail on.
	mergeConflict(t, dir, "feature")
	return dir
}

// mergeConflict runs `git merge <ref>` tolerating the expected non-zero exit.
func mergeConflict(t *testing.T, dir, ref string) {
	t.Helper()
	cmd := exec.Command("git", "-C", dir, "merge", ref)
	cmd.Env = append(scrubGitEnv(os.Environ()),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	_ = cmd.Run()
}

func TestService_ConflictSnapshot_ParsesWorkingTreeMarkers(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot error = %v", err)
	}
	if len(snap.Regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(snap.Regions))
	}
	if !strings.Contains(snap.Content, "<<<<<<<") || !strings.Contains(snap.Content, ">>>>>>>") {
		t.Errorf("Content missing markers:\n%s", snap.Content)
	}
	r := snap.Regions[0]
	if !reflect.DeepEqual(r.Ours, []string{"ours"}) || !reflect.DeepEqual(r.Theirs, []string{"theirs"}) {
		t.Errorf("Ours/Theirs = %v / %v", r.Ours, r.Theirs)
	}
}

func TestService_ConflictSnapshot_Diff3CapturesBase(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", true)

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot error = %v", err)
	}
	if len(snap.Regions) != 1 || !snap.Regions[0].HasBase {
		t.Fatalf("want 1 region with base, got %+v", snap.Regions)
	}
	if !reflect.DeepEqual(snap.Regions[0].Base, []string{"base"}) {
		t.Errorf("Base = %v, want [base]", snap.Regions[0].Base)
	}
}

func TestService_ConflictSnapshot_AddAddWithoutBase(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	gitCmd(t, dir, "commit", "--allow-empty", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "theirs\n")
	gitCmd(t, dir, "add", "f.txt")
	gitCmd(t, dir, "commit", "-m", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "ours\n")
	gitCmd(t, dir, "add", "f.txt")
	gitCmd(t, dir, "commit", "-m", "ours")
	mergeConflict(t, dir, "feature")

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot(add/add) error = %v", err)
	}
	if len(snap.Regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(snap.Regions))
	}
	region := snap.Regions[0]
	if region.BaseEndsWithNewline != nil {
		t.Errorf("BaseEndsWithNewline = %v, want nil for an absent stage", *region.BaseEndsWithNewline)
	}
	if region.OursEndsWithNewline == nil || !*region.OursEndsWithNewline ||
		region.TheirsEndsWithNewline == nil || !*region.TheirsEndsWithNewline {
		t.Errorf("EOF ours/theirs = %v/%v, want true/true",
			region.OursEndsWithNewline, region.TheirsEndsWithNewline)
	}
}

func TestService_ConflictSnapshot_EmptyBaseBlobIsPresent(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "", "ours", "theirs", false)

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot(empty base) error = %v", err)
	}
	base := snap.Regions[0].BaseEndsWithNewline
	if base == nil {
		t.Fatal("BaseEndsWithNewline = nil, want present false")
	}
	if *base {
		t.Error("BaseEndsWithNewline = true, want false for a present empty blob")
	}
}

func TestService_ConflictSnapshot_MarkerShapedContentOutsideRegionAllowed(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t,
		"Title\n=======\nbase\n",
		"Title\n=======\nours\n",
		"Title\n=======\ntheirs\n",
		false,
	)

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot(marker content outside region) error = %v", err)
	}
	if len(snap.Regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(snap.Regions))
	}
}

func TestService_ConflictSnapshot_ReportsLineEndings(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "l1\r\nl2\r\n", "l1\r\nours\r\n", "l1\r\ntheirs\r\n", false)

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot error = %v", err)
	}
	if snap.LineEndings != "crlf" {
		t.Errorf("LineEndings = %q, want crlf", snap.LineEndings)
	}
}

func TestService_ConflictSnapshot_BinaryIsError(t *testing.T) {
	requireGit(t)
	// NUL bytes on both sides -> a binary conflicted file.
	dir := makeConflict(t, "base\x00\n", "ours\x00\n", "theirs\x00\n", false)

	_, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err == nil {
		t.Fatal("ConflictSnapshot(binary) error = nil, want error")
	}
}

func TestService_ConflictSnapshot_NestedWorkspaceDirResolvesPath(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "sub/f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "sub/f.txt", "theirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "sub/f.txt", "ours\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	// dir points at the nested workspace subdir; path is repo-root-relative.
	sub := filepath.Join(dir, "sub")
	snap, err := NewService().ConflictSnapshot(ctx(), sub, "sub/f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot error = %v", err)
	}
	if len(snap.Regions) != 1 {
		t.Errorf("regions = %d, want 1 (path must resolve from repo root)", len(snap.Regions))
	}
}

func TestService_ConflictSnapshot_OverLimitIsError(t *testing.T) {
	requireGit(t)
	big := strings.Repeat("x\n", (maxDiffableBytes/2)+1024) // > 1MB per side
	dir := makeConflict(t, "base\n", big+"ours\n", big+"theirs\n", false)

	_, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err == nil {
		t.Fatal("ConflictSnapshot(over-limit) error = nil, want error")
	}
}

// ── MergeHeads integration ──

// gitAllow runs git tolerating a non-zero exit (for rebase/cherry-pick that
// stop on conflict), returning combined output.
func gitAllow(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(scrubGitEnv(os.Environ()),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	_ = cmd.Run()
}

func TestService_MergeHeads_Merge(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)

	mh, err := NewService().MergeHeads(ctx(), dir)
	if err != nil {
		t.Fatalf("MergeHeads error = %v", err)
	}
	if mh.Operation != "merge" {
		t.Errorf("Operation = %q, want merge", mh.Operation)
	}
	if mh.Ours.Subject != "ours" || mh.Theirs.Subject != "theirs" {
		t.Errorf("subjects = %q / %q, want ours / theirs", mh.Ours.Subject, mh.Theirs.Subject)
	}
	if mh.Ours.Hash == "" || mh.Theirs.Hash == "" {
		t.Errorf("hashes empty: %+v", mh)
	}
}

func TestService_MergeHeads_Rebase(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "feature\n")
	gitCmd(t, dir, "commit", "-am", "feature work")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "mainline\n")
	gitCmd(t, dir, "commit", "-am", "main work")
	gitCmd(t, dir, "checkout", "feature")
	gitAllow(t, dir, "rebase", "main") // conflicts, stops

	mh, err := NewService().MergeHeads(ctx(), dir)
	if err != nil {
		t.Fatalf("MergeHeads error = %v", err)
	}
	if mh.Operation != "rebase" {
		t.Errorf("Operation = %q, want rebase", mh.Operation)
	}
	if mh.Theirs.Hash == "" {
		t.Errorf("theirs hash empty during rebase: %+v", mh)
	}
	if mh.Theirs.Subject != "feature work" {
		t.Errorf("Theirs.Subject = %q, want feature work (replayed commit)", mh.Theirs.Subject)
	}
}

func TestService_MergeHeads_CherryPick(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "feature\n")
	gitCmd(t, dir, "commit", "-am", "feature edit")
	pick := strings.TrimSpace(gitCmd(t, dir, "rev-parse", "HEAD"))
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "mainline\n")
	gitCmd(t, dir, "commit", "-am", "main edit")
	gitAllow(t, dir, "cherry-pick", pick) // conflicts

	mh, err := NewService().MergeHeads(ctx(), dir)
	if err != nil {
		t.Fatalf("MergeHeads error = %v", err)
	}
	if mh.Operation != "cherry-pick" {
		t.Errorf("Operation = %q, want cherry-pick", mh.Operation)
	}
	if mh.Theirs.Subject != "feature edit" {
		t.Errorf("Theirs.Subject = %q, want feature edit", mh.Theirs.Subject)
	}
}

func TestService_MergeHeads_NoOperationIsError(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	if _, err := NewService().MergeHeads(ctx(), dir); err == nil {
		t.Fatal("MergeHeads(clean repo) error = nil, want error")
	}
}

// ── ConflictStages + rev whitelist ──

func TestService_ConflictStages_ModifyModifyAllPresent(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)

	st, err := NewService().ConflictStages(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictStages error = %v", err)
	}
	if st.Base == nil || st.Ours == nil || st.Theirs == nil {
		t.Errorf("want all stages present, got base=%v ours=%v theirs=%v", st.Base, st.Ours, st.Theirs)
	}
	if st.Binary {
		t.Errorf("Binary = true, want false for text conflict")
	}
}

func TestService_ConflictStages_DeleteModifyMissingOurs(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "theirs modified")
	gitCmd(t, dir, "commit", "-am", "modify on feature")
	gitCmd(t, dir, "checkout", "main")
	gitCmd(t, dir, "rm", "f.txt")
	gitCmd(t, dir, "commit", "-m", "delete on main")
	mergeConflict(t, dir, "feature")

	st, err := NewService().ConflictStages(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictStages error = %v", err)
	}
	if st.Ours != nil {
		t.Errorf("Ours = %v, want nil (we deleted it)", st.Ours)
	}
	if st.Base == nil || st.Theirs == nil {
		t.Errorf("want base+theirs present, got base=%v theirs=%v", st.Base, st.Theirs)
	}
}

func TestService_ConflictStages_BinaryFlag(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "b\x00ase\n", "o\x00urs\n", "t\x00heirs\n", false)

	st, err := NewService().ConflictStages(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictStages error = %v", err)
	}
	if !st.Binary {
		t.Errorf("Binary = false, want true for binary conflict")
	}
}

func TestService_ConflictStages_BinaryMergeAttribute(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, ".gitattributes", "f.txt -merge\n")
	writeFile(t, dir, "f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "theirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "ours\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	stages, err := NewService().ConflictStages(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictStages error = %v", err)
	}
	if !stages.Binary {
		t.Error("Binary = false, want true for -merge attribute")
	}
	if _, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictSnapshot(-merge) error = nil, want binary refusal")
	}
}

func TestService_FileAtRev_StageRevsAllowed(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	svc := NewService()

	ours, err := svc.FileAtRev(ctx(), dir, ":2", "f.txt")
	if err != nil {
		t.Fatalf("FileAtRev(:2) error = %v", err)
	}
	if ours.Content != "ours\n" {
		t.Errorf("stage 2 content = %q, want ours", ours.Content)
	}
	theirs, err := svc.FileAtRev(ctx(), dir, ":3", "f.txt")
	if err != nil {
		t.Fatalf("FileAtRev(:3) error = %v", err)
	}
	if theirs.Content != "theirs\n" {
		t.Errorf("stage 3 content = %q, want theirs", theirs.Content)
	}
}

// ── ResolveConflictSide finalize ──

// isUnmerged reports whether path still has conflict stages in the index.
func isUnmerged(t *testing.T, dir, path string) bool {
	t.Helper()
	out := gitCmd(t, dir, "ls-files", "-u", "--", path)
	return strings.TrimSpace(out) != ""
}

func TestService_ResolveConflictSide_BinaryTakeOurs(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "b\x00ase\n", "o\x00urs\n", "t\x00heirs\n", false)

	if err := NewService().ResolveConflictSide(ctx(), dir, "f.txt", "ours"); err != nil {
		t.Fatalf("ResolveConflictSide(ours) error = %v", err)
	}
	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged after resolve")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "o\x00urs\n" {
		t.Errorf("worktree content = %q, want ours", got)
	}
}

func TestService_ResolveConflictSide_BinaryTakeTheirs(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "b\x00ase\n", "o\x00urs\n", "t\x00heirs\n", false)

	if err := NewService().ResolveConflictSide(ctx(), dir, "f.txt", "theirs"); err != nil {
		t.Fatalf("ResolveConflictSide(theirs) error = %v", err)
	}
	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged after resolve")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "t\x00heirs\n" {
		t.Errorf("worktree content = %q, want theirs", got)
	}
}

// deleteModifyRepo: ours (main) deletes f.txt, theirs (feature) modifies it.
func deleteModifyRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "theirs modified")
	gitCmd(t, dir, "commit", "-am", "modify on feature")
	gitCmd(t, dir, "checkout", "main")
	gitCmd(t, dir, "rm", "f.txt")
	gitCmd(t, dir, "commit", "-m", "delete on main")
	mergeConflict(t, dir, "feature")
	return dir
}

func TestService_ResolveConflictSide_DeleteModifyTakeDeletion(t *testing.T) {
	requireGit(t)
	dir := deleteModifyRepo(t) // ours = deletion (stage 2 absent)

	if err := NewService().ResolveConflictSide(ctx(), dir, "f.txt", "ours"); err != nil {
		t.Fatalf("ResolveConflictSide(ours=deletion) error = %v", err)
	}
	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged after resolve")
	}
	if _, err := os.Stat(filepath.Join(dir, "f.txt")); !os.IsNotExist(err) {
		t.Error("f.txt should be deleted from worktree")
	}
	// Resolved to the deletion: no index entry for f.txt at all. (Since ours
	// already deleted it at HEAD, there is no "D" against HEAD to show — the
	// point is the path is gone from both index and worktree, and unmerged.)
	if tracked := strings.TrimSpace(gitCmd(t, dir, "ls-files", "--", "f.txt")); tracked != "" {
		t.Errorf("f.txt still in index = %q, want absent", tracked)
	}
}

func TestService_ResolveConflictSide_DeleteModifyTakeTheirs(t *testing.T) {
	requireGit(t)
	dir := deleteModifyRepo(t)

	if err := NewService().ResolveConflictSide(ctx(), dir, "f.txt", "theirs"); err != nil {
		t.Fatalf("ResolveConflictSide(theirs) error = %v", err)
	}
	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged after resolve")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "theirs modified" {
		t.Errorf("worktree content = %q, want theirs", got)
	}
	if staged := gitCmd(t, dir, "show", ":0:f.txt"); staged != "theirs modified" {
		t.Errorf("staged content = %q, want theirs without a trailing newline", staged)
	}
}

func TestService_ResolveConflictSide_InvalidSideIsError(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	if err := NewService().ResolveConflictSide(ctx(), dir, "f.txt", "sideways"); err == nil {
		t.Fatal("ResolveConflictSide(bad side) error = nil, want error")
	}
}

func TestParseConflictRegions_ExactMarkerSize(t *testing.T) {
	// A conflict written with an 8-char conflict-marker-size parses when the
	// exact width is supplied, and a content line that is a longer divider of
	// the same character is NOT mistaken for a marker.
	content := "" +
		"<<<<<<<< HEAD\n" +
		"ours\n" +
		"================ (a real divider in ours)\n" +
		"========\n" +
		"theirs\n" +
		">>>>>>>> feature\n"
	regions, err := parseConflictRegions(content, 8)
	if err != nil {
		t.Fatalf("parseConflictRegions(size 8) error = %v", err)
	}
	if len(regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(regions))
	}
	if !reflect.DeepEqual(regions[0].Ours, []string{"ours", "================ (a real divider in ours)"}) {
		t.Errorf("Ours = %v, want the divider kept as content", regions[0].Ours)
	}
	if regions[0].OursLabel != "HEAD" || regions[0].TheirLabel != "feature" {
		t.Errorf("labels = %q / %q", regions[0].OursLabel, regions[0].TheirLabel)
	}
}

// ── review-round hardening ──

func TestService_ResolveConflictSide_NotConflictedIsErrorNoDelete(t *testing.T) {
	requireGit(t)
	dir := initRepo(t) // README.md committed, clean, NOT conflicted

	err := NewService().ResolveConflictSide(ctx(), dir, "README.md", "ours")
	if err == nil {
		t.Fatal("ResolveConflictSide(clean file) error = nil, want refusal")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "README.md")); statErr != nil {
		t.Errorf("README.md must not be deleted for a non-conflicted path: %v", statErr)
	}
}

func TestService_ConflictStages_UnconflictedAllNil(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)

	st, err := NewService().ConflictStages(ctx(), dir, "README.md")
	if err != nil {
		t.Fatalf("ConflictStages(clean) error = %v", err)
	}
	if st.Base != nil || st.Ours != nil || st.Theirs != nil {
		t.Errorf("stages = %+v, want all nil for unconflicted path", st)
	}
}

func TestService_ConflictStages_BinaryOnOneSideOnly(t *testing.T) {
	requireGit(t)
	// ours text, theirs binary: git must classify the file binary even though
	// the first present stage probed (ours) is text.
	dir := makeConflict(t, "base\n", "ours text\n", "theirs\x00binary\n", false)

	st, err := NewService().ConflictStages(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictStages error = %v", err)
	}
	if !st.Binary {
		t.Errorf("Binary = false, want true when any stage is binary")
	}
}

func TestService_ConflictStages_SizeMatchesBlob(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)

	st, err := NewService().ConflictStages(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictStages error = %v", err)
	}
	if st.Ours == nil || st.Ours.Size != int64(len("ours\n")) {
		t.Errorf("Ours.Size = %v, want %d", st.Ours, len("ours\n"))
	}
}

func TestService_ConflictSnapshot_LineCoordinatesAndEncoding(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "top\nbase\n", "top\nours\n", "top\ntheirs\n", false)

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot error = %v", err)
	}
	if snap.Encoding != "utf-8" {
		t.Errorf("Encoding = %q, want utf-8", snap.Encoding)
	}
	r := snap.Regions[0]
	// Region markers must map to the real lines in the returned content.
	lines := strings.Split(snap.Content, "\n")
	if r.StartLine < 1 || r.StartLine > len(lines) || !strings.HasPrefix(lines[r.StartLine-1], "<<<<<<<") {
		t.Errorf("StartLine %d does not point at a <<<<<<< line", r.StartLine)
	}
	if r.EndLine < 1 || r.EndLine > len(lines) || !strings.HasPrefix(lines[r.EndLine-1], ">>>>>>>") {
		t.Errorf("EndLine %d does not point at a >>>>>>> line", r.EndLine)
	}
}

func TestService_MergeHeads_OursLabelIsBranch(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)

	mh, err := NewService().MergeHeads(ctx(), dir)
	if err != nil {
		t.Fatalf("MergeHeads error = %v", err)
	}
	if mh.Ours.Label != "main" {
		t.Errorf("Ours.Label = %q, want main (branch name)", mh.Ours.Label)
	}
	if mh.Theirs.Subject != "theirs" {
		t.Errorf("Theirs.Subject = %q, want theirs", mh.Theirs.Subject)
	}
}

func TestService_ConflictSnapshot_SymlinkIsError(t *testing.T) {
	requireGit(t)
	dir := initRepo(t)
	// Point a tracked path at a file outside the repo via symlink.
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.txt")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if _, err := NewService().ConflictSnapshot(ctx(), dir, "link.txt"); err == nil {
		t.Fatal("ConflictSnapshot(symlink) error = nil, want refusal")
	}
}

// makeConflictNamed builds a merge conflict on an arbitrarily named binary file.
func makeConflictNamed(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, name, "b\x00ase\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, name, "t\x00heirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, name, "o\x00urs\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")
	return dir
}

func TestService_ResolveConflictSide_LiteralPathspecName(t *testing.T) {
	requireGit(t)
	// "f[x].txt" contains pathspec metacharacters; without --literal-pathspecs
	// git treats "[x]" as a character class and never matches this literal
	// filename, so the resolve would silently no-op and leave it unmerged.
	name := "f[x].txt"
	dir := makeConflictNamed(t, name)

	if err := NewService().ResolveConflictSide(ctx(), dir, name, "ours"); err != nil {
		t.Fatalf("ResolveConflictSide(%q) error = %v", name, err)
	}
	if isUnmerged(t, dir, name) {
		t.Errorf("%q still unmerged; pathspec metacharacters not treated literally", name)
	}
	got, _ := os.ReadFile(filepath.Join(dir, name))
	if string(got) != "o\x00urs\n" {
		t.Errorf("content = %q, want ours", got)
	}
}

// ── review round 2: directory pathspec + ancestor symlink containment ──

func TestService_ConflictStages_DirectoryPathIsAllNil(t *testing.T) {
	requireGit(t)
	// Real conflict in a subdir; querying a DIRECTORY ("sub" or ".") must not
	// aggregate the child's stages — otherwise ResolveConflictSide could act on
	// a directory pathspec and touch unrelated files.
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "sub/f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "sub/f.txt", "theirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "sub/f.txt", "ours\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	st, err := NewService().ConflictStages(ctx(), dir, "sub")
	if err != nil {
		t.Fatalf("ConflictStages(dir) error = %v", err)
	}
	if st.Base != nil || st.Ours != nil || st.Theirs != nil {
		t.Errorf("stages = %+v, want all nil for a directory path", st)
	}
}

func TestService_ResolveConflictSide_DirectoryPathRefused(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "sub/f.txt", "base\n")
	writeFile(t, dir, "bystander.txt", "keep me\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "sub/f.txt", "theirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "sub/f.txt", "ours\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	if err := NewService().ResolveConflictSide(ctx(), dir, ".", "ours"); err == nil {
		t.Fatal("ResolveConflictSide(directory) error = nil, want refusal")
	}
	if _, err := os.Stat(filepath.Join(dir, "bystander.txt")); err != nil {
		t.Errorf("bystander.txt must survive a directory-path resolve: %v", err)
	}
}

func TestService_ConflictSnapshot_AncestorSymlinkEscapeIsError(t *testing.T) {
	requireGit(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := initRepo(t)
	// An in-repo directory symlink pointing outside; a path through it would
	// escape the repository if only the final component is checked.
	if err := os.Symlink(outside, filepath.Join(dir, "out")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if _, err := NewService().ConflictSnapshot(ctx(), dir, "out/secret.txt"); err == nil {
		t.Fatal("ConflictSnapshot(ancestor symlink escape) error = nil, want refusal")
	}
}

func TestService_ConflictSnapshot_HonorsConflictMarkerSizeAttr(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	// Widen markers for f.txt to 9 chars via gitattributes.
	writeFile(t, dir, ".gitattributes", "f.txt conflict-marker-size=9\n")
	writeFile(t, dir, "f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "theirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "ours\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictSnapshot error = %v", err)
	}
	if len(snap.Regions) != 1 {
		t.Fatalf("regions = %d, want 1 (must detect 9-char markers from gitattributes)", len(snap.Regions))
	}
	if !strings.Contains(snap.Content, "<<<<<<<<<") {
		t.Errorf("expected 9-char markers in content:\n%s", snap.Content)
	}
}

func TestService_ResolveConflictSide_PathWithSpace(t *testing.T) {
	requireGit(t)
	// -z output is verbatim (no core.quotePath quoting), so a filename with a
	// space must still match exactly through ConflictStages/ResolveConflictSide.
	name := "a file.txt"
	dir := makeConflictNamed(t, name)
	if err := NewService().ResolveConflictSide(ctx(), dir, name, "ours"); err != nil {
		t.Fatalf("ResolveConflictSide(%q) error = %v", name, err)
	}
	if isUnmerged(t, dir, name) {
		t.Errorf("%q still unmerged", name)
	}
}

func TestParseConflictRegions_RenameWidensOuterMarkerByOne(t *testing.T) {
	// Rename/add and rename/rename conflicts get outer markers one char wider
	// than the base conflict-marker-size (git bumps them to nest inner content).
	// With base size 7 the real markers are 8 chars and must still parse.
	content := "" +
		"<<<<<<<< HEAD\n" +
		"ours\n" +
		"========\n" +
		"theirs\n" +
		">>>>>>>> feature\n"
	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("parseConflictRegions(rename +1 markers) error = %v", err)
	}
	if len(regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(regions))
	}
	if regions[0].OursLabel != "HEAD" || regions[0].TheirLabel != "feature" {
		t.Errorf("labels = %q / %q", regions[0].OursLabel, regions[0].TheirLabel)
	}
}

func TestParseConflictRegions_RegionWidthLocked(t *testing.T) {
	// A region opened at width 8 must require its closing markers at width 8;
	// a 7-char line inside is content, not a separator.
	content := "" +
		"<<<<<<<< HEAD\n" +
		"=======\n" + // 7 chars: content within an 8-wide region
		"========\n" + // 8 chars: the real separator
		"theirs\n" +
		">>>>>>>> feature\n"
	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	if len(regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(regions))
	}
	if !reflect.DeepEqual(regions[0].Ours, []string{"======="}) {
		t.Errorf("Ours = %v, want the 7-char line kept as content", regions[0].Ours)
	}
}

func TestParseConflictRegions_MarkerShapedContentOutsideIsNotError(t *testing.T) {
	// A conflicted file can legitimately contain a Markdown setext heading
	// underline (7+ '=') outside any conflict; it is content, and the real
	// conflict below it must still parse (not be lost to a stray-marker error).
	content := "" +
		"Title\n" +
		"=======\n" +
		"intro\n" +
		"<<<<<<< HEAD\n" +
		"ours\n" +
		"=======\n" +
		"theirs\n" +
		">>>>>>> feature\n"
	regions, err := parseConflictRegions(content, defaultMarkerSize)
	if err != nil {
		t.Fatalf("error = %v (heading '=======' outside a conflict must be content)", err)
	}
	if len(regions) != 1 {
		t.Fatalf("regions = %d, want 1", len(regions))
	}
	if !reflect.DeepEqual(regions[0].Ours, []string{"ours"}) {
		t.Errorf("Ours = %v, want [ours]", regions[0].Ours)
	}
}

func TestParseConflictRegions_PrematureCloseInOursIsError(t *testing.T) {
	// A width-w closing marker inside the ours section (no separator seen) is
	// malformed: git never emits it, so reject to fallback rather than silently
	// swallow it as content.
	content := "<<<<<<< HEAD\nours\n>>>>>>> feature\n"
	if _, err := parseConflictRegions(content, defaultMarkerSize); err == nil {
		t.Fatal("premature close in ours: error = nil, want error")
	}
}

func TestParseConflictRegions_StrayMarkerInTheirsIsError(t *testing.T) {
	content := "<<<<<<< HEAD\nours\n=======\ntheirs\n<<<<<<< again\n>>>>>>> feature\n"
	if _, err := parseConflictRegions(content, defaultMarkerSize); err == nil {
		t.Fatal("stray opening in theirs: error = nil, want error")
	}
}

func TestParseConflictRegions_AmbiguousWidthsRejected(t *testing.T) {
	// A width-8 (rename) conflict whose content contains a COMPLETE width-7
	// conflict sample parses cleanly at both 7 and 8. Returning either silently
	// would be a wrong parse, so it must be rejected (fallback to plain editor).
	content := "" +
		"<<<<<<<< HEAD\n" +
		"<<<<<<< inner\n" +
		"a\n" +
		"=======\n" +
		"b\n" +
		">>>>>>> inner\n" +
		"========\n" +
		"theirs\n" +
		">>>>>>>> feature\n"
	if _, err := parseConflictRegions(content, defaultMarkerSize); err == nil {
		t.Fatal("ambiguous widths: error = nil, want rejection")
	}
}

func TestParseConflictRegions_TooManyWidthsRejected(t *testing.T) {
	var b strings.Builder
	for w := 7; w < 20; w++ { // 13 distinct opening-run widths
		b.WriteString(strings.Repeat("<", w) + " x\n")
	}
	if _, err := parseConflictRegions(b.String(), defaultMarkerSize); err == nil {
		t.Fatal("too many candidate widths: error = nil, want rejection")
	}
}

func TestService_ConflictSnapshot_LiteralMarkerContentIsRejected(t *testing.T) {
	requireGit(t)
	// A file whose UNCHANGED content contains a complete literal conflict
	// example (same width as the real markers). Git does not widen markers for
	// marker-shaped content, so the working tree holds two width-7 marker sets:
	// the real conflict and the content example. The parser cannot tell them
	// apart, so ConflictSnapshot must refuse (fallback to plain editor) rather
	// than return a spurious region the user could "resolve" and corrupt.
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	doc := "intro\n" +
		"<<<<<<< example\n" +
		"alpha\n" +
		"=======\n" +
		"beta\n" +
		">>>>>>> example\n" +
		"tail\n"
	writeFile(t, dir, "f.txt", doc+"shared base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", doc+"shared theirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", doc+"shared ours\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	_, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
	if err == nil {
		t.Fatal("ConflictSnapshot(literal marker content) error = nil, want refusal")
	}
}

func TestService_ConflictSnapshot_BOMLiteralMarkerStillRejected(t *testing.T) {
	requireGit(t)
	// A UTF-8-BOM file whose content begins with a literal conflict example.
	// The worktree opener is decoded (BOM stripped) while the stage blob keeps
	// the BOM bytes; verification must normalize both so the spurious region is
	// still detected and the file refused.
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	bom := "\xef\xbb\xbf"
	doc := bom + "<<<<<<< example\n" + "alpha\n" + "=======\n" + "beta\n" + ">>>>>>> example\n" + "tail\n"
	writeFile(t, dir, "f.txt", doc+"shared base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", doc+"shared theirs\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", doc+"shared ours\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	if _, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictSnapshot(BOM + literal markers) error = nil, want refusal")
	}
}

func TestService_ConflictSnapshot_LiteralCloseInTheirsRejected(t *testing.T) {
	requireGit(t)
	// theirs content contains a literal closing-marker line (">>>>>>> literal",
	// width 7). Git does not widen, so the parser would mis-consume it as the
	// region close, truncating Theirs. That is silent data corruption if a side
	// is accepted, so the snapshot must be refused.
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	// The theirs side of the conflict itself contains a literal closing-marker
	// line, so the parser mis-consumes it as the region close and truncates.
	writeFile(t, dir, "f.txt", "common\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "theirs-before\n>>>>>>> literal\ntheirs-after\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "ours-content\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	if _, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictSnapshot(literal close in theirs) error = nil, want refusal")
	}
}

func TestService_ConflictSnapshot_ContentFilterFailsClosed(t *testing.T) {
	requireGit(t)
	// With an `ident` attribute (or any smudge filter) git transforms content on
	// checkout, so the worktree no longer equals the raw stage blob and the
	// literal-marker verification cannot be trusted. Such a file must fail closed
	// (refuse) rather than risk a silently truncated region.
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, ".gitattributes", "f.txt ident\n")
	writeFile(t, dir, "f.txt", "base $Id$\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", "theirs $Id$\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "ours $Id$\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")

	if _, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictSnapshot(ident filter active) error = nil, want fail-closed refusal")
	}
}

func TestService_ConflictSnapshot_EOFNewlinesMatchStageBlobs(t *testing.T) {
	requireGit(t)
	for _, ending := range []struct {
		name string
		eol  string
	}{
		{name: "LF", eol: "\n"},
		{name: "CRLF", eol: "\r\n"},
	} {
		for mask := 0; mask < 8; mask++ {
			t.Run(ending.name+"/"+strconv.Itoa(mask), func(t *testing.T) {
				body := func(text string, bit uint) string {
					if mask&(1<<bit) != 0 {
						return text + ending.eol
					}
					return text
				}
				dir := makeConflict(t, body("base", 0), body("ours", 1), body("theirs", 2), false)

				snap, err := NewService().ConflictSnapshot(ctx(), dir, "f.txt")
				if err != nil {
					t.Fatalf("ConflictSnapshot error = %v", err)
				}
				if len(snap.Regions) != 1 {
					t.Fatalf("regions = %+v, want one EOF region", snap.Regions)
				}
				region := snap.Regions[0]
				for _, side := range []struct {
					name string
					got  *bool
					bit  uint
				}{
					{name: "base", got: region.BaseEndsWithNewline, bit: 0},
					{name: "ours", got: region.OursEndsWithNewline, bit: 1},
					{name: "theirs", got: region.TheirsEndsWithNewline, bit: 2},
				} {
					want := mask&(1<<side.bit) != 0
					if side.got == nil || *side.got != want {
						t.Errorf("%s EOF newline = %v, want %v", side.name, side.got, want)
					}
				}
			})
		}
	}
}

func TestLastRegionEndsFile(t *testing.T) {
	region := []ConflictRegion{{EndLine: 1}}
	for _, tc := range []struct {
		name  string
		lines []string
		want  bool
	}{
		{name: "marker at EOF", lines: []string{">>>>>>> incoming"}, want: true},
		{name: "Git separator newline", lines: []string{">>>>>>> incoming", ""}, want: true},
		{name: "blank suffix", lines: []string{">>>>>>> incoming", "", ""}, want: false},
		{name: "text suffix", lines: []string{">>>>>>> incoming", "suffix"}, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := lastRegionEndsFile(tc.lines, region); got != tc.want {
				t.Errorf("lastRegionEndsFile() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestService_ConflictGuard_PreservesFinalNewlineStateThroughWriteAndStage(t *testing.T) {
	requireGit(t)
	for _, tc := range []struct {
		name        string
		stageEOL    string
		lineEndings string
		result      string
		want        string
	}{
		{name: "LF/no newline", stageEOL: "\n", lineEndings: "lf", result: "resolved", want: "resolved"},
		{name: "LF/newline", stageEOL: "\n", lineEndings: "lf", result: "resolved\n", want: "resolved\n"},
		{name: "CRLF/no newline", stageEOL: "\r\n", lineEndings: "crlf", result: "resolved", want: "resolved"},
		{name: "CRLF/newline", stageEOL: "\r\n", lineEndings: "crlf", result: "resolved\n", want: "resolved\r\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := makeConflict(t, "base"+tc.stageEOL, "ours", "theirs"+tc.stageEOL, false)
			svc := NewService()
			state, err := svc.ConflictState(ctx(), dir, "f.txt")
			if err != nil {
				t.Fatalf("ConflictState error = %v", err)
			}
			if state.Snapshot == nil {
				t.Fatal("Snapshot = nil")
			}
			if state.Snapshot.LineEndings != tc.lineEndings {
				t.Fatalf("LineEndings = %q, want %q", state.Snapshot.LineEndings, tc.lineEndings)
			}

			written, err := svc.WriteConflictResult(ctx(), dir, "f.txt", state.SourceVersion,
				tc.result, state.Snapshot.Encoding, state.Snapshot.LineEndings)
			if err != nil || !written.Applied {
				t.Fatalf("WriteConflictResult = %+v, err = %v", written, err)
			}
			staged, err := svc.StageConflictResult(ctx(), dir, "f.txt", written.SourceVersion)
			if err != nil || !staged.Applied {
				t.Fatalf("StageConflictResult = %+v, err = %v", staged, err)
			}

			if got := string(mustRead(t, filepath.Join(dir, "f.txt"))); got != tc.want {
				t.Errorf("worktree bytes = %q, want %q", got, tc.want)
			}
			if got := gitCmd(t, dir, "show", ":0:f.txt"); got != tc.want {
				t.Errorf("staged bytes = %q, want %q", got, tc.want)
			}
		})
	}
}

// ── ConflictState + guarded mutation boundary (real git) ──
//
// These cover the Phase 4 invariant: a watcher event is a hint, so the ONLY
// thing that may authorize a mutation is a source version the backend computed
// itself and re-verified inside the same call as the mutation.

// gitStdin runs git in dir with the given stdin, isolated like gitCmd.
func gitStdin(t *testing.T, dir, stdin string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Env = append(scrubGitEnv(os.Environ()),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// versionOf returns the source version of a conflicted path, failing the test
// on any read error.
func versionOf(t *testing.T, dir, path string) string {
	t.Helper()
	state, err := NewService().ConflictState(ctx(), dir, path)
	if err != nil {
		t.Fatalf("ConflictState(%s) error = %v", path, err)
	}
	if state.SourceVersion == "" {
		t.Fatalf("ConflictState(%s) returned an empty source version", path)
	}
	return state.SourceVersion
}

func TestService_ConflictState_TextSessionCarriesSnapshotHeadsAndVersion(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Snapshot == nil {
		t.Fatal("Snapshot = nil, want a text snapshot for a mergeable text conflict")
	}
	if len(state.Snapshot.Regions) != 1 {
		t.Errorf("regions = %d, want 1", len(state.Snapshot.Regions))
	}
	if !strings.Contains(state.Snapshot.Content, "<<<<<<<") {
		t.Errorf("Content missing markers:\n%s", state.Snapshot.Content)
	}
	if state.Heads == nil || state.Heads.Operation != "merge" {
		t.Errorf("Heads = %+v, want a merge operation", state.Heads)
	}
	if state.Stages.Ours == nil || state.Stages.Theirs == nil {
		t.Errorf("Stages = %+v, want ours and theirs present", state.Stages)
	}
	if state.Stages.Ours.Mode == "" {
		t.Error("Stages.Ours.Mode is empty, want the index mode")
	}
	if state.SourceVersion == "" {
		t.Error("SourceVersion is empty")
	}
}

func TestService_ConflictVersion_StableForUnchangedState(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)

	first := versionOf(t, dir, "f.txt")
	second := versionOf(t, dir, "f.txt")

	if first != second {
		t.Errorf("source version changed without any state change: %q -> %q", first, second)
	}
}

func TestService_ConflictVersion_ChangesWithWorktreeBytes(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	before := versionOf(t, dir, "f.txt")

	// Same logical text, CRLF bytes: a decoded-string comparison would call
	// this identical, which is exactly the hole the raw-byte hash closes.
	raw, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	crlf := strings.ReplaceAll(string(raw), "\n", "\r\n")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(crlf), 0o644); err != nil {
		t.Fatal(err)
	}

	if after := versionOf(t, dir, "f.txt"); after == before {
		t.Error("source version unchanged after a CRLF rewrite of the same text")
	}
}

func TestService_ConflictVersion_ChangesWithByteOrderMark(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	before := versionOf(t, dir, "f.txt")

	raw, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), append([]byte{0xEF, 0xBB, 0xBF}, raw...), 0o644); err != nil {
		t.Fatal(err)
	}

	if after := versionOf(t, dir, "f.txt"); after == before {
		t.Error("source version unchanged after a BOM was prepended")
	}
}

func TestService_ConflictVersion_ChangesWithWorktreeMode(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	before := versionOf(t, dir, "f.txt")

	if err := os.Chmod(filepath.Join(dir, "f.txt"), 0o755); err != nil {
		t.Fatal(err)
	}

	if after := versionOf(t, dir, "f.txt"); after == before {
		t.Error("source version unchanged after the worktree permission mode changed")
	}
}

func TestService_ConflictVersion_ChangesWhenWorktreeFileRemoved(t *testing.T) {
	requireGit(t)
	// A delete/modify conflict resolves through the whole-file side UI, so an
	// absent working-tree file is representable there: the index stages still
	// describe the surviving side.
	dir := deleteModifyRepo(t)
	before := versionOf(t, dir, "f.txt")

	if err := os.Remove(filepath.Join(dir, "f.txt")); err != nil {
		t.Fatal(err)
	}

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState after removal error = %v, want a coherent state", err)
	}
	if state.SourceVersion == before {
		t.Error("source version unchanged after the worktree file was removed")
	}
	if state.Snapshot != nil {
		t.Errorf("Snapshot = %+v, want nil with no worktree file", state.Snapshot)
	}
	if state.Stages.Theirs == nil {
		t.Error("Stages.Theirs = nil, want the surviving side still readable")
	}
}

func TestService_ConflictState_TextConflictWithoutWorktreeFileFailsClosed(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	if err := os.Remove(filepath.Join(dir, "f.txt")); err != nil {
		t.Fatal(err)
	}

	// The index still describes a text conflict with both sides present.
	// Returning "no snapshot" here would silently offer a whole-file side
	// choice the stage topology never called for, so this fails closed and the
	// session surfaces a retryable read failure instead.
	if _, err := NewService().ConflictState(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictState(text conflict, missing file) error = nil, want a fail-closed error")
	}
}

func TestService_ConflictState_SymlinkWorktreePathFailsClosed(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	writeFile(t, dir, "other.txt", "elsewhere\n")
	if err := os.Remove(filepath.Join(dir, "f.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "other.txt"), filepath.Join(dir, "f.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if _, err := NewService().ConflictState(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictState(symlink) error = nil, want a fail-closed error")
	}
}

func TestService_ConflictState_DirectoryWorktreePathFailsClosed(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	if err := os.Remove(filepath.Join(dir, "f.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "f.txt"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := NewService().ConflictState(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictState(directory) error = nil, want a fail-closed error")
	}
}

func TestService_ConflictVersion_ChangesWithStageMode(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatal(err)
	}
	before := state.SourceVersion

	// Replace stage 3 with the same object at an executable mode: presence and
	// object are identical, only the mode moved.
	gitStdin(t, dir, "100755 "+state.Stages.Theirs.Hash+" 3\tf.txt\n", "update-index", "--index-info")

	if after := versionOf(t, dir, "f.txt"); after == before {
		t.Error("source version unchanged after a conflict stage mode changed")
	}
}

func TestService_ConflictVersion_ChangesWithStageObject(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatal(err)
	}
	before := state.SourceVersion
	replacement := strings.TrimSpace(gitStdin(t, dir, "different theirs\n", "hash-object", "-w", "--stdin"))

	gitStdin(t, dir, "100644 "+replacement+" 3\tf.txt\n", "update-index", "--index-info")

	if after := versionOf(t, dir, "f.txt"); after == before {
		t.Error("source version unchanged after a conflict stage object changed")
	}
}

func TestService_ConflictVersion_ChangesWithOperationHead(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	before := versionOf(t, dir, "f.txt")
	base := strings.TrimSpace(gitCmd(t, dir, "rev-parse", "main^"))
	gitDir := strings.TrimSpace(gitCmd(t, dir, "rev-parse", "--absolute-git-dir"))

	// Stages and worktree bytes are untouched; only the incoming side of the
	// operation moved. Current/Incoming now mean something else.
	if err := os.WriteFile(filepath.Join(gitDir, "MERGE_HEAD"), []byte(base+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	after := versionOf(t, dir, "f.txt")
	if after == before {
		t.Fatal("source version unchanged after the operation's incoming head changed")
	}
	// A mutation holding the pre-change version must be refused.
	res, err := NewService().StageConflictResult(ctx(), dir, "f.txt", before)
	if err != nil {
		t.Fatalf("StageConflictResult error = %v, want a clean mismatch", err)
	}
	if res.Applied {
		t.Error("Applied = true, want false for a stale operation head")
	}
	if !isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt was staged despite a stale source version")
	}
}

func TestService_ConflictGuard_StaleWriteIsRefusedWithoutMutation(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	current := versionOf(t, dir, "f.txt")
	original, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}

	res, err := NewService().WriteConflictResult(ctx(), dir, "f.txt", current+"-stale", "resolved\n", "utf-8", "lf")

	if err != nil {
		t.Fatalf("WriteConflictResult error = %v, want a clean mismatch", err)
	}
	if res.Applied {
		t.Error("Applied = true, want false for a stale version")
	}
	if res.SourceVersion != current {
		t.Errorf("SourceVersion = %q, want the live version %q", res.SourceVersion, current)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != string(original) {
		t.Errorf("worktree bytes changed on a refused write: %q", got)
	}
	if !isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt was staged on a refused write")
	}
}

func TestService_ConflictGuard_StaleStageIsRefusedWithoutMutation(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	current := versionOf(t, dir, "f.txt")

	res, err := NewService().StageConflictResult(ctx(), dir, "f.txt", current+"-stale")

	if err != nil {
		t.Fatalf("StageConflictResult error = %v, want a clean mismatch", err)
	}
	if res.Applied {
		t.Error("Applied = true, want false for a stale version")
	}
	if !isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt was staged despite a stale source version")
	}
}

func TestService_ConflictGuard_StaleSideApplyIsRefusedWithoutMutation(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "b\x00ase\n", "o\x00urs\n", "t\x00heirs\n", false)
	current := versionOf(t, dir, "f.txt")
	original, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}

	res, err := NewService().ApplyConflictSide(ctx(), dir, "f.txt", "ours", current+"-stale")

	if err != nil {
		t.Fatalf("ApplyConflictSide error = %v, want a clean mismatch", err)
	}
	if res.Applied {
		t.Error("Applied = true, want false for a stale version")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != string(original) {
		t.Errorf("worktree bytes changed on a refused side apply: %q", got)
	}
	if !isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt was staged on a refused side apply")
	}
}

func TestService_ConflictGuard_WriteThenStageWithReturnedVersion(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	svc := NewService()
	current := versionOf(t, dir, "f.txt")
	resolved := "resolved\n<<<<<<< literal text\n"

	write, err := svc.WriteConflictResult(ctx(), dir, "f.txt", current, resolved, "utf-8", "lf")
	if err != nil {
		t.Fatalf("WriteConflictResult error = %v", err)
	}
	if !write.Applied {
		t.Fatal("Applied = false, want true for the live version")
	}
	if write.SourceVersion == current || write.SourceVersion == "" {
		t.Errorf("SourceVersion = %q, want the post-write version", write.SourceVersion)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != resolved {
		t.Errorf("worktree content = %q, want the resolved result", got)
	}

	stage, err := svc.StageConflictResult(ctx(), dir, "f.txt", write.SourceVersion)
	if err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}
	if !stage.Applied {
		t.Fatal("Applied = false, want true when staging the version the write returned")
	}
	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged after a guarded stage")
	}
}

func TestService_ConflictGuard_StageRetryAfterIndexLockUsesSameVersion(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	svc := NewService()
	write, err := svc.WriteConflictResult(ctx(), dir, "f.txt", versionOf(t, dir, "f.txt"), "resolved\n", "utf-8", "lf")
	if err != nil || !write.Applied {
		t.Fatalf("WriteConflictResult = %+v, err = %v", write, err)
	}
	gitDir := strings.TrimSpace(gitCmd(t, dir, "rev-parse", "--absolute-git-dir"))
	lock := filepath.Join(gitDir, "index.lock")
	if err := os.WriteFile(lock, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.StageConflictResult(ctx(), dir, "f.txt", write.SourceVersion); err == nil {
		t.Fatal("StageConflictResult with a held index.lock error = nil, want an operational error")
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}

	// The failed stage mutated nothing, so the write's version is still the
	// live one and a retry needs no new read.
	retry, err := svc.StageConflictResult(ctx(), dir, "f.txt", write.SourceVersion)
	if err != nil {
		t.Fatalf("retry StageConflictResult error = %v", err)
	}
	if !retry.Applied {
		t.Error("Applied = false, want true retrying with the version the write returned")
	}
	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged after the retried stage")
	}
}

func TestService_ConflictGuard_SideApplyThenStage(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "b\x00ase\n", "o\x00urs\n", "t\x00heirs\n", false)
	svc := NewService()

	apply, err := svc.ApplyConflictSide(ctx(), dir, "f.txt", "theirs", versionOf(t, dir, "f.txt"))
	if err != nil {
		t.Fatalf("ApplyConflictSide error = %v", err)
	}
	if !apply.Applied {
		t.Fatal("Applied = false, want true for the live version")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "t\x00heirs\n" {
		t.Errorf("worktree content = %q, want theirs", got)
	}
	// Apply is worktree-only: the path stays unmerged until the guarded stage.
	if !isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt was staged by the side apply, want worktree-only")
	}

	stage, err := svc.StageConflictResult(ctx(), dir, "f.txt", apply.SourceVersion)
	if err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}
	if !stage.Applied || isUnmerged(t, dir, "f.txt") {
		t.Errorf("stage = %+v, unmerged = %v, want applied and resolved", stage, isUnmerged(t, dir, "f.txt"))
	}
}

func TestService_ConflictGuard_AbsentSideStagesTheDeletion(t *testing.T) {
	requireGit(t)
	dir := deleteModifyRepo(t) // ours deleted the file (stage 2 absent)
	svc := NewService()

	apply, err := svc.ApplyConflictSide(ctx(), dir, "f.txt", "ours", versionOf(t, dir, "f.txt"))
	if err != nil {
		t.Fatalf("ApplyConflictSide(deletion) error = %v", err)
	}
	if !apply.Applied {
		t.Fatal("Applied = false, want true")
	}
	if _, err := os.Stat(filepath.Join(dir, "f.txt")); !os.IsNotExist(err) {
		t.Error("f.txt should be removed from the worktree")
	}
	// Worktree-only: the index still carries the conflict until the stage.
	if !isUnmerged(t, dir, "f.txt") {
		t.Error("the side apply staged the deletion, want worktree-only")
	}

	if _, err := svc.StageConflictResult(ctx(), dir, "f.txt", apply.SourceVersion); err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}
	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged after staging the deletion")
	}
	if tracked := strings.TrimSpace(gitCmd(t, dir, "ls-files", "--", "f.txt")); tracked != "" {
		t.Errorf("f.txt still in the index = %q, want absent", tracked)
	}
}

func TestService_ConflictGuard_RejectsUnwritableEncoding(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	original, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}

	// latin-1 cannot be re-encoded by the writer: it would silently write UTF-8
	// bytes. Refuse rather than perform a lossy write.
	if _, err := NewService().WriteConflictResult(ctx(), dir, "f.txt", versionOf(t, dir, "f.txt"), "resolved\n", "latin-1", "lf"); err == nil {
		t.Fatal("WriteConflictResult(latin-1) error = nil, want a refusal")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != string(original) {
		t.Errorf("worktree bytes changed on a refused encoding: %q", got)
	}
}

func TestService_ConflictState_BinaryConflictHasNoSnapshot(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "b\x00ase\n", "o\x00urs\n", "t\x00heirs\n", false)

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Snapshot != nil {
		t.Error("Snapshot != nil, want nil for a binary conflict")
	}
	if !state.Stages.Binary {
		t.Error("Stages.Binary = false, want true")
	}
	if state.SourceVersion == "" {
		t.Error("SourceVersion is empty for a binary conflict")
	}
}

func TestService_ConflictState_MissingSideHasNoSnapshot(t *testing.T) {
	requireGit(t)
	dir := deleteModifyRepo(t)

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Snapshot != nil {
		t.Error("Snapshot != nil, want nil when a side is absent")
	}
	if state.Stages.Ours != nil {
		t.Errorf("Stages.Ours = %+v, want nil (deleted on ours)", state.Stages.Ours)
	}
	if state.Heads == nil {
		t.Error("Heads = nil, want the operation heads while stages exist")
	}
}

func TestService_ConflictState_ResolvedPathHasNoStagesAndNoHeads(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	gitCmd(t, dir, "checkout", "--theirs", "--", "f.txt")
	gitCmd(t, dir, "add", "--", "f.txt")

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Stages.Base != nil || state.Stages.Ours != nil || state.Stages.Theirs != nil {
		t.Errorf("Stages = %+v, want all absent", state.Stages)
	}
	// Resolved-outside detection must not depend on operation metadata that may
	// already be gone.
	if state.Heads != nil {
		t.Errorf("Heads = %+v, want nil with no conflict stages", state.Heads)
	}
	if state.Snapshot != nil {
		t.Errorf("Snapshot = %+v, want nil with no conflict stages", state.Snapshot)
	}
}

func TestService_ConflictState_MarkersRemovedKeepsEmptyRegions(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	// Resolved in the worktree by hand but never staged: still conflicted in
	// the index, and the session must be able to tell markers are gone.
	writeFile(t, dir, "f.txt", "hand resolved\n")

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Snapshot == nil {
		t.Fatal("Snapshot = nil, want a marker-free snapshot for a still-conflicted text path")
	}
	if state.Snapshot.Regions == nil {
		t.Error("Regions = nil, want an empty non-nil slice")
	}
	if len(state.Snapshot.Regions) != 0 {
		t.Errorf("regions = %d, want 0", len(state.Snapshot.Regions))
	}
}

func TestService_ConflictState_OverLimitTextFailsClosed(t *testing.T) {
	requireGit(t)
	dir := makeConflict(t, "base\n", "ours\n", "theirs\n", false)
	big := strings.Repeat("a\n", (maxDiffableBytes/2)+64)
	writeFile(t, dir, "f.txt", big)

	// Stages say this is a text conflict, so silently degrading to a
	// whole-file side choice would change what the user is deciding.
	if _, err := NewService().ConflictState(ctx(), dir, "f.txt"); err == nil {
		t.Fatal("ConflictState(over-limit text) error = nil, want a fail-closed error")
	}
}

// ── Conflict topology and byte preservation (real git) ──

// modifyDeleteRepo: ours (main) modifies f.txt, theirs (feature) deletes it.
// The mirror image of deleteModifyRepo, so both stage-absence orientations are
// covered rather than only the one the earlier phase happened to build.
func modifyDeleteRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "f.txt", "base\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	gitCmd(t, dir, "rm", "f.txt")
	gitCmd(t, dir, "commit", "-m", "delete on feature")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", "ours modified")
	gitCmd(t, dir, "commit", "-am", "modify on main")
	mergeConflict(t, dir, "feature")
	return dir
}

// binaryDeleteModifyRepo: ours deletes a binary file, theirs modifies it.
func binaryDeleteModifyRepo(t *testing.T, oursDeletes bool) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	writeFile(t, dir, "f.bin", "b\x00ase\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	if oursDeletes {
		writeFile(t, dir, "f.bin", "t\x00heirs\n")
		gitCmd(t, dir, "commit", "-am", "modify on feature")
	} else {
		gitCmd(t, dir, "rm", "f.bin")
		gitCmd(t, dir, "commit", "-m", "delete on feature")
	}
	gitCmd(t, dir, "checkout", "main")
	if oursDeletes {
		gitCmd(t, dir, "rm", "f.bin")
		gitCmd(t, dir, "commit", "-m", "delete on main")
	} else {
		writeFile(t, dir, "f.bin", "o\x00urs\n")
		gitCmd(t, dir, "commit", "-am", "modify on main")
	}
	mergeConflict(t, dir, "feature")
	return dir
}

func TestService_ConflictState_DeleteModifyStageOrientation(t *testing.T) {
	requireGit(t)
	dir := deleteModifyRepo(t) // ours deleted: stage 2 absent, stage 3 present

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Stages.Ours != nil {
		t.Errorf("Stages.Ours = %+v, want nil (deleted on ours)", state.Stages.Ours)
	}
	if state.Stages.Theirs == nil {
		t.Error("Stages.Theirs = nil, want the surviving side")
	}
	if state.Snapshot != nil {
		t.Error("Snapshot != nil, want the whole-file side UI")
	}
}

func TestService_ConflictState_ModifyDeleteStageOrientation(t *testing.T) {
	requireGit(t)
	dir := modifyDeleteRepo(t) // theirs deleted: stage 3 absent, stage 2 present

	state, err := NewService().ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Stages.Theirs != nil {
		t.Errorf("Stages.Theirs = %+v, want nil (deleted on theirs)", state.Stages.Theirs)
	}
	if state.Stages.Ours == nil {
		t.Error("Stages.Ours = nil, want the surviving side")
	}
	if state.Snapshot != nil {
		t.Error("Snapshot != nil, want the whole-file side UI")
	}
}

func TestService_ConflictGuard_ModifyDeleteKeepsOurSide(t *testing.T) {
	requireGit(t)
	dir := modifyDeleteRepo(t)
	svc := NewService()

	apply, err := svc.ApplyConflictSide(ctx(), dir, "f.txt", "ours", versionOf(t, dir, "f.txt"))
	if err != nil || !apply.Applied {
		t.Fatalf("ApplyConflictSide(ours) = %+v, err = %v", apply, err)
	}
	if _, err := svc.StageConflictResult(ctx(), dir, "f.txt", apply.SourceVersion); err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}

	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(got) != "ours modified" {
		t.Errorf("worktree content = %q, want ours", got)
	}
	if staged := gitCmd(t, dir, "show", ":0:f.txt"); staged != "ours modified" {
		t.Errorf("staged content = %q, want ours", staged)
	}
}

func TestService_ConflictGuard_ModifyDeleteTakesTheirDeletion(t *testing.T) {
	requireGit(t)
	dir := modifyDeleteRepo(t)
	svc := NewService()

	apply, err := svc.ApplyConflictSide(ctx(), dir, "f.txt", "theirs", versionOf(t, dir, "f.txt"))
	if err != nil || !apply.Applied {
		t.Fatalf("ApplyConflictSide(theirs=deletion) = %+v, err = %v", apply, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "f.txt")); !os.IsNotExist(err) {
		t.Error("f.txt should be removed from the worktree")
	}
	if _, err := svc.StageConflictResult(ctx(), dir, "f.txt", apply.SourceVersion); err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}

	if isUnmerged(t, dir, "f.txt") {
		t.Error("f.txt still unmerged")
	}
	if tracked := strings.TrimSpace(gitCmd(t, dir, "ls-files", "--", "f.txt")); tracked != "" {
		t.Errorf("f.txt still in the index = %q, want absent", tracked)
	}
}

func TestService_ConflictState_BinaryDeleteModifyBothOrientations(t *testing.T) {
	requireGit(t)
	for _, tc := range []struct {
		name        string
		oursDeletes bool
	}{
		{"binary DU (ours deleted)", true},
		{"binary UD (theirs deleted)", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := binaryDeleteModifyRepo(t, tc.oursDeletes)
			state, err := NewService().ConflictState(ctx(), dir, "f.bin")
			if err != nil {
				t.Fatalf("ConflictState error = %v", err)
			}
			if state.Snapshot != nil {
				t.Error("Snapshot != nil, want the whole-file side UI")
			}
			absent, present := state.Stages.Ours, state.Stages.Theirs
			if !tc.oursDeletes {
				absent, present = state.Stages.Theirs, state.Stages.Ours
			}
			if absent != nil {
				t.Errorf("deleted side = %+v, want nil", absent)
			}
			if present == nil {
				t.Error("surviving side = nil, want a blob")
			}
			if state.SourceVersion == "" {
				t.Error("SourceVersion is empty")
			}
		})
	}
}

func TestService_ConflictGuard_BinaryDeleteModifyKeepsTheSurvivingSide(t *testing.T) {
	requireGit(t)
	dir := binaryDeleteModifyRepo(t, true) // ours deleted, theirs modified
	svc := NewService()

	apply, err := svc.ApplyConflictSide(ctx(), dir, "f.bin", "theirs", versionOf(t, dir, "f.bin"))
	if err != nil || !apply.Applied {
		t.Fatalf("ApplyConflictSide(theirs) = %+v, err = %v", apply, err)
	}
	if _, err := svc.StageConflictResult(ctx(), dir, "f.bin", apply.SourceVersion); err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}

	got, _ := os.ReadFile(filepath.Join(dir, "f.bin"))
	if string(got) != "t\x00heirs\n" {
		t.Errorf("worktree content = %q, want theirs", got)
	}
	if isUnmerged(t, dir, "f.bin") {
		t.Error("f.bin still unmerged")
	}
}

// crlfConflictRepo commits CRLF bytes on both sides with autocrlf disabled, so
// the fixture controls the committed bytes on every platform (no unix2dos).
func crlfConflictRepo(t *testing.T, prefix string) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-b", "main")
	gitCmd(t, dir, "config", "user.name", "Test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
	gitCmd(t, dir, "config", "core.autocrlf", "false")
	// The first line is shared so the conflict region starts BELOW it: a
	// difference on line 1 would put the marker (and any byte-order mark) inside
	// the region, and the file would no longer begin with the prefix under test.
	writeFile(t, dir, "f.txt", prefix+"header\r\nbase\r\nshared\r\n")
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "base")
	gitCmd(t, dir, "checkout", "-b", "feature")
	writeFile(t, dir, "f.txt", prefix+"header\r\ntheirs\r\nshared\r\n")
	gitCmd(t, dir, "commit", "-am", "theirs")
	gitCmd(t, dir, "checkout", "main")
	writeFile(t, dir, "f.txt", prefix+"header\r\nours\r\nshared\r\n")
	gitCmd(t, dir, "commit", "-am", "ours")
	mergeConflict(t, dir, "feature")
	return dir
}

func TestService_ConflictGuard_PreservesCRLFThroughWriteAndStage(t *testing.T) {
	requireGit(t)
	dir := crlfConflictRepo(t, "")
	svc := NewService()

	state, err := svc.ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Snapshot == nil {
		t.Fatal("Snapshot = nil, want a text snapshot")
	}
	if state.Snapshot.LineEndings != "crlf" {
		t.Fatalf("LineEndings = %q, want crlf", state.Snapshot.LineEndings)
	}

	// The editor hands back an LF document; the captured line endings are what
	// makes the write round-trip.
	written, err := svc.WriteConflictResult(ctx(), dir, "f.txt", state.SourceVersion,
		"header\nours\nshared\n", state.Snapshot.Encoding, state.Snapshot.LineEndings)
	if err != nil || !written.Applied {
		t.Fatalf("WriteConflictResult = %+v, err = %v", written, err)
	}
	if _, err := svc.StageConflictResult(ctx(), dir, "f.txt", written.SourceVersion); err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}

	raw, _ := os.ReadFile(filepath.Join(dir, "f.txt"))
	if string(raw) != "header\r\nours\r\nshared\r\n" {
		t.Errorf("worktree bytes = %q, want CRLF", raw)
	}
	if staged := gitCmd(t, dir, "show", ":0:f.txt"); staged != "header\r\nours\r\nshared\r\n" {
		t.Errorf("staged bytes = %q, want CRLF", staged)
	}
}

func TestService_ConflictGuard_PreservesByteOrderMarkThroughWriteAndStage(t *testing.T) {
	requireGit(t)
	const bom = "\xEF\xBB\xBF"
	dir := crlfConflictRepo(t, bom)
	svc := NewService()

	state, err := svc.ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	if state.Snapshot == nil {
		t.Fatal("Snapshot = nil, want a text snapshot")
	}
	if state.Snapshot.Encoding != "utf-8-bom" {
		t.Fatalf("Encoding = %q, want utf-8-bom", state.Snapshot.Encoding)
	}
	before := state.SourceVersion

	// Source-version sensitivity: dropping the BOM is a real byte change.
	stripped := strings.TrimPrefix(string(mustRead(t, filepath.Join(dir, "f.txt"))), bom)
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(stripped), 0o644); err != nil {
		t.Fatal(err)
	}
	if after := versionOf(t, dir, "f.txt"); after == before {
		t.Error("source version unchanged after the BOM was removed")
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(bom+stripped), 0o644); err != nil {
		t.Fatal(err)
	}

	state, err = svc.ConflictState(ctx(), dir, "f.txt")
	if err != nil {
		t.Fatalf("ConflictState error = %v", err)
	}
	written, err := svc.WriteConflictResult(ctx(), dir, "f.txt", state.SourceVersion,
		"header\nours\nshared\n", state.Snapshot.Encoding, state.Snapshot.LineEndings)
	if err != nil || !written.Applied {
		t.Fatalf("WriteConflictResult = %+v, err = %v", written, err)
	}
	if _, err := svc.StageConflictResult(ctx(), dir, "f.txt", written.SourceVersion); err != nil {
		t.Fatalf("StageConflictResult error = %v", err)
	}

	raw := mustRead(t, filepath.Join(dir, "f.txt"))
	if !strings.HasPrefix(string(raw), bom) {
		t.Errorf("worktree bytes = %q, want a leading BOM", raw)
	}
	if staged := gitCmd(t, dir, "show", ":0:f.txt"); !strings.HasPrefix(staged, bom) {
		t.Errorf("staged bytes = %q, want a leading BOM", staged)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
