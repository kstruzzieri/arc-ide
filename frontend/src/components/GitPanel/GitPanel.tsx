import { useMemo, useState } from 'react';
import { Panel, PanelAction } from '../layout';
import { RestartIcon, ChevronRightIcon, ChevronDownIcon } from '../icons';
import { useGitStore, useGitStatusSnapshot } from '../../stores/gitStore';
import {
  useIDEStore,
  useActiveWorkspace,
  useTreeViewMode,
  useCanFocusWorkspace,
} from '../../stores/ideStore';
import { classifyChange, type GitFileChange, type GitRowStatus } from '../../types/git';
import { joinRepoPath, normalizeFsPath } from '../../utils/paths';
import { ensureEditorFileOpen } from '../../utils/editorNavigation';
import { FileIcon } from '../FileExplorer/FileIcon';
import { BranchSwitcher } from '../git/BranchSwitcher';
import styles from './GitPanel.module.css';

type ViewScope = 'workspace' | 'project';

interface BucketedChange {
  change: GitFileChange;
  absPath: string;
  rowStatus: GitRowStatus;
  /** Location shown after the filename: repo-relative directory, or the repo
   * folder name for files that sit at the repository root. */
  location: string;
}

const statusLetter: Record<GitRowStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

export function GitPanel() {
  const { status, isRefreshing, opInFlight, lastError } = useGitStatusSnapshot();
  const receipt = useGitStore((s) => s.lastCommitReceipt);
  const workspaces = useIDEStore((s) => s.workspaces);
  // Scope follows the shared workspace focus, so the panel matches whatever the
  // file tree / workspace selector is showing (selecting the Frontend workspace
  // scopes the panel to Frontend; Project view shows all repo changes).
  const activeWorkspace = useActiveWorkspace();
  const treeViewMode = useTreeViewMode();
  const canFocusWorkspace = useCanFocusWorkspace();
  const setTreeViewMode = useIDEStore((s) => s.setTreeViewMode);

  const repoRoot = status?.isRepo ? status.repoRoot : null;

  // Workspace scope uses ownership (Firn's one-repo-many-workspaces model): a
  // workspace owns the files under its directory, minus any nested
  // sub-workspace's files. So a root (e.g. Go) workspace owns everything except
  // a nested frontend/ workspace, while the Frontend workspace owns frontend/.
  const scopeCtx = useMemo(() => {
    const rel = activeWorkspace ? normalizeFsPath(activeWorkspace.relDir) : null;
    const activeRel =
      treeViewMode === 'workspace' && rel !== null ? (rel === '.' ? '' : rel) : null; // null = project scope (show all)
    const subDirs = workspaces
      .map((w) => normalizeFsPath(w.relDir))
      .filter((d) => d && d !== '.' && d !== activeRel);
    return { activeRel, subDirs };
  }, [treeViewMode, activeWorkspace, workspaces]);

  // Bucket once per status; scope filter narrows to the active workspace.
  const buckets = useMemo(() => {
    const repoName = repoRoot ? (normalizeFsPath(repoRoot).split('/').pop() ?? '') : '';
    const all: BucketedChange[] = (status?.files ?? []).map((change) => {
      const slash = change.path.lastIndexOf('/');
      const dir = slash === -1 ? '' : change.path.slice(0, slash);
      return {
        change,
        absPath: joinRepoPath(repoRoot ?? '', change.path),
        rowStatus: classifyChange(change).rowStatus,
        location: dir || repoName,
      };
    });

    const { activeRel, subDirs } = scopeCtx;
    const inActive = (p: string) =>
      activeRel === '' || p === activeRel || p.startsWith(activeRel + '/');
    const ownedByOther = (p: string) => subDirs.some((d) => p === d || p.startsWith(d + '/'));
    const scoped =
      activeRel !== null
        ? all.filter((f) => inActive(f.change.path) && !ownedByOther(f.change.path))
        : all;

    return {
      conflicts: scoped.filter((f) => f.change.unmerged),
      staged: scoped.filter((f) => classifyChange(f.change).staged),
      changes: scoped.filter((f) => classifyChange(f.change).unstaged),
      untracked: scoped.filter((f) => classifyChange(f.change).untracked),
    };
  }, [status, repoRoot, scopeCtx]);

  if (!status || !status.isRepo) {
    const message = !status
      ? 'Loading git status…'
      : status.detail
        ? status.detail
        : 'Not a git repository.';
    return (
      <Panel title="Source Control">
        <div className={styles.empty}>{message}</div>
      </Panel>
    );
  }

  const git = useGitStore.getState();

  return (
    <Panel
      title="Source Control"
      actions={
        <PanelAction
          icon={<RestartIcon />}
          title="Refresh"
          ariaLabel="Refresh git status"
          onClick={() => void git.refresh()}
          disabled={isRefreshing}
        />
      }
    >
      <div className={styles.panelBody}>
        <div className={styles.headerRow}>
          {/* Scope toggle mirrors the shared workspace focus; shown only when
              there are workspaces to focus. */}
          {canFocusWorkspace && <ScopeToggle scope={treeViewMode} onChange={setTreeViewMode} />}
          {/* The branch switcher gets its own full-width row so long branch
              names stay legible in a narrow panel instead of truncating beside
              the scope toggle. */}
          <div className={styles.branchRow}>
            <BranchSwitcher respondToFocusRequest={false} />
          </div>
        </div>
        <SyncControls />
        {buckets.conflicts.length > 0 && (
          <ConflictBanner branch={status.branch} conflicts={buckets.conflicts} raw={lastError} />
        )}
        {lastError && buckets.conflicts.length === 0 && (
          <div className={styles.errorStrip} data-testid="git-error" role="alert">
            {lastError}
          </div>
        )}
        {receipt && <CommitReceiptCard />}
        <CommitArea stagedCount={buckets.staged.length} disabled={opInFlight !== null} />
        <div className={styles.sections}>
          {buckets.conflicts.length > 0 && (
            <Section
              testId="section-conflicts"
              title="Conflicts"
              files={buckets.conflicts}
              rowAction={null}
            />
          )}
          <Section
            testId="section-staged"
            title="Staged Changes"
            files={buckets.staged}
            rowAction="unstage"
          />
          <Section
            testId="section-changes"
            title="Changes"
            files={buckets.changes}
            rowAction="stage"
          />
          <Section
            testId="section-untracked"
            title="Untracked"
            files={buckets.untracked}
            rowAction="stage"
          />
        </div>
      </div>
    </Panel>
  );
}

function ScopeToggle({
  scope,
  onChange,
}: {
  scope: ViewScope;
  onChange: (scope: ViewScope) => void;
}) {
  return (
    <div className={styles.scopeToggle} role="group" aria-label="Change scope">
      {(['workspace', 'project'] as const).map((s) => (
        <button
          key={s}
          type="button"
          className={`${styles.scopeBtn} ${scope === s ? styles.scopeActive : ''}`}
          onClick={() => onChange(s)}
          aria-pressed={scope === s}
        >
          {s === 'workspace' ? 'Workspace' : 'Project'}
        </button>
      ))}
    </div>
  );
}

function SyncControls() {
  const { status, opInFlight } = useGitStatusSnapshot();
  const git = useGitStore.getState();
  if (!status?.isRepo) return null;

  const busy = opInFlight !== null;
  const hasUpstream = status.upstream !== '';
  // Nothing behind → nothing to pull. A branch with no upstream can still be
  // published, so push stays enabled there even with a zero ahead count.
  const canPull = status.behind > 0 && !busy;
  const canPush = (status.ahead > 0 || !hasUpstream) && !busy;
  const pushLabel = !hasUpstream ? 'Publish' : 'Push';

  return (
    <div className={styles.syncRow}>
      <div className={styles.syncButtons}>
        <button
          type="button"
          className={`${styles.syncBtn} ${status.behind > 0 ? styles.syncActive : ''}`}
          onClick={() => void git.pull()}
          disabled={!canPull}
          aria-label={
            status.behind > 0 ? `Pull ${status.behind} incoming` : 'Pull (nothing to pull)'
          }
        >
          <span className={styles.syncArrow} aria-hidden="true">
            ↓
          </span>
          Pull
          {status.behind > 0 && <span className={styles.syncCount}>{status.behind}</span>}
        </button>
        <button
          type="button"
          className={`${styles.syncBtn} ${status.ahead > 0 || !hasUpstream ? styles.syncActive : ''}`}
          onClick={() => void git.push()}
          disabled={!canPush}
          aria-label={
            status.ahead > 0 ? `Push ${status.ahead} outgoing` : `${pushLabel} (nothing to push)`
          }
        >
          <span className={styles.syncArrow} aria-hidden="true">
            ↑
          </span>
          {pushLabel}
          {status.ahead > 0 && <span className={styles.syncCount}>{status.ahead}</span>}
        </button>
      </div>
    </div>
  );
}

function CommitArea({ stagedCount, disabled }: { stagedCount: number; disabled: boolean }) {
  const commitMessage = useGitStore((s) => s.commitMessage);
  const aiAvailable = useGitStore((s) => s.aiAvailable);
  const [amend, setAmend] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const canCommit = commitMessage.trim() !== '' && (stagedCount > 0 || amend) && !disabled;

  const handleGenerate = async () => {
    const git = useGitStore.getState();
    const draft = git.commitMessage.trim();
    if (draft === '') {
      await git.generateMessage(); // fills the empty textarea directly
      return;
    }
    // Non-destructive: keep the draft, surface the proposal beside it.
    const before = git.commitMessage;
    await git.generateMessage();
    const generated = useGitStore.getState().commitMessage;
    if (generated !== before) {
      useGitStore.getState().setCommitMessage(before);
      setSuggestion(generated);
    }
  };

  return (
    <div className={styles.commitArea}>
      <textarea
        className={styles.commitInput}
        placeholder={`Commit message${stagedCount === 0 ? ' (stage changes first)' : ''}`}
        aria-label="Commit message"
        value={commitMessage}
        onChange={(e) => useGitStore.getState().setCommitMessage(e.target.value)}
        rows={3}
      />
      {suggestion && (
        <div className={styles.aiSuggestion} data-testid="ai-suggestion">
          <div className={styles.aiSuggestionText}>{suggestion}</div>
          <div className={styles.aiSuggestionActions}>
            <button
              type="button"
              className={styles.smallBtn}
              onClick={() => {
                useGitStore.getState().setCommitMessage(suggestion);
                setSuggestion(null);
              }}
            >
              Use
            </button>
            <button type="button" className={styles.smallBtn} onClick={() => setSuggestion(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <ScopeGuard />
      <div className={styles.commitControls}>
        <label className={styles.amendLabel}>
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => setAmend(e.target.checked)}
            aria-label="Amend previous commit"
          />
          Amend
        </label>
        {aiAvailable && (
          <button
            type="button"
            className={styles.smallBtn}
            onClick={() => void handleGenerate()}
            disabled={disabled}
            aria-label="Generate message"
            title="Generate a commit message with golem"
          >
            Generate
          </button>
        )}
        <button
          type="button"
          className={styles.commitBtn}
          disabled={!canCommit}
          onClick={() => void useGitStore.getState().commit(amend)}
        >
          Commit
        </button>
      </div>
    </div>
  );
}

/**
 * Firn-specific: staged files spanning multiple workspaces get a visible,
 * non-blocking note plus the run profiles those workspaces own — the closest
 * deterministic "what does this commit affect" signal available.
 */
function ScopeGuard() {
  const status = useGitStore((s) => s.status);
  const workspaces = useIDEStore((s) => s.workspaces);
  const runProfiles = useIDEStore((s) => s.runProfiles);

  const spanned = useMemo(() => {
    if (!status?.isRepo || workspaces.length < 2) return null;
    // Porcelain paths and WorkspaceDef.relDir are both repo-relative.
    const stagedPaths = (status.files ?? [])
      .filter((f) => classifyChange(f).staged)
      .map((f) => f.path);
    const hit = workspaces.filter((ws) => {
      const dir = normalizeFsPath(ws.relDir);
      if (!dir || dir === '.') return false; // a root workspace matches everything
      return stagedPaths.some((sp) => sp === dir || sp.startsWith(dir + '/'));
    });
    return hit.length > 1 ? hit : null;
  }, [status, workspaces]);

  if (!spanned) return null;

  const names = spanned.map((ws) => ws.name);
  const profiles = runProfiles
    .filter((p) => p.workspaceName && names.includes(p.workspaceName))
    .map((p) => p.name)
    .slice(0, 3);

  return (
    <div className={styles.scopeGuard}>
      Commit spans {names.join(' + ')}
      {profiles.length > 0 && (
        <span className={styles.scopeProfiles}> · {profiles.join(', ')}</span>
      )}
    </div>
  );
}

function CommitReceiptCard() {
  const receipt = useGitStore((s) => s.lastCommitReceipt);
  const ahead = useGitStore((s) => s.status?.ahead ?? 0);
  const [showOutput, setShowOutput] = useState(false);
  if (!receipt) return null;

  return (
    <div className={styles.receipt} data-testid="commit-receipt">
      <div className={styles.receiptHead}>
        Committed <code>{receipt.hash}</code> on {receipt.branch}
      </div>
      <div className={styles.receiptSubject}>{receipt.subject}</div>
      {receipt.files.length > 0 && (
        <div className={styles.receiptFiles}>
          {receipt.files.length} file{receipt.files.length === 1 ? '' : 's'}:{' '}
          {receipt.files.join(', ')}
        </div>
      )}
      {ahead > 0 && <div className={styles.receiptPush}>{ahead} unpushed — ready to push</div>}
      {receipt.output && (
        <button
          type="button"
          className={styles.smallBtn}
          onClick={() => setShowOutput((v) => !v)}
          aria-expanded={showOutput}
        >
          {showOutput ? 'Hide output' : 'Show output'}
        </button>
      )}
      {showOutput && <pre className={styles.rawOutput}>{receipt.output}</pre>}
    </div>
  );
}

function ConflictBanner({
  branch,
  conflicts,
  raw,
}: {
  branch: string;
  conflicts: BucketedChange[];
  raw: string | null;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const fileQueue = conflicts.map((file) => file.change.path);

  return (
    <div className={styles.conflictBanner} data-testid="conflict-banner" role="alert">
      <div className={styles.conflictTitle}>
        Resolve conflicts on {branch} ({conflicts.length} file
        {conflicts.length === 1 ? '' : 's'})
      </div>
      <ul className={styles.conflictList}>
        {conflicts.map((f) => (
          <li key={f.change.path} className={styles.conflictItem}>
            <button
              type="button"
              className={styles.conflictResolve}
              onClick={() =>
                void useGitStore.getState().openMergeResolution(f.change.path, fileQueue)
              }
              aria-label={`Resolve ${f.change.path}`}
            >
              Resolve
            </button>
            <button
              type="button"
              className={styles.conflictOpen}
              onClick={() => void ensureEditorFileOpen(f.absPath)}
              aria-label={`Open ${f.change.path}`}
              title={f.change.path}
            >
              {f.change.path}
            </button>
          </li>
        ))}
      </ul>
      {raw && (
        <>
          <button
            type="button"
            className={styles.smallBtn}
            onClick={() => setShowRaw((v) => !v)}
            aria-expanded={showRaw}
          >
            {showRaw ? 'Hide git output' : 'Show git output'}
          </button>
          {showRaw && <pre className={styles.rawOutput}>{raw}</pre>}
        </>
      )}
    </div>
  );
}

function Section({
  testId,
  title,
  files,
  rowAction,
}: {
  testId: string;
  title: string;
  files: BucketedChange[];
  rowAction: 'stage' | 'unstage' | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (files.length === 0) return null;
  const git = useGitStore.getState();
  const paths = files.map((f) => f.change.path);

  // Staged section files are all included (checked); stage/untracked section
  // files are all excluded. A section is homogeneous, so the header box is a
  // plain two-state select-all, not tristate.
  const allStaged = rowAction === 'unstage';
  const toggleAll = () => {
    if (rowAction === null) return; // conflicts can't be bulk-staged
    void (allStaged ? git.unstage(paths) : git.stage(paths));
  };

  return (
    <div className={styles.section} data-testid={testId}>
      <div className={styles.sectionHeader}>
        <button
          type="button"
          className={styles.sectionChevron}
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
        >
          {collapsed ? (
            <ChevronRightIcon aria-hidden="true" />
          ) : (
            <ChevronDownIcon aria-hidden="true" />
          )}
        </button>
        {rowAction !== null && (
          <input
            type="checkbox"
            className={styles.sectionCheck}
            checked={allStaged}
            onChange={toggleAll}
            aria-label={`Select all in ${title}`}
            title={allStaged ? 'Unstage all' : 'Stage all'}
          />
        )}
        <span className={styles.sectionTitle}>
          {title} <span className={styles.sectionCount}>{files.length}</span>
        </span>
      </div>
      {!collapsed && (
        <ul className={`${styles.rows} ${rowAction === null ? styles.rowsNoCheck : ''}`}>
          {files.map((f) => (
            <ChangeRow key={`${testId}-${f.change.path}`} file={f} rowAction={rowAction} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangeRow({
  file,
  rowAction,
}: {
  file: BucketedChange;
  rowAction: 'stage' | 'unstage' | null;
}) {
  const name = fileName(file.change.path);
  const busy = useGitStore((s) => s.opInFlight !== null);
  const git = useGitStore.getState();

  // Staged rows diff HEAD↔index, unstaged/untracked rows diff index↔worktree;
  // conflict rows open the file itself — resolving happens in the editor.
  const handleOpen = () => {
    if (rowAction === null) {
      void ensureEditorFileOpen(file.absPath);
    } else {
      void git.openDiff(file.change, rowAction === 'unstage' ? 'staged' : 'unstaged');
    }
  };

  // Checkbox = "include in the next commit" (JetBrains model): checked means
  // the file is staged. Conflict rows (rowAction null) have no checkbox — they
  // must be resolved before they can be committed.
  const staged = rowAction === 'unstage';
  const toggleInclude = () => {
    if (staged) void git.unstage([file.change.path]);
    else void git.stage([file.change.path]);
  };

  return (
    <li className={styles.row} data-git={file.rowStatus}>
      {rowAction !== null && (
        <input
          type="checkbox"
          className={styles.rowCheck}
          checked={staged}
          onChange={toggleInclude}
          aria-label={`Include ${name} in commit`}
          title={staged ? 'Staged — click to unstage' : 'Click to stage'}
        />
      )}
      <button
        type="button"
        className={styles.rowMain}
        onClick={handleOpen}
        title={file.change.path}
      >
        <FileIcon name={name} isDir={false} isExpanded={false} className={styles.rowIcon} />
        <span className={styles.rowName}>{name}</span>
        {file.location && (
          <span className={styles.rowDir} data-testid="row-dir">
            {file.location}
          </span>
        )}
      </button>
      <span className={styles.rowActions}>
        {file.rowStatus === 'untracked' && (
          <button
            type="button"
            className={styles.rowTrackBtn}
            onClick={() => void git.intentToAdd([file.change.path])}
            disabled={busy}
            aria-label={`Track ${file.change.path} without staging`}
            title="Track without staging (git add -N): the file shows in diffs and can be staged hunk-by-hunk"
          >
            Track
          </button>
        )}
        {classifyChange(file.change).intentToAdd && (
          <button
            type="button"
            className={styles.rowTrackBtn}
            onClick={() => void git.unstage([file.change.path])}
            disabled={busy}
            aria-label={`Untrack ${file.change.path}`}
            title="Stop tracking (git restore --staged): back to untracked, file kept on disk"
          >
            Untrack
          </button>
        )}
        <span className={styles.rowBadge} aria-hidden="true">
          {statusLetter[file.rowStatus]}
        </span>
      </span>
    </li>
  );
}

function fileName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}
