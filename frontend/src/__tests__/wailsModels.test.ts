import { filesystem } from '../wails/bindings';

const entry = (unreadable?: boolean) =>
  filesystem.FileEntry.createFrom({
    name: 'restricted',
    path: '/repo/restricted',
    isDir: true,
    size: 0,
    modTime: '',
    ...(unreadable === undefined ? {} : { unreadable }),
  });

it('converts the optional FileEntry unreadable binding', () => {
  expect(entry().unreadable).toBeUndefined();
  expect(entry(true).unreadable).toBe(true);
});
