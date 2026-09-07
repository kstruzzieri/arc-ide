jest.mock('../../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
}));

import { shortenPath } from '../../utils/workspace';

describe('shortenPath', () => {
  it('should shorten /Users/<name>/... paths', () => {
    expect(shortenPath('/Users/alice/projects/my-app')).toBe('~/projects/my-app');
  });

  it('should shorten /home/<name>/... paths', () => {
    expect(shortenPath('/home/alice/projects/my-app')).toBe('~/projects/my-app');
  });

  it('should shorten Windows C:\\Users\\<name>\\... paths', () => {
    expect(shortenPath('C:\\Users\\alice\\projects\\my-app')).toBe('~\\projects\\my-app');
  });

  it('should return ~ for paths exactly at the home directory level', () => {
    expect(shortenPath('/Users/alice/my-project')).toBe('~/my-project');
    expect(shortenPath('/home/alice/my-project')).toBe('~/my-project');
  });

  it('should return ~ when path is just the home directory', () => {
    expect(shortenPath('/Users/alice')).toBe('~');
    expect(shortenPath('/home/alice')).toBe('~');
  });

  it('should return non-home paths unchanged', () => {
    expect(shortenPath('/var/data/project')).toBe('/var/data/project');
    expect(shortenPath('/opt/workspace')).toBe('/opt/workspace');
  });

  it('should handle empty/falsy input', () => {
    expect(shortenPath('')).toBe('');
  });
});
