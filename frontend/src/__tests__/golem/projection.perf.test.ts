/**
 * Task B7 — the projection payload measured against Go's hard limit (#271 §5.2).
 *
 * `PostGolemWindowMessage` refuses any message whose payload exceeds
 * `golemWindowMaxPayload` (app_golem_window.go), so the size of a projected
 * `GolemView` is a correctness property of this plan, not a performance nicety:
 * a long chat that serializes past the cap stops crossing the window boundary
 * altogether. The cap is read out of the Go source rather than retyped, so the
 * two cannot drift apart silently.
 *
 * Bytes are counted with `TextEncoder`, never `string.length`: Go measures the
 * UTF-8 body, and one CJK character is three bytes to Go and one unit to JS —
 * a 1.4 MB transcript would look like a 470 KB one to `length`.
 *
 * Elapsed time is printed, not asserted. A wall-clock threshold in Jest is a
 * measurement of the CI runner, and a flaky gate that fails on a busy machine
 * teaches people to re-run it rather than to read it. The real timing evidence
 * is the streaming measurement on a supported laptop, recorded in the task
 * report.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGolemView } from '../../golem/projection';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { GOLEM_WINDOW_MAX_PAYLOAD_BYTES, parseGolemView } from '../../types/golemWindow';
import type { ConversationView, TranscriptEntry } from '../../types/golem';

/** Go's own `golemWindowMaxPayload`, parsed so a change there fails here. */
const GO_PAYLOAD_CAP = (() => {
  const source = readFileSync(resolve(__dirname, '../../../../app_golem_window.go'), 'utf8');
  const match = /golemWindowMaxPayload\s*=\s*(\d+)\s*<<\s*(\d+)/.exec(source);
  if (!match) throw new Error('golemWindowMaxPayload is no longer declared as `N << M`');
  return Number(match[1]) << Number(match[2]);
})();

const identity = { repoEpoch: 1, workspaceId: 'project', conversationId: 'c1' };
const RUN = '11111111-1111-4111-8111-111111111111';

/**
 * A deterministic worst-plausible chat: multilingual assistant text (three
 * bytes per character), tool chips, queued turns, warnings and a pending
 * consent — everything the projection actually copies, at a length no real
 * session is likely to pass.
 */
function longChat(turns: number, charsPerTurn: number): ConversationView {
  const transcript: TranscriptEntry[] = [];
  for (let i = 0; i < turns; i += 1) {
    transcript.push({ id: `u${i}`, runId: RUN, kind: 'user', text: '測定'.repeat(8) });
    transcript.push({
      id: `t${i}`,
      runId: RUN,
      kind: 'tool',
      text: '検索結果'.repeat(12),
      toolCallId: `call-${i}`,
      toolName: 'search',
      activity: 'done',
    });
    transcript.push({
      id: `e${i}`,
      runId: RUN,
      kind: 'assistant',
      text: '測定'.repeat(charsPerTurn / 2),
    });
  }
  return {
    identity,
    workspaceLabel: 'repo',
    available: true,
    needsConsent: true,
    warnings: ['この設定は確認が必要です。', 'A second provider warning.'],
    initError: null,
    destination: {
      provider: 'anthropic',
      model: 'claude-opus',
      endpoint: 'https://api.example.test/v1',
      classification: 'remote',
      digest: 'digest-remote',
    },
    rawEvents: [],
    transcript,
    runs: {
      [RUN]: { identity: { ...identity, runId: RUN }, phase: 'needs-consent', lastSeq: turns },
    },
    activeRunId: RUN,
    queuedTurns: [
      { queueId: 'q1', state: 'queued', message: '次の質問'.repeat(20), contextRefs: [] },
      { queueId: 'q2', state: 'reopen-required', message: 'follow up', contextRefs: [] },
    ],
    pendingConsentTurn: {
      draft: { message: '承認待ち'.repeat(20), contextRefs: [] },
      userEntryId: 'u0',
      identity: { ...identity, runId: RUN },
      challenge: {
        id: 'challenge-1',
        identity: { ...identity, runId: RUN },
        destination: {
          provider: 'anthropic',
          model: 'claude-opus',
          endpoint: 'https://api.example.test/v1',
          classification: 'remote',
          digest: 'digest-remote',
        },
        destinationDigest: 'digest-remote',
        expiresAt: 0,
      },
    },
    lastFailedTurn: null,
  };
}

function install(conversation: ConversationView): void {
  __resetGolemStore();
  useGolemStore.setState({
    bridgePhase: 'ready',
    bridgeError: null,
    hydratedIdentity: identity,
    selectedConversationId: identity.conversationId,
    conversations: { [identity.conversationId]: conversation },
  });
}

/** The full publish path: project, serialize, measure, validate on receipt. */
function measure(samples: number): { bytes: number; medianMs: number; maxMs: number } {
  const timings: number[] = [];
  let bytes = 0;
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    const wire = JSON.stringify(buildGolemView(useGolemStore.getState()));
    bytes = new TextEncoder().encode(wire).byteLength;
    parseGolemView(JSON.parse(wire));
    // The first two runs pay for JIT warm-up and are not part of the shape.
    if (i >= 2) timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return {
    bytes,
    medianMs: timings[Math.floor(timings.length / 2)],
    maxMs: timings[timings.length - 1],
  };
}

describe('projection payload', () => {
  it('uses the same payload byte limit for frontend admission and Go relay validation', () => {
    expect(GOLEM_WINDOW_MAX_PAYLOAD_BYTES).toBe(GO_PAYLOAD_CAP);
  });
  it('measures a long multilingual transcript through projection and validation', () => {
    // A long working session, at the sizes a CJK conversation actually reaches.
    install(longChat(400, 200));
    const ordinary = measure(12);
    console.info({
      case: 'long-session-400-turns',
      ...ordinary,
      cap: GO_PAYLOAD_CAP,
      marginPercent: Math.round((1 - ordinary.bytes / GO_PAYLOAD_CAP) * 100),
    });
    expect(ordinary.bytes).toBeLessThanOrEqual(GO_PAYLOAD_CAP);

    // Five times that, as the headroom probe. The payload is linear in
    // transcript bytes, so this datapoint is what says where the cap would
    // actually bind — see the task report for the extrapolation.
    install(longChat(2000, 200));
    const extreme = measure(12);
    console.info({
      case: 'extreme-2000-turns',
      ...extreme,
      cap: GO_PAYLOAD_CAP,
      marginPercent: Math.round((1 - extreme.bytes / GO_PAYLOAD_CAP) * 100),
    });
    // Not merely under the cap: the headroom itself is the claim. Five times a
    // long session must still leave a quarter of the payload budget unused, so
    // a projection that grows toward the cap fails here instead of in Go.
    expect(extreme.bytes).toBeLessThan(GO_PAYLOAD_CAP * 0.75);
  });

  it('reports an oversized transcript at full size rather than truncating it', () => {
    // The refusal has to be Go's, on a complete payload. A projection that
    // quietly dropped rows to fit would hand the satellite a conversation that
    // is missing turns, with nothing anywhere saying so.
    install(longChat(4000, 400));
    const view = buildGolemView(useGolemStore.getState());
    const bytes = new TextEncoder().encode(JSON.stringify(view)).byteLength;
    console.info({ case: 'oversized', bytes, cap: GO_PAYLOAD_CAP });

    expect(bytes).toBeGreaterThan(GO_PAYLOAD_CAP);
    expect(view.conversations[identity.conversationId].transcript).toHaveLength(4000 * 3);
  });
});
