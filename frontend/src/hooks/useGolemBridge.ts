import { useEffect, useRef, useState } from 'react';
import { GetGolemStatus, GetWorkspaceInfo } from '../wails/bindings';
import { EventsOn } from '../wails/runtime';
import { ingestGolemEvents, useGolemStore } from '../stores/golemStore';
import { useIDEStore } from '../stores/ideStore';
import { boundedGolemMessage, parseGolemStatus, toStatusRequest } from '../types/golem';

/**
 * Always-mounted Golem bridge (#226 Task B7).
 *
 * Mounted beside `useRunOutputListener` in `App.tsx` because the chat panel
 * unmounts whenever the right panel collapses or switches to Runs — a listener
 * owned by the panel would silently drop a background run's output.
 *
 * Three effects, deliberately separate:
 *  1. subscriptions, for the App's whole lifetime;
 *  2. repository binding, serialized on one promise chain so an unbind can
 *     never overtake the bind that follows it;
 *  3. status hydration, keyed on the resolved epoch plus the focused workspace.
 */

const NOOP = () => {};

/**
 * One display frame at 60 Hz. While the Golem window is undocked, streamed
 * deltas are batched on a one-shot timer of this length instead of a frame:
 * `requestAnimationFrame` stops while main is minimized, and a microtask would
 * publish a full projection per token.
 */
const UNDOCKED_INGEST_MS = 16;

const isDeltaEvent = (payload: unknown): boolean =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as { type?: unknown }).type === 'message.delta';

export function useGolemBridge(): void {
  const repoPath = useIDEStore((state) => state.workspace?.path ?? '');
  const workspaceId = useIDEStore((state) => state.activeWorkspaceId);
  const [repoEpoch, setRepoEpoch] = useState<number | null>(null);

  const refreshRef = useRef<() => void>(NOOP);
  const bindChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const bindGenerationRef = useRef(0);
  const statusGenerationRef = useRef(0);
  const statusRequestRef = useRef(0);

  useEffect(() => {
    // Consecutive deltas are coalesced into one frame, but any other event —
    // including the run-status fallback — flushes them first so raw order,
    // assistant text, and lastSeq stay exactly as the backend emitted them.
    let pending: unknown[] = [];
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const flush = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      // One store mutation for the whole frame: a per-event apply copies the
      // conversation once per delta and does not survive a fast token stream.
      ingestGolemEvents(batch);
    };

    const offEvent = EventsOn('golem:event', (payload: unknown) => {
      if (isDeltaEvent(payload)) {
        pending.push(payload);
        // Undocked ingestion (#271). `requestAnimationFrame` stops firing while the window is
        // minimized or hidden, and the undocked Golem window is a separate
        // native window that stays on screen — so main would batch a whole
        // reply into a frame that never runs and publish nothing. While a
        // satellite exists in any phase, ingestion runs on a one-shot timer of
        // one display frame instead: it fires while minimized, and every
        // delta inside that frame still becomes one store mutation — and so
        // one projection — rather than one per token. Docked, the frame
        // batching is unchanged. Never a timer loop: this is event-triggered,
        // armed only by a delta and cleared by every flush, not polling.
        if (useGolemStore.getState().windowState.phase !== 'closed') {
          if (timer === null) {
            timer = setTimeout(() => {
              timer = null;
              if (!disposed) flush();
            }, UNDOCKED_INGEST_MS);
          }
        } else if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            flush();
          });
        }
        return;
      }
      flush();
      useGolemStore.getState().ingestEvent(payload);
    });

    const offRunStatus = EventsOn('golem:run-status', (payload: unknown) => {
      flush();
      useGolemStore.getState().ingestRunStatus(payload);
    });

    // Payload-free by contract: the backend never says what changed, so the
    // bridge re-reads the identity it is currently bound to and nothing else.
    const offStatusChanged = EventsOn('golem:status-changed', () => {
      refreshRef.current();
    });

    // A window opening while a frame is already queued would otherwise leave
    // that batch waiting on a frame the minimized window never produces.
    const offWindowPhase = useGolemStore.subscribe((state, previous) => {
      if (state.windowState.phase === previous.windowState.phase) return;
      if (state.windowState.phase !== 'closed') flush();
    });

    return () => {
      disposed = true;
      offWindowPhase();
      flush();
      offEvent?.();
      offRunStatus?.();
      offStatusChanged?.();
    };
  }, []);

  useEffect(() => {
    const generation = ++bindGenerationRef.current;
    if (!repoPath) return;

    useGolemStore.setState({ bridgePhase: 'binding', bridgeError: null });

    const bind = async () => {
      try {
        const info = await GetWorkspaceInfo(repoPath);
        if (generation !== bindGenerationRef.current) return; // superseded
        setRepoEpoch(typeof info?.repoEpoch === 'number' ? info.repoEpoch : null);
      } catch (err) {
        if (generation !== bindGenerationRef.current) return;
        useGolemStore.setState({
          bridgePhase: 'error',
          bridgeError: boundedGolemMessage(err),
        });
      }
    };
    bindChainRef.current = bindChainRef.current.then(bind, bind);

    return () => {
      bindGenerationRef.current += 1;
      setRepoEpoch(null);
      useGolemStore.getState().invalidateBinding();
      const unbind = () => GetWorkspaceInfo('').catch(NOOP);
      bindChainRef.current = bindChainRef.current.then(unbind, unbind);
    };
  }, [repoPath]);

  useEffect(() => {
    const generation = ++statusGenerationRef.current;
    refreshRef.current = NOOP;
    if (repoEpoch === null) return;

    const load = () => {
      const request = ++statusRequestRef.current;
      void (async () => {
        try {
          const raw = await GetGolemStatus(
            toStatusRequest({ repoEpoch, workspaceId, conversationId: '' })
          );
          if (generation !== statusGenerationRef.current || request !== statusRequestRef.current) {
            return; // superseded
          }
          useGolemStore.getState().hydrateStatus(parseGolemStatus(raw));
        } catch (err) {
          if (generation !== statusGenerationRef.current || request !== statusRequestRef.current) {
            return;
          }
          useGolemStore.setState({
            bridgePhase: 'error',
            bridgeError: boundedGolemMessage(err),
          });
        }
      })();
    };

    refreshRef.current = load;
    load();

    return () => {
      statusGenerationRef.current += 1;
      refreshRef.current = NOOP;
    };
  }, [repoEpoch, workspaceId]);
}
