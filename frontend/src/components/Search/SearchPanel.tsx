import {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LanguageSupport } from '@codemirror/language';
import { ChevronDownIcon, ChevronRightIcon } from '../icons';
import { useIDEStore } from '../../stores/ideStore';
import { useSearchStore } from '../../stores/searchStore';
import type { FileResult, LineMatch, SearchUIState } from '../../types/search';
import { byteColumnToCharColumn } from '../../utils/searchRanges';
import {
  buildLineRenderModel,
  MAX_SEARCH_HIGHLIGHTED_ROWS,
  parseLineTokens,
  syntaxPaletteVars,
  type LineRenderPart,
} from '../../utils/searchTokens';
import { navigateToEditorLocation } from '../../utils/editorNavigation';
import { useSearchSyntaxSupports } from '../../hooks/useSearchSyntaxSupports';
import styles from './SearchPanel.module.css';

// Search durations span microseconds (cached) to multi-second (cold ripgrep
// over a large repo). formatDuration() in utils is for run-profile timers and
// rounds anything under a second to "0s", so we use a search-tuned formatter.
function formatSearchDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

interface FileItem {
  kind: 'file';
  index: number;
  file: FileResult;
  expanded: boolean;
}

interface MatchItem {
  kind: 'match';
  index: number;
  file: FileResult;
  match: LineMatch;
  syntaxEligible: boolean;
}

type FlatItem = FileItem | MatchItem;

function buildFlatItems(files: FileResult[], expandedFiles: Set<string>): FlatItem[] {
  const items: FlatItem[] = [];
  let syntaxMatchCount = 0;
  for (const file of files) {
    const expanded = expandedFiles.has(file.path);
    items.push({ kind: 'file', index: items.length, file, expanded });
    if (expanded) {
      for (const match of file.matches) {
        items.push({
          kind: 'match',
          index: items.length,
          file,
          match,
          syntaxEligible: syntaxMatchCount < MAX_SEARCH_HIGHLIGHTED_ROWS,
        });
        syntaxMatchCount++;
      }
    }
  }
  return items;
}

// Split a relativePath into "filename" and "leading directory" segments for
// header rendering. The backend (`internal/search/parser.go` →
// `toRelativeForwardSlash` / `filepath.ToSlash`) always normalizes paths to
// forward slashes regardless of OS, so this never has to handle backslashes;
// do not call with native Windows paths.
function splitFilePath(relativePath: string): { name: string; dir: string } {
  const idx = relativePath.lastIndexOf('/');
  if (idx === -1) return { name: relativePath, dir: '' };
  return { name: relativePath.slice(idx + 1), dir: relativePath.slice(0, idx) };
}

interface MatchLineProps {
  match: LineMatch;
  support: LanguageSupport | null;
}

// U+200E (left-to-right mark). The leading-context span is laid out with
// direction: rtl so it ellipsizes on the LEFT (keeping the text nearest the
// match visible — same trick as .fileDir). A trailing space would otherwise
// "hang" outside the rtl line box and vanish; terminating the run with an LRM
// keeps it inside. Appended only when the lead ends in preserved whitespace,
// so DOM text otherwise matches the source line exactly (post-trim).
// See .contextLead in SearchPanel.module.css.
const LRM = '‎';

// Token pieces render as inner spans carrying only the raw tok-<role> class
// (colored by the scoped :global CSS in the module stylesheet); plain gaps render
// as bare text nodes so uncolored runs add no extra elements.
const MatchLine = memo(function MatchLine({ match, support }: MatchLineProps) {
  const parts = useMemo<LineRenderPart[]>(() => {
    const tokens = support ? parseLineTokens(match.text, support) : null;
    return buildLineRenderModel(match.text, match.submatches, tokens ?? []);
  }, [match.text, match.submatches, support]);

  return (
    <span className={styles.lineText}>
      {parts.map((part, i) => {
        if (part.kind === 'match') {
          return (
            <mark key={i} className={styles.match}>
              {part.text}
            </mark>
          );
        }
        const children = part.pieces.map((piece, j) =>
          piece.className ? (
            <span key={j} className={piece.className}>
              {piece.text}
            </span>
          ) : (
            piece.text
          )
        );
        if (part.isLead) {
          const leadText = part.pieces.map((p) => p.text).join('');
          return (
            <span key={i} className={`${styles.context} ${styles.contextLead}`}>
              <bdi dir="ltr">
                {children}
                {/[ \t]$/.test(leadText) ? LRM : null}
              </bdi>
            </span>
          );
        }
        return (
          <span key={i} className={styles.context}>
            {children}
          </span>
        );
      })}
    </span>
  );
});

interface FileGroupProps {
  item: FileItem;
  focused: boolean;
  tabbable: boolean;
  itemRef: (el: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onFocus: () => void;
}

function FileGroupHeader({ item, focused, tabbable, itemRef, onToggle, onFocus }: FileGroupProps) {
  const { name, dir } = splitFilePath(item.file.relativePath);
  const ChevIcon = item.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      ref={itemRef}
      type="button"
      className={`${styles.fileHeader} ${focused ? styles.focused : ''}`}
      onClick={onToggle}
      onFocus={onFocus}
      tabIndex={tabbable ? 0 : -1}
      aria-expanded={item.expanded}
      aria-label={`${item.file.relativePath} (${item.file.matches.length} ${
        item.file.matches.length === 1 ? 'match' : 'matches'
      })`}
      title={item.file.relativePath}
    >
      <span className={styles.chevron} aria-hidden="true">
        <ChevIcon />
      </span>
      <span className={styles.filePath}>
        <span className={styles.fileName}>{name}</span>
        {/* <bdi> isolates the directory string from any surrounding bidi
            context. With direction:rtl on .fileDir the *layout* is
            right-anchored (so we ellipsize the start, keeping the deepest
            segment visible), but the slashes are bidi-neutral and could
            otherwise re-order on systems with mixed scripts. <bdi> +
            unicode-bidi: isolate keeps slash order stable. The dir="ltr"
            attribute must live on a CHILD of the rtl-styled element, not the
            element itself: author CSS `direction` overrides the attribute's
            presentational hint, so pinning both on one node lets the CSS win
            and re-orders mixed-script segments anyway. */}
        {dir && (
          <span className={styles.fileDir}>
            <bdi dir="ltr">{dir}</bdi>
          </span>
        )}
      </span>
      <span className={styles.matchCount} aria-hidden="true">
        {item.file.matches.length}
      </span>
    </button>
  );
}

interface ResultRowProps {
  item: MatchItem;
  focused: boolean;
  tabbable: boolean;
  itemRef: (el: HTMLButtonElement | null) => void;
  onActivate: () => void;
  onFocus: () => void;
  support: LanguageSupport | null;
}

// ripgrep runs without --max-columns (parser.go buffers up to 16MB/line), so a
// match in a minified file can be megabytes long. The tooltip and accessible
// name carry no value past a few hundred characters — cap them so we don't
// attach multi-MB strings to every row (the visual row already ellipsizes).
const ROW_LABEL_MAX = 300;

function ResultRow({
  item,
  focused,
  tabbable,
  itemRef,
  onActivate,
  onFocus,
  support,
}: ResultRowProps) {
  const trimmed = item.match.text.trim();
  const lineText = trimmed.length > ROW_LABEL_MAX ? `${trimmed.slice(0, ROW_LABEL_MAX)}…` : trimmed;
  return (
    <button
      ref={itemRef}
      type="button"
      className={`${styles.resultRow} ${focused ? styles.focused : ''}`}
      onClick={onActivate}
      onFocus={onFocus}
      tabIndex={tabbable ? 0 : -1}
      aria-label={`Line ${item.match.line} in ${item.file.relativePath}: ${lineText}`}
      title={lineText}
    >
      <span className={styles.lineNumber} aria-hidden="true">
        {item.match.line}
      </span>
      <MatchLine match={item.match} support={support} />
    </button>
  );
}

function describeMatchSummary(state: Extract<SearchUIState, { kind: 'results' }>): string {
  const fileWord = state.totalFiles === 1 ? 'file' : 'files';
  const lineWord = state.totalLines === 1 ? 'match' : 'matches';
  return `${state.totalLines} ${lineWord} in ${state.totalFiles} ${fileWord}`;
}

export function SearchPanel() {
  const query = useSearchStore((s) => s.query);
  const options = useSearchStore((s) => s.options);
  const uiState = useSearchStore((s) => s.uiState);
  const expandedFiles = useSearchStore((s) => s.expandedFiles);
  const focusInputRevision = useSearchStore((s) => s.focusInputRevision);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setOption = useSearchStore((s) => s.setOption);
  const toggleFileExpanded = useSearchStore((s) => s.toggleFileExpanded);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsScrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const [focusedItemIndex, setFocusedItemIndex] = useState<number | null>(null);

  // Focus the input on every focusInputRevision bump (and on initial mount,
  // since useEffect always runs once on mount regardless of dep value).
  // Caveat: in dev StrictMode / hot reload, an incidental SearchPanel
  // re-mount will also re-focus the input even if the user didn't request
  // it. Acceptable trade-off: in production, panel mounts only happen on
  // user-initiated transitions (sidebar view change, panel expand) where
  // focusing the input is the desired behavior.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusInputRevision]);

  const flatItems = useMemo(() => {
    if (uiState.kind !== 'results') return [];
    return buildFlatItems(uiState.files, expandedFiles);
  }, [uiState, expandedFiles]);

  const editorSyntaxTheme = useIDEStore((s) => s.editorSyntaxTheme);
  const paletteVars = useMemo(() => syntaxPaletteVars(editorSyntaxTheme), [editorSyntaxTheme]);

  // Distinct relativePaths of currently visible (expanded) match rows.
  const visibleFilenames = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of flatItems) {
      if (item.kind === 'match' && item.syntaxEligible && !seen.has(item.file.relativePath)) {
        seen.add(item.file.relativePath);
        out.push(item.file.relativePath);
      }
    }
    return out;
  }, [flatItems]);

  const supports = useSearchSyntaxSupports(visibleFilenames);

  // Restore keyboard focus when results refresh.
  //
  // Two cases:
  //  1. The focused index is now out of range (results shrank). Drop the
  //     stale index and pull focus back to the input — otherwise the
  //     unmounted button leaves focus on document.body where the input/list
  //     keydown listeners can't fire, stranding keyboard nav.
  //  2. The index is still in range but the array identity changed (results
  //     refreshed with the same shape, e.g. a re-search that produced the
  //     same files). The button at that index is a fresh DOM node and the
  //     previous one unmounted, so document.activeElement reverted to body.
  //     Re-focus the new button at the same index.
  //
  // setState-in-effect lint is suppressed for case (1): flatItems is derived
  // from an async store refresh that can't be observed via pure render-time
  // derivation, which is the documented exception for this rule.
  useEffect(() => {
    if (focusedItemIndex === null) return;
    if (focusedItemIndex >= flatItems.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFocusedItemIndex(null);
      inputRef.current?.focus();
      return;
    }
    const el = itemRefs.current.get(focusedItemIndex);
    if (el && document.activeElement !== el) {
      el.focus();
    }
  }, [flatItems, focusedItemIndex]);

  const focusItem = useCallback((index: number) => {
    if (index === 0 && resultsScrollRef.current) resultsScrollRef.current.scrollTop = 0;
    setFocusedItemIndex(index);
    const el = itemRefs.current.get(index);
    el?.focus();
  }, []);

  const handleQueryChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
    },
    [setQuery]
  );

  const handleClearQuery = useCallback(() => {
    setQuery('');
    inputRef.current?.focus();
  }, [setQuery]);

  const handleInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' && flatItems.length > 0) {
        e.preventDefault();
        focusItem(0);
      } else if (e.key === 'Escape' && query) {
        e.preventDefault();
        setQuery('');
      }
    },
    [flatItems.length, focusItem, query, setQuery]
  );

  const activateMatch = useCallback(async (file: FileResult, match: LineMatch) => {
    // Capture the workspace at click time. If the user switches workspaces
    // before the file read resolves, bail rather than open a file from the
    // old workspace into the new one (otherwise navigateToEditorLocation
    // would open it as a tab outside the active workspace's scope).
    const workspaceAtClick = useIDEStore.getState().workspace?.path ?? null;
    if (!workspaceAtClick) return;
    const isSameWorkspace = () => useIDEStore.getState().workspace?.path === workspaceAtClick;

    const charColumn = byteColumnToCharColumn(match.text, match.column);
    if (!isSameWorkspace()) return;

    await navigateToEditorLocation(file.path, match.line, charColumn, {
      shouldApply: isSameWorkspace,
    });
  }, []);

  const handleListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (focusedItemIndex === null || flatItems.length === 0) return;
      const item = flatItems[focusedItemIndex];
      // Stale index belongs to results that have already refreshed; the
      // restoration effect above will re-focus the input on the next render
      // tick. Bail out here so we don't act on a phantom item.
      if (!item) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = Math.min(flatItems.length - 1, focusedItemIndex + 1);
          focusItem(next);
          return;
        }
        case 'ArrowUp': {
          e.preventDefault();
          if (focusedItemIndex === 0) {
            inputRef.current?.focus();
            setFocusedItemIndex(null);
          } else {
            focusItem(focusedItemIndex - 1);
          }
          return;
        }
        case 'ArrowLeft': {
          // Tree convention:
          //   - Expanded file → collapse it.
          //   - Collapsed file → move focus to parent (here: the input).
          //   - Match row → move focus to its parent file header.
          e.preventDefault();
          if (item.kind === 'file' && item.expanded) {
            toggleFileExpanded(item.file.path);
          } else if (item.kind === 'file' && !item.expanded) {
            inputRef.current?.focus();
            setFocusedItemIndex(null);
          } else if (item.kind === 'match') {
            // Walk back to the nearest preceding file header.
            for (let i = focusedItemIndex - 1; i >= 0; i--) {
              if (flatItems[i].kind === 'file') {
                focusItem(i);
                return;
              }
            }
          }
          return;
        }
        case 'ArrowRight': {
          if (item.kind === 'file' && !item.expanded) {
            e.preventDefault();
            toggleFileExpanded(item.file.path);
          }
          return;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (item.kind === 'file') {
            toggleFileExpanded(item.file.path);
          } else {
            void activateMatch(item.file, item.match);
          }
          return;
        }
        case 'Home': {
          e.preventDefault();
          focusItem(0);
          return;
        }
        case 'End': {
          e.preventDefault();
          focusItem(flatItems.length - 1);
          return;
        }
      }
    },
    [activateMatch, flatItems, focusItem, focusedItemIndex, toggleFileExpanded]
  );

  const setItemRef = useCallback(
    (index: number) => (el: HTMLButtonElement | null) => {
      if (el) {
        itemRefs.current.set(index, el);
      } else {
        itemRefs.current.delete(index);
      }
    },
    []
  );

  const isInvalidRegex = uiState.kind === 'invalid-regex';

  return (
    <div
      className={styles.container}
      role="region"
      aria-label="Workspace search"
      style={paletteVars}
    >
      <div className={styles.controls}>
        <div className={styles.inputWrapper}>
          <input
            ref={inputRef}
            type="text"
            className={`${styles.input} ${isInvalidRegex ? styles.invalid : ''}`}
            placeholder="Search workspace…"
            aria-label="Search query"
            aria-invalid={isInvalidRegex}
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleInputKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query && (
            <button
              type="button"
              className={styles.clearButton}
              onClick={handleClearQuery}
              aria-label="Clear search"
              title="Clear search (Esc)"
            >
              ×
            </button>
          )}
        </div>
        <div className={styles.options} role="group" aria-label="Search options">
          <button
            type="button"
            className={styles.optionToggle}
            aria-pressed={options.caseSensitive}
            aria-label="Match case"
            title="Match case"
            onClick={() => setOption('caseSensitive', !options.caseSensitive)}
          >
            Aa
          </button>
          <button
            type="button"
            className={styles.optionToggle}
            aria-pressed={options.wholeWord}
            aria-label="Match whole word"
            title="Match whole word"
            onClick={() => setOption('wholeWord', !options.wholeWord)}
          >
            ab|
          </button>
          <button
            type="button"
            className={styles.optionToggle}
            aria-pressed={options.regex}
            aria-label="Use regular expression"
            title="Use regular expression"
            onClick={() => setOption('regex', !options.regex)}
          >
            .*
          </button>
        </div>
      </div>

      <PanelBody
        uiState={uiState}
        flatItems={flatItems}
        resultsScrollRef={resultsScrollRef}
        focusedItemIndex={focusedItemIndex}
        // Default the keyboard-tabbable position to item 0 when no row is
        // focused, so a Tab-only user can reach the result list via Tab
        // from the option toggles. Without this, the roving tabindex
        // pattern (only the focused row gets tabIndex=0) would skip the
        // entire results region until the user presses ArrowDown first.
        tabbableIndex={focusedItemIndex ?? 0}
        setItemRef={setItemRef}
        onListKeyDown={handleListKeyDown}
        onToggleFile={toggleFileExpanded}
        onActivateMatch={activateMatch}
        onItemFocus={setFocusedItemIndex}
        supports={supports}
      />
    </div>
  );
}

interface PanelBodyProps {
  uiState: SearchUIState;
  flatItems: FlatItem[];
  resultsScrollRef: RefObject<HTMLDivElement | null>;
  focusedItemIndex: number | null;
  tabbableIndex: number;
  setItemRef: (index: number) => (el: HTMLButtonElement | null) => void;
  onListKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onToggleFile: (path: string) => void;
  onActivateMatch: (file: FileResult, match: LineMatch) => void;
  onItemFocus: (index: number) => void;
  supports: ReadonlyMap<string, LanguageSupport>;
}

const PanelBody = memo(function PanelBody({
  uiState,
  flatItems,
  resultsScrollRef,
  focusedItemIndex,
  tabbableIndex,
  setItemRef,
  onListKeyDown,
  onToggleFile,
  onActivateMatch,
  onItemFocus,
  supports,
}: PanelBodyProps) {
  switch (uiState.kind) {
    case 'no-workspace':
      return (
        <div className={styles.statePanel}>
          <span className={styles.statePanelTitle}>No workspace open</span>
          <span>Open a folder to search across files.</span>
        </div>
      );

    case 'empty-query':
      return (
        <div className={styles.statePanel}>
          <span>Type to search the workspace.</span>
        </div>
      );

    case 'loading':
      return (
        <div className={styles.statePanel} aria-live="polite">
          <span>
            <span className={styles.loadingDot} aria-hidden="true" />
            Searching…
          </span>
        </div>
      );

    case 'no-matches':
      return (
        <div className={styles.statePanel}>
          <span className={styles.statePanelTitle}>No matches</span>
          <span>Search completed in {formatSearchDuration(uiState.durationMs)}.</span>
        </div>
      );

    case 'missing-tool':
      return (
        <div className={`${styles.statePanel} ${styles.error}`} role="alert">
          <span className={styles.statePanelTitle}>ripgrep is not available</span>
          <span>{uiState.message}</span>
        </div>
      );

    case 'invalid-regex':
      return (
        <div className={`${styles.statePanel} ${styles.warning}`} role="alert">
          <span className={styles.statePanelTitle}>Invalid regular expression</span>
          <span>{uiState.message}</span>
        </div>
      );

    case 'canceled':
      return (
        <div className={styles.statePanel}>
          <span>Search canceled.</span>
        </div>
      );

    case 'failed':
      return (
        <div className={`${styles.statePanel} ${styles.error}`} role="alert">
          <span className={styles.statePanelTitle}>Search failed</span>
          <span>{uiState.message}</span>
        </div>
      );

    case 'results': {
      return (
        <>
          <div className={`${styles.summary} ${uiState.truncated ? styles.truncated : ''}`}>
            <span>{describeMatchSummary(uiState)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatSearchDuration(uiState.durationMs)}</span>
            {uiState.truncated && (
              <>
                <span aria-hidden="true">·</span>
                {/* Prefix the warning with a ⚠ glyph so the truncation cue
                    is not color-only — colorblind users see the icon plus
                    the explicit "Truncated" word in addition to the warning
                    color modifier on the summary background. */}
                <span>⚠ Truncated at {uiState.matchCap.toLocaleString()} matches</span>
              </>
            )}
          </div>
          <div
            ref={resultsScrollRef}
            className={styles.resultsScroll}
            aria-label="Search results"
            onKeyDown={onListKeyDown}
          >
            <div className={styles.resultsList}>
              {flatItems.map((item) =>
                item.kind === 'file' ? (
                  <FileGroupHeader
                    key={`f:${item.file.path}`}
                    item={item}
                    focused={focusedItemIndex === item.index}
                    tabbable={tabbableIndex === item.index}
                    itemRef={setItemRef(item.index)}
                    onToggle={() => onToggleFile(item.file.path)}
                    onFocus={() => onItemFocus(item.index)}
                  />
                ) : (
                  <ResultRow
                    key={`m:${item.file.path}:${item.match.line}:${item.match.column}`}
                    item={item}
                    focused={focusedItemIndex === item.index}
                    tabbable={tabbableIndex === item.index}
                    itemRef={setItemRef(item.index)}
                    onActivate={() => onActivateMatch(item.file, item.match)}
                    onFocus={() => onItemFocus(item.index)}
                    support={
                      item.syntaxEligible ? (supports.get(item.file.relativePath) ?? null) : null
                    }
                  />
                )
              )}
            </div>
          </div>
        </>
      );
    }
  }
});
