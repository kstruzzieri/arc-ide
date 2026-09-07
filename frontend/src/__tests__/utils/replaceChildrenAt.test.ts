import { replaceChildrenAt } from '../../utils/replaceChildrenAt';
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

describe('replaceChildrenAt', () => {
  it('sets children on a deep node, recreating only the spine', () => {
    const sib = dir('/r/b');
    const tree = [dir('/r/a', [dir('/r/a/x')]), sib];
    const next = replaceChildrenAt(tree, '/r/a/x', [file('/r/a/x/f.txt')]);
    const a = next.find((e) => e.path === '/r/a')!;
    expect(a.children![0].children).toEqual([file('/r/a/x/f.txt')]);
    // untouched sibling keeps identity (structural sharing)
    expect(next.find((e) => e.path === '/r/b')).toBe(sib);
  });

  it('normalizes loaded-empty to []', () => {
    const tree = [dir('/r/a', [dir('/r/a/x')])];
    const next = replaceChildrenAt(tree, '/r/a/x', []);
    const x = next[0].children![0];
    expect(x.children).toEqual([]);
  });

  it('returns input unchanged when path not found', () => {
    const tree = [dir('/r/a')];
    expect(replaceChildrenAt(tree, '/nope', [])).toBe(tree);
  });

  it('marks a deep node unreadable without replacing trustworthy children', () => {
    const loadedChild = file('/r/a/x/keep.txt');
    const sibling = dir('/r/b');
    const tree = [dir('/r/a', [dir('/r/a/x', [loadedChild])]), sibling];

    const next = replaceChildrenAt(tree, '/r/a/x', undefined, true);

    const target = next[0].children![0];
    expect(target.unreadable).toBe(true);
    expect(target.children).toBe(tree[0].children![0].children);
    expect(next[1]).toBe(sibling);
  });

  it('descends through Windows paths', () => {
    const tree = [dir('C:\\repo\\src', [dir('C:\\repo\\src\\pkg')])];
    const next = replaceChildrenAt(tree, 'C:\\repo\\src\\pkg', [
      file('C:\\repo\\src\\pkg\\main.go'),
    ]);
    expect(next[0].children![0].children).toEqual([file('C:\\repo\\src\\pkg\\main.go')]);
  });
});
