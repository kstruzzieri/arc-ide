import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  RoutingCard,
  routeRowKey,
  routeUseCases,
  type RoutingCardProps,
} from '../../../components/GolemConfig/RoutingCard';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';
import {
  buildApplyRequest,
  cleanDraft,
  projectDraft,
  stageChange,
  KeyVault,
  type Change,
  type RouteChange,
} from '../../../types/golemConfig';
import {
  CAPABILITY_NAMES,
  type ModelProjection,
  type ProviderProjection,
} from '../../../types/golem';

jest.mock('../../../wails/bindings', () => ({
  ReloadGolemSettings: jest.fn(),
}));
import { ReloadGolemSettings } from '../../../wails/bindings';

const testRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const model = (over: Partial<ModelProjection> = {}): ModelProjection => ({
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

/** A second model on the same provider, so a retarget has somewhere to go. */
const other = model({
  role: 'other-role',
  modelName: 'gpt-5',
  effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
  capabilityFacts: {
    caps: ['chat', 'stream', 'tool_call', 'thinking'],
    knownCaps: [...CAPABILITY_NAMES],
  },
  exposedCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
  routedUseCases: [],
  removable: true,
});

const providerRow = (over: Partial<ProviderProjection> = {}): ProviderProjection => ({
  name: 'hosted',
  endpoint: 'https://api.example.com/v1',
  classification: 'remote',
  apiFormat: 'openai-compat',
  credentialState: 'available',
  ...over,
});

const vault = () => new KeyVault(new Map());
const draftWith = (...changes: Change[]) =>
  changes.reduce((draft, change) => stageChange(draft, change, vault()), cleanDraft(testRevision));

function renderRouting(over: Partial<RoutingCardProps> = {}) {
  const onStage = jest.fn();
  const onUnstagedChange = jest.fn();
  const routes = over.routes ?? [{ useCase: 'chat', role: 'chat-role' }];
  const models = over.models ?? [model(), other];
  const draft = over.draft ?? cleanDraft(testRevision);
  const props: RoutingCardProps = {
    routes,
    models,
    providers: [providerRow()],
    draft,
    // Exactly what the workspace hands over: the COALESCED changes, so every
    // test below exercises the same values Apply would send.
    changes: projectDraft({ routes, models }, draft).changes,
    rows: new Map(),
    roleRows: new Map(),
    diagnostics: [],
    editable: true,
    onStage,
    onUnstagedChange,
    ...over,
  };
  const view = render(<RoutingCard {...props} />);
  return { ...view, onStage, onUnstagedChange };
}

const openRoute = async (useCase: string, label = 'Edit') =>
  await userEvent.click(screen.getByRole('button', { name: `${label} route ${useCase}` }));

const stage = async () => await userEvent.click(screen.getByRole('button', { name: 'Done' }));

/** Choose a model card in the band. Card text is name + type + facts, so the
 *  card is found by its NAME node rather than its whole accessible name. */
async function pickModel(name: string) {
  const card = within(screen.getByRole('listbox', { name: /Models/ }))
    .getAllByRole('option')
    .find((option) => within(option).queryByText(name) !== null);
  if (card === undefined) throw new Error(`no model card named ${name}`);
  await userEvent.click(card);
}

/** The declare path: type a name nothing matches, then take the declare card. */
async function declareModel(name: string) {
  await userEvent.clear(screen.getByLabelText('Filter models'));
  await userEvent.type(screen.getByLabelText('Filter models'), name);
  await userEvent.click(screen.getByRole('option', { name: new RegExp(`Declare "${name}"`) }));
}

const routeCells = (useCase: string) => screen.getByTestId(`route-row-${useCase}`);

// ---------------------------------------------------------------------------
// The rows themselves.
// ---------------------------------------------------------------------------

describe('RoutingCard rows', () => {
  it('renders one row per known-or-authored use case', () => {
    expect(routeUseCases([{ useCase: 'summarize', role: 'chat-role' }])).toEqual([
      'agent',
      'chat',
      'embedding',
      'planning',
      'summarize',
    ]);

    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [model({ routedUseCases: ['chat', 'summarize'] })],
    });

    for (const useCase of ['agent', 'chat', 'embedding', 'planning', 'summarize']) {
      expect(routeCells(useCase)).toBeInTheDocument();
    }
    // A known use case with no route is an offer, not a defect.
    expect(within(routeCells('agent')).getByText('No model')).toBeInTheDocument();
    expect(within(routeCells('chat')).getByText('Ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign route embedding' })).toBeInTheDocument();
  });

  it('reads an applied model that misses its floor as Incompatible', () => {
    renderRouting({
      routes: [{ useCase: 'agent', role: 'chat-role' }],
      models: [model({ routedUseCases: ['agent'] })],
    });
    expect(within(routeCells('agent')).getByText('Incompatible')).toBeInTheDocument();
  });

  it('shows the staged model and marks the row Modified before Apply', () => {
    renderRouting({
      draft: draftWith({
        kind: 'route',
        useCase: 'chat',
        modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
        capabilityFacts: { caps: ['chat', 'stream'], knownCaps: [...CAPABILITY_NAMES] },
        exposedCaps: ['chat', 'stream'],
        thinkMode: '',
        confirmUnknown: false,
      }),
      rows: new Map([['chat', { modified: true, keyStaged: false, needsReview: false }]]),
    });

    const row = routeCells('chat');
    expect(within(row).getByText('gpt-5')).toBeInTheDocument();
    expect(within(row).getByText('Modified')).toBeInTheDocument();
  });

  it('marks every populated row Modified while the source is not the applied document', () => {
    renderRouting({ draft: { ...cleanDraft(testRevision), source: { kind: 'blank' } } });
    expect(within(routeCells('chat')).getByText('Modified')).toBeInTheDocument();
    // No model still takes precedence over the source-derived Modified.
    expect(within(routeCells('agent')).getByText('No model')).toBeInTheDocument();
  });

  it('prefers Needs review over Modified', () => {
    renderRouting({
      rows: new Map([['chat', { modified: true, keyStaged: false, needsReview: true }]]),
    });
    expect(within(routeCells('chat')).getByText('Needs review')).toBeInTheDocument();
  });

  it('renders a use-case diagnostic inside the row that owns it', () => {
    renderRouting({
      diagnostics: [
        {
          code: 'eligibility_ineligible',
          subjectKind: 'use_case',
          subjectName: 'chat',
          blocking: true,
        },
      ],
    });
    const text = 'This model does not meet every affected use-case requirement.';
    // [C6] A row-owned diagnostic is a sibling detail row in the row's rowgroup.
    expect(within(routeCells('chat').parentElement!).getByText(text)).toBeInTheDocument();
    expect(within(routeCells('agent')).queryByText(text)).not.toBeInTheDocument();
  });

  it('offers no editing controls while the configuration is not editable', () => {
    renderRouting({ editable: false });
    expect(screen.queryByRole('button', { name: /route chat/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Defined models: fallback-aware routedUseCases and removable.
// ---------------------------------------------------------------------------

describe('RoutingCard defined models', () => {
  it('lists only unrouted models and offers Remove only for removable ones', () => {
    renderRouting({
      models: [
        model(),
        // Reached only through another role's fallback chain: routed, so it is
        // not a defined-model row at all.
        model({ role: 'fallback-role', modelName: 'fallback-m', routedUseCases: ['chat'] }),
        // Unrouted but still referenced as a fallback target: not removable.
        model({ role: 'orphan-role', modelName: 'orphan-m', routedUseCases: [], removable: false }),
        other,
      ],
    });

    expect(screen.queryByTestId('defined-model-row-fallback-role')).not.toBeInTheDocument();
    expect(screen.getByTestId('defined-model-row-orphan-role')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('defined-model-row-orphan-role')).queryByRole('button')
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove model role other-role' })
    ).toBeInTheDocument();
  });

  it('stages a guarded role removal', async () => {
    const { onStage } = renderRouting();
    await userEvent.click(screen.getByRole('button', { name: 'Remove model role other-role' }));
    expect(onStage).toHaveBeenCalledWith([{ kind: 'role-remove', role: 'other-role' }], []);
  });

  it('marks a role staged for removal Modified', () => {
    renderRouting({
      roleRows: new Map([['other-role', { modified: true, keyStaged: false, needsReview: false }]]),
    });
    expect(
      within(screen.getByTestId('defined-model-row-other-role')).getByText('Modified')
    ).toBeInTheDocument();
  });

  // The same reading order the dock's Models cards and the picker use: provider
  // groups in the providers list's order, role-alpha within each.
  it('groups the defined models by provider, role-alpha within', () => {
    const unrouted = (role: string, provider: string) =>
      model({ role, provider, routedUseCases: [], removable: false });
    renderRouting({
      routes: [],
      // Transport order: ascending by role, so the providers interleave.
      models: [
        unrouted('a-hosted', 'hosted'),
        unrouted('a-local', 'zeta-local'),
        unrouted('b-hosted', 'hosted'),
        unrouted('b-local', 'zeta-local'),
      ],
      providers: [providerRow(), providerRow({ name: 'zeta-local' })],
    });

    const defined = screen.getByRole('table', { name: 'Defined models' });
    expect(
      within(defined)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.getAttribute('data-testid'))
    ).toEqual([
      'defined-model-row-a-hosted',
      'defined-model-row-b-hosted',
      'defined-model-row-a-local',
      'defined-model-row-b-local',
    ]);
  });

  // Re-pressing Remove would only re-stage the identity it already holds, so a
  // staged removal swaps the control for its undo.
  it('offers the staged removal an undo instead of a re-stage', async () => {
    const { onStage } = renderRouting({
      roleRows: new Map([['other-role', { modified: true, keyStaged: false, needsReview: false }]]),
    });
    expect(
      screen.queryByRole('button', { name: 'Remove model role other-role' })
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Unstage removal of model role other-role' })
    );
    expect(onStage).toHaveBeenCalledWith([], ['role:other-role']);
  });
});

// ---------------------------------------------------------------------------
// The route editor.
// ---------------------------------------------------------------------------

describe('RouteEditor', () => {
  it('expands the row into a native fieldset seeded from the applied route', async () => {
    renderRouting();
    const edit = screen.getByRole('button', { name: 'Edit route chat' });
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(edit);
    // [C6] Re-query: expanding wrapped the row in a rowgroup keyed differently,
    // so the node captured above is detached.
    expect(screen.getByRole('button', { name: 'Edit route chat' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    const editor = screen.getByRole('group', { name: 'Route chat' });
    expect(within(editor).getByLabelText('Provider')).toHaveValue('hosted');
    expect(
      within(editor)
        .getByRole('listbox', { name: /Models/ })
        .querySelector('[aria-selected="true"]')
    ).toHaveTextContent('gpt-5-mini');
    const caps = within(editor).getByRole('group', {
      name: 'Capabilities exposed to chat — from gpt-5-mini',
    });
    // A locked box names WHY it is locked (v9 renders `required` beside it).
    expect(within(caps).getByLabelText('chat required')).toBeChecked();
    expect(within(caps).getByLabelText('chat required')).toBeDisabled();
    expect(within(caps).getByLabelText('insert')).not.toBeChecked();
  });

  it('stages a retarget of a role no other use case shares', async () => {
    const { onStage } = renderRouting();
    await openRoute('chat');
    expect(screen.queryByText(/also governs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/keeps? using the current model/i)).not.toBeInTheDocument();

    await pickModel('gpt-5');
    await stage();

    // `other` exposes exactly what it declares — no selector override exists —
    // so this is §4.5's "declared caps arrive checked" case, and the seed is
    // the full declared set.
    expect(onStage).toHaveBeenCalledWith(
      [
        {
          kind: 'route',
          useCase: 'chat',
          modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
          capabilityFacts: {
            caps: ['chat', 'stream', 'tool_call', 'thinking'],
            knownCaps: [...CAPABILITY_NAMES],
          },
          exposedCaps: ['chat', 'stream', 'tool_call', 'thinking'],
          thinkMode: '',
          confirmUnknown: false,
        },
      ],
      []
    );
  });

  it('paints the row and seeds the editor from the coalesced change, not the raw staging', async () => {
    const routes = [
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'summarize', role: 'summarize-role' },
    ];
    const models = [
      model(),
      model({
        role: 'summarize-role',
        modelName: 'gpt-5',
        effectiveCapabilities: ['chat', 'stream', 'thinking'],
        capabilityFacts: { caps: ['chat', 'stream', 'thinking'], knownCaps: [...CAPABILITY_NAMES] },
        exposedCapabilities: ['chat', 'stream', 'thinking'],
        thinkMode: 'auto',
        routedUseCases: ['summarize'],
      }),
    ];
    const modelFacts = { provider: 'hosted', model: 'gpt-5', type: 'dense' as const };
    const capabilityFacts = {
      caps: ['chat', 'stream', 'thinking'] as const,
      knownCaps: [...CAPABILITY_NAMES],
    };
    // Two use cases staged onto ONE selector with differing selector-scoped
    // fields. §3.3 rebuilds the group from its LAST authority, so `chat`'s own
    // staging is not what Apply sends.
    const draft = draftWith(
      {
        kind: 'route',
        useCase: 'chat',
        modelFacts,
        capabilityFacts: { ...capabilityFacts, caps: [...capabilityFacts.caps] },
        exposedCaps: ['chat', 'stream', 'thinking'],
        thinkMode: 'auto',
        confirmUnknown: true,
      },
      {
        kind: 'route',
        useCase: 'summarize',
        modelFacts,
        capabilityFacts: { ...capabilityFacts, caps: [...capabilityFacts.caps] },
        exposedCaps: ['chat', 'stream'],
        thinkMode: '',
        confirmUnknown: true,
      }
    );

    renderRouting({ routes, models, draft });

    // The row paints the authority's think mode, not the one chat was staged with.
    const row = routeCells('chat');
    expect(within(row).getByText('gpt-5')).toBeInTheDocument();
    expect(within(row).queryByText('auto')).not.toBeInTheDocument();
    expect(within(row).getByText('—')).toBeInTheDocument();

    // The reopened editor agrees with the row.
    await openRoute('chat');
    const caps = screen.getByRole('group', {
      name: 'Capabilities exposed to chat — from gpt-5',
    });
    expect(within(caps).getByLabelText('thinking')).not.toBeChecked();
    expect(screen.queryByLabelText('Think mode')).not.toBeInTheDocument();

    // …and so does the request.
    const request = buildApplyRequest({ routes, models }, draft, vault(), 'apply');
    const staged = request.changes.find(
      (change): change is RouteChange => change.kind === 'route' && change.useCase === 'chat'
    );
    expect(staged?.exposedCaps).toEqual(['chat', 'stream']);
    expect(staged?.thinkMode).toBe('');
  });

  it('seeds a retarget from the selector persisted exposure, not the declared set', async () => {
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'summarize-role' },
      ],
      models: [
        model(),
        model({
          role: 'summarize-role',
          modelName: 'gpt-5',
          // Declares four capabilities…
          effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
          capabilityFacts: {
            caps: ['chat', 'stream', 'tool_call', 'thinking'],
            knownCaps: [...CAPABILITY_NAMES],
          },
          // …but the selector override `summarize` authored exposes two.
          exposedCapabilities: ['chat', 'stream'],
          routedUseCases: ['summarize'],
        }),
      ],
    });
    await openRoute('chat');
    await pickModel('gpt-5');

    const caps = screen.getByRole('group', {
      name: 'Capabilities exposed to chat — from gpt-5',
    });
    expect(within(caps).getByLabelText('chat required')).toBeChecked();
    expect(within(caps).getByLabelText('chat required')).toBeDisabled();
    expect(within(caps).getByLabelText('tool_call')).not.toBeChecked();
    expect(within(caps).getByLabelText('thinking')).not.toBeChecked();

    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();
    // Staging must not re-widen what `summarize` narrowed: the override is
    // selector-wide, so a wider set here would rewrite the sibling's contract.
    expect(onStage.mock.calls[0][0][0].exposedCaps).toEqual(['chat', 'stream']);
  });

  it('discloses that a shared role forks and leaves its siblings alone', async () => {
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [model({ routedUseCases: ['chat', 'summarize'] }), other],
    });
    await openRoute('chat');
    expect(screen.getByText('This model also serves summarize.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Choosing a different model here changes chat only; summarize keeps using the current model.'
      )
    ).toBeInTheDocument();
  });

  // The verb has to agree with the list, or a careful notice reads as machine
  // output: "chat also uses" but "chat and completion also use".
  it('agrees the disclosure verbs with more than one sibling', async () => {
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
        { useCase: 'completion', role: 'chat-role' },
      ],
      models: [model({ routedUseCases: ['chat', 'completion', 'summarize'] }), other],
    });
    await openRoute('chat');

    expect(
      screen.getByText('This model also serves completion and summarize.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Choosing a different model here changes chat only; completion and summarize keep using the current model.'
      )
    ).toBeInTheDocument();
  });

  // The coupling surfaces BEFORE the editor opens: a neutral strip marker
  // derived from the same `routedUseCases` the in-editor notice reads, so the
  // two can never disagree.
  it('marks a strip whose model also serves other routes, naming them on hover', () => {
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
        { useCase: 'completion', role: 'chat-role' },
      ],
      models: [model({ routedUseCases: ['chat', 'completion', 'summarize'] }), other],
    });

    const marker = within(routeCells('chat')).getByText('shared with 2 others');
    expect(marker).toHaveAttribute('title', 'completion, summarize');
    // The sibling rows carry their own markers, each naming its own others.
    expect(within(routeCells('summarize')).getByText('shared with 2 others')).toHaveAttribute(
      'title',
      'chat, completion'
    );
  });

  it('agrees the marker with a single sibling and marks nothing when unshared', () => {
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [model({ routedUseCases: ['chat', 'summarize'] }), other],
    });
    expect(within(routeCells('chat')).getByText('shared with 1 other')).toHaveAttribute(
      'title',
      'summarize'
    );
    // agent resolves to nothing here, and nothing else is shared.
    expect(within(routeCells('agent')).queryByText(/shared with/)).not.toBeInTheDocument();
  });

  it('yields the marker to the editor notice while the row is open', async () => {
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [model({ routedUseCases: ['chat', 'summarize'] }), other],
    });
    expect(within(routeCells('chat')).getByText('shared with 1 other')).toBeInTheDocument();

    await openRoute('chat');
    // One coupling, told once: the marker hides and the info notice names the
    // same sibling the marker's title named.
    expect(within(routeCells('chat')).queryByText(/shared with 1 other/)).not.toBeInTheDocument();
    expect(screen.getByText('This model also serves summarize.')).toBeInTheDocument();
  });

  it('suppresses the marker while a staged retarget paints a different model', () => {
    // chat and summarize share chat-role; chat is staged onto gpt-5. The
    // collapsed chat row paints the STAGED model, and the coupling belongs to
    // the model being replaced — describing gpt-5 with the old model's marker
    // would lie. The unstaged sibling keeps its marker.
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [model({ routedUseCases: ['chat', 'summarize'] }), other],
      draft: draftWith({
        kind: 'route',
        useCase: 'chat',
        modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
        capabilityFacts: {
          caps: ['chat', 'stream', 'tool_call', 'thinking'],
          knownCaps: [...CAPABILITY_NAMES],
        },
        exposedCaps: ['chat', 'stream'],
        thinkMode: '',
        confirmUnknown: true,
      }),
    });

    const row = routeCells('chat');
    expect(within(row).getByText('gpt-5')).toBeInTheDocument();
    expect(within(row).queryByText(/shared with/)).not.toBeInTheDocument();
    expect(within(routeCells('summarize')).getByText('shared with 1 other')).toBeInTheDocument();
  });

  it('discloses the selector-wide reach of the change from the projected draft', async () => {
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [
        model(),
        model({
          role: 'agent-role',
          modelName: 'gpt-5',
          effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
          capabilityFacts: {
            caps: ['chat', 'stream', 'tool_call', 'thinking'],
            knownCaps: [...CAPABILITY_NAMES],
          },
          exposedCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
          routedUseCases: ['agent'],
        }),
      ],
    });
    await openRoute('chat');
    // Staging chat onto the agent's selector makes the capability edit govern
    // the agent route too.
    await pickModel('gpt-5');
    expect(
      screen.getByText(/agent uses this same model, so these changes apply/)
    ).toBeInTheDocument();
  });

  it('requires the unknown-requirement acknowledgement and sets confirmUnknown', async () => {
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'summarize-role' },
      ],
      models: [
        model(),
        model({ role: 'summarize-role', modelName: 'gpt-5', routedUseCases: ['summarize'] }),
      ],
    });
    await openRoute('chat');
    await pickModel('gpt-5');

    expect(
      screen.getByText(/no capability requirements on record for summarize/)
    ).toBeInTheDocument();
    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/requirements are unknown/i);

    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();
    const staged = onStage.mock.calls[0][0][0];
    expect(staged.confirmUnknown).toBe(true);
    // The reducer owns the exact set; the editor supplies the acknowledgement.
    expect(staged.confirmUnknownUseCases).toBeUndefined();
  });

  it('stages a capability and think-mode override, hiding Think until thinking is exposed', async () => {
    const { onStage } = renderRouting({
      models: [
        model({
          effectiveCapabilities: ['chat', 'stream', 'thinking'],
          capabilityFacts: {
            caps: ['chat', 'stream', 'thinking'],
            knownCaps: [...CAPABILITY_NAMES],
          },
          exposedCapabilities: ['chat', 'stream', 'thinking'],
          thinkMode: 'auto',
        }),
      ],
    });
    await openRoute('chat');

    expect(screen.getByLabelText('Think mode')).toHaveValue('auto');
    await userEvent.click(screen.getByLabelText('thinking'));
    expect(screen.queryByLabelText('Think mode')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('thinking'));
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'toggle');
    await stage();

    const staged = onStage.mock.calls[0][0][0];
    expect(staged.exposedCaps).toEqual(['chat', 'stream', 'thinking']);
    expect(staged.thinkMode).toBe('toggle');
  });

  it('drops the think mode with the capability that justified it', async () => {
    const { onStage } = renderRouting({
      models: [
        model({
          effectiveCapabilities: ['chat', 'stream', 'thinking'],
          capabilityFacts: {
            caps: ['chat', 'stream', 'thinking'],
            knownCaps: [...CAPABILITY_NAMES],
          },
          exposedCapabilities: ['chat', 'stream', 'thinking'],
          thinkMode: 'auto',
        }),
      ],
    });
    await openRoute('chat');
    await userEvent.click(screen.getByLabelText('thinking'));
    await stage();

    const staged = onStage.mock.calls[0][0][0];
    expect(staged.exposedCaps).toEqual(['chat', 'stream']);
    expect(staged.thinkMode).toBe('');
  });

  it('offers Unassign for an optional route and never for the agent', async () => {
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'agent', role: 'agent-role' },
        { useCase: 'chat', role: 'chat-role' },
      ],
      models: [
        model(),
        model({
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
      ],
    });

    await openRoute('agent');
    expect(screen.queryByRole('button', { name: 'Unassign' })).not.toBeInTheDocument();
    await openRoute('agent'); // collapse

    await openRoute('chat');
    await userEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    expect(onStage).toHaveBeenCalledWith([{ kind: 'route-unassign', useCase: 'chat' }], []);
  });

  it('offers no Unassign for a use case that is not bound yet', async () => {
    renderRouting();
    await openRoute('embedding', 'Assign');
    expect(screen.queryByRole('button', { name: 'Unassign' })).not.toBeInTheDocument();
  });

  // v9's editor header is the row strip itself. A visible legend would sit in
  // the fieldset's border line, cutting it and reserving a gap across the top;
  // the accessible name still has to be there, so it is visually hidden.
  // The native box is drawn by the browser and desaturates the accent, so the
  // real input is transparent and a span is drawn in its place. The input has
  // to stay in the DOM, checkable and labelled.
  it('draws its own capability indicator over a real, labelled input', async () => {
    renderRouting();
    await openRoute('chat');
    const box = screen.getByLabelText('chat required');

    expect(box).toBeChecked();
    expect(box).toHaveClass('checkboxInput');
    expect(box.nextElementSibling).toHaveClass('checkboxBox');
    // Decorative: the input alone carries the state to assistive tech.
    expect(box.nextElementSibling).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the fieldset name out of the border line', async () => {
    renderRouting();
    await openRoute('chat');
    const editor = screen.getByRole('group', { name: 'Route chat' });
    const legend = editor.querySelector('legend');
    expect(legend).toHaveTextContent('Route chat');
    expect(legend).toHaveClass('srOnly');
  });

  it('assigns a new role from complete manual facts and requires the type', async () => {
    const { onStage } = renderRouting({ providers: [providerRow(), providerRow({ name: 'lan' })] });
    await openRoute('embedding', 'Assign');

    // Nothing is chosen yet, so there is nothing to stage.
    await stage();
    expect(screen.getByRole('alert')).toHaveTextContent(/Choose a provider/);

    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'hosted');
    // The declare card carries the typed name into the facts editor.
    await declareModel('nomic-embed');
    await stage();
    expect(screen.getByRole('alert')).toHaveTextContent(/model type is required/i);
    expect(onStage).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText('Type'), 'embedding');
    await stage();

    expect(onStage).toHaveBeenCalledWith(
      [
        {
          kind: 'route',
          useCase: 'embedding',
          modelFacts: { provider: 'hosted', model: 'nomic-embed', type: 'embedding' },
          // A manual declaration is authoritative: the checked set over the
          // full vocabulary, with no unknown capability fact to confirm.
          capabilityFacts: { caps: ['embed'], knownCaps: [...CAPABILITY_NAMES] },
          exposedCaps: ['embed'],
          thinkMode: '',
          confirmUnknown: false,
        },
      ],
      []
    );
  });

  it('refuses a manual model name that is not a safe identifier', async () => {
    const { onStage } = renderRouting();
    await openRoute('embedding', 'Assign');
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'hosted');
    await declareModel('hand-rolled');
    await userEvent.type(screen.getByLabelText('Model name'), 'a‮b');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'dense');
    await stage();

    expect(screen.getByRole('alert')).toHaveTextContent('A model entry is invalid.');
    expect(onStage).not.toHaveBeenCalled();
  });

  it('reverts unstaged fields on Cancel and releases the Apply gate', async () => {
    const { onStage, onUnstagedChange } = renderRouting();
    await openRoute('chat');
    await pickModel('gpt-5');
    expect(onUnstagedChange).toHaveBeenLastCalledWith(routeRowKey('chat'), true);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onUnstagedChange).toHaveBeenLastCalledWith(routeRowKey('chat'), false);
    expect(onStage).not.toHaveBeenCalled();

    await openRoute('chat');
    expect(
      within(screen.getByRole('listbox', { name: /Models/ })).getByRole('option', {
        selected: true,
      })
    ).toHaveTextContent('gpt-5-mini');
  });

  // Three notices stack under this editor and they mean three different things.
  // A shared neutral outline made them indistinguishable; each now carries its
  // own semantic tone, and no two intents share one look.
  it('tones each disclosure by what it actually means', async () => {
    const shared = model({ routedUseCases: ['chat', 'summarize'], hasThinkTags: true });
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'chat-role' },
      ],
      models: [shared, other],
    });
    await openRoute('chat');

    // A fact about the fork: nothing is asked of the reader.
    const sharedRole = screen.getByText(/This model also serves/).closest('div');
    expect(sharedRole).toHaveAttribute('data-tone', 'info');

    // Retargeting reaches the sibling use case and drops authored fields.
    await pickModel('gpt-5');
    expect(screen.getByText(/belong to the model itself/).closest('div')).toHaveAttribute(
      'data-tone',
      'caution'
    );
    expect(screen.getByText(/no capability requirements on record/).closest('div')).toHaveAttribute(
      'data-tone',
      'caution'
    );
    expect(screen.getByText(/set up by hand/).closest('div')).toHaveAttribute(
      'data-tone',
      'blocking'
    );

    // The acknowledgements inside those notices use the drawn indicator too.
    const ack = screen.getByLabelText('Apply anyway');
    expect(ack).toHaveClass('checkboxInput');
    expect(ack.nextElementSibling).toHaveClass('checkboxBox');
  });

  it('reopens on the values already staged, not the applied ones', async () => {
    renderRouting({
      draft: draftWith({
        kind: 'route',
        useCase: 'chat',
        modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
        capabilityFacts: { caps: ['chat', 'stream'], knownCaps: [...CAPABILITY_NAMES] },
        exposedCaps: ['chat', 'stream'],
        thinkMode: '',
        confirmUnknown: false,
      }),
    });
    await openRoute('chat');
    expect(
      within(screen.getByRole('listbox', { name: /Models/ })).getByRole('option', {
        selected: true,
      })
    ).toHaveTextContent('gpt-5');
  });
});

// ---------------------------------------------------------------------------
// Amendment 13: the inline hidden-field drop acknowledgement.
// ---------------------------------------------------------------------------

describe('RouteEditor drop acknowledgement', () => {
  const withHiddenFields = {
    models: [model({ hasThinkTags: true, hasSlots: true }), other],
  };

  it('pre-sets the drop confirmations from the acknowledgement', async () => {
    const { onStage } = renderRouting(withHiddenFields);
    await openRoute('chat');
    expect(screen.queryByText(/set up by hand/)).not.toBeInTheDocument();

    await pickModel('gpt-5');
    expect(
      screen.getByText(/custom think tags and slot configuration set up by hand/)
    ).toBeInTheDocument();

    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/confirm what this change removes/i);

    await userEvent.click(screen.getByLabelText('Remove them and continue'));
    await stage();
    expect(onStage.mock.calls[0][0][0].confirmDrops).toEqual(['slots', 'think_tags']);
  });

  it('names think tags alone when that is the only hidden fact', async () => {
    const { onStage } = renderRouting({ models: [model({ hasThinkTags: true }), other] });
    await openRoute('chat');
    await pickModel('gpt-5');
    expect(screen.getByText(/custom think tags set up by hand/)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Remove them and continue'));
    await stage();
    expect(onStage.mock.calls[0][0][0].confirmDrops).toEqual(['think_tags']);
  });

  it('names slots alone when that is the only hidden fact', async () => {
    const { onStage } = renderRouting({ models: [model({ hasSlots: true }), other] });
    await openRoute('chat');
    await pickModel('gpt-5');
    expect(screen.getByText(/slot configuration set up by hand/)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Remove them and continue'));
    await stage();
    expect(onStage.mock.calls[0][0][0].confirmDrops).toEqual(['slots']);
  });

  it('shows no notice when both hidden-field facts are false', async () => {
    const { onStage } = renderRouting();
    await openRoute('chat');
    await pickModel('gpt-5');

    expect(screen.queryByText(/set up by hand/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remove them and continue')).not.toBeInTheDocument();

    await stage();
    // Nothing is dropped, so a stale confirmation must not be sent at all.
    expect(onStage.mock.calls[0][0][0].confirmDrops).toBeUndefined();
  });

  it('shows no notice while the selector is unchanged, because nothing is dropped', async () => {
    renderRouting(withHiddenFields);
    await openRoute('chat');
    // Re-selecting the same model is a selector override, not a retarget.
    await pickModel('gpt-5-mini');
    await userEvent.click(screen.getByLabelText('generate'));
    expect(screen.queryByText(/set up by hand/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The workspace wiring.
// ---------------------------------------------------------------------------

describe('GolemConfigWorkspace route editing', () => {
  const readyProjection = {
    state: 'ready',
    sourceOrigin: 'user_config',
    revision: testRevision,
    readOnly: false,
    editable: true,
    routes: [{ useCase: 'chat', role: 'chat-role' }],
    models: [model(), other],
    providers: [providerRow()],
    diagnostics: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
  });

  it('counts a staged route and marks its row, holding Apply while fields are unstaged', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('route-row-chat');

    await openRoute('chat');
    await pickModel('gpt-5');
    await stage();
    expect(screen.getByText('1 change waiting for Apply')).toBeInTheDocument();
    expect(
      screen.queryByText(/Apply is unavailable while an editor has unstaged changes/)
    ).not.toBeInTheDocument();

    // #284: Done on success now closes the editor, so making a further edit
    // on the same route means reopening it first.
    await openRoute('chat');
    // An edit made after staging is what closes the global Apply gate (§4.2).
    await userEvent.click(screen.getByLabelText('insert'));
    expect(
      screen.getByText(/Apply is unavailable while an editor has unstaged changes/)
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // §4.2: an open row reports only that it is being edited; the collapsed row
    // is where the staged state shows.
    expect(within(screen.getByTestId('route-row-chat')).getByText('Modified')).toBeInTheDocument();
    expect(screen.getByText('1 change waiting for Apply')).toBeInTheDocument();
  });

  it('marks every selector sibling Modified from the projected draft', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: {
        ...readyProjection,
        routes: [
          { useCase: 'chat', role: 'chat-role' },
          { useCase: 'summarize', role: 'chat-role' },
        ],
        models: [model({ routedUseCases: ['chat', 'summarize'] }), other],
      },
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('route-row-chat');

    await openRoute('chat');
    await userEvent.click(screen.getByLabelText('generate'));
    // The override reaches `summarize`, which has no Firn floor, so the
    // acknowledgement is what unlocks the stage.
    await userEvent.click(screen.getByLabelText('Apply anyway'));
    // #284: a successful Done closes the editor itself now — no Cancel
    // needed to collapse it back to its row.
    await stage();

    expect(within(screen.getByTestId('route-row-chat')).getByText('Modified')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('route-row-summarize')).getByText('Modified')
    ).toBeInTheDocument();
  });

  it('repaints a sibling row when a later staging becomes the selector authority', async () => {
    const shared = model({
      role: 'summarize-role',
      modelName: 'gpt-5',
      effectiveCapabilities: ['chat', 'stream', 'thinking'],
      capabilityFacts: { caps: ['chat', 'stream', 'thinking'], knownCaps: [...CAPABILITY_NAMES] },
      exposedCapabilities: ['chat', 'stream', 'thinking'],
      thinkMode: 'auto',
      routedUseCases: ['summarize'],
    });
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: {
        ...readyProjection,
        routes: [
          { useCase: 'chat', role: 'chat-role' },
          { useCase: 'summarize', role: 'summarize-role' },
        ],
        models: [model(), shared],
      },
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('route-row-chat');

    // Stage chat onto the summarize selector, keeping `thinking` and Auto.
    // #284: a successful Done closes the editor itself now — no Cancel
    // needed to collapse it back to its row.
    await openRoute('chat');
    await pickModel('gpt-5');
    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();
    expect(within(screen.getByTestId('route-row-chat')).getByText('auto')).toBeInTheDocument();

    // Now narrow the SAME selector from the summarize row. That staging becomes
    // the group's authority, so chat's row must follow it rather than keep
    // showing the values it was staged with.
    await openRoute('summarize');
    await userEvent.click(screen.getByLabelText('thinking'));
    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();

    expect(
      within(screen.getByTestId('route-row-chat')).queryByText('auto')
    ).not.toBeInTheDocument();
    expect(screen.getByText('2 changes waiting for Apply')).toBeInTheDocument();
  });

  it('keeps a route diagnostic on its row and the rest on the page', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: {
        ...readyProjection,
        diagnostics: [
          {
            code: 'eligibility_unknown',
            subjectKind: 'use_case',
            subjectName: 'chat',
            blocking: false,
          },
          {
            code: 'eligibility_unknown',
            subjectKind: 'use_case',
            subjectName: 'ghost',
            blocking: false,
          },
        ],
      },
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const row = await screen.findByTestId('route-row-chat');

    // [C6] The row-owned diagnostic is a sibling `detailRow` in the row's rowgroup.
    expect(
      within(row.parentElement!).getByText('Model eligibility is still unverified.')
    ).toBeInTheDocument();
    const page = screen.getByRole('list', { name: 'Configuration diagnostics' });
    expect(within(page).getAllByRole('listitem')).toHaveLength(1);
    expect(within(page).getByText('use case ghost')).toBeInTheDocument();
  });
});
