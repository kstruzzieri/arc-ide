/**
 * The inline model band (#263 spec §4.4/§4.7, picker revamp v2 Treatment 1).
 *
 * The editor row GROWS instead of overlaying: provider select, filter field and
 * a card grid, then one master-detail strip. Nothing floats, nothing clips,
 * nothing needs a portal — the models, the declare path and the hidden-by-floor
 * set are all permanently visible surfaces.
 *
 * Cards are uniformly COMPACT and never expand: name, type, one facts line. The
 * strip below owns everything else, so a grid row can never inflate and the
 * geometry never moves under the cursor. It has three states — the declare
 * form, a one-line placeholder, or the readout (facts left, exposure editor
 * right of a hairline) — so the surface never jumps into existence.
 *
 * Arrowing the grid PREVIEWS the focused card in the strip's left half without
 * assigning it; the exposure editor on the right always belongs to what is
 * actually selected, because editing exposure you have not chosen would stage a
 * lie.
 *
 * Everything here is a filter and a pre-check. The backend independently
 * re-derives eligibility and refuses a model that does not meet the affected
 * requirements, so nothing below is authoritative.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CAPABILITY_NAMES,
  MODEL_TYPES,
  type CapabilityName,
  type ModelProjection,
  type ModelType,
  type ProviderProjection,
} from '../../types/golem';
import { formatContextWindow } from '../../utils/formatContextWindow';
import { orderModelsForDisplay } from '../../utils/golemModelOrder';
import styles from './GolemConfig.module.css';

const TYPE_LABEL: Record<ModelType, string> = {
  dense: 'Dense',
  moe: 'Mixture of experts',
  embedding: 'Embedding',
};

/** A hand-declared model: authoritative facts, not detected ones (§4.4). */
export interface ManualModel {
  model: string;
  /** Required before staging; `''` is "not chosen yet", never a default. */
  type: ModelType | '';
  caps: CapabilityName[];
}

/** Capability arrays cross the transport in CAPABILITY_NAMES order or not at all. */
export const canonicalCaps = (caps: Iterable<CapabilityName>): CapabilityName[] => {
  const wanted = new Set(caps);
  return CAPABILITY_NAMES.filter((cap) => wanted.has(cap));
};

/**
 * Where a row came from. Today every row is `authored` — the models the
 * document already defines.
 *
 * SLICE D SEAM (contract b241d01): `RefreshInventory` results union in here as
 * `discovered` rows, behind the band header's reserved refresh slot and never
 * implicitly. `ProbeToolCall` then resolves a discovered row's tri-state
 * `tool_call` fact. No inventory call exists yet, and this type is the only
 * thing that anticipates one — the row builder below is the single place that
 * union will land, so nothing else in the band has to learn about provenance.
 */
export type ModelProvenance = 'authored' | 'discovered';

export interface ModelRow {
  model: ModelProjection;
  provenance: ModelProvenance;
}

/** The tuple `sameModelFacts` compares, flattened — the identity of a card. */
const rowKey = (model: ModelProjection): string =>
  [
    model.provider,
    model.modelName,
    model.type,
    model.parameters ?? '',
    model.contextWindow ?? 0,
    model.dimensions ?? 0,
  ].join('\u0000');

/**
 * The band's rows for one provider, in the shared display order. One builder,
 * so Slice D adds discovered models in a single place.
 *
 * `models` carries one entry per ROLE, so two roles naming the same model with
 * byte-identical facts arrive twice. The band picks a MODEL, not a role, so
 * they collapse to one card here — otherwise they would share a React key and
 * both answer to `sameModel`, marking two cards selected at once.
 */
export function buildModelRows(models: readonly ModelProjection[], provider: string): ModelRow[] {
  const seen = new Set<string>();
  const unique = models.filter((model) => {
    if (model.provider !== provider) return false;
    const key = rowKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return orderModelsForDisplay(unique, []).map((model) => ({
    model,
    provenance: 'authored' as const,
  }));
}

const sameModel = (a: ModelProjection | null, b: ModelProjection): boolean =>
  a !== null && rowKey(a) === rowKey(b);

/**
 * What a compact card says beside its type tag: the numbers that tell two
 * same-named models apart. The TYPE is its own tag, so it is not in here.
 * Context reads human-scale ("256K ctx"); the exact count travels in the
 * facts span's title. Dimensions stay raw — small numbers, different unit.
 */
const factsLine = (model: ModelProjection): string =>
  [
    model.parameters,
    model.contextWindow === undefined
      ? undefined
      : `${formatContextWindow(model.contextWindow)} ctx`,
    model.dimensions === undefined ? undefined : `${model.dimensions} dim`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

/** Hover detail wherever the abbreviated context renders: the exact count. */
const contextTitle = (model: ModelProjection): string | undefined =>
  model.contextWindow === undefined ? undefined : `${model.contextWindow} tokens`;

const missingFloor = (model: ModelProjection, floor: readonly CapabilityName[]): CapabilityName[] =>
  floor.filter((cap) => !model.exposedCapabilities.includes(cap));

export interface ModelBandProps {
  /** DOM id root; the grid is `<id>-grid` and its cards `<id>-card-N`. */
  id: string;
  useCase: string;
  /** The use case's Firn floor; these capabilities are the filter. */
  floor: readonly CapabilityName[];
  /** Every model the document defines, across providers. */
  models: readonly ModelProjection[];
  provider: string;
  providers: readonly ProviderProjection[];
  /** The chosen model, or null. The MODEL, not its name: two rows can share one. */
  selected: ModelProjection | null;
  /** Non-null while the declare fieldset is open. */
  manual: ManualModel | null;
  /**
   * The exposure editor for the SELECTED model (capabilities + think mode),
   * owned by the route editor and placed in the strip's right half. Passing it
   * as a node keeps the staging state where it already lives.
   */
  exposure?: ReactNode;
  onProviderChange: (provider: string) => void;
  onSelect: (model: ModelProjection) => void;
  onManual: (manual: ManualModel | null) => void;
}

export function ModelBand({
  id,
  useCase,
  floor,
  models,
  provider,
  providers,
  selected,
  manual,
  exposure,
  onProviderChange,
  onSelect,
  onManual,
}: ModelBandProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  /**
   * Detail-follows-focus: arrowing through the grid previews the focused card
   * in the strip without assigning it. Cards never expand — the strip is the
   * only place facts are shown, so the grid geometry never moves.
   */
  const [previewing, setPreviewing] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  /** True only for the render that follows a keyboard move. */
  const navigatedRef = useRef(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const gridId = `${id}-grid`;

  const rows = buildModelRows(models, provider);
  const eligible = rows.filter((row) => missingFloor(row.model, floor).length === 0);
  const blocked = rows.filter((row) => missingFloor(row.model, floor).length > 0);

  const needle = query.trim().toLowerCase();
  const matches = eligible.filter((row) => row.model.modelName.toLowerCase().includes(needle));
  const exact = eligible.some((row) => row.model.modelName.toLowerCase() === needle);
  /** A typed name nothing matches pins the declare card as the grid's last stop. */
  const declaring = needle !== '' && !exact;

  // Navigable stops: the matching cards, then the declare card. Blocked cards
  // are shown for their REASON, never chosen, so they stay out of the walk.
  const stops = matches.length + (declaring ? 1 : 0);
  const activeIndex = stops === 0 ? -1 : Math.min(active, stops - 1);

  /**
   * How many cards sit on one grid row, measured from the laid-out cards —
   * `auto-fill` decides the count, so it cannot be derived from the data.
   * jsdom reports every offset as 0, which collapses this to one column and
   * makes a row step equal a single card.
   */
  const columns = (): number => {
    const cards = [...(gridRef.current?.children ?? [])].filter(
      (card): card is HTMLElement =>
        card instanceof HTMLElement && card.getAttribute('role') === 'option'
    );
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    let count = 1;
    while (count < cards.length && cards[count].offsetTop === top) count += 1;
    return count;
  };

  const choose = (model: ModelProjection) => {
    setPreviewing(false);
    onSelect(model);
  };

  const chooseAt = (index: number) => {
    const row = matches[index];
    if (row !== undefined) {
      choose(row.model);
      return;
    }
    if (declaring) onManual({ model: query.trim(), type: '', caps: canonicalCaps(floor) });
  };

  /** One edit of the hand-declared facts; null-safe because the fieldset only
   *  renders while `manual` is non-null. */
  const patch = (next: Partial<ManualModel>) => {
    if (manual !== null) onManual({ ...manual, ...next });
  };

  const moveTo = (index: number) => {
    const next = Math.min(stops - 1, Math.max(0, index));
    // Armed only for a REAL move: a step past either end clamps to the same
    // index, the focus effect (keyed on activeIndex) never runs, and a flag
    // left armed here would fire on the NEXT index change — typing the first
    // character into the filter resets active to 0 — yanking focus onto the
    // grid mid-keystroke.
    if (next !== activeIndex) navigatedRef.current = true;
    setPreviewing(true);
    setActive(next);
  };

  const onGridKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setPreviewing(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (activeIndex >= 0) chooseAt(activeIndex);
      return;
    }
    if (stops === 0) return;
    // §4.7 names Home/End alongside the arrows.
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveTo(event.key === 'Home' ? 0 : stops - 1);
      return;
    }
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[
      event.key
    ];
    if (step === undefined) return;
    event.preventDefault();
    moveTo(activeIndex + step);
  };

  /**
   * Roving focus: the active card IS the tab stop, so navigating has to move
   * real focus with it — otherwise the focus ring sits on the card the user
   * left, Tab re-enters the grid instead of leaving it, and a screen reader is
   * told nothing. Guarded by the nav flag so first paint never steals focus.
   */
  useEffect(() => {
    if (!navigatedRef.current) return;
    navigatedRef.current = false;
    gridRef.current?.querySelector<HTMLElement>('[data-active]')?.focus();
  }, [activeIndex]);

  const assignedKey = selected === null ? null : rowKey(selected);
  const paintedRef = useRef(false);
  useEffect(() => {
    if (!paintedRef.current) {
      paintedRef.current = true;
      return;
    }
    // The grid is the scroll region now, so this moves the GRID, not the page.
    // Arrow navigation needs no equivalent: focusing a card scrolls its own
    // scroller natively, and a second call would fight that.
    gridRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [assignedKey]);

  // Leaving the declare fieldset returns the caret to the filter it was opened
  // from (§4.4).
  const wasManual = useRef(manual !== null);
  useEffect(() => {
    if (wasManual.current && manual === null) filterRef.current?.focus();
    wasManual.current = manual !== null;
  }, [manual]);

  /**
   * What the strip READS OUT. Preview follows keyboard focus, so the left half
   * can describe a card the user is only walking past; the selection is what
   * the exposure editor stays bound to.
   */
  const previewRow = previewing ? matches[activeIndex]?.model : undefined;
  const detail = previewRow ?? selected;
  const previewingOther = previewRow !== undefined && !sameModel(selected, previewRow);
  const detailState =
    manual !== null
      ? 'declaring'
      : detail === null || detail === undefined
        ? 'empty'
        : previewingOther
          ? 'previewing'
          : 'assigned';

  const declareForm =
    manual === null ? null : (
      <fieldset className={styles.manual}>
        <legend className={styles.editorLegend}>Enter a model manually</legend>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-manual-model`}>
            Model name
          </label>
          <input
            className={styles.input}
            id={`${id}-manual-model`}
            value={manual.model}
            onChange={(event) => patch({ model: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-manual-type`}>
            Type
          </label>
          <select
            className={styles.input}
            id={`${id}-manual-type`}
            value={manual.type}
            onChange={(event) => patch({ type: event.target.value as ModelType })}
          >
            <option value="">Choose a type</option>
            {MODEL_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
          <span className={styles.fieldHint}>
            Required. Golem stores the model type, and no inventory can supply it for a model you
            enter by hand.
          </span>
        </div>
        <fieldset className={styles.capabilities}>
          <legend className={styles.fieldLabel}>Capabilities this model supports</legend>
          {CAPABILITY_NAMES.map((cap) => {
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
                  checked={locked || manual.caps.includes(cap)}
                  onChange={(event) =>
                    patch({
                      caps: canonicalCaps(
                        event.target.checked
                          ? [...manual.caps, cap]
                          : manual.caps.filter((other) => other !== cap)
                      ),
                    })
                  }
                />
                <span className={styles.checkboxBox} aria-hidden="true" />
                {cap}
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
            What you declare here is what Golem may use. The capabilities this use case requires are
            checked and locked.
          </span>
        </fieldset>
        <button
          type="button"
          className={`${styles.button} ${styles.quiet}`}
          onClick={() => onManual(null)}
        >
          Back to the model list
        </button>
      </fieldset>
    );

  const filterLabel = floor.length === 0 ? 'filter: none' : `filter: ${floor.join(' · ')}`;

  return (
    <div className={styles.band}>
      <div className={styles.bandHead}>
        <span className={styles.fieldLabel}>{`Model — every card below can serve ${useCase}`}</span>
        <span className={styles.bandFilter}>{filterLabel}</span>
        <span className={styles.grow} />
        {/* SLICE D: the "Refresh list" affordance lands here, explicit-only
            (RefreshInventory, contract b241d01). Nothing renders today. */}
        <span className={styles.bandRefreshSlot} />
      </div>

      <div className={styles.bandRow}>
        <label className={styles.srOnly} htmlFor={`${id}-provider`}>
          Provider
        </label>
        <select
          className={`${styles.input} ${styles.bandProvider}`}
          id={`${id}-provider`}
          value={provider}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          <option value="">Choose a provider</option>
          {providers.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </select>
        <label className={styles.srOnly} htmlFor={`${id}-filter`}>
          Filter models
        </label>
        <input
          ref={filterRef}
          className={styles.input}
          id={`${id}-filter`}
          autoComplete="off"
          placeholder="Filter models — or type a new name to declare it"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setPreviewing(false);
          }}
        />
      </div>

      <div
        ref={gridRef}
        id={gridId}
        role="listbox"
        aria-label={`Models for ${useCase}`}
        className={styles.modelGrid}
        onKeyDown={onGridKeyDown}
        onBlur={(event) => {
          // Card-to-card moves stay inside the grid; only leaving it entirely
          // ends the preview.
          if (!event.currentTarget.contains(event.relatedTarget)) setPreviewing(false);
        }}
      >
        {matches.map((row, index) => {
          const chosen = sameModel(selected, row.model);
          return (
            <div
              key={rowKey(row.model)}
              id={`${id}-card-${index}`}
              role="option"
              aria-selected={chosen}
              tabIndex={index === activeIndex ? 0 : -1}
              data-active={index === activeIndex || undefined}
              data-provenance={row.provenance}
              className={`${styles.modelCard} ${chosen ? styles.modelCardChosen : ''}`}
              onClick={() => {
                setActive(index);
                choose(row.model);
              }}
            >
              <span className={styles.modelCardTop}>
                <span className={styles.modelName}>{row.model.modelName}</span>
                {chosen && <span className={styles.modelCardMark}>assigned</span>}
              </span>
              <span className={styles.modelCardMeta}>
                <span className={styles.factTag}>{row.model.type}</span>
                <span className={styles.modelCardFacts} title={contextTitle(row.model)}>
                  {factsLine(row.model)}
                </span>
              </span>
            </div>
          );
        })}

        {declaring && (
          <div
            id={`${id}-card-${matches.length}`}
            role="option"
            aria-selected={false}
            tabIndex={matches.length === activeIndex ? 0 : -1}
            data-active={matches.length === activeIndex || undefined}
            className={`${styles.modelCard} ${styles.modelCardDeclare}`}
            onClick={() => {
              setActive(matches.length);
              chooseAt(matches.length);
            }}
          >
            <span className={styles.modelName}>{`Declare "${query.trim()}"`}</span>
            <span className={styles.modelCardFacts}>no exact match — opens the facts editor</span>
          </div>
        )}

        {showHidden &&
          blocked.map((row) => (
            <div
              key={rowKey(row.model)}
              role="option"
              aria-selected={false}
              aria-disabled="true"
              data-provenance={row.provenance}
              className={`${styles.modelCard} ${styles.modelCardBlocked}`}
            >
              <span className={styles.modelCardTop}>
                <span className={styles.modelName}>{row.model.modelName}</span>
                <span className={styles.modelCardFacts}>{`not eligible for ${useCase}`}</span>
              </span>
              <span className={styles.modelCardMeta}>
                <span className={styles.factTag}>{row.model.type}</span>
                <span className={styles.modelCardFacts} title={contextTitle(row.model)}>
                  {factsLine(row.model)}
                </span>
              </span>
              <span className={styles.capChips}>
                {missingFloor(row.model, floor).map((cap) => (
                  <span key={cap} className={`${styles.capChip} ${styles.capChipMissing}`}>
                    {`✕ ${cap}`}
                  </span>
                ))}
              </span>
            </div>
          ))}
      </div>

      <span className={styles.srOnly} role="status" aria-live="polite">
        {`${matches.length} model${matches.length === 1 ? ' matches' : 's match'} this filter`}
      </span>

      {matches.length === 0 && !declaring && (
        <p className={styles.fieldHint}>
          No defined model meets this filter. Type a name above to declare one by hand.
        </p>
      )}

      {/*
       * The master-detail strip (Treatment 1). One surface below the grid, in
       * three states, so the layout never jumps into existence and the grid
       * never reflows: the declare form, a one-line dashed placeholder, or the
       * readout — facts left, the exposure editor right of a hairline rule.
       */}
      <div
        className={`${styles.detail} ${detailState === 'empty' ? styles.detailEmpty : ''}`}
        data-testid="model-detail"
        data-state={detailState}
      >
        {manual !== null ? (
          <>
            <div className={styles.detailHead}>
              <span className={styles.detailName}>
                {`declare "${manual.model === '' ? '…' : manual.model}"`}
              </span>
              <span className={styles.grow} />
              <span className={styles.detailOwner}>
                {`on ${provider} — facts you assert, nothing detects them`}
              </span>
            </div>
            {declareForm}
            {exposure !== undefined && (
              <div className={styles.detailDeclaredExposure}>{exposure}</div>
            )}
          </>
        ) : detail === null ? (
          'No model assigned. Select a card above — its facts and the exposure editor land here, together.'
        ) : (
          <>
            <div className={styles.detailHead}>
              <span className={styles.detailName}>{detail.modelName}</span>
              <span className={styles.factTag}>{detail.type}</span>
              {/* ASSIGNED is the route's actual model; a preview says so instead. */}
              {previewingOther ? (
                <span className={styles.detailHint}>press Enter to choose</span>
              ) : (
                <span className={styles.modelCardMark}>assigned</span>
              )}
              <span className={styles.grow} />
              <span className={styles.detailOwner}>{`from ${detail.provider}`}</span>
            </div>

            <div className={styles.detailBody} data-split={exposure !== undefined || undefined}>
              <div>
                <div className={styles.detailStats}>
                  <span className={styles.detailStat}>
                    <span className={styles.detailStatKey}>type</span>
                    <span className={styles.detailStatValue}>{TYPE_LABEL[detail.type]}</span>
                  </span>
                  {detail.parameters !== undefined && (
                    <span className={styles.detailStat}>
                      <span className={styles.detailStatKey}>params</span>
                      <span className={styles.detailStatValue}>{detail.parameters}</span>
                    </span>
                  )}
                  {detail.contextWindow !== undefined && (
                    <span className={styles.detailStat}>
                      <span className={styles.detailStatKey}>context</span>
                      <span className={styles.detailStatValue} title={contextTitle(detail)}>
                        {formatContextWindow(detail.contextWindow)}
                      </span>
                    </span>
                  )}
                </div>
                <div className={styles.detailDeclares}>
                  <span className={styles.detailStatKey}>declares</span>
                  <span className={styles.capChips}>
                    {detail.exposedCapabilities.map((cap) => (
                      <span
                        key={cap}
                        className={`${styles.capChip} ${floor.includes(cap) ? styles.capChipFloor : ''}`}
                      >
                        {cap}
                      </span>
                    ))}
                  </span>
                </div>
              </div>

              {/*
               * Bound to the SELECTION (or the hand declaration), never to a
               * preview: the left half may be showing another model's facts
               * read-only, but editing exposure you have not chosen would stage
               * a lie. The owner decides whether there is anything to expose.
               */}
              {exposure !== undefined && <div className={styles.detailExposure}>{exposure}</div>}
            </div>
          </>
        )}
      </div>

      {blocked.length > 0 && (
        <button
          type="button"
          className={styles.hiddenLine}
          onClick={() => setShowHidden((current) => !current)}
        >
          <span className={styles.hiddenCount}>
            {`${blocked.length} model${blocked.length === 1 ? '' : 's'}`}
          </span>
          {` do${blocked.length === 1 ? 'es' : ''} not meet ${floor.join(' · ')} — `}
          <span className={styles.hiddenToggle}>
            {`${showHidden ? 'hide' : 'show'} ${blocked.length === 1 ? 'it' : 'them'}`}
          </span>
        </button>
      )}
    </div>
  );
}
