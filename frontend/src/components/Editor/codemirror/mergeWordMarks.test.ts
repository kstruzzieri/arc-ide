import { sideWordMarks } from './mergeWordMarks';

describe('sideWordMarks', () => {
  it('marks the changed words on both sides of a modified line', () => {
    const marks = sideWordMarks(['const timeout = 100 ms'], ['const timeout = 250 ms']);

    expect(marks).not.toBeNull();
    expect(marks!.a[0]).toEqual([
      { text: 'const timeout = ', type: 'same' },
      { text: '100', type: 'del' },
      { text: ' ms', type: 'same' },
    ]);
    expect(marks!.b[0]).toEqual([
      { text: 'const timeout = ', type: 'same' },
      { text: '250', type: 'ins' },
      { text: ' ms', type: 'same' },
    ]);
  });

  it('leaves unchanged lines as a single same segment', () => {
    const marks = sideWordMarks(['shared', 'a'], ['shared', 'b']);

    expect(marks!.a[0]).toEqual([{ text: 'shared', type: 'same' }]);
    expect(marks!.b[0]).toEqual([{ text: 'shared', type: 'same' }]);
  });

  it('marks whole lines when the sides have different line counts', () => {
    const marks = sideWordMarks(['only ours'], ['first', 'second']);

    expect(marks!.a[0]).toEqual([{ text: 'only ours', type: 'del' }]);
    expect(marks!.b[0]).toEqual([{ text: 'first', type: 'ins' }]);
    expect(marks!.b[1]).toEqual([{ text: 'second', type: 'ins' }]);
  });

  it('returns null when the sides have too many characters to diff cheaply', () => {
    // Stay UNDER the line cap (200 combined lines < 500) so this exercises the CHAR
    // cap specifically: 100 lines/side x 201 chars = 40,200 combined chars > 40,000.
    const wide = new Array(100).fill('x'.repeat(201));

    expect(sideWordMarks(wide, [...wide])).toBeNull();
  });

  it('returns null when one line has too many word tokens to diff cheaply', () => {
    // The character cap still admits this pair, but alternating word/space runs
    // would make the token-level Myers trace much larger than the source text.
    const ours = 'a '.repeat(251);
    const theirs = 'b '.repeat(251);

    expect(ours.length + theirs.length).toBeLessThan(40_000);
    expect(sideWordMarks([ours], [theirs])).toBeNull();
  });

  it('returns null when the sides have too many lines, even if the lines are short', () => {
    // Char total is tiny here; the guard that matters is the LINE count, because
    // diffSequences retains up to MAX_MYERS_D (2000) sequence-sized trace snapshots.
    const many = new Array(600).fill('x');

    expect(sideWordMarks(many, many.slice(0, 599))).toBeNull();
  });

  it('returns null when either side is empty', () => {
    expect(sideWordMarks([], ['a'])).toBeNull();
  });
});
