import {
  createMainRelayCore,
  createSatelliteCore,
  RELAY_ACTION_REFUSED,
  RELAY_HANDOFF_IN_PROGRESS,
  type MainRelayCore,
  type SatelliteCore,
} from '../../golem/relayCore';
import type { GolemActionResult } from '../../types/golem';
import {
  GOLEM_WINDOW_MAX_PAYLOAD_BYTES,
  type GolemAck,
  type GolemDraftMap,
  type GolemView,
  type GolemViewAction,
  type GolemWindowEnvelope,
  type GolemWindowMessage,
} from '../../types/golemWindow';
import wire from '../fixtures/golemWindowWire.json';

const emptyView: GolemView = {
  bridgePhase: 'unbound',
  bridgeError: null,
  hydratedIdentity: null,
  selectedConversationId: null,
  conversations: {},
  composerFocusRevision: 0,
  processedThrough: 0,
};

it('admits concurrent duplicate and lost-ack retries exactly once', async () => {
  let admit!: (result: GolemActionResult) => void;
  const admission = new Promise<GolemActionResult>((resolve) => {
    admit = resolve;
  });
  const execute = jest.fn(() => admission);
  const sent: GolemWindowMessage[] = [];
  const empty: GolemView = {
    bridgePhase: 'unbound',
    bridgeError: null,
    hydratedIdentity: null,
    selectedConversationId: null,
    conversations: {},
    composerFocusRevision: 0,
    processedThrough: 0,
  };
  const core = createMainRelayCore({
    instance: 1,
    execute,
    snapshot: () => empty,
    transport: {
      post: async (message) => {
        sent.push(message);
      },
    },
    onDrafts: jest.fn(),
    onError: jest.fn(),
  });
  const envelope: GolemWindowEnvelope = {
    from: 'satellite',
    message: {
      kind: 'action',
      instance: 1,
      handoff: 0,
      id: 1,
      revision: 0,
      payload: { type: 'select', conversationId: 'c1' },
    },
  };
  try {
    const first = core.receive(envelope);
    const duplicate = core.receive(envelope);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    admit({ ok: true });
    await Promise.all([first, duplicate]);
    // Pretend the receiver lost both acknowledgements, then retries the same ID.
    await core.receive(envelope);
    expect(execute).toHaveBeenCalledTimes(1);
    const acks = sent.filter((message) => message.kind === 'ack');
    expect(acks).toHaveLength(3);
    for (const ack of acks) {
      expect(ack.revision).toBe(1);
      expect(ack.payload).toEqual({ id: 1, ok: true });
    }
  } finally {
    core.dispose();
  }
});

// ── Deterministic queued bus ─────────────────────────────────────────────────
// Neither side ever reaches the other directly: every post lands in a queue the
// test drains by hand, so a duplicate, a reorder, a held post and a dropped
// message are all just choices about what to deliver.

interface Post {
  from: 'main' | 'satellite';
  message: GolemWindowMessage;
  release(): void;
  released: boolean;
}

class Bus {
  readonly posts: Post[] = [];
  hold = false;
  main: MainRelayCore | null = null;
  satellite: SatelliteCore | null = null;

  transport(from: 'main' | 'satellite') {
    return {
      post: (message: GolemWindowMessage): Promise<void> => {
        let release!: () => void;
        const settled = new Promise<void>((resolve) => {
          release = () => {
            entry.released = true;
            resolve();
          };
        });
        const entry: Post = { from, message, release, released: false };
        this.posts.push(entry);
        if (!this.hold) release();
        return settled;
      },
    };
  }

  /** Every post of a kind, whether or not it has been delivered. */
  sent(from: 'main' | 'satellite', kind?: GolemWindowMessage['kind']): GolemWindowMessage[] {
    return this.posts
      .filter((p) => p.from === from && (kind === undefined || p.message.kind === kind))
      .map((p) => p.message);
  }

  envelope(post: Post): GolemWindowEnvelope {
    return { from: post.from, message: post.message };
  }

  /** Hand one queued post to the opposite side; returns what was delivered. */
  deliver(post: Post): GolemWindowMessage {
    const envelope = this.envelope(post);
    if (post.from === 'main') this.satellite?.receive(envelope);
    else void this.main?.receive(envelope);
    return post.message;
  }

  /** Drain everything queued after `from`, releasing held posts as it goes. */
  async pump(from = 0): Promise<void> {
    for (let i = from; i < this.posts.length; i += 1) {
      const post = this.posts[i];
      if (!post.released) post.release();
      this.deliver(post);
      await flush();
    }
  }
}

/** Settle every already-scheduled microtask without advancing timers. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function viewMessage(revision: number, view: GolemView = emptyView): GolemWindowMessage {
  return { kind: 'view', instance: 1, handoff: 0, id: 0, revision, payload: view };
}

function actionEnvelope(id: number, payload: unknown): GolemWindowEnvelope {
  return {
    from: 'satellite',
    message: { kind: 'action', instance: 1, handoff: 0, id, revision: 0, payload },
  };
}

describe('main relay core', () => {
  it('retires completed action bodies after the next id without reexecuting old replays', async () => {
    const bus = new Bus();
    const execute = jest.fn(() => ({ ok: true }));
    const core = createMainRelayCore({
      instance: 1,
      execute,
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    try {
      const first = actionEnvelope(1, { type: 'select', conversationId: 'c1' });
      const latest = actionEnvelope(2, { type: 'select', conversationId: 'c2' });
      await core.receive(first);
      await core.receive(latest);
      await core.receive(first);
      expect(bus.sent('main', 'ack').at(-1)?.payload).toMatchObject({ id: 1, ok: false });
      await core.receive(latest);
      expect(bus.sent('main', 'ack').at(-1)?.payload).toEqual({ id: 2, ok: true });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      core.dispose();
    }
  });

  it('reports a failed projection to the satellite while still acknowledging admission', async () => {
    const sent: GolemWindowMessage[] = [];
    const core = createMainRelayCore({
      instance: 1,
      execute: () => ({ ok: true }),
      snapshot: () => emptyView,
      transport: {
        post: async (message) => {
          if (message.kind === 'view') throw new Error('projection unavailable');
          sent.push(message);
        },
      },
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    try {
      await core.receive(actionEnvelope(1, { type: 'select', conversationId: 'c1' }));
      expect(sent).toEqual([
        {
          kind: 'view-error',
          instance: 1,
          id: 0,
          revision: 1,
          handoff: 0,
          payload: { reason: 'projection unavailable' },
        },
        { kind: 'ack', instance: 1, id: 1, revision: 1, handoff: 0, payload: { id: 1, ok: true } },
      ]);
    } finally {
      core.dispose();
    }
  });

  it('publishes a recovery queued while the preceding projection is failing', async () => {
    const sent: GolemWindowMessage[] = [];
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const core = createMainRelayCore({
      instance: 1,
      execute: () => ({ ok: true }),
      snapshot: () => emptyView,
      transport: {
        post: (message) => {
          sent.push(message);
          return sent.length === 1 ? first : Promise.resolve();
        },
      },
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    try {
      core.publish();
      core.publish();
      rejectFirst(new Error('first projection unavailable'));
      await flush();
      expect(sent.map((message) => message.kind)).toEqual(['view', 'view-error', 'view']);
      expect(sent.at(-1)?.revision).toBe(2);
      await flush();
      expect(sent).toHaveLength(3);
    } finally {
      core.dispose();
    }
  });

  it('retires draft acknowledgements when a newer return handoff arrives', async () => {
    const bus = new Bus();
    const onDrafts = jest.fn();
    const core = createMainRelayCore({
      instance: 1,
      execute: () => ({ ok: true }),
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts,
      onError: jest.fn(),
    });
    const transfer = (handoff: number): GolemWindowEnvelope => ({
      from: 'satellite',
      message: {
        kind: 'drafts',
        instance: 1,
        handoff,
        id: handoff,
        revision: 1,
        payload: { c1: 'draft' },
      },
    });
    try {
      await core.receive(transfer(1));
      await core.receive(transfer(2));
      await core.receive(transfer(1));
      expect(bus.sent('main', 'ack')).toHaveLength(2);
      expect(onDrafts).toHaveBeenCalledTimes(2);
    } finally {
      core.dispose();
    }
  });

  it('keeps admission in send order and refuses a conflicting body under a used id', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const bus = new Bus();
    const core = createMainRelayCore({
      instance: 1,
      execute: async (action) => {
        order.push(`${action.type}:start`);
        if (action.type === 'select') await firstDone;
        order.push(`${action.type}:end`);
        return { ok: true };
      },
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    try {
      const first = core.receive(actionEnvelope(1, { type: 'select', conversationId: 'c1' }));
      const second = core.receive(actionEnvelope(2, { type: 'clear', conversationId: 'c1' }));
      await flush();
      expect(order).toEqual(['select:start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(['select:start', 'select:end', 'clear:start', 'clear:end']);

      // The same id carrying a different body is a contract break, not a retry.
      await core.receive(actionEnvelope(1, { type: 'clear', conversationId: 'c9' }));
      const acks = bus.sent('main', 'ack');
      expect(acks[acks.length - 1].payload).toMatchObject({ id: 1, ok: false });
      expect(order).toEqual(['select:start', 'select:end', 'clear:start', 'clear:end']);
    } finally {
      core.dispose();
    }
  });

  it('answers a throwing execute with a refusal that carries the error and reports it', async () => {
    const bus = new Bus();
    const onError = jest.fn();
    // The refusal and the toast both carry a bounded string; the console is the
    // only place the stack survives, so the log is part of the contract.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    const core = createMainRelayCore({
      instance: 1,
      execute: () => {
        throw new Error('submitTurn exploded');
      },
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError,
    });
    try {
      await core.receive(actionEnvelope(1, { type: 'select', conversationId: 'c1' }));
      const acks = bus.sent('main', 'ack');
      expect(acks).toHaveLength(1);
      expect(acks[0].payload).toEqual({ id: 1, ok: false, reason: 'submitTurn exploded' });
      // A programming error in main is main's to hear about, not only the
      // satellite's to display as a refusal.
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0][0] as Error).message).toBe('submitTurn exploded');
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0][0]).toBe('golem: select action 1 failed');
      expect(logged.mock.calls[0][1]).toBeInstanceOf(Error);
    } finally {
      logged.mockRestore();
      core.dispose();
    }
  });

  it('refuses an unparseable action definitively instead of stranding the waiter', async () => {
    const bus = new Bus();
    const execute = jest.fn();
    const core = createMainRelayCore({
      instance: 1,
      execute,
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    try {
      await core.receive(actionEnvelope(1, { type: 'patchStore', set: {} }));
      expect(execute).not.toHaveBeenCalled();
      expect(bus.sent('main', 'ack')[0].payload).toMatchObject({ id: 1, ok: false });
    } finally {
      core.dispose();
    }
  });

  it('coalesces publishes to one in-flight post and keeps first and latest', async () => {
    const bus = new Bus();
    bus.hold = true;
    let phase = 'a';
    const core = createMainRelayCore({
      instance: 1,
      execute: async () => ({ ok: true }),
      snapshot: () => ({ ...emptyView, selectedConversationId: phase }),
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    try {
      core.publish();
      await flush();
      expect(bus.posts).toHaveLength(1);

      phase = 'b';
      core.publish();
      phase = 'c';
      core.publish();
      phase = 'd';
      core.publish();
      await flush();
      // Maximum active posts is one: nothing else left while the first is held.
      expect(bus.posts).toHaveLength(1);

      bus.posts[0].release();
      await flush();
      expect(bus.posts).toHaveLength(2);
      const views = bus
        .sent('main', 'view')
        .map((m) => (m.payload as GolemView).selectedConversationId);
      expect(views).toEqual(['a', 'd']);
      expect(bus.sent('main', 'view').map((m) => m.revision)).toEqual([1, 2]);
    } finally {
      core.dispose();
    }
  });

  it('retains the newest snapshot and surfaces a failed post without looping', async () => {
    const onError = jest.fn();
    let fail = true;
    let focus = 7;
    const sent: GolemWindowMessage[] = [];
    const core = createMainRelayCore({
      instance: 1,
      execute: async () => ({ ok: true }),
      snapshot: () => ({ ...emptyView, composerFocusRevision: focus }),
      transport: {
        post: async (message) => {
          if (fail) throw new Error('window gone');
          sent.push(message);
        },
      },
      onDrafts: jest.fn(),
      onError,
    });
    try {
      core.publish();
      await flush();
      // Both the projection and its small failure notification were refused.
      expect(onError).toHaveBeenCalledTimes(2);
      expect(sent).toHaveLength(0);
      // A failed post never retries itself: no spin against a window that died.
      await flush();
      expect(onError).toHaveBeenCalledTimes(2);
      expect(sent).toHaveLength(0);

      // Recovery takes no further publish(): the core's next flush — here the
      // one an action's ack forces — carries the newest snapshot, exactly once.
      fail = false;
      focus = 9;
      await core.receive(actionEnvelope(1, { type: 'select', conversationId: 'c1' }));
      await flush();
      const views = sent.filter((message) => message.kind === 'view');
      expect(views).toHaveLength(1);
      expect((views[0].payload as GolemView).composerFocusRevision).toBe(9);
      expect(onError).toHaveBeenCalledTimes(2);
    } finally {
      core.dispose();
    }
  });

  it('replays the original refusal when an unparseable action is retried', async () => {
    const bus = new Bus();
    const execute = jest.fn();
    const core = createMainRelayCore({
      instance: 1,
      execute,
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    try {
      const payload = { type: 'patchStore', set: {} };
      await core.receive(actionEnvelope(1, payload));
      // A lost ack is retried under the same id and body: the refusal is the
      // settled answer for that id, never a conflict with a newer sequence.
      await core.receive(actionEnvelope(1, payload));
      const acks = bus.sent('main', 'ack');
      expect(acks).toHaveLength(2);
      for (const ack of acks)
        expect(ack.payload).toEqual({ id: 1, ok: false, reason: RELAY_ACTION_REFUSED });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      core.dispose();
    }
  });

  it('ignores an abort and a foreign instance without touching any state', async () => {
    const bus = new Bus();
    const execute = jest.fn();
    const onDrafts = jest.fn();
    const onError = jest.fn();
    const core = createMainRelayCore({
      instance: 1,
      execute,
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts,
      onError,
    });
    try {
      // B5/B6 own the abort handshake; the relay core has nothing to do with it.
      await core.receive({
        from: 'satellite',
        message: { kind: 'abort', instance: 1, handoff: 2, id: 0, revision: 0, payload: null },
      });
      expect(onError).not.toHaveBeenCalled();

      // A message from a previous window instance admits nothing, installs no
      // drafts and answers nothing; it is only reported as unexpected.
      const foreign = 2;
      await core.receive({
        from: 'satellite',
        message: {
          kind: 'action',
          instance: foreign,
          handoff: 0,
          id: 1,
          revision: 0,
          payload: { type: 'select', conversationId: 'c1' },
        },
      });
      await core.receive({
        from: 'satellite',
        message: {
          kind: 'drafts',
          instance: foreign,
          handoff: 1,
          id: 1,
          revision: 0,
          payload: { c1: 'foreign' },
        },
      });
      await flush();
      expect(execute).not.toHaveBeenCalled();
      expect(onDrafts).not.toHaveBeenCalled();
      expect(bus.posts).toHaveLength(0);
      expect(onError).toHaveBeenCalledTimes(2);
    } finally {
      core.dispose();
    }
  });
});

describe('satellite core', () => {
  function makeSatellite(overrides: Partial<Parameters<typeof createSatelliteCore>[0]> = {}) {
    const bus = new Bus();
    const onView = jest.fn();
    const onAdmission = jest.fn();
    const onDrafts = jest.fn();
    const onError = jest.fn();
    const core = createSatelliteCore({
      instance: 1,
      transport: bus.transport('satellite'),
      ackTimeoutMs: 1000,
      maxAttempts: 3,
      onView,
      onAdmission,
      onDrafts,
      onError,
      ...overrides,
    });
    bus.satellite = core;
    return { bus, core, onView, onAdmission, onDrafts, onError };
  }

  function ackEnvelope(message: GolemWindowMessage, ack: GolemAck): GolemWindowEnvelope {
    return {
      from: 'main',
      message: {
        kind: 'ack',
        instance: 1,
        handoff: message.handoff,
        id: message.id,
        revision: 1,
        payload: ack,
      },
    };
  }

  it('refuses a payload above the byte limit before it can block the queue', async () => {
    const { bus, core } = makeSatellite();
    // Exercise admission without creating a large prompt: the encoder reports
    // a boundary result, while the real relay owns rejection and queue state.
    const encode = jest
      .spyOn(TextEncoder.prototype, 'encode')
      .mockReturnValueOnce(new Uint8Array(GOLEM_WINDOW_MAX_PAYLOAD_BYTES + 1));
    const outcome: unknown[] = [];
    const action = { type: 'send', conversationId: 'c1', text: '測定' } as const;
    try {
      void core.send(action).then(
        (ack) => outcome.push(ack),
        (error) => outcome.push(error)
      );
      await flush();
      expect(outcome[0]).toBeInstanceOf(Error);
      expect(encode).toHaveBeenCalledWith(JSON.stringify(action));
      expect(bus.sent('satellite', 'action')).toHaveLength(0);
      const next = core.send({ type: 'select', conversationId: 'c1' });
      await flush();
      const message = bus.sent('satellite', 'action')[0];
      core.receive(ackEnvelope(message, { id: message.id, ok: true }));
      await expect(next).resolves.toMatchObject({ ok: true });
    } finally {
      encode.mockRestore();
      core.dispose();
    }
  });

  it('keeps projection failure until a covering view installs, then ignores stale errors', () => {
    const events: string[] = [];
    const overrides = {
      onView: () => events.push('view'),
      onProjectionError: (reason: string | null) => events.push(reason ?? 'recovered'),
    };
    const { core } = makeSatellite(overrides);
    const failed = (revision: number): GolemWindowEnvelope => ({
      from: 'main',
      message: {
        kind: 'view-error',
        instance: 1,
        id: 0,
        handoff: 0,
        revision,
        payload: { reason: 'projection unavailable' },
      },
    });
    try {
      core.receive({ from: 'main', message: viewMessage(1) });
      core.receive(failed(3));
      core.receive({ from: 'main', message: viewMessage(2) });
      expect(events).toEqual(['view', 'projection unavailable']);
      core.receive({ from: 'main', message: viewMessage(4) });
      expect(events).toEqual(['view', 'projection unavailable', 'view', 'recovered']);
      core.receive(failed(3));
      expect(events).toHaveLength(4);
    } finally {
      core.dispose();
    }
  });

  it('forgets an aborted transfer without letting an older handoff restart', async () => {
    const { core } = makeSatellite();
    try {
      const old = core.beginHandoff(1, () => ({ c1: 'old draft' }));
      void old.catch(() => undefined);
      await flush();
      core.abortHandoff(1, 'first attempt ended');
      const current = core.beginHandoff(2, () => ({ c1: 'current draft' }));
      void current.catch(() => undefined);
      await expect(core.beginHandoff(1, () => ({}))).rejects.toThrow('closed handoff');
      expect(core.beginHandoff(2, () => ({}))).toBe(current);
    } finally {
      core.dispose();
    }
  });

  it('installs only newer views and never lets a null bootstrap erase one', () => {
    const { core, onView } = makeSatellite();
    try {
      core.receive({
        from: 'main',
        message: viewMessage(4, { ...emptyView, composerFocusRevision: 4 }),
      });
      expect(onView).toHaveBeenCalledTimes(1);
      // A late bootstrap that predates the live view must not roll it back.
      core.installBootstrap({ ...emptyView, composerFocusRevision: 1 }, 2);
      // Only the null guard can reject this one: its revision outranks the live
      // view, so it must neither erase the projection nor advance the revision.
      core.installBootstrap(null, 9);
      core.receive({ from: 'main', message: viewMessage(3) });
      expect(onView).toHaveBeenCalledTimes(1);

      core.receive({
        from: 'main',
        message: viewMessage(5, { ...emptyView, composerFocusRevision: 5 }),
      });
      expect(onView).toHaveBeenCalledTimes(2);
      expect(onView.mock.calls[1][0].composerFocusRevision).toBe(5);
    } finally {
      core.dispose();
    }
  });

  it('posts only the head action and unlocks the host before the queue advances', async () => {
    const { bus, core, onAdmission } = makeSatellite();
    try {
      const first = core.send({ type: 'send', conversationId: 'c1', text: 'one' });
      const second = core.send({ type: 'send', conversationId: 'c1', text: 'two' });
      await flush();
      expect(bus.sent('satellite', 'action')).toHaveLength(1);

      const head = bus.sent('satellite', 'action')[0];
      const seen: string[] = [];
      onAdmission.mockImplementation((action: GolemViewAction) => {
        seen.push(`admit:${bus.sent('satellite', 'action').length}`);
        expect(action.type).toBe('send');
      });
      core.receive(ackEnvelope(head, { id: head.id, ok: true }));
      await expect(first).resolves.toEqual({ id: head.id, ok: true });
      // The host was told before the next action went out.
      expect(seen).toEqual(['admit:1']);
      await flush();
      const posted = bus.sent('satellite', 'action');
      expect(posted).toHaveLength(2);
      expect(posted[1].id).toBeGreaterThan(posted[0].id);

      core.receive(ackEnvelope(posted[1], { id: posted[1].id, ok: false, reason: 'busy' }));
      // A definitive refusal resolves; it never rejects the caller's promise.
      await expect(second).resolves.toEqual({ id: posted[1].id, ok: false, reason: 'busy' });
    } finally {
      core.dispose();
    }
  });

  it('retries the same envelope on a lost ack, then stops and keeps it pending', async () => {
    jest.useFakeTimers();
    const { bus, core, onError } = makeSatellite();
    try {
      const pending = core.send({ type: 'send', conversationId: 'c1', text: 'one' });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await flush();
      const id = bus.sent('satellite', 'action')[0].id;

      jest.advanceTimersByTime(1000);
      await flush();
      jest.advanceTimersByTime(1000);
      await flush();
      const attempts = bus.sent('satellite', 'action');
      expect(attempts).toHaveLength(3);
      expect(attempts.every((m) => m.id === id)).toBe(true);

      // Bounded: the third timeout stops the timers instead of retrying forever.
      jest.advanceTimersByTime(10_000);
      await flush();
      expect(bus.sent('satellite', 'action')).toHaveLength(3);
      expect(onError).toHaveBeenCalledTimes(1);
      // Uncertain, not refused: the caller is still waiting on the same id.
      expect(settled).toBe(false);

      core.retryPending();
      await flush();
      const retried = bus.sent('satellite', 'action');
      expect(retried).toHaveLength(4);
      expect(retried[3].id).toBe(id);

      core.receive(ackEnvelope(retried[3], { id, ok: true }));
      await expect(pending).resolves.toEqual({ id, ok: true });
    } finally {
      core.dispose();
      jest.useRealTimers();
    }
  });

  it('installs a transfer that arrives before the first projection, once, on arrival', async () => {
    const { bus, core, onDrafts, onError } = makeSatellite();
    try {
      const drafts: GolemWindowMessage = {
        kind: 'drafts',
        instance: 1,
        handoff: 2,
        id: 5,
        revision: 0,
        payload: { c1: 'typed before any view' },
      };
      // `ready` needs a view revision to quote, so nothing may install yet.
      core.receive({ from: 'main', message: drafts });
      expect(onDrafts).not.toHaveBeenCalled();

      // Main's retry of the same transfer must not be answered from an empty
      // install slot; it simply waits with the first one.
      core.receive({ from: 'main', message: { ...drafts } });
      expect(onDrafts).not.toHaveBeenCalled();

      core.receive({ from: 'main', message: viewMessage(1) });
      expect(onDrafts).toHaveBeenCalledTimes(1);
      expect(onDrafts).toHaveBeenCalledWith({ c1: 'typed before any view' }, 2, 5);

      await core.ready(2, 5);
      const readies = bus.sent('satellite', 'ready');
      expect(readies).toHaveLength(1);
      expect(readies[0]).toMatchObject({ handoff: 2, id: 5, instance: 1 });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      core.dispose();
    }
  });

  it('keeps the newest handoff when two transfers are held before the first projection', () => {
    const { bus, core, onDrafts, onError } = makeSatellite();
    try {
      const newer: GolemWindowMessage = {
        kind: 'drafts',
        instance: 1,
        handoff: 3,
        id: 7,
        revision: 0,
        payload: { c1: 'from the live attempt' },
      };
      const older: GolemWindowMessage = { ...newer, handoff: 2, id: 5, payload: { c1: 'stale' } };
      core.receive({ from: 'main', message: newer });
      // A straggler from a superseded attempt must not displace the live one.
      core.receive({ from: 'main', message: older });
      expect(onDrafts).not.toHaveBeenCalled();

      core.receive({ from: 'main', message: viewMessage(1) });
      expect(onDrafts).toHaveBeenCalledTimes(1);
      expect(onDrafts).toHaveBeenCalledWith({ c1: 'from the live attempt' }, 3, 7);
      expect(bus.sent('satellite', 'ready')).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      core.dispose();
    }
  });

  it('settles an action once even when its acknowledgement arrives twice', async () => {
    const { bus, core, onAdmission, onError } = makeSatellite();
    try {
      const pending = core.send({ type: 'send', conversationId: 'c1', text: 'one' });
      await flush();
      const head = bus.sent('satellite', 'action')[0];
      const ack = ackEnvelope(head, { id: head.id, ok: true });

      core.receive(ack);
      // Main re-acks a replayed action with the same stored message: a delayed
      // first ack is a healthy exchange, not an unexpected one.
      core.receive(ack);
      await expect(pending).resolves.toEqual({ id: head.id, ok: true });
      expect(onAdmission).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      core.dispose();
    }
  });

  it('ignores an abort and a foreign instance without touching any state', async () => {
    const { bus, core, onView, onAdmission, onDrafts, onError } = makeSatellite();
    try {
      // B5/B6 own the abort handshake; the relay core has nothing to do with it.
      core.receive({
        from: 'main',
        message: { kind: 'abort', instance: 1, handoff: 3, id: 0, revision: 1, payload: null },
      });
      expect(onError).not.toHaveBeenCalled();

      core.receive({
        from: 'main',
        message: viewMessage(4, { ...emptyView, composerFocusRevision: 4 }),
      });
      expect(onView).toHaveBeenCalledTimes(1);

      // A message from a previous window instance can neither install a view or
      // a draft map, nor settle a waiter; it is only reported as unexpected.
      const foreign = 2;
      core.receive({
        from: 'main',
        message: {
          ...viewMessage(9, { ...emptyView, composerFocusRevision: 9 }),
          instance: foreign,
        },
      });
      core.receive({
        from: 'main',
        message: {
          kind: 'drafts',
          instance: foreign,
          handoff: 1,
          id: 1,
          revision: 9,
          payload: { c1: 'foreign' },
        },
      });
      const pending = core.send({ type: 'send', conversationId: 'c1', text: 'one' });
      await flush();
      const head = bus.sent('satellite', 'action')[0];
      core.receive({
        from: 'main',
        message: {
          kind: 'ack',
          instance: foreign,
          handoff: 0,
          id: head.id,
          revision: 9,
          payload: { id: head.id, ok: true },
        },
      });
      await flush();
      expect(onView).toHaveBeenCalledTimes(1);
      expect(onDrafts).not.toHaveBeenCalled();
      expect(onAdmission).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(3);

      // The live instance still owns the waiter the foreign ack could not take.
      core.receive(ackEnvelope(head, { id: head.id, ok: true }));
      await expect(pending).resolves.toEqual({ id: head.id, ok: true });
    } finally {
      core.dispose();
    }
  });

  it('installs a transferred draft map once and only readies after installing', async () => {
    const { bus, core, onDrafts, onError } = makeSatellite();
    try {
      core.receive({ from: 'main', message: viewMessage(1) });
      const drafts: GolemWindowMessage = {
        kind: 'drafts',
        instance: 1,
        handoff: 2,
        id: 5,
        revision: 1,
        payload: { c1: 'typed here', c2: '' },
      };
      core.receive({ from: 'main', message: drafts });
      core.receive({ from: 'main', message: { ...drafts } });
      expect(onDrafts).toHaveBeenCalledTimes(1);
      expect(onDrafts).toHaveBeenCalledWith({ c1: 'typed here', c2: '' }, 2, 5);
      expect(bus.sent('satellite', 'ready')).toHaveLength(0);

      await core.ready(2, 5);
      const readies = bus.sent('satellite', 'ready');
      expect(readies).toHaveLength(1);
      expect(readies[0]).toMatchObject({ handoff: 2, id: 5, instance: 1 });

      // A late duplicate replays the response; it never re-installs over typing.
      core.receive({ from: 'main', message: { ...drafts } });
      await flush();
      expect(onDrafts).toHaveBeenCalledTimes(1);
      expect(bus.sent('satellite', 'ready')).toHaveLength(2);

      // A stale handoff can neither install nor be readied.
      core.receive({ from: 'main', message: { ...drafts, handoff: 1, id: 9 } });
      expect(onDrafts).toHaveBeenCalledTimes(1);
      await expect(core.ready(9, 99)).rejects.toThrow();
      expect(onError).toHaveBeenCalled();
    } finally {
      core.dispose();
    }
  });

  it('drains admissions before reading drafts and only closes on a matching ack', async () => {
    const { bus, core, onError } = makeSatellite();
    const drafts: GolemDraftMap = { c1: 'hello', c2: '', c3: 'unselected' };
    const readDrafts = jest.fn(() => ({ ...drafts }));
    try {
      const send = core.send({ type: 'send', conversationId: 'c1', text: 'hello' });
      await flush();
      const action = bus.sent('satellite', 'action')[0];

      let closed = false;
      const handoff = core.beginHandoff(4, readDrafts);
      void handoff.then(() => {
        closed = true;
      });
      // New actions are blocked the moment the handoff starts.
      await expect(core.send({ type: 'clear', conversationId: 'c1' })).rejects.toThrow();
      await flush();
      // An unacknowledged Send prevents close: nothing was read or transferred.
      expect(readDrafts).not.toHaveBeenCalled();
      expect(bus.sent('satellite', 'drafts')).toHaveLength(0);

      // The host clears the source draft inside its admission callback, so the
      // getter must run after the drain, not before it.
      drafts.c1 = '';
      core.receive(ackEnvelope(action, { id: action.id, ok: true }));
      await send;
      await flush();
      expect(readDrafts).toHaveBeenCalledTimes(1);
      const transfer = bus.sent('satellite', 'drafts')[0];
      expect(transfer.payload).toEqual({ c1: '', c2: '', c3: 'unselected' });
      expect(transfer.handoff).toBe(4);
      expect(closed).toBe(false);

      // A stale handoff ack cannot settle the current waiter.
      core.receive({
        from: 'main',
        message: { ...transfer, kind: 'ack', handoff: 3, payload: { id: transfer.id, ok: true } },
      });
      await flush();
      expect(closed).toBe(false);
      expect(onError).toHaveBeenCalled();

      core.receive({
        from: 'main',
        message: {
          kind: 'ack',
          instance: 1,
          handoff: 4,
          id: transfer.id,
          revision: 1,
          payload: { id: transfer.id, ok: true },
        },
      });
      await handoff;
      expect(closed).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it('never resolves a handoff whose transfer is refused or unanswered', async () => {
    jest.useFakeTimers();
    const { bus, core } = makeSatellite();
    try {
      const refused = core.beginHandoff(1, () => ({ c1: 'kept' }));
      const rejection = refused.catch((error: Error) => error);
      await flush();
      const transfer = bus.sent('satellite', 'drafts')[0];
      core.receive({
        from: 'main',
        message: {
          kind: 'ack',
          instance: 1,
          handoff: 1,
          id: transfer.id,
          revision: 1,
          payload: { id: transfer.id, ok: false, reason: 'main is closing' },
        },
      });
      await expect(rejection).resolves.toBeInstanceOf(Error);

      // The unanswered case exhausts its retries on the SAME id and stays open.
      const stalled = core.beginHandoff(2, () => ({ c1: 'kept' }));
      let closed = false;
      void stalled.then(
        () => {
          closed = true;
        },
        () => {
          closed = true;
        }
      );
      await flush();
      const first = bus.sent('satellite', 'drafts').filter((m) => m.handoff === 2)[0];
      for (let i = 0; i < 4; i += 1) {
        jest.advanceTimersByTime(1000);
        await flush();
      }
      const attempts = bus.sent('satellite', 'drafts').filter((m) => m.handoff === 2);
      expect(attempts).toHaveLength(3);
      expect(attempts.every((m) => m.id === first.id)).toBe(true);
      expect(closed).toBe(false);

      // Re-entering the same handoff reuses the unresolved id, never a new one.
      const again = core.beginHandoff(2, () => ({ c1: 'kept' }));
      expect(again).toBe(stalled);
      await flush();
      expect(
        bus
          .sent('satellite', 'drafts')
          .filter((m) => m.handoff === 2)
          .every((m) => m.id === first.id)
      ).toBe(true);
    } finally {
      core.dispose();
      jest.useRealTimers();
    }
  });

  it('ends an aborted handoff, lifts the barrier, and ignores everything else', async () => {
    jest.useFakeTimers();
    const { bus, core, onError } = makeSatellite();
    try {
      const stalled = core.beginHandoff(1, () => ({ c1: 'kept' }));
      let ended = '';
      void stalled.catch((error: Error) => {
        ended = error.message;
      });
      await flush();
      expect(bus.sent('satellite', 'drafts')).toHaveLength(1);

      // While the transfer is live the barrier holds every action back.
      await expect(core.send({ type: 'select', conversationId: 'c1' })).rejects.toThrow(
        RELAY_HANDOFF_IN_PROGRESS
      );

      // A handoff this core never started is not this core's to end.
      core.abortHandoff(99, 'not this one');
      await flush();
      expect(ended).toBe('');

      core.abortHandoff(1, 'main gave up');
      await flush();
      expect(ended).toBe('main gave up');

      // Its retry timer went with it: nothing re-posts the dead transfer.
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(bus.sent('satellite', 'drafts')).toHaveLength(1);

      // Input is live again, and a second abort of the same handoff is inert.
      const resumed = core.send({ type: 'select', conversationId: 'c1' });
      void resumed.catch(() => undefined);
      await flush();
      expect(bus.sent('satellite', 'action')).toHaveLength(1);
      core.abortHandoff(1, 'again');
      await flush();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      core.dispose();
      jest.useRealTimers();
    }
  });

  it('stops timers and settles waiters on disposal without touching drafts', async () => {
    jest.useFakeTimers();
    const { bus, core, onView, onDrafts } = makeSatellite();
    const pending = core.send({ type: 'send', conversationId: 'c1', text: 'one' });
    const settled = pending.catch((error: Error) => error);
    await flush();
    const posted = bus.sent('satellite', 'action').length;

    core.dispose();
    await expect(settled).resolves.toBeInstanceOf(Error);

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(bus.sent('satellite', 'action')).toHaveLength(posted);
    // Late callbacks are invalidated, and disposal installs nothing.
    core.receive({ from: 'main', message: viewMessage(9) });
    expect(onView).not.toHaveBeenCalled();
    expect(onDrafts).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('main and satellite over one bus', () => {
  it('keeps an edited queue item until a snapshot covers it, and restores it on refusal', async () => {
    const bus = new Bus();
    const views: GolemView[] = [];
    const admissions: GolemAck[] = [];
    let queueText = 'authoritative';
    const main = createMainRelayCore({
      instance: 1,
      execute: (action) => {
        if (action.type !== 'updateQueued') return { ok: true };
        if (action.text === 'refused edit') return { ok: false, reason: 'already dispatched' };
        queueText = action.text;
        return { ok: true };
      },
      snapshot: () => ({ ...emptyView, bridgeError: queueText }),
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    const satellite = createSatelliteCore({
      instance: 1,
      transport: bus.transport('satellite'),
      ackTimeoutMs: 1000,
      maxAttempts: 3,
      onView: (view) => views.push(view),
      onAdmission: (_action, ack) => admissions.push(ack),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    bus.main = main;
    bus.satellite = satellite;
    try {
      main.publish();
      await bus.pump();
      expect(views).toHaveLength(1);

      const edit = satellite.send({
        type: 'updateQueued',
        conversationId: 'c1',
        queueId: 'q1',
        text: 'edited',
      });
      await flush();
      const editId = bus.sent('satellite', 'action')[0].id;

      // A snapshot published from before the edit cannot claim to cover it.
      main.publish();
      await bus.pump(bus.posts.length - 1);
      expect(views[views.length - 1].processedThrough).toBeLessThan(editId);

      await bus.pump();
      await expect(edit).resolves.toEqual({ id: editId, ok: true });
      const covering = views.filter((v) => v.processedThrough >= editId);
      expect(covering).not.toHaveLength(0);
      expect(covering[0].bridgeError).toBe('edited');
      expect(admissions).toEqual([{ id: editId, ok: true }]);

      const refused = satellite.send({
        type: 'updateQueued',
        conversationId: 'c1',
        queueId: 'q1',
        text: 'refused edit',
      });
      await bus.pump();
      const refusedAck = await refused;
      expect(refusedAck.ok).toBe(false);
      expect(refusedAck.reason).toBe('already dispatched');
      // The authoritative queue text is unchanged and re-published.
      expect(views[views.length - 1].bridgeError).toBe('edited');
    } finally {
      satellite.dispose();
      main.dispose();
    }
  });

  it('transfers drafts main to satellite and back inside the handoff barrier', async () => {
    const bus = new Bus();
    const hostDrafts: GolemDraftMap = { c1: 'still typing', c2: '' };
    const received: GolemDraftMap[] = [];
    const main = createMainRelayCore({
      instance: 1,
      execute: () => ({ ok: true }),
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts: (map) => received.push(map),
      onError: jest.fn(),
    });
    let satelliteDrafts: GolemDraftMap = {};
    const satellite = createSatelliteCore({
      instance: 1,
      transport: bus.transport('satellite'),
      ackTimeoutMs: 1000,
      maxAttempts: 3,
      onView: jest.fn(),
      onAdmission: jest.fn(),
      onDrafts: (map, handoff, id) => {
        satelliteDrafts = map;
        void satellite.ready(handoff, id);
      },
      onError: jest.fn(),
    });
    bus.main = main;
    bus.satellite = satellite;
    try {
      main.publish();
      await bus.pump();

      const undock = main.sendDrafts(3, () => ({ ...hostDrafts }));
      await bus.pump();
      await undock;
      expect(satelliteDrafts).toEqual({ c1: 'still typing', c2: '' });

      satelliteDrafts.c1 = 'edited in the satellite';
      const redock = satellite.beginHandoff(4, () => ({ ...satelliteDrafts }));
      await bus.pump();
      await redock;
      expect(received).toEqual([{ c1: 'edited in the satellite', c2: '' }]);
    } finally {
      satellite.dispose();
      main.dispose();
    }
  });

  // The same fixture drives Go's `acceptGolemReady` / `acceptGolemAck` to a
  // committed transition in app_golem_window_lifecycle_test.go
  // (TestGolemWindowWireFixture). Go verifies `ready` and the transfer `ack`
  // against `revision`, so a view revision or a projection counter there is a
  // refused post — which is exactly what this scenario's second publish exposes.
  it('emits the wire shapes Go commits, field for field, from the shared fixture', async () => {
    const bus = new Bus();
    const main = createMainRelayCore({
      instance: wire.instance,
      execute: () => ({ ok: true }),
      snapshot: () => emptyView,
      transport: bus.transport('main'),
      onDrafts: jest.fn(),
      onError: jest.fn(),
    });
    const satellite = createSatelliteCore({
      instance: wire.instance,
      transport: bus.transport('satellite'),
      ackTimeoutMs: 1000,
      maxAttempts: 3,
      onView: jest.fn(),
      onAdmission: jest.fn(),
      onDrafts: (_map, handoff, id) => {
        void satellite.ready(handoff, id);
      },
      onError: jest.fn(),
    });
    bus.main = main;
    bus.satellite = satellite;
    try {
      main.publish();
      await bus.pump();
      main.publish();
      await bus.pump();
      expect(bus.sent('main', 'view')).toEqual(wire.undock.views);

      const undock = main.sendDrafts(wire.undock.handoff, () => ({
        ...wire.undock.drafts.payload,
      }));
      await bus.pump();
      await undock;
      expect(bus.sent('main', 'drafts')).toEqual([wire.undock.drafts]);
      expect(bus.sent('satellite', 'ready')).toEqual([wire.undock.ready]);

      const redock = satellite.beginHandoff(wire.redock.handoff, () => ({
        ...wire.redock.drafts.payload,
      }));
      await bus.pump();
      await redock;
      expect(bus.sent('satellite', 'drafts')).toEqual([wire.redock.drafts]);
      expect(bus.sent('main', 'ack')).toEqual([wire.redock.ack]);
    } finally {
      satellite.dispose();
      main.dispose();
    }
  });
});
