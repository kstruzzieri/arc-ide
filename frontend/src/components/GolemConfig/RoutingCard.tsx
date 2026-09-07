/**
 * Model routing section card (#263 spec §4.1/§4.2/§4.3, mockup v10).
 *
 * One strip per use case, joined to the model its role resolves to, and a
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
 * Strips are list items, matching the dock readout's `ul`/`li` rows, so each row
 * has a boundary in the accessibility tree — and so the editor's `fieldset`,
 * which a `role="row"` would forbid, has a legal home.
 */

import { useEffect, useState } from 'react';
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
  meetsUseCaseFloor,
  type Change,
  type Draft,
  type RowMarkers,
} from '../../types/golemConfig';
import { orderModelsForDisplay } from '../../utils/golemModelOrder';
import { formatSettingsDiagnostic } from '../../utils/settingsDiagnostics';
import type { EditorFocusRequest } from './ApplyBar';
import { Cell } from './Cell';
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
  diagnostics,
  editable,
  focusRequest = null,
  onStage,
  onUnstagedChange,
}: RoutingCardProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** A fresh object per request, so a repeated chip click focuses again. */
  const [pendingFocus, setPendingFocus] = useState<{ elementId: string } | null>(null);

  // More than one row may be expanded at once: collapsing an editor outside
  // its explicit actions would silently discard unstaged fields (§4.6a).
  const openEditor = (useCase: string, elementId: string) => {
    setOpen((current) => (current.has(useCase) ? current : new Set(current).add(useCase)));
    setPendingFocus({ elementId });
  };

  const close = (useCase: string) =>
    setOpen((current) => {
      if (!current.has(useCase)) return current;
      const next = new Set(current);
      next.delete(useCase);
      return next;
    });

  // Two effects, because the editor does not exist until the open state has
  // committed: the first expands the row, the second focuses what that commit
  // mounted. A `role-remove` chip has no editor at all, so it lands on the
  // defined-model row itself.
  useEffect(() => {
    if (focusRequest === null) return;
    const separator = focusRequest.changeId.indexOf(':');
    const namespace = focusRequest.changeId.slice(0, separator);
    const name = focusRequest.changeId.slice(separator + 1);
    if (namespace === 'role') {
      setPendingFocus({ elementId: definedRowId(name) });
      return;
    }
    if (namespace !== 'route') return;
    const index = routeUseCases(routes).indexOf(name);
    if (index < 0) return;
    setOpen((current) => (current.has(name) ? current : new Set(current).add(name)));
    setPendingFocus({ elementId: `golem-route-editor-${index}` });
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
  const base = { routes, models };

  const stagedFor = (useCase: string): Change | undefined =>
    changes.find((change) => changeStableID(change) === `route:${useCase}`);

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
        {/* Decorative: every cell below names its own column. */}
        <div className={`${styles.columns} ${styles.routeGrid}`} aria-hidden="true">
          <span>Use case</span>
          <span>Provider</span>
          <span>Model</span>
          <span>Think</span>
          <span>Status</span>
          <span />
        </div>
        <ul className={styles.rows} aria-label="Model routing">
          {routeUseCases(routes).map((useCase, index) => {
            const role = byUseCase.get(useCase) ?? null;
            const applied = role === null ? null : (byRole.get(role) ?? null);
            const staged = stagedFor(useCase);
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
                      think: applied.thinkMode,
                      caps: applied.exposedCapabilities,
                    };
            const markers = rows.get(useCase);
            const status = routeStatus(view, useCase, markers, sourceReplaced);
            const expanded = open.has(useCase);
            const editorId = `golem-route-editor-${index}`;
            const notices = rowDiagnostics(useCase);
            /**
             * The routes this row's APPLIED model also serves — the same
             * derivation RouteEditor's `sharedRole` makes from the same
             * `current` object, so the strip marker can never disagree with
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

            return (
              <li key={useCase} data-testid={`route-row-${useCase}`} className={styles.row}>
                <div
                  className={`${styles.strip} ${styles.routeGrid}`}
                  data-expanded={expanded || undefined}
                >
                  <Cell label="Use case" className={styles.useCase}>
                    {useCase}
                  </Cell>
                  <Cell label="Provider" className={styles.meta}>
                    {view ? view.provider : <span className={styles.absent}>—</span>}
                  </Cell>
                  <Cell label="Model" className={styles.value}>
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
                  </Cell>
                  <Cell label="Think" className={`${styles.meta} ${styles.thinkCell}`}>
                    {view && view.think !== '' ? (
                      view.think
                    ) : (
                      <span className={styles.absent}>—</span>
                    )}
                  </Cell>
                  <Cell label="Status">
                    {expanded ? (
                      <StatusText tone="dim">editing…</StatusText>
                    ) : (
                      <StatusText tone={status.tone}>{status.label}</StatusText>
                    )}
                  </Cell>
                  <span className={styles.rowActions}>
                    {editable && (
                      <button
                        type="button"
                        className={styles.button}
                        aria-expanded={expanded}
                        aria-controls={editorId}
                        onClick={() => openEditor(useCase, editorId)}
                      >
                        {role === null ? 'Assign' : 'Edit'}
                        <span className={styles.srOnly}>{` route ${useCase}`}</span>
                      </button>
                    )}
                  </span>
                </div>

                {notices.map((diagnostic, position) => (
                  <p
                    key={`${diagnostic.code}-${position}`}
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
                ))}

                {expanded && (
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
                    rowKey={routeRowKey(useCase)}
                    onStage={onStage}
                    onClose={() => close(useCase)}
                    onUnstagedChange={onUnstagedChange}
                  />
                )}
              </li>
            );
          })}
        </ul>

        {unrouted.length > 0 && (
          <>
            <h4 id="golem-config-defined-models" className={styles.subgroup}>
              Defined models
            </h4>
            <p className={styles.empty}>
              Defined in the file but not routed to any use case — directly or through a fallback.
            </p>
            <div className={`${styles.columns} ${styles.definedGrid}`} aria-hidden="true">
              <span>Role</span>
              <span>Provider</span>
              <span>Model</span>
              <span />
            </div>
            <ul className={styles.rows} aria-labelledby="golem-config-defined-models">
              {unrouted.map((model) => {
                const markers = roleRows.get(model.role);
                return (
                  <li
                    key={model.role}
                    id={definedRowId(model.role)}
                    tabIndex={-1}
                    data-testid={`defined-model-row-${model.role}`}
                    className={`${styles.strip} ${styles.definedGrid}`}
                  >
                    <Cell label="Role" className={styles.identifier}>
                      {model.role}
                    </Cell>
                    <Cell label="Provider" className={styles.meta}>
                      {model.provider}
                    </Cell>
                    <Cell label="Model" className={styles.value}>
                      {model.modelName}
                    </Cell>
                    <span className={styles.rowActions}>
                      {markers?.needsReview === true && (
                        <StatusText tone="warn">Needs review</StatusText>
                      )}
                      {markers?.needsReview !== true && markers?.modified === true && (
                        <StatusText tone="warn">Modified</StatusText>
                      )}
                      {/* §5.2b: removal is guarded backend-side and offered only
                          for a role the projection reports as unreferenced —
                          fallback targets included. Once staged, the same
                          control takes it back: re-pressing Remove would only
                          re-stage the identity it already holds, which is no
                          undo at all. */}
                      {editable &&
                        model.removable &&
                        (markers?.modified === true ? (
                          <button
                            type="button"
                            className={`${styles.button} ${styles.quiet}`}
                            onClick={() => onStage([], [`role:${model.role}`])}
                          >
                            Unstage removal
                            <span className={styles.srOnly}>{` of model role ${model.role}`}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={`${styles.button} ${styles.quiet}`}
                            onClick={() => onStage([{ kind: 'role-remove', role: model.role }], [])}
                          >
                            Remove
                            <span className={styles.srOnly}>{` model role ${model.role}`}</span>
                          </button>
                        ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
