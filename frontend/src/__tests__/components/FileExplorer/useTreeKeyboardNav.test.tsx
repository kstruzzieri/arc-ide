// src/__tests__/components/FileExplorer/useTreeKeyboardNav.test.tsx
import { renderHook, act } from '@testing-library/react';
import { useTreeKeyboardNav } from '../../../components/FileExplorer/useTreeKeyboardNav';
import { rowDomId } from '../../../components/FileExplorer/TreeRow';
import { ROOT_ROW_KEY } from '../../../utils/flattenTree';
import type { FlatRow } from '../../../utils/flattenTree';

const mkRow = (over: Partial<FlatRow> & { key: string }): FlatRow => ({
  kind: 'entry',
  depth: 1,
  level: 2,
  isDir: false,
  isExpanded: false,
  isSelected: false,
  regionAccent: null,
  fileAccent: null,
  ownershipAccent: null,
  setSize: 1,
  posInSet: 1,
  name: over.key,
  ...over,
  canExpand: over.canExpand ?? false,
});

const rows: FlatRow[] = [
  mkRow({ kind: 'root', key: ROOT_ROW_KEY, depth: 0, level: 1, isDir: true, isExpanded: true }),
  mkRow({ key: '/repo/src', depth: 1, isDir: true, isExpanded: false }),
  mkRow({ key: '/repo/b.ts', depth: 1 }),
];

const key = (k: string): React.KeyboardEvent =>
  ({ key: k, preventDefault: jest.fn() }) as unknown as React.KeyboardEvent;

function setup(over: Partial<Parameters<typeof useTreeKeyboardNav>[0]> = {}) {
  const scrollToIndex = jest.fn();
  const actions = { toggle: jest.fn(), select: jest.fn(), open: jest.fn() };
  const hook = renderHook(() =>
    useTreeKeyboardNav({ rows, actions, virtualizer: { scrollToIndex }, ...over })
  );
  return { hook, scrollToIndex, actions };
}

describe('useTreeKeyboardNav', () => {
  it('initializes active to the first row', () => {
    const { hook } = setup();
    expect(hook.result.current.activeKey).toBe(ROOT_ROW_KEY);
    expect(hook.result.current.activeId).toBe(rowDomId(ROOT_ROW_KEY));
  });

  it('ArrowDown moves to the next row and scrolls it into view', () => {
    const { hook, scrollToIndex } = setup();
    act(() => hook.result.current.onKeyDown(key('ArrowDown')));
    expect(hook.result.current.activeKey).toBe('/repo/src');
    expect(scrollToIndex).toHaveBeenCalledWith(1, expect.anything());
  });

  it('ArrowUp clamps at the top', () => {
    const { hook } = setup();
    act(() => hook.result.current.onKeyDown(key('ArrowUp')));
    expect(hook.result.current.activeKey).toBe(ROOT_ROW_KEY);
  });

  it('ArrowRight on a collapsed dir toggles it open', () => {
    const { hook, actions } = setup();
    act(() => hook.result.current.onKeyDown(key('ArrowDown'))); // -> /repo/src (collapsed dir)
    act(() => hook.result.current.onKeyDown(key('ArrowRight')));
    expect(actions.toggle).toHaveBeenCalledWith(rows[1]);
  });

  it('ArrowLeft on a file jumps to its parent depth', () => {
    const nested: FlatRow[] = [
      mkRow({ kind: 'root', key: ROOT_ROW_KEY, depth: 0, level: 1, isDir: true, isExpanded: true }),
      mkRow({ key: '/repo/src', depth: 1, isDir: true, isExpanded: true }),
      mkRow({ key: '/repo/src/x.ts', depth: 2 }),
    ];
    const { hook } = setup({ rows: nested });
    act(() => hook.result.current.setActiveKey('/repo/src/x.ts'));
    act(() => hook.result.current.onKeyDown(key('ArrowLeft')));
    expect(hook.result.current.activeKey).toBe('/repo/src');
  });

  it('Enter opens a file; Space selects', () => {
    const { hook, actions } = setup();
    act(() => hook.result.current.setActiveKey('/repo/b.ts'));
    act(() => hook.result.current.onKeyDown(key('Enter')));
    expect(actions.open).toHaveBeenCalledWith(rows[2]);
    act(() => hook.result.current.onKeyDown(key(' ')));
    expect(actions.select).toHaveBeenCalledWith(rows[2]);
  });
});
