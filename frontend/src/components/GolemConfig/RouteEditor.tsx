/**
 * Route row editor (#263 spec §4.3/§4.4/§4.5, mockup v9/v10).
 *
 * The strip expands into a native `fieldset`: on the left the provider select
 * and the filtered model picker, on the right the capabilities this use case
 * exposes and — only while `thinking` is among them — the think mode.
 *
 * Three disclosures separate this from a naive "pick a model" form, and all
 * three exist because a route edit is LOSSY in ways the row cannot show:
 *
 * - a role several use cases share is FORKED by the backend, so the siblings
 *   keep the model they have (§5.2b);
 * - a capability/think override is persisted per provider+model SELECTOR, so it
 *   governs every use case resolving to that selector (§4.5) — and if any of
 *   them is outside Firn's floor table, the change needs an explicit
 *   "requirements unknown" acknowledgement the backend re-derives and verifies;
 * - a real retarget drops the authored, model-specific ThinkTags/Slots, which
 *   the projection reports only as existence facts (§5.2b, plan amendment 13).
 *
 * Two more block Done outright, because the backend would refuse the request:
 * a floor capability the checked set lacks (never ticked for the user — an
 * asserted cap is taken as truth), and a Think mode a selector sibling already
 * sets differently (go-llm's selectorPairConflict).
 *
 * The affected and governed sets are NEVER re-derived here: the candidate
 * change is projected through `projectDraft`, the same reducer whose
 * normalization Apply sends, so the disclosures and the request cannot
 * disagree. The backend re-derives both sets independently and refuses an
 * omission or an extra.
 */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CAPABILITY_NAMES,
  compareString,
  isIdentifier,
  THINK_MODES,
  type CapabilityFacts,
  type CapabilityName,
  type ModelProjection,
  type ProviderProjection,
  type ThinkMode,
} from '../../types/golem';
import {
  affectedUseCases,
  changeStableID,
  floorShortfalls,
  governedUseCasesOf,
  leavingRoutes,
  modelFactsOf,
  overridesSelector,
  probeRouteChange,
  retargetOf,
  sameModelFacts,
  shortfallLine,
  stagedRoutes,
  unionFloor,
  USE_CASE_FLOORS,
  type Change,
  type Draft,
  type DraftBaseProjection,
  type DropField,
  type FloorShortfall,
  type ModelFacts,
  type RouteChange,
} from '../../types/golemConfig';
import { formatSettingsDiagnostic } from '../../utils/settingsDiagnostics';
import styles from './GolemConfig.module.css';
import { ModelBand, canonicalCaps, type ManualModel } from './ModelBand';

/** The one copy vocabulary, shared with the diagnostics the backend returns. */
const copy = (code: Parameters<typeof formatSettingsDiagnostic>[0]): string =>
  formatSettingsDiagnostic(code, '', '').text;

const MODEL_INVALID = copy('model_invalid');
const INELIGIBLE = copy('eligibility_ineligible');
/** [W5-1] What an all-unticked checklist would actually persist. */
const EMPTY_EXPOSURE =
  "Tick at least one capability before staging this route; an empty set falls back to the model type's defaults, not to nothing.";

/** Transport order, the order the backend's drop set is compared in. */
const DROP_ORDER: readonly DropField[] = ['slots', 'think_tags'];

const THINK_LABEL: Record<ThinkMode, string> = {
  '': 'Default',
  none: 'None',
  always: 'Always',
  toggle: 'Toggle',
  auto: 'Auto',
};

/**
 * Plain English for a list of use cases (NOT a hook — the `use` prefix would
 * make the linter, and a reader, think it were one), with the verb that agrees with it:
 * "chat also uses" but "chat and completion also use". Getting this wrong is
 * the kind of thing that makes a careful notice read as machine output.
 */
const listUseCases = (useCases: readonly string[]): string =>
  useCases.length <= 1
    ? (useCases[0] ?? '')
    : `${useCases.slice(0, -1).join(', ')} and ${useCases[useCases.length - 1]}`;

const agrees = (useCases: readonly string[], singular: string, plural: string): string =>
  useCases.length === 1 ? singular : plural;

/**
 * The same list with the names carrying the weight —
 * `<strong>a</strong>, <strong>b</strong> and <strong>c</strong>` — so a
 * notice reads as a sentence about THOSE routes, not a wall of equal words.
 */
const boldList = (names: readonly string[]): ReactNode =>
  names.map((name, index) => (
    <Fragment key={name}>
      {index === 0 ? '' : index === names.length - 1 ? ' and ' : ', '}
      <strong>{name}</strong>
    </Fragment>
  ));

/**
 * Amendment 13 copy, one clause per hidden fact the current model carries.
 * Reading order is the amendment's; the drop SET stays in transport order
 * (`slots` before `think_tags`), which is what the backend compares against.
 */
const dropNotice = (thinkTags: boolean, slots: boolean): string => {
  const names = [
    ...(thinkTags ? ['custom think tags'] : []),
    ...(slots ? ['slot configuration'] : []),
  ];
  return `The current model has ${names.join(' and ')} set up by hand. Changing the model ${names.length === 1 ? 'removes it' : 'removes them'}.`;
};

export interface RouteEditorProps {
  /** DOM id root; also the `aria-controls` target of the disclosure button. */
  id: string;
  useCase: string;
  /** The applied route's role, or null while this use case is unbound. */
  role: string | null;
  /** The model that role resolves to, or null. */
  current: ModelProjection | null;
  providers: readonly ProviderProjection[];
  models: readonly ModelProjection[];
  /** Routes + models the draft is layered on, for the candidate projection. */
  base: DraftBaseProjection;
  draft: Draft;
  /** The change already staged on this route identity, if any. */
  staged?: Change;
  /**
   * [W4-3] A defined model the Assign list chose: the editor opens with it
   * selected, as an unstaged edit over the row's real baseline. Read once, at mount.
   */
  preselect?: ModelProjection;
  rowKey: string;
  onStage: (changes: Change[], drop: string[]) => void;
  onClose: () => void;
  onUnstagedChange: (rowKey: string, unstaged: boolean) => void;
  /**
   * #284: called exactly once per successful Done staging with the finished
   * announcement. The OWNER announces, closes this editor, and restores
   * focus — the editor cannot, because it unmounts with the message.
   */
  onStaged: (announcement: string) => void;
}

/** The `factsKey` of a hand-declared model: its declared set, canonical. */
const declarationKey = (caps: readonly CapabilityName[]): string => `manual\u0000${caps.join(',')}`;

interface Seed {
  provider: string;
  defined: ModelProjection | null;
  manual: ManualModel | null;
  exposed: CapabilityName[];
  think: ThinkMode;
  ackUnknown: boolean;
  ackDrops: boolean;
}

/**
 * Reopening shows what is waiting for Apply, not the applied document
 * underneath it. A staged change whose facts match a defined model reads back
 * as that model; anything else was declared by hand and reads back as a manual
 * declaration, because there is no other lossless way to restore it.
 */
function seedFrom(
  staged: Change | undefined,
  current: ModelProjection | null,
  models: readonly ModelProjection[],
  authority: RouteChange | undefined
): Seed {
  // [W4-7] The exposure seeds EXACTLY from what is staged or applied. A floor
  // cap the model lacks is never added here: go-llm takes an asserted cap as
  // truth, so only the user's own tick may assert one.
  if (staged?.kind === 'route') {
    const facts = staged.modelFacts;
    const defined = models.find((model) => sameModelFacts(model, facts)) ?? null;
    return {
      provider: facts.provider,
      defined,
      manual:
        defined === null
          ? {
              model: facts.model,
              type: facts.type,
              caps: canonicalCaps(staged.capabilityFacts.caps),
            }
          : null,
      exposed: canonicalCaps(staged.exposedCaps),
      think: staged.thinkMode,
      ackUnknown: staged.confirmUnknown,
      ackDrops: staged.confirmDrops !== undefined,
    };
  }
  if (current !== null) {
    // [W5-5] Another route already staged onto this selector: coalescing will
    // hand the group whatever Done stages here, so open on the group's own
    // exposure and Think — a Done that touches neither keeps them.
    return {
      provider: current.provider,
      defined: current,
      manual: null,
      exposed: canonicalCaps(authority?.exposedCaps ?? current.exposedCapabilities),
      think: authority?.thinkMode ?? current.thinkMode,
      ackUnknown: false,
      ackDrops: false,
    };
  }
  return {
    provider: '',
    defined: null,
    manual: null,
    exposed: [],
    think: '',
    ackUnknown: false,
    ackDrops: false,
  };
}

export function RouteEditor({
  id,
  useCase,
  role,
  current,
  providers,
  models,
  base,
  draft,
  staged,
  preselect,
  rowKey,
  onStage,
  onClose,
  onUnstagedChange,
  onStaged,
}: RouteEditorProps) {
  /** Siblings the backend forks away from, rather than changing under them. */
  const sharedRole = (current?.routedUseCases ?? []).filter((other) => other !== useCase);
  /**
   * The draft minus this route's own staging: Done replaces that identity
   * (`stageChange`), so nothing below may read it as a sibling.
   */
  const others = draft.changes.filter(
    (change) => !(change.kind === 'route' && change.useCase === useCase)
  );
  /**
   * [W5-5] What the selector's group holds in this draft — the values
   * `projectDraft` will coalesce this route onto (its latest member is the
   * authority, and Done makes this route the latest). This route's own
   * staging comes first when it sits on the selector: RoutingCard hands it
   * over already coalesced, so it IS the group's current values, where a
   * peer's raw staging may predate them. Otherwise the latest peer.
   */
  const authorityOn = (model: ModelProjection | null): RouteChange | undefined => {
    if (model === null) return undefined;
    const onSelector = (change: Change): change is RouteChange =>
      change.kind === 'route' &&
      change.modelFacts.provider === model.provider &&
      change.modelFacts.model === model.modelName;
    return staged !== undefined && onSelector(staged)
      ? staged
      : [...others].reverse().find(onSelector);
  };
  const seed = useMemo(
    () =>
      seedFrom(
        preselect === undefined ? staged : undefined,
        preselect ?? current,
        models,
        authorityOn(preselect ?? current)
      ),
    // Derived once, at mount: the row remounts when the document moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [provider, setProvider] = useState(seed.provider);
  const [defined, setDefined] = useState<ModelProjection | null>(seed.defined);
  const [manual, setManual] = useState<ManualModel | null>(seed.manual);
  const [exposed, setExposed] = useState<CapabilityName[]>(seed.exposed);
  const [think, setThink] = useState<ThinkMode>(seed.think);
  const [ackUnknown, setAckUnknown] = useState(seed.ackUnknown);
  const [ackDrops, setAckDrops] = useState(seed.ackDrops);
  const [refusal, setRefusal] = useState('');

  // The facts the picker currently yields. `null` means "not choosable yet";
  // submit() names which half is missing.
  const facts: ModelFacts | null =
    provider === ''
      ? null
      : manual !== null
        ? manual.model === '' || manual.type === ''
          ? null
          : { provider, model: manual.model, type: manual.type }
        : defined === null
          ? null
          : modelFactsOf(defined);

  /**
   * A manual declaration is authoritative: `caps` is the checked set and
   * `knownCaps` the full vocabulary shown (§4.4). A defined model carries the
   * facts the projection already computed.
   */
  const capabilityFacts: CapabilityFacts | null =
    manual !== null
      ? { caps: canonicalCaps(manual.caps), knownCaps: [...CAPABILITY_NAMES] }
      : (defined?.capabilityFacts ?? null);

  /**
   * What arrives checked for a selection. §4.5's "declared caps arrive checked"
   * governs a selector Firn has never persisted an exposure for — a manual
   * declaration. A DEFINED model's `exposedCapabilities` already IS that
   * answer: the projection reports the selector override when one exists and
   * the declared set when it does not. Reading it here keeps all three seeding
   * paths (staged, applied, freshly chosen) on one notion of "offered", so
   * retargeting onto a model whose selector another use case narrowed cannot
   * silently re-widen that sibling's persisted contract through
   * `SetRoleOverrides`. A route another use case already STAGED onto the
   * selector comes first [W5-5]: coalescing makes its exposure this one's.
   * Nothing is added to it (see `seedFrom`).
   */
  const authority = authorityOn(defined);
  const offeredCaps =
    authority?.exposedCaps ?? defined?.exposedCapabilities ?? capabilityFacts?.caps ?? [];

  // Choosing a different model re-seeds the checklist from ITS exposure. Keyed
  // on the declaration, not the half-typed name, so a keystroke never discards
  // an exposure the user has already adjusted. (Render-phase state adjustment:
  // the React "derive state from props" pattern.)
  const factsKey =
    manual !== null
      ? declarationKey(manual.caps)
      : `defined\u0000${provider}\u0000${defined?.modelName ?? ''}`;
  const [seenKey, setSeenKey] = useState(factsKey);
  if (factsKey !== seenKey) {
    setSeenKey(factsKey);
    setExposed(canonicalCaps(offeredCaps));
    // A hand-declared name is never matched against a staged selector: this
    // key is the declaration's caps, not the half-typed name (ceiling; a
    // declaration that spells a peer's staged model still opens on '').
    setThink(manual === null ? (authority?.thinkMode ?? defined?.thinkMode ?? '') : '');
    setAckDrops(false);
    setAckUnknown(false);
  }

  const candidate: RouteChange | null =
    facts === null || capabilityFacts === null
      ? null
      : {
          kind: 'route',
          useCase,
          modelFacts: facts,
          capabilityFacts,
          // The checked set, nothing added: what the checklist shows is what is sent.
          exposedCaps: exposed,
          // A think mode is meaningless without the capability that justifies it.
          thinkMode: exposed.includes('thinking') ? think : '',
          confirmUnknown: false,
        };

  /**
   * Two sets from the same reducer Apply sends through, the edited use case
   * first (§4.5). `affected` is what the backend asks the user to CONFIRM —
   * it feeds the unknown-requirements acknowledgement. `governed` is what the
   * change actually gates: the floors, the required caps and the caution
   * notice read it, because a fork leaves the source role's other use cases
   * exactly as they are.
   */
  const affected = candidate === null ? [useCase] : affectedUseCases(base, draft, candidate);
  const governed = candidate === null ? [useCase] : governedUseCasesOf(base, draft, candidate);
  /** [W4-2] The floor this route must meet: the union over everything it governs. */
  const floor = unionFloor(governed);
  const floorOwners = governed.filter((other) => (USE_CASE_FLOORS.get(other) ?? []).length > 0);
  /** [W4-7] What the checked set lacks against that floor — named, never ticked for the user. */
  const short = candidate === null ? [] : floorShortfalls(exposed, governed);
  const alsoGoverns = governed.filter((other) => other !== useCase);
  const unknownUseCases = affected.filter((other) => !USE_CASE_FLOORS.has(other));

  /**
   * An override — the same full facts the role already names — is the one
   * change that rewrites every role on the selector (`SetRoleOverrides`); a
   * join or fork writes Think to its own role alone. The same question the
   * backend's planRouteChanges asks, through the same comparison.
   */
  const isOverride = current !== null && facts !== null && sameModelFacts(current, facts);
  /**
   * [W5-2][W5-3][W5-4] Where Think lands. The reducer coalesces a selector
   * group onto its latest change, so Think always reaches every OTHER staged
   * route on the selector (`peers`); it reaches the applied siblings too only
   * when the group holds an override — this change, or one already staged —
   * because only `SetRoleOverrides` writes selector-wide. This route's own
   * earlier staging is not a sibling (`others`): Done replaces it, and
   * `isOverride` already speaks for the candidate. `isOverride` alone still
   * decides what a retarget drops.
   */
  const peers = new Set(
    candidate === null
      ? []
      : others.flatMap((change) =>
          change.kind === 'route' &&
          change.modelFacts.provider === candidate.modelFacts.provider &&
          change.modelFacts.model === candidate.modelFacts.model
            ? [change.useCase]
            : []
        )
  );
  const thinkEverywhere =
    isOverride || (candidate !== null && overridesSelector(base, others, candidate.modelFacts));
  const thinkReach = thinkEverywhere
    ? alsoGoverns
    : alsoGoverns.filter((other) => peers.has(other));

  /**
   * What a real retarget would drop. An override drops nothing, and a
   * confirmation the backend cannot match is refused outright, so this stays
   * exactly the backend's rule.
   */
  const drops: DropField[] =
    current === null || facts === null || isOverride
      ? []
      : DROP_ORDER.filter((field) => (field === 'slots' ? current.hasSlots : current.hasThinkTags));

  /**
   * [W4-9] A role joining a selector cannot set a Think mode a sibling on it
   * already sets differently: go-llm refuses the finished document
   * (selectorPairConflict — both sides non-empty). One entry per conflicting
   * mode, naming the routes that set it — each once, since `routedUseCases`
   * is fallback-inclusive and two roles can name the same route.
   *
   * [W4-10] The backend applies a request in phases — route plans in
   * stable-id order, then overrides, binds, unassigns, removals — and
   * validates every mutation, so what counts is the selector as it stands
   * when THIS join runs. A sibling is skipped only when it is gone by then:
   * its one routed use case has a staged route onto another selector whose
   * plan sorts before this one (a retarget rewrites the role onto the new
   * selector). Everything else stays and counts — a fork keeps the source
   * role on the selector, an unassigned route is still bound, and a
   * departure sorting after the join is a transient conflict the backend
   * still refuses — named by the routes it still serves, or as
   * `role <name>` when none is left to name (an unrouted role never leaves).
   * The edited role counts only when shared (this route is leaving it).
   * A sibling's own staged override lands in the overrides phase, after every
   * join, so its APPLIED Think is what this join meets — even while the row
   * already paints the staged one.
   * Ceiling: a sibling routed by exactly one use case that an unrouted role
   * lists as a fallback is forked too (`fallbacks[role]`), invisible here —
   * the pre-check may mark it gone and the backend refuses late.
   * Capability overrides conflict the same way, but the projection cannot
   * tell a sibling's explicit override from its declared caps, so that half
   * stays with the backend.
   */
  const conflictsByMode = new Map<ThinkMode, Set<string>>();
  if (!isOverride && candidate !== null && candidate.thinkMode !== '') {
    const staged = stagedRoutes(draft.changes);
    const unassigned = new Set(
      draft.changes.flatMap((change) => (change.kind === 'route-unassign' ? [change.useCase] : []))
    );
    const joinId = changeStableID(candidate);
    for (const sibling of base.models) {
      if (
        sibling.provider !== candidate.modelFacts.provider ||
        sibling.modelName !== candidate.modelFacts.model ||
        sibling.thinkMode === '' ||
        sibling.thinkMode === candidate.thinkMode
      )
        continue;
      const leaving = leavingRoutes(base, staged, sibling);
      // The route taking the sibling's ONLY use case elsewhere, if there is one.
      const departure = retargetOf(base, staged, sibling);
      const gone =
        sibling.role === role
          ? sharedRole.length === 0
          : departure !== undefined && compareString(changeStableID(departure), joinId) < 0;
      if (gone) continue;
      const staying = sibling.routedUseCases.filter(
        (other) =>
          !leaving.has(other) &&
          !unassigned.has(other) &&
          (sibling.role !== role || other !== useCase)
      );
      // Still here, but only because its plan sorts after this join — say so.
      // departure !== undefined means the sibling's one route is leaving, so
      // staying is always empty then — the note only ever decorates the
      // role-fallback name.
      const departureNote =
        departure !== undefined ? ` (its ${departure.useCase} route leaves after this join)` : '';
      const names = conflictsByMode.get(sibling.thinkMode) ?? new Set<string>();
      for (const name of staying.length > 0 ? staying : [`role ${sibling.role}${departureNote}`])
        names.add(name);
      conflictsByMode.set(sibling.thinkMode, names);
    }
  }
  const thinkConflicts = [...conflictsByMode].map(([mode, names]) => ({ mode, names: [...names] }));
  const thinkConflictLine = ({ mode, names }: { mode: ThinkMode; names: string[] }): string =>
    `${listUseCases(names)} already ${agrees(names, 'sets', 'set')} Think to ${mode} on this model; a route joining it cannot set a different Think mode.`;

  /**
   * [K6] One verdict per card, cached by role for the life of the draft: the
   * band re-renders on every keystroke in the declare form, and every verdict
   * projects the whole draft.
   */
  const shortfalls = useMemo(() => {
    const cache = new Map<string, readonly FloorShortfall[]>();
    return (model: ModelProjection): readonly FloorShortfall[] => {
      const cached = cache.get(model.role);
      if (cached !== undefined) return cached;
      const verdict = floorShortfalls(
        model.exposedCapabilities,
        governedUseCasesOf(base, draft, probeRouteChange(useCase, model))
      );
      cache.set(model.role, verdict);
      return verdict;
    };
  }, [base, draft, useCase]);

  /** The editor's state as one comparable string: what Done would stage, minus the derivations. */
  const snapshotOf = (state: Seed): string =>
    JSON.stringify({
      provider: state.provider,
      defined: state.defined?.role ?? null,
      manual: state.manual,
      exposed: state.exposed,
      think: state.think,
      ackUnknown: state.ackUnknown,
      ackDrops: state.ackDrops,
    });
  const snapshot = snapshotOf({ provider, defined, manual, exposed, think, ackUnknown, ackDrops });
  // [W4-3] The baseline is what the ROW holds: a preselected model is an edit
  // waiting for Done, never a committed state, so it must read as unstaged.
  const [committed] = useState(() =>
    snapshotOf(seedFrom(staged, current, models, authorityOn(current)))
  );
  const unstaged = snapshot !== committed;

  useEffect(() => {
    onUnstagedChange(rowKey, unstaged);
  }, [onUnstagedChange, rowKey, unstaged]);

  // Collapsing or unmounting releases the Apply gate this editor was holding.
  useEffect(() => () => onUnstagedChange(rowKey, false), [onUnstagedChange, rowKey]);

  const clearRefusal = () => setRefusal('');

  const submit = () => {
    if (provider === '') {
      setRefusal('Choose a provider first — a model needs the endpoint it runs on.');
      return;
    }
    if (manual === null && defined === null) {
      setRefusal('Choose a model, or enter one manually.');
      return;
    }
    if (manual !== null) {
      if (!isIdentifier(manual.model) || manual.model === '') {
        setRefusal(`${MODEL_INVALID} Enter the model id the provider serves.`);
        return;
      }
      if (manual.type === '') {
        setRefusal('A model type is required before this route can be staged.');
        return;
      }
    }
    if (candidate === null) {
      setRefusal('Choose a model, or enter one manually.');
      return;
    }
    // The clause the backend would refuse with, before the round trip.
    if (short.length > 0) {
      setRefusal(`${INELIGIBLE} ${shortfallLine(short)}.`);
      return;
    }
    // [W5-1] go-llm reads an empty capability list as "clear it" and derives
    // the model type's defaults — for an override (SetRoleOverrides, nil) and
    // a join alike (roleOptions → applyRoleOverridesFromOpts: len == 0
    // clears); never the empty set the checklist shows (§4.4). After the
    // floor clause, which names what a floored route is missing.
    if (exposed.length === 0) {
      setRefusal(EMPTY_EXPOSURE);
      return;
    }
    if (thinkConflicts.length > 0) {
      setRefusal(thinkConflicts.map(thinkConflictLine).join(' '));
      return;
    }
    if (unknownUseCases.length > 0 && !ackUnknown) {
      setRefusal(
        `The requirements are unknown for ${unknownUseCases.join(', ')}. Confirm the change before staging it.`
      );
      return;
    }
    if (drops.length > 0 && !ackDrops) {
      setRefusal('Confirm what this change removes from the current model before staging it.');
      return;
    }

    onStage(
      [
        {
          ...candidate,
          // The reducer derives the exact `confirmUnknownUseCases` set from the
          // selector group; this is the acknowledgement that set requires.
          confirmUnknown: unknownUseCases.length > 0,
          ...(drops.length > 0 ? { confirmDrops: drops } : {}),
        },
      ],
      []
    );
    setRefusal('');
    onStaged(`${useCase} model staged: ${candidate.modelFacts.model}`);
  };

  const unassign = () => {
    onStage([{ kind: 'route-unassign', useCase }], []);
    onClose();
  };

  const capsLegend =
    facts === null
      ? `Capabilities exposed to ${useCase}`
      : `Capabilities exposed to ${useCase} — from ${facts.model}`;

  // tabIndex is how an Apply-bar chip focuses the editor it names (§3.3).
  return (
    <fieldset className={styles.editor} id={id} tabIndex={-1}>
      {/* The row strip above IS the editor header (v9): the use case and its
          `editing…` status. A visible legend would cut the border line and
          leave a gap across the top, so the accessible name is sr-only. */}
      <legend className={styles.srOnly}>{`Route ${useCase}`}</legend>

      {refusal !== '' && (
        <p className={styles.fieldError} role="alert">
          {refusal}
        </p>
      )}

      {/*
       * Treatment 1: band, then one master-detail strip. The exposure editor
       * lives in that strip beside the selected model, so what is being
       * edited and what it applies to are one surface — but its STATE stays
       * here, where staging already reads it.
       */}
      <ModelBand
        id={id}
        useCase={useCase}
        floor={USE_CASE_FLOORS.get(useCase) ?? []}
        required={floor}
        shortfalls={shortfalls}
        models={models}
        provider={provider}
        providers={providers}
        selected={defined}
        manual={manual}
        exposure={
          defined === null && manual === null ? undefined : (
            <>
              <div className={styles.column}>
                <fieldset className={styles.capabilities}>
                  <legend className={styles.fieldLabel}>{capsLegend}</legend>
                  {(capabilityFacts?.knownCaps ?? CAPABILITY_NAMES).map((cap) => {
                    const required = floor.includes(cap);
                    // A required cap locks only once it is checked: the tick is
                    // the user's assertion, never the checklist's (§4.4).
                    const locked = required && exposed.includes(cap);
                    return (
                      <label
                        key={cap}
                        className={`${styles.checkbox} ${locked ? styles.checkboxLocked : ''}`}
                      >
                        <input
                          className={styles.checkboxInput}
                          type="checkbox"
                          disabled={locked}
                          checked={exposed.includes(cap)}
                          onChange={(event) => {
                            setExposed((currentCaps) =>
                              canonicalCaps(
                                event.target.checked
                                  ? [...currentCaps, cap]
                                  : currentCaps.filter((other) => other !== cap)
                              )
                            );
                            // A hand-declared model cannot expose what it does not
                            // declare: this tick is the declare form's assertion too.
                            // Adding only — unticking never withdraws a declaration.
                            // The key advances with it: this tick IS the exposure
                            // edit, so the changed declaration must not re-seed the
                            // checklist, Think or the acknowledgements over it.
                            if (
                              event.target.checked &&
                              manual !== null &&
                              !manual.caps.includes(cap)
                            ) {
                              const caps = canonicalCaps([...manual.caps, cap]);
                              setManual({ ...manual, caps });
                              setSeenKey(declarationKey(caps));
                            }
                            clearRefusal();
                          }}
                        />
                        <span className={styles.checkboxBox} aria-hidden="true" />
                        {cap}
                        {/* v9 names the reason beside the control rather than
                        leaving a locked box to explain itself. */}
                        {required && (
                          <>
                            {' '}
                            <span className={styles.requiredTag}>required</span>
                          </>
                        )}
                      </label>
                    );
                  })}
                  <span className={styles.fieldHint}>
                    {`What this route may use.${
                      floorOwners.length > 0
                        ? ` Required by ${listUseCases(floorOwners)}: ${floor.join(', ')}.`
                        : ''
                    }`}
                  </span>
                </fieldset>
              </div>

              {/* Think sits under the capabilities inside the strip's exposure half. */}
              {exposed.includes('thinking') && (
                <div className={styles.column}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor={`${id}-think`}>
                      Think mode
                    </label>
                    <select
                      className={styles.input}
                      id={`${id}-think`}
                      value={think}
                      onChange={(event) => {
                        setThink(event.target.value as ThinkMode);
                        clearRefusal();
                      }}
                    >
                      {THINK_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {THINK_LABEL[mode]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </>
          )
        }
        onProviderChange={(next) => {
          setProvider(next);
          setDefined(null);
          setManual(null);
          clearRefusal();
        }}
        onSelect={(model) => {
          setDefined(model);
          setManual(null);
          clearRefusal();
        }}
        onManual={(next) => {
          setManual(next);
          if (next !== null) setDefined(null);
          clearRefusal();
        }}
      />

      {/* A fact about what the backend will do; nothing is asked of the user.
          Names the mechanism — the model CHOICE belongs to this route alone —
          so it cannot read as contradicting the capability notice below, whose
          settings belong to the model and reach every route on it. */}
      {current !== null && sharedRole.length > 0 && (
        <div className={styles.disclosure} data-tone="info">
          <p className={styles.disclosureText}>
            {boldList([useCase, ...sharedRole])} share this model.
          </p>
          <p className={styles.disclosureText}>
            Picking a different model here changes <strong>{useCase} only</strong>;{' '}
            <strong>
              {listUseCases(sharedRole)} {agrees(sharedRole, 'keeps', 'keep')}
            </strong>{' '}
            {current.modelName}.
          </p>
        </div>
      )}

      {/* This edit reaches past the row being edited. [W4-8] Only an override
          writes Think selector-wide; a join carries its Think on its own role —
          but the reducer coalesces every staged route on the selector onto this
          one's Think [W5-4], and an override already staged there carries it to
          the applied siblings too [W5-2]. */}
      {alsoGoverns.length > 0 && (
        <div className={styles.disclosure} data-tone="caution">
          <p className={styles.disclosureText}>
            {thinkReach.length === alsoGoverns.length ? (
              <>
                Capabilities and Think are properties of <strong>the model</strong>, not the route.
                Changing them here also changes them for {boldList(alsoGoverns)}.
              </>
            ) : (
              <>
                Capabilities are a property of <strong>the model</strong>, not the route. Changing
                them here also changes them for {boldList(alsoGoverns)}; Think applies to this route
                {thinkReach.length === 0 ? (
                  ' only'
                ) : thinkReach.length === 1 ? (
                  <> and {boldList(thinkReach)}</>
                ) : (
                  <>, {boldList(thinkReach)}</>
                )}
                .
              </>
            )}
          </p>
        </div>
      )}

      {/* Staging is refused while any of these stand. */}
      {thinkConflicts.map(({ mode, names }) => (
        <div key={mode} className={styles.disclosure} data-tone="blocking">
          <p className={styles.disclosureText}>
            <strong>{listUseCases(names)}</strong> already {agrees(names, 'sets', 'set')} Think to{' '}
            <strong>{mode}</strong> on this model; a route joining it cannot set a different Think
            mode.
          </p>
        </div>
      ))}

      {/* Staging is refused until this is acknowledged. */}
      {unknownUseCases.length > 0 && (
        <div className={styles.disclosure} data-tone="caution">
          <p className={styles.disclosureText}>
            Firn has <strong>no requirements on record for {listUseCases(unknownUseCases)}</strong>,
            so it cannot check this model for {agrees(unknownUseCases, 'it', 'them')}. Tick{' '}
            <strong>Apply anyway</strong> to accept that.
          </p>
          <label className={styles.checkbox}>
            <input
              className={styles.checkboxInput}
              type="checkbox"
              checked={ackUnknown}
              onChange={(event) => {
                setAckUnknown(event.target.checked);
                clearRefusal();
              }}
            />
            <span className={styles.checkboxBox} aria-hidden="true" />
            Apply anyway
          </label>
        </div>
      )}

      {drops.length > 0 && (
        <div className={styles.disclosure} data-tone="blocking">
          <p className={styles.disclosureText}>
            {dropNotice(current?.hasThinkTags === true, current?.hasSlots === true)}
          </p>
          <p className={styles.disclosureText}>
            They live in the configuration file and are not shown here. Golem confirms exactly what
            goes when you apply.
          </p>
          <label className={styles.checkbox}>
            <input
              className={styles.checkboxInput}
              type="checkbox"
              checked={ackDrops}
              onChange={(event) => {
                setAckDrops(event.target.checked);
                clearRefusal();
              }}
            />
            <span className={styles.checkboxBox} aria-hidden="true" />
            Remove them and continue
          </label>
        </div>
      )}

      {/* [W4-7] A required cap the model lacks is named, never ticked for the
          user: the tick is an assertion go-llm takes as truth. */}
      {facts !== null && short.length > 0 && (
        <div className={styles.disclosure} data-tone="blocking">
          <p className={styles.disclosureText}>
            <strong>{facts.model}</strong> does not declare{' '}
            <strong>{short.map(({ cap }) => cap).join(', ')}</strong>: {shortfallLine(short)}. Pick
            a model that does, or tick {short.length === 1 ? 'it' : 'them'} here to declare that it
            can.
          </p>
        </div>
      )}

      {/* [W5-1] Nothing ticked is not "nothing exposed": go-llm derives the
          model type's defaults for an empty list. Said here, before Done refuses. */}
      {facts !== null && exposed.length === 0 && (
        <div className={styles.disclosure} data-tone="blocking">
          <p className={styles.disclosureText}>{EMPTY_EXPOSURE}</p>
        </div>
      )}

      <div className={styles.editorFooter}>
        {/* Always enabled: this button IS the validator's entry point, and the
            refusals above are how the editor answers. The global Apply gate is
            held by `onUnstagedChange`, not by a disabled control. */}
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          onClick={submit}
          data-unstaged={unstaged || undefined}
        >
          Done
        </button>
        <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={onClose}>
          Cancel
        </button>
        {/* §4.3: optional use cases only. The agent route is Firn's own run
            path, and the backend refuses to unbind it independently (§5.2). */}
        {/* v9 right-aligns the destructive action away from Done/Cancel. */}
        <span className={styles.grow} />
        {role !== null && useCase !== 'agent' && (
          <button type="button" className={`${styles.button} ${styles.danger}`} onClick={unassign}>
            Unassign
          </button>
        )}
      </div>
    </fieldset>
  );
}
