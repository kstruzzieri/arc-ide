/**
 * Model routing section card (#263 spec §4.1/§4.2/§4.3, mockup v10).
 *
 * One row per use case, joined to the model its role resolves to, and a
 * subgroup for models the file defines but nothing routes.
 *
 * The row list is the union of Firn's KNOWN use cases and the ones this file
 * authors: a known use case with no route is an offer ("Assign"), not an
 * omission, and an authored use case Firn has no floor for is still a row.
 *
 * A row shows what is WAITING for Apply, not only what is applied: a staged
 * route change paints its own model, and a staged unassign paints none. Without
 * that a new assignment would read as "No model" until the write landed.
 *
 * Rows are `role="row"` inside a `role="table"` (#308): the header row names the
 * columns once for assistive technology at every width. An open row and its
 * editor share one `role="rowgroup"`, which is where the editor's `fieldset` —
 * illegal directly inside a row — has a legal home.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  compareString,
  type CapabilityName,
  type ModelProjection,
  type ProviderProjection,
  type RouteProjection,
  type SettingsDiagnostic,
  type ThinkMode,
} from '../../types/golem';
import {
  USE_CASE_FLOORS,
  changeStableID,
  floorShortfalls,
  governedUseCasesOf,
  meetsUseCaseFloor,
  overridesSelector,
  probeRouteChange,
  shortfallLine,
  type Change,
  type Draft,
  type RouteChange,
  type RowMarkers,
} from '../../types/golemConfig';
import { orderModelsForDisplay } from '../../utils/golemModelOrder';
import { formatSettingsDiagnostic } from '../../utils/settingsDiagnostics';
import type { EditorFocusRequest } from './ApplyBar';
import { AssignList, type AssignOption } from './AssignList';
import { Cell, Was } from './Cell';
import styles from './GolemConfig.module.css';
import { RouteEditor } from './RouteEditor';
import { StatusText, type StatusTone } from './StatusText';

/**
 * Editor gate keys. NUL is a Cc rune, so no identifier reaching this surface
 * can collide with one — including the provider names sharing the same set.
 */
export const routeRowKey = (useCase: string): string => `\u0000route\u0000${useCase}`;

/** Firn's known use cases plus the ones this configuration authors. */
export function routeUseCases(routes: readonly RouteProjection[]): string[] {
  const names = new Set<string>([...USE_CASE_FLOORS.keys()]);
  for (const route of routes) names.add(route.useCase);
  return [...names].sort(compareString);
}

/**
 * True while this diagnostic belongs to a route row rather than the page. The
 * workspace calls this to decide what NOT to render above the cards, so both
 * answers come from one rule.
 */
export const routingOwnsDiagnostic = (
  routes: readonly RouteProjection[],
  diagnostic: SettingsDiagnostic
): boolean =>
  diagnostic.subjectKind === 'use_case' && routeUseCases(routes).includes(diagnostic.subjectName);

/** What a row paints: the staged intent when there is one, else the applied truth. */
interface RouteView {
  provider: string;
  model: string;
  think: ThinkMode;
  caps: readonly CapabilityName[];
}

function routeStatus(
  view: RouteView | null,
  useCase: string,
  markers: RowMarkers | undefined,
  sourceReplaced: boolean
): { label: string; tone: StatusTone } {
  // §3.3: No model and Incompatible take precedence over Modified.
  if (view === null) return { label: 'No model', tone: 'dim' };
  if (!meetsUseCaseFloor(useCase, view.caps)) return { label: 'Incompatible', tone: 'bad' };
  if (markers?.needsReview === true) return { label: 'Needs review', tone: 'warn' };
  // A profile or blank source has nothing applied underneath it, so every
  // populated row is a pending change.
  if (markers?.modified === true || sourceReplaced) return { label: 'Modified', tone: 'warn' };
  return { label: 'Ready', tone: 'ok' };
}

export interface RoutingCardProps {
  routes: RouteProjection[];
  models: ModelProjection[];
  providers: ProviderProjection[];
  /** The raw draft: its source, and the base the editor's preview stages onto. */
  draft: Draft;
  /**
   * The draft's changes AS PROJECTED (`projectDraft().changes`) — never
   * `draft.changes`. A selector group is rebuilt from its last authority, so
   * the raw change a row was staged with can differ from the one Apply sends;
   * painting the raw one would show the user a request that does not exist.
   */
  changes: readonly Change[];
  /** Route-identity row markers from `projectDraft`. */
  rows: ReadonlyMap<string, RowMarkers>;
  /** Role-identity row markers from `projectDraft`. */
  roleRows: ReadonlyMap<string, RowMarkers>;
  /**
   * Staged use case → every use case its selector governs (`projectDraft`).
   * A shared-selector change retargets siblings; the row says so before the
   * editor is opened.
   */
  selectorUseCases: ReadonlyMap<string, readonly string[]>;
  diagnostics: readonly SettingsDiagnostic[];
  /** False while the document is Limited, Invalid, or otherwise unwritable. */
  editable: boolean;
  /** The Apply bar asking for one of this card's editors (§3.3 chips). */
  focusRequest?: EditorFocusRequest | null;
  onStage: (changes: Change[], drop: string[]) => void;
  onUnstagedChange: (rowKey: string, unstaged: boolean) => void;
}

/** The DOM id of a defined-model row: a `role-remove` chip's only target. */
const definedRowId = (role: string): string => `golem-defined-row-${role}`;

export function RoutingCard({
  routes,
  models,
  providers,
  draft,
  changes,
  rows,
  roleRows,
  selectorUseCases,
  diagnostics,
  editable,
  focusRequest = null,
  onStage,
  onUnstagedChange,
}: RoutingCardProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** A fresh object per request, so a repeated chip click focuses again. */
  const [pendingFocus, setPendingFocus] = useState<{ elementId: string } | null>(null);
  /**
   * #284: the staging announcement must outlive the editor that produced it,
   * so the live region is the card's, mounted for the card's whole life.
   */
  const [announcement, setAnnouncement] = useState('');
  /**
   * The row a jump just landed on, for ~1.4s (ruling 7), held as the change
   * identity `route:<useCase>` / `role:<role>`. [X11] Both namespaces flash, and a
   * use case and a model role may legally share a name, so the namespace rides
   * along rather than the bare name. [K4] So does the request's nonce: a SECOND
   * jump to the same row inside the flash window is otherwise an identical
   * `setFlash`, which React bails out of — the attribute never changes and the row
   * the user asked for twice flashes once. [N3] The two live in separate fields
   * rather than one `<key>#<nonce>` string: `#` is a legal identifier character.
   */
  const [flash, setFlash] = useState<{ key: string; nonce: number } | null>(null);
  const flashNonce = (key: string): number | undefined =>
    flash?.key === key ? flash.nonce : undefined;
  /** [W4-3] The defined-model row whose Assign list is open — one at a time — by role. */
  const [assigning, setAssigning] = useState<string | null>(null);
  /**
   * [W4-3] Use case → the defined model its editor opens on, from the Assign
   * list. Read once, when the editor mounts; cleared when that editor closes.
   */
  const [preselect, setPreselect] = useState<ReadonlyMap<string, ModelProjection>>(new Map());

  // More than one row may be expanded at once: collapsing an editor outside
  // its explicit actions would silently discard unstaged fields (§4.6a).
  const openEditor = (useCase: string, elementId: string) => {
    setOpen((current) => (current.has(useCase) ? current : new Set(current).add(useCase)));
    setPendingFocus({ elementId });
    setAnnouncement('');
  };

  /**
   * [C22] `elementId` is the control focus returns to — the row's Edit button,
   * so Cancel lands back where the editor was opened from.
   */
  const close = (useCase: string, elementId?: string) => {
    setOpen((current) => {
      if (!current.has(useCase)) return current;
      const next = new Set(current);
      next.delete(useCase);
      return next;
    });
    setPreselect((current) => {
      if (!current.has(useCase)) return current;
      const next = new Map(current);
      next.delete(useCase);
      return next;
    });
    if (elementId !== undefined) setPendingFocus({ elementId });
  };

  // Named `announceStaged`, not `staged`: the row map below already binds
  // `staged` to the row's Change (`stagedFor(useCase)`), and that shadow
  // would silently turn the handler call into a call on a Change object.
  const announceStaged = (useCase: string, editorId: string, message: string) => {
    setAnnouncement(message);
    close(useCase);
    setPendingFocus({ elementId: `${editorId}-edit` });
  };

  // Two effects, because the editor does not exist until the open state has
  // committed: the first expands the row, the second focuses what that commit
  // mounted. A `role-remove` chip has no editor at all, so it lands on the
  // defined-model row itself.
  useEffect(() => {
    // [A1] The shared boundary: a request can never open editable controls on a
    // locked, consenting, busy, Limited/Invalid or read-only surface.
    if (focusRequest === null || !editable) return;
    const separator = focusRequest.changeId.indexOf(':');
    const namespace = focusRequest.changeId.slice(0, separator);
    const name = focusRequest.changeId.slice(separator + 1);
    if (namespace === 'role') {
      // [X11] A `role-remove` chip has no editor, so the defined-model row itself is
      // the target — and it flashes like any other landed jump.
      setPendingFocus({ elementId: definedRowId(name) });
      setFlash({ key: `role:${name}`, nonce: focusRequest.nonce });
      const roleTimer = window.setTimeout(() => setFlash(null), 1400);
      return () => window.clearTimeout(roleTimer);
    }
    if (namespace !== 'route') {
      setFlash(null); // the jump landed in the other card: no stale flash here
      return;
    }
    const index = routeUseCases(routes).indexOf(name);
    if (index < 0) return;
    const editorId = `golem-route-editor-${index}`;
    openEditor(name, `${editorId}-filter`); // the Model field, not the fieldset
    // [C26] Never interpolate an identifier into a selector (quotes are legal in
    // use-case names); the row carries an index-derived id instead.
    // `scrollIntoView` is optional-called because jsdom does not implement it.
    document.getElementById(`${editorId}-row`)?.scrollIntoView?.({ block: 'center' });
    setFlash({ key: `route:${name}`, nonce: focusRequest.nonce });
    const timer = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(timer);
    // Routes are stable for the life of one card mount (the workspace remounts
    // it when the document moves), so the request alone drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    if (pendingFocus === null) return;
    document.getElementById(pendingFocus.elementId)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const byRole = new Map(models.map((model) => [model.role, model]));
  const byUseCase = new Map(routes.map((route) => [route.useCase, route.role]));
  // Grouped by provider in the providers card's own order, then role-alpha —
  // the one reading order every model list on this surface shares.
  const unrouted = orderModelsForDisplay(
    models.filter((model) => model.routedUseCases.length === 0),
    providers
  );
  const sourceReplaced = draft.source.kind !== 'applied';
  // One object per document: the editor caches its per-card verdicts on it.
  const base = useMemo(() => ({ routes, models }), [routes, models]);

  const stagedFor = (useCase: string): Change | undefined =>
    changes.find((change) => changeStableID(change) === `route:${useCase}`);

  /**
   * [W4-1][#315] The staged route change whose selector `applied` shares, and
   * whether its group is an OVERRIDE (a change onto the model its use case
   * already has — the full facts, as the backend classifies it). Capabilities
   * are one override per selector, so any change onto the selector leaves this
   * row exposing them; think is written selector-wide only by an override
   * (SetRoleOverrides) — a role joining the selector leaves a neighbour with
   * no staged change of its own alone (a staged neighbour takes the group's
   * coalesced Think, on its own row). A sibling the projection marks only
   * through its ROLE — the
   * source role a retarget forks away from, a fallback chain — keeps every
   * applied value: §5.2b, siblings never change silently.
   */
  const governingChange = (
    useCase: string,
    applied: ModelProjection | null
  ): { change: RouteChange; override: boolean } | undefined => {
    if (applied === null) return undefined;
    const group: RouteChange[] = [];
    for (const [stagedUseCase, affected] of selectorUseCases) {
      if (!affected.includes(useCase)) continue;
      const change = stagedFor(stagedUseCase);
      if (
        change?.kind === 'route' &&
        change.modelFacts.provider === applied.provider &&
        change.modelFacts.model === applied.modelName
      )
        group.push(change);
    }
    if (group.length === 0) return undefined;
    return {
      change: group[0],
      override: overridesSelector(base, group, {
        provider: applied.provider,
        model: applied.modelName,
      }),
    };
  };

  const assignId = (index: number): string => `golem-defined-assign-${index}`;

  /**
   * [W4-3] Every use case, with why this model cannot take it — the verdict the
   * picker gives a card, from the same helpers. An open editor is listed
   * disabled rather than re-seeded: re-seeding would drop its unstaged fields.
   */
  const assignOptions = (model: ModelProjection): AssignOption[] =>
    routeUseCases(routes).map((useCase) => {
      if (open.has(useCase)) return { useCase, reason: 'editor open' };
      const short = floorShortfalls(
        model.exposedCapabilities,
        governedUseCasesOf(base, draft, probeRouteChange(useCase, model))
      );
      return { useCase, reason: shortfallLine(short) };
    });

  /** Choosing a use case opens ITS editor on this model — the Edit path, seeded. */
  const assignTo = (model: ModelProjection, useCase: string) => {
    const editorId = `golem-route-editor-${routeUseCases(routes).indexOf(useCase)}`;
    setPreselect((current) => new Map(current).set(useCase, model));
    setAssigning(null);
    openEditor(useCase, editorId);
    document.getElementById(`${editorId}-row`)?.scrollIntoView?.({ block: 'center' });
  };

  /** Close this row's list if it is the open one, without touching another row's. */
  const dropAssign = (role: string) => setAssigning((open) => (open === role ? null : open));

  /** Escape or a second press: the list unmounts and focus returns to the trigger it opened from. */
  const closeAssign = (index: number) => {
    setAssigning(null);
    setPendingFocus({ elementId: `${assignId(index)}-trigger` });
  };

  const rowDiagnostics = (useCase: string) =>
    diagnostics.filter(
      (diagnostic) => diagnostic.subjectKind === 'use_case' && diagnostic.subjectName === useCase
    );

  return (
    <section className={styles.card} aria-labelledby="golem-config-routing">
      <div className={styles.cardHead}>
        <h3 id="golem-config-routing" className={styles.cardTitle}>
          Model Routing
        </h3>
        <span className={styles.hint}>assign a model to each use case</span>
      </div>
      <div className={styles.cardBody}>
        {/* §4.6 bootstrap: an empty section names its prerequisite. The rows
            below still list every known use case, so the offer is visible. */}
        {models.length === 0 && (
          <p className={styles.empty}>
            Add a provider, then assign a model to each use case — nothing is routed yet.
          </p>
        )}
        <div
          className={`${styles.table} ${styles.routeTable}`}
          role="table"
          aria-label="Model routing"
        >
          <div className={styles.headRow} role="row">
            <span role="columnheader">Use case</span>
            <span role="columnheader">Provider</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">Think</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">
              <span className={styles.srOnly}>Actions</span>
            </span>
          </div>
          {routeUseCases(routes).map((useCase, index) => {
            const role = byUseCase.get(useCase) ?? null;
            const applied = role === null ? null : (byRole.get(role) ?? null);
            const staged = stagedFor(useCase);
            const governing = staged === undefined ? governingChange(useCase, applied) : undefined;
            const view: RouteView | null =
              staged?.kind === 'route'
                ? {
                    provider: staged.modelFacts.provider,
                    model: staged.modelFacts.model,
                    think: staged.thinkMode,
                    caps: staged.exposedCaps,
                  }
                : staged?.kind === 'route-unassign' || applied === null
                  ? null
                  : {
                      provider: applied.provider,
                      model: applied.modelName,
                      think:
                        governing?.override === true
                          ? governing.change.thinkMode
                          : applied.thinkMode,
                      // Never empty: the editor and both request parsers refuse an
                      // empty exposure [W5-1].
                      caps:
                        governing !== undefined
                          ? governing.change.exposedCaps
                          : applied.exposedCapabilities,
                    };
            const markers = rows.get(useCase);
            const status = routeStatus(view, useCase, markers, sourceReplaced);
            const expanded = open.has(useCase);
            const editorId = `golem-route-editor-${index}`;
            const notices = rowDiagnostics(useCase);
            /**
             * The routes this row's APPLIED model also serves — the same
             * derivation RouteEditor's `sharedRole` makes from the same
             * `current` object, so the row marker can never disagree with
             * the notice inside the open editor. While a route change is
             * staged the row's headline paints the STAGED model, and this
             * coupling belongs to the model being replaced — describing the
             * displayed model with the old model's marker would be a lie, so
             * the marker is suppressed until the row shows the applied truth.
             */
            const shared =
              staged?.kind === 'route'
                ? []
                : (applied?.routedUseCases ?? []).filter((other) => other !== useCase);
            // Ruling 7: one `WAS` line per field whose APPLIED value differs — `applied`
            // being the DRAFT BASE row [A2]. [C23] The stripe itself follows the projected
            // row marker — the shipped definition of "this row has a staged change" — so
            // think-only, exposure-only and assign-into-empty changes stripe too. [C5] Only
            // `modified`: `keyStaged` is set on PROVIDER rows alone, so the disjunct this
            // line used to carry could never be true here.
            const changed = markers?.modified === true;
            const wasModel =
              staged?.kind === 'route' &&
              applied !== null &&
              staged.modelFacts.model !== applied.modelName
                ? applied.modelName
                : null;
            const wasProvider =
              staged?.kind === 'route' &&
              applied !== null &&
              staged.modelFacts.provider !== applied.provider
                ? applied.provider
                : null;
            /** The think mode about to land on this row: its own staged change's, or — only for an override group — the sibling's. */
            const incomingThink =
              staged?.kind === 'route'
                ? staged.thinkMode
                : governing?.override === true
                  ? governing.change.thinkMode
                  : undefined;
            const wasThink =
              incomingThink !== undefined && applied !== null && incomingThink !== applied.thinkMode
                ? applied.thinkMode === ''
                  ? '—'
                  : applied.thinkMode
                : null;
            const wasAssigned =
              staged?.kind === 'route-unassign' && applied !== null ? applied.modelName : null;
            const alsoAffects = (selectorUseCases.get(useCase) ?? []).filter(
              (other) => other !== useCase
            );

            const row = (
              <div
                key={`row:${useCase}`}
                id={`${editorId}-row`}
                role="row"
                data-testid={`route-row-${useCase}`}
                className={styles.row}
                data-expanded={expanded || undefined}
                data-changed={changed || undefined}
                data-flash={flashNonce(`route:${useCase}`)}
              >
                <Cell className={styles.useCase}>
                  {useCase}
                  {expanded && <span className={styles.editingTag}>editing</span>}
                </Cell>
                <Cell className={styles.providerCell}>
                  {view ? view.provider : <span className={styles.absent}>—</span>}
                  {wasProvider !== null && <Was value={wasProvider} />}
                </Cell>
                <Cell className={styles.modelCell}>
                  {/* The role a broken route still names is the only lead a
                      reader has for repairing it externally, so it is
                      meaningful copy rather than an inert placeholder. */}
                  {view ? (
                    <>
                      {view.model}
                      {/* The coupling, surfaced BEFORE the editor opens: a
                          neutral fact, the sibling names one hover away.
                          Hidden while the row is expanded — the editor's
                          info notice tells the same fact in full. */}
                      {!expanded && shared.length > 0 && (
                        <span className={styles.sharedMarker} title={shared.join(', ')}>
                          {`shared with ${shared.length} other${shared.length === 1 ? '' : 's'}`}
                        </span>
                      )}
                    </>
                  ) : role !== null && staged?.kind !== 'route-unassign' ? (
                    `role ${role} has no model`
                  ) : (
                    <span className={styles.absent}>—</span>
                  )}
                  {(wasModel ?? wasAssigned) !== null && <Was value={(wasModel ?? wasAssigned)!} />}
                  {/* Shared-selector changes retarget siblings: the fact the
                      editor's disclosure already tells, surfaced on the row. */}
                  {changed && alsoAffects.length > 0 && (
                    <small
                      className={styles.usedBy}
                    >{`also affects ${alsoAffects.join(', ')}`}</small>
                  )}
                </Cell>
                <Cell label="Think" className={styles.metaCell}>
                  {view && view.think !== '' ? (
                    view.think
                  ) : (
                    <span className={styles.absent}>—</span>
                  )}
                  {wasThink !== null && <Was value={wasThink} />}
                </Cell>
                {/* Ruling 6: an open row carries the EDITING tag beside its use
                    case, so the status column reports nothing while it edits. */}
                <Cell className={styles.statusCell}>
                  {!expanded && <StatusText tone={status.tone}>{status.label}</StatusText>}
                </Cell>
                <Cell className={styles.actionsCell}>
                  {editable && (
                    <button
                      type="button"
                      id={`${editorId}-edit`}
                      className={`${styles.button} ${styles.small}`}
                      aria-expanded={expanded}
                      aria-controls={editorId}
                      onClick={() => openEditor(useCase, editorId)}
                    >
                      {role === null ? 'Assign' : 'Edit'}
                      <span className={styles.srOnly}>{` route ${useCase}`}</span>
                    </button>
                  )}
                </Cell>
              </div>
            );

            const detail = (
              <>
                {notices.map((diagnostic, position) => (
                  <div
                    key={`${diagnostic.code}-${position}`}
                    role="row"
                    className={styles.detailRow}
                  >
                    <p
                      role="cell"
                      aria-colspan={6}
                      className={styles.rowDiagnostic}
                      data-tone={diagnostic.blocking ? 'blocking' : 'caution'}
                    >
                      {
                        formatSettingsDiagnostic(
                          diagnostic.code,
                          diagnostic.subjectKind,
                          diagnostic.subjectName
                        ).text
                      }
                    </p>
                  </div>
                ))}
                {expanded && (
                  <div role="row" className={styles.detailRow}>
                    {/* [C21] Visual spanning is not accessible spanning: name the span. */}
                    <div role="cell" aria-colspan={6} className={styles.editorCell}>
                      <RouteEditor
                        id={editorId}
                        useCase={useCase}
                        role={role}
                        current={applied}
                        providers={providers}
                        models={models}
                        base={base}
                        draft={draft}
                        staged={staged}
                        preselect={preselect.get(useCase)}
                        rowKey={routeRowKey(useCase)}
                        onStage={onStage}
                        onClose={() => close(useCase, `${editorId}-edit`)}
                        onUnstagedChange={onUnstagedChange}
                        onStaged={(message) => announceStaged(useCase, editorId, message)}
                      />
                    </div>
                  </div>
                )}
              </>
            );

            // Ruling 6: an open row and its editor are ONE outlined group. [C6] The wrapper's
            // key differs from the bare row's: with the same key React would reuse the row's
            // DOM node AS the group and slide a new row inside it. [X1] The discriminator is a
            // PREFIX, not a suffix: `a` and `a:group` are both legal use-case names, so a
            // suffix would let one row's group key collide with another row's key.
            return expanded || notices.length > 0 ? (
              <div
                key={`group:${useCase}`}
                role="rowgroup"
                className={expanded ? styles.editGroup : styles.noticeGroup}
              >
                {row}
                {detail}
              </div>
            ) : (
              row
            );
          })}
        </div>

        <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>

        {unrouted.length > 0 && (
          <>
            <h4 id="golem-config-defined-models" className={styles.subgroup}>
              Defined models
            </h4>
            <p className={styles.empty}>
              Defined in the file but not routed to any use case — directly or through a fallback.
            </p>
            <div
              className={`${styles.table} ${styles.definedTable}`}
              role="table"
              aria-labelledby="golem-config-defined-models"
            >
              <div className={styles.headRow} role="row">
                <span role="columnheader">Role</span>
                <span role="columnheader">Provider</span>
                <span role="columnheader">Model</span>
                <span role="columnheader">
                  <span className={styles.srOnly}>Actions</span>
                </span>
              </div>
              {unrouted.map((model, index) => {
                const markers = roleRows.get(model.role);
                const listId = assignId(index);
                // [C3] A row staged for removal offers nothing to route to.
                const canAssign = editable && markers?.modified !== true;
                const listOpen = canAssign && assigning === model.role;
                const row = (
                  <div
                    key={`row:${model.role}`}
                    role="row"
                    id={definedRowId(model.role)}
                    tabIndex={-1}
                    data-testid={`defined-model-row-${model.role}`}
                    className={styles.row}
                    data-expanded={listOpen || undefined}
                    // [X11] A staged `role-remove` stripes its row like every other
                    // staged change, and a landed `role:` jump flashes it.
                    data-changed={markers?.modified === true || undefined}
                    data-flash={flashNonce(`role:${model.role}`)}
                  >
                    {/* [W4-3] A role and a use case may share a name (`agent`): the record
                        form says which this is, the way TYPE / THINK label their cells. */}
                    <Cell label="Role" className={styles.identifier}>
                      {model.role}
                    </Cell>
                    <Cell className={styles.providerCell}>{model.provider}</Cell>
                    <Cell className={styles.modelCell}>{model.modelName}</Cell>
                    <Cell className={styles.actionsCell}>
                      {markers?.needsReview === true && (
                        <StatusText tone="warn">Needs review</StatusText>
                      )}
                      {markers?.needsReview !== true && markers?.modified === true && (
                        <StatusText tone="warn">Modified</StatusText>
                      )}
                      {/* An inline disclosure (W4-3), so no aria-haspopup: expanded +
                          controls describe it. It routes the MODEL — the backend never
                          binds the defined role itself — so the name says which model. */}
                      {canAssign && (
                        <button
                          type="button"
                          id={`${listId}-trigger`}
                          className={`${styles.button} ${styles.small}`}
                          aria-expanded={listOpen}
                          aria-controls={listOpen ? listId : undefined}
                          onClick={() => (listOpen ? closeAssign(index) : setAssigning(model.role))}
                        >
                          Assign…
                          <span className={styles.srOnly}>
                            {` model ${model.modelName}, role ${model.role}`}
                          </span>
                        </button>
                      )}
                      {/* §5.2b: removal is guarded backend-side and offered only
                          for a role the projection reports as unreferenced —
                          fallback targets included. Once staged, the same
                          control takes it back: re-pressing Remove would only
                          re-stage the identity it already holds, which is no
                          undo at all. Either press closes this row's Assign
                          list for good: left merely hidden, it would remount
                          and take focus when the removal is unstaged. */}
                      {editable &&
                        model.removable &&
                        (markers?.modified === true ? (
                          <button
                            type="button"
                            className={`${styles.button} ${styles.small} ${styles.quiet}`}
                            onClick={() => {
                              dropAssign(model.role);
                              onStage([], [`role:${model.role}`]);
                            }}
                          >
                            Unstage removal
                            <span className={styles.srOnly}>{` of model role ${model.role}`}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={`${styles.button} ${styles.small} ${styles.quiet}`}
                            onClick={() => {
                              dropAssign(model.role);
                              onStage([{ kind: 'role-remove', role: model.role }], []);
                            }}
                          >
                            Remove
                            <span className={styles.srOnly}>{` model role ${model.role}`}</span>
                          </button>
                        ))}
                    </Cell>
                  </div>
                );
                // [C6] The group's key differs from the row's: the same rule as the route rows.
                return listOpen ? (
                  <div key={`group:${model.role}`} role="rowgroup" className={styles.editGroup}>
                    {row}
                    <div role="row" className={styles.detailRow}>
                      {/* [C21] Name the span: four columns in this table. */}
                      <div role="cell" aria-colspan={4} className={styles.editorCell}>
                        <AssignList
                          id={listId}
                          modelName={model.modelName}
                          options={assignOptions(model)}
                          onChoose={(useCase) => assignTo(model, useCase)}
                          onClose={() => closeAssign(index)}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  row
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
