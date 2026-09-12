import fs from 'fs';
import path from 'path';
import {
  CAPABILITY_NAMES,
  GolemContractError,
  type CapabilityName,
  type ModelProjection,
} from '../../types/golem';
import {
  ACTIVE_PROFILE_KEY,
  affectedUseCases,
  buildApplyRequest,
  canApplyDraft,
  changeStableID,
  cleanDraft,
  draftChangeCount,
  effectiveRoutes,
  floorShortfalls,
  governedUseCasesOf,
  isDraftDirty,
  KeyVault,
  meetsUseCaseFloor,
  parseCancelSettingsApplyResult,
  parseConfirmSettingsApplyRequest,
  parseDestinationGrantsResult,
  parseGolemProfileListResult,
  parseGolemProfileLoadResult,
  parseGolemProfileSaveResult,
  parseSaveGolemProfileAsRequest,
  parseSettingsApplyRequest,
  parseSettingsApplyResult,
  probeRouteChange,
  projectDraft,
  providerUsage,
  readActiveProfile,
  recordApplyProvenance,
  replaceSource,
  retainsKeys,
  retargetOf,
  setTargetRevision,
  settleDraft,
  stageChange,
  stagedRoutes,
  unionFloor,
  unstageChange,
  USE_CASE_FLOORS,
  type ApplyMode,
  type Change,
  type DestinationGrantsStatus,
  type Draft,
  type DraftBaseProjection,
  type DraftEvent,
  type RouteChange,
} from '../../types/golemConfig';

const corpusDir = path.resolve(
  __dirname,
  '../../../../internal/ai/testdata/settings_apply_contract'
);

type ApplyFixture = {
  verdict: 'accept' | 'reject';
  document: string;
  mode?: string;
  value: unknown;
};

const readFixture = (file: string): ApplyFixture =>
  JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8')) as ApplyFixture;

const fixtureMode = (fixture: ApplyFixture): ApplyMode => {
  if (fixture.mode !== 'apply' && fixture.mode !== 'create') {
    throw new GolemContractError();
  }
  return fixture.mode;
};

const checkFixture = (fixture: ApplyFixture): void => {
  switch (fixture.document) {
    case 'apply_request':
      parseSettingsApplyRequest(fixture.value, fixtureMode(fixture));
      return;
    case 'confirm_request':
      parseConfirmSettingsApplyRequest(fixture.value, fixtureMode(fixture));
      return;
    case 'apply_result':
      parseSettingsApplyResult(fixture.value);
      return;
    case 'cancel_result':
      parseCancelSettingsApplyResult(fixture.value);
      return;
    case 'profile_load_result':
      parseGolemProfileLoadResult(fixture.value);
      return;
    case 'profile_list_result':
      parseGolemProfileListResult(fixture.value);
      return;
    case 'profile_save_request':
      parseSaveGolemProfileAsRequest(fixture.value);
      return;
    case 'profile_save_result':
      parseGolemProfileSaveResult(fixture.value);
      return;
    default:
      throw new Error(`unknown document ${fixture.document}`);
  }
};

describe('apply contract corpus', () => {
  const files = fs.readdirSync(corpusDir).filter((file) => file.endsWith('.json'));

  it('corpus exists', () => {
    expect(files.length).toBeGreaterThanOrEqual(100);
  });

  it.each(files)('%s parses to its recorded verdict', (file) => {
    const fixture = readFixture(file);
    if (fixture.verdict !== 'accept' && fixture.verdict !== 'reject') {
      throw new Error(`${file}: unknown verdict ${JSON.stringify(fixture.verdict)}`);
    }
    if (fixture.verdict === 'accept') {
      expect(() => checkFixture(fixture)).not.toThrow();
    } else {
      expect(() => checkFixture(fixture)).toThrow(GolemContractError);
    }
  });
});

const minimalRequest = () =>
  readFixture('accept-apply-request-minimal.json').value as Record<string, unknown>;

describe('parseSettingsApplyRequest', () => {
  it('returns the decoded request', () => {
    const request = parseSettingsApplyRequest(minimalRequest(), 'apply');
    expect(request.source.kind).toBe('applied');
    expect(request.changes).toHaveLength(1);
    expect(request.changes[0].kind).toBe('route');
  });

  it('accepts an identifier at exactly 256 UTF-8 bytes and rejects 257', () => {
    const at = minimalRequest();
    at.changes = [{ kind: 'route-unassign', useCase: 'é'.repeat(128) }];
    expect(() => parseSettingsApplyRequest(at, 'apply')).not.toThrow();
    const over = minimalRequest();
    over.changes = [{ kind: 'route-unassign', useCase: `${'é'.repeat(128)}a` }];
    expect(() => parseSettingsApplyRequest(over, 'apply')).toThrow(GolemContractError);
  });

  it('requires targetRevision on apply and forbids it on create', () => {
    const request = minimalRequest();
    expect(() => parseSettingsApplyRequest(request, 'create')).toThrow(GolemContractError);
    delete request.targetRevision;
    expect(() => parseSettingsApplyRequest(request, 'apply')).toThrow(GolemContractError);
  });

  // An empty change set is source-conditional: only a profile source carries a
  // document of its own, so only it is a write with no staged mutation. The Go
  // validator applies the identical rule to byte-identical fixtures.
  it.each([
    ['applied', 'apply', { kind: 'applied' }, false],
    ['blank', 'create', { kind: 'blank' }, false],
    [
      'profile',
      'apply',
      { kind: 'profile', profileId: 'curated/local', sourceRevision: 'a'.repeat(64) },
      true,
    ],
    [
      'profile',
      'create',
      { kind: 'profile', profileId: 'curated/local', sourceRevision: 'a'.repeat(64) },
      true,
    ],
  ] as const)('%s source with no changes on %s', (_kind, mode, source, accepted) => {
    const request = minimalRequest();
    request.source = source;
    request.changes = [];
    request.keys = {};
    if (mode === 'create') delete request.targetRevision;
    const parse = () => parseSettingsApplyRequest(request, mode);
    if (accepted) expect(parse).not.toThrow();
    else expect(parse).toThrow(GolemContractError);
  });

  it('rejects the applied source on create', () => {
    const request = minimalRequest();
    delete request.targetRevision;
    expect(() => parseSettingsApplyRequest(request, 'create')).toThrow(GolemContractError);
    request.source = { kind: 'blank' };
    expect(() => parseSettingsApplyRequest(request, 'create')).not.toThrow();
  });

  it.each([
    ['an empty value', ''],
    ['an interpolation', '${OPENAI_API_KEY}'],
    ['an embedded interpolation', 'prefix-${X}'],
    ['a value over 4096 bytes', 'k'.repeat(4097)],
  ])('rejects a key with %s', (_name, value) => {
    const request = minimalRequest();
    request.changes = [{ kind: 'provider-key-set', name: 'hosted' }];
    request.keys = { hosted: value };
    expect(() => parseSettingsApplyRequest(request, 'apply')).toThrow(GolemContractError);
  });

  it('requires an exact 1:1 map between provider-key-set changes and keys', () => {
    const missingKey = minimalRequest();
    missingKey.changes = [{ kind: 'provider-key-set', name: 'hosted' }];
    expect(() => parseSettingsApplyRequest(missingKey, 'apply')).toThrow(GolemContractError);

    const strayKey = minimalRequest();
    strayKey.keys = { hosted: 'sk-literal-value' };
    expect(() => parseSettingsApplyRequest(strayKey, 'apply')).toThrow(GolemContractError);

    const paired = minimalRequest();
    paired.changes = [{ kind: 'provider-key-set', name: 'hosted' }];
    paired.keys = { hosted: 'sk-literal-value' };
    expect(() => parseSettingsApplyRequest(paired, 'apply')).not.toThrow();
  });

  it('rejects 257 changes and accepts 256', () => {
    const build = (count: number) => {
      const request = minimalRequest();
      request.changes = Array.from({ length: count }, (_, index) => ({
        kind: 'route-unassign',
        useCase: `u${index.toString().padStart(3, '0')}`,
      }));
      return request;
    };
    expect(() => parseSettingsApplyRequest(build(256), 'apply')).not.toThrow();
    expect(() => parseSettingsApplyRequest(build(257), 'apply')).toThrow(GolemContractError);
  });
});

describe('parseSettingsApplyResult', () => {
  it('rejects an unknown status', () => {
    expect(() => parseSettingsApplyResult({ status: 'queued' })).toThrow(GolemContractError);
  });

  it('rejects a member the status does not own', () => {
    expect(() => parseSettingsApplyResult({ status: 'busy', conflict: 'target' })).toThrow(
      GolemContractError
    );
  });

  it('returns the narrowed variant', () => {
    const result = parseSettingsApplyResult(
      readFixture('accept-result-consent-required.json').value
    );
    if (result.status !== 'consent_required') throw new Error('expected consent_required');
    expect(result.challenge.destinations[0].classification).toBe('remote');
  });
});

// ---------------------------------------------------------------------------
// The batch consent challenge (spec D8): every NEW remote destination one
// write would open, each with the routing hops that reach it. The rules mirror
// validateApplyChallenge in internal/ai/settings_apply_test.go one for one --
// the corpus replays them on the live seam, and these state them directly so a
// rule that loses its fixture still has an owner.
// ---------------------------------------------------------------------------

/** One rendered provenance hop: two bounded identifiers plus a fixed literal. */
const MAX_HOP_BYTES = 544;

const destination = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: 'hosted',
  model: 'wire-model',
  endpoint: 'https://api.example.com/v1',
  classification: 'remote',
  provenance: ['agent'],
  ...over,
});

const challengeOf = (...destinations: unknown[]): Record<string, unknown> => ({
  token: 'opaque-challenge-token',
  expiresAt: 1767225600000,
  destinations,
});

const consentRequired = (challenge: unknown): unknown => ({
  status: 'consent_required',
  challenge,
});

/** Every way the batch can be malformed, stated once and asserted twice. */
const badChallenges: Array<[string, unknown]> = [
  ['no destinations at all', challengeOf()],
  [
    'a destination with no provenance key',
    challengeOf({
      provider: 'hosted',
      model: 'wire-model',
      endpoint: 'https://api.example.com/v1',
      classification: 'remote',
    }),
  ],
  ['an empty provenance', challengeOf(destination({ provenance: [] }))],
  ['an empty provenance hop', challengeOf(destination({ provenance: [''] }))],
  [
    'a provenance hop over the byte limit',
    challengeOf(destination({ provenance: ['a'.repeat(MAX_HOP_BYTES + 1)] })),
  ],
  ['a provenance hop carrying a format rune', challengeOf(destination({ provenance: ['agent‮'] }))],
  ['a local destination', challengeOf(destination({ classification: 'local' }))],
  ['an empty endpoint', challengeOf(destination({ endpoint: '' }))],
  ['an empty provider', challengeOf(destination({ provider: '' }))],
  ['an unknown destination member', challengeOf(destination({ apiKey: 'sk-leak' }))],
  ['257 destinations', challengeOf(...Array.from({ length: 257 }, () => destination()))],
];

describe('batch consent challenge', () => {
  it('parses every destination and keeps its provenance in order', () => {
    const result = parseSettingsApplyResult(
      consentRequired(
        challengeOf(
          destination(),
          destination({ model: '', provenance: ['agent', 'agent (recommendation)'] })
        )
      )
    );
    if (result.status !== 'consent_required') throw new Error('expected consent_required');
    expect(result.challenge.destinations).toHaveLength(2);
    expect(result.challenge.destinations[0]).toEqual({
      provider: 'hosted',
      model: 'wire-model',
      endpoint: 'https://api.example.com/v1',
      classification: 'remote',
      provenance: ['agent'],
    });
    // A recommendation entry names a provider and no model at all.
    expect(result.challenge.destinations[1].model).toBe('');
    expect(result.challenge.destinations[1].provenance).toEqual([
      'agent',
      'agent (recommendation)',
    ]);
  });

  it('accepts 256 destinations and a hop at exactly the byte limit', () => {
    const result = parseSettingsApplyResult(
      consentRequired(
        challengeOf(
          ...Array.from({ length: 255 }, () => destination()),
          destination({ provenance: ['a'.repeat(MAX_HOP_BYTES)] })
        )
      )
    );
    if (result.status !== 'consent_required') throw new Error('expected consent_required');
    expect(result.challenge.destinations).toHaveLength(256);
  });

  it.each(badChallenges)('rejects a challenge with %s', (_name, challenge) => {
    expect(() => parseSettingsApplyResult(consentRequired(challenge))).toThrow(GolemContractError);
  });

  it('rejects a challenge on a status that does not own one', () => {
    expect(() =>
      parseSettingsApplyResult({ status: 'busy', challenge: challengeOf(destination()) })
    ).toThrow(GolemContractError);
  });

  it('rejects consent_required with no challenge', () => {
    expect(() => parseSettingsApplyResult({ status: 'consent_required' })).toThrow(
      GolemContractError
    );
  });
});

// ---------------------------------------------------------------------------
// The grant-only result (spec D13): eight statuses, no projection, no
// diagnostics, and a challenge present iff the status is consent_required.
// ---------------------------------------------------------------------------

describe('parseDestinationGrantsResult', () => {
  const STATUSES: DestinationGrantsStatus[] = [
    'none',
    'consent_required',
    'granted',
    'uncertain',
    'conflict',
    'busy',
    'unavailable',
    'config_invalid',
  ];

  it.each(STATUSES)('accepts %s', (status) => {
    const value =
      status === 'consent_required'
        ? { status, challenge: challengeOf(destination()) }
        : { status };
    expect(parseDestinationGrantsResult(value).status).toBe(status);
  });

  it('returns the parsed challenge on consent_required', () => {
    const { status, challenge } = parseDestinationGrantsResult({
      status: 'consent_required',
      challenge: challengeOf(destination(), destination({ model: '' })),
    });
    expect(status).toBe('consent_required');
    if (challenge === undefined) throw new Error('expected a challenge');
    expect(challenge.destinations).toHaveLength(2);
    expect(challenge.token).toBe('opaque-challenge-token');
  });

  it('leaves the challenge absent on every other status', () => {
    expect(parseDestinationGrantsResult({ status: 'granted' }).challenge).toBeUndefined();
  });

  it('rejects a status outside the union', () => {
    expect(() => parseDestinationGrantsResult({ status: 'applied' })).toThrow(GolemContractError);
  });

  it('rejects consent_required with no challenge', () => {
    expect(() => parseDestinationGrantsResult({ status: 'consent_required' })).toThrow(
      GolemContractError
    );
  });

  it.each(STATUSES.filter((status) => status !== 'consent_required'))(
    'rejects a challenge carried by %s',
    (status) => {
      expect(() =>
        parseDestinationGrantsResult({ status, challenge: challengeOf(destination()) })
      ).toThrow(GolemContractError);
    }
  );

  it('rejects a member the result never owns', () => {
    expect(() =>
      parseDestinationGrantsResult({ status: 'granted', projection: { state: 'ready' } })
    ).toThrow(GolemContractError);
  });

  it.each(badChallenges)('rejects a consent_required challenge with %s', (_name, challenge) => {
    expect(() => parseDestinationGrantsResult({ status: 'consent_required', challenge })).toThrow(
      GolemContractError
    );
  });

  it('rejects a non-record', () => {
    expect(() => parseDestinationGrantsResult(null)).toThrow(GolemContractError);
  });
});

describe('parseCancelSettingsApplyResult', () => {
  it('accepts the single success variant', () => {
    expect(parseCancelSettingsApplyResult({ status: 'cancelled' }).status).toBe('cancelled');
  });
  it('rejects anything else', () => {
    expect(() => parseCancelSettingsApplyResult({ status: 'cancelling' })).toThrow(
      GolemContractError
    );
  });
});

describe('parseGolemProfileLoadResult', () => {
  it('returns the draft projection and its provenance', () => {
    const result = parseGolemProfileLoadResult(
      readFixture('accept-profile-load-loaded.json').value
    );
    if (result.status !== 'loaded') throw new Error('expected loaded');
    expect(result.profileId).toBe('curated/local');
    expect(result.projection.providers[0].credentialState).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Draft reducer, key lifecycle, and provenance
// ---------------------------------------------------------------------------

const REVISION_A = '0123456789abcdef'.repeat(4);

const appliedResult = () =>
  parseSettingsApplyResult(readFixture('accept-result-applied.json').value);
const resultEvent = (file: string): DraftEvent => ({
  kind: 'result',
  result: parseSettingsApplyResult(readFixture(file).value),
});

const vaultOf = (entries: readonly (readonly [string, string])[] = []): KeyVault =>
  new KeyVault(new Map(entries));

const routeChange = (over: Partial<RouteChange> = {}): RouteChange => ({
  kind: 'route',
  useCase: 'chat',
  modelFacts: { provider: 'hosted', model: 'gpt-5-mini', type: 'dense' },
  capabilityFacts: { caps: ['chat', 'stream'], knownCaps: [...CAPABILITY_NAMES] },
  exposedCaps: ['chat', 'stream'],
  thinkMode: '',
  confirmUnknown: false,
  ...over,
});

const modelRow = (over: Partial<ModelProjection> = {}): ModelProjection => ({
  role: 'chat-role',
  modelName: 'gpt-5-mini',
  provider: 'hosted',
  type: 'dense',
  effectiveCapabilities: ['chat', 'stream'],
  capabilityFacts: { caps: ['chat', 'stream'], knownCaps: [...CAPABILITY_NAMES] },
  exposedCapabilities: ['chat', 'stream'],
  thinkMode: '',
  routedUseCases: ['chat'],
  hasThinkTags: false,
  hasSlots: false,
  removable: false,
  ...over,
});

const emptyBase: DraftBaseProjection = { routes: [], models: [] };

const stage = (changes: readonly Change[], vault: KeyVault = vaultOf()): Draft =>
  changes.reduce((draft, change) => stageChange(draft, change, vault), cleanDraft(REVISION_A));

const selectorFields = (change: Change) => {
  if (change.kind !== 'route') throw new Error('expected a route change');
  return {
    exposedCaps: change.exposedCaps,
    capabilityFacts: change.capabilityFacts,
    thinkMode: change.thinkMode,
    confirmUnknown: change.confirmUnknown,
    confirmUnknownUseCases: change.confirmUnknownUseCases,
  };
};

describe('draft reducer', () => {
  it('replaces a restaged identity and keeps the newest values', () => {
    const draft = stage([routeChange({ thinkMode: 'auto' }), routeChange({ thinkMode: 'always' })]);
    expect(draft.changes).toHaveLength(1);
    expect(selectorFields(draft.changes[0]).thinkMode).toBe('always');
    expect(draftChangeCount(draft)).toBe(1);
  });

  it('treats a source replacement as dirty with no staged rows', () => {
    const clean = cleanDraft(REVISION_A);
    expect(isDraftDirty(clean)).toBe(false);
    expect(draftChangeCount(clean)).toBe(0);

    const profile = replaceSource(
      clean,
      { kind: 'profile', profileId: 'curated/local', sourceRevision: REVISION_A },
      vaultOf()
    );
    expect(isDraftDirty(profile)).toBe(true);
    expect(draftChangeCount(profile)).toBe(1);
    expect(draftChangeCount(stage([routeChange()], vaultOf()))).toBe(1);
  });

  it('keeps a provider add and its key set as independent identities', () => {
    const vault = vaultOf();
    vault.set('hosted', 'sk-literal');
    const draft = stage(
      [
        { kind: 'provider-add', name: 'hosted', endpoint: 'https://api.example.com' },
        { kind: 'provider-key-set', name: 'hosted' },
      ],
      vault
    );
    expect(draft.changes.map(changeStableID)).toEqual(['provider:hosted', 'provider-key:hosted']);
    expect(vault.has('hosted')).toBe(true);
  });

  it('evicts a staged key change and its vault entry when the provider is removed', () => {
    const vault = vaultOf();
    vault.set('hosted', 'sk-literal');
    const staged = stage([{ kind: 'provider-key-set', name: 'hosted' }], vault);
    const removed = stageChange(staged, { kind: 'provider-remove', name: 'hosted' }, vault);
    expect(removed.changes.map(changeStableID)).toEqual(['provider:hosted']);
    expect(vault.has('hosted')).toBe(false);
    expect(vault.extractForApply()).toEqual({});
  });

  it('adopts a reloaded revision while the retained changes stand', () => {
    const draft = setTargetRevision(
      stage([{ kind: 'route-unassign', useCase: 'chat' }]),
      'b'.repeat(64)
    );
    expect(draft.targetRevision).toBe('b'.repeat(64));
    expect(draft.changes).toHaveLength(1);
  });

  it('unstaging a key set drops its vault entry', () => {
    const vault = vaultOf();
    vault.set('hosted', 'sk-literal');
    const draft = unstageChange(
      stage([{ kind: 'provider-key-set', name: 'hosted' }], vault),
      'provider-key:hosted',
      vault
    );
    expect(draft.changes).toHaveLength(0);
    expect(vault.has('hosted')).toBe(false);
  });
});

describe('projected draft normalization', () => {
  it('coalesces selector-wide fields once across every staged route on one selector', () => {
    const draft = stage([
      routeChange({ useCase: 'chat', exposedCaps: ['chat'], thinkMode: 'auto' }),
      routeChange({ useCase: 'summarize', exposedCaps: ['chat', 'stream'], thinkMode: 'always' }),
    ]);
    const projected = projectDraft(emptyBase, draft);
    const [first, second] = projected.changes;
    expect(selectorFields(first)).toEqual(selectorFields(second));
    expect(selectorFields(first).exposedCaps).toEqual(['chat', 'stream']);
    expect(selectorFields(first).thinkMode).toBe('always');
  });

  it('leaves distinct selectors independent', () => {
    const draft = stage([
      routeChange({ useCase: 'chat', thinkMode: 'auto' }),
      routeChange({
        useCase: 'agent',
        modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
        exposedCaps: ['chat', 'stream', 'tool_call'],
        thinkMode: 'none',
      }),
    ]);
    const projected = projectDraft(emptyBase, draft);
    expect(selectorFields(projected.changes[0]).thinkMode).toBe('auto');
    expect(selectorFields(projected.changes[1]).thinkMode).toBe('none');
  });

  it('derives confirmUnknownUseCases as the sorted floorless union of the selector group', () => {
    const draft = stage([
      routeChange({ useCase: 'chat' }),
      routeChange({ useCase: 'summarize' }),
      routeChange({ useCase: 'briefing' }),
    ]);
    const projected = projectDraft(emptyBase, draft);
    for (const change of projected.changes) {
      expect(selectorFields(change).confirmUnknownUseCases).toEqual(['briefing', 'summarize']);
    }
  });

  it('omits confirmUnknownUseCases when every affected use case has a floor', () => {
    const draft = stage([routeChange({ useCase: 'chat' })]);
    const projected = projectDraft(emptyBase, draft);
    expect(projected.changes[0]).not.toHaveProperty('confirmUnknownUseCases');
  });

  it('widens the affected set to the use cases the current role already serves', () => {
    const base: DraftBaseProjection = {
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [modelRow({ routedUseCases: ['chat', 'summarize'] })],
    };
    const projected = projectDraft(base, stage([routeChange({ useCase: 'chat' })]));
    expect(projected.selectorUseCases.get('chat')).toEqual(['chat', 'summarize']);
    expect(selectorFields(projected.changes[0]).confirmUnknownUseCases).toEqual(['summarize']);
    // An override sits on the selector the current role is on, so it governs
    // summarize too; a fork onto a selector nobody is on governs chat alone and
    // summarize is confirmation-only (the source role is left as it was).
    expect(projected.governedUseCases.get('chat')).toEqual(['chat', 'summarize']);
    const forked = projectDraft(
      base,
      stage([
        routeChange({
          useCase: 'chat',
          modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
        }),
      ])
    );
    expect(forked.selectorUseCases.get('chat')).toEqual(['chat', 'summarize']);
    expect(forked.governedUseCases.get('chat')).toEqual(['chat']);
  });

  it('marks shared selector siblings Modified and inherits Needs review', () => {
    const base: DraftBaseProjection = {
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [modelRow({ routedUseCases: ['chat', 'summarize'] })],
    };
    const draft = stage([routeChange({ useCase: 'chat' })]);
    const projected = projectDraft(base, draft);
    expect(projected.routeRows.get('chat')?.modified).toBe(true);
    expect(projected.routeRows.get('summarize')?.modified).toBe(true);
    expect(projected.routeRows.get('summarize')?.needsReview).toBe(false);

    const conflicted = settleDraft(
      draft,
      {
        kind: 'result',
        result: { status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' },
      },
      vaultOf()
    );
    const reviewed = projectDraft(base, conflicted);
    expect(reviewed.routeRows.get('chat')?.needsReview).toBe(true);
    expect(reviewed.routeRows.get('summarize')?.needsReview).toBe(true);
  });

  it('marks provider rows Modified and Key staged separately', () => {
    const vault = vaultOf([['hosted', 'sk-literal']]);
    const draft = stage(
      [
        { kind: 'provider-update', name: 'hosted', endpoint: 'https://api.example.com' },
        { kind: 'provider-key-set', name: 'hosted' },
        { kind: 'role-remove', role: 'orphan' },
      ],
      vault
    );
    const projected = projectDraft(emptyBase, draft);
    expect(projected.providerRows.get('hosted')).toEqual({
      modified: true,
      keyStaged: true,
      needsReview: false,
    });
    expect(projected.roleRows.get('orphan')?.modified).toBe(true);
  });
});

describe('buildApplyRequest', () => {
  it('builds an exact 1:1 key map for staged key sets', () => {
    const vault = vaultOf([['hosted', 'sk-literal']]);
    const draft = stage([{ kind: 'provider-key-set', name: 'hosted' }], vault);
    const request = buildApplyRequest(emptyBase, draft, vault, 'apply');
    expect(request.keys).toEqual({ hosted: 'sk-literal' });
    expect(request.targetRevision).toBe(REVISION_A);
  });

  it('refuses a vault entry with no matching key-set change', () => {
    const vault = vaultOf([['hosted', 'sk-literal']]);
    const draft = stage([{ kind: 'route-unassign', useCase: 'chat' }]);
    expect(() => buildApplyRequest(emptyBase, draft, vault, 'apply')).toThrow(GolemContractError);
  });

  it('refuses a key-set change with no vault entry', () => {
    const vault = vaultOf();
    const draft = stage([{ kind: 'provider-key-set', name: 'hosted' }], vault);
    expect(() => buildApplyRequest(emptyBase, draft, vault, 'apply')).toThrow(GolemContractError);
  });

  it('sends the normalized selector-wide changes', () => {
    const vault = vaultOf();
    const draft = stage(
      [
        routeChange({ useCase: 'chat', exposedCaps: ['chat'] }),
        routeChange({ useCase: 'summarize', exposedCaps: ['chat', 'stream'] }),
      ],
      vault
    );
    const request = buildApplyRequest(emptyBase, draft, vault, 'apply');
    expect(selectorFields(request.changes[0])).toEqual(selectorFields(request.changes[1]));
  });

  it('omits targetRevision on create', () => {
    const vault = vaultOf();
    const draft = replaceSource(
      stage([routeChange({ useCase: 'agent' })], vault),
      { kind: 'blank' },
      vault
    );
    const request = buildApplyRequest(
      emptyBase,
      stageChange(draft, routeChange({ useCase: 'agent' }), vault),
      vault,
      'create'
    );
    expect(request).not.toHaveProperty('targetRevision');
    expect(request.source.kind).toBe('blank');
  });
});

describe('key lifecycle', () => {
  const keyedDraft = (vault: KeyVault): Draft => {
    vault.set('hosted', 'sk-literal');
    return stage(
      [
        { kind: 'provider-add', name: 'hosted', endpoint: 'https://api.example.com' },
        { kind: 'provider-key-set', name: 'hosted' },
      ],
      vault
    );
  };

  it.each([
    ['consent_required', () => resultEvent('accept-result-consent-required.json')],
    [
      'drop_confirmation_required',
      () => resultEvent('accept-result-drop-confirmation-required.json'),
    ],
    ['busy', (): DraftEvent => ({ kind: 'result', result: { status: 'busy' } })],
  ])('retains key refs across %s and extracts repeatably', (_name, build) => {
    const vault = vaultOf();
    const draft = keyedDraft(vault);
    const event = build();
    expect(retainsKeys(event)).toBe(true);
    const before = vault.extractForApply();
    const settled = settleDraft(draft, event, vault);
    expect(vault.extractForApply()).toEqual(before);
    expect(vault.extractForApply()).toEqual({ hosted: 'sk-literal' });
    expect(settled.changes.map(changeStableID)).toEqual(draft.changes.map(changeStableID));
    expect(buildApplyRequest(emptyBase, settled, vault, 'apply').keys).toEqual({
      hosted: 'sk-literal',
    });
  });

  it.each([
    ['applied', (): DraftEvent => ({ kind: 'result', result: appliedResult() })],
    [
      'conflict',
      (): DraftEvent => ({
        kind: 'result',
        result: { status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' },
      }),
    ],
    ['diagnostics', () => resultEvent('accept-result-diagnostics.json')],
    ['limited', () => resultEvent('accept-result-limited.json')],
    ['expiry', (): DraftEvent => ({ kind: 'expired' })],
    ['cancel', (): DraftEvent => ({ kind: 'cancelled' })],
    ['discard', (): DraftEvent => ({ kind: 'discard' })],
    ['teardown', (): DraftEvent => ({ kind: 'teardown' })],
    ['transport rejection', (): DraftEvent => ({ kind: 'rejected' })],
  ])('clears key refs and key changes on %s', (_name, build) => {
    const vault = vaultOf();
    const draft = keyedDraft(vault);
    const event = build();
    expect(retainsKeys(event)).toBe(false);
    const settled = settleDraft(draft, event, vault);
    expect(vault.extractForApply()).toEqual({});
    expect(vault.has('hosted')).toBe(false);
    expect(
      settled.changes.some((change) => changeStableID(change).startsWith('provider-key:'))
    ).toBe(false);
  });

  it('resets the draft on applied and adopts the new revision', () => {
    const vault = vaultOf();
    const settled = settleDraft(
      keyedDraft(vault),
      { kind: 'result', result: appliedResult() },
      vault
    );
    expect(settled.changes).toHaveLength(0);
    expect(settled.source).toEqual({ kind: 'applied' });
    expect(settled.needsReview).toHaveLength(0);
    expect(isDraftDirty(settled)).toBe(false);
    expect(settled.targetRevision).toBe(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
  });

  it('retains every explicit non-key change as Needs review on conflict and blocks Apply', () => {
    const vault = vaultOf();
    const draft = keyedDraft(vault);
    const settled = settleDraft(
      draft,
      {
        kind: 'result',
        result: { status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' },
      },
      vault
    );
    expect(settled.changes.map(changeStableID)).toEqual(['provider:hosted']);
    expect(settled.needsReview).toEqual(['provider:hosted']);
    expect(canApplyDraft(settled)).toBe(false);
    expect(isDraftDirty(settled)).toBe(true);

    const restaged = stageChange(
      settled,
      { kind: 'provider-add', name: 'hosted', endpoint: 'https://api.example.com' },
      vault
    );
    expect(restaged.needsReview).toHaveLength(0);
    expect(canApplyDraft(restaged)).toBe(true);
  });

  it('clears Needs review when the retained change is discarded instead', () => {
    const vault = vaultOf();
    const settled = settleDraft(
      keyedDraft(vault),
      {
        kind: 'result',
        result: { status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' },
      },
      vault
    );
    const discarded = unstageChange(settled, 'provider:hosted', vault);
    expect(discarded.needsReview).toHaveLength(0);
    expect(isDraftDirty(discarded)).toBe(false);
  });

  it('drops the profile source on an outcome-unknown rejection', () => {
    const vault = vaultOf();
    const profile = replaceSource(
      keyedDraft(vault),
      { kind: 'profile', profileId: 'curated/local', sourceRevision: REVISION_A },
      vault
    );
    const staged = stageChange(
      profile,
      { kind: 'provider-add', name: 'hosted', endpoint: 'https://api.example.com' },
      vault
    );
    const settled = settleDraft(staged, { kind: 'rejected' }, vault);
    expect(settled.source).toEqual({ kind: 'applied' });
    expect(settled.needsReview).toEqual(['provider:hosted']);
    expect(canApplyDraft(settled)).toBe(false);
  });

  it('never validates or drops what the vault is given', () => {
    const vault = vaultOf();
    vault.set('hosted', '');
    vault.set('other', '${OPENAI_API_KEY}');
    expect(vault.extractForApply()).toEqual({ hosted: '', other: '${OPENAI_API_KEY}' });
  });
});

describe('active profile provenance', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const seed = () =>
    window.localStorage.setItem(
      ACTIVE_PROFILE_KEY,
      JSON.stringify({ version: 1, profileId: 'user/mine', appliedRevision: REVISION_A })
    );

  it('records an acknowledged profile-origin apply', () => {
    recordApplyProvenance(
      { kind: 'profile', profileId: 'curated/local', sourceRevision: REVISION_A },
      { kind: 'result', result: appliedResult() }
    );
    expect(readActiveProfile()).toEqual({
      version: 1,
      profileId: 'curated/local',
      appliedRevision: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
  });

  it('clears provenance for a blank-origin apply', () => {
    seed();
    recordApplyProvenance({ kind: 'blank' }, { kind: 'result', result: appliedResult() });
    expect(readActiveProfile()).toBeNull();
  });

  it('retains provenance for an applied-origin edit', () => {
    seed();
    recordApplyProvenance({ kind: 'applied' }, { kind: 'result', result: appliedResult() });
    expect(readActiveProfile()?.profileId).toBe('user/mine');
  });

  it('clears provenance when the outcome is unknown', () => {
    seed();
    recordApplyProvenance(
      { kind: 'profile', profileId: 'curated/local', sourceRevision: REVISION_A },
      { kind: 'rejected' }
    );
    expect(readActiveProfile()).toBeNull();
  });

  it('retains provenance when nothing was written', () => {
    seed();
    recordApplyProvenance(
      { kind: 'profile', profileId: 'curated/local', sourceRevision: REVISION_A },
      resultEvent('accept-result-diagnostics.json')
    );
    expect(readActiveProfile()?.profileId).toBe('user/mine');
  });

  it.each([
    ['a non-JSON value', 'not-json'],
    [
      'a future schema version',
      '{"version":2,"profileId":"user/mine","appliedRevision":"' + REVISION_A + '"}',
    ],
    [
      'an unknown member',
      '{"version":1,"profileId":"user/mine","appliedRevision":"' + REVISION_A + '","extra":1}',
    ],
    ['an invalid revision', '{"version":1,"profileId":"user/mine","appliedRevision":"nope"}'],
    [
      'an invalid profile id',
      '{"version":1,"profileId":"User/Mine","appliedRevision":"' + REVISION_A + '"}',
    ],
  ])('reads %s as no provenance', (_name, raw) => {
    window.localStorage.setItem(ACTIVE_PROFILE_KEY, raw);
    expect(readActiveProfile()).toBeNull();
  });

  it('survives a throwing storage accessor', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    try {
      expect(readActiveProfile()).toBeNull();
      expect(() =>
        recordApplyProvenance(
          { kind: 'profile', profileId: 'curated/local', sourceRevision: REVISION_A },
          { kind: 'result', result: appliedResult() }
        )
      ).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('use-case floors', () => {
  const rows = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../internal/ai/testdata/settings_use_case_floors.json'),
      'utf8'
    )
  ) as { useCase: string; capabilities: CapabilityName[] }[];

  it('mirrors the Go floor table exactly', () => {
    expect(USE_CASE_FLOORS.size).toBe(rows.length);
    for (const row of rows) {
      expect(USE_CASE_FLOORS.get(row.useCase)).toEqual(row.capabilities);
    }
  });

  it.each([
    ['agent', ['chat', 'stream'], false],
    ['agent', ['chat', 'stream', 'tool_call'], true],
    ['chat', ['chat', 'stream'], true],
    ['embedding', ['embed'], true],
    ['embedding', ['chat'], false],
    ['summarize', [], true],
    ['planning', ['chat', 'stream'], false],
    ['planning', ['chat', 'stream', 'tool_call'], true],
  ])('meetsUseCaseFloor(%s, %j) is %s', (useCase, caps, expected) => {
    expect(meetsUseCaseFloor(useCase as string, caps as CapabilityName[])).toBe(expected);
  });
});

describe('effectiveRoutes / providerUsage (one derived view)', () => {
  const base: DraftBaseProjection = {
    routes: [
      { useCase: 'agent', role: 'a' },
      { useCase: 'chat', role: 'c' },
    ],
    models: [
      // The fallback-inclusive claim each model carries has to AGREE with the
      // routes above, or the fold [X3] applies would credit a use case the base
      // never routed there. `modelRow` defaults to `['chat']`.
      modelRow({ role: 'a', provider: 'llama-swap', modelName: 'm1', routedUseCases: ['agent'] }),
      modelRow({ role: 'c', provider: 'zen', modelName: 'm2' }),
    ],
  };

  it('reflects staged moves and unassigns, not only the base', () => {
    const changes: Change[] = [
      {
        kind: 'route',
        useCase: 'agent',
        modelFacts: { provider: 'zen', model: 'm3', type: 'dense' },
        capabilityFacts: { caps: [], knownCaps: [] },
        exposedCaps: [],
        thinkMode: '',
        confirmUnknown: false,
      },
      { kind: 'route-unassign', useCase: 'chat' },
    ];
    const routes = effectiveRoutes(base, changes);
    expect(routes.get('agent')).toEqual({ provider: 'zen', model: 'm3' });
    expect(routes.get('chat')).toBeNull();
    expect(providerUsage(routes, base, changes)).toEqual(new Map([['zen', ['agent']]]));
  });

  it('with no changes equals the base', () => {
    expect(providerUsage(effectiveRoutes(base, []), base, [])).toEqual(
      new Map([
        ['llama-swap', ['agent']],
        ['zen', ['chat']],
      ])
    );
  });

  it('credits a provider reached only through a fallback chain', () => {
    // [X3] `agent` routes DIRECTLY to provider A, but the backend resolved its
    // fallback chain onto provider B and says so on B's model (`routedUseCases`).
    // Counting only direct routes would report B as `not routed`.
    const withFallback: DraftBaseProjection = {
      routes: [{ useCase: 'agent', role: 'a' }],
      models: [
        modelRow({ role: 'a', provider: 'A', modelName: 'm1', routedUseCases: ['agent'] }),
        modelRow({ role: 'b', provider: 'B', modelName: 'm2', routedUseCases: ['agent'] }),
      ],
    };
    expect(providerUsage(effectiveRoutes(withFallback, []), withFallback, [])).toEqual(
      new Map([
        ['A', ['agent']],
        ['B', ['agent']],
      ])
    );
  });

  it('lets a staged route override the base claim on that use case', () => {
    // The fold answers only use cases this draft is NOT restaging: once `agent` is
    // retargeted, the applied models' claim on it is exactly what Apply replaces.
    const withFallback: DraftBaseProjection = {
      routes: [{ useCase: 'agent', role: 'a' }],
      models: [
        modelRow({ role: 'a', provider: 'A', modelName: 'm1', routedUseCases: ['agent'] }),
        modelRow({ role: 'b', provider: 'B', modelName: 'm2', routedUseCases: ['agent'] }),
      ],
    };
    const changes: Change[] = [
      {
        kind: 'route',
        useCase: 'agent',
        modelFacts: { provider: 'C', model: 'm3', type: 'dense' },
        capabilityFacts: { caps: [], knownCaps: [] },
        exposedCaps: [],
        thinkMode: '',
        confirmUnknown: false,
      },
    ];
    expect(providerUsage(effectiveRoutes(withFallback, changes), withFallback, changes)).toEqual(
      new Map([['C', ['agent']]])
    );
  });
});

describe('floors across a selector (wave 4c)', () => {
  // Transport order (routes by use case, models by role), as a real projection arrives.
  const base: DraftBaseProjection = {
    routes: [
      { useCase: 'agent', role: 'agent-role' },
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'reasoning', role: 'reason-role' },
    ],
    models: [
      modelRow({
        role: 'agent-role',
        modelName: 'gpt-5',
        effectiveCapabilities: ['chat', 'stream', 'tool_call'],
        capabilityFacts: {
          caps: ['chat', 'stream', 'tool_call'],
          knownCaps: [...CAPABILITY_NAMES],
        },
        exposedCapabilities: ['chat', 'stream', 'tool_call'],
        routedUseCases: ['agent'],
      }),
      modelRow({ routedUseCases: ['chat'] }),
      // agent reaches reason-role through a fallback chain: routedUseCases is
      // fallback-inclusive (internal/ai/settings.go roleUsage).
      modelRow({
        role: 'reason-role',
        modelName: 'deepseek',
        routedUseCases: ['agent', 'reasoning'],
      }),
    ],
  };
  const byRole = (role: string): ModelProjection => {
    const found = base.models.find((model) => model.role === role);
    if (found === undefined) throw new Error(`no model role ${role}`);
    return found;
  };

  it('unions the floors of the use cases named, in canonical order', () => {
    expect(unionFloor(['reasoning'])).toEqual([]);
    expect(unionFloor(['reasoning', 'agent', 'embedding'])).toEqual([
      'chat',
      'stream',
      'embed',
      'tool_call',
    ]);
  });

  it('lists what a candidate asks the user to confirm, the edited use case first', () => {
    // reasoning's current role also serves agent; gpt-5's selector serves agent directly.
    expect(
      affectedUseCases(
        base,
        cleanDraft(REVISION_A),
        probeRouteChange('reasoning', byRole('agent-role'))
      )
    ).toEqual(['reasoning', 'agent']);
    // A card on chat-role's selector adds chat to the set.
    expect(
      affectedUseCases(
        base,
        cleanDraft(REVISION_A),
        probeRouteChange('reasoning', byRole('chat-role'))
      )
    ).toEqual(['reasoning', 'agent', 'chat']);
  });

  it('lists what a candidate governs: the changed use case, then the target selector routes', () => {
    // agent-role is on gpt-5's selector, so a fork of reasoning onto it governs agent…
    expect(
      governedUseCasesOf(
        base,
        cleanDraft(REVISION_A),
        probeRouteChange('reasoning', byRole('agent-role'))
      )
    ).toEqual(['reasoning', 'agent']);
    // …while on chat-role's selector agent — reached only through reasoning's
    // CURRENT role — is confirmation-only: the fork leaves that role as it is.
    const ontoChat = probeRouteChange('reasoning', byRole('chat-role'));
    expect(governedUseCasesOf(base, cleanDraft(REVISION_A), ontoChat)).toEqual([
      'reasoning',
      'chat',
    ]);
    expect(affectedUseCases(base, cleanDraft(REVISION_A), ontoChat)).toEqual([
      'reasoning',
      'agent',
      'chat',
    ]);
  });

  it('folds a staged change on the same selector into the set', () => {
    const draft = stage([
      routeChange({
        useCase: 'chat',
        modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
        exposedCaps: ['chat', 'stream', 'tool_call'],
      }),
    ]);
    expect(
      affectedUseCases(base, draft, probeRouteChange('reasoning', byRole('agent-role')))
    ).toEqual(['reasoning', 'agent', 'chat']);
  });

  it('names each missing capability with the use cases that need it', () => {
    expect(floorShortfalls(['chat', 'stream'], ['reasoning', 'agent', 'chat'])).toEqual([
      { cap: 'tool_call', useCases: ['agent'] },
    ]);
    expect(floorShortfalls(['embed'], ['chat', 'agent'])).toEqual([
      { cap: 'chat', useCases: ['chat', 'agent'] },
      { cap: 'stream', useCases: ['chat', 'agent'] },
      { cap: 'tool_call', useCases: ['agent'] },
    ]);
    expect(floorShortfalls(['chat', 'stream', 'tool_call'], ['reasoning', 'agent'])).toEqual([]);
  });

  it("carries every optional fact and the model's own exposure into the probe", () => {
    const probe = probeRouteChange('agent', modelRow({ parameters: '7b', contextWindow: 4096 }));
    expect(probe.modelFacts).toEqual({
      provider: 'hosted',
      model: 'gpt-5-mini',
      type: 'dense',
      parameters: '7b',
      contextWindow: 4096,
    });
    // What the card exposes, nothing added: the floor it misses is the verdict, not the probe.
    expect(probe.exposedCaps).toEqual(['chat', 'stream']);
    expect(probe.thinkMode).toBe('');
  });

  it('drops a sibling the draft already moves off the selector from the governed set', () => {
    // [W4-10] agent sits on gpt-5 today. A draft that routes it onto ANOTHER
    // selector leaves nothing of it on gpt-5 for chat to govern; a draft that
    // routes it ONTO gpt-5 is in chat's own selector group.
    const gpt5 = byRole('agent-role');
    const twoRoutes: DraftBaseProjection = {
      routes: [
        { useCase: 'agent', role: 'agent-role' },
        { useCase: 'chat', role: 'chat-role' },
      ],
      models: [gpt5, modelRow({ routedUseCases: ['chat'] })],
    };
    const probe = probeRouteChange('chat', gpt5);
    const agentOnto = (model: string): RouteChange =>
      routeChange({
        useCase: 'agent',
        modelFacts: { provider: 'hosted', model, type: 'dense' },
        exposedCaps: ['chat', 'stream', 'tool_call'],
      });
    expect(governedUseCasesOf(twoRoutes, stage([agentOnto('claude')]), probe)).toEqual(['chat']);
    expect(governedUseCasesOf(twoRoutes, stage([agentOnto('gpt-5')]), probe)).toEqual([
      'chat',
      'agent',
    ]);

    // An unassign is NOT a departure: the unbind runs after every route plan,
    // so the sibling's route is still bound when the join is gated. (agent is
    // Firn's run path and can never be unassigned; the sibling routes planning.)
    const planRole: ModelProjection = { ...gpt5, role: 'plan-role', routedUseCases: ['planning'] };
    const withPlanning: DraftBaseProjection = {
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'planning', role: 'plan-role' },
      ],
      models: [modelRow({ routedUseCases: ['chat'] }), planRole],
    };
    expect(
      governedUseCasesOf(
        withPlanning,
        stage([{ kind: 'route-unassign', useCase: 'planning' }]),
        probeRouteChange('chat', planRole)
      )
    ).toEqual(['chat', 'planning']);
  });

  it('keeps every use case a fork source still serves once one of its routes leaves', () => {
    // pair-role routes planning AND summarize on gpt-5: forking planning away
    // leaves pair-role's Defaults bound to BOTH until the binds phase, so
    // chat joining gpt-5 still gates on everything pair-role still serves.
    const gpt5 = byRole('agent-role');
    const pairRole: ModelProjection = {
      ...gpt5,
      role: 'pair-role',
      routedUseCases: ['planning', 'summarize'],
    };
    const forked: DraftBaseProjection = {
      routes: [
        { useCase: 'planning', role: 'pair-role' },
        { useCase: 'summarize', role: 'pair-role' },
        { useCase: 'chat', role: 'chat-role' },
      ],
      models: [pairRole, modelRow({ routedUseCases: ['chat'] })],
    };
    const planningAway = routeChange({
      useCase: 'planning',
      modelFacts: { provider: 'hosted', model: 'claude', type: 'dense' },
      exposedCaps: ['chat', 'stream', 'tool_call'],
    });
    expect(
      governedUseCasesOf(forked, stage([planningAway]), probeRouteChange('chat', pairRole))
    ).toEqual(['chat', 'planning', 'summarize']);
  });

  it('keeps a route the draft moves off a role it reaches only as a fallback', () => {
    // routedUseCases is fallback-inclusive: agent reaches judge-role through
    // agent-role's chain. Retargeting agent rewrites (or forks) agent-role, its
    // OWN role; judge-role stays on gpt-5, still on agent's chain, so agent
    // still gates a join there.
    const gpt5 = byRole('agent-role');
    const judge: ModelProjection = { ...gpt5, role: 'judge-role', modelName: 'gpt-5' };
    const viaFallback: DraftBaseProjection = {
      routes: [
        { useCase: 'agent', role: 'agent-role' },
        { useCase: 'chat', role: 'chat-role' },
      ],
      models: [
        { ...gpt5, modelName: 'claude-opus' },
        modelRow({ routedUseCases: ['chat'] }),
        judge,
      ],
    };
    const agentAway = routeChange({
      useCase: 'agent',
      modelFacts: { provider: 'hosted', model: 'claude', type: 'dense' },
      exposedCaps: ['chat', 'stream', 'tool_call'],
    });
    expect(
      governedUseCasesOf(viaFallback, stage([agentAway]), probeRouteChange('chat', judge))
    ).toEqual(['chat', 'agent']);
  });
});

describe('retargetOf', () => {
  const chatRole = modelRow({ role: 'chat-role', routedUseCases: ['chat'] });
  const base: DraftBaseProjection = {
    routes: [{ useCase: 'chat', role: 'chat-role' }],
    models: [chatRole],
  };

  it('returns the route for a single-use-case role moved to another selector', () => {
    const away = routeChange({
      useCase: 'chat',
      modelFacts: { provider: 'hosted', model: 'claude', type: 'dense' },
    });
    expect(retargetOf(base, stagedRoutes([away]), chatRole)).toBe(away);
  });

  it('returns undefined for a fork source routing more than one use case', () => {
    const pairRole = modelRow({ role: 'pair-role', routedUseCases: ['chat', 'summarize'] });
    const forkBase: DraftBaseProjection = {
      routes: [
        { useCase: 'chat', role: 'pair-role' },
        { useCase: 'summarize', role: 'pair-role' },
      ],
      models: [pairRole],
    };
    const away = routeChange({
      useCase: 'chat',
      modelFacts: { provider: 'hosted', model: 'claude', type: 'dense' },
    });
    expect(retargetOf(forkBase, stagedRoutes([away]), pairRole)).toBeUndefined();
  });

  it('returns undefined for a route staying on the same selector', () => {
    const sameSelector = routeChange({
      useCase: 'chat',
      modelFacts: { provider: chatRole.provider, model: chatRole.modelName, type: chatRole.type },
      thinkMode: 'always',
    });
    expect(retargetOf(base, stagedRoutes([sameSelector]), chatRole)).toBeUndefined();
  });
});
