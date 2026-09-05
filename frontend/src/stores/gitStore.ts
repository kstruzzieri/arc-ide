import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import {
  GitStatus,
  GitStage,
  GitUnstage,
  GitIntentToAdd,
  GitCommit,
  GitPull,
  GitPush,
  GitBranches,
  GitCheckout,
  GitCommitMessageAvailable,
  GitGenerateCommitMessage,
  GitFileAtRev,
  GitFileHunks,
  GitApplyHunk,
  GitConflictState,
  GitWriteConflictResult,
  GitStageConflictResult,
  GitApplyConflictSide,
  ReadFile,
} from '../wails/bindings';
import type { git } from '../wails/bindings';
import {
  buildStatusByPath,
  classifyChange,
  type GitFileChange,
  type GitRowStatus,
} from '../types/git';
import { joinRepoPath } from '../utils/paths';
import { pathsReferToSameFile } from '../utils/lspUri';
import {
  flushWorkingTreeEdit,
  getFileWriteRevision,
  isWritableFormat,
  markFileWriteAttempt,
  saveOpenFileToDisk,
  withFileWriteLock,
} from '../utils/fileWrites';
import { useIDEStore } from './ideStore';

/** Which pair of revisions a diff shows. Staged rows compare HEAD to the
 * index; unstaged (and untracked) rows compare the index to the worktree. */
export type DiffContext = 'staged' | 'unstaged';
export type EditorFocus = 'file' | 'diff' | 'merge';

export interface DiffSide {
  label: string;
  content: string;
}

/** One open diff, rendered as a reused preview tab in the editor area. */
export interface DiffSession {
  /** Repo-relative path, used as the tab title. */
  path: string;
  /** Absolute worktree path, for opening the real file from the diff. */
  absPath: string;
  context: DiffContext;
  left: DiffSide;
  right: DiffSide;
  /** Either side is binary → no merge view, show a binary state instead. */
  binary: boolean;
  /** Either side exceeded the diffable size cap. */
  truncated: boolean;
  /** Per-hunk staging affordances, from `git diff` of this file. Empty for
   * untracked/binary/too-large diffs (whole-file staging only). In an
   * 'unstaged' diff these stage; in a 'staged' diff they unstage. */
  hunks: git.Hunk[];
  /** True when hunks were skipped only because the working-tree side is an
   * unsaved editor buffer git hasn't diffed yet. The diff view keeps its
   * previous hunk gutter through such a refresh (dimmed where edits touched)
   * instead of collapsing the column for the sub-second save window. */
  hunksSuppressed?: boolean;
  /** Monotonic id of the openDiff request that produced this session. The diff
   * view compares it against the id current when the user last typed, so a
   * refresh that STARTED before a local edit can never reconcile the pane
   * backward, while one that started after (and so read the post-edit
   * buffer/disk) is authoritative. Not part of sameSession equality. */
  requestRevision?: number;
  /** The working-tree file's detected encoding and line endings, captured when
   * an editable (unstaged) diff is built so an edit written straight to disk
   * (file not open in the editor) round-trips them instead of silently
   * rewriting to UTF-8/LF. Undefined when there is no writable worktree file
   * (staged, deleted, binary, or too-large sessions stay read-only). */
  worktreeEncoding?: string;
  worktreeLineEndings?: string;
}

/** How one conflict region was resolved: Current, Incoming, Both, or Manual. */
export type MergeDecision = 'C' | 'I' | 'B' | 'M';

/** Why the open merge session no longer matches the file on disk.
 *
 * `changed` — the source version moved. `scope: 'conflict'` means the operation
 * heads or the index stages moved, so Current/Incoming no longer mean what the
 * user reviewed and Reload is the only recovery; `scope: 'worktree'` means only
 * the working-tree bytes moved, which the user may knowingly overwrite through
 * a separate confirmation. `hidden` is set by "Keep working": it hides the
 * notice WITHOUT becoming permission to overwrite.
 *
 * `resolved-outside` — the path is no longer conflicted, or its markers are
 * gone. Terminal for the session that observed it.
 *
 * `check-failed` — a revalidation could not read the file. Finalize stays
 * blocked until a retry succeeds, because a session nobody could verify must
 * not be writable. */
export type MergeExternalChange =
  | {
      kind: 'changed';
      hidden: boolean;
      scope: 'worktree' | 'conflict';
      /** The live version this notice describes. A later signal that finds the
       * same version leaves an acknowledged notice hidden; a different one
       * raises a fresh notice, because that is a change the user has not seen. */
      observedVersion: string;
    }
  | { kind: 'resolved-outside'; message: string }
  | { kind: 'check-failed'; message: string };

interface MergeSessionBase {
  /** Repo-relative path of the conflicted file. */
  path: string;
  /** Absolute worktree path. */
  absPath: string;
  /** Repo root captured at open; finalize revalidates against the live root
   * so a workspace switch mid-session can never stage into the wrong repo. */
  repoRoot: string;
  /** Card/header labels for the two sides of the active operation. */
  labels: git.MergeHeads;
  /** Workspace-scoped conflicted paths still to resolve, rotated so this
   * session's path is first and the panel's relative order is preserved. */
  fileQueue: string[];
  /** Monotonic id of the openMergeResolution request that built this session. */
  requestRevision: number;
  /** Store epoch captured at open; async work checks it after every await. */
  epoch: number;
  /** Per-path write generation captured with the conflict snapshot. Any later
   * editor/diff write invalidates the session before it can overwrite data.
   * This sees Firn's own writes only; `sourceVersion` is the external
   * authority. */
  fileWriteRevision: number;
  /** Opaque backend identity of everything this session was built from: the
   * operation heads, every index stage, and the raw worktree bytes. Every
   * mutation presents it, and the backend refuses when it has moved. */
  sourceVersion: string;
  /** Index stages for the path, on the common base so a text session can also
   * classify a later index change. */
  stages: git.ConflictStages;
  /** True once the user has touched this session — any Result-document change
   * (which includes every accepted side), a recorded or reopened decision, or a
   * chosen whole-file side. Sticky: a session the user has touched asks before
   * discarding, even if the edit was undone. */
  dirty: boolean;
  /** True while a user-requested Reload is reading; competing signals stand
   * down and the surface freezes rather than double-submitting. */
  reloadPending: boolean;
  /** True when a close was requested on a touched session and the discard
   * confirmation is showing. */
  closeRequested: boolean;
  /** Set when a revalidation found the session out of date with the file. */
  external?: MergeExternalChange;
}

/** Three-way textual conflict with marker blocks: the Result-spine editor. */
export interface TextMergeSession extends MergeSessionBase {
  kind: 'text';
  /** Full working-tree document, markers included — the exact bytes the
   * regions were parsed from (single atomic backend read). */
  content: string;
  encoding: string;
  lineEndings: string;
  regions: git.ConflictRegion[];
  /** Region index → how it was resolved. Absent = still unresolved. */
  decisions: Record<number, MergeDecision>;
  /** True when the file's format can't be written back losslessly — the
   * session renders read-only and finalize stays disabled. */
  readOnly: boolean;
}

/** Whole-file side choice: binary conflicts and textual delete/modify, which
 * have no marker block to edit. */
export interface SidesMergeSession extends MergeSessionBase {
  kind: 'sides';
  selectedSide?: 'ours' | 'theirs';
  /** Set once a side has been applied to the worktree but not yet staged, with
   * the version that apply produced. A stage retry may reuse it; changing the
   * selection clears it so the next finalize applies again. */
  appliedSide?: { side: 'ours' | 'theirs'; sourceVersion: string };
}

export type MergeSession = TextMergeSession | SidesMergeSession;

/** Friendly post-commit summary shown in the panel instead of raw git output. */
export interface CommitReceipt {
  branch: string;
  hash: string;
  subject: string;
  /** Repo-relative paths that were staged when the commit ran. */
  files: string[];
  /** Raw git output (stats, hook messages) for the collapsible detail. */
  output: string;
}

/** Deep-equality for a diff session, so an unchanged live refresh can keep the
 * same object reference and avoid rebuilding the merge view. */
function sameSession(a: DiffSession | null, b: DiffSession): boolean {
  return (
    a !== null &&
    a.path === b.path &&
    a.absPath === b.absPath &&
    a.context === b.context &&
    a.binary === b.binary &&
    a.truncated === b.truncated &&
    a.left.label === b.left.label &&
    a.left.content === b.left.content &&
    a.right.label === b.right.label &&
    a.right.content === b.right.content &&
    a.worktreeEncoding === b.worktreeEncoding &&
    a.worktreeLineEndings === b.worktreeLineEndings &&
    a.hunksSuppressed === b.hunksSuppressed &&
    sameHunks(a.hunks, b.hunks)
  );
}

function sameHunks(a: git.Hunk[], b: git.Hunk[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (h, i) =>
        h.patch === b[i].patch && h.newStart === b[i].newStart && h.newLines === b[i].newLines
    )
  );
}

/** Editor buffers are LF-joined by CodeMirror while git snapshots preserve
 * raw file bytes; any comparison between the two must run in one line-ending
 * domain. */
function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Parses git's "[branch hash] subject" commit summary line. */
function parseCommitSummary(output: string): Pick<CommitReceipt, 'branch' | 'hash' | 'subject'> {
  const match = /^\[(.+?) (?:\(root-commit\) )?([0-9a-f]+)\] (.*)$/m.exec(output);
  if (!match) return { branch: '', hash: '', subject: '' };
  return { branch: match[1], hash: match[2], subject: match[3] };
}

/** Trailing debounce for watcher-driven refreshes; batches event bursts
 * (branch switches, installs) into one `git status` run. */
export const GIT_REFRESH_DEBOUNCE_MS = 300;

/** Rotates the panel's conflict list so the opened path is first, preserving
 * the panel's relative order. Starting from the middle of the list then walks
 * the rest and wraps once, instead of jumping back to the top — and no second
 * progress model is needed to describe where the user is. */
function rotateMergeQueue(queue: string[], path: string): string[] {
  const index = queue.indexOf(path);
  if (index < 0) return [path, ...queue];
  if (index === 0) return [...queue];
  return [...queue.slice(index), ...queue.slice(0, index)];
}

export type GitOp =
  | 'stage'
  | 'unstage'
  | 'intent-to-add'
  | 'commit'
  | 'pull'
  | 'push'
  | 'checkout'
  | 'generate';

interface GitState {
  /** Workspace root git commands run from; null = no workspace. */
  root: string | null;
  status: git.RepoStatus | null;
  /** Absolute path → row decoration, for tree lookups. */
  statusByPath: Record<string, GitRowStatus>;
  branches: string[];
  commitMessage: string;
  isRefreshing: boolean;
  opInFlight: GitOp | null;
  /** Last mutating-op output (e.g. "Already up to date.") for the panel. */
  lastOpOutput: string | null;
  /** Last operation error, shown inline in the panel (conflicts etc.). */
  lastError: string | null;
  /** Set on successful commit; cleared by the next mutating op or reset. */
  lastCommitReceipt: CommitReceipt | null;
  aiAvailable: boolean;
  /** Monotonic guard: refreshes started before the last workspace switch
   * must not apply their result. */
  epoch: number;
  /** Bumped on each accepted status snapshot so HEAD-backed consumers refetch. */
  statusRevision: number;
  /** Bumped when a consumer (status bar) wants the branch popup focused;
   * the git panel watches this like SearchPanel watches focusInputRevision. */
  focusBranchRevision: number;
  /** The open diff preview tab; a new openDiff reuses it in place. */
  diffSession: DiffSession | null;
  /** The change the open diff was built from, so a refresh can re-run it even
   * after an unsaved edit drops the file out of git status. */
  diffSource: GitFileChange | null;
  /** True when the diff tab is the visible editor surface. */
  diffFocused: boolean;
  /** True when the merge-resolution tab is the visible editor surface. */
  mergeFocused: boolean;
  /** The open merge-resolution session; null when none. */
  mergeSession: MergeSession | null;
  /** True during the gap between a finalized session closing and the next
   * queued one opening. The editor shell treats the gap as a hand-off rather
   * than a close, so focus does not bounce through the fallback surface. */
  mergeAdvancePending: boolean;
  /** Politely announced when the queue hands off to the next conflicted file.
   * Owned here because the store owns the queue; the editor only keeps the live
   * region mounted. */
  mergeQueueAnnouncement: string;
}

interface GitActions {
  resetForWorkspace: (root: string | null) => void;
  refresh: () => Promise<void>;
  scheduleRefresh: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  /** Track untracked paths without staging content (git add -N): the files
   * gain an empty index blob so they diff normally and can be staged
   * hunk-by-hunk. */
  intentToAdd: (paths: string[]) => Promise<void>;
  /** Stage (reverse=false) or unstage (reverse=true) a single diff hunk by
   * applying its patch to the index. Refreshes status + the open diff after. */
  applyHunk: (patch: string, reverse: boolean) => Promise<void>;
  setCommitMessage: (message: string) => void;
  commit: (amend: boolean) => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  loadBranches: () => Promise<void>;
  checkout: (branch: string, create: boolean) => Promise<void>;
  generateMessage: () => Promise<void>;
  probeAiAvailable: () => Promise<void>;
  requestBranchPopupFocus: () => void;
  openDiff: (
    change: GitFileChange,
    context: DiffContext,
    opts?: { focus?: boolean }
  ) => Promise<void>;
  refreshOpenDiff: () => Promise<void>;
  closeDiff: () => void;
  setDiffFocused: (focused: boolean) => void;
  setEditorFocus: (focus: EditorFocus) => void;
  /** Open the merge-resolution surface for a conflicted file. Flushes the
   * file's dirty editor buffer to disk first so markers are parsed from the
   * bytes the session will display. Resolves false (with a user-facing toast
   * where actionable) when no session could be built. */
  openMergeResolution: (path: string, fileQueue: string[]) => Promise<boolean>;
  /** Record how a region was resolved (text sessions only). */
  recordDecision: (index: number, choice: MergeDecision) => void;
  /** Reopen a resolved region: forget its decision (text sessions only). */
  reopenDecision: (index: number) => void;
  /** Choose which whole-file side wins (sides sessions only). */
  selectMergeSide: (side: 'ours' | 'theirs') => void;
  /** Mark the session touched, from the editor's document-change signal.
   * Idempotent: an already-dirty session keeps its object identity. */
  markMergeDirty: () => void;
  /** A signal that the file at absPath may have changed. Revalidates the open
   * session when the path matches. Advisory: it can never authorize a write. */
  notifyMergeFileChanged: (absPath: string) => Promise<void>;
  /** Reload (or Retry): read the conflict state again at click time and, when it
   * moved, replace the session with that fresh read — discarding decisions. */
  applyMergeReload: () => Promise<void>;
  /** Keep working: hide a worktree-scoped notice. NOT overwrite consent — the
   * mismatched version stays on the session and Write and stage still asks. */
  acknowledgeMergeExternal: () => void;
  /** Ask to close. A pristine session closes immediately; a touched one raises
   * the discard confirmation instead. Every close entry point (Esc, the merge
   * tab's X, resolved-outside) goes through here so none can bypass the guard. */
  requestMergeClose: () => void;
  /** Dismiss the discard confirmation, keeping the session and its decisions. */
  cancelMergeClose: () => void;
  /** Discard the session from the confirmation. Never writes. */
  confirmMergeClose: () => void;
  /** Discard the session. Never writes — worktree and markers stay intact.
   * Also invalidates any in-flight open so a closed surface cannot reappear.
   * The final primitive: UI entry points call requestMergeClose instead. */
  closeMergeResolution: () => void;
  /** Write the resolved file and stage it, then advance to the next queued
   * conflicted file. Text sessions require the resolved Result document;
   * sides sessions apply the previously selected side via the backend
   * finalize op. Resolves true when the stage succeeded (a supersession
   * after that point only skips the queue advance); false means the file was
   * not staged — before the write that is always a clean no-op, after it the
   * error toast says what still needs doing. */
  mergeFinalizeAndStage: (result?: string) => Promise<boolean>;
  /** Write and stage over a working-tree change the user has explicitly chosen
   * to overwrite. Reads the conflict state again at confirmation time and
   * finalizes against THAT version, so a file that moved while the dialog was
   * open is refused rather than clobbered. */
  mergeOverwriteAndStage: (result?: string) => Promise<boolean>;
}

type GitStore = GitState & GitActions;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let diffRequestRevision = 0;
/** Monotonic id for openMergeResolution requests, so a superseded open (or
 * one predating a workspace switch) drops its result instead of clobbering
 * the newer session. */
let mergeRequestRevision = 0;
/** True while a merge finalize is running — a second click must not start a
 * concurrent write/stage pair against the same session. */
let mergeFinalizeInFlight = false;
/** User-initiated openDiff calls currently in flight. Background refreshes
 * yield to these: a refresh that bumped the request revision mid-click would
 * get the user's completion discarded and their click would appear dead. */
let userDiffRequestsInFlight = 0;

/** Monotonic id for merge revalidations. Only the newest read may install:
 * two overlapping reads can finish in either order, and letting the older one
 * land would install a session describing an older moment. */
let mergeRevalidationGeneration = 0;

/** Current openDiff request id, read by the diff view when the user types so
 * it can tell refreshes that predate the edit from ones that supersede it. */
export const getDiffRequestRevision = () => diffRequestRevision;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The diff and merge surfaces render inside the Files column, which #271 can
 * reduce to a rail — so publishing one for the user has to ask for that column
 * (spec §6.3). Called only after this store's own request/epoch/write guards
 * accepted a focused result, never on a background refresh or a refused open.
 *
 * Direct rather than through `utils/editorSurface`: that helper also owns the
 * git↔configuration focus exclusivity, which these paths set themselves, and
 * importing it here would loop utils back into the store it builds on.
 */
function revealFilesColumn(): void {
  const ide = useIDEStore.getState();
  if (!ide.isRestoringWorkspace) ide.revealCenterPanel('files');
}

export const useGitStore = create<GitStore>()(
  devtools(
    (set, get) => ({
      root: null,
      status: null,
      statusByPath: {},
      branches: [],
      commitMessage: '',
      isRefreshing: false,
      opInFlight: null,
      lastOpOutput: null,
      lastError: null,
      lastCommitReceipt: null,
      aiAvailable: false,
      epoch: 0,
      statusRevision: 0,
      focusBranchRevision: 0,
      diffSession: null,
      diffSource: null,
      diffFocused: false,
      mergeFocused: false,
      mergeSession: null,
      mergeAdvancePending: false,
      mergeQueueAnnouncement: '',

      resetForWorkspace: (root) => {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
          refreshTimer = null;
        }
        set(
          (state) => ({
            root,
            status: null,
            statusByPath: {},
            branches: [],
            commitMessage: '',
            isRefreshing: false,
            opInFlight: null,
            lastOpOutput: null,
            lastError: null,
            lastCommitReceipt: null,
            diffSession: null,
            diffSource: null,
            diffFocused: false,
            mergeFocused: false,
            mergeSession: null,
            mergeAdvancePending: false,
            mergeQueueAnnouncement: '',
            epoch: state.epoch + 1,
            statusRevision: 0,
          }),
          false,
          'git/resetForWorkspace'
        );
      },

      refresh: async () => {
        const { root, epoch } = get();
        if (!root) return;
        set({ isRefreshing: true }, false, 'git/refreshStart');
        try {
          const status = await GitStatus(root);
          if (get().epoch !== epoch) return; // workspace switched mid-flight
          const statusByPath = status.isRepo
            ? buildStatusByPath(status.repoRoot, status.files ?? [])
            : {};
          set(
            (state) => ({
              status,
              statusByPath,
              isRefreshing: false,
              statusRevision: state.statusRevision + 1,
            }),
            false,
            'git/refreshDone'
          );
          // Keep an open diff in sync with the just-loaded status (live edits).
          // Awaited so callers see a consistent snapshot; it early-returns when
          // no diff is open, so the common path stays cheap.
          await get().refreshOpenDiff();
          // An index-only resolution (`git add` in a terminal) changes no
          // watched file, so the watcher never fires and this snapshot is the
          // only signal. Hand it to the same revalidator rather than setting a
          // banner here: the policy lives in one place, and a snapshot for a
          // different repo or a since-replaced session must not act at all.
          const merge = get().mergeSession;
          if (
            merge &&
            get().epoch === epoch &&
            status.isRepo &&
            status.repoRoot === merge.repoRoot &&
            !(status.files ?? []).some((file) => file.path === merge.path && file.unmerged)
          ) {
            await revalidateMergeSession(get, set);
          }
        } catch (err) {
          if (get().epoch !== epoch) return;
          set({ isRefreshing: false }, false, 'git/refreshFailed');
          useIDEStore.getState().showToast(`Git status failed: ${toErrorMessage(err)}`, 'error');
        }
      },

      scheduleRefresh: () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void get().refresh();
        }, GIT_REFRESH_DEBOUNCE_MS);
      },

      stage: async (paths) => {
        await runOp('stage', get, set, async (root) => {
          await GitStage(root, paths);
          return null;
        });
      },

      unstage: async (paths) => {
        await runOp('unstage', get, set, async (root) => {
          await GitUnstage(root, paths);
          return null;
        });
      },

      intentToAdd: async (paths) => {
        await runOp('intent-to-add', get, set, async (root) => {
          await GitIntentToAdd(root, paths);
          return null;
        });
      },

      // Applying a hunk IS a stage/unstage op, so it reuses runOp: single-flight
      // against other git ops and an automatic status + open-diff refresh, which
      // repaints the diff with the now-reduced hunk set.
      applyHunk: async (patch, reverse) => {
        await runOp(reverse ? 'unstage' : 'stage', get, set, async (root) => {
          await GitApplyHunk(root, patch, reverse);
          return null;
        });
      },

      setCommitMessage: (commitMessage) => set({ commitMessage }, false, 'git/setCommitMessage'),

      commit: async (amend) => {
        const message = get().commitMessage;
        // Snapshot the staged set before the commit consumes it.
        const stagedFiles = (get().status?.files ?? [])
          .filter((f) => classifyChange(f).staged)
          .map((f) => f.path);
        const ok = await runOp('commit', get, set, (root) => GitCommit(root, message, amend));
        if (ok) {
          const output = get().lastOpOutput ?? '';
          set(
            {
              commitMessage: '',
              lastCommitReceipt: { ...parseCommitSummary(output), files: stagedFiles, output },
            },
            false,
            'git/commitReceipt'
          );
        }
      },

      pull: async () => {
        await runOp('pull', get, set, (root) => GitPull(root));
      },

      push: async () => {
        await runOp('push', get, set, (root) => GitPush(root));
      },

      loadBranches: async () => {
        const { root } = get();
        if (!root) return;
        try {
          const branches = await GitBranches(root);
          set({ branches: branches ?? [] }, false, 'git/loadBranches');
        } catch (err) {
          useIDEStore.getState().showToast(`Git branches failed: ${toErrorMessage(err)}`, 'error');
        }
      },

      checkout: async (branch, create) => {
        const ok = await runOp('checkout', get, set, async (root) => {
          await GitCheckout(root, branch, create);
          return null;
        });
        if (ok) await get().loadBranches();
      },

      generateMessage: async () => {
        await runOp(
          'generate',
          get,
          set,
          (root) => GitGenerateCommitMessage(root),
          (message) => ({ commitMessage: message ?? '', lastOpOutput: null })
        );
      },

      probeAiAvailable: async () => {
        try {
          const aiAvailable = await GitCommitMessageAvailable();
          set({ aiAvailable }, false, 'git/probeAiAvailable');
        } catch {
          set({ aiAvailable: false }, false, 'git/probeAiAvailable');
        }
      },

      requestBranchPopupFocus: () =>
        set(
          (state) => ({ focusBranchRevision: state.focusBranchRevision + 1 }),
          false,
          'git/requestBranchPopupFocus'
        ),

      openDiff: async (change, context, opts) => {
        const { root, status, epoch } = get();
        const repoRoot = status?.isRepo ? status.repoRoot : root;
        if (!repoRoot) return;
        const requestRevision = ++diffRequestRevision;
        const untracked = classifyChange(change).untracked;
        const focus = opts?.focus ?? true;
        if (focus) userDiffRequestsInFlight++;

        try {
          let left: DiffSide;
          let right: DiffSide;
          let binary = false;
          let truncated = false;
          // The working-tree file's encoding/line endings, for round-tripping a
          // disk-write edit. Only unstaged sessions have a live worktree side.
          let worktreeEncoding: string | undefined;
          let worktreeLineEndings: string | undefined;
          // The working-tree side is showing an unsaved editor buffer, which
          // git hasn't diffed — its disk-based hunks wouldn't line up with (or
          // stage) what's on screen, so per-hunk staging is suppressed until save.
          let dirtyBufferWorktree = false;

          const fetchRev = async (
            rev: 'HEAD' | ':0',
            label: string,
            path = change.path
          ): Promise<DiffSide> => {
            const fc = await GitFileAtRev(repoRoot, rev, path);
            binary = binary || fc.binary;
            truncated = truncated || fc.truncated;
            return { label, content: fc.content };
          };

          const abs = joinRepoPath(repoRoot, change.path);
          if (context === 'staged') {
            left = await fetchRev('HEAD', 'HEAD', change.origPath ?? change.path);
            right = await fetchRev(':0', 'Index');
          } else {
            // Untracked files have no index version; diff against empty.
            left = untracked ? { label: 'Index', content: '' } : await fetchRev(':0', 'Index');
            // Prefer the live editor buffer if the file is open, so the diff
            // reflects unsaved edits; otherwise read from disk. Match with the
            // app's canonical path comparison — the open file's path (native,
            // possibly URI-decoded) may differ in representation from abs.
            const openFile = useIDEStore
              .getState()
              .openFiles.find((f) => pathsReferToSameFile(f.path, abs));
            let worktree = '';
            if (openFile) {
              worktree = openFile.content ?? '';
              worktreeEncoding = openFile.encoding;
              worktreeLineEndings = openFile.lineEndings;
              dirtyBufferWorktree = openFile.isModified === true;
            } else if (change.worktree === 'D') {
              // A deleted file has no metadata to preserve, so its empty
              // worktree snapshot remains read-only.
            } else {
              const result = await ReadFile(abs);
              if (result === null) {
                throw new Error(`ReadFile returned no content for ${abs}`);
              }
              worktree = result.content ?? '';
              binary = binary || result.isBinary === true;
              worktreeEncoding = result.encoding;
              worktreeLineEndings = result.lineEndings;
            }
            right = { label: 'Working Tree', content: worktree };
          }

          // Per-hunk staging data for tracked, textual, in-size diffs.
          // Untracked/staged-rename/binary/too-large diffs stage whole-file only,
          // so skip the extra git call and leave hunks empty (no gutter button).
          let hunks: git.Hunk[] = [];
          const stagedRename = context === 'staged' && change.origPath;
          const hunkable = !untracked && !stagedRename && !binary && !truncated;
          if (hunkable && !dirtyBufferWorktree) {
            const fh = await GitFileHunks(repoRoot, change.path, context === 'staged');
            hunks = fh.hunks ?? [];
          }

          if (get().epoch !== epoch || requestRevision !== diffRequestRevision) return;
          const next: DiffSession = {
            path: change.path,
            absPath: abs,
            context,
            left,
            right,
            binary,
            truncated,
            hunks,
            // Skipped only because the buffer hasn't been saved yet — the next
            // post-save refresh will deliver real hunks for the same diff.
            hunksSuppressed: hunkable && dirtyBufferWorktree,
            requestRevision,
            worktreeEncoding,
            worktreeLineEndings,
          };
          set(
            (state) => ({
              // Reuse the existing object when nothing changed so a live refresh
              // doesn't rebuild the merge view (and reset scroll) on every save.
              diffSession: sameSession(state.diffSession, next) ? state.diffSession! : next,
              // Remember the originating change so a refresh can re-run even
              // after an unsaved edit drops the file out of git status.
              diffSource: change,
              // A refresh (focus:false) keeps whatever the user was looking at.
              diffFocused: focus ? true : state.diffFocused,
              mergeFocused: focus ? false : state.mergeFocused,
            }),
            false,
            'git/openDiff'
          );
          // The diff surface lives inside the Files column, so a focused open is
          // also a request to see that column (#271 §6.3) — every time, since
          // reopening the same path from another context is still an intent. A
          // background refresh (focus:false) changes nothing the user asked for.
          if (focus) revealFilesColumn();
        } catch (err) {
          if (get().epoch === epoch && requestRevision === diffRequestRevision) {
            useIDEStore.getState().showToast(`Diff failed: ${toErrorMessage(err)}`, 'error');
          }
        } finally {
          if (focus) userDiffRequestsInFlight--;
        }
      },

      // Re-run the open diff against the latest status so ongoing edits show up
      // live. Keeps the same file+context and preserves focus; if the file no
      // longer has changes, the diff simply re-fetches to matching content.
      refreshOpenDiff: async () => {
        const { diffSession, diffSource, status } = get();
        if (!diffSession || !status?.isRepo) return;
        // Yield to a click in flight: refreshing here would supersede the
        // user's request revision and their newly opened diff would be
        // discarded on completion. The user's own openDiff refreshes anyway.
        if (userDiffRequestsInFlight > 0) return;
        // Prefer the current status entry (updated XY letters). Fall back to the
        // originating change so an unsaved edit — which leaves disk unchanged
        // and drops the file from git status — still re-reads the live buffer.
        const change = (status.files ?? []).find((f) => f.path === diffSession.path) ?? diffSource;
        if (!change) return;
        // Follow a whole-file stage/unstage (the panel checkbox): when the open
        // context no longer has changes but the other one does, retarget so the
        // diff keeps showing the change the user is tracking — and lands back
        // in the editable working-tree view when they unstage. A partially
        // staged file has content in both contexts and stays put.
        let context = diffSession.context;
        const cls = classifyChange(change);
        if (context === 'unstaged' && !cls.unstaged && !cls.untracked && cls.staged) {
          context = 'staged';
        } else if (context === 'staged' && !cls.staged && (cls.unstaged || cls.untracked)) {
          context = 'unstaged';
        }
        await get().openDiff(change, context, { focus: false });
      },

      closeDiff: () =>
        set({ diffSession: null, diffSource: null, diffFocused: false }, false, 'git/closeDiff'),

      setDiffFocused: (diffFocused) => get().setEditorFocus(diffFocused ? 'diff' : 'file'),

      setEditorFocus: (focus) =>
        set(
          { diffFocused: focus === 'diff', mergeFocused: focus === 'merge' },
          false,
          'git/setEditorFocus'
        ),

      openMergeResolution: async (path, fileQueue) => {
        // A finalize is mid-write: snapshotting now would capture pre-write
        // markers and install a stale session over the completed resolution.
        // (Refused BEFORE the counter bump so the running finalize's own
        // guards are unaffected; the post-finalize advance re-opens freely.)
        // Toasted so a refused open is never a silent dead click.
        if (mergeFinalizeInFlight) {
          useIDEStore
            .getState()
            .showToast('Finishing the previous resolution — try again in a moment', 'info');
          return false;
        }
        const installedSession = get().mergeSession;
        if (installedSession?.path === path) {
          get().setEditorFocus('merge');
          revealFilesColumn();
          return true;
        }
        if (installedSession) {
          useIDEStore.getState().showToast('Close the current merge resolution first', 'info');
          return false;
        }
        const { root, status, epoch } = get();
        const repoRoot = status?.isRepo ? status.repoRoot : root;
        if (!repoRoot) return false;
        const requestRevision = ++mergeRequestRevision;
        const isCurrent = () => get().epoch === epoch && requestRevision === mergeRequestRevision;
        const abs = joinRepoPath(repoRoot, path);

        // Flush any unsaved editor buffer first: the snapshot must be parsed
        // from the same bytes the session displays, and git only sees disk.
        try {
          await saveOpenFileToDisk(abs);
        } catch (err) {
          if (isCurrent()) {
            useIDEStore
              .getState()
              .showToast(`Could not save ${path}: ${toErrorMessage(err)}`, 'error');
          }
          return false;
        }
        if (!isCurrent()) return false;
        const fileWriteRevision = getFileWriteRevision(abs);
        const fileStayedStable = () => {
          if (getFileWriteRevision(abs) === fileWriteRevision) return true;
          if (isCurrent()) {
            useIDEStore
              .getState()
              .showToast(`${path} changed while opening its merge session — try again`, 'error');
          }
          return false;
        };

        try {
          // ONE coherent backend read decides everything: the stages, the text
          // snapshot (absent when the stage topology needs the whole-file side
          // UI), the operation heads, and the source version that identifies
          // exactly this state. Assembling a session from separate calls would
          // let an intervening write make its parts describe different moments.
          const state = await GitConflictState(repoRoot, path);
          if (!isCurrent()) return false;
          if (!fileStayedStable()) return false;
          if (!state.stages.base && !state.stages.ours && !state.stages.theirs) {
            useIDEStore.getState().showToast(`${path} is not conflicted`, 'info');
            return false;
          }
          if (!state.heads) {
            useIDEStore
              .getState()
              .showToast(
                `Cannot resolve ${path}: no merge, rebase, or cherry-pick in progress`,
                'error'
              );
            return false;
          }

          const base = {
            path,
            absPath: abs,
            repoRoot,
            labels: state.heads,
            fileQueue: rotateMergeQueue(fileQueue, path),
            requestRevision,
            epoch,
            fileWriteRevision,
            sourceVersion: state.sourceVersion,
            stages: state.stages,
            dirty: false,
            reloadPending: false,
            closeRequested: false,
          };
          if (!state.snapshot) {
            set(
              {
                mergeSession: { kind: 'sides', ...base },
                diffFocused: false,
                mergeFocused: true,
              },
              false,
              'git/openMergeResolution'
            );
            revealFilesColumn();
            return true;
          }

          const snap = state.snapshot;
          if (!snap.regions || snap.regions.length === 0) {
            useIDEStore.getState().showToast(`No conflict markers found in ${path}`, 'info');
            return false;
          }
          set(
            {
              mergeSession: {
                kind: 'text',
                ...base,
                content: snap.content,
                encoding: snap.encoding,
                lineEndings: snap.lineEndings,
                regions: snap.regions,
                decisions: {},
                readOnly: !isWritableFormat(snap.encoding, snap.lineEndings),
              },
              diffFocused: false,
              mergeFocused: true,
            },
            false,
            'git/openMergeResolution'
          );
          revealFilesColumn();
          return true;
        } catch (err) {
          if (isCurrent()) {
            useIDEStore
              .getState()
              .showToast(`Merge resolution failed: ${toErrorMessage(err)}`, 'error');
          }
          return false;
        }
      },

      recordDecision: (index, choice) => {
        const session = get().mergeSession;
        if (session?.kind !== 'text') return;
        // A phantom decision outside the region space would corrupt
        // completion accounting ("all regions decided" gates) silently.
        if (index < 0 || index >= session.regions.length) return;
        set(
          {
            mergeSession: {
              ...session,
              dirty: true,
              decisions: { ...session.decisions, [index]: choice },
            },
          },
          false,
          'git/recordDecision'
        );
      },

      reopenDecision: (index) => {
        const session = get().mergeSession;
        if (session?.kind !== 'text') return;
        const decisions = { ...session.decisions };
        delete decisions[index];
        set({ mergeSession: { ...session, dirty: true, decisions } }, false, 'git/reopenDecision');
      },

      selectMergeSide: (side) => {
        const session = get().mergeSession;
        if (session?.kind !== 'sides') return;
        // A different side invalidates any already-applied one: the next
        // finalize must apply the new choice before staging.
        set(
          {
            mergeSession: {
              ...session,
              selectedSide: side,
              dirty: true,
              appliedSide: session.appliedSide?.side === side ? session.appliedSide : undefined,
            },
          },
          false,
          'git/selectMergeSide'
        );
      },

      markMergeDirty: () => {
        const session = get().mergeSession;
        // Idempotent by identity: this runs on every document change, and a
        // fresh session object per keystroke would re-render every consumer.
        if (!session || session.dirty) return;
        set({ mergeSession: { ...session, dirty: true } }, false, 'git/markMergeDirty');
      },

      notifyMergeFileChanged: async (absPath) => {
        const session = get().mergeSession;
        if (!session) return;
        if (!pathsReferToSameFile(session.absPath, absPath)) return;
        await revalidateMergeSession(get, set);
      },

      applyMergeReload: async () => {
        const session = get().mergeSession;
        if (!session || session.reloadPending) return;
        // Bind synchronously so a close or queue advance between the click and
        // the read can drop this continuation, and so the surface freezes
        // instead of accepting a second click.
        set({ mergeSession: { ...session, reloadPending: true } }, false, 'git/mergeReloadStart');
        await revalidateMergeSession(get, set, { force: true });
      },

      acknowledgeMergeExternal: () => {
        const session = get().mergeSession;
        const external = session?.external;
        if (!session || external?.kind !== 'changed') return;
        // Conflict-scoped changes stay visible: the sides themselves moved, so
        // hiding the notice would hide the fact that Current and Incoming no
        // longer mean what the user reviewed.
        if (external.scope !== 'worktree' || external.hidden) return;
        set(
          { mergeSession: { ...session, external: { ...external, hidden: true } } },
          false,
          'git/acknowledgeMergeExternal'
        );
      },

      requestMergeClose: () => {
        const session = get().mergeSession;
        if (!session) return;
        // Closing never writes, so the only thing at stake is the user's
        // in-session work. Pristine means there is none.
        if (!session.dirty) {
          get().closeMergeResolution();
          return;
        }
        if (session.closeRequested) return;
        set({ mergeSession: { ...session, closeRequested: true } }, false, 'git/requestMergeClose');
      },

      cancelMergeClose: () => {
        const session = get().mergeSession;
        if (!session?.closeRequested) return;
        set({ mergeSession: { ...session, closeRequested: false } }, false, 'git/cancelMergeClose');
      },

      confirmMergeClose: () => {
        if (!get().mergeSession) return;
        get().closeMergeResolution();
      },

      closeMergeResolution: () => {
        // Invalidate any in-flight open too — a session installing after the
        // user closed the surface would make it reappear.
        mergeRequestRevision++;
        set(
          {
            mergeSession: null,
            mergeFocused: false,
            mergeAdvancePending: false,
            mergeQueueAnnouncement: '',
          },
          false,
          'git/closeMergeResolution'
        );
      },

      mergeFinalizeAndStage: async (result) => finalizeMergeSession(get, set, result, null),

      mergeOverwriteAndStage: async (result) => {
        const session = get().mergeSession;
        if (!session) return false;
        if (mergeFinalizeInFlight) return false;
        const external = session.external;
        // Only a worktree-scoped change can be knowingly overwritten. A moved
        // head or stage means the user reviewed different sides entirely.
        if (external?.kind !== 'changed' || external.scope !== 'worktree') return false;

        let state: git.ConflictState;
        try {
          // Read at confirmation time: the file may have moved again while the
          // dialog was on screen, and the notice's version is already history.
          state = await GitConflictState(session.repoRoot, session.path);
        } catch (err) {
          useIDEStore
            .getState()
            .showToast(
              `Could not check ${session.path} before overwriting: ${toErrorMessage(err)}`,
              'error'
            );
          return false;
        }
        const live = get().mergeSession;
        if (!live || live.requestRevision !== session.requestRevision) return false;

        if (!state.stages.base && !state.stages.ours && !state.stages.theirs) {
          setMergeExternal(get, set, live, {
            kind: 'resolved-outside',
            message: `${live.path} is no longer conflicted — it was resolved outside Firn.`,
          });
          return false;
        }
        if (!sameConflictIdentity(live, state)) {
          // What the user reviewed is gone; overwriting would stage a decision
          // about sides that no longer exist.
          setMergeExternal(get, set, live, {
            kind: 'changed',
            hidden: false,
            scope: 'conflict',
            observedVersion: state.sourceVersion,
          });
          return false;
        }
        if (live.kind === 'text') {
          if (!state.snapshot) {
            setMergeExternal(get, set, live, {
              kind: 'changed',
              hidden: false,
              scope: 'conflict',
              observedVersion: state.sourceVersion,
            });
            return false;
          }
          if (state.snapshot.regions.length === 0) {
            setMergeExternal(get, set, live, {
              kind: 'resolved-outside',
              message: `The conflict markers in ${live.path} are gone — it was resolved outside Firn. Stage it from the Source Control panel.`,
            });
            return false;
          }
        } else if (state.snapshot) {
          setMergeExternal(get, set, live, {
            kind: 'changed',
            hidden: false,
            scope: 'conflict',
            observedVersion: state.sourceVersion,
          });
          return false;
        }
        // The fresh read is NOT installed: the user is overwriting on purpose,
        // and their decisions are the whole point of the operation.
        return finalizeMergeSession(get, set, result, state.sourceVersion);
      },
    }),
    { name: 'git-store' }
  )
);

type MergeSetter = (partial: Partial<GitState>, replace: false, name: string) => void;

/** What a revalidation was started for. Every one of these must still hold
 * after the await, or the read describes a session that no longer exists. */
interface MergeRevalidationBinding {
  generation: number;
  absPath: string;
  requestRevision: number;
  epoch: number;
}

// Generated stages are `StageBlob | null`; the presence check below already
// treats absent and null the same, so accept both rather than guard each caller.
function sameStageBlob(a?: git.StageBlob | null, b?: git.StageBlob | null): boolean {
  if (!a || !b) return !a && !b;
  return a.hash === b.hash && a.mode === b.mode && a.size === b.size;
}

/**
 * Exact conflict identity: the operation heads plus every stage's presence,
 * mode, and object. Used ONLY to classify whether an external change is
 * something the user could knowingly overwrite (worktree bytes moved) or must
 * reload (the sides themselves moved, so Current/Incoming no longer mean what
 * was reviewed). `sourceVersion` remains the authority for no-op and mutation
 * decisions — this never gates a write.
 */
function sameConflictIdentity(session: MergeSession, state: git.ConflictState): boolean {
  const heads = state.heads;
  if (!heads) return false;
  if (
    session.labels.operation !== heads.operation ||
    session.labels.ours.hash !== heads.ours.hash ||
    session.labels.theirs.hash !== heads.theirs.hash
  ) {
    return false;
  }
  if (Boolean(session.stages.binary) !== Boolean(state.stages.binary)) return false;
  return (
    sameStageBlob(session.stages.base, state.stages.base) &&
    sameStageBlob(session.stages.ours, state.stages.ours) &&
    sameStageBlob(session.stages.theirs, state.stages.theirs)
  );
}

function sameExternal(a: MergeExternalChange | undefined, b: MergeExternalChange): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'changed' && b.kind === 'changed') {
    return a.scope === b.scope && a.hidden === b.hidden && a.observedVersion === b.observedVersion;
  }
  if (a.kind === 'resolved-outside' && b.kind === 'resolved-outside')
    return a.message === b.message;
  if (a.kind === 'check-failed' && b.kind === 'check-failed') return a.message === b.message;
  return false;
}

/** Applies an external-change notice without touching content or decisions. */
function setMergeExternal(
  get: () => GitStore,
  set: MergeSetter,
  session: MergeSession,
  external: MergeExternalChange
): void {
  // resolved-outside is terminal for the session that observed it: a later
  // failed or partial hint must not downgrade it back to "maybe fine".
  if (session.external?.kind === 'resolved-outside' && external.kind !== 'resolved-outside') return;
  if (sameExternal(session.external, external)) return;
  if (get().mergeSession !== session) return;
  set({ mergeSession: { ...session, external } }, false, 'git/mergeExternalChange');
}

function clearMergeExternal(get: () => GitStore, set: MergeSetter, session: MergeSession): void {
  if (!session.external) return;
  if (get().mergeSession !== session) return;
  const cleared: MergeSession = { ...session };
  delete cleared.external;
  set({ mergeSession: cleared }, false, 'git/mergeExternalCleared');
}

/** Builds the replacement session from one coherent read, keeping only the
 * scoped queue. Decisions are deliberately NOT carried over: region indexes are
 * positional, so transplanting them onto fresh regions is exactly the
 * stale-coordinate corruption the whole-session swap exists to prevent. */
function revalidatedMergeSession(
  session: MergeSession,
  state: git.ConflictState,
  requestRevision: number
): MergeSession | null {
  if (!state.heads) return null;
  const base = {
    path: session.path,
    absPath: session.absPath,
    repoRoot: session.repoRoot,
    labels: state.heads,
    fileQueue: session.fileQueue,
    requestRevision,
    epoch: session.epoch,
    fileWriteRevision: getFileWriteRevision(session.absPath),
    sourceVersion: state.sourceVersion,
    stages: state.stages,
    dirty: false,
    reloadPending: false,
    closeRequested: false,
  };
  if (!state.snapshot) return { kind: 'sides', ...base };
  return {
    kind: 'text',
    ...base,
    content: state.snapshot.content,
    encoding: state.snapshot.encoding,
    lineEndings: state.snapshot.lineEndings,
    regions: state.snapshot.regions,
    decisions: {},
    readOnly: !isWritableFormat(state.snapshot.encoding, state.snapshot.lineEndings),
  };
}

function clearMergeReloadPending(
  get: () => GitStore,
  set: MergeSetter,
  binding: MergeRevalidationBinding
): void {
  const live = get().mergeSession;
  // Only the session that started the Reload may clear its flag; a close or a
  // queue advance in between drops the continuation entirely.
  if (!live || live.absPath !== binding.absPath) return;
  if (live.requestRevision !== binding.requestRevision) return;
  if (!live.reloadPending) return;
  set({ mergeSession: { ...live, reloadPending: false } }, false, 'git/mergeReloadSettled');
}

/**
 * The single reconciliation path for an open merge session.
 *
 * One coherent `GitConflictState` read, then exactly one of: no-op, whole-session
 * swap, or an external-change notice. There is no regions-only update — applying
 * fresh regions to older content would leave every marker range pointing at the
 * wrong bytes.
 *
 * `force` is Reload/Retry: it reads at click time (never applying a candidate
 * captured when a notice was raised) and may replace a touched session, which is
 * what the user asked for.
 */
async function revalidateMergeSession(
  get: () => GitStore,
  set: MergeSetter,
  options: { force?: boolean } = {}
): Promise<void> {
  const force = options.force === true;
  const session = get().mergeSession;
  if (!session) return;
  // A finalize is mid-write: the backend's own version guard is authoritative
  // there, and reading a half-written worktree would only produce noise. The
  // refresh that follows the operation is the next signal.
  if (mergeFinalizeInFlight) return;
  // A user-requested Reload owns the session until it settles.
  if (session.reloadPending && !force) return;

  const binding: MergeRevalidationBinding = {
    generation: ++mergeRevalidationGeneration,
    absPath: session.absPath,
    requestRevision: session.requestRevision,
    epoch: session.epoch,
  };
  const live = (): MergeSession | null => {
    const current = get().mergeSession;
    if (!current) return null;
    if (current.absPath !== binding.absPath) return null;
    if (current.requestRevision !== binding.requestRevision) return null;
    if (get().epoch !== binding.epoch) return null;
    if (mergeRevalidationGeneration !== binding.generation) return null;
    return current;
  };

  let state: git.ConflictState;
  try {
    state = await GitConflictState(session.repoRoot, session.path);
  } catch (err) {
    const current = live();
    if (!current) return;
    if (force) {
      useIDEStore
        .getState()
        .showToast(`Could not reload ${current.path}: ${toErrorMessage(err)}`, 'error');
      clearMergeReloadPending(get, set, binding);
    }
    // A session nobody could verify must not stay silently writable.
    setMergeExternal(get, set, live() ?? current, {
      kind: 'check-failed',
      message: `Could not check ${current.path} for outside changes: ${toErrorMessage(err)}`,
    });
    return;
  }

  let current = live();
  if (!current) return;
  const finish = () => {
    if (force) clearMergeReloadPending(get, set, binding);
  };

  if (!state.stages.base && !state.stages.ours && !state.stages.theirs) {
    setMergeExternal(get, set, current, {
      kind: 'resolved-outside',
      message: `${current.path} is no longer conflicted — it was resolved outside Firn.`,
    });
    finish();
    return;
  }

  if (state.sourceVersion === current.sourceVersion) {
    // Nothing moved. This is also what makes Firn's own writes harmless: the
    // finalize updates the session to the version its write produced, so the
    // watcher event that write triggers lands here.
    clearMergeExternal(get, set, current);
    finish();
    return;
  }

  if (state.snapshot && state.snapshot.regions.length === 0) {
    setMergeExternal(get, set, current, {
      kind: 'resolved-outside',
      message: `The conflict markers in ${current.path} are gone — it was resolved outside Firn. Stage it from the Source Control panel.`,
    });
    finish();
    return;
  }

  if (!state.heads) {
    setMergeExternal(get, set, current, {
      kind: 'check-failed',
      message: `Could not check ${current.path} for outside changes: its merge operation is no longer readable.`,
    });
    finish();
    return;
  }

  if (current.dirty && !force) {
    const scope = sameConflictIdentity(current, state) ? 'worktree' : 'conflict';
    const previous = current.external;
    // The user already dismissed THIS change: leave it dismissed. A different
    // version is a change they have not seen, so it raises the notice again.
    const hidden =
      previous?.kind === 'changed' &&
      previous.hidden &&
      previous.observedVersion === state.sourceVersion;
    setMergeExternal(get, set, current, {
      kind: 'changed',
      hidden,
      scope,
      observedVersion: state.sourceVersion,
    });
    finish();
    return;
  }

  const replacement = revalidatedMergeSession(current, state, mergeRequestRevision + 1);
  if (!replacement) {
    setMergeExternal(get, set, current, {
      kind: 'check-failed',
      message: `Could not check ${current.path} for outside changes: its merge operation is no longer readable.`,
    });
    finish();
    return;
  }
  current = live() ?? current;
  if (get().mergeSession !== current) {
    finish();
    return;
  }
  // One store update installs the whole replacement and claims a fresh request
  // revision, so any finalize or open still in flight against the old snapshot
  // is stale from this moment on.
  mergeRequestRevision += 1;
  set({ mergeSession: replacement }, false, 'git/mergeSessionReloaded');

  if (force) {
    // The forced read took time; anything that changed during it is unobserved.
    // One ordinary revalidation against the freshly installed session catches
    // it (and no-ops when nothing moved).
    await revalidateMergeSession(get, set, {});
  }
}

/**
 * Shared mutating-op wrapper: single-flight via opInFlight, error → lastError
 * + toast, success output → lastOpOutput, always refresh afterwards so the
 * panel reflects reality even after a failed op (a conflicted pull DID change
 * the worktree). Returns whether the op succeeded.
 */
async function runOp(
  op: GitOp,
  get: () => GitStore,
  set: (partial: Partial<GitState>, replace: false, name: string) => void,
  fn: (root: string) => Promise<string | null>,
  onSuccess?: (output: string | null) => Partial<GitState>
): Promise<boolean> {
  const { root, opInFlight, epoch } = get();
  if (!root || opInFlight) return false;
  const isCurrent = () => get().root === root && get().epoch === epoch;
  set(
    { opInFlight: op, lastError: null, lastOpOutput: null, lastCommitReceipt: null },
    false,
    `git/${op}Start`
  );
  try {
    const output = await fn(root);
    if (!isCurrent()) return false;
    set(
      { opInFlight: null, lastOpOutput: output, ...(onSuccess?.(output) ?? {}) },
      false,
      `git/${op}Done`
    );
    return true;
  } catch (err) {
    if (!isCurrent()) return false;
    const message = toErrorMessage(err);
    set({ opInFlight: null, lastError: message }, false, `git/${op}Failed`);
    useIDEStore.getState().showToast(`Git ${op} failed: ${message}`, 'error');
    return false;
  } finally {
    if (isCurrent()) void get().refresh();
  }
}

export const useGitStatusSnapshot = () =>
  useGitStore(
    useShallow((state) => ({
      status: state.status,
      isRefreshing: state.isRefreshing,
      opInFlight: state.opInFlight,
      lastError: state.lastError,
      lastOpOutput: state.lastOpOutput,
    }))
  );

export const useGitStatusByPath = () => useGitStore((state) => state.statusByPath);
export const useGitBranchInfo = () =>
  useGitStore(
    useShallow((state) => ({
      branch: state.status?.isRepo ? state.status.branch : '',
      ahead: state.status?.ahead ?? 0,
      behind: state.status?.behind ?? 0,
      changedCount: state.status?.files?.length ?? 0,
    }))
  );

/**
 * The one finalize implementation, shared by the ordinary Write and stage and
 * by the explicit overwrite confirmation.
 *
 * `expectedVersionOverride` is the version an overwrite read at confirmation
 * time; null means finalize against the version the session was built from.
 * Either way the backend re-derives it inside the same call as the mutation, so
 * this function's own checks are about Firn's surfaces (open buffers, queued
 * saves, workspace switches), not about outside processes.
 */
async function finalizeMergeSession(
  get: () => GitStore,
  set: MergeSetter,
  result: string | undefined,
  expectedVersionOverride: string | null
): Promise<boolean> {
  const session = get().mergeSession;
  if (!session) return false;
  // Single-flight: a second click while a finalize runs must not start
  // a concurrent write/stage pair against the same session.
  if (mergeFinalizeInFlight) return false;
  // An unresolved external state means this session is outdated or
  // unverifiable. The overwrite path supplies its own freshly read version and
  // is the only way past this.
  if (session.external && expectedVersionOverride === null) return false;

  // The version every guarded mutation must present. The backend re-derives it
  // and refuses on mismatch, so this is a claim, never a permission.
  const expectedVersion = expectedVersionOverride ?? session.sourceVersion;
  // A refused mutation needs the shared revalidator to classify what moved, but
  // revalidation stands down during a finalize, so it runs once this returns.
  let revalidateAfter = false;

  // Before the destructive write, ANY newer open (even one still in
  // flight) or a workspace switch makes this finalize stale.
  const isCurrent = () =>
    get().epoch === session.epoch && session.requestRevision === mergeRequestRevision;
  // After the write, only a workspace switch aborts — the stage against
  // the captured root must still complete so disk and index agree; a
  // same-workspace supersession merely skips the advance.
  const isSameWorkspace = () => get().epoch === session.epoch;
  const showError = (message: string) => useIDEStore.getState().showToast(message, 'error');
  const findOpenFile = () =>
    useIDEStore.getState().openFiles.find((f) => pathsReferToSameFile(f.path, session.absPath));
  const clearCapturedSession = () => {
    if (isSameWorkspace() && get().mergeSession?.requestRevision === session.requestRevision) {
      mergeRequestRevision++;
      set({ mergeSession: null, mergeFocused: false }, false, 'git/mergeInvalidated');
    }
  };
  const invalidateChangedSession = (message: string) => {
    showError(message);
    clearCapturedSession();
    return false;
  };
  const fileStayedStable = () =>
    getFileWriteRevision(session.absPath) === session.fileWriteRevision;

  // Set when the stage succeeded while the session was still current.
  // The advance itself runs AFTER the in-flight guard drops, because it
  // opens the next session and openMergeResolution refuses to run
  // during a finalize (a mid-write open would snapshot stale markers).
  let advanceAfter = false;
  // A warning raised on a SUCCESSFUL finalize, emitted after the
  // advance so its toast is not overwritten by the completion toast.
  let warningAfter: string | null = null;

  // Staging runs through runOp for single-flight + status refresh, but
  // against the session's CAPTURED repo root — never the live one.
  const stageGuarded = async (expected: string): Promise<boolean> => {
    let outcome: git.ConflictGuardResult | undefined;
    const ok = await runOp('stage', get, set, async () => {
      outcome = await GitStageConflictResult(session.repoRoot, session.path, expected);
      return null;
    });
    // A version mismatch is not an error: nothing was staged, and the caller
    // reconciles instead of retrying blindly.
    if (ok && outcome && !outcome.applied) {
      revalidateAfter = true;
      showError(
        `${session.path} changed outside Firn while it was being staged, so it was NOT staged. Reload it and re-resolve.`
      );
      return false;
    }
    if (!ok) {
      // runOp toasts its own failures; its silent branch is the
      // opInFlight gate — surface it so finalize is never a dead click
      // after the write already happened.
      if (isSameWorkspace() && !get().lastError) {
        showError(
          `Could not stage ${session.path}: another git operation is running — retry when it finishes.`
        );
      }
      return false;
    }
    advanceAfter = isCurrent();
    return true;
  };

  const runFinalize = async (): Promise<boolean> => {
    if (!isCurrent()) return false;
    if (!fileStayedStable()) {
      return invalidateChangedSession(
        `Cannot finalize ${session.path}: the file changed after this merge session opened. Reopen it and re-resolve.`
      );
    }
    // Fail BEFORE the write when staging would be refused anyway —
    // runOp's opInFlight gate is silent and by then markers are gone.
    if (get().opInFlight) {
      showError(
        `Cannot finalize ${session.path}: another git operation is running — retry when it finishes.`
      );
      return false;
    }

    if (session.kind === 'sides') {
      const side = session.selectedSide;
      if (!side) return false;
      try {
        return await withFileWriteLock(session.absPath, async (_write, hasQueuedWrites) => {
          if (!isCurrent()) return false;
          if (get().opInFlight) {
            showError(
              `Cannot finalize ${session.path}: another git operation is running — retry when it finishes.`
            );
            return false;
          }
          if (!fileStayedStable() || hasQueuedWrites()) {
            return invalidateChangedSession(
              `Cannot finalize ${session.path}: the file acquired another save after this merge session opened. Reopen it and choose a side again.`
            );
          }

          // The plain tab bypasses this surface entirely: unsaved
          // edits would be discarded or resurrected by autosave.
          const before = findOpenFile();
          if (before?.isModified) {
            showError(
              `Cannot finalize ${session.path}: the file has unsaved edits. Save or revert them first.`
            );
            return false;
          }

          // Applying a side and staging it are separate guarded steps, so a stage
          // that fails can be retried against the version the apply produced instead
          // of re-applying the side over whatever the user changed in the meantime.
          let stageVersion = expectedVersion;
          const alreadyApplied =
            session.appliedSide?.side === side &&
            session.appliedSide.sourceVersion === expectedVersion;
          if (!alreadyApplied) {
            const applied = await GitApplyConflictSide(
              session.repoRoot,
              session.path,
              side,
              expectedVersion
            );
            if (!applied.applied) {
              revalidateAfter = true;
              showError(
                `${session.path} changed outside Firn, so the chosen side was NOT applied. Reload it and choose again.`
              );
              return false;
            }
            markFileWriteAttempt(session.absPath);
            stageVersion = applied.sourceVersion;
            if (!isSameWorkspace()) {
              showError(
                `Workspace switched while finalizing ${session.path}: the chosen side was applied but NOT staged. Stage it manually in its original repository.`
              );
              return false;
            }
            const applying = get().mergeSession;
            if (
              applying?.kind === 'sides' &&
              applying.requestRevision === session.requestRevision
            ) {
              set(
                {
                  mergeSession: {
                    ...applying,
                    sourceVersion: stageVersion,
                    appliedSide: { side, sourceVersion: stageVersion },
                    // The apply is a Firn-owned worktree write: record it, or the stage
                    // retry would see its own apply as somebody else's save and
                    // invalidate the session.
                    fileWriteRevision: getFileWriteRevision(session.absPath),
                  },
                },
                false,
                'git/mergeSideApplied'
              );
            }
          }
          const ok = await stageGuarded(stageVersion);
          if (!ok) {
            return false;
          }
          if (isSameWorkspace()) {
            const after = findOpenFile();
            if (after) {
              if (after.isModified) {
                warningAfter = `${session.path}: the chosen side was applied and staged, but the open tab has unsaved edits from during the apply. They were kept — review the tab before saving.`;
              } else {
                useIDEStore.getState().closeFile(after.id);
              }
            } else if (before) {
              warningAfter = `${session.path}: the editor tab closed while the side was being applied. If it had unsaved edits they were auto-saved and may conflict with the staged resolution — check the file's git status before committing.`;
            } else if (hasQueuedWrites()) {
              warningAfter = `${session.path}: another save queued while the side was being applied. The side was staged, but the worktree may change — check git status before committing.`;
            }
          }
          return true;
        });
      } catch (err) {
        return invalidateChangedSession(
          `Could not finalize ${session.path}: a pending file save failed (${toErrorMessage(err)}). Reopen it and choose a side again.`
        );
      }
    }

    if (result == null) return false;
    if (session.readOnly) {
      showError(
        `Cannot finalize ${session.path}: its encoding or line endings cannot be written back losslessly.`
      );
      return false;
    }
    if (session.regions.some((_, index) => session.decisions[index] === undefined)) {
      showError(`Cannot finalize ${session.path}: unresolved conflicts remain.`);
      return false;
    }

    // Settle any queued diff edit for this path so the resolved write
    // is ordered after it in the per-path queue.
    try {
      await flushWorkingTreeEdit(session.absPath);
    } catch (err) {
      if (isSameWorkspace()) showError(`Could not save ${session.path}: ${toErrorMessage(err)}`);
      return false;
    }
    if (!isCurrent()) return false;

    const baseline = normalizeEol(session.content);
    try {
      return await withFileWriteLock(session.absPath, async (write, hasQueuedWrites) => {
        if (!isCurrent()) return false;
        if (get().opInFlight) {
          showError(
            `Cannot finalize ${session.path}: another git operation is running — retry when it finishes.`
          );
          return false;
        }
        if (!fileStayedStable() || hasQueuedWrites()) {
          return invalidateChangedSession(
            `Cannot finalize ${session.path}: the file acquired another save after this merge session opened. Reopen it and re-resolve.`
          );
        }

        // The buffer matched the session content when the session
        // opened. A dirty flag is divergence even when the text was
        // edited back to the baseline: an autosave may still own an
        // intermediate revision of the same path.
        const openFile = findOpenFile();
        if (openFile?.isModified) {
          showError(
            `Cannot finalize ${session.path}: the file has unsaved edits. Save or revert them first.`
          );
          return false;
        }
        if (
          openFile &&
          normalizeEol(openFile.content) !== baseline &&
          openFile.content !== result
        ) {
          showError(
            `Cannot finalize ${session.path}: the editor buffer changed after this merge session started. Close the merge tab and re-resolve, or undo the buffer edit.`
          );
          return false;
        }

        // The backend performs the write inside the same call that compares the
        // version, so nothing can slip in between. The queue's own writer is
        // bypassed deliberately: the path lock is still held here, and the write
        // revision is recorded by hand exactly as the sides path does.
        void write;
        const written = await GitWriteConflictResult(
          session.repoRoot,
          session.path,
          expectedVersion,
          result,
          session.encoding,
          session.lineEndings
        );
        if (!written.applied) {
          revalidateAfter = true;
          showError(
            `${session.path} changed outside Firn, so it was NOT written. Reload it, or confirm the overwrite.`
          );
          return false;
        }
        markFileWriteAttempt(session.absPath);
        const resolvedWriteRevision = getFileWriteRevision(session.absPath);
        if (!isSameWorkspace()) {
          showError(
            `Workspace switched while finalizing ${session.path}: the resolved file was written but NOT staged. Stage it manually in its original repository.`
          );
          return false;
        }

        const after = findOpenFile();
        if (hasQueuedWrites()) {
          return invalidateChangedSession(
            `${session.path} acquired another pending save while the resolution was being written. The file was NOT staged — reopen it and re-resolve.`
          );
        }
        if (after?.isModified) {
          return invalidateChangedSession(
            `${session.path} changed while the resolved file was being written. Your edit is preserved and the file was NOT staged — review it, then stage manually.`
          );
        }
        if (after && after.content !== result && normalizeEol(after.content) !== baseline) {
          return invalidateChangedSession(
            `${session.path} changed while the resolved file was being written. Your edit is preserved and the file was NOT staged — review it, then stage manually.`
          );
        }

        // A clean tab may close during the write without queueing
        // anything. In that case the resolution is still durably last
        // and can be staged. Reconcile only a tab that remains open.
        if (after) {
          const ide = useIDEStore.getState();
          ide.updateFileContent(after.id, result);
          ide.setFileModified(after.id, false);
        }

        // Rebase the live session so a retry after a failed stage can
        // submit a corrected result without comparing to old markers.
        const live = get().mergeSession;
        if (live?.kind === 'text' && live.requestRevision === session.requestRevision) {
          set(
            {
              mergeSession: {
                ...live,
                content: result,
                fileWriteRevision: resolvedWriteRevision,
                // The write's own watcher event reports THIS version, so recording it
                // is what makes that event a no-op instead of a false
                // "changed outside Firn".
                sourceVersion: written.sourceVersion,
              },
            },
            false,
            'git/mergeWriteBaseline'
          );
        }

        // Holding the path queue through GitStage prevents an
        // autosave queued during the write from racing the index.
        const staged = await stageGuarded(written.sourceVersion);
        if (!staged && hasQueuedWrites()) {
          return invalidateChangedSession(
            `${session.path} acquired another save while staging failed. Reopen it and re-resolve before retrying.`
          );
        }
        return staged;
      });
    } catch (err) {
      if (isSameWorkspace()) {
        showError(`Could not write ${session.path}: ${toErrorMessage(err)}`);
        clearCapturedSession();
      }
      return false;
    }
  };

  mergeFinalizeInFlight = true;
  let ok = false;
  try {
    ok = await runFinalize();
  } finally {
    mergeFinalizeInFlight = false;
  }
  // The warning goes out BEFORE the advance: a failed next-open raises
  // its own explanatory toast, which must be the one that survives
  // (single-toast UI). The completion toast is suppressed instead so a
  // warning on an exhausted queue is not buried either.
  if (ok && warningAfter) showError(warningAfter);
  if (ok && advanceAfter) {
    // Close the finalized session and hand off to the next queued conflicted
    // file, or report completion when the queue is exhausted. The pending flag
    // is set in the SAME update that clears the session, so the gap between the
    // two is never mistaken for a close.
    const remaining = session.fileQueue.filter((p) => p !== session.path);
    const advancing = remaining.length > 0;
    set(
      { mergeSession: null, mergeFocused: false, mergeAdvancePending: advancing },
      false,
      'git/mergeFinalized'
    );
    if (!advancing) {
      if (!warningAfter) {
        useIDEStore.getState().showToast('Conflict queue resolved', 'info');
      }
    } else {
      try {
        // One step only: walking a stale queue would produce a burst of toasts
        // for entries that are no longer conflicted.
        await get().openMergeResolution(remaining[0], remaining);
        const opened = get().mergeSession;
        if (opened && opened.path === remaining[0]) {
          const count = opened.fileQueue.length;
          set(
            {
              mergeQueueAnnouncement: `Now resolving ${opened.path}. ${count} conflicted file${count === 1 ? '' : 's'} remaining.`,
            },
            false,
            'git/mergeQueueAnnounced'
          );
        }
      } finally {
        // Owned by this advance: a workspace reset or close during the open
        // already cleared the flag and must not have it resurrected.
        if (get().mergeAdvancePending) {
          set({ mergeAdvancePending: false }, false, 'git/mergeAdvanceSettled');
        }
      }
    }
  }
  if (revalidateAfter) await revalidateMergeSession(get, set);
  return ok;
}
