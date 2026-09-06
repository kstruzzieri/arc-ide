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
