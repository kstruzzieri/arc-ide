import * as bindings from '../../wails/bindings';
// v2-api-names.json is the frozen inventory of the method names the v2 build
// exposed. This pair of assertions is the S6 parity guard and is kept
// deliberately, past the #273 migration: it is what proves the v3 adapter
// still offers exactly that surface -- nothing dropped in the port, nothing
// silently added without the inventory being updated on purpose.
import names from './v2-api-names.json';

it('adapter exports every v2-bound method name', () => {
  const missing = (names as string[]).filter(
    (n) => typeof (bindings as Record<string, unknown>)[n] !== 'function'
  );
  expect(missing).toEqual([]);
});

it('no binding function missing from the inventory', () => {
  const extra = Object.keys(bindings).filter(
    (k) =>
      typeof (bindings as Record<string, unknown>)[k] === 'function' &&
      !(names as string[]).includes(k)
  );
  expect(extra).toEqual([]);
});
