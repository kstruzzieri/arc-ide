import fs from 'fs';
import path from 'path';
import * as bindings from '../../wails/bindings';
import { GOLEM_RAW_CALL_IDS } from '../../wails/bindings';
import { GolemContractError, parseSettingsProjection } from '../../types/golem';
import {
  parseCancelSettingsApplyResult,
  parseConfirmSettingsApplyRequest,
  parseGolemProfileListResult,
  parseGolemProfileLoadResult,
  parseGolemProfileSaveResult,
  parseSaveGolemProfileAsRequest,
  parseSettingsApplyRequest,
  parseSettingsApplyResult,
  type ApplyMode,
} from '../../types/golemConfig';

// The adapter's '@wailsio/runtime' import is mapped to this file, so requiring
// it by path yields the same module instance -- and by path rather than by
// package name so the "only the adapters know v3" guard stays green.
const v3 = require('../../__mocks__/wailsV3Runtime');

const GENERATED = fs.readFileSync(path.resolve(__dirname, '../../../bindings/firn/app.ts'), 'utf8');

type RawCallName = keyof typeof GOLEM_RAW_CALL_IDS;
const rawCallNames = Object.keys(GOLEM_RAW_CALL_IDS) as RawCallName[];

// One generated binding: its name and the source text from `export function`
// up to the next one, so a `$Call.ByID` literal is always read out of the body
// it belongs to.
type GeneratedFunction = { name: string; body: string };

const generatedFunctions = (): GeneratedFunction[] => {
  const heads: Array<{ name: string; index: number }> = [];
  const re = /^export function (\w+)\(/gm;
  for (let m = re.exec(GENERATED); m !== null; m = re.exec(GENERATED)) {
    heads.push({ name: m[1], index: m.index });
  }
  return heads.map((head, i) => ({
    name: head.name,
    body: GENERATED.slice(head.index, i + 1 < heads.length ? heads[i + 1].index : GENERATED.length),
  }));
};

const generated = generatedFunctions();
const generatedByName = new Map(generated.map((fn) => [fn.name, fn]));

// A generated call converts its result when it pipes it through a
// `$$createTypeN` helper -- exactly the lossy step the raw routing exists to
// skip.
const isObjectReturning = (fn: GeneratedFunction): boolean => /\$\$createType\d+\(/.test(fn.body);

// The invariant the raw routing rests on is about the RETURN TYPE, not the
// method name: every generated binding that resolves with an `ai$0.*` class is
// a wire-contract document the validators must see untouched. Candidates are
// therefore every binding whose signature says `$CancellablePromise<ai$0.`,
// plus every Golem-NAMED one so a call that stops returning an ai type (or is
// renamed out of the ai package) still cannot drop out of the set unnoticed.
const golemFunctions = generated.filter(
  (fn) => fn.name.includes('Golem') || /\$CancellablePromise<ai\$0\./.test(fn.body)
);

describe('generated Golem call ids', () => {
  it('finds the generated bindings', () => {
    expect(generated.length).toBeGreaterThan(50);
  });

  it.each(rawCallNames)('%s mirrors the generated $Call.ByID literal', (name) => {
    const fn = generatedByName.get(name);
    expect(fn).toBeDefined();
    const id = /\$Call\.ByID\((\d+)/.exec(fn!.body);
    expect(id).not.toBeNull();
    expect(Number(id![1])).toBe(GOLEM_RAW_CALL_IDS[name]);
  });

  it('routes every object-returning Golem call raw, and only those', () => {
    const converting = golemFunctions.filter(isObjectReturning).map((fn) => fn.name);
    expect(converting.slice().sort()).toEqual(rawCallNames.slice().sort());
  });

  // CancelGolemRun resolves with a bare boolean: `$CancellablePromise<boolean>`
  // with no `$$createType` in its body, so nothing is constructed and the plain
  // re-export is already wire-faithful.
  it('leaves the primitive-returning Golem call as a plain re-export', () => {
    const cancelRun = generatedByName.get('CancelGolemRun');
    expect(cancelRun).toBeDefined();
    expect(isObjectReturning(cancelRun!)).toBe(false);
    expect(rawCallNames).not.toContain('CancelGolemRun');
  });
});

describe('adapter routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Each entry is one adapter export and the arguments a caller passes it.
  const routes: Array<[RawCallName, unknown[]]> = [
    ['ApplyGolemSettings', [{ request: 'apply' }]],
    ['BootstrapGolemWindow', []],
    ['CancelGolemSettingsApply', ['challenge-token']],
    ['ConfirmGolemDestinationGrants', ['challenge-token']],
    ['ConfirmGolemSettingsApply', [{ request: 'confirm' }]],
    ['CreateGolemSettings', [{ request: 'create' }]],
    ['GetGolemSettings', []],
    ['GetGolemStatus', [{ request: 'status' }]],
    ['GetGolemWindowState', []],
    ['ListGolemProfiles', []],
    ['LoadGolemProfile', ['profile-id']],
    ['PrepareGolemDestinationGrants', []],
    ['ReloadGolemSettings', []],
    ['RunGolemTurn', [{ request: 'turn' }]],
    ['SaveGolemProfileAs', [{ request: 'save-as' }]],
  ];

  it.each(routes)('%s calls ByID with its id and returns the payload as-is', async (name, args) => {
    const payload = { marker: name, nested: { collections: null }, list: null };
    v3.Call.ByID.mockReturnValueOnce(v3.CancellablePromise.resolve(payload));

    const call = (bindings as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
      name
    ];
    const promise = call(...args);

    expect(v3.Call.ByID).toHaveBeenCalledTimes(1);
    expect(v3.Call.ByID).toHaveBeenCalledWith(GOLEM_RAW_CALL_IDS[name], ...args);
    // Arguments forwarded by reference, not copied through a constructor.
    v3.Call.ByID.mock.calls[0].slice(1).forEach((forwarded: unknown, i: number) => {
      expect(forwarded).toBe(args[i]);
    });
    // The runtime's cancellable promise, not a plain Promise wrapper. The
    // identity check is what rules out a `.then()` chain: CancellablePromise
    // extends Promise, so a derived promise would still satisfy both the
    // instanceof and the `cancel` probe below.
    expect(promise).toBe(v3.Call.ByID.mock.results[0].value);
    expect(promise).toBeInstanceOf(v3.CancellablePromise);
    expect(typeof (promise as unknown as { cancel: unknown }).cancel).toBe('function');
    // The very object the call resolved with: no copy, no createFrom repair.
    await expect(promise).resolves.toBe(payload);
    expect(payload.list).toBeNull();
    expect(payload.nested.collections).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The boundary proof: every fixture in the two shared corpora, replayed on the
// live seam. The mocked transport resolves with the fixture's raw JSON, the
// adapter export is awaited, and the result goes to the validator production
// applies to that call. Verdicts come from the file name alone, so a seam that
// repaired or defaulted anything would flip a reject fixture to accept.
// ---------------------------------------------------------------------------

const projectionCorpus = path.resolve(
  __dirname,
  '../../../../internal/ai/testdata/settings_contract'
);
const applyCorpus = path.resolve(
  __dirname,
  '../../../../internal/ai/testdata/settings_apply_contract'
);

type ApplyFixture = { document: string; mode?: string; value: unknown };

const jsonFiles = (dir: string): string[] =>
  fs.readdirSync(dir).filter((file) => file.endsWith('.json'));

const readJson = (dir: string, file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as unknown;

const fixtureMode = (fixture: ApplyFixture): ApplyMode => {
  if (fixture.mode !== 'apply' && fixture.mode !== 'create') {
    throw new GolemContractError();
  }
  return fixture.mode;
};

// The seam under test plus the validator that reads its result. Request
// documents never arrive AS a result, so they ride the export that carries
// them; what the leg proves for those is that the seam is byte-transparent,
// with the same request parsers the golemConfig corpus test uses.
const replay = async (document: string, fixture: ApplyFixture, payload: unknown): Promise<void> => {
  v3.Call.ByID.mockReturnValueOnce(v3.CancellablePromise.resolve(payload));
  switch (document) {
    case 'projection':
      parseSettingsProjection(await bindings.GetGolemSettings());
      return;
    case 'apply_request': {
      const mode = fixtureMode(fixture);
      const raw = await (mode === 'create'
        ? bindings.CreateGolemSettings(payload as never)
        : bindings.ApplyGolemSettings(payload as never));
      parseSettingsApplyRequest(raw, mode);
      return;
    }
    case 'confirm_request': {
      const mode = fixtureMode(fixture);
      parseConfirmSettingsApplyRequest(
        await bindings.ConfirmGolemSettingsApply(payload as never),
        mode
      );
      return;
    }
    case 'apply_result':
      parseSettingsApplyResult(await bindings.ApplyGolemSettings(payload as never));
      return;
    case 'cancel_result':
      parseCancelSettingsApplyResult(await bindings.CancelGolemSettingsApply('token'));
      return;
    case 'profile_load_result':
      parseGolemProfileLoadResult(await bindings.LoadGolemProfile('profile'));
      return;
    case 'profile_list_result':
      parseGolemProfileListResult(await bindings.ListGolemProfiles());
      return;
    case 'profile_save_request':
      parseSaveGolemProfileAsRequest(await bindings.SaveGolemProfileAs(payload as never));
      return;
    case 'profile_save_result':
      parseGolemProfileSaveResult(await bindings.SaveGolemProfileAs(payload as never));
      return;
    default:
      throw new Error(`unknown document ${document}`);
  }
};

const expectVerdict = async (file: string, run: () => Promise<void>): Promise<void> => {
  if (file.startsWith('accept-')) {
    await expect(run()).resolves.toBeUndefined();
  } else if (file.startsWith('reject-')) {
    await expect(run()).rejects.toBeInstanceOf(GolemContractError);
  } else {
    throw new Error(`${file}: name carries no accept-/reject- verdict`);
  }
};

describe('contract corpora on the live adapter seam', () => {
  // A fixture whose `mode` is missing or invalid throws in fixtureMode BEFORE
  // the call, so without this its queued payload would be consumed by the next
  // fixture and that one would pass for the wrong reason.
  beforeEach(() => {
    v3.Call.ByID.mockReset();
  });

  const projectionFiles = jsonFiles(projectionCorpus);
  const applyFiles = jsonFiles(applyCorpus);

  it('both corpora are present', () => {
    expect(projectionFiles.length).toBeGreaterThanOrEqual(100);
    expect(applyFiles.length).toBeGreaterThanOrEqual(100);
  });

  it.each(projectionFiles)('settings_contract/%s keeps its verdict', async (file) => {
    const { projection } = readJson(projectionCorpus, file) as { projection: unknown };
    await expectVerdict(file, () =>
      replay('projection', { document: 'projection', value: projection }, projection)
    );
  });

  it.each(applyFiles)('settings_apply_contract/%s keeps its verdict', async (file) => {
    const fixture = readJson(applyCorpus, file) as ApplyFixture;
    await expectVerdict(file, () => replay(fixture.document, fixture, fixture.value));
  });
});
