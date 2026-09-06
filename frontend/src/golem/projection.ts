import type { GolemStoreState } from '../types/golem';
import type { GolemView, ProjectedConversation, ProjectedRun } from '../types/golemWindow';

/**
 * The presentation projection main publishes to the satellite (#271 spec §5.2).
 *
 * Every field is enumerated rather than spread: a spread of `ConversationView`
 * would ship the host's composer `draft`, the transcript's `raw` provider
 * events, and each run's owner-only submitted `request` across a window
 * boundary. Adding a field to `ConversationView` must therefore be a
 * deliberate decision to project it, not an accident of structure.
 *
 * `lastFailedTurn` narrows to a boolean on purpose: the satellite needs to know
 * only whether Retry is available, never the prompt that failed.
 */
export function buildGolemView(state: GolemStoreState): GolemView {
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
      warnings: c.warnings,
      initError: c.initError,
      destination: c.destination,
      activeRunId: c.activeRunId,
      queuedTurns: c.queuedTurns,
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
