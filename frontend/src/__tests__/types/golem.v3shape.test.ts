import fs from 'fs';
import path from 'path';
import { ai } from '../../wails/bindings';
import { GolemContractError, parseSettingsProjection } from '../../types/golem';
import {
  parseCancelSettingsApplyResult,
  parseConfirmSettingsApplyRequest,
  parseGolemProfileLoadResult,
  parseSettingsApplyRequest,
  parseSettingsApplyResult,
  type ApplyMode,
} from '../../types/golemConfig';

// The Golem INBOUND path no longer goes through `createFrom`: the nine
// object-returning Golem calls are read raw in src/wails/bindings.ts so the
// validators see the untouched wire payload, and
// src/__tests__/wails/golemRawCalls.test.ts is the guard for that routing.
//
// So no live production path feeds a generated instance to these validators
// any more: the only `new ai.*` sites in src are the outbound StatusRequest /
// TurnRequest / RunIdentity builders in src/types/golem.ts, and nothing parses
// one back. This file is therefore a standing REGRESSION PIN, not a test of a
// path production walks today. It holds two properties:
//
//   - parsing a generated class instance must equal parsing the same payload
//     as plain JSON. tsconfig sets useDefineForClassFields, so every declared
//     optional field ("revision"?: string) is an OWN property valued
//     `undefined` on an instance -- absent on the wire, present to
//     Object.hasOwn. This is what would have to hold if the raw routing were
//     ever reverted, or if a builder result were ever re-parsed.
//   - the last test records WHY the inbound calls are routed raw, and fails
//     loudly if the generator ever stops injecting defaults.

const projectionCorpus = path.resolve(
  __dirname,
  '../../../../internal/ai/testdata/settings_contract'
);
const applyCorpus = path.resolve(
  __dirname,
  '../../../../internal/ai/testdata/settings_apply_contract'
);

type ProjectionFixture = { verdict: string; projection: Record<string, unknown> };
type ApplyFixture = { verdict: string; document: string; mode?: string; value: unknown };

// createFrom rewrites nested members on the object it is handed, so every call
// site gets its own copy -- and the copy is the exact JSON the wire would carry.
const wireCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const readFixture = <T>(dir: string, file: string): T =>
  JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as T;

const acceptFiles = (dir: string): string[] =>
  fs.readdirSync(dir).filter((file) => file.startsWith('accept-') && file.endsWith('.json'));

const fixtureMode = (fixture: ApplyFixture): ApplyMode => {
  if (fixture.mode !== 'apply' && fixture.mode !== 'create') {
    throw new Error(`${fixture.document}: unknown mode ${JSON.stringify(fixture.mode)}`);
  }
  return fixture.mode;
};

const parseDocument = (fixture: ApplyFixture, value: unknown): unknown => {
  switch (fixture.document) {
    case 'apply_request':
      return parseSettingsApplyRequest(value, fixtureMode(fixture));
    case 'confirm_request':
      return parseConfirmSettingsApplyRequest(value, fixtureMode(fixture));
    case 'apply_result':
      return parseSettingsApplyResult(value);
    case 'cancel_result':
      return parseCancelSettingsApplyResult(value);
    case 'profile_load_result':
      return parseGolemProfileLoadResult(value);
    default:
      throw new Error(`unknown document ${fixture.document}`);
  }
};

const instantiate = (fixture: ApplyFixture): unknown => {
  const source = wireCopy(fixture.value);
  switch (fixture.document) {
    case 'apply_request':
      return ai.SettingsApplyRequest.createFrom(source);
    case 'confirm_request':
      return ai.ConfirmSettingsApplyRequest.createFrom(source);
    case 'apply_result':
      return ai.SettingsApplyResult.createFrom(source);
    case 'cancel_result':
      return ai.CancelSettingsApplyResult.createFrom(source);
    case 'profile_load_result':
      return ai.GolemProfileLoadResult.createFrom(source);
    default:
      throw new Error(`unknown document ${fixture.document}`);
  }
};

describe('v3 generated class instances at the Golem boundary', () => {
  it('carries an absent optional as an own key valued undefined', () => {
    const fixture = readFixture<ProjectionFixture>(projectionCorpus, 'accept-missing-state.json');
    expect(Object.hasOwn(fixture.projection, 'revision')).toBe(false);

    const instance = ai.SettingsProjection.createFrom(wireCopy(fixture.projection));
    expect(Object.hasOwn(instance, 'revision')).toBe(true);
    expect(instance.revision).toBeUndefined();
  });

  describe('settings projection corpus', () => {
    const files = acceptFiles(projectionCorpus);

    it('has accept fixtures', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)('%s parses the same as a SettingsProjection instance', (file) => {
      const fixture = readFixture<ProjectionFixture>(projectionCorpus, file);
      const fromWire = parseSettingsProjection(wireCopy(fixture.projection));
      const instance = ai.SettingsProjection.createFrom(wireCopy(fixture.projection));

      expect(parseSettingsProjection(instance)).toStrictEqual(fromWire);
    });
  });

  describe('settings apply corpus', () => {
    const files = acceptFiles(applyCorpus);

    it('has accept fixtures', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)('%s parses the same as a generated instance', (file) => {
      const fixture = readFixture<ApplyFixture>(applyCorpus, file);
      const fromWire = parseDocument(fixture, wireCopy(fixture.value));
      const instance = instantiate(fixture);

      expect(parseDocument(fixture, instance)).toStrictEqual(fromWire);
    });
  });

  // The defect the raw routing exists to close: the generated constructor
  // DEFAULTS a missing required field, so a payload the contract rejects comes
  // out of createFrom indistinguishable from a valid one -- here, a settings
  // document with no `readOnly` key materialises as an EDITABLE surface, and
  // `readOnly` is a fail-closed UI control.
  it('repairs a reject fixture when the payload goes through createFrom', () => {
    const fixture = readFixture<ProjectionFixture>(
      projectionCorpus,
      'reject-readonly-missing.json'
    );
    expect(Object.hasOwn(fixture.projection, 'readOnly')).toBe(false);
    expect(() => parseSettingsProjection(wireCopy(fixture.projection))).toThrow(GolemContractError);

    const repaired = ai.SettingsProjection.createFrom(wireCopy(fixture.projection));
    expect(parseSettingsProjection(repaired).readOnly).toBe(false);
  });
});
