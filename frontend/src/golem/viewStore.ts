import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { GolemView, GolemWindowState } from '../types/golemWindow';

/**
 * Everything the undocked Golem window knows (#271 spec §5.2).
 *
 * Passive by construction: this file imports no owner, no bridge and no
 * binding, and the store has no actions of its own. `windowSatellite.ts` is the
 * only writer — it validates every projection and every lifecycle snapshot
 * before it lands here, so a component reading this store can never be looking
 * at an unparsed wire payload.
 */
export interface ViewStore {
  /**
   * The newest projection main has published, or null until the first one
   * arrives. Null is a real state: a window can be open and bootstrapped before
   * main has ever flushed a view.
   */
  view: GolemView | null;
  /** The newest Go lifecycle snapshot, kept by `stateRevision`. */
  state: GolemWindowState | null;
  /**
   * The interaction barrier. True until this window owns a ready view with the
   * complete transferred draft map, and again for the whole of a re-dock.
   */
  frozen: boolean;
  /**
   * Conversations whose Send or Clear is waiting on an acknowledgement. A
   * member keeps its composer locked even when the rest of the window is live,
   * because an unconfirmed action must not be issued twice.
   */
  pendingComposers: ReadonlySet<string>;
  /** The last failure this window could not hide, or null. */
  error: string | null;
  /** A failed projection stays blocking until a newer complete view arrives. */
  projectionError: string | null;
}

/** Shared empty membership, so an idle window never allocates a Set. */
export const NO_PENDING_COMPOSERS: ReadonlySet<string> = new Set<string>();

export const useViewStore = create<ViewStore>()(
  devtools(
    (): ViewStore => ({
      view: null,
      state: null,
      // Frozen until proven otherwise: an unstarted satellite must not accept a
      // keystroke it has nowhere to send.
      frozen: true,
      pendingComposers: NO_PENDING_COMPOSERS,
      error: null,
      projectionError: null,
    }),
    { name: 'golem-window-view' }
  )
);
