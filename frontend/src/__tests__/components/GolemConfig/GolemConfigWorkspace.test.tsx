import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';

jest.mock('../../../wails/bindings', () => ({
  ReloadGolemSettings: jest.fn(),
  PrepareGolemDestinationGrants: jest.fn(),
}));
import { PrepareGolemDestinationGrants, ReloadGolemSettings } from '../../../wails/bindings';

const testRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const model = (over: Record<string, unknown> = {}) => ({
  role: 'agent-m',
  modelName: 'qwen3-coder-30b',
  provider: 'llama-swap',
  type: 'dense',
  effectiveCapabilities: ['chat', 'stream', 'tool_call'],
  capabilityFacts: {
    caps: ['chat', 'stream', 'tool_call'],
    knownCaps: ['chat', 'generate', 'stream', 'embed', 'tool_call', 'thinking', 'insert'],
  },
  exposedCapabilities: ['chat', 'stream', 'tool_call'],
  thinkMode: 'auto',
  routedUseCases: ['agent'],
  hasThinkTags: false,
  hasSlots: false,
  removable: false,
  ...over,
});

const readyProjection = {
  state: 'ready',
  sourceOrigin: 'user_config',
  revision: testRevision,
  readOnly: false,
  editable: true,
  routes: [{ useCase: 'agent', role: 'agent-m' }],
  models: [model()],
  providers: [
    {
      name: 'llama-swap',
      endpoint: 'http://127.0.0.1:9292/v1',
      classification: 'local',
      apiFormat: 'openai-compat',
      credentialState: 'none',
    },
  ],
  diagnostics: [],
};

const emptyProjection = (state: string, sourceOrigin: string) => ({
  state,
  sourceOrigin,
  readOnly: false,
  editable: false,
  routes: [],
  models: [],
  providers: [],
  diagnostics: [],
});

const resolve = (projection: unknown, busy = false) =>
  (ReloadGolemSettings as jest.Mock).mockResolvedValue({ busy, projection });

// jsdom resolves no CSS from a module, so the one honest guard for a purely
// visual rule is the stylesheet itself. Keith rejected the left-only accent bar
// on rounded surfaces; severity now reads through a full border, and nothing
// should quietly reintroduce a one-sided rule.
describe('GolemConfig stylesheet', () => {
  const css = () =>
    fs.readFileSync(
      path.resolve(__dirname, '../../../components/GolemConfig/GolemConfig.module.css'),
      'utf8'
    );

  it('carries no left-only accent bars', () => {
    // The 3px bar down one rounded edge is the treatment Keith rejected. A 1px
    // hairline dividing two halves of a grid is structure, not an accent, so
    // the guard names the signature rather than banning the property.
    expect(css()).not.toMatch(/border-left(-color)?:\s*(3px|var\(--(accent|status|palette))/);
  });

  // Each tone owns the whole outline in a full-strength semantic colour. A
  // dimmed or partial treatment is what made three intents look alike.
  it.each([
    ['info', '--accent'],
    ['caution', '--status-warning'],
    ['blocking', '--palette-red'],
  ])('gives the %s tone the %s outline on every notice surface', (tone, token) => {
    const rule = css().match(new RegExp(`\\[data-tone='${tone}'\\][^}]*}`, 's'));
    expect(rule?.[0]).toContain(`border-color: var(${token})`);
    for (const surface of ['notice', 'disclosure', 'panel', 'rowDiagnostic', 'diagnostic']) {
      expect(css()).toContain(`.${surface}[data-tone='${tone}']`);
    }
  });

  // The old boolean is gone: a non-blocking diagnostic is a caution, not a
  // neutral aside, so every surface reads through the one tone vocabulary.
  it('no longer styles anything through the blocking boolean', () => {
    expect(css()).not.toContain('data-blocking');
  });

  // The open editor's masthead (the expanded strip): its own surface step, the
  // use case promoted, the metadata demoted, the live state in accent. Whether
  // the contrast READS is Keith's call — this pins that the knobs exist.
  it('elevates the expanded strip into a masthead band', () => {
    expect(css()).toMatch(
      /\.strip\[data-expanded\] \{[^}]*background-color: var\(--surface-hover\)/s
    );
    expect(css()).toMatch(/\.strip\[data-expanded\] \.useCase \{[^}]*font-size: 13px/s);
    expect(css()).toMatch(/\.strip\[data-expanded\] \.value \{[^}]*color: var\(--text-muted\)/s);
    expect(css()).toMatch(/\.strip\[data-expanded\] \.status \{[^}]*color: var\(--accent\)/s);
  });

  // One control box for every single-line field, on the BASE class: a
  // min-height let a select's intrinsic metrics beat the input beside it (the
  // band provider select, then the API-format select), so the height is
  // explicit and the select draws its own caret. A per-row copy of the rule
  // is the drift this pins against.
  it('normalizes selects and inputs to one explicit control box', () => {
    const input = css().match(/^\.input \{[^}]*\}/m)?.[0] ?? '';
    expect(input).toMatch(/height: 30px/);
    expect(input).not.toMatch(/min-height/);

    const select = css().match(/^select\.input \{[^}]*\}/m)?.[0] ?? '';
    expect(select).toMatch(/appearance: none/);
  });

  it('the configuration menu panel can never outgrow its pane', () => {
    const text = css();
    const panel = text.match(/\.menuPanel\s*\{[^}]*\}/)?.[0] ?? '';
    // Viewport-relative clamp (the trigger, not the masthead, is the
    // positioned ancestor now, so a percentage can no longer reach the pane
    // width) and no fixed floor: a 200px pane, at 100% or 200% zoom, always
    // fits the panel, because the vw term shrinks along with it.
    expect(panel).toContain('max-width: min(320px, calc(100vw - 32px))');
    expect(panel).not.toMatch(/min-width:\s*[1-9]/);
  });
});

describe('GolemConfigWorkspace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolve(readyProjection);
  });

  it('loads once on mount and renders the masthead verdict, source, and revision', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // Queried by test id, not by the `banner` role: the real surface renders
    // inside the shell's <main>, where a <header> is a section header.
    const masthead = await screen.findByTestId('golem-config-masthead');
    expect(within(masthead).getByRole('heading', { name: 'Golem Configuration' })).toBeVisible();
    expect(within(masthead).getByText('Ready')).toBeInTheDocument();
    expect(within(masthead).getByText('User configuration directory')).toBeInTheDocument();
    expect(within(masthead).getByText(`rev ${testRevision.slice(0, 12)}`)).toHaveAttribute(
      'title',
      testRevision
    );
    expect(ReloadGolemSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * Spec I15: the approval action is PERMANENT. Nothing probes for missing
   * destinations on mount and no runtime event tells this surface when the set
   * changes, so the action cannot appear conditionally — it is always there,
   * and every click asks afresh.
   */
  it('always offers the destination approval action', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // Before the first load lands there is nothing to approve against yet, so
    // the action is present and waiting rather than absent.
    const action = screen.getByRole('button', { name: 'Approve missing destinations' });
    expect(action).toBeInTheDocument();
    expect(action).toBeDisabled();

    await screen.findByTestId('provider-row-llama-swap');
    expect(screen.getByRole('button', { name: 'Approve missing destinations' })).toBeEnabled();
    // A permanent action asks nothing on its own.
    expect(PrepareGolemDestinationGrants).not.toHaveBeenCalled();
  });

  it('keeps the approval action on a configuration that could not load', async () => {
    (ReloadGolemSettings as jest.Mock).mockRejectedValue('no service');
    render(<GolemConfigWorkspace onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Retry' });
    expect(
      screen.getByRole('button', { name: 'Approve missing destinations' })
    ).toBeInTheDocument();
  });

  it('moves focus to the heading when the tab opens', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByRole('heading', { name: 'Golem Configuration' });
    expect(screen.getByRole('heading', { name: 'Golem Configuration' })).toHaveFocus();
  });

  it('renders a provider strip with endpoint, classification, format, and key state', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('provider-row-llama-swap');
    expect(within(row).getByText('llama-swap')).toBeInTheDocument();
    expect(within(row).getByText('http://127.0.0.1:9292/v1')).toBeInTheDocument();
    expect(within(row).getByText('Local')).toBeInTheDocument();
    expect(within(row).getByText('openai-compat')).toBeInTheDocument();
    expect(within(row).getByText('No key')).toBeInTheDocument();
  });

  it('renders a routing strip joining the use case to its model and provider', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('route-row-agent');
    expect(within(row).getByText('agent')).toBeInTheDocument();
    expect(within(row).getByText('llama-swap')).toBeInTheDocument();
    expect(within(row).getByText('qwen3-coder-30b')).toBeInTheDocument();
    expect(within(row).getByText('auto')).toBeInTheDocument();
    expect(within(row).getByText('Ready')).toBeInTheDocument();
  });

  it('gives every strip a row boundary and names each column inside it', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const providerRow = await screen.findByTestId('provider-row-llama-swap');
    const providers = screen.getByRole('list', { name: 'Providers' });
    expect(within(providers).getAllByRole('listitem')).toEqual([providerRow]);
    for (const column of ['Provider', 'Endpoint', 'Type', 'API key']) {
      expect(within(providerRow).getByText(column)).toBeInTheDocument();
    }

    const routeRow = screen.getByTestId('route-row-agent');
    const routes = screen.getByRole('list', { name: 'Model routing' });
    // §4.1: the rows are Firn's known use cases plus the authored ones, so a
    // known use case with no route is an offer rather than an omission.
    expect(within(routes).getAllByRole('listitem')).toEqual([
      routeRow,
      screen.getByTestId('route-row-chat'),
      screen.getByTestId('route-row-embedding'),
      screen.getByTestId('route-row-planning'),
    ]);
    for (const column of ['Use case', 'Provider', 'Model', 'Think', 'Status']) {
      expect(within(routeRow).getByText(column)).toBeInTheDocument();
    }

    // The visible header row is decorative, so the per-cell labels are the only
    // column names the accessibility tree carries — no double announcement.
    expect(providers.previousElementSibling).toHaveAttribute('aria-hidden', 'true');
    expect(routes.previousElementSibling).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps meaningful placeholder copy off the disabled-contrast class', async () => {
    resolve({
      ...readyProjection,
      routes: [
        { useCase: 'agent', role: 'agent-m' },
        { useCase: 'embedding', role: 'ghost' },
      ],
      providers: [
        {
          name: 'llama-swap',
          endpoint: '',
          classification: 'unknown',
          apiFormat: 'openai-compat',
          credentialState: 'none',
        },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // `.absent` is --text-disabled (2.50:1 on the strip) and is reserved for the
    // bare em-dash. Both of these are the reader's only lead on what is wrong,
    // so they must sit on a class that clears the §4.7 floor.
    const providerRow = await screen.findByTestId('provider-row-llama-swap');
    expect(within(providerRow).getByText('no endpoint')).toHaveClass('value');

    const routeRow = screen.getByTestId('route-row-embedding');
    expect(within(routeRow).getByText('role ghost has no model')).toHaveClass('value');
  });

  it('marks a route with no resolvable model as No model', async () => {
    resolve({
      ...readyProjection,
      routes: [
        { useCase: 'agent', role: 'agent-m' },
        { useCase: 'embedding', role: 'ghost' },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('route-row-embedding');
    expect(within(row).getByText('No model')).toBeInTheDocument();
  });

  it('marks a route whose exposed capabilities miss the use-case floor as Incompatible', async () => {
    resolve({
      ...readyProjection,
      models: [model({ exposedCapabilities: ['chat', 'stream'] })],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('route-row-agent');
    expect(within(row).getByText('Incompatible')).toBeInTheDocument();
  });

  it('lists defined models that no use case routes to', async () => {
    resolve({
      ...readyProjection,
      models: [
        model(),
        model({
          role: 'spare',
          modelName: 'nomic-embed',
          routedUseCases: [],
          exposedCapabilities: ['embed'],
          thinkMode: '',
        }),
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('defined-model-row-spare');
    expect(within(row).getByText('nomic-embed')).toBeInTheDocument();
    expect(screen.getByText('Defined models')).toBeInTheDocument();
    expect(screen.queryByTestId('defined-model-row-agent-m')).not.toBeInTheDocument();
  });

  it('names each section prerequisite while the configuration is Missing', async () => {
    resolve({
      ...emptyProjection('missing', 'none'),
      diagnostics: [{ code: 'config_missing', subjectKind: '', subjectName: '', blocking: true }],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    expect(await screen.findByText(/Add a provider first/)).toBeInTheDocument();
    expect(screen.getByText(/Add a provider, then assign a model/)).toBeInTheDocument();
    expect(screen.getByText('No models.json was found at any discovery location.')).toBeVisible();
  });

  it('explains that editing is unavailable while Limited', async () => {
    resolve({
      ...readyProjection,
      state: 'limited',
      readOnly: true,
      diagnostics: [
        { code: 'duplicate_keys', subjectKind: 'provider', subjectName: 'hosted', blocking: false },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    expect(
      await screen.findByText(/Editing is unavailable while this configuration is Limited/)
    ).toBeInTheDocument();
    // Limited keeps the runtime entities visible.
    expect(screen.getByTestId('provider-row-llama-swap')).toBeInTheDocument();
    expect(
      screen.getByText(/Duplicate JSON keys make this configuration read-only\./)
    ).toBeInTheDocument();
    expect(screen.getByText('provider hosted')).toBeInTheDocument();
  });

  it('explains that editing is unavailable while Invalid and offers Refresh', async () => {
    resolve({
      ...emptyProjection('invalid', 'env'),
      diagnostics: [{ code: 'json_invalid', subjectKind: '', subjectName: '', blocking: true }],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    expect(
      await screen.findByText(/Editing is unavailable: this configuration could not be loaded/)
    ).toBeInTheDocument();
    expect(screen.getByText('The configuration file is not valid JSON.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('names the diagnostic subject by kind, never by name alone', async () => {
    resolve({
      ...readyProjection,
      // Transport order is blocking, then code, then subject kind and name.
      diagnostics: [
        {
          code: 'agent_capabilities_insufficient',
          subjectKind: 'use_case',
          subjectName: 'agent',
          blocking: true,
        },
        {
          code: 'provider_endpoint_unsupported',
          subjectKind: 'provider',
          subjectName: 'agent',
          blocking: true,
        },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // The provider named `agent` has no row here, so its diagnostic stays on
    // the page and must carry its kind. The use case DOES have a row, and
    // §4.3 puts its diagnostic there — which is the same disambiguation by a
    // different route: neither reader ever sees a bare "agent".
    expect(await screen.findByText('provider agent')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('route-row-agent')).getByText(
        'The agent model must support chat, stream, and tool_call.'
      )
    ).toBeInTheDocument();
  });

  it('shows the busy notice for an explicit Refresh only', async () => {
    resolve(readyProjection, true);
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');
    expect(screen.queryByText(/Golem is busy/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Golem is busy/)).toHaveAttribute('role', 'status');
  });

  it('announces the state verdict in a live region', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');
    // #284 gave RoutingCard its own persistent `role="status"` region, so a
    // plain `getByRole('status')` is ambiguous here — matched by content
    // instead, the way the neighboring "Golem is busy" assertion above does.
    expect(
      screen.getByText('Configuration Ready. Source User configuration directory.')
    ).toHaveAttribute('role', 'status');
  });

  it('disables Refresh while a load is in flight', async () => {
    let settle!: (value: unknown) => void;
    (ReloadGolemSettings as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((r) => {
          settle = r;
        })
    );
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    expect(refresh).toBeDisabled();

    settle({ busy: false, projection: readyProjection });
    await screen.findByTestId('provider-row-llama-swap');
    expect(refresh).toBeEnabled();
  });

  it('closes an open editor while Refresh owns the surface', async () => {
    let settle!: (value: unknown) => void;
    (ReloadGolemSettings as jest.Mock)
      .mockResolvedValueOnce({ busy: false, projection: readyProjection })
      .mockImplementationOnce(
        () =>
          new Promise((resolveReload) => {
            settle = resolveReload;
          })
      );
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');
    await userEvent.click(screen.getByRole('button', { name: 'Edit provider llama-swap' }));
    expect(screen.getByLabelText('Endpoint')).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit provider llama-swap' })
    ).not.toBeInTheDocument();

    settle({
      busy: false,
      projection: { ...readyProjection, revision: 'f'.repeat(64) },
    });
    await screen.findByText(`rev ${'f'.repeat(12)}`);
    expect(screen.getByRole('button', { name: 'Edit provider llama-swap' })).toBeEnabled();
  });

  it('drops a response that lands after unmount', async () => {
    let settle!: (value: unknown) => void;
    (ReloadGolemSettings as jest.Mock).mockImplementation(
      () =>
        new Promise((r) => {
          settle = r;
        })
    );
    const { unmount } = render(<GolemConfigWorkspace onClose={() => {}} />);
    unmount();
    settle({ busy: false, projection: readyProjection });
    await waitFor(() => expect(ReloadGolemSettings).toHaveBeenCalledTimes(1));
  });

  it('offers a bounded message and Retry when the call is rejected', async () => {
    (ReloadGolemSettings as jest.Mock).mockRejectedValue('Golem is unavailable.');
    render(<GolemConfigWorkspace onClose={() => {}} />);

    expect(await screen.findByText('Golem is unavailable.')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });

    resolve(readyProjection);
    await userEvent.click(retry);
    expect(await screen.findByTestId('provider-row-llama-swap')).toBeInTheDocument();
  });

  it('turns a malformed payload into the fixed contract error', async () => {
    resolve({ state: 'weird' });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    expect(await screen.findByText('Golem returned an unexpected response.')).toBeInTheDocument();
  });

  it('closes through the masthead Close action', async () => {
    const onClose = jest.fn();
    render(<GolemConfigWorkspace onClose={onClose} />);
    await screen.findByTestId('provider-row-llama-swap');

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders no draft bar until something is staged', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');

    // The editors themselves are Task 8's and are present; what a clean draft
    // must not show is the Apply/Discard surface over an empty change set.
    expect(screen.getByRole('button', { name: 'Edit provider llama-swap' })).toBeInTheDocument();
    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
  });
});
