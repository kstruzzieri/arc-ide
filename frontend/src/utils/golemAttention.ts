import type { ConversationView } from '../types/golem';

export type GolemAttention = 'approval' | 'running' | null;

/**
 * The Golem rail's one-glance state (#271 spec §2.4). Approval outranks
 * running because a waiting consent challenge is the only state that needs
 * the user; a running turn needs nothing.
 */
export function golemAttention(state: {
  conversations: Record<string, ConversationView>;
}): GolemAttention {
  let running = false;
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.pendingConsentTurn) return 'approval';
    if (conversation.activeRunId !== null) running = true;
  }
  return running ? 'running' : null;
}
