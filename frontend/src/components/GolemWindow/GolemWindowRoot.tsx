import { useEffect, type KeyboardEvent } from 'react';
import golemIcon from '../../assets/branding/golem-icon.svg';
import { useDraftStore } from '../../golem/draftStore';
import {
  activeRunOf,
  selectedConversation,
  STATUS_LABEL,
  workspaceName,
} from '../../golem/projection';
import { useViewStore } from '../../golem/viewStore';
import {
  requestReDock,
  retryGolemConnection,
  satelliteActions,
  startGolemSatellite,
} from '../../golem/windowSatellite';
import { retryChangesNothing } from '../../types/golemWindow';
import { isMac } from '../../utils/platform';
import { GolemSurface } from '../Golem/GolemSurface';
import { PlusIcon, SettingsIcon } from '../icons';
import panelStyles from '../Golem/GolemPanel.module.css';
import barStyles from '../layout/PanelCommandBar.module.css';
import styles from './GolemWindowRoot.module.css';

/**
 * The root of the undocked Golem window (#271 spec §5.3).
 *
 * It renders the same `GolemSurface` the docked panel does, over a projection
 * that arrived across the relay, and it owns nothing else: no conversation
 * state, no bridge, no workspace persistence, no command palette, and no path
 * to the IDE's stores — not even transitively. `GolemWindowRoot.test.tsx`
 * poisons every one of those modules and mounts this tree, so the boundary is
 * checked at runtime rather than trusted to the imports written above.
 *
 * Everything the window can change goes out through `satelliteActions()`, which
 * posts an action and waits for main to admit or refuse it. Nothing here
 * assumes an action succeeded.
 */

const WINDOW_TITLE = 'Firn — Golem';
const CONNECTING = 'Connecting to the main window…';
const BUSY_HINT = 'Finish or cancel the current run first';
const RETRY_WAIT_HINT = 'Waiting for the main window to give up the transfer';

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

/** The platform's window-close / reload chords, and nothing adjacent to them. */
function isPrimaryModifier(event: globalThis.KeyboardEvent): boolean {
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function GolemWindowRoot() {
  const view = useViewStore((state) => state.view);
  const windowState = useViewStore((state) => state.state);
  const frozen = useViewStore((state) => state.frozen);
  const pendingComposers = useViewStore((state) => state.pendingComposers);
  const error = useViewStore((state) => state.error);

  // The relay is started here and only here: one subscription pair, one core,
  // torn down on unmount so StrictMode's second mount owns a clean one.
  useEffect(() => startGolemSatellite(), []);

  useEffect(() => {
    document.title = WINDOW_TITLE;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // A reload would throw away the draft map main handed over and leave Go
      // waiting on a `ready` that can never come. There is no reload here.
      if (event.key === 'F5' || (isPrimaryModifier(event) && event.key.toLowerCase() === 'r')) {
        event.preventDefault();
        return;
      }
      if (!isPrimaryModifier(event)) return;
      if (!event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        void requestReDock();
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        // Selecting the already-selected conversation is what bumps main's
        // composer focus revision; with nothing selected there is nothing to
        // focus, and inventing an id would select somebody else's chat.
        const selected = useViewStore.getState().view?.selectedConversationId;
        if (selected) satelliteActions().select(selected);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const actions = satelliteActions();
  const conversation = view === null ? null : selectedConversation(view);
  const conversationId = conversation?.identity.conversationId ?? null;

  const draft = useDraftStore((state) =>
    conversationId === null ? '' : (state.drafts[conversationId] ?? '')
  );
  const onDraftChange = (text: string) => {
    if (conversationId === null) return;
    useDraftStore.getState().setDraft(conversationId, text);
  };

  const activeRun = activeRunOf(conversation);
  const statusLabel = activeRun ? STATUS_LABEL[activeRun.phase] : undefined;
  const destination = conversation?.destination ?? null;

  // Only Go's own `ready` makes this window the visible host. While it is
  // bootstrapping or closing, main is still the one announcing.
  const visible = windowState?.phase === 'ready';
  const canRetry = !retryChangesNothing(windowState);
  const composerPending = conversationId !== null && pendingComposers.has(conversationId);

  const clearBusy =
    conversation !== null &&
    (conversation.activeRunId !== null || conversation.pendingConsentTurn !== null);
  const clearEmpty =
    conversation !== null &&
    conversation.transcript.length === 0 &&
    draft === '' &&
    conversation.queuedTurns.length === 0;
  const canClear =
    conversation !== null && !frozen && !composerPending && !clearBusy && !clearEmpty;

  return (
    // data-accent pins the window to the glacier accent the docked panel uses,
    // so the two hosts of the same conversation never differ in hue.
    <div className={styles.window} data-accent="project">
      <header className={styles.titlebar} data-traffic-lights={isMac() ? 'true' : undefined}>
        <span className={styles.wordmark}>
          {/* The mark doubles as the live indicator. Decorative — the sr-only
              status beside it carries the state. */}
          <img
            className={panelStyles.tileIcon}
            src={golemIcon}
            alt=""
            draggable={false}
            data-live={statusLabel ? 'true' : undefined}
          />
          <span className={styles.name}>GOLEM</span>
          {statusLabel && (
            <>
              <span className={panelStyles.liveDot} aria-hidden="true" />
              <span className={panelStyles.srOnly}>{statusLabel}</span>
            </>
          )}
        </span>
        <div className={barStyles.controls}>
          <button
            type="button"
            className={barStyles.control}
            aria-label="Configuration"
            title="Configuration"
            onClick={actions.openConfig}
          >
            <SettingsIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            className={barStyles.control}
            aria-label="New chat"
            title={clearBusy ? BUSY_HINT : 'New chat'}
            disabled={!canClear}
            onClick={() => {
              if (!canClear || conversationId === null) return;
              actions.clear(conversationId);
            }}
          >
            <PlusIcon aria-hidden="true" />
          </button>
          {/* The chord is not discoverable; this button is. */}
          <button type="button" className={styles.dock} onClick={() => void requestReDock()}>
            Dock in main window
          </button>
        </div>
      </header>

      <div className={`${panelStyles.chipsRow} ${styles.chips}`}>
        <span className={panelStyles.workspace}>
          {conversation ? workspaceName(conversation) : 'No workspace'}
        </span>
        {/* Three states, not two: a projection with no destination knows
            nothing about where a prompt would go, and saying "Remote" there
            would be a guess about the one thing that must not be guessed. */}
        {destination ? (
          <span className={panelStyles.badge} data-classification={destination.classification}>
            {destination.classification === 'local' ? 'Local' : 'Remote'}
          </span>
        ) : (
          <span className={panelStyles.badge}>Unknown</span>
        )}
        {destination && (
          <span className={panelStyles.modelChip}>
            <span className={panelStyles.provider}>{destination.provider}</span>
            <span aria-hidden="true">·</span>
            <span className={panelStyles.model}>{destination.model}</span>
          </span>
        )}
        <details className={panelStyles.chipDetails} onKeyDown={closeDetailsOnEscape}>
          <summary className={panelStyles.chipSummary}>Connection</summary>
          <div className={panelStyles.chipDetailsBody}>
            {destination && <span className={panelStyles.endpoint}>{destination.endpoint}</span>}
            <span>Context: prompt only</span>
          </div>
        </details>
      </div>

      {error !== null && (
        <p className={styles.error} role="alert">
          <span className={styles.reason}>{error}</span>
          {/* Retry is a deliberate no-op while Go still believes the transfer is
              running; a live button there reads as broken. Say why instead. */}
          <button
            type="button"
            className={styles.retry}
            title={canRetry ? 'Retry connection' : RETRY_WAIT_HINT}
            disabled={!canRetry}
            onClick={retryGolemConnection}
          >
            Retry connection
          </button>
        </p>
      )}

      <div className={`${panelStyles.panel} ${styles.body}`} role="region" aria-label="Golem">
        {view === null ? (
          <p className={styles.loading}>{CONNECTING}</p>
        ) : (
          <GolemSurface
            view={view}
            draft={draft}
            onDraftChange={onDraftChange}
            actions={actions}
            frozen={frozen}
            composerPending={composerPending}
            focusRevision={view.composerFocusRevision}
            visible={visible}
          />
        )}
      </div>
    </div>
  );
}
