import {
  boundedGolemMessage,
  GolemContractError,
  isRecord,
  readConsentChallenge,
  readConversationIdentity,
  readDestination,
  readRunIdentity,
  type ConversationIdentity,
  type ConversationView,
  type GolemStoreState,
  type PendingConsentTurn,
  type QueuedTurn,
  type RunPhase,
  type RunView,
  type TranscriptEntry,
} from './golem';

/**
 * #271 spec §5 — the two-window contract. Validators mirror types/golem.ts:
 * every value crossing the relay is `unknown` until a parser accepts it, and a
 * type assertion is never a substitute for one. The wire shapes here are the
 * exact JSON tags of `GolemWindowState`, `GolemWindowMessage`,
 * `GolemWindowEnvelope` and `GolemWindowBootstrap` in app_golem_window.go; Go
 * validates only the envelope, so every payload field is parsed on this side.
 */

export type GolemWindowMode = 'docked' | 'undocked';
export type GolemWindowPhase = 'closed' | 'bootstrapping' | 'bootstrapped' | 'ready' | 'closing';

export interface GolemWindowState {
  mode: GolemWindowMode;
  phase: GolemWindowPhase;
  instance: number;
  restorePending: boolean;
  stateRevision: number; // strictly increasing Go lifecycle revision
  handoff: number; // current transfer attempt, including repeated closes
  /**
   * Go's own text for the failure that produced this state — a deadline, a
   * relayed abort, a retirement that stalled after the close was authorized.
   * Absent on every successful transition (`omitempty` on the wire).
   */
  reason?: string;
}

/**
 * Whether "Retry connection" would change nothing at all in this state.
 *
 * Only a `closing` that names a reason is a stalled retirement, which a retry
 * can act on with a fresh close request. Any other `closing` is a transfer Go
 * still believes is running, and its re-dock branch refuses a second request
 * outright — so retrying there would clear the reason strip and do nothing,
 * leaving the user a frozen window with no explanation on screen. Go's own
 * deadline, or the abort already posted, is what ends that wait.
 *
 * `windowSatellite.retryGolemConnection` refuses on this, and
 * `GolemWindowRoot` disables the control on it, so the surfaced affordance and
 * the action behind it can never disagree.
 */
export function retryChangesNothing(state: GolemWindowState | null | undefined): boolean {
  return state?.phase === 'closing' && state.reason === undefined;
}

/** Kept equal to Go's golemWindowMaxPayload by the projection contract test. */
export const GOLEM_WINDOW_MAX_PAYLOAD_BYTES = 4 << 20;

export type GolemWindowKind =
  | 'view'
  | 'view-error'
  | 'drafts'
  | 'action'
  | 'ack'
  | 'ready'
  | 'abort';
export type GolemWindowRole = 'main' | 'satellite';

export interface GolemWindowMessage {
  kind: GolemWindowKind;
  instance: number;
  id: number;
  revision: number;
  handoff: number; // 0 for ordinary view/actions/acks; transfer attempt otherwise
  payload: unknown;
}

export interface GolemWindowEnvelope {
  from: GolemWindowRole;
  message: GolemWindowMessage;
}

export interface GolemWindowBootstrap {
  state: GolemWindowState;
  view: GolemView | null;
  revision: number;
  /** Retained failure when its live event preceded this window's subscription. */
  viewError?: GolemWindowMessage;
}

/** Explicit presentation types: no host drafts or owner-only run requests. */
export type ProjectedRun = Pick<RunView, 'identity' | 'phase' | 'lastSeq' | 'error'>;
export type ProjectedTranscript = Omit<TranscriptEntry, 'raw'>;
export type ProjectedConversation = Pick<
  ConversationView,
  | 'identity'
  | 'workspaceLabel'
  | 'available'
  | 'needsConsent'
  | 'warnings'
  | 'initError'
  | 'destination'
  | 'activeRunId'
  | 'queuedTurns'
> & {
  transcript: ProjectedTranscript[];
  runs: Record<string, ProjectedRun>;
  pendingConsentTurn: Pick<PendingConsentTurn, 'identity' | 'challenge'> | null;
  lastFailedTurn: boolean;
};

export interface GolemView {
  bridgePhase: GolemStoreState['bridgePhase'];
  bridgeError: string | null;
  hydratedIdentity: ConversationIdentity | null;
  selectedConversationId: string | null;
  conversations: Record<string, ProjectedConversation>;
  composerFocusRevision: number;
  processedThrough: number; // highest settled satellite action id in this snapshot
}

export type GolemDraftMap = Record<string, string>;

export type GolemViewAction =
  | { type: 'send'; conversationId: string; text: string }
  | { type: 'allowAndSend'; conversationId: string; runId: string; challengeId: string }
  | { type: 'cancelRun'; runId: string }
  | { type: 'retry'; conversationId: string }
  | { type: 'updateQueued'; conversationId: string; queueId: string; text: string }
  | { type: 'removeQueued'; conversationId: string; queueId: string }
  | { type: 'select'; conversationId: string }
  | { type: 'clear'; conversationId: string }
  | { type: 'openConfig' };

export interface GolemAck {
  id: number;
  ok: boolean;
  reason?: string;
}

const MODES: readonly GolemWindowMode[] = ['docked', 'undocked'];
const PHASES: readonly GolemWindowPhase[] = [
  'closed',
  'bootstrapping',
  'bootstrapped',
  'ready',
  'closing',
];
const KINDS: readonly GolemWindowKind[] = [
  'view',
  'view-error',
  'drafts',
  'action',
  'ack',
  'ready',
  'abort',
];
const ROLES: readonly GolemWindowRole[] = ['main', 'satellite'];
const BRIDGE_PHASES: readonly GolemStoreState['bridgePhase'][] = [
  'unbound',
  'binding',
  'ready',
  'error',
];
const RUN_PHASES: readonly RunPhase[] = [
  'admitting',
  'needs-consent',
  'running',
  'canceling',
  'done',
  'failed',
  'canceled',
];
const TRANSCRIPT_KINDS: readonly TranscriptEntry['kind'][] = ['user', 'assistant', 'tool', 'error'];
const ACTIVITIES: readonly NonNullable<TranscriptEntry['activity']>[] = [
  'running',
  'done',
  'failed',
  'interrupted',
];
const QUEUE_STATES: readonly QueuedTurn['state'][] = ['queued', 'reopen-required'];

const isString = (v: unknown): v is string => typeof v === 'string';
const isUint = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/**
 * A run's event sequence. `-1` is the store's initial/unknown sentinel — every
 * run carries it from admission until its first event lands, and a terminal
 * status with no sequence restores it — so the wire domain starts one below
 * zero. It is the only signed counter the projection carries: `repoEpoch` is a
 * Go `uint64`, and both revisions and the watermark only ever count up from 0.
 */
const isSeq = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= -1;
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => set.includes(v as T);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const fail = (): never => {
  throw new GolemContractError();
};

export function parseGolemViewError(value: unknown): string {
  if (!isRecord(value) || !isString(value.reason) || value.reason.trim() === '') return fail();
  return boundedGolemMessage(value.reason);
}

/** A nullable string field: present and either `string` or exactly `null`. */
const readNullableString = (v: unknown): string | null =>
  v === null ? null : isString(v) ? v : fail();

/**
 * An optional field the projection omits entirely when absent. `undefined`
 * means absent; `null` is a malformed value, not a missing one, because
 * `buildGolemView` never emits it and JSON never round-trips `undefined`.
 */
const readOptionalString = (v: unknown): string | undefined =>
  v === undefined ? undefined : isString(v) ? v : fail();

/** Identity counters must be whole, in range, and non-negative on the wire. */
function readIdentity(value: unknown): ConversationIdentity {
  const identity = readConversationIdentity(value);
  if (!identity || !isUint(identity.repoEpoch)) return fail();
  return identity;
}

export function parseGolemWindowState(value: unknown): GolemWindowState {
  if (!isRecord(value)) return fail();
  if (!oneOf(MODES, value.mode) || !oneOf(PHASES, value.phase) || !isUint(value.instance))
    return fail();
  if (typeof value.restorePending !== 'boolean' || !isUint(value.stateRevision)) return fail();
  if (!isUint(value.handoff)) return fail();
  const state: GolemWindowState = {
    mode: value.mode,
    phase: value.phase,
    instance: value.instance,
    restorePending: value.restorePending,
    stateRevision: value.stateRevision,
    handoff: value.handoff,
  };
  const reason = readOptionalString(value.reason);
  // Bounded like every other display message; blank means "no reason".
  if (reason !== undefined && reason.trim() !== '') state.reason = boundedGolemMessage(reason);
  return state;
}

export function parseGolemWindowEnvelope(value: unknown): GolemWindowEnvelope {
  if (!isRecord(value) || !oneOf(ROLES, value.from) || !isRecord(value.message)) return fail();
  const m = value.message;
  if (!oneOf(KINDS, m.kind) || !isUint(m.instance) || !isUint(m.id)) return fail();
  if (!isUint(m.revision) || !isUint(m.handoff)) return fail();
  return {
    from: value.from,
    message: {
      kind: m.kind,
      instance: m.instance,
      id: m.id,
      revision: m.revision,
      handoff: m.handoff,
      payload: m.payload,
    },
  };
}

function parseTranscriptEntry(value: unknown): ProjectedTranscript {
  if (!isRecord(value)) return fail();
  if (!isString(value.id) || value.id === '' || !isString(value.runId)) return fail();
  if (!oneOf(TRANSCRIPT_KINDS, value.kind) || !isString(value.text)) return fail();
  const entry: ProjectedTranscript = {
    id: value.id,
    runId: value.runId,
    kind: value.kind,
    text: value.text,
  };
  const toolCallId = readOptionalString(value.toolCallId);
  if (toolCallId !== undefined) entry.toolCallId = toolCallId;
  const toolName = readOptionalString(value.toolName);
  if (toolName !== undefined) entry.toolName = toolName;
  if (value.activity !== undefined) {
    if (!oneOf(ACTIVITIES, value.activity)) return fail();
    entry.activity = value.activity;
  }
  return entry;
}

function parseQueuedTurn(value: unknown): QueuedTurn {
  if (!isRecord(value)) return fail();
  if (!isString(value.message) || !isStringArray(value.contextRefs)) return fail();
  if (!isString(value.queueId) || value.queueId === '') return fail();
  if (!oneOf(QUEUE_STATES, value.state)) return fail();
  const turn: QueuedTurn = {
    message: value.message,
    contextRefs: [...value.contextRefs],
    queueId: value.queueId,
    state: value.state,
  };
  const userEntryId = readOptionalString(value.userEntryId);
  if (userEntryId !== undefined) turn.userEntryId = userEntryId;
  return turn;
}

function parseRun(runId: string, value: unknown): ProjectedRun {
  if (!isRecord(value)) return fail();
  const identity = readRunIdentity(value.identity);
  if (!identity || !isUint(identity.repoEpoch) || identity.runId !== runId) return fail();
  if (!oneOf(RUN_PHASES, value.phase) || !isSeq(value.lastSeq)) return fail();
  const run: ProjectedRun = { identity, phase: value.phase, lastSeq: value.lastSeq };
  const error = readOptionalString(value.error);
  if (error !== undefined) run.error = error;
  return run;
}

function parsePendingConsentTurn(
  value: unknown
): Pick<PendingConsentTurn, 'identity' | 'challenge'> | null {
  if (value === null) return null;
  if (!isRecord(value)) return fail();
  const identity = readRunIdentity(value.identity);
  const challenge = readConsentChallenge(value.challenge);
  if (!identity || !isUint(identity.repoEpoch) || !challenge) return fail();
  return { identity, challenge };
}

function parseConversation(conversationId: string, value: unknown): ProjectedConversation {
  if (!isRecord(value)) return fail();
  const identity = readIdentity(value.identity);
  if (identity.conversationId !== conversationId) return fail();
  if (!isString(value.workspaceLabel)) return fail();
  if (typeof value.available !== 'boolean' || typeof value.needsConsent !== 'boolean')
    return fail();
  if (!isStringArray(value.warnings)) return fail();
  if (typeof value.lastFailedTurn !== 'boolean') return fail();
  if (!Array.isArray(value.transcript) || !Array.isArray(value.queuedTurns)) return fail();
  if (!isRecord(value.runs)) return fail();

  const destination = value.destination === null ? null : readDestination(value.destination);
  if (destination === null && value.destination !== null) return fail();

  const runs: Record<string, ProjectedRun> = Object.create(null) as Record<string, ProjectedRun>;
  for (const [runId, run] of Object.entries(value.runs)) runs[runId] = parseRun(runId, run);

  return {
    identity,
    workspaceLabel: value.workspaceLabel,
    available: value.available,
    needsConsent: value.needsConsent,
    warnings: [...value.warnings],
    initError: readNullableString(value.initError),
    destination,
    activeRunId: readNullableString(value.activeRunId),
    queuedTurns: value.queuedTurns.map(parseQueuedTurn),
    transcript: value.transcript.map(parseTranscriptEntry),
    runs,
    pendingConsentTurn: parsePendingConsentTurn(value.pendingConsentTurn),
    lastFailedTurn: value.lastFailedTurn,
  };
}

export function parseGolemView(value: unknown): GolemView {
  if (!isRecord(value)) return fail();
  if (!oneOf(BRIDGE_PHASES, value.bridgePhase)) return fail();
  if (!isUint(value.composerFocusRevision) || !isUint(value.processedThrough)) return fail();
  if (!isRecord(value.conversations)) return fail();

  const conversations: Record<string, ProjectedConversation> = Object.create(null) as Record<
    string,
    ProjectedConversation
  >;
  for (const [id, conversation] of Object.entries(value.conversations))
    conversations[id] = parseConversation(id, conversation);

  return {
    bridgePhase: value.bridgePhase,
    bridgeError: readNullableString(value.bridgeError),
    hydratedIdentity: value.hydratedIdentity === null ? null : readIdentity(value.hydratedIdentity),
    selectedConversationId: readNullableString(value.selectedConversationId),
    conversations,
    composerFocusRevision: value.composerFocusRevision,
    processedThrough: value.processedThrough,
  };
}

export function parseGolemWindowBootstrap(value: unknown): GolemWindowBootstrap {
  if (!isRecord(value) || !isUint(value.revision)) return fail();
  const state = parseGolemWindowState(value.state);
  const view = value.view === null ? null : parseGolemView(value.view);
  // Revision zero means "main has never published"; any other revision must
  // carry the projection it names, and a projection must carry its revision.
  if ((view === null) !== (value.revision === 0)) return fail();
  const bootstrap: GolemWindowBootstrap = { state, view, revision: value.revision };
  if (value.viewError !== undefined) {
    const { message } = parseGolemWindowEnvelope({ from: 'main', message: value.viewError });
    if (
      message.kind !== 'view-error' ||
      message.instance !== state.instance ||
      message.id !== 0 ||
      message.handoff !== 0 ||
      message.revision <= value.revision
    )
      return fail();
    bootstrap.viewError = { ...message, payload: { reason: parseGolemViewError(message.payload) } };
  }
  return bootstrap;
}

export function parseGolemDraftMap(value: unknown): GolemDraftMap {
  if (!isRecord(value)) return fail();
  const out: GolemDraftMap = Object.create(null) as GolemDraftMap;
  for (const [id, text] of Object.entries(value)) {
    if (!isString(text)) return fail();
    out[id] = text;
  }
  return out;
}

export function parseGolemViewAction(value: unknown): GolemViewAction {
  if (!isRecord(value) || !isString(value.type)) return fail();
  const cid = value.conversationId;
  switch (value.type) {
    case 'send':
      return isString(cid) && isString(value.text)
        ? { type: 'send', conversationId: cid, text: value.text }
        : fail();
    case 'allowAndSend':
      return isString(cid) && isString(value.runId) && isString(value.challengeId)
        ? {
            type: 'allowAndSend',
            conversationId: cid,
            runId: value.runId,
            challengeId: value.challengeId,
          }
        : fail();
    case 'retry':
    case 'select':
    case 'clear':
      return isString(cid) ? { type: value.type, conversationId: cid } : fail();
    case 'cancelRun':
      return isString(value.runId) ? { type: 'cancelRun', runId: value.runId } : fail();
    case 'updateQueued':
      return isString(cid) && isString(value.queueId) && isString(value.text)
        ? { type: 'updateQueued', conversationId: cid, queueId: value.queueId, text: value.text }
        : fail();
    case 'removeQueued':
      return isString(cid) && isString(value.queueId)
        ? { type: 'removeQueued', conversationId: cid, queueId: value.queueId }
        : fail();
    case 'openConfig':
      return { type: 'openConfig' };
    default:
      return fail();
  }
}

export function parseGolemAck(value: unknown): GolemAck {
  if (!isRecord(value) || !isUint(value.id) || typeof value.ok !== 'boolean') return fail();
  if (value.reason !== undefined && !isString(value.reason)) return fail();
  return value.reason === undefined
    ? { id: value.id, ok: value.ok }
    : { id: value.id, ok: value.ok, reason: value.reason };
}
