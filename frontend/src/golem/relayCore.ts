import { boundedGolemMessage, type GolemActionResult } from '../types/golem';
import {
  parseGolemAck,
  parseGolemDraftMap,
  parseGolemView,
  parseGolemViewAction,
  type GolemAck,
  type GolemDraftMap,
  type GolemView,
  type GolemViewAction,
  type GolemWindowEnvelope,
  type GolemWindowMessage,
} from '../types/golemWindow';

/**
 * The transport-agnostic halves of the two-window protocol (#271 spec §5.3).
 *
 * Neither core knows about Wails, React or the Golem store: they own sequence
 * numbers, deduplication, coalescing, retry bounds and the handoff barrier, so
 * all of that is testable without a second window. `RelayTransport.post`
 * resolving means Go accepted the envelope — never that the other JS context
 * processed it, which is why every outcome below waits on a reply instead.
 */
export interface RelayTransport {
  post(message: GolemWindowMessage): Promise<void>;
}

/** A definitive refusal: the sender may act on it. */
export const RELAY_ACTION_REFUSED = 'Golem could not admit the action.';
export const RELAY_ACTION_CONFLICT = 'Golem already answered a different action under that id.';
export const RELAY_UNEXPECTED_MESSAGE = 'Golem received an unexpected window message.';
export const RELAY_STALE_TRANSFER = 'Golem received a draft transfer for a closed handoff.';
export const RELAY_TRANSFER_UNCONFIRMED = 'Golem could not confirm the draft transfer.';
export const RELAY_ACTION_UNCONFIRMED = 'Golem has not confirmed the last action.';
export const RELAY_HANDOFF_IN_PROGRESS = 'Golem is moving this conversation to the other window.';
export const RELAY_DISPOSED = 'The Golem window closed before the relay finished.';

const relayError = (value: unknown): Error => new Error(boundedGolemMessage(value));

const toAck = (id: number, result: GolemActionResult): GolemAck =>
  result.reason === undefined
    ? { id, ok: result.ok }
    : { id, ok: result.ok, reason: result.reason };

// ── Main ─────────────────────────────────────────────────────────────────────

export interface MainRelayDeps {
  instance: number;
  transport: RelayTransport;
  execute(action: GolemViewAction): GolemActionResult | Promise<GolemActionResult>;
  snapshot(): GolemView;
  onDrafts(map: GolemDraftMap): void;
  onError(error: Error): void;
}

export interface MainRelayCore {
  publish(): void;
  sendDrafts(handoff: number, readDrafts: () => GolemDraftMap): Promise<void>;
  receive(envelope: GolemWindowEnvelope): Promise<void>;
  dispose(): void;
}

interface OutboundTransfer {
  id: number;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  message: GolemWindowMessage | null;
  settled: boolean;
}

export function createMainRelayCore(deps: MainRelayDeps): MainRelayCore {
  let disposed = false;
  let revision = 0;
  /** Highest settled satellite action id; stamped onto every projection. */
  let watermark = 0;
  let highestActionId = 0;
  let outboundId = 0;
  let posting = false;
  let dirty = false;
  let tailPost: Promise<void> = Promise.resolve();
  /** Serializes admissions, and doubles as the drain before a draft read. */
  let admissionTail: Promise<void> = Promise.resolve();

  const settledAcks = new Map<number, Promise<GolemWindowMessage>>();
  const actionBodies = new Map<number, string>();
  const inboundClaimed = new Set<string>();
  const inboundAcks = new Map<string, GolemWindowMessage>();
  const transfers = new Map<number, OutboundTransfer>();
  let highestInboundHandoff = 0;

  const report = (value: unknown): void => {
    if (!disposed) deps.onError(relayError(value));
  };

  function viewMessage(rev: number): GolemWindowMessage {
    return {
      kind: 'view',
      instance: deps.instance,
      id: 0,
      revision: rev,
      handoff: 0,
      payload: { ...deps.snapshot(), processedThrough: watermark },
    };
  }

  /** Coalesced background publication: at most one post is ever in flight. */
  function schedulePublish(): void {
    if (disposed || posting || !dirty) return;
    posting = true;
    dirty = false;
    tailPost = deps.transport.post(viewMessage(++revision)).then(
      () => {
        posting = false;
        schedulePublish();
      },
      (error: unknown) => {
        // Retain the newest snapshot and wait for the next arrival: an
        // immediate retry here would spin against a window that just died.
        posting = false;
        report(error);
      }
    );
  }

  function publish(): void {
    dirty = true;
    schedulePublish();
  }

  /**
   * Posts one projection that provably carries the current watermark, waiting
   * out any coalesced post first, and answers with the revision it stamped.
   */
  async function publishForAck(): Promise<number> {
    while (posting) await tailPost;
    if (disposed) return revision;
    posting = true;
    dirty = false;
    const rev = ++revision;
    const done = deps.transport.post(viewMessage(rev)).then(
      () => {
        posting = false;
        schedulePublish();
      },
      (error: unknown) => {
        posting = false;
        report(error);
      }
    );
    tailPost = done;
    await done;
    return rev;
  }

  /**
   * Executes an action at most once per id for the lifetime of the instance.
   * The in-flight promise is recorded before the queued callback can run, so a
   * duplicate delivered mid-execution reuses it instead of racing a second one.
   */
  function settleAction(id: number, action: GolemViewAction): Promise<GolemWindowMessage> {
    const previous = settledAcks.get(id);
    if (previous) return previous;
    const settled = admissionTail
      .then(async () => toAck(id, await deps.execute(action)))
      .catch((): GolemAck => ({ id, ok: false, reason: RELAY_ACTION_REFUSED }))
      .then(async (ack): Promise<GolemWindowMessage> => {
        // Settled either way: the next projection covers this id, so the
        // satellite may drop its pending overlay once it sees the watermark.
        if (id > watermark) watermark = id;
        const rev = await publishForAck();
        return {
          kind: 'ack',
          instance: deps.instance,
          id,
          revision: rev,
          handoff: 0,
          payload: ack,
        };
      });
    settledAcks.set(id, settled);
    admissionTail = settled.then(
      () => undefined,
      () => undefined
    );
    return settled;
  }

  const refusalMessage = (id: number, handoff: number, reason: string): GolemWindowMessage => ({
    kind: 'ack',
    instance: deps.instance,
    id,
    revision,
    handoff,
    payload: { id, ok: false, reason },
  });

  async function postRefusal(id: number, handoff: number, reason: string): Promise<void> {
    await deps.transport.post(refusalMessage(id, handoff, reason)).catch(report);
  }

  async function receiveAction(message: GolemWindowMessage): Promise<void> {
    const { id } = message;
    if (id === 0) {
      report(RELAY_UNEXPECTED_MESSAGE);
      return;
    }
    const body = JSON.stringify(message.payload);
    const known = settledAcks.has(id);
    if (known) {
      if (actionBodies.get(id) !== body) {
        await postRefusal(id, 0, RELAY_ACTION_CONFLICT);
        return;
      }
    } else if (id <= highestActionId) {
      // An unseen id below the watermark is a replayed or forged sequence.
      await postRefusal(id, 0, RELAY_ACTION_CONFLICT);
      return;
    }

    let action: GolemViewAction;
    try {
      action = parseGolemViewAction(message.payload);
    } catch {
      // Definitive, so the satellite's waiter settles instead of hanging. The
      // refusal is recorded like any other settled ack: a lost-ack retry of the
      // same body must replay it, not collide with the id watermark this branch
      // just advanced.
      const settled =
        settledAcks.get(id) ?? Promise.resolve(refusalMessage(id, 0, RELAY_ACTION_REFUSED));
      if (!known) {
        highestActionId = Math.max(highestActionId, id);
        actionBodies.set(id, body);
        settledAcks.set(id, settled);
      }
      await deps.transport.post(await settled).catch(report);
      return;
    }
    if (!known) {
      highestActionId = Math.max(highestActionId, id);
      actionBodies.set(id, body);
    }
    // Synchronous up to here: a duplicate delivered in the same tick finds the
    // recorded promise rather than starting a second execution.
    const ackMessage = await settleAction(id, action);
    if (disposed) return;
    await deps.transport.post(ackMessage).catch(report);
  }

  async function receiveDrafts(message: GolemWindowMessage): Promise<void> {
    if (message.id === 0) {
      report(RELAY_UNEXPECTED_MESSAGE);
      return;
    }
    const key = `${message.handoff}:${message.id}`;
    const done = inboundAcks.get(key);
    if (done) {
      await deps.transport.post(done).catch(report);
      return;
    }
    if (inboundClaimed.has(key)) return; // still installing; one response only
    if (message.handoff < highestInboundHandoff) {
      report(RELAY_STALE_TRANSFER);
      return;
    }
    let map: GolemDraftMap;
    try {
      map = parseGolemDraftMap(message.payload);
    } catch {
      await postRefusal(message.id, message.handoff, RELAY_TRANSFER_UNCONFIRMED);
      return;
    }
    inboundClaimed.add(key);
    highestInboundHandoff = message.handoff;
    await admissionTail;
    if (disposed) return;
    deps.onDrafts(map);
    const ackMessage: GolemWindowMessage = {
      kind: 'ack',
      instance: deps.instance,
      id: message.id,
      revision,
      handoff: message.handoff,
      payload: { id: message.id, ok: true },
    };
    inboundAcks.set(key, ackMessage);
    await deps.transport.post(ackMessage).catch(report);
  }

  function receiveReady(message: GolemWindowMessage): void {
    const transfer = transfers.get(message.handoff);
    if (!transfer || transfer.id !== message.id) {
      report(RELAY_STALE_TRANSFER);
      return;
    }
    transfer.settled = true;
    transfer.resolve();
  }

  async function receive(envelope: GolemWindowEnvelope): Promise<void> {
    if (disposed) return;
    const { from, message } = envelope;
    if (from !== 'satellite' || message.instance !== deps.instance) {
      report(RELAY_UNEXPECTED_MESSAGE);
      return;
    }
    switch (message.kind) {
      case 'action':
        return receiveAction(message);
      case 'drafts':
        return receiveDrafts(message);
      case 'ready':
        return receiveReady(message);
      case 'ack':
        return; // main waits on `ready`, never on a satellite ack
      case 'abort':
        return; // a legal kind from either role; B5/B6 own the abort handshake
      default:
        report(RELAY_UNEXPECTED_MESSAGE);
    }
  }

  async function sendDrafts(handoff: number, readDrafts: () => GolemDraftMap): Promise<void> {
    if (disposed) throw relayError(RELAY_DISPOSED);
    const existing = transfers.get(handoff);
    if (existing) {
      // A retry reuses (instance, handoff, id) so the receiver installs once.
      if (existing.message && !existing.settled)
        await deps.transport.post(existing.message).catch(report);
      return existing.promise;
    }
    const id = ++outboundId;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const transfer: OutboundTransfer = {
      id,
      promise,
      resolve,
      reject,
      message: null,
      settled: false,
    };
    transfers.set(handoff, transfer);

    // The docked host's admission barrier: a Send that clears its own draft
    // must have run before the final map is read.
    await admissionTail;
    if (disposed) {
      transfer.settled = true;
      reject(relayError(RELAY_DISPOSED));
      return promise;
    }
    transfer.message = {
      kind: 'drafts',
      instance: deps.instance,
      id,
      revision,
      handoff,
      payload: readDrafts(),
    };
    await deps.transport.post(transfer.message).catch((error: unknown) => {
      report(error);
    });
    return promise;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const transfer of transfers.values()) {
      if (transfer.settled) continue;
      transfer.settled = true;
      transfer.reject(relayError(RELAY_DISPOSED));
    }
  }

  return { publish, sendDrafts, receive, dispose };
}

// ── Satellite ────────────────────────────────────────────────────────────────

export interface SatelliteDeps {
  instance: number;
  transport: RelayTransport;
  ackTimeoutMs: number;
  maxAttempts: number;
  onView(view: GolemView): void;
  /** Host clear/unlock runs here, before the queue advances. */
  onAdmission(action: GolemViewAction, ack: GolemAck): void;
  /**
   * A transferred draft map, with the (handoff, id) the host must quote back
   * through `ready` once it has installed it.
   */
  onDrafts(map: GolemDraftMap, handoff: number, id: number): void;
  onError(error: Error): void;
}

export interface SatelliteCore {
  send(action: GolemViewAction): Promise<GolemAck>;
  installBootstrap(view: GolemView | null, revision: number): void;
  receive(envelope: GolemWindowEnvelope): void;
  beginHandoff(handoff: number, readDrafts: () => GolemDraftMap): Promise<void>;
  /**
   * Ends a transfer this window can no longer complete — main aborted the
   * transition, or Go's own deadline expired and it handed the window back.
   * The waiter rejects with `reason`, its retry timer stops, and the input
   * barrier the handoff raised comes down whether or not the transfer had
   * already settled: either way nothing is waiting on it any more. A handoff
   * this core never started changes nothing.
   */
  abortHandoff(handoff: number, reason: string): void;
  ready(handoff: number, draftID: number): Promise<void>;
  retryPending(): void;
  dispose(): void;
}

interface PendingAction {
  id: number;
  action: GolemViewAction;
  message: GolemWindowMessage;
  resolve(ack: GolemAck): void;
  reject(error: Error): void;
  promise: Promise<GolemAck>;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  posted: boolean;
}

interface Handoff {
  id: number;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  message: GolemWindowMessage | null;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export function createSatelliteCore(deps: SatelliteDeps): SatelliteCore {
  let disposed = false;
  let blocked = false;
  let nextId = 0;
  let viewRevision = 0;
  let highestHandoff = 0;
  const queue: PendingAction[] = [];
  /** Every action id this window has already settled, for late duplicate acks. */
  const settledActions = new Set<number>();
  const handoffs = new Map<number, Handoff>();
  const installed = new Map<string, GolemWindowMessage | null>();
  /**
   * A transfer that arrived before the first projection. `ready` may not be
   * posted without a view revision to quote, so the install waits rather than
   * claiming its key: claiming it would make main's retry replay a response
   * that does not exist yet, and nothing would ever re-arm `ready`.
   */
  let deferredDrafts: GolemWindowMessage | null = null;

  const report = (value: unknown): void => {
    if (!disposed) deps.onError(relayError(value));
  };

  const clearTimer = (entry: { timer: ReturnType<typeof setTimeout> | null }): void => {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  };

  // ── Actions ──

  function armActionTimer(entry: PendingAction): void {
    if (disposed) return;
    clearTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (disposed || queue[0] !== entry) return;
      if (entry.attempts >= deps.maxAttempts) {
        // Uncertain, not refused: keep the envelope, the id and the input, and
        // stop the timers so a dead window cannot spin forever.
        report(RELAY_ACTION_UNCONFIRMED);
        return;
      }
      entry.attempts += 1;
      postAction(entry);
    }, deps.ackTimeoutMs);
  }

  function postAction(entry: PendingAction): void {
    void deps.transport.post(entry.message).then(
      () => armActionTimer(entry),
      (error: unknown) => {
        entry.posted = false;
        report(error);
      }
    );
  }

  function pumpQueue(): void {
    if (disposed) return;
    const head = queue[0];
    if (!head || head.posted) return;
    head.posted = true;
    head.attempts = 1;
    postAction(head);
  }

  function send(action: GolemViewAction): Promise<GolemAck> {
    if (disposed) return Promise.reject(relayError(RELAY_DISPOSED));
    if (blocked) return Promise.reject(relayError(RELAY_HANDOFF_IN_PROGRESS));
    const id = ++nextId;
    let resolve!: (ack: GolemAck) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<GolemAck>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    queue.push({
      id,
      action,
      message: {
        kind: 'action',
        instance: deps.instance,
        id,
        revision: viewRevision,
        handoff: 0,
        payload: action,
      },
      resolve,
      reject,
      promise,
      attempts: 0,
      timer: null,
      posted: false,
    });
    pumpQueue();
    return promise;
  }

  function settleAction(ack: GolemAck): void {
    const index = queue.findIndex((entry) => entry.id === ack.id);
    if (index === -1) {
      // Main re-acks a replayed action with the same stored message, so a
      // first ack that was merely slow arrives after the retry settled the id.
      // Only an id this window never issued is genuinely unexpected.
      if (!settledActions.has(ack.id)) report(RELAY_UNEXPECTED_MESSAGE);
      return;
    }
    const [entry] = queue.splice(index, 1);
    settledActions.add(entry.id);
    clearTimer(entry);
    // The host clears/unlocks its composer before the next action goes out.
    deps.onAdmission(entry.action, ack);
    entry.resolve(ack);
    pumpQueue();
  }

  function retryPending(): void {
    const head = queue[0];
    if (!head || disposed) return;
    clearTimer(head);
    head.posted = true;
    head.attempts = 1;
    postAction(head);
  }

  // ── Views ──

  function applyView(view: GolemView, revision: number): void {
    if (disposed || revision <= viewRevision) return;
    const first = viewRevision === 0;
    viewRevision = revision;
    // Take the held transfer before the host runs: a throwing onView must not
    // strand it in a slot the `first` guard can never revisit.
    const pending = first ? deferredDrafts : null;
    deferredDrafts = null;
    deps.onView(view);
    if (pending !== null) receiveDrafts(pending);
  }

  function installBootstrap(view: GolemView | null, revision: number): void {
    if (disposed) return;
    // A null, revision-zero bootstrap says main has never published; it can
    // never erase a live projection that already arrived.
    if (view === null) return;
    applyView(view, revision);
  }

  // ── Draft transfer, satellite → main ──

  function armHandoffTimer(entry: Handoff): void {
    if (disposed || entry.message === null) return;
    clearTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (disposed || entry.settled || entry.message === null) return;
      if (entry.attempts >= deps.maxAttempts) {
        // Never resolves: an unconfirmed transfer must not permit the close.
        report(RELAY_TRANSFER_UNCONFIRMED);
        return;
      }
      entry.attempts += 1;
      postHandoff(entry);
    }, deps.ackTimeoutMs);
  }

  function postHandoff(entry: Handoff): void {
    if (entry.message === null) return;
    void deps.transport.post(entry.message).then(
      () => armHandoffTimer(entry),
      (error: unknown) => report(error)
    );
  }

  function beginHandoff(handoff: number, readDrafts: () => GolemDraftMap): Promise<void> {
    const existing = handoffs.get(handoff);
    if (existing) return existing.promise;
    // Synchronous: no further action may enter the queue from this point.
    blocked = true;
    const id = ++nextId;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Handoff = {
      id,
      promise,
      resolve,
      reject,
      message: null,
      attempts: 0,
      timer: null,
      settled: false,
    };
    handoffs.set(handoff, entry);

    const draining = queue.map((pending) => pending.promise);
    void Promise.all(draining).then(
      () => {
        if (disposed || entry.settled) return;
        // Read after the drain: an admitted Send has already cleared its draft.
        entry.message = {
          kind: 'drafts',
          instance: deps.instance,
          id,
          revision: viewRevision,
          handoff,
          payload: readDrafts(),
        };
        entry.attempts = 1;
        postHandoff(entry);
      },
      (error: unknown) => {
        if (entry.settled) return;
        entry.settled = true;
        blocked = false;
        reject(relayError(error));
      }
    );
    return promise;
  }

  function settleHandoff(message: GolemWindowMessage, ack: GolemAck): void {
    const entry = handoffs.get(message.handoff);
    if (!entry || entry.id !== ack.id || entry.settled) {
      report(RELAY_STALE_TRANSFER);
      return;
    }
    clearTimer(entry);
    entry.settled = true;
    if (ack.ok) {
      entry.resolve();
      return;
    }
    // Refused: restore safe interaction in the source window; the host keeps
    // any composer whose Send is still unresolved locked on its own.
    blocked = false;
    entry.reject(relayError(ack.reason ?? RELAY_TRANSFER_UNCONFIRMED));
  }

  function abortHandoff(handoff: number, reason: string): void {
    const entry = handoffs.get(handoff);
    if (!entry) return;
    // The transition is over either way — a resolved transfer whose close was
    // then refused is just as dead as an unanswered one — so the barrier comes
    // down first and unconditionally.
    blocked = false;
    if (entry.settled) return;
    clearTimer(entry);
    entry.settled = true;
    entry.reject(relayError(reason));
  }

  // ── Draft transfer, main → satellite ──

  function receiveDrafts(message: GolemWindowMessage): void {
    if (message.id === 0) {
      report(RELAY_UNEXPECTED_MESSAGE);
      return;
    }
    const key = `${message.handoff}:${message.id}`;
    if (installed.has(key)) {
      // Replay the response rather than installing over post-handoff typing.
      const readyMessage = installed.get(key);
      if (readyMessage) void deps.transport.post(readyMessage).catch(report);
      return;
    }
    if (message.handoff < highestHandoff) {
      report(RELAY_STALE_TRANSFER);
      return;
    }
    let map: GolemDraftMap;
    try {
      map = parseGolemDraftMap(message.payload);
    } catch (error) {
      report(error);
      return;
    }
    if (viewRevision === 0) {
      // No projection yet, so `ready` has no revision to quote: hold the
      // transfer — and its key — until the first view arrives. A retry of the
      // same transfer simply replaces its own held message; an older handoff
      // never displaces a newer one.
      if (deferredDrafts === null || message.handoff >= deferredDrafts.handoff) {
        deferredDrafts = message;
      }
      return;
    }
    highestHandoff = message.handoff;
    installed.set(key, null);
    deps.onDrafts(map, message.handoff, message.id);
  }

  async function ready(handoff: number, draftID: number): Promise<void> {
    if (disposed) throw relayError(RELAY_DISPOSED);
    const key = `${handoff}:${draftID}`;
    if (!installed.has(key)) {
      // Ready is only truthful once a complete draft map has been installed.
      report(RELAY_STALE_TRANSFER);
      throw relayError(RELAY_STALE_TRANSFER);
    }
    if (viewRevision === 0) {
      report(RELAY_STALE_TRANSFER);
      throw relayError(RELAY_STALE_TRANSFER);
    }
    const message: GolemWindowMessage = {
      kind: 'ready',
      instance: deps.instance,
      id: draftID,
      revision: viewRevision,
      handoff,
      payload: null,
    };
    installed.set(key, message);
    await deps.transport.post(message);
  }

  function receive(envelope: GolemWindowEnvelope): void {
    if (disposed) return;
    const { from, message } = envelope;
    if (from !== 'main' || message.instance !== deps.instance) {
      report(RELAY_UNEXPECTED_MESSAGE);
      return;
    }
    switch (message.kind) {
      case 'view': {
        try {
          applyView(parseGolemView(message.payload), message.revision);
        } catch (error) {
          report(error);
        }
        return;
      }
      case 'ack': {
        let ack: GolemAck;
        try {
          ack = parseGolemAck(message.payload);
        } catch (error) {
          report(error);
          return;
        }
        if (message.handoff === 0) settleAction(ack);
        else settleHandoff(message, ack);
        return;
      }
      case 'drafts':
        receiveDrafts(message);
        return;
      case 'abort':
        return; // a legal kind from either role; B5/B6 own the abort handshake
      default:
        report(RELAY_UNEXPECTED_MESSAGE);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const entry of queue.splice(0)) {
      clearTimer(entry);
      entry.reject(relayError(RELAY_DISPOSED));
    }
    for (const entry of handoffs.values()) {
      clearTimer(entry);
      if (entry.settled) continue;
      entry.settled = true;
      entry.reject(relayError(RELAY_DISPOSED));
    }
  }

  return {
    send,
    installBootstrap,
    receive,
    beginHandoff,
    abortHandoff,
    ready,
    retryPending,
    dispose,
  };
}
