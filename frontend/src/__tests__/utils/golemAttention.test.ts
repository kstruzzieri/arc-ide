import { golemAttention } from '../../utils/golemAttention';
import type { ConversationView } from '../../types/golem';

const conv = (over: Partial<ConversationView>): ConversationView =>
  ({
    identity: { repoEpoch: 1, workspaceId: 'project', conversationId: 'c1' },
    workspaceLabel: 'repo',
    available: true,
    needsConsent: false,
    warnings: [],
    initError: null,
    destination: null,
    rawEvents: [],
    transcript: [],
    runs: {},
    activeRunId: null,
    draft: '',
    queuedTurns: [],
    pendingConsentTurn: null,
    lastFailedTurn: null,
    ...over,
  }) as ConversationView;

it('is null with no live work', () => {
  expect(golemAttention({ conversations: { c1: conv({}) } })).toBeNull();
});

it('reports running for an active run', () => {
  expect(golemAttention({ conversations: { c1: conv({ activeRunId: 'r1' }) } })).toBe('running');
});

it('approval outranks running across conversations', () => {
  const pending = {
    challenge: { expiresAt: Date.now() + 60_000 },
  } as ConversationView['pendingConsentTurn'];
  expect(
    golemAttention({
      conversations: { c1: conv({ activeRunId: 'r1' }), c2: conv({ pendingConsentTurn: pending }) },
    })
  ).toBe('approval');
});
