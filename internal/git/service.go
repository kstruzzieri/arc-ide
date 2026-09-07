package git

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Service runs git operations by shelling out to the user's git binary, so
// their existing credential helpers, SSH agents, and hooks keep working.
type Service struct{}

// scrubGitEnv drops the repository-local GIT_* variables Git exports to hooks
// (and that hooks re-export to their children). Left in place, an inherited
// GIT_DIR/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/etc. overrides cmd.Dir and
// redirects the operation into whatever repository the parent was pointed at.
// The set mirrors Git's own repository-local env (`git rev-parse
// --local-env-vars`): these are exactly the variables Git treats as
// repository-scoped and refuses to leak into submodules, so scrubbing the same
// set is the root-cause fix rather than patching the one variable that happened
// to bite us. Returns a fresh slice; the input is never mutated.
func scrubGitEnv(env []string) []string {
	clean := make([]string, 0, len(env))
	for _, variable := range env {
		name, _, _ := strings.Cut(variable, "=")
		switch name {
		case "GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_IMPLICIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_COMMON_DIR",
			"GIT_PREFIX",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_GRAFT_FILE",
			"GIT_SHALLOW_FILE",
			"GIT_NAMESPACE",
			"GIT_NO_REPLACE_OBJECTS",
			"GIT_REPLACE_REF_BASE",
			"GIT_CONFIG",
			"GIT_CONFIG_PARAMETERS",
			"GIT_CONFIG_COUNT",
			"GIT_INTERNAL_SUPER_PREFIX":
			continue
		}
		clean = append(clean, variable)
	}
	return clean
}

// NewService returns a Service. It does not verify git is installed; Status
// reports IsRepo=false when git is missing, and operations surface the error.
func NewService() *Service {
	return &Service{}
}

// run executes git with args in dir. GIT_TERMINAL_PROMPT=0 turns interactive
// credential prompts into immediate errors (a desktop app has no terminal to
// answer them); LC_ALL=C pins parseable English output.
func (s *Service) run(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(scrubGitEnv(os.Environ()), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), fmt.Errorf("git %s: %s", args[0], msg)
	}
	return stdout.String(), nil
}

// Status returns the repository snapshot for the repo containing dir.
// A missing git binary or a dir outside any repo yields IsRepo=false, nil.
func (s *Service) Status(ctx context.Context, dir string) (RepoStatus, error) {
	root, err := s.run(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		// --show-toplevel needs a working tree. If the directory is still a
		// git dir (e.g. a normal repo wrongly marked core.bare=true), say so
		// with a fix rather than reporting "not a git repository".
		if _, gitErr := s.run(ctx, dir, "rev-parse", "--git-dir"); gitErr == nil {
			return RepoStatus{
				Files:  []FileChange{},
				Detail: "This git repository has no working tree (core.bare=true). Fix it with: git config core.bare false",
			}, nil
		}
		return RepoStatus{Files: []FileChange{}}, nil
	}

	out, err := s.run(ctx, dir, "status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z")
	if err != nil {
		return RepoStatus{}, err
	}

	status := parsePorcelainV2([]byte(out))
	status.IsRepo = true
	status.RepoRoot = strings.TrimSpace(root)
	return status, nil
}

// Stage adds the given repo-root-relative paths to the index.
func (s *Service) Stage(ctx context.Context, dir string, paths []string) error {
	if err := validateRepoRelPaths(paths); err != nil {
		return err
	}
	_, err := s.runAtRoot(ctx, dir, append([]string{literalPathspecs, "add", "--"}, paths...)...)
	return err
}

// IntentToAdd records untracked paths in the index as empty blobs
// (git add --intent-to-add): the files become tracked and diffable while
// their content stays unstaged, enabling later hunk-by-hunk staging.
func (s *Service) IntentToAdd(ctx context.Context, dir string, paths []string) error {
	if err := validateRepoRelPaths(paths); err != nil {
		return err
	}
	_, err := s.runAtRoot(ctx, dir, append([]string{"add", "--intent-to-add", "--"}, paths...)...)
	return err
}

// Unstage removes paths from the index. On an unborn HEAD (no commits yet)
// `restore --staged` cannot resolve HEAD, so fall back to rm --cached.
func (s *Service) Unstage(ctx context.Context, dir string, paths []string) error {
	if err := validateRepoRelPaths(paths); err != nil {
		return err
	}
	if _, err := s.run(ctx, dir, "rev-parse", "--verify", "HEAD"); err != nil {
		_, err := s.runAtRoot(ctx, dir, append([]string{"rm", "--cached", "-r", "--"}, paths...)...)
		return err
	}
	_, err := s.runAtRoot(ctx, dir, append([]string{"restore", "--staged", "--"}, paths...)...)
	return err
}

// Commit records staged changes. With amend, the previous commit is replaced.
// Returns git's summary output for display.
func (s *Service) Commit(ctx context.Context, dir, message string, amend bool) (string, error) {
	args := []string{"commit", "-m", message}
	if amend {
		args = append(args, "--amend")
	}
	return s.run(ctx, dir, args...)
}

// Pull fetches and integrates the upstream branch. Conflict and divergence
// errors are returned verbatim from git for the UI to display.
func (s *Service) Pull(ctx context.Context, dir string) (string, error) {
	return s.run(ctx, dir, "pull")
}

// Push publishes the current branch. When it has no upstream yet, the branch
// is pushed with -u to origin so subsequent pushes and ahead/behind work.
func (s *Service) Push(ctx context.Context, dir string) (string, error) {
	if _, err := s.run(ctx, dir, "rev-parse", "--abbrev-ref", "@{upstream}"); err != nil {
		return s.run(ctx, dir, "push", "-u", "origin", "HEAD")
	}
	return s.run(ctx, dir, "push")
}

// Branches lists local branch names.
func (s *Service) Branches(ctx context.Context, dir string) ([]string, error) {
	out, err := s.run(ctx, dir, "branch", "--list", "--format=%(refname:short)")
	if err != nil {
		return nil, err
	}
	var branches []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			branches = append(branches, line)
		}
	}
	return branches, nil
}

// Checkout switches to branch, creating it from the current HEAD when create
// is set. Overwrite errors (dirty conflicting files) surface verbatim.
func (s *Service) Checkout(ctx context.Context, dir, branch string, create bool) error {
	args := []string{"checkout"}
	if create {
		args = append(args, "-b")
	}
	args = append(args, branch)
	_, err := s.run(ctx, dir, args...)
	return err
}

// maxDiffableBytes caps content shipped over the bindings bridge for diffs.
// Beyond this the UI renders a "diff too large" state instead of a merge view.
const maxDiffableBytes = 1 << 20 // 1MB

// FileContent is file content at a revision, with the states the diff UI must
// special-case: binary files and files past the diffable size cap ship no
// content at all — the flags alone drive the UI.
type FileContent struct {
	Content   string `json:"content"`
	Binary    bool   `json:"binary"`
	Truncated bool   `json:"truncated"`
}

// FileAtRev returns the content of a repo-root-relative path at rev ("HEAD",
// ":0" for the index). A path that does not exist at rev returns empty content
// so new files diff against empty.
func (s *Service) FileAtRev(ctx context.Context, dir, rev, path string) (FileContent, error) {
	if err := validateRev(rev); err != nil {
		return FileContent{}, err
	}
	if err := validateRepoRelPaths([]string{path}); err != nil {
		return FileContent{}, err
	}
	out, err := s.runAtRoot(ctx, dir, "show", rev+":"+path)
	if err != nil {
		if strings.Contains(err.Error(), "does not exist") ||
			strings.Contains(err.Error(), "exists on disk, but not in") ||
			strings.Contains(err.Error(), "but not at stage") ||
			strings.Contains(err.Error(), "invalid object name 'HEAD'") {
			return FileContent{}, nil
		}
		return FileContent{}, err
	}
	if isBinary(out) {
		return FileContent{Binary: true}, nil
	}
	if len(out) > maxDiffableBytes {
		return FileContent{Truncated: true}, nil
	}
	return FileContent{Content: out}, nil
}

// isBinary mirrors git's own heuristic: a NUL byte in the first 8000 bytes.
func isBinary(content string) bool {
	probe := content
	if len(probe) > 8000 {
		probe = probe[:8000]
	}
	return strings.ContainsRune(probe, 0)
}

// StagedDiff returns the unified diff of the index against HEAD, used as
// input for commit-message generation.
func (s *Service) StagedDiff(ctx context.Context, dir string) (string, error) {
	return s.run(ctx, dir, "diff", "--cached")
}

// runAtRoot runs git from the repo top-level, so repo-root-relative path
// arguments (the porcelain contract) resolve even when dir is a subdirectory.
func (s *Service) runAtRoot(ctx context.Context, dir string, args ...string) (string, error) {
	root := dir
	if out, err := s.run(ctx, dir, "rev-parse", "--show-toplevel"); err == nil {
		root = strings.TrimSpace(out)
	}
	return s.run(ctx, root, args...)
}
