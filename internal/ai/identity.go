package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"firn/internal/filesystem"
	"firn/internal/workspace"
)

// ErrWorkspaceUnavailable wraps repository-root and workspace-detection
// failures: the repository cannot be bound at all. The raw cause is retained
// in the chain for host logging (and may carry absolute paths); callers must
// match the sentinel, never the text.
var ErrWorkspaceUnavailable = errors.New("golem workspace unavailable")

// ErrRequestRejected wraps stale/invalid request identities and
// workspace-selection failures against a live binding. The raw cause is
// retained in the chain for host logging; callers must match the sentinel,
// never the text.
var ErrRequestRejected = errors.New("golem request rejected")

// binding is one incarnation of a bound repository.
type binding struct {
	identity RepositoryIdentity
	repoRoot string // canonical
	defs     map[string]workspace.WorkspaceDef
}

// Bindings is the process-wide authority for which repository is bound and
// which epoch is current. All request identities are validated against it.
type Bindings struct {
	fs        filesystem.FileSystem
	mu        sync.Mutex
	nextEpoch uint64 // monotonic for the process lifetime; never reset
	current   *binding
}

// NewBindings returns an empty Bindings backed by fsys. fsys must view the
// real filesystem: canonicalization (filepath.Abs/EvalSymlinks) is OS-level,
// so a virtual fsys would disagree with the canonical roots derived here.
func NewBindings(fsys filesystem.FileSystem) *Bindings {
	return &Bindings{fs: fsys}
}

// Bind canonicalizes repoPath, detects its workspaces, and makes it the
// current binding. Rebinding the same canonical root is an idempotent refresh
// that keeps the epoch; any other transition allocates a new epoch.
//
// Detection runs outside the lock, so two concurrent same-root refreshes may
// publish defs out of order (same epoch either way; self-heals on the next
// refresh).
func (b *Bindings) Bind(repoPath string) (RepositoryIdentity, error) {
	abs, err := filepath.Abs(repoPath)
	if err != nil {
		return RepositoryIdentity{}, fmt.Errorf("%w: resolving %q: %w", ErrWorkspaceUnavailable, repoPath, err)
	}
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return RepositoryIdentity{}, fmt.Errorf("%w: canonicalizing %q: %w", ErrWorkspaceUnavailable, repoPath, err)
	}
	info, err := b.fs.Stat(root)
	if err != nil {
		return RepositoryIdentity{}, fmt.Errorf("%w: stat %q: %w", ErrWorkspaceUnavailable, repoPath, err)
	}
	if !info.IsDir() {
		return RepositoryIdentity{}, fmt.Errorf("%w: %q is not a directory", ErrWorkspaceUnavailable, repoPath)
	}
	defs, err := workspace.DetectWorkspaces(b.fs, root)
	if err != nil {
		return RepositoryIdentity{}, fmt.Errorf("%w: detecting workspaces: %w", ErrWorkspaceUnavailable, err)
	}
	byID := make(map[string]workspace.WorkspaceDef, len(defs))
	for _, def := range defs {
		// First-wins: DetectWorkspaces emits the synthetic "project" def first,
		// so a subdirectory literally named "project" cannot shadow it.
		if _, ok := byID[def.ID]; !ok {
			byID[def.ID] = def
		}
	}

	key := sha256.Sum256([]byte(root))

	b.mu.Lock()
	defer b.mu.Unlock()
	var identity RepositoryIdentity
	if b.current != nil && b.current.repoRoot == root {
		identity = b.current.identity // idempotent refresh, same incarnation
	} else {
		b.nextEpoch++
		identity = RepositoryIdentity{RepoKey: hex.EncodeToString(key[:]), RepoEpoch: b.nextEpoch}
	}
	// Always publish a fresh binding: Resolve snapshots b.current and reads it
	// after unlocking, so a published binding must never be mutated.
	b.current = &binding{identity: identity, repoRoot: root, defs: byID}
	return identity, nil
}

// Unbind drops the current binding. The next Bind allocates a new epoch.
func (b *Bindings) Unbind() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.current = nil
}

// Current returns the current repository identity, if any.
func (b *Bindings) Current() (RepositoryIdentity, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.current == nil {
		return RepositoryIdentity{}, false
	}
	return b.current.identity, true
}

// Resolve validates a request identity against the current binding and
// returns the workspace with its canonical, repo-contained tool root.
func (b *Bindings) Resolve(repoEpoch uint64, workspaceID string) (ResolvedWorkspace, error) {
	b.mu.Lock()
	cur := b.current
	b.mu.Unlock()
	if cur == nil {
		return ResolvedWorkspace{}, fmt.Errorf("%w: no repository bound", ErrWorkspaceUnavailable)
	}
	if repoEpoch == 0 || repoEpoch != cur.identity.RepoEpoch {
		return ResolvedWorkspace{}, fmt.Errorf("%w: epoch %d is not current epoch %d", ErrRequestRejected, repoEpoch, cur.identity.RepoEpoch)
	}
	def, ok := cur.defs[workspaceID]
	if !ok {
		return ResolvedWorkspace{}, fmt.Errorf("%w: unknown workspace %q", ErrRequestRejected, workspaceID)
	}
	toolRoot, workspaceRel, err := toolRootFor(cur.repoRoot, def.RelDir)
	if err != nil {
		return ResolvedWorkspace{}, err
	}
	workspaceLexicalRel := def.RelDir
	if workspaceLexicalRel == workspaceRel {
		workspaceLexicalRel = ""
	}
	return ResolvedWorkspace{
		RepositoryIdentity:  cur.identity,
		WorkspaceID:         def.ID,
		WorkspaceName:       def.Name,
		WorkspaceRel:        workspaceRel,
		workspaceLexicalRel: workspaceLexicalRel,
		RepoRoot:            cur.repoRoot,
		ToolRoot:            toolRoot,
	}, nil
}

// toolRootFor canonicalizes repoRoot+relDir at request time, rejects any result
// that escapes the canonical repo root, and returns the canonical repo-relative
// slash prefix the scope policy must evaluate.
func toolRootFor(repoRoot, relDir string) (string, string, error) {
	if relDir == "" {
		return repoRoot, "", nil
	}
	toolRoot, err := filepath.EvalSymlinks(filepath.Join(repoRoot, filepath.FromSlash(relDir)))
	if err != nil {
		return "", "", fmt.Errorf("%w: canonicalizing workspace %q: %w", ErrRequestRejected, relDir, err)
	}
	rel, err := filepath.Rel(repoRoot, toolRoot)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("%w: workspace %q resolves outside the repository", ErrRequestRejected, relDir)
	}
	return toolRoot, filepath.ToSlash(rel), nil
}

// ConversationID derives the stable conversation ID for a workspace within a
// canonical repository. The epoch is deliberately excluded so a session store
// can restore the conversation after a rebind; NUL keeps the repoKey and
// workspaceID unambiguous.
func ConversationID(repoKey, workspaceID string) string {
	sum := sha256.Sum256([]byte(repoKey + "\x00" + workspaceID))
	return "golem-" + hex.EncodeToString(sum[:])
}
