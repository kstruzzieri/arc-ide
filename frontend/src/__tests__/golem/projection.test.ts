import { useDraftStore } from '../../golem/draftStore';
import { buildGolemView } from '../../golem/projection';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { GolemContractError } from '../../types/golem';
import type {
  ConsentChallenge,
  ConversationView,
  ProviderDestination,
  RunIdentity,
} from '../../types/golem';
import { parseGolemView } from '../../types/golemWindow';

beforeEach(() => {
  __resetGolemStore();
  useDraftStore.setState({ drafts: {} });
});

const destination: ProviderDestination = {
  provider: 'ollama',
  model: 'qwen3',
  endpoint: 'http://127.0.0.1:11434',
  classification: 'local',
  digest: 'sha256:abc',
};

const runIdentity: RunIdentity = {
  repoEpoch: 1,
  workspaceId: 'project',
  conversationId: 'c1',
  runId: 'r1',
};

const challenge: ConsentChallenge = {
  id: 'ch1',
  identity: runIdentity,
  destination,
  destinationDigest: destination.digest,
  expiresAt: 1_700_000_000,
};

it('projects store state without drafts or raw events', () => {
  useGolemStore.setState((s) => ({
    selectedConversationId: 'c1',
    conversations: {
      ...s.conversations,
      c1: {
        identity: { repoEpoch: 1, workspaceId: 'project', conversationId: 'c1' },
        workspaceLabel: 'repo',
        available: true,
        needsConsent: false,
        warnings: [],
        initError: null,
        destination: null,
        rawEvents: [{ protocol: 1 } as never],
        transcript: [],
        runs: {},
        activeRunId: null,
        queuedTurns: [],
        pendingConsentTurn: null,
        lastFailedTurn: null,
      },
    },
  }));
  useDraftStore.getState().setDraft('c1', 'secret typing');
  const view = buildGolemView(useGolemStore.getState());
  expect(view.selectedConversationId).toBe('c1');
  expect(view.conversations.c1).not.toHaveProperty('draft');
  expect(view.conversations.c1).not.toHaveProperty('rawEvents');
  expect(view.conversations.c1.workspaceLabel).toBe('repo');
  expect(JSON.stringify(view)).not.toContain('secret typing');
});

/** Every optional and nullable branch the projection can emit, in one place. */
function seedRichConversation(): ConversationView {
  const conversation: ConversationView = {
    identity: { repoEpoch: 1, workspaceId: 'project', conversationId: 'c1' },
    workspaceLabel: 'repo',
    available: true,
    needsConsent: true,
    warnings: ['model is remote'],
    initError: null,
    destination,
    rawEvents: [
      {
        protocol: 1,
        threadId: 'c1',
        runId: 'r1',
        seq: 4,
        type: 'tool',
        payload: { secret: 'raw-event-body' },
        raw: '{"secret":"raw-event-body"}',
      },
    ],
    transcript: [
      { id: 'e1', runId: 'r1', kind: 'user', text: 'ship it' },
      {
        id: 'e2',
        runId: 'r1',
        kind: 'tool',
        text: 'reading files',
        toolCallId: 'tc1',
        toolName: 'read',
        activity: 'running',
        raw: {
          protocol: 1,
          threadId: 'c1',
          runId: 'r1',
          seq: 4,
          type: 'tool',
          payload: null,
          raw: '{"secret":"raw-entry-body"}',
        },
      },
      { id: 'e3', runId: 'r2', kind: 'error', text: 'model refused' },
    ],
    runs: {
      r1: {
        identity: runIdentity,
        phase: 'running',
        lastSeq: 4,
        request: { message: 'owner-only prompt', contextRefs: ['a.ts'] },
        userEntryId: 'e1',
      },
      r2: {
        identity: { ...runIdentity, runId: 'r2' },
        phase: 'failed',
        lastSeq: 0,
        error: 'model refused',
      },
      // The store's initial/unknown sequence sentinel, which every freshly
      // admitted run carries until its first event arrives.
      r3: { identity: { ...runIdentity, runId: 'r3' }, phase: 'admitting', lastSeq: -1 },
    },
    activeRunId: 'r1',
    queuedTurns: [
      { queueId: 'q1', state: 'queued', message: 'next up', contextRefs: [] },
      {
        queueId: 'q2',
        state: 'reopen-required',
        message: 'blocked',
        contextRefs: ['b.ts'],
        userEntryId: 'e9',
      },
    ],
    pendingConsentTurn: {
      draft: { message: 'owner-only consent prompt', contextRefs: [] },
      identity: runIdentity,
      challenge,
      userEntryId: 'e1',
    },
    lastFailedTurn: { draft: { message: 'owner-only retry', contextRefs: [] }, userEntryId: 'e3' },
  };
  useGolemStore.setState((s) => ({
    selectedConversationId: 'c1',
    hydratedIdentity: conversation.identity,
    bridgePhase: 'ready',
    conversations: { ...s.conversations, c1: conversation },
  }));
  // The composer text lives in the visible host now (#271 B4), never in the
  // store — so the projection cannot ship it even by accident. The assertion
  // that a serialized view never contains it stays exactly as strict.
  useDraftStore.getState().setDraft('c1', 'secret typing');
  return conversation;
}

it('round-trips a rich projection through JSON and its own parser', () => {
  seedRichConversation();
  const view = buildGolemView(useGolemStore.getState());
  const wire: unknown = JSON.parse(JSON.stringify(view));
  expect(parseGolemView(wire)).toEqual(view);

  const serialized = JSON.stringify(view);
  expect(serialized).not.toContain('secret typing');
  expect(serialized).not.toContain('raw-event-body');
  expect(serialized).not.toContain('raw-entry-body');
  expect(serialized).not.toContain('owner-only');

  const projected = view.conversations.c1;
  expect(projected.lastFailedTurn).toBe(true);
  expect(projected.pendingConsentTurn).toEqual({ identity: runIdentity, challenge });
  expect(projected.runs.r1).toEqual({ identity: runIdentity, phase: 'running', lastSeq: 4 });
  expect(projected.runs.r2.error).toBe('model refused');
  expect(projected.runs.r3.lastSeq).toBe(-1);
  expect(projected.transcript[1]).toEqual({
    id: 'e2',
    runId: 'r1',
    kind: 'tool',
    text: 'reading files',
    toolCallId: 'tc1',
    toolName: 'read',
    activity: 'running',
  });
  expect(projected.queuedTurns).toEqual([
    { queueId: 'q1', state: 'queued', message: 'next up', contextRefs: [] },
    {
      queueId: 'q2',
      state: 'reopen-required',
      message: 'blocked',
      contextRefs: ['b.ts'],
      userEntryId: 'e9',
    },
  ]);
});

it('copies the live arrays it carries rather than aliasing store state', () => {
  const conversation = seedRichConversation();
  const projected = buildGolemView(useGolemStore.getState()).conversations.c1;
  // An in-flight payload must not be mutable through the store it came from.
  expect(projected.warnings).not.toBe(conversation.warnings);
  expect(projected.warnings).toEqual(conversation.warnings);
  expect(projected.queuedTurns).not.toBe(conversation.queuedTurns);
  expect(projected.queuedTurns[0]).not.toBe(conversation.queuedTurns[0]);
  expect(projected.queuedTurns[1].contextRefs).not.toBe(conversation.queuedTurns[1].contextRefs);
  expect(projected.queuedTurns).toEqual(conversation.queuedTurns);
});

type Mutate = (wire: Record<string, never>) => void;

/** Each mutation breaks exactly one nested field the parser must reject. */
const corruptions: ReadonlyArray<readonly [string, Mutate]> = [
  ['unknown bridge phase', (w) => ((w as never as { bridgePhase: string }).bridgePhase = 'warm')],
  [
    'fractional composer revision',
    (w) => ((w as never as { composerFocusRevision: number }).composerFocusRevision = 1.5),
  ],
  [
    'negative processed watermark',
    (w) => ((w as never as { processedThrough: number }).processedThrough = -1),
  ],
  [
    'conversation key that disagrees with its identity',
    (w) => {
      const view = w as never as { conversations: Record<string, unknown> };
      view.conversations.c2 = view.conversations.c1;
      delete view.conversations.c1;
    },
  ],
  [
    'non-integer repo epoch',
    (w) =>
      ((
        w as never as { conversations: { c1: { identity: { repoEpoch: number } } } }
      ).conversations.c1.identity.repoEpoch = 1.25),
  ],
  [
    'warnings holding a non-string',
    (w) =>
      ((
        w as never as { conversations: { c1: { warnings: unknown[] } } }
      ).conversations.c1.warnings = [7]),
  ],
  [
    'undefined initError instead of null',
    (w) => {
      delete (w as never as { conversations: { c1: { initError?: unknown } } }).conversations.c1
        .initError;
    },
  ],
  [
    'destination missing its classification',
    (w) => {
      delete (
        w as never as { conversations: { c1: { destination: { classification?: unknown } } } }
      ).conversations.c1.destination.classification;
    },
  ],
  [
    'unknown transcript kind',
    (w) =>
      ((
        w as never as { conversations: { c1: { transcript: { kind: string }[] } } }
      ).conversations.c1.transcript[0].kind = 'system'),
  ],
  [
    'unknown transcript activity',
    (w) =>
      ((
        w as never as { conversations: { c1: { transcript: { activity: string }[] } } }
      ).conversations.c1.transcript[1].activity = 'thinking'),
  ],
  [
    'unknown run phase',
    (w) =>
      ((
        w as never as { conversations: { c1: { runs: Record<string, { phase: string }> } } }
      ).conversations.c1.runs.r1.phase = 'thinking'),
  ],
  [
    'run sequence below the unknown sentinel',
    (w) =>
      ((
        w as never as { conversations: { c1: { runs: Record<string, { lastSeq: number }> } } }
      ).conversations.c1.runs.r1.lastSeq = -2),
  ],
  [
    'fractional run sequence',
    (w) =>
      ((
        w as never as { conversations: { c1: { runs: Record<string, { lastSeq: number }> } } }
      ).conversations.c1.runs.r1.lastSeq = 4.5),
  ],
  [
    'run key that disagrees with its identity',
    (w) => {
      const runs = (w as never as { conversations: { c1: { runs: Record<string, unknown> } } })
        .conversations.c1.runs;
      runs.r3 = runs.r1;
      delete runs.r1;
    },
  ],
  [
    'unknown queue state',
    (w) =>
      ((
        w as never as { conversations: { c1: { queuedTurns: { state: string }[] } } }
      ).conversations.c1.queuedTurns[0].state = 'sent'),
  ],
  [
    'queued turn without contextRefs',
    (w) => {
      delete (w as never as { conversations: { c1: { queuedTurns: { contextRefs?: unknown }[] } } })
        .conversations.c1.queuedTurns[0].contextRefs;
    },
  ],
  [
    'consent challenge missing its destination',
    (w) => {
      delete (
        w as never as {
          conversations: { c1: { pendingConsentTurn: { challenge: { destination?: unknown } } } };
        }
      ).conversations.c1.pendingConsentTurn.challenge.destination;
    },
  ],
  [
    'retry availability as a draft rather than a boolean',
    (w) =>
      ((
        w as never as { conversations: { c1: { lastFailedTurn: unknown } } }
      ).conversations.c1.lastFailedTurn = { message: 'owner-only retry' }),
  ],
];

it.each(corruptions)('rejects a projection with %s', (_label, mutate) => {
  seedRichConversation();
  const wire = JSON.parse(JSON.stringify(buildGolemView(useGolemStore.getState())));
  expect(parseGolemView(wire)).toBeDefined();
  mutate(wire);
  expect(() => parseGolemView(wire)).toThrow(GolemContractError);
});
