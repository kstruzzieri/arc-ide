// jest maps '@wailsio/runtime' to src/__mocks__/wailsV3Runtime.js, and the
// generated bindings run its Create functions for real -- so every suite that
// parses a generated class instance is only as faithful as that copy. This
// holds the copy against the shipped dist/create.js, case for case, including
// the two an earlier looser mock got wrong: a non-array through Array (it threw
// instead of passing the source back) and an empty array through Map (it
// returned {} instead of the array).

type CreateFn = (source: never) => unknown;

interface CreateModule {
  Any: CreateFn;
  ByteSlice: CreateFn;
  Array: (element: CreateFn) => CreateFn;
  Map: (key: CreateFn, value: CreateFn) => CreateFn;
  Nullable: (element: CreateFn) => CreateFn;
  Struct: (fields: Record<string, CreateFn>) => CreateFn;
  DateFromTime: CreateFn;
}

// By file path, not by package name: the package name is mapped to the mock,
// and '@wailsio/runtime/dist/create.js' is not an exported subpath.
const shipped = require('../../../node_modules/@wailsio/runtime/dist/create.js') as CreateModule;
const mock = (require('../../__mocks__/wailsV3Runtime') as { Create: CreateModule }).Create;

const TIME = '2026-01-02T03:04:05Z';

// Each case builds its own source: the shipped functions convert in place.
const cases: [string, (create: CreateModule) => unknown][] = [
  ['Any returns its source', (c) => c.Any({ a: 1 } as never)],
  ['ByteSlice replaces null with an empty string', (c) => c.ByteSlice(null as never)],
  ['ByteSlice passes a string through', (c) => c.ByteSlice('AA==' as never)],
  ['Array(Any) turns null into an empty array', (c) => c.Array(c.Any)(null as never)],
  ['Array converts elements in place', (c) => c.Array(c.DateFromTime)([TIME] as never)],
  ['Array returns a non-array source unchanged', (c) => c.Array(c.DateFromTime)({ a: 1 } as never)],
  ['Map(Any, Any) turns null into an empty object', (c) => c.Map(c.Any, c.Any)(null as never)],
  [
    'Map converts values in place',
    (c) => c.Map(c.Any, c.DateFromTime)({ at: TIME, other: TIME } as never),
  ],
  ['Map returns an empty array unchanged', (c) => c.Map(c.Any, c.DateFromTime)([] as never)],
  ['Nullable keeps null null', (c) => c.Nullable(c.DateFromTime)(null as never)],
  ['Nullable converts a present value', (c) => c.Nullable(c.DateFromTime)(TIME as never)],
  [
    'Struct converts declared fields only',
    (c) => c.Struct({ at: c.DateFromTime })({ at: TIME, other: TIME } as never),
  ],
  [
    'Struct leaves an absent field absent',
    (c) => c.Struct({ at: c.DateFromTime })({ other: TIME } as never),
  ],
  [
    'Struct of only Any fields passes the source through',
    (c) => c.Struct({ a: c.Any })(1 as never),
  ],
  ['DateFromTime parses an RFC3339 string', (c) => c.DateFromTime(TIME as never)],
];

describe('the @wailsio/runtime mock mirrors the shipped Create', () => {
  it.each(cases)('%s', (_name, run) => {
    expect(run(mock)).toStrictEqual(run(shipped));
  });
});
