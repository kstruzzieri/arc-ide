import { reorderTargetForDrop, reorderTargetForKey } from '../../utils/centerReorder';

const key = (k: string, over: Partial<KeyboardEventInit> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
  ...over,
});

it('moves the panel to the side the arrow points at, on both platforms', () => {
  expect(reorderTargetForKey(key('ArrowLeft', { metaKey: true }), 'golem', true)).toBe(
    'golem-first'
  );
  expect(reorderTargetForKey(key('ArrowRight', { metaKey: true }), 'golem', true)).toBe(
    'files-first'
  );
  expect(reorderTargetForKey(key('ArrowLeft', { ctrlKey: true }), 'files', false)).toBe(
    'files-first'
  );
  expect(reorderTargetForKey(key('ArrowRight', { ctrlKey: true }), 'files', false)).toBe(
    'golem-first'
  );
});

it('ignores the wrong modifier, Alt, and non-arrow keys', () => {
  expect(reorderTargetForKey(key('ArrowLeft', { ctrlKey: true }), 'golem', true)).toBeNull();
  expect(
    reorderTargetForKey(key('ArrowLeft', { metaKey: true, altKey: true }), 'golem', true)
  ).toBeNull();
  expect(
    reorderTargetForKey(key('ArrowLeft', { metaKey: true, shiftKey: false }), 'golem', true)
  ).toBeNull();
  expect(reorderTargetForKey(key('a', { metaKey: true }), 'golem', true)).toBeNull();
});

it('requires crossing the target midpoint and returns a stable directed order', () => {
  expect(reorderTargetForDrop('golem', 'files-first', 'files', 300, 350)).toBeNull();
  expect(reorderTargetForDrop('golem', 'files-first', 'files', 300, 250)).toBe('golem-first');
  expect(reorderTargetForDrop('files', 'files-first', 'golem', 300, 250)).toBeNull();
  expect(reorderTargetForDrop('files', 'files-first', 'golem', 300, 350)).toBe('golem-first');
  expect(reorderTargetForDrop('golem', 'golem-first', 'files', 300, 350)).toBe('files-first');
  expect(reorderTargetForDrop('files', 'golem-first', 'golem', 300, 250)).toBe('files-first');
  expect(reorderTargetForDrop('files', 'files-first', 'files', 300, 250)).toBeNull();
  expect(reorderTargetForDrop('golem', 'files-first', 'files', 300, 300)).toBeNull();
});
