import { useEffect, useLayoutEffect, useRef } from 'react';
import { isMac } from '../utils/platform';
import { useIDEStore } from '../stores/ideStore';
import { EventsOn } from '../wails/runtime';
import {
  navigateBack,
  navigateForward,
  runOrRestartSelectedProfile,
  showGolem,
  showSidebarView,
} from '../utils/commands';

/**
 * Registers global keyboard shortcuts for the IDE.
 * Call this hook exactly ONCE at the app level (e.g., in IDEShell).
 *
 * On macOS, Cmd+[ / Cmd+] are intercepted by WKWebView for browser
 * back/forward navigation before JavaScript can handle them. The app
 * registers native Wails menu items with these accelerators, which emit
 * "navigate:back" / "navigate:forward" events to the frontend. Both
 * the native events and the JS keydown handler call the same nav functions.
 */
export function useKeyboardShortcuts(
  openFolder: () => void,
  openCommandPalette: () => void,
  isCommandPaletteOpen: boolean
) {
  const commandPaletteOpenRef = useRef(isCommandPaletteOpen);
  useLayoutEffect(() => {
    commandPaletteOpenRef.current = isCommandPaletteOpen;
  }, [isCommandPaletteOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const mac = isMac();
      const modifier = mac ? e.metaKey : e.ctrlKey;

      // Cmd+O / Ctrl+O — Open folder
      if (modifier && e.key === 'o') {
        e.preventDefault();
        openFolder();
        return;
      }

      const exactPaletteModifier = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (exactPaletteModifier && e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        openCommandPalette();
        return;
      }

      // Cmd+R / Ctrl+R — run (or restart) the selected run-profile target.
      // preventDefault is essential: WKWebView treats Cmd+R as page reload.
      if (modifier && (e.key === 'r' || e.key === 'R') && !e.shiftKey) {
        e.preventDefault();
        runOrRestartSelectedProfile();
        return;
      }

      // One shape for every platform-modifier+Shift chord below. Alt is
      // excluded: Alt makes a different chord, not a sloppier spelling of this
      // one, and the OS or the webview may already own it.
      const chordModifier = modifier && e.shiftKey && !e.altKey;

      // Cmd+Shift+F / Ctrl+Shift+F — Workspace search.
      if (chordModifier && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        showSidebarView('search');
        return;
      }

      // Cmd+Shift+I / Ctrl+Shift+I — Golem chat.
      // preventDefault is essential: both WKWebView and Chromium claim this
      // chord for developer tools.
      if (chordModifier && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        showGolem();
        return;
      }

      // Cmd+Shift+Y / Ctrl+Shift+Y — Structure (current-file outline).
      if (chordModifier && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        showSidebarView('structure');
        return;
      }

      // Cmd+[ / Cmd+] on macOS, Alt+Left / Alt+Right elsewhere — editor navigation history.
      // On macOS these may also arrive via Wails native menu events (navigate:back/forward)
      // because WKWebView sometimes intercepts Cmd+[/Cmd+] before JavaScript can handle them.
      const isBack = mac
        ? e.metaKey && (e.key === '[' || e.code === 'BracketLeft')
        : e.altKey && e.key === 'ArrowLeft';
      const isForward = mac
        ? e.metaKey && (e.key === ']' || e.code === 'BracketRight')
        : e.altKey && e.key === 'ArrowRight';

      if (isBack || isForward) {
        const state = useIDEStore.getState();
        const hasTarget = isBack
          ? state.navigationHistory.length > 0
          : state.navigationForward.length > 0;
        if (!state.activeFileId || !hasTarget) return;

        e.preventDefault();
        if (isBack) navigateBack();
        else navigateForward();
        return;
      }
    };

    // Native menu events from Wails (needed on macOS where WKWebView
    // may intercept Cmd+[ / Cmd+] for browser navigation).
    const cancelBack = EventsOn('navigate:back', () => {
      if (!commandPaletteOpenRef.current) navigateBack();
    });
    const cancelForward = EventsOn('navigate:forward', () => {
      if (!commandPaletteOpenRef.current) navigateForward();
    });

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      cancelBack();
      cancelForward();
    };
  }, [openFolder, openCommandPalette]);
}
