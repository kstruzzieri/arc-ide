/**
 * Task B6 — the main window's relay owner.
 *
 * The store, the bridge and every admission guard live in this window, so these
 * are integration regressions around B2's real `createMainRelayCore` and B4's
 * real store methods: nothing that deduplicates, coalesces or refuses is
 * mocked away. Only the Wails seam is — the two events, the five bindings, and
 * the transport underneath them.
 */

import type { GolemWindowMessage, GolemWindowState } from '../../types/golemWindow';

const stateMock = jest.fn();
const openMock = jest.fn();
const focusMock = jest.fn();
const closeMock = jest.fn();
const postMock = jest.fn();
const runTurnMock = jest.fn();
const cancelRunMock = jest.fn();

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    GetGolemWindowState: (...args: unknown[]) => stateMock(...args),
    OpenGolemWindow: (...args: unknown[]) => openMock(...args),
    FocusGolemWindow: (...args: unknown[]) => focusMock(...args),
    CloseGolemWindow: (...args: unknown[]) => closeMock(...args),
    PostGolemWindowMessage: (...args: unknown[]) => postMock(...args),
    RunGolemTurn: (...args: unknown[]) => runTurnMock(...args),
    CancelGolemRun: (...args: unknown[]) => cancelRunMock(...args),
  };
});

import { useDraftStore } from '../../golem/draftStore';
import {
  MAIN_TRANSFER_MAX_ATTEMPTS,
  MAIN_TRANSFER_RETRY_MS,
  dockGolem,
  focusGolemWindow,
  startMainGolemRelay,
  undockGolem,
} from '../../golem/windowRelay';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import { parseGolemStatus } from '../../types/golem';
import { EventsOn } from '../../wails/runtime';

const mockEventsOn = EventsOn as jest.MockedFunction<typeof EventsOn>;

const MODE_EVENT = 'golem:window-mode';
const MESSAGE_EVENT = 'golem:window-message';

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

const installEventsOn = () => {
  listeners.clear();
  mockEventsOn.mockImplementation(((event: string, callback: Handler) => {
    const live = listeners.get(event) ?? new Set<Handler>();
    live.add(callback);
    listeners.set(event, live);
    return () => {
      live.delete(callback);
    };
  }) as unknown as typeof EventsOn);
};

const liveListeners = (event: string) => listeners.get(event)?.size ?? 0;
const emit = (event: string, payload: unknown) => {
  for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
};

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

// ── lifecycle fixtures ───────────────────────────────────────────────────────

const closed: GolemWindowState = {
  mode: 'docked',
  phase: 'closed',
  instance: 0,
  restorePending: false,
  stateRevision: 0,
  handoff: 0,
};

const phase = (
  value: GolemWindowState['phase'],
  revision: number,
  handoff = 1,
  instance = 1
): GolemWindowState => ({
  ...closed,
  phase: value,
  instance,
  stateRevision: revision,
  handoff,
  mode: value === 'ready' || value === 'closing' ? 'undocked' : 'docked',
});

/**
 * The `closed` Go publishes once a window has existed and been retired: the
 * instance and the handoff are both cleared, so main has only the state it
 * installed a moment ago to tell a completed re-dock from a dead bootstrap.
 */
const retired = (revision: number): GolemWindowState => ({
  ...closed,
  stateRevision: revision,
});

const message = (over: Partial<GolemWindowMessage>): GolemWindowMessage => ({
  kind: 'action',
  instance: 1,
  id: 1,
  revision: 0,
  handoff: 0,
  payload: null,
  ...over,
});

const fromSatellite = (over: Partial<GolemWindowMessage>) => ({
  from: 'satellite' as const,
  message: message(over),
});

const posted = (kind: GolemWindowMessage['kind']): GolemWindowMessage[] =>
  postMock.mock.calls
    .map((call) => call[0] as GolemWindowMessage)
    .filter((entry) => entry.kind === kind);

const acks = () => posted('ack').map((entry) => entry.payload);

const golemStatus = (conversationId: string, workspaceId: string) =>
  parseGolemStatus({
    available: true,
    workspaceLabel: workspaceId,
    identity: { repoEpoch: 3, workspaceId, conversationId },
    needsConsent: false,
    activeRuns: [],
  });

const CONV = 'conv-a';

/**
 * Counts `setHostFrozen(false)` calls. A redundant thaw is invisible in the
 * final state but still a second write over a surface the user is looking at,
 * so it is asserted rather than inferred.
 */
const countThaws = () => {
  const real = useGolemStore.getState().setHostFrozen;
  let thaws = 0;
  useGolemStore.setState({
    setHostFrozen: (frozen: boolean) => {
      if (!frozen) thaws += 1;
      real(frozen);
    },
  });
  return {
    count: () => thaws,
    restore: () => useGolemStore.setState({ setHostFrozen: real }),
  };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let stop: (() => void) | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  installEventsOn();
  useIDEStore.setState(useIDEStore.getInitialState());
  __resetGolemStore();
  useDraftStore.getState().installAll({});
  stateMock.mockResolvedValue(closed);
  openMock.mockResolvedValue(undefined);
  focusMock.mockResolvedValue(undefined);
  closeMock.mockResolvedValue(undefined);
  postMock.mockResolvedValue(undefined);
  runTurnMock.mockResolvedValue({ state: 'accepted' });
  cancelRunMock.mockResolvedValue(undefined);
});

afterEach(() => {
  stop?.();
  stop = null;
});

/** Starts the owner and drains the initial `GetGolemWindowState` round trip. */
const start = async () => {
  stop = startMainGolemRelay();
  await flush();
};

/** A hydrated conversation, so B4's admission guards can actually accept. */
const hydrate = () => {
  useGolemStore.getState().hydrateStatus(golemStatus(CONV, 'frontend'));
};

// ── 1 ────────────────────────────────────────────────────────────────────────

describe('lifecycle installation', () => {
  it('keeps the newest revision when the state getter answers late', async () => {
    const gate = deferred<unknown>();
    stateMock.mockReturnValue(gate.promise);
    useDraftStore.getState().installAll({ [CONV]: 'typed before undocking' });

    stop = startMainGolemRelay();
    await flush();

    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    expect(posted('drafts')).toHaveLength(1);
    expect(posted('drafts')[0].payload).toEqual({ [CONV]: 'typed before undocking' });

    emit(MODE_EVENT, phase('ready', 4));
    await flush();

    // The late getter carries revision 3 — real, but older than what landed.
    gate.resolve(phase('bootstrapped', 3));
    await flush();

    expect(useGolemStore.getState().windowState).toMatchObject({
      phase: 'ready',
      stateRevision: 4,
    });
    // No second transfer, and the map handed over is not handed over again.
    expect(posted('drafts')).toHaveLength(1);
    expect(useDraftStore.getState().drafts).toEqual({});
  });

  it('binds one core and publishes once when bootstrapped arrives first', async () => {
    await start();
    hydrate();
    await flush();

    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    const views = posted('view').length;
    expect(views).toBeGreaterThan(0);
    expect(posted('drafts')).toHaveLength(1);

    // The identical snapshot again: same revision, so nothing repeats.
    emit(MODE_EVENT, phase('bootstrapped', 2));
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();

    expect(posted('drafts')).toHaveLength(1);
    expect(posted('view')).toHaveLength(views);
  });

  it('publishes a fresh projection when the presentation state moves', async () => {
    await start();
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    const before = posted('view').length;

    hydrate();
    await flush();

    expect(posted('view').length).toBeGreaterThan(before);
    const latest = posted('view').at(-1)!.payload as { selectedConversationId: string };
    expect(latest.selectedConversationId).toBe(CONV);
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────

describe('undock', () => {
  it('freezes synchronously and answers repeated calls with one attempt', async () => {
    const gate = deferred<undefined>();
    openMock.mockReturnValue(gate.promise);
    await start();

    const first = undockGolem();
    const second = undockGolem();

    expect(useGolemStore.getState().hostFrozen).toBe(true);
    expect(first).toBe(second);
    expect(openMock).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    expect(posted('drafts')).toHaveLength(1);

    emit(MODE_EVENT, phase('ready', 3));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('rejects and thaws the docked host when the window will not open', async () => {
    openMock.mockRejectedValue(new Error('no display available'));
    await start();

    await expect(undockGolem()).rejects.toThrow('no display available');
    expect(useGolemStore.getState().hostFrozen).toBe(false);
  });

  it('fails an early close with the reason the open call actually reports', async () => {
    const gate = deferred<undefined>();
    openMock.mockReturnValue(gate.promise);
    await start();

    const thaw = countThaws();
    try {
      const settled = undockGolem().catch((error: unknown) => error);

      // Go's `abandonGolemOpen` publishes `closed` *before* `OpenGolemWindow`
      // returns its error, so failing the attempt here would bury the only
      // description of what actually went wrong.
      emit(MODE_EVENT, retired(2));
      await flush();
      gate.reject(new Error('display gone'));

      expect(((await settled) as Error).message).toBe('display gone');
      expect(useGolemStore.getState().hostFrozen).toBe(false);
      expect(thaw.count()).toBe(1);
    } finally {
      thaw.restore();
    }
  });

  it('falls back to the generic reason when the open call reports none', async () => {
    const gate = deferred<undefined>();
    openMock.mockReturnValue(gate.promise);
    await start();
    const settled = undockGolem().catch((error: unknown) => error);

    emit(MODE_EVENT, retired(2));
    await flush();
    gate.resolve(undefined);

    expect(((await settled) as Error).message).toBe('The Golem window closed before it was ready.');
    expect(useGolemStore.getState().hostFrozen).toBe(false);
  });

  it('focuses the composer once when the window first becomes ready', async () => {
    await start();
    const before = useGolemStore.getState().composerFocusRevision;

    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    expect(useGolemStore.getState().composerFocusRevision).toBe(before);

    emit(MODE_EVENT, phase('ready', 3));
    await flush();
    const opened = useGolemStore.getState().composerFocusRevision;
    expect(opened).toBeGreaterThan(before);

    // Every later tick of the same instance is ordinary state, not an open.
    emit(MODE_EVENT, phase('ready', 4));
    await flush();
    expect(useGolemStore.getState().composerFocusRevision).toBe(opened);
  });

  it('brings a live window forward instead of opening one that cannot settle', async () => {
    await start();
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    emit(MODE_EVENT, phase('ready', 3));
    await flush();

    await expect(undockGolem()).resolves.toBeUndefined();
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('holds the docked text frozen until an unconfirmed transfer is retired', async () => {
    jest.useFakeTimers();
    try {
      useDraftStore.getState().installAll({ [CONV]: 'half a sentence' });
      await start();
      const attempt = undockGolem();
      const settled = attempt.catch((error: unknown) => error);

      emit(MODE_EVENT, phase('bootstrapped', 2));
      await flush();
      expect(posted('drafts')).toHaveLength(1);

      // Nothing acknowledges: main retries on its own bound, then aborts.
      for (let i = 1; i < MAIN_TRANSFER_MAX_ATTEMPTS; i += 1) {
        jest.advanceTimersByTime(MAIN_TRANSFER_RETRY_MS);
        await flush();
      }
      expect(posted('drafts')).toHaveLength(MAIN_TRANSFER_MAX_ATTEMPTS);
      // Every retry reuses the one transfer id, so the receiver installs once.
      expect(new Set(posted('drafts').map((entry) => entry.id)).size).toBe(1);

      jest.advanceTimersByTime(MAIN_TRANSFER_RETRY_MS);
      await flush();
      expect(posted('drafts')).toHaveLength(MAIN_TRANSFER_MAX_ATTEMPTS);
      expect(posted('abort')).toHaveLength(1);

      // Still frozen, and the text is still the user's: ownership is uncertain
      // until Go says the attempt is over.
      expect(useGolemStore.getState().hostFrozen).toBe(true);
      expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'half a sentence' });

      emit(MODE_EVENT, retired(5));
      await flush();

      const error = (await settled) as Error;
      expect(error.message).toBe('Golem could not hand this conversation to the window.');
      expect(useGolemStore.getState().hostFrozen).toBe(false);
      expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'half a sentence' });
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

describe('satellite actions', () => {
  const ready = async () => {
    await start();
    hydrate();
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    emit(MODE_EVENT, phase('ready', 3));
    await flush();
  };

  it('admits a duplicated action once and answers both copies identically', async () => {
    await ready();
    const action = fromSatellite({
      kind: 'action',
      id: 1,
      payload: { type: 'send', conversationId: CONV, text: 'hello' },
    });

    emit(MESSAGE_EVENT, action);
    emit(MESSAGE_EVENT, action);
    await flush();

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const answered = acks();
    expect(answered).toHaveLength(2);
    expect(answered[0]).toEqual({ id: 1, ok: true });
    expect(answered[1]).toEqual(answered[0]);
  });

  it('refuses an empty send and never clears main’s inactive draft map', async () => {
    await ready();
    // Main's map is the copy of a window whose user is typing elsewhere.
    useDraftStore.getState().installAll({ [CONV]: 'stale main copy' });

    emit(
      MESSAGE_EVENT,
      fromSatellite({
        kind: 'action',
        id: 1,
        payload: { type: 'send', conversationId: CONV, text: '   ' },
      })
    );
    await flush();
    expect(acks()[0]).toEqual({ id: 1, ok: false, reason: 'There is nothing to send.' });

    emit(
      MESSAGE_EVENT,
      fromSatellite({
        kind: 'action',
        id: 2,
        payload: { type: 'send', conversationId: CONV, text: 'accepted' },
      })
    );
    await flush();
    expect(acks()[1]).toEqual({ id: 2, ok: true });

    // Neither outcome touches it: only the visible host clears a draft.
    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'stale main copy' });
  });

  it('routes openConfig to the one app-global configuration tab', async () => {
    await ready();

    emit(MESSAGE_EVENT, fromSatellite({ kind: 'action', id: 1, payload: { type: 'openConfig' } }));
    await flush();

    expect(acks()[0]).toEqual({ id: 1, ok: true });
    expect(useGolemStore.getState()).toMatchObject({ configTabOpen: true, configTabFocused: true });
  });

  it('reports an envelope from a retired instance rather than acting on it', async () => {
    await ready();

    emit(
      MESSAGE_EVENT,
      fromSatellite({
        kind: 'action',
        instance: 0,
        id: 1,
        payload: { type: 'send', conversationId: CONV, text: 'ghost' },
      })
    );
    await flush();

    expect(runTurnMock).not.toHaveBeenCalled();
    expect(useGolemStore.getState().windowError).toBe(
      'Golem received an unexpected window message.'
    );
  });

  it('holds a message that outran its lifecycle event and replays it once', async () => {
    await start();
    hydrate();
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();

    // `ready` has not been published yet, so an action is ahead of the state.
    stateMock.mockResolvedValue(phase('ready', 3));
    emit(
      MESSAGE_EVENT,
      fromSatellite({
        kind: 'action',
        id: 1,
        payload: { type: 'send', conversationId: CONV, text: 'early' },
      })
    );
    await flush();

    expect(useGolemStore.getState().windowState.phase).toBe('ready');
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(acks()).toEqual([{ id: 1, ok: true }]);
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────

describe('re-dock', () => {
  const ready = async () => {
    await start();
    hydrate();
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    emit(MODE_EVENT, phase('ready', 3));
    await flush();
  };

  const returnedDrafts = (handoff: number, id: number, map: Record<string, string>) =>
    fromSatellite({ kind: 'drafts', id, handoff, payload: map });

  it('installs the returned map once and reveals Golem only when the close lands', async () => {
    await ready();
    const attempt = dockGolem();
    expect(closeMock).toHaveBeenCalledTimes(1);

    emit(MODE_EVENT, phase('closing', 4, 2));
    emit(MESSAGE_EVENT, returnedDrafts(2, 7, { [CONV]: 'written in the window' }));
    await flush();

    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'written in the window' });
    expect(acks()).toEqual([{ id: 7, ok: true }]);
    // Nothing is revealed yet: the window is still retiring.
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(true);

    // A duplicate transfer replays the answer without overwriting local typing.
    useDraftStore.getState().setDraft(CONV, 'edited after the handover');
    emit(MESSAGE_EVENT, returnedDrafts(2, 7, { [CONV]: 'written in the window' }));
    await flush();
    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'edited after the handover' });
    expect(acks()).toHaveLength(2);

    const focusBefore = useGolemStore.getState().composerFocusRevision;
    emit(MODE_EVENT, retired(5));
    await expect(attempt).resolves.toBeUndefined();

    expect(useIDEStore.getState()).toMatchObject({
      isGolemPanelCollapsed: false,
      centerReveal: 'golem',
    });
    expect(useGolemStore.getState().composerFocusRevision).toBeGreaterThan(focusBefore);
    expect(useGolemStore.getState().hostFrozen).toBe(false);
  });

  it('holds a returned map that outran its closing snapshot and installs it once', async () => {
    await ready();
    const attempt = dockGolem();

    // The map is relayed over one channel and the `closing` that explains it
    // over another, so the getter is what places it.
    stateMock.mockResolvedValue(phase('closing', 4, 2));
    emit(MESSAGE_EVENT, returnedDrafts(2, 7, { [CONV]: 'typed in the window' }));
    await flush();

    expect(useGolemStore.getState().windowState).toMatchObject({ phase: 'closing', handoff: 2 });
    // One ack, so the held envelope was placed exactly once: B2 answers a
    // duplicate too, and a second delivery would show up as a second ack.
    expect(acks()).toEqual([{ id: 7, ok: true }]);
    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'typed in the window' });
    expect(useGolemStore.getState().windowError).toBeNull();

    emit(MODE_EVENT, retired(5));
    await expect(attempt).resolves.toBeUndefined();
    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'typed in the window' });
  });

  it('keeps satellite ownership when the transition aborts back to ready', async () => {
    await ready();
    const settled = dockGolem().catch((error: unknown) => error);

    emit(MODE_EVENT, phase('closing', 4, 2));
    await flush();
    emit(
      MESSAGE_EVENT,
      fromSatellite({ kind: 'abort', id: 0, handoff: 2, payload: { reason: 'window is busy' } })
    );
    emit(MODE_EVENT, phase('ready', 5, 2));
    await flush();

    expect(((await settled) as Error).message).toBe('window is busy');
    // Still the satellite's: nothing came back, so nothing is editable here.
    expect(useGolemStore.getState().hostFrozen).toBe(true);
    expect(useDraftStore.getState().drafts).toEqual({});

    // A later valid re-dock replaces main's stale map.
    const second = dockGolem();
    emit(MODE_EVENT, phase('closing', 6, 3));
    emit(MESSAGE_EVENT, returnedDrafts(3, 9, { [CONV]: 'second attempt' }));
    await flush();
    emit(MODE_EVENT, retired(7));
    await expect(second).resolves.toBeUndefined();
    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'second attempt' });
  });

  it('focuses the satellite composer once when the transition aborts back to ready', async () => {
    await ready();
    const settled = dockGolem().catch((error: unknown) => error);
    emit(MODE_EVENT, phase('closing', 4, 2));
    await flush();

    // §5.1: the re-dock failed, so the window the user is looking at is the
    // host again and its caret has to come back with the role.
    const before = useGolemStore.getState().composerFocusRevision;
    emit(MODE_EVENT, phase('ready', 5, 2));
    await flush();
    await settled;
    const recovered = useGolemStore.getState().composerFocusRevision;
    expect(recovered).toBe(before + 1);

    // A later `ready` of the same live instance is not a second recovery.
    emit(MODE_EVENT, phase('ready', 6, 2));
    await flush();
    expect(useGolemStore.getState().composerFocusRevision).toBe(recovered);
  });

  it('keeps the map it was already handed when the transition falls back to ready', async () => {
    await ready();
    const settled = dockGolem().catch((error: unknown) => error);

    emit(MODE_EVENT, phase('closing', 4, 2));
    emit(MESSAGE_EVENT, returnedDrafts(2, 7, { [CONV]: 'handed back before the abort' }));
    await flush();
    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'handed back before the abort' });

    emit(
      MESSAGE_EVENT,
      fromSatellite({ kind: 'abort', id: 0, handoff: 2, payload: { reason: 'could not close' } })
    );
    emit(MODE_EVENT, phase('ready', 5, 2));
    await flush();

    expect(((await settled) as Error).message).toBe('could not close');
    // Returning to `ready` is not a fresh undock: main clears its inactive copy
    // once per instance, and this map is the one the satellite just gave back.
    expect(useDraftStore.getState().drafts).toEqual({ [CONV]: 'handed back before the abort' });
  });

  it('reports a stale returned map instead of installing it over a newer one', async () => {
    await ready();
    void dockGolem().catch(() => undefined);
    emit(MODE_EVENT, phase('closing', 4, 2));
    await flush();
    emit(
      MESSAGE_EVENT,
      fromSatellite({ kind: 'abort', id: 0, handoff: 2, payload: { reason: 'aborted' } })
    );
    emit(MODE_EVENT, phase('ready', 5, 2));
    await flush();

    void dockGolem().catch(() => undefined);
    emit(MODE_EVENT, phase('closing', 6, 3));
    await flush();
    // The abandoned handoff's map, arriving after a newer one opened.
    emit(MESSAGE_EVENT, returnedDrafts(2, 7, { [CONV]: 'from the dead handoff' }));
    await flush();

    expect(useDraftStore.getState().drafts).toEqual({});
    expect(useGolemStore.getState().windowError).toBe(
      'Golem received an unexpected window message.'
    );
  });

  it('does not reveal Golem when a bootstrap dies before it was ever ready', async () => {
    await start();
    const settled = undockGolem().catch((error: unknown) => error);
    emit(MODE_EVENT, phase('bootstrapping', 2));
    await flush();
    emit(MODE_EVENT, retired(3));

    expect(((await settled) as Error).message).toBe('The Golem window closed before it was ready.');
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(true);
    expect(useGolemStore.getState().hostFrozen).toBe(false);
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────

describe('without a repository', () => {
  it('restores a saved undocked window once and keeps the controls usable', async () => {
    stateMock.mockResolvedValue({ ...closed, mode: 'undocked', restorePending: true });
    await start();

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(useGolemStore.getState().hostFrozen).toBe(true);

    // A second snapshot still marked restorePending must not open a second one.
    emit(MODE_EVENT, { ...closed, mode: 'undocked', restorePending: true, stateRevision: 1 });
    await flush();
    expect(openMock).toHaveBeenCalledTimes(1);

    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    const view = posted('view').at(-1)!.payload as {
      bridgePhase: string;
      conversations: Record<string, unknown>;
    };
    expect(view.bridgePhase).toBe('unbound');
    expect(view.conversations).toEqual({});

    emit(MODE_EVENT, phase('ready', 3));
    await flush();

    // Window and config controls work with no repository at all…
    await expect(focusGolemWindow()).resolves.toBeUndefined();
    emit(MESSAGE_EVENT, fromSatellite({ kind: 'action', id: 1, payload: { type: 'openConfig' } }));
    await flush();
    expect(useGolemStore.getState().configTabOpen).toBe(true);

    // …and Send stays subject to the bridge's ordinary eligibility guard.
    emit(
      MESSAGE_EVENT,
      fromSatellite({
        kind: 'action',
        id: 2,
        payload: { type: 'send', conversationId: CONV, text: 'anyone home' },
      })
    );
    await flush();
    expect(acks().at(-1)).toEqual({
      id: 2,
      ok: false,
      reason: 'That Golem conversation is no longer open.',
    });
    expect(runTurnMock).not.toHaveBeenCalled();
  });
});

// ── 6 ────────────────────────────────────────────────────────────────────────

describe('owner lifetime', () => {
  it('leaves one subscription set and no live timer across a StrictMode cycle', async () => {
    jest.useFakeTimers();
    try {
      const first = startMainGolemRelay();
      await flush();
      emit(MODE_EVENT, phase('bootstrapped', 2));
      await flush();
      const postsBefore = postMock.mock.calls.length;

      first();
      stop = startMainGolemRelay();
      await flush();

      expect(liveListeners(MODE_EVENT)).toBe(1);
      expect(liveListeners(MESSAGE_EVENT)).toBe(1);

      // The retired owner's transfer timer must not post again.
      jest.advanceTimersByTime(MAIN_TRANSFER_RETRY_MS * (MAIN_TRANSFER_MAX_ATTEMPTS + 1));
      await flush();
      expect(posted('drafts')).toHaveLength(1);
      expect(postMock.mock.calls.length).toBe(postsBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a pending transition when the owner is torn down', async () => {
    openMock.mockReturnValue(deferred<undefined>().promise);
    stop = startMainGolemRelay();
    await flush();
    const settled = undockGolem().catch((error: unknown) => error);

    stop();
    stop = null;

    expect(((await settled) as Error).message).toBe(
      'The Golem window controls closed before the transition finished.'
    );
  });

  it('keeps the window fields across a repository invalidation', async () => {
    await start();
    hydrate();
    emit(MODE_EVENT, phase('bootstrapped', 2));
    await flush();
    emit(MODE_EVENT, phase('ready', 3));
    await flush();
    expect(useGolemStore.getState().hostFrozen).toBe(true);

    useGolemStore.getState().invalidateBinding();
    useGolemStore.getState().setWindowError('a window failure the user has not dismissed');
    useGolemStore.getState().hydrateStatus(golemStatus(CONV, 'frontend'));

    expect(useGolemStore.getState()).toMatchObject({
      windowState: { phase: 'ready', instance: 1, stateRevision: 3 },
      hostFrozen: true,
      windowError: 'a window failure the user has not dismissed',
      bridgePhase: 'ready',
    });
  });
});
