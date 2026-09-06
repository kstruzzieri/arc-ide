import type { GolemStoreState, RunPhase } from '../types/golem';
import type { GolemView, ProjectedConversation, ProjectedRun } from '../types/golemWindow';

/**
 * The presentation projection main publishes to the satellite (#271 spec §5.2).
 *
 * Every field is enumerated rather than spread: a spread of `ConversationView`
 * would ship the transcript's `raw` provider events and each run's owner-only
 * submitted `request` across a window boundary. Adding a field to
 * `ConversationView` must therefore be a deliberate decision to project it, not
 * an accident of structure. (Composer text is not among the risks any more —
 * since #271 B4 it lives in the visible host's `draftStore`, so the executing
 * owner has nothing to leak — but the enumeration is what keeps that true for
 * the *next* field somebody adds.)
 *
 * `lastFailedTurn` narrows to a boolean on purpose: the satellite needs to know
 * only whether Retry is available, never the prompt that failed.
 */
/**
 * Exactly the slices the projection reads. Narrower than `GolemStoreState` on
 * purpose: it lets a host memoize on those six subscriptions instead of on a
 * whole-store `getState()` read the dependency checker cannot see through.
 */
export type GolemProjectionSource = Pick<
  GolemStoreState,
  | 'conversations'
  | 'bridgePhase'
  | 'bridgeError'
  | 'hydratedIdentity'
  | 'selectedConversationId'
  | 'composerFocusRevision'
>;

export function buildGolemView(state: GolemProjectionSource): GolemView {
  const conversations: Record<string, ProjectedConversation> = Object.create(null) as Record<
    string,
    ProjectedConversation
  >;
  for (const [id, c] of Object.entries(state.conversations)) {
    conversations[id] = {
      identity: c.identity,
      workspaceLabel: c.workspaceLabel,
      available: c.available,
      needsConsent: c.needsConsent,
      // Copied, not aliased: a projection can be in flight while the store
      // mutates, and a payload must never change under the serializer.
      warnings: [...c.warnings],
      initError: c.initError,
      destination: c.destination,
      activeRunId: c.activeRunId,
      queuedTurns: c.queuedTurns.map((turn) => ({ ...turn, contextRefs: [...turn.contextRefs] })),
      transcript: c.transcript.map((entry) => ({
        id: entry.id,
        runId: entry.runId,
        kind: entry.kind,
        text: entry.text,
        ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
        ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
        ...(entry.activity === undefined ? {} : { activity: entry.activity }),
      })),
      runs: Object.fromEntries(
        Object.entries(c.runs).map(([runId, run]): [string, ProjectedRun] => [
          runId,
          {
            identity: run.identity,
            phase: run.phase,
            lastSeq: run.lastSeq,
            ...(run.error === undefined ? {} : { error: run.error }),
          },
        ])
      ),
      pendingConsentTurn:
        c.pendingConsentTurn === null
          ? null
          : {
              identity: c.pendingConsentTurn.identity,
              challenge: c.pendingConsentTurn.challenge,
            },
      lastFailedTurn: c.lastFailedTurn !== null,
    };
  }
  return {
    bridgePhase: state.bridgePhase,
    bridgeError: state.bridgeError,
    hydratedIdentity: state.hydratedIdentity,
    selectedConversationId: state.selectedConversationId,
    composerFocusRevision: state.composerFocusRevision,
    processedThrough: 0, // stamped by the instance's main relay at flush time
    conversations,
  };
}

// ── reading a projection ──────────────────────────────────────────────────────
// Pure derivations over a `GolemView`, shared by the passive `GolemSurface` and
// by whichever chrome hosts it (#271 B4). They live beside the builder rather
// than in the component so both hosts read a projection the same way, and so a
// component file keeps exporting only components.

/** Phases shown as live in the focused or background run surfaces. */
export const isLivePhase = (phase: RunPhase): boolean =>
  phase === 'admitting' ||
  phase === 'needs-consent' ||
  phase === 'running' ||
  phase === 'canceling';

/**
 * The host chrome's live status, also carried as sr-only text beside the
 * breathing mark. Keyed by exactly the live phases, so a present label doubles
 * as the "something is happening" flag — the transcript's live rail node reads
 * it rather than testing `isLivePhase` a second time.
 */
export const STATUS_LABEL: Partial<Record<RunPhase, string>> = {
  admitting: 'RUNNING',
  running: 'RUNNING',
  canceling: 'CANCELING',
  'needs-consent': 'APPROVAL',
};

export const workspaceName = (conversation: ProjectedConversation): string =>
  conversation.workspaceLabel || 'Workspace';

/** The conversation a projection has focused, or null when it has none. */
export const selectedConversation = (view: GolemView): ProjectedConversation | null =>
  view.selectedConversationId ? (view.conversations[view.selectedConversationId] ?? null) : null;

/** The run occupying a conversation's active slot, or null. */
export const activeRunOf = (conversation: ProjectedConversation | null): ProjectedRun | null =>
  conversation?.activeRunId != null ? (conversation.runs[conversation.activeRunId] ?? null) : null;

/**
 * Whether a projected conversation is still bound to the identity the backend
 * most recently hydrated. An unbound conversation cannot accept a turn, and its
 * identity is the only thing the backend would reject it by.
 */
export const isBound = (view: GolemView, conversation: ProjectedConversation): boolean => {
  const current = view.hydratedIdentity;
  return (
    current !== null &&
    current.repoEpoch === conversation.identity.repoEpoch &&
    current.workspaceId === conversation.identity.workspaceId &&
    current.conversationId === conversation.identity.conversationId
  );
};
