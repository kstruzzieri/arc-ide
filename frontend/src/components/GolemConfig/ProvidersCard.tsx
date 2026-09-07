/**
 * Providers section card (#263 spec §4.1/§4.3b, mockup v10): a header bar with
 * an accent edge over separated row strips, each of which expands in place into
 * its editor.
 *
 * Strips are list items, matching the dock readout's `ul`/`li` rows, so each row
 * has a boundary in the accessibility tree — and so the editor's `fieldset`,
 * which a `role="row"` would forbid, has a legal home.
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
import { Cell } from './Cell';
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

const appliedEditorID = (index: number): string => `golem-provider-editor-${index}`;
const stagedEditorID = (index: number): string => `golem-provider-staged-editor-${index}`;

export interface ProvidersCardProps {
  providers: ProviderProjection[];
  /** Providers a defined model still references; removal is refused for these. */
  usedProviders: readonly string[];
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
  /** A fresh object per request, so a repeated chip click focuses again. */
  const [pendingFocus, setPendingFocus] = useState<{ editorId: string } | null>(null);

  // More than one row may be expanded at once: collapsing an editor outside
  // its explicit actions would silently discard unstaged fields (§4.6a).
  const openEditor = (rowKey: string, editorId: string) => {
    setOpen((current) => (current.has(rowKey) ? current : new Set(current).add(rowKey)));
    setPendingFocus({ editorId });
  };

  const close = (rowKey: string) =>
    setOpen((current) => {
      if (!current.has(rowKey)) return current;
      const next = new Set(current);
      next.delete(rowKey);
      return next;
    });

  // Two effects, because the editor does not exist until the open state has
  // committed: the first expands the row, the second focuses what that commit
  // mounted. Applied and staged providers both have strips, so a chip lands on
  // its own row; only a name with neither falls back to the add form.
  useEffect(() => {
    if (focusRequest === null) return;
    const separator = focusRequest.changeId.indexOf(':');
    const namespace = focusRequest.changeId.slice(0, separator);
    if (namespace !== 'provider' && namespace !== 'provider-key') return;
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
    setPendingFocus({ editorId });
    // Both lists are stable for the life of one card mount (the workspace
    // remounts it when the document moves), so the request alone drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    if (pendingFocus === null) return;
    document.getElementById(pendingFocus.editorId)?.focus();
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
          <>
            {/* Decorative: every cell below names its own column. */}
            <div className={`${styles.columns} ${styles.providerGrid}`} aria-hidden="true">
              <span>Provider</span>
              <span>Endpoint</span>
              <span>Type</span>
              <span>API key</span>
              <span />
            </div>
            <ul className={styles.rows} aria-label="Providers">
              {strips.map(({ provider, applied, editorId }) => {
                const credential = CREDENTIAL[provider.credentialState];
                const markers = rows.get(provider.name);
                const expanded = open.has(provider.name);
                const notices = rowDiagnostics(provider.name);
                return (
                  <li
                    key={provider.name}
                    data-testid={`provider-row-${provider.name}`}
                    className={styles.row}
                  >
                    <div
                      className={`${styles.strip} ${styles.providerGrid}`}
                      data-expanded={expanded || undefined}
                    >
                      <Cell label="Provider" className={styles.identifier}>
                        {provider.name}
                      </Cell>
                      <Cell label="Endpoint" className={styles.value}>
                        {/* Meaningful, not inert: an empty endpoint is the whole
                            misconfiguration signal, so it keeps readable copy. */}
                        {provider.endpoint === '' ? 'no endpoint' : provider.endpoint}
                      </Cell>
                      <Cell label="Type" className={styles.meta}>
                        {CLASSIFICATION_LABEL[provider.classification]}
                        <span className={styles.metaSub}>{provider.apiFormat}</span>
                      </Cell>
                      <Cell label="API key">
                        {markers?.keyStaged === true ? (
                          <StatusText tone="warn">Key staged</StatusText>
                        ) : (
                          <StatusText tone={credential.tone}>{credential.label}</StatusText>
                        )}
                      </Cell>
                      <span className={styles.rowActions}>
                        <RowStatus expanded={expanded} markers={markers} />
                        {editable && (
                          <button
                            type="button"
                            className={styles.button}
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
                            className={`${styles.button} ${styles.quiet}`}
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
                        onClose={() => close(provider.name)}
                        onUnstagedChange={onUnstagedChange}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
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
              close(ADD_ROW_KEY);
            }}
            onClose={() => close(ADD_ROW_KEY)}
            onUnstagedChange={onUnstagedChange}
          />
        )}
      </div>
    </section>
  );
}

/** §4.2: an open row reports only that it is being edited. */
function RowStatus({ expanded, markers }: { expanded: boolean; markers?: RowMarkers }) {
  if (expanded) return <StatusText tone="dim">editing…</StatusText>;
  if (markers === undefined) return null;
  if (markers.needsReview) return <StatusText tone="warn">Needs review</StatusText>;
  if (markers.modified) return <StatusText tone="warn">Modified</StatusText>;
  return null;
}
