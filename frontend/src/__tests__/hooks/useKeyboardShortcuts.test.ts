import { renderHook, act } from '@testing-library/react';
import { getPlatform } from '../../utils/platform';
import * as platform from '../../utils/platform';
import { __resetGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import { useSearchStore } from '../../stores/searchStore';

// Mock Wails bindings
const mockOpenFolder = jest.fn();
const mockOpenCommandPalette = jest.fn();
const mockNavigateToEditorLocation = jest.fn();
const mockStartProfile = jest.fn().mockResolvedValue(undefined);
const mockRestartProfile = jest.fn().mockResolvedValue(undefined);
jest.mock('../../wails/bindings', () => ({
  ReadDirectory: jest.fn().mockResolvedValue([]),
  StartRunProfile: (...a: unknown[]) => mockStartProfile(...a),
  RestartRunProfile: (...a: unknown[]) => mockRestartProfile(...a),
  StopRunProfile: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEventsOn = jest.fn<any, [string, () => void]>().mockReturnValue(jest.fn());
jest.mock('../../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
  EventsOn: (event: string, callback: () => void) => mockEventsOn(event, callback),
}));

jest.mock('../../utils/editorNavigation', () => ({
  navigateToEditorLocation: (...args: unknown[]) => mockNavigateToEditorLocation(...args),
}));

import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

const renderShortcutsWith = (openFolder: () => void, openCommandPalette: () => void) =>
  renderHook(() => useKeyboardShortcuts(openFolder, openCommandPalette, false));
const renderShortcuts = () => renderShortcutsWith(mockOpenFolder, mockOpenCommandPalette);

const isMac = getPlatform() === 'mac';

function modifierKeyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey: !isMac,
    metaKey: isMac,
    bubbles: true,
  });
}

function searchShortcutEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: !isMac,
    metaKey: isMac,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
}

function navigationBackEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: isMac ? '[' : 'ArrowLeft',
    code: isMac ? 'BracketLeft' : 'ArrowLeft',
    metaKey: isMac,
    altKey: !isMac,
    bubbles: true,
    cancelable: true,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState(useIDEStore.getInitialState());
});

describe('useKeyboardShortcuts', () => {
  it('should open folder dialog on modifier+O', async () => {
    renderShortcuts();

    await act(async () => {
      window.dispatchEvent(modifierKeyEvent('o'));
    });

    expect(mockOpenFolder).toHaveBeenCalled();
  });

  it('should not trigger on plain "o" key without modifier', async () => {
    renderShortcuts();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'o',
          bubbles: true,
        })
      );
    });

    expect(mockOpenFolder).not.toHaveBeenCalled();
  });

  it('should clean up listener on unmount', async () => {
    const { unmount } = renderShortcuts();
    unmount();

    await act(async () => {
      window.dispatchEvent(modifierKeyEvent('o'));
    });

    expect(mockOpenFolder).not.toHaveBeenCalled();
    expect(mockEventsOn).toHaveBeenCalledWith('navigate:back', expect.any(Function));
    expect(mockEventsOn).toHaveBeenCalledWith('navigate:forward', expect.any(Function));
  });

  it('should navigate back through editor navigation history', async () => {
    renderShortcuts();

    useIDEStore.setState({
      activeFileId: '/current.ts',
      cursorPosition: { line: 9, column: 4 },
      cursorPositions: { '/current.ts': { line: 12, column: 8 } },
    });
    useIDEStore.getState().pushNavigationHistory({
      fileId: '/definition-source.ts',
      line: 3,
      column: 2,
    });

    const event = navigationBackEvent();
    await act(async () => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(mockNavigateToEditorLocation).toHaveBeenCalledWith('/definition-source.ts', 3, 2);
    expect(useIDEStore.getState().navigationForward).toEqual([
      { fileId: '/current.ts', line: 12, column: 8 },
    ]);
  });

  it('should navigate back via Wails native menu event', async () => {
    renderShortcuts();

    useIDEStore.setState({
      activeFileId: '/current.ts',
      cursorPosition: { line: 9, column: 4 },
      cursorPositions: { '/current.ts': { line: 12, column: 8 } },
    });
    useIDEStore.getState().pushNavigationHistory({
      fileId: '/definition-source.ts',
      line: 3,
      column: 2,
    });

    // Find the navigate:back callback that was registered with EventsOn
    const backCall = mockEventsOn.mock.calls.find((call) => call[0] === 'navigate:back');
    const backCallback = backCall?.[1] as (() => void) | undefined;
    expect(backCallback).toBeDefined();

    await act(async () => {
      backCallback!();
    });

    expect(mockNavigateToEditorLocation).toHaveBeenCalledWith('/definition-source.ts', 3, 2);
  });

  describe('search shortcut', () => {
    beforeEach(() => {
      useSearchStore.setState({
        query: '',
        options: { regex: false, caseSensitive: false, wholeWord: false },
        uiState: { kind: 'no-workspace' },
        expandedFiles: new Set<string>(),
        activeRequestId: null,
        focusInputRevision: 0,
      });
    });

    it('switches the sidebar to search and bumps focusInputRevision', async () => {
      useIDEStore.setState({
        activeSidebarView: 'explorer',
        isLeftPanelCollapsed: false,
      });
      renderShortcuts();

      const event = searchShortcutEvent();
      await act(async () => {
        window.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(useIDEStore.getState().activeSidebarView).toBe('search');
      expect(useSearchStore.getState().focusInputRevision).toBe(1);
    });

    it('expands the left panel if it was collapsed', async () => {
      useIDEStore.setState({
        activeSidebarView: 'search',
        isLeftPanelCollapsed: true,
      });
      renderShortcuts();

      await act(async () => {
        window.dispatchEvent(searchShortcutEvent());
      });

      expect(useIDEStore.getState().isLeftPanelCollapsed).toBe(false);
    });

    it('leaves the left panel expanded if already open', async () => {
      useIDEStore.setState({
        activeSidebarView: 'search',
        isLeftPanelCollapsed: false,
      });
      renderShortcuts();

      await act(async () => {
        window.dispatchEvent(searchShortcutEvent());
      });

      expect(useIDEStore.getState().isLeftPanelCollapsed).toBe(false);
      expect(useSearchStore.getState().focusInputRevision).toBe(1);
    });

    it('does not trigger on plain "f" or modifier+F without Shift', async () => {
      renderShortcuts();

      await act(async () => {
        window.dispatchEvent(modifierKeyEvent('f'));
      });
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'f', shiftKey: true, bubbles: true })
        );
      });

      expect(useSearchStore.getState().focusInputRevision).toBe(0);
    });
  });

  it('opens Structure and expands the left panel', async () => {
    useIDEStore.setState({
      activeSidebarView: 'explorer',
      isLeftPanelCollapsed: true,
    });
    renderShortcuts();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Y',
          ctrlKey: !isMac,
          metaKey: isMac,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(useIDEStore.getState().activeSidebarView).toBe('structure');
    expect(useIDEStore.getState().isLeftPanelCollapsed).toBe(false);
  });

  describe.each([
    ['macOS', true],
    ['Windows/Linux', false],
  ] as const)('command palette shortcut on %s', (_platformName, mac) => {
    beforeEach(() => {
      jest.spyOn(platform, 'isMac').mockReturnValue(mac);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('opens once and prevents default for the platform modifier+Shift+P', () => {
      const openCommandPalette = jest.fn();
      renderShortcutsWith(jest.fn(), openCommandPalette);
      const event = new KeyboardEvent('keydown', {
        key: 'P',
        metaKey: mac,
        ctrlKey: !mac,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });

      act(() => {
        window.dispatchEvent(event);
      });

      expect(openCommandPalette).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('ignores incomplete, wrong-platform, extra-modifier, and already-prevented events', () => {
      const openCommandPalette = jest.fn();
      renderShortcutsWith(jest.fn(), openCommandPalette);
      const events = [
        new KeyboardEvent('keydown', { key: 'P', bubbles: true, cancelable: true }),
        new KeyboardEvent('keydown', {
          key: 'P',
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'P',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'P',
          metaKey: !mac,
          ctrlKey: mac,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'P',
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
        new KeyboardEvent('keydown', {
          key: 'P',
          metaKey: mac,
          ctrlKey: !mac,
          shiftKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ];
      const alreadyPrevented = new KeyboardEvent('keydown', {
        key: 'P',
        metaKey: mac,
        ctrlKey: !mac,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      alreadyPrevented.preventDefault();
      events.push(alreadyPrevented);

      act(() => {
        events.forEach((event) => window.dispatchEvent(event));
      });

      expect(openCommandPalette).not.toHaveBeenCalled();
      events.slice(0, -1).forEach((event) => expect(event.defaultPrevented).toBe(false));
    });
  });

  describe.each([
    ['macOS', true],
    ['Windows/Linux', false],
  ] as const)('Golem shortcut on %s', (_platformName, mac) => {
    beforeEach(() => {
      __resetGolemStore();
      jest.spyOn(platform, 'isMac').mockReturnValue(mac);
      useIDEStore.setState({ isRightPanelCollapsed: true });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const golemEvent = (over: KeyboardEventInit = {}) =>
      new KeyboardEvent('keydown', {
        key: 'i',
        metaKey: mac,
        ctrlKey: !mac,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...over,
      });

    it('opens the Golem panel and prevents default for the platform modifier+Shift+I', () => {
      renderShortcuts();
      const event = golemEvent();

      act(() => {
        window.dispatchEvent(event);
      });

      expect(useIDEStore.getState()).toMatchObject({
        centerReveal: 'golem',
        isGolemPanelCollapsed: false,
      });
      // WKWebView and Chromium both claim Cmd/Ctrl+Shift+I for devtools.
      expect(event.defaultPrevented).toBe(true);
    });

    it('accepts the shifted uppercase key the browser actually reports', () => {
      renderShortcuts();

      act(() => {
        window.dispatchEvent(golemEvent({ key: 'I' }));
      });

      expect(useIDEStore.getState()).toMatchObject({
        centerReveal: 'golem',
        isGolemPanelCollapsed: false,
      });
    });

    it('ignores plain I, a missing Shift, an Alt-modified chord, and the other platform modifier', () => {
      renderShortcuts();
      const events = [
        golemEvent({ metaKey: false, ctrlKey: false, shiftKey: false }),
        golemEvent({ shiftKey: false }),
        golemEvent({ altKey: true }),
        golemEvent({ metaKey: !mac, ctrlKey: mac }),
      ];

      act(() => {
        events.forEach((event) => window.dispatchEvent(event));
      });

      expect(useIDEStore.getState()).toMatchObject({
        centerReveal: 'files',
        isGolemPanelCollapsed: true,
      });
      events.forEach((event) => expect(event.defaultPrevented).toBe(false));
    });
  });

  it('should not handle navigation shortcuts that were already handled', async () => {
    renderShortcuts();

    useIDEStore.setState({
      activeFileId: '/current.ts',
      cursorPosition: { line: 9, column: 4 },
      cursorPositions: { '/current.ts': { line: 12, column: 8 } },
    });
    useIDEStore.getState().pushNavigationHistory({
      fileId: '/definition-source.ts',
      line: 3,
      column: 2,
    });

    const event = navigationBackEvent();
    event.preventDefault();
    await act(async () => {
      window.dispatchEvent(event);
    });

    expect(mockNavigateToEditorLocation).not.toHaveBeenCalled();
    expect(useIDEStore.getState().navigationHistory).toEqual([
      { fileId: '/definition-source.ts', line: 3, column: 2 },
    ]);
    expect(useIDEStore.getState().navigationForward).toEqual([]);
  });
});

function runShortcutEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'r',
    ctrlKey: !isMac,
    metaKey: isMac,
    bubbles: true,
    cancelable: true,
  });
}

describe('Cmd/Ctrl+R run target', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useIDEStore.setState({
      runProfiles: [{ id: 'p1', name: 'dev', type: 'single', source: 'user', workspaceId: 'ws1' }],
      runProfileState: {},
      runOutputs: {},
      runInstanceIdsByProfile: {},
      latestRunInstanceIdByProfile: {},
      hiddenProfileIds: [],
      stoppingProfileIds: [],
      restartingProfileIds: [],
      activeWorkspaceId: 'ws1',
      selectedProfileId: 'p1',
    });
  });

  test('starts the target when idle and prevents default (no page reload)', () => {
    renderShortcuts();
    const ev = runShortcutEvent();
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(mockStartProfile).toHaveBeenCalledWith('p1');
    expect(ev.defaultPrevented).toBe(true);
  });

  test('restarts the target when running', () => {
    useIDEStore.setState({
      runOutputs: {
        r1: {
          runInstanceId: 'r1',
          profileId: 'p1',
          state: 'running',
          exitCode: 0,
          entries: [],
        },
      },
      runInstanceIdsByProfile: { p1: ['r1'] },
      latestRunInstanceIdByProfile: { p1: 'r1' },
    });
    renderShortcuts();
    act(() => {
      window.dispatchEvent(runShortcutEvent());
    });
    expect(mockRestartProfile).toHaveBeenCalledWith('p1');
  });

  test('no-op while stopping', () => {
    useIDEStore.setState({ stoppingProfileIds: ['p1'] });
    renderShortcuts();
    act(() => {
      window.dispatchEvent(runShortcutEvent());
    });
    expect(mockStartProfile).not.toHaveBeenCalled();
    expect(mockRestartProfile).not.toHaveBeenCalled();
  });
});
