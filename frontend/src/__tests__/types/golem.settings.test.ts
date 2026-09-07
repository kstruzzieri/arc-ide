import fs from 'fs';
import path from 'path';
import {
  parseSettingsProjection,
  parseSettingsReloadResult,
  GolemContractError,
  type SettingsProjection,
} from '../../types/golem';

const validProjection = (): Record<string, unknown> => ({
  state: 'ready',
  sourceOrigin: 'user_config',
  revision: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  readOnly: false,
  editable: true,
  routes: [
    { useCase: 'agent', role: 'agent-m' },
    { useCase: 'chat', role: 'agent-m' },
  ],
  models: [
    {
      role: 'agent-m',
      modelName: 'wire-model',
      provider: 'hosted',
      type: 'dense',
      parameters: '7b',
      contextWindow: 32768,
      dimensions: 1536,
      effectiveCapabilities: ['chat', 'stream', 'tool_call'],
      capabilityFacts: {
        caps: ['chat', 'stream', 'tool_call'],
        knownCaps: ['chat', 'generate', 'stream', 'embed', 'tool_call', 'thinking', 'insert'],
      },
      exposedCapabilities: ['chat', 'stream', 'tool_call'],
      thinkMode: '',
      routedUseCases: ['agent', 'chat'],
      hasThinkTags: false,
      hasSlots: false,
      removable: false,
    },
  ],
  providers: [
    {
      name: 'hosted',
      endpoint: 'https://api.example.com:8443/v1',
      classification: 'remote',
      apiFormat: 'openai-compat',
      credentialState: 'available',
    },
  ],
  diagnostics: [],
});

type SettingsDiagnosticMappingCase = {
  input: string;
  output: string;
  keepSubject: boolean;
  blocking: boolean;
};

const settingsDiagnosticMappingCases = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../internal/ai/testdata/settings_diagnostic_mapping.json'),
    'utf8'
  )
) as SettingsDiagnosticMappingCase[];

describe('parseSettingsProjection', () => {
  it('accepts a full valid projection', () => {
    const p: SettingsProjection = parseSettingsProjection(validProjection());
    expect(p.state).toBe('ready');
    expect(p.providers[0].classification).toBe('remote');
  });

  it.each([
    [
      'unknown state',
      (v: Record<string, unknown>) => {
        v.state = 'weird';
      },
    ],
    [
      'unknown sourceOrigin',
      (v: Record<string, unknown>) => {
        v.sourceOrigin = 'somewhere';
      },
    ],
    [
      'null collections',
      (v: Record<string, unknown>) => {
        v.routes = null;
      },
    ],
    [
      'missing collections',
      (v: Record<string, unknown>) => {
        delete v.diagnostics;
      },
    ],
    [
      'null nested capabilities',
      (v: Record<string, unknown>) => {
        (v.models as Record<string, unknown>[])[0].effectiveCapabilities = null;
      },
    ],
    [
      'missing nested key',
      (v: Record<string, unknown>) => {
        delete (v.routes as Record<string, unknown>[])[0].useCase;
      },
    ],
    [
      'unknown classification',
      (v: Record<string, unknown>) => {
        (v.providers as Record<string, unknown>[])[0].classification = 'lan';
      },
    ],
    [
      'unknown credentialState',
      (v: Record<string, unknown>) => {
        (v.providers as Record<string, unknown>[])[0].credentialState = 'maybe';
      },
    ],
    [
      'unknown capability',
      (v: Record<string, unknown>) => {
        (v.models as Record<string, unknown>[])[0].effectiveCapabilities = ['chat', 'telepathy'];
      },
    ],
    [
      'eight capabilities',
      (v: Record<string, unknown>) => {
        (v.models as Record<string, unknown>[])[0].effectiveCapabilities = [
          'chat',
          'chat',
          'chat',
          'chat',
          'chat',
          'chat',
          'chat',
          'chat',
        ];
      },
    ],
    [
      'unknown diagnostic code',
      (v: Record<string, unknown>) => {
        v.diagnostics = [{ code: 'future_code', subjectKind: '', subjectName: '', blocking: true }];
      },
    ],
    [
      'empty provider name',
      (v: Record<string, unknown>) => {
        (v.providers as Record<string, unknown>[])[0].name = '';
      },
    ],
    [
      'oversized routes',
      (v: Record<string, unknown>) => {
        v.routes = Array.from({ length: 257 }, (_, i) => ({ useCase: `u${i}`, role: 'r' }));
      },
    ],
    [
      'oversized endpoint',
      (v: Record<string, unknown>) => {
        (v.providers as Record<string, unknown>[])[0].endpoint = `http://h/${'a'.repeat(1024)}`;
      },
    ],
    [
      'non-ASCII endpoint host',
      (v: Record<string, unknown>) => {
        (v.providers as Record<string, unknown>[])[0].endpoint = 'http://ex\u0430mple.com';
      },
    ],
    [
      'identifier over byte bound via multibyte',
      (v: Record<string, unknown>) => {
        (v.routes as Record<string, unknown>[])[0].role = 'é'.repeat(129); // 258 UTF-8 bytes
      },
    ],
    [
      'unknown top-level key',
      (v: Record<string, unknown>) => {
        v.extra = 1;
      },
    ],
    [
      'unknown provider key',
      (v: Record<string, unknown>) => {
        (v.providers as Record<string, unknown>[])[0].timeout = 5;
      },
    ],
    [
      'a missing hidden-fact flag',
      (v: Record<string, unknown>) => {
        delete (v.models as Record<string, unknown>[])[0].hasThinkTags;
      },
    ],
    [
      'a non-boolean hidden-fact flag',
      (v: Record<string, unknown>) => {
        (v.models as Record<string, unknown>[])[0].hasSlots = 'true';
      },
    ],
    [
      'a capability outside knownCaps',
      (v: Record<string, unknown>) => {
        const model = (v.models as Record<string, unknown>[])[0];
        model.capabilityFacts = { caps: ['chat'], knownCaps: ['chat', 'stream'] };
        model.effectiveCapabilities = ['chat'];
        model.exposedCapabilities = ['chat', 'embed'];
      },
    ],
    [
      'bidi override in an identifier',
      (v: Record<string, unknown>) => {
        (v.routes as Record<string, unknown>[])[0].role = 'agent\u202Em'; // RLO
      },
    ],
    [
      'control character in an identifier',
      (v: Record<string, unknown>) => {
        (v.providers as Record<string, unknown>[])[0].name = 'lo\u0007cal'; // BEL
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const value = validProjection();
    mutate(value);
    expect(() => parseSettingsProjection(value)).toThrow(GolemContractError);
  });

  it('rejects empty route and model identities', () => {
    const value = validProjection();
    (value.routes as Record<string, unknown>[])[0].useCase = '';
    (value.routes as Record<string, unknown>[])[0].role = '';
    (value.models as Record<string, unknown>[])[0].role = '';
    expect(() => parseSettingsProjection(value)).toThrow(GolemContractError);
  });

  it('accepts an identifier at exactly 256 bytes, multibyte included', () => {
    const value = validProjection();
    (value.routes as Record<string, unknown>[])[0].role = 'é'.repeat(128); // 256 UTF-8 bytes
    expect(() => parseSettingsProjection(value)).not.toThrow();
  });

  it('accepts 257 unique diagnostics and rejects 258', () => {
    const makeDiagnostics = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        code: 'provider_endpoint_unsupported',
        subjectKind: 'provider',
        subjectName: `p${index.toString().padStart(3, '0')}`,
        blocking: false,
      }));
    const at = validProjection();
    at.diagnostics = makeDiagnostics(257);
    expect(() => parseSettingsProjection(at)).not.toThrow();
    const over = validProjection();
    over.diagnostics = makeDiagnostics(258);
    expect(() => parseSettingsProjection(over)).toThrow(GolemContractError);
  });

  it('treats empty collections as empty arrays', () => {
    const value = { ...validProjection(), routes: [], models: [], providers: [], diagnostics: [] };
    expect(parseSettingsProjection(value).routes).toEqual([]);
  });
});

describe('settings diagnostic mapping contract', () => {
  it('contains 31 pinned upstream codes plus the unknown-future case', () => {
    expect(settingsDiagnosticMappingCases).toHaveLength(32);
    expect(settingsDiagnosticMappingCases.at(-1)?.input).toBe('certified_future_code');
    expect(new Set(settingsDiagnosticMappingCases.map(({ input }) => input)).size).toBe(32);
    // The role-lifecycle slice (#462) took the upstream vocabulary from 27 to
    // 31; all four action codes fail closed onto config_invalid at load.
    for (const code of [
      'role_exists',
      'role_in_use',
      'use_case_not_found',
      'drop_confirmation_required',
    ]) {
      expect(settingsDiagnosticMappingCases.find((row) => row.input === code)?.output).toBe(
        'config_invalid'
      );
    }
  });

  it.each(settingsDiagnosticMappingCases)(
    '$input maps to a parseable $output diagnostic',
    ({ output, keepSubject, blocking }) => {
      const projection = validProjection();
      projection.diagnostics = [
        {
          code: output,
          subjectKind: keepSubject ? 'provider' : '',
          subjectName: keepSubject ? 'p1' : '',
          blocking,
        },
      ];
      expect(() => parseSettingsProjection(projection)).not.toThrow();
    }
  );

  it('accepts use_case and the Firn-owned identifier notice', () => {
    const projection = validProjection();
    projection.diagnostics = [
      { code: 'defaults_invalid', subjectKind: 'use_case', subjectName: 'agent', blocking: true },
      { code: 'identifier_not_editable', subjectKind: '', subjectName: '', blocking: false },
    ];
    expect(() => parseSettingsProjection(projection)).not.toThrow();
  });
});

describe('parseSettingsReloadResult', () => {
  it('accepts busy + projection', () => {
    const r = parseSettingsReloadResult({ busy: true, projection: validProjection() });
    expect(r.busy).toBe(true);
  });
  it('rejects a missing projection', () => {
    expect(() => parseSettingsReloadResult({ busy: false })).toThrow(GolemContractError);
  });
  it('rejects a non-boolean busy', () => {
    expect(() => parseSettingsReloadResult({ busy: 'yes', projection: validProjection() })).toThrow(
      GolemContractError
    );
  });
  it('rejects an unknown key', () => {
    expect(() =>
      parseSettingsReloadResult({ busy: false, projection: validProjection(), extra: true })
    ).toThrow(GolemContractError);
  });
});

describe('cross-language contract corpus', () => {
  const corpusDir = path.resolve(__dirname, '../../../../internal/ai/testdata/settings_contract');
  const files = fs.readdirSync(corpusDir).filter((f) => f.endsWith('.json'));
  it('corpus exists', () => {
    expect(files.length).toBeGreaterThanOrEqual(100);
  });
  it.each(files)('%s parses to its recorded verdict', (file) => {
    const entry = JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8')) as {
      verdict: string;
      projection: unknown;
    };
    if (entry.verdict !== 'accept' && entry.verdict !== 'reject') {
      throw new Error(`${file}: unknown verdict ${JSON.stringify(entry.verdict)}`);
    }
    if (entry.verdict === 'accept') {
      expect(() => parseSettingsProjection(entry.projection)).not.toThrow();
    } else {
      expect(() => parseSettingsProjection(entry.projection)).toThrow(GolemContractError);
    }
  });
});
