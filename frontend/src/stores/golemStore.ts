import { create } from 'zustand';
import { CancelGolemRun, RunGolemTurn } from '../wails/bindings';
import {
  boundedGolemMessage as boundedMessage,
  GOLEM_UNAVAILABLE,
  GolemContractError,
  parseGolemEvent,
  parseRunStatus,
  parseTurnAdmission,
  toCancelRequest,
  toTurnRequest,
} from '../types/golem';
import type {
  ConversationIdentity,
  ConversationView,
  GolemActionResult,
  GolemEvent,
  GolemStatus,
  GolemStoreState,
  RunIdentity,
  RunPhase,
  RunView,
  TranscriptEntry,
  TurnAdmission,
  TurnDraft,
} from '../types/golem';
import type { GolemWindowState } from '../types/golemWindow';

/**
 * Conversation-keyed Golem chat state (#226 Task B7).
 *
 * The panel unmounts whenever the right panel collapses or switches to Runs, so
 * everything a conversation needs to survive that — transcript, draft, queue,
 * pending consent, composer focus — lives here rather than in component state.
 *
 * Two invariants drive most of the code:
 *  1. Reduction is monotonic. A run's phase only advances; a terminal phase is a
 *     process-lifetime tombstone for that run ID, so a deferred `RunGolemTurn`
 *     or `GetGolemStatus` result that lands after the run already ended cannot
 *     resurrect it, reopen the active slot, or dispatch the queue a second time.
 *  2. Nothing from the boundary is trusted. Wails results go through the
 *     validators in `types/golem.ts`; a contract break is a bridge error, and a
 *     malformed streamed event is silently dropped.
 */

const RUN_FAILED_ERROR = 'The Golem run failed.';
const NO_SECURE_UUID_ERROR =
  'This window cannot generate a secure run ID, so the turn was not sent.';
const STALE_BINDING_ERROR = 'The workspace changed before this turn started.';
const CONSENT_EXPIRED_ERROR = 'The consent request expired. Send the message again to retry it.';

// Refusal reasons (#271). Every guard that declines an action names why, in
// words the visible host can put in front of the user unchanged: a silent
// no-op leaves them staring at text that was neither sent nor kept.
const NO_CONVERSATION_ERROR = 'That Golem conversation is no longer open.';
const NOT_CONNECTED_ERROR = 'Golem is not connected yet.';
const STALE_CONVERSATION_ERROR = 'This workspace is no longer open.';
const EMPTY_MESSAGE_ERROR = 'There is nothing to send.';
const BUSY_ERROR = 'Golem is still working on the current run.';
const NO_PENDING_CONSENT_ERROR = 'There is no approval waiting in this conversation.';
const CONSENT_MISMATCH_ERROR = 'That approval was for a different request.';
const NOTHING_TO_RETRY_ERROR = 'There is no failed message to retry.';
const NO_QUEUED_TURN_ERROR = 'That queued message is no longer waiting.';
const UNKNOWN_RUN_ERROR = 'That Golem run is not running here.';
const NOT_CANCELABLE_ERROR = 'That Golem run cannot be canceled in its current state.';

const OK: GolemActionResult = { ok: true };
const refuse = (reason: string): GolemActionResult => ({ ok: false, reason });

/**
 * `rawEvents` is a bounded tail, not the transcript. Every projected row keeps
 * its own `raw` event, so nothing the UI renders reads this array; it exists
 * for raw inspection of what just arrived. A token-level delta stream reaches
 * tens of thousands of events in one session and every ingested frame copies
 * this array, so an unbounded list makes ingestion quadratic (estimated, not
 * benchmarked: tens of thousands of events cost seconds of main-thread work).
 * 500 is a judgement call — nothing depends on the exact number, only on the
 * bound existing — and keeps several screens of recent history at a flat cost.
 * Dropping from the head is safe: `lastSeq` lives on the run, and the
 * transcript projection is already applied by the time an entry ages out.
 *
 * Truncation is silent, so any view that renders this array must label itself
 * as the last `MAX_RAW_EVENTS` events rather than the whole session.
 */
const MAX_RAW_EVENTS = 500;

/**
 * Highest repository epoch ever hydrated. Epochs are never reused within a
 * process, so this is a monotonic floor that rejects a status snapshot captured
 * before an unbind/rebind even while `hydratedIdentity` is momentarily null.
 */
let hydratedEpochFloor = 0;
let localIdSeq = 0;
type TerminalPhase = 'done' | 'failed' | 'canceled';

interface UnknownTerminal {
  conversationId: string;
  identity?: RunIdentity;
  phase: TerminalPhase;
  message?: string;
  seq?: number;
  raw?: GolemEvent;
}

const unknownTerminals = new Map<string, UnknownTerminal>();

const nextLocalId = (prefix: string): string => `${prefix}-${++localIdSeq}`;

/**
 * `crypto.randomUUID` exists only in secure contexts. There is deliberately no
 * `Math.random`/timestamp fallback: the backend accepts nothing but a canonical
 * v4 UUID, and a guessable run ID is an identity, not a formatting, problem.
 */
function secureRandomUUID(): string | null {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.randomUUID !== 'function') return null;
  try {
    return webCrypto.randomUUID();
  } catch {
    return null;
  }
}

const isTerminalPhase = (phase: RunPhase): boolean =>
  phase === 'done' || phase === 'failed' || phase === 'canceled';

const sameConversationIdentity = (
  a: ConversationIdentity | null,
  b: ConversationIdentity | null
): boolean =>
  a !== null &&
  b !== null &&
  a.repoEpoch === b.repoEpoch &&
  a.workspaceId === b.workspaceId &&
  a.conversationId === b.conversationId;

const sameRunIdentity = (a: RunIdentity, b: RunIdentity): boolean =>
  sameConversationIdentity(a, b) && a.runId === b.runId;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

function newConversation(identity: ConversationIdentity, workspaceLabel = ''): ConversationView {
  return {
    identity,
    workspaceLabel,
    available: false,
    needsConsent: false,
    warnings: [],
    initError: null,
    destination: null,
    rawEvents: [],
    transcript: [],
    runs: {},
    activeRunId: null,
    queuedTurns: [],
    pendingConsentTurn: null,
    lastFailedTurn: null,
  };
}

// ── mutation scratchpad ───────────────────────────────────────────────────────
// A shallow working copy of the slices a reducer may touch. Conversations are
// copied on write so an ignored event leaves every object identity untouched
// and React skips the re-render entirely.

interface Mutation {
  /**
   * Conversations already copied in this mutation. Every writer drafts rather
   * than assuming a caller did, so no function carries an unstated ordering
   * obligation; the memo keeps a second draft within one mutation free, which
   * is what lets a whole frame of events cost a single working copy.
   */
  drafted: Set<string>;
  conversations: Record<string, ConversationView>;
  runToConversation: Record<string, string>;
  lastActiveConversationId: string | null;
  activityRevision: number;
  lastFailureConversationId: string | null;
  failureRevision: number;
}

const beginMutation = (state: GolemStoreState): Mutation => ({
  drafted: new Set(),
  conversations: { ...state.conversations },
  runToConversation: { ...state.runToConversation },
  lastActiveConversationId: state.lastActiveConversationId,
  activityRevision: state.activityRevision,
  lastFailureConversationId: state.lastFailureConversationId,
  failureRevision: state.failureRevision,
});

/** The publishable slices of a mutation; `drafted` is scratch and stays here. */
const toState = (mutation: Mutation) => ({
  conversations: mutation.conversations,
  runToConversation: mutation.runToConversation,
  lastActiveConversationId: mutation.lastActiveConversationId,
  activityRevision: mutation.activityRevision,
  lastFailureConversationId: mutation.lastFailureConversationId,
  failureRevision: mutation.failureRevision,
});

/**
 * Returns the mutation's own writable copy of a conversation, making one on
 * first use. Writing through anything else mutates published state in place:
 * the data still ends up correct, but the object identity never changes and
 * every `useGolemStore(s => s.conversations[id])` subscriber goes unnotified.
 */
function draftConversation(mutation: Mutation, conversationId: string): ConversationView | null {
  const existing = mutation.conversations[conversationId];
  if (!existing) return null;
  if (mutation.drafted.has(conversationId)) return existing;
  const copy: ConversationView = {
    ...existing,
    warnings: [...existing.warnings],
    rawEvents: [...existing.rawEvents],
    transcript: [...existing.transcript],
    runs: { ...existing.runs },
    queuedTurns: [...existing.queuedTurns],
  };
  mutation.conversations[conversationId] = copy;
  mutation.drafted.add(conversationId);
  return copy;
}

function markActive(mutation: Mutation, conversationId: string): void {
  mutation.lastActiveConversationId = conversationId;
  mutation.activityRevision += 1;
}

function markFailure(mutation: Mutation, conversationId: string): void {
  mutation.lastFailureConversationId = conversationId;
  mutation.failureRevision += 1;
}

function appendError(
  conversation: ConversationView,
  runId: string,
  text: string,
  raw?: GolemEvent
) {
  const entry: TranscriptEntry = { id: nextLocalId('error'), runId, kind: 'error', text };
  if (raw) entry.raw = raw;
  conversation.transcript.push(entry);
}

function appendRawEvent(conversation: ConversationView, event: GolemEvent): void {
  conversation.rawEvents.push(event);
  if (conversation.rawEvents.length > MAX_RAW_EVENTS) {
    conversation.rawEvents.splice(0, conversation.rawEvents.length - MAX_RAW_EVENTS);
  }
}

function upsertRun(
  conversation: ConversationView,
  runId: string,
  patch: Partial<RunView>
): RunView {
  const existing = conversation.runs[runId] ?? {
    identity: { ...conversation.identity, runId },
    phase: 'running' as RunPhase,
    lastSeq: -1,
  };
  const next = { ...existing, ...patch };
  conversation.runs[runId] = next;
  return next;
}

/**
 * Retires a pending consent turn that can no longer be granted, keeping its
 * prompt retryable.
 *
 * The backend drops a past-deadline challenge on its next `Status` call, and
 * the bridge calls `Status` on every `golem:status-changed`. After that both
 * `StartTurn` with the challenge ID and `Cancel` on that identity are rejected
 * forever, so a client that keeps waiting leaves the conversation busy with no
 * way out. Releasing the turn into `lastFailedTurn` lets the user resend it
 * under a fresh run ID and collect a fresh challenge.
 */
function releasePendingConsent(conversation: ConversationView, message: string): boolean {
  const pending = conversation.pendingConsentTurn;
  if (!pending) return false;
  const runId = pending.identity.runId;
  conversation.pendingConsentTurn = null;
  conversation.lastFailedTurn = { draft: pending.draft, userEntryId: pending.userEntryId };
  const run = conversation.runs[runId];
  if (run && !isTerminalPhase(run.phase)) {
    conversation.runs[runId] = { ...run, phase: 'failed', error: message };
  }
  if (conversation.activeRunId === runId) conversation.activeRunId = null;
  appendError(conversation, runId, message);
  return true;
}

// ── event payload projections ─────────────────────────────────────────────────

type Projection =
  | { kind: 'none' }
  | { kind: 'delta'; messageId: string; text: string }
  | { kind: 'tool-start'; toolCallId: string; name: string; preview: string }
  | { kind: 'tool-finish'; toolCallId: string; name: string; preview: string; isError: boolean }
  | { kind: 'terminal'; phase: TerminalPhase; message?: string };

/**
 * Classifies one already-validated envelope. `null` means the payload does not
 * match its own event type, in which case the event is dropped whole rather
 * than half-applied. Terminals are deliberately lenient: dropping one would
 * wedge the conversation's active slot forever.
 */
function classifyEvent(event: GolemEvent): Projection | null {
  const payload = event.payload;
  switch (event.type) {
    case 'run.started':
      return isRecord(payload) ? { kind: 'none' } : null;
    case 'message.delta': {
      if (!isRecord(payload)) return null;
      if (!isNonEmptyString(payload.messageId) || typeof payload.text !== 'string') return null;
      return { kind: 'delta', messageId: payload.messageId, text: payload.text };
    }
    case 'tool.started': {
      if (!isRecord(payload) || !isNonEmptyString(payload.toolCallId)) return null;
      return {
        kind: 'tool-start',
        toolCallId: payload.toolCallId,
        name: typeof payload.name === 'string' ? payload.name : '',
        preview: typeof payload.preview === 'string' ? payload.preview : '',
      };
    }
    case 'tool.finished': {
      if (!isRecord(payload) || !isNonEmptyString(payload.toolCallId)) return null;
      return {
        kind: 'tool-finish',
        toolCallId: payload.toolCallId,
        name: typeof payload.name === 'string' ? payload.name : '',
        preview: typeof payload.preview === 'string' ? payload.preview : '',
        isError: payload.isError === true,
      };
    }
    case 'run.finished':
      return isRecord(payload) ? { kind: 'terminal', phase: 'done' } : null;
    case 'run.canceled':
      return isRecord(payload) ? { kind: 'terminal', phase: 'canceled' } : null;
    case 'run.failed': {
      if (!isRecord(payload)) return null;
      const message =
        typeof payload.message === 'string' && payload.message.trim() !== ''
          ? boundedMessage(payload.message)
          : RUN_FAILED_ERROR;
      return { kind: 'terminal', phase: 'failed', message };
    }
    default:
      return { kind: 'none' };
  }
}

function applyDelta(
  conversation: ConversationView,
  event: GolemEvent,
  messageId: string,
  text: string
) {
  const entryId = `assistant:${event.runId}:${messageId}`;
  const index = conversation.transcript.findIndex((entry) => entry.id === entryId);
  if (index < 0) {
    conversation.transcript.push({
      id: entryId,
      runId: event.runId,
      kind: 'assistant',
      text,
      raw: event,
    });
    return;
  }
  const previous = conversation.transcript[index];
  conversation.transcript[index] = { ...previous, text: previous.text + text, raw: event };
}

function applyToolEvent(
  conversation: ConversationView,
  event: GolemEvent,
  projection: Extract<Projection, { kind: 'tool-start' | 'tool-finish' }>
) {
  const entryId = `tool:${event.runId}:${projection.toolCallId}`;
  const index = conversation.transcript.findIndex((entry) => entry.id === entryId);
  const activity =
    projection.kind === 'tool-start' ? 'running' : projection.isError ? 'failed' : 'done';
  if (index < 0) {
    conversation.transcript.push({
      id: entryId,
      runId: event.runId,
      kind: 'tool',
      text: projection.preview,
      toolCallId: projection.toolCallId,
      toolName: projection.name,
      activity,
      raw: event,
    });
    return;
  }
  const previous = conversation.transcript[index];
  conversation.transcript[index] = {
    ...previous,
    text: projection.preview || previous.text,
    toolName: projection.name || previous.toolName,
    activity,
    raw: event,
  };
}

// ── terminal reduction and queue dispatch ─────────────────────────────────────

interface PendingDispatch {
  identity: RunIdentity;
  draft: TurnDraft;
}

interface DispatchContext {
  hydratedIdentity: ConversationIdentity | null;
  bridgePhase: GolemStoreState['bridgePhase'];
}

/**
 * Starts at most the first staged turn. The backend emits a run's terminal only
 * after it has released the conversation, so dispatching here — and only here —
 * cannot be rejected as busy.
 */
function dispatchQueued(
  mutation: Mutation,
  conversationId: string,
  context: DispatchContext
): PendingDispatch | null {
  const conversation = draftConversation(mutation, conversationId);
  if (!conversation) return null;
  if (conversation.activeRunId !== null || conversation.pendingConsentTurn !== null) return null;

  const index = conversation.queuedTurns.findIndex((turn) => turn.state === 'queued');
  if (index < 0) return null;

  const current = context.hydratedIdentity;
  const epochCurrent =
    context.bridgePhase === 'ready' &&
    current !== null &&
    current.repoEpoch === conversation.identity.repoEpoch &&
    conversation.available;
  if (!epochCurrent) {
    conversation.queuedTurns[index] = {
      ...conversation.queuedTurns[index],
      state: 'reopen-required',
    };
    return null;
  }

  const runId = secureRandomUUID();
  const queued = conversation.queuedTurns[index];
  if (!runId) {
    appendError(conversation, '', NO_SECURE_UUID_ERROR);
    return null;
  }

  conversation.queuedTurns.splice(index, 1);
  const draft: TurnDraft = { message: queued.message, contextRefs: [...queued.contextRefs] };
  const identity: RunIdentity = { ...conversation.identity, runId };

  let userEntryId = queued.userEntryId;
  if (userEntryId) {
    // A consented prompt was already projected: retag it rather than repeat it.
    const existing = conversation.transcript.findIndex((entry) => entry.id === userEntryId);
    if (existing >= 0) {
      conversation.transcript[existing] = {
        ...conversation.transcript[existing],
        runId,
        text: draft.message,
      };
    } else {
      userEntryId = undefined;
    }
  }
  if (!userEntryId) {
    userEntryId = nextLocalId('user');
    conversation.transcript.push({ id: userEntryId, runId, kind: 'user', text: draft.message });
  }

  conversation.runs[runId] = {
    identity,
    phase: 'admitting',
    lastSeq: -1,
    request: draft,
    userEntryId,
  };
  conversation.activeRunId = runId;
  mutation.runToConversation[runId] = conversationId;
  return { identity, draft };
}

/**
 * Applies one terminal exactly once. A run already in a terminal phase is a
 * tombstone: it never re-enters the active slot and never re-dispatches.
 */
function finishRun(
  mutation: Mutation,
  conversationId: string,
  runId: string,
  phase: RunPhase,
  context: DispatchContext,
  message?: string,
  raw?: GolemEvent
): PendingDispatch | null {
  const conversation = draftConversation(mutation, conversationId);
  if (!conversation) return null;
  const existing = conversation.runs[runId];
  if (existing && isTerminalPhase(existing.phase)) return null;

  const run = upsertRun(conversation, runId, message ? { phase, error: message } : { phase });

  conversation.transcript = conversation.transcript.map((entry) =>
    entry.kind === 'tool' && entry.runId === runId && entry.activity === 'running'
      ? { ...entry, activity: 'interrupted' }
      : entry
  );
  if (message) appendError(conversation, runId, message, raw);

  if (conversation.activeRunId === runId) conversation.activeRunId = null;

  const pending = conversation.pendingConsentTurn;
  if (pending && pending.identity.runId === runId) {
    conversation.lastFailedTurn = { draft: pending.draft, userEntryId: pending.userEntryId };
    conversation.pendingConsentTurn = null;
  } else if (phase === 'failed' && run.request && run.userEntryId) {
    conversation.lastFailedTurn = { draft: run.request, userEntryId: run.userEntryId };
  }

  if (phase === 'failed') markFailure(mutation, conversationId);

  return dispatchQueued(mutation, conversationId, context);
}

/**
 * Reduces one streamed event into the working copy. `null` means the event was
 * ignored, so a batch that changes nothing leaves every object identity — and
 * therefore every React subscriber — untouched.
 */
function reduceEvent(
  mutation: Mutation,
  value: unknown,
  context: DispatchContext
): { dispatch: PendingDispatch | null } | null {
  const event = parseGolemEvent(value);
  if (!event) return null;
  const projection = classifyEvent(event);
  if (!projection) return null;

  const conversationId = mutation.runToConversation[event.runId] ?? event.threadId;
  const existing = mutation.conversations[conversationId];
  if (!existing) {
    if (projection.kind === 'terminal' && !unknownTerminals.has(event.runId)) {
      unknownTerminals.set(event.runId, {
        conversationId: event.threadId,
        phase: projection.phase,
        message: projection.message,
        seq: event.seq,
        raw: event,
      });
    }
    return null;
  }

  const knownRun = existing.runs[event.runId];
  if (knownRun && event.seq <= knownRun.lastSeq) return null;

  const conversation = draftConversation(mutation, conversationId)!;
  mutation.runToConversation[event.runId] = conversationId;

  appendRawEvent(conversation, event);
  upsertRun(conversation, event.runId, { lastSeq: event.seq });

  switch (projection.kind) {
    case 'delta':
      applyDelta(conversation, event, projection.messageId, projection.text);
      break;
    case 'tool-start':
    case 'tool-finish':
      applyToolEvent(conversation, event, projection);
      break;
    case 'terminal':
      return {
        dispatch: finishRun(
          mutation,
          conversationId,
          event.runId,
          projection.phase,
          context,
          projection.message,
          event
        ),
      };
    case 'none':
      if (event.type === 'run.started') {
        const run = conversation.runs[event.runId];
        if (!isTerminalPhase(run.phase) && run.phase !== 'canceling') {
          conversation.runs[event.runId] = { ...run, phase: 'running' };
          if (conversation.pendingConsentTurn?.identity.runId === event.runId) {
            conversation.pendingConsentTurn = null;
          }
          // A background run entering `running` by event is activity too.
          markActive(mutation, conversationId);
        }
      }
      break;
  }
  return { dispatch: null };
}

// ── store ─────────────────────────────────────────────────────────────────────

/**
 * The lifecycle every session starts in: docked, with no satellite window and
 * no transfer in flight (#271 spec §5.1). Exported because the relay and its
 * tests both need the exact shape Go's `closed` snapshot carries.
 */
export const DEFAULT_GOLEM_WINDOW_STATE: GolemWindowState = Object.freeze({
  mode: 'docked',
  phase: 'closed',
  instance: 0,
  restorePending: false,
  stateRevision: 0,
  handoff: 0,
});

const initialState = () => ({
  conversations: {} as Record<string, ConversationView>,
  runToConversation: {} as Record<string, string>,
  selectedConversationId: null as string | null,
  hydratedIdentity: null as ConversationIdentity | null,
  bridgePhase: 'unbound' as GolemStoreState['bridgePhase'],
  bridgeError: null as string | null,
  lastActiveConversationId: null as string | null,
  activityRevision: 0,
  lastFailureConversationId: null as string | null,
  failureRevision: 0,
  configTabOpen: false,
  configTabFocused: false,
  composerFocusRevision: 0,
  // App-scoped (#271 B6): `invalidateBinding` and `hydrateStatus` write named
  // fields only, so a repository switch never touches these three. They are
  // here so a fresh store — and the test reset — starts docked.
  windowState: DEFAULT_GOLEM_WINDOW_STATE,
  hostFrozen: false,
  windowError: null as string | null,
});

/**
 * Set while the store is created. Batch ingestion is a delivery concern of the
 * bridge rather than a store action, and the declared `GolemStoreState`
 * contract is frozen for Task B8, so it is exported beside the store instead
 * of on it.
 *
 * `create()` runs its initializer synchronously at module evaluation, so this
 * is assigned before any importer can call the export. The default therefore
 * only survives a future circular import that calls it during evaluation, and
 * it throws rather than silently dropping the events that caller delivered.
 */
let ingestGolemEventBatch: (values: unknown[]) => void = () => {
  throw new Error('golem store not initialized');
};

export const useGolemStore = create<GolemStoreState>()((set, get) => {
  /**
   * Send is allowed only into the conversation the backend just hydrated.
   * Returns the refusal reason, or `null` when the send may proceed — the
   * guard and the message the host shows are one decision, so they are one
   * function rather than a boolean plus a second walk over the same state.
   */
  const sendRefusal = (conversationId: string): string | null => {
    const state = get();
    const conversation = state.conversations[conversationId];
    if (!conversation) return NO_CONVERSATION_ERROR;
    if (state.bridgePhase !== 'ready') return NOT_CONNECTED_ERROR;
    if (!sameConversationIdentity(state.hydratedIdentity, conversation.identity)) {
      return STALE_CONVERSATION_ERROR;
    }
    if (!conversation.available) return conversation.initError ?? GOLEM_UNAVAILABLE;
    return null;
  };

  /** Advances only the token-matched run that is still awaiting admission. */
  const admittingRun = (
    state: GolemStoreState,
    identity: RunIdentity
  ): { conversationId: string; run: RunView } | null => {
    const conversationId = state.runToConversation[identity.runId];
    if (!conversationId) return null;
    const run = state.conversations[conversationId]?.runs[identity.runId];
    if (!run || run.phase !== 'admitting') return null;
    return { conversationId, run };
  };

  const applyAdmission = (identity: RunIdentity, admission: TurnAdmission) => {
    set((state) => {
      const matched = admittingRun(state, identity);
      if (!matched) return state;
      const mutation = beginMutation(state);
      const conversation = draftConversation(mutation, matched.conversationId)!;
      const run = conversation.runs[identity.runId];

      if (admission.state === 'accepted') {
        conversation.runs[identity.runId] = { ...run, phase: 'running' };
        if (conversation.activeRunId === null) conversation.activeRunId = identity.runId;
        if (conversation.pendingConsentTurn?.identity.runId === identity.runId) {
          conversation.pendingConsentTurn = null;
        }
        markActive(mutation, matched.conversationId);
        return toState(mutation);
      }

      // A challenge belongs to the binding that issued it; the backend drops it
      // on unbind, so a stale-epoch grant must never be offered to the user.
      const stale = identity.repoEpoch < hydratedEpochFloor;
      if (stale || !run.request || !run.userEntryId) {
        conversation.runs[identity.runId] = {
          ...run,
          phase: 'failed',
          error: STALE_BINDING_ERROR,
        };
        appendError(conversation, identity.runId, STALE_BINDING_ERROR);
        if (conversation.activeRunId === identity.runId) conversation.activeRunId = null;
        if (run.request && run.userEntryId) {
          conversation.lastFailedTurn = { draft: run.request, userEntryId: run.userEntryId };
        }
        markFailure(mutation, matched.conversationId);
        return toState(mutation);
      }

      conversation.runs[identity.runId] = { ...run, phase: 'needs-consent' };
      conversation.activeRunId = identity.runId;
      conversation.pendingConsentTurn = {
        draft: run.request,
        identity: run.identity,
        challenge: admission.consentChallenge,
        userEntryId: run.userEntryId,
      };
      markActive(mutation, matched.conversationId);
      return toState(mutation);
    });
  };

  const applyTurnFailure = (identity: RunIdentity, message: string, consentRetry: boolean) => {
    set((state) => {
      const matched = admittingRun(state, identity);
      if (!matched) return state;
      const mutation = beginMutation(state);
      const conversation = draftConversation(mutation, matched.conversationId)!;
      const run = conversation.runs[identity.runId];

      if (consentRetry) {
        // Keep the exact challenge and prompt row so the grant can be retried.
        conversation.runs[identity.runId] = { ...run, phase: 'needs-consent', error: message };
        appendError(conversation, identity.runId, message);
        markFailure(mutation, matched.conversationId);
        return toState(mutation);
      }

      conversation.runs[identity.runId] = { ...run, phase: 'failed', error: message };
      appendError(conversation, identity.runId, message);
      if (conversation.activeRunId === identity.runId) conversation.activeRunId = null;
      if (run.request && run.userEntryId) {
        conversation.lastFailedTurn = { draft: run.request, userEntryId: run.userEntryId };
      }
      markFailure(mutation, matched.conversationId);
      // Deliberately no queue dispatch: a rejected admission usually means the
      // next turn would be rejected too, and draining would burn the whole queue.
      return toState(mutation);
    });
  };

  const runTurn = async (
    identity: RunIdentity,
    draft: TurnDraft,
    challengeId: string | null
  ): Promise<void> => {
    const consentRetry = challengeId !== null;
    let admission: TurnAdmission;
    try {
      const result = await RunGolemTurn(toTurnRequest(identity, draft, challengeId ?? ''));
      admission = parseTurnAdmission(result);
      if (
        admission.identity.runId !== identity.runId ||
        admission.identity.repoEpoch !== identity.repoEpoch ||
        admission.identity.workspaceId !== identity.workspaceId ||
        admission.identity.conversationId !== identity.conversationId
      ) {
        throw new GolemContractError();
      }
    } catch (err) {
      if (err instanceof GolemContractError) {
        set({ bridgePhase: 'error', bridgeError: err.message });
      }
      applyTurnFailure(identity, boundedMessage(err), consentRetry);
      return;
    }
    applyAdmission(identity, admission);
  };

  const runDispatch = (dispatch: PendingDispatch | null) => {
    if (dispatch) void runTurn(dispatch.identity, dispatch.draft, null);
  };

  /**
   * The backend half of a cancellation, after the local `canceling` transition
   * has already been admitted. A rejection is not a refusal of the user's
   * intent — the run really was asked to stop — so it rolls the phase back and
   * reports through the transcript rather than through the caller's result.
   */
  const requestCancel = async (
    conversationId: string,
    runId: string,
    identity: RunIdentity,
    previousPhase: RunPhase
  ): Promise<void> => {
    try {
      // The run's own identity, never the current workspace's: a background
      // run from a retired epoch is cancelable only by its exact identity.
      await CancelGolemRun(toCancelRequest(identity));
    } catch (err) {
      set((current) => {
        const mutation = beginMutation(current);
        const draft = draftConversation(mutation, conversationId);
        if (!draft) return current;
        const latest = draft.runs[runId];
        if (!latest || latest.phase !== 'canceling') return current;
        // Cancel on a pending-consent turn is only rejected when the backend
        // no longer holds that challenge, so restoring `needs-consent` would
        // offer a grant that can never succeed. Every other rejection leaves
        // the run alive, so its previous phase is still the truth.
        if (draft.pendingConsentTurn?.identity.runId === runId) {
          releasePendingConsent(draft, boundedMessage(err));
        } else {
          draft.runs[runId] = { ...latest, phase: previousPhase };
          appendError(draft, runId, boundedMessage(err));
        }
        markFailure(mutation, conversationId);
        return toState(mutation);
      });
    }
  };

  /**
   * Applies a whole delivery — one animation frame's worth of streamed events —
   * in a single store mutation, so a frame costs one working copy instead of
   * one per event.
   */
  const ingestBatch = (values: unknown[]) => {
    const dispatches: PendingDispatch[] = [];
    set((current) => {
      const mutation = beginMutation(current);
      const context: DispatchContext = {
        hydratedIdentity: current.hydratedIdentity,
        bridgePhase: current.bridgePhase,
      };
      let changed = false;
      for (const value of values) {
        const reduced = reduceEvent(mutation, value, context);
        if (!reduced) continue;
        changed = true;
        if (reduced.dispatch) dispatches.push(reduced.dispatch);
      }
      return changed ? toState(mutation) : current;
    });
    for (const dispatch of dispatches) runDispatch(dispatch);
  };
  ingestGolemEventBatch = ingestBatch;

  /** Drops a pending consent turn whose challenge deadline has already passed. */
  const dropExpiredConsent = (conversationId: string): boolean => {
    const pending = get().conversations[conversationId]?.pendingConsentTurn;
    if (!pending || Date.now() <= pending.challenge.expiresAt) return false;
    set((state) => {
      const mutation = beginMutation(state);
      const conversation = draftConversation(mutation, conversationId);
      if (!conversation || !releasePendingConsent(conversation, CONSENT_EXPIRED_ERROR)) {
        return state;
      }
      markFailure(mutation, conversationId);
      return toState(mutation);
    });
    return true;
  };

  return {
    ...initialState(),

    hydrateStatus(status: GolemStatus) {
      // A status that never resolved a workspace carries the zero identity: it
      // is a binding failure, not a conversation. The epoch floor below is
      // deliberately not applied first — the zero identity carries epoch 0, so
      // ordering the floor ahead of this branch would suppress every binding
      // failure once any epoch had hydrated. Staleness here is the bridge's
      // job: `statusGenerationRef` drops a superseded status before it lands.
      if (status.identity.conversationId === '') {
        set({
          bridgePhase: 'error',
          bridgeError: boundedMessage(status.initError ?? GOLEM_UNAVAILABLE),
          hydratedIdentity: null,
        });
        return;
      }
      if (status.identity.repoEpoch < hydratedEpochFloor) return;
      hydratedEpochFloor = Math.max(hydratedEpochFloor, status.identity.repoEpoch);

      let reissued = false;
      set((state) => {
        const mutation = beginMutation(state);
        const conversationId = status.identity.conversationId;
        const known = mutation.conversations[conversationId];
        // A conversation that has never been hydrated is not "previously
        // healthy", so a cold-start degraded status still counts as new.
        const wasDegraded = known ? !known.available || known.initError !== null : false;
        if (!known) {
          mutation.conversations[conversationId] = newConversation(
            status.identity,
            status.workspaceLabel
          );
        }
        const conversation = draftConversation(mutation, conversationId)!;

        conversation.identity = status.identity;
        conversation.workspaceLabel = status.workspaceLabel;
        conversation.available = status.available;
        conversation.needsConsent = status.needsConsent;
        conversation.warnings = [...(status.warnings ?? [])];
        conversation.initError = status.initError ?? null;
        conversation.destination = status.destination ?? null;

        const degraded = !status.available || conversation.initError !== null;
        if (degraded && !wasDegraded) markFailure(mutation, conversationId);

        // Reopening the same repository re-arms turns staged while it was closed.
        conversation.queuedTurns = conversation.queuedTurns.map((turn) => {
          if (turn.state !== 'reopen-required') return turn;
          reissued = true;
          return { ...turn, state: 'queued' as const };
        });

        for (const active of status.activeRuns) {
          const runConversationId = active.identity.conversationId;
          if (!mutation.conversations[runConversationId]) {
            mutation.conversations[runConversationId] = newConversation(
              {
                repoEpoch: active.identity.repoEpoch,
                workspaceId: active.identity.workspaceId,
                conversationId: runConversationId,
              },
              active.workspaceLabel
            );
          }
          const target = draftConversation(mutation, runConversationId)!;
          if (!target.workspaceLabel) target.workspaceLabel = active.workspaceLabel;

          const terminal = unknownTerminals.get(active.identity.runId);
          if (
            terminal?.conversationId === runConversationId &&
            (!terminal.identity || sameRunIdentity(terminal.identity, active.identity))
          ) {
            target.runs[active.identity.runId] = {
              identity: active.identity,
              phase: terminal.phase,
              lastSeq: terminal.seq ?? -1,
              ...(terminal.message ? { error: terminal.message } : {}),
            };
            mutation.runToConversation[active.identity.runId] = runConversationId;
            if (terminal.raw) appendRawEvent(target, terminal.raw);
            if (terminal.message) {
              appendError(target, active.identity.runId, terminal.message, terminal.raw);
            }
            if (terminal.phase === 'failed') markFailure(mutation, runConversationId);
            unknownTerminals.delete(active.identity.runId);
            continue;
          }

          const known = target.runs[active.identity.runId];
          if (known && isTerminalPhase(known.phase)) continue; // tombstone
          target.runs[active.identity.runId] = {
            ...known,
            identity: active.identity,
            phase: active.state,
            lastSeq: known?.lastSeq ?? -1,
          };
          mutation.runToConversation[active.identity.runId] = runConversationId;
          if (target.activeRunId === null) target.activeRunId = active.identity.runId;
          // Adopting a run the backend reports as live is activity; re-listing
          // an unchanged one is not, or every status refresh would re-alert.
          if (!known || known.phase !== active.state) markActive(mutation, runConversationId);
        }
        unknownTerminals.clear();

        return {
          ...toState(mutation),
          hydratedIdentity: status.identity,
          bridgePhase: 'ready' as const,
          bridgeError: null,
          selectedConversationId: state.selectedConversationId ?? conversationId,
        };
      });

      if (!reissued) return;
      let dispatch: PendingDispatch | null = null;
      set((state) => {
        const mutation = beginMutation(state);
        dispatch = dispatchQueued(mutation, status.identity.conversationId, {
          hydratedIdentity: state.hydratedIdentity,
          bridgePhase: state.bridgePhase,
        });
        return toState(mutation);
      });
      runDispatch(dispatch);
    },

    invalidateBinding() {
      set((state) => {
        const mutation = beginMutation(state);
        for (const conversationId of Object.keys(mutation.conversations)) {
          const conversation = draftConversation(mutation, conversationId)!;
          const pending = conversation.pendingConsentTurn;
          if (pending) {
            // The backend drops unconsumed challenges for a retired binding, so
            // the prompt goes back on the shelf with its existing user row.
            conversation.queuedTurns.push({
              ...pending.draft,
              queueId: nextLocalId('queue'),
              state: 'reopen-required',
              userEntryId: pending.userEntryId,
            });
            conversation.pendingConsentTurn = null;
            const run = conversation.runs[pending.identity.runId];
            if (run && !isTerminalPhase(run.phase)) {
              conversation.runs[pending.identity.runId] = { ...run, phase: 'canceled' };
            }
            if (conversation.activeRunId === pending.identity.runId) {
              conversation.activeRunId = null;
            }
          }
          conversation.queuedTurns = conversation.queuedTurns.map((turn) =>
            turn.state === 'queued' ? { ...turn, state: 'reopen-required' as const } : turn
          );
        }
        return {
          ...toState(mutation),
          hydratedIdentity: null,
          bridgePhase: 'unbound' as const,
          bridgeError: null,
        };
      });
    },

    ingestEvent(value: unknown) {
      ingestBatch([value]);
    },

    ingestRunStatus(value: unknown) {
      const status = parseRunStatus(value);
      if (!status) return;

      const state = get();
      const mappedConversationId = state.runToConversation[status.identity.runId];
      const conversationId = mappedConversationId ?? status.identity.conversationId;
      const conversation = state.conversations[conversationId];
      const run = conversation?.runs[status.identity.runId];
      if (conversation && !sameConversationIdentity(conversation.identity, status.identity)) {
        return;
      }
      if (mappedConversationId && (!run || !sameRunIdentity(run.identity, status.identity))) {
        return;
      }
      if (!conversation) {
        if (!unknownTerminals.has(status.identity.runId)) {
          unknownTerminals.set(status.identity.runId, {
            conversationId: status.identity.conversationId,
            identity: status.identity,
            phase: status.state,
            message: status.message ? boundedMessage(status.message) : undefined,
          });
        }
        return;
      }

      let dispatch: PendingDispatch | null = null;
      set((current) => {
        const mutation = beginMutation(current);
        if (!draftConversation(mutation, conversationId)) return current;
        mutation.runToConversation[status.identity.runId] = conversationId;
        dispatch = finishRun(
          mutation,
          conversationId,
          status.identity.runId,
          status.state,
          { hydratedIdentity: current.hydratedIdentity, bridgePhase: current.bridgePhase },
          status.message ? boundedMessage(status.message) : undefined
        );
        return toState(mutation);
      });
      runDispatch(dispatch);
    },

    // Any known conversation is selectable, including one in a workspace the
    // IDE is not focused on: that is how a background run is reached.
    selectConversation(conversationId: string): GolemActionResult {
      if (!get().conversations[conversationId]) return refuse(NO_CONVERSATION_ERROR);
      set((state) => ({
        selectedConversationId: conversationId,
        composerFocusRevision: state.composerFocusRevision + 1,
      }));
      return OK;
    },

    clearConversation(conversationId: string): GolemActionResult {
      // Decided here rather than inferred from a before/after comparison: an
      // already-empty conversation resets to exactly itself, and the host's own
      // draft — which this store no longer holds — is reason enough to clear.
      const existing = get().conversations[conversationId];
      if (!existing) return refuse(NO_CONVERSATION_ERROR);
      if (existing.activeRunId !== null || existing.pendingConsentTurn !== null) {
        return refuse(BUSY_ERROR);
      }

      set((state) => {
        const conversation = state.conversations[conversationId];
        if (!conversation) return state;
        // Idle guard (the load-bearing safety rule): clearing while a run is
        // live would drop a conversation whose backend run is still emitting
        // events, and a GetGolemStatus snapshot could still list that live run
        // and re-hydrate it. When idle there is no live run — finished runs
        // never appear in backend ActiveRuns, and the backend emits exactly one
        // terminal per run — so a full reset cannot be repopulated by a stray
        // event. The button is disabled in this state too; the guard is defense
        // in depth.
        if (conversation.activeRunId !== null || conversation.pendingConsentTurn !== null) {
          return state;
        }

        const mutation = beginMutation(state);
        // Draft through the copy-on-write path so every subscriber sees a new
        // reference; writing the published object in place leaves the data
        // correct but the panel frozen.
        const draft = draftConversation(mutation, conversationId)!;

        // Reset content to the fresh shape; the backend-derived status fields
        // (identity, workspaceLabel, available, needsConsent, warnings,
        // initError, destination) reflect the workspace, not chat content, and
        // stay as they are.
        draft.rawEvents = [];
        draft.transcript = [];
        draft.runs = {};
        draft.activeRunId = null;
        draft.queuedTurns = [];
        draft.pendingConsentTurn = null;
        draft.lastFailedTurn = null;

        // Purge this conversation's run routing. No live run exists, so this is
        // safe, and it keeps the map from growing unbounded across clears.
        // Iterate a key snapshot; delete from the mutation's own copy.
        for (const runId of Object.keys(mutation.runToConversation)) {
          if (mutation.runToConversation[runId] === conversationId) {
            delete mutation.runToConversation[runId];
          }
        }

        // The failure that drove a StatusBar "Attention" is gone. Leave the
        // monotonic counters and lastActiveConversationId alone.
        if (mutation.lastFailureConversationId === conversationId) {
          mutation.lastFailureConversationId = null;
        }

        return {
          ...toState(mutation),
          composerFocusRevision: state.composerFocusRevision + 1,
        };
      });
      return OK;
    },

    requestComposerFocus() {
      set((state) => ({ composerFocusRevision: state.composerFocusRevision + 1 }));
    },

    // #271 B6. Deliberately dumb writes: the ordering rule ("install only a
    // newer stateRevision") belongs to the one relay that owns the lifetime,
    // not to a setter every caller could reach with a stale snapshot.
    setWindowState(windowState) {
      set({ windowState });
    },

    setHostFrozen(hostFrozen) {
      set({ hostFrozen });
    },

    setWindowError(windowError) {
      set({ windowError });
    },

    // One app-global tab: opening an already-open tab only re-focuses it.
    // Reach it through `focusConfigTab` in utils/editorSurface, never directly:
    // selecting this tab must also park the git store's editor focus, or a diff
    // or merge re-opened afterwards only re-raises an already-true flag and
    // lands invisibly behind this surface.
    openConfigTab() {
      set({ configTabOpen: true, configTabFocused: true });
    },

    closeConfigTab() {
      set({ configTabOpen: false, configTabFocused: false });
    },

    setConfigTabFocused(focused: boolean) {
      // A closed tab cannot hold editor focus; guarding here means no caller has
      // to order its close against a competing surface's focus grab.
      set((state) => ({ configTabFocused: focused && state.configTabOpen }));
    },

    // The composer text is supplied by whichever window the user is typing in
    // (#271): it is never stored here, so it can never be projected out of the
    // executing owner to the other window.
    submitTurn(conversationId: string, text: string): GolemActionResult {
      const refusal = sendRefusal(conversationId);
      if (refusal) return refuse(refusal);
      // An expired challenge must not keep the conversation busy: the new
      // message starts a fresh run, which collects a fresh challenge.
      dropExpiredConsent(conversationId);
      const conversation = get().conversations[conversationId];
      const message = text.trim();
      if (!message) return refuse(EMPTY_MESSAGE_ERROR);

      const busy = conversation.activeRunId !== null || conversation.pendingConsentTurn !== null;
      if (busy) {
        set((state) => {
          const mutation = beginMutation(state);
          const draft = draftConversation(mutation, conversationId)!;
          draft.queuedTurns.push({
            message,
            contextRefs: [],
            queueId: nextLocalId('queue'),
            state: 'queued',
          });
          return toState(mutation);
        });
        return OK;
      }

      // Refusal only, no transcript row: the reason carries the same text back
      // to the host that asked, which retains the draft and surfaces it once.
      // Appending a row as well would say it twice in the docked window.
      const runId = secureRandomUUID();
      if (!runId) return refuse(NO_SECURE_UUID_ERROR);

      const identity: RunIdentity = { ...conversation.identity, runId };
      const turnDraft: TurnDraft = { message, contextRefs: [] };
      set((state) => {
        const mutation = beginMutation(state);
        const draft = draftConversation(mutation, conversationId)!;
        const userEntryId = nextLocalId('user');
        draft.transcript.push({ id: userEntryId, runId, kind: 'user', text: message });
        draft.runs[runId] = {
          identity,
          phase: 'admitting',
          lastSeq: -1,
          request: turnDraft,
          userEntryId,
        };
        draft.activeRunId = runId;
        mutation.runToConversation[runId] = conversationId;
        return toState(mutation);
      });

      // The prompt is admitted and already visible in the transcript; how the
      // provider answers is the transcript's business, not this caller's.
      void runTurn(identity, turnDraft, null);
      return OK;
    },

    /**
     * The approval names the challenge the user was actually shown. A grant
     * dispatched from a window whose view has since moved on would otherwise
     * consent to whatever challenge is pending *now* — a different destination,
     * possibly a different prompt — so identity is checked before the phase.
     */
    allowAndSend(conversationId: string, runId: string, challengeId: string): GolemActionResult {
      const refusal = sendRefusal(conversationId);
      if (refusal) return refuse(refusal);
      // Identity first, and before the expiry sweep: an approval dispatched
      // from a stale view names a challenge that is not the current one, so it
      // is not entitled to release the current one either — expiring here
      // would let it clear a challenge the user in front of it never saw.
      const stale = get().conversations[conversationId].pendingConsentTurn;
      if (stale && (stale.identity.runId !== runId || stale.challenge.id !== challengeId)) {
        return refuse(CONSENT_MISMATCH_ERROR);
      }
      // The backend would reject the grant with "no pending consent challenge"
      // and leave nothing to clear it, so expire it here instead.
      if (dropExpiredConsent(conversationId)) return refuse(CONSENT_EXPIRED_ERROR);
      const conversation = get().conversations[conversationId];
      const pending = conversation.pendingConsentTurn;
      if (!pending) return refuse(NO_PENDING_CONSENT_ERROR);
      const run = conversation.runs[pending.identity.runId];
      if (!run || run.phase !== 'needs-consent') return refuse(BUSY_ERROR);

      set((state) => {
        const mutation = beginMutation(state);
        const draft = draftConversation(mutation, conversationId)!;
        const current = draft.runs[pending.identity.runId];
        draft.runs[pending.identity.runId] = { ...current, phase: 'admitting' };
        return toState(mutation);
      });

      void runTurn(pending.identity, pending.draft, pending.challenge.id);
      return OK;
    },

    retryLastFailed(conversationId: string): GolemActionResult {
      const refusal = sendRefusal(conversationId);
      if (refusal) return refuse(refusal);
      // Without this, an expired challenge makes Retry a silent dead button:
      // the busy check below would see `pendingConsentTurn` and return with no
      // feedback. Releasing it also makes its prompt the newest failure, so
      // Retry deliberately resends that rather than the older one — the
      // expiry notice is the last row in the transcript, and every other send
      // path already treats the released turn as `lastFailedTurn`.
      dropExpiredConsent(conversationId);
      const conversation = get().conversations[conversationId];
      const failed = conversation?.lastFailedTurn;
      if (!failed) return refuse(NOTHING_TO_RETRY_ERROR);
      if (conversation.activeRunId !== null || conversation.pendingConsentTurn !== null) {
        return refuse(BUSY_ERROR);
      }

      // As in `submitTurn`: one channel only, the refusal.
      const runId = secureRandomUUID();
      if (!runId) return refuse(NO_SECURE_UUID_ERROR);

      const identity: RunIdentity = { ...conversation.identity, runId };
      set((state) => {
        const mutation = beginMutation(state);
        const draft = draftConversation(mutation, conversationId)!;
        const index = draft.transcript.findIndex((entry) => entry.id === failed.userEntryId);
        if (index >= 0) draft.transcript[index] = { ...draft.transcript[index], runId };
        draft.runs[runId] = {
          identity,
          phase: 'admitting',
          lastSeq: -1,
          request: failed.draft,
          userEntryId: failed.userEntryId,
        };
        draft.activeRunId = runId;
        draft.lastFailedTurn = null;
        mutation.runToConversation[runId] = conversationId;
        return toState(mutation);
      });

      void runTurn(identity, failed.draft, null);
      return OK;
    },

    // A queue id the dispatcher already consumed is gone, not editable: the
    // existence check is what stops an edit typed a frame too late from
    // reporting success against a turn that is already running.
    updateQueuedTurn(conversationId: string, queueId: string, message: string): GolemActionResult {
      const conversation = get().conversations[conversationId];
      if (!conversation) return refuse(NO_CONVERSATION_ERROR);
      if (!conversation.queuedTurns.some((turn) => turn.queueId === queueId)) {
        return refuse(NO_QUEUED_TURN_ERROR);
      }
      set((state) => {
        const existing = state.conversations[conversationId];
        if (!existing) return state;
        const queuedTurns = existing.queuedTurns.map((turn) =>
          turn.queueId === queueId ? { ...turn, message } : turn
        );
        return {
          conversations: {
            ...state.conversations,
            [conversationId]: { ...existing, queuedTurns },
          },
        };
      });
      return OK;
    },

    removeQueuedTurn(conversationId: string, queueId: string): GolemActionResult {
      const conversation = get().conversations[conversationId];
      if (!conversation) return refuse(NO_CONVERSATION_ERROR);
      if (!conversation.queuedTurns.some((turn) => turn.queueId === queueId)) {
        return refuse(NO_QUEUED_TURN_ERROR);
      }
      set((state) => {
        const existing = state.conversations[conversationId];
        if (!existing) return state;
        return {
          conversations: {
            ...state.conversations,
            [conversationId]: {
              ...existing,
              queuedTurns: existing.queuedTurns.filter((turn) => turn.queueId !== queueId),
            },
          },
        };
      });
      return OK;
    },

    cancelRun(runId: string): GolemActionResult {
      const state = get();
      const conversationId = state.runToConversation[runId];
      if (!conversationId) return refuse(UNKNOWN_RUN_ERROR);
      const run = state.conversations[conversationId]?.runs[runId];
      if (
        !run ||
        isTerminalPhase(run.phase) ||
        run.phase === 'admitting' ||
        run.phase === 'canceling'
      )
        return refuse(NOT_CANCELABLE_ERROR);
      const previousPhase = run.phase;

      // Declining an already-expired challenge: the backend has dropped it, so
      // Cancel would be rejected and leave the turn stuck as pending.
      const pending = state.conversations[conversationId]?.pendingConsentTurn;
      if (pending?.identity.runId === runId && dropExpiredConsent(conversationId)) {
        return refuse(CONSENT_EXPIRED_ERROR);
      }

      set((current) => {
        const mutation = beginMutation(current);
        const draft = draftConversation(mutation, conversationId)!;
        draft.runs[runId] = { ...draft.runs[runId], phase: 'canceling' };
        markActive(mutation, conversationId);
        return toState(mutation);
      });

      // The local transition to `canceling` is what the caller is told about;
      // the backend's answer keeps its existing rollback below.
      void requestCancel(conversationId, runId, run.identity, previousPhase);
      return OK;
    },
  };
});

/** Ingests one animation frame's batch of streamed events in one mutation. */
export const ingestGolemEvents = (values: unknown[]): void => {
  ingestGolemEventBatch(values);
};

/** Test-only reset of both the store and its process-lifetime counters. */
export function __resetGolemStore(): void {
  hydratedEpochFloor = 0;
  localIdSeq = 0;
  unknownTerminals.clear();
  useGolemStore.setState(initialState(), false);
}
