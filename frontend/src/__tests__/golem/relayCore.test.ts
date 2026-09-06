import {
  createMainRelayCore,
  createSatelliteCore,
  type MainRelayCore,
  type SatelliteCore,
} from '../../golem/relayCore';
import type { GolemActionResult } from '../../types/golem';
import type {
  GolemAck,
  GolemDraftMap,
  GolemView,
  GolemViewAction,
  GolemWindowEnvelope,
  GolemWindowMessage,
} from '../../types/golemWindow';

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
    const sent: GolemWindowMessage[] = [];
    const core = createMainRelayCore({
      instance: 1,
      execute: async () => ({ ok: true }),
      snapshot: () => ({ ...emptyView, composerFocusRevision: 7 }),
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
      expect(onError).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(0);

      fail = false;
      core.publish();
      await flush();
      expect(sent).toHaveLength(1);
      expect((sent[0].payload as GolemView).composerFocusRevision).toBe(7);
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
      core.installBootstrap(null, 0);
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
});
