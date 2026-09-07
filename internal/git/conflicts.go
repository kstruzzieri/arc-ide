package git

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"firn/internal/filesystem"
)

// ConflictSnapshot is the single, atomic read of a conflicted working-tree
// file: the exact bytes the frontend displays plus the regions parsed from
// those same bytes. Parsing regions from the same read the UI renders closes
// the window where an external write between two reads would leave region
// coordinates pointing at different content. Encoding/LineEndings mirror
// filesystem.FileContent so the frontend can persist the resolved file without
// a lossy round-trip.
type ConflictSnapshot struct {
	Content     string           `json:"content"`
	Encoding    string           `json:"encoding"`
	LineEndings string           `json:"lineEndings"`
	Regions     []ConflictRegion `json:"regions"`
}

// ConflictSnapshot reads the conflicted file at a repo-root-relative path once
// and parses its conflict regions. dir may be a nested workspace inside the
// repo, so the path is resolved against the repository top-level (porcelain
// paths are always repo-root-relative). Binary files and files past the
// diffable size cap are refused with an error — the resolution surface only
// handles text, and the caller falls back to the plain conflict playbook.
func (s *Service) ConflictSnapshot(ctx context.Context, dir, path string) (ConflictSnapshot, error) {
	if err := validateRepoRelPaths([]string{path}); err != nil {
		return ConflictSnapshot{}, err
	}
	root, err := s.repoRoot(ctx, dir)
	if err != nil {
		return ConflictSnapshot{}, err
	}
	abs := filepath.Join(root, filepath.FromSlash(path))

	// Containment: the fully symlink-resolved path must stay under the
	// symlink-resolved repo root, so a crafted path through an in-repo
	// directory symlink (which git never emits but a tampered binding could
	// send) cannot read outside the repository.
	if err := verifyUnderRoot(root, abs); err != nil {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: %w", path, err)
	}
	// Lstat before reading: reject a final-component symlink (ReadFileWithMetadata
	// would follow it) and enforce the size cap on the raw file before decoding
	// a huge file into memory. A small TOCTOU window remains before the read;
	// acceptable for a single-user local IDE reading its own working tree.
	info, err := os.Lstat(abs)
	if err != nil {
		return ConflictSnapshot{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: path is a symlink", path)
	}
	if info.Size() > maxDiffableBytes {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: file is too large (%d bytes)", path, info.Size())
	}

	reader := filesystem.NewFileReader(filesystem.NewOS())
	fc, err := reader.ReadFileWithMetadata(abs)
	if err != nil {
		return ConflictSnapshot{}, err
	}
	if fc.IsBinary {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: file is binary", path)
	}
	if binary, err := s.binaryMergeAttribute(ctx, dir, path); err != nil {
		return ConflictSnapshot{}, err
	} else if binary {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: git attributes require binary merging", path)
	}

	regions, err := parseConflictRegions(fc.Content, s.conflictMarkerSize(ctx, dir, path))
	if err != nil {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: %w", path, err)
	}
	// Git adds conflict markers around the merge hunks; it does NOT widen them
	// to avoid colliding with marker-shaped lines already in the file's content.
	// So a file whose unchanged content contains a literal conflict example
	// produces a region the parser cannot distinguish from a real one. A real
	// region's opening marker is git-added and never appears in a stage blob; a
	// spurious one is content and does. If any region's opener is found in a
	// stage, refuse and fall back rather than surface a region that, if
	// "resolved", would corrupt unchanged text.
	if len(regions) > 0 {
		stages, err := s.ConflictStages(ctx, dir, path)
		if err != nil {
			return ConflictSnapshot{}, err
		}
		spurious, err := s.regionMarkersInStages(ctx, dir, path, fc.Content, fc.Encoding, regions, stages)
		if err != nil {
			return ConflictSnapshot{}, err
		}
		if spurious {
			return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: file content contains literal conflict markers", path)
		}
	}
	return ConflictSnapshot{
		Content:     fc.Content,
		Encoding:    fc.Encoding,
		LineEndings: fc.LineEndings,
		Regions:     regions,
	}, nil
}

// ConflictState is one coherent read of everything a merge-resolution session
// depends on: which index stages exist, the text snapshot when the conflict is
// text-mergeable, the operation heads that give Current/Incoming their meaning,
// and an opaque SourceVersion covering all of it plus the raw working-tree
// bytes.
//
// SourceVersion exists because a filesystem watcher is a hint, not an
// authority: an event can be missed, coalesced, or arrive late, and a merge
// session that trusted it would happily overwrite a change it never saw. Every
// mutation therefore carries the version the user actually reviewed, and the
// backend re-derives the version inside the same call as the mutation.
//
// Snapshot is nil when the stage topology calls for the whole-file side UI (a
// binary conflict, or a delete/modify where one side has no blob) and when the
// path is no longer conflicted at all. Heads is nil only when there are no
// conflict stages, so "resolved outside Firn" can be detected without
// depending on operation metadata that may already be gone.
type ConflictState struct {
	Stages        ConflictStages    `json:"stages"`
	Snapshot      *ConflictSnapshot `json:"snapshot,omitempty"`
	Heads         *MergeHeads       `json:"heads,omitempty"`
	SourceVersion string            `json:"sourceVersion"`
}

// ConflictGuardResult reports the outcome of a guarded conflict mutation.
// Applied=false is the ordinary "someone else changed the file" outcome and
// mutates nothing; SourceVersion always carries the live version so the caller
// can re-read or re-confirm. Operational failures are returned as errors
// instead, so a caller never has to parse error text to tell a race from a
// broken repository.
type ConflictGuardResult struct {
	Applied       bool   `json:"applied"`
	SourceVersion string `json:"sourceVersion"`
}

// conflictSignature is the cheap identity of everything the source version
// covers except the working-tree bytes themselves. Reading it before and after
// the byte read is what makes a ConflictState coherent: if any of it moved, the
// bytes and the metadata may describe different moments.
type conflictSignature struct {
	stages ConflictStages
	heads  *MergeHeads
	// info is nil when the working-tree path is absent, which is a legitimate
	// state (a delete/modify side, or a file the user removed).
	info os.FileInfo
}

// ConflictState reads the conflicted path's stages, heads, and (for a text
// conflict) its snapshot in one coherent pass, and returns the source version
// that identifies exactly that state.
func (s *Service) ConflictState(ctx context.Context, dir, path string) (ConflictState, error) {
	return s.conflictState(ctx, dir, path, true)
}

func (s *Service) conflictState(ctx context.Context, dir, path string, withSnapshot bool) (ConflictState, error) {
	if err := validateRepoRelPaths([]string{path}); err != nil {
		return ConflictState{}, err
	}
	root, err := s.repoRoot(ctx, dir)
	if err != nil {
		return ConflictState{}, err
	}
	abs := filepath.Join(root, filepath.FromSlash(path))

	// One retry absorbs an ordinary concurrent save. A state that keeps moving
	// fails closed rather than returning a version that describes neither read:
	// a version nobody can reproduce would refuse every later mutation anyway,
	// and an incoherent one could authorize the wrong write.
	for attempt := 0; attempt < 2; attempt++ {
		before, err := s.conflictSignature(ctx, dir, path, abs)
		if err != nil {
			return ConflictState{}, err
		}
		state, err := s.readConflictState(ctx, dir, root, abs, path, before, withSnapshot)
		if err != nil {
			return ConflictState{}, err
		}
		after, err := s.conflictSignature(ctx, dir, path, abs)
		if err != nil {
			return ConflictState{}, err
		}
		if sameConflictSignature(before, after) {
			return state, nil
		}
	}
	return ConflictState{}, fmt.Errorf("cannot resolve %s: its conflict state kept changing while it was read", path)
}

// conflictSignature reads the index stages, the operation heads (only while the
// path is actually conflicted), and the working-tree path's Lstat identity.
func (s *Service) conflictSignature(ctx context.Context, dir, path, abs string) (conflictSignature, error) {
	stages, err := s.ConflictStages(ctx, dir, path)
	if err != nil {
		return conflictSignature{}, err
	}
	sig := conflictSignature{stages: stages}
	if conflictStagesPresent(stages) {
		// Stages exist, so an operation must be in progress. Missing or
		// unreadable heads means this read is not coherent, not that the
		// conflict has no sides.
		heads, err := s.MergeHeads(ctx, dir)
		if err != nil {
			return conflictSignature{}, fmt.Errorf("cannot resolve %s: %w", path, err)
		}
		sig.heads = &heads
	}
	info, err := os.Lstat(abs)
	switch {
	case err == nil:
		sig.info = info
	case os.IsNotExist(err):
		// Absent is a real state, not a failure.
	default:
		return conflictSignature{}, err
	}
	return sig, nil
}

// readConflictState hashes the working-tree bytes and, for a text conflict,
// decodes and parses the snapshot from those exact bytes.
func (s *Service) readConflictState(
	ctx context.Context,
	dir, root, abs, path string,
	sig conflictSignature,
	withSnapshot bool,
) (ConflictState, error) {
	state := ConflictState{Stages: sig.stages, Heads: sig.heads}
	// A text session needs both sides in the index and a mergeable (non-binary)
	// file; anything else is resolved through the whole-file side UI.
	wantsText := conflictStagesPresent(sig.stages) &&
		!sig.stages.Binary && sig.stages.Ours != nil && sig.stages.Theirs != nil

	worktreeDigest := ""
	var raw []byte
	if sig.info != nil {
		// Containment: the fully symlink-resolved path must stay under the
		// symlink-resolved repo root, so a crafted path through an in-repo
		// directory symlink cannot read outside the repository.
		if err := verifyUnderRoot(root, abs); err != nil {
			return ConflictState{}, fmt.Errorf("cannot resolve %s: %w", path, err)
		}
		// Only an absent or regular path is representable: a symlink or
		// directory in place of the conflicted file means something else owns
		// that name, and both the snapshot and the side apply must refuse it.
		if sig.info.Mode()&os.ModeSymlink != 0 {
			return ConflictState{}, fmt.Errorf("cannot resolve %s: path is a symlink", path)
		}
		if !sig.info.Mode().IsRegular() {
			return ConflictState{}, fmt.Errorf("cannot resolve %s: path is not a regular file", path)
		}

		var err error
		raw, worktreeDigest, err = hashWorktreeFile(abs, sig.info.Size())
		if err != nil {
			return ConflictState{}, err
		}
	} else if wantsText && withSnapshot {
		// The index still describes a text conflict, so degrading to the
		// whole-file UI would silently change what the user is deciding.
		return ConflictState{}, fmt.Errorf("cannot resolve %s: the working-tree file is missing", path)
	}

	if wantsText && withSnapshot {
		if raw == nil {
			return ConflictState{}, fmt.Errorf("cannot resolve %s: file is too large (%d bytes)", path, sig.info.Size())
		}
		snapshot, err := s.snapshotFromBytes(ctx, dir, path, raw, sig.stages)
		if err != nil {
			return ConflictState{}, err
		}
		state.Snapshot = &snapshot
	}

	state.SourceVersion = conflictSourceVersion(root, path, sig, worktreeDigest)
	return state, nil
}

// snapshotFromBytes decodes and parses a conflict snapshot from the exact bytes
// the source version was computed over, so the displayed content and the
// guarded version can never describe different reads.
func (s *Service) snapshotFromBytes(
	ctx context.Context,
	dir, path string,
	raw []byte,
	stages ConflictStages,
) (ConflictSnapshot, error) {
	fc := filesystem.NewFileReader(filesystem.NewOS()).DecodeBytes(raw)
	if fc.IsBinary {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: file is binary", path)
	}
	regions, err := parseConflictRegions(fc.Content, s.conflictMarkerSize(ctx, dir, path))
	if err != nil {
		return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: %w", path, err)
	}
	// A file whose own content contains marker-shaped lines produces a region
	// the parser cannot distinguish from a real one; resolving it would corrupt
	// unchanged text. See ConflictSnapshot for the full reasoning.
	if len(regions) > 0 {
		spurious, err := s.regionMarkersInStages(ctx, dir, path, fc.Content, fc.Encoding, regions, stages)
		if err != nil {
			return ConflictSnapshot{}, err
		}
		if spurious {
			return ConflictSnapshot{}, fmt.Errorf("cannot resolve %s: file content contains literal conflict markers", path)
		}
	}
	return ConflictSnapshot{
		Content:     fc.Content,
		Encoding:    fc.Encoding,
		LineEndings: fc.LineEndings,
		Regions:     regions,
	}, nil
}

// hashWorktreeFile returns the file's raw bytes (only when it is within the
// text cap) and the hex SHA-256 of those bytes. A file past the cap is streamed
// into the hash and its bytes are dropped: a binary conflict's identity still
// matters for the guard, but its content must never cross the Wails bridge.
func hashWorktreeFile(abs string, size int64) ([]byte, string, error) {
	if size <= maxDiffableBytes {
		raw, err := os.ReadFile(abs)
		if err != nil {
			return nil, "", err
		}
		sum := sha256.Sum256(raw)
		return raw, hex.EncodeToString(sum[:]), nil
	}
	file, err := os.Open(abs)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = file.Close() }()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return nil, "", err
	}
	return nil, hex.EncodeToString(digest.Sum(nil)), nil
}

// conflictSourceVersion hashes every input that gives the conflict its meaning.
// Each field is framed with a tag and a byte length so no combination of values
// can be reassembled into the same input stream as a different state.
func conflictSourceVersion(root, path string, sig conflictSignature, worktreeDigest string) string {
	digest := sha256.New()
	hashField(digest, "root", root)
	hashField(digest, "path", path)
	if sig.heads != nil {
		hashField(digest, "operation", sig.heads.Operation)
		hashField(digest, "ours-head", sig.heads.Ours.Hash)
		hashField(digest, "theirs-head", sig.heads.Theirs.Hash)
	} else {
		hashField(digest, "no-operation", "")
	}
	hashField(digest, "binary-merge", strconv.FormatBool(sig.stages.Binary))
	for _, stage := range []struct {
		number string
		blob   *StageBlob
	}{{"1", sig.stages.Base}, {"2", sig.stages.Ours}, {"3", sig.stages.Theirs}} {
		if stage.blob == nil {
			hashField(digest, "stage-"+stage.number+"-absent", "")
			continue
		}
		hashField(digest, "stage-"+stage.number,
			stage.blob.Mode+" "+stage.blob.Hash+" "+strconv.FormatInt(stage.blob.Size, 10))
	}
	if sig.info == nil {
		hashField(digest, "worktree-absent", "")
	} else {
		hashField(digest, "worktree-type", sig.info.Mode().Type().String())
		hashField(digest, "worktree-perm", sig.info.Mode().Perm().String())
		hashField(digest, "worktree-bytes", worktreeDigest)
	}
	return "v1:" + hex.EncodeToString(digest.Sum(nil))
}

func hashField(digest hash.Hash, tag, value string) {
	_, _ = fmt.Fprintf(digest, "%s:%d:", tag, len(value))
	_, _ = digest.Write([]byte(value))
	_, _ = digest.Write([]byte{0})
}

func conflictStagesPresent(stages ConflictStages) bool {
	return stages.Base != nil || stages.Ours != nil || stages.Theirs != nil
}

func sameConflictSignature(a, b conflictSignature) bool {
	if !sameStageBlob(a.stages.Base, b.stages.Base) ||
		!sameStageBlob(a.stages.Ours, b.stages.Ours) ||
		!sameStageBlob(a.stages.Theirs, b.stages.Theirs) ||
		a.stages.Binary != b.stages.Binary {
		return false
	}
	if (a.heads == nil) != (b.heads == nil) {
		return false
	}
	if a.heads != nil && (a.heads.Operation != b.heads.Operation ||
		a.heads.Ours.Hash != b.heads.Ours.Hash ||
		a.heads.Theirs.Hash != b.heads.Theirs.Hash) {
		return false
	}
	if (a.info == nil) != (b.info == nil) {
		return false
	}
	if a.info == nil {
		return true
	}
	// Identity as well as size/mtime: a file replaced by a symlink or a
	// same-length rewrite within the timestamp granularity would otherwise look
	// unchanged.
	return os.SameFile(a.info, b.info) &&
		a.info.Mode() == b.info.Mode() &&
		a.info.Size() == b.info.Size() &&
		a.info.ModTime().Equal(b.info.ModTime())
}

func sameStageBlob(a, b *StageBlob) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Hash == b.Hash && a.Mode == b.Mode && a.Size == b.Size
}

// writableConflictFormat mirrors the frontend's writable whitelist
// (utils/fileWrites.ts): FileWriter silently re-encodes anything outside it, so
// a guarded write refuses rather than performing a lossy write.
func writableConflictFormat(encoding, lineEndings string) bool {
	switch encoding {
	case "utf-8", "utf-8-bom", "utf-16le", "utf-16be":
	default:
		return false
	}
	switch lineEndings {
	case "lf", "crlf", "none":
		return true
	default:
		return false
	}
}

// guardedConflictMutation is the whole point of the source version: read the
// coherent state, refuse unless it is exactly the state the caller reviewed,
// and only then mutate — all inside one backend call, so nothing can slip
// between the comparison and the write.
//
// Portability ceiling: this closes the window against Firn's own surfaces and
// against any process that honors the same per-path lock. An uncooperative
// external process can still win the final syscall. That is the strongest
// practical guarantee available with the standard library, not a filesystem
// compare-and-swap.
func (s *Service) guardedConflictMutation(
	ctx context.Context,
	dir, path, expectedSourceVersion string,
	withSnapshot bool,
	mutate func(state ConflictState, root, abs string) error,
) (ConflictGuardResult, error) {
	if err := validateRepoRelPaths([]string{path}); err != nil {
		return ConflictGuardResult{}, err
	}
	if expectedSourceVersion == "" {
		return ConflictGuardResult{}, fmt.Errorf("cannot resolve %s: no expected source version was supplied", path)
	}
	state, err := s.conflictState(ctx, dir, path, withSnapshot)
	if err != nil {
		return ConflictGuardResult{}, err
	}
	if state.SourceVersion != expectedSourceVersion {
		return ConflictGuardResult{Applied: false, SourceVersion: state.SourceVersion}, nil
	}
	root, err := s.repoRoot(ctx, dir)
	if err != nil {
		return ConflictGuardResult{}, err
	}
	abs := filepath.Join(root, filepath.FromSlash(path))
	if err := mutate(state, root, abs); err != nil {
		return ConflictGuardResult{}, err
	}
	after, err := s.conflictState(ctx, dir, path, false)
	if err != nil {
		return ConflictGuardResult{}, err
	}
	return ConflictGuardResult{Applied: true, SourceVersion: after.SourceVersion}, nil
}

// WriteConflictResult writes a resolved text result to the working tree only if
// the file still matches expectedSourceVersion, and returns the post-write
// version so the caller can stage without re-reading.
func (s *Service) WriteConflictResult(
	ctx context.Context,
	dir, path, expectedSourceVersion, content, encoding, lineEndings string,
) (ConflictGuardResult, error) {
	if !writableConflictFormat(encoding, lineEndings) {
		return ConflictGuardResult{}, fmt.Errorf(
			"cannot write %s: %s with %s line endings cannot be written back losslessly", path, encoding, lineEndings)
	}
	return s.guardedConflictMutation(ctx, dir, path, expectedSourceVersion, true,
		func(state ConflictState, _, abs string) error {
			if state.Snapshot == nil {
				return fmt.Errorf("cannot write %s: it has no text conflict to resolve", path)
			}
			writer := filesystem.NewFileWriter(filesystem.NewOS())
			return writer.WriteFileWithOptions(abs, content, &filesystem.WriteOptions{
				Encoding:    encoding,
				LineEndings: lineEndings,
			})
		})
}

// StageConflictResult stages the working-tree state of a conflicted path (its
// content, or its deletion) only if the path still matches
// expectedSourceVersion. `add -A` covers both so content and deletion share one
// guarded, retryable path.
func (s *Service) StageConflictResult(
	ctx context.Context,
	dir, path, expectedSourceVersion string,
) (ConflictGuardResult, error) {
	return s.guardedConflictMutation(ctx, dir, path, expectedSourceVersion, false,
		func(ConflictState, string, string) error {
			_, err := s.runAtRoot(ctx, dir, literalPathspecs, "add", "-A", "--", path)
			return err
		})
}

// ApplyConflictSide applies one whole-file side to the working tree — without
// staging — only if the path still matches expectedSourceVersion. Keeping the
// apply and the stage separate lets a failed stage be retried against the
// version this call returns, instead of re-applying a side over content the
// user may have since changed.
func (s *Service) ApplyConflictSide(
	ctx context.Context,
	dir, path, side, expectedSourceVersion string,
) (ConflictGuardResult, error) {
	if err := validateConflictSide(side); err != nil {
		return ConflictGuardResult{}, err
	}
	return s.guardedConflictMutation(ctx, dir, path, expectedSourceVersion, false,
		func(state ConflictState, root, abs string) error {
			return s.applyConflictSideToWorktree(ctx, dir, path, side, state.Stages, root, abs)
		})
}

// MergeHead describes one side of an in-progress conflict for the card header.
// Label is a branch name when resolvable, else the short hash; Hash/Subject
// come from the commit that side points at.
type MergeHead struct {
	Label   string `json:"label"`
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
}

// MergeHeads names both sides of the conflict the user is resolving, plus the
// operation (merge, rebase, or cherry-pick) so the UI can phrase "incoming"
// correctly. It reads HEAD (ours) and the operation's incoming ref (theirs).
type MergeHeads struct {
	Operation string    `json:"operation"`
	Ours      MergeHead `json:"ours"`
	Theirs    MergeHead `json:"theirs"`
}

// MergeHeads returns the two sides of the in-progress conflict. The incoming
// ref is chosen by which operation is underway: MERGE_HEAD for a merge,
// CHERRY_PICK_HEAD for a cherry-pick, REBASE_HEAD for a rebase. When no
// conflicting operation is in progress it returns an error rather than
// inventing a side — porcelain reports "(detached)" mid-rebase, so ours is
// always taken from HEAD directly, never from the branch name.
func (s *Service) MergeHeads(ctx context.Context, dir string) (MergeHeads, error) {
	operation, incomingRef := "", ""
	switch {
	// Rebase is detected by its state directory (git's own signal in
	// wt-status.c) and takes precedence: a stale REBASE_HEAD can linger, and a
	// merge step inside `rebase --rebase-merges` sets MERGE_HEAD while still
	// being a rebase. Its incoming ref is MERGE_HEAD for an inner merge step,
	// else REBASE_HEAD for a normal pick step.
	case s.gitPathExists(ctx, dir, "rebase-merge"), s.gitPathExists(ctx, dir, "rebase-apply"):
		operation = "rebase"
		// An inner merge step of `rebase --rebase-merges` writes MERGE_HEAD;
		// otherwise the pick step's incoming commit is REBASE_HEAD. Detect the
		// former via its state file (not a DWIM ref) so a branch literally
		// named MERGE_HEAD cannot shadow it. If the apply backend leaves no
		// REBASE_HEAD, describeHead errors and the caller falls back safely.
		if s.gitPathExists(ctx, dir, "MERGE_HEAD") {
			incomingRef = "MERGE_HEAD"
		} else {
			incomingRef = "REBASE_HEAD"
		}
	case s.gitPathExists(ctx, dir, "CHERRY_PICK_HEAD"):
		operation, incomingRef = "cherry-pick", "CHERRY_PICK_HEAD"
	case s.gitPathExists(ctx, dir, "MERGE_HEAD"):
		operation, incomingRef = "merge", "MERGE_HEAD"
	default:
		return MergeHeads{}, fmt.Errorf("no merge, rebase, or cherry-pick in progress")
	}

	ours, err := s.describeHead(ctx, dir, "HEAD")
	if err != nil {
		return MergeHeads{}, err
	}
	// Prefer the current branch name for ours; empty (detached) keeps the hash.
	if branch, err := s.run(ctx, dir, "symbolic-ref", "--short", "-q", "HEAD"); err == nil {
		if name := strings.TrimSpace(branch); name != "" {
			ours.Label = name
		}
	}
	theirs, err := s.describeHead(ctx, dir, incomingRef)
	if err != nil {
		return MergeHeads{}, err
	}
	return MergeHeads{Operation: operation, Ours: ours, Theirs: theirs}, nil
}

// gitPathExists reports whether a file or directory exists under the git dir
// (e.g. "MERGE_HEAD", "rebase-merge"). It asks git for the absolute path so
// linked worktrees resolve correctly and a symlinked dir cannot mislead a
// lexical join, then stats it. This checks the operation-state file directly
// rather than resolving a ref name, which cannot be shadowed by a branch.
func (s *Service) gitPathExists(ctx context.Context, dir, name string) bool {
	out, err := s.run(ctx, dir, "rev-parse", "--path-format=absolute", "--git-path", name)
	if err != nil {
		return false
	}
	p := strings.TrimSpace(out)
	if p == "" {
		return false
	}
	_, statErr := os.Stat(p)
	return statErr == nil
}

// verifyUnderRoot fails unless abs, with all symlinks resolved, stays within
// the symlink-resolved repository root. Both sides are resolved so platform
// symlinks in the root path itself (e.g. macOS /var -> /private/var) do not
// cause a false escape.
func verifyUnderRoot(root, abs string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	realAbs, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(realRoot, realAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes the repository")
	}
	return nil
}

// describeHead resolves a ref to short hash + subject, seeding Label with the
// short hash (callers may override with a branch name).
func (s *Service) describeHead(ctx context.Context, dir, ref string) (MergeHead, error) {
	out, err := s.run(ctx, dir, "log", "-1", "--format=%h%x00%s", ref)
	if err != nil {
		return MergeHead{}, err
	}
	hash, subject, _ := strings.Cut(strings.TrimRight(out, "\n"), "\x00")
	return MergeHead{Label: hash, Hash: hash, Subject: subject}, nil
}

// ResolveConflictSide finalizes a whole-file conflict (binary, or a
// delete/modify where a marker-based resolution is impossible) by taking one
// side. side is "ours" or "theirs". When the chosen side has content (its
// index stage exists) that content is checked out and staged; when the chosen
// side is a deletion (its stage is absent) the path is removed and the deletion
// is staged. This is the only write the merge surface makes, and only at Write
// and stage time — never on a click — so closing the surface leaves the working
// tree untouched.
func (s *Service) ResolveConflictSide(ctx context.Context, dir, path, side string) error {
	if err := validateRepoRelPaths([]string{path}); err != nil {
		return err
	}
	if err := validateConflictSide(side); err != nil {
		return err
	}
	root, err := s.repoRoot(ctx, dir)
	if err != nil {
		return err
	}
	abs := filepath.Join(root, filepath.FromSlash(path))
	stages, err := s.ConflictStages(ctx, dir, path)
	if err != nil {
		return err
	}
	if err := s.applyConflictSideToWorktree(ctx, dir, path, side, stages, root, abs); err != nil {
		return err
	}
	// `-A` so a resolution to the deletion stages the removal through the same
	// call that stages content.
	_, err = s.runAtRoot(ctx, dir, literalPathspecs, "add", "-A", "--", path)
	return err
}

func validateConflictSide(side string) error {
	switch side {
	case "ours", "theirs":
		return nil
	default:
		return fmt.Errorf("invalid conflict side %q (allowed: ours, theirs)", side)
	}
}

// applyConflictSideToWorktree puts one whole-file side into the working tree and
// touches nothing else. It is the single implementation shared by the guarded
// ApplyConflictSide and the compatible ResolveConflictSide, so the two can never
// disagree about what taking a side means.
func (s *Service) applyConflictSideToWorktree(
	ctx context.Context,
	dir, path, side string,
	stages ConflictStages,
	root, abs string,
) error {
	// Refuse when the path has no conflict stages at all: it is not conflicted
	// (already resolved, a stale card, or a double-click). Without this guard
	// the "chosen side absent = deletion" branch below would delete a clean
	// tracked file and destroy uncommitted content.
	if !conflictStagesPresent(stages) {
		return fmt.Errorf("%s is not conflicted", path)
	}
	chosen, checkoutFlag := stages.Ours, "--ours"
	if side == "theirs" {
		chosen, checkoutFlag = stages.Theirs, "--theirs"
	}
	// Chosen side is a deletion (its stage is absent though the path IS
	// conflicted): remove the working-tree file and leave the index alone.
	if chosen == nil {
		return removeConflictWorktreePath(root, abs, path)
	}
	_, err := s.runAtRoot(ctx, dir, literalPathspecs, "checkout", checkoutFlag, "--", path)
	return err
}

// removeConflictWorktreePath deletes the working-tree file for a side that is a
// deletion. An already-absent path is an idempotent success; anything that is
// not a contained regular file is refused rather than removed.
func removeConflictWorktreePath(root, abs, path string) error {
	info, err := os.Lstat(abs)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := verifyUnderRoot(root, abs); err != nil {
		return fmt.Errorf("cannot resolve %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("cannot resolve %s: path is not a regular file", path)
	}
	return os.Remove(abs)
}

// literalPathspecs is the global git flag that disables pathspec magic, so a
// user-supplied path is always matched as a literal filename. It guards the
// path-bearing commands (checkout, rm, add, ls-files) against a filename that
// contains pathspec metacharacters ("*", a leading ":") matching or mutating
// unrelated files — critical for the destructive rm/checkout in
// ResolveConflictSide.
const literalPathspecs = "--literal-pathspecs"

// StageBlob is one conflict index entry (a stage-1/2/3 object). Size is the
// blob byte size and Mode the index mode (e.g. "100644", "100755"), which is
// part of the conflict's identity: a side that only changed its executable bit
// still changed. A nil *StageBlob on ConflictStages means the stage is absent
// — the explicit signal for a delete/modify conflict, never conflated with
// empty content.
type StageBlob struct {
	Hash string `json:"hash"`
	Mode string `json:"mode"`
	Size int64  `json:"size"`
}

// ConflictStages reports which index stages exist for a conflicted path, so the
// frontend can tell a whole-file side conflict (binary, or delete/modify with a
// stage absent) from a mergeable text conflict, and offer only the sides that
// actually exist. Stage 1 is the merge base, 2 is ours (HEAD), 3 is theirs.
type ConflictStages struct {
	Path   string     `json:"path"`
	Base   *StageBlob `json:"base"`
	Ours   *StageBlob `json:"ours"`
	Theirs *StageBlob `json:"theirs"`
	Binary bool       `json:"binary"`
}

// ConflictStages runs `git ls-files -u` for a single path and records which of
// the three conflict stages are present, along with a binary flag derived from
// a representative present stage. An unconflicted path yields all-nil stages
// and no error, letting the caller decide it is nothing to resolve.
func (s *Service) ConflictStages(ctx context.Context, dir, path string) (ConflictStages, error) {
	if err := validateRepoRelPaths([]string{path}); err != nil {
		return ConflictStages{}, err
	}
	out, err := s.runAtRoot(ctx, dir, literalPathspecs, "ls-files", "-u", "-z", "--", path)
	if err != nil {
		return ConflictStages{}, err
	}

	result := ConflictStages{Path: path}
	for _, rec := range strings.Split(out, "\x00") {
		if rec == "" {
			continue
		}
		// Record: "<mode> <object> <stage>\t<path>". Accept only records for
		// the exact requested path — a directory-like pathspec (e.g. ".") would
		// otherwise aggregate descendants' stages into one result and let
		// ResolveConflictSide act on the wrong files.
		meta, name, ok := strings.Cut(rec, "\t")
		if !ok || name != path {
			continue
		}
		fields := strings.Fields(meta)
		if len(fields) != 3 {
			continue
		}
		blob := &StageBlob{Hash: fields[1], Mode: fields[0], Size: s.blobSize(ctx, dir, fields[1])}
		switch fields[2] {
		case "1":
			result.Base = blob
		case "2":
			result.Ours = blob
		case "3":
			result.Theirs = blob
		}
	}

	result.Binary, err = s.binaryMergeAttribute(ctx, dir, path)
	if err != nil {
		return ConflictStages{}, err
	}
	if !result.Binary {
		// Git merges a file as binary when ANY present stage is binary, so probe
		// every present stage — a text-ours/binary-theirs conflict is still binary.
		for _, blob := range []*StageBlob{result.Base, result.Ours, result.Theirs} {
			if blob != nil && s.blobIsBinary(ctx, dir, blob) {
				result.Binary = true
				break
			}
		}
	}
	return result, nil
}

// binaryMergeAttribute reports whether Git attributes select its binary merge
// behavior. The `binary` macro expands to `-merge`; `merge=binary` names the
// same built-in driver explicitly.
func (s *Service) binaryMergeAttribute(ctx context.Context, dir, path string) (bool, error) {
	out, err := s.runAtRoot(ctx, dir, literalPathspecs, "check-attr", "-z", "merge", "--", path)
	if err != nil {
		return false, err
	}
	fields := strings.Split(out, "\x00")
	if len(fields) < 3 {
		return false, fmt.Errorf("cannot read merge attribute for %s", path)
	}
	return fields[2] == "unset" || fields[2] == "binary", nil
}

// blobSize returns the byte size of a git object, or 0 when it cannot be read.
func (s *Service) blobSize(ctx context.Context, dir, hash string) int64 {
	out, err := s.runAtRoot(ctx, dir, "cat-file", "-s", hash)
	if err != nil {
		return 0
	}
	var n int64
	if _, scanErr := fmt.Sscanf(strings.TrimSpace(out), "%d", &n); scanErr != nil {
		return 0
	}
	return n
}

// blobIsBinary probes a blob for a NUL byte using git's own heuristic. A blob
// past the diffable size cap is treated as binary without reading it: the merge
// surface refuses over-cap text anyway (ConflictSnapshot), so this both avoids
// an unbounded read of a huge object and routes it to the whole-file-side UI.
func (s *Service) blobIsBinary(ctx context.Context, dir string, blob *StageBlob) bool {
	if blob.Size > maxDiffableBytes {
		return true
	}
	out, err := s.runAtRoot(ctx, dir, "cat-file", "blob", blob.Hash)
	if err != nil {
		return false
	}
	return isBinary(out)
}

// contentTransformActive reports whether a checkout-time content transform is
// configured for a path — a smudge/clean `filter`, `ident` keyword expansion,
// or a `working-tree-encoding` — any of which makes the working-tree bytes
// diverge from the raw index blob. `git check-attr -z` emits a
// "<path>\0<attr>\0<value>\0" triple per attribute; a value other than
// "unspecified"/"unset" means the transform is active.
func (s *Service) contentTransformActive(ctx context.Context, dir, path string) (bool, error) {
	out, err := s.runAtRoot(ctx, dir, literalPathspecs, "check-attr", "-z",
		"filter", "ident", "working-tree-encoding", "--", path)
	if err != nil {
		return false, err
	}
	fields := strings.Split(out, "\x00")
	for i := 0; i+2 < len(fields); i += 3 {
		switch fields[i+2] {
		case "", "unspecified", "unset":
		default:
			return true, nil
		}
	}
	return false, nil
}

// conflictMarkerSize returns the effective conflict-marker-size for a path
// (git's gitattributes-controlled marker width), defaulting to 7 when unset or
// unparseable. `git check-attr -z` emits "<path>\0conflict-marker-size\0<value>\0";
// value is a positive integer when set, else "unspecified"/"set"/"unset".
func (s *Service) conflictMarkerSize(ctx context.Context, dir, path string) int {
	out, err := s.runAtRoot(ctx, dir, literalPathspecs, "check-attr", "-z", "conflict-marker-size", "--", path)
	if err != nil {
		return defaultMarkerSize
	}
	fields := strings.Split(out, "\x00")
	if len(fields) < 3 {
		return defaultMarkerSize
	}
	if n, convErr := strconv.Atoi(fields[2]); convErr == nil && n > 0 {
		return n
	}
	return defaultMarkerSize
}

// regionMarkersInStages reports whether a marker plus its immediate content
// context appears in one of the conflict's index stages (base/ours/theirs), and
// records authoritative per-stage newline state on a final EOF region. Git's
// real markers are absent from the clean stage blobs, while a literal marker
// and its neighbors remain together. Context avoids mistaking an unrelated
// marker-shaped line elsewhere in a stage for region structure.
func (s *Service) regionMarkersInStages(
	ctx context.Context,
	dir, path, content, encoding string,
	regions []ConflictRegion,
	stages ConflictStages,
) (bool, error) {
	// The worktree content is decoded (BOM stripped) while FileAtRev returns raw
	// blob bytes. That only compares reliably for UTF-8; for a wide or legacy
	// encoding the bytes differ and a spurious region could slip through, so
	// fail closed (refuse) rather than risk exposing one.
	switch encoding {
	case "utf-8", "utf-8-bom":
	default:
		return false, fmt.Errorf("cannot resolve %s: %s encoding cannot be verified against conflict markers", path, encoding)
	}
	// A checkout-time content transform (an ident keyword, a smudge filter, or a
	// working-tree-encoding) makes the worktree bytes differ from the raw stage
	// blobs, so the marker comparison below would silently miss a literal marker.
	// Fail closed rather than enumerate every transform.
	if active, err := s.contentTransformActive(ctx, dir, path); err != nil {
		return false, err
	} else if active {
		return false, fmt.Errorf("cannot resolve %s: a git content filter is active and cannot be verified against conflict markers", path)
	}

	lines := strings.Split(content, "\n")
	lineAt := func(n int) string { // 1-based; "" if out of range
		if n >= 1 && n <= len(lines) {
			return strings.TrimSuffix(lines[n-1], "\r")
		}
		return ""
	}
	// Collect each marker-shaped line with its immediate non-marker neighbors.
	// The region's width comes from its opening <<< run so nested-width regions
	// are measured correctly. Keys contain one to three complete lines.
	markerContexts := map[string]bool{}
	for _, r := range regions {
		w := 0
		opener := lineAt(r.StartLine)
		for w < len(opener) && opener[w] == markerOurs {
			w++
		}
		if w == 0 {
			continue
		}
		isMarker := func(line string) bool {
			for _, ch := range []byte{markerOurs, markerBase, markerSep, markerTheir} {
				if _, _, ok := markerRun(line, ch, w, 0); ok {
					return true
				}
			}
			return false
		}
		for n := r.StartLine; n <= r.EndLine; n++ {
			line := lineAt(n)
			if !isMarker(line) {
				continue
			}
			context := []string{line}
			if n > 1 && !isMarker(lineAt(n-1)) {
				context = append([]string{lineAt(n - 1)}, context...)
			}
			if n < len(lines) && !isMarker(lineAt(n+1)) {
				context = append(context, lineAt(n+1))
			}
			markerContexts[strings.Join(context, "\n")] = true
		}
	}
	eofAtRisk := lastRegionEndsFile(lines, regions)
	eofRegion := &regions[len(regions)-1]

	const utf8BOM = "\xef\xbb\xbf"
	for _, stage := range []struct {
		name    string
		blob    *StageBlob
		newline **bool
	}{
		{name: ":1", blob: stages.Base, newline: &eofRegion.BaseEndsWithNewline},
		{name: ":2", blob: stages.Ours, newline: &eofRegion.OursEndsWithNewline},
		{name: ":3", blob: stages.Theirs, newline: &eofRegion.TheirsEndsWithNewline},
	} {
		if stage.blob == nil {
			continue
		}
		if stage.blob.Size > maxDiffableBytes {
			return false, fmt.Errorf("cannot resolve %s: %s stage is too large to verify", path, stage.name)
		}
		stageContent, err := s.runAtRoot(ctx, dir, "cat-file", "blob", stage.blob.Hash)
		if err != nil {
			return false, err
		}
		if len(stageContent) > maxDiffableBytes || isBinary(stageContent) {
			// Cannot read the stage to compare — a literal marker could hide in
			// the part we did not see, so refuse rather than miss it.
			return false, fmt.Errorf("cannot resolve %s: %s stage is binary or too large to verify", path, stage.name)
		}
		if eofAtRisk {
			hasNewline := strings.HasSuffix(stageContent, "\n")
			*stage.newline = &hasNewline
		}
		if stageContent == "" {
			continue // present empty blob
		}
		stageLines := strings.Split(strings.TrimPrefix(stageContent, utf8BOM), "\n")
		for i := range stageLines {
			stageLines[i] = strings.TrimSuffix(stageLines[i], "\r")
		}
		for i := range stageLines {
			for width := 1; width <= 3 && i+width <= len(stageLines); width++ {
				if markerContexts[strings.Join(stageLines[i:i+width], "\n")] {
					return true, nil
				}
			}
		}
	}
	return false, nil
}

// lastRegionEndsFile reports whether the final conflict region's closing marker
// reaches EOF, allowing only the newline Git adds after the marker. Any further
// blank lines are real suffix content and stay on the normal non-EOF path.
func lastRegionEndsFile(lines []string, regions []ConflictRegion) bool {
	if len(regions) == 0 {
		return false
	}
	end := regions[len(regions)-1].EndLine // 1-based line of >>>>>>>
	return end == len(lines) || (end+1 == len(lines) && lines[end] == "")
}

// repoRoot returns the repository top-level for dir. Unlike runAtRoot (which
// silently falls back to dir), this surfaces the error, because a path that
// cannot be resolved to a repo root must fail the operation rather than read a
// file relative to the wrong directory.
func (s *Service) repoRoot(ctx context.Context, dir string) (string, error) {
	out, err := s.run(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// ConflictRegion is one <<<<<<< / ======= / >>>>>>> block in a conflicted
// working-tree file. Line numbers are 1-based into the file the frontend
// displays. Ours/Base/Theirs hold the region's lines without their trailing
// newline (each entry is one line); they are always non-nil slices so a side
// that resolves to nothing (a delete/modify within the block) is an empty
// slice, never a JSON null. Base is populated only for diff3-style markers
// (HasBase); the default merge style omits the ||||||| section. The three
// EndsWithNewline fields are populated only on a final EOF region from the
// authoritative stage blobs; nil means that stage is absent.
type ConflictRegion struct {
	Index                 int      `json:"index"`
	StartLine             int      `json:"startLine"` // 1-based line of the <<<<<<< marker
	EndLine               int      `json:"endLine"`   // 1-based line of the >>>>>>> marker
	Ours                  []string `json:"ours"`
	Base                  []string `json:"base"`
	Theirs                []string `json:"theirs"`
	HasBase               bool     `json:"hasBase"`
	OursLabel             string   `json:"oursLabel"`  // text after <<<<<<< (e.g. "HEAD")
	TheirLabel            string   `json:"theirLabel"` // text after >>>>>>> (e.g. branch name)
	BaseEndsWithNewline   *bool    `json:"baseEndsWithNewline,omitempty"`
	OursEndsWithNewline   *bool    `json:"oursEndsWithNewline,omitempty"`
	TheirsEndsWithNewline *bool    `json:"theirsEndsWithNewline,omitempty"`
}

// Conflict marker characters. Git begins each marker line with a run of the
// same character exactly conflict-marker-size long, optionally followed by a
// space and a label.
const (
	markerOurs  = '<'
	markerBase  = '|'
	markerSep   = '='
	markerTheir = '>'
	// defaultMarkerSize is git's default marker width when the
	// conflict-marker-size attribute is unset.
	defaultMarkerSize = 7
)

// markerRun measures the leading run of the character ch in line and, if it is
// a conflict marker (run of at least minWidth, followed by end-of-line or a
// single space), returns the run width and the label after it. minWidth is the
// exact width to require when > 0 (used for the base/separator/closing markers,
// which must match the width of the region's opening marker), or the minimum
// acceptable width when passed as a floor for the opening marker.
func markerRun(line string, ch byte, exactWidth, minWidth int) (width int, label string, ok bool) {
	n := 0
	for n < len(line) && line[n] == ch {
		n++
	}
	if exactWidth > 0 {
		if n != exactWidth {
			return 0, "", false
		}
	} else if n < minWidth {
		return 0, "", false
	}
	rest := line[n:]
	switch {
	case rest == "":
		return n, "", true
	case rest[0] == ' ':
		return n, rest[1:], true
	default:
		return 0, "", false
	}
}

// parseConflictRegions extracts conflict regions from decoded file text. It is
// pure (no git, no disk) so the marker grammar is unit-testable in isolation.
//
// Git widens a conflict's markers past the base conflict-marker-size (+1 for
// rename conflicts, more for nested recursive merges) precisely so a region's
// own content can never contain a marker line of the region's exact width. We
// exploit that guarantee: gather the widths of the opening <<< runs actually
// present (each >= markerSize), then parse strictly at each candidate width and
// take the first that yields a clean, non-empty set of regions. Parsing at the
// exact width means a wider or narrower marker-shaped content line (a Markdown
// "=======" heading, documentation showing conflict markers) is treated as
// content, never mistaken for structure and never rejected as a stray marker.
// A file whose markers do not form clean regions at any candidate width returns
// an error, and the caller falls back to a plain editor.
func parseConflictRegions(content string, markerSize int) ([]ConflictRegion, error) {
	if markerSize < 1 {
		markerSize = defaultMarkerSize
	}
	// CRLF files decode with a trailing \r on every line; strip it so markers
	// match and side lines stay logical. The file's line ending is carried
	// separately (ConflictSnapshot.LineEndings) and reapplied on write.
	lines := strings.Split(content, "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}

	widths := openingWidths(lines, markerSize)
	if len(widths) == 0 {
		return []ConflictRegion{}, nil // no conflict openings: nothing to resolve
	}
	// A well-formed file uses one marker width (occasionally a couple across
	// nested merges). A large spread of distinct opening-run widths is either
	// malformed or crafted to make us parse the whole file many times; cap the
	// candidates and fall back rather than do superlinear work.
	const maxCandidateWidths = 8
	if len(widths) > maxCandidateWidths {
		return nil, fmt.Errorf("too many distinct conflict marker widths (%d)", len(widths))
	}

	var cleanParses [][]ConflictRegion
	var firstErr error
	for _, w := range widths {
		regions, err := parseAtWidth(lines, w)
		switch {
		case err == nil && len(regions) > 0:
			cleanParses = append(cleanParses, regions)
		case err != nil && firstErr == nil:
			firstErr = err
		}
	}
	switch {
	case len(cleanParses) == 1:
		return cleanParses[0], nil
	case len(cleanParses) > 1:
		// More than one width parses cleanly (e.g. a widened conflict whose
		// content contains a complete narrower marker sample). We cannot tell
		// which is the real structure, so refuse rather than pick wrong.
		return nil, fmt.Errorf("ambiguous conflict markers: %d widths parse cleanly", len(cleanParses))
	case firstErr != nil:
		return nil, firstErr
	default:
		return []ConflictRegion{}, nil
	}
}

// openingWidths returns the distinct widths of opening (<<<) marker runs of at
// least markerSize, sorted ascending so the narrowest plausible width is tried
// first.
func openingWidths(lines []string, markerSize int) []int {
	seen := map[int]bool{}
	var widths []int
	for _, line := range lines {
		if w, _, ok := markerRun(line, markerOurs, 0, markerSize); ok && !seen[w] {
			seen[w] = true
			widths = append(widths, w)
		}
	}
	sort.Ints(widths)
	return widths
}

// parseAtWidth runs the conflict grammar with every marker required to be
// exactly w characters. Inside a region, a marker-shaped line at width w in the
// wrong position is malformed (git never emits it) and errors out; a line that
// is not a width-w marker is content. An unterminated region errors.
func parseAtWidth(lines []string, w int) ([]ConflictRegion, error) {
	const (
		outside = iota
		inOurs
		inBase
		inTheirs
	)
	isMark := func(line string, ch byte) bool {
		_, _, ok := markerRun(line, ch, w, 0)
		return ok
	}

	regions := []ConflictRegion{}
	section := outside
	var cur ConflictRegion

	for i, line := range lines {
		lineNo := i + 1
		switch section {
		case outside:
			if _, label, ok := markerRun(line, markerOurs, w, 0); ok {
				cur = ConflictRegion{
					Index:     len(regions),
					StartLine: lineNo,
					Ours:      []string{},
					Base:      []string{},
					Theirs:    []string{},
					OursLabel: label,
				}
				section = inOurs
			}
			// Any other line (including a narrower/wider marker-shaped divider)
			// is content outside a conflict.
		case inOurs:
			switch {
			case isMark(line, markerBase):
				cur.HasBase = true
				section = inBase
			case isMark(line, markerSep):
				section = inTheirs
			case isMark(line, markerOurs) || isMark(line, markerTheir):
				return nil, fmt.Errorf("malformed conflict marker at line %d", lineNo)
			default:
				cur.Ours = append(cur.Ours, line)
			}
		case inBase:
			switch {
			case isMark(line, markerSep):
				section = inTheirs
			case isMark(line, markerOurs) || isMark(line, markerBase) || isMark(line, markerTheir):
				return nil, fmt.Errorf("malformed conflict marker at line %d", lineNo)
			default:
				cur.Base = append(cur.Base, line)
			}
		case inTheirs:
			switch {
			case isMark(line, markerTheir):
				_, label, _ := markerRun(line, markerTheir, w, 0)
				cur.EndLine = lineNo
				cur.TheirLabel = label
				regions = append(regions, cur)
				section = outside
			case isMark(line, markerOurs) || isMark(line, markerSep) || isMark(line, markerBase):
				return nil, fmt.Errorf("malformed conflict marker at line %d", lineNo)
			default:
				cur.Theirs = append(cur.Theirs, line)
			}
		}
	}

	if section != outside {
		return nil, fmt.Errorf("unterminated conflict starting at line %d", cur.StartLine)
	}
	return regions, nil
}
