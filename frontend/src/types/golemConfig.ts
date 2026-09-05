/**
 * The closed Golem settings WRITE transport (spec §5.6), the mirror of
 * internal/ai/settings_apply.go. Every enum is closed, every unknown key is a
 * contract break, and every bound is measured in UTF-8 BYTES — the shared
 * corpus in internal/ai/testdata/settings_apply_contract/ runs these validators
 * and the Go ones over byte-identical fixtures, so the two cannot drift.
 *
 * Requests are validated here as well as in the backend. The backend is the
 * authority (the frontend is not trusted); validating locally means a drafting
 * bug fails at the boundary that produced it instead of arriving as an opaque
 * diagnostics result.
 *
 * API key values live in `keys` and nowhere else: no result type below has a
 * member that could carry one back.
 */
import {
  CAPABILITY_NAMES,
  MAX_DIAGNOSTICS,
  MAX_ENDPOINT_BYTES,
  MAX_PROJECTION_ENTRIES,
  MODEL_TYPES,
  NON_ASCII_RUNE,
  REVISION,
  THINK_MODES,
  API_FORMATS,
  compareString,
  contractError,
  hasOnlyKeys,
  hasPresentKey,
  isBoundedString,
  isCanonicalCapabilities,
  isCleanIdentifier,
  isIdentifier,
  isOneOf,
  isOptionalModelNumber,
  isRecord,
  isStrictlyOrdered,
  parseSettingsProjection,
  readCappedArray,
  readSettingsDiagnostic,
  utf8Length,
  type APIFormat,
  type CapabilityFacts,
  type CapabilityName,
  type ModelType,
  type ProviderProjection,
  type RouteProjection,
  type ModelProjection,
  type SettingsDiagnostic,
  type SettingsProjection,
  type SettingsState,
  type ThinkMode,
} from './golem';

/** §5.6: key values are 1..4096 UTF-8 bytes, literal-only. */
const MAX_KEY_VALUE_BYTES = 4096;
/** §5.6: the consent challenge token is opaque, 1..256 UTF-8 bytes. */
const MAX_CHALLENGE_TOKEN_BYTES = 256;
const PROFILE_ID = /^(curated|user)\/[a-z0-9][a-z0-9-]{0,63}$/;

/** Apply targets an existing document; Create establishes a new one. */
export type ApplyMode = 'apply' | 'create';

export type ChangeKind =
  | 'route'
  | 'route-unassign'
  | 'provider-add'
  | 'provider-update'
  | 'provider-remove'
  | 'provider-key-set'
  | 'provider-key-clear'
  | 'role-remove';

/**
 * Stable change-identity namespaces (§3.3). Exactly four, and they are NOT the
 * change kinds: provider add/update/remove share one provider identity, and key
 * set/clear share the independent key identity, so an add and a key operation
 * on one provider can coexist.
 */
export type ChangeIdentityNamespace = 'route' | 'provider' | 'provider-key' | 'role';
const IDENTITY_NAMESPACES: readonly ChangeIdentityNamespace[] = [
  'route',
  'provider',
  'provider-key',
  'role',
];

/** Model-specific members a real retarget drops (§5.2b). */
export type DropField = 'slots' | 'think_tags';
const DROP_FIELDS: readonly DropField[] = ['slots', 'think_tags'];

export type ApplySource =
  | { kind: 'applied' }
  | { kind: 'profile'; profileId: string; sourceRevision: string }
  | { kind: 'blank' };

export interface ModelFacts {
  provider: string;
  model: string;
  type: ModelType;
  parameters?: string;
  contextWindow?: number;
  dimensions?: number;
}

export interface RouteChange {
  kind: 'route';
  useCase: string;
  modelFacts: ModelFacts;
  capabilityFacts: CapabilityFacts;
  exposedCaps: CapabilityName[];
  thinkMode: ThinkMode;
  confirmUnknown: boolean;
  confirmUnknownUseCases?: string[];
  confirmDrops?: DropField[];
}

export type Change =
  | RouteChange
  | { kind: 'route-unassign'; useCase: string }
  | { kind: 'provider-add'; name: string; endpoint: string; apiFormat?: APIFormat }
  | { kind: 'provider-update'; name: string; endpoint?: string; apiFormat?: APIFormat }
  | { kind: 'provider-remove'; name: string }
  | { kind: 'provider-key-set'; name: string }
  | { kind: 'provider-key-clear'; name: string }
  | { kind: 'role-remove'; role: string };

export interface SettingsApplyRequest {
  targetRevision?: string;
  source: ApplySource;
  changes: Change[];
  keys: Record<string, string>;
}

export interface ConfirmSettingsApplyRequest {
  challengeToken: string;
  request: SettingsApplyRequest;
}

export interface ApplyDestination {
  provider: string;
  model: string;
  endpoint: string;
  classification: 'remote';
}

export interface ApplyChallenge {
  token: string;
  expiresAt: number;
  destination: ApplyDestination;
}

export interface ChangeDropSet {
  changeId: string;
  fields: DropField[];
}

export type ConsentOutcome = 'unchanged' | 'recorded' | 'uncertain';
export type ApplyConflictKind = 'target' | 'profile_source' | 'challenge';

export type SettingsApplyResult =
  | { status: 'applied'; projection: SettingsProjection; warning?: 'durability_uncertain' }
  | { status: 'consent_required'; challenge: ApplyChallenge }
  | { status: 'drop_confirmation_required'; drops: ChangeDropSet[] }
  | {
      status: 'conflict';
      conflict: ApplyConflictKind;
      projection?: SettingsProjection;
      consentOutcome: ConsentOutcome;
    }
  | { status: 'diagnostics'; diagnostics: SettingsDiagnostic[]; consentOutcome: ConsentOutcome }
  | { status: 'busy' }
  | { status: 'limited'; diagnostics: SettingsDiagnostic[] };

export interface CancelSettingsApplyResult {
  status: 'cancelled';
}

/** A profile preview: the projection minus sourceOrigin and revision. */
export interface ProfileDraftProjection {
  state: Extract<SettingsState, 'ready' | 'limited'>;
  readOnly: boolean;
  editable: boolean;
  routes: RouteProjection[];
  models: ModelProjection[];
  providers: ProviderProjection[];
  diagnostics: SettingsDiagnostic[];
}

export type ProfileDiagnosticCode =
  | 'invalid_id'
  | 'not_found'
  | 'curated_read_only'
  | 'store_unsafe'
  | 'io'
  | 'config_invalid'
  | 'active_config_invalid'
  | 'profile_limit';

const PROFILE_DIAGNOSTIC_CODES: readonly ProfileDiagnosticCode[] = [
  'invalid_id',
  'not_found',
  'curated_read_only',
  'store_unsafe',
  'io',
  'config_invalid',
  'active_config_invalid',
  'profile_limit',
];

export interface ProfileDiagnostic {
  code: ProfileDiagnosticCode;
  profileId?: string;
}

export type GolemProfileLoadResult =
  | {
      status: 'loaded';
      profileId: string;
      sourceRevision: string;
      projection: ProfileDraftProjection;
    }
  | { status: 'diagnostics'; diagnostics: ProfileDiagnostic[] };

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && REVISION.test(value);

const isProfileID = (value: unknown): value is string =>
  typeof value === 'string' && PROFILE_ID.test(value);

/**
 * An authored endpoint: non-empty, bounded, and printable ASCII only. A
 * non-ASCII host is a homoglyph risk and is never resolvable as authored —
 * internationalized hosts must be supplied as punycode.
 */
const isEndpoint = (value: unknown): value is string =>
  isBoundedString(value, MAX_ENDPOINT_BYTES) && value !== '' && !NON_ASCII_RUNE.test(value);

/**
 * Literal-only: `${` is refused even though go-llm would expand it. Exported
 * for ProviderEditor, which must reach this verdict BEFORE the vault is
 * touched (plan amendment 12) — one definition of the rule, not two.
 */
export const isKeyValue = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  utf8Length(value) <= MAX_KEY_VALUE_BYTES &&
  !value.includes('${');

const isChallengeToken = (value: unknown): value is string =>
  isCleanIdentifier(value, MAX_CHALLENGE_TOKEN_BYTES) && value !== '';

const isCapabilityList = (value: unknown): CapabilityName[] | null => {
  const caps = readCappedArray(value, CAPABILITY_NAMES.length, (cap) =>
    isOneOf(cap, CAPABILITY_NAMES) ? cap : null
  );
  return caps !== null && isCanonicalCapabilities(caps) ? caps : null;
};

const isSubsetOf = (values: readonly string[], known: readonly string[]): boolean =>
  values.every((value) => known.includes(value));

/** Non-empty, unique, ascending, drawn from the closed drop vocabulary. */
const readDropFields = (value: unknown): DropField[] | null => {
  const fields = readCappedArray(value, DROP_FIELDS.length, (field) =>
    isOneOf(field, DROP_FIELDS) ? field : null
  );
  if (fields === null || fields.length === 0) return null;
  return isStrictlyOrdered(fields, compareString) ? fields : null;
};

const readSortedIdentifiers = (value: unknown): string[] | null => {
  const values = readCappedArray(value, MAX_PROJECTION_ENTRIES, (entry) =>
    isIdentifier(entry) ? entry : null
  );
  if (values === null || values.length === 0) return null;
  return isStrictlyOrdered(values, compareString) ? values : null;
};

/**
 * The stable change identity a drop set names: `<namespace>:<identifier>` over
 * the four §3.3 namespaces. A bare identifier, an unknown namespace, or a
 * change KIND used as one (`provider-key-set:` rather than `provider-key:`) is
 * a contract break. Splitting on the first `:` recovers the namespace exactly,
 * because no namespace contains one.
 */
const isChangeID = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const separator = value.indexOf(':');
  if (separator < 0) return false;
  return (
    isOneOf(value.slice(0, separator), IDENTITY_NAMESPACES) &&
    isIdentifier(value.slice(separator + 1))
  );
};

/**
 * An explicit `null` is a rejection. An own key valued `undefined` reads as
 * absent (see `hasPresentKey`): v3's generated class instances declare every
 * optional field as an own `undefined` property under
 * `useDefineForClassFields`, and JSON cannot carry `undefined`.
 *
 * The apply/cancel/profile-load results this file parses no longer arrive as
 * generated instances -- they are among the nine calls src/wails/bindings.ts
 * reads raw -- so on the wire path the rule is a no-op, for that same reason
 * that JSON carries no `undefined`. It is kept so the helper stays correct for
 * any generated instance that ever reaches it.
 */
const readOptional = <T>(
  value: Record<string, unknown>,
  key: string,
  read: (entry: unknown) => T | null
): { present: false } | { present: true; value: T } | null => {
  if (!hasPresentKey(value, key)) return { present: false };
  const parsed = read(value[key]);
  return parsed === null ? null : { present: true, value: parsed };
};

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function readApplySource(value: unknown): ApplySource | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'applied':
    case 'blank':
      return hasOnlyKeys(value, ['kind']) ? ({ kind: value.kind } as ApplySource) : null;
    case 'profile':
      if (!hasOnlyKeys(value, ['kind', 'profileId', 'sourceRevision'])) return null;
      if (!isProfileID(value.profileId) || !isRevision(value.sourceRevision)) return null;
      return {
        kind: 'profile',
        profileId: value.profileId,
        sourceRevision: value.sourceRevision,
      };
    default:
      return null;
  }
}

function readModelFacts(value: unknown): ModelFacts | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, ['provider', 'model', 'type', 'parameters', 'contextWindow', 'dimensions'])
  )
    return null;
  const { provider, model, type } = value;
  if (!isIdentifier(provider) || !isIdentifier(model) || !isOneOf(type, MODEL_TYPES)) return null;

  const parameters = readOptional(value, 'parameters', (entry) =>
    isIdentifier(entry) ? entry : null
  );
  const contextWindow = readOptional(value, 'contextWindow', (entry) =>
    isOptionalModelNumber(entry) ? entry : null
  );
  const dimensions = readOptional(value, 'dimensions', (entry) =>
    isOptionalModelNumber(entry) ? entry : null
  );
  if (parameters === null || contextWindow === null || dimensions === null) return null;
  return {
    provider,
    model,
    type,
    ...(parameters.present ? { parameters: parameters.value } : {}),
    ...(contextWindow.present ? { contextWindow: contextWindow.value } : {}),
    ...(dimensions.present ? { dimensions: dimensions.value } : {}),
  };
}

function readRequestCapabilityFacts(value: unknown): CapabilityFacts | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['caps', 'knownCaps'])) return null;
  const caps = isCapabilityList(value.caps);
  const knownCaps = isCapabilityList(value.knownCaps);
  if (caps === null || knownCaps === null || !isSubsetOf(caps, knownCaps)) return null;
  return { caps, knownCaps };
}

function readRouteChange(value: Record<string, unknown>): Change | null {
  if (
    !hasOnlyKeys(value, [
      'kind',
      'useCase',
      'modelFacts',
      'capabilityFacts',
      'exposedCaps',
      'thinkMode',
      'confirmUnknown',
      'confirmUnknownUseCases',
      'confirmDrops',
    ])
  )
    return null;
  const { useCase, thinkMode, confirmUnknown } = value;
  if (
    !isIdentifier(useCase) ||
    !isOneOf(thinkMode, THINK_MODES) ||
    typeof confirmUnknown !== 'boolean'
  )
    return null;
  const modelFacts = readModelFacts(value.modelFacts);
  const capabilityFacts = readRequestCapabilityFacts(value.capabilityFacts);
  const exposedCaps = isCapabilityList(value.exposedCaps);
  if (modelFacts === null || capabilityFacts === null || exposedCaps === null) return null;
  if (!isSubsetOf(exposedCaps, capabilityFacts.knownCaps)) return null;

  // Confirmation arrays are omitted when empty; an explicit [] is a break.
  const confirmUnknownUseCases = readOptional(
    value,
    'confirmUnknownUseCases',
    readSortedIdentifiers
  );
  const confirmDrops = readOptional(value, 'confirmDrops', readDropFields);
  if (confirmUnknownUseCases === null || confirmDrops === null) return null;
  return {
    kind: 'route',
    useCase,
    modelFacts,
    capabilityFacts,
    exposedCaps,
    thinkMode,
    confirmUnknown,
    ...(confirmUnknownUseCases.present
      ? { confirmUnknownUseCases: confirmUnknownUseCases.value }
      : {}),
    ...(confirmDrops.present ? { confirmDrops: confirmDrops.value } : {}),
  };
}

function readChange(value: unknown): Change | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'route':
      return readRouteChange(value);
    case 'route-unassign':
      if (!hasOnlyKeys(value, ['kind', 'useCase']) || !isIdentifier(value.useCase)) return null;
      return { kind: 'route-unassign', useCase: value.useCase };
    case 'provider-add': {
      if (!hasOnlyKeys(value, ['kind', 'name', 'endpoint', 'apiFormat'])) return null;
      if (!isIdentifier(value.name) || !isEndpoint(value.endpoint)) return null;
      const apiFormat = readOptional(value, 'apiFormat', (entry) =>
        isOneOf(entry, API_FORMATS) ? entry : null
      );
      if (apiFormat === null) return null;
      return {
        kind: 'provider-add',
        name: value.name,
        endpoint: value.endpoint,
        ...(apiFormat.present ? { apiFormat: apiFormat.value } : {}),
      };
    }
    case 'provider-update': {
      if (!hasOnlyKeys(value, ['kind', 'name', 'endpoint', 'apiFormat'])) return null;
      if (!isIdentifier(value.name)) return null;
      const endpoint = readOptional(value, 'endpoint', (entry) =>
        isEndpoint(entry) ? entry : null
      );
      const apiFormat = readOptional(value, 'apiFormat', (entry) =>
        isOneOf(entry, API_FORMATS) ? entry : null
      );
      if (endpoint === null || apiFormat === null) return null;
      // An update that touches nothing is not a change.
      if (!endpoint.present && !apiFormat.present) return null;
      return {
        kind: 'provider-update',
        name: value.name,
        ...(endpoint.present ? { endpoint: endpoint.value } : {}),
        ...(apiFormat.present ? { apiFormat: apiFormat.value } : {}),
      };
    }
    case 'provider-remove':
    case 'provider-key-set':
    case 'provider-key-clear':
      if (!hasOnlyKeys(value, ['kind', 'name']) || !isIdentifier(value.name)) return null;
      return { kind: value.kind, name: value.name };
    case 'role-remove':
      if (!hasOnlyKeys(value, ['kind', 'role']) || !isIdentifier(value.role)) return null;
      return { kind: 'role-remove', role: value.role };
    default:
      return null;
  }
}

/**
 * The §3.3 stable change identity, `<namespace>:<identity>` — the one
 * identity vocabulary, shared by duplicate detection here and by the drop-set
 * change ids the backend reports. One id per semantic target, never one per
 * change kind.
 */
export function changeStableID(change: Change): string {
  switch (change.kind) {
    case 'route':
    case 'route-unassign':
      return `route:${change.useCase}`;
    case 'provider-add':
    case 'provider-update':
    case 'provider-remove':
      return `provider:${change.name}`;
    case 'provider-key-set':
    case 'provider-key-clear':
      return `provider-key:${change.name}`;
    case 'role-remove':
      return `role:${change.role}`;
  }
}

function changesAreConsistent(changes: readonly Change[], keys: Record<string, string>): boolean {
  const identities = new Set<string>();
  const keySets = new Set<string>();
  const removedProviders = new Set<string>();
  const keyedProviders = new Set<string>();
  for (const change of changes) {
    const identity = changeStableID(change);
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (change.kind === 'provider-remove') removedProviders.add(change.name);
    if (change.kind === 'provider-key-set') {
      keySets.add(change.name);
      keyedProviders.add(change.name);
    }
    if (change.kind === 'provider-key-clear') keyedProviders.add(change.name);
  }
  // Removing a provider and touching its key in the same Apply contradict.
  for (const name of removedProviders) if (keyedProviders.has(name)) return false;
  // Exact 1:1: every provider-key-set carries one key value, and no other
  // change (and no stray entry) may carry one.
  const keyNames = Object.keys(keys);
  if (keyNames.length !== keySets.size) return false;
  return keyNames.every((name) => keySets.has(name));
}

export function parseSettingsApplyRequest(value: unknown, mode: ApplyMode): SettingsApplyRequest {
  if (!isRecord(value)) return contractError();
  if (!hasOnlyKeys(value, ['targetRevision', 'source', 'changes', 'keys'])) return contractError();

  const hasTargetRevision = hasPresentKey(value, 'targetRevision');
  if (mode === 'apply' && !(hasTargetRevision && isRevision(value.targetRevision)))
    return contractError();
  if (mode === 'create' && hasTargetRevision) return contractError();

  const source = readApplySource(value.source);
  if (source === null) return contractError();
  // Create establishes a document that does not exist yet, so there is no
  // applied source to copy from.
  if (mode === 'create' && source.kind === 'applied') return contractError();

  const changes = readCappedArray(value.changes, MAX_PROJECTION_ENTRIES, readChange);
  if (changes === null) return contractError();
  // An empty change set is a write only from a profile source: the loaded,
  // scrubbed profile document IS the change (§3.3 makes a source replacement
  // dirty on its own). An applied source with no change asks for nothing, and a
  // blank one cannot form a BootstrapSpec. Mirrors internal/ai's rule exactly.
  if (changes.length === 0 && source.kind !== 'profile') return contractError();

  const rawKeys = value.keys;
  if (!isRecord(rawKeys) || Object.keys(rawKeys).length > MAX_PROJECTION_ENTRIES)
    return contractError();
  for (const [name, keyValue] of Object.entries(rawKeys)) {
    if (!isIdentifier(name) || !isKeyValue(keyValue)) return contractError();
  }
  // Spread, never per-key assignment: `keys['__proto__'] = v` would invoke the
  // prototype setter and silently drop the entry, so a stray "__proto__" key
  // would pass the 1:1 check here while Go's map still carries it. Spread
  // creates own data properties, so both sides see the same key set.
  const keys = { ...rawKeys } as Record<string, string>;
  if (!changesAreConsistent(changes, keys)) return contractError();

  return {
    ...(hasTargetRevision ? { targetRevision: value.targetRevision as string } : {}),
    source,
    changes,
    keys,
  };
}

export function parseConfirmSettingsApplyRequest(
  value: unknown,
  mode: ApplyMode
): ConfirmSettingsApplyRequest {
  if (!isRecord(value)) return contractError();
  if (!hasOnlyKeys(value, ['challengeToken', 'request'])) return contractError();
  if (!isChallengeToken(value.challengeToken)) return contractError();
  return {
    challengeToken: value.challengeToken,
    request: parseSettingsApplyRequest(value.request, mode),
  };
}

// ---------------------------------------------------------------------------
// Result validation
// ---------------------------------------------------------------------------

/** Which optional members each status owns; every other member must be absent. */
const RESULT_MEMBERS: Record<string, readonly string[]> = {
  applied: ['projection', 'warning'],
  consent_required: ['challenge'],
  drop_confirmation_required: ['drops'],
  conflict: ['conflict', 'projection', 'consentOutcome'],
  diagnostics: ['diagnostics', 'consentOutcome'],
  busy: [],
  limited: ['diagnostics'],
};

const CONSENT_OUTCOMES: readonly ConsentOutcome[] = ['unchanged', 'recorded', 'uncertain'];
const CONFLICT_KINDS: readonly ApplyConflictKind[] = ['target', 'profile_source', 'challenge'];

function readApplyDestination(value: unknown): ApplyDestination | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ['provider', 'model', 'endpoint', 'classification'])) return null;
  const { provider, model, endpoint, classification } = value;
  if (!isIdentifier(provider) || !isIdentifier(model) || !isEndpoint(endpoint)) return null;
  if (classification !== 'remote') return null;
  return { provider, model, endpoint, classification };
}

function readApplyChallenge(value: unknown): ApplyChallenge | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ['token', 'expiresAt', 'destination'])) return null;
  if (!isChallengeToken(value.token)) return null;
  // A Unix-millisecond instant: positive and exactly representable.
  if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 1) return null;
  const destination = readApplyDestination(value.destination);
  if (destination === null) return null;
  return { token: value.token, expiresAt: value.expiresAt as number, destination };
}

function readDropSets(value: unknown): ChangeDropSet[] | null {
  const drops = readCappedArray(value, MAX_PROJECTION_ENTRIES, (entry) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['changeId', 'fields'])) return null;
    if (!isChangeID(entry.changeId)) return null;
    const fields = readDropFields(entry.fields);
    return fields === null ? null : { changeId: entry.changeId, fields };
  });
  if (drops === null || drops.length === 0) return null;
  return new Set(drops.map((drop) => drop.changeId)).size === drops.length ? drops : null;
}

function readResultDiagnostics(value: unknown, blockingOnly: boolean): SettingsDiagnostic[] | null {
  const diagnostics = readCappedArray(value, MAX_DIAGNOSTICS, readSettingsDiagnostic);
  if (diagnostics === null || diagnostics.length === 0) return null;
  if (blockingOnly && diagnostics.some((diagnostic) => !diagnostic.blocking)) return null;
  const order = (a: SettingsDiagnostic, b: SettingsDiagnostic): number =>
    (a.blocking === b.blocking ? 0 : a.blocking ? -1 : 1) ||
    compareString(a.code, b.code) ||
    compareString(a.subjectKind, b.subjectKind) ||
    compareString(a.subjectName, b.subjectName);
  return isStrictlyOrdered(diagnostics, order) ? diagnostics : null;
}

export function parseSettingsApplyResult(value: unknown): SettingsApplyResult {
  if (!isRecord(value) || typeof value.status !== 'string') return contractError();
  // Own properties only: a plain object inherits `toString`, `constructor` and
  // friends, so an unguarded lookup would answer a FUNCTION for
  // `status: "toString"` and then throw a TypeError on the spread below —
  // a crash where the contract calls for a refusal.
  if (!Object.hasOwn(RESULT_MEMBERS, value.status)) return contractError();
  const members = RESULT_MEMBERS[value.status];
  if (!hasOnlyKeys(value, ['status', ...members])) return contractError();

  switch (value.status) {
    case 'applied': {
      if (!hasPresentKey(value, 'projection')) return contractError();
      const projection = parseSettingsProjection(value.projection);
      if (!hasPresentKey(value, 'warning')) return { status: 'applied', projection };
      if (value.warning !== 'durability_uncertain') return contractError();
      return { status: 'applied', projection, warning: 'durability_uncertain' };
    }
    case 'consent_required': {
      const challenge = readApplyChallenge(value.challenge);
      if (challenge === null) return contractError();
      return { status: 'consent_required', challenge };
    }
    case 'drop_confirmation_required': {
      const drops = readDropSets(value.drops);
      if (drops === null) return contractError();
      return { status: 'drop_confirmation_required', drops };
    }
    case 'conflict': {
      if (!isOneOf(value.conflict, CONFLICT_KINDS)) return contractError();
      if (!isOneOf(value.consentOutcome, CONSENT_OUTCOMES)) return contractError();
      const conflict = value.conflict;
      const consentOutcome = value.consentOutcome;
      if (!hasPresentKey(value, 'projection'))
        return { status: 'conflict', conflict, consentOutcome };
      return {
        status: 'conflict',
        conflict,
        projection: parseSettingsProjection(value.projection),
        consentOutcome,
      };
    }
    case 'diagnostics': {
      if (!isOneOf(value.consentOutcome, CONSENT_OUTCOMES)) return contractError();
      const diagnostics = readResultDiagnostics(value.diagnostics, true);
      if (diagnostics === null) return contractError();
      return { status: 'diagnostics', diagnostics, consentOutcome: value.consentOutcome };
    }
    case 'busy':
      return { status: 'busy' };
    case 'limited': {
      // Limited keeps the projection's blocking semantics: a non-blocking
      // "this document is not editable" notice is exactly what it carries.
      const diagnostics = readResultDiagnostics(value.diagnostics, false);
      if (diagnostics === null) return contractError();
      return { status: 'limited', diagnostics };
    }
    default:
      return contractError();
  }
}

export function parseCancelSettingsApplyResult(value: unknown): CancelSettingsApplyResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status']) || value.status !== 'cancelled')
    return contractError();
  return { status: 'cancelled' };
}

/**
 * A draft is exactly a projection minus sourceOrigin and revision, so their
 * PRESENCE is a contract break and the remaining rules are checked once, by
 * the projection validator, with the two omitted members supplied here.
 */
export function parseProfileDraftProjection(value: unknown): ProfileDraftProjection {
  if (!isRecord(value)) return contractError();
  if (
    !hasOnlyKeys(value, [
      'state',
      'readOnly',
      'editable',
      'routes',
      'models',
      'providers',
      'diagnostics',
    ])
  )
    return contractError();
  if (value.state !== 'ready' && value.state !== 'limited') return contractError();
  const state = value.state;
  const projection = parseSettingsProjection({
    ...value,
    sourceOrigin: 'none',
    revision: '0'.repeat(64),
  });
  // Every loaded draft is credential-free: the loader clears every provider
  // key before the preview is built.
  if (projection.providers.some((provider) => provider.credentialState !== 'none'))
    return contractError();
  return {
    state,
    readOnly: projection.readOnly,
    editable: projection.editable,
    routes: projection.routes,
    models: projection.models,
    providers: projection.providers,
    diagnostics: projection.diagnostics,
  };
}

function readProfileDiagnostics(value: unknown): ProfileDiagnostic[] | null {
  const diagnostics = readCappedArray(value, MAX_PROJECTION_ENTRIES, (entry) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['code', 'profileId'])) return null;
    if (!isOneOf(entry.code, PROFILE_DIAGNOSTIC_CODES)) return null;
    const profileId = readOptional(entry, 'profileId', (raw) => (isProfileID(raw) ? raw : null));
    if (profileId === null) return null;
    return {
      code: entry.code,
      ...(profileId.present ? { profileId: profileId.value } : {}),
    };
  });
  if (diagnostics === null || diagnostics.length === 0) return null;
  return diagnostics;
}

export function parseGolemProfileLoadResult(value: unknown): GolemProfileLoadResult {
  if (!isRecord(value)) return contractError();
  switch (value.status) {
    case 'loaded': {
      if (!hasOnlyKeys(value, ['status', 'profileId', 'sourceRevision', 'projection']))
        return contractError();
      if (!isProfileID(value.profileId) || !isRevision(value.sourceRevision))
        return contractError();
      if (!hasPresentKey(value, 'projection')) return contractError();
      return {
        status: 'loaded',
        profileId: value.profileId,
        sourceRevision: value.sourceRevision,
        projection: parseProfileDraftProjection(value.projection),
      };
    }
    case 'diagnostics': {
      if (!hasOnlyKeys(value, ['status', 'diagnostics'])) return contractError();
      const diagnostics = readProfileDiagnostics(value.diagnostics);
      if (diagnostics === null) return contractError();
      return { status: 'diagnostics', diagnostics };
    }
    default:
      return contractError();
  }
}

// ---------------------------------------------------------------------------
// Draft model (§3.3)
//
// The draft is the request-in-progress: a source, the staged changes keyed by
// their stable identity, and the ids a conflict left waiting for review. It
// holds no key VALUES — those live in a caller-owned ref behind KeyVault — and
// no projection: the base projection is passed in where it is needed, so one
// draft can be projected over a reloaded document without being rebuilt.
// ---------------------------------------------------------------------------

export interface Draft {
  targetRevision?: string;
  source: ApplySource;
  changes: Change[];
  /**
   * Stable ids a conflict or an unknown outcome retained. Apply stays disabled
   * until each is re-staged or discarded (§4.6) — never auto-dropped, never
   * auto-rebased.
   */
  needsReview: string[];
}

export const cleanDraft = (targetRevision?: string): Draft => ({
  ...(targetRevision === undefined ? {} : { targetRevision }),
  source: { kind: 'applied' },
  changes: [],
  needsReview: [],
});

/** The prefix of the §3.3 key identity, the one namespace keys ever occupy. */
const KEY_IDENTITY_PREFIX = 'provider-key:';

/**
 * The Firn use-case capability floor table, mirroring
 * internal/ai/settings.go's firnUseCaseFloors. A drift test reads the shared
 * fixture (internal/ai/testdata/settings_use_case_floors.json) that pins the Go
 * table and compares it to this one, so the two cannot diverge silently.
 */
export const USE_CASE_FLOORS: ReadonlyMap<string, readonly CapabilityName[]> = new Map<
  string,
  readonly CapabilityName[]
>([
  ['agent', ['chat', 'stream', 'tool_call']],
  ['chat', ['chat', 'stream']],
  ['embedding', ['embed']],
  ['planning', ['chat', 'stream', 'tool_call']],
]);

/** A use case outside the table has no floor to meet; it needs confirmation. */
export const meetsUseCaseFloor = (useCase: string, caps: readonly CapabilityName[]): boolean =>
  (USE_CASE_FLOORS.get(useCase) ?? []).every((cap) => caps.includes(cap));

// ---------------------------------------------------------------------------
// Key lifecycle (plan amendment 12)
// ---------------------------------------------------------------------------

/**
 * Dumb storage plus lifecycle over the caller's `useRef<Map<string,string>>`.
 *
 * The vault validates NOTHING and never silently drops an entry: non-empty,
 * literal-only, `${`-free is enforced in ProviderEditor before `set`, and the
 * rejection is surfaced at the input. `extractForApply` never clears, because
 * Confirm resends the complete request; the ONLY clearing path is
 * `settleDraft`'s terminal table below.
 *
 * A stray entry is never skipped: `extractForApply` hands the whole map to
 * `parseSettingsApplyRequest`, whose exact 1:1 rule fails the Apply loudly.
 */
export class KeyVault {
  constructor(private readonly entries: Map<string, string>) {}

  set(name: string, value: string): void {
    this.entries.set(name, value);
  }

  delete(name: string): void {
    this.entries.delete(name);
  }

  clear(): void {
    this.entries.clear();
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * The request `keys` map. Object.fromEntries creates own data properties, so
   * a provider literally named `__proto__` stays visible to the 1:1 check.
   */
  extractForApply(): Record<string, string> {
    return Object.fromEntries(this.entries);
  }
}

// ---------------------------------------------------------------------------
// Reducer
//
// Every vault mutation reachable from here is an idempotent delete or clear, so
// a React StrictMode double-invoked updater cannot corrupt the map. `set` is
// the editor's alone and is never called from a reducer path.
// ---------------------------------------------------------------------------

/** Restaging an identity replaces it; the newest staging is always last. */
export function stageChange(draft: Draft, change: Change, vault: KeyVault): Draft {
  const identity = changeStableID(change);
  // Removing a provider evicts its staged key change (§3.3); staging a key
  // clear replaces a pending set, so its value goes too.
  const evictedProvider =
    change.kind === 'provider-remove' || change.kind === 'provider-key-clear' ? change.name : null;
  const evicted = evictedProvider === null ? null : `${KEY_IDENTITY_PREFIX}${evictedProvider}`;
  if (evictedProvider !== null) vault.delete(evictedProvider);
  const changes = draft.changes.filter((staged) => {
    const other = changeStableID(staged);
    return other !== identity && other !== evicted;
  });
  changes.push(change);
  return {
    ...draft,
    changes,
    needsReview: draft.needsReview.filter((id) => id !== identity && id !== evicted),
  };
}

export function unstageChange(draft: Draft, changeId: string, vault: KeyVault): Draft {
  if (changeId.startsWith(KEY_IDENTITY_PREFIX)) {
    vault.delete(changeId.slice(KEY_IDENTITY_PREFIX.length));
  }
  return {
    ...draft,
    changes: draft.changes.filter((staged) => changeStableID(staged) !== changeId),
    needsReview: draft.needsReview.filter((id) => id !== changeId),
  };
}

/**
 * A source replacement is destructive (§4.6a): the draft and every key ref
 * clear through the one terminal path before the new source is adopted.
 */
export function replaceSource(draft: Draft, source: ApplySource, vault: KeyVault): Draft {
  return { ...settleDraft(draft, { kind: 'discard' }, vault), source };
}

/** Adopts the revision of a freshly reloaded document. */
export const setTargetRevision = (draft: Draft, targetRevision?: string): Draft => ({
  ...draft,
  ...(targetRevision === undefined ? {} : { targetRevision }),
});

/** §3.3: `changes.length` plus one when the source itself is a replacement. */
export const draftChangeCount = (draft: Draft): number =>
  draft.changes.length + (draft.source.kind === 'applied' ? 0 : 1);

export const isDraftDirty = (draft: Draft): boolean => draftChangeCount(draft) > 0;

export const canApplyDraft = (draft: Draft): boolean =>
  isDraftDirty(draft) && draft.needsReview.length === 0;

// ---------------------------------------------------------------------------
// The central terminal-transition table (§5.6)
// ---------------------------------------------------------------------------

export type DraftEvent =
  | { kind: 'result'; result: SettingsApplyResult }
  /** The consent challenge outlived its `expiresAt`. */
  | { kind: 'expired' }
  /** The user cancelled the challenge, or Cancel settled. */
  | { kind: 'cancelled' }
  /** Discard draft. */
  | { kind: 'discard' }
  /** The surface is going away: unmount, tab close, app quit. */
  | { kind: 'teardown' }
  /** Transport rejection — the outcome of the write is UNKNOWN. */
  | { kind: 'rejected' };

/**
 * The three nonterminal results, and only those, keep key refs alive: each one
 * is answered by resending the same request. Everything else — applied,
 * conflict, diagnostics, limited, expiry, cancel, Discard, teardown, and a
 * transport rejection — is terminal for keys.
 */
const KEY_RETAINING_STATUSES = ['consent_required', 'drop_confirmation_required', 'busy'] as const;

export const retainsKeys = (event: DraftEvent): boolean =>
  event.kind === 'result' && isOneOf(event.result.status, KEY_RETAINING_STATUSES);

function retainNonKeyChanges(draft: Draft, review: boolean): Draft {
  const changes = draft.changes.filter(
    (change) => !changeStableID(change).startsWith(KEY_IDENTITY_PREFIX)
  );
  const identities = changes.map(changeStableID);
  return {
    ...draft,
    changes,
    needsReview: review ? identities : draft.needsReview.filter((id) => identities.includes(id)),
  };
}

/**
 * The one place a draft settles, and the one place key refs are cleared.
 * Nothing else may call `KeyVault.clear`, so "were the keys dropped?" has
 * exactly one answer per outcome and it is this table.
 */
export function settleDraft(draft: Draft, event: DraftEvent, vault: KeyVault): Draft {
  if (retainsKeys(event)) return draft;
  vault.clear();
  switch (event.kind) {
    case 'discard':
    case 'teardown':
      return cleanDraft(draft.targetRevision);
    case 'rejected':
      // Outcome unknown: the write may already be live, so the old source chip
      // is dropped, the source resets to the active target, and every explicit
      // non-key operation waits for an explicit re-stage or discard (§4.6a).
      return { ...retainNonKeyChanges(draft, true), source: { kind: 'applied' } };
    case 'expired':
    case 'cancelled':
      // Nothing was written. The rows stay staged; only the keys must be
      // re-entered.
      return retainNonKeyChanges(draft, false);
    case 'result':
      switch (event.result.status) {
        case 'applied':
          return cleanDraft(event.result.projection.revision);
        case 'conflict':
          // No automatic merge and no auto-drop: every explicit non-key change
          // survives as `Needs review` (§4.6). The reload the user then chooses
          // supplies the new revision through setTargetRevision.
          return retainNonKeyChanges(draft, true);
        default:
          // diagnostics and limited: nothing was written, and the staged rows
          // are still what the user meant.
          return retainNonKeyChanges(draft, false);
      }
  }
}

// ---------------------------------------------------------------------------
// Projected draft
//
// Selector sharing is computed over the BASE projection AND every staged route
// change, because two use cases can be staged onto one provider+model that did
// not share a selector before. The selector-scoped fields are then coalesced
// once per selector, and the unknown-use-case confirmation is derived per
// selector — byte-identical to what internal/ai re-derives, or Apply refuses.
// ---------------------------------------------------------------------------

/**
 * Everything a draft needs from the document it is layered on. Satisfied by
 * both `SettingsProjection` and `ProfileDraftProjection`.
 */
export type DraftBaseProjection = Pick<SettingsProjection, 'routes' | 'models'>;

export interface RowMarkers {
  modified: boolean;
  keyStaged: boolean;
  needsReview: boolean;
}

export interface ProjectedDraft {
  /** The staged changes, normalized, in staging order — what Apply sends. */
  changes: Change[];
  /** Keyed by use case; includes selector-wide siblings. */
  routeRows: Map<string, RowMarkers>;
  /** Keyed by role. */
  roleRows: Map<string, RowMarkers>;
  /** Keyed by provider name. */
  providerRows: Map<string, RowMarkers>;
  /**
   * Staged use case → every use case its selector governs, for the editor's
   * "also governs" disclosure (§4.5).
   */
  selectorUseCases: Map<string, string[]>;
}

// NUL cannot occur inside an identifier (Cc is forbidden), so it separates the
// two halves of the key unambiguously.
const selectorKey = (provider: string, model: string): string => `${provider}\u0000${model}`;

/**
 * Mirrors internal/ai's sameModelFacts: an absent optional fact is the zero
 * value on both sides (the projection omits empty and zero facts).
 *
 * Exported for RouteEditor, which asks the same question the backend's
 * planRouteChanges asks — "is this a real retarget, or a selector override?" —
 * to decide whether hidden model-specific fields are about to be dropped. One
 * definition of the comparison, not two.
 */
export const sameModelFacts = (model: ModelProjection, facts: ModelFacts): boolean =>
  model.provider === facts.provider &&
  model.modelName === facts.model &&
  model.type === facts.type &&
  (model.parameters ?? '') === (facts.parameters ?? '') &&
  (model.contextWindow ?? 0) === (facts.contextWindow ?? 0) &&
  (model.dimensions ?? 0) === (facts.dimensions ?? 0);

interface SelectorGroup {
  changes: RouteChange[];
  affected: Set<string>;
}

/**
 * Groups staged route changes by provider+model and collects, per group, every
 * use case the resulting override governs — the mirror of the backend's
 * gateRolesFor: the role the use case resolves to today, plus every role
 * already sharing the selector when the change is an override or asserts
 * capabilities explicitly.
 */
function selectorGroups(
  base: DraftBaseProjection,
  changes: readonly Change[]
): Map<string, SelectorGroup> {
  const roleOf = new Map(base.routes.map((route) => [route.useCase, route.role]));
  const modelOf = new Map(base.models.map((model) => [model.role, model]));
  const groups = new Map<string, SelectorGroup>();
  for (const change of changes) {
    if (change.kind !== 'route') continue;
    const key = selectorKey(change.modelFacts.provider, change.modelFacts.model);
    let group = groups.get(key);
    if (group === undefined) {
      group = { changes: [], affected: new Set() };
      groups.set(key, group);
    }
    group.changes.push(change);
    group.affected.add(change.useCase);

    const role = roleOf.get(change.useCase);
    const current = role === undefined ? undefined : modelOf.get(role);
    const gateRoles = new Set<string>();
    if (role !== undefined) gateRoles.add(role);
    if (
      (current !== undefined && sameModelFacts(current, change.modelFacts)) ||
      change.exposedCaps.length > 0
    ) {
      for (const model of base.models) {
        if (selectorKey(model.provider, model.modelName) === key) gateRoles.add(model.role);
      }
    }
    for (const name of gateRoles) {
      for (const useCase of modelOf.get(name)?.routedUseCases ?? []) group.affected.add(useCase);
    }
  }
  return groups;
}

/**
 * One staged change rebuilt from its selector's authority. Written out member
 * by member rather than spread, so a stale `confirmUnknownUseCases` from an
 * earlier staging cannot survive into the request.
 */
const coalesceRouteChange = (
  change: RouteChange,
  authority: RouteChange,
  unknownUseCases: readonly string[]
): RouteChange => ({
  kind: 'route',
  useCase: change.useCase,
  modelFacts: change.modelFacts,
  // Selector-scoped (§3.3): byte-identical across the whole group.
  capabilityFacts: authority.capabilityFacts,
  exposedCaps: authority.exposedCaps,
  thinkMode: authority.thinkMode,
  confirmUnknown: authority.confirmUnknown,
  ...(unknownUseCases.length > 0 ? { confirmUnknownUseCases: [...unknownUseCases] } : {}),
  // Per change: the drop set belongs to the role being retargeted.
  ...(change.confirmDrops === undefined ? {} : { confirmDrops: change.confirmDrops }),
});

const markRow = (rows: Map<string, RowMarkers>, key: string, patch: Partial<RowMarkers>): void => {
  const current = rows.get(key) ?? { modified: false, keyStaged: false, needsReview: false };
  rows.set(key, {
    modified: current.modified || patch.modified === true,
    keyStaged: current.keyStaged || patch.keyStaged === true,
    needsReview: current.needsReview || patch.needsReview === true,
  });
};

export function projectDraft(base: DraftBaseProjection, draft: Draft): ProjectedDraft {
  const review = new Set(draft.needsReview);
  const routeRows = new Map<string, RowMarkers>();
  const roleRows = new Map<string, RowMarkers>();
  const providerRows = new Map<string, RowMarkers>();
  const selectorUseCases = new Map<string, string[]>();
  const normalized = new Map<string, RouteChange>();

  for (const group of selectorGroups(base, draft.changes).values()) {
    const affected = [...group.affected].sort(compareString);
    const unknownUseCases = affected.filter((useCase) => !USE_CASE_FLOORS.has(useCase));
    const authority = group.changes[group.changes.length - 1];
    const inReview = group.changes.some((change) => review.has(changeStableID(change)));
    for (const change of group.changes) {
      normalized.set(change.useCase, coalesceRouteChange(change, authority, unknownUseCases));
      selectorUseCases.set(change.useCase, affected);
    }
    // Selector-wide fields mark every affected sibling row, and siblings
    // inherit the originating operation's review state (§3.3, §4.6).
    for (const useCase of affected) {
      markRow(routeRows, useCase, { modified: true, needsReview: inReview });
    }
  }

  for (const change of draft.changes) {
    const needsReview = review.has(changeStableID(change));
    switch (change.kind) {
      case 'route':
        break; // marked per selector group above
      case 'route-unassign':
        markRow(routeRows, change.useCase, { modified: true, needsReview });
        break;
      case 'provider-add':
      case 'provider-update':
      case 'provider-remove':
        markRow(providerRows, change.name, { modified: true, needsReview });
        break;
      case 'provider-key-set':
      case 'provider-key-clear':
        markRow(providerRows, change.name, { keyStaged: true, needsReview });
        break;
      case 'role-remove':
        markRow(roleRows, change.role, { modified: true, needsReview });
        break;
    }
  }

  return {
    changes: draft.changes.map((change) =>
      change.kind === 'route' ? (normalized.get(change.useCase) ?? change) : change
    ),
    routeRows,
    roleRows,
    providerRows,
    selectorUseCases,
  };
}

/**
 * The request the draft currently means, validated by the same parser that
 * guards inbound payloads: a drafting bug (a stray key ref, a missing
 * targetRevision, a non-canonical capability array) fails here, at the boundary
 * that produced it, instead of arriving as an opaque diagnostics result.
 */
export function buildApplyRequest(
  base: DraftBaseProjection,
  draft: Draft,
  vault: KeyVault,
  mode: ApplyMode
): SettingsApplyRequest {
  return parseSettingsApplyRequest(
    {
      ...(mode === 'apply' && draft.targetRevision !== undefined
        ? { targetRevision: draft.targetRevision }
        : {}),
      source: draft.source,
      changes: projectDraft(base, draft).changes,
      keys: vault.extractForApply(),
    },
    mode
  );
}

// ---------------------------------------------------------------------------
// Active-profile provenance
//
// Display-only, schema-versioned, and never trusted: an unreadable, unknown-
// versioned, or malformed record reads as "no provenance" rather than as data.
// Every storage access is wrapped, because the accessor itself throws in a
// blocked-storage context.
// ---------------------------------------------------------------------------

export const ACTIVE_PROFILE_KEY = 'firn.golem.activeProfile';

export interface ActiveProfileProvenance {
  version: 1;
  profileId: string;
  appliedRevision: string;
}

const activeProfileStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage denied: provenance is display-only, so carry on
  }
};

export function readActiveProfile(): ActiveProfileProvenance | null {
  let raw: string | null;
  try {
    raw = activeProfileStorage()?.getItem(ACTIVE_PROFILE_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'profileId', 'appliedRevision'])) {
    return null;
  }
  if (value.version !== 1 || !isProfileID(value.profileId) || !isRevision(value.appliedRevision)) {
    return null;
  }
  return { version: 1, profileId: value.profileId, appliedRevision: value.appliedRevision };
}

function writeActiveProfile(value: ActiveProfileProvenance | null): void {
  try {
    const storage = activeProfileStorage();
    if (storage === null) return;
    if (value === null) storage.removeItem(ACTIVE_PROFILE_KEY);
    else storage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(value));
  } catch {
    return; // a denied or full store loses a label, nothing more
  }
}

/**
 * Only an acknowledged, actually-applied write moves provenance. An apply that
 * came from a profile records it; a blank build clears it; an edit of the
 * active document keeps whatever origin it already had; and an unknown outcome
 * clears it, because the label can no longer be trusted (§4.6a).
 */
export function recordApplyProvenance(source: ApplySource, event: DraftEvent): void {
  if (event.kind === 'rejected') {
    writeActiveProfile(null);
    return;
  }
  if (event.kind !== 'result' || event.result.status !== 'applied') return;
  switch (source.kind) {
    case 'applied':
      return;
    case 'blank':
      writeActiveProfile(null);
      return;
    case 'profile': {
      const appliedRevision = event.result.projection.revision;
      writeActiveProfile(
        isProfileID(source.profileId) && isRevision(appliedRevision)
          ? { version: 1, profileId: source.profileId, appliedRevision }
          : null
      );
    }
  }
}
