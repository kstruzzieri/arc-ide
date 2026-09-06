import { DEFAULT_GOLEM_WINDOW_STATE, useGolemStore } from '../stores/golemStore';
import { useIDEStore } from '../stores/ideStore';
import { boundedGolemMessage, isRecord, type GolemActionResult } from '../types/golem';
import {
  parseGolemWindowEnvelope,
  parseGolemWindowState,
  type GolemViewAction,
  type GolemWindowEnvelope,
  type GolemWindowMessage,
  type GolemWindowState,
} from '../types/golemWindow';
import {
  CloseGolemWindow,
  FocusGolemWindow,
  GetGolemWindowState,
  OpenGolemWindow,
  PostGolemWindowMessage,
} from '../wails/bindings';
import { EventsOn } from '../wails/runtime';
// A deliberate module cycle: `utils/commands` imports the four controls below.
// Both directions are hoisted function declarations used only from inside a
// call, so neither module ever reads the other during evaluation.
import { showGolemConfiguration } from '../utils/commands';
import { useDraftStore } from './draftStore';
import { buildGolemView } from './projection';
import { createMainRelayCore, type MainRelayCore, type RelayTransport } from './relayCore';

/**
 * The main window's half of the two-window protocol (#271 Task B6).
 *
 * This is the *owner*: the store, the AI bridge and the executing admission
 * guards all live in this window, and the undocked satellite has none of them.
 * So everything here is integration around B2's tested `createMainRelayCore`,
 * not a second relay: bind one core per window instance, publish the
 * projection whenever the presentation state moves, run the draft transfer
 * inside the handoff barrier, execute the actions the satellite asks for, and
 * settle the undock/re-dock promises on Go's authoritative transitions — never
 * on a local guess.
 *
 * Three orderings shape it, exactly as they do the satellite:
 *
 * 1. **Go emits before it answers.** Both subscriptions are registered before
 *    `GetGolemWindowState()` is called, and both responses run through the same
 *    revision-guarded installer, so a `ready` that overtakes the getter is not
 *    walked back to `bootstrapped`.
 * 2. **React StrictMode starts twice.** Per-start state lives in an `Owner`,
 *    only one of which is `active`; a retired owner's core, timer and
 *    continuations can no longer touch the store or the transport.
 * 3. **A message can outrun its own lifecycle event.** The relayed draft map of
 *    a re-dock can arrive before the `closing` snapshot that explains it, so an
 *    envelope ahead of the installed state is held, one state refresh is
 *    requested, and it is replayed through the same gate. Dropping it would
 *    lose the user's composer text.
 */

const MODE_EVENT = 'golem:window-mode';
const MESSAGE_EVENT = 'golem:window-message';

/**
 * The main-side transfer bound.
 *
 * B2's `MainRelayDeps` carries no `ackTimeoutMs`/`maxAttempts`, so
 * `sendDrafts` has no retry of its own: it posts once and resolves when the
 * satellite answers `ready`. Go's 10 s `golemTransitionDeadline` would
 * eventually retire an unanswered bootstrap, but leaning on it alone means a
 * single dropped post freezes the docked composer for a full ten seconds. So
 * main drives its own bounded retry — the same envelope, the same
 * `(instance, handoff, id)`, so the satellite still installs exactly once —
 * and gives up well inside Go's deadline, posting an `abort` so Go retires the
 * attempt immediately instead of waiting it out. Go's deadline stays the
 * backstop for the case where even the abort cannot be delivered.
 */
export const MAIN_TRANSFER_RETRY_MS = 3000;
export const MAIN_TRANSFER_MAX_ATTEMPTS = 3;

/**
 * Envelopes held while the installed lifecycle state is behind them. Large
 * enough for a busy handoff, small enough that a wedged reconciliation fails
 * loudly instead of growing without bound.
 */
export const PENDING_ENVELOPE_LIMIT = 32;

const NO_OWNER = 'The Golem window is not ready to accept that yet.';
const OWNER_RETIRED = 'The Golem window controls closed before the transition finished.';
const TRANSFER_UNCONFIRMED = 'Golem could not hand this conversation to the window.';
const ABORT_UNEXPLAINED = 'The Golem window ended the transition without a reason.';
const UNDOCK_FAILED = 'The Golem window closed before it was ready.';
const REDOCK_FAILED = 'Golem could not move this conversation back to the main window.';
const UNEXPECTED_MESSAGE = 'Golem received an unexpected window message.';
const PENDING_OVERFLOW = 'Golem received more window messages than it could place.';
const OUT_OF_ORDER = 'Golem could not place a window message in the window lifecycle.';

// ── owner state ──────────────────────────────────────────────────────────────

interface Attempt {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  settled: boolean;
  /** Whether the binding that opened this attempt has answered yet. */
  openSettled: boolean;
  /** The lifecycle reason held back while that answer is still outstanding. */
  closedReason: string | null;
}

type AttemptKind = 'undock' | 'dock';

interface Owner {
  cancelled: boolean;
  /** Go's lifecycle revision, starting below zero so revision 0 installs. */
  installedRevision: number;
  state: GolemWindowState;
  core: MainRelayCore | null;
  coreInstance: number;
  /** The handoff whose main→satellite transfer this owner has already begun. */
  transferHandoff: number;
  transferAttempts: number;
  transferTimer: ReturnType<typeof setTimeout> | null;
  transferSettled: boolean;
  /** The instance whose drafts main has already handed over, or 0. */
  clearedInstance: number;
  /** The instance whose re-dock main has observed, or 0. */
  closingInstance: number;
  undock: Attempt | null;
  dock: Attempt | null;
  restoreTried: boolean;
  /** The reason the in-flight transition failed, shown when it settles. */
  failure: string | null;
  pending: GolemWindowEnvelope[];
  refreshing: boolean;
  unsubscribe: (() => void)[];
}

let active: Owner | null = null;

const transport: RelayTransport = {
  post: (message: GolemWindowMessage) => PostGolemWindowMessage(message),
};

/**
 * Surfaces a window failure. `windowError` is deliberately not `bridgeError`:
 * a window that would not open must never make a working docked AI look broken.
 */
export function reportGolemWindowError(error: unknown): void {
  const message = boundedGolemMessage(error);
  useGolemStore.getState().setWindowError(message);
  useIDEStore.getState().showToast(message, 'error');
}

// ── action execution ─────────────────────────────────────────────────────────

/**
 * The satellite's whole write surface, executed against the same guarded store
 * methods the docked host calls. Deliberately NOT `GolemPanel`'s adapter: that
 * one clears the composer draft on acceptance, and main's draft map is the
 * inactive copy of a window whose user is typing somewhere else. Every branch
 * answers with the store's own synchronous `GolemActionResult`, which B2 stamps
 * onto the acknowledgement.
 */
function execute(action: GolemViewAction): GolemActionResult {
  const s = useGolemStore.getState();
  switch (action.type) {
    case 'send':
      return s.submitTurn(action.conversationId, action.text);
    case 'allowAndSend':
      return s.allowAndSend(action.conversationId, action.runId, action.challengeId);
    case 'cancelRun':
      return s.cancelRun(action.runId);
    case 'retry':
      return s.retryLastFailed(action.conversationId);
    case 'updateQueued':
      return s.updateQueuedTurn(action.conversationId, action.queueId, action.text);
    case 'removeQueued':
      return s.removeQueuedTurn(action.conversationId, action.queueId);
    case 'select':
      return s.selectConversation(action.conversationId);
    case 'clear':
      return s.clearConversation(action.conversationId);
    case 'openConfig':
      // Go has already brought main forward for this intent; main owns the tab.
      showGolemConfiguration();
      return { ok: true };
  }
}

// ── attempts ─────────────────────────────────────────────────────────────────

function newAttempt(): Attempt {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, settled: false, openSettled: false, closedReason: null };
}

function settleAttempt(own: Owner, kind: AttemptKind): void {
  const attempt = own[kind];
  if (!attempt || attempt.settled) return;
  attempt.settled = true;
  own[kind] = null;
  attempt.resolve();
}

function failAttempt(own: Owner, kind: AttemptKind, reason: string): void {
  const attempt = own[kind];
  if (!attempt || attempt.settled) return;
  attempt.settled = true;
  own[kind] = null;
  attempt.reject(new Error(boundedGolemMessage(reason)));
}

// ── the draft transfer, main → satellite ─────────────────────────────────────

function stopTransferTimer(own: Owner): void {
  if (own.transferTimer === null) return;
  clearTimeout(own.transferTimer);
  own.transferTimer = null;
}

function stopTransfer(own: Owner): void {
  stopTransferTimer(own);
  own.transferSettled = true;
}

function failTransfer(own: Owner, instance: number, handoff: number, reason: string): void {
  if (own.transferSettled || own.transferHandoff !== handoff) return;
  stopTransfer(own);
  own.failure = boundedGolemMessage(reason);
  // Told, not merely abandoned: without this Go waits out its own deadline
  // with the docked composer frozen. The source is NOT thawed here — ownership
  // is uncertain until Go publishes the transition that ends the attempt.
  void PostGolemWindowMessage({
    kind: 'abort',
    instance,
    id: 0,
    revision: 0,
    handoff,
    payload: { reason: own.failure },
  }).catch(reportGolemWindowError);
}

function postTransfer(own: Owner, core: MainRelayCore, instance: number, handoff: number): void {
  // The getter, not a copy: a Send admitted between the freeze and here has
  // already cleared its own draft, and the satellite must not be handed the
  // text that was just submitted.
  core
    .sendDrafts(handoff, () => useDraftStore.getState().takeAll())
    .then(
      () => {
        if (own.cancelled || own !== active || own.transferHandoff !== handoff) return;
        stopTransfer(own);
      },
      (error: unknown) => {
        if (own.cancelled || own !== active) return;
        failTransfer(own, instance, handoff, boundedGolemMessage(error));
      }
    );
  stopTransferTimer(own);
  own.transferTimer = setTimeout(() => {
    own.transferTimer = null;
    if (own.cancelled || own !== active) return;
    if (own.transferSettled || own.transferHandoff !== handoff) return;
    if (own.transferAttempts >= MAIN_TRANSFER_MAX_ATTEMPTS) {
      failTransfer(own, instance, handoff, TRANSFER_UNCONFIRMED);
      return;
    }
    own.transferAttempts += 1;
    // Same handoff, so B2 reuses the recorded id and message: the satellite
    // installs once however many copies reach it.
    postTransfer(own, core, instance, handoff);
  }, MAIN_TRANSFER_RETRY_MS);
}

function startTransfer(own: Owner, state: GolemWindowState): void {
  const core = own.core;
  if (core === null || state.handoff === 0) return;
  if (own.transferHandoff === state.handoff) return; // once per handoff
  stopTransferTimer(own);
  own.transferHandoff = state.handoff;
  own.transferAttempts = 1;
  own.transferSettled = false;
  postTransfer(own, core, state.instance, state.handoff);
}

// ── the core ─────────────────────────────────────────────────────────────────

function disposeCore(own: Owner): void {
  own.core?.dispose();
  own.core = null;
  own.coreInstance = 0;
}

function bindCore(own: Owner, next: GolemWindowState): void {
  if (next.phase === 'closed' || next.instance === 0) {
    disposeCore(own);
    return;
  }
  if (own.core !== null && own.coreInstance === next.instance) return;
  // A new instance: the old core's ids, watermark and transfer belong to a
  // window that is gone.
  disposeCore(own);
  own.coreInstance = next.instance;
  own.core = createMainRelayCore({
    instance: next.instance,
    transport,
    execute,
    snapshot: () => buildGolemView(useGolemStore.getState()),
    onDrafts: (map) => useDraftStore.getState().installAll(map),
    onError: reportGolemWindowError,
  });
  own.core.publish();
}

/** Exactly the slices `buildGolemView` reads; anything else is not published. */
type ProjectionSlices = readonly unknown[];

const projectionSlices = (): ProjectionSlices => {
  const s = useGolemStore.getState();
  return [
    s.conversations,
    s.bridgePhase,
    s.bridgeError,
    s.hydratedIdentity,
    s.selectedConversationId,
    s.composerFocusRevision,
  ];
};

function subscribeProjection(own: Owner): () => void {
  let previous = projectionSlices();
  return useGolemStore.subscribe(() => {
    if (own.cancelled || own !== active) return;
    const next = projectionSlices();
    if (next.every((value, index) => value === previous[index])) return;
    previous = next;
    // Coalesced by B2: many mutations in one tick become one post.
    own.core?.publish();
  });
}

// ── envelope gating ──────────────────────────────────────────────────────────

type Gate = 'accept' | 'ahead' | 'reject';

/**
 * Whether an envelope belongs to the installed lifecycle state, is ahead of it
 * (so the state event has not landed yet), or is definitively stale.
 *
 * `ahead` is never a refusal: Go relays a message and publishes the state that
 * explains it over two different channels, so the map returned by a re-dock can
 * genuinely arrive before the `closing` snapshot.
 */
function gate(state: GolemWindowState, message: GolemWindowMessage): Gate {
  if (message.instance > state.instance) return 'ahead';
  if (state.instance === 0 || message.instance !== state.instance) return 'reject';
  const { phase } = state;
  switch (message.kind) {
    case 'abort':
      return 'accept';
    case 'action':
    case 'ack':
      // Go admits ordinary traffic only from ready onwards.
      if (phase === 'ready' || phase === 'closing') return 'accept';
      return phase === 'closed' ? 'reject' : 'ahead';
    case 'drafts':
      if (message.handoff === 0) return 'reject';
      if (message.handoff > state.handoff) return 'ahead';
      if (message.handoff < state.handoff) return 'reject';
      if (phase === 'closing') return 'accept';
      return phase === 'closed' ? 'reject' : 'ahead';
    case 'ready':
      if (message.handoff === 0) return 'reject';
      if (message.handoff > state.handoff) return 'ahead';
      if (message.handoff < state.handoff) return 'reject';
      if (phase === 'bootstrapped' || phase === 'ready') return 'accept';
      return phase === 'bootstrapping' ? 'ahead' : 'reject';
    default:
      // `view` is main's own kind; the satellite never sends one.
      return 'reject';
  }
}

function handleAbort(own: Owner, message: GolemWindowMessage): void {
  const { payload } = message;
  const reason =
    isRecord(payload) && typeof payload.reason === 'string'
      ? boundedGolemMessage(payload.reason)
      : ABORT_UNEXPLAINED;
  own.failure = reason;
  stopTransfer(own);
  // With an attempt in flight the reason is shown once, where that attempt
  // settles. With none, this is the only channel it has.
  if (own.undock === null && own.dock === null) reportGolemWindowError(reason);
}

function accept(own: Owner, envelope: GolemWindowEnvelope): void {
  if (envelope.message.kind === 'abort') {
    handleAbort(own, envelope.message);
    return;
  }
  const core = own.core;
  if (core === null) {
    hold(own, envelope);
    return;
  }
  core.receive(envelope).catch(reportGolemWindowError);
}

function hold(own: Owner, envelope: GolemWindowEnvelope): void {
  if (own.pending.length >= PENDING_ENVELOPE_LIMIT) {
    // Nothing is installed and nothing is thawed: main keeps the surface it
    // still owns rather than acting on a lifecycle it cannot reconstruct.
    reportGolemWindowError(PENDING_OVERFLOW);
    return;
  }
  own.pending.push(envelope);
  refreshState(own);
}

function replayPending(own: Owner): void {
  if (own.pending.length === 0) return;
  const held = own.pending.splice(0);
  for (const envelope of held) {
    switch (gate(own.state, envelope.message)) {
      case 'accept':
        accept(own, envelope);
        break;
      case 'reject':
        reportGolemWindowError(UNEXPECTED_MESSAGE);
        break;
      default:
        // Still ahead: re-held directly, so a replay cannot re-arm the refresh.
        own.pending.push(envelope);
    }
  }
}

function refreshState(own: Owner): void {
  if (own.refreshing) return;
  own.refreshing = true;
  void GetGolemWindowState().then(
    (raw: unknown) => {
      own.refreshing = false;
      if (own.cancelled || own !== active) return;
      const before = own.installedRevision;
      try {
        installState(own, parseGolemWindowState(raw));
      } catch (error) {
        reportGolemWindowError(error);
        return;
      }
      // `installState` replays only when it actually installed something.
      replayPending(own);
      if (own.pending.length > 0 && own.installedRevision === before) {
        reportGolemWindowError(OUT_OF_ORDER);
      }
    },
    (error: unknown) => {
      own.refreshing = false;
      if (own.cancelled || own !== active) return;
      reportGolemWindowError(error);
    }
  );
}

function handleMessage(own: Owner, payload: unknown): void {
  if (own.cancelled || own !== active) return;
  let envelope: GolemWindowEnvelope;
  try {
    envelope = parseGolemWindowEnvelope(payload);
  } catch (error) {
    reportGolemWindowError(error);
    return;
  }
  // Go relays main's own posts back to main. That is an echo, not traffic.
  if (envelope.from !== 'satellite') return;
  switch (gate(own.state, envelope.message)) {
    case 'accept':
      accept(own, envelope);
      return;
    case 'ahead':
      hold(own, envelope);
      return;
    default:
      reportGolemWindowError(UNEXPECTED_MESSAGE);
  }
}

// ── the lifecycle installer ──────────────────────────────────────────────────

function refreshFrozen(own: Owner): void {
  // The docked host owns the surface only while no window exists. Everything
  // else — bootstrapping, bootstrapped, ready, closing — is either the
  // satellite's or nobody's, and a frozen composer is the honest affordance.
  useGolemStore.getState().setHostFrozen(own.state.phase !== 'closed');
}

function installState(own: Owner, next: GolemWindowState): void {
  if (own.cancelled || own !== active) return;
  // Go's revision only ever counts up, so an older snapshot is a late delivery
  // and must not walk `ready` back to `bootstrapped`.
  if (next.stateRevision <= own.installedRevision) return;
  const previous = own.state;
  own.installedRevision = next.stateRevision;
  own.state = next;
  useGolemStore.getState().setWindowState(next);
  bindCore(own, next);
  refreshFrozen(own);
  // Go's own text for a failed transition; the local fallbacks below are for
  // a snapshot that carries none.
  const reason = next.reason ?? null;

  if (next.phase === 'closing' && next.instance !== 0) {
    if (
      reason !== null &&
      previous.phase === 'closing' &&
      previous.instance === next.instance &&
      own.closingInstance === next.instance
    ) {
      // Go authorized the native close and the window never left the manager
      // within its cap: the phase stays `closing`, so the reason is the only
      // retry affordance there is. Settle the attempt with it (once per
      // stalled snapshot, since a repeat carries a newer revision), which
      // re-enables the rail's Dock button; the next dockGolem() re-issues
      // CloseGolemWindow, and Go re-arms its retirement observer on that.
      if (own.dock !== null) failAttempt(own, 'dock', reason);
      else reportGolemWindowError(reason);
    }
    own.closingInstance = next.instance;
  }
  if (next.phase === 'bootstrapped') startTransfer(own, next);

  if (next.phase === 'ready' && next.instance !== 0) {
    stopTransfer(own);
    if (own.clearedInstance !== next.instance) {
      // The first ready of this instance: the satellite now owns the drafts,
      // so main's copy is inactive. A closing → ready recovery does not repeat
      // this, or it would erase the map the satellite just handed back.
      own.clearedInstance = next.instance;
      useDraftStore.getState().installAll({});
      // §7: an opened window is a window the user is about to type in. The
      // satellite has no store, so its caret comes from this bump travelling
      // out with the next projection — once per window, not per state tick.
      useGolemStore.getState().requestComposerFocus();
    }
    if (own.closingInstance === next.instance) {
      // The re-dock was abandoned: the satellite keeps the conversation.
      own.closingInstance = 0;
      failAttempt(own, 'dock', own.failure ?? reason ?? REDOCK_FAILED);
      own.failure = null;
      // §5.1 restores the source interaction on failure, and the source here is
      // the window the user is still looking at. Clearing `closingInstance`
      // above is what keeps this to one bump per recovery: an ordinary later
      // `ready` of the same instance no longer matches.
      useGolemStore.getState().requestComposerFocus();
    }
    settleAttempt(own, 'undock');
  }

  if (next.phase === 'closed') {
    stopTransfer(own);
    const redocked =
      own.closingInstance !== 0 &&
      own.closingInstance === previous.instance &&
      previous.mode === 'undocked';
    own.closingInstance = 0;
    if (redocked) {
      settleAttempt(own, 'dock');
      // §5.3: only a completed re-dock reveals the chat, and only main does it.
      useIDEStore.getState().revealCenterPanel('golem');
      useGolemStore.getState().requestComposerFocus();
    } else {
      failAttempt(own, 'dock', own.failure ?? reason ?? REDOCK_FAILED);
    }
    const opening = own.undock;
    if (opening !== null && !opening.openSettled) {
      // `abandonGolemOpen` emits this `closed` *before* `OpenGolemWindow`
      // returns its error, so failing the attempt now would settle it with a
      // generic reason and leave the real one — "no display", a superseded
      // attempt — with nowhere to go. Hold the reason and let the binding's
      // own answer, which is the one that knows, settle it.
      opening.closedReason = own.failure ?? reason ?? UNDOCK_FAILED;
    } else {
      failAttempt(own, 'undock', own.failure ?? reason ?? UNDOCK_FAILED);
    }
    own.failure = null;
  }

  if (next.restorePending && !own.restoreTried) {
    // A saved undocked window, restored once the owner is wired — which is
    // independent of whether the AI bridge ever binds a repository.
    own.restoreTried = true;
    void undockGolem().catch(reportGolemWindowError);
  }

  replayPending(own);
}

// ── public surface ───────────────────────────────────────────────────────────

/**
 * Subscribes, reads the authoritative state and returns the teardown. Safe to
 * call twice under StrictMode: the returned function retires its own owner,
 * and a retired owner's core, timer and continuations can no longer act.
 */
export function startMainGolemRelay(): () => void {
  const own: Owner = {
    cancelled: false,
    installedRevision: -1,
    state: DEFAULT_GOLEM_WINDOW_STATE,
    core: null,
    coreInstance: 0,
    transferHandoff: 0,
    transferAttempts: 0,
    transferTimer: null,
    transferSettled: true,
    clearedInstance: 0,
    closingInstance: 0,
    undock: null,
    dock: null,
    restoreTried: false,
    failure: null,
    pending: [],
    refreshing: false,
    unsubscribe: [],
  };
  active = own;

  // Both subscriptions before the read: Go publishes the state and starts
  // relaying before a bound call's own response reaches JS.
  own.unsubscribe.push(
    EventsOn<unknown>(MODE_EVENT, (payload) => {
      if (own.cancelled || own !== active) return;
      try {
        installState(own, parseGolemWindowState(payload));
      } catch (error) {
        reportGolemWindowError(error);
      }
    })
  );
  own.unsubscribe.push(EventsOn<unknown>(MESSAGE_EVENT, (payload) => handleMessage(own, payload)));
  own.unsubscribe.push(subscribeProjection(own));

  void GetGolemWindowState().then(
    (raw: unknown) => {
      if (own.cancelled || own !== active) return;
      try {
        installState(own, parseGolemWindowState(raw));
      } catch (error) {
        reportGolemWindowError(error);
      }
    },
    (error: unknown) => {
      if (own.cancelled || own !== active) return;
      reportGolemWindowError(error);
    }
  );

  return () => {
    own.cancelled = true;
    if (active === own) active = null;
    stopTransfer(own);
    for (const off of own.unsubscribe) off();
    own.unsubscribe.length = 0;
    own.pending.length = 0;
    disposeCore(own);
    failAttempt(own, 'undock', OWNER_RETIRED);
    failAttempt(own, 'dock', OWNER_RETIRED);
  };
}

/**
 * Moves the conversation into its own window. Resolves on Go's authoritative
 * `ready`, rejects on a failed open or an aborted close. Repeated calls answer
 * with the one attempt already in flight.
 */
export function undockGolem(): Promise<void> {
  const own = active;
  if (own === null || own.cancelled) return Promise.reject(new Error(NO_OWNER));
  if (own.undock) return own.undock.promise;
  // Go answers an open on a live window by revealing it and publishing no new
  // state, so an attempt started here would wait for a `ready` that has already
  // happened. Same intent, honest call: bring the window forward.
  if (own.state.phase === 'ready') return focusGolemWindow();
  // Synchronous, before any snapshot is taken: B4 made local admission and
  // draft clearing synchronous, so the barrier and the map the transfer will
  // read cannot disagree about what the user typed.
  const golem = useGolemStore.getState();
  golem.setHostFrozen(true);
  golem.setWindowError(null);
  own.failure = null;
  const attempt = newAttempt();
  own.undock = attempt;
  void OpenGolemWindow().then(
    () => {
      if (own.cancelled || own.undock !== attempt) return;
      attempt.openSettled = true;
      // Go accepted the open and then retired the window: it never said why,
      // so the lifecycle's own reason is all there is.
      if (attempt.closedReason !== null) failAttempt(own, 'undock', attempt.closedReason);
    },
    (error: unknown) => {
      if (own.cancelled || own.undock !== attempt) return;
      attempt.openSettled = true;
      const retired = attempt.closedReason !== null;
      failAttempt(own, 'undock', boundedGolemMessage(error));
      // Nothing was ever handed over, so the docked host owns it again — unless
      // the retirement already thawed it, which must not be written twice.
      if (!retired) refreshFrozen(own);
    }
  );
  return attempt.promise;
}

/**
 * Asks Go to bring the conversation back. Go answers with `closing`, which is
 * what starts the transfer; only the `closed` that follows proves it finished.
 */
export function dockGolem(): Promise<void> {
  const own = active;
  if (own === null || own.cancelled) return Promise.reject(new Error(NO_OWNER));
  if (own.dock) return own.dock.promise;
  useGolemStore.getState().setWindowError(null);
  own.failure = null;
  const attempt = newAttempt();
  own.dock = attempt;
  void CloseGolemWindow().then(
    () => undefined,
    (error: unknown) => {
      if (own.cancelled || own.dock !== attempt) return;
      failAttempt(own, 'dock', boundedGolemMessage(error));
    }
  );
  return attempt.promise;
}

/** Brings the satellite forward. Go refuses when there is no live window. */
export function focusGolemWindow(): Promise<void> {
  return FocusGolemWindow().then(() => undefined);
}
