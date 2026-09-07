import {
  diffSequences,
  inlineWordDiff,
  tokenizeWords,
  type InlineDiffSegment,
} from '../../../utils/lineDiff';

/** Word marks for both sides of a conflict card, aligned to their own lines. */
export interface SideWordMarks {
  a: InlineDiffSegment[][];
  b: InlineDiffSegment[][];
}

// Above any cap the card renders plain — word marks are a nicety, not worth a
// stall. All bounds matter: diffSequences is O(N*D) time AND keeps up to
// MAX_MYERS_D trace snapshots, so both many lines and one token-dense line can
// consume far more memory than their character count suggests.
const MAX_DIFF_CHARS = 40_000;
const MAX_DIFF_LINES = 500;
const MAX_DIFF_TOKENS_PER_PAIR = 1_000;

function totalChars(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length, 0);
}

/**
 * Pairs the two sides line-by-line with a Myers diff, then word-diffs each
 * one-to-one replacement. Unpaired lines are marked whole; unchanged lines get
 * a single `same` segment so callers can render every line the same way.
 */
export function sideWordMarks(a: readonly string[], b: readonly string[]): SideWordMarks | null {
  if (a.length === 0 || b.length === 0) return null;
  if (a.length + b.length > MAX_DIFF_LINES) return null;
  if (totalChars(a) + totalChars(b) > MAX_DIFF_CHARS) return null;

  const marksA: InlineDiffSegment[][] = a.map((line) => [{ text: line, type: 'same' }]);
  const marksB: InlineDiffSegment[][] = b.map((line) => [{ text: line, type: 'same' }]);

  for (const hunk of diffSequences([...a], [...b])) {
    const removed = hunk.toA - hunk.fromA;
    const added = hunk.toB - hunk.fromB;
    if (removed === added) {
      for (let offset = 0; offset < removed; offset += 1) {
        const oldLine = a[hunk.fromA + offset];
        const newLine = b[hunk.fromB + offset];
        if (
          tokenizeWords(oldLine).length + tokenizeWords(newLine).length >
          MAX_DIFF_TOKENS_PER_PAIR
        ) {
          return null;
        }
        const segments = inlineWordDiff(oldLine, newLine);
        marksA[hunk.fromA + offset] = segments.filter((segment) => segment.type !== 'ins');
        marksB[hunk.fromB + offset] = segments.filter((segment) => segment.type !== 'del');
      }
      continue;
    }
    for (let index = hunk.fromA; index < hunk.toA; index += 1) {
      marksA[index] = [{ text: a[index], type: 'del' }];
    }
    for (let index = hunk.fromB; index < hunk.toB; index += 1) {
      marksB[index] = [{ text: b[index], type: 'ins' }];
    }
  }

  return { a: marksA, b: marksB };
}
