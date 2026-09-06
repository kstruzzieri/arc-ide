/**
 * Task B7 — conversation-keyed Golem store.
 *
 * TDD: written before `src/types/golem.ts` and `src/stores/golemStore.ts` exist.
 *
 * Two concerns live here because they are one contract:
 *  - boundary validators that turn `unknown` Wails payloads into declared types
 *    without a single unchecked cast;
 *  - the conversation/run reducer that keeps streamed transcripts, queues, and
 *    consent state monotonic across deferred promises and epoch changes.
 */

import { ai } from '../../wails/bindings';
import {
  boundedGolemMessage,
  GolemContractError,
  parseGolemEvent,
  parseGolemStatus,
  parseRunStatus,
  parseTurnAdmission,
  toCancelRequest,
  toStatusRequest,
  toTurnRequest,
} from '../../types/golem';
import type { ConversationView, GolemStatus, QueuedTurn, TurnAdmission } from '../../types/golem';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';

// ── Wails mocks ───────────────────────────────────────────────────────────────

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

// ── crypto.randomUUID control ─────────────────────────────────────────────────

/**
 * Exhausting the queue must never be mistaken for the guard under test:
 * `secureRandomUUID` converts every throw into the same `null` that a missing
 * `crypto.randomUUID` produces, so a test that simply forgot to stage an ID
 * would otherwise pass through the identical `NO_SECURE_UUID_ERROR` path. The
 * flag makes exhaustion fail its own test loudly instead.
 */
let uuidQueue: string[] = [];
let uuidExhausted = false;
const mockRandomUUID = jest.fn(() => {
  const next = uuidQueue.shift();
  if (!next) {
    uuidExhausted = true;
    throw new Error('test exhausted the queued UUIDs');
  }
  return next;
});

afterEach(() => {
  expect(uuidExhausted).toBe(false);
});

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const installCrypto = (value: unknown) => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value });
};

afterAll(() => {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
});

// ── fixtures ──────────────────────────────────────────────────────────────────

const EPOCH = 7;
const WS = 'frontend';
const CONV = 'conv-frontend';
const OTHER_WS = 'backend';
const OTHER_CONV = 'conv-backend';
const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const RUN_C = '33333333-3333-4333-8333-333333333333';

const identity = { repoEpoch: EPOCH, workspaceId: WS, conversationId: CONV };
const runIdentity = (runId: string, over: Partial<typeof identity> = {}) => ({
  ...identity,
  ...over,
  runId,
});

const remoteDestination = {
  provider: 'anthropic',
  model: 'claude',
  endpoint: 'https://api.example.test',
  classification: 'remote' as const,
  digest: 'digest-remote',
};
const localDestination = {
  ...remoteDestination,
  classification: 'local' as const,
  digest: 'local',
};

/** Matches `consentChallengeTTL` closely enough to exercise both sides of it. */
const CHALLENGE_TTL_MS = 5 * 60_000;

const challengeFor = (runId: string, over: Record<string, unknown> = {}) => ({
  id: 'challenge-1',
  identity: runIdentity(runId),
  destination: remoteDestination,
  destinationDigest: remoteDestination.digest,
  // Relative to the clock so the suite cannot become time-dependent.
  expiresAt: Date.now() + CHALLENGE_TTL_MS,
  ...over,
});

const statusPayload = (over: Record<string, unknown> = {}) => ({
  available: true,
  workspaceLabel: 'Frontend',
  identity,
  destination: localDestination,
  needsConsent: false,
  activeRuns: [],
  ...over,
});

const admissionPayload = (runId: string, over: Record<string, unknown> = {}) => ({
  state: 'accepted',
  identity: runIdentity(runId),
  destination: localDestination,
  context: { included: 0, bytes: 0, excluded: 0 },
  ...over,
});

const eventPayload = (over: Record<string, unknown> = {}) => ({
  protocol: 1,
  threadId: CONV,
  runId: RUN_A,
  seq: 1,
  type: 'run.started',
  payload: {},
  raw: '{"type":"run.started"}',
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const store = () => useGolemStore.getState();
const conv = (id = CONV): ConversationView => {
  const found = store().conversations[id];
  if (!found) throw new Error(`no conversation ${id}`);
  return found;
};

/** Hydrate a ready, available conversation and select it. */
const hydrateReady = (over: Record<string, unknown> = {}) => {
  store().hydrateStatus(parseGolemStatus(statusPayload(over)));
  store().selectConversation(CONV);
};

beforeEach(() => {
  __resetGolemStore();
  jest.clearAllMocks();
  uuidQueue = [];
  uuidExhausted = false;
  installCrypto({ randomUUID: mockRandomUUID });
  // The backend echoes the submitted identity; the default mock must too.
  mockRunGolemTurn.mockImplementation((request: ai.TurnRequest) =>
    Promise.resolve({
      state: 'accepted',
      identity: { ...request.identity },
      destination: localDestination,
      context: { included: 0, bytes: 0, excluded: 0 },
    })
  );
  mockCancelGolemRun.mockResolvedValue(true);
  mockGetGolemStatus.mockResolvedValue(statusPayload());
  mockGetWorkspaceInfo.mockResolvedValue({ name: '', path: '', repoKey: '', repoEpoch: EPOCH });
});

// ─────────────────────────────────────────────────────────────────────────────
// B7.1 — boundary validators
// ─────────────────────────────────────────────────────────────────────────────

describe('boundary validators', () => {
  it('accepts a plain status object and normalizes the optional fields', () => {
    const parsed = parseGolemStatus(
      statusPayload({ warnings: ['policy drift'], initError: 'Golem is unavailable.' })
    );
    expect(parsed.available).toBe(true);
    expect(parsed.identity).toEqual(identity);
    expect(parsed.destination).toEqual(localDestination);
    expect(parsed.warnings).toEqual(['policy drift']);
    expect(parsed.initError).toBe('Golem is unavailable.');
    expect(parsed.activeRuns).toEqual([]);
  });

  it('accepts a generated ai.Status instance', () => {
    const generated = ai.Status.createFrom(
      statusPayload({
        activeRuns: [
          { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
        ],
      })
    );
    const parsed = parseGolemStatus(generated);
    expect(parsed.activeRuns).toEqual([
      { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
    ]);
    expect(parsed.destination?.classification).toBe('local');
  });

  it('drops absent optional status fields rather than inventing them', () => {
    const parsed = parseGolemStatus(statusPayload({ destination: undefined }));
    expect(parsed.destination).toBeUndefined();
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.initError).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', []],
    ['a missing identity', statusPayload({ identity: undefined })],
    ['a partial identity', statusPayload({ identity: { repoEpoch: 1, workspaceId: 'x' } })],
    ['a non-boolean available', statusPayload({ available: 'yes' })],
    ['a non-array activeRuns', statusPayload({ activeRuns: null })],
    [
      'an unknown active-run state',
      statusPayload({
        activeRuns: [{ identity: runIdentity(RUN_A), workspaceLabel: 'x', state: 'paused' }],
      }),
    ],
    [
      'an unknown destination classification',
      statusPayload({ destination: { ...localDestination, classification: 'hybrid' } }),
    ],
    ['a non-string warning', statusPayload({ warnings: [1] })],
  ])('rejects %s', (_label, value) => {
    expect(() => parseGolemStatus(value)).toThrow(GolemContractError);
  });

  it('reports a bounded contract message that never echoes the payload', () => {
    let thrown: unknown;
    try {
      parseGolemStatus({ available: true, secret: 'API_KEY_MARKER' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GolemContractError);
    const message = (thrown as Error).message;
    expect(message).not.toContain('API_KEY_MARKER');
    expect(message.length).toBeLessThanOrEqual(120);
  });

  it('accepts accepted admissions as plain objects and generated instances', () => {
    const plain = parseTurnAdmission(admissionPayload(RUN_A));
    expect(plain.state).toBe('accepted');
    expect(plain.identity).toEqual(runIdentity(RUN_A));

    const generated = parseTurnAdmission(ai.TurnAdmission.createFrom(admissionPayload(RUN_A)));
    expect(generated.state).toBe('accepted');
    expect(generated.context).toEqual({ included: 0, bytes: 0, excluded: 0 });
  });

  it('accepts a needs_consent admission whose challenge matches identity, destination and digest', () => {
    const parsed = parseTurnAdmission(
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A),
      })
    );
    expect(parsed.state).toBe('needs_consent');
    if (parsed.state !== 'needs_consent') throw new Error('unreachable');
    expect(parsed.consentChallenge.id).toBe('challenge-1');
  });

  it.each<[string, unknown]>([
    ['an unknown state', admissionPayload(RUN_A, { state: 'queued' })],
    [
      'an accepted admission carrying a challenge',
      admissionPayload(RUN_A, { consentChallenge: challengeFor(RUN_A) }),
    ],
    [
      'needs_consent without a challenge',
      admissionPayload(RUN_A, { state: 'needs_consent', destination: remoteDestination }),
    ],
    [
      'needs_consent with a null challenge',
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: null,
      }),
    ],
    [
      'a challenge naming another run',
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_B),
      }),
    ],
    [
      'a challenge naming another epoch',
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A, {
          identity: { ...runIdentity(RUN_A), repoEpoch: EPOCH + 1 },
        }),
      }),
    ],
    [
      'a challenge naming another workspace',
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A, {
          identity: { ...runIdentity(RUN_A), workspaceId: OTHER_WS },
        }),
      }),
    ],
    [
      'a challenge naming another conversation',
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A, {
          identity: { ...runIdentity(RUN_A), conversationId: OTHER_CONV },
        }),
      }),
    ],
    [
      'a challenge naming another destination',
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A, {
          destination: { ...remoteDestination, endpoint: 'https://elsewhere.test' },
        }),
      }),
    ],
    [
      'a challenge whose destinationDigest drifted',
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A, { destinationDigest: 'other' }),
      }),
    ],
    ['a missing context receipt', admissionPayload(RUN_A, { context: undefined })],
  ])('rejects %s', (_label, value) => {
    expect(() => parseTurnAdmission(value)).toThrow(GolemContractError);
  });

  it.each([
    ['run.started', {}],
    ['message.delta', { messageId: 'm1', text: 'hi' }],
    ['tool.started', { toolCallId: 't1', name: 'read', preview: 'read(a)' }],
    ['tool.finished', { toolCallId: 't1', name: 'read', preview: 'ok', isError: false }],
    ['run.finished', { stopReason: 'end_turn', model: 'claude' }],
    ['run.failed', { code: 'run_failed', message: 'The Golem run failed.' }],
    ['run.canceled', {}],
  ])('accepts the %s envelope', (type, payload) => {
    const parsed = parseGolemEvent(eventPayload({ type, payload }));
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe(type);
    expect(parsed!.payload).toEqual(payload);
    expect(parsed!.protocol).toBe(1);
  });

  it.each<[string, unknown]>([
    ['a non-object', 42],
    ['an unsupported protocol', eventPayload({ protocol: 2 })],
    ['a missing threadId', eventPayload({ threadId: '' })],
    ['a missing runId', eventPayload({ runId: undefined })],
    ['a non-numeric seq', eventPayload({ seq: '1' })],
    ['a missing type', eventPayload({ type: '' })],
    ['a non-string raw', eventPayload({ raw: {} })],
  ])('returns null for %s streamed event', (_label, value) => {
    expect(parseGolemEvent(value)).toBeNull();
  });

  it('parses failed and canceled run-status fallbacks', () => {
    expect(parseRunStatus({ identity: runIdentity(RUN_A), state: 'failed', message: 'x' })).toEqual(
      {
        identity: runIdentity(RUN_A),
        state: 'failed',
        message: 'x',
      }
    );
    expect(parseRunStatus({ identity: runIdentity(RUN_A), state: 'canceled' })).toEqual({
      identity: runIdentity(RUN_A),
      state: 'canceled',
    });
  });

  it.each<[string, unknown]>([
    ['an unknown state', { identity: runIdentity(RUN_A), state: 'done' }],
    ['a partial identity', { identity: { repoEpoch: 1 }, state: 'failed' }],
    ['a non-string message', { identity: runIdentity(RUN_A), state: 'failed', message: 3 }],
    ['a non-object', null],
  ])('returns null for %s run status', (_label, value) => {
    expect(parseRunStatus(value)).toBeNull();
  });

  it('clamps a rejection to a short displayable string', () => {
    const clamped = boundedGolemMessage('x'.repeat(500));
    expect(clamped).toHaveLength(200);
    expect(clamped.endsWith('…')).toBe(true);
    expect(clamped.slice(0, 199)).toBe('x'.repeat(199));

    expect(boundedGolemMessage('x'.repeat(200))).toBe('x'.repeat(200));
    expect(boundedGolemMessage(new Error('boom'))).toBe('boom');
    expect(boundedGolemMessage('  spaced  ')).toBe('spaced');
    expect(boundedGolemMessage('   ')).toBe('Golem is unavailable.');
    expect(boundedGolemMessage({ toString: () => 'API_KEY_MARKER' })).toBe('Golem is unavailable.');
  });

  it('builds Wails inputs through the generated constructors only', () => {
    const statusRequest = toStatusRequest(identity);
    expect(statusRequest).toBeInstanceOf(ai.StatusRequest);
    expect(Object.keys(statusRequest).sort()).toEqual(['repoEpoch', 'workspaceId']);

    const turnRequest = toTurnRequest(runIdentity(RUN_A), { message: 'hi', contextRefs: [] });
    expect(turnRequest).toBeInstanceOf(ai.TurnRequest);
    expect(turnRequest.identity).toBeInstanceOf(ai.RunIdentity);
    expect(Object.keys(turnRequest).sort()).toEqual([
      'consentChallengeId',
      'contextRefs',
      'identity',
      'message',
    ]);

    expect(toCancelRequest(runIdentity(RUN_A))).toBeInstanceOf(ai.RunIdentity);
  });

  // #273 adversarial fix wave (M3): a QueuedTurn is structurally a TurnDraft
  // plus queueId/state/userEntryId. Replaying one through toTurnRequest must
  // not let those extra fields ride the wire -- v3 constructors Object.assign
  // their whole source, so a spread of the caller's object would ship them.
  it('drops QueuedTurn-only fields when a queued turn is replayed as a draft', () => {
    const queuedTurn: QueuedTurn = {
      message: 'hi',
      contextRefs: [],
      queueId: 'q1',
      state: 'queued',
      userEntryId: 'entry-1',
    };

    const turnRequest = toTurnRequest(runIdentity(RUN_A), queuedTurn);
    const payload = JSON.parse(JSON.stringify(turnRequest)) as Record<string, unknown>;

    expect('queueId' in payload).toBe(false);
    expect('state' in payload).toBe(false);
    expect('userEntryId' in payload).toBe(false);
    expect(Object.keys(turnRequest).sort()).toEqual([
      'consentChallengeId',
      'contextRefs',
      'identity',
      'message',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B7.1 — event reduction
// ─────────────────────────────────────────────────────────────────────────────

describe('event reduction', () => {
  beforeEach(() => {
    hydrateReady();
    useGolemStore.setState((state) => ({
      runToConversation: { ...state.runToConversation, [RUN_A]: CONV },
    }));
  });

  const send = (over: Record<string, unknown>) => store().ingestEvent(eventPayload(over));

  it('merges message deltas by message ID and keeps a single assistant row', () => {
    send({ seq: 1, type: 'message.delta', payload: { messageId: 'm1', text: 'Hel' } });
    send({ seq: 2, type: 'message.delta', payload: { messageId: 'm1', text: 'lo' } });
    send({ seq: 3, type: 'message.delta', payload: { messageId: 'm2', text: '!' } });

    const rows = conv().transcript.filter((entry) => entry.kind === 'assistant');
    expect(rows.map((row) => row.text)).toEqual(['Hello', '!']);
    expect(rows[0].runId).toBe(RUN_A);
    expect(rows[0].raw?.seq).toBe(2);
    expect(conv().runs[RUN_A].lastSeq).toBe(3);
  });

  it('updates one activity across tool.started and tool.finished', () => {
    send({
      seq: 1,
      type: 'tool.started',
      payload: { toolCallId: 't1', name: 'read', preview: 'read(a)' },
    });
    expect(conv().transcript.filter((e) => e.kind === 'tool')).toHaveLength(1);
    expect(conv().transcript[0].activity).toBe('running');

    send({
      seq: 2,
      type: 'tool.finished',
      payload: { toolCallId: 't1', name: 'read', preview: 'ok', isError: false },
    });
    const tools = conv().transcript.filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].activity).toBe('done');
    expect(tools[0].text).toBe('ok');
    expect(tools[0].toolName).toBe('read');
    expect(tools[0].raw?.seq).toBe(2);
  });

  it('marks a failing tool.finished as failed', () => {
    send({
      seq: 1,
      type: 'tool.started',
      payload: { toolCallId: 't1', name: 'read', preview: '' },
    });
    send({
      seq: 2,
      type: 'tool.finished',
      payload: { toolCallId: 't1', name: 'read', preview: 'boom', isError: true },
    });
    expect(conv().transcript[0].activity).toBe('failed');
  });

  it('ignores an event whose seq does not advance the run', () => {
    send({ seq: 5, type: 'message.delta', payload: { messageId: 'm1', text: 'a' } });
    send({ seq: 5, type: 'message.delta', payload: { messageId: 'm1', text: 'b' } });
    send({ seq: 4, type: 'message.delta', payload: { messageId: 'm1', text: 'c' } });
    expect(conv().transcript[0].text).toBe('a');
    expect(conv().rawEvents).toHaveLength(1);
    expect(conv().runs[RUN_A].lastSeq).toBe(5);
  });

  it.each(['run.finished', 'run.failed', 'run.canceled'])(
    'marks unmatched tool activities interrupted on %s',
    (terminal) => {
      send({
        seq: 1,
        type: 'tool.started',
        payload: { toolCallId: 't1', name: 'read', preview: '' },
      });
      send({
        seq: 2,
        type: 'tool.started',
        payload: { toolCallId: 't2', name: 'glob', preview: '' },
      });
      send({
        seq: 3,
        type: 'tool.finished',
        payload: { toolCallId: 't1', name: 'read', preview: 'ok', isError: false },
      });
      send({
        seq: 4,
        type: terminal,
        payload: terminal === 'run.failed' ? { code: 'run_failed', message: 'nope' } : {},
      });

      const tools = conv().transcript.filter((e) => e.kind === 'tool');
      expect(tools.map((t) => t.activity)).toEqual(['done', 'interrupted']);
    }
  );

  it('keeps unknown but valid events in rawEvents without projecting a row', () => {
    send({ seq: 1, type: 'plan.updated', payload: { steps: 2 } });
    expect(conv().rawEvents.map((e) => e.type)).toEqual(['plan.updated']);
    expect(conv().transcript).toHaveLength(0);
    expect(conv().runs[RUN_A].lastSeq).toBe(1);
  });

  it('keeps rawEvents to a bounded tail without losing the projection or lastSeq', () => {
    for (let seq = 1; seq <= 520; seq += 1) {
      send({ seq, type: 'message.delta', payload: { messageId: 'm1', text: 'x' } });
    }

    const raw = conv().rawEvents;
    expect(raw).toHaveLength(500);
    expect(raw[0].seq).toBe(21);
    expect(raw[raw.length - 1].seq).toBe(520);
    // Everything the UI reads is unaffected by the drop.
    expect(conv().runs[RUN_A].lastSeq).toBe(520);
    expect(conv().transcript.filter((e) => e.kind === 'assistant')[0].text).toHaveLength(520);
  });

  it('does not mutate state for an invalid envelope', () => {
    send({ seq: 1, type: 'message.delta', payload: { messageId: 'm1', text: 'a' } });
    const before = conv();
    store().ingestEvent(eventPayload({ protocol: 9, seq: 2 }));
    store().ingestEvent({ nonsense: true });
    store().ingestEvent(
      eventPayload({ seq: 2, type: 'message.delta', payload: { text: 'no id' } })
    );
    expect(conv().rawEvents).toBe(before.rawEvents);
    expect(conv().transcript[0].text).toBe('a');
  });

  it('projects a bounded error row from run.failed', () => {
    send({
      seq: 1,
      type: 'run.failed',
      payload: { code: 'run_failed', message: 'The Golem run failed.' },
    });
    const errors = conv().transcript.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].text).toBe('The Golem run failed.');
    expect(errors[0].raw?.type).toBe('run.failed');
    expect(conv().runs[RUN_A].phase).toBe('failed');
  });

  it('finishes a run from the run-status fallback without synthesizing a raw event', () => {
    send({
      seq: 1,
      type: 'tool.started',
      payload: { toolCallId: 't1', name: 'read', preview: '' },
    });
    const rawBefore = conv().rawEvents.length;
    store().ingestRunStatus({
      identity: runIdentity(RUN_A),
      state: 'failed',
      message: 'The Golem run failed.',
    });
    expect(conv().rawEvents).toHaveLength(rawBefore);
    expect(conv().runs[RUN_A].phase).toBe('failed');
    expect(conv().transcript.find((e) => e.kind === 'tool')!.activity).toBe('interrupted');
    expect(conv().transcript.find((e) => e.kind === 'error')!.text).toBe('The Golem run failed.');
  });

  it.each([
    ['repository epoch', { repoEpoch: EPOCH + 1 }],
    ['workspace', { workspaceId: OTHER_WS }],
    ['conversation', { conversationId: OTHER_CONV }],
  ])('ignores a run-status whose %s does not match the mapped run', (_label, mismatch) => {
    send({ seq: 1, type: 'run.started' });

    store().ingestRunStatus({
      identity: runIdentity(RUN_A, mismatch),
      state: 'failed',
      message: 'wrong run',
    });

    expect(conv().runs[RUN_A].phase).toBe('running');
    expect(conv().transcript.filter((entry) => entry.kind === 'error')).toHaveLength(0);
  });

  it('ignores an unmapped run-status whose identity collides with a conversation ID', () => {
    store().ingestRunStatus({
      identity: runIdentity(RUN_B, { workspaceId: OTHER_WS }),
      state: 'failed',
      message: 'wrong workspace',
    });

    expect(conv().runs[RUN_B]).toBeUndefined();
    expect(store().runToConversation[RUN_B]).toBeUndefined();
    expect(conv().transcript.filter((entry) => entry.kind === 'error')).toHaveLength(0);
  });

  it('ignores a malformed streamed status', () => {
    const before = store().conversations;
    store().ingestRunStatus({ identity: runIdentity(RUN_A), state: 'weird' });
    expect(store().conversations).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B7.2 — lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('bridge lifecycle and hydration', () => {
  it('lets a pre-hydration relayed terminal tombstone beat a stale active snapshot until reset', () => {
    store().ingestEvent(
      eventPayload({
        seq: 2,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );

    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
          ],
        })
      )
    );

    expect(conv().runs[RUN_A]).toMatchObject({ phase: 'done', lastSeq: 2 });
    expect(conv().rawEvents.map((event) => event.type)).toEqual(['run.finished']);
    expect(conv().activeRunId).toBeNull();

    __resetGolemStore();
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
          ],
        })
      )
    );

    expect(conv().runs[RUN_A].phase).toBe('running');
  });

  it('lets a pre-hydration run-status tombstone beat a stale active snapshot', () => {
    store().ingestRunStatus({ identity: runIdentity(RUN_A), state: 'failed', message: 'died' });

    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
          ],
        })
      )
    );

    expect(conv().runs[RUN_A]).toMatchObject({ phase: 'failed', error: 'died' });
    expect(conv().transcript.filter((entry) => entry.kind === 'error')).toMatchObject([
      { runId: RUN_A, text: 'died' },
    ]);
    expect(conv().activeRunId).toBeNull();
  });

  it('clears an unmatched terminal buffer after a successful global hydration', () => {
    store().ingestEvent(
      eventPayload({
        seq: 2,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    store().hydrateStatus(parseGolemStatus(statusPayload()));

    expect(conv().runs[RUN_A]).toBeUndefined();

    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
          ],
        })
      )
    );

    expect(conv().runs[RUN_A].phase).toBe('running');
  });

  it('starts unbound with nothing hydrated', () => {
    expect(store().bridgePhase).toBe('unbound');
    expect(store().hydratedIdentity).toBeNull();
    expect(store().conversations).toEqual({});
  });

  it('moves to ready and stores availability, consent, warnings and initError', () => {
    useGolemStore.setState({ bridgePhase: 'binding' });
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          available: false,
          needsConsent: true,
          destination: remoteDestination,
          warnings: ['manifest reloaded'],
          initError:
            'Remote consent storage is unavailable; open Golem configuration for repair steps.',
        })
      )
    );
    expect(store().bridgePhase).toBe('ready');
    expect(store().hydratedIdentity).toEqual(identity);
    expect(conv().available).toBe(false);
    expect(conv().needsConsent).toBe(true);
    expect(conv().warnings).toEqual(['manifest reloaded']);
    expect(conv().initError).toBe(
      'Remote consent storage is unavailable; open Golem configuration for repair steps.'
    );
    expect(conv().destination).toEqual(remoteDestination);
    expect(conv().workspaceLabel).toBe('Frontend');
  });

  it('normalizes absent optional status fields to null and empty arrays', () => {
    hydrateReady({ destination: undefined });
    expect(conv().destination).toBeNull();
    expect(conv().initError).toBeNull();
    expect(conv().warnings).toEqual([]);
  });

  it('treats an unresolvable status as a bridge error without inventing a conversation', () => {
    hydrateReady();
    store().hydrateStatus(
      parseGolemStatus({
        available: false,
        workspaceLabel: '',
        identity: { repoEpoch: 0, workspaceId: '', conversationId: '' },
        needsConsent: false,
        activeRuns: [],
        initError: 'The Golem workspace is unavailable.',
      })
    );
    expect(store().bridgePhase).toBe('error');
    expect(store().bridgeError).toBe('The Golem workspace is unavailable.');
    expect(store().hydratedIdentity).toBeNull();
    expect(Object.keys(store().conversations)).toEqual([CONV]);
  });

  it('rejects a stale-epoch status while retaining conversation history', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'hello');
    await flush();

    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, repoEpoch: EPOCH + 1 },
          workspaceLabel: 'Frontend v2',
        })
      )
    );
    expect(store().hydratedIdentity!.repoEpoch).toBe(EPOCH + 1);

    store().hydrateStatus(
      parseGolemStatus(statusPayload({ workspaceLabel: 'stale', available: false }))
    );
    expect(store().hydratedIdentity!.repoEpoch).toBe(EPOCH + 1);
    expect(conv().workspaceLabel).toBe('Frontend v2');
    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('upserts hydrated active runs with routing but no invented prompt metadata', () => {
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
            {
              identity: {
                ...runIdentity(RUN_B),
                workspaceId: OTHER_WS,
                conversationId: OTHER_CONV,
              },
              workspaceLabel: 'Backend',
              state: 'canceling',
            },
          ],
        })
      )
    );
    expect(store().runToConversation).toEqual({ [RUN_A]: CONV, [RUN_B]: OTHER_CONV });
    expect(conv().runs[RUN_A].phase).toBe('running');
    expect(conv().runs[RUN_A].request).toBeUndefined();
    expect(conv().runs[RUN_A].userEntryId).toBeUndefined();
    expect(conv().activeRunId).toBe(RUN_A);
    expect(conv(OTHER_CONV).runs[RUN_B].phase).toBe('canceling');
    expect(conv(OTHER_CONV).workspaceLabel).toBe('Backend');
  });

  it('updates an already-known other-workspace run when a later status re-lists it', () => {
    const otherIdentity = {
      ...runIdentity(RUN_B),
      workspaceId: OTHER_WS,
      conversationId: OTHER_CONV,
    };
    const withOtherRun = (state: string) =>
      statusPayload({
        activeRuns: [{ identity: otherIdentity, workspaceLabel: 'Backend', state }],
      });

    store().hydrateStatus(parseGolemStatus(withOtherRun('running')));
    expect(conv(OTHER_CONV).runs[RUN_B].phase).toBe('running');

    store().hydrateStatus(parseGolemStatus(withOtherRun('canceling')));

    expect(conv(OTHER_CONV).runs[RUN_B].phase).toBe('canceling');
    expect(conv(OTHER_CONV).runs[RUN_B].identity).toEqual(otherIdentity);
    expect(Object.keys(conv(OTHER_CONV).runs)).toEqual([RUN_B]);
    expect(conv(OTHER_CONV).activeRunId).toBe(RUN_B);
    expect(store().runToConversation[RUN_B]).toBe(OTHER_CONV);
  });

  it('merges rather than deletes runs from other workspaces', () => {
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            {
              identity: {
                ...runIdentity(RUN_B),
                workspaceId: OTHER_WS,
                conversationId: OTHER_CONV,
              },
              workspaceLabel: 'Backend',
              state: 'running',
            },
          ],
        })
      )
    );
    store().hydrateStatus(parseGolemStatus(statusPayload({ activeRuns: [] })));
    expect(conv(OTHER_CONV).runs[RUN_B].phase).toBe('running');
    expect(store().runToConversation[RUN_B]).toBe(OTHER_CONV);
  });
});

describe('send gating', () => {
  it.each<[string, () => void]>([
    ['no workspace is bound', () => __resetGolemStore()],
    [
      'binding is still in flight',
      () => {
        hydrateReady();
        useGolemStore.setState({ bridgePhase: 'binding' });
      },
    ],
    [
      'the bridge is in error',
      () => {
        hydrateReady();
        useGolemStore.setState({ bridgePhase: 'error', bridgeError: 'Golem is unavailable.' });
      },
    ],
    [
      'status reports the workspace unavailable',
      () => hydrateReady({ available: false, initError: 'Golem is unavailable.' }),
    ],
    [
      'the hydrated identity names another workspace',
      () => {
        hydrateReady();
        useGolemStore.setState({
          hydratedIdentity: { ...identity, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
        });
      },
    ],
  ])('makes no backend call when %s', async (_label, arrange) => {
    arrange();
    if (!store().conversations[CONV]) {
      store().hydrateStatus(parseGolemStatus(statusPayload()));
      useGolemStore.setState({ bridgePhase: 'unbound', hydratedIdentity: null });
    }
    // A run ID is available: a refusal here has to come from the gate, not from
    // an exhausted UUID queue, which would look identical from the mock alone.
    uuidQueue = [RUN_A];
    expect(store().submitTurn(CONV, 'hello')).toMatchObject({ ok: false });
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(mockRandomUUID).not.toHaveBeenCalled();
    expect(uuidQueue).toEqual([RUN_A]);
    // The refusal is definitive and lossless: the host keeps the message the
    // user typed, and nothing is projected, queued, or routed here.
    expect(conv().transcript).toEqual([]);
    expect(conv().queuedTurns).toEqual([]);
    expect(conv().runs).toEqual({});
    expect(conv().activeRunId).toBeNull();
    expect(store().runToConversation).toEqual({});
  });

  it('makes no backend call for a blank draft', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, '   ');
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(uuidQueue).toEqual([RUN_A]);
    expect(conv().transcript).toEqual([]);
    expect(conv().activeRunId).toBeNull();
  });

  it('refuses through one channel and calls nothing when secure randomUUID is unavailable', async () => {
    hydrateReady();
    installCrypto({});
    const result = store().submitTurn(CONV, 'hello');
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    // The refusal reason is the whole message. A transcript row as well would
    // make the docked host show it twice — once inline, once as the toast the
    // refusal raises — so the transcript stays untouched.
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('secure run ID') });
    expect(conv().transcript).toEqual([]);
    expect(conv().activeRunId).toBeNull();
  });
});

describe('submitTurn', () => {
  it('creates the provisional run, routing and user row before the Wails call', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];

    let observed: ReturnType<typeof store> | null = null;
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockImplementation(() => {
      observed = store();
      return gate.promise;
    });

    expect(store().submitTurn(CONV, 'explain this')).toEqual({ ok: true });
    expect(observed).not.toBeNull();
    const snapshot = observed!;
    const before = snapshot.conversations[CONV];
    expect(before.runs[RUN_A].phase).toBe('admitting');
    expect(before.runs[RUN_A].request).toEqual({ message: 'explain this', contextRefs: [] });
    expect(before.runs[RUN_A].userEntryId).toBeTruthy();
    expect(before.activeRunId).toBe(RUN_A);
    expect(snapshot.runToConversation[RUN_A]).toBe(CONV);
    const userRow = before.transcript.find((e) => e.kind === 'user')!;
    expect(userRow.text).toBe('explain this');
    expect(userRow.id).toBe(before.runs[RUN_A].userEntryId);

    // Awaiting the now-synchronous admission proves nothing about the provider,
    // so the deferred backend fixture is what gets awaited.
    gate.resolve(admissionPayload(RUN_A));
    await flush();
    expect(conv().runs[RUN_A].phase).toBe('running');
  });

  it('submits no endpoint or path', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'hello');
    await flush();

    const request = mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest;
    expect(Object.keys(request).sort()).toEqual([
      'consentChallengeId',
      'contextRefs',
      'identity',
      'message',
    ]);
    expect(Object.keys(request.identity).sort()).toEqual([
      'conversationId',
      'repoEpoch',
      'runId',
      'workspaceId',
    ]);
    expect(JSON.stringify(request)).not.toContain('endpoint');
    expect(request.consentChallengeId).toBe('');
  });

  it('lets admission resolve after the run has already advanced by events', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockReturnValue(gate.promise);
    expect(store().submitTurn(CONV, 'hello')).toEqual({ ok: true });

    store().ingestEvent(eventPayload({ seq: 1, type: 'run.started' }));
    store().ingestEvent(
      eventPayload({ seq: 2, type: 'message.delta', payload: { messageId: 'm1', text: 'hi' } })
    );
    expect(conv().runs[RUN_A].phase).toBe('running');

    gate.resolve(admissionPayload(RUN_A));
    await flush();
    expect(conv().runs[RUN_A].phase).toBe('running');
    expect(conv().transcript.filter((e) => e.kind === 'assistant')[0].text).toBe('hi');
  });

  it('routes background events by threadId while another workspace is focused', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'hello');
    await flush();

    // Focus moves to a sibling workspace in the same repository.
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
          workspaceLabel: 'Backend',
        })
      )
    );
    store().selectConversation(OTHER_CONV);

    store().ingestEvent(
      eventPayload({
        threadId: CONV,
        seq: 1,
        type: 'message.delta',
        payload: { messageId: 'm1', text: 'background' },
      })
    );
    expect(conv().transcript.filter((e) => e.kind === 'assistant')[0].text).toBe('background');
    expect(conv(OTHER_CONV).transcript).toHaveLength(0);
  });

  it('ignores events for an unknown conversation', () => {
    hydrateReady();
    const before = store().conversations;
    store().ingestEvent(eventPayload({ threadId: 'conv-unknown', runId: RUN_C }));
    expect(store().conversations).toBe(before);
  });

  // Composer text is not store state any more (#271): it lives in the visible
  // host's `useDraftStore`, so its durability is asserted there and in the
  // panel suite. What the store still owns across a switch is the transcript.
  it('restores the same transcript after switching away and back', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'hello');
    await flush();

    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
        })
      )
    );
    expect(store().selectConversation(OTHER_CONV)).toEqual({ ok: true });
    expect(conv(OTHER_CONV).transcript).toEqual([]);

    const revision = store().composerFocusRevision;
    expect(store().selectConversation(CONV)).toEqual({ ok: true });
    expect(store().selectedConversationId).toBe(CONV);
    expect(store().composerFocusRevision).toBeGreaterThan(revision);
    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('requestComposerFocus bumps the revision by exactly one', () => {
    const revision = store().composerFocusRevision;
    store().requestComposerFocus();
    expect(store().composerFocusRevision).toBe(revision + 1);
  });
});

describe('queueing', () => {
  const startBusyRun = async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
  };

  it('stages a queued turn without a backend call while a run is active', async () => {
    await startBusyRun();
    mockRunGolemTurn.mockClear();
    store().submitTurn(CONV, 'second');
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(conv().queuedTurns).toHaveLength(1);
    expect(conv().queuedTurns[0]).toMatchObject({ message: 'second', state: 'queued' });
  });

  it('stages a queued turn while consent is pending', async () => {
    hydrateReady({ destination: remoteDestination, needsConsent: true });
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValue(
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A),
      })
    );
    store().submitTurn(CONV, 'first');
    await flush();
    expect(conv().pendingConsentTurn).not.toBeNull();

    mockRunGolemTurn.mockClear();
    store().submitTurn(CONV, 'second');
    await flush();
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(conv().queuedTurns).toHaveLength(1);
  });

  it('starts exactly one queued turn on the terminal relay with a fresh run ID', async () => {
    await startBusyRun();
    store().submitTurn(CONV, 'second');
    await flush();
    store().submitTurn(CONV, 'third');
    await flush();
    expect(conv().queuedTurns).toHaveLength(2);

    uuidQueue = [RUN_B];
    mockRunGolemTurn.mockClear();
    store().ingestEvent(
      eventPayload({
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    expect((mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest).identity.runId).toBe(RUN_B);
    expect((mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest).message).toBe('second');
    expect(conv().queuedTurns).toHaveLength(1);
    expect(conv().queuedTurns[0].message).toBe('third');
    expect(conv().activeRunId).toBe(RUN_B);
  });

  it('edits and removes staged turns', async () => {
    await startBusyRun();
    store().submitTurn(CONV, 'second');
    await flush();
    const queueId = conv().queuedTurns[0].queueId;

    store().updateQueuedTurn(CONV, queueId, 'second, revised');
    expect(conv().queuedTurns[0].message).toBe('second, revised');
    store().removeQueuedTurn(CONV, queueId);
    expect(conv().queuedTurns).toHaveLength(0);
  });

  it('keeps queued turns staged as reopen-required after unbind and reissues them on rebind', async () => {
    await startBusyRun();
    store().submitTurn(CONV, 'second');
    await flush();

    store().invalidateBinding();
    expect(store().bridgePhase).toBe('unbound');
    expect(store().hydratedIdentity).toBeNull();
    expect(conv().queuedTurns[0].state).toBe('reopen-required');

    mockRunGolemTurn.mockClear();
    uuidQueue = [RUN_B];
    // The old-epoch run finished in the background; the slot must be free first.
    store().ingestEvent(
      eventPayload({
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    await flush();
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(conv().queuedTurns[0].state).toBe('reopen-required');

    store().hydrateStatus(
      parseGolemStatus(statusPayload({ identity: { ...identity, repoEpoch: EPOCH + 1 } }))
    );
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    const reissued = mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest;
    expect(reissued.identity.repoEpoch).toBe(EPOCH + 1);
    expect(reissued.identity.runId).toBe(RUN_B);
    expect(reissued.message).toBe('second');
    expect(conv().queuedTurns).toHaveLength(0);
  });

  it('publishes a fresh conversation reference for the rebind dispatch', async () => {
    // `hydrateStatus` re-arms the queue in one `set()` and dispatches it in a
    // second. Both mutations must copy the conversation: the final state is
    // identical either way, so no state assertion can catch a writer that
    // mutates the published object in place — but a selector on
    // `conversations[CONV]` would then be handed the same reference twice and
    // React would render the reissued turn's transcript row and activeRunId
    // never at all. Identity across the two publications is the only witness.
    await startBusyRun();
    store().submitTurn(CONV, 'second');
    await flush();
    store().invalidateBinding();
    store().ingestEvent(
      eventPayload({
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    await flush();
    expect(conv().queuedTurns[0].state).toBe('reopen-required');

    const published: ConversationView[] = [];
    const unsubscribe = useGolemStore.subscribe((state) => {
      const current = state.conversations[CONV];
      if (current && current !== published[published.length - 1]) published.push(current);
    });

    uuidQueue = [RUN_B];
    mockRunGolemTurn.mockClear();
    store().hydrateStatus(
      parseGolemStatus(statusPayload({ identity: { ...identity, repoEpoch: EPOCH + 1 } }))
    );
    unsubscribe();
    await flush();

    expect(published).toHaveLength(2);
    expect(published[0]).not.toBe(published[1]);
    // The re-arm publication, then the dispatch publication.
    expect(published[0].queuedTurns).toMatchObject([{ message: 'second', state: 'queued' }]);
    expect(published[0].activeRunId).toBeNull();
    expect(published[1].queuedTurns).toHaveLength(0);
    expect(published[1].activeRunId).toBe(RUN_B);
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
  });
});

describe('consent', () => {
  // Only the expiry tests install a clock; restoring keeps the rest real.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const needsConsentAdmission = (runId: string) =>
    admissionPayload(runId, {
      state: 'needs_consent',
      destination: remoteDestination,
      consentChallenge: challengeFor(runId),
    });

  const firstRemoteSubmission = async () => {
    hydrateReady({ destination: remoteDestination, needsConsent: true });
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValue(needsConsentAdmission(RUN_A));
    store().submitTurn(CONV, 'ask remote');
    await flush();
  };

  /**
   * Approve exactly the challenge the conversation is currently showing. The
   * grant now names its run and challenge, so the tests approve what a user
   * would have been looking at rather than "whatever is pending".
   */
  const approve = () => {
    const pending = conv().pendingConsentTurn;
    if (!pending) throw new Error('no pending consent turn to approve');
    return store().allowAndSend(CONV, pending.identity.runId, pending.challenge.id);
  };

  it('stores the exact request when admission needs consent', async () => {
    await firstRemoteSubmission();
    const pending = conv().pendingConsentTurn!;
    expect(pending.draft).toEqual({ message: 'ask remote', contextRefs: [] });
    expect(pending.identity).toEqual(runIdentity(RUN_A));
    expect(pending.challenge.id).toBe('challenge-1');
    expect(pending.userEntryId).toBe(conv().runs[RUN_A].userEntryId);
    expect(conv().runs[RUN_A].phase).toBe('needs-consent');
  });

  it('retries with the same identity and message plus only the challenge ID', async () => {
    await firstRemoteSubmission();
    mockRunGolemTurn.mockClear();
    mockRunGolemTurn.mockResolvedValue(admissionPayload(RUN_A, { destination: remoteDestination }));

    expect(approve()).toEqual({ ok: true });
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    const retry = mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest;
    expect(retry.identity).toEqual(expect.objectContaining(runIdentity(RUN_A)));
    expect(retry.message).toBe('ask remote');
    expect(retry.contextRefs).toEqual([]);
    expect(retry.consentChallengeId).toBe('challenge-1');
    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().runs[RUN_A].phase).toBe('running');
  });

  it('retains the pending turn, challenge and user row after a transient grant rejection', async () => {
    await firstRemoteSubmission();
    const pendingBefore = conv().pendingConsentTurn!;
    mockRunGolemTurn.mockClear();
    mockRunGolemTurn.mockRejectedValueOnce(
      'Remote consent storage is unavailable; open Golem configuration for repair steps.'
    );

    // Admitted locally: the grant really was dispatched. The provider's later
    // rejection is a transcript event, not a refusal of the click.
    expect(approve()).toEqual({ ok: true });
    await flush();

    expect(conv().pendingConsentTurn).toEqual(pendingBefore);
    expect(conv().runs[RUN_A].phase).toBe('needs-consent');
    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(
      conv()
        .transcript.filter((e) => e.kind === 'error')
        .pop()!.text
    ).toBe('Remote consent storage is unavailable; open Golem configuration for repair steps.');
    expect(conv().lastFailedTurn).toBeNull();
    expect(store().lastFailureConversationId).toBe(CONV);
  });

  it('admits a consent grant only once while preserving retry after rejection', async () => {
    await firstRemoteSubmission();
    const grant = deferred<unknown>();
    mockRunGolemTurn.mockClear();
    mockRunGolemTurn.mockReturnValue(grant.promise);

    expect(approve()).toEqual({ ok: true });
    // The run left `needs-consent` on the first grant, so the second is refused
    // with a reason rather than dispatched a second time.
    expect(approve()).toMatchObject({ ok: false });

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    grant.reject(
      'Remote consent storage is unavailable; open Golem configuration for repair steps.'
    );
    await flush();
    expect(conv().runs[RUN_A].phase).toBe('needs-consent');

    mockRunGolemTurn.mockResolvedValueOnce(
      admissionPayload(RUN_A, { destination: remoteDestination })
    );
    expect(approve()).toEqual({ ok: true });
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(2);
    expect(conv().runs[RUN_A].phase).toBe('running');
  });

  it('does not cancel a consent grant while it is being admitted', async () => {
    await firstRemoteSubmission();
    const grant = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(grant.promise);

    expect(approve()).toEqual({ ok: true });
    expect(conv().runs[RUN_A].phase).toBe('admitting');

    expect(store().cancelRun(RUN_A)).toMatchObject({ ok: false });

    expect(mockCancelGolemRun).not.toHaveBeenCalled();
    expect(conv().runs[RUN_A].phase).toBe('admitting');

    grant.resolve(admissionPayload(RUN_A, { destination: remoteDestination }));
    await flush();
    expect(conv().runs[RUN_A].phase).toBe('running');
  });

  it('clears consent when run.started arrives before an accepted grant', async () => {
    await firstRemoteSubmission();
    const grant = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(grant.promise);

    expect(approve()).toEqual({ ok: true });
    store().ingestEvent(eventPayload({ seq: 1, type: 'run.started' }));
    expect(conv().runs[RUN_A].phase).toBe('running');

    grant.resolve(admissionPayload(RUN_A, { destination: remoteDestination }));
    await flush();
    expect(conv().pendingConsentTurn).toBeNull();

    store().ingestEvent(
      eventPayload({
        seq: 2,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    expect(conv().runs[RUN_A].phase).toBe('done');
    expect(conv().lastFailedTurn).toBeNull();
  });

  it('keeps one prompt row and one first request across a deferred fail-then-recover grant', async () => {
    await firstRemoteSubmission();
    const firstCallCount = mockRunGolemTurn.mock.calls.length;

    const failing = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(failing.promise);
    expect(approve()).toEqual({ ok: true });
    failing.reject(
      'Remote consent storage is unavailable; open Golem configuration for repair steps.'
    );
    await flush();

    const recovering = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(recovering.promise);
    expect(approve()).toEqual({ ok: true });
    recovering.resolve(admissionPayload(RUN_A, { destination: remoteDestination }));
    await flush();

    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(mockRunGolemTurn.mock.calls).toHaveLength(firstCallCount + 2);
    expect(mockRunGolemTurn.mock.calls[firstCallCount][0].consentChallengeId).toBe('challenge-1');
    expect(mockRunGolemTurn.mock.calls[firstCallCount + 1][0].consentChallengeId).toBe(
      'challenge-1'
    );
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().runs[RUN_A].phase).toBe('running');
  });

  it('declines with Cancel on the pending identity and keeps the turn retryable', async () => {
    await firstRemoteSubmission();
    store().cancelRun(RUN_A);
    await flush();

    expect(mockCancelGolemRun).toHaveBeenCalledTimes(1);
    const cancelArg = mockCancelGolemRun.mock.calls[0][0] as ai.RunIdentity;
    expect(cancelArg).toBeInstanceOf(ai.RunIdentity);
    expect({ ...cancelArg }).toEqual(runIdentity(RUN_A));
    expect(conv().runs[RUN_A].phase).toBe('canceling');

    store().ingestRunStatus({ identity: runIdentity(RUN_A), state: 'canceled' });
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().activeRunId).toBeNull();
    expect(conv().lastFailedTurn).toEqual({
      draft: { message: 'ask remote', contextRefs: [] },
      userEntryId: conv().runs[RUN_A].userEntryId,
    });
  });

  it('releases an expired challenge for retry instead of leaving the turn pending', async () => {
    await firstRemoteSubmission();
    const pending = conv().pendingConsentTurn!;
    const userEntryId = pending.userEntryId;

    // The backend drops a past-deadline challenge on its next Status call, and
    // answers every later grant or cancel for it with a rejection.
    jest.spyOn(Date, 'now').mockReturnValue(pending.challenge.expiresAt + 1);
    mockRunGolemTurn.mockClear();

    expect(approve()).toMatchObject({ ok: false });
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().activeRunId).toBeNull();
    expect(conv().runs[RUN_A].phase).toBe('failed');
    expect(
      conv()
        .transcript.filter((e) => e.kind === 'error')
        .pop()!.text
    ).toBe('The consent request expired. Send the message again to retry it.');
    expect(conv().lastFailedTurn).toEqual({
      draft: { message: 'ask remote', contextRefs: [] },
      userEntryId,
    });
    expect(store().lastFailureConversationId).toBe(CONV);

    // The way out is a real one: Retry starts a fresh run and a fresh challenge.
    uuidQueue = [RUN_B];
    mockRunGolemTurn.mockImplementation((request: ai.TurnRequest) =>
      Promise.resolve(needsConsentAdmission(request.identity.runId))
    );
    store().retryLastFailed(CONV);
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    const retried = mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest;
    expect(retried.identity.runId).toBe(RUN_B);
    expect(retried.consentChallengeId).toBe('');
    expect(retried.message).toBe('ask remote');
    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);
  });

  it('drops an expired challenge on Retry rather than leaving the button dead', async () => {
    // Turn 1 is rejected, so Retry has something to retry.
    hydrateReady({ destination: remoteDestination, needsConsent: true });
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockRejectedValueOnce('The Golem request is invalid or stale.');
    store().submitTurn(CONV, 'first');
    await flush();
    expect(conv().lastFailedTurn!.draft.message).toBe('first');

    // Turn 2 parks on a consent challenge, which then expires.
    uuidQueue = [RUN_B];
    mockRunGolemTurn.mockResolvedValueOnce(needsConsentAdmission(RUN_B));
    store().submitTurn(CONV, 'ask remote');
    await flush();
    jest.spyOn(Date, 'now').mockReturnValue(conv().pendingConsentTurn!.challenge.expiresAt + 1);

    uuidQueue = [RUN_C];
    mockRunGolemTurn.mockClear();
    mockRunGolemTurn.mockImplementation((request: ai.TurnRequest) =>
      Promise.resolve(needsConsentAdmission(request.identity.runId))
    );
    store().retryLastFailed(CONV);
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    const retried = mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest;
    expect(retried.identity.runId).toBe(RUN_C);
    expect(retried.consentChallengeId).toBe('');
    // Releasing the expired challenge makes its prompt the newest failure, and
    // the expiry notice is the last row the user saw, so Retry resends that
    // rather than the older 'first'.
    expect(retried.message).toBe('ask remote');
    expect(conv().pendingConsentTurn!.identity.runId).toBe(RUN_C);
    expect(conv().runs[RUN_B].phase).toBe('failed');
  });

  it('sends rather than queues behind an expired consent turn', async () => {
    await firstRemoteSubmission();
    const expiresAt = conv().pendingConsentTurn!.challenge.expiresAt;
    jest.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);

    mockRunGolemTurn.mockClear();
    mockRunGolemTurn.mockImplementation((request: ai.TurnRequest) =>
      Promise.resolve(needsConsentAdmission(request.identity.runId))
    );
    uuidQueue = [RUN_B];
    store().submitTurn(CONV, 'ask again');
    await flush();

    expect(conv().queuedTurns).toHaveLength(0);
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    expect((mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest).identity.runId).toBe(RUN_B);
    expect(conv().pendingConsentTurn!.identity.runId).toBe(RUN_B);
  });

  it('declines an expired challenge locally instead of calling Cancel', async () => {
    await firstRemoteSubmission();
    const userEntryId = conv().pendingConsentTurn!.userEntryId;
    jest.spyOn(Date, 'now').mockReturnValue(conv().pendingConsentTurn!.challenge.expiresAt + 1);
    mockCancelGolemRun.mockClear();

    store().cancelRun(RUN_A);
    await flush();

    // The backend already dropped the challenge, so Cancel has nothing to
    // match and would only answer with a rejection.
    expect(mockCancelGolemRun).not.toHaveBeenCalled();
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().runs[RUN_A].phase).toBe('failed');
    expect(conv().activeRunId).toBeNull();
    expect(conv().lastFailedTurn).toEqual({
      draft: { message: 'ask remote', contextRefs: [] },
      userEntryId,
    });
    expect(
      conv()
        .transcript.filter((e) => e.kind === 'error')
        .pop()!.text
    ).toBe('The consent request expired. Send the message again to retry it.');
  });

  it('clears a pending consent turn when its Cancel is rejected', async () => {
    await firstRemoteSubmission();
    const userEntryId = conv().pendingConsentTurn!.userEntryId;
    mockCancelGolemRun.mockRejectedValueOnce('The Golem request is invalid or stale.');

    store().cancelRun(RUN_A);
    await flush();

    // Cancel is only rejected here when the backend no longer holds the
    // challenge, so restoring needs-consent would offer an impossible grant.
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().activeRunId).toBeNull();
    expect(conv().runs[RUN_A].phase).toBe('failed');
    expect(conv().lastFailedTurn).toEqual({
      draft: { message: 'ask remote', contextRefs: [] },
      userEntryId,
    });
    expect(
      conv()
        .transcript.filter((e) => e.kind === 'error')
        .pop()!.text
    ).toBe('The Golem request is invalid or stale.');
  });

  it('refuses to offer a consent challenge issued under a retired epoch', async () => {
    hydrateReady({ destination: remoteDestination, needsConsent: true });
    uuidQueue = [RUN_A];
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(gate.promise);
    expect(store().submitTurn(CONV, 'ask remote')).toEqual({ ok: true });

    // The repository is rebound before the challenge comes back; the backend
    // has already dropped every unconsumed challenge for the old incarnation.
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, repoEpoch: EPOCH + 1 },
          destination: remoteDestination,
          needsConsent: true,
        })
      )
    );

    gate.resolve(needsConsentAdmission(RUN_A));
    await flush();

    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().runs[RUN_A].phase).toBe('failed');
    expect(conv().activeRunId).toBeNull();
    expect(
      conv()
        .transcript.filter((e) => e.kind === 'error')
        .pop()!.text
    ).toBe('The workspace changed before this turn started.');
    expect(conv().lastFailedTurn).toEqual({
      draft: { message: 'ask remote', contextRefs: [] },
      userEntryId: conv().runs[RUN_A].userEntryId,
    });
  });

  it('re-stages an invalidated challenge and resubmits it on rebind with one user row', async () => {
    await firstRemoteSubmission();
    const userEntryId = conv().pendingConsentTurn!.userEntryId;
    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);

    store().invalidateBinding();

    // The backend dropped the challenge with the binding, so the prompt goes
    // back on the shelf carrying the row it already projected.
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().queuedTurns).toHaveLength(1);
    expect(conv().queuedTurns[0]).toMatchObject({
      message: 'ask remote',
      state: 'reopen-required',
      userEntryId,
    });
    expect(conv().activeRunId).toBeNull();
    expect(conv().runs[RUN_A].phase).toBe('canceled');

    mockRunGolemTurn.mockClear();
    mockRunGolemTurn.mockImplementation((request: ai.TurnRequest) =>
      Promise.resolve({
        state: 'accepted',
        identity: { ...request.identity },
        destination: remoteDestination,
        context: { included: 0, bytes: 0, excluded: 0 },
      })
    );
    uuidQueue = [RUN_B];
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, repoEpoch: EPOCH + 1 },
          destination: remoteDestination,
        })
      )
    );
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    const resubmitted = mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest;
    expect(resubmitted.message).toBe('ask remote');
    expect(resubmitted.consentChallengeId).toBe('');
    expect(resubmitted.identity.runId).toBe(RUN_B);
    expect(resubmitted.identity.repoEpoch).toBe(EPOCH + 1);

    const userRows = conv().transcript.filter((e) => e.kind === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].id).toBe(userEntryId);
    expect(userRows[0].runId).toBe(RUN_B);
    expect(conv().runs[RUN_B].userEntryId).toBe(userEntryId);
    expect(conv().queuedTurns).toHaveLength(0);
  });

  it('honours an accepted admission whose epoch was retired while it was in flight', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(gate.promise);
    expect(store().submitTurn(CONV, 'hello')).toEqual({ ok: true });

    store().hydrateStatus(
      parseGolemStatus(statusPayload({ identity: { ...identity, repoEpoch: EPOCH + 1 } }))
    );

    gate.resolve(admissionPayload(RUN_A));
    await flush();

    // Unlike needs_consent, an accepted admission names a run the backend is
    // already running: the epoch guard is deliberately not applied here, or the
    // run would be orphaned and the user could no longer cancel it.
    expect(conv().runs[RUN_A].phase).toBe('running');
    expect(conv().activeRunId).toBe(RUN_A);
    expect(conv().transcript.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(conv().lastFailedTurn).toBeNull();
  });

  it('does not resurrect a terminal run when needs_consent resolves late', async () => {
    hydrateReady({ destination: remoteDestination, needsConsent: true });
    uuidQueue = [RUN_A];
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(gate.promise);
    expect(store().submitTurn(CONV, 'ask remote')).toEqual({ ok: true });
    store().submitTurn(CONV, 'queued after');
    await flush();

    store().ingestEvent(eventPayload({ seq: 1, type: 'run.started' }));
    uuidQueue = [RUN_B];
    store().ingestEvent(eventPayload({ seq: 2, type: 'run.canceled', payload: {} }));
    await flush();
    const dispatchedCalls = mockRunGolemTurn.mock.calls.length;

    gate.resolve(needsConsentAdmission(RUN_A));
    await flush();

    expect(conv().runs[RUN_A].phase).toBe('canceled');
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().activeRunId).toBe(RUN_B);
    expect(mockRunGolemTurn.mock.calls).toHaveLength(dispatchedCalls);
  });
});

describe('failure and retry', () => {
  it('records lastFailedTurn on admission rejection and does not drain queued work', async () => {
    hydrateReady();
    // A second run ID is available on purpose: if the failure path drained the
    // queue it would succeed, so the queue below cannot survive by accident.
    uuidQueue = [RUN_A, RUN_B];
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(gate.promise);
    expect(store().submitTurn(CONV, 'first')).toEqual({ ok: true });
    store().submitTurn(CONV, 'second');
    await flush();

    gate.reject('The Golem request is invalid or stale.');
    await flush();

    expect(conv().runs[RUN_A].phase).toBe('failed');
    expect(conv().activeRunId).toBeNull();
    expect(conv().lastFailedTurn).toEqual({
      draft: { message: 'first', contextRefs: [] },
      userEntryId: conv().runs[RUN_A].userEntryId,
    });
    expect(conv().queuedTurns).toHaveLength(1);
    expect(conv().queuedTurns[0]).toMatchObject({ message: 'second', state: 'queued' });
    expect(conv().runs[RUN_B]).toBeUndefined();
    expect(uuidQueue).toEqual([RUN_B]);
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    expect(store().lastFailureConversationId).toBe(CONV);
  });

  it('ignores a late or duplicate run-status for a run that already ended', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    const settledRows = conv().transcript.length;
    const settledFailures = store().failureRevision;
    expect(conv().runs[RUN_A].phase).toBe('done');

    // `ingestRunStatus` has no seq guard, so the terminal tombstone is the only
    // thing standing between a duplicated relay and a rewritten history.
    store().ingestRunStatus({
      identity: runIdentity(RUN_A),
      state: 'failed',
      message: 'late failure',
    });
    store().ingestRunStatus({ identity: runIdentity(RUN_A), state: 'canceled' });

    expect(conv().runs[RUN_A].phase).toBe('done');
    expect(conv().runs[RUN_A].error).toBeUndefined();
    expect(conv().transcript).toHaveLength(settledRows);
    expect(conv().transcript.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(conv().lastFailedTurn).toBeNull();
    expect(store().failureRevision).toBe(settledFailures);
  });

  it('re-stages rather than starts a queued turn under a retired epoch', async () => {
    // A sibling workspace in the same repository owns the queued work.
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
          workspaceLabel: 'Backend',
        })
      )
    );
    store().selectConversation(OTHER_CONV);
    uuidQueue = [RUN_A];
    store().submitTurn(OTHER_CONV, 'first');
    await flush();
    store().submitTurn(OTHER_CONV, 'second');
    await flush();
    expect(conv(OTHER_CONV).queuedTurns[0].state).toBe('queued');

    // The repository is rebound and focus lands elsewhere, so the sibling's
    // queued turn is still armed but its epoch is retired.
    store().hydrateStatus(
      parseGolemStatus(statusPayload({ identity: { ...identity, repoEpoch: EPOCH + 1 } }))
    );
    expect(conv(OTHER_CONV).queuedTurns[0].state).toBe('queued');

    uuidQueue = [RUN_B];
    mockRunGolemTurn.mockClear();
    store().ingestEvent(
      eventPayload({
        threadId: OTHER_CONV,
        runId: RUN_A,
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(uuidQueue).toEqual([RUN_B]);
    expect(conv(OTHER_CONV).queuedTurns).toHaveLength(1);
    expect(conv(OTHER_CONV).queuedTurns[0]).toMatchObject({
      message: 'second',
      state: 'reopen-required',
    });
    expect(conv(OTHER_CONV).activeRunId).toBeNull();
    expect(conv(OTHER_CONV).runs[RUN_B]).toBeUndefined();
  });

  it('refuses Retry while the conversation is unavailable', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );
    const failed = conv().lastFailedTurn;
    expect(failed).not.toBeNull();

    hydrateReady({ available: false, initError: 'Golem is unavailable.' });
    uuidQueue = [RUN_B];
    mockRunGolemTurn.mockClear();
    store().retryLastFailed(CONV);
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(uuidQueue).toEqual([RUN_B]);
    expect(conv().lastFailedTurn).toEqual(failed);
    expect(conv().runs[RUN_B]).toBeUndefined();
    expect(conv().activeRunId).toBeNull();
  });

  it('refuses Retry through one channel when secure randomUUID is unavailable', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );
    const failed = conv().lastFailedTurn;
    const errorsBefore = conv().transcript.filter((e) => e.kind === 'error').length;

    installCrypto({});
    mockRunGolemTurn.mockClear();
    const result = store().retryLastFailed(CONV);
    installCrypto({ randomUUID: mockRandomUUID });
    await flush();

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('secure run ID') });
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    // No extra transcript row: the refusal already carries the whole message.
    expect(conv().transcript.filter((e) => e.kind === 'error')).toHaveLength(errorsBefore);
    // The retry is still available once a secure ID can be named again.
    expect(conv().lastFailedTurn).toEqual(failed);
  });

  it('sets bridgePhase error when an admission violates the contract', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValueOnce({ state: 'maybe' });
    store().submitTurn(CONV, 'first');
    await flush();

    expect(store().bridgePhase).toBe('error');
    expect(store().bridgeError).toBeTruthy();
    expect(conv().runs[RUN_A].phase).toBe('failed');
  });

  it('rejects an admission that names another run', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValueOnce(admissionPayload(RUN_B));
    store().submitTurn(CONV, 'first');
    await flush();

    expect(store().bridgePhase).toBe('error');
    expect(conv().runs[RUN_A].phase).toBe('failed');
    expect(conv().runs[RUN_B]).toBeUndefined();
  });

  it('records lastFailedTurn from a terminal run.failed with a known request', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );
    expect(conv().lastFailedTurn).toEqual({
      draft: { message: 'first', contextRefs: [] },
      userEntryId: conv().runs[RUN_A].userEntryId,
    });
  });

  it('leaves a status-hydrated run without prompt metadata or an enabled retry', async () => {
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
          ],
        })
      )
    );
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );
    expect(conv().lastFailedTurn).toBeNull();

    mockRunGolemTurn.mockClear();
    store().retryLastFailed(CONV);
    await flush();
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
  });

  it('retries with a fresh run ID and reuses the original user row', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );
    const userEntryId = conv().runs[RUN_A].userEntryId!;

    uuidQueue = [RUN_B];
    mockRunGolemTurn.mockClear();
    store().retryLastFailed(CONV);
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    expect((mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest).identity.runId).toBe(RUN_B);
    const userRows = conv().transcript.filter((e) => e.kind === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].id).toBe(userEntryId);
    expect(userRows[0].runId).toBe(RUN_B);
    expect(conv().runs[RUN_B].userEntryId).toBe(userEntryId);
    expect(conv().lastFailedTurn).toBeNull();
    expect(store().runToConversation[RUN_B]).toBe(CONV);
  });
});

describe('cancel', () => {
  it('cancels a background run with its own identity and stays canceling until terminal', () => {
    const backgroundIdentity = {
      repoEpoch: EPOCH - 1,
      workspaceId: OTHER_WS,
      conversationId: OTHER_CONV,
      runId: RUN_C,
    };
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            {
              identity: backgroundIdentity,
              workspaceLabel: 'Backend (previous)',
              state: 'running',
            },
          ],
        })
      )
    );

    void store().cancelRun(RUN_C);
    const sent = mockCancelGolemRun.mock.calls[0][0] as ai.RunIdentity;
    expect({ ...sent }).toEqual(backgroundIdentity);
    expect(conv(OTHER_CONV).runs[RUN_C].phase).toBe('canceling');

    store().ingestEvent(
      eventPayload({
        threadId: OTHER_CONV,
        runId: RUN_C,
        seq: 1,
        type: 'run.canceled',
        payload: {},
      })
    );
    expect(conv(OTHER_CONV).runs[RUN_C].phase).toBe('canceled');
    expect(conv(OTHER_CONV).activeRunId).toBeNull();
  });

  it('ignores cancel for an unknown or already terminal run', async () => {
    hydrateReady();
    store().cancelRun(RUN_C);
    await flush();
    expect(mockCancelGolemRun).not.toHaveBeenCalled();

    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    store().cancelRun(RUN_A);
    await flush();
    expect(mockCancelGolemRun).not.toHaveBeenCalled();
  });

  it('restores the run and reports a bounded error when Cancel is rejected', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    mockCancelGolemRun.mockRejectedValueOnce('The Golem request is invalid or stale.');

    store().cancelRun(RUN_A);
    await flush();

    expect(conv().runs[RUN_A].phase).toBe('running');
    expect(
      conv()
        .transcript.filter((e) => e.kind === 'error')
        .pop()!.text
    ).toBe('The Golem request is invalid or stale.');
  });
});

describe('activity and failure revisions', () => {
  it('advances activity on running and canceling and failure on run failure', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    expect(store().lastActiveConversationId).toBe(CONV);
    const afterRunning = store().activityRevision;
    expect(afterRunning).toBeGreaterThan(0);

    void store().cancelRun(RUN_A);
    expect(store().activityRevision).toBeGreaterThan(afterRunning);

    const beforeFailure = store().failureRevision;
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );
    expect(store().failureRevision).toBeGreaterThan(beforeFailure);
    expect(store().lastFailureConversationId).toBe(CONV);
  });

  it('advances activity when a background run starts by event', () => {
    hydrateReady();
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
        })
      )
    );
    store().selectConversation(OTHER_CONV);
    useGolemStore.setState({ lastActiveConversationId: OTHER_CONV });
    const before = store().activityRevision;

    store().ingestEvent(
      eventPayload({ threadId: CONV, runId: RUN_C, seq: 1, type: 'run.started' })
    );

    expect(conv().runs[RUN_C].phase).toBe('running');
    expect(store().lastActiveConversationId).toBe(CONV);
    expect(store().activityRevision).toBeGreaterThan(before);
  });

  it('marks a new consent challenge as the newest conversation activity', async () => {
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            {
              identity: runIdentity(RUN_C, {
                workspaceId: OTHER_WS,
                conversationId: OTHER_CONV,
              }),
              workspaceLabel: 'Backend',
              state: 'running',
            },
          ],
        })
      )
    );
    expect(store().lastActiveConversationId).toBe(OTHER_CONV);
    const before = store().activityRevision;

    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValueOnce(
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A),
      })
    );
    store().submitTurn(CONV, 'ask remote');
    await flush();

    expect(conv().runs[RUN_A].phase).toBe('needs-consent');
    expect(store().lastActiveConversationId).toBe(CONV);
    expect(store().activityRevision).toBeGreaterThan(before);
  });

  it('advances activity when hydration adopts a live run, but not when it re-lists one', () => {
    const withRun = (state: string) =>
      statusPayload({
        activeRuns: [{ identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state }],
      });
    const before = store().activityRevision;

    store().hydrateStatus(parseGolemStatus(withRun('running')));
    const adopted = store().activityRevision;
    expect(adopted).toBeGreaterThan(before);
    expect(store().lastActiveConversationId).toBe(CONV);

    // A status refresh that reports the same run must not re-alert.
    store().hydrateStatus(parseGolemStatus(withRun('running')));
    expect(store().activityRevision).toBe(adopted);

    store().hydrateStatus(parseGolemStatus(withRun('canceling')));
    expect(store().activityRevision).toBeGreaterThan(adopted);
  });

  it('keeps an older failure visible when newer activity happens elsewhere', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );
    const failureRevision = store().failureRevision;

    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          identity: { ...identity, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
        })
      )
    );
    store().selectConversation(OTHER_CONV);
    uuidQueue = [RUN_B];
    store().submitTurn(OTHER_CONV, 'other');
    await flush();

    expect(store().lastActiveConversationId).toBe(OTHER_CONV);
    expect(store().lastFailureConversationId).toBe(CONV);
    expect(store().failureRevision).toBe(failureRevision);
  });

  it('advances the failure revision when a newly hydrated status is degraded', () => {
    hydrateReady();
    const before = store().failureRevision;
    hydrateReady({
      available: false,
      initError:
        'Remote consent storage is unavailable; open Golem configuration for repair steps.',
    });
    expect(store().failureRevision).toBeGreaterThan(before);
    expect(store().lastFailureConversationId).toBe(CONV);

    const settled = store().failureRevision;
    hydrateReady({
      available: false,
      initError:
        'Remote consent storage is unavailable; open Golem configuration for repair steps.',
    });
    expect(store().failureRevision).toBe(settled);
  });
});

describe('clearConversation', () => {
  const needsConsentAdmission = (runId: string) =>
    admissionPayload(runId, {
      state: 'needs_consent',
      destination: remoteDestination,
      consentChallenge: challengeFor(runId),
    });

  it('resets content to the fresh idle shape while preserving backend status and changing the object reference', async () => {
    hydrateReady({
      needsConsent: true,
      warnings: ['policy drift'],
      destination: remoteDestination,
    });
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(
      eventPayload({ seq: 1, type: 'message.delta', payload: { messageId: 'm1', text: 'hi' } })
    );
    store().ingestEvent(
      eventPayload({ seq: 2, type: 'run.failed', payload: { code: 'run_failed', message: 'boom' } })
    );

    // A rich but idle conversation: content present, no live run, and a failure
    // that put this conversation in the StatusBar's "Attention" slot.
    const before = conv();
    expect(before.transcript.length).toBeGreaterThanOrEqual(3);
    expect(before.rawEvents).toHaveLength(2);
    expect(before.runs[RUN_A].phase).toBe('failed');
    expect(before.lastFailedTurn).not.toBeNull();
    expect(before.activeRunId).toBeNull();
    expect(before.pendingConsentTurn).toBeNull();
    expect(store().runToConversation[RUN_A]).toBe(CONV);
    expect(store().lastFailureConversationId).toBe(CONV);
    const focusRevision = store().composerFocusRevision;

    expect(store().clearConversation(CONV)).toEqual({ ok: true });
    const after = conv();

    // Copy-on-write: a brand-new conversation object so every subscriber re-renders.
    expect(after).not.toBe(before);
    // Content wiped to the fresh values.
    expect(after.rawEvents).toEqual([]);
    expect(after.transcript).toEqual([]);
    expect(after.runs).toEqual({});
    expect(after.activeRunId).toBeNull();
    expect(after.queuedTurns).toEqual([]);
    expect(after.pendingConsentTurn).toBeNull();
    expect(after.lastFailedTurn).toBeNull();
    // Backend-derived status survives untouched.
    expect(after.identity).toEqual(identity);
    expect(after.workspaceLabel).toBe('Frontend');
    expect(after.available).toBe(true);
    expect(after.needsConsent).toBe(true);
    expect(after.warnings).toEqual(['policy drift']);
    expect(after.initError).toBeNull();
    expect(after.destination).toEqual(remoteDestination);
    // Routing purged, the failure slot released, and the composer refocused.
    expect(store().runToConversation[RUN_A]).toBeUndefined();
    expect(store().lastFailureConversationId).toBeNull();
    expect(store().composerFocusRevision).toBe(focusRevision + 1);
  });

  it('purges only the cleared conversation from runToConversation', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(eventPayload({ seq: 1, type: 'run.finished', payload: {} }));
    // A second CONV-mapped run plus one belonging to another conversation.
    useGolemStore.setState((state) => ({
      runToConversation: { ...state.runToConversation, [RUN_B]: OTHER_CONV, [RUN_C]: CONV },
    }));

    store().clearConversation(CONV);

    expect(store().runToConversation[RUN_A]).toBeUndefined();
    expect(store().runToConversation[RUN_C]).toBeUndefined();
    expect(store().runToConversation[RUN_B]).toBe(OTHER_CONV);
  });

  it('clears its own failure slot but leaves one pointing elsewhere', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().ingestEvent(eventPayload({ seq: 1, type: 'run.finished', payload: {} }));
    useGolemStore.setState({ lastFailureConversationId: OTHER_CONV });
    const failureRevision = store().failureRevision;

    store().clearConversation(CONV);

    expect(store().lastFailureConversationId).toBe(OTHER_CONV);
    expect(store().failureRevision).toBe(failureRevision);
  });

  it('empties queued turns left idle after an unbind', async () => {
    hydrateReady({ destination: remoteDestination, needsConsent: true });
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValue(needsConsentAdmission(RUN_A));
    store().submitTurn(CONV, 'first');
    await flush();
    store().submitTurn(CONV, 'second');
    await flush();
    store().invalidateBinding();

    // Idle (no live run, no pending consent) but still carrying staged turns.
    expect(conv().activeRunId).toBeNull();
    expect(conv().pendingConsentTurn).toBeNull();
    expect(conv().queuedTurns.length).toBeGreaterThan(0);

    store().clearConversation(CONV);

    expect(conv().queuedTurns).toEqual([]);
    expect(conv().transcript).toEqual([]);
  });

  it('is a no-op while a run is live', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockReturnValue(gate.promise);
    expect(store().submitTurn(CONV, 'first')).toEqual({ ok: true });
    expect(conv().activeRunId).toBe(RUN_A);

    const before = conv();
    store().clearConversation(CONV);

    // Same reference and content intact: the guard refused it.
    expect(conv()).toBe(before);
    expect(conv().transcript.filter((e) => e.kind === 'user')).toHaveLength(1);

    gate.resolve(admissionPayload(RUN_A));
    await flush();
  });

  it('is a no-op while a consent is pending', async () => {
    hydrateReady({ destination: remoteDestination, needsConsent: true });
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValue(needsConsentAdmission(RUN_A));
    store().submitTurn(CONV, 'ask remote');
    await flush();
    expect(conv().pendingConsentTurn).not.toBeNull();

    const before = conv();
    store().clearConversation(CONV);

    expect(conv()).toBe(before);
    expect(conv().pendingConsentTurn).not.toBeNull();
  });

  it('does nothing for an unknown conversation', () => {
    hydrateReady();
    const before = store().conversations;
    expect(store().clearConversation('conv-nope')).toMatchObject({ ok: false });
    expect(store().conversations).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #271 B4 — synchronous local admission
//
// Every action method answers for the *local* state transition it just made or
// refused, before the provider has said anything. A rejected provider promise
// is never a refusal: admission already owns that submitted prompt, and its
// later failure belongs to the transcript/retry flow.
// ─────────────────────────────────────────────────────────────────────────────

describe('admission results', () => {
  it('admits explicit text before the provider responds', () => {
    store().hydrateStatus(parseGolemStatus(statusPayload()));
    uuidQueue.push(RUN_A);
    mockRunGolemTurn.mockReturnValue(new Promise(() => {}));
    expect(store().submitTurn(CONV, '  explicit text  ')).toEqual({ ok: true });
    expect((mockRunGolemTurn.mock.calls[0][0] as ai.TurnRequest).message).toBe('explicit text');
    expect(store().conversations[CONV]).not.toHaveProperty('draft');
  });

  it('refuses an old conversation without retargeting or accepting its input', () => {
    store().hydrateStatus(parseGolemStatus(statusPayload()));
    store().invalidateBinding();
    const refusal = store().submitTurn(CONV, 'keep this');
    expect(refusal).toMatchObject({ ok: false });
    expect(refusal.reason).toEqual(expect.any(String));
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    // Nothing was retargeted onto a still-bound conversation, and the refused
    // text never reached the transcript or the queue.
    expect(conv().transcript).toEqual([]);
    expect(conv().queuedTurns).toEqual([]);
  });

  it('refuses a blank message with a reason rather than silently doing nothing', () => {
    hydrateReady();
    expect(store().submitTurn(CONV, '   ')).toMatchObject({ ok: false });
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
  });

  it('admits a Send staged behind a live run as a queued turn', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    const admitting = deferred<Record<string, unknown>>();
    mockRunGolemTurn.mockReturnValueOnce(admitting.promise);
    expect(store().submitTurn(CONV, 'first')).toEqual({ ok: true });

    expect(store().submitTurn(CONV, 'second')).toEqual({ ok: true });
    expect(conv().queuedTurns.map((turn) => turn.message)).toEqual(['second']);
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);

    admitting.resolve(admissionPayload(RUN_A));
    await flush();
  });

  it('refuses a Send this window cannot name a secure run for', () => {
    hydrateReady();
    installCrypto({});
    expect(store().submitTurn(CONV, 'hello')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('secure run ID'),
    });
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    installCrypto({ randomUUID: mockRandomUUID });
  });

  it('refuses Clear while a run is live and accepts it once the conversation is idle', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    const admitting = deferred<Record<string, unknown>>();
    mockRunGolemTurn.mockReturnValueOnce(admitting.promise);
    store().submitTurn(CONV, 'first');

    expect(store().clearConversation(CONV)).toMatchObject({ ok: false });
    expect(conv().transcript).not.toEqual([]);

    admitting.resolve(admissionPayload(RUN_A));
    await flush();
    store().ingestEvent(eventPayload({ seq: 1, type: 'run.finished', payload: {} }));
    expect(store().clearConversation(CONV)).toEqual({ ok: true });
    expect(conv().transcript).toEqual([]);
  });

  it('accepts Clear on an idle conversation whose only content is its host draft', () => {
    hydrateReady();
    // The store holds no composer text at all now, so an empty conversation is
    // still clearable: only its host knows whether there is a draft to drop.
    expect(conv().transcript).toEqual([]);
    expect(store().clearConversation(CONV)).toEqual({ ok: true });
  });

  it('refuses a queue edit or removal for a dispatched or unknown id', async () => {
    hydrateReady();
    uuidQueue = [RUN_A, RUN_B];
    const admitting = deferred<Record<string, unknown>>();
    mockRunGolemTurn.mockReturnValueOnce(admitting.promise);
    store().submitTurn(CONV, 'first');
    store().submitTurn(CONV, 'second');
    const queueId = conv().queuedTurns[0].queueId;
    expect(store().updateQueuedTurn(CONV, queueId, 'second, revised')).toEqual({ ok: true });

    expect(store().updateQueuedTurn(CONV, 'queue-nope', 'x')).toMatchObject({ ok: false });
    expect(store().removeQueuedTurn(CONV, 'queue-nope')).toMatchObject({ ok: false });

    admitting.resolve(admissionPayload(RUN_A));
    await flush();
    store().ingestEvent(eventPayload({ seq: 1, type: 'run.finished', payload: {} }));
    // The queued turn was dispatched by the terminal, so its id is gone.
    expect(conv().queuedTurns).toEqual([]);
    expect(store().updateQueuedTurn(CONV, queueId, 'too late')).toMatchObject({ ok: false });
    expect(store().removeQueuedTurn(CONV, queueId)).toMatchObject({ ok: false });
  });

  it('admits a background run cancellation by that run own identity', () => {
    const backgroundIdentity = {
      repoEpoch: EPOCH - 1,
      workspaceId: OTHER_WS,
      conversationId: OTHER_CONV,
      runId: RUN_C,
    };
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            {
              identity: backgroundIdentity,
              workspaceLabel: 'Backend (previous)',
              state: 'running',
            },
          ],
        })
      )
    );
    expect(store().selectConversation(OTHER_CONV)).toEqual({ ok: true });
    expect(store().selectConversation('conv-nope')).toMatchObject({ ok: false });

    expect(store().cancelRun(RUN_C)).toEqual({ ok: true });
    expect({ ...(mockCancelGolemRun.mock.calls[0][0] as ai.RunIdentity) }).toEqual(
      backgroundIdentity
    );
    expect(store().cancelRun(RUN_C)).toMatchObject({ ok: false });
    expect(store().cancelRun(RUN_B)).toMatchObject({ ok: false });
  });

  it('refuses an approval that names a different run or challenge', async () => {
    hydrateReady({ needsConsent: true, destination: remoteDestination });
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValueOnce(
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A),
      })
    );
    store().submitTurn(CONV, 'ask remote');
    await flush();
    const pending = conv().pendingConsentTurn!;
    expect(pending.challenge.id).toBe('challenge-1');

    expect(store().allowAndSend(CONV, RUN_B, pending.challenge.id)).toMatchObject({ ok: false });
    expect(store().allowAndSend(CONV, RUN_A, 'challenge-other')).toMatchObject({ ok: false });
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);

    expect(store().allowAndSend(CONV, RUN_A, 'challenge-1')).toEqual({ ok: true });
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('refuses a mismatched approval on its own terms without releasing an expired challenge', async () => {
    hydrateReady({ needsConsent: true, destination: remoteDestination });
    uuidQueue = [RUN_A];
    mockRunGolemTurn.mockResolvedValueOnce(
      admissionPayload(RUN_A, {
        state: 'needs_consent',
        destination: remoteDestination,
        consentChallenge: challengeFor(RUN_A),
      })
    );
    store().submitTurn(CONV, 'ask remote');
    await flush();
    const pending = conv().pendingConsentTurn!;
    jest.spyOn(Date, 'now').mockReturnValue(pending.challenge.expiresAt + 1);

    // A stale view approving a challenge that is not the current one has no
    // standing over the current one — expiring it here would clear a challenge
    // the user in front of it never saw.
    expect(store().allowAndSend(CONV, RUN_B, pending.challenge.id)).toEqual({
      ok: false,
      reason: 'That approval was for a different request.',
    });
    expect(conv().pendingConsentTurn).toBe(pending);
    expect(conv().runs[RUN_A].phase).toBe('needs-consent');
    expect(conv().transcript.filter((e) => e.kind === 'error')).toHaveLength(0);

    // The matching approval is still the one that gets told it expired.
    expect(store().allowAndSend(CONV, RUN_A, pending.challenge.id)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('expired'),
    });
    expect(conv().pendingConsentTurn).toBeNull();
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
  });

  it('refuses Retry when there is nothing that failed', () => {
    hydrateReady();
    expect(store().retryLastFailed(CONV)).toMatchObject({ ok: false });
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
  });
});

describe('monotonicity under deferred promises', () => {
  it('does not let a late accepted admission resurrect a terminal run or redispatch the queue', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    const gate = deferred<unknown>();
    mockRunGolemTurn.mockReturnValueOnce(gate.promise);
    expect(store().submitTurn(CONV, 'first')).toEqual({ ok: true });
    store().submitTurn(CONV, 'second');
    await flush();

    uuidQueue = [RUN_B];
    store().ingestEvent(eventPayload({ seq: 1, type: 'run.started' }));
    store().ingestEvent(
      eventPayload({
        seq: 2,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    await flush();
    const callsAfterDispatch = mockRunGolemTurn.mock.calls.length;
    expect(conv().activeRunId).toBe(RUN_B);

    gate.resolve(admissionPayload(RUN_A));
    await flush();

    expect(conv().runs[RUN_A].phase).toBe('done');
    expect(conv().activeRunId).toBe(RUN_B);
    expect(mockRunGolemTurn.mock.calls).toHaveLength(callsAfterDispatch);
    expect(conv().queuedTurns).toHaveLength(0);
  });

  it('preserves the terminal tombstone when an active status snapshot resolves late', async () => {
    hydrateReady();
    uuidQueue = [RUN_A];
    store().submitTurn(CONV, 'first');
    await flush();
    store().submitTurn(CONV, 'second');
    await flush();

    uuidQueue = [RUN_B];
    store().ingestEvent(
      eventPayload({
        seq: 1,
        type: 'run.finished',
        payload: { stopReason: 'end_turn', model: 'm' },
      })
    );
    await flush();
    const callsAfterDispatch = mockRunGolemTurn.mock.calls.length;

    // A GetGolemStatus snapshot captured before the terminal now resolves.
    store().hydrateStatus(
      parseGolemStatus(
        statusPayload({
          activeRuns: [
            { identity: runIdentity(RUN_A), workspaceLabel: 'Frontend', state: 'running' },
          ],
        })
      )
    );
    await flush();

    expect(conv().runs[RUN_A].phase).toBe('done');
    expect(conv().activeRunId).toBe(RUN_B);
    expect(mockRunGolemTurn.mock.calls).toHaveLength(callsAfterDispatch);
  });
});

// Type-level guard: the declared union stays discriminated, so consumers cannot
// read a challenge off an accepted admission.
it('keeps TurnAdmission discriminated by state', () => {
  const admission: TurnAdmission = parseTurnAdmission(admissionPayload(RUN_A));
  if (admission.state === 'accepted') {
    expect(admission.consentChallenge).toBeUndefined();
  }
  const status: GolemStatus = parseGolemStatus(statusPayload());
  expect(status.identity.conversationId).toBe(CONV);
});

describe('configuration tab flags (#263 Slice B)', () => {
  beforeEach(() => {
    __resetGolemStore();
  });

  it('starts closed and unfocused', () => {
    expect(useGolemStore.getState().configTabOpen).toBe(false);
    expect(useGolemStore.getState().configTabFocused).toBe(false);
  });

  it('open focuses the single tab and reopening is idempotent', () => {
    useGolemStore.getState().openConfigTab();
    expect(useGolemStore.getState().configTabOpen).toBe(true);
    expect(useGolemStore.getState().configTabFocused).toBe(true);

    useGolemStore.getState().setConfigTabFocused(false);
    useGolemStore.getState().openConfigTab();
    expect(useGolemStore.getState()).toMatchObject({
      configTabOpen: true,
      configTabFocused: true,
    });
  });

  it('close clears both flags', () => {
    useGolemStore.getState().openConfigTab();
    useGolemStore.getState().closeConfigTab();
    expect(useGolemStore.getState()).toMatchObject({
      configTabOpen: false,
      configTabFocused: false,
    });
  });

  it('never focuses a closed tab', () => {
    useGolemStore.getState().setConfigTabFocused(true);
    expect(useGolemStore.getState().configTabFocused).toBe(false);
  });
});
