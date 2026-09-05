// Single stable import surface for the generated v3 bindings.
import { Call, type CancellablePromise } from '@wailsio/runtime';
import type {
  ConfirmSettingsApplyRequest,
  SettingsApplyRequest,
  StatusRequest,
  TurnRequest,
} from '../../bindings/firn/internal/ai/models';

export * from '../../bindings/firn/app';
export * as ai from '../../bindings/firn/internal/ai/models';
export * as filesystem from '../../bindings/firn/internal/filesystem/models';
export * as git from '../../bindings/firn/internal/git/models';
export * as lsp from '../../bindings/firn/internal/lsp/models';
export * as main from '../../bindings/firn/models';
export * as runhistory from '../../bindings/firn/internal/runhistory/models';
export * as runprofile from '../../bindings/firn/internal/runprofile/models';
export * as search from '../../bindings/firn/internal/search/models';
export * as workspace from '../../bindings/firn/internal/workspace/models';

/**
 * The one deliberate exception to this adapter's "direct re-exports only" rule.
 *
 * WHY: every object-returning Golem binding in bindings/firn/app.ts pipes its
 * result through a generated `createFrom` before handing it back, and that
 * transformation is LOSSY in exactly the two ways the Golem wire contract
 * cares about. The generated constructors DEFAULT a missing required field
 * (`if (!("readOnly" in $$source)) this["readOnly"] = false;`), and the pinned
 * runtime's `$Create.Array` / `$Create.Map` rewrite a null collection to `[]` /
 * `{}`. A malformed payload therefore arrives indistinguishable from a valid
 * one — worst case, a settings document with no `readOnly` key materialises as
 * an EDITABLE surface, and `readOnly` is a fail-closed UI control. So these
 * eleven calls are read raw and the wire payload reaches the validators
 * untouched.
 *
 * IDS: mirrored from the generated bindings, not invented here.
 * src/__tests__/wails/golemRawCalls.test.ts pins every entry against the
 * `$Call.ByID(...)` literal inside the matching generated function, and fails
 * when a regeneration renumbers one, a rename moves one, or a NEW
 * object-returning binding appears that is not routed raw. That guard keys on
 * the generated RETURN TYPE, not on the name: its candidates are every binding
 * whose signature says `$CancellablePromise<ai$0.` plus every Golem-named one,
 * so a future `GetAgentStatus(): $CancellablePromise<ai$0.Status>` is caught
 * even though nothing about it says "Golem". ByID rather than
 * ByName because this repo ships obfuscated builds (build/Taskfile.yml), where
 * reflection-visible method names are gone but the numeric ids are stable.
 *
 * CONSUMERS: the results are typed `unknown` on purpose. The `parse*`
 * validators in src/types/golem.ts and src/types/golemConfig.ts — all of which
 * take `unknown` — are the only things that may read them.
 */
export const GOLEM_RAW_CALL_IDS = {
  ApplyGolemSettings: 3398837476,
  CancelGolemSettingsApply: 3715274072,
  ConfirmGolemDestinationGrants: 2180243700,
  ConfirmGolemSettingsApply: 4278120228,
  CreateGolemSettings: 649660458,
  GetGolemSettings: 3594143992,
  GetGolemStatus: 107712831,
  LoadGolemProfile: 1561429884,
  PrepareGolemDestinationGrants: 4086758063,
  ReloadGolemSettings: 1366669581,
  RunGolemTurn: 2592072505,
} as const;

// Each override shadows the `export *` above for one call, keeps the generated
// parameter types so every call site compiles unchanged, and returns the
// runtime's CancellablePromise DIRECTLY — no `async`, no `.then`, nothing that
// would drop Wails' cancellation.
export const ApplyGolemSettings = (req: SettingsApplyRequest): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.ApplyGolemSettings, req);

export const CancelGolemSettingsApply = (challengeToken: string): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.CancelGolemSettingsApply, challengeToken);

// The grant-only pair (spec D13). Prepare takes no argument — nothing is
// staged — and Confirm takes only the opaque token, because the batch it
// approves lives in the challenge record and never crossed the wire back.
// Cancelling one is CancelGolemSettingsApply above: the challenge map is
// mode-blind, so the approve flow needs no cancel binding of its own.
export const ConfirmGolemDestinationGrants = (
  challengeToken: string
): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.ConfirmGolemDestinationGrants, challengeToken);

export const PrepareGolemDestinationGrants = (): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.PrepareGolemDestinationGrants);

export const ConfirmGolemSettingsApply = (
  req: ConfirmSettingsApplyRequest
): CancellablePromise<unknown> => Call.ByID(GOLEM_RAW_CALL_IDS.ConfirmGolemSettingsApply, req);

export const CreateGolemSettings = (req: SettingsApplyRequest): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.CreateGolemSettings, req);

export const GetGolemSettings = (): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.GetGolemSettings);

export const GetGolemStatus = (req: StatusRequest): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.GetGolemStatus, req);

export const LoadGolemProfile = (profileID: string): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.LoadGolemProfile, profileID);

export const ReloadGolemSettings = (): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.ReloadGolemSettings);

export const RunGolemTurn = (req: TurnRequest): CancellablePromise<unknown> =>
  Call.ByID(GOLEM_RAW_CALL_IDS.RunGolemTurn, req);
