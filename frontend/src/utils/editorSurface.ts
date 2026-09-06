import { useGitStore, type EditorFocus } from '../stores/gitStore';
import { useGolemStore } from '../stores/golemStore';
import { useIDEStore } from '../stores/ideStore';

/**
 * Every editor surface lives inside the Files column, which #271 lets the user
 * (or window pressure) reduce to a rail. Selecting a surface is therefore also a
 * request to see that column — including when the target is the one already
 * selected, which is why this is a call at the intent, not an observer of a
 * changed id or focus flag (spec §6.3).
 *
 * A workspace restore is the one caller that is not an intent: it reopens the
 * files the session had, and the saved layout, not those files, decides whether
 * Files is a rail.
 */
function revealFiles(): void {
  const state = useIDEStore.getState();
  if (!state.isRestoringWorkspace) state.revealCenterPanel('files');
}

/**
 * Select one of the three git-store-owned editor surfaces (#263 spec §3.1).
 *
 * Editor focus is exclusive, so choosing any of them also retires the app-global
 * Golem configuration tab's focus. It lives here rather than inside
 * `gitStore.setEditorFocus` so the git store never has to know the configuration
 * surface exists — and rather than at each call site, so the two flags cannot
 * drift into disagreeing about which tab is selected.
 */
export function focusEditorSurface(focus: EditorFocus, options: { reveal?: boolean } = {}): void {
  useGitStore.getState().setEditorFocus(focus);
  useGolemStore.getState().setConfigTabFocused(false);
  // `reveal: false` marks the passive synchronization callers — the editor's own
  // active-file effect — which mirror a selection someone else already made.
  if (options.reveal !== false) revealFiles();
}

/**
 * The other direction, and the reason exclusivity has to be bidirectional: the
 * git store's `openDiff`/`openMergeResolution` set `diffFocused`/`mergeFocused`
 * directly, and `openDiff` only ever raises the flag (gitStore
 * `diffFocused: focus ? true : state.diffFocused`). A flag left true while the
 * configuration tab is selected makes the next open a no-op edge, so the diff
 * would swap sessions invisibly behind this surface. Selecting the configuration
 * tab therefore parks the git-side focus back on `file`.
 *
 * Every entry point to the tab — the tab itself, the palette command, and the
 * dock's "Open configuration" — goes through here rather than calling
 * `openConfigTab` directly.
 */
export function focusConfigTab(): void {
  useGolemStore.getState().openConfigTab();
  useGitStore.getState().setEditorFocus('file');
  revealFiles();
}
