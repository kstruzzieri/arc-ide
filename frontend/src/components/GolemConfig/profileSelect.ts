/**
 * Pure §4.8 source model, consumed by the Source picker (#312). The picker
 * always names the current draft's source and never silently reverts: `value`
 * derives from the source ALONE, so a list refresh can repaint entries but can
 * never move the selection.
 */
import type { ActiveProfileProvenance, ApplySource, ProfileInfo } from '../../types/golemConfig';
import type { SettingsProjection } from '../../types/golem';

export type ProfileListState =
  | { kind: 'unloaded' }
  | { kind: 'loaded'; profiles: ProfileInfo[] }
  | { kind: 'limited'; profiles: ProfileInfo[] }
  | { kind: 'unavailable'; message: string };

/** Neither sentinel can collide with a ProfileID (both lack the namespace '/'). */
export const APPLIED_SOURCE_VALUE = 'applied';
export const BLANK_SOURCE_VALUE = '__blank__';

/** START FROM sentinels: profile ids contain '/' and never ':', so the prefix cannot collide. */
export const START_BLANK_VALUE = 'start:__blank__';
export const startFromValue = (profileId: string): string => `start:${profileId}`;
export const startFromProfileId = (value: string): string | null =>
  value.startsWith('start:') && value !== START_BLANK_VALUE ? value.slice('start:'.length) : null;

/** §5.6 bounded copy shared by the Source picker, the Save button, and the workspace. */
export const LIST_LIMITED_COPY = 'Too many profiles to display.';
export const TRANSPORT_UNAVAILABLE_COPY =
  'Configuration service unavailable. Refresh before trying again.';

export interface ProfileSelectOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface ProfileSelectModel {
  value: string;
  applied: ProfileSelectOption;
  blank: ProfileSelectOption | null;
  retained: ProfileSelectOption | null;
  curated: ProfileSelectOption[];
  yours: ProfileSelectOption[];
  description: string;
  /** Closed-trigger eyebrow (#312 ruling 3): the namespace of the selected profile. */
  group: 'Curated' | 'Yours' | '';
  /** START FROM group (#312): state-independent commands, built from ALL list rows. */
  startFrom: { blank: ProfileSelectOption; curated: ProfileSelectOption[] };
}

export interface BuildProfileSelectArgs {
  source: ApplySource;
  list: ProfileListState;
  provenance: ActiveProfileProvenance | null;
  appliedRevision?: string;
  state: SettingsProjection['state'] | null;
}

const slugOf = (id: string): string => id.slice(id.indexOf('/') + 1);

/**
 * §4.8: the picker's value is a pure function of the source alone. Shared by
 * the model below and by the workspace's `selectSource` handler so the two
 * can never hand-copy this mapping out of sync with each other (review
 * finding 3 on Task 6 — the duplicate ternary was a divergence hazard).
 */
export function sourceSelectValue(source: ApplySource): string {
  return source.kind === 'applied'
    ? APPLIED_SOURCE_VALUE
    : source.kind === 'blank'
      ? BLANK_SOURCE_VALUE
      : source.profileId;
}

export function buildProfileSelectModel(args: BuildProfileSelectArgs): ProfileSelectModel {
  const { source, list, provenance, appliedRevision, state } = args;

  const value = sourceSelectValue(source);

  // §4.8: ancestry renders on the Applied option, never as a separate control.
  // The modified marker needs BOTH revisions to compare honestly.
  const ancestry =
    provenance === null
      ? ''
      : ` — ${provenance.profileId}${
          appliedRevision !== undefined && appliedRevision !== provenance.appliedRevision
            ? ' · modified'
            : ''
        }`;
  const applied: ProfileSelectOption = {
    value: APPLIED_SOURCE_VALUE,
    label: state === 'missing' ? 'No applied configuration' : `Applied${ancestry}`,
    disabled: state === 'missing' && source.kind === 'applied',
  };

  const rows = list.kind === 'loaded' || list.kind === 'limited' ? list.profiles : [];
  // §4.8 (controller ruling): while Missing the picker shows ONLY the
  // applied-configuration-absent state — no Curated/Yours groups; the picker's
  // START FROM entries are the bootstrap. `listed` is what actually renders.
  const listed = state === 'missing' ? [] : rows;
  // §4.6: replacement is disabled while the document is Invalid or Limited;
  // ready edits it (missing lists nothing, so the bit never shows there).
  const optionsDisabled = state !== 'ready';
  const toOption = (row: ProfileInfo): ProfileSelectOption => ({
    value: row.id,
    label: slugOf(row.id),
    disabled: optionsDisabled,
  });
  const curated = listed.filter((row) => row.curated).map(toOption);
  const yours = listed.filter((row) => !row.curated).map(toOption);

  const blank: ProfileSelectOption | null =
    source.kind === 'blank'
      ? { value: BLANK_SOURCE_VALUE, label: 'Blank draft', disabled: false }
      : null;

  // §4.8: a selected profile absent from the RENDERED rows is retained as the
  // selected option — never a snap to a lie. The ` (unavailable)` marker
  // appears exactly when a proven list genuinely lacks it in its UNDERLYING
  // rows; a Missing-state staged source the list still carries, an
  // unloaded/unavailable list, OR a limited list, gets the bare slug —
  // `limited`'s rows are only the first maxProjectionEntries in ID order, so
  // a source past the cap EXISTS and is simply not shown, which proves
  // nothing about absence. Only a fully `loaded` list has scanned every row.
  // Either way the option is not re-choosable.
  let retained: ProfileSelectOption | null = null;
  if (source.kind === 'profile' && !listed.some((row) => row.id === source.profileId)) {
    const provenAbsent = list.kind === 'loaded' && !rows.some((row) => row.id === source.profileId);
    retained = {
      value: source.profileId,
      label: `${slugOf(source.profileId)}${provenAbsent ? ' (unavailable)' : ''}`,
      disabled: true,
    };
  }

  const description =
    source.kind === 'profile'
      ? (rows.find((row) => row.id === source.profileId)?.description ?? '')
      : '';

  const group: ProfileSelectModel['group'] =
    source.kind === 'profile'
      ? source.profileId.startsWith('curated/')
        ? 'Curated'
        : 'Yours'
      : '';
  // #312: START FROM is built from `rows`, not `listed` — the Missing state hides
  // selectable profiles, but the bootstrap commands are exactly what it needs.
  const startFrom = {
    blank: { value: START_BLANK_VALUE, label: 'Blank draft', disabled: false },
    curated: rows
      .filter((row) => row.curated)
      .map((row) => ({
        value: startFromValue(row.id),
        label: `Curated ${slugOf(row.id)}`,
        disabled: false,
      })),
  };
  return { value, applied, blank, retained, curated, yours, description, group, startFrom };
}
