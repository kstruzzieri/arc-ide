import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createMergeResolutionEditor,
  type MergeResolutionEditor,
  type MergeResolutionState,
} from './codemirror';
import {
  useGitStore,
  type MergeDecision,
  type MergeSession,
  type SidesMergeSession,
  type TextMergeSession,
} from '../../stores/gitStore';
import { useEditorSyntaxTheme } from '../../stores/ideStore';
import { GitConflictStages, GitFileAtRev } from '../../wails/bindings';
import styles from './MergeResolutionView.module.css';

type BaseStrip =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'text'; content: string }
  | { status: 'message'; message: string }
  | { status: 'error'; message: string };

const REGIONS_CARRY_BASE = (session: TextMergeSession) =>
  session.regions.some((region) => region.hasBase);

function initialState(session: TextMergeSession): MergeResolutionState {
  return {
    activeIndex: null,
    decisions: session.decisions,
    order: 'current-first',
  };
}

function decisionClass(decision: MergeDecision | undefined): string {
  return decision ? styles[`decision${decision}`] : styles.unresolved;
}

function decisionLabel(decision: MergeDecision | undefined): string {
  switch (decision) {
    case 'C':
      return 'Current';
    case 'I':
      return 'Incoming';
    case 'B':
      return 'Both';
    case 'M':
      return 'Manual';
    default:
      return 'unresolved';
  }
}

/** Remaining work is stated as a count, not an ordinal: the queue shrinks as
 * files finalize, so "File 2 of 3" would reset to "File 1 of 2" on the next
 * advance and read as going backwards. */
function remainingLabel(session: MergeSession): string {
  const remaining = session.fileQueue.length;
  return `${remaining} conflicted file${remaining === 1 ? '' : 's'} remaining`;
}

export function describeMergeAnnouncement(
  previous: Record<number, MergeDecision>,
  next: Record<number, MergeDecision>,
  totalRegions: number
): string | null {
  const resolved: number[] = [];
  const reopened: number[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const index = Number(key);
    if (previous[index] === next[index]) continue;
    if (next[index] === undefined) reopened.push(index);
    else resolved.push(index);
  }
  if (resolved.length === 0 && reopened.length === 0) return null;
  resolved.sort((a, b) => a - b);
  reopened.sort((a, b) => a - b);
  const parts: string[] = [];
  if (resolved.length === 1) {
    parts.push(
      `Conflict ${resolved[0] + 1} resolved: took ${decisionLabel(next[resolved[0]]).toLowerCase()}`
    );
  } else if (resolved.length > 1) {
    parts.push(`Conflicts ${resolved.map((index) => index + 1).join(', ')} resolved`);
  }
  if (reopened.length === 1) {
    parts.push(`Conflict ${reopened[0] + 1} reopened`);
  } else if (reopened.length > 1) {
    parts.push(`Conflicts ${reopened.map((index) => index + 1).join(', ')} reopened`);
  }
  const remaining = totalRegions - Object.keys(next).length;
  return `${parts.join('. ')}. ${remaining} unresolved.`;
}

/** Where keyboard focus should land after a notice resolves: the live Result
 * document, or the first whole-file side choice. */
type FocusResult = () => void;

export function MergeResolutionView({
  session,
  visible,
  onFinalizingChange,
}: {
  session: MergeSession;
  visible: boolean;
  onFinalizingChange?: (finalizing: boolean) => void;
}) {
  const [finalizing, setFinalizingState] = useState(false);
  // The overwrite confirmation is owned here so both renderers ask the same
  // question, and so the request survives the renderer's own re-renders.
  const [overwriteRequest, setOverwriteRequest] = useState<{ result?: string } | null>(null);
  // The wrapper owns the surface element so one key handler covers both
  // renderers (and the editor inside them), and one discard confirmation is
  // rendered no matter which kind is open.
  const sectionRef = useRef<HTMLElement>(null);
  const focusResultRef = useRef<FocusResult>(() => {});
  const focusResult = useCallback(() => focusResultRef.current(), []);
  const setFinalizing = useCallback(
    (next: boolean) => {
      setFinalizingState(next);
      onFinalizingChange?.(next);
    },
    [onFinalizingChange]
  );

  useEffect(() => {
    return () => onFinalizingChange?.(false);
  }, [onFinalizingChange]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // CodeMirror consumed it (collapsing a selection), or the platform is
    // ending an IME composition — key code 229 is the Windows/macOS IME
    // placeholder, where `key` is not the physical key at all.
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // A write or a reload in flight owns the session; Escape must not race it.
    if (finalizing || session.reloadPending) return;
    event.preventDefault();
    // The store decides pristine-vs-touched: closing writes nothing, so the
    // only thing at stake is the user's in-session work.
    useGitStore.getState().requestMergeClose();
  };

  return (
    <section
      ref={sectionRef}
      className={styles.root}
      aria-label={`Merge resolution for ${session.path}`}
      onKeyDown={handleKeyDown}
    >
      {session.kind === 'sides' ? (
        <SidesResolutionContent
          session={session}
          finalizing={finalizing}
          setFinalizing={setFinalizing}
          focusResult={focusResult}
          focusResultRef={focusResultRef}
          requestOverwrite={setOverwriteRequest}
        />
      ) : (
        <TextResolutionContent
          session={session}
          visible={visible}
          finalizing={finalizing}
          setFinalizing={setFinalizing}
          focusResult={focusResult}
          focusResultRef={focusResultRef}
          sectionRef={sectionRef}
          requestOverwrite={setOverwriteRequest}
        />
      )}
      {session.closeRequested && <MergeDiscardDialog session={session} />}
      {overwriteRequest && (
        <MergeOverwriteDialog
          session={session}
          request={overwriteRequest}
          onSettled={() => setOverwriteRequest(null)}
          setFinalizing={setFinalizing}
        />
      )}
    </section>
  );
}

/**
 * The one external-change notice, shared by both renderers.
 *
 * The live region holds only the message; the actions are siblings, so a screen
 * reader announcing the change does not read the buttons as part of it.
 */
function MergeExternalNotice({
  session,
  focusResult,
  disabled,
}: {
  session: MergeSession;
  focusResult: FocusResult;
  disabled: boolean;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const external = session.external;
  if (!external) return null;
  if (external.kind === 'changed' && external.hidden) return null;

  const reload = async () => {
    await useGitStore.getState().applyMergeReload();
    // A notice that survived the read means the user still has something to
    // act on, so focus stays on that action rather than jumping away.
    if (useGitStore.getState().mergeSession?.external) {
      actionRef.current?.focus();
      return;
    }
    focusResult();
  };

  if (external.kind === 'changed') {
    const message =
      external.scope === 'conflict'
        ? `The conflict in ${session.path} changed outside Firn: Current and Incoming no longer match what you reviewed. Reload to continue.`
        : `${session.path} changed outside Firn while you were resolving it. Reload to start from the file as it is now, or keep working — writing will then ask you to confirm the overwrite.`;
    return (
      <div className={styles.notice}>
        <span className={styles.noticeMessage} role="status" data-testid="merge-notice">
          {message}
        </span>
        <div className={styles.noticeActions}>
          <button
            ref={actionRef}
            type="button"
            className={styles.secondaryButton}
            onClick={() => void reload()}
            disabled={disabled || session.reloadPending}
          >
            Reload (discard decisions)
          </button>
          {external.scope === 'worktree' && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                useGitStore.getState().acknowledgeMergeExternal();
                focusResult();
              }}
              disabled={disabled || session.reloadPending}
            >
              Keep working
            </button>
          )}
        </div>
      </div>
    );
  }

  if (external.kind === 'resolved-outside') {
    return (
      <div className={styles.notice}>
        <span className={styles.noticeMessage} role="alert" data-testid="merge-notice">
          {external.message}
        </span>
        <div className={styles.noticeActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            // Through the same guard as every other close: a touched session
            // still gets its discard confirmation.
            onClick={() => useGitStore.getState().requestMergeClose()}
            disabled={disabled}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.notice}>
      <span className={styles.noticeMessage} role="alert" data-testid="merge-notice">
        {external.message}
      </span>
      <div className={styles.noticeActions}>
        <button
          ref={actionRef}
          type="button"
          className={styles.secondaryButton}
          onClick={() => void reload()}
          disabled={disabled || session.reloadPending}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/** The shared discard confirmation. Closing never writes, so the only thing at
 * stake is the user's in-session work — which is exactly what this names. */
function MergeDiscardDialog({ session }: { session: MergeSession }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    invokerRef.current = active instanceof HTMLElement ? active : null;
    if (!dialog.open) dialog.showModal();
    // Initial focus on the non-destructive choice.
    keepRef.current?.focus();
  }, []);

  const restoreInvoker = () => {
    const invoker = invokerRef.current;
    if (invoker?.isConnected) invoker.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="merge-discard-title"
      aria-describedby="merge-discard-description"
      onCancel={(event) => {
        // Escape inside the dialog cancels the request, never the session.
        event.preventDefault();
        useGitStore.getState().cancelMergeClose();
        restoreInvoker();
      }}
    >
      <h2 id="merge-discard-title" className={styles.dialogTitle}>
        Discard your merge decisions?
      </h2>
      <p id="merge-discard-description" className={styles.dialogBody}>
        Closing discards the decisions you have made for {session.path} in this session. It does not
        change the file on disk or anything you have staged — the conflict markers stay exactly as
        they are.
      </p>
      <div className={styles.dialogActions}>
        <button
          ref={keepRef}
          type="button"
          className={styles.secondaryButton}
          onClick={() => {
            useGitStore.getState().cancelMergeClose();
            restoreInvoker();
          }}
        >
          Keep working
        </button>
        <button
          type="button"
          className={styles.finalizeButton}
          onClick={() => useGitStore.getState().confirmMergeClose()}
        >
          Discard and close
        </button>
      </div>
    </dialog>
  );
}

/**
 * Explicit consent to overwrite a working-tree change the user has been shown.
 *
 * "Keep working" only hid the notice; this is the separate, destructive step,
 * and the store re-reads the file at this moment so a version that moved again
 * while the dialog was open is refused rather than clobbered.
 */
function MergeOverwriteDialog({
  session,
  request,
  onSettled,
  setFinalizing,
}: {
  session: MergeSession;
  request: { result?: string };
  onSettled: () => void;
  setFinalizing: (finalizing: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    invokerRef.current = active instanceof HTMLElement ? active : null;
    if (!dialog.open) dialog.showModal();
    // Initial focus on the non-destructive choice.
    cancelRef.current?.focus();
  }, []);

  const close = () => {
    const invoker = invokerRef.current;
    onSettled();
    if (invoker?.isConnected) invoker.focus();
  };

  const confirm = async () => {
    setFinalizing(true);
    try {
      await useGitStore.getState().mergeOverwriteAndStage(request.result);
    } finally {
      setFinalizing(false);
      close();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="merge-overwrite-title"
      aria-describedby="merge-overwrite-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2 id="merge-overwrite-title" className={styles.dialogTitle}>
        Overwrite the outside change?
      </h2>
      <p id="merge-overwrite-description" className={styles.dialogBody}>
        {session.path} changed outside Firn after this session opened. Writing your resolution
        replaces those changes on disk and stages the result. If the file changes again before the
        write lands, it will be refused instead.
      </p>
      <div className={styles.dialogActions}>
        <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={close}>
          Cancel
        </button>
        <button type="button" className={styles.finalizeButton} onClick={() => void confirm()}>
          Overwrite and stage
        </button>
      </div>
    </dialog>
  );
}

function TextResolutionContent({
  session,
  visible,
  finalizing,
  setFinalizing,
  focusResult,
  focusResultRef,
  sectionRef,
  requestOverwrite,
}: {
  session: TextMergeSession;
  visible: boolean;
  finalizing: boolean;
  setFinalizing: (finalizing: boolean) => void;
  focusResult: FocusResult;
  focusResultRef: React.RefObject<FocusResult>;
  sectionRef: React.RefObject<HTMLElement | null>;
  requestOverwrite: (request: { result?: string }) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MergeResolutionEditor | null>(null);
  const sessionRef = useRef(session);
  const decisionsRef = useRef(session.decisions);
  const activeIndexRef = useRef<number | null>(null);
  const hadSurfaceFocusRef = useRef(false);
  const themeId = useEditorSyntaxTheme();
  const themeIdRef = useRef(themeId);
  const appliedThemeIdRef = useRef(themeId);
  themeIdRef.current = themeId;
  const [resolutionState, setResolutionState] = useState(() => initialState(session));
  const [resolutionRefusal, setResolutionRefusal] = useState<string | null>(null);
  const [reopened, setReopened] = useState<number | null>(null);
  const [base, setBase] = useState<BaseStrip>({ status: 'idle' });
  const [baseExpanded, setBaseExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState(() => {
    const remaining = session.regions.length - Object.keys(session.decisions).length;
    return `${remaining} conflict${remaining === 1 ? '' : 's'} unresolved.`;
  });
  sessionRef.current = session;
  focusResultRef.current = () => editorRef.current?.view.focus();

  // Reset the strip whenever the session identity changes — a new file or a
  // fresh openMergeResolution request must not show the previous file's base.
  useEffect(() => {
    setBase({ status: 'idle' });
    setBaseExpanded(false);
  }, [session.path, session.requestRevision]);

  const loadBase = async () => {
    if (base.status !== 'idle' && base.status !== 'error') return;
    setBase({ status: 'loading' });
    const { path, repoRoot, requestRevision } = sessionRef.current;
    // Session identity is `requestRevision` (monotonic per openMergeResolution),
    // NOT `epoch` — epoch is workspace-scoped and starts at 0, so comparing it to
    // a session epoch would be wrong. If the prop swaps mid-fetch, sessionRef
    // advances and we bail.
    const isStale = () =>
      sessionRef.current.path !== path || sessionRef.current.requestRevision !== requestRevision;
    try {
      const stages = await GitConflictStages(repoRoot, path);
      if (isStale()) return;
      if (!stages.base) {
        setBase({
          status: 'message',
          message: 'No common ancestor — this file was added on both sides.',
        });
        return;
      }
      const file = await GitFileAtRev(repoRoot, ':1', path);
      if (isStale()) return;
      if (file.binary) {
        setBase({ status: 'message', message: 'Base version is binary — nothing to show.' });
        return;
      }
      if (file.truncated) {
        setBase({ status: 'message', message: 'Base version is too large to display.' });
        return;
      }
      const content = file.content.replace(/\r\n?/g, '\n');
      if (content === '') {
        // A present-but-empty base blob (size 0) would otherwise render an empty
        // <pre> — a forbidden placeholder.
        setBase({
          status: 'message',
          message: 'The common ancestor version of this file was empty.',
        });
        return;
      }
      setBase({ status: 'text', content });
    } catch (error) {
      // A rejection from a fetch that belonged to a since-swapped session must
      // not overwrite the new session's freshly-reset strip.
      if (isStale()) return;
      setBase({
        status: 'error',
        message: `Could not read the base version: ${error instanceof Error ? error.message : String(error)}`,
      });
      setBaseExpanded(false);
    }
  };

  // The editor is rebuilt per session identity: a revalidation installs a whole
  // new session with a new requestRevision, and its regions are positional, so
  // the live document from the previous snapshot can never be carried over. A
  // baseline rebase after a successful write keeps the same revision and so
  // keeps the live controller.
  useEffect(() => {
    if (!hostRef.current) return undefined;
    // The surface element outlives every rebuild, so capturing it here is the
    // same node the cleanup needs to ask about focus.
    const surface = sectionRef.current;
    const initialSession = sessionRef.current;
    const editor = createMergeResolutionEditor(hostRef.current, initialSession, {
      syntaxThemeId: themeIdRef.current,
      onDocumentChanged: () => useGitStore.getState().markMergeDirty(),
      onResolutionRefused: (choice, reason) =>
        setResolutionRefusal(
          reason === 'nonterminal-eof'
            ? `${decisionLabel(choice)} cannot be applied because this conflict is not at the end of the document as expected. Reopen merge resolution and try again.`
            : choice === 'B'
              ? "Take Both cannot safely represent this conflict's end-of-file newline. Choose Current or Incoming instead."
              : choice === 'M'
                ? 'Edit manually cannot safely start with both sides because their end-of-file newline state is ambiguous. Choose Current or Incoming, then edit the result.'
                : `${decisionLabel(choice)} cannot be applied because its end-of-file newline state is unavailable. Choose a different side or reopen merge resolution.`
        ),
      onStateChange: (next) => {
        const previous = decisionsRef.current;
        const actions = useGitStore.getState();
        for (const index of new Set([...Object.keys(previous), ...Object.keys(next.decisions)])) {
          const region = Number(index);
          if (previous[region] === next.decisions[region]) continue;
          if (next.decisions[region] === undefined) actions.reopenDecision(region);
          else actions.recordDecision(region, next.decisions[region]);
        }
        const message = describeMergeAnnouncement(
          previous,
          next.decisions,
          sessionRef.current.regions.length
        );
        if (message !== null) setAnnouncement(message);
        if (message !== null || next.activeIndex !== activeIndexRef.current)
          setResolutionRefusal(null);
        decisionsRef.current = next.decisions;
        activeIndexRef.current = next.activeIndex;
        setResolutionState(next);
      },
    });
    editorRef.current = editor;
    appliedThemeIdRef.current = themeIdRef.current;
    const initialEditorState = editor.getState();
    decisionsRef.current = initialEditorState.decisions;
    activeIndexRef.current = initialEditorState.activeIndex;
    setResolutionState(initialEditorState);
    setResolutionRefusal(null);
    setReopened(null);
    // Restore focus into the rebuilt surface only if it was inside before the
    // swap: a background reload must never steal focus from another panel.
    if (hadSurfaceFocusRef.current) {
      hadSurfaceFocusRef.current = false;
      editor.view.focus();
    }
    // Reset the live-region summary for the new file, matching the
    // reopened/base resets — otherwise the previous file's last announcement
    // lingers until the first action here.
    const remainingOnOpen =
      session.regions.length - Object.keys(initialEditorState.decisions).length;
    setAnnouncement(`${remainingOnOpen} conflict${remainingOnOpen === 1 ? '' : 's'} unresolved.`);
    return () => {
      hadSurfaceFocusRef.current = surface?.contains(document.activeElement) ?? false;
      editor.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.requestRevision]);

  useEffect(() => {
    if (appliedThemeIdRef.current === themeId) return;
    editorRef.current?.setTheme(themeId);
    appliedThemeIdRef.current = themeId;
  }, [themeId]);

  useEffect(() => {
    if (visible) editorRef.current?.view.requestMeasure();
  }, [visible]);

  // A Reload in flight freezes the document the same way a finalize does: its
  // result is about to be replaced, so edits made now would be discarded
  // without ever being seen.
  useEffect(() => {
    if (session.reloadPending) editorRef.current?.setFrozen(true);
    else if (!finalizing) editorRef.current?.setFrozen(false);
  }, [session.reloadPending, finalizing]);

  const unresolved = session.regions.length - Object.keys(resolutionState.decisions).length;
  // A notice does not freeze editing — "Keep working" has to mean it. Only a
  // write in flight or a reload about to replace the document does.
  const blocked = finalizing || session.reloadPending;
  // A worktree-only change is the one external state the user may knowingly
  // write over, through the confirmation below. Everything else — a moved
  // conflict, a resolution outside Firn, a failed check — stays unwritable.
  const overwritable =
    session.external?.kind === 'changed' && session.external.scope === 'worktree';
  const disabled =
    unresolved !== 0 || session.readOnly || blocked || (Boolean(session.external) && !overwritable);
  const baseStatus =
    base.status === 'loading'
      ? 'Loading base…'
      : base.status === 'text'
        ? 'Base version loaded.'
        : base.status === 'message' || base.status === 'error'
          ? base.message
          : '';
  const finalize = async () => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    if (overwritable) {
      // Ask before overwriting what someone else wrote.
      requestOverwrite({ result: editor.getResult() });
      return;
    }
    editor.setFrozen(true);
    setFinalizing(true);
    try {
      const ok = await useGitStore.getState().mergeFinalizeAndStage(editor.getResult());
      // A successful finalize either advanced to the next queued file or
      // exhausted the queue; when a session is still open, put the user back in
      // the document rather than leaving focus on a disabled button.
      if (ok && useGitStore.getState().mergeSession) focusResult();
    } finally {
      if (editorRef.current === editor) editor.setFrozen(false);
      setFinalizing(false);
    }
  };

  return (
    <>
      <header className={styles.header}>
        <span className={styles.path}>{session.path}</span>
        <span className={styles.filePosition}>{remainingLabel(session)}</span>
        <span className={styles.unresolvedCount}>{unresolved} unresolved</span>
        {session.readOnly && (
          <span className={styles.readOnlyReason}>
            Read-only: {session.encoding} / {session.lineEndings} cannot be written losslessly.
          </span>
        )}
        <div className={styles.headerActions}>
          {reopened !== null && resolutionState.decisions[reopened] === undefined && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                editorRef.current?.activate(reopened);
                setReopened(null);
              }}
              disabled={blocked}
            >
              Conflict {reopened + 1} reopened — go to it
            </button>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => editorRef.current?.undo()}
            disabled={blocked}
          >
            Undo
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => editorRef.current?.next(1)}
            disabled={blocked}
          >
            Next unresolved
          </button>
        </div>
      </header>
      <MergeExternalNotice session={session} focusResult={focusResult} disabled={finalizing} />
      {resolutionRefusal && (
        <div className={styles.notice}>
          <span className={styles.noticeMessage} role="alert">
            {resolutionRefusal}
          </span>
        </div>
      )}
      {!REGIONS_CARRY_BASE(session) && (
        <div className={styles.baseStrip}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              if (baseExpanded) {
                setBaseExpanded(false);
                return;
              }
              setBaseExpanded(true);
              void loadBase();
            }}
            aria-expanded={baseExpanded}
          >
            {baseExpanded ? 'Hide' : 'Show'} base (common ancestor)
          </button>
          <span
            className={baseExpanded || base.status === 'error' ? styles.baseNote : styles.srOnly}
            aria-live="polite"
          >
            {baseStatus}
          </span>
          {baseExpanded && base.status === 'text' && (
            <pre
              className={styles.basePane}
              role="region"
              tabIndex={0}
              aria-label="Base version, read-only"
            >
              {base.content}
            </pre>
          )}
        </div>
      )}
      <div className={styles.body}>
        <nav className={styles.rail} aria-label="Conflicts">
          {session.regions.map((_, index) => {
            const decision = resolutionState.decisions[index];
            return (
              <button
                key={index}
                type="button"
                className={`${styles.railItem} ${decisionClass(decision)} ${resolutionState.activeIndex === index ? styles.active : ''}`}
                aria-current={resolutionState.activeIndex === index ? 'true' : undefined}
                aria-label={
                  decision === undefined
                    ? `Conflict ${index + 1}: unresolved`
                    : `Reopen conflict ${index + 1} (currently ${decisionLabel(decision)})`
                }
                onClick={() => {
                  const editor = editorRef.current;
                  if (!editor) return;
                  if (resolutionState.decisions[index] === undefined) {
                    editor.activate(index);
                    return;
                  }
                  if (editor.reopen(index)) setReopened(index);
                }}
                disabled={blocked}
              >
                {decision ?? index + 1}
              </button>
            );
          })}
        </nav>
        <div ref={hostRef} className={styles.editorHost} />
      </div>
      <footer className={styles.statusRow}>
        <div className={styles.progress} aria-label={`${unresolved} unresolved conflicts`}>
          {session.regions.map((_, index) => (
            <span
              key={index}
              className={`${styles.segment} ${decisionClass(resolutionState.decisions[index])}`}
            />
          ))}
        </div>
        <button
          type="button"
          className={styles.finalizeButton}
          disabled={disabled}
          onClick={() => void finalize()}
        >
          Write &amp; stage
        </button>
      </footer>
      <div role="status" aria-live="polite" className={styles.srOnly}>
        {announcement}
      </div>
    </>
  );
}

function SidesResolutionContent({
  session,
  finalizing,
  setFinalizing,
  focusResult,
  focusResultRef,
  requestOverwrite,
}: {
  session: SidesMergeSession;
  finalizing: boolean;
  setFinalizing: (finalizing: boolean) => void;
  focusResult: FocusResult;
  focusResultRef: React.RefObject<FocusResult>;
  requestOverwrite: (request: { result?: string }) => void;
}) {
  const firstSideRef = useRef<HTMLButtonElement>(null);
  focusResultRef.current = () => firstSideRef.current?.focus();

  const blocked = finalizing || session.reloadPending;
  const overwritable =
    session.external?.kind === 'changed' && session.external.scope === 'worktree';
  const finalizeBlocked = blocked || (Boolean(session.external) && !overwritable);
  const finalize = async () => {
    if (!session.selectedSide || finalizeBlocked) return;
    if (overwritable) {
      requestOverwrite({});
      return;
    }
    setFinalizing(true);
    try {
      const ok = await useGitStore.getState().mergeFinalizeAndStage();
      if (ok && useGitStore.getState().mergeSession) focusResult();
    } finally {
      setFinalizing(false);
    }
  };
  const side = (key: 'ours' | 'theirs') => {
    const keepsFile = Boolean(session.stages[key]);
    const selected = session.selectedSide === key;
    const heading = key === 'ours' ? 'CURRENT' : 'INCOMING';
    const label = session.labels[key].label;
    return (
      <button
        ref={key === 'ours' ? firstSideRef : undefined}
        type="button"
        className={`${styles.sideChoice} ${selected ? styles.sideSelected : ''} ${key === 'ours' ? styles.decisionC : styles.decisionI}`}
        aria-pressed={selected}
        onClick={() => useGitStore.getState().selectMergeSide(key)}
        disabled={blocked}
      >
        <strong>
          {heading} — {label}
        </strong>{' '}
        {keepsFile ? 'keeps this file' : 'deletes this file'}
      </button>
    );
  };

  return (
    <>
      <header className={styles.header}>
        <span className={styles.path}>{session.path}</span>
        <span className={styles.filePosition}>{remainingLabel(session)}</span>
      </header>
      <MergeExternalNotice session={session} focusResult={focusResult} disabled={finalizing} />
      <div className={styles.sides}>
        {side('ours')}
        {side('theirs')}
      </div>
      <footer className={styles.statusRow}>
        <span className={styles.sideStatus}>Choose the side to stage.</span>
        <button
          type="button"
          className={styles.finalizeButton}
          disabled={!session.selectedSide || finalizeBlocked}
          onClick={() => void finalize()}
        >
          Write &amp; stage
        </button>
      </footer>
    </>
  );
}
