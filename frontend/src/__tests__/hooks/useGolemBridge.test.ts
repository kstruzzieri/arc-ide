/**
 * Task B7 — always-mounted Golem event bridge.
 *
 * TDD: written before `src/hooks/useGolemBridge.ts` exists.
 *
 * The bridge is the only thing that talks to Wails about repository binding and
 * status. It has to survive the panel being collapsed or switched to Runs, keep
 * exactly one listener per event across a StrictMode mount cycle, serialize
 * bind/unbind so they cannot land out of order, and batch streamed deltas
 * without ever reordering them against the events around them.
 */

import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { EventsOn } from '../../wails/runtime';
import { useGolemBridge } from '../../hooks/useGolemBridge';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';

const mockGetWorkspaceInfo = jest.fn();
const mockGetGolemStatus = jest.fn();
const mockRunGolemTurn = jest.fn();
const mockCancelGolemRun = jest.fn();

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    GetWorkspaceInfo: (...args: unknown[]) => mockGetWorkspaceInfo(...args),
    GetGolemStatus: (...args: unknown[]) => mockGetGolemStatus(...args),
    RunGolemTurn: (...args: unknown[]) => mockRunGolemTurn(...args),
    CancelGolemRun: (...args: unknown[]) => mockCancelGolemRun(...args),
  };
});

const mockEventsOn = EventsOn as jest.MockedFunction<typeof EventsOn>;

// ── event plumbing ────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => void;
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
const emit = (event: string, payload?: unknown) => {
  act(() => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  });
};

// ── requestAnimationFrame control ─────────────────────────────────────────────

let frameQueue: Array<{ id: number; callback: FrameRequestCallback }> = [];
let frameId = 0;
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;

const runFrame = () => {
  const queued = frameQueue;
  frameQueue = [];
  act(() => {
    for (const entry of queued) entry.callback(0);
  });
};

beforeAll(() => {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = ++frameId;
    frameQueue.push({ id, callback });
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    frameQueue = frameQueue.filter((entry) => entry.id !== id);
  }) as typeof cancelAnimationFrame;
});

afterAll(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
});

// ── fixtures ──────────────────────────────────────────────────────────────────

const REPO_A = '/repos/alpha';
const REPO_B = '/repos/beta';
const WS = 'frontend';
const CONV = 'conv-frontend';
const RUN = '11111111-1111-4111-8111-111111111111';

const identity = { repoEpoch: 4, workspaceId: WS, conversationId: CONV };
const runIdentity = { ...identity, runId: RUN };
const localDestination = {
  provider: 'ollama',
  model: 'llama',
  endpoint: 'http://127.0.0.1:11434',
  classification: 'local' as const,
  digest: 'local',
};

const statusPayload = (over: Record<string, unknown> = {}) => ({
  available: true,
  workspaceLabel: 'Frontend',
  identity,
  destination: localDestination,
  needsConsent: false,
  activeRuns: [],
  ...over,
});

const eventPayload = (over: Record<string, unknown> = {}) => ({
  protocol: 1,
  threadId: CONV,
  runId: RUN,
  seq: 1,
  type: 'run.started',
  payload: {},
  raw: '{}',
  ...over,
});

const delta = (seq: number, text: string, messageId = 'm1') =>
  eventPayload({ seq, type: 'message.delta', payload: { messageId, text }, raw: `{"seq":${seq}}` });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
};

const openRepository = (path = REPO_A) => {
  act(() => {
    useIDEStore.setState({
      workspace: { name: path.split('/').pop()!, path },
      activeWorkspaceId: WS,
    });
  });
};

const store = () => useGolemStore.getState();
const conversation = () => store().conversations[CONV];

beforeEach(() => {
  jest.clearAllMocks();
  frameQueue = [];
  installEventsOn();
  __resetGolemStore();
  useIDEStore.setState(useIDEStore.getInitialState());
  mockGetWorkspaceInfo.mockImplementation((path: string) =>
    Promise.resolve({ name: 'alpha', path, repoKey: 'key', repoEpoch: path === '' ? 0 : 4 })
  );
  mockGetGolemStatus.mockResolvedValue(statusPayload());
  mockCancelGolemRun.mockResolvedValue(true);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('subscriptions', () => {
  it('owns exactly one subscription per Golem event and releases them on unmount', () => {
    const { unmount } = renderHook(() => useGolemBridge());

    expect(liveListeners('golem:event')).toBe(1);
    expect(liveListeners('golem:run-status')).toBe(1);
    expect(liveListeners('golem:status-changed')).toBe(1);

    unmount();
    expect(liveListeners('golem:event')).toBe(0);
    expect(liveListeners('golem:run-status')).toBe(0);
    expect(liveListeners('golem:status-changed')).toBe(0);
  });

  it('leaves exactly one live listener per event after a StrictMode mount cycle', () => {
    renderHook(() => useGolemBridge(), { wrapper: StrictMode });

    expect(mockEventsOn.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(liveListeners('golem:event')).toBe(1);
    expect(liveListeners('golem:run-status')).toBe(1);
    expect(liveListeners('golem:status-changed')).toBe(1);
  });

  it('lets one effect own the subscriptions for the whole App lifetime', async () => {
    renderHook(() => useGolemBridge());
    openRepository(REPO_A);
    await settle();
    const subscribed = mockEventsOn.mock.calls.length;
    expect(subscribed).toBeGreaterThanOrEqual(3);

    // Opening another repository rebinds and re-hydrates, but must not tear the
    // subscriptions down: a resubscribe window drops whatever arrives inside it.
    openRepository(REPO_B);
    await settle();

    expect(mockEventsOn.mock.calls.length).toBe(subscribed);
    expect(liveListeners('golem:event')).toBe(1);
    expect(liveListeners('golem:run-status')).toBe(1);
    expect(liveListeners('golem:status-changed')).toBe(1);
  });

  it('keeps its listeners while the panel is collapsed or showing Runs', async () => {
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    act(() => {
      useGolemStore.setState({ panelMode: 'runs' });
    });
    emit('golem:event', eventPayload({ seq: 1 }));

    expect(liveListeners('golem:event')).toBe(1);
    expect(conversation().runs[RUN].lastSeq).toBe(1);
  });
});

describe('repository binding', () => {
  it('moves through binding before it reports ready', async () => {
    const gate = deferred<Record<string, unknown>>();
    mockGetWorkspaceInfo.mockImplementation((path: string) =>
      path === '' ? Promise.resolve({ repoEpoch: 0 }) : gate.promise
    );

    renderHook(() => useGolemBridge());
    expect(store().bridgePhase).toBe('unbound');

    openRepository();
    expect(store().bridgePhase).toBe('binding');
    expect(store().bridgeError).toBeNull();

    await act(async () => {
      gate.resolve({ name: 'alpha', path: REPO_A, repoKey: 'key', repoEpoch: 4 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(store().bridgePhase).toBe('ready');
  });

  it('reports binding then error when the workspace call is rejected', async () => {
    const gate = deferred<Record<string, unknown>>();
    mockGetWorkspaceInfo.mockReturnValue(gate.promise);

    renderHook(() => useGolemBridge());
    openRepository();
    expect(store().bridgePhase).toBe('binding');

    await act(async () => {
      gate.reject('The Golem workspace is unavailable.');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(store().bridgePhase).toBe('error');
  });

  it('binds the open repository and unbinds on close with the only path call', async () => {
    const { unmount } = renderHook(() => useGolemBridge());
    expect(mockGetWorkspaceInfo).not.toHaveBeenCalled();

    openRepository();
    await settle();
    expect(mockGetWorkspaceInfo).toHaveBeenCalledWith(REPO_A);
    expect(store().bridgePhase).toBe('ready');

    unmount();
    await settle();
    expect(mockGetWorkspaceInfo).toHaveBeenLastCalledWith('');
    const paths = mockGetWorkspaceInfo.mock.calls.map((call) => call[0]);
    expect(paths).toEqual([REPO_A, '']);
  });

  it('serializes unbind before the next bind', async () => {
    const order: string[] = [];
    const unbindGate = deferred<void>();
    mockGetWorkspaceInfo.mockImplementation(async (path: string) => {
      order.push(path === '' ? 'unbind' : `bind:${path}`);
      if (path === '') await unbindGate.promise;
      return { name: 'x', path, repoKey: 'key', repoEpoch: path === REPO_B ? 5 : 4 };
    });

    renderHook(() => useGolemBridge());
    openRepository(REPO_A);
    await settle();
    expect(order).toEqual([`bind:${REPO_A}`]);

    openRepository(REPO_B);
    await settle();
    // The unbind is still in flight, so the next bind must not have started.
    expect(order).toEqual([`bind:${REPO_A}`, 'unbind']);

    await act(async () => {
      unbindGate.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(order).toEqual([`bind:${REPO_A}`, 'unbind', `bind:${REPO_B}`]);
  });

  it('invalidates the binding and discards a stale bind result when the repository closes', async () => {
    const gate = deferred<Record<string, unknown>>();
    mockGetWorkspaceInfo.mockImplementation((path: string) =>
      path === '' ? Promise.resolve({ repoEpoch: 0 }) : gate.promise
    );

    renderHook(() => useGolemBridge());
    openRepository(REPO_A);
    await settle();

    act(() => {
      useIDEStore.setState({ workspace: null });
    });
    expect(store().bridgePhase).toBe('unbound');

    await act(async () => {
      gate.resolve({ name: 'x', path: REPO_A, repoKey: 'key', repoEpoch: 4 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(mockGetGolemStatus).not.toHaveBeenCalled();
    expect(store().hydratedIdentity).toBeNull();
  });

  it('reports a bounded bridge error when binding fails', async () => {
    mockGetWorkspaceInfo.mockRejectedValue('The Golem workspace is unavailable.');
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    expect(store().bridgePhase).toBe('error');
    expect(store().bridgeError).toBe('The Golem workspace is unavailable.');
  });
});

describe('status hydration', () => {
  it('sends only the repository epoch and workspace ID', async () => {
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    expect(mockGetGolemStatus).toHaveBeenCalledTimes(1);
    const request = mockGetGolemStatus.mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual(['repoEpoch', 'workspaceId']);
    expect(request.repoEpoch).toBe(4);
    expect(request.workspaceId).toBe(WS);
  });

  it('re-hydrates on a focus change without canceling background runs', async () => {
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    mockGetGolemStatus.mockResolvedValue(
      statusPayload({
        identity: { ...identity, workspaceId: 'backend', conversationId: 'conv-backend' },
        workspaceLabel: 'Backend',
      })
    );
    act(() => {
      useIDEStore.setState({ activeWorkspaceId: 'backend' });
    });
    await settle();

    expect(mockGetGolemStatus).toHaveBeenCalledTimes(2);
    expect(mockGetGolemStatus.mock.calls[1][0].workspaceId).toBe('backend');
    expect(mockCancelGolemRun).not.toHaveBeenCalled();
    expect(mockGetWorkspaceInfo.mock.calls.map((call) => call[0])).toEqual([REPO_A]);
  });

  it('adopts an already-active run without inventing prompt data, and keeps Retry disabled', async () => {
    mockGetGolemStatus.mockResolvedValue(
      statusPayload({
        activeRuns: [{ identity: runIdentity, workspaceLabel: 'Frontend', state: 'running' }],
      })
    );
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    expect(conversation().runs[RUN].phase).toBe('running');
    expect(conversation().runs[RUN].request).toBeUndefined();
    expect(conversation().runs[RUN].userEntryId).toBeUndefined();
    expect(store().runToConversation[RUN]).toBe(CONV);

    emit('golem:event', delta(1, 'streaming'));
    runFrame();
    expect(conversation().transcript.find((e) => e.kind === 'assistant')!.text).toBe('streaming');

    await act(async () => {
      await store().cancelRun(RUN);
    });
    expect({ ...(mockCancelGolemRun.mock.calls[0][0] as object) }).toEqual(runIdentity);

    mockRunGolemTurn.mockClear();
    await act(async () => {
      await store().retryLastFailed(CONV);
    });
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
  });

  it('reports a bounded bridge error for a status that breaks the contract', async () => {
    mockGetGolemStatus.mockResolvedValue({ available: 'maybe' });
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    expect(store().bridgePhase).toBe('error');
    expect(store().bridgeError).toBe('Golem returned an unexpected response.');
  });

  it('reports a bounded bridge error when the status call is rejected', async () => {
    mockGetGolemStatus.mockRejectedValue('Golem is unavailable.');
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    expect(store().bridgePhase).toBe('error');
    expect(store().bridgeError).toBe('Golem is unavailable.');
  });
});

describe('golem:status-changed', () => {
  it('ignores an older refresh that resolves after a newer request in the same binding', async () => {
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    mockGetGolemStatus.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    emit('golem:status-changed');
    emit('golem:status-changed');

    await act(async () => {
      newer.resolve(statusPayload({ workspaceLabel: 'newer' }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(conversation().workspaceLabel).toBe('newer');

    await act(async () => {
      older.resolve(statusPayload({ workspaceLabel: 'older' }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(conversation().workspaceLabel).toBe('newer');
  });

  it('re-fetches only the current identity and hydrates the consent degradation', async () => {
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();
    expect(conversation().initError).toBeNull();

    mockGetGolemStatus.mockResolvedValue(
      statusPayload({
        needsConsent: true,
        warnings: [
          'Remote consent storage is unavailable; open Golem configuration for repair steps.',
        ],
        initError:
          'Remote consent storage is unavailable; open Golem configuration for repair steps.',
      })
    );
    emit('golem:status-changed');
    await settle();

    expect(mockGetGolemStatus).toHaveBeenCalledTimes(2);
    expect(mockGetGolemStatus.mock.calls[1][0]).toEqual(mockGetGolemStatus.mock.calls[0][0]);
    expect(conversation().initError).toBe(
      'Remote consent storage is unavailable; open Golem configuration for repair steps.'
    );
    expect(conversation().warnings).toEqual([
      'Remote consent storage is unavailable; open Golem configuration for repair steps.',
    ]);
    expect(conversation().needsConsent).toBe(true);

    mockGetGolemStatus.mockResolvedValue(statusPayload());
    emit('golem:status-changed');
    await settle();
    expect(conversation().initError).toBeNull();
  });

  it('cannot apply a refresh that resolves after the binding generation changed', async () => {
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();

    const gate = deferred<unknown>();
    mockGetGolemStatus.mockReturnValueOnce(gate.promise);
    emit('golem:status-changed');

    act(() => {
      useIDEStore.setState({ workspace: null });
    });
    await settle();
    expect(store().hydratedIdentity).toBeNull();

    await act(async () => {
      gate.resolve(statusPayload({ workspaceLabel: 'stale label' }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(store().hydratedIdentity).toBeNull();
    expect(conversation().workspaceLabel).toBe('Frontend');
  });

  it('cannot overwrite an already-ingested terminal with a deferred active snapshot', async () => {
    mockGetGolemStatus.mockResolvedValue(
      statusPayload({
        activeRuns: [{ identity: runIdentity, workspaceLabel: 'Frontend', state: 'running' }],
      })
    );
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();
    expect(conversation().activeRunId).toBe(RUN);

    const gate = deferred<unknown>();
    mockGetGolemStatus.mockReturnValueOnce(gate.promise);
    emit('golem:status-changed');

    emit(
      'golem:event',
      eventPayload({
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    expect(conversation().runs[RUN].phase).toBe('done');

    await act(async () => {
      gate.resolve(
        statusPayload({
          activeRuns: [{ identity: runIdentity, workspaceLabel: 'Frontend', state: 'running' }],
        })
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(conversation().runs[RUN].phase).toBe('done');
    expect(conversation().activeRunId).toBeNull();
  });
});

describe('delta batching', () => {
  beforeEach(async () => {
    renderHook(() => useGolemBridge());
    openRepository();
    await settle();
  });

  it('batches consecutive deltas into one frame', () => {
    emit('golem:event', delta(1, 'He'));
    emit('golem:event', delta(2, 'll'));
    emit('golem:event', delta(3, 'o'));
    expect(conversation().rawEvents).toHaveLength(0);

    runFrame();
    expect(conversation().transcript.find((e) => e.kind === 'assistant')!.text).toBe('Hello');
    expect(conversation().rawEvents.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(conversation().runs[RUN].lastSeq).toBe(3);
  });

  it('applies a whole frame of deltas in a single store mutation', () => {
    let notifications = 0;
    const unsubscribe = useGolemStore.subscribe(() => {
      notifications += 1;
    });
    try {
      emit('golem:event', delta(1, 'He'));
      emit('golem:event', delta(2, 'll'));
      emit('golem:event', delta(3, 'o'));
      expect(notifications).toBe(0);

      runFrame();

      // One notification for three events: applying them one at a time copies
      // the conversation once per token and does not survive a fast stream.
      expect(notifications).toBe(1);
      expect(conversation().transcript.find((e) => e.kind === 'assistant')!.text).toBe('Hello');
      expect(conversation().rawEvents.map((e) => e.seq)).toEqual([1, 2, 3]);
    } finally {
      unsubscribe();
    }
  });

  it('flushes pending deltas before every non-delta event', () => {
    emit('golem:event', delta(1, 'a'));
    emit('golem:event', delta(2, 'b'));
    emit('golem:event', eventPayload({ seq: 3, type: 'plan.updated', payload: { steps: 1 } }));
    emit('golem:event', delta(4, 'c'));

    // The unknown event must already be ordered after the first two deltas.
    expect(conversation().rawEvents.map((e) => e.seq)).toEqual([1, 2, 3]);
    runFrame();
    expect(conversation().rawEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(conversation().transcript.find((e) => e.kind === 'assistant')!.text).toBe('abc');
    expect(conversation().runs[RUN].lastSeq).toBe(4);
  });

  it('flushes pending deltas before started, tool and terminal boundaries', () => {
    emit('golem:event', eventPayload({ seq: 1, type: 'run.started' }));
    emit('golem:event', delta(2, 'thinking'));
    emit(
      'golem:event',
      eventPayload({
        seq: 3,
        type: 'tool.started',
        payload: { toolCallId: 't1', name: 'read', preview: 'read(a)' },
      })
    );
    expect(conversation().rawEvents.map((e) => e.seq)).toEqual([1, 2, 3]);

    emit('golem:event', delta(4, ' more'));
    emit(
      'golem:event',
      eventPayload({
        seq: 5,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );

    expect(conversation().rawEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(conversation().transcript.find((e) => e.kind === 'assistant')!.text).toBe(
      'thinking more'
    );
    expect(conversation().transcript.find((e) => e.kind === 'tool')!.activity).toBe('interrupted');
    expect(conversation().runs[RUN].phase).toBe('done');
    expect(conversation().runs[RUN].lastSeq).toBe(5);
  });

  it('flushes pending deltas before a golem:run-status fallback', () => {
    emit('golem:event', delta(1, 'partial'));
    emit('golem:run-status', {
      identity: runIdentity,
      state: 'failed',
      message: 'The Golem run failed.',
    });

    expect(conversation().rawEvents.map((e) => e.seq)).toEqual([1]);
    expect(conversation().transcript.find((e) => e.kind === 'assistant')!.text).toBe('partial');
    expect(conversation().runs[RUN].phase).toBe('failed');
    expect(conversation().runs[RUN].lastSeq).toBe(1);
  });

  it('flushes pending deltas on unmount rather than dropping them', async () => {
    const { unmount } = renderHook(() => useGolemBridge());
    // Two bridges are mounted in this test, so the delta lands twice; only the
    // first ingest can advance lastSeq, which is exactly the guard being used.
    emit('golem:event', delta(9, 'tail'));
    expect(conversation().rawEvents).toHaveLength(0);

    unmount();
    await settle();
    expect(conversation().transcript.find((e) => e.kind === 'assistant')!.text).toBe('tail');
    expect(conversation().runs[RUN].lastSeq).toBe(9);
  });
});
