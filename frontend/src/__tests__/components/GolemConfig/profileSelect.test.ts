import {
  APPLIED_SOURCE_VALUE,
  BLANK_SOURCE_VALUE,
  START_BLANK_VALUE,
  buildProfileSelectModel,
  startFromProfileId,
  startFromValue,
  type ProfileListState,
} from '../../../components/GolemConfig/profileSelect';
import type { ProfileInfo } from '../../../types/golemConfig';

const REV_A = 'a'.repeat(64);
const REV_B = 'b'.repeat(64);

const loadedList: ProfileListState = {
  kind: 'loaded',
  profiles: [
    { id: 'curated/local', description: 'Vetted local lineup', curated: true, revision: REV_A },
    { id: 'user/mine', curated: false },
  ],
};

describe('buildProfileSelectModel', () => {
  it('derives the value from the source alone', () => {
    const base = {
      list: loadedList,
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready' as const,
    };
    expect(buildProfileSelectModel({ ...base, source: { kind: 'applied' } }).value).toBe(
      APPLIED_SOURCE_VALUE
    );
    expect(buildProfileSelectModel({ ...base, source: { kind: 'blank' } }).value).toBe(
      BLANK_SOURCE_VALUE
    );
    expect(
      buildProfileSelectModel({
        ...base,
        source: { kind: 'profile', profileId: 'user/mine', sourceRevision: REV_B },
      }).value
    ).toBe('user/mine');
  });

  it('a list refresh never changes the selected source', () => {
    const source = { kind: 'profile', profileId: 'user/mine', sourceRevision: REV_B } as const;
    const before = buildProfileSelectModel({
      source,
      list: { kind: 'unloaded' },
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready',
    });
    const after = buildProfileSelectModel({
      source,
      list: loadedList,
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready',
    });
    expect(before.value).toBe('user/mine');
    expect(after.value).toBe('user/mine');
  });

  it('renders ancestry on the applied option, with the modified marker on divergence', () => {
    const provenance = { version: 1 as const, profileId: 'user/mine', appliedRevision: REV_A };
    const same = buildProfileSelectModel({
      source: { kind: 'applied' },
      list: loadedList,
      provenance,
      appliedRevision: REV_A,
      state: 'ready',
    });
    expect(same.applied.label).toBe('Applied — user/mine');
    const diverged = buildProfileSelectModel({
      source: { kind: 'applied' },
      list: loadedList,
      provenance,
      appliedRevision: REV_B,
      state: 'ready',
    });
    expect(diverged.applied.label).toBe('Applied — user/mine · modified');
  });

  it('shows only the applied-absent state while Missing: no optgroup rows at all', () => {
    const model = buildProfileSelectModel({
      source: { kind: 'applied' },
      list: loadedList,
      provenance: null,
      state: 'missing',
    });
    expect(model.applied.label).toBe('No applied configuration');
    // §4.8: bootstrap goes through the menu's Start actions, never the select.
    expect(model.curated).toEqual([]);
    expect(model.yours).toEqual([]);
    expect(model.retained).toBeNull();
    expect(model.blank).toBeNull();
  });

  it('a Start-staged draft while Missing still names its source, optgroups stay absent', () => {
    const staged = buildProfileSelectModel({
      source: { kind: 'profile', profileId: 'curated/local', sourceRevision: REV_A },
      list: loadedList,
      provenance: null,
      state: 'missing',
    });
    expect(staged.value).toBe('curated/local');
    expect(staged.curated).toEqual([]);
    expect(staged.yours).toEqual([]);
    // The bare slug, disabled, WITHOUT the unavailable marker: the list still
    // carries curated/local, so nothing proved absence — the option only
    // represents the staged source truthfully.
    expect(staged.retained).toEqual({ value: 'curated/local', label: 'local', disabled: true });
    expect(staged.description).toBe('Vetted local lineup');

    const blank = buildProfileSelectModel({
      source: { kind: 'blank' },
      list: loadedList,
      provenance: null,
      state: 'missing',
    });
    expect(blank.value).toBe(BLANK_SOURCE_VALUE);
    expect(blank.blank).toEqual({
      value: BLANK_SOURCE_VALUE,
      label: 'Blank draft',
      disabled: false,
    });
    expect(blank.curated).toEqual([]);
  });

  it('lists the blank draft option only while the draft is blank', () => {
    const blank = buildProfileSelectModel({
      source: { kind: 'blank' },
      list: loadedList,
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready',
    });
    expect(blank.blank).toEqual({
      value: BLANK_SOURCE_VALUE,
      label: 'Blank draft',
      disabled: false,
    });
    // Rule 8: a non-profile source yields '' even against a populated list —
    // the description is never borrowed from the list's first row.
    expect(blank.description).toBe('');
    const applied = buildProfileSelectModel({
      source: { kind: 'applied' },
      list: loadedList,
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready',
    });
    expect(applied.blank).toBeNull();
    expect(applied.description).toBe('');
  });

  it('groups curated and user rows by slug and surfaces the selected description', () => {
    const model = buildProfileSelectModel({
      source: { kind: 'profile', profileId: 'curated/local', sourceRevision: REV_A },
      list: loadedList,
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready',
    });
    expect(model.curated).toEqual([{ value: 'curated/local', label: 'local', disabled: false }]);
    expect(model.yours).toEqual([{ value: 'user/mine', label: 'mine', disabled: false }]);
    expect(model.description).toBe('Vetted local lineup');
    // Rule 7: the selected profile IS present in the rendered rows, so
    // `retained` must be null — the "exactly when absent" half of the rule.
    expect(model.retained).toBeNull();
  });

  it('disables profile options while the projection is Invalid or Limited', () => {
    for (const state of ['invalid', 'limited'] as const) {
      const model = buildProfileSelectModel({
        source: { kind: 'applied' },
        list: loadedList,
        provenance: null,
        state,
      });
      expect(model.curated[0].disabled).toBe(true);
      expect(model.yours[0].disabled).toBe(true);
    }
  });

  it('retains a selected profile missing from a refreshed list, marked unavailable', () => {
    const model = buildProfileSelectModel({
      source: { kind: 'profile', profileId: 'user/gone', sourceRevision: REV_B },
      list: loadedList,
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready',
    });
    expect(model.value).toBe('user/gone');
    expect(model.retained).toEqual({
      value: 'user/gone',
      label: 'gone (unavailable)',
      disabled: true,
    });
  });

  // Fix for the review finding: `limited`'s rows are only the first
  // maxProjectionEntries in ID order — a source past the cap EXISTS and is
  // simply not shown, so a limited list proves nothing about absence. Only a
  // fully `loaded` list (the test above) may earn the marker.
  it('retains a selected profile missing from a LIMITED list without the marker', () => {
    const limitedList: ProfileListState = { kind: 'limited', profiles: loadedList.profiles };
    const model = buildProfileSelectModel({
      source: { kind: 'profile', profileId: 'user/gone', sourceRevision: REV_B },
      list: limitedList,
      provenance: null,
      appliedRevision: REV_A,
      state: 'ready',
    });
    expect(model.value).toBe('user/gone');
    expect(model.retained).toEqual({
      value: 'user/gone',
      label: 'gone',
      disabled: true,
    });
  });

  it('retains the selected profile without the marker while the list is unproven', () => {
    for (const list of [
      { kind: 'unloaded' } as const,
      { kind: 'unavailable', message: 'x' } as const,
    ]) {
      const model = buildProfileSelectModel({
        source: { kind: 'profile', profileId: 'user/mine', sourceRevision: REV_B },
        list,
        provenance: null,
        appliedRevision: REV_A,
        state: 'ready',
      });
      expect(model.retained).toEqual({ value: 'user/mine', label: 'mine', disabled: true });
    }
  });
});

describe('picker groups (#312)', () => {
  const rows: ProfileInfo[] = [
    { id: 'curated/local', curated: true, description: 'Vetted local lineup' },
    { id: 'user/local', curated: false },
    { id: 'user/cloud', curated: false },
  ];
  const list = { kind: 'loaded' as const, profiles: rows };

  it('names the selected profile group for the closed trigger', () => {
    const user = buildProfileSelectModel({
      source: { kind: 'profile', profileId: 'user/local', sourceRevision: 'r' },
      list,
      provenance: null,
      appliedRevision: 'a',
      state: 'ready',
    });
    expect(user.group).toBe('Yours');
    const curated = buildProfileSelectModel({
      source: { kind: 'profile', profileId: 'curated/local', sourceRevision: 'r' },
      list,
      provenance: null,
      appliedRevision: 'a',
      state: 'ready',
    });
    expect(curated.group).toBe('Curated');
    const applied = buildProfileSelectModel({
      source: { kind: 'applied' },
      list,
      provenance: null,
      appliedRevision: 'a',
      state: 'ready',
    });
    expect(applied.group).toBe('');
  });

  it('always offers START FROM: Blank draft plus one entry per curated row', () => {
    const model = buildProfileSelectModel({
      source: { kind: 'applied' },
      list,
      provenance: null,
      appliedRevision: 'a',
      state: 'ready',
    });
    expect(model.startFrom.blank).toEqual({
      value: START_BLANK_VALUE,
      label: 'Blank draft',
      disabled: false,
    });
    expect(model.startFrom.curated).toEqual([
      { value: startFromValue('curated/local'), label: 'Curated local', disabled: false },
    ]);
    expect(startFromProfileId(startFromValue('curated/local'))).toBe('curated/local');
    expect(startFromProfileId('curated/local')).toBeNull();
  });

  it('while Missing lists no profiles but keeps START FROM and disables the current entry', () => {
    const model = buildProfileSelectModel({
      source: { kind: 'applied' },
      list,
      provenance: null,
      appliedRevision: undefined,
      state: 'missing',
    });
    expect(model.curated).toEqual([]);
    expect(model.yours).toEqual([]);
    expect(model.applied).toEqual({
      value: APPLIED_SOURCE_VALUE,
      label: 'No applied configuration',
      disabled: true,
    });
    expect(model.startFrom.curated).toHaveLength(1);
  });
});
