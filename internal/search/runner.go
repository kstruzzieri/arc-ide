package search

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// rgLookup is the function used to resolve the ripgrep binary on PATH. It is
// a package variable solely so tests can swap in a deterministic stub. There
// is no fallback path or hard-coded alternate location: if rg is missing, the
// caller receives StatusMissingTool.
var rgLookup = exec.LookPath

// rgBinaryName is the program name we resolve via rgLookup. Tests override.
var rgBinaryName = "rg"

// runnerConfig holds per-run knobs. We keep it tiny so tests can construct
// configs inline without referencing unexported globals.
type runnerConfig struct {
	// MatchCap is the maximum number of LineMatch entries collected before
	// the runner stops appending and flags the response Truncated.
	MatchCap int
	// Timeout is the maximum wall-clock time a single rg run may take.
	Timeout time.Duration
}

// defaultRunnerConfig provides production defaults. They are referenced
// rather than copied into every call site so the values are easy to tune.
func defaultRunnerConfig() runnerConfig {
	return runnerConfig{
		MatchCap: 5000,
		Timeout:  30 * time.Second,
	}
}

// errInvalidRegex is returned by runRipgrep when rg exits with status 2
// and its stderr indicates a regex parse failure.
var errInvalidRegex = errors.New("invalid regular expression")

// errCanceled is returned when the supplied context is canceled before
// rg finishes. The caller maps it to StatusCanceled.
var errCanceled = errors.New("search canceled")

// isMissingTool reports whether err originated from exec.LookPath failing to
// find ripgrep on PATH. exec.LookPath returns an *exec.Error wrapping
// exec.ErrNotFound; we walk the chain via errors.Is.
func isMissingTool(err error) bool {
	return errors.Is(err, exec.ErrNotFound)
}

// buildArgs converts a SearchRequest into ripgrep arguments. It never
// concatenates the query into a flag value; --regexp is used to keep the
// query in its own argv slot so leading dashes and other patterns are not
// mistaken for flags.
//
// Order:
//  1. --no-config: ignore user-level ripgrep configuration so our flags are
//     authoritative.
//  2. --no-require-git: honor .gitignore / .ignore even when the search root
//     is not inside a Git repository. Firn IDE workspaces commonly target
//     plain folders; without this flag ripgrep silently disables ignore rules
//     for non-Git roots and surfaces files the user expects to be hidden.
//  3. --json, --line-number, --column, --color=never: stable parsing contract.
//  4. Mode flags: --fixed-strings, --case-sensitive/--ignore-case, --word-regexp.
//  5. --regexp <query>: query is its own argv element; leading "-" is safe.
//  6. -- <root>: end-of-options sentinel so paths starting with "-" are safe.
func buildArgs(req SearchRequest) []string {
	args := make([]string, 0, 15)
	args = append(args,
		// Ignore any user-level ripgrep config file so our explicit flags
		// are authoritative. Without this, a stray RIPGREP_CONFIG_PATH or
		// ~/.ripgreprc could change case behavior, ignore rules, etc.
		"--no-config",
		// Apply .gitignore / .ignore even outside a Git repo so workspaces
		// rooted at a plain folder still hide ignored files. Without this,
		// ripgrep requires the root to be inside a .git tree before it
		// honors any ignore rules at all.
		"--no-require-git",
		"--json",
		"--line-number",
		"--column",
		"--color", "never",
	)

	if !req.Options.Regex {
		args = append(args, "--fixed-strings")
	}
	if req.Options.CaseSensitive {
		args = append(args, "--case-sensitive")
	} else {
		args = append(args, "--ignore-case")
	}
	if req.Options.WholeWord {
		args = append(args, "--word-regexp")
	}

	args = append(args, "--regexp", req.Query)
	args = append(args, "--", req.Root)
	return args
}

// runOutcome captures the terminal state of one rg invocation.
type runOutcome struct {
	Truncated bool
	Err       error // typed: nil, errInvalidRegex, errCanceled, or wrapped failure
}

// runRipgrep executes ripgrep for req, streaming JSON events to onMatch via
// parseEvents. The function returns whether the result was truncated and an
// optional typed error. Exit code 1 is mapped to a successful empty run.
//
// The context owned by the caller controls cancelation. When ctx is canceled
// before rg finishes, runRipgrep returns errCanceled. Process group
// cleanup is delegated to exec.CommandContext + Wait; exec.CommandContext
// already kills the child process on context expiry on all supported OSes.
func runRipgrep(ctx context.Context, cfg runnerConfig, req SearchRequest, onMatch func(filePath string, m LineMatch) bool) runOutcome {
	bin, err := rgLookup(rgBinaryName)
	if err != nil {
		return runOutcome{Err: fmt.Errorf("ripgrep not found on PATH: %w", err)}
	}

	runCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, bin, buildArgs(req)...)
	// Intentionally do not set cmd.Dir: we always pass an absolute search
	// root as a positional argument, and ripgrep emits absolute paths in
	// that mode. Setting Dir would couple ripgrep's CWD to the search root
	// and could surprise downstream tooling that inspects relative paths.

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return runOutcome{Err: fmt.Errorf("create rg stdout pipe: %w", err)}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return runOutcome{Err: fmt.Errorf("create rg stderr pipe: %w", err)}
	}

	if err := cmd.Start(); err != nil {
		return runOutcome{Err: fmt.Errorf("start rg: %w", err)}
	}

	// Drain stderr concurrently so rg never blocks on a full pipe. We keep
	// the bytes for diagnostics in the failure path.
	stderrCh := make(chan []byte, 1)
	go func() {
		buf, _ := io.ReadAll(stderrPipe)
		stderrCh <- buf
	}()

	collected := 0
	truncated := false
	canceledAfterCap := false
	cancelAfterCap := func() {
		truncated = true
		canceledAfterCap = true
		cancel()
	}
	parseErr := parseEvents(stdout, func(filePath string, m LineMatch) bool {
		if collected >= cfg.MatchCap {
			cancelAfterCap()
			return false
		}
		collected++
		if !onMatch(filePath, m) {
			cancelAfterCap()
			return false
		}
		return true
	})

	// Always read remaining stdout so rg can exit cleanly even after we stop
	// collecting. parseEvents already drains via the scanner, but if it
	// returned early on a malformed line we need to copy the rest into the
	// void to unblock rg.
	_, _ = io.Copy(io.Discard, stdout)

	// Receive the drained stderr before Wait: Wait closes the pipe, and a
	// close racing the goroutine's ReadAll can drop stderr bytes we need for
	// the exit-code-2 regex classification below. Stdout is already at EOF
	// here, so the process has finished writing and this receive is bounded
	// by process exit (which the runCtx timeout in turn bounds).
	stderrBytes := <-stderrCh
	waitErr := cmd.Wait()

	// Cancelation outranks all other classifications. Check ctx (caller
	// cancel) and runCtx (timeout) separately so we can give a precise
	// message later if needed.
	if ctxErr := ctx.Err(); ctxErr != nil {
		return runOutcome{Truncated: truncated, Err: errCanceled}
	}

	if canceledAfterCap {
		return runOutcome{Truncated: true}
	}

	if waitErr == nil {
		// Exit code 0: matches found. parseErr (if any) is a real failure.
		if parseErr != nil {
			return runOutcome{Truncated: truncated, Err: fmt.Errorf("parse rg output: %w", parseErr)}
		}
		return runOutcome{Truncated: truncated}
	}

	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		switch exitErr.ExitCode() {
		case 1:
			// Successful empty run. parseErr should be nil but if it isn't,
			// the JSON stream was malformed which is a real failure.
			if parseErr != nil {
				return runOutcome{Truncated: truncated, Err: fmt.Errorf("parse rg output: %w", parseErr)}
			}
			return runOutcome{}
		case 2:
			msg := classifyStderr(stderrBytes)
			if isRegexError(stderrBytes) {
				return runOutcome{Err: fmt.Errorf("%w: %s", errInvalidRegex, msg)}
			}
			return runOutcome{Err: fmt.Errorf("ripgrep failed: %s", msg)}
		default:
			// Negative exit code on Unix indicates the process was signaled
			// (for example by context cancelation killing it). If runCtx is
			// done due to deadline we report a timeout-shaped failure; if
			// the parent ctx is already canceled we returned earlier.
			if runCtx.Err() != nil && ctx.Err() == nil {
				return runOutcome{Truncated: truncated, Err: fmt.Errorf("ripgrep timed out after %s", cfg.Timeout)}
			}
			return runOutcome{Truncated: truncated, Err: fmt.Errorf("ripgrep exited with code %d: %s", exitErr.ExitCode(), classifyStderr(stderrBytes))}
		}
	}

	// Non-ExitError waitErr typically means the process could not be reaped
	// or was killed before producing an exit status.
	return runOutcome{Truncated: truncated, Err: fmt.Errorf("ripgrep wait failed: %w (%s)", waitErr, classifyStderr(stderrBytes))}
}

// classifyStderr returns a single-line, trimmed version of stderr suitable
// for surfacing in error messages. Multi-line stderr is collapsed to its
// first non-empty line so the user sees the headline cause.
func classifyStderr(b []byte) string {
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "no stderr output"
	}
	if first, _, found := strings.Cut(s, "\n"); found {
		first = strings.TrimSpace(first)
		if first != "" {
			return first
		}
	}
	return s
}

// isRegexError detects ripgrep's pattern-rejection stderr signatures.
// ripgrep prints messages such as "regex parse error:" or "error parsing
// regex" when the supplied pattern is invalid, and refuses literal newlines
// in patterns ("the literal \n is not allowed in a regex"). We treat all of
// these as invalid-regex/invalid-pattern conditions so the UI can ask the
// user to adjust the query rather than reporting a generic failure. We
// match stable substrings to stay robust across ripgrep versions.
func isRegexError(stderr []byte) bool {
	s := strings.ToLower(string(stderr))
	return strings.Contains(s, "regex parse error") ||
		strings.Contains(s, "error parsing regex") ||
		strings.Contains(s, "unrecognized escape sequence") ||
		strings.Contains(s, "invalid character class") ||
		strings.Contains(s, "not allowed in a regex")
}

// validateRequest enforces the contract documented on SearchRequest. It
// returns a typed status (StatusInvalidRegex is reserved for ripgrep itself;
// validation here covers structural problems before we even spawn rg) and
// an error message safe to forward to the user.
func validateRequest(req SearchRequest, statRoot func(string) (isDir bool, err error)) (SearchStatus, string) {
	if strings.TrimSpace(req.RequestID) == "" {
		return StatusFailed, "requestId is required"
	}
	if req.Query == "" {
		return StatusFailed, "query is required"
	}
	if strings.TrimSpace(req.Root) == "" {
		return StatusFailed, "search root is required"
	}
	if !filepath.IsAbs(req.Root) {
		return StatusFailed, "search root must be an absolute path"
	}
	isDir, err := statRoot(req.Root)
	if err != nil {
		return StatusFailed, fmt.Sprintf("search root unavailable: %s", err.Error())
	}
	if !isDir {
		return StatusFailed, "search root is not a directory"
	}
	return StatusSuccess, ""
}
