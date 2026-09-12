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
 * The affected set is NEVER re-derived here: the candidate change is projected
 * through `projectDraft`, the same reducer whose normalization Apply sends, so
 * the disclosure and the request cannot disagree. The backend re-derives both
 * sets independently and refuses an omission or an extra.
 */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CAPABILITY_NAMES,
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
  floorShortfalls,
  meetsUseCaseFloor,
  modelFactsOf,
  probeRouteChange,
  sameModelFacts,
  unionFloor,
  USE_CASE_FLOORS,
  type Change,
  type Draft,
  type DraftBaseProjection,
  type DropField,
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
  floor: readonly CapabilityName[]
): Seed {
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
      // The floor is always in: its checkboxes render locked-on, and a state
      // that disagreed with them would make the surface lie about what it is
      // about to send.
      exposed: canonicalCaps([...staged.exposedCaps, ...floor]),
      think: staged.thinkMode,
      ackUnknown: staged.confirmUnknown,
      ackDrops: staged.confirmDrops !== undefined,
    };
  }
  if (current !== null) {
    return {
      provider: current.provider,
      defined: current,
      manual: null,
      exposed: canonicalCaps([...current.exposedCapabilities, ...floor]),
      think: current.thinkMode,
      ackUnknown: false,
      ackDrops: false,
    };
  }
  return {
    provider: '',
    defined: null,
    manual: null,
    exposed: canonicalCaps(floor),
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
  rowKey,
  onStage,
  onClose,
  onUnstagedChange,
  onStaged,
}: RouteEditorProps) {
  /** Siblings the backend forks away from, rather than changing under them. */
  const sharedRole = (current?.routedUseCases ?? []).filter((other) => other !== useCase);
  /**
   * [W4-2] What every candidate governs at least: this use case and the ones
   * its current role already serves. A chosen card adds the use cases ITS
   * selector's roles serve (`affected` below); a hand-declared name has no
   * selector yet, so the baseline is exactly its floor.
   */
  const baseline = [useCase, ...sharedRole];
  const baselineFloor = unionFloor(baseline);
  const seed = useMemo(
    () => seedFrom(staged, current, models, baselineFloor),
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
   * facts the projection already computed. Parameterised on the floor because
   * the candidate's own floor is derived from a probe built with the baseline's.
   */
  const declaredFacts = (withFloor: readonly CapabilityName[]): CapabilityFacts | null =>
    manual !== null
      ? { caps: canonicalCaps([...manual.caps, ...withFloor]), knownCaps: [...CAPABILITY_NAMES] }
      : (defined?.capabilityFacts ?? null);

  /**
   * Every use case this candidate governs, from the same reducer Apply sends
   * through — the edited one first (§4.5). Only the selector and whether ANY
   * exposure is asserted matter to that reducer, so the probe carries the
   * baseline floor; the candidate below carries the floor derived from it.
   */
  const probeFacts = declaredFacts(baselineFloor);
  const affected =
    facts === null || probeFacts === null
      ? baseline
      : affectedUseCases(base, draft, {
          kind: 'route',
          useCase,
          modelFacts: facts,
          capabilityFacts: probeFacts,
          exposedCaps: canonicalCaps([...exposed, ...baselineFloor]),
          thinkMode: '',
          confirmUnknown: false,
        });
  /** [W4-2] The floor this route must meet: the union over everything it governs. */
  const floor = unionFloor(affected);
  const floorOwners = affected.filter((other) => (USE_CASE_FLOORS.get(other) ?? []).length > 0);
  const capabilityFacts = declaredFacts(floor);

  /**
   * What arrives checked for a selection. §4.5's "declared caps arrive checked"
   * governs a selector Firn has never persisted an exposure for — a manual
   * declaration. A DEFINED model's `exposedCapabilities` already IS that
   * answer: the projection reports the selector override when one exists and
   * the declared set when it does not. Reading it here keeps all three seeding
   * paths (staged, applied, freshly chosen) on one notion of "offered", so
   * retargeting onto a model whose selector another use case narrowed cannot
   * silently re-widen that sibling's persisted contract through
   * `SetRoleOverrides`.
   */
  const offeredCaps = canonicalCaps([
    ...(defined?.exposedCapabilities ?? capabilityFacts?.caps ?? []),
    ...floor,
  ]);

  // Choosing a different model re-seeds the checklist from ITS exposure. Keyed
  // on the declaration, not the half-typed name, so a keystroke never discards
  // an exposure the user has already adjusted. (Render-phase state adjustment:
  // the React "derive state from props" pattern.)
  const factsKey =
    manual !== null
      ? `manual\u0000${manual.caps.join(',')}`
      : `defined\u0000${provider}\u0000${defined?.modelName ?? ''}`;
  const [seenKey, setSeenKey] = useState(factsKey);
  if (factsKey !== seenKey) {
    setSeenKey(factsKey);
    setExposed(offeredCaps);
    setThink(manual === null ? (defined?.thinkMode ?? '') : '');
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
          // The floor is always in: what the locked checkboxes show is what is sent.
          exposedCaps: canonicalCaps([...exposed, ...floor]),
          // A think mode is meaningless without the capability that justifies it.
          thinkMode: exposed.includes('thinking') ? think : '',
          confirmUnknown: false,
        };

  const alsoGoverns = affected.filter((other) => other !== useCase);
  const unknownUseCases = affected.filter((other) => !USE_CASE_FLOORS.has(other));

  /**
   * What a real retarget would drop. An override — the same provider+model the
   * role already names — drops nothing, and a confirmation the backend cannot
   * match is refused outright, so this stays exactly the backend's rule.
   */
  const drops: DropField[] =
    current === null || facts === null || sameModelFacts(current, facts)
      ? []
      : DROP_ORDER.filter((field) => (field === 'slots' ? current.hasSlots : current.hasThinkTags));

  const snapshot = JSON.stringify({
    provider,
    defined: defined?.role ?? null,
    manual,
    exposed,
    think,
    ackUnknown,
    ackDrops,
  });
  const [committed] = useState(snapshot);
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
    if (!meetsUseCaseFloor(useCase, exposed)) {
      setRefusal(`${INELIGIBLE} Expose ${floor.join(', ')} for ${useCase}.`);
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
        serves={baseline}
        floor={baselineFloor}
        required={floor}
        shortfalls={(candidateModel) =>
          floorShortfalls(
            candidateModel.exposedCapabilities,
            affectedUseCases(base, draft, probeRouteChange(useCase, candidateModel))
          )
        }
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
                    const locked = floor.includes(cap);
                    return (
                      <label
                        key={cap}
                        className={`${styles.checkbox} ${locked ? styles.checkboxLocked : ''}`}
                      >
                        <input
                          className={styles.checkboxInput}
                          type="checkbox"
                          disabled={locked}
                          checked={locked || exposed.includes(cap)}
                          onChange={(event) => {
                            setExposed((currentCaps) =>
                              canonicalCaps(
                                event.target.checked
                                  ? [...currentCaps, cap]
                                  : currentCaps.filter((other) => other !== cap)
                              )
                            );
                            clearRefusal();
                          }}
                        />
                        <span className={styles.checkboxBox} aria-hidden="true" />
                        {cap}
                        {/* v9 names the reason beside the locked control rather than
                        leaving a disabled box to explain itself. */}
                        {locked && (
                          <>
                            {' '}
                            <span className={styles.requiredTag}>required</span>
                          </>
                        )}
                      </label>
                    );
                  })}
                  <span className={styles.fieldHint}>
                    What this route may use.
                    {floorOwners.length > 0 &&
                      ` The capabilities ${listUseCases(floorOwners)} ${agrees(floorOwners, 'requires', 'require')} are checked and locked.`}
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

      {/* This edit reaches past the row being edited. */}
      {alsoGoverns.length > 0 && (
        <div className={styles.disclosure} data-tone="caution">
          <p className={styles.disclosureText}>
            Capabilities and Think are properties of <strong>the model</strong>, not the route.
            Changing them here also changes them for {boldList(alsoGoverns)}.
          </p>
        </div>
      )}

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
