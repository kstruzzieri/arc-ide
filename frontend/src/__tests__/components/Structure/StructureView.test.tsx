import { render, screen, fireEvent, act } from '@testing-library/react';
import type { DocumentSymbolNode } from '../../../utils/documentSymbols';
import type { UseDocumentSymbolsResult } from '../../../hooks/useDocumentSymbols';

const mockNavigate = jest.fn();
jest.mock('../../../utils/editorNavigation', () => ({
  navigateToEditorLocation: (...args: unknown[]) => mockNavigate(...args),
}));

let hookResult: UseDocumentSymbolsResult;
const mockRefresh = jest.fn();
jest.mock('../../../hooks/useDocumentSymbols', () => ({
  useDocumentSymbols: () => hookResult,
}));

import { StructureView } from '../../../components/Structure/StructureView';

function range(line: number, character = 0) {
  return { start: { line, character }, end: { line, character: character + 1 } };
}
function sym(
  name: string,
  kind: number,
  selLine: number,
  children: DocumentSymbolNode[] = []
): DocumentSymbolNode {
  return { name, kind, range: range(selLine), selectionRange: range(selLine), children };
}

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;
}

function expectSoleTabStop(expected: HTMLElement) {
  const items = screen.getAllByRole('treeitem');
  expect(items.filter((item) => item.tabIndex === 0)).toEqual([expected]);
  expect(items.filter((item) => item.tabIndex === -1)).toHaveLength(items.length - 1);
}

function focus(item: HTMLElement) {
  act(() => item.focus());
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockRefresh.mockClear();
  hookResult = { status: 'no-file', symbols: [], filePath: null, refresh: mockRefresh };
});

it('renders the no-file state', () => {
  render(<StructureView />);
  expect(screen.getByText('No file open')).toBeInTheDocument();
});

it('renders unsupported state', () => {
  hookResult = { status: 'unsupported', symbols: [], filePath: '/ws/x.env', refresh: mockRefresh };
  render(<StructureView />);
  expect(screen.getByText('Structure unavailable for this file')).toBeInTheDocument();
});

it('renders error state with a working Retry button', () => {
  hookResult = { status: 'error', symbols: [], filePath: '/ws/x.ts', refresh: mockRefresh };
  render(<StructureView />);
  expect(screen.getByText("Couldn't load structure")).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

it('renders a nested symbol tree and jumps to the selection range on click', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)])],
  };
  render(<StructureView />);

  expect(screen.getByText('Widget')).toBeInTheDocument();
  const child = screen.getByText('render');
  expect(child).toBeInTheDocument();

  fireEvent.click(child);
  // selectionRange.start is 0-based (line 4, char 0) → editor is 1-based (5, 1)
  expect(mockNavigate).toHaveBeenCalledWith('/ws/main.ts', 5, 1);
});

it('associates every child group with its parent treeitem', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('Group', 5, 2, [sym('leaf', 6, 4)])])],
  };
  render(<StructureView />);

  const groups = screen.getAllByRole('group');
  expect(groups).toHaveLength(2);

  for (const [owner, group] of [
    [row('Widget'), groups[0]],
    [row('Group'), groups[1]],
  ] as const) {
    expect(group).toHaveAttribute('id');
    expect(owner.getAttribute('aria-owns')?.split(/\s+/)).toContain(group.id);
  }
});

it('jumps via keyboard (Enter or Space) so the tree is operable without a mouse', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0)],
  };
  render(<StructureView />);

  const widget = row('Widget');
  expect(widget).toHaveAttribute('tabindex', '0');
  fireEvent.keyDown(widget, { key: 'Enter' });
  fireEvent.keyDown(widget, { key: ' ' });
  expect(mockNavigate).toHaveBeenNthCalledWith(1, '/ws/main.ts', 1, 1);
  expect(mockNavigate).toHaveBeenNthCalledWith(2, '/ws/main.ts', 1, 1);
});

it('roves one tab stop through visible order with arrows, Home, End, and clamped boundaries', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)]), sym('helper', 12, 8)],
  };
  render(<StructureView />);

  const widget = row('Widget');
  const renderRow = row('render');
  const helper = row('helper');
  expectSoleTabStop(widget);

  focus(widget);
  fireEvent.keyDown(widget, { key: 'ArrowDown' });
  expect(renderRow).toHaveFocus();
  expectSoleTabStop(renderRow);

  fireEvent.keyDown(renderRow, { key: 'ArrowDown' });
  expect(helper).toHaveFocus();
  fireEvent.keyDown(helper, { key: 'ArrowDown' });
  expect(helper).toHaveFocus();

  fireEvent.keyDown(helper, { key: 'ArrowUp' });
  expect(renderRow).toHaveFocus();
  fireEvent.keyDown(renderRow, { key: 'Home' });
  expect(widget).toHaveFocus();
  fireEvent.keyDown(widget, { key: 'ArrowUp' });
  expect(widget).toHaveFocus();

  fireEvent.keyDown(widget, { key: 'End' });
  expect(helper).toHaveFocus();
  expectSoleTabStop(helper);
});

it('uses Right and Left for child focus, expansion, collapse, and parent focus', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('Group', 5, 2, [sym('leaf', 6, 4)])])],
  };
  render(<StructureView />);

  const widget = row('Widget');
  let group = row('Group');
  focus(widget);
  fireEvent.keyDown(widget, { key: 'ArrowRight' });
  expect(group).toHaveFocus();

  fireEvent.keyDown(group, { key: 'ArrowLeft' });
  expect(group).toHaveFocus();
  expect(group).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('leaf')).not.toBeInTheDocument();

  fireEvent.keyDown(group, { key: 'ArrowLeft' });
  expect(widget).toHaveFocus();
  fireEvent.keyDown(widget, { key: 'ArrowLeft' });
  expect(widget).toHaveFocus();
  expect(screen.queryByText('Group')).not.toBeInTheDocument();

  fireEvent.keyDown(widget, { key: 'ArrowRight' });
  expect(widget).toHaveFocus();
  group = row('Group');
  expect(group).toHaveAttribute('aria-expanded', 'false');

  fireEvent.keyDown(widget, { key: 'ArrowRight' });
  expect(group).toHaveFocus();
  fireEvent.keyDown(group, { key: 'ArrowRight' });
  expect(group).toHaveFocus();
  fireEvent.keyDown(group, { key: 'ArrowRight' });
  const leaf = row('leaf');
  expect(leaf).toHaveFocus();

  fireEvent.keyDown(leaf, { key: 'ArrowLeft' });
  expect(group).toHaveFocus();
  expectSoleTabStop(group);
});

it('repairs the sole tab stop when filtering hides the active row', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('alpha', 12, 0), sym('beta', 12, 1)],
  };
  render(<StructureView />);

  const beta = row('beta');
  focus(beta);
  expectSoleTabStop(beta);

  fireEvent.change(screen.getByLabelText('Filter symbols'), { target: { value: 'alph' } });
  expect(screen.queryByText('beta')).not.toBeInTheDocument();
  expectSoleTabStop(row('alpha'));
});

it('repairs the sole tab stop when collapse-all hides the active row', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)]), sym('helper', 12, 8)],
  };
  render(<StructureView />);

  const renderRow = row('render');
  focus(renderRow);
  expectSoleTabStop(renderRow);
  fireEvent.click(screen.getByTitle('Collapse all'));

  expect(screen.queryByText('render')).not.toBeInTheDocument();
  expectSoleTabStop(row('Widget'));
});

it('repairs the sole tab stop when the active file changes', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/a.ts',
    refresh: mockRefresh,
    symbols: [sym('alpha', 12, 0), sym('beta', 12, 1)],
  };
  const { rerender } = render(<StructureView />);

  focus(row('beta'));
  expectSoleTabStop(row('beta'));

  hookResult = {
    status: 'ready',
    filePath: '/ws/b.ts',
    refresh: mockRefresh,
    symbols: [sym('gamma', 12, 0), sym('delta', 12, 1)],
  };
  rerender(<StructureView />);

  expectSoleTabStop(row('gamma'));
});

it('collapses a subtree via ArrowLeft on the focused row', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)])],
  };
  render(<StructureView />);

  const row = screen.getByText('Widget').closest('[role="treeitem"]') as HTMLElement;
  expect(screen.getByText('render')).toBeInTheDocument();
  fireEvent.keyDown(row, { key: 'ArrowLeft' });
  expect(screen.queryByText('render')).not.toBeInTheDocument();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('collapses a subtree via its twisty without triggering navigation', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)])],
  };
  render(<StructureView />);

  const widgetRow = screen.getByText('Widget').closest('[role="treeitem"]') as HTMLElement;

  // Child visible initially
  expect(screen.getByText('render')).toBeInTheDocument();

  // Click the twisty span (first child of the row) — should collapse, not navigate
  const twistySpan = widgetRow.firstElementChild as HTMLElement;
  fireEvent.click(twistySpan);
  expect(screen.queryByText('render')).not.toBeInTheDocument();
  expect(mockNavigate).not.toHaveBeenCalled();
});

it('filters symbols by the filter input', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('alpha', 12, 0), sym('beta', 12, 1)],
  };
  render(<StructureView />);

  fireEvent.change(screen.getByLabelText('Filter symbols'), { target: { value: 'alph' } });
  expect(screen.getByText('alpha')).toBeInTheDocument();
  expect(screen.queryByText('beta')).not.toBeInTheDocument();
});

it('collapse-all collapses the visible tree even while a filter is active', () => {
  // Two containers; filter narrows to one. Collapse-all must operate on the
  // rendered (filtered) tree, not the full symbol list.
  hookResult = {
    status: 'ready',
    filePath: '/ws/main.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)]), sym('Gadget', 5, 8, [sym('tick', 6, 9)])],
  };
  render(<StructureView />);

  fireEvent.change(screen.getByLabelText('Filter symbols'), { target: { value: 'Widget' } });
  expect(screen.getByText('render')).toBeInTheDocument();

  fireEvent.click(screen.getByTitle('Collapse all'));
  expect(screen.queryByText('render')).not.toBeInTheDocument();
});

it('resets collapse state when the active file changes', () => {
  hookResult = {
    status: 'ready',
    filePath: '/ws/a.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)])],
  };
  const { rerender } = render(<StructureView />);

  fireEvent.click(screen.getByTitle('Collapse all'));
  expect(screen.queryByText('render')).not.toBeInTheDocument();

  // Switch to a different file with a same-shaped tree — collapse must reset so
  // stale position-keyed collapse state can't hide the new file's symbols.
  hookResult = {
    status: 'ready',
    filePath: '/ws/b.ts',
    refresh: mockRefresh,
    symbols: [sym('Widget', 5, 0, [sym('render', 6, 4)])],
  };
  rerender(<StructureView />);
  expect(screen.getByText('render')).toBeInTheDocument();
});
