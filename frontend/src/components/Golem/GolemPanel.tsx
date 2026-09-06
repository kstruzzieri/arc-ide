import { useMemo, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDraftStore } from '../../golem/draftStore';
import {
  activeRunOf,
  buildGolemView,
  selectedConversation,
  STATUS_LABEL,
  workspaceName,
} from '../../golem/projection';
import { useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import type { GolemActionResult } from '../../types/golem';
import { focusConfigTab } from '../../utils/editorSurface';
import golemIcon from '../../assets/branding/golem-icon.svg';
import { PlusIcon, SettingsIcon } from '../icons';
import { PanelBarButton, PanelCommandBar } from '../layout/PanelCommandBar';
import { GolemSurface, type GolemSurfaceActions } from './GolemSurface';
import styles from './GolemPanel.module.css';

/**
 * The docked host for the Golem chat (#226 Task B8, #271 Task B4).
 *
 * Two jobs, and only two: the command bar and connection chips that belong to
 * the IDE's panel chrome, and the *adapter* that turns the passive
 * `GolemSurface`'s callbacks into store calls. The chat tree itself lives in
 * `GolemSurface`, which the undocked window renders with the same projection
 * and a relay-backed set of the same callbacks.
 *
 * Composer text is deliberately not store state: it lives in `useDraftStore`,
 * which is per-window, so the executing owner has nothing to project across the
 * window boundary. The host drops a draft only when admission *accepted* it —
 * a refusal keeps what the user typed and says why.
 */

/**
 * The message a refusal shows when the store somehow omitted its reason. The
 * store never does — every `ok: false` path names one — but `reason` is
 * optional in the contract, and silently swallowing a refusal is the one thing
 * this adapter must not do.
 */
const UNEXPLAINED_REFUSAL = 'Golem refused that action.';

const reportRefusal = (result: GolemActionResult): void => {
  if (result.ok) return;
  useIDEStore.getState().showToast(result.reason ?? UNEXPLAINED_REFUSAL, 'error');
};

/**
 * Escape closes the connection disclosure and hands focus back to its summary —
 * the behaviour a dialog-like disclosure owes the keyboard, which `<details>`
 * does not supply on its own.
 */
function closeDetailsOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== 'Escape' || !event.currentTarget.open) return;
  event.preventDefault();
  event.currentTarget.open = false;
  event.currentTarget.querySelector<HTMLElement>('summary')?.focus();
}

interface GolemPanelProps {
  /**
   * The shell's *effective* visibility (#271). Not the saved collapse flag: a
   * saved-open island is still a rail under window pressure, and a hidden mount
   * must neither steal focus nor try to measure itself. Once the satellite
   * window owns the view this is false too, so only one host announces.
   */
  visible: boolean;
  /**
   * The transfer barrier. True only while a docked/undocked handoff is in
   * flight, during which this window is not the owner and may dispatch nothing.
   * B6 supplies it from the window lifecycle; docked-only there is no handoff,
   * so it is absent and the barrier is down.
   */
  frozen?: boolean;
}

export function GolemPanel({ visible, frozen = false }: GolemPanelProps) {
  // The exact slices `buildGolemView` reads, shallow-compared so an unrelated
  // store change does not rebuild the projection. Deliberately NOT
  // `useShallow(buildGolemView)`: the builder makes a fresh nested
  // `conversations` object on every read, which breaks zustand's stable-snapshot
  // expectation and re-renders forever.
  const slices = useGolemStore(
    useShallow((state) => ({
      conversations: state.conversations,
      bridgePhase: state.bridgePhase,
      bridgeError: state.bridgeError,
      hydratedIdentity: state.hydratedIdentity,
      selectedConversationId: state.selectedConversationId,
      composerFocusRevision: state.composerFocusRevision,
    }))
  );
  const view = useMemo(() => buildGolemView(slices), [slices]);

  const conversation = selectedConversation(view);
  const conversationId = conversation?.identity.conversationId ?? null;

  // Subscribed on its own so typing re-renders the composer without rebuilding
  // the whole projection.
  const draft = useDraftStore((state) =>
    conversationId === null ? '' : (state.drafts[conversationId] ?? '')
  );

  // Not manually memoized: the React Compiler keeps this stable on its own, and
  // a hand-written useCallback over `conversationId` defeats its analysis.
  const onDraftChange = (text: string) => {
    if (conversationId === null) return;
    useDraftStore.getState().setDraft(conversationId, text);
  };

  /**
   * The docked adapter. Admission is synchronous here — the store is in this
   * window — so an accepted Send drops the draft in the same tick and a refused
   * one keeps it and explains itself. (B6's satellite holds its lock open until
   * the relay acknowledges instead, and must not run this clearing adapter: an
   * uncertain relay failure has to keep both the draft and the action id.)
   */
  const actions = useMemo<GolemSurfaceActions>(
    () => ({
      send(id, text) {
        const result = useGolemStore.getState().submitTurn(id, text);
        if (result.ok) useDraftStore.getState().clear(id);
        else reportRefusal(result);
      },
      clear(id) {
        const result = useGolemStore.getState().clearConversation(id);
        if (result.ok) useDraftStore.getState().clear(id);
        else reportRefusal(result);
      },
      allowAndSend: (id, runId, challengeId) =>
        reportRefusal(useGolemStore.getState().allowAndSend(id, runId, challengeId)),
      cancelRun: (runId) => reportRefusal(useGolemStore.getState().cancelRun(runId)),
      retry: (id) => reportRefusal(useGolemStore.getState().retryLastFailed(id)),
      updateQueued: (id, queueId, text) =>
        reportRefusal(useGolemStore.getState().updateQueuedTurn(id, queueId, text)),
      removeQueued: (id, queueId) =>
        reportRefusal(useGolemStore.getState().removeQueuedTurn(id, queueId)),
      select: (id) => reportRefusal(useGolemStore.getState().selectConversation(id)),
      openConfig: focusConfigTab,
    }),
    []
  );

  const activeRun = activeRunOf(conversation);
  const statusLabel = activeRun ? STATUS_LABEL[activeRun.phase] : undefined;
  const destination = conversation?.destination ?? null;

  // "New chat" resets the conversation to a fresh idle state. It is blocked
  // while a run is live or a consent is pending — the store refuses the clear
  // there anyway (a live run could re-hydrate a cleared conversation), so a
  // disabled button reads as the honest affordance. It is also pointless with
  // nothing to clear: an empty transcript, no draft in *this* host, and no
  // queued turns.
  const clearBusy =
    conversation !== null &&
    (conversation.activeRunId !== null || conversation.pendingConsentTurn !== null);
  const clearEmpty =
    conversation !== null &&
    conversation.transcript.length === 0 &&
    draft === '' &&
    conversation.queuedTurns.length === 0;
  const canClear = conversation !== null && !frozen && !clearBusy && !clearEmpty;

  return (
    // data-accent pins the whole panel to the glacier accent the way
    // Terminal.tsx does, so Send, focus rings, and the Golem chrome share one
    // accent regardless of the workspace.
    <div className={styles.panel} data-accent="project">
      <div className={styles.chrome}>
        <PanelCommandBar
          panel="golem"
          name="GOLEM"
          tile={
            // The mark doubles as the live indicator: it breathes while a run is
            // active. Decorative — the sr-only status in `meta` carries the state.
            <img
              className={styles.tileIcon}
              src={golemIcon}
              alt=""
              draggable={false}
              data-live={statusLabel ? 'true' : undefined}
            />
          }
          meta={
            statusLabel ? (
              <>
                <span className={styles.liveDot} aria-hidden="true" />
                <span className={styles.srOnly}>{statusLabel}</span>
              </>
            ) : undefined
          }
          controls={
            <>
              <PanelBarButton label="Configuration" onClick={actions.openConfig}>
                <SettingsIcon aria-hidden="true" />
              </PanelBarButton>
              <PanelBarButton
                label="New chat"
                title={clearBusy ? 'Finish or cancel the current run first' : 'New chat'}
                disabled={!canClear}
                onClick={() => {
                  if (frozen || conversationId === null) return;
                  actions.clear(conversationId);
                }}
              >
                <PlusIcon aria-hidden="true" />
              </PanelBarButton>
            </>
          }
          onCollapse={() => useIDEStore.getState().setGolemPanelCollapsed(true)}
        />
        <div className={styles.chipsRow}>
          <span className={styles.workspace}>
            {conversation ? workspaceName(conversation) : 'No workspace'}
          </span>
          {destination && (
            <span className={styles.badge} data-classification={destination.classification}>
              {destination.classification === 'local' ? 'Local' : 'Remote'}
            </span>
          )}
          {!destination && <span className={styles.badge}>Unknown</span>}
          {destination && (
            <span className={styles.modelChip}>
              <span className={styles.provider}>{destination.provider}</span>
              <span aria-hidden="true">·</span>
              <span className={styles.model}>{destination.model}</span>
            </span>
          )}
          {/* D5: the exact endpoint stays reachable — it is the only place the
              machine a prompt would reach is spelled out — but behind a native
              disclosure instead of a permanent third row. Escape closes it and
              returns focus to the summary. */}
          <details className={styles.chipDetails} onKeyDown={closeDetailsOnEscape}>
            <summary className={styles.chipSummary}>Connection</summary>
            <div className={styles.chipDetailsBody}>
              {destination && <span className={styles.endpoint}>{destination.endpoint}</span>}
              <span>Context: prompt only</span>
            </div>
          </details>
        </div>
      </div>

      <GolemSurface
        view={view}
        draft={draft}
        onDraftChange={onDraftChange}
        actions={actions}
        frozen={frozen}
        // Docked admission settles inside the handler, so this host never holds
        // an unacknowledged dispatch open across a render.
        composerPending={false}
        focusRevision={view.composerFocusRevision}
        visible={visible}
      />
    </div>
  );
}
