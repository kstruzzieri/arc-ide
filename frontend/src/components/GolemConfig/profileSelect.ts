/**
 * Pure §4.8 profile-select model. The select always names the current draft's
 * source and never silently reverts: `value` derives from the source ALONE,
 * so a list refresh can repaint options but can never move the selection.
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

/** §5.6 bounded copy shared by the select, the menu, and the workspace. */
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
}

export interface BuildProfileSelectArgs {
  source: ApplySource;
  list: ProfileListState;
  provenance: ActiveProfileProvenance | null;
  appliedRevision?: string;
  state: SettingsProjection['state'] | null;
}

const slugOf = (id: string): string => id.slice(id.indexOf('/') + 1);

export function buildProfileSelectModel(args: BuildProfileSelectArgs): ProfileSelectModel {
  const { source, list, provenance, appliedRevision, state } = args;

  const value =
    source.kind === 'applied'
      ? APPLIED_SOURCE_VALUE
      : source.kind === 'blank'
        ? BLANK_SOURCE_VALUE
        : source.profileId;

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
    label: state === 'missing' ? 'No applied configuration' : `Applied configuration${ancestry}`,
    disabled: false,
  };

  const rows = list.kind === 'loaded' || list.kind === 'limited' ? list.profiles : [];
  // §4.8 (controller ruling): while Missing the select shows ONLY the
  // applied-configuration-absent state — no curated/user optgroups; the menu's
  // Start actions are the bootstrap. `listed` is what actually renders.
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
  // rows; a Missing-state staged source the list still carries, or an
  // unloaded/unavailable list, gets the bare slug — nothing proved absence.
  // Either way the option is not re-choosable.
  let retained: ProfileSelectOption | null = null;
  if (source.kind === 'profile' && !listed.some((row) => row.id === source.profileId)) {
    const provenAbsent =
      (list.kind === 'loaded' || list.kind === 'limited') &&
      !rows.some((row) => row.id === source.profileId);
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

  return { value, applied, blank, retained, curated, yours, description };
}
