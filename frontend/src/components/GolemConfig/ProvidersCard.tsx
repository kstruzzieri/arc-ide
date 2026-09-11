/**
 * Providers section card (#263 spec §4.1/§4.3b, mockup v10): a header bar over a
 * table of provider records, each of which expands in place into its editor.
 *
 * Rows are `role="row"` inside a `role="table"` (#308): the header row names the
 * columns once for assistive technology at every width. An open row and its
 * editor share one `role="rowgroup"`, which is where the editor's `fieldset` —
 * illegal directly inside a row — has a legal home.
 *
 * The card owns which rows are expanded and nothing else: the draft, the key
 * vault, and every staged change live at the workspace root (spec §3.2).
 */

import { useEffect, useState } from 'react';
import type { ProviderProjection, SettingsDiagnostic } from '../../types/golem';
import {
  changeStableID,
  type Change,
  type KeyVault,
  type RowMarkers,
} from '../../types/golemConfig';
import { formatSettingsDiagnostic } from '../../utils/settingsDiagnostics';
import type { EditorFocusRequest } from './ApplyBar';
import { Cell, Was } from './Cell';
import styles from './GolemConfig.module.css';
import { ProviderEditor } from './ProviderEditor';
import { StatusText, type StatusTone } from './StatusText';

const CLASSIFICATION_LABEL: Record<ProviderProjection['classification'], string> = {
  local: 'Local',
  remote: 'Remote',
  unknown: 'Unknown',
};

const CREDENTIAL: Record<
  ProviderProjection['credentialState'],
  { label: string; tone: StatusTone }
> = {
  none: { label: 'No key', tone: 'dim' },
  available: { label: 'Key present', tone: 'ok' },
  reference_unavailable: { label: 'Key reference unavailable', tone: 'bad' },
};

/**
 * The add editor's gate key. A provider name can never collide with it: NUL is
 * a Cc rune, and every identifier that reaches this surface is Cc/Cf-free.
 */
const ADD_ROW_KEY = '\u0000add';
const ADD_EDITOR_ID = 'golem-provider-add';
/** [F6] The control the add form was opened from, so closing it lands focus back there. */
const ADD_TRIGGER_ID = 'golem-provider-add-button';

const appliedEditorID = (index: number): string => `golem-provider-editor-${index}`;
const stagedEditorID = (index: number): string => `golem-provider-staged-editor-${index}`;

export interface ProvidersCardProps {
  providers: ProviderProjection[];
  /** Providers a defined model still references; removal is refused for these. */
  usedProviders: readonly string[];
  /**
   * [A2] provider → the use cases that reach it AFTER Apply, from the one
   * derived view (`providerUsage(effectiveRoutes(base, changes))`). A provider
   * absent from the map is routed by nothing.
   */
  usage: ReadonlyMap<string, readonly string[]>;
  /** Staged changes, so a reopened editor shows what is waiting for Apply. */
  changes: readonly Change[];
  /** Provider-identity row markers from `projectDraft`. */
  rows: ReadonlyMap<string, RowMarkers>;
  /** Diagnostics already scoped to provider rows by the workspace. */
  diagnostics: readonly SettingsDiagnostic[];
  /**
   * Providers this draft is CREATING, projected from the staged `provider-add`
   * changes. They get real strips: a staged add has nothing applied underneath
   * it, so without one there is no way to reopen it, correct it, or take it
   * back short of discarding the whole draft (§4.3b).
   */
  stagedProviders?: readonly ProviderProjection[];
  vault: KeyVault;
  /** False while the document is Limited, Invalid, or otherwise unwritable. */
  editable: boolean;
  /** The Apply bar asking for one of this card's editors (§3.3 chips). */
  focusRequest?: EditorFocusRequest | null;
  onStage: (changes: Change[], drop: string[]) => void;
  onUnstagedChange: (rowKey: string, unstaged: boolean) => void;
}

export function ProvidersCard({
  providers,
  usedProviders,
  usage,
  changes,
  rows,
  diagnostics,
  stagedProviders = [],
  vault,
  editable,
  focusRequest = null,
  onStage,
  onUnstagedChange,
}: ProvidersCardProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /**
   * A fresh object per request, so a repeated chip click focuses again. It holds
   * a plain element id, not an editor id: [C22] closing a row hands focus back to
   * that row's Edit button, so one effect serves both directions.
   */
  const [pendingFocus, setPendingFocus] = useState<{ elementId: string } | null>(null);
  /**
   * The provider a jump just landed on, for ~1.4s (ruling 7). [K4] The nonce rides
   * along because a SECOND jump to the same row inside the flash window is an
   * identical `setFlash` — React bails out, the attribute never changes, and the row
   * the user asked for twice flashes once. [N3] Two fields, not one packed string:
   * `#` is a legal identifier character, so `<name>#<nonce>` was ambiguous.
   */
  const [flash, setFlash] = useState<{ key: string; nonce: number } | null>(null);
  const flashNonce = (name: string): number | undefined =>
    flash?.key === name ? flash.nonce : undefined;

  // More than one row may be expanded at once: collapsing an editor outside
  // its explicit actions would silently discard unstaged fields (§4.6a).
  const openEditor = (rowKey: string, editorId: string) => {
    setOpen((current) => (current.has(rowKey) ? current : new Set(current).add(rowKey)));
    setPendingFocus({ elementId: editorId });
  };

  /**
   * [C22] `elementId` is the control focus returns to. Cancel and Done pass the
   * row's Edit button; Unstage passes nothing, because the row it closes is the
   * row it removes.
   */
  const close = (rowKey: string, elementId?: string) => {
    setOpen((current) => {
      if (!current.has(rowKey)) return current;
      const next = new Set(current);
      next.delete(rowKey);
      return next;
    });
    if (elementId !== undefined) setPendingFocus({ elementId });
  };

  // Two effects, because the editor does not exist until the open state has
  // committed: the first expands the row, the second focuses what that commit
  // mounted. Applied and staged providers both have strips, so a chip lands on
  // its own row; only a name with neither falls back to the add form.
  useEffect(() => {
    // [A1] The shared boundary: a request can never open editable controls on a
    // locked, consenting, busy, Limited/Invalid or read-only surface.
    if (focusRequest === null || !editable) return;
    const separator = focusRequest.changeId.indexOf(':');
    const namespace = focusRequest.changeId.slice(0, separator);
    if (namespace !== 'provider' && namespace !== 'provider-key') {
      setFlash(null); // the jump landed in the other card: no stale flash here
      return;
    }
    const name = focusRequest.changeId.slice(separator + 1);
    const applied = providers.findIndex((entry) => entry.name === name);
    const staged = stagedProviders.findIndex((entry) => entry.name === name);
    const editorId =
      applied >= 0
        ? appliedEditorID(applied)
        : staged >= 0
          ? stagedEditorID(staged)
          : ADD_EDITOR_ID;
    const rowKey = applied < 0 && staged < 0 ? ADD_ROW_KEY : name;
    setOpen((current) => (current.has(rowKey) ? current : new Set(current).add(rowKey)));
    // [C24] Land on an ENABLED control named by the change itself. A staged key
    // clear disables the key input, so a key change lands on the editor fieldset
    // — the honest target — rather than on something that cannot take focus.
    const change = stagedFor(focusRequest.changeId);
    setPendingFocus({
      elementId:
        change?.kind === 'provider-update' && change.endpoint !== undefined
          ? `${editorId}-endpoint`
          : change?.kind === 'provider-update' && change.apiFormat !== undefined
            ? `${editorId}-format`
            : editorId,
    });
    // [C26] Never interpolate an identifier into a selector; the row carries an
    // index-derived id. `scrollIntoView` is optional-called: jsdom lacks it.
    document.getElementById(`${editorId}-row`)?.scrollIntoView?.({ block: 'center' });
    setFlash(rowKey === ADD_ROW_KEY ? null : { key: name, nonce: focusRequest.nonce });
    const timer = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(timer);
    // The request alone drives this effect; both lists are read at request
    // time from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    if (pendingFocus === null) return;
    document.getElementById(pendingFocus.elementId)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const stagedFor = (identity: string): Change | undefined =>
    changes.find((change) => changeStableID(change) === identity);

  // Applied names plus names already staged for creation: both would collide.
  const takenNames = [
    ...providers.map((entry) => entry.name),
    ...changes.filter((change) => change.kind === 'provider-add').map((change) => change.name),
  ];

  const rowDiagnostics = (name: string) =>
    diagnostics.filter(
      (diagnostic) => diagnostic.subjectKind === 'provider' && diagnostic.subjectName === name
    );

  /**
   * Applied strips first, then the ones this draft is creating. A staged add
   * carries `applied: null`, which is what makes its editor produce a
   * `provider-add` rather than an update — and what makes reopening it seed
   * from the staged change instead of a document row that does not exist.
   */
  const strips = [
    ...providers.map((provider, index) => ({
      provider,
      applied: provider,
      editorId: appliedEditorID(index),
    })),
    ...stagedProviders.map((provider, index) => ({
      provider,
      applied: null,
      editorId: stagedEditorID(index),
    })),
  ];

  return (
    <section className={styles.card} aria-labelledby="golem-config-providers">
      <div className={styles.cardHead}>
        <h3 id="golem-config-providers" className={styles.cardTitle}>
          Providers
        </h3>
        <span className={styles.hint}>where models run — add these first</span>
        {editable && (
          <>
            <span className={styles.grow} />
            <button
              type="button"
              id={ADD_TRIGGER_ID}
              className={styles.button}
              aria-expanded={open.has(ADD_ROW_KEY)}
              aria-controls={ADD_EDITOR_ID}
              onClick={() => openEditor(ADD_ROW_KEY, ADD_EDITOR_ID)}
            >
              Add provider
            </button>
          </>
        )}
      </div>
      <div className={styles.cardBody}>
        {strips.length === 0 ? (
          <p className={styles.empty}>
            Add a provider first — a provider is the endpoint a model actually runs on, and nothing
            can be routed until one exists.
          </p>
        ) : (
          <div
            className={`${styles.table} ${styles.providerTable}`}
            role="table"
            aria-label="Providers"
          >
            <div className={styles.headRow} role="row">
              <span role="columnheader">Provider</span>
              <span role="columnheader">Endpoint</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">API key</span>
              <span role="columnheader">
                <span className={styles.srOnly}>Actions</span>
              </span>
            </div>
            {strips.map(({ provider, applied, editorId }) => {
              // [N2] React identity is the LIST + NAME, never the positional
              // `editorId`: unstaging one staged add shifts every later index, and an
              // index-keyed strip is remounted — silently discarding the unstaged edits
              // in its open editor (§4.6a). Names are unique within each list
              // (`takenNames` refuses a collision), and the list half keeps an applied
              // strip apart from a staged add of the same name [K6].
              const identity = `${applied === null ? 'staged' : 'applied'}:${provider.name}`;
              const credential = CREDENTIAL[provider.credentialState];
              const markers = rows.get(provider.name);
              const expanded = open.has(provider.name);
              const notices = rowDiagnostics(provider.name);
              const usedBy = usage.get(provider.name) ?? [];
              const stagedUpdate = stagedFor(`provider:${provider.name}`);
              // The row shows what is WAITING for Apply, as the routing card already does.
              const update = stagedUpdate?.kind === 'provider-update' ? stagedUpdate : undefined;
              const endpoint = update?.endpoint ?? provider.endpoint;
              const apiFormat = update?.apiFormat ?? provider.apiFormat;
              // Ruling 7: a `WAS` line per field whose DRAFT BASE value differs [A2].
              const wasEndpoint =
                update?.endpoint !== undefined &&
                applied !== null &&
                update.endpoint !== applied.endpoint
                  ? applied.endpoint
                  : null;
              const wasFormat =
                update?.apiFormat !== undefined &&
                applied !== null &&
                update.apiFormat !== applied.apiFormat
                  ? applied.apiFormat
                  : null;
              // [C23] Stripe from the projected marker (covers adds, removes, key-only changes).
              const changed = markers?.modified === true || markers?.keyStaged === true;
              const row = (
                <div
                  key={`row:${identity}`}
                  id={`${editorId}-row`}
                  role="row"
                  data-testid={`provider-row-${provider.name}`}
                  className={styles.row}
                  data-expanded={expanded || undefined}
                  data-changed={changed || undefined}
                  data-flash={flashNonce(provider.name)}
                >
                  <Cell className={styles.identifier}>{provider.name}</Cell>
                  <Cell className={styles.endpointCell}>
                    {/* Meaningful, not inert: an empty endpoint is the whole
                        misconfiguration signal, so it keeps readable copy. */}
                    {endpoint === '' ? 'no endpoint' : endpoint}
                    {wasEndpoint !== null && <Was value={wasEndpoint} />}
                    {/* [C30] `not routed` is information, not an inert placeholder. */}
                    <small className={styles.usedBy}>
                      {usedBy.length > 0 ? `used by ${usedBy.join(', ')}` : 'not routed'}
                    </small>
                  </Cell>
                  <Cell label="Type" className={styles.metaCell}>
                    {/* [A2] A staged endpoint is classified by the backend on Apply, so
                        the row says Pending rather than repeating a stale verdict. */}
                    {wasEndpoint !== null ? (
                      <span className={styles.pending}>Pending</span>
                    ) : (
                      CLASSIFICATION_LABEL[provider.classification]
                    )}
                    <span className={styles.metaSub}>{apiFormat}</span>
                    {wasFormat !== null && <Was value={wasFormat} />}
                  </Cell>
                  <Cell label="API key" className={styles.metaCell}>
                    {markers?.keyStaged === true ? (
                      <StatusText tone="warn">Key staged</StatusText>
                    ) : (
                      <StatusText tone={credential.tone}>{credential.label}</StatusText>
                    )}
                  </Cell>
                  <Cell className={styles.actionsCell}>
                    <RowStatus expanded={expanded} markers={markers} />
                    {editable && (
                      <button
                        type="button"
                        id={`${editorId}-edit`}
                        className={`${styles.button} ${styles.small}`}
                        aria-expanded={expanded}
                        aria-controls={editorId}
                        onClick={() => openEditor(provider.name, editorId)}
                      >
                        Edit
                        <span className={styles.srOnly}>{` provider ${provider.name}`}</span>
                      </button>
                    )}
                    {/* A staged add has nothing applied to revert TO, so
                        taking it back is unstaging it — the key operation
                        it may carry goes with it (§3.3). */}
                    {editable && applied === null && (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.small} ${styles.quiet}`}
                        onClick={() => {
                          close(provider.name);
                          onStage(
                            [],
                            [`provider:${provider.name}`, `provider-key:${provider.name}`]
                          );
                        }}
                      >
                        Unstage
                        <span className={styles.srOnly}>{` provider ${provider.name}`}</span>
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
                        aria-colspan={5}
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
                      <div role="cell" aria-colspan={5} className={styles.editorCell}>
                        <ProviderEditor
                          id={editorId}
                          provider={applied}
                          staged={stagedFor(`provider:${provider.name}`)}
                          stagedKey={stagedFor(`provider-key:${provider.name}`)}
                          takenNames={takenNames}
                          inUse={usedProviders.includes(provider.name)}
                          vault={vault}
                          rowKey={provider.name}
                          onStage={onStage}
                          onClose={() => close(provider.name, `${editorId}-edit`)}
                          onUnstagedChange={onUnstagedChange}
                        />
                      </div>
                    </div>
                  )}
                </>
              );
              // Ruling 6: an open row and its editor are ONE outlined group. [C6] The wrapper's
              // key differs from the bare row's: with the same key React would reuse the row's
              // DOM node AS the group and slide a new row inside it. [K6][N2] Both keys are built
              // on `identity` — list plus name — which is unique per STRIP and position-free:
              // keying on the name alone collided an applied strip with a staged add of the same
              // name, which a profile_source reload that keeps the draft produces.
              return expanded || notices.length > 0 ? (
                <div
                  key={`group:${identity}`}
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
        )}

        {open.has(ADD_ROW_KEY) && (
          <ProviderEditor
            id={ADD_EDITOR_ID}
            provider={null}
            takenNames={takenNames}
            inUse={false}
            vault={vault}
            rowKey={ADD_ROW_KEY}
            // Staging hands the change to its own strip above, so the blank
            // form closes rather than lingering as a second copy of a provider
            // that now exists in the draft.
            onStage={(changes, drop) => {
              onStage(changes, drop);
              close(ADD_ROW_KEY, ADD_TRIGGER_ID);
            }}
            onClose={() => close(ADD_ROW_KEY, ADD_TRIGGER_ID)}
            onUnstagedChange={onUnstagedChange}
          />
        )}
      </div>
    </section>
  );
}

/** §4.2: an open row reports only that it is being edited (ruling 6: a tag, not a status). */
function RowStatus({ expanded, markers }: { expanded: boolean; markers?: RowMarkers }) {
  if (expanded) return <span className={styles.editingTag}>editing</span>;
  if (markers === undefined) return null;
  if (markers.needsReview) return <StatusText tone="warn">Needs review</StatusText>;
  if (markers.modified) return <StatusText tone="warn">Modified</StatusText>;
  return null;
}
