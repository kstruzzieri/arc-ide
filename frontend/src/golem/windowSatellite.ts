import type { GolemSurfaceActions } from '../components/Golem/GolemSurface';
import { boundedGolemMessage, isRecord } from '../types/golem';
import {
  parseGolemWindowBootstrap,
  parseGolemWindowEnvelope,
  parseGolemWindowState,
  retryChangesNothing,
  type GolemAck,
  type GolemDraftMap,
  type GolemView,
  type GolemViewAction,
  type GolemWindowEnvelope,
  type GolemWindowMessage,
  type GolemWindowState,
} from '../types/golemWindow';
import {
  BootstrapGolemWindow,
  CloseGolemWindow,
  ConfirmGolemWindowClose,
  PostGolemWindowMessage,
} from '../wails/bindings';
import { EventsOn } from '../wails/runtime';
import { useDraftStore } from './draftStore';
import { createSatelliteCore, type RelayTransport, type SatelliteCore } from './relayCore';
import { NO_PENDING_COMPOSERS, useViewStore } from './viewStore';

/**
 * The undocked window's relay client (#271 spec §5.2).
 *
 * It owns the whole satellite lifecycle: subscribe, bootstrap, install main's
 * draft map, report `ready`, dispatch acknowledged actions, and run the re-dock
 * transfer. Nothing here executes a turn — every mutation is a `GolemViewAction`
 * that main admits or refuses, and this window believes only what it is told.
 *
 * Three orderings drive the shape of this file:
 *
 * 1. **Go emits before it answers.** `BootstrapGolemWindow` publishes the
 *    `bootstrapped` snapshot — and main starts relaying — before the bound
 *    call's own response reaches JS. So both subscriptions are registered first
 *    and everything that arrives in the gap is buffered, never dropped.
 * 2. **React StrictMode starts twice.** Per-start state lives in an `Owner`,
 *    only one of which is `active`; a retired owner's late bootstrap can neither
 *    replace the live core nor write to the store.
 * 3. **A re-dock can land mid-Send.** The draft map is read through a getter
 *    *inside* the handoff barrier, after the outstanding action drained and its
 *    host clearing ran, so an already-submitted prompt is not handed back to the
 *    composer.
 */

const MODE_EVENT = 'golem:window-mode';
const MESSAGE_EVENT = 'golem:window-message';

/**
 * Go's own bound on a whole transition — `golemTransitionDeadline` in
 * app_golem_window.go. Nothing here arms a timer against it; it is the ceiling
 * the retry bounds below are chosen under, because when it expires Go restores
 * `ready` on its own and this window's verdict would explain a transition the
 * user has already been handed back.
 */
export const GOLEM_TRANSITION_DEADLINE_MS = 10_000;
/** How long an unacknowledged relay post waits before it is posted again. */
export const SATELLITE_ACK_TIMEOUT_MS = 3000;
/**
 * Posts per action or transfer before the outcome is declared uncertain rather
 * than lost. ACK × ATTEMPTS must stay under GOLEM_TRANSITION_DEADLINE_MS, which
 * `windowSatellite.test.ts` asserts rather than leaving to arithmetic.
 */
export const SATELLITE_MAX_ATTEMPTS = 3;
/**
 * Envelopes held while the bootstrap response is outstanding. `handleMessage`
 * coalesces superseded projections in place, so this bounds only what cannot be
 * collapsed: main's draft transfer and its retries — at most
 * SATELLITE_MAX_ATTEMPTS posts per handoff — plus the one held view. Sixty-four
 * is an order of magnitude above that, so an overflow means the relay is
 * producing traffic this window has no rule for, not a merely slow startup.
 */
export const SATELLITE_STARTUP_BUFFER = 64;

const NO_CONNECTION = 'Golem is not connected to the main window.';
const NOT_INTERACTIVE = 'Golem is not accepting input in this window yet.';
const STARTUP_OVERFLOW = 'Golem received more startup messages than it could hold.';
const UNEXPECTED_MESSAGE = 'Golem received a window message meant for another window.';
const STALE_TRANSFER = 'Golem received a draft transfer that does not belong to this window.';
const UNEXPLAINED_REFUSAL = 'Golem refused that action.';
const ABORT_UNEXPLAINED = 'The main window ended the transition without a reason.';
const TRANSFER_ENDED = 'The move to the main window did not complete.';

/**
 * One optimistic queue edit. The projection is the only source of a queued
 * turn's text, so an edit has to be painted locally until main's watermark
 * (`GolemView.processedThrough`) proves the projection carries it — otherwise
 * the controlled input snaps back on every incoming view.
 */
interface QueueEdit {
  text: string;
  /** The admitted action id, or null while the edit is still unacknowledged. */
  settledAt: number | null;
}

interface Owner {
  cancelled: boolean;
  /** Retires an in-flight bootstrap continuation without retiring the owner. */
  generation: number;
  instance: number;
  core: SatelliteCore | null;
  buffer: GolemWindowEnvelope[];
  draftsInstalled: boolean;
  /** The projection as main published it, before any local queue overlay. */
  rawView: GolemView | null;
  /** One promise per handoff, so a repeated `closing` snapshot cannot restart it. */
  handoffs: Map<number, Promise<void>>;
  queueEdits: Map<string, QueueEdit>;
}

let active: Owner | null = null;

const transport: RelayTransport = {
  post: (message: GolemWindowMessage) => PostGolemWindowMessage(message),
};

// ── store writes ─────────────────────────────────────────────────────────────

/**
 * Surfaces a failure. A *retired* owner is silent: its window is already gone.
 * No owner at all is not the same thing — the relay never started, or was torn
 * down before the caller ran — and that failure is the user's only sign that
 * this window is not connected, so it is written.
 */
function report(own: Owner | null, value: unknown): void {
  if (own !== null && (own.cancelled || own !== active)) return;
  useViewStore.setState({ error: boundedGolemMessage(value) }, false, 'golem/error');
}

function setPending(own: Owner, conversationId: string, pending: boolean): void {
  if (own.cancelled || own !== active) return;
  const current = useViewStore.getState().pendingComposers;
  if (current.has(conversationId) === pending) return;
  const next = new Set(current);
  if (pending) next.add(conversationId);
  else next.delete(conversationId);
  useViewStore.setState(
    { pendingComposers: next.size === 0 ? NO_PENDING_COMPOSERS : next },
    false,
    pending ? 'golem/lock' : 'golem/unlock'
  );
}

/**
 * The one rule for the interaction barrier. This window is live only while it
 * holds a projection, the transferred draft map and Go's own `ready` for its
 * instance. Go is the sole authority on the last of those: a transfer that
 * failed leaves the phase alone until Go restores `ready`, and a window that
 * froze itself past that point could never be typed in again.
 */
function refreshFrozen(own: Owner): void {
  if (own.cancelled || own !== active) return;
  const { view, state, frozen } = useViewStore.getState();
  const next =
    !own.draftsInstalled ||
    view === null ||
    state === null ||
    state.instance !== own.instance ||
    state.phase !== 'ready';
  if (next !== frozen) useViewStore.setState({ frozen: next }, false, 'golem/frozen');
}

// ── the local queue-edit overlay ─────────────────────────────────────────────

function withQueueEdits(view: GolemView, edits: Map<string, QueueEdit>): GolemView {
  if (edits.size === 0) return view;
  let changed = false;
  const conversations = { ...view.conversations };
  for (const [id, conversation] of Object.entries(conversations)) {
    if (!conversation.queuedTurns.some((turn) => edits.has(turn.queueId))) continue;
    conversations[id] = {
      ...conversation,
      queuedTurns: conversation.queuedTurns.map((turn) => {
        const edit = edits.get(turn.queueId);
        return edit === undefined ? turn : { ...turn, message: edit.text };
      }),
    };
    changed = true;
  }
  return changed ? { ...view, conversations } : view;
}

/** Retires every overlay entry main's watermark proves the projection carries. */
function dropSettledEdits(own: Owner, view: GolemView): void {
  for (const [queueId, edit] of own.queueEdits)
    if (edit.settledAt !== null && view.processedThrough >= edit.settledAt)
      own.queueEdits.delete(queueId);
}

function paintView(own: Owner): void {
  if (own.cancelled || own !== active || own.rawView === null) return;
  useViewStore.setState({ view: withQueueEdits(own.rawView, own.queueEdits) }, false, 'golem/view');
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Posts an `abort` for the transition this window can no longer complete, so
 * Go returns closing→ready (or retires a failed bootstrap) instead of waiting
 * out its deadline. A failure before this window even knows its instance is
 * covered by Go's bootstrap timeout, which is why that case posts nothing.
 */
function postAbort(instance: number, handoff: number, reason: string): void {
  if (instance === 0 || handoff === 0) return;
  void PostGolemWindowMessage({
    kind: 'abort',
    instance,
    id: 0,
    revision: 0,
    handoff,
    payload: { reason },
  }).catch((error: unknown) => {
    useViewStore.setState(
      {
        error: boundedGolemMessage(
          `${reason} The main window could not be told: ${boundedGolemMessage(error)}`
        ),
      },
      false,
      'golem/abort-failed'
    );
  });
}

function installState(own: Owner, next: GolemWindowState): void {
  if (own.cancelled || own !== active) return;
  const current = useViewStore.getState().state;
  // Go's lifecycle revision only ever counts up, so an older snapshot is a
  // late delivery and must not walk `ready` back to `bootstrapped`.
  if (current !== null && next.stateRevision <= current.stateRevision) return;
  useViewStore.setState({ state: next }, false, 'golem/state');
  const mine = own.instance !== 0 && next.instance === own.instance;
  // `restoreGolemReady` walks closing→ready under the SAME handoff number, so
  // this snapshot is the only word this window gets that a transfer Go gave up
  // on is over. Settling the waiter here — before the barrier is recomputed —
  // is what keeps a timed-out re-dock from leaving the window mute. Go names
  // why (its deadline, a relayed abort); the generic text is only for a
  // snapshot that carries no reason.
  if (mine && next.phase === 'ready' && own.handoffs.has(next.handoff))
    own.core?.abortHandoff(next.handoff, next.reason ?? TRANSFER_ENDED);
  refreshFrozen(own);
  if (!mine) return;
  // A `closing` that carries a reason is a stalled retirement: Go authorized
  // the native close and this window never left the manager. It is still on
  // screen — the user pressed ⌘W here — so the reason is shown here too, and
  // stays frozen; Retry (retryGolemConnection) is a fresh close request.
  if (next.phase === 'closing' && next.reason !== undefined)
    useViewStore.setState({ error: next.reason }, false, 'golem/stalled');
  // Only a window that reached `ready` owns a map to hand back. Go flips
  // `mode` to undocked on ready alone, so an aborted bootstrap's `closing`
  // still says `docked`: there is nothing to transfer, Go has already
  // authorized the close, and a transfer here would hand main an empty map to
  // install over the user's docked text (§5.1).
  if (next.phase === 'closing' && next.handoff !== 0 && next.mode === 'undocked')
    void beginReDock(own, next);
}

function installView(own: Owner, view: GolemView): void {
  if (own.cancelled || own !== active) return;
  own.rawView = view;
  dropSettledEdits(own, view);
  paintView(own);
  refreshFrozen(own);
}

function installDrafts(own: Owner, map: GolemDraftMap, handoff: number, id: number): void {
  if (own.cancelled || own !== active) return;
  useDraftStore.getState().installAll(map);
  own.draftsInstalled = true;
  refreshFrozen(own);
  // `ready` quotes the id of the map actually installed: main holds the close
  // open until it hears its own transfer named back.
  own.core?.ready(handoff, id).catch((error: unknown) => {
    report(own, error);
    postAbort(own.instance, handoff, boundedGolemMessage(error));
  });
}

function onAdmission(own: Owner, action: GolemViewAction, ack: GolemAck): void {
  if (own.cancelled || own !== active) return;
  if (action.type === 'send' || action.type === 'clear') {
    // Only on acceptance, and only this conversation: a refusal keeps what the
    // user typed, and a conversation selected since then is untouched.
    if (ack.ok) useDraftStore.getState().clear(action.conversationId);
    setPending(own, action.conversationId, false);
  }
  if (action.type === 'updateQueued') {
    const edit = own.queueEdits.get(action.queueId);
    if (edit) {
      if (ack.ok) edit.settledAt = ack.id;
      else own.queueEdits.delete(action.queueId);
      paintView(own);
    }
  }
  if (!ack.ok) {
    useViewStore.setState({ error: ack.reason ?? UNEXPLAINED_REFUSAL }, false, 'golem/refused');
    return;
  }
  // An accepted action is proof the relay works; a stale banner would only lie.
  if (useViewStore.getState().error !== null)
    useViewStore.setState({ error: null }, false, 'golem/recovered');
}

function handleAbort(own: Owner, message: GolemWindowMessage): void {
  if (own.cancelled || own !== active) return;
  const { payload } = message;
  const reason =
    isRecord(payload) && typeof payload.reason === 'string'
      ? boundedGolemMessage(payload.reason)
      : ABORT_UNEXPLAINED;
  useViewStore.setState({ error: reason }, false, 'golem/aborted');
  // Main ended the transfer this window started. Settling the waiter with
  // main's own reason both lifts the relay's barrier and keeps that reason as
  // the one the failure is finally reported under.
  own.handoffs.delete(message.handoff);
  own.core?.abortHandoff(message.handoff, reason);
  refreshFrozen(own);
}

/**
 * A main→satellite transfer is legal only inside the live transfer generation
 * and only while a window is being brought up. Role and instance are checked by
 * the caller; this is the phase and handoff half.
 */
function transferBelongsHere(message: GolemWindowMessage): boolean {
  const state = useViewStore.getState().state;
  if (state === null) return false;
  if (state.phase === 'closed' || state.phase === 'closing') return false;
  return message.handoff !== 0 && message.handoff === state.handoff;
}

function deliver(own: Owner, envelope: GolemWindowEnvelope): void {
  if (own.cancelled || own !== active) return;
  const { from, message } = envelope;
  // Go delivers each relay message to the other window only, so this window
  // should never see its own posts; if one does arrive, it is an echo, not
  // traffic.
  if (from !== 'main') return;
  if (message.instance !== own.instance) {
    report(own, UNEXPECTED_MESSAGE);
    return;
  }
  if (message.kind === 'abort') {
    handleAbort(own, message);
    return;
  }
  if (message.kind === 'drafts' && !transferBelongsHere(message)) {
    report(own, STALE_TRANSFER);
    return;
  }
  own.core?.receive(envelope);
}

function handleMessage(own: Owner, payload: unknown): void {
  if (own.cancelled || own !== active) return;
  let envelope: GolemWindowEnvelope;
  try {
    envelope = parseGolemWindowEnvelope(payload);
  } catch (error) {
    report(own, error);
    return;
  }
  if (own.core === null) {
    if (envelope.message.kind === 'view') {
      // Projections are a strict revision series and only the newest can ever
      // be installed, so a superseded one is replaced where it stands rather
      // than spending room the buffer holds for the draft transfer.
      const held = own.buffer.findIndex((entry) => entry.message.kind === 'view');
      if (held !== -1) {
        if (envelope.message.revision > own.buffer[held].message.revision)
          own.buffer[held] = envelope;
        return;
      }
    }
    if (own.buffer.length >= SATELLITE_STARTUP_BUFFER) {
      // Dropping one of these could drop a draft transfer, so the startup
      // fails loudly instead.
      failStartup(own, STARTUP_OVERFLOW);
      return;
    }
    own.buffer.push(envelope);
    return;
  }
  deliver(own, envelope);
}

function failStartup(own: Owner, value: unknown): void {
  if (own.cancelled || own !== active) return;
  // Retires the outstanding bootstrap continuation: a response that lands after
  // this must not quietly revive a window the user was told had failed.
  own.generation += 1;
  own.buffer.length = 0;
  const reason = boundedGolemMessage(value);
  useViewStore.setState({ error: reason, frozen: true }, false, 'golem/startup-failed');
  const state = useViewStore.getState().state;
  if (state !== null) postAbort(state.instance, state.handoff, reason);
}

function runBootstrap(own: Owner): void {
  const generation = own.generation;
  void BootstrapGolemWindow()
    .then(
      (raw: unknown) => {
        if (own.cancelled || own !== active || own.generation !== generation) return;
        const bootstrap = parseGolemWindowBootstrap(raw);
        own.instance = bootstrap.state.instance;
        own.core = createSatelliteCore({
          instance: bootstrap.state.instance,
          transport,
          ackTimeoutMs: SATELLITE_ACK_TIMEOUT_MS,
          maxAttempts: SATELLITE_MAX_ATTEMPTS,
          onView: (view) => installView(own, view),
          onAdmission: (action, ack) => onAdmission(own, action, ack),
          onDrafts: (map, handoff, id) => installDrafts(own, map, handoff, id),
          onError: (error) => report(own, error),
        });
        installState(own, bootstrap.state);
        // Revision-guarded, so a live projection that overtook the response is
        // not replaced by the older snapshot the response carries.
        own.core.installBootstrap(bootstrap.view, bootstrap.revision);
        for (const envelope of own.buffer.splice(0)) deliver(own, envelope);
      },
      (error: unknown) => {
        if (own.cancelled || own !== active || own.generation !== generation) return;
        failStartup(own, error);
      }
    )
    .catch((error: unknown) => {
      if (own.cancelled || own !== active || own.generation !== generation) return;
      failStartup(own, error);
    });
}

// ── re-dock ──────────────────────────────────────────────────────────────────

function failHandoff(own: Owner, state: GolemWindowState, reason: string): void {
  if (own.cancelled || own !== active) return;
  own.handoffs.delete(state.handoff);
  // Idempotent, and the barrier comes down even when the transfer itself had
  // succeeded and it was the close authorization that failed.
  own.core?.abortHandoff(state.handoff, reason);
  useViewStore.setState({ error: reason }, false, 'golem/handoff-failed');
  // Only while Go still believes the transfer is running. Once it has restored
  // `ready` — its own deadline, or an abort it relayed — an abort would name a
  // transition it has already closed, and Go answers that with an error.
  const current = useViewStore.getState().state;
  if (current !== null && current.phase === 'closing' && current.handoff === state.handoff)
    postAbort(state.instance, state.handoff, reason);
  refreshFrozen(own);
}

async function runReDock(own: Owner, state: GolemWindowState, core: SatelliteCore): Promise<void> {
  useViewStore.setState({ frozen: true }, false, 'golem/handoff');
  try {
    // The getter is deliberate. Copying `takeAll()` before `beginHandoff`
    // drains the queue would transfer an already-submitted Send's text back
    // into the composer it was sent from.
    await core.beginHandoff(state.handoff, () => useDraftStore.getState().takeAll());
  } catch (error) {
    failHandoff(own, state, boundedGolemMessage(error));
    return;
  }
  if (own.cancelled || own !== active) return;
  const current = useViewStore.getState().state;
  if (
    current !== null &&
    (current.instance !== state.instance || current.handoff !== state.handoff)
  )
    return;
  try {
    // Only now: this is the native close authorization, and it is granted only
    // against a transfer main has acknowledged.
    await ConfirmGolemWindowClose(state.instance, state.handoff);
  } catch (error) {
    if (own.cancelled || own !== active) return;
    failHandoff(own, state, boundedGolemMessage(error));
  }
  // Past authorization there is deliberately nothing left to do: a retirement
  // timeout is Go's same-id close recovery, and this window stays closing.
}

function beginReDock(own: Owner, state: GolemWindowState): Promise<void> {
  const existing = own.handoffs.get(state.handoff);
  if (existing) return existing;
  const core = own.core;
  if (core === null) {
    failHandoff(own, state, NO_CONNECTION);
    return Promise.resolve();
  }
  const promise = runReDock(own, state, core);
  own.handoffs.set(state.handoff, promise);
  return promise;
}

// ── public surface ───────────────────────────────────────────────────────────

/**
 * Subscribes, bootstraps and returns the teardown. Safe to call twice under
 * StrictMode: the returned function retires its own owner, and a retired
 * owner's core, timers and continuations can no longer touch the store.
 */
export function startGolemSatellite(): () => void {
  const own: Owner = {
    cancelled: false,
    generation: 0,
    instance: 0,
    core: null,
    buffer: [],
    draftsInstalled: false,
    rawView: null,
    handoffs: new Map(),
    queueEdits: new Map(),
  };
  active = own;
  useViewStore.setState(
    { view: null, state: null, frozen: true, pendingComposers: NO_PENDING_COMPOSERS, error: null },
    false,
    'golem/start'
  );

  // Both subscriptions before the call: Go publishes `bootstrapping` and starts
  // relaying main's traffic before the bound response comes back.
  const offMode = EventsOn<unknown>(MODE_EVENT, (payload) => {
    if (own.cancelled || own !== active) return;
    try {
      installState(own, parseGolemWindowState(payload));
    } catch (error) {
      report(own, error);
    }
  });
  const offMessage = EventsOn<unknown>(MESSAGE_EVENT, (payload) => handleMessage(own, payload));

  runBootstrap(own);

  return () => {
    own.cancelled = true;
    if (active === own) active = null;
    own.core?.dispose();
    own.core = null;
    offMode();
    offMessage();
  };
}

/**
 * Sends one action and answers with main's acknowledgement. It refuses at once
 * when there is no live, interactive core — a queued action nobody can post is
 * indistinguishable from a lost one.
 */
function dispatch(action: GolemViewAction, lockId?: string): Promise<GolemAck> {
  const own = active;
  if (own === null || own.cancelled || own.core === null)
    return Promise.reject(new Error(NO_CONNECTION));
  if (useViewStore.getState().frozen) return Promise.reject(new Error(NOT_INTERACTIVE));
  if (lockId === undefined) return own.core.send(action);
  // The lock goes on before the action is enqueued, so a second Send cannot
  // slip in behind an unacknowledged one.
  setPending(own, lockId, true);
  return own.core.send(action).catch((error: unknown) => {
    // A definitive refusal never reached the queue, so the lock comes off with
    // it. An *uncertain* outcome never rejects, and keeps both id and lock.
    setPending(own, lockId, false);
    throw error;
  });
}

function run(action: GolemViewAction, lockId?: string): void {
  const own = active;
  dispatch(action, lockId).then(
    () => undefined,
    (error: unknown) => report(own, error)
  );
}

const ACTIONS: GolemSurfaceActions = {
  send: (conversationId, text) => run({ type: 'send', conversationId, text }, conversationId),
  clear: (conversationId) => run({ type: 'clear', conversationId }, conversationId),
  allowAndSend: (conversationId, runId, challengeId) =>
    run({ type: 'allowAndSend', conversationId, runId, challengeId }),
  cancelRun: (runId) => run({ type: 'cancelRun', runId }),
  retry: (conversationId) => run({ type: 'retry', conversationId }),
  updateQueued: (conversationId, queueId, text) => {
    const own = active;
    if (own !== null && !own.cancelled) {
      own.queueEdits.set(queueId, { text, settledAt: null });
      paintView(own);
    }
    run({ type: 'updateQueued', conversationId, queueId, text });
  },
  removeQueued: (conversationId, queueId) => run({ type: 'removeQueued', conversationId, queueId }),
  select: (conversationId) => run({ type: 'select', conversationId }),
  openConfig: () => run({ type: 'openConfig' }),
};

/** The satellite's `GolemSurfaceActions`. Stable, so a memoized tree stays put. */
export function satelliteActions(): GolemSurfaceActions {
  return ACTIONS;
}

/**
 * Asks Go to move this conversation back to the main window. Go answers with a
 * `closing` snapshot, which is what actually starts the transfer. A refusal is
 * reported rather than thrown: this is a button, not a protocol step.
 */
export function requestReDock(): Promise<void> {
  const own = active;
  return CloseGolemWindow().then(
    () => undefined,
    (error: unknown) => {
      report(own, error);
    }
  );
}

/** The one "Retry connection" control, whichever stage actually failed. */
export function retryGolemConnection(): void {
  const own = active;
  if (own === null || own.cancelled) return;
  const state = useViewStore.getState().state;
  // The same predicate the root disables the control on (retryChangesNothing):
  // keep the reason on screen rather than clearing it for nothing.
  if (own.core !== null && retryChangesNothing(state)) return;
  useViewStore.setState({ error: null }, false, 'golem/retry');
  if (own.core === null) {
    own.generation += 1;
    runBootstrap(own);
    return;
  }
  if (state?.phase === 'closing') {
    // The transfer is over; it is the native close that stalled. The retry
    // for that is Go's own re-arm leg, which CloseGolemWindow reaches.
    void requestReDock();
    return;
  }
  own.core.retryPending();
}
