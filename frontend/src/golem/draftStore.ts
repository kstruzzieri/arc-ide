import { create } from 'zustand';
import type { GolemDraftMap } from '../types/golemWindow';

interface DraftStore {
  drafts: GolemDraftMap;
  setDraft(conversationId: string, text: string): void;
  clear(conversationId: string): void;
  takeAll(): GolemDraftMap;
  installAll(map: GolemDraftMap): void;
}

/**
 * Host-lifetime composer drafts, keyed by conversation (#271 spec §5.2, B).
 *
 * One instance per JS context: the visible host edits it, and the whole map is
 * transferred exactly once inside the handoff barrier. Drafts are never part of
 * a projection, so this deliberately does not live in `golemStore` — the
 * executing owner must have no way to publish what the user is still typing.
 *
 * `takeAll` and `installAll` copy rather than share: the map crosses a window
 * boundary as JSON, and a caller holding the live object could otherwise mutate
 * store state behind zustand's back.
 */
export const useDraftStore = create<DraftStore>()((set, get) => ({
  drafts: {},
  setDraft: (conversationId, text) =>
    set((s) =>
      s.drafts[conversationId] === text ? s : { drafts: { ...s.drafts, [conversationId]: text } }
    ),
  clear: (conversationId) => set((s) => ({ drafts: { ...s.drafts, [conversationId]: '' } })),
  takeAll: () => ({ ...get().drafts }),
  installAll: (map) => set({ drafts: { ...map } }),
}));
