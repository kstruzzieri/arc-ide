/**
 * Task B5 — the satellite window's relay client.
 *
 * Everything here is about ORDER: Go emits `bootstrapped` before the bound
 * `BootstrapGolemWindow` response reaches JS, React StrictMode starts and stops
 * the satellite twice, and a re-dock can land while a Send is still in flight.
 * The transport and the lifecycle are mocked; `relayCore` is the real thing.
 */

import type { GolemSurfaceActions } from '../../components/Golem/GolemSurface';
import type {
  GolemView,
  GolemWindowBootstrap,
  GolemWindowMessage,
  GolemWindowState,
  ProjectedConversation,
} from '../../types/golemWindow';

const bootstrapMock = jest.fn();
const postMock = jest.fn();
const closeMock = jest.fn();
const confirmMock = jest.fn();

jest.mock('../../wails/bindings', () => ({
  BootstrapGolemWindow: (...args: unknown[]) => bootstrapMock(...args),
  PostGolemWindowMessage: (...args: unknown[]) => postMock(...args),
  CloseGolemWindow: (...args: unknown[]) => closeMock(...args),
  ConfirmGolemWindowClose: (...args: unknown[]) => confirmMock(...args),
}));

const listeners = new Map<string, (payload: unknown) => void>();
jest.mock('../../wails/runtime', () => ({
  EventsOn: (name: string, cb: (payload: unknown) => void) => {
    listeners.set(name, cb);
    return () => {
      if (listeners.get(name) === cb) listeners.delete(name);
    };
  },
}));

import { useDraftStore } from '../../golem/draftStore';
import { useViewStore } from '../../golem/viewStore';
import {
  requestReDock,
  retryGolemConnection,
  satelliteActions,
  startGolemSatellite,
  GOLEM_TRANSITION_DEADLINE_MS,
  SATELLITE_ACK_TIMEOUT_MS,
  SATELLITE_MAX_ATTEMPTS,
  SATELLITE_STARTUP_BUFFER,
} from '../../golem/windowSatellite';

const MODE_EVENT = 'golem:window-mode';
const MESSAGE_EVENT = 'golem:window-message';

const identity = (conversationId: string) => ({
  repoEpoch: 7,
  workspaceId: 'frontend',
  conversationId,
});

function conversation(conversationId: string, label: string): ProjectedConversation {
  return {
    identity: identity(conversationId),
    workspaceLabel: label,
    available: true,
    needsConsent: false,
    warnings: [],
    initError: null,
    destination: null,
    activeRunId: null,
    queuedTurns: [],
    transcript: [],
    runs: {},
    pendingConsentTurn: null,
    lastFailedTurn: false,
  };
}

function viewOf(overrides: Partial<GolemView> = {}): GolemView {
  return {
    bridgePhase: 'ready',
    bridgeError: null,
    hydratedIdentity: identity('conv-a'),
    selectedConversationId: 'conv-a',
    composerFocusRevision: 0,
    processedThrough: 0,
    conversations: {
      'conv-a': conversation('conv-a', 'Frontend'),
      'conv-b': conversation('conv-b', 'Backend'),
    },
    ...overrides,
  };
}

function stateOf(overrides: Partial<GolemWindowState> = {}): GolemWindowState {
  return {
    mode: 'undocked',
    phase: 'bootstrapped',
    instance: 1,
    restorePending: false,
    stateRevision: 2,
    handoff: 1,
    ...overrides,
  };
}

const fromMain = (message: GolemWindowMessage) => ({ from: 'main', message });

const viewMessage = (revision: number, view: GolemView = viewOf(), instance = 1) =>
  fromMain({ kind: 'view', instance, id: 0, revision, handoff: 0, payload: view });

const draftsMessage = (
  id: number,
  handoff: number,
  payload: Record<string, string>,
  instance = 1
) => fromMain({ kind: 'drafts', instance, id, revision: 0, handoff, payload });

const ackMessage = (id: number, ok: boolean, reason?: string, instance = 1) =>
  fromMain({
    kind: 'ack',
    instance,
    id,
    revision: 0,
    handoff: 0,
    payload: reason === undefined ? { id, ok } : { id, ok, reason },
  });

const transferAck = (id: number, handoff: number, ok = true, instance = 1) =>
  fromMain({ kind: 'ack', instance, id, revision: 0, handoff, payload: { id, ok } });

const abortMessage = (handoff: number, reason: string, instance = 1) =>
  fromMain({ kind: 'abort', instance, id: 0, revision: 0, handoff, payload: { reason } });

function bootstrapOf(overrides: Partial<GolemWindowBootstrap> = {}): GolemWindowBootstrap {
  return { state: stateOf(), view: null, revision: 0, ...overrides };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emitMode = (state: GolemWindowState) => listeners.get(MODE_EVENT)?.(state);
const emitMessage = (envelope: unknown) => listeners.get(MESSAGE_EVENT)?.(envelope);

/** Drains the microtask queue the relay's promise chains run on. */
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

const posted = (kind: string): GolemWindowMessage[] =>
  postMock.mock.calls.map(([m]) => m as GolemWindowMessage).filter((m) => m.kind === kind);

let actions: GolemSurfaceActions;

beforeEach(() => {
  jest.useFakeTimers();
  listeners.clear();
  bootstrapMock.mockReset();
  postMock.mockReset().mockImplementation(() => Promise.resolve());
  closeMock.mockReset().mockImplementation(() => Promise.resolve());
  confirmMock.mockReset().mockImplementation(() => Promise.resolve());
  useDraftStore.setState({ drafts: {} });
  useViewStore.setState({
    view: null,
    state: null,
    frozen: true,
    pendingComposers: new Set<string>(),
    error: null,
  });
  actions = satelliteActions();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

/** Starts, feeds a bootstrap plus a transfer, and drives Go to `ready`. */
async function startReady(): Promise<() => void> {
  bootstrapMock.mockReturnValue(Promise.resolve(bootstrapOf({ view: viewOf(), revision: 4 })));
  const stop = startGolemSatellite();
  await flush();
  emitMessage(draftsMessage(9, 1, {}));
  await flush();
  emitMode(stateOf({ phase: 'ready', stateRevision: 3 }));
  await flush();
  return stop;
}

/**
 * The retry bounds are not free parameters: Go restores `ready` on its own
 * deadline (`golemTransitionDeadline`), and a verdict that landed after that
 * would explain a transition the user has already been handed back.
 */
it('spends every transfer retry before Go abandons the transition', () => {
  expect(SATELLITE_ACK_TIMEOUT_MS * SATELLITE_MAX_ATTEMPTS).toBeLessThan(
    GOLEM_TRANSITION_DEADLINE_MS
  );
});

describe('startup ordering', () => {
  it('installs a live view and drafts that arrive before the bootstrap response', async () => {
    const boot = deferred<GolemWindowBootstrap>();
    bootstrapMock.mockReturnValue(boot.promise);

    const stop = startGolemSatellite();
    // Go emits `bootstrapped` and relays main's opening traffic before the
    // bound call's own response makes it back to this window.
    emitMode(stateOf());
    emitMessage(viewMessage(6, viewOf({ composerFocusRevision: 3 })));
    emitMessage(draftsMessage(11, 1, { 'conv-a': 'held text' }));
    await flush();

    expect(useViewStore.getState().view).toBeNull();
    expect(posted('ready')).toHaveLength(0);

    boot.resolve(bootstrapOf({ view: viewOf(), revision: 4 }));
    await flush();

    // The higher revision wins, whichever route delivered it.
    expect(useViewStore.getState().view?.composerFocusRevision).toBe(3);
    expect(useDraftStore.getState().drafts).toEqual({ 'conv-a': 'held text' });
    const ready = posted('ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ instance: 1, id: 11, handoff: 1 });
    stop();
  });

  it('keeps the bootstrap view when it is newer than the live one', async () => {
    const boot = deferred<GolemWindowBootstrap>();
    bootstrapMock.mockReturnValue(boot.promise);
    const stop = startGolemSatellite();
    emitMessage(viewMessage(2, viewOf({ composerFocusRevision: 1 })));
    await flush();
    boot.resolve(bootstrapOf({ view: viewOf({ composerFocusRevision: 9 }), revision: 5 }));
    await flush();
    expect(useViewStore.getState().view?.composerFocusRevision).toBe(9);
    stop();
  });

  it('stays frozen with a null bootstrap view until the first projection lands', async () => {
    bootstrapMock.mockReturnValue(Promise.resolve(bootstrapOf({ view: null, revision: 0 })));
    const stop = startGolemSatellite();
    await flush();
    emitMessage(draftsMessage(3, 1, {}));
    await flush();

    // No projection: `ready` would be a lie, so nothing is posted and the
    // window cannot leave its loading state.
    expect(posted('ready')).toHaveLength(0);
    expect(useViewStore.getState().view).toBeNull();
    expect(useViewStore.getState().frozen).toBe(true);
    stop();
  });

  it('accepts an unbound first view and still runs window controls', async () => {
    bootstrapMock.mockReturnValue(
      Promise.resolve(
        bootstrapOf({
          view: viewOf({
            bridgePhase: 'unbound',
            bridgeError: null,
            hydratedIdentity: null,
            selectedConversationId: null,
            conversations: {},
          }),
          revision: 1,
        })
      )
    );
    const stop = startGolemSatellite();
    await flush();
    emitMessage(draftsMessage(2, 1, {}));
    await flush();
    emitMode(stateOf({ phase: 'ready', stateRevision: 3 }));
    await flush();

    expect(useViewStore.getState().view?.bridgePhase).toBe('unbound');
    expect(useViewStore.getState().frozen).toBe(false);

    actions.openConfig();
    await flush();
    expect(posted('action')[0]).toMatchObject({ payload: { type: 'openConfig' } });

    await requestReDock();
    expect(closeMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('fails the bootstrap and aborts when the startup buffer overflows', async () => {
    const boot = deferred<GolemWindowBootstrap>();
    bootstrapMock.mockReturnValue(boot.promise);
    const stop = startGolemSatellite();
    emitMode(stateOf());
    // Transfers, not projections: dropping one of these would drop a draft map,
    // so they are exactly what the bound exists for and what cannot coalesce.
    for (let i = 0; i <= SATELLITE_STARTUP_BUFFER; i += 1) emitMessage(draftsMessage(i + 1, 1, {}));
    await flush();

    expect(useViewStore.getState().error).not.toBeNull();
    const aborts = posted('abort');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({ instance: 1, handoff: 1 });
    boot.resolve(bootstrapOf({ view: viewOf(), revision: 1 }));
    await flush();
    // A resolution that arrives after the failure cannot quietly revive it.
    expect(useViewStore.getState().view).toBeNull();
    stop();
  });

  it('coalesces superseded projections instead of overflowing the buffer', async () => {
    const boot = deferred<GolemWindowBootstrap>();
    bootstrapMock.mockReturnValue(boot.promise);
    const stop = startGolemSatellite();
    emitMode(stateOf());
    // Only the newest projection can ever be installed, so a burst of them must
    // not consume the room the buffer holds for a draft transfer.
    for (let i = 0; i <= SATELLITE_STARTUP_BUFFER; i += 1)
      emitMessage(viewMessage(i + 1, viewOf({ composerFocusRevision: i + 1 })));
    emitMessage(draftsMessage(7, 1, { 'conv-a': 'held text' }));
    await flush();
    expect(posted('abort')).toHaveLength(0);

    boot.resolve(bootstrapOf({ view: viewOf(), revision: 1 }));
    await flush();

    expect(useViewStore.getState().error).toBeNull();
    expect(useViewStore.getState().view?.composerFocusRevision).toBe(SATELLITE_STARTUP_BUFFER + 1);
    expect(useDraftStore.getState().drafts).toEqual({ 'conv-a': 'held text' });
    expect(posted('ready')).toHaveLength(1);
    stop();
  });

  it('reports a bootstrap rejection and retries on demand', async () => {
    bootstrapMock.mockReturnValueOnce(Promise.reject(new Error('no live window')));
    const stop = startGolemSatellite();
    await flush();
    expect(useViewStore.getState().error).toContain('no live window');

    bootstrapMock.mockReturnValueOnce(
      Promise.resolve(bootstrapOf({ view: viewOf(), revision: 2 }))
    );
    retryGolemConnection();
    await flush();
    expect(useViewStore.getState().error).toBeNull();
    expect(useViewStore.getState().view).not.toBeNull();
    stop();
  });
});

describe('StrictMode double start', () => {
  it('lets only the active owner write state', async () => {
    const first = deferred<GolemWindowBootstrap>();
    bootstrapMock.mockReturnValueOnce(first.promise);
    const stopFirst = startGolemSatellite();
    stopFirst();

    bootstrapMock.mockReturnValueOnce(
      Promise.resolve(bootstrapOf({ state: stateOf({ instance: 2 }), view: viewOf(), revision: 3 }))
    );
    const stopSecond = startGolemSatellite();
    await flush();
    emitMessage(draftsMessage(1, 1, { 'conv-a': 'second' }, 2));
    await flush();

    // The retired attempt resolves last and must change nothing.
    first.resolve(
      bootstrapOf({
        state: stateOf({ instance: 1, stateRevision: 99 }),
        view: viewOf({ composerFocusRevision: 42 }),
        revision: 90,
      })
    );
    await flush();

    expect(useViewStore.getState().state?.instance).toBe(2);
    expect(useViewStore.getState().view?.composerFocusRevision).toBe(0);
    expect(useDraftStore.getState().drafts).toEqual({ 'conv-a': 'second' });
    expect(posted('ready').every((m) => m.instance === 2)).toBe(true);
    stopSecond();
  });

  it('drops the retired owner listeners and timers', async () => {
    const stop = await startReady();
    // An unacknowledged action, so the retired owner really does leave a retry
    // timer behind for the teardown to cancel.
    actions.send('conv-a', 'hello');
    await flush();
    expect(posted('action')).toHaveLength(1);

    stop();
    expect(listeners.size).toBe(0);
    const before = postMock.mock.calls.length;
    jest.advanceTimersByTime(SATELLITE_ACK_TIMEOUT_MS * (SATELLITE_MAX_ATTEMPTS + 2));
    await flush();
    expect(postMock.mock.calls.length).toBe(before);
  });

  it('installs a repeated transfer once and replays its ready', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'typed after the transfer');
    emitMessage(draftsMessage(9, 1, { 'conv-a': 'stale' }));
    await flush();
    expect(useDraftStore.getState().drafts['conv-a']).toBe('typed after the transfer');
    expect(posted('ready')).toHaveLength(2);
    expect(posted('ready')[1]).toMatchObject({ id: 9, handoff: 1 });
    stop();
  });

  it('ignores a stale stateRevision', async () => {
    const stop = await startReady();
    expect(useViewStore.getState().frozen).toBe(false);
    emitMode(stateOf({ phase: 'bootstrapped', stateRevision: 1 }));
    await flush();
    expect(useViewStore.getState().state?.phase).toBe('ready');
    expect(useViewStore.getState().frozen).toBe(false);
    stop();
  });

  it('refuses a drafts transfer from an older handoff', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'mine');
    emitMessage(draftsMessage(4, 0, { 'conv-a': 'forged' }));
    await flush();
    expect(useDraftStore.getState().drafts['conv-a']).toBe('mine');
    expect(useViewStore.getState().error).not.toBeNull();
    stop();
  });
});

describe('acknowledged actions', () => {
  it('clears only the accepted conversation draft', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'hello');
    useDraftStore.getState().setDraft('conv-b', 'keep me');

    actions.send('conv-a', 'hello');
    await flush();
    expect(useViewStore.getState().pendingComposers.has('conv-a')).toBe(true);
    const action = posted('action')[0];
    emitMessage(ackMessage(action.id, true));
    await flush();

    expect(useDraftStore.getState().drafts['conv-a']).toBe('');
    expect(useDraftStore.getState().drafts['conv-b']).toBe('keep me');
    expect(useViewStore.getState().pendingComposers.has('conv-a')).toBe(false);
    stop();
  });

  it('retains the draft and shows the reason on a refusal', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'hello');
    actions.send('conv-a', 'hello');
    await flush();
    emitMessage(ackMessage(posted('action')[0].id, false, 'Golem is busy.'));
    await flush();

    expect(useDraftStore.getState().drafts['conv-a']).toBe('hello');
    expect(useViewStore.getState().pendingComposers.has('conv-a')).toBe(false);
    expect(useViewStore.getState().error).toBe('Golem is busy.');
    stop();
  });

  it('keeps the lock and offers a retry when the acknowledgement never comes', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'hello');
    actions.send('conv-a', 'hello');
    await flush();
    for (let i = 0; i <= SATELLITE_MAX_ATTEMPTS; i += 1) {
      jest.advanceTimersByTime(SATELLITE_ACK_TIMEOUT_MS);
      await flush();
    }
    expect(useViewStore.getState().pendingComposers.has('conv-a')).toBe(true);
    expect(useDraftStore.getState().drafts['conv-a']).toBe('hello');
    expect(useViewStore.getState().error).not.toBeNull();

    const before = posted('action').length;
    retryGolemConnection();
    await flush();
    expect(posted('action').length).toBeGreaterThan(before);
    expect(useViewStore.getState().error).toBeNull();
    stop();
  });

  it('cannot clear text typed into a conversation selected after the send', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'hello');
    actions.send('conv-a', 'hello');
    await flush();
    useDraftStore.getState().setDraft('conv-b', 'brand new');
    emitMessage(ackMessage(posted('action')[0].id, true));
    await flush();
    expect(useDraftStore.getState().drafts['conv-b']).toBe('brand new');
    stop();
  });

  it('refuses every action while frozen', async () => {
    bootstrapMock.mockReturnValue(Promise.resolve(bootstrapOf({ view: viewOf(), revision: 1 })));
    const stop = startGolemSatellite();
    await flush();
    actions.send('conv-a', 'hello');
    await flush();
    expect(posted('action')).toHaveLength(0);
    expect(useViewStore.getState().error).not.toBeNull();
    stop();
  });
});

describe('re-dock', () => {
  it('waits for an outstanding send and its draft clearing before transferring', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'in flight');
    useDraftStore.getState().setDraft('conv-b', 'untouched');
    actions.send('conv-a', 'in flight');
    await flush();
    const sendId = posted('action')[0].id;

    emitMode(stateOf({ phase: 'closing', stateRevision: 4, handoff: 2 }));
    await flush();
    expect(useViewStore.getState().frozen).toBe(true);
    // Blocked on the unresolved Send: nothing may be read yet.
    expect(posted('drafts')).toHaveLength(0);

    emitMessage(ackMessage(sendId, true));
    await flush();

    const drafts = posted('drafts');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].handoff).toBe(2);
    // The admitted Send cleared its own draft before the map was read.
    expect(drafts[0].payload).toEqual({ 'conv-a': '', 'conv-b': 'untouched' });
    expect(confirmMock).not.toHaveBeenCalled();

    emitMessage(transferAck(drafts[0].id, 2));
    await flush();
    expect(confirmMock).toHaveBeenCalledWith(1, 2);
    stop();
  });

  it('aborts and keeps the input when the transfer is refused', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'still mine');
    emitMode(stateOf({ phase: 'closing', stateRevision: 4, handoff: 2 }));
    await flush();
    const transfer = posted('drafts')[0];
    emitMessage(transferAck(transfer.id, 2, false));
    await flush();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(useDraftStore.getState().drafts['conv-a']).toBe('still mine');
    expect(useViewStore.getState().error).not.toBeNull();
    const aborts = posted('abort');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({ instance: 1, handoff: 2 });

    // Go answers that abort with closing→ready, which is what puts this window
    // back to work: a refused move must not cost the user their input.
    emitMode(stateOf({ phase: 'ready', stateRevision: 5, handoff: 2 }));
    await flush();
    expect(useViewStore.getState().frozen).toBe(false);
    actions.send('conv-a', 'still mine');
    await flush();
    expect(posted('action')).toHaveLength(1);
    stop();
  });

  it('aborts when the close authorization is refused', async () => {
    confirmMock.mockImplementation(() => Promise.reject(new Error('close not authorized')));
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'still mine');
    emitMode(stateOf({ phase: 'closing', stateRevision: 4, handoff: 2 }));
    await flush();
    emitMessage(transferAck(posted('drafts')[0].id, 2));
    await flush();
    expect(useViewStore.getState().error).toContain('close not authorized');
    expect(posted('abort')).toHaveLength(1);

    emitMode(stateOf({ phase: 'ready', stateRevision: 5, handoff: 2 }));
    await flush();
    expect(useViewStore.getState().frozen).toBe(false);
    expect(useDraftStore.getState().drafts['conv-a']).toBe('still mine');
    actions.send('conv-a', 'still mine');
    await flush();
    expect(posted('action')).toHaveLength(1);
    stop();
  });

  it('restores input when Go abandons the transfer on its own deadline', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'still mine');
    emitMode(stateOf({ phase: 'closing', stateRevision: 4, handoff: 2 }));
    await flush();
    expect(posted('drafts')).toHaveLength(1);

    // Every retry is spent, and the core names the reason, before Go's own
    // deadline runs out.
    for (let i = 0; i < SATELLITE_MAX_ATTEMPTS; i += 1) {
      jest.advanceTimersByTime(SATELLITE_ACK_TIMEOUT_MS);
      await flush();
    }
    expect(useViewStore.getState().error).not.toBeNull();

    // `restoreGolemReady` walks the phase back under the SAME handoff number,
    // which is the only signal this window gets that the transfer is over.
    emitMode(stateOf({ phase: 'ready', stateRevision: 5, handoff: 2 }));
    await flush();

    expect(useViewStore.getState().frozen).toBe(false);
    expect(useDraftStore.getState().drafts['conv-a']).toBe('still mine');
    actions.send('conv-a', 'still mine');
    await flush();
    expect(posted('action')).toHaveLength(1);
    // Go closed the transition itself; an abort would name one that is gone.
    expect(posted('abort')).toHaveLength(0);
    stop();
  });

  it('shows Go’s own reason when its deadline hands the window back', async () => {
    const stop = await startReady();
    emitMode(stateOf({ phase: 'closing', stateRevision: 4, handoff: 2 }));
    await flush();
    expect(posted('drafts')).toHaveLength(1);

    emitMode(
      stateOf({
        phase: 'ready',
        stateRevision: 5,
        handoff: 2,
        reason: 'draft transfer deadline expired',
      })
    );
    await flush();

    expect(useViewStore.getState().error).toBe('draft transfer deadline expired');
    expect(useViewStore.getState().frozen).toBe(false);
    expect(posted('abort')).toHaveLength(0);
    stop();
  });

  it('runs one transfer per handoff no matter how often the snapshot repeats', async () => {
    const stop = await startReady();
    emitMode(stateOf({ phase: 'closing', stateRevision: 4, handoff: 2 }));
    await flush();
    emitMode(stateOf({ phase: 'closing', stateRevision: 5, handoff: 2 }));
    emitMode(stateOf({ phase: 'closing', stateRevision: 6, handoff: 2 }));
    await flush();
    expect(posted('drafts')).toHaveLength(1);
    stop();
  });

  it('restores input when main aborts the transition', async () => {
    const stop = await startReady();
    useDraftStore.getState().setDraft('conv-a', 'still mine');
    emitMode(stateOf({ phase: 'closing', stateRevision: 4, handoff: 2 }));
    await flush();

    // `acceptGolemAbort` restores ready and only then relays the abort, so this
    // window is told the transition is over and told why in the same breath.
    emitMessage(abortMessage(2, 'The main window refused the handoff.'));
    emitMode(stateOf({ phase: 'ready', stateRevision: 5, handoff: 2 }));
    await flush();

    expect(useViewStore.getState().frozen).toBe(false);
    expect(useViewStore.getState().error).toBe('The main window refused the handoff.');
    expect(useDraftStore.getState().drafts['conv-a']).toBe('still mine');
    actions.send('conv-a', 'still mine');
    await flush();
    expect(posted('action')).toHaveLength(1);
    // Main ended this transition; echoing an abort back names a dead one.
    expect(posted('abort')).toHaveLength(0);
    stop();
  });

  it('reports a failed re-dock request instead of rejecting', async () => {
    closeMock.mockImplementation(() => Promise.reject(new Error('window is busy')));
    const stop = await startReady();
    await expect(requestReDock()).resolves.toBeUndefined();
    expect(useViewStore.getState().error).toContain('window is busy');
    stop();
  });
});
