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
  const projection = projectDraft({ routes, models }, draft);
  const props: RoutingCardProps = {
    routes,
    models,
    providers: [providerRow()],
    draft,
    // Exactly what the workspace hands over: the COALESCED changes, so every
    // test below exercises the same values Apply would send.
    changes: projection.changes,
    rows: new Map(),
    roleRows: new Map(),
    selectorUseCases: projection.selectorUseCases,
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
    // Every defined row can be assigned; only a removable one offers Remove.
    const orphan = screen.getByTestId('defined-model-row-orphan-role');
    expect(
      within(orphan).getByRole('button', { name: 'Assign… model orphan-m, role orphan-role' })
    ).toBeInTheDocument();
    expect(within(orphan).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
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
    const share = screen.getByText(/share this model/);
    expect(share).toHaveTextContent('chat and summarize share this model.');
    // The names carry the weight: every route named is emphasised, the grammar is not.
    expect([...share.querySelectorAll('strong')].map((node) => node.textContent)).toEqual([
      'chat',
      'summarize',
    ]);
    expect(screen.getByText(/Picking a different model/)).toHaveTextContent(
      'Picking a different model here changes chat only; summarize keeps gpt-5-mini.'
    );
    // A pure fork governs chat alone: summarize stays on its role, so nothing
    // here reaches it and no caution claims otherwise.
    await pickModel('gpt-5');
    expect(screen.queryByText(/not the route/)).not.toBeInTheDocument();
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

    expect(screen.getByText(/share this model/)).toHaveTextContent(
      'chat, completion and summarize share this model.'
    );
    expect(screen.getByText(/Picking a different model/)).toHaveTextContent(
      'Picking a different model here changes chat only; completion and summarize keep gpt-5-mini.'
    );
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
    expect(screen.getByText(/share this model/)).toHaveTextContent(
      'chat and summarize share this model.'
    );
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
    // the agent route too — but chat JOINS that selector, and only an override
    // writes Think selector-wide, so the notice says Think stays on this route.
    await pickModel('gpt-5');
    expect(screen.getByText(/not the route/)).toHaveTextContent(
      'Capabilities are a property of the model, not the route. Changing them here also changes them for agent; Think applies to this route only.'
    );
  });

  it('says Think reaches the selector when the draft already holds an override on it', async () => {
    // agent sits on gpt-5 with no Think, and the draft already stages an OVERRIDE
    // of that route (same facts) that sets one. The reducer coalesces the whole
    // selector group onto its latest change and the backend runs the group's
    // override selector-wide (SetRoleOverrides), so a route JOINING gpt-5 now sets
    // Think for agent too — the notice must say so, not "this route only".
    const agentModel = model({
      role: 'agent-role',
      modelName: 'gpt-5',
      effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      capabilityFacts: {
        caps: ['chat', 'stream', 'tool_call', 'thinking'],
        knownCaps: [...CAPABILITY_NAMES],
      },
      exposedCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      routedUseCases: ['agent'],
    });
    const override: RouteChange = {
      kind: 'route',
      useCase: 'agent',
      modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
      capabilityFacts: agentModel.capabilityFacts,
      exposedCaps: ['chat', 'stream', 'tool_call', 'thinking'],
      thinkMode: 'always',
      confirmUnknown: false,
    };
    const routes = [
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'agent', role: 'agent-role' },
    ];
    const models = [model(), agentModel];
    const { onStage } = renderRouting({ routes, models, draft: draftWith(override) });
    await openRoute('chat');
    await pickModel('gpt-5');
    expect(screen.getByText(/not the route/)).toHaveTextContent(
      'Capabilities and Think are properties of the model, not the route. Changing them here also changes them for agent.'
    );

    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'auto');
    await stage();
    const staged = onStage.mock.calls[0][0][0];
    // What Apply sends: the join is the group's latest change, so its Think is
    // the override's Think too.
    const projected = projectDraft({ routes, models }, draftWith(override, staged));
    expect(
      projected.changes.map((change) => (change.kind === 'route' ? change.thinkMode : change.kind))
    ).toEqual(['auto', 'auto']);
  });

  it('does not count its own earlier staging as the override a reopen replaces', async () => {
    // chat staged an OVERRIDE of its model (same full facts) that sets Think.
    // Reopened, the editor picks the same provider/model under DIFFERENT facts —
    // a retarget, which Done stages in place of the override (`stageChange`
    // replaces the identity). No override is left on the selector then, so
    // Think stays on this route: the notice must not read the replaced change.
    const shared: Pick<
      ModelProjection,
      'effectiveCapabilities' | 'capabilityFacts' | 'exposedCapabilities'
    > = {
      effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      capabilityFacts: {
        caps: ['chat', 'stream', 'tool_call', 'thinking'],
        knownCaps: [...CAPABILITY_NAMES],
      },
      exposedCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
    };
    const routes = [
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'agent', role: 'agent-role' },
    ];
    const models = [
      model({ ...shared, contextWindow: 32768 }),
      model({ ...shared, role: 'agent-role', parameters: '7B', routedUseCases: ['agent'] }),
    ];
    const override: RouteChange = {
      kind: 'route',
      useCase: 'chat',
      modelFacts: { provider: 'hosted', model: 'gpt-5-mini', type: 'dense', contextWindow: 32768 },
      capabilityFacts: shared.capabilityFacts,
      exposedCaps: ['chat', 'stream', 'tool_call', 'thinking'],
      thinkMode: 'always',
      confirmUnknown: false,
    };
    renderRouting({ routes, models, draft: draftWith(override) });
    await openRoute('chat');
    // Two cards share the name; the 7B facts line tells the agent's apart.
    const card = within(screen.getByRole('listbox', { name: /Models/ }))
      .getAllByRole('option')
      .find((option) => within(option).queryByText(/7B/) !== null);
    if (card === undefined) throw new Error('no 7B card');
    await userEvent.click(card);
    expect(screen.getByText(/not the route/)).toHaveTextContent(
      'Capabilities are a property of the model, not the route. Changing them here also changes them for agent; Think applies to this route only.'
    );
  });

  it('says Think reaches every other staged route on the selector, override or not', async () => {
    // planning is already staged onto gpt-5 with Think always; summarize is
    // applied there. The reducer coalesces every staged route on a selector
    // onto the LATEST change, so a chat join makes its Think planning's Think
    // too — while summarize, applied and unstaged, keeps its own without an
    // override. The notice names exactly that split.
    const routes = [
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'planning', role: 'planning-role' },
      { useCase: 'analysis', role: 'analysis-role' },
      { useCase: 'summarize', role: 'other-role' },
    ];
    const models = [
      model(),
      model({ role: 'planning-role', modelName: 'gpt-4', routedUseCases: ['planning'] }),
      model({ role: 'analysis-role', modelName: 'gpt-4', routedUseCases: ['analysis'] }),
      { ...other, routedUseCases: ['summarize'] },
    ];
    const join = (useCase: string): RouteChange => ({
      kind: 'route',
      useCase,
      modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
      capabilityFacts: other.capabilityFacts,
      exposedCaps: ['chat', 'stream', 'tool_call', 'thinking'],
      thinkMode: 'always',
      confirmUnknown: false,
    });
    const { onStage } = renderRouting({
      routes,
      models,
      draft: draftWith(join('planning'), join('analysis')),
    });
    await openRoute('chat');
    await pickModel('gpt-5');
    // Two peers: the clause lists them after this route, one conjunction.
    expect(screen.getByText(/not the route/)).toHaveTextContent(
      'Capabilities are a property of the model, not the route. Changing them here also changes them for analysis, planning and summarize; Think applies to this route, analysis and planning.'
    );

    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'auto');
    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();
    const staged = onStage.mock.calls[0][0][0];
    const projected = projectDraft(
      { routes, models },
      draftWith(join('planning'), join('analysis'), staged)
    );
    expect(
      projected.changes.map((change) => (change.kind === 'route' ? change.thinkMode : change.kind))
    ).toEqual(['auto', 'auto', 'auto']);
  });

  it('names the floor before the empty set when both clauses stand', async () => {
    // A floored route on a model that never met it: unticking the last cap
    // leaves both refusals standing, and Done answers with the one naming what
    // chat is missing — the backend's own clause — not the generic one.
    const { onStage } = renderRouting({
      models: [
        model({
          effectiveCapabilities: ['generate'],
          capabilityFacts: { caps: ['generate'], knownCaps: [...CAPABILITY_NAMES] },
          exposedCapabilities: ['generate'],
        }),
      ],
    });
    await openRoute('chat');
    await userEvent.click(screen.getByLabelText('generate'));
    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/chat needs chat/);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/Tick at least one/);
  });

  it('opens a join on the Think and exposure its selector already carries in the draft', async () => {
    // agent's staged override sets Think always on gpt-5. A chat join coalesces
    // onto whatever Done stages here, so the editor opens on always — a Done
    // that leaves Think alone keeps the override's value instead of wiping it
    // to the applied ''.
    const agentModel = model({
      role: 'agent-role',
      modelName: 'gpt-5',
      effectiveCapabilities: ['chat', 'generate', 'stream', 'tool_call', 'thinking'],
      capabilityFacts: {
        caps: ['chat', 'generate', 'stream', 'tool_call', 'thinking'],
        knownCaps: [...CAPABILITY_NAMES],
      },
      exposedCapabilities: ['chat', 'generate', 'stream', 'tool_call', 'thinking'],
      routedUseCases: ['agent'],
    });
    // The override narrowed the exposure (no generate): the join must open on
    // THAT set, not on the applied five.
    const override: RouteChange = {
      kind: 'route',
      useCase: 'agent',
      modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
      capabilityFacts: agentModel.capabilityFacts,
      exposedCaps: ['chat', 'stream', 'tool_call', 'thinking'],
      thinkMode: 'always',
      confirmUnknown: false,
    };
    const routes = [
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'agent', role: 'agent-role' },
    ];
    const { onStage } = renderRouting({
      routes,
      models: [model(), agentModel],
      draft: draftWith(override),
    });
    await openRoute('chat');
    await pickModel('gpt-5');
    expect(screen.getByLabelText('Think mode')).toHaveValue('always');
    await stage();
    const staged = onStage.mock.calls[0][0][0];
    expect(staged.thinkMode).toBe('always');
    expect(staged.exposedCaps).toEqual(['chat', 'stream', 'tool_call', 'thinking']);
  });

  it('opens an applied route on the Think a staged join already gives its selector', async () => {
    // chat staged a join onto gpt-5 — agent's applied model — with Think auto.
    // Opening agent starts from auto: an untouched Done would otherwise stage
    // agent's applied '' as the group's authority and wipe the join's Think.
    const agentModel = model({
      role: 'agent-role',
      modelName: 'gpt-5',
      effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      capabilityFacts: {
        caps: ['chat', 'stream', 'tool_call', 'thinking'],
        knownCaps: [...CAPABILITY_NAMES],
      },
      exposedCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      routedUseCases: ['agent'],
    });
    const join: RouteChange = {
      kind: 'route',
      useCase: 'chat',
      modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
      capabilityFacts: agentModel.capabilityFacts,
      exposedCaps: ['chat', 'stream', 'tool_call', 'thinking'],
      thinkMode: 'auto',
      confirmUnknown: false,
    };
    const { onUnstagedChange } = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [model(), agentModel],
      draft: draftWith(join),
    });
    await openRoute('agent');
    expect(screen.getByLabelText('Think mode')).toHaveValue('auto');
    // The committed baseline opens on the same values: nothing is unstaged
    // yet, so the Apply gate is not held by merely opening the editor.
    expect(onUnstagedChange).toHaveBeenLastCalledWith(routeRowKey('agent'), false);
  });

  it('re-seeds from its own coalesced staging when a pick returns to that model', async () => {
    // chat staged an override on its model that narrows the exposure and sets
    // Think. Reopened, the user picks another model, then the original again:
    // the checklist and Think come back from the staged change — the group's
    // current values — not from the model's raw declared exposure, which
    // would silently widen the override and drop its Think.
    const current = model({
      effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      capabilityFacts: {
        caps: ['chat', 'stream', 'tool_call', 'thinking'],
        knownCaps: [...CAPABILITY_NAMES],
      },
      exposedCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
    });
    const override: RouteChange = {
      kind: 'route',
      useCase: 'chat',
      modelFacts: { provider: 'hosted', model: 'gpt-5-mini', type: 'dense' },
      capabilityFacts: current.capabilityFacts,
      exposedCaps: ['chat', 'stream', 'thinking'],
      thinkMode: 'toggle',
      confirmUnknown: false,
    };
    renderRouting({ models: [current, other], draft: draftWith(override) });
    await openRoute('chat');
    expect(screen.getByLabelText('Think mode')).toHaveValue('toggle');
    expect(screen.getByLabelText('tool_call')).not.toBeChecked();

    await pickModel('gpt-5');
    expect(screen.getByLabelText('Think mode')).toHaveValue('');
    expect(screen.getByLabelText('tool_call')).toBeChecked();

    await pickModel('gpt-5-mini');
    expect(screen.getByLabelText('Think mode')).toHaveValue('toggle');
    expect(screen.getByLabelText('tool_call')).not.toBeChecked();
    expect(screen.getByLabelText('thinking')).toBeChecked();
  });

  it('refuses a join whose Think differs from what a sibling already sets on the model', async () => {
    const { onStage } = renderRouting({
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
          thinkMode: 'auto',
          routedUseCases: ['agent'],
        }),
      ],
    });
    await openRoute('chat');
    await pickModel('gpt-5');
    expect(screen.getByLabelText('Think mode')).toHaveValue('auto');

    // go-llm refuses the finished document when two roles on one selector set
    // different non-empty think modes (selectorPairConflict): say so before Apply.
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    const conflict = screen.getByText(/already sets Think/);
    expect(conflict).toHaveTextContent(
      'agent already sets Think to auto on this model; a route joining it cannot set a different Think mode.'
    );
    expect(conflict.closest('div')).toHaveAttribute('data-tone', 'blocking');
    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/already sets Think to auto/);

    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'auto');
    expect(screen.queryByText(/already sets Think/)).not.toBeInTheDocument();
    await stage();
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage.mock.calls[0][0][0].thinkMode).toBe('auto');
  });

  /** gpt-5 as a sibling role that sets Think, so a join has something to conflict with. */
  const thinkingGpt5 = (over: Partial<ModelProjection>): ModelProjection =>
    model({
      modelName: 'gpt-5',
      effectiveCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      capabilityFacts: {
        caps: ['chat', 'stream', 'tool_call', 'thinking'],
        knownCaps: [...CAPABILITY_NAMES],
      },
      exposedCapabilities: ['chat', 'stream', 'tool_call', 'thinking'],
      thinkMode: 'auto',
      ...over,
    });

  it('ignores a Think-setting sibling the draft already moves off the model', async () => {
    // [W4-10] agent-role sets Think to auto on gpt-5, but the draft already
    // routes agent elsewhere: once applied, nothing of agent-role is left on
    // the selector for chat to conflict with.
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [model(), thinkingGpt5({ role: 'agent-role', routedUseCases: ['agent'] })],
      draft: draftWith({
        kind: 'route',
        useCase: 'agent',
        modelFacts: { provider: 'hosted', model: 'claude', type: 'dense' },
        capabilityFacts: {
          caps: ['chat', 'stream', 'tool_call'],
          knownCaps: [...CAPABILITY_NAMES],
        },
        exposedCaps: ['chat', 'stream', 'tool_call'],
        thinkMode: '',
        confirmUnknown: false,
      }),
    });
    await openRoute('chat');
    await pickModel('gpt-5');
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    expect(screen.queryByText(/already sets Think/)).not.toBeInTheDocument();
    await stage();
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage.mock.calls[0][0][0].thinkMode).toBe('always');
  });

  /** A staged route of `useCase` onto claude — a selector nothing else is on. */
  const routedAway = (useCase: string): Change => ({
    kind: 'route',
    useCase,
    modelFacts: { provider: 'hosted', model: 'claude', type: 'dense' },
    capabilityFacts: { caps: ['chat', 'stream', 'tool_call'], knownCaps: [...CAPABILITY_NAMES] },
    exposedCaps: ['chat', 'stream', 'tool_call'],
    thinkMode: '',
    confirmUnknown: false,
  });

  it('still names a sibling role whose only route the draft unassigns', async () => {
    // Unassigns run after every route plan: plan-role is still bound, with its
    // Think, when chat joins. With no route left to name, the role is named.
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'planning', role: 'plan-role' },
      ],
      models: [model(), thinkingGpt5({ role: 'plan-role', routedUseCases: ['planning'] })],
      draft: draftWith({ kind: 'route-unassign', useCase: 'planning' }),
    });
    await openRoute('chat');
    await pickModel('gpt-5');
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    expect(screen.getByText(/already sets Think/)).toHaveTextContent(
      'role plan-role already sets Think to auto on this model; a route joining it cannot set a different Think mode.'
    );
    await stage();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('keeps the conflict when the leaving sibling is retargeted after this join', async () => {
    // Route plans run in stable-id order: `route:agent` joins gpt-5 before
    // `route:chat` moves chat-role off it, so the backend meets the conflict
    // and refuses. A transient conflict is still a refusal; say so.
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'agent', role: 'agent-role' },
        { useCase: 'chat', role: 'chat-role' },
      ],
      models: [
        model({ role: 'agent-role', routedUseCases: ['agent'] }),
        thinkingGpt5({ role: 'chat-role', routedUseCases: ['chat'] }),
      ],
      draft: draftWith(routedAway('chat')),
    });
    await openRoute('agent');
    await pickModel('gpt-5');
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    expect(screen.getByText(/already sets Think/)).toHaveTextContent(
      'role chat-role (its chat route leaves after this join) already sets Think to auto on this model; a route joining it cannot set a different Think mode.'
    );
    await stage();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('names what a fork source keeps serving when one of its routes leaves', async () => {
    // pair-role serves chat and summarize; the draft moves chat elsewhere. A
    // fork leaves the source role on gpt-5 with summarize and its Think.
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'agent', role: 'agent-role' },
        { useCase: 'chat', role: 'pair-role' },
        { useCase: 'summarize', role: 'pair-role' },
      ],
      models: [
        model({ role: 'agent-role', routedUseCases: ['agent'] }),
        thinkingGpt5({ role: 'pair-role', routedUseCases: ['chat', 'summarize'] }),
      ],
      draft: draftWith(routedAway('chat')),
    });
    await openRoute('agent');
    await pickModel('gpt-5');
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    expect(screen.getByText(/already sets Think/)).toHaveTextContent(
      'summarize already sets Think to auto on this model; a route joining it cannot set a different Think mode.'
    );
    await stage();
    expect(onStage).not.toHaveBeenCalled();
  });

  it('names a route once in the Think conflict, however many sibling roles reach it', async () => {
    // routedUseCases is fallback-inclusive: judge-role is reached only through
    // agent-role's chain, so both roles name agent. The notice says it once.
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [
        model(),
        thinkingGpt5({ role: 'agent-role', routedUseCases: ['agent'] }),
        thinkingGpt5({ role: 'judge-role', routedUseCases: ['agent'] }),
      ],
    });
    await openRoute('chat');
    await pickModel('gpt-5');
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    expect(screen.getByText(/already sets? Think/)).toHaveTextContent(
      /^agent already sets Think to auto on this model; a route joining it cannot set a different Think mode\.$/
    );
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

    expect(screen.getByText(/Firn has/)).toHaveTextContent(
      'Firn has no requirements on record for summarize, so it cannot check this model for it. Tick Apply anyway to accept that.'
    );
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

  it('refuses an empty exposure, which would fall back to the type defaults rather than to nothing', async () => {
    // A floorless route: no shortfall stands in the way, only the acknowledgement.
    // go-llm reads an empty override as "clear it": the model's capabilities
    // derive from its type again (dense → chat, generate, stream), so an
    // all-unticked checklist would persist MORE than it shows.
    const { onStage } = renderRouting({
      routes: [{ useCase: 'summarize', role: 'summarize-role' }],
      models: [
        model({
          role: 'summarize-role',
          effectiveCapabilities: ['chat'],
          capabilityFacts: { caps: ['chat'], knownCaps: [...CAPABILITY_NAMES] },
          exposedCapabilities: ['chat'],
          routedUseCases: ['summarize'],
        }),
      ],
    });
    await openRoute('summarize');
    await userEvent.click(screen.getByLabelText('chat'));
    // Disclosed as soon as the last cap goes, like every other blocking clause.
    expect(screen.getByText(/Tick at least one capability/).closest('div')).toHaveAttribute(
      'data-tone',
      'blocking'
    );
    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Tick at least one capability before staging this route; an empty set falls back to the model type's defaults, not to nothing."
    );

    await userEvent.click(screen.getByLabelText('chat'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Tick at least one capability/)).not.toBeInTheDocument();
    await stage();
    expect(onStage.mock.calls[0][0][0].exposedCaps).toEqual(['chat']);
  });

  it('refuses a hand-declared model with nothing ticked on a floorless route', async () => {
    // A floorless route seeds no caps into a fresh declaration (§4.4), so the
    // checklist opens empty — and go-llm would derive the type's defaults for
    // that join exactly as for an override. Said before Done, refused on Done.
    const { onStage } = renderRouting({
      routes: [{ useCase: 'summarize', role: 'summarize-role' }],
      models: [model({ role: 'summarize-role', routedUseCases: ['summarize'] })],
    });
    await openRoute('summarize');
    await declareModel('fresh-model');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'dense');
    expect(
      screen
        .getByText(
          "Tick at least one capability before staging this route; an empty set falls back to the model type's defaults, not to nothing."
        )
        .closest('div')
    ).toHaveAttribute('data-tone', 'blocking');
    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Tick at least one capability/);
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
        { useCase: 'agent', role: 'agent-role' },
      ],
      // agent is already on gpt-5: joining that selector governs agent, so the
      // caution renders (the join copy); the fork of chat-role never reaches summarize.
      models: [shared, { ...other, role: 'agent-role', routedUseCases: ['agent'] }],
    });
    await openRoute('chat');

    // A fact about the fork: nothing is asked of the reader.
    const sharedRole = screen.getByText(/share this model/).closest('div');
    expect(sharedRole).toHaveAttribute('data-tone', 'info');

    // Retargeting reaches the selector sibling, needs the summarize acknowledgement
    // and drops authored fields.
    await pickModel('gpt-5');
    expect(screen.getByText(/not the route/)).toHaveTextContent(
      'Changing them here also changes them for agent; Think applies to this route only.'
    );
    expect(screen.getByText(/not the route/).closest('div')).toHaveAttribute(
      'data-tone',
      'caution'
    );
    expect(screen.getByText(/Firn has/).closest('div')).toHaveAttribute('data-tone', 'caution');
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
    expect(screen.getByText('1 staged change')).toBeInTheDocument();
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
    expect(screen.getByText('1 staged change')).toBeInTheDocument();
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
    expect(screen.getByText('2 staged changes')).toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// Wave 4c: the picker's floor is every use case a card would govern.
// ---------------------------------------------------------------------------

describe('RouteEditor union floor (wave 4c)', () => {
  const agentModel = model({
    role: 'agent-role',
    modelName: 'gpt-5',
    effectiveCapabilities: ['chat', 'stream', 'tool_call'],
    capabilityFacts: { caps: ['chat', 'stream', 'tool_call'], knownCaps: [...CAPABILITY_NAMES] },
    exposedCapabilities: ['chat', 'stream', 'tool_call'],
    routedUseCases: ['agent'],
  });
  const grid = () => within(screen.getByRole('listbox', { name: /Models/ }));
  const names = () =>
    grid()
      .getAllByRole('option')
      .map((card) => within(card).getByText(/gpt/).textContent);
  const cardNamed = (name: string) => {
    const card = grid()
      .getAllByRole('option')
      .find((option) => within(option).queryByText(name) !== null);
    if (card === undefined) throw new Error(`no card named ${name}`);
    return card;
  };

  it('blocks the current model as an override, because its chain siblings govern', async () => {
    // chat-role reaches agent through a fallback chain. Keeping gpt-5-mini is an
    // OVERRIDE of that selector, so agent's floor governs it; gpt-5 is a fork of
    // chat alone (agent-role already serves agent from it), so only chat's floor
    // and agent's own apply — and gpt-5 meets both.
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [model({ routedUseCases: ['agent', 'chat'] }), agentModel],
    });
    await openRoute('chat');
    expect(screen.getByText('Model — every card below can serve chat')).toBeInTheDocument();
    expect(screen.getByText('filter: chat · stream')).toBeInTheDocument();
    expect(names()).toEqual(['gpt-5']);

    await userEvent.click(screen.getByRole('button', { name: /1 model is not eligible/ }));
    const blocked = cardNamed('gpt-5-mini');
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(within(blocked).getByText('agent needs tool_call')).toBeInTheDocument();
  });

  it('hides a card its own selector siblings refuse, and names the sibling', async () => {
    // gpt-5-mid serves chat's floor, but agent is routed to it and needs tool_call.
    const mid = model({ role: 'agent-role', modelName: 'gpt-5-mid', routedUseCases: ['agent'] });
    renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [model(), mid, other],
    });
    await openRoute('chat');
    // The band's own line names only what EVERY card serves…
    expect(screen.getByText('Model — every card below can serve chat')).toBeInTheDocument();
    // …(cards are role-alpha within the provider: chat-role, then other-role)…
    expect(names()).toEqual(['gpt-5-mini', 'gpt-5']);
    // …and the card agent already uses says why it is out.
    await userEvent.click(screen.getByRole('button', { name: /1 model is not eligible/ }));
    expect(within(cardNamed('gpt-5-mid')).getByText('agent needs tool_call')).toBeInTheDocument();
  });

  it('locks a sibling floor in the exposure checklist once the card is chosen', async () => {
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [model(), agentModel],
    });
    await openRoute('chat');
    await pickModel('gpt-5');

    const caps = screen.getByRole('group', { name: 'Capabilities exposed to chat — from gpt-5' });
    const toolCall = within(caps).getByLabelText('tool_call required');
    expect(toolCall).toBeChecked();
    expect(toolCall).toBeDisabled();
    expect(within(caps).getByText(/Required by/)).toHaveTextContent(
      'What this route may use. Required by chat and agent: chat, stream, tool_call.'
    );
    await stage();
    expect(onStage.mock.calls[0][0][0].exposedCaps).toEqual(['chat', 'stream', 'tool_call']);
  });

  it('never asserts a floor cap the applied model lacks: it names the shortfall and refuses', async () => {
    // agent on gpt-5-mini (the Incompatible row): tool_call is required but NOT
    // declared, so nothing ticks it for the user. Ticking it is an explicit
    // assertion go-llm takes as truth; until then Done refuses with the clause
    // the backend would.
    const { onStage } = renderRouting({
      routes: [{ useCase: 'agent', role: 'chat-role' }],
      models: [model({ routedUseCases: ['agent'] })],
    });
    await openRoute('agent');
    const caps = screen.getByRole('group', {
      name: 'Capabilities exposed to agent — from gpt-5-mini',
    });
    const toolCall = () => within(caps).getByLabelText('tool_call required');
    expect(toolCall()).not.toBeChecked();
    expect(toolCall()).toBeEnabled();
    const notice = screen.getByText(/does not declare/);
    expect(notice).toHaveTextContent(
      'gpt-5-mini does not declare tool_call: agent needs tool_call. Pick a model that does, or tick it here to declare that it can.'
    );
    expect(notice.closest('div')).toHaveAttribute('data-tone', 'blocking');
    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/agent needs tool_call/);

    await userEvent.click(toolCall());
    expect(screen.queryByText(/does not declare/)).not.toBeInTheDocument();
    expect(toolCall()).toBeChecked();
    expect(toolCall()).toBeDisabled();
    await stage();
    expect(onStage.mock.calls[0][0][0].exposedCaps).toEqual(['chat', 'stream', 'tool_call']);
  });

  it('locks a sibling floor in the declare form when a declared name joins that selector', async () => {
    // A hand-declared name is a fresh selector — until it is edited into an
    // existing model's name, at which point its siblings' floors apply and the
    // checked set must be what is sent (spec 4.4).
    const { onStage } = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [model(), agentModel],
    });
    await openRoute('chat');
    await declareModel('gpt-5x');
    const declared = () => screen.getByRole('group', { name: 'Capabilities this model supports' });
    expect(within(declared()).getByLabelText('tool_call')).not.toBeChecked();
    expect(within(declared()).getByLabelText('tool_call')).toBeEnabled();

    const name = screen.getByLabelText('Model name');
    await userEvent.clear(name);
    await userEvent.type(name, 'gpt-5');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'dense');
    // Joining agent-role's selector makes tool_call required — but a declaration
    // is what the user asserts, so nothing ticks it for them; the notice names
    // the sibling and Done refuses until they do.
    const toolCall = () => within(declared()).getByLabelText('tool_call required');
    expect(toolCall()).not.toBeChecked();
    expect(toolCall()).toBeEnabled();
    expect(screen.getByText(/does not declare/)).toHaveTextContent(
      'gpt-5 does not declare tool_call: agent needs tool_call.'
    );
    await stage();
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/agent needs tool_call/);

    await userEvent.click(toolCall());
    expect(toolCall()).toBeChecked();
    expect(toolCall()).toBeDisabled();
    expect(screen.queryByText(/does not declare/)).not.toBeInTheDocument();
    const exposed = screen.getByRole('group', {
      name: 'Capabilities exposed to chat — from gpt-5',
    });
    expect(within(exposed).getByLabelText('tool_call required')).toBeDisabled();

    await stage();
    const staged = onStage.mock.calls[0][0][0];
    expect(staged.capabilityFacts.caps).toEqual(['chat', 'stream', 'tool_call']);
    expect(staged.exposedCaps).toEqual(['chat', 'stream', 'tool_call']);
  });

  /** chat declared onto gpt-5 by hand, beside agent-role's gpt-5: tool_call is required, not declared. */
  const declareOntoAgentSelector = async () => {
    const view = renderRouting({
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'agent', role: 'agent-role' },
      ],
      models: [model(), agentModel],
    });
    await openRoute('chat');
    await declareModel('gpt-5x');
    const name = screen.getByLabelText('Model name');
    await userEvent.clear(name);
    await userEvent.type(name, 'gpt-5');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'dense');
    return view;
  };
  const declared = () => screen.getByRole('group', { name: 'Capabilities this model supports' });
  const exposed = () =>
    screen.getByRole('group', { name: 'Capabilities exposed to chat — from gpt-5' });

  it('declares a cap ticked in the exposure checklist of a hand-declared model', async () => {
    // A route cannot expose what its model does not declare: the tick in the
    // exposure checklist is the same assertion as the tick in the declare form.
    const { onStage } = await declareOntoAgentSelector();
    expect(within(declared()).getByLabelText('tool_call required')).not.toBeChecked();

    await userEvent.click(within(exposed()).getByLabelText('tool_call required'));
    expect(within(declared()).getByLabelText('tool_call required')).toBeChecked();
    expect(within(declared()).getByLabelText('tool_call required')).toBeDisabled();
    expect(screen.queryByText(/does not declare/)).not.toBeInTheDocument();
    await stage();
    const staged = onStage.mock.calls[0][0][0];
    expect(staged.capabilityFacts.caps).toEqual(['chat', 'stream', 'tool_call']);
    expect(staged.exposedCaps).toEqual(['chat', 'stream', 'tool_call']);
  });

  it('never withdraws a declared cap when the exposure unticks it', async () => {
    await declareOntoAgentSelector();
    await userEvent.click(within(exposed()).getByLabelText('thinking'));
    expect(within(declared()).getByLabelText('thinking')).toBeChecked();
    await userEvent.click(within(exposed()).getByLabelText('thinking'));
    expect(within(exposed()).getByLabelText('thinking')).not.toBeChecked();
    expect(within(declared()).getByLabelText('thinking')).toBeChecked();
  });

  it('keeps Think and the other exposure edits when an exposure tick declares a cap', async () => {
    // The write-through changes the declaration, and a changed declaration
    // normally re-seeds the exposure and Think from it. This tick IS the
    // exposure edit, so nothing else the user set may be thrown away.
    const { onStage } = await declareOntoAgentSelector();
    await userEvent.click(within(declared()).getByLabelText('thinking'));
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    await userEvent.click(within(exposed()).getByLabelText('thinking'));
    expect(screen.queryByLabelText('Think mode')).not.toBeInTheDocument();

    await userEvent.click(within(exposed()).getByLabelText('tool_call required'));
    expect(within(declared()).getByLabelText('tool_call required')).toBeChecked();
    expect(within(declared()).getByLabelText('tool_call required')).toBeDisabled();
    expect(within(exposed()).getByLabelText('thinking')).not.toBeChecked();
    // Think is only visible while thinking is exposed; re-expose it to read it.
    await userEvent.click(within(exposed()).getByLabelText('thinking'));
    expect(screen.getByLabelText('Think mode')).toHaveValue('always');

    await stage();
    const staged = onStage.mock.calls[0][0][0];
    expect(staged.thinkMode).toBe('always');
    expect(staged.capabilityFacts.caps).toEqual(['chat', 'stream', 'tool_call', 'thinking']);
    expect(staged.exposedCaps).toEqual(['chat', 'stream', 'tool_call', 'thinking']);
  });
});
