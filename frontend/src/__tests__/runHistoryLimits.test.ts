import * as fs from 'fs';
import * as path from 'path';

/**
 * The frontend mirrors the Go store's retention and record limits so it can bound
 * its own maps and truncate output before it crosses the binding. Nothing else
 * enforces that the two agree, and drift is silent and user-visible: if Go
 * retains fewer rich records than the frontend does, the surplus tabs advertise
 * output the store has already redacted, and every click on one is a failed read.
 *
 * Both sides are read as text so this guard pulls in no Wails bindings.
 */
describe('run history limits match across the Go/TypeScript boundary', () => {
  // __dirname = frontend/src/__tests__
  const repoRoot = path.join(__dirname, '../../..');
  const read = (...parts: string[]) => fs.readFileSync(path.join(repoRoot, ...parts), 'utf-8');

  const goSource = read('internal', 'runhistory', 'store.go');
  const hookSource = read('frontend', 'src', 'hooks', 'useRunOutput.ts');
  const storeSource = read('frontend', 'src', 'stores', 'ideStore.ts');

  /**
   * Parses the two literal forms in play — a decimal (with optional `_`
   * separators) and a left shift — rather than evaluating the text, so an
   * expression this guard cannot read fails the test instead of running as code.
   */
  function literal(source: string, pattern: RegExp, label: string): number {
    const match = pattern.exec(source);
    if (!match) throw new Error(`${label} is no longer declared where this guard looks`);
    const value = match[1].replace(/_/g, '').trim();
    const shift = /^(\d+)\s*<<\s*(\d+)$/.exec(value);
    if (shift) return Number(shift[1]) * 2 ** Number(shift[2]);
    if (/^\d+$/.test(value)) return Number(value);
    throw new Error(`${label} is no longer a literal this guard can read: ${match[1]}`);
  }

  const goConst = (name: string) =>
    literal(goSource, new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm'), `Go ${name}`);
  const tsConst = (source: string, name: string) =>
    literal(source, new RegExp(`\\bconst ${name}\\s*=\\s*(.+?);`), `TypeScript ${name}`);

  it.each([
    ['maxSummaries', () => tsConst(storeSource, 'MAX_RUN_HISTORY_SUMMARIES')],
    ['maxRichRecords', () => tsConst(storeSource, 'MAX_RICH_RUN_HISTORY_RECORDS')],
    ['maxEntries', () => tsConst(hookSource, 'HISTORY_MAX_ENTRIES')],
    ['maxRecordBytes', () => tsConst(hookSource, 'HISTORY_MAX_RECORD_BYTES')],
  ])('Go %s matches its TypeScript mirror', (goName, readTypeScript) => {
    expect(readTypeScript()).toBe(goConst(goName));
  });

  it('reserves the same record envelope headroom the Go builder does', () => {
    // buildRecord: remaining := maxRecordBytes - len(empty) - 1024
    const reserve = /remaining\s*:=\s*maxRecordBytes\s*-\s*len\(empty\)\s*-\s*(\d+)/.exec(goSource);
    expect(reserve).not.toBeNull();
    expect(tsConst(hookSource, 'HISTORY_RECORD_RESERVE_BYTES')).toBe(Number(reserve?.[1]));
  });

  it('is not vacuous: every name it guards still resolves', () => {
    // A rename on either side would otherwise make the assertions above silently
    // unreachable rather than failing.
    for (const name of ['maxSummaries', 'maxRichRecords', 'maxEntries', 'maxRecordBytes']) {
      expect(() => goConst(name)).not.toThrow();
    }
    expect(() => tsConst(storeSource, 'MAX_RUN_HISTORY_SUMMARIES')).not.toThrow();
    expect(() => tsConst(hookSource, 'HISTORY_MAX_RECORD_BYTES')).not.toThrow();
  });
});
