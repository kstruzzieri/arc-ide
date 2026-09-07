import { normalizeFsPath, joinRepoPath } from './paths';

describe('normalizeFsPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeFsPath('C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts');
  });

  it('strips trailing slashes', () => {
    expect(normalizeFsPath('/repo/src/')).toBe('/repo/src');
  });

  it('keeps a bare root slash', () => {
    expect(normalizeFsPath('/')).toBe('/');
  });

  it('leaves normal posix paths untouched', () => {
    expect(normalizeFsPath('/repo/src/a.ts')).toBe('/repo/src/a.ts');
  });
});

describe('joinRepoPath', () => {
  it('joins a repo root and a porcelain relative path', () => {
    expect(joinRepoPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
  });

  it('normalizes a windows repo root against git forward slashes', () => {
    expect(joinRepoPath('C:\\repo', 'src/a.ts')).toBe('C:/repo/src/a.ts');
  });

  it('tolerates a trailing slash on the root', () => {
    expect(joinRepoPath('/repo/', 'a.ts')).toBe('/repo/a.ts');
  });

  it('joins a repository rooted at the filesystem root', () => {
    expect(joinRepoPath('/', 'a.ts')).toBe('/a.ts');
  });
});
