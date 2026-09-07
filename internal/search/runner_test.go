package search

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestBuildArgs verifies the option-to-argument mapping is exact and that
// the query is its own argv element rather than being string-templated.
func TestBuildArgs(t *testing.T) {
	cases := []struct {
		name string
		req  SearchRequest
		want []string
	}{
		{
			name: "literal-case-insensitive",
			req: SearchRequest{
				Root:    "/abs/root",
				Query:   "needle",
				Options: SearchOptions{},
			},
			want: []string{
				"--no-config", "--no-require-git", "--json", "--line-number", "--column", "--color", "never",
				"--fixed-strings", "--ignore-case",
				"--regexp", "needle",
				"--", "/abs/root",
			},
		},
		{
			name: "regex-case-sensitive-whole-word",
			req: SearchRequest{
				Root:    "/r",
				Query:   `\bfoo\b`,
				Options: SearchOptions{Regex: true, CaseSensitive: true, WholeWord: true},
			},
			want: []string{
				"--no-config", "--no-require-git", "--json", "--line-number", "--column", "--color", "never",
				"--case-sensitive", "--word-regexp",
				"--regexp", `\bfoo\b`,
				"--", "/r",
			},
		},
		{
			name: "leading-dash-query-is-safe",
			req: SearchRequest{
				Root:  "/r",
				Query: "-flag",
			},
			want: []string{
				"--no-config", "--no-require-git", "--json", "--line-number", "--column", "--color", "never",
				"--fixed-strings", "--ignore-case",
				"--regexp", "-flag",
				"--", "/r",
			},
		},
		{
			name: "literal-mode-includes-fixed-strings",
			req: SearchRequest{
				Root:    "/r",
				Query:   ".*",
				Options: SearchOptions{Regex: false, CaseSensitive: true},
			},
			want: []string{
				"--no-config", "--no-require-git", "--json", "--line-number", "--column", "--color", "never",
				"--fixed-strings", "--case-sensitive",
				"--regexp", ".*",
				"--", "/r",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildArgs(tc.req)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("buildArgs:\n got %#v\nwant %#v", got, tc.want)
			}
		})
	}
}

// TestClassifyStderr trims and collapses stderr output to a single line.
func TestClassifyStderr(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", "no stderr output"},
		{"   \n  ", "no stderr output"},
		{"single line", "single line"},
		{"first\nsecond\nthird", "first"},
		{"\n\nfirst real", "first real"},
	}
	for _, tc := range cases {
		got := classifyStderr([]byte(tc.in))
		if got != tc.want {
			t.Errorf("classifyStderr(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestIsRegexError matches ripgrep's stderr signatures for regex parse
// failures.
func TestIsRegexError(t *testing.T) {
	yes := []string{
		"regex parse error: empty class",
		"error parsing regex: foo",
		"unrecognized escape sequence",
		"invalid character class",
		"the literal \"\\n\" is not allowed in a regex",
	}
	no := []string{
		"some other failure",
		"",
		"no such file or directory",
	}
	for _, s := range yes {
		if !isRegexError([]byte(s)) {
			t.Errorf("isRegexError(%q) = false, want true", s)
		}
	}
	for _, s := range no {
		if isRegexError([]byte(s)) {
			t.Errorf("isRegexError(%q) = true, want false", s)
		}
	}
}

// TestIsMissingTool ensures the helper recognizes wrapped exec.ErrNotFound
// values returned by exec.LookPath.
func TestIsMissingTool(t *testing.T) {
	if isMissingTool(nil) {
		t.Error("isMissingTool(nil) = true, want false")
	}
	if isMissingTool(errors.New("plain")) {
		t.Error("isMissingTool(plain error) = true, want false")
	}
	wrapped := &exec.Error{Name: "rg", Err: exec.ErrNotFound}
	if !isMissingTool(wrapped) {
		t.Error("isMissingTool(exec.Error{ErrNotFound}) = false, want true")
	}
	// exec.LookPath in real callsites wraps via fmt.Errorf("%w").
	if !isMissingTool(errors.Join(wrapped, errors.New("ctx"))) {
		t.Error("isMissingTool(joined exec.Error) = false, want true")
	}
}

func TestRunRipgrepCancelsProcessAtMatchCap(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell wrapper helper is Unix-only")
	}

	dir := t.TempDir()
	wrapper := filepath.Join(dir, "fake-rg")
	// The child records how far it got through its stream here, which is how
	// we prove the process was cancelled rather than left to finish. Nothing
	// is interpolated into the wrapper script: paths travel by environment
	// because Go's %q is not shell quoting -- it passes "$" and backticks
	// through verbatim, live inside sh's double quotes, and escapes
	// non-printable bytes into \u forms sh does not decode. Either would send
	// the child to a different file than the one checked here.
	progress := filepath.Join(dir, "emitted")
	t.Setenv(fakeRGProgressEnv, progress)
	// Same reasoning for the binary path, which is a toolchain-generated
	// build-cache location we do not control. "$VAR" in sh expands without
	// word splitting or globbing, so nothing in the path can be reinterpreted.
	t.Setenv(fakeRGBinEnv, os.Args[0])

	// "exec" is load-bearing: it replaces this shell with the emitting process
	// so the pid exec.CommandContext kills on cancelation is the one writing.
	// Without it SIGKILL would hit /bin/sh and orphan the emitter. The ^...$
	// anchors matter for the same reason as in internal/lsp: an unanchored
	// filter would also run any future test whose name merely contains this
	// one, and its output would land on the JSON stream the parent parses.
	script := fmt.Sprintf(
		"#!/bin/sh\n%s=cap exec \"$%s\" -test.run=^TestSearchFakeRGProcess$ -- \"$@\"\n",
		fakeRGModeEnv, fakeRGBinEnv,
	)
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake rg wrapper: %v", err)
	}

	prevLookup := rgLookup
	prevName := rgBinaryName
	t.Cleanup(func() {
		rgLookup = prevLookup
		rgBinaryName = prevName
	})
	rgLookup = func(string) (string, error) { return wrapper, nil }

	const matchCap = 5
	delivered := 0

	// Timeout here is a backstop, not the behavior under test: the cap must
	// fire long before any deadline is relevant. The fake rg streams 10k
	// matches a millisecond apart, so it lives ~10s when nothing cancels it;
	// a minute clears that and still leaves room for the subprocess spawn,
	// which is what actually dominates the wall clock (~0.2s idle, far more
	// on a loaded machine). An earlier 2s bound flaked for exactly that
	// reason, reporting a timeout instead of exercising the cap. One minute
	// also stays well under Go's 10m per-binary timeout, so a runner that
	// wedged instead of canceling still fails as a test, not a panic.
	outcome := runRipgrep(
		context.Background(),
		runnerConfig{MatchCap: matchCap, Timeout: time.Minute},
		SearchRequest{RequestID: "cap", Root: "/tmp", Query: "needle"},
		func(string, LineMatch) bool { delivered++; return true },
	)

	if outcome.Err != nil {
		t.Fatalf("runRipgrep returned error: %v", outcome.Err)
	}
	// Truncated is set only by cancelAfterCap, so it is evidence that the cap
	// branch ran. It is NOT evidence that the process was cancelled: dropping
	// the cancel() call from cancelAfterCap leaves Truncated true and lets the
	// child stream to completion, which is what the emitted check below exists
	// to catch.
	if !outcome.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	// And the cancelation actually stopped collection: exactly MatchCap
	// matches reached the consumer even though the fake rg had 10k to give.
	if delivered != matchCap {
		t.Fatalf("delivered %d matches, want %d", delivered, matchCap)
	}

	// The process itself was cancelled, not merely ignored: a run left to
	// finish emits fakeRGMatches lines. The bound is expressed in the child's
	// own output rather than wall-clock time, so load cannot trip it -- the
	// child emits at most one line per millisecond by construction, so
	// exceeding this bound would require cancelation to outlast emittedBound
	// milliseconds of the child's own paced output, and a loaded machine makes
	// the child slower, never faster.
	//
	// The lower bound is what keeps this honest. An upper bound alone fails
	// open: if the child never wrote the file at all -- wrong path, lost env
	// var, an edited wrapper -- the count reads zero and the check passes
	// while asserting nothing. Nothing above catches that, because Truncated
	// and delivered are satisfied entirely by parent-side bookkeeping. The
	// child must have emitted at least the matches the parent consumed.
	const emittedBound = 500
	emitted := emittedByFakeRG(t, progress)
	if emitted < matchCap || emitted >= emittedBound {
		t.Fatalf(
			"fake rg emitted %d lines (of %d); want [%d, %d), i.e. killed shortly after the cap",
			emitted, fakeRGMatches, matchCap, emittedBound,
		)
	}
}

// emittedByFakeRG returns how many lines the fake rg child emitted, counted as
// the size of the append-only progress file it writes one byte to per line.
// Counting bytes rather than reading back a number matters because the child
// dies to SIGKILL mid-stream: a single-byte append is all-or-nothing, whereas
// a rewritten counter can be caught truncated.
//
// A missing file is a hard failure, not a zero: it means the progress plumbing
// broke, and returning zero would quietly disarm the caller's upper-bound
// check instead of reporting that the test can no longer see what it claims
// to measure.
func emittedByFakeRG(t *testing.T, path string) int {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat fake rg progress (child never recorded its output?): %v", err)
	}
	return int(info.Size())
}

// fakeRGMatches is the length of the fake rg match stream. It sits three
// orders of magnitude above the test's match cap so that "stopped at the cap"
// and "ran to completion" are never ambiguous.
const fakeRGMatches = 10_000

// Environment contract between the match-cap test and its child process.
// fakeRGModeEnv arms the child; fakeRGProgressEnv names the file it appends
// one byte to per emitted line. Both are required once armed -- an optional
// progress file would let the parent's cancelation check pass while measuring
// nothing.
const (
	fakeRGModeEnv     = "FIRN_SEARCH_FAKE_RG"
	fakeRGProgressEnv = "FIRN_SEARCH_FAKE_RG_PROGRESS"
	fakeRGBinEnv      = "FIRN_SEARCH_FAKE_RG_BIN"
)

// TestSearchFakeRGProcess is the child half of the match-cap test: the wrapper
// script re-execs this binary with FIRN_SEARCH_FAKE_RG=cap. The matches are
// paced a millisecond apart so the child is a long-lived stream that outlives
// the cap by orders of magnitude -- the parent can only finish early by
// cancelling it. One byte per emitted line is appended to the file named by
// FIRN_SEARCH_FAKE_RG_PROGRESS so the parent can see how far the child got
// before it was killed.
func TestSearchFakeRGProcess(t *testing.T) {
	if os.Getenv(fakeRGModeEnv) != "cap" {
		t.Skip("not running as the fake rg child")
	}

	// Diagnostics go to stderr and exit 2, never through testing's stdout:
	// stdout is the JSON stream the parent parses, so a t.Fatalf here would
	// surface as a parse error instead of the real cause. Exit 2 is ripgrep's
	// own "failed" code, which routes the message into runRipgrep's error.
	failf := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "fake rg: "+format+"\n", args...)
		os.Exit(2)
	}

	// Required, not optional: without the progress file the parent's
	// cancelation check has nothing to measure.
	path := os.Getenv(fakeRGProgressEnv)
	if path == "" {
		failf("%s is unset", fakeRGProgressEnv)
	}
	// Append-only: this process is SIGKILLed mid-stream, and an append is
	// all-or-nothing where a truncate-and-rewrite is not.
	progress, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		failf("open progress %s: %v", path, err)
	}

	for i := 1; i <= fakeRGMatches; i++ {
		_, _ = fmt.Fprintf(
			os.Stdout,
			`{"type":"match","data":{"path":{"text":"/tmp/fake.txt"},"lines":{"text":"needle\n"},"line_number":%d,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}`+"\n",
			i,
		)
		if _, err := progress.Write([]byte{'.'}); err != nil {
			failf("write progress: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
	os.Exit(0)
}

// TestValidateRequest covers all rejection branches and the success path.
func TestValidateRequest(t *testing.T) {
	stat := func(want bool, err error) func(string) (bool, error) {
		return func(string) (bool, error) { return want, err }
	}

	cases := []struct {
		name       string
		req        SearchRequest
		stat       func(string) (bool, error)
		wantStatus SearchStatus
		wantSubstr string
	}{
		{
			name:       "missing-request-id",
			req:        SearchRequest{Query: "x", Root: "/r"},
			stat:       stat(true, nil),
			wantStatus: StatusFailed,
			wantSubstr: "requestId",
		},
		{
			name:       "missing-query",
			req:        SearchRequest{RequestID: "1", Root: "/r"},
			stat:       stat(true, nil),
			wantStatus: StatusFailed,
			wantSubstr: "query",
		},
		{
			name:       "missing-root",
			req:        SearchRequest{RequestID: "1", Query: "x"},
			stat:       stat(true, nil),
			wantStatus: StatusFailed,
			wantSubstr: "root is required",
		},
		{
			name:       "relative-root",
			req:        SearchRequest{RequestID: "1", Query: "x", Root: "rel/path"},
			stat:       stat(true, nil),
			wantStatus: StatusFailed,
			wantSubstr: "absolute",
		},
		{
			name:       "stat-failure",
			req:        SearchRequest{RequestID: "1", Query: "x", Root: "/missing"},
			stat:       stat(false, errors.New("nope")),
			wantStatus: StatusFailed,
			wantSubstr: "unavailable",
		},
		{
			name:       "not-a-dir",
			req:        SearchRequest{RequestID: "1", Query: "x", Root: "/r"},
			stat:       stat(false, nil),
			wantStatus: StatusFailed,
			wantSubstr: "not a directory",
		},
		{
			name:       "ok",
			req:        SearchRequest{RequestID: "1", Query: "x", Root: "/r"},
			stat:       stat(true, nil),
			wantStatus: StatusSuccess,
			wantSubstr: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotStatus, gotMsg := validateRequest(tc.req, tc.stat)
			if gotStatus != tc.wantStatus {
				t.Errorf("status = %s, want %s", gotStatus, tc.wantStatus)
			}
			if tc.wantSubstr != "" && !strings.Contains(gotMsg, tc.wantSubstr) {
				t.Errorf("message %q does not contain %q", gotMsg, tc.wantSubstr)
			}
		})
	}
}
