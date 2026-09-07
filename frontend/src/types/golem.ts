/**
 * Golem chat contract for the frontend (#226 Task B7).
 *
 * Everything crossing the Wails boundary arrives as `unknown`: the generated
 * `ai.*` classes are constructed from `any` and never validate, so they are
 * INPUTS to the validators below rather than trusted UI state. Nothing here
 * casts an untrusted value into a declared type.
 *
 * `ai.RelayedEvent` and `ai.RunStatusEvent` are deliberately absent from the
 * generated models — no bound method returns them, so Wails never emits their
 * TypeScript shapes. `GolemEvent` and `GolemRunStatusEvent` are hand-written
 * mirrors of `internal/ai.RelayedEvent` / `internal/ai.RunStatusEvent`.
 */

import { ai } from '../wails/bindings';
import { GOLEM_UNAVAILABLE } from '../golem/projection';
// Type-only, so the cycle with `types/golemWindow.ts` (which imports this
// module's validators at runtime) is erased rather than made circular.
import type { GolemWindowState } from './golemWindow';

export interface ConversationIdentity {
  repoEpoch: number;
  workspaceId: string;
  conversationId: string;
}

export interface RunIdentity extends ConversationIdentity {
  runId: string;
}

export interface ProviderDestination {
  provider: string;
  model: string;
  endpoint: string;
  classification: 'local' | 'remote';
  digest: string;
}

export interface GolemEvent {
  protocol: 1;
  threadId: string;
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  raw: string;
}

export interface GolemRunStatusEvent {
  identity: RunIdentity;
  state: 'failed' | 'canceled';
  message?: string;
}

export interface ConsentChallenge {
  id: string;
  identity: RunIdentity;
  destination: ProviderDestination;
  destinationDigest: string;
  expiresAt: number;
}

export interface ContextReceipt {
  included: number;
  bytes: number;
  excluded: number;
}

export interface TurnAdmissionBase {
  identity: RunIdentity;
  destination: ProviderDestination;
  context: ContextReceipt;
}

export type TurnAdmission =
  | (TurnAdmissionBase & { state: 'accepted'; consentChallenge?: never })
  | (TurnAdmissionBase & {
      state: 'needs_consent';
      consentChallenge: ConsentChallenge;
    });

export interface ActiveRunStatus {
  identity: RunIdentity;
  workspaceLabel: string;
  state: 'running' | 'canceling';
}

export interface GolemStatus {
  available: boolean;
  workspaceLabel: string;
  identity: ConversationIdentity;
  destination?: ProviderDestination;
  needsConsent: boolean;
  consentChallenge?: ConsentChallenge;
  activeRuns: ActiveRunStatus[];
  warnings?: string[];
  initError?: string;
}

export type RunPhase =
  | 'admitting'
  | 'needs-consent'
  | 'running'
  | 'canceling'
  | 'done'
  | 'failed'
  | 'canceled';

export interface TranscriptEntry {
  id: string;
  runId: string;
  kind: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  toolCallId?: string;
  toolName?: string;
  activity?: 'running' | 'done' | 'failed' | 'interrupted';
  raw?: GolemEvent;
}

export interface TurnDraft {
  message: string;
  contextRefs: string[];
}

export interface RunView {
  identity: RunIdentity;
  phase: RunPhase;
  lastSeq: number;
  unanswered?: boolean; // finished without assistant text, independent of Retry eligibility
  request?: TurnDraft; // absent when reconstructed only from backend Status
  userEntryId?: string;
  error?: string;
}

export interface QueuedTurn extends TurnDraft {
  queueId: string;
  state: 'queued' | 'reopen-required';
  userEntryId?: string; // retained only when a consented prompt was already projected
}

export interface PendingConsentTurn {
  draft: TurnDraft;
  identity: RunIdentity;
  challenge: ConsentChallenge;
  userEntryId: string;
}

export interface RetryTurn {
  draft: TurnDraft;
  userEntryId: string;
}

export interface ConversationView {
  identity: ConversationIdentity;
  workspaceLabel: string;
  available: boolean;
  needsConsent: boolean;
  warnings: string[];
  initError: string | null;
  destination: ProviderDestination | null;
  rawEvents: GolemEvent[];
  transcript: TranscriptEntry[];
  runs: Record<string, RunView>;
  activeRunId: string | null;
  queuedTurns: QueuedTurn[];
  pendingConsentTurn: PendingConsentTurn | null;
  lastFailedTurn: RetryTurn | null;
}

export interface GolemStoreState {
  conversations: Record<string, ConversationView>;
  runToConversation: Record<string, string>;
  selectedConversationId: string | null;
  hydratedIdentity: ConversationIdentity | null;
  bridgePhase: 'unbound' | 'binding' | 'ready' | 'error';
  bridgeError: string | null;
  lastActiveConversationId: string | null;
  activityRevision: number;
  lastFailureConversationId: string | null;
  failureRevision: number;
  /**
   * The one app-global configuration tab (#263 spec §3.1). Only its open/focus
   * flags live here: the draft and any pending API-key value stay inside the
   * mounted workspace root, so no key value can ever reach a store. Both
   * initialize to false, and focus is meaningless while the tab is closed.
   */
  configTabOpen: boolean;
  configTabFocused: boolean;
  openConfigTab(): void;
  closeConfigTab(): void;
  setConfigTabFocused(focused: boolean): void;
  composerFocusRevision: number;
  /** Arms the composer of the visible Golem host (replaces setPanelMode's bump). */
  requestComposerFocus(): void;
  /**
   * The undocked-window lifecycle (#271 spec §5), as Go last published it.
   *
   * These three are app-scoped: a repository unbind, rebind or status
   * hydration must leave them exactly as they were, because the satellite
   * window outlives every one of those. Only `golem/windowRelay.ts` writes
   * them, and only from an authoritative Go snapshot.
   */
  windowState: GolemWindowState;
  /**
   * The docked host's interaction barrier. True from the moment an undock is
   * requested until the authoritative transition settles it, so the text a
   * user is typing can never be edited while ownership is uncertain.
   * Deliberately not derived from `windowState.phase` alone: the barrier goes
   * up synchronously, before Go has said anything.
   */
  hostFrozen: boolean;
  /**
   * The last window failure the user has not been shown past, or null.
   * Distinct from `bridgeError`: a window that would not open must not make a
   * working docked AI look broken.
   */
  windowError: string | null;
  setWindowState(state: GolemWindowState): void;
  setHostFrozen(frozen: boolean): void;
  setWindowError(error: string | null): void;
  hydrateStatus(status: GolemStatus): void;
  invalidateBinding(): void;
  ingestEvent(value: unknown): void;
  ingestRunStatus(value: unknown): void;
  /**
   * Local admission (#271 spec §5.2). Each of these answers for the state
   * transition it just made or refused, synchronously, before the provider has
   * said anything: the visible host needs a definitive yes/no *now* to decide
   * whether to drop the text the user typed. Provider completion and failure
   * keep landing through the transcript, `lastFailedTurn` and the run phases,
   * exactly as before — a rejected provider promise is not a refusal, because
   * admission already took ownership of that prompt.
   */
  selectConversation(conversationId: string): GolemActionResult;
  clearConversation(conversationId: string): GolemActionResult;
  submitTurn(conversationId: string, text: string): GolemActionResult;
  allowAndSend(conversationId: string, runId: string, challengeId: string): GolemActionResult;
  retryLastFailed(conversationId: string): GolemActionResult;
  updateQueuedTurn(conversationId: string, queueId: string, message: string): GolemActionResult;
  removeQueuedTurn(conversationId: string, queueId: string): GolemActionResult;
  cancelRun(runId: string): GolemActionResult;
}

/**
 * The outcome of admitting one user intent against the executing owner
 * (#271 spec §5.2). `ok: false` is a *definitive* refusal the host may act
 * on — it never encodes "not yet known": an uncertain relay timeout keeps the
 * action pending instead. `reason` is already bounded by the producer.
 */
export interface GolemActionResult {
  ok: boolean;
  reason?: string;
}

// ── Wails inputs ──────────────────────────────────────────────────────────────
// v3 constructors Object.assign their entire source object rather than
// copying field by field, so passing a caller-supplied object straight
// through (spread, or a variable handed to the constructor whole) ships
// anything extra it carries -- a QueuedTurn's `queueId`/`state` riding along
// on a TurnDraft, for example. Every builder below is enumerated field by
// field from the declared shape of its input type, so nothing beyond those
// fields ever reaches the wire. TypeScript types are not a runtime guard for
// this: excess-property checks only fire on object literals passed inline,
// never on a caller's variable, which is exactly how a QueuedTurn reaches
// toTurnRequest. The Go side is not a backstop either -- ai.TurnRequest,
// ai.StatusRequest, and ai.RunIdentity decode with plain json.Unmarshal, with
// none of settings_apply.go/consent.go's strictUnmarshal rejecting unknown
// fields. This file is the only enforcement point on the request side of the
// boundary.

export const toStatusRequest = (identity: ConversationIdentity) =>
  new ai.StatusRequest({
    repoEpoch: identity.repoEpoch,
    workspaceId: identity.workspaceId,
  });

export const toTurnRequest = (identity: RunIdentity, draft: TurnDraft, consentChallengeId = '') =>
  new ai.TurnRequest({
    identity: new ai.RunIdentity({
      repoEpoch: identity.repoEpoch,
      workspaceId: identity.workspaceId,
      conversationId: identity.conversationId,
      runId: identity.runId,
    }),
    message: draft.message,
    contextRefs: draft.contextRefs,
    consentChallengeId,
  });

export const toCancelRequest = (identity: RunIdentity) =>
  new ai.RunIdentity({
    repoEpoch: identity.repoEpoch,
    workspaceId: identity.workspaceId,
    conversationId: identity.conversationId,
    runId: identity.runId,
  });

// ── Boundary validators ───────────────────────────────────────────────────────

/**
 * The single error the request/response boundary raises. The message is fixed
 * so a malformed payload — which may embed provider or filesystem text — can
 * never reach the UI through the error path.
 */
export class GolemContractError extends Error {
  constructor() {
    super('Golem returned an unexpected response.');
    this.name = 'GolemContractError';
  }
}

export const contractError = (): never => {
  throw new GolemContractError();
};

const MAX_ERROR_CHARS = 200;

/**
 * Shown whenever a failure carries no usable message of its own. Defined in
 * `golem/projection` — the bindings-free half — because the satellite's chat
 * surface needs it and must never reach this module; re-exported here so the
 * store and the validators keep their single import surface.
 */
export { GOLEM_UNAVAILABLE };

/**
 * Clamps any rejection value to a short, displayable string. The backend
 * already sanitizes its own errors; this only bounds length and shape so a
 * hostile or oversized rejection cannot become the UI.
 */
export function boundedGolemMessage(value: unknown): string {
  const raw = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
  const text = raw.trim() || GOLEM_UNAVAILABLE;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Absent means absent: `undefined` and `null` are the same missing optional. */
const isAbsent = (value: unknown): boolean => value === undefined || value === null;

export function readConversationIdentity(value: unknown): ConversationIdentity | null {
  if (!isRecord(value)) return null;
  if (!isNumber(value.repoEpoch) || !isString(value.workspaceId) || !isString(value.conversationId))
    return null;
  return {
    repoEpoch: value.repoEpoch,
    workspaceId: value.workspaceId,
    conversationId: value.conversationId,
  };
}

export function readRunIdentity(value: unknown): RunIdentity | null {
  const base = readConversationIdentity(value);
  if (!base || !isRecord(value)) return null;
  if (!isString(value.runId) || value.runId === '') return null;
  return { ...base, runId: value.runId };
}

export function readDestination(value: unknown): ProviderDestination | null {
  if (!isRecord(value)) return null;
  const { provider, model, endpoint, classification, digest } = value;
  if (!isString(provider) || !isString(model) || !isString(endpoint) || !isString(digest))
    return null;
  if (classification !== 'local' && classification !== 'remote') return null;
  return { provider, model, endpoint, classification, digest };
}

function readContextReceipt(value: unknown): ContextReceipt | null {
  if (!isRecord(value)) return null;
  if (!isNumber(value.included) || !isNumber(value.bytes) || !isNumber(value.excluded)) return null;
  return { included: value.included, bytes: value.bytes, excluded: value.excluded };
}

export function readConsentChallenge(value: unknown): ConsentChallenge | null {
  if (!isRecord(value)) return null;
  if (!isString(value.id) || value.id === '') return null;
  if (!isString(value.destinationDigest) || !isNumber(value.expiresAt)) return null;
  const challengeIdentity = readRunIdentity(value.identity);
  const destination = readDestination(value.destination);
  if (!challengeIdentity || !destination) return null;
  return {
    id: value.id,
    identity: challengeIdentity,
    destination,
    destinationDigest: value.destinationDigest,
    expiresAt: value.expiresAt,
  };
}

function readActiveRun(value: unknown): ActiveRunStatus | null {
  if (!isRecord(value)) return null;
  const activeIdentity = readRunIdentity(value.identity);
  if (!activeIdentity || !isString(value.workspaceLabel)) return null;
  if (value.state !== 'running' && value.state !== 'canceling') return null;
  return { identity: activeIdentity, workspaceLabel: value.workspaceLabel, state: value.state };
}

const sameRunIdentity = (a: RunIdentity, b: RunIdentity): boolean =>
  a.repoEpoch === b.repoEpoch &&
  a.workspaceId === b.workspaceId &&
  a.conversationId === b.conversationId &&
  a.runId === b.runId;

const sameDestination = (a: ProviderDestination, b: ProviderDestination): boolean =>
  a.provider === b.provider &&
  a.model === b.model &&
  a.endpoint === b.endpoint &&
  a.classification === b.classification &&
  a.digest === b.digest;

export function parseGolemStatus(value: unknown): GolemStatus {
  if (!isRecord(value)) return contractError();
  if (typeof value.available !== 'boolean' || typeof value.needsConsent !== 'boolean')
    return contractError();
  if (!isString(value.workspaceLabel)) return contractError();

  const statusIdentity = readConversationIdentity(value.identity);
  if (!statusIdentity) return contractError();

  if (!Array.isArray(value.activeRuns)) return contractError();
  const activeRuns: ActiveRunStatus[] = [];
  for (const entry of value.activeRuns) {
    const run = readActiveRun(entry);
    if (!run) return contractError();
    activeRuns.push(run);
  }

  const status: GolemStatus = {
    available: value.available,
    workspaceLabel: value.workspaceLabel,
    identity: statusIdentity,
    needsConsent: value.needsConsent,
    activeRuns,
  };

  if (!isAbsent(value.destination)) {
    const destination = readDestination(value.destination);
    if (!destination) return contractError();
    status.destination = destination;
  }
  if (!isAbsent(value.consentChallenge)) {
    const challenge = readConsentChallenge(value.consentChallenge);
    if (!challenge) return contractError();
    status.consentChallenge = challenge;
  }
  if (!isAbsent(value.warnings)) {
    if (!Array.isArray(value.warnings) || !value.warnings.every(isString)) return contractError();
    status.warnings = [...value.warnings];
  }
  if (!isAbsent(value.initError)) {
    if (!isString(value.initError)) return contractError();
    status.initError = value.initError;
  }
  return status;
}

export function parseTurnAdmission(value: unknown): TurnAdmission {
  if (!isRecord(value)) return contractError();
  const admissionIdentity = readRunIdentity(value.identity);
  const destination = readDestination(value.destination);
  const context = readContextReceipt(value.context);
  if (!admissionIdentity || !destination || !context) return contractError();

  if (value.state === 'accepted') {
    // An accepted admission that still carries a challenge is a contract break,
    // not a challenge to honour.
    if (!isAbsent(value.consentChallenge)) return contractError();
    return { state: 'accepted', identity: admissionIdentity, destination, context };
  }

  if (value.state !== 'needs_consent') return contractError();
  const challenge = readConsentChallenge(value.consentChallenge);
  if (!challenge) return contractError();
  if (!sameRunIdentity(challenge.identity, admissionIdentity)) return contractError();
  if (!sameDestination(challenge.destination, destination)) return contractError();
  if (challenge.destinationDigest !== destination.digest) return contractError();

  return {
    state: 'needs_consent',
    identity: admissionIdentity,
    destination,
    context,
    consentChallenge: challenge,
  };
}

/** Streamed events are advisory: a malformed one is dropped, never surfaced. */
export function parseGolemEvent(value: unknown): GolemEvent | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== 1) return null;
  if (!isString(value.threadId) || value.threadId === '') return null;
  if (!isString(value.runId) || value.runId === '') return null;
  if (!isNumber(value.seq) || value.seq < 0) return null;
  if (!isString(value.type) || value.type === '') return null;
  if (!isString(value.raw)) return null;
  return {
    protocol: 1,
    threadId: value.threadId,
    runId: value.runId,
    seq: value.seq,
    type: value.type,
    payload: value.payload,
    raw: value.raw,
  };
}

export function parseRunStatus(value: unknown): GolemRunStatusEvent | null {
  if (!isRecord(value)) return null;
  const statusIdentity = readRunIdentity(value.identity);
  if (!statusIdentity) return null;
  if (value.state !== 'failed' && value.state !== 'canceled') return null;
  if (!isAbsent(value.message) && !isString(value.message)) return null;
  const event: GolemRunStatusEvent = { identity: statusIdentity, state: value.state };
  if (isString(value.message)) event.message = value.message;
  return event;
}

// ── Settings projection (#263 Phase 1) ───────────────────────────────────────
// Read-only. EVERY enum below is a CLOSED set — including capability names and
// diagnostic codes — and unknown KEYS are contract breaks too: every reader
// rejects them (hasOnlyKeys), mirroring the Go corpus harness's
// DisallowUnknownFields, so the validators are strict in both directions.
// That is deliberate: the producer and this validator ship from the same repo
// in lockstep, so an unknown key or value is contract drift, not forward
// compatibility. Phase 2 grows the sets on both sides of the boundary in the
// same change. Limits mirror internal/ai/settings.go and are exercised by the
// shared corpus in internal/ai/testdata/settings_contract/.

export type SettingsState = 'missing' | 'invalid' | 'limited' | 'ready';
export type SettingsSourceOrigin = 'none' | 'env' | 'working_directory' | 'user_config' | 'legacy';
export type ProviderClassification = 'local' | 'remote' | 'unknown';
export type CredentialState = 'none' | 'available' | 'reference_unavailable';
export type DiagnosticSubjectKind = '' | 'role' | 'model' | 'provider' | 'use_case';
export type SettingsDiagnosticCode =
  | 'config_missing'
  | 'json_invalid'
  | 'config_invalid'
  | 'agent_role_missing'
  | 'agent_capabilities_insufficient'
  | 'provider_endpoint_unsupported'
  | 'projection_limited'
  | 'duplicate_keys'
  | 'provider_required'
  | 'provider_name_invalid'
  | 'provider_endpoint_invalid'
  | 'provider_format_invalid'
  | 'slot_policy_invalid'
  | 'model_invalid'
  | 'think_invalid'
  | 'provider_not_found'
  | 'defaults_invalid'
  | 'key_reference_malformed'
  | 'key_reference_unavailable'
  | 'selector_conflict'
  | 'identifier_not_editable'
  // Write/action codes: produced by the apply pipeline, never by a load.
  | 'invalid_argument'
  | 'role_not_found'
  | 'provider_exists'
  | 'provider_in_use'
  | 'eligibility_ineligible'
  | 'eligibility_unknown'
  | 'key_value_invalid'
  | 'profile_source_unavailable'
  | 'consent_store_failed'
  | 'config_save_failed';
export type CapabilityName =
  | 'chat'
  | 'generate'
  | 'stream'
  | 'embed'
  | 'tool_call'
  | 'thinking'
  | 'insert';

export type ModelType = 'dense' | 'moe' | 'embedding';
export type ThinkMode = '' | 'none' | 'always' | 'toggle' | 'auto';
export type APIFormat = 'ollama' | 'openai-compat';

export interface RouteProjection {
  useCase: string;
  role: string;
}

export interface CapabilityFacts {
  caps: CapabilityName[];
  knownCaps: CapabilityName[];
}

export interface ModelProjection {
  role: string;
  modelName: string;
  provider: string;
  type: ModelType;
  parameters?: string;
  contextWindow?: number;
  dimensions?: number;
  effectiveCapabilities: CapabilityName[];
  capabilityFacts: CapabilityFacts;
  exposedCapabilities: CapabilityName[];
  thinkMode: ThinkMode;
  routedUseCases: string[];
  /** Existence facts only — a retarget drops these, the values never cross. */
  hasThinkTags: boolean;
  hasSlots: boolean;
  removable: boolean;
}

export interface ProviderProjection {
  name: string;
  endpoint: string;
  classification: ProviderClassification;
  apiFormat: APIFormat;
  credentialState: CredentialState;
}

export interface SettingsDiagnostic {
  code: SettingsDiagnosticCode;
  subjectKind: DiagnosticSubjectKind;
  subjectName: string;
  blocking: boolean;
}

export interface SettingsProjection {
  state: SettingsState;
  sourceOrigin: SettingsSourceOrigin;
  revision?: string;
  readOnly: boolean;
  editable: boolean;
  routes: RouteProjection[];
  models: ModelProjection[];
  providers: ProviderProjection[];
  diagnostics: SettingsDiagnostic[];
}

export interface SettingsReloadResult {
  busy: boolean;
  projection: SettingsProjection;
}

// The primitives below are exported for golemConfig.ts, the sibling validator
// that owns the WRITE transport. They stay internal to the frontend contract
// layer: one definition of each bound, rune class, and ordering rule, shared
// by both validators so the read and write sides cannot drift apart.
export const MAX_PROJECTION_ENTRIES = 256;
// All string limits are UTF-8 BYTE counts, matching internal/ai/settings.go
// (Go len()). Measured here with TextEncoder — never String.length, whose
// UTF-16 code units disagree with Go on non-ASCII input.
const MAX_IDENTIFIER_BYTES = 256;
export const MAX_ENDPOINT_BYTES = 1024;
// Worst case the backend can emit: one endpoint diagnostic per provider plus
// one agent diagnostic (see internal/ai/settings.go maxProjectionDiagnostics).
export const MAX_DIAGNOSTICS = MAX_PROJECTION_ENTRIES + 1;

const utf8Encoder = new TextEncoder();
export const utf8Length = (value: string): number => utf8Encoder.encode(value).length;

const SETTINGS_STATES: readonly SettingsState[] = ['missing', 'invalid', 'limited', 'ready'];
const SOURCE_ORIGINS: readonly SettingsSourceOrigin[] = [
  'none',
  'env',
  'working_directory',
  'user_config',
  'legacy',
];
const CLASSIFICATIONS: readonly ProviderClassification[] = ['local', 'remote', 'unknown'];
const CREDENTIAL_STATES: readonly CredentialState[] = [
  'none',
  'available',
  'reference_unavailable',
];
const SUBJECT_KINDS: readonly DiagnosticSubjectKind[] = [
  '',
  'role',
  'model',
  'provider',
  'use_case',
];
const DIAGNOSTIC_CODES: readonly SettingsDiagnosticCode[] = [
  'config_missing',
  'json_invalid',
  'config_invalid',
  'agent_role_missing',
  'agent_capabilities_insufficient',
  'provider_endpoint_unsupported',
  'projection_limited',
  'duplicate_keys',
  'provider_required',
  'provider_name_invalid',
  'provider_endpoint_invalid',
  'provider_format_invalid',
  'slot_policy_invalid',
  'model_invalid',
  'think_invalid',
  'provider_not_found',
  'defaults_invalid',
  'key_reference_malformed',
  'key_reference_unavailable',
  'selector_conflict',
  'identifier_not_editable',
  'invalid_argument',
  'role_not_found',
  'provider_exists',
  'provider_in_use',
  'eligibility_ineligible',
  'eligibility_unknown',
  'key_value_invalid',
  'profile_source_unavailable',
  'consent_store_failed',
  'config_save_failed',
];
export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'chat',
  'generate',
  'stream',
  'embed',
  'tool_call',
  'thinking',
  'insert',
];

export const isBoundedString = (value: unknown, maxBytes: number): value is string =>
  isString(value) && utf8Length(value) <= maxBytes;

// Presence in the settings/apply contract documents means "own key holding a
// DEFINED value", and both helpers below apply that rule -- deliberately not
// the policy isAbsent states higher in this file for the run/status documents
// (`undefined` and `null` alike missing): there a null optional is nothing,
// here a null is a real value the strict-both-ways mirror must still see.
//
// Wails v3 hands every binding result back as a generated class instance --
// every result EXCEPT the nine Golem calls src/wails/bindings.ts reads raw
// through the runtime's Call.ByID, which is how the documents these validators
// govern reach them today. tsconfig sets useDefineForClassFields, so on a
// generated instance each declared optional member ("revision"?: string)
// becomes an own property valued `undefined` -- whether or not the wire carried
// it. JSON cannot represent `undefined`, so an own key valued `undefined` can
// only come from the class shape and never from the producer; ignoring those
// keys restores the exact wire semantics the v2 plain objects had. The rule is
// retained rather than dropped with the raw routing: it keeps the helpers
// correct for any generated instance that ever reaches them, and it is a no-op
// on the raw wire path precisely because JSON cannot carry `undefined`.
//
// Strictness is untouched: a key carrying any real value -- null included --
// still counts as present, so hasOnlyKeys still rejects genuine unknown keys,
// a strict-both-ways mirror of the Go corpus harness's DisallowUnknownFields
// (see the section comment).
export const hasPresentKey = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key) && value[key] !== undefined;

export const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => value[key] === undefined || allowed.includes(key));

export const MODEL_TYPES: readonly ModelType[] = ['dense', 'moe', 'embedding'];
export const THINK_MODES: readonly ThinkMode[] = ['', 'none', 'always', 'toggle', 'auto'];
export const API_FORMATS: readonly APIFormat[] = ['ollama', 'openai-compat'];
export const REVISION = /^[0-9a-f]{64}$/;
const MAX_MODEL_NUMBER = 2147483647;
// Identifier spoofing guard: every Unicode Cc (control) and Cf (format) rune
// -- including bidi overrides/isolates and zero-widths that can reorder or
// hide characters. Unicode property escapes close the full Cc/Cf category
// that an explicit enumerated range table cannot express; this MUST stay
// identical to contractIdentifier's rune check in internal/ai/settings_test.go,
// or a corpus fixture with an exotic Cf rune could split verdicts between the
// two oracles. The Go builder scrubs the same categories to U+FFFD, which is
// safe: producer stricter than contract.
const FORBIDDEN_IDENTIFIER_RUNES = /[\p{Cc}\p{Cf}]/u;

// A canonical endpoint is always plain ASCII: NormalizeEndpoint rejects a
// non-ASCII host outright (Cyrillic/fullwidth/ideographic-dot homoglyphs
// included -- a confusable host could spoof a trusted domain, and a
// non-ASCII host is never resolvable as-is; internationalized hosts must be
// supplied as their punycode form) and percent-escapes any non-ASCII byte in
// the path. This is defense-in-depth on the reader's side of a boundary the
// producer already closes.
export const NON_ASCII_RUNE = /[^\x20-\x7E]/;

export const isCleanIdentifier = (value: unknown, maxBytes: number): value is string =>
  isBoundedString(value, maxBytes) && !FORBIDDEN_IDENTIFIER_RUNES.test(value);

export const isIdentifier = (value: unknown): value is string =>
  isCleanIdentifier(value, MAX_IDENTIFIER_BYTES) && value !== '';

export const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  isString(value) && (allowed as readonly string[]).includes(value);

// compareString orders by emitted UTF-8 byte value, matching Go's `<` on
// strings -- never String.length/localeCompare, whose UTF-16 code-unit order
// disagrees with Go on non-BMP characters (see accept-utf8-order-nonbmp.json).
export const compareString = (a: string, b: string): number => {
  const left = utf8Encoder.encode(a);
  const right = utf8Encoder.encode(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
};

export function isStrictlyOrdered<T>(
  values: readonly T[],
  compare: (a: T, b: T) => number
): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (compare(values[i - 1], values[i]) >= 0) return false;
  }
  return true;
}

export function isCanonicalCapabilities(values: readonly CapabilityName[]): boolean {
  let previous = -1;
  for (const value of values) {
    const index = CAPABILITY_NAMES.indexOf(value);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}

export const isOptionalModelNumber = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_MODEL_NUMBER;

export function readCappedArray<T>(
  value: unknown,
  max: number,
  read: (entry: unknown) => T | null
): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

function readRoute(value: unknown): RouteProjection | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ['useCase', 'role'])) return null;
  if (!isIdentifier(value.useCase)) return null;
  if (!isIdentifier(value.role)) return null;
  return { useCase: value.useCase, role: value.role };
}

function readCapabilityFacts(value: unknown): CapabilityFacts | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['caps', 'knownCaps'])) return null;
  const caps = readCappedArray(value.caps, CAPABILITY_NAMES.length, (cap) =>
    isOneOf(cap, CAPABILITY_NAMES) ? cap : null
  );
  const knownCaps = readCappedArray(value.knownCaps, CAPABILITY_NAMES.length, (cap) =>
    isOneOf(cap, CAPABILITY_NAMES) ? cap : null
  );
  if (
    caps === null ||
    knownCaps === null ||
    !isCanonicalCapabilities(caps) ||
    !isCanonicalCapabilities(knownCaps) ||
    knownCaps.length !== CAPABILITY_NAMES.length
  )
    return null;
  return { caps, knownCaps };
}

function readModel(value: unknown): ModelProjection | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'role',
      'modelName',
      'provider',
      'type',
      'parameters',
      'contextWindow',
      'dimensions',
      'effectiveCapabilities',
      'capabilityFacts',
      'exposedCapabilities',
      'thinkMode',
      'routedUseCases',
      'hasThinkTags',
      'hasSlots',
      'removable',
    ])
  )
    return null;

  const { role, modelName, provider, type, thinkMode, removable } = value;
  const { hasThinkTags, hasSlots } = value;
  if (
    !isIdentifier(role) ||
    !isIdentifier(modelName) ||
    !isIdentifier(provider) ||
    !isOneOf(type, MODEL_TYPES) ||
    !isOneOf(thinkMode, THINK_MODES) ||
    typeof removable !== 'boolean' ||
    typeof hasThinkTags !== 'boolean' ||
    typeof hasSlots !== 'boolean'
  )
    return null;

  const hasParameters = hasPresentKey(value, 'parameters');
  const hasContextWindow = hasPresentKey(value, 'contextWindow');
  const hasDimensions = hasPresentKey(value, 'dimensions');
  if (hasParameters && !isIdentifier(value.parameters)) return null;
  if (hasContextWindow && !isOptionalModelNumber(value.contextWindow)) return null;
  if (hasDimensions && !isOptionalModelNumber(value.dimensions)) return null;

  const effectiveCapabilities = readCappedArray(
    value.effectiveCapabilities,
    CAPABILITY_NAMES.length,
    (cap) => (isOneOf(cap, CAPABILITY_NAMES) ? cap : null)
  );
  const exposedCapabilities = readCappedArray(
    value.exposedCapabilities,
    CAPABILITY_NAMES.length,
    (cap) => (isOneOf(cap, CAPABILITY_NAMES) ? cap : null)
  );
  const capabilityFacts = readCapabilityFacts(value.capabilityFacts);
  const routedUseCases = readCappedArray(value.routedUseCases, MAX_PROJECTION_ENTRIES, (useCase) =>
    isIdentifier(useCase) ? useCase : null
  );
  if (
    effectiveCapabilities === null ||
    exposedCapabilities === null ||
    capabilityFacts === null ||
    routedUseCases === null ||
    !isCanonicalCapabilities(effectiveCapabilities) ||
    !isCanonicalCapabilities(exposedCapabilities) ||
    capabilityFacts.caps.length !== effectiveCapabilities.length ||
    capabilityFacts.caps.some((cap, index) => cap !== effectiveCapabilities[index]) ||
    // caps ⊆ knownCaps (§5.6), stated rather than left implied by the
    // full-vocabulary rule in readCapabilityFacts.
    !effectiveCapabilities.every((cap) => capabilityFacts.knownCaps.includes(cap)) ||
    !exposedCapabilities.every((cap) => capabilityFacts.knownCaps.includes(cap)) ||
    !isStrictlyOrdered(routedUseCases, compareString)
  )
    return null;

  return {
    role,
    modelName,
    provider,
    type,
    ...(hasParameters ? { parameters: value.parameters as string } : {}),
    ...(hasContextWindow ? { contextWindow: value.contextWindow as number } : {}),
    ...(hasDimensions ? { dimensions: value.dimensions as number } : {}),
    effectiveCapabilities,
    capabilityFacts,
    exposedCapabilities,
    thinkMode,
    routedUseCases,
    hasThinkTags,
    hasSlots,
    removable,
  };
}

function readProvider(value: unknown): ProviderProjection | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ['name', 'endpoint', 'classification', 'apiFormat', 'credentialState']))
    return null;
  const { name, endpoint, classification, apiFormat, credentialState } = value;
  if (!isIdentifier(name)) return null;
  // Endpoint is not an identifier (so an empty endpoint stays valid), but a
  // non-empty one must still be free of Cc/Cf runes and fully ASCII -- see
  // NON_ASCII_RUNE above for why the producer already guarantees this.
  if (!isBoundedString(endpoint, MAX_ENDPOINT_BYTES)) return null;
  if (
    endpoint !== '' &&
    (FORBIDDEN_IDENTIFIER_RUNES.test(endpoint) || NON_ASCII_RUNE.test(endpoint))
  )
    return null;
  if (!isOneOf(classification, CLASSIFICATIONS)) return null;
  if (!isOneOf(apiFormat, API_FORMATS)) return null;
  if (!isOneOf(credentialState, CREDENTIAL_STATES)) return null;
  return { name, endpoint, classification, apiFormat, credentialState };
}

export function readSettingsDiagnostic(value: unknown): SettingsDiagnostic | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ['code', 'subjectKind', 'subjectName', 'blocking'])) return null;
  const { code, subjectKind, subjectName, blocking } = value;
  if (!isOneOf(code, DIAGNOSTIC_CODES)) return null;
  if (!isOneOf(subjectKind, SUBJECT_KINDS)) return null;
  if (!isCleanIdentifier(subjectName, MAX_IDENTIFIER_BYTES)) return null;
  if (typeof blocking !== 'boolean') return null;
  return { code, subjectKind, subjectName, blocking };
}

export function parseSettingsProjection(value: unknown): SettingsProjection {
  if (!isRecord(value)) return contractError();
  if (
    !hasOnlyKeys(value, [
      'state',
      'sourceOrigin',
      'revision',
      'readOnly',
      'editable',
      'routes',
      'models',
      'providers',
      'diagnostics',
    ])
  )
    return contractError();
  if (
    !isOneOf(value.state, SETTINGS_STATES) ||
    !isOneOf(value.sourceOrigin, SOURCE_ORIGINS) ||
    typeof value.readOnly !== 'boolean' ||
    typeof value.editable !== 'boolean'
  )
    return contractError();

  const loaded = value.state === 'ready' || value.state === 'limited';
  const hasRevision = hasPresentKey(value, 'revision');
  if (
    loaded !== hasRevision ||
    (loaded && (typeof value.revision !== 'string' || !REVISION.test(value.revision)))
  )
    return contractError();
  if (!loaded && (value.readOnly || value.editable)) return contractError();
  if (value.state === 'ready' && (value.readOnly || !value.editable)) return contractError();

  const routes = readCappedArray(value.routes, MAX_PROJECTION_ENTRIES, readRoute);
  const models = readCappedArray(value.models, MAX_PROJECTION_ENTRIES, readModel);
  const providers = readCappedArray(value.providers, MAX_PROJECTION_ENTRIES, readProvider);
  const diagnostics = readCappedArray(value.diagnostics, MAX_DIAGNOSTICS, readSettingsDiagnostic);
  if (routes === null || models === null || providers === null || diagnostics === null)
    return contractError();
  if (!loaded && (routes.length !== 0 || models.length !== 0 || providers.length !== 0))
    return contractError();
  const limitedHasCause =
    value.readOnly ||
    !value.editable ||
    diagnostics.some((diagnostic) => diagnostic.code === 'projection_limited');
  if (value.state === 'limited' && !limitedHasCause) return contractError();

  const routeOrder = (a: RouteProjection, b: RouteProjection): number =>
    compareString(a.useCase, b.useCase);
  const diagnosticOrder = (a: SettingsDiagnostic, b: SettingsDiagnostic): number =>
    (a.blocking === b.blocking ? 0 : a.blocking ? -1 : 1) ||
    compareString(a.code, b.code) ||
    compareString(a.subjectKind, b.subjectKind) ||
    compareString(a.subjectName, b.subjectName);
  if (
    !isStrictlyOrdered(routes, routeOrder) ||
    !isStrictlyOrdered(models, (a, b) => compareString(a.role, b.role)) ||
    !isStrictlyOrdered(providers, (a, b) => compareString(a.name, b.name)) ||
    !isStrictlyOrdered(diagnostics, diagnosticOrder)
  )
    return contractError();

  return {
    state: value.state,
    sourceOrigin: value.sourceOrigin,
    ...(loaded ? { revision: value.revision as string } : {}),
    readOnly: value.readOnly,
    editable: value.editable,
    routes,
    models,
    providers,
    diagnostics,
  };
}

export function parseSettingsReloadResult(value: unknown): SettingsReloadResult {
  if (!isRecord(value)) return contractError();
  if (!hasOnlyKeys(value, ['busy', 'projection'])) return contractError();
  if (typeof value.busy !== 'boolean') return contractError();
  return { busy: value.busy, projection: parseSettingsProjection(value.projection) };
}
