package git

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Hunk is one @@-block of a file's unified diff. Patch is a standalone,
// applyable patch — the file header followed by this single hunk — so the
// frontend can replay exactly what the user saw through `git apply` without
// reconstructing anything. NewStart/NewLines locate the hunk on the new side
// (the right pane of the diff view) so the UI can anchor a gutter control.
type Hunk struct {
	Patch    string `json:"patch"`
	NewStart int    `json:"newStart"`
	NewLines int    `json:"newLines"`
}

// FileHunks is the per-hunk breakdown of a single file's diff. A binary file
// or a file with no diff yields an empty Hunks slice (never nil, for stable
// JSON), which the UI renders as "no per-hunk staging here".
type FileHunks struct {
	Path  string `json:"path"`
	Hunks []Hunk `json:"hunks"`
}

// FileHunks returns the unified diff of path split into hunks. staged=false
// diffs the working tree against the index (hunks the user can stage);
// staged=true diffs the index against HEAD (hunks the user can unstage).
// --no-color/--no-ext-diff pin plain, applyable output regardless of user
// config or diff drivers.
//
// One line of context, not the default three and not zero: with three lines,
// edits within ~6 lines coalesce into a single hunk and the UI gets one
// staging control for visually distinct changes; with zero, an insertion hunk
// has an empty preimage, so `git apply` cannot offset-search and anchors
// blindly at the recorded line — staging only the later of two insertions
// landed it one line off in the index (silent corruption). One context line
// keeps nearby edits separate while giving git an anchor to search with.
// parseFileHunks then shifts each anchor past the context so gutter buttons
// still sit on the first changed line.
func (s *Service) FileHunks(ctx context.Context, dir, path string, staged bool) (FileHunks, error) {
	if err := validateRepoRelPaths([]string{path}); err != nil {
		return FileHunks{}, err
	}
	args := []string{
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--unified=1",
		"--src-prefix=a/",
		"--dst-prefix=b/",
	}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", path)
	out, err := s.runAtRoot(ctx, dir, args...)
	if err != nil {
		return FileHunks{}, err
	}
	return parseFileHunks(out, path), nil
}

// ApplyPatch applies a single-hunk patch to the index via `git apply --cached`
// (reverse=true adds --reverse, which unstages). The patch must be one git
// produced; it is validated as a diff and then run against the index, whose
// content matches the patch's preimage by construction.
func (s *Service) ApplyPatch(ctx context.Context, dir, patch string, reverse bool) error {
	if !looksLikePatch(patch) {
		return fmt.Errorf("not a git patch")
	}
	args := []string{"apply", "--cached"}
	if reverse {
		args = append(args, "--reverse")
	}
	_, err := s.runAtRootStdin(ctx, dir, patch, args...)
	return err
}

// looksLikePatch is a cheap guard at the bindings boundary: reject anything
// that is not a unified diff before it reaches `git apply`. git itself does
// the real validation and rejects patches that do not apply.
func looksLikePatch(patch string) bool {
	return strings.HasPrefix(patch, "diff --git ") || strings.HasPrefix(patch, "--- ")
}

// parseFileHunks splits one file's unified diff into a header (everything
// before the first @@) and its hunks. Each hunk's Patch is header+hunk-text so
// it applies on its own. A single `git diff -- <path>` yields at most one file
// section; content before the first @@ that isn't a diff (empty output, binary
// notice) simply produces no hunks.
func parseFileHunks(raw, path string) FileHunks {
	result := FileHunks{Path: path, Hunks: []Hunk{}}
	// An unmerged file yields a combined diff (`diff --cc`, @@@ headers) whose
	// hunks are not applyable patches; the conflict banner owns that state, so
	// expose no per-hunk controls.
	if strings.HasPrefix(raw, "diff --cc ") {
		return result
	}
	firstHunk := strings.Index(raw, "\n@@")
	if firstHunk < 0 {
		if strings.HasPrefix(raw, "@@") {
			firstHunk = -1 // header is empty; hunks start at offset 0
		} else {
			return result // no hunks (empty, binary, or mode-only change)
		}
	}
	var header, body string
	if firstHunk < 0 {
		body = raw
	} else {
		header = raw[:firstHunk+1] // include the newline before the first @@
		body = raw[firstHunk+1:]
	}

	// Split body into hunks at each line that begins with "@@".
	lines := strings.SplitAfter(body, "\n")
	var cur strings.Builder
	var curStart, curLines int
	flush := func() {
		if cur.Len() == 0 {
			return
		}
		// The @@ header's new-side range includes the surrounding context
		// lines; shift the anchor past the leading context and drop context
		// from the count so the UI anchors controls on the first changed line
		// (and a pure deletion anchors on the line after the removal, with a
		// zero count, matching the change gutter's convention).
		lead, trail := contextRuns(cur.String())
		start := curStart + lead
		count := curLines - lead - trail
		if count < 0 {
			count = 0
		}
		result.Hunks = append(result.Hunks, Hunk{
			Patch:    header + cur.String(),
			NewStart: start,
			NewLines: count,
		})
		cur.Reset()
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "@@") {
			flush()
			curStart, curLines = parseHunkHeader(line)
		}
		if cur.Len() > 0 || strings.HasPrefix(line, "@@") {
			cur.WriteString(line)
		}
	}
	flush()
	return result
}

// contextRuns counts the unchanged context lines (" "-prefixed) at the start
// and end of one hunk's text. The first line is the @@ header and "\"-prefixed
// lines ("\ No newline at end of file") annotate the preceding line, so both
// are ignored.
func contextRuns(hunk string) (lead, trail int) {
	lines := strings.Split(strings.TrimSuffix(hunk, "\n"), "\n")
	if len(lines) < 2 {
		return 0, 0
	}
	body := lines[1:] // drop the @@ header
	for _, l := range body {
		if !strings.HasPrefix(l, " ") {
			break
		}
		lead++
	}
	for i := len(body) - 1; i >= lead; i-- {
		if strings.HasPrefix(body[i], "\\") {
			continue
		}
		if !strings.HasPrefix(body[i], " ") {
			break
		}
		trail++
	}
	return lead, trail
}

// parseHunkHeader extracts the new-side start line and line count from an
// "@@ -old,oldN +new,newN @@" header. A missing count means 1 (git omits it
// for single-line ranges). Malformed headers degrade to 0/0 rather than
// dropping the hunk — the patch text is still authoritative for applying.
func parseHunkHeader(line string) (start, count int) {
	_, rest, ok := strings.Cut(line, "+")
	if !ok {
		return 0, 0
	}
	end := strings.IndexAny(rest, " \t")
	if end >= 0 {
		rest = rest[:end]
	}
	startStr, countStr, hasCount := strings.Cut(rest, ",")
	start, _ = strconv.Atoi(startStr)
	if !hasCount {
		return start, 1
	}
	count, _ = strconv.Atoi(countStr)
	return start, count
}

// runStdin is run() with a patch piped to git's stdin, for `git apply`.
func (s *Service) runStdin(ctx context.Context, dir, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(scrubGitEnv(os.Environ()), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), fmt.Errorf("git %s: %s", args[0], msg)
	}
	return stdout.String(), nil
}

// runAtRootStdin runs runStdin from the repo top-level so the a/ b/ paths in
// the patch resolve regardless of which subdirectory dir points at.
func (s *Service) runAtRootStdin(ctx context.Context, dir, stdin string, args ...string) (string, error) {
	root := dir
	if out, err := s.run(ctx, dir, "rev-parse", "--show-toplevel"); err == nil {
		root = strings.TrimSpace(out)
	}
	return s.runStdin(ctx, root, stdin, args...)
}
