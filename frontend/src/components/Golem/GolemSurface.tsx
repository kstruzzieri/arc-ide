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
import {
  activeRunOf,
  isBound,
  isLivePhase,
  selectedConversation,
  STATUS_LABEL,
  workspaceName,
} from '../../golem/projection';
import type { RunPhase } from '../../types/golem';
import type {
  GolemView,
  ProjectedConversation,
  ProjectedRun,
  ProjectedTranscript,
} from '../../types/golemWindow';
import styles from './GolemPanel.module.css';

/**
 * The Golem chat tree, as a passive view (#271 Task B4).
 *
 * This file has one hard rule, and it is a rule about *imports*, not about
 * style: nothing reachable from here may pull in `golemStore`, `ideStore`, the
 * bridge, navigation, persistence or the Wails bindings. The satellite window
 * renders this component with a projection that arrived over a relay and a set
 * of callbacks that post actions back; if importing it could instantiate the
 * executing store, the undocked window would quietly grow a second owner of
 * the conversation. `GolemSurface.imports.test.ts` fails if that ever happens.
 *
 * Everything it draws therefore comes from `view` (B2's `GolemView`, which
 * carries no host drafts, no raw provider events and no owner-only submitted
 * prompts) and everything it changes goes out through `actions`.
 */

/**
 * Deliberately spelled out rather than imported as `GOLEM_UNAVAILABLE` from
 * `types/golem`: that module pulls in the generated Wails bindings for its
 * request constructors, and importing one string from it would drag the whole
 * backend surface into the satellite window. Type-only imports from there are
 * fine — they are erased. `GolemSurface.imports.test.tsx` is what caught this.
 */
const BRIDGE_UNAVAILABLE = 'Golem is unavailable.';

const NO_WORKSPACE = 'Open a workspace to chat with Golem.';
const BINDING = 'Connecting to Golem…';
const STALE = 'This workspace is no longer open.';
const UNAVAILABLE = 'Golem is unavailable in this workspace.';
const CONSENT_REQUIRED = 'This workspace asks for approval before sending anything to a provider.';

/** The backend has accepted these phases, so a cancellation can name a run it owns. */
const isCancelablePhase = (phase: RunPhase): boolean =>
  phase === 'needs-consent' || phase === 'running';

/** The assistant text a finished run produced, for the live region. */
function completedReply(conversation: ProjectedConversation, runId: string): string {
  for (let index = conversation.transcript.length - 1; index >= 0; index -= 1) {
    const entry = conversation.transcript[index];
    if (entry.kind === 'assistant' && entry.runId === runId && entry.text.trim() !== '') {
      return entry.text;
    }
  }
  return '';
}

/** What the latest terminal run has to say, or '' while none has finished. */
function phaseAnnouncement(
  conversation: ProjectedConversation,
  latest: ProjectedRun | null
): string {
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
  entry: ProjectedTranscript;
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
function workingActivity(conversation: ProjectedConversation, activeRun: ProjectedRun): string {
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

function clusterStatus(entries: ProjectedTranscript[]): ToolStatus {
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
function toolNameSummary(entries: ProjectedTranscript[]): string {
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
 * isError}`, and the four read tools send an empty preview — so the detail
 * available is the tool's name, its status, the call id and a non-empty
 * preview. The raw provider event body is deliberately *not* here: it is
 * owner-only and never crosses the window boundary (`ProjectedTranscript` omits
 * `raw`), and this surface renders the same projection in both windows rather
 * than being richer in one of them.
 *
 * Memoised on the entry: a chip that reached a terminal activity keeps its
 * reference across a delta, so a token stream re-renders one assistant row and
 * skips every settled chip. The detail toggle is the chip's own local state,
 * so opening one never touches a store or its neighbours.
 */
const ToolChip = memo(function ToolChip({ entry }: { entry: ProjectedTranscript }) {
  const [open, setOpen] = useState(false);
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
          {preview === '' ? (
            <p className={styles.detailNote}>This tool call reported no preview.</p>
          ) : (
            <div className={styles.detailPair}>
              <dt>Preview</dt>
              {/* Text, never markup: the preview is untrusted tool output. */}
              <dd className={styles.detailText}>{preview}</dd>
            </div>
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
  entries: ProjectedTranscript[];
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
  | { type: 'entry'; entry: ProjectedTranscript }
  | { type: 'cluster'; id: string; entries: ProjectedTranscript[] };

/**
 * Folds each run of consecutive `kind: 'tool'` entries into one cluster; any
 * non-tool entry breaks the run. Pure over the entry list — the projection
 * keeps entries flat, so this is the only place the grouping exists.
 */
function groupTranscript(transcript: ProjectedTranscript[]): TranscriptItem[] {
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
 * The nine things a user can do to a conversation (#271 spec §5.2) — exactly
 * the `GolemViewAction` vocabulary the relay carries, so a satellite window can
 * post any of them and the docked host can call the store directly.
 *
 * `clear` and `openConfig` are dispatched by the host's own chrome (the docked
 * command bar's New chat and Configuration buttons); `openConfig` is also
 * reachable from this surface's unavailable notice. Every other member is
 * dispatched from here.
 */
export interface GolemSurfaceActions {
  send(conversationId: string, text: string): void;
  allowAndSend(conversationId: string, runId: string, challengeId: string): void;
  cancelRun(runId: string): void;
  retry(conversationId: string): void;
  updateQueued(conversationId: string, queueId: string, text: string): void;
  removeQueued(conversationId: string, queueId: string): void;
  select(conversationId: string): void;
  clear(conversationId: string): void;
  openConfig(): void;
}

export interface GolemSurfaceProps {
  /** Everything drawn here. Never a store read — see the file comment. */
  view: GolemView;
  /** The selected conversation's composer text, owned by the visible host. */
  draft: string;
  onDraftChange(text: string): void;
  actions: GolemSurfaceActions;
  /**
   * The transfer barrier. While a handoff is in flight the conversation has no
   * single owner, so nothing may be dispatched and nothing may be typed — and
   * the block is enforced in the handlers, not only through `disabled`, so a
   * click already dispatched in the same tick cannot slip past it.
   */
  frozen: boolean;
  /**
   * One selected-conversation Send or Clear is awaiting acknowledgement. It
   * locks that composer and its Send only; every other control — switching
   * conversation, editing the queue, canceling a run — stays usable.
   */
  composerPending: boolean;
  /** The armed composer-focus request; only a *changed* value focuses. */
  focusRevision: number;
  /**
   * The shell's *effective* visibility, including which window currently owns
   * the view. A hidden surface neither measures itself, nor takes focus, nor
   * announces — otherwise both windows would speak at once.
   */
  visible: boolean;
}

export function GolemSurface({
  view,
  draft,
  onDraftChange,
  actions,
  frozen,
  composerPending,
  focusRevision,
  visible,
}: GolemSurfaceProps) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Follow the stream only while the user is already at the newest row, the
  // same rule the run output follows: scrolling back through a conversation
  // must not be yanked away by the next delta.
  const pinnedRef = useRef(true);
  // Per-cluster collapse overrides, keyed by the cluster's stable id (its first
  // entry's id). Local, never in a store: a disclosure is view state. Absent
  // means "use the default", so a finished cluster collapses on its own once its
  // running tool settles and stops being the default-expanded one.
  const [clusterOverrides, setClusterOverrides] = useState<Record<string, boolean>>({});

  const conversations = view.conversations;
  const selectedConversationId = view.selectedConversationId;
  const conversation = selectedConversation(view);
  const conversationId = conversation?.identity.conversationId ?? null;

  const notice = useMemo(() => {
    if (view.bridgePhase === 'binding') return BINDING;
    if (view.bridgePhase === 'error') return view.bridgeError ?? BRIDGE_UNAVAILABLE;
    if (!conversation) return NO_WORKSPACE;
    if (!isBound(view, conversation)) return STALE;
    if (!conversation.available) return conversation.initError ?? UNAVAILABLE;
    return null;
  }, [view, conversation]);

  // True only for the notice's "Golem is unavailable" branch above — not the
  // no-workspace, still-binding, or stale-identity cases, none of which have a
  // configuration worth reviewing.
  const unavailable = useMemo(() => {
    if (view.bridgePhase === 'binding' || view.bridgePhase === 'error') return false;
    if (!conversation) return false;
    return isBound(view, conversation) && !conversation.available;
  }, [view, conversation]);

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
    const rows: { run: ProjectedRun; label: string }[] = [];
    for (const [id, projected] of Object.entries(conversations)) {
      if (id === selectedConversationId) continue;
      for (const run of Object.values(projected.runs)) {
        if (isLivePhase(run.phase)) rows.push({ run, label: workspaceName(projected) });
      }
    }
    return rows;
  }, [conversations, selectedConversationId]);

  const conversationList = Object.entries(conversations);

  const activeRun = activeRunOf(conversation);
  const pending = conversation?.pendingConsentTurn ?? null;
  const statusLabel = activeRun ? STATUS_LABEL[activeRun.phase] : undefined;
  const composerLocked = frozen || composerPending || conversationId === null;
  const canSend = notice === null && !composerLocked && draft.trim() !== '';

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
    let latest: ProjectedRun | null = null;
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
  // The request is only spent once the composer actually takes the focus, so an
  // absent one — or a composer still disabled because the conversation has not
  // bound yet, a handoff is in flight, or a send is unacknowledged — leaves the
  // request armed instead of dropping it. That is why `composerLocked` is a
  // dependency: it is what re-enables the textarea.
  const consumedFocusRevision = useRef(focusRevision);
  useEffect(() => {
    if (!visible || frozen || composerPending) return;
    if (consumedFocusRevision.current === focusRevision) return;
    const composer = composerRef.current;
    if (!composer) return;
    composer.focus();
    if (document.activeElement === composer) consumedFocusRevision.current = focusRevision;
  }, [focusRevision, visible, frozen, composerPending, composerLocked]);

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
  const lastClusterId = useMemo(() => {
    let id: string | null = null;
    for (const item of renderItems) if (item.type === 'cluster') id = item.id;
    return id;
  }, [renderItems]);

  // Auto-grow the composer to fit the draft, then scroll past the ceiling. The
  // draft is a prop now, so this keys on that value; the rows=3 intrinsic
  // height is the natural floor, so a cleared draft shrinks the box back.
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  const send = () => {
    // The frozen check is repeated here rather than trusted to `disabled`: a
    // keydown or a click can already be in flight when the barrier goes up.
    if (frozen || composerPending || conversationId === null) return;
    if (draft.trim() === '') return;
    actions.send(conversationId, draft);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // An Enter that commits an IME composition belongs to the composition, not
    // to the conversation.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const cancel = (runId: string) => {
    if (frozen) return;
    actions.cancelRun(runId);
  };

  return (
    <>
      {/* A switcher for one conversation is just a label repeated. */}
      {conversationList.length > 1 && (
        <div className={styles.conversations} role="group" aria-label="Golem conversations">
          {conversationList.map(([id, projected]) => (
            <button
              key={id}
              type="button"
              className={styles.conversationButton}
              aria-pressed={id === selectedConversationId}
              disabled={frozen}
              onClick={() => {
                if (frozen) return;
                actions.select(id);
              }}
            >
              {workspaceName(projected)}
            </button>
          ))}
        </div>
      )}

      {notice && (
        <p className={styles.notice}>
          {notice}
          {unavailable && (
            <button
              type="button"
              className={styles.reviewConfigButton}
              disabled={frozen}
              onClick={() => {
                if (frozen) return;
                actions.openConfig();
              }}
            >
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
                disabled={frozen}
                // That run's own conversation, never the focused one: a
                // background run may belong to a workspace the IDE is not on.
                onClick={() => {
                  if (frozen) return;
                  actions.select(run.identity.conversationId);
                }}
              >
                {label} · {run.phase}
              </button>
              {isCancelablePhase(run.phase) && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  aria-label={`Cancel the Golem run in ${label}`}
                  disabled={frozen}
                  onClick={() => cancel(run.identity.runId)}
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
              disabled={
                frozen || conversation?.runs[pending.identity.runId]?.phase !== 'needs-consent'
              }
              onClick={() => {
                if (frozen || conversationId === null) return;
                // The visible challenge, named explicitly: a grant dispatched
                // from a stale view must not approve a different destination.
                actions.allowAndSend(conversationId, pending.identity.runId, pending.challenge.id);
              }}
            >
              Allow &amp; send
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={
                frozen || conversation?.runs[pending.identity.runId]?.phase !== 'needs-consent'
              }
              onClick={() => cancel(pending.identity.runId)}
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
            disabled={frozen}
            onChange={(event) => {
              if (frozen || conversationId === null) return;
              actions.updateQueued(conversationId, turn.queueId, event.target.value);
            }}
          />
          {turn.state === 'reopen-required' && (
            <span className={styles.queuedState}>Waiting for the workspace</span>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            aria-label={`Remove queued message ${index + 1}`}
            disabled={frozen}
            onClick={() => {
              if (frozen || conversationId === null) return;
              actions.removeQueued(conversationId, turn.queueId);
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
          disabled={composerLocked}
          onChange={(event) => {
            if (composerLocked) return;
            onDraftChange(event.target.value);
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
              disabled={frozen}
              onClick={() => cancel(activeRun.identity.runId)}
            >
              Cancel
            </button>
          )}
          {conversation?.lastFailedTurn && (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={frozen}
              onClick={() => {
                if (frozen || conversationId === null) return;
                actions.retry(conversationId);
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>

      {/* Only the visible host announces: two windows sharing one conversation
          would otherwise say the same thing twice. */}
      <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="false">
        {visible && announcement && <span>{announcement}</span>}
        {visible && activeRun && activeAnnouncement && (
          <span key={activeRun.identity.runId}>
            {announcement && ' '}
            {activeAnnouncement}
          </span>
        )}
      </div>
    </>
  );
}
