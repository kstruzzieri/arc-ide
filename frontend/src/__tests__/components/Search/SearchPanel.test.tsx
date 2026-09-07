import { javascript } from '@codemirror/lang-javascript';

jest.mock('../../../hooks/useSearchSyntaxSupports', () => ({
  useSearchSyntaxSupports: jest.fn(() => new Map()),
}));

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SearchPanel } from '../../../components/Search';
import { useIDEStore } from '../../../stores/ideStore';
import { useSearchStore } from '../../../stores/searchStore';
import { useSearchSyntaxSupports } from '../../../hooks/useSearchSyntaxSupports';
import type { FileResult, SearchUIState } from '../../../types/search';
import { MAX_SEARCH_HIGHLIGHTED_ROWS } from '../../../utils/searchTokens';

const mockNavigate = jest.fn();
jest.mock('../../../utils/editorNavigation', () => ({
  navigateToEditorLocation: (...args: unknown[]) => mockNavigate(...args),
}));

function setUIState(
  partial: Partial<{
    query: string;
    uiState: SearchUIState;
    expandedFiles: Set<string>;
    options: { regex: boolean; caseSensitive: boolean; wholeWord: boolean };
  }>
) {
  useSearchStore.setState((state) => ({
    ...state,
    ...partial,
  }));
}

function makeFile(
  relativePath: string,
  matches: Array<{
    line: number;
    column?: number;
    text: string;
    submatches?: Array<{ start: number; end: number }>;
  }>
): FileResult {
  return {
    path: `/workspace/${relativePath}`,
    relativePath,
    matches: matches.map((m) => ({
      line: m.line,
      column: m.column ?? 1,
      text: m.text,
      submatches: m.submatches ?? [{ start: 0, end: new TextEncoder().encode(m.text).length }],
    })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the search store between tests by rebuilding the default state.
  useSearchStore.setState({
    query: '',
    options: { regex: false, caseSensitive: false, wholeWord: false },
    uiState: { kind: 'no-workspace' },
    expandedFiles: new Set(),
    activeRequestId: null,
    focusInputRevision: 0,
  });
});

afterEach(() => {
  // Clean up any DOM nodes appended directly to document.body by tests
  // (testing-library's auto-cleanup only unmounts React roots).
  document.getElementById('mount-focus-sibling')?.remove();
});

describe('SearchPanel — empty-style states', () => {
  it('renders the no-workspace state', () => {
    setUIState({ uiState: { kind: 'no-workspace' } });
    render(<SearchPanel />);
    expect(screen.getByText('No workspace open')).toBeInTheDocument();
    expect(screen.getByText(/Open a folder to search/)).toBeInTheDocument();
  });

  it('renders the empty-query state', () => {
    setUIState({ uiState: { kind: 'empty-query' } });
    render(<SearchPanel />);
    expect(screen.getByText(/Type to search the workspace/)).toBeInTheDocument();
  });

  it('renders the loading state', () => {
    setUIState({ uiState: { kind: 'loading', requestId: 'r1' } });
    render(<SearchPanel />);
    expect(screen.getByText(/Searching/)).toBeInTheDocument();
  });

  it('renders the no-matches state with formatted duration', () => {
    setUIState({ uiState: { kind: 'no-matches', durationMs: 142 } });
    render(<SearchPanel />);
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.getByText(/142 ms/)).toBeInTheDocument();
  });

  it('renders the missing-tool state as an alert', () => {
    setUIState({
      uiState: { kind: 'missing-tool', message: 'ripgrep is not on PATH.' },
    });
    render(<SearchPanel />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('ripgrep is not available')).toBeInTheDocument();
    expect(screen.getByText('ripgrep is not on PATH.')).toBeInTheDocument();
  });

  it('renders the invalid-regex state and marks the input invalid', () => {
    setUIState({
      query: 'foo[',
      uiState: { kind: 'invalid-regex', message: 'unclosed character class' },
    });
    render(<SearchPanel />);
    expect(screen.getByText('Invalid regular expression')).toBeInTheDocument();
    const input = screen.getByLabelText('Search query');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders the failed state with the message', () => {
    setUIState({ uiState: { kind: 'failed', message: 'spawn failure' } });
    render(<SearchPanel />);
    expect(screen.getByText('Search failed')).toBeInTheDocument();
    expect(screen.getByText('spawn failure')).toBeInTheDocument();
  });

  it('renders the canceled state', () => {
    setUIState({ uiState: { kind: 'canceled' } });
    render(<SearchPanel />);
    expect(screen.getByText(/Search canceled/)).toBeInTheDocument();
  });
});

describe('SearchPanel — controls', () => {
  it('updates query on input change', () => {
    setUIState({ uiState: { kind: 'empty-query' } });
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(useSearchStore.getState().query).toBe('hello');
  });

  it('toggles each option independently', () => {
    setUIState({ uiState: { kind: 'empty-query' } });
    render(<SearchPanel />);
    const caseBtn = screen.getByRole('button', { name: 'Match case' });
    const wordBtn = screen.getByRole('button', { name: 'Match whole word' });
    const regexBtn = screen.getByRole('button', { name: 'Use regular expression' });

    expect(caseBtn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(caseBtn);
    expect(useSearchStore.getState().options.caseSensitive).toBe(true);
    fireEvent.click(wordBtn);
    expect(useSearchStore.getState().options.wholeWord).toBe(true);
    fireEvent.click(regexBtn);
    expect(useSearchStore.getState().options.regex).toBe(true);
  });

  it('shows the clear button only when there is a query', () => {
    setUIState({ uiState: { kind: 'empty-query' } });
    const { rerender } = render(<SearchPanel />);
    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();

    act(() => {
      useSearchStore.getState().setQuery('foo');
    });
    rerender(<SearchPanel />);
    fireEvent.click(screen.getByLabelText('Clear search'));
    expect(useSearchStore.getState().query).toBe('');
  });

  it('focuses the input on mount regardless of starting focusInputRevision', () => {
    // Render an unrelated focusable sibling first and focus it; this ensures
    // any subsequent activeElement === input observation reflects the panel's
    // mount-time focus effect, not jsdom's body-default behavior. Sibling
    // is removed by the suite-level afterEach below to survive assertion
    // failures without leaking into later tests.
    const sibling = document.createElement('button');
    sibling.id = 'mount-focus-sibling';
    sibling.textContent = 'sibling';
    document.body.appendChild(sibling);
    sibling.focus();
    expect(document.activeElement?.id).toBe('mount-focus-sibling');

    // Mount with a non-zero revision to prove the effect fires on mount and
    // doesn't depend on a 0-valued dep.
    setUIState({ uiState: { kind: 'empty-query' } });
    useSearchStore.setState({ focusInputRevision: 5 });

    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');
    expect(document.activeElement).toBe(input);
  });

  it('refocuses the input when requestInputFocus bumps the revision', () => {
    setUIState({ uiState: { kind: 'empty-query' } });
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(input);

    act(() => {
      useSearchStore.getState().requestInputFocus();
    });
    expect(document.activeElement).toBe(input);
  });
});

describe('SearchPanel — results rendering', () => {
  const fileA = makeFile('src/components/Foo.tsx', [
    { line: 12, column: 5, text: '  const foo = bar();', submatches: [{ start: 8, end: 11 }] },
    { line: 30, column: 9, text: 'function foo() {}', submatches: [{ start: 9, end: 12 }] },
  ]);
  const fileB = makeFile('Bar.ts', [
    { line: 4, column: 1, text: 'foo();', submatches: [{ start: 0, end: 3 }] },
  ]);

  function setResults(opts?: { truncated?: boolean; matchCap?: number }) {
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [fileA, fileB],
        totalFiles: 2,
        totalLines: 3,
        truncated: opts?.truncated ?? false,
        matchCap: opts?.matchCap ?? 5000,
        durationMs: 180,
      },
      expandedFiles: new Set([fileA.path, fileB.path]),
    });
  }

  it('renders the summary with file/match counts and duration', () => {
    setResults();
    render(<SearchPanel />);
    expect(screen.getByText('3 matches in 2 files')).toBeInTheDocument();
    expect(screen.getByText('180 ms')).toBeInTheDocument();
  });

  it('groups matches by file and shows match counts on the header', () => {
    setResults();
    render(<SearchPanel />);
    const fooHeader = screen.getByRole('button', { name: /Foo\.tsx \(2 matches\)/ });
    expect(fooHeader).toBeInTheDocument();
    expect(within(fooHeader).getByText('2')).toBeInTheDocument();

    const barHeader = screen.getByRole('button', { name: /Bar\.ts \(1 match\)/ });
    expect(within(barHeader).getByText('1')).toBeInTheDocument();
  });

  it('renders highlighted match segments via <mark>', () => {
    setResults();
    render(<SearchPanel />);
    const marks = document.querySelectorAll('mark');
    // 3 total matches across both files → 3 highlight elements.
    expect(marks.length).toBe(3);
    expect(marks[0].textContent).toBe('foo');
  });

  it('renders the truncation banner with a non-color cue when results are capped', () => {
    setResults({ truncated: true, matchCap: 5000 });
    render(<SearchPanel />);
    // Color-only signaling fails WCAG; assert the explicit warning glyph
    // and word are present so the cue is reachable without color.
    expect(screen.getByText(/⚠ Truncated at 5,000 matches/)).toBeInTheDocument();
  });

  it('makes the first item tabbable when no row is focused (Tab-only access)', () => {
    setResults();
    render(<SearchPanel />);
    const firstHeader = screen.getByRole('button', { name: /Foo\.tsx \(2 matches\)/ });
    expect(firstHeader).toHaveAttribute('tabindex', '0');
    // The Bar.ts header is not the focused row and is not at index 0, so it
    // must NOT be in the tab order.
    const secondHeader = screen.getByRole('button', { name: /Bar\.ts \(1 match\)/ });
    expect(secondHeader).toHaveAttribute('tabindex', '-1');
  });

  it('refocuses the previously focused row after a same-shape result refresh', () => {
    setResults();
    render(<SearchPanel />);
    const firstHeader = screen.getByRole('button', { name: /Foo\.tsx \(2 matches\)/ });
    act(() => {
      firstHeader.focus();
    });
    expect(document.activeElement).toBe(firstHeader);

    // Refresh the store with structurally identical results (different
    // object identity, same shape). The button DOM nodes are recreated.
    act(() => {
      useSearchStore.setState({
        uiState: {
          kind: 'results',
          files: [{ ...fileA }, { ...fileB }],
          totalFiles: 2,
          totalLines: 3,
          truncated: false,
          matchCap: 5000,
          durationMs: 60,
        },
      });
    });

    const refreshedHeader = screen.getByRole('button', { name: /Foo\.tsx \(2 matches\)/ });
    expect(document.activeElement).toBe(refreshedHeader);
  });

  it('skips navigation if there is no workspace open at click time', async () => {
    act(() => {
      useIDEStore.setState({ workspace: null });
    });
    const file = makeFile('foo.ts', [
      { line: 1, column: 1, text: 'foo', submatches: [{ start: 0, end: 3 }] },
    ]);
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [file],
        totalFiles: 1,
        totalLines: 1,
        truncated: false,
        matchCap: 5000,
        durationMs: 5,
      },
      expandedFiles: new Set([file.path]),
    });

    render(<SearchPanel />);
    const row = screen.getByRole('button', { name: /Line 1 in foo\.ts/ });

    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('clicking a match calls navigateToEditorLocation with byte→char column', async () => {
    // The activateMatch guard requires a workspace; mock one that contains
    // the file path. The test assertion is on byte→char column conversion,
    // not on the workspace gate.
    act(() => {
      useIDEStore.setState({ workspace: { name: 'w', path: '/workspace' } });
    });
    // Multi-byte case: the line text starts with a 2-byte char (é) and the
    // backend reports column=3 (1-based byte offset just past 'é '), which
    // equals char column 3 in JS. Use a clearer 4-byte case: emoji.
    const file = makeFile('emoji.ts', [
      // "🙂 const x" — 🙂 is 4 bytes in UTF-8 (and 2 UTF-16 code units).
      // Backend column 6 = byte index 5 = right after "🙂 " (4 + 1 = 5 bytes).
      // In UTF-16, that's char index 3 (2 surrogates + 1 space) → 1-based 4.
      { line: 1, column: 6, text: '🙂 const x', submatches: [{ start: 5, end: 10 }] },
    ]);
    setUIState({
      query: 'const',
      uiState: {
        kind: 'results',
        files: [file],
        totalFiles: 1,
        totalLines: 1,
        truncated: false,
        matchCap: 5000,
        durationMs: 5,
      },
      expandedFiles: new Set([file.path]),
    });

    render(<SearchPanel />);
    const row = screen.getByRole('button', { name: /Line 1 in emoji\.ts/ });

    await act(async () => {
      fireEvent.click(row);
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(
      '/workspace/emoji.ts',
      1,
      4,
      expect.objectContaining({ shouldApply: expect.any(Function) })
    );

    const options = mockNavigate.mock.calls[0][3] as { shouldApply: () => boolean };
    expect(options.shouldApply()).toBe(true);

    act(() => {
      useIDEStore.setState({ workspace: { name: 'other', path: '/other-workspace' } });
    });

    expect(options.shouldApply()).toBe(false);
  });

  it('clicking a file header collapses then expands the group', () => {
    setResults();
    render(<SearchPanel />);
    expect(useSearchStore.getState().expandedFiles.has(fileA.path)).toBe(true);

    const header = screen.getByRole('button', { name: /Foo\.tsx \(2 matches\)/ });
    fireEvent.click(header);
    expect(useSearchStore.getState().expandedFiles.has(fileA.path)).toBe(false);

    fireEvent.click(header);
    expect(useSearchStore.getState().expandedFiles.has(fileA.path)).toBe(true);
  });

  it('restores focus to the input when results refresh and the focused row unmounts', () => {
    setResults();
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');
    const lastRow = screen.getByRole('button', { name: /^Line 4 in Bar\.ts:/ });

    act(() => {
      lastRow.focus();
    });
    expect(document.activeElement).toBe(lastRow);

    // Simulate a fresh response that drops Bar.ts entirely. The previously
    // focused row unmounts; without restoration, focus would move to body.
    act(() => {
      useSearchStore.setState({
        uiState: {
          kind: 'results',
          files: [fileA],
          totalFiles: 1,
          totalLines: 2,
          truncated: false,
          matchCap: 5000,
          durationMs: 50,
        },
        expandedFiles: new Set([fileA.path]),
      });
    });

    expect(document.activeElement).toBe(input);
  });
});

describe('SearchPanel — keyboard navigation', () => {
  const file = makeFile('a.ts', [
    { line: 1, column: 1, text: 'foo', submatches: [{ start: 0, end: 3 }] },
    { line: 2, column: 1, text: 'foo', submatches: [{ start: 0, end: 3 }] },
  ]);

  function setupResults() {
    // activateMatch requires a workspace; without it the click is a no-op.
    useIDEStore.setState({ workspace: { name: 'w', path: '/workspace' } });
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [file],
        totalFiles: 1,
        totalLines: 2,
        truncated: false,
        matchCap: 5000,
        durationMs: 10,
      },
      expandedFiles: new Set([file.path]),
    });
  }

  it('ArrowDown from the input focuses the first item', () => {
    setupResults();
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const fileHeader = screen.getByRole('button', { name: /a\.ts \(2 matches\)/ });
    expect(document.activeElement).toBe(fileHeader);
  });

  it('ArrowDown moves through the flat item list', () => {
    setupResults();
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const fileHeader = screen.getByRole('button', { name: /a\.ts \(2 matches\)/ });
    fireEvent.keyDown(fileHeader, { key: 'ArrowDown' });

    const firstResult = screen.getByRole('button', { name: /^Line 1 in a\.ts:/ });
    expect(document.activeElement).toBe(firstResult);
  });

  it('Home scrolls to the first sticky header before focusing it', () => {
    const secondFile = makeFile('b.ts', [
      { line: 3, column: 1, text: 'foo', submatches: [{ start: 0, end: 3 }] },
    ]);
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [file, secondFile],
        totalFiles: 2,
        totalLines: 3,
        truncated: false,
        matchCap: 5000,
        durationMs: 10,
      },
      expandedFiles: new Set([file.path, secondFile.path]),
    });
    render(<SearchPanel />);

    const results = screen.getByLabelText('Search results');
    results.scrollTop = 100;
    const secondHeader = screen.getByRole('button', { name: /b\.ts \(1 match\)/ });
    act(() => {
      secondHeader.focus();
    });
    fireEvent.keyDown(secondHeader, { key: 'Home' });

    expect(results.scrollTop).toBe(0);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /a\.ts \(2 matches\)/ })
    );
  });

  it('ArrowUp on the first item returns focus to the input', () => {
    setupResults();
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const fileHeader = screen.getByRole('button', { name: /a\.ts \(2 matches\)/ });
    fireEvent.keyDown(fileHeader, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);
  });

  it('Enter on a result row navigates', async () => {
    setupResults();
    render(<SearchPanel />);
    const firstResult = screen.getByRole('button', { name: /^Line 1 in a\.ts:/ });
    // act() flushes onFocus state update so focusedItemIndex is set before
    // the keyDown handler reads it.
    act(() => {
      firstResult.focus();
    });
    await act(async () => {
      fireEvent.keyDown(firstResult, { key: 'Enter' });
    });
    expect(mockNavigate).toHaveBeenCalledWith(
      file.path,
      1,
      1,
      expect.objectContaining({ shouldApply: expect.any(Function) })
    );
  });

  it('Enter on a file header toggles expansion', () => {
    setupResults();
    render(<SearchPanel />);
    const fileHeader = screen.getByRole('button', { name: /a\.ts \(2 matches\)/ });
    act(() => {
      fileHeader.focus();
    });
    fireEvent.keyDown(fileHeader, { key: 'Enter' });
    expect(useSearchStore.getState().expandedFiles.has(file.path)).toBe(false);
  });

  it('ArrowLeft on a match row moves focus to the parent file header', () => {
    setupResults();
    render(<SearchPanel />);
    const firstResult = screen.getByRole('button', { name: /^Line 1 in a\.ts:/ });
    act(() => {
      firstResult.focus();
    });
    fireEvent.keyDown(firstResult, { key: 'ArrowLeft' });

    const fileHeader = screen.getByRole('button', { name: /a\.ts \(2 matches\)/ });
    expect(document.activeElement).toBe(fileHeader);
  });

  it('ArrowLeft on a collapsed file header returns focus to the input', () => {
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [file],
        totalFiles: 1,
        totalLines: 2,
        truncated: false,
        matchCap: 5000,
        durationMs: 10,
      },
      expandedFiles: new Set(),
    });
    render(<SearchPanel />);
    const fileHeader = screen.getByRole('button', { name: /a\.ts \(2 matches\)/ });
    act(() => {
      fileHeader.focus();
    });
    fireEvent.keyDown(fileHeader, { key: 'ArrowLeft' });

    const input = screen.getByLabelText('Search query');
    expect(document.activeElement).toBe(input);
  });

  it('ArrowRight on a collapsed file header expands it', () => {
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [file],
        totalFiles: 1,
        totalLines: 2,
        truncated: false,
        matchCap: 5000,
        durationMs: 10,
      },
      expandedFiles: new Set(),
    });
    render(<SearchPanel />);
    const fileHeader = screen.getByRole('button', { name: /a\.ts \(2 matches\)/ });
    act(() => {
      fileHeader.focus();
    });
    fireEvent.keyDown(fileHeader, { key: 'ArrowRight' });
    expect(useSearchStore.getState().expandedFiles.has(file.path)).toBe(true);
  });

  it('Escape on the input clears a non-empty query', () => {
    setUIState({ query: 'foo', uiState: { kind: 'empty-query' } });
    render(<SearchPanel />);
    const input = screen.getByLabelText('Search query');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useSearchStore.getState().query).toBe('');
  });
});

describe('SearchPanel — match-anchored line rendering (#207)', () => {
  function renderResults(files: FileResult[]) {
    setUIState({
      query: 'Search',
      uiState: {
        kind: 'results',
        files,
        totalFiles: files.length,
        totalLines: files.reduce((n, f) => n + f.matches.length, 0),
        truncated: false,
        matchCap: 5000,
        durationMs: 12,
      },
      expandedFiles: new Set(files.map((f) => f.path)),
    });
    return render(<SearchPanel />);
  }

  it('renders leading context as an rtl-safe bdi with an LRM terminator', () => {
    // "Search" at byte offset 16 in an ASCII line (byte == char here).
    const file = makeFile('a.ts', [
      { line: 178, text: 'export function SearchPanel() {', submatches: [{ start: 16, end: 22 }] },
    ]);
    renderResults([file]);

    const lead = document.querySelector('.contextLead');
    expect(lead).not.toBeNull();
    expect(lead).toHaveClass('context');
    const bdi = lead!.querySelector('bdi');
    expect(bdi).not.toBeNull();
    expect(bdi!.getAttribute('dir')).toBe('ltr');
    // LRM keeps the trailing space inside the rtl line box.
    expect(bdi!.textContent).toBe('export function ‎');
  });

  it('renders trailing context as a plain .context span without lead class', () => {
    const file = makeFile('a.ts', [
      { line: 178, text: 'export function SearchPanel() {', submatches: [{ start: 16, end: 22 }] },
    ]);
    renderResults([file]);

    const contexts = document.querySelectorAll('.context:not(.contextLead)');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].textContent).toBe('Panel() {');
    expect(document.querySelector('mark')!.textContent).toBe('Search');
  });

  it('trims leading indentation from the leading context segment (render only)', () => {
    // 6 spaces + `aria-label="` = offset 18 for "Search".
    const file = makeFile('a.ts', [
      {
        line: 573,
        text: '      aria-label="Search results"',
        submatches: [{ start: 18, end: 24 }],
      },
    ]);
    renderResults([file]);

    const bdi = document.querySelector('.contextLead bdi');
    // No LRM: it is only appended when the lead ends in preserved whitespace.
    expect(bdi!.textContent).toBe('aria-label="');
  });

  it('omits the leading segment entirely when it is whitespace-only', () => {
    const file = makeFile('a.ts', [
      { line: 9, text: '   Search everywhere', submatches: [{ start: 3, end: 9 }] },
    ]);
    renderResults([file]);

    expect(document.querySelector('.contextLead')).toBeNull();
    const lineText = document.querySelector('.lineText')!;
    expect((lineText.firstElementChild as HTMLElement).tagName).toBe('MARK');
  });

  it('handles multiple submatches: only the first segment is the lead', () => {
    // "Search"/"search" at byte offsets 12 and 34 in the line below (ASCII: byte == char).
    const file = makeFile('a.ts', [
      {
        line: 12,
        text: 'import { useSearchStore } from "./searchStore";',
        submatches: [
          { start: 12, end: 18 },
          { start: 34, end: 40 },
        ],
      },
    ]);
    renderResults([file]);

    expect(document.querySelectorAll('mark')).toHaveLength(2);
    expect(document.querySelectorAll('.contextLead')).toHaveLength(1);
    // Middle + trailing context spans are plain .context.
    expect(document.querySelectorAll('.context:not(.contextLead)')).toHaveLength(2);
  });

  it('splits by byte offsets, not UTF-16 indices, for non-ASCII prefixes', () => {
    // Emoji (4 bytes) + CJK (3) + decomposed e-acute (1+2) + space (1) = 11 bytes,
    // but only 6 UTF-16 code units — the offsets diverge, exercising the byte path.
    const prefix = '🙂漢é ';
    const start = new TextEncoder().encode(prefix).length;
    const file = makeFile('a.ts', [
      { line: 3, text: `${prefix}Search done`, submatches: [{ start, end: start + 6 }] },
    ]);
    renderResults([file]);

    expect(document.querySelector('mark')!.textContent).toBe('Search');
    // Lead ends in a preserved space, so the LRM terminator is appended.
    expect(document.querySelector('.contextLead bdi')!.textContent).toBe(`${prefix}‎`);
  });

  it('exposes the full line via title and includes it in the aria-label', () => {
    const file = makeFile('a.ts', [
      {
        line: 87,
        text: '      const results = await SearchWorkspace(workspacePath);',
        submatches: [{ start: 28, end: 34 }],
      },
    ]);
    renderResults([file]);

    const row = screen.getByRole('button', {
      name: 'Line 87 in a.ts: const results = await SearchWorkspace(workspacePath);',
    });
    expect(row).toHaveAttribute('title', 'const results = await SearchWorkspace(workspacePath);');
  });

  it('nests the directory bdi inside the rtl-styled span (mixed-script segment order)', () => {
    const file = makeFile('docs/حزم/catalog/notes.md', [
      { line: 7, text: 'Search me', submatches: [{ start: 0, end: 6 }] },
    ]);
    renderResults([file]);

    const dir = document.querySelector('.fileDir');
    expect(dir).not.toBeNull();
    // The rtl-styled element must NOT itself carry dir="ltr" — the isolation
    // wrapper is a child.
    expect(dir!.tagName).toBe('SPAN');
    const bdi = dir!.querySelector('bdi');
    expect(bdi).not.toBeNull();
    expect(bdi!.getAttribute('dir')).toBe('ltr');
    expect(bdi!.textContent).toBe('docs/حزم/catalog');
  });

  it('caps title and aria-label for very long lines (ripgrep has no column cap)', () => {
    const longLine = `const x = '${'a'.repeat(500)}'; // Search target`;
    const start = longLine.indexOf('Search');
    const file = makeFile('a.ts', [
      { line: 1, text: longLine, submatches: [{ start, end: start + 6 }] },
    ]);
    renderResults([file]);

    const row = document.querySelector('.resultRow') as HTMLButtonElement;
    // 300 chars + ellipsis, not the full 500+ char line.
    expect(row.title).toHaveLength(301);
    expect(row.title.endsWith('…')).toBe(true);
    expect(row.title.startsWith("const x = '")).toBe(true);
    const label = row.getAttribute('aria-label')!;
    expect(label.startsWith('Line 1 in a.ts: ')).toBe(true);
    expect(label.length).toBeLessThan(340);
  });
});

describe('SearchPanel — dimmed syntax tokens (#215)', () => {
  const tsSupport = javascript({ typescript: true });

  function setResultsFor(file: FileResult) {
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [file],
        totalFiles: 1,
        totalLines: file.matches.length,
        truncated: false,
        matchCap: 5000,
        durationMs: 10,
      },
      expandedFiles: new Set([file.path]),
    });
  }

  it('renders monochrome (no tok- spans) while support is unloaded', () => {
    (useSearchSyntaxSupports as jest.Mock).mockReturnValue(new Map());
    const file = makeFile('a.ts', [
      { line: 1, text: 'const foo = bar;', submatches: [{ start: 6, end: 9 }] },
    ]);
    setResultsFor(file);
    render(<SearchPanel />);
    expect(document.querySelector('[class*="tok-"]')).toBeNull();
    expect(document.querySelector('mark')!.textContent).toBe('foo');
    expect(document.querySelector('.contextLead')).not.toBeNull();
  });

  it('renders nested token spans in context once support resolves, mark unchanged', () => {
    const file = makeFile('a.ts', [
      { line: 1, text: 'const foo = bar;', submatches: [{ start: 6, end: 9 }] },
    ]);
    (useSearchSyntaxSupports as jest.Mock).mockReturnValue(
      new Map([[file.relativePath, tsSupport]])
    );
    setResultsFor(file);
    render(<SearchPanel />);
    const keyword = document.querySelector('.tok-keyword');
    expect(keyword).not.toBeNull();
    expect(keyword!.textContent).toBe('const');
    const marks = document.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('foo');
    expect(marks[0].querySelector('[class*="tok-"]')).toBeNull();
  });

  it('keeps one .context box per outer segment (no extra flex items)', () => {
    const file = makeFile('a.ts', [
      { line: 1, text: 'const foo = bar;', submatches: [{ start: 6, end: 9 }] },
    ]);
    (useSearchSyntaxSupports as jest.Mock).mockReturnValue(
      new Map([[file.relativePath, tsSupport]])
    );
    setResultsFor(file);
    render(<SearchPanel />);
    expect(document.querySelectorAll('.context')).toHaveLength(2);
    expect(document.querySelector('.contextLead bdi')).not.toBeNull();
  });

  it('preserves the leading bdi + LRM terminator around token spans', () => {
    const file = makeFile('a.ts', [
      { line: 1, text: 'export function SearchPanel() {', submatches: [{ start: 16, end: 22 }] },
    ]);
    (useSearchSyntaxSupports as jest.Mock).mockReturnValue(
      new Map([[file.relativePath, tsSupport]])
    );
    setResultsFor(file);
    render(<SearchPanel />);
    const bdi = document.querySelector('.contextLead bdi')!;
    expect(bdi.textContent).toBe('export function ‎');
  });

  it('sets --syntax-* custom properties on the search container from the active theme', () => {
    (useSearchSyntaxSupports as jest.Mock).mockReturnValue(new Map());
    act(() => {
      useIDEStore.setState({ editorSyntaxTheme: 'reef' });
    });
    const file = makeFile('a.ts', [
      { line: 1, text: 'const foo = bar;', submatches: [{ start: 6, end: 9 }] },
    ]);
    setResultsFor(file);
    render(<SearchPanel />);
    const container = screen.getByRole('region', { name: 'Workspace search' });
    expect(container.style.getPropertyValue('--syntax-keyword')).toBe('#FF6B9D');
  });

  it('passes only distinct visible filenames to the loader hook', () => {
    const spy = useSearchSyntaxSupports as jest.Mock;
    spy.mockClear();
    spy.mockReturnValue(new Map());
    const file = makeFile('a.ts', [
      { line: 1, text: 'foo one', submatches: [{ start: 0, end: 3 }] },
      { line: 2, text: 'foo two', submatches: [{ start: 0, end: 3 }] },
    ]);
    setResultsFor(file);
    render(<SearchPanel />);
    const lastArg = spy.mock.calls[spy.mock.calls.length - 1][0] as string[];
    expect(lastArg).toEqual(['a.ts']);
  });

  it('bounds syntax highlighting to the first 50 expanded matches', () => {
    const spy = useSearchSyntaxSupports as jest.Mock;
    expect(MAX_SEARCH_HIGHLIGHTED_ROWS).toBe(50);
    const highlightedMatches = Array.from({ length: MAX_SEARCH_HIGHLIGHTED_ROWS }, (_, index) => ({
      line: index + 1,
      text: 'const foo = 1;',
      submatches: [{ start: 6, end: 9 }],
    }));
    const fileA = makeFile('a.ts', highlightedMatches);
    const fileB = makeFile('b.ts', [
      {
        line: MAX_SEARCH_HIGHLIGHTED_ROWS + 1,
        text: 'const foo = 1;',
        submatches: [{ start: 6, end: 9 }],
      },
    ]);
    spy.mockReturnValue(
      new Map([
        [fileA.relativePath, tsSupport],
        [fileB.relativePath, tsSupport],
      ])
    );
    setUIState({
      query: 'foo',
      uiState: {
        kind: 'results',
        files: [fileA, fileB],
        totalFiles: 2,
        totalLines: MAX_SEARCH_HIGHLIGHTED_ROWS + 1,
        truncated: false,
        matchCap: 5000,
        durationMs: 10,
      },
      expandedFiles: new Set([fileA.path, fileB.path]),
    });

    render(<SearchPanel />);

    const rows = screen.getAllByRole('button', { name: /^Line \d+ in/ });
    expect(rows).toHaveLength(MAX_SEARCH_HIGHLIGHTED_ROWS + 1);
    expect(document.querySelectorAll('mark')).toHaveLength(MAX_SEARCH_HIGHLIGHTED_ROWS + 1);
    for (const row of rows.slice(0, MAX_SEARCH_HIGHLIGHTED_ROWS)) {
      expect(row.querySelector('.tok-keyword')).not.toBeNull();
    }
    expect(rows[MAX_SEARCH_HIGHLIGHTED_ROWS].querySelector('[class*="tok-"]')).toBeNull();
    const lastArg = spy.mock.calls[spy.mock.calls.length - 1][0] as string[];
    expect(lastArg).toEqual(['a.ts']);
  });
});
