/**
 * Task B5 — the undocked window's root.
 *
 * Every forbidden module is replaced with one that throws on evaluation, so
 * this file is also the root's runtime import boundary: chrome, chips and chat
 * all load here, and any of them reaching an executing owner, the bridge,
 * workspace persistence, the main shortcut handler or the command palette makes
 * the whole suite fail on import rather than on some later assertion.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMac } from '../../../utils/platform';
import type {
  GolemView,
  GolemWindowState,
  ProjectedConversation,
} from '../../../types/golemWindow';

const FORBIDDEN = [
  '../../../App',
  '../../../stores/golemStore',
  '../../../stores/ideStore',
  '../../../hooks/useGolemBridge',
  '../../../hooks/useKeyboardShortcuts',
  '../../../hooks/useWorkspacePersistence',
  '../../../utils/commands',
  '../../../utils/editorSurface',
  '../../../components/CommandPalette/CommandPalette',
  '../../../components/layout/PanelCommandBar',
] as const;

for (const path of FORBIDDEN) {
  jest.mock(path, () => {
    throw new Error(`GolemWindowRoot must not reach ${path}`);
  });
}

const stopSatellite = jest.fn();
const startSatellite = jest.fn(() => stopSatellite);
const requestReDockMock = jest.fn(() => Promise.resolve());
const retryConnectionMock = jest.fn();
const relayActions = {
  send: jest.fn(),
  allowAndSend: jest.fn(),
  cancelRun: jest.fn(),
  retry: jest.fn(),
  updateQueued: jest.fn(),
  removeQueued: jest.fn(),
  select: jest.fn(),
  clear: jest.fn(),
  openConfig: jest.fn(),
};

jest.mock('../../../golem/windowSatellite', () => ({
  startGolemSatellite: () => startSatellite(),
  // Stable across renders on purpose: the surface memoizes on it.
  satelliteActions: () => relayActions,
  requestReDock: () => requestReDockMock(),
  retryGolemConnection: () => retryConnectionMock(),
}));

import { GolemWindowRoot } from '../../../components/GolemWindow/GolemWindowRoot';
import { useDraftStore } from '../../../golem/draftStore';
import { NO_PENDING_COMPOSERS, useViewStore } from '../../../golem/viewStore';

const identity = (conversationId: string) => ({
  repoEpoch: 7,
  workspaceId: 'frontend',
  conversationId,
});

function conversation(overrides: Partial<ProjectedConversation> = {}): ProjectedConversation {
  return {
    identity: identity('conv-a'),
    workspaceLabel: 'Frontend',
    available: true,
    needsConsent: false,
    warnings: [],
    initError: null,
    destination: null,
    activeRunId: null,
    queuedTurns: [],
    transcript: [],
    runs: {},
    pendingConsentTurn: null,
    lastFailedTurn: false,
    ...overrides,
  };
}

function viewOf(conv: ProjectedConversation = conversation()): GolemView {
  return {
    bridgePhase: 'ready',
    bridgeError: null,
    hydratedIdentity: conv.identity,
    selectedConversationId: conv.identity.conversationId,
    composerFocusRevision: 0,
    processedThrough: 0,
    conversations: { [conv.identity.conversationId]: conv },
  };
}

const readyState: GolemWindowState = {
  mode: 'undocked',
  phase: 'ready',
  instance: 1,
  restorePending: false,
  stateRevision: 3,
  handoff: 1,
};

function install(view: GolemView | null, overrides: Partial<Parameters<typeof set>[0]> = {}) {
  set({ view, state: view === null ? null : readyState, frozen: view === null, ...overrides });
}

const set = (partial: {
  view?: GolemView | null;
  state?: GolemWindowState | null;
  frozen?: boolean;
  pendingComposers?: ReadonlySet<string>;
  error?: string | null;
}) => useViewStore.setState(partial);

/** The platform's own window-command modifier, exactly as the root reads it. */
const PRIMARY: KeyboardEventInit = isMac() ? { metaKey: true } : { ctrlKey: true };

const chord = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
};

beforeEach(() => {
  jest.clearAllMocks();
  useDraftStore.setState({ drafts: {} });
  useViewStore.setState({
    view: null,
    state: null,
    frozen: true,
    pendingComposers: NO_PENDING_COMPOSERS,
    error: null,
  });
});

describe('lifecycle', () => {
  it('starts the satellite on mount and stops it on unmount', () => {
    const { unmount } = render(<GolemWindowRoot />);
    expect(startSatellite).toHaveBeenCalledTimes(1);
    unmount();
    expect(stopSatellite).toHaveBeenCalledTimes(1);
  });

  it('names the window and exposes one Golem region', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    expect(document.title).toBe('Firn — Golem');
    expect(screen.getAllByRole('region', { name: 'Golem' })).toHaveLength(1);
  });

  it('waits with a loading notice until the first projection lands', () => {
    render(<GolemWindowRoot />);
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /message golem/i })).not.toBeInTheDocument();
  });

  it('renders the chat once a projection and a ready phase exist', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    expect(screen.getByRole('textbox', { name: /message golem/i })).toBeEnabled();
  });

  it('shows the failure reason with a retry that reconnects', () => {
    install(viewOf(), { error: 'The main window stopped answering.' });
    render(<GolemWindowRoot />);
    expect(screen.getByRole('alert')).toHaveTextContent('The main window stopped answering.');
    fireEvent.click(screen.getByRole('button', { name: /retry connection/i }));
    expect(retryConnectionMock).toHaveBeenCalledTimes(1);
  });
});

describe('window chrome', () => {
  it('docks back into the main window on demand', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    fireEvent.click(screen.getByRole('button', { name: /dock in main window/i }));
    expect(requestReDockMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a missing destination as Unknown, never as Remote', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Remote')).not.toBeInTheDocument();
    expect(screen.queryByText('Local')).not.toBeInTheDocument();
  });

  it('keeps the endpoint and context reachable from the keyboard', () => {
    install(
      viewOf(
        conversation({
          destination: {
            provider: 'anthropic',
            model: 'claude',
            endpoint: 'https://api.example.test/v1',
            classification: 'remote',
            digest: 'abc',
          },
        })
      )
    );
    render(<GolemWindowRoot />);
    expect(screen.getByText('Remote')).toBeInTheDocument();

    const summary = screen.getByText('Connection');
    fireEvent.click(summary);
    expect(screen.getByText('https://api.example.test/v1')).toBeVisible();
    expect(screen.getByText(/context/i)).toBeVisible();

    // Escape closes the disclosure and hands focus back to its summary.
    fireEvent.keyDown(summary, { key: 'Escape' });
    expect(summary.closest('details')).not.toHaveAttribute('open');
  });

  it('gates New chat on the projected idle state and the local draft', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    // Nothing to clear: no transcript, no queue, no draft.
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();

    act(() => useDraftStore.getState().setDraft('conv-a', 'typed'));
    const newChat = screen.getByRole('button', { name: 'New chat' });
    expect(newChat).toBeEnabled();
    fireEvent.click(newChat);
    expect(relayActions.clear).toHaveBeenCalledWith('conv-a');

    act(() => install(viewOf(conversation({ activeRunId: 'run-1' }))));
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
  });

  it('opens the configuration through the relay, never through the IDE', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
    expect(relayActions.openConfig).toHaveBeenCalledTimes(1);
  });
});

describe('interaction state', () => {
  it('locks only the composer of a conversation awaiting an acknowledgement', () => {
    install(viewOf(), { pendingComposers: new Set(['conv-a']) });
    render(<GolemWindowRoot />);
    expect(screen.getByRole('textbox', { name: /message golem/i })).toBeDisabled();
    // The window itself is still usable: the re-dock must never be trapped.
    expect(screen.getByRole('button', { name: /dock in main window/i })).toBeEnabled();
  });

  it('announces nothing while Go has not made this window ready', () => {
    const conv = conversation({
      transcript: [{ id: 'e1', runId: 'r1', kind: 'assistant', text: 'answered' }],
    });
    install(viewOf(conv), { state: { ...readyState, phase: 'closing' }, frozen: true });
    render(<GolemWindowRoot />);
    // Main is still the visible host during a transition, and two windows must
    // not read the same reply out loud.
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();

    act(() => install(viewOf(conv)));
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});

/**
 * #271 B7 — the same window read through each ownership phase.
 *
 * Ownership is not a boolean here: Go's `phase` says who is allowed to host the
 * conversation, and `handoff` says which transfer attempt a phase belongs to.
 * Every row below drives a real sequence of those snapshots and asks the three
 * questions an assistive technology asks — is there one announcer, where is the
 * focus, and can this be operated — rather than checking a rendered class.
 */
describe('ownership phases', () => {
  const answered = conversation({
    transcript: [{ id: 'e1', runId: 'r1', kind: 'assistant', text: 'answered' }],
    runs: {
      r1: {
        identity: { ...identity('conv-a'), runId: 'r1' },
        phase: 'done',
        lastSeq: 1,
      },
    },
  });
  const announcer = () => document.querySelector('[aria-live="polite"]');
  const composer = () => screen.getByRole('textbox', { name: /message golem/i });
  /** A projection arriving with main's post-`ready` focus bump already on it. */
  const armed = (conv = answered, revision = 1): GolemView => ({
    ...viewOf(conv),
    composerFocusRevision: revision,
  });

  it('stays silent and unfocused until Go makes this window ready', () => {
    install(armed(answered, 0), {
      state: { ...readyState, phase: 'bootstrapping', stateRevision: 1, handoff: 1 },
      frozen: true,
    });
    render(<GolemWindowRoot />);
    expect(announcer()).toBeNull();
    expect(composer()).toBeDisabled();

    // Bootstrapped is still not ready: the drafts have not arrived, so main is
    // the one hosting and the one announcing.
    act(() =>
      install(armed(answered, 0), {
        state: { ...readyState, phase: 'bootstrapped', stateRevision: 2, handoff: 1 },
        frozen: true,
      })
    );
    expect(announcer()).toBeNull();
    expect(document.activeElement).not.toBe(composer());

    // Ready, with the focus revision main bumps once the handoff settles.
    act(() =>
      install(armed(), { state: { ...readyState, stateRevision: 3, handoff: 1 }, frozen: false })
    );
    expect(announcer()).toHaveTextContent('answered');
    expect(composer()).toBeEnabled();
    expect(document.activeElement).toBe(composer());
  });

  it('recovers the host role when a re-dock aborts back to ready', () => {
    install(armed(), { state: { ...readyState, stateRevision: 3, handoff: 1 } });
    render(<GolemWindowRoot />);
    expect(announcer()).toHaveTextContent('answered');

    // A re-dock opens: ownership is in doubt, so this window stops speaking and
    // stops accepting text — but the way back must never be trapped.
    act(() =>
      install(armed(), {
        state: { ...readyState, phase: 'closing', stateRevision: 4, handoff: 2 },
        frozen: true,
      })
    );
    expect(announcer()).toBeNull();
    expect(composer()).toBeDisabled();
    expect(screen.getByRole('button', { name: /dock in main window/i })).toBeEnabled();

    // The transfer aborted: the same handoff returns to ready and this window
    // is the host again, with one announcer and the caret back in the composer.
    // The bumped revision is not fixture convenience — main sends exactly this
    // on a `closing` → `ready` recovery (§5.1); see windowRelay.ts `installState`
    // and its "focuses the satellite composer once when the transition aborts".
    act(() =>
      install(armed(answered, 2), {
        state: { ...readyState, stateRevision: 5, handoff: 2 },
        frozen: false,
      })
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(announcer()).toHaveTextContent('answered');
    expect(document.activeElement).toBe(composer());
  });

  it('hands the conversation over silently on a successful re-dock', () => {
    install(armed(), { state: { ...readyState, stateRevision: 3, handoff: 1 } });
    render(<GolemWindowRoot />);
    composer().blur();

    act(() =>
      install(armed(), {
        state: { ...readyState, phase: 'closing', stateRevision: 6, handoff: 3 },
        frozen: true,
      })
    );
    // Go has confirmed the transfer; main owns the conversation and is about to
    // destroy this window. A projection still in flight must not make the
    // closing window announce a reply main is also about to announce, and must
    // not pull the focus out of the window the user is now looking at.
    act(() =>
      install(armed(answered, 4), {
        state: { ...readyState, phase: 'closed', stateRevision: 7, handoff: 0 },
        frozen: true,
      })
    );
    expect(announcer()).toBeNull();
    expect(document.activeElement).not.toBe(composer());
  });

  it('answers a focus request with a real control when there is no conversation', () => {
    const empty: GolemView = {
      bridgePhase: 'ready',
      bridgeError: null,
      hydratedIdentity: null,
      selectedConversationId: null,
      composerFocusRevision: 0,
      processedThrough: 0,
      conversations: {},
    };
    install(empty, { frozen: false });
    render(<GolemWindowRoot />);
    expect(composer()).toBeDisabled();

    act(() => install({ ...empty, composerFocusRevision: 1 }, { frozen: false }));
    expect(document.activeElement).not.toBe(composer());
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Golem transcript' }));
  });

  it('states a pending approval in words, not only in colour', () => {
    const run = { ...identity('conv-a'), runId: 'r9' };
    const destination = {
      provider: 'anthropic',
      model: 'claude',
      endpoint: 'https://api.example.test/v1',
      classification: 'remote' as const,
      digest: 'digest-remote',
    };
    install(
      viewOf(
        conversation({
          activeRunId: 'r9',
          runs: { r9: { identity: run, phase: 'needs-consent', lastSeq: 0 } },
          pendingConsentTurn: {
            identity: run,
            challenge: {
              id: 'challenge-1',
              identity: run,
              destination,
              destinationDigest: 'digest-remote',
              expiresAt: 0,
            },
          },
        })
      )
    );
    render(<GolemWindowRoot />);

    const approval = screen.getByRole('group', { name: 'Approval required' });
    expect(approval).toHaveTextContent(/approval before this message leaves the machine/i);
    expect(screen.getByRole('button', { name: /allow & send/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /not now/i })).toBeEnabled();
    // The chrome's live status is text beside the mark, never the mark alone.
    expect(screen.getByText('APPROVAL')).toBeInTheDocument();
    expect(announcer()).toHaveTextContent(/needs your approval/i);
  });
});

/**
 * #271 B7 — the chrome rules jsdom cannot observe, asserted against the source.
 *
 * jsdom has no layout and no `prefers-reduced-motion`, and `--wails-draggable`
 * is read by the native shell, not by the DOM. Rendering therefore proves
 * nothing about any of them; the stylesheet is the artifact that has to be
 * right, so the stylesheet is what is read.
 */
describe('window chrome contract', () => {
  const here = (name: string) =>
    readFileSync(resolve(__dirname, '../../../components/GolemWindow', name), 'utf8');
  const css = here('GolemWindowRoot.module.css');
  const panelCss = readFileSync(
    resolve(__dirname, '../../../components/Golem/GolemPanel.module.css'),
    'utf8'
  );
  const barCss = readFileSync(
    resolve(__dirname, '../../../components/layout/PanelCommandBar.module.css'),
    'utf8'
  );
  const block = (source: string, selector: string): string =>
    source
      .slice(source.indexOf(selector))
      .slice(0, source.slice(source.indexOf(selector)).indexOf('}') + 1);

  it('reserves the native titlebar inset and keeps the controls out of the drag region', () => {
    // macOS overlays its traffic lights on a frameless window; the inset is
    // what stops them landing on top of the wordmark.
    expect(block(css, ".titlebar[data-traffic-lights='true']")).toContain('padding-left: 78px');
    // The bar drags the window, and every interactive thing on it opts out —
    // a control inside a drag region swallows the click as a drag.
    expect(block(css, '.titlebar {')).toContain('--wails-draggable: drag');
    const noDrag = block(css, '.titlebar button');
    expect(noDrag).toContain('--wails-draggable: no-drag');
    for (const selector of ['.titlebar a', ".titlebar [role='button']", '.chips', '.error']) {
      expect(noDrag).toContain(selector);
    }
  });

  it('lets the identity yield so the controls survive Go 380px floor', () => {
    // golemWindowMinWidth in app_golem_window.go. At that width only the
    // wordmark can give, so it must be able to shrink AND be clipped.
    expect(block(css, '.wordmark {')).toContain('min-width: 0');
    expect(block(css, '.wordmark {')).toContain('overflow: hidden');
    // The three controls are fixed-size and never wrap onto a second row.
    expect(block(barCss, '.controls {')).toContain('flex: none');
    expect(block(css, '.dock {')).toContain('flex: none');
    expect(block(css, '.dock {')).toContain('white-space: nowrap');
  });

  it('honours reduced motion for every animated thing this window draws', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    // The window's only transition of its own.
    expect(reduced).toContain('.dock');
    // Everything else it animates is Plan A's, reused rather than re-declared,
    // so Plan A's rule is what has to cover it.
    const panelReduced = panelCss.slice(
      panelCss.indexOf('@media (prefers-reduced-motion: reduce)')
    );
    expect(panelReduced).toContain(".tileIcon[data-live='true']");
    expect(panelReduced).toContain('.liveDot');
    expect(barCss.slice(barCss.indexOf('@media (prefers-reduced-motion: reduce)'))).toContain(
      '.control'
    );
  });
});

describe('scoped shortcuts', () => {
  it('requests the re-dock on the native close chord', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    const event = chord('w', PRIMARY);
    expect(event.defaultPrevented).toBe(true);
    expect(requestReDockMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses every reload chord', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    expect(chord('r', PRIMARY).defaultPrevented).toBe(true);
    expect(chord('R', { ...PRIMARY, shiftKey: true }).defaultPrevented).toBe(true);
    expect(chord('F5').defaultPrevented).toBe(true);
    expect(chord('F5', { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it('re-selects the focused conversation to bump the composer focus', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    expect(chord('I', { ...PRIMARY, shiftKey: true }).defaultPrevented).toBe(true);
    expect(relayActions.select).toHaveBeenCalledWith('conv-a');
  });

  it('does nothing on the focus chord with no selected conversation', () => {
    install({ ...viewOf(), selectedConversationId: null });
    render(<GolemWindowRoot />);
    chord('I', { ...PRIMARY, shiftKey: true });
    expect(relayActions.select).not.toHaveBeenCalled();
  });

  it('leaves unrelated chords to the platform', () => {
    install(viewOf());
    render(<GolemWindowRoot />);
    // The window-command modifier is not a licence to swallow everything under
    // it: copy, and the other window's close modifier, both pass through.
    expect(chord('c', PRIMARY).defaultPrevented).toBe(false);
    expect(chord('w', isMac() ? { ctrlKey: true } : { metaKey: true }).defaultPrevented).toBe(
      false
    );
    expect(chord('w').defaultPrevented).toBe(false);
    expect(requestReDockMock).not.toHaveBeenCalled();
  });
});
