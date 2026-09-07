import { preserveLoadedChildren } from '../../utils/preserveLoadedChildren';
import type { FileEntry } from '../../stores/ideStore';

const dir = (path: string, children?: FileEntry[]): FileEntry =>
  ({
    name: path.split('/').pop()!,
    path,
    isDir: true,
    size: 0,
    modTime: '',
    children,
  }) as FileEntry;

const file = (path: string): FileEntry =>
  ({
    name: path.split('/').pop()!,
    path,
    isDir: false,
    size: 0,
    modTime: '',
  }) as FileEntry;

it('keeps loaded children of a surviving dir', () => {
  const oldLevel = [dir('/r/a', [file('/r/a/x.ts')]), dir('/r/b')];
  const newLevel = [dir('/r/a'), dir('/r/b'), file('/r/new.ts')];
  const merged = preserveLoadedChildren(oldLevel, newLevel);
  expect(merged.find((e) => e.path === '/r/a')!.children).toEqual([file('/r/a/x.ts')]);
  expect(merged.find((e) => e.path === '/r/new.ts')).toBeTruthy();
});

it('does not resurrect a removed dir and leaves new unloaded dirs unloaded', () => {
  const oldLevel = [dir('/r/a', [file('/r/a/x.ts')])];
  const newLevel = [dir('/r/c')];
  const merged = preserveLoadedChildren(oldLevel, newLevel);
  expect(merged.map((e) => e.path)).toEqual(['/r/c']);
  expect(merged[0].children).toBeUndefined();
});

it('returns newLevel unchanged when oldLevel is empty/undefined', () => {
  const newLevel = [dir('/r/a')];
  expect(preserveLoadedChildren(undefined, newLevel)).toBe(newLevel);
  expect(preserveLoadedChildren([], newLevel)).toBe(newLevel);
});

it('does not copy children to a surviving file entry', () => {
  // files never have children; ensure we don't accidentally copy
  const oldLevel = [file('/r/foo.ts')];
  const newLevel = [file('/r/foo.ts')];
  const merged = preserveLoadedChildren(oldLevel, newLevel);
  expect(merged[0].children).toBeUndefined();
});

it('leaves a surviving-but-still-unloaded dir unloaded', () => {
  const oldLevel = [dir('/r/a')]; // unloaded (children === undefined)
  const newLevel = [dir('/r/a')];
  const merged = preserveLoadedChildren(oldLevel, newLevel);
  expect(merged[0].children).toBeUndefined();
});

it('keeps an unreadable directory marked across a parent-only refresh', () => {
  const oldDir = dir('/r/a');
  oldDir.unreadable = true;

  const merged = preserveLoadedChildren([oldDir], [dir('/r/a')]);

  expect(merged[0].unreadable).toBe(true);
  expect(merged[0].children).toBeUndefined();
});
