import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import { GOLEM_UNAVAILABLE } from '../../types/golem';
import type { ConversationView, RunPhase, RunView, TranscriptEntry } from '../../types/golem';
import { focusConfigTab } from '../../utils/editorSurface';
import golemIcon from '../../assets/branding/golem-icon.svg';
import { PlusIcon, SettingsIcon } from '../icons';
import { PanelBarButton, PanelCommandBar } from '../layout/PanelCommandBar';
import styles from './GolemPanel.module.css';

/**
 * The Golem conversation view (#226 Task B8).
 *
 * Deliberately one file. The composer, transcript, consent shelf, queue, and
 * background strip are five views of one conversation record, and splitting
 * them would mean five components all reaching into the same store slice.
 *
 * The island stays mounted while collapsed (#271); in Plan A the draft, queue,
 * pending consent turn and focus signal stay in the existing golemStore. Plan B
 * moves drafts to the visible host and uses an acknowledged whole-map handoff;
 * it does not share one JavaScript store between windows. Even the live region
 * is derived, not accumulated.
 */

const NO_WORKSPACE = 'Open a workspace to chat with Golem.';
const BINDING = 'Connecting to Golem…';
const STALE = 'This workspace is no longer open.';
const UNAVAILABLE = 'Golem is unavailable in this workspace.';
const CONSENT_REQUIRED = 'This workspace asks for approval before sending anything to a provider.';

/** Phases shown as live in the focused or background run surfaces. */
const isLivePhase = (phase: RunPhase): boolean =>
  phase === 'admitting' ||
  phase === 'needs-consent' ||
  phase === 'running' ||
  phase === 'canceling';

/** The backend has accepted these phases, so a cancellation can name a run it owns. */
const isCancelablePhase = (phase: RunPhase): boolean =>
  phase === 'needs-consent' || phase === 'running';

/**
 * The bar's live status, carried as sr-only text beside the breathing mark.
 *
 * Keyed by exactly the live phases, so a present label is also the panel's
 * "something is happening" flag — the transcript's live rail node reads it
 * rather than testing `isLivePhase` a second time.
 */
const STATUS_LABEL: Partial<Record<RunPhase, string>> = {
  admitting: 'RUNNING',
  running: 'RUNNING',
  canceling: 'CANCELING',
  'needs-consent': 'APPROVAL',
};

const workspaceName = (conversation: ConversationView): string =>
  conversation.workspaceLabel || 'Workspace';

/** The assistant text a finished run produced, for the live region. */
function completedReply(conversation: ConversationView, runId: string): string {
  for (let index = conversation.transcript.length - 1; index >= 0; index -= 1) {
    const entry = conversation.transcript[index];
    if (entry.kind === 'assistant' && entry.runId === runId && entry.text.trim() !== '') {
      return entry.text;
    }
  }
  return '';
}

/** What the latest terminal run has to say, or '' while none has finished. */
function phaseAnnouncement(conversation: ConversationView, latest: RunView | null): string {
  if (!latest) return '';
  if (latest.phase === 'canceled') return 'Golem run canceled.';
  if (latest.phase === 'failed') return `Golem run failed. ${latest.error ?? ''}`.trim();
  return completedReply(conversation, latest.identity.runId) || 'Golem finished its reply.';
}

/**
 * Sanitized markdown for assistant replies. The security story is entirely
 * structural: react-markdown WITHOUT `rehype-raw` never parses raw HTML — a
 * literal `<b>x</b>` in provider output stays inert text — and we never touch
 * `dangerouslySetInnerHTML`. Markdown carries two live vectors even so, both
 * closed here by rendering our own inert elements:
 *   - links: a `<span>`, never an `<a href>`. In WKWebView an anchor click
 *     navigates the whole app to an attacker URL; a span cannot. The
 *     destination is visible text (react-markdown's default urlTransform has
 *     already stripped javascript:/data: etc.), so every input mode can read
 *     and copy it without making the WebView navigate.
 *   - images: the alt text as a `<span>`, never an `<img>`, so the webview
 *     never fetches an attacker URL (tracking / SSRF). `disallowedElements`
 *     can't preserve alt on a void `<img>`, so a component is the honest fix.
 * `disallowedElements` still drops the embed-family names for defense in depth
 * (they can't appear without rehype-raw, but cost nothing to refuse).
 */
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <span className={styles.mdLink}>
      {children}
      {href && <span className={styles.mdLinkDestination}> ({href})</span>}
    </span>
  ),
  img: ({ alt }) => (alt ? <span className={styles.mdImage}>{alt}</span> : null),
};

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_DISALLOWED = ['iframe', 'script', 'html', 'style', 'link', 'object', 'embed'];

/** Parsed only for settled replies; memoization keeps older rows untouched. */
const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      <Markdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        disallowedElements={MARKDOWN_DISALLOWED}
        unwrapDisallowed
      >
        {text}
      </Markdown>
    </div>
  );
});

/**
 * One non-tool transcript row (user / assistant / error).
 *
 * A component, not a file split: the transcript is the only genuinely O(n)
 * render here, and every entry but the streaming last one keeps its reference
 * across a delta, so memoising the row is what stops a token stream from
 * rebuilding the whole conversation each frame. Tool entries take the
 * `ToolChip` / `ToolCluster` path below instead.
 *
 * A live assistant reply stays plain text rather than reparsing the complete
 * growing document. Once its run settles, it renders as sanitized markdown.
 * User prompts and errors always stay plain.
 */
const TranscriptRow = memo(function TranscriptRow({
  entry,
  live,
}: {
  entry: TranscriptEntry;
  live: boolean;
}) {
  return (
    <div className={`${styles.entry} ${styles[entry.kind]}`}>
      <div className={styles.bubble}>
        {entry.kind === 'assistant' ? (
          live ? (
            <span className={styles.entryText}>{entry.text}</span>
          ) : (
            <MarkdownMessage text={entry.text} />
          )
        ) : (
          // Rendered as text, never as markup: user/error text is not markdown.
          <span className={styles.entryText}>{entry.text}</span>
        )}
      </div>
    </div>
  );
});

/** Phases in which the agent is actively working (a consent wait is not work). */
const isWorkingPhase = (phase: RunPhase): boolean =>
  phase === 'admitting' || phase === 'running' || phase === 'canceling';

/**
 * What the agent is doing right now, derived from real state only — no invented
 * counts. A currently-running tool wins; otherwise streamed assistant text means
 * it is composing a reply; otherwise it is still thinking.
 */
function workingActivity(conversation: ConversationView, activeRun: RunView): string {
  if (activeRun.phase === 'canceling') return 'Canceling…';
  const runId = activeRun.identity.runId;
  let responding = false;
  for (const entry of conversation.transcript) {
    if (entry.runId !== runId) continue;
    if (entry.kind === 'tool' && entry.activity === 'running') {
      return `Running ${entry.toolName || 'tool'}…`;
    }
    if (entry.kind === 'assistant' && entry.text.trim() !== '') responding = true;
  }
  return responding ? 'Responding…' : 'Thinking…';
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The Claude-Code-style working line: an obvious "the agent is running" notice
 * in the chat body after a prompt is sent. Elapsed is measured client-side from
 * when the notice appears — the only number here, and a real one. Token counts
 * and task counts are deliberately absent: neither is in the Phase 1 event
 * stream (firn-ide#265). `aria-hidden` because the sr-only phase label already
 * announces the working state and a ticking timer would spam a screen reader.
 */
function RunningNotice({ activity }: { activity: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className={styles.workingNotice} aria-hidden="true">
      <span className={styles.workingDot} />
      <span>{activity}</span>
      <span aria-hidden="true">·</span>
      <span className={styles.workingElapsed}>{formatElapsed(elapsed)}</span>
    </div>
  );
}

/** Worst-first status of a run of tool calls: failed dominates running dominates done. */
type ToolStatus = 'failed' | 'running' | 'done';

const STATUS_PHRASE: Record<ToolStatus, string> = {
  failed: 'some failed',
  running: 'in progress',
  done: 'all completed',
};

function clusterStatus(entries: TranscriptEntry[]): ToolStatus {
  let running = false;
  for (const entry of entries) {
    // An interrupted tool (a run canceled mid-call) is an abnormal end, so it
    // reads as the failed marker rather than a quiet "done".
    if (entry.activity === 'failed' || entry.activity === 'interrupted') return 'failed';
    if (entry.activity === 'running') running = true;
  }
  return running ? 'running' : 'done';
}

/** `search ×3, glob` — distinct tool names in first-seen order, counted. */
function toolNameSummary(entries: TranscriptEntry[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const name = entry.toolName || 'tool';
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order
    .map((name) => (counts.get(name)! > 1 ? `${name} ×${counts.get(name)}` : name))
    .join(', ');
}

/**
 * One tool call as a clickable chip that reveals what the event carries.
 *
 * Honest limit: go-llm's tool events emit only `{toolCallId, name, preview,
 * isError}`, and the four read tools send an empty preview — so the richest
 * detail available today is the tool's name, its status, the call id, the
 * event `seq`, a non-empty preview when present, and the raw payload JSON.
 * Upstream kstruzzieri/go-llm#393 adds sanitized arguments; when it lands they
 * appear in the raw payload below with no change here.
 *
 * Memoised on the entry: a chip that reached a terminal activity keeps its
 * reference across a delta, so a token stream re-renders one assistant row and
 * skips every settled chip. The detail toggle is the chip's own local state,
 * so opening one never touches the store or its neighbours.
 */
const ToolChip = memo(function ToolChip({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false);
  const raw = entry.raw;
  const preview = entry.text;
  return (
    <div className={`${styles.entry} ${styles.tool}`}>
      <button
        type="button"
        className={styles.toolChip}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {/* Two-tone like the mockups' `.k`: purple verb, neutral detail. */}
        <span className={styles.toolName}>{entry.toolName || 'tool'}</span>
        {entry.activity && <span className={styles.toolActivity}>{entry.activity}</span>}
      </button>
      {open && (
        <dl className={styles.toolDetail}>
          <div className={styles.detailPair}>
            <dt>Tool</dt>
            <dd>{entry.toolName || 'tool'}</dd>
          </div>
          {entry.activity && (
            <div className={styles.detailPair}>
              <dt>Status</dt>
              <dd>{entry.activity}</dd>
            </div>
          )}
          {entry.toolCallId && (
            <div className={styles.detailPair}>
              <dt>Call ID</dt>
              <dd>{entry.toolCallId}</dd>
            </div>
          )}
          {raw && (
            <div className={styles.detailPair}>
              <dt>Seq</dt>
              <dd>{raw.seq}</dd>
            </div>
          )}
          {preview !== '' && (
            <div className={styles.detailPair}>
              <dt>Preview</dt>
              {/* Text, never markup: the preview is untrusted tool output. */}
              <dd className={styles.detailText}>{preview}</dd>
            </div>
          )}
          {raw ? (
            // Raw payload as TEXT inside a <pre>, never dangerouslySetInnerHTML:
            // args land here for free once go-llm#393 populates the payload.
            <pre className={styles.toolRaw}>{JSON.stringify(raw.payload, null, 2)}</pre>
          ) : (
            <p className={styles.detailNote}>No raw event was captured for this tool call.</p>
          )}
        </dl>
      )}
    </div>
  );
});

/**
 * A run of consecutive tool calls, folded into one collapsible summary so a
 * four-search turn is one row rather than four chips. Rendered only for two or
 * more calls; a lone tool takes the `ToolChip` path directly.
 */
function ToolCluster({
  entries,
  expanded,
  onToggle,
}: {
  entries: TranscriptEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const status = clusterStatus(entries);
  const label = `${entries.length} tool calls, ${STATUS_PHRASE[status]} — ${
    expanded ? 'hide' : 'show'
  } details`;
  return (
    <div className={styles.cluster}>
      <button
        type="button"
        className={styles.clusterHeader}
        aria-expanded={expanded}
        aria-label={label}
        onClick={onToggle}
      >
        <span className={styles.clusterMarker} data-status={status} aria-hidden="true" />
        <span className={styles.clusterSummary}>
          {entries.length} tools · {toolNameSummary(entries)}
        </span>
        <span className={styles.clusterChevron} aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className={styles.clusterBody}>
          {entries.map((entry) => (
            <ToolChip key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Render-layer view of the flat transcript: tool runs folded into clusters. */
type TranscriptItem =
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'cluster'; id: string; entries: TranscriptEntry[] };

/**
 * Folds each run of consecutive `kind: 'tool'` entries into one cluster; any
 * non-tool entry breaks the run. Pure over the entry list — the store keeps
 * entries flat, so this is the only place the grouping exists.
 */
function groupTranscript(transcript: TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const entry of transcript) {
    if (entry.kind === 'tool') {
      const last = items[items.length - 1];
      if (last && last.type === 'cluster') last.entries.push(entry);
      else items.push({ type: 'cluster', id: entry.id, entries: [entry] });
    } else {
      items.push({ type: 'entry', entry });
    }
  }
  return items;
}

/** Slack, in px, for treating a scroll position as "at the newest row". */
const PIN_SLACK = 4;

/** Composer auto-grow ceiling, in px, past which the field scrolls. */
const COMPOSER_MAX_HEIGHT = 160;

/**
 * Escape closes the connection disclosure and hands focus back to its summary —
 * the behaviour a dialog-like disclosure owes the keyboard, which `<details>`
 * does not supply on its own.
 */
function closeDetailsOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== 'Escape' || !event.currentTarget.open) return;
  event.preventDefault();
  event.currentTarget.open = false;
  event.currentTarget.querySelector<HTMLElement>('summary')?.focus();
}

interface GolemPanelProps {
  /**
   * The shell's *effective* visibility (#271). Not the saved collapse flag: a
   * saved-open island is still a rail under window pressure, and a hidden mount
   * must neither steal focus nor try to measure itself.
   */
  visible: boolean;
}

export function GolemPanel({ visible }: GolemPanelProps) {
  const conversations = useGolemStore((state) => state.conversations);
  const selectedConversationId = useGolemStore((state) => state.selectedConversationId);
  const hydratedIdentity = useGolemStore((state) => state.hydratedIdentity);
  const bridgePhase = useGolemStore((state) => state.bridgePhase);
  const bridgeError = useGolemStore((state) => state.bridgeError);
  const composerFocusRevision = useGolemStore((state) => state.composerFocusRevision);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Follow the stream only while the user is already at the newest row, the
  // same rule the run output follows: scrolling back through a conversation
  // must not be yanked away by the next delta.
  const pinnedRef = useRef(true);
  // Per-cluster collapse overrides, keyed by the cluster's stable id (its first
  // entry's id). Local, never in the store: a disclosure is view state. Absent
  // means "use the default", so a finished cluster collapses on its own once its
  // running tool settles and stops being the default-expanded one.
  const [clusterOverrides, setClusterOverrides] = useState<Record<string, boolean>>({});

  const conversation = selectedConversationId
    ? (conversations[selectedConversationId] ?? null)
    : null;
  const conversationId = conversation?.identity.conversationId ?? null;

  const notice = useMemo(() => {
    if (bridgePhase === 'binding') return BINDING;
    if (bridgePhase === 'error') return bridgeError ?? GOLEM_UNAVAILABLE;
    if (!conversation) return NO_WORKSPACE;
    // A conversation the backend is no longer bound to cannot accept a turn,
    // and its identity is the only thing the backend would reject it by.
    const current = hydratedIdentity;
    const bound =
      current !== null &&
      current.repoEpoch === conversation.identity.repoEpoch &&
      current.workspaceId === conversation.identity.workspaceId &&
      current.conversationId === conversation.identity.conversationId;
    if (!bound) return STALE;
    if (!conversation.available) return conversation.initError ?? UNAVAILABLE;
    return null;
  }, [bridgePhase, bridgeError, conversation, hydratedIdentity]);

  // True only for the notice's "Golem is unavailable" branch above — not the
  // no-workspace, still-binding, or stale-identity cases, none of which have a
  // configuration worth reviewing.
  const unavailable = useMemo(() => {
    if (bridgePhase === 'binding' || bridgePhase === 'error') return false;
    if (!conversation) return false;
    const current = hydratedIdentity;
    const bound =
      current !== null &&
      current.repoEpoch === conversation.identity.repoEpoch &&
      current.workspaceId === conversation.identity.workspaceId &&
      current.conversationId === conversation.identity.conversationId;
    return bound && !conversation.available;
  }, [bridgePhase, conversation, hydratedIdentity]);

  // Everything the backend flagged, shown in the panel rather than as a toast
  // that scrolls away before the user reads it.
  const inlineWarnings = useMemo(() => {
    if (!conversation) return [] as string[];
    const rows = [...conversation.warnings];
    if (conversation.initError && conversation.initError !== notice) {
      rows.push(conversation.initError);
    }
    if (conversation.needsConsent && !conversation.pendingConsentTurn) rows.push(CONSENT_REQUIRED);
    return rows;
  }, [conversation, notice]);

  const backgroundRuns = useMemo(() => {
    const rows: { run: RunView; label: string }[] = [];
    for (const [id, view] of Object.entries(conversations)) {
      if (id === selectedConversationId) continue;
      for (const run of Object.values(view.runs)) {
        if (isLivePhase(run.phase)) rows.push({ run, label: workspaceName(view) });
      }
    }
    return rows;
  }, [conversations, selectedConversationId]);

  const conversationList = Object.entries(conversations);

  const activeRun =
    conversation?.activeRunId != null
      ? (conversation.runs[conversation.activeRunId] ?? null)
      : null;
  const pending = conversation?.pendingConsentTurn ?? null;
  const draft = conversation?.draft ?? '';
  const destination = conversation?.destination ?? null;
  const canSend = notice === null && conversationId !== null && draft.trim() !== '';
  const statusLabel = activeRun ? STATUS_LABEL[activeRun.phase] : undefined;

  // "New chat" resets the conversation to a fresh idle state. It is blocked
  // while a run is live or a consent is pending — the store refuses the clear
  // there anyway (a live run could re-hydrate a cleared conversation), so a
  // disabled button reads as the honest affordance. It is also pointless with
  // nothing to clear: an empty transcript, no draft, and no queued turns.
  const clearBusy =
    conversation !== null &&
    (conversation.activeRunId !== null || conversation.pendingConsentTurn !== null);
  const clearEmpty =
    conversation !== null &&
    conversation.transcript.length === 0 &&
    conversation.draft === '' &&
    conversation.queuedTurns.length === 0;
  const canClear = conversation !== null && !clearBusy && !clearEmpty;

  /**
   * The single polite announcement, derived rather than accumulated.
   *
   * A live region announces when its content changes, so "announce once" is
   * exactly "compute a value that only changes on the events worth hearing".
   * Deltas move the transcript but not a run's phase and not the pending
   * challenge, so a token stream leaves this string untouched and silent.
   */
  const announcement = useMemo(() => {
    if (!conversation) return '';
    const challenge = conversation.pendingConsentTurn?.challenge;
    if (challenge) {
      return `Golem needs your approval to send this message to ${challenge.destination.provider}.`;
    }
    let latest: RunView | null = null;
    for (const run of Object.values(conversation.runs)) {
      if (run.phase === 'done' || run.phase === 'failed' || run.phase === 'canceled') latest = run;
    }
    // An error can arrive without moving any phase — a refused cancel restores
    // the run's previous phase and only appends a row — so the newest error row
    // is part of the derived string, not just the phases. Deltas never append
    // one, so a stream still leaves this silent.
    let lastError = '';
    for (const entry of conversation.transcript) {
      if (entry.kind === 'error') lastError = entry.text;
    }
    const phase = phaseAnnouncement(conversation, latest);
    // A terminal that already speaks that text does not say it twice.
    if (lastError && !phase.includes(lastError)) return `${phase} Golem error. ${lastError}`.trim();
    return phase;
  }, [conversation]);

  const activeAnnouncement =
    activeRun && isWorkingPhase(activeRun.phase)
      ? activeRun.phase === 'canceling'
        ? 'Golem is canceling.'
        : 'Golem is working.'
      : '';

  // The island stays mounted through collapse now (#271), so focus follows an
  // explicit request rather than a mount: only a *changed* revision arms the
  // composer, and only the visible host consumes it. A request raised while the
  // panel is a rail waits here until the panel is shown, so ⌘⇧I still lands;
  // becoming visible on its own (a widened window, a restore) never does.
  // The request is only spent once a composer actually takes the focus, so a
  // render without one leaves the request armed rather than dropping it.
  const consumedFocusRevision = useRef(composerFocusRevision);
  useEffect(() => {
    if (!visible || consumedFocusRevision.current === composerFocusRevision) return;
    const composer = composerRef.current;
    if (!composer) return;
    consumedFocusRevision.current = composerFocusRevision;
    composer.focus();
  }, [composerFocusRevision, visible]);

  // A hidden pane cannot be measured or scrolled, so becoming visible re-pins
  // the transcript to the newest row and re-fits the composer — without focus.
  useLayoutEffect(() => {
    if (!visible) return;
    const element = transcriptRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(composer.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [visible]);

  const transcript = conversation?.transcript;
  useEffect(() => {
    const element = transcriptRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [transcript]);

  // Grouping is a pure fold over the entry list, memoised on the array identity
  // so it re-runs once per transcript change (a delta) and not on unrelated
  // re-renders like composer typing. The heavy per-chip work stays in the
  // memoized ToolChip, so a delta still updates one row.
  const renderItems = useMemo(() => groupTranscript(transcript ?? []), [transcript]);
  // Only the newest cluster defaults open, and only while it holds a live tool —
  // that is the one the user needs to watch; finished clusters stay tucked away.
  let lastClusterId: string | null = null;
  for (const item of renderItems) if (item.type === 'cluster') lastClusterId = item.id;

  // Auto-grow the composer to fit the draft, then scroll past the ceiling. The
  // draft lives in golemStore, so this keys on that value rather than moving it
  // to component state; the rows=3 intrinsic height is the natural floor, so a
  // cleared draft shrinks the box back on its own.
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  const send = () => {
    // Only the identity guard: every other blocked state — no workspace, a
    // binding in flight, a stale identity, an unavailable backend, a blank
    // draft — is already refused by `golemStore.submitTurn`.
    if (conversationId === null) return;
    void useGolemStore.getState().submitTurn(conversationId);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // An Enter that commits an IME composition belongs to the composition, not
    // to the conversation.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    // data-accent pins the whole panel to the glacier accent the way
    // Terminal.tsx does, so Send, focus rings, and the Golem chrome share one
    // accent regardless of the workspace.
    <div className={styles.panel} data-accent="project">
      <div className={styles.chrome}>
        <PanelCommandBar
          panel="golem"
          name="GOLEM"
          tile={
            // The mark doubles as the live indicator: it breathes while a run is
            // active. Decorative — the sr-only status in `meta` carries the state.
            <img
              className={styles.tileIcon}
              src={golemIcon}
              alt=""
              draggable={false}
              data-live={statusLabel ? 'true' : undefined}
            />
          }
          meta={
            statusLabel ? (
              <>
                <span className={styles.liveDot} aria-hidden="true" />
                <span className={styles.srOnly}>{statusLabel}</span>
              </>
            ) : undefined
          }
          controls={
            <>
              <PanelBarButton label="Configuration" onClick={focusConfigTab}>
                <SettingsIcon aria-hidden="true" />
              </PanelBarButton>
              <PanelBarButton
                label="New chat"
                title={clearBusy ? 'Finish or cancel the current run first' : 'New chat'}
                disabled={!canClear}
                onClick={() => {
                  if (conversationId) useGolemStore.getState().clearConversation(conversationId);
                }}
              >
                <PlusIcon aria-hidden="true" />
              </PanelBarButton>
            </>
          }
          onCollapse={() => useIDEStore.getState().setGolemPanelCollapsed(true)}
        />
        <div className={styles.chipsRow}>
          <span className={styles.workspace}>
            {conversation ? workspaceName(conversation) : 'No workspace'}
          </span>
          {destination && (
            <span className={styles.badge} data-classification={destination.classification}>
              {destination.classification === 'local' ? 'Local' : 'Remote'}
            </span>
          )}
          {!destination && <span className={styles.badge}>Unknown</span>}
          {destination && (
            <span className={styles.modelChip}>
              <span className={styles.provider}>{destination.provider}</span>
              <span aria-hidden="true">·</span>
              <span className={styles.model}>{destination.model}</span>
            </span>
          )}
          {/* D5: the exact endpoint stays reachable — it is the only place the
              machine a prompt would reach is spelled out — but behind a native
              disclosure instead of a permanent third row. Escape closes it and
              returns focus to the summary. */}
          <details className={styles.chipDetails} onKeyDown={closeDetailsOnEscape}>
            <summary className={styles.chipSummary}>Connection</summary>
            <div className={styles.chipDetailsBody}>
              {destination && <span className={styles.endpoint}>{destination.endpoint}</span>}
              <span>Context: prompt only</span>
            </div>
          </details>
        </div>
      </div>

      {/* A switcher for one conversation is just a label repeated. */}
      {conversationList.length > 1 && (
        <div className={styles.conversations} role="group" aria-label="Golem conversations">
          {conversationList.map(([id, view]) => (
            <button
              key={id}
              type="button"
              className={styles.conversationButton}
              aria-pressed={id === selectedConversationId}
              onClick={() => useGolemStore.getState().selectConversation(id)}
            >
              {workspaceName(view)}
            </button>
          ))}
        </div>
      )}

      {notice && (
        <p className={styles.notice}>
          {notice}
          {unavailable && (
            <button type="button" className={styles.reviewConfigButton} onClick={focusConfigTab}>
              Review configuration
            </button>
          )}
        </p>
      )}
      {/* Provider-supplied strings: two identical warnings are still two rows. */}
      {inlineWarnings.map((warning, index) => (
        <p key={`${index}-${warning}`} className={styles.warning}>
          {warning}
        </p>
      ))}

      {/* Focusable because it scrolls: WKWebView gives a bare scroll container
          no keyboard access of its own. `region`, not `log`: the implicit
          aria-live of a log would fight the one deliberate live region. */}
      <div
        ref={transcriptRef}
        className={styles.transcript}
        // Lights the newest timeline node while a run is live. An attribute
        // rather than a class on the row: the rail has to stay pure CSS so a
        // token delta still re-renders one memoized row and nothing else.
        data-live={statusLabel ? 'true' : undefined}
        tabIndex={0}
        role="region"
        aria-label="Golem transcript"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_SLACK;
        }}
      >
        {renderItems.map((item) => {
          if (item.type === 'entry') {
            const live =
              item.entry.runId === activeRun?.identity.runId && isLivePhase(activeRun.phase);
            return <TranscriptRow key={item.entry.id} entry={item.entry} live={live} />;
          }
          // A lone tool is a chip on its own, never wrapped in a "1 tool" cluster.
          if (item.entries.length === 1) {
            return <ToolChip key={item.id} entry={item.entries[0]} />;
          }
          const defaultExpanded =
            item.id === lastClusterId && item.entries.some((entry) => entry.activity === 'running');
          const expanded = clusterOverrides[item.id] ?? defaultExpanded;
          return (
            <ToolCluster
              key={item.id}
              entries={item.entries}
              expanded={expanded}
              onToggle={() =>
                setClusterOverrides((previous) => ({ ...previous, [item.id]: !expanded }))
              }
            />
          );
        })}
      </div>

      {conversation && activeRun && isWorkingPhase(activeRun.phase) && (
        <RunningNotice
          key={activeRun.identity.runId}
          activity={workingActivity(conversation, activeRun)}
        />
      )}

      {backgroundRuns.length > 0 && (
        <div className={styles.background}>
          {backgroundRuns.map(({ run, label }) => (
            <div key={run.identity.runId} className={styles.backgroundRow}>
              <button
                type="button"
                className={styles.backgroundLabel}
                // The phase is in the name because this strip is the only
                // surface that reports a background run's phase at all.
                aria-label={`Show the Golem run in ${label}: ${run.phase}`}
                // That run's own conversation, never the focused one: a
                // background run may belong to a workspace the IDE is not on.
                onClick={() =>
                  useGolemStore.getState().selectConversation(run.identity.conversationId)
                }
              >
                {label} · {run.phase}
              </button>
              {isCancelablePhase(run.phase) && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  aria-label={`Cancel the Golem run in ${label}`}
                  onClick={() => void useGolemStore.getState().cancelRun(run.identity.runId)}
                >
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {pending && (
        <div className={styles.consent} role="group" aria-label="Approval required">
          <p className={styles.consentCopy}>
            Golem needs your approval before this message leaves the machine.
          </p>
          <dl className={styles.destinationList}>
            <div className={styles.destinationPair}>
              <dt>Provider</dt>
              <dd>{pending.challenge.destination.provider}</dd>
            </div>
            <div className={styles.destinationPair}>
              <dt>Model</dt>
              <dd>{pending.challenge.destination.model}</dd>
            </div>
            <div className={styles.destinationPair}>
              <dt>Endpoint</dt>
              <dd>{pending.challenge.destination.endpoint}</dd>
            </div>
          </dl>
          <div className={styles.consentActions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={conversation?.runs[pending.identity.runId]?.phase !== 'needs-consent'}
              onClick={() => {
                if (conversationId) void useGolemStore.getState().allowAndSend(conversationId);
              }}
            >
              Allow &amp; send
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={conversation?.runs[pending.identity.runId]?.phase !== 'needs-consent'}
              onClick={() => void useGolemStore.getState().cancelRun(pending.identity.runId)}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* Numbered: n queued turns are otherwise n identically named controls. */}
      {conversation?.queuedTurns.map((turn, index) => (
        <div key={turn.queueId} className={styles.queued}>
          <input
            className={styles.queuedInput}
            aria-label={`Queued message ${index + 1}`}
            value={turn.message}
            onChange={(event) => {
              if (conversationId) {
                useGolemStore
                  .getState()
                  .updateQueuedTurn(conversationId, turn.queueId, event.target.value);
              }
            }}
          />
          {turn.state === 'reopen-required' && (
            <span className={styles.queuedState}>Waiting for the workspace</span>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            aria-label={`Remove queued message ${index + 1}`}
            onClick={() => {
              if (conversationId) {
                useGolemStore.getState().removeQueuedTurn(conversationId, turn.queueId);
              }
            }}
          >
            Remove
          </button>
        </div>
      ))}

      <div className={styles.composerRow}>
        <textarea
          ref={composerRef}
          className={styles.composer}
          aria-label="Message Golem"
          placeholder="Ask Golem…"
          rows={3}
          value={draft}
          disabled={conversationId === null}
          onChange={(event) => {
            if (conversationId) {
              useGolemStore.getState().setDraft(conversationId, event.target.value);
            }
          }}
          onKeyDown={handleComposerKeyDown}
        />
        <div className={styles.composerActions}>
          <button type="button" className={styles.primaryButton} disabled={!canSend} onClick={send}>
            Send
          </button>
          {activeRun && isCancelablePhase(activeRun.phase) && (
            <button
              type="button"
              className={`${styles.secondaryButton} ${styles.cancelButton}`}
              aria-label="Cancel the current Golem run"
              onClick={() => void useGolemStore.getState().cancelRun(activeRun.identity.runId)}
            >
              Cancel
            </button>
          )}
          {conversation?.lastFailedTurn && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                if (conversationId) void useGolemStore.getState().retryLastFailed(conversationId);
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>

      <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="false">
        {announcement && <span>{announcement}</span>}
        {activeRun && activeAnnouncement && (
          <span key={activeRun.identity.runId}>
            {announcement && ' '}
            {activeAnnouncement}
          </span>
        )}
      </div>
    </div>
  );
}
