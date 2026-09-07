/**
 * Provider row editor (#263 spec §4.3b, mockup v10).
 *
 * The strip expands into a native `fieldset`: Name (immutable once created —
 * renaming is remove + add), Endpoint, API format, and a write-only API key.
 *
 * The key value lives in this component's state while it is typed and nowhere
 * else. **Done** validates it, hands it to the workspace-root KeyVault,
 * and clears the input; collapsing and reopening never brings it back, because
 * there is nothing to bring back. Clearing the vault is NOT this component's
 * job — that is the reducer's single terminal path (§3.2).
 *
 * Every check here is a pre-check: the backend independently re-validates the
 * name, the endpoint, and the key, and owns every verdict this cannot reach
 * (userinfo, queries, resolvability, collisions against a document that moved).
 */

import { useEffect, useState } from 'react';
import {
  API_FORMATS,
  MAX_ENDPOINT_BYTES,
  NON_ASCII_RUNE,
  isBoundedString,
  isIdentifier,
  type APIFormat,
  type ProviderProjection,
} from '../../types/golem';
import { isKeyValue, type Change, type KeyVault } from '../../types/golemConfig';
import { formatSettingsDiagnostic } from '../../utils/settingsDiagnostics';
import styles from './GolemConfig.module.css';

/** The one copy vocabulary, shared with the diagnostics the backend returns. */
const copy = (code: Parameters<typeof formatSettingsDiagnostic>[0]): string =>
  formatSettingsDiagnostic(code, '', '').text;

const NAME_INVALID = copy('provider_name_invalid');
const NAME_TAKEN = copy('provider_exists');
const ENDPOINT_INVALID = copy('provider_endpoint_invalid');
const KEY_INVALID = copy('key_value_invalid');
const PROVIDER_IN_USE = copy('provider_in_use');

/** go-llm's NormalizeEndpoint lowercases the scheme before comparing. */
const HTTP_SCHEME = /^https?:\/\//i;

const FORMAT_LABEL: Record<APIFormat, string> = {
  ollama: 'Ollama',
  'openai-compat': 'OpenAI-compatible',
};

export interface ProviderFields {
  name: string;
  endpoint: string;
  apiFormat: APIFormat;
  keyValue: string;
  clearKey: boolean;
}

export interface StagedProviderChanges {
  changes: Change[];
  /** Stable identities this editor owns and is NOT staging, so a change the
   * user has just reverted leaves the draft instead of lingering. */
  drop: string[];
}

/**
 * The changes these fields mean, against the APPLIED provider.
 *
 * An update carries only the members the user actually changed: the projection
 * shows the normalized endpoint, and re-sending it would overwrite a different
 * authored spelling — and every provider member the transport does not model
 * (§4.3b). Provider and key are separate identities, so an add and its key are
 * one ordered sequence rather than one change (§5.2 mutation order).
 */
export function providerChanges(
  applied: ProviderProjection | null,
  fields: ProviderFields,
  stagedKey?: Change
): StagedProviderChanges {
  const name = applied?.name ?? fields.name;
  const changes: Change[] = [];
  const drop: string[] = [];

  if (applied === null) {
    changes.push({
      kind: 'provider-add',
      name,
      endpoint: fields.endpoint,
      apiFormat: fields.apiFormat,
    });
  } else {
    const patch: { endpoint?: string; apiFormat?: APIFormat } = {};
    if (fields.endpoint !== applied.endpoint) patch.endpoint = fields.endpoint;
    if (fields.apiFormat !== applied.apiFormat) patch.apiFormat = fields.apiFormat;
    if (Object.keys(patch).length > 0) changes.push({ kind: 'provider-update', name, ...patch });
    else drop.push(`provider:${name}`);
  }

  if (fields.keyValue !== '') changes.push({ kind: 'provider-key-set', name });
  else if (fields.clearKey) changes.push({ kind: 'provider-key-clear', name });
  // An empty password field cannot mean "revert my key": it is empty after
  // every successful stage, so dropping the identity here would silently
  // delete both the staged key-set and its vault value on the next stage from
  // this editor. An unchecked Clear box, by contrast, IS the revert.
  else if (applied !== null && stagedKey?.kind !== 'provider-key-set')
    drop.push(`provider-key:${name}`);

  return { changes, drop };
}

interface Problems {
  name?: string;
  endpoint?: string;
  key?: string;
}

const endpointProblem = (value: string): string | undefined => {
  if (value === '') return `${ENDPOINT_INVALID} An endpoint is required.`;
  if (NON_ASCII_RUNE.test(value))
    return `${ENDPOINT_INVALID} Use ASCII only — an internationalized host must be given as punycode.`;
  if (!isBoundedString(value, MAX_ENDPOINT_BYTES))
    return `${ENDPOINT_INVALID} It must be at most ${MAX_ENDPOINT_BYTES} bytes.`;
  if (!HTTP_SCHEME.test(value)) return `${ENDPOINT_INVALID} Use an http:// or https:// URL.`;
  return undefined;
};

/**
 * Amendment 12: the vault stores whatever it is handed, so a value is checked
 * HERE, before it is handed over, and a refusal is shown at the input. `${` is
 * refused even though go-llm would expand it — a reference is an external
 * configuration concern, and staging one would write a credential the user
 * cannot see.
 */
const keyProblem = (value: string): string | undefined => {
  if (value === '') return undefined; // no key operation at all
  if (value.includes('${'))
    return `${KEY_INVALID} A \${…} reference stays an external configuration concern.`;
  return isKeyValue(value) ? undefined : KEY_INVALID;
};

const sameFields = (a: ProviderFields, b: ProviderFields): boolean =>
  a.name === b.name &&
  a.endpoint === b.endpoint &&
  a.apiFormat === b.apiFormat &&
  a.keyValue === b.keyValue &&
  a.clearKey === b.clearKey;

export interface ProviderEditorProps {
  /** DOM id root; also the `aria-controls` target of the disclosure button. */
  id: string;
  /** The applied provider, or null while adding one. */
  provider: ProviderProjection | null;
  /** The change already staged on the provider identity, if any. */
  staged?: Change;
  /** The change already staged on the key identity, if any. */
  stagedKey?: Change;
  /** Names a new provider may not take: applied plus already staged. */
  takenNames: readonly string[];
  /** True while a model still references this provider. */
  inUse: boolean;
  vault: KeyVault;
  rowKey: string;
  onStage: (changes: Change[], drop: string[]) => void;
  onClose: () => void;
  onUnstagedChange: (rowKey: string, unstaged: boolean) => void;
}

export function ProviderEditor({
  id,
  provider,
  staged,
  stagedKey,
  takenNames,
  inUse,
  vault,
  rowKey,
  onStage,
  onClose,
  onUnstagedChange,
}: ProviderEditorProps) {
  const adding = provider === null;
  const stagedRemoval = staged?.kind === 'provider-remove';
  /**
   * A provider-add already in the draft, editing from its own strip. The name
   * is that change's stable identity (§3.3), so it is fixed here for exactly
   * the reason an applied provider's is: editing it in place would mean
   * creating a SECOND provider while the first one stayed staged, and the key
   * value could not follow — the vault deliberately has no read, so a rename
   * cannot carry the secret across. Renaming is unstage plus re-add.
   */
  const stagedAdd = staged?.kind === 'provider-add' ? staged : null;
  const nameFixed = provider !== null || stagedAdd !== null;

  // Reopening shows what is waiting for Apply, not the applied document
  // underneath it — except the key, which is deliberately unrecoverable.
  const initial = (): ProviderFields => ({
    name: staged?.kind === 'provider-add' ? staged.name : (provider?.name ?? ''),
    endpoint:
      (staged?.kind === 'provider-add' || staged?.kind === 'provider-update'
        ? staged.endpoint
        : undefined) ??
      provider?.endpoint ??
      '',
    apiFormat:
      (staged?.kind === 'provider-add' || staged?.kind === 'provider-update'
        ? staged.apiFormat
        : undefined) ??
      provider?.apiFormat ??
      'openai-compat',
    keyValue: '',
    clearKey: stagedKey?.kind === 'provider-key-clear',
  });

  const [fields, setFields] = useState<ProviderFields>(initial);
  /** What is already in the draft: the baseline the Apply gate compares to. */
  const [committed, setCommitted] = useState<ProviderFields>(initial);
  const [problems, setProblems] = useState<Problems>({});
  const [refusal, setRefusal] = useState('');

  const unstaged = !sameFields(fields, committed);

  useEffect(() => {
    onUnstagedChange(rowKey, unstaged);
  }, [onUnstagedChange, rowKey, unstaged]);

  // Collapsing or unmounting releases the Apply gate this editor was holding.
  useEffect(() => () => onUnstagedChange(rowKey, false), [onUnstagedChange, rowKey]);

  // Editing invalidates the last verdict rather than leaving a stale red field:
  // Stage re-checks everything anyway.
  const patch = (next: Partial<ProviderFields>) => {
    setFields((current) => ({ ...current, ...next }));
    setProblems({});
    setRefusal('');
  };

  const name = provider?.name ?? fields.name;
  const keyLocked = stagedRemoval;

  const submit = () => {
    // A name this editor already staged is not a collision with itself.
    const taken = takenNames.filter((other) => other !== committed.name);
    const found: Problems = {
      ...(adding
        ? {
            name: !isIdentifier(fields.name)
              ? NAME_INVALID
              : taken.includes(fields.name)
                ? NAME_TAKEN
                : undefined,
          }
        : {}),
      // An untouched endpoint is never re-sent, so it is never re-checked: the
      // applied document is the backend's to judge.
      ...(adding || fields.endpoint !== provider.endpoint
        ? { endpoint: endpointProblem(fields.endpoint) }
        : {}),
      key: keyProblem(fields.keyValue),
    };
    setProblems(found);
    if (found.name !== undefined || found.endpoint !== undefined || found.key !== undefined) return;

    const { changes, drop } = providerChanges(provider, fields, stagedKey);
    if (fields.keyValue !== '') vault.set(name, fields.keyValue);
    onStage(changes, drop);

    const next = { ...fields, keyValue: '' };
    setFields(next);
    setCommitted(next);
  };

  const remove = () => {
    if (inUse) {
      setRefusal(PROVIDER_IN_USE);
      return;
    }
    onStage([{ kind: 'provider-remove', name }], [`provider-key:${name}`]);
    onClose();
  };

  /** A hint always describes its field; an error joins it while it stands. */
  const describedBy = (field: 'endpoint' | 'key'): string =>
    problems[field] === undefined
      ? `${id}-${field}-hint`
      : `${id}-${field}-hint ${id}-${field}-error`;

  // tabIndex is how an Apply-bar chip focuses the editor it names (§3.3).
  return (
    <fieldset className={styles.editor} id={id} tabIndex={-1}>
      {/* The row strip above IS the editor header (v9). A visible legend
          would cut the border line and leave a gap across the top, so the
          accessible name is sr-only. */}
      <legend className={styles.srOnly}>
        {provider !== null
          ? `Edit provider ${provider.name}`
          : stagedAdd !== null
            ? `Staged provider ${stagedAdd.name}`
            : 'Add a provider'}
      </legend>

      <div className={styles.editorGrid}>
        <div className={styles.field}>
          {!nameFixed ? (
            <>
              <label className={styles.fieldLabel} htmlFor={`${id}-name`}>
                Provider name
              </label>
              <input
                className={styles.input}
                id={`${id}-name`}
                aria-invalid={problems.name === undefined ? undefined : true}
                aria-describedby={problems.name === undefined ? undefined : `${id}-name-error`}
                value={fields.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </>
          ) : (
            <>
              <span className={styles.fieldLabel}>Provider name</span>
              <span className={styles.identifier}>{fields.name}</span>
              <span className={styles.fieldHint}>
                {provider !== null
                  ? 'The name cannot be changed. To rename, remove this provider and add it again.'
                  : 'The name cannot be changed. To rename, unstage this provider and add it again.'}
              </span>
            </>
          )}
          {problems.name !== undefined && (
            <span className={styles.fieldError} id={`${id}-name-error`}>
              {problems.name}
            </span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-endpoint`}>
            Endpoint
          </label>
          <input
            className={styles.input}
            id={`${id}-endpoint`}
            aria-invalid={problems.endpoint === undefined ? undefined : true}
            aria-describedby={describedBy('endpoint')}
            value={fields.endpoint}
            onChange={(event) => patch({ endpoint: event.target.value })}
          />
          <span className={styles.fieldHint} id={`${id}-endpoint-hint`}>
            An http:// or https:// URL. Firn checks the shape; Golem validates the rest when you
            apply.
          </span>
          {problems.endpoint !== undefined && (
            <span className={styles.fieldError} id={`${id}-endpoint-error`}>
              {problems.endpoint}
            </span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-format`}>
            API format
          </label>
          <select
            className={styles.input}
            id={`${id}-format`}
            value={fields.apiFormat}
            onChange={(event) => patch({ apiFormat: event.target.value as APIFormat })}
          >
            {API_FORMATS.map((format) => (
              <option key={format} value={format}>
                {FORMAT_LABEL[format]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${id}-key`}>
            New API key
          </label>
          <input
            className={styles.input}
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            disabled={keyLocked || fields.clearKey}
            aria-invalid={problems.key === undefined ? undefined : true}
            aria-describedby={describedBy('key')}
            value={fields.keyValue}
            onChange={(event) => patch({ keyValue: event.target.value })}
          />
          <span className={styles.fieldHint} id={`${id}-key-hint`}>
            Staged as a literal value and never shown again. Nothing is written until you apply.
          </span>
          {problems.key !== undefined && (
            <span className={styles.fieldError} id={`${id}-key-error`}>
              {problems.key}
            </span>
          )}
          {!adding && (
            <label className={styles.checkbox}>
              <input
                className={styles.checkboxInput}
                type="checkbox"
                disabled={keyLocked}
                checked={fields.clearKey}
                onChange={(event) => patch({ clearKey: event.target.checked, keyValue: '' })}
              />
              <span className={styles.checkboxBox} aria-hidden="true" />
              Clear the stored API key
            </label>
          )}
          {keyLocked && (
            <span className={styles.fieldHint}>
              This provider is staged for removal, so its API key cannot also change.
            </span>
          )}
        </div>
      </div>

      {refusal !== '' && (
        <p className={styles.fieldError} role="alert">
          {refusal}
        </p>
      )}

      <div className={styles.editorFooter}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={!unstaged}
          onClick={submit}
        >
          Done
        </button>
        <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={onClose}>
          Cancel
        </button>
        {/* v9 right-aligns the destructive action away from Done/Cancel. */}
        <span className={styles.grow} />
        {!adding && (
          <button type="button" className={`${styles.button} ${styles.danger}`} onClick={remove}>
            Remove provider
          </button>
        )}
      </div>
    </fieldset>
  );
}
