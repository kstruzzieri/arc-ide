import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ProvidersCard,
  type ProvidersCardProps,
} from '../../../components/GolemConfig/ProvidersCard';
import * as ProviderEditorModule from '../../../components/GolemConfig/ProviderEditor';
import { providerChanges } from '../../../components/GolemConfig/ProviderEditor';
import * as RoutingCardModule from '../../../components/GolemConfig/RoutingCard';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';
import { KeyVault, type Change } from '../../../types/golemConfig';
import type { ProviderProjection } from '../../../types/golem';

jest.mock('../../../wails/bindings', () => ({
  ReloadGolemSettings: jest.fn(),
}));
import { ReloadGolemSettings } from '../../../wails/bindings';

const testRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** A second, later document: any other 64-hex CAS token. */
const movedRevision = 'f'.repeat(64);

const provider = (over: Partial<ProviderProjection> = {}): ProviderProjection => ({
  name: 'llama-swap',
  endpoint: 'http://127.0.0.1:9292/v1',
  classification: 'local',
  apiFormat: 'openai-compat',
  credentialState: 'none',
  ...over,
});

const hosted = provider({
  name: 'hosted',
  endpoint: 'https://api.example.com/v1',
  classification: 'remote',
  apiFormat: 'openai-compat',
  credentialState: 'available',
});

function renderCard(over: Partial<ProvidersCardProps> = {}) {
  const keys = new Map<string, string>();
  const onStage = jest.fn();
  const onUnstagedChange = jest.fn();
  const props: ProvidersCardProps = {
    providers: [provider()],
    usedProviders: [],
    changes: [],
    rows: new Map(),
    diagnostics: [],
    vault: new KeyVault(keys),
    editable: true,
    onStage,
    onUnstagedChange,
    ...over,
  };
  const view = render(<ProvidersCard {...props} />);
  return { ...view, keys, onStage, onUnstagedChange };
}

// jsdom ships <dialog> without its modal methods, and the workspace's §4.6a
// confirmation is a real one.
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

const openEditor = async (name = 'llama-swap') =>
  await userEvent.click(screen.getByRole('button', { name: `Edit provider ${name}` }));

const stage = async () => await userEvent.click(screen.getByRole('button', { name: 'Done' }));

/**
 * Records exactly what an editor hands to `onStage`, by delegating to the real
 * component with a wrapped callback. Nothing else can see the change a row
 * produced once the workspace owns the draft.
 */
function captureStagedChanges(): Change[][] {
  const seen: Change[][] = [];
  const real = ProviderEditorModule.ProviderEditor;
  jest.spyOn(ProviderEditorModule, 'ProviderEditor').mockImplementation((props) =>
    real({
      ...props,
      onStage: (changes, drop) => {
        seen.push(changes);
        props.onStage(changes, drop);
      },
    })
  );
  return seen;
}

// ---------------------------------------------------------------------------
// The change builder: what Apply actually receives.
// ---------------------------------------------------------------------------

describe('providerChanges', () => {
  const fields = {
    name: 'llama-swap',
    endpoint: 'http://127.0.0.1:9292/v1',
    apiFormat: 'openai-compat' as const,
    keyValue: '',
    clearKey: false,
  };

  it('sends only the endpoint when only the endpoint changed', () => {
    expect(
      providerChanges(provider(), { ...fields, endpoint: 'http://127.0.0.1:8080/v1' })
    ).toEqual({
      changes: [
        { kind: 'provider-update', name: 'llama-swap', endpoint: 'http://127.0.0.1:8080/v1' },
      ],
      drop: ['provider-key:llama-swap'],
    });
  });

  it('sends only the API format when only the format changed', () => {
    expect(providerChanges(provider(), { ...fields, apiFormat: 'ollama' })).toEqual({
      changes: [{ kind: 'provider-update', name: 'llama-swap', apiFormat: 'ollama' }],
      drop: ['provider-key:llama-swap'],
    });
  });

  it('stages nothing and drops both identities when no field changed', () => {
    expect(providerChanges(provider(), fields)).toEqual({
      changes: [],
      drop: ['provider:llama-swap', 'provider-key:llama-swap'],
    });
  });

  it('never drops a key-set already staged: the field is empty after every stage', () => {
    const stagedKey = { kind: 'provider-key-set', name: 'llama-swap' } as const;
    expect(
      providerChanges(provider(), { ...fields, endpoint: 'http://127.0.0.1:8080/v1' }, stagedKey)
    ).toEqual({
      changes: [
        { kind: 'provider-update', name: 'llama-swap', endpoint: 'http://127.0.0.1:8080/v1' },
      ],
      drop: [],
    });
  });

  it('does drop a staged key-clear once the box is unchecked — that IS the revert', () => {
    expect(
      providerChanges(provider(), fields, { kind: 'provider-key-clear', name: 'llama-swap' })
    ).toEqual({
      changes: [],
      drop: ['provider:llama-swap', 'provider-key:llama-swap'],
    });
  });

  it('orders provider-add before its key-set', () => {
    expect(
      providerChanges(null, {
        name: 'hosted',
        endpoint: 'https://api.example.com/v1',
        apiFormat: 'openai-compat',
        keyValue: 'sk-live-value',
        clearKey: false,
      })
    ).toEqual({
      changes: [
        {
          kind: 'provider-add',
          name: 'hosted',
          endpoint: 'https://api.example.com/v1',
          apiFormat: 'openai-compat',
        },
        { kind: 'provider-key-set', name: 'hosted' },
      ],
      drop: [],
    });
  });

  it('keeps the key identity independent of the provider identity', () => {
    expect(providerChanges(provider(), { ...fields, keyValue: 'sk-live-value' })).toEqual({
      changes: [{ kind: 'provider-key-set', name: 'llama-swap' }],
      drop: ['provider:llama-swap'],
    });
  });

  it('stages a key clear on its own identity', () => {
    expect(
      providerChanges(hosted, {
        ...fields,
        name: 'hosted',
        endpoint: hosted.endpoint,
        clearKey: true,
      })
    ).toEqual({
      changes: [{ kind: 'provider-key-clear', name: 'hosted' }],
      drop: ['provider:hosted'],
    });
  });
});

// ---------------------------------------------------------------------------
// The editor surface.
// ---------------------------------------------------------------------------

describe('ProviderEditor', () => {
  it('expands the row into a labelled editor and keeps an existing name immutable', async () => {
    renderCard();
    const edit = screen.getByRole('button', { name: 'Edit provider llama-swap' });
    expect(edit).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(edit);
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    const editor = screen.getByRole('group', { name: 'Edit provider llama-swap' });
    expect(within(editor).queryByLabelText('Provider name')).not.toBeInTheDocument();
    expect(within(editor).getByText(/name cannot be changed/i)).toBeInTheDocument();
    expect(within(editor).getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:9292/v1');
    expect(within(editor).getByLabelText('API format')).toHaveValue('openai-compat');
    expect(within(editor).getByLabelText('New API key')).toHaveAttribute('type', 'password');
  });

  it('stages an update carrying only the field the user changed', async () => {
    const { onStage } = renderCard();
    await openEditor();

    const endpoint = screen.getByLabelText('Endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'http://127.0.0.1:8080/v1');
    await stage();

    expect(onStage).toHaveBeenCalledWith(
      [{ kind: 'provider-update', name: 'llama-swap', endpoint: 'http://127.0.0.1:8080/v1' }],
      ['provider-key:llama-swap']
    );
  });

  it('transfers the key into the vault and clears the input', async () => {
    const { onStage, keys } = renderCard();
    await openEditor();

    await userEvent.type(screen.getByLabelText('New API key'), 'sk-live-value');
    await stage();

    expect(keys.get('llama-swap')).toBe('sk-live-value');
    expect(screen.getByLabelText('New API key')).toHaveValue('');
    expect(onStage).toHaveBeenCalledWith(
      [{ kind: 'provider-key-set', name: 'llama-swap' }],
      ['provider:llama-swap']
    );
  });

  it('never rehydrates a staged key when the row is collapsed and reopened', async () => {
    const { keys } = renderCard();
    await openEditor();
    await userEvent.type(screen.getByLabelText('New API key'), 'sk-live-value');
    await stage();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('New API key')).not.toBeInTheDocument();
    await openEditor();
    expect(screen.getByLabelText('New API key')).toHaveValue('');
    expect(keys.get('llama-swap')).toBe('sk-live-value');
  });

  it('refuses an environment reference at the input before the vault is touched', async () => {
    const { onStage, keys } = renderCard();
    await openEditor();

    const key = screen.getByLabelText('New API key');
    // paste, not type: userEvent reads `{...}` as a key descriptor.
    await userEvent.click(key);
    await userEvent.paste('sk-${OPENAI_KEY}');
    await stage();

    expect(key).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/API keys must be non-empty literal values\./)).toBeInTheDocument();
    expect(key).toHaveAccessibleDescription(/external configuration concern/);
    expect(keys.size).toBe(0);
    expect(onStage).not.toHaveBeenCalled();
  });

  it('refuses a key value over the transport bound before the vault is touched', async () => {
    const { onStage, keys } = renderCard();
    await openEditor();

    const key = screen.getByLabelText('New API key');
    // paste, not type: 4097 keystrokes is pointless and slow.
    await userEvent.click(key);
    await userEvent.paste('k'.repeat(4097));
    await stage();

    expect(key).toHaveAttribute('aria-invalid', 'true');
    expect(keys.size).toBe(0);
    expect(onStage).not.toHaveBeenCalled();
  });

  it('leaves an empty key field as no key operation at all', async () => {
    const { onStage, keys } = renderCard();
    await openEditor();

    const endpoint = screen.getByLabelText('Endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'http://127.0.0.1:8080/v1');
    await stage();

    expect(keys.size).toBe(0);
    expect(onStage.mock.calls[0][0]).toEqual([
      { kind: 'provider-update', name: 'llama-swap', endpoint: 'http://127.0.0.1:8080/v1' },
    ]);
  });

  it('pre-checks the endpoint scheme, leaving the rest to the backend', async () => {
    const { onStage } = renderCard();
    await openEditor();

    const endpoint = screen.getByLabelText('Endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'ftp://127.0.0.1/v1');
    await stage();

    expect(endpoint).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/A provider endpoint is invalid\./)).toBeInTheDocument();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('pre-checks the endpoint for non-ASCII runes', async () => {
    const { onStage } = renderCard();
    await openEditor();

    const endpoint = screen.getByLabelText('Endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'https://прим.example/v1');
    await stage();

    expect(endpoint).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/punycode/)).toBeInTheDocument();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('refuses a colliding provider name with the provider_exists copy', async () => {
    const { onStage } = renderCard({
      changes: [{ kind: 'provider-add', name: 'staged-one', endpoint: 'https://a.example/v1' }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add provider' }));

    const name = screen.getByLabelText('Provider name');
    await userEvent.type(name, 'staged-one');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'https://b.example/v1');
    await stage();

    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('A provider with that name already exists.')).toBeInTheDocument();
    expect(onStage).not.toHaveBeenCalled();

    await userEvent.clear(name);
    await userEvent.type(name, 'llama-swap');
    await stage();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('refuses a provider name that is not a safe identifier', async () => {
    const { onStage } = renderCard();
    await userEvent.click(screen.getByRole('button', { name: 'Add provider' }));

    const name = screen.getByLabelText('Provider name');
    await userEvent.type(name, 'a‮b');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'https://b.example/v1');
    await stage();

    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('A provider name is invalid.')).toBeInTheDocument();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('refuses removal while a model still uses the provider', async () => {
    const { onStage } = renderCard({ usedProviders: ['llama-swap'] });
    await openEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Remove provider' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This provider is still used by a model.');
    expect(onStage).not.toHaveBeenCalled();
  });

  it('stages a removal for a provider no model uses', async () => {
    const { onStage } = renderCard({ usedProviders: ['other'] });
    await openEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Remove provider' }));
    expect(onStage).toHaveBeenCalledWith(
      [{ kind: 'provider-remove', name: 'llama-swap' }],
      ['provider-key:llama-swap']
    );
  });

  it('disables key entry for a provider already staged for removal', async () => {
    renderCard({
      changes: [{ kind: 'provider-remove', name: 'llama-swap' }],
      rows: new Map([['llama-swap', { modified: true, keyStaged: false, needsReview: false }]]),
    });
    await openEditor();

    expect(screen.getByLabelText('New API key')).toBeDisabled();
    expect(screen.getByLabelText('Clear the stored API key')).toBeDisabled();
    expect(screen.getByText(/staged for removal/i)).toBeInTheDocument();
  });

  it('reverts unstaged fields on Cancel and releases the Apply gate', async () => {
    const { onStage, onUnstagedChange } = renderCard();
    await openEditor();

    await userEvent.type(screen.getByLabelText('Endpoint'), '-typo');
    expect(onUnstagedChange).toHaveBeenLastCalledWith('llama-swap', true);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onUnstagedChange).toHaveBeenLastCalledWith('llama-swap', false);
    expect(onStage).not.toHaveBeenCalled();

    await openEditor();
    expect(screen.getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:9292/v1');
  });

  it('reopens an editor on the values already staged, not the applied ones', async () => {
    renderCard({
      changes: [
        { kind: 'provider-update', name: 'llama-swap', endpoint: 'http://127.0.0.1:8080/v1' },
      ],
    });
    await openEditor();
    expect(screen.getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:8080/v1');
  });

  it('renders a row-owned diagnostic inside the strip that owns it', async () => {
    renderCard({
      providers: [provider(), hosted],
      diagnostics: [
        { code: 'provider_in_use', subjectKind: 'provider', subjectName: 'hosted', blocking: true },
      ],
    });

    const row = screen.getByTestId('provider-row-hosted');
    expect(within(row).getByText('This provider is still used by a model.')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('provider-row-llama-swap')).queryByText(
        'This provider is still used by a model.'
      )
    ).not.toBeInTheDocument();
  });

  it('shows the staged row markers beside the row', async () => {
    renderCard({
      rows: new Map([['llama-swap', { modified: true, keyStaged: true, needsReview: false }]]),
    });
    const row = screen.getByTestId('provider-row-llama-swap');
    expect(within(row).getByText('Modified')).toBeInTheDocument();
    expect(within(row).getByText('Key staged')).toBeInTheDocument();
  });

  // Same rule as the route editor: the row strip is the header, so the
  // fieldset's name is present for assistive tech and out of the border line.
  it('keeps the fieldset name out of the border line', async () => {
    renderCard();
    await openEditor();
    const editor = screen.getByRole('group', { name: 'Edit provider llama-swap' });
    const legend = editor.querySelector('legend');
    expect(legend).toHaveTextContent('Edit provider llama-swap');
    expect(legend).toHaveClass('srOnly');
  });

  it('offers no editing controls while the configuration is not editable', () => {
    renderCard({ editable: false });
    expect(screen.queryByRole('button', { name: 'Add provider' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit provider llama-swap' })
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The workspace wiring: draft, vault, and the Apply gate.
// ---------------------------------------------------------------------------

describe('GolemConfigWorkspace provider editing', () => {
  const readyProjection = {
    state: 'ready',
    sourceOrigin: 'user_config',
    revision: testRevision,
    readOnly: false,
    editable: true,
    routes: [],
    models: [],
    // The transport orders providers by name; the parser refuses anything else.
    providers: [hosted, provider()],
    diagnostics: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts staged changes and blocks Apply while an editor has unstaged fields', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');

    await openEditor();
    await userEvent.type(screen.getByLabelText('New API key'), 'sk-live-value');
    await stage();
    expect(screen.getByText('1 change waiting for Apply')).toBeInTheDocument();
    expect(screen.queryByText(/unstaged/i)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Endpoint'), '-more');
    expect(
      screen.getByText(/Apply is unavailable while an editor has unstaged changes/)
    ).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByText(/Apply is unavailable while an editor has unstaged changes/)
    ).not.toBeInTheDocument();
    expect(screen.getByText('1 change waiting for Apply')).toBeInTheDocument();
  });

  it('keeps a staged key when the same editor then stages another field', async () => {
    const editor = jest.spyOn(ProviderEditorModule, 'ProviderEditor');
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');

    await openEditor();
    await userEvent.type(screen.getByLabelText('New API key'), 'sk-live-value');
    await stage();
    const vault = editor.mock.calls[0][0].vault;
    expect(vault.has('llama-swap')).toBe(true);

    // The password field is empty again — which must not read as "revert it".
    const endpoint = screen.getByLabelText('Endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'http://127.0.0.1:8080/v1');
    await stage();

    expect(vault.has('llama-swap')).toBe(true);
    expect(screen.getByText('2 changes waiting for Apply')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('provider-row-llama-swap')).getByText('Key staged')
    ).toBeInTheDocument();
  });

  it('re-derives an open editor when Refresh moves the document', async () => {
    const stagedByEditor = captureStagedChanges();
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');

    await openEditor();
    await userEvent.type(screen.getByLabelText('Endpoint'), '-stale');

    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: {
        ...readyProjection,
        revision: movedRevision,
        providers: [hosted, provider({ endpoint: 'http://127.0.0.1:7000/v1' })],
      },
    });
    // The open editor holds unstaged fields, so Refresh is a destructive
    // transition and asks first (§4.6a).
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & reload',
      })
    );
    await screen.findByText('http://127.0.0.1:7000/v1');

    // The editor mounted against the old document is gone, and so is the
    // unstaged value it was holding.
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();

    await openEditor();
    expect(screen.getByLabelText('Endpoint')).toHaveValue('http://127.0.0.1:7000/v1');

    await userEvent.selectOptions(screen.getByLabelText('API format'), 'ollama');
    await stage();
    expect(stagedByEditor).toEqual([
      [{ kind: 'provider-update', name: 'llama-swap', apiFormat: 'ollama' }],
    ]);
  });

  it('marks the row and drops every staged key through the terminal path on Discard', async () => {
    const editor = jest.spyOn(ProviderEditorModule, 'ProviderEditor');
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');

    await openEditor();
    await userEvent.type(screen.getByLabelText('New API key'), 'sk-live-value');
    await stage();

    const vault = editor.mock.calls[0][0].vault;
    expect(vault.has('llama-swap')).toBe(true);
    expect(
      within(screen.getByTestId('provider-row-llama-swap')).getByText('Key staged')
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(vault.has('llama-swap')).toBe(false);
    expect(screen.queryByText('1 change waiting for Apply')).not.toBeInTheDocument();
    // §3.3: a discarded draft also resets the editors it was staged from.
    expect(screen.queryByLabelText('New API key')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('provider-row-llama-swap')).queryByText('Key staged')
    ).not.toBeInTheDocument();
  });

  it('re-renders nothing outside the editor while the API key is typed', async () => {
    const editor = jest.spyOn(ProviderEditorModule, 'ProviderEditor');
    const routing = jest.spyOn(RoutingCardModule, 'RoutingCard');
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');

    await openEditor('llama-swap');
    await openEditor('hosted');
    // The first unstaged keystroke legitimately reaches the root: it is what
    // closes the global Apply gate (§4.2). Everything after it must not.
    await userEvent.type(
      within(screen.getByTestId('provider-row-llama-swap')).getByLabelText('Endpoint'),
      'x'
    );

    const rendersOf = (name: string) =>
      editor.mock.calls.filter(([props]) => props.provider?.name === name).length;
    const before = {
      edited: rendersOf('llama-swap'),
      sibling: rendersOf('hosted'),
      routing: routing.mock.calls.length,
    };

    await userEvent.type(
      within(screen.getByTestId('provider-row-llama-swap')).getByLabelText('New API key'),
      'sk-live'
    );

    expect(rendersOf('llama-swap')).toBeGreaterThan(before.edited);
    expect(rendersOf('hosted')).toBe(before.sibling);
    expect(routing.mock.calls.length).toBe(before.routing);
  });

  it('routes a provider-scoped diagnostic onto its row and leaves the rest on the page', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: {
        ...readyProjection,
        diagnostics: [
          {
            code: 'provider_endpoint_unsupported',
            subjectKind: 'provider',
            subjectName: 'ghost',
            blocking: true,
          },
          {
            code: 'provider_endpoint_unsupported',
            subjectKind: 'provider',
            subjectName: 'hosted',
            blocking: true,
          },
        ],
      },
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('provider-row-hosted');
    expect(
      within(row).getByText('This provider endpoint is not a usable URL.')
    ).toBeInTheDocument();
    const page = screen.getByRole('list', { name: 'Configuration diagnostics' });
    expect(within(page).getAllByRole('listitem')).toHaveLength(1);
    expect(within(page).getByText('provider ghost')).toBeInTheDocument();
  });
});
