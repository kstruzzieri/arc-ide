import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoutingCard, routeRowKey } from '../../../components/GolemConfig/RoutingCard';
import {
  CAPABILITY_NAMES,
  type ModelProjection,
  type ProviderProjection,
} from '../../../types/golem';
import {
  cleanDraft,
  projectDraft,
  stageChange,
  KeyVault,
  type Change,
  type RouteChange,
} from '../../../types/golemConfig';

const model: ModelProjection = {
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
};

const provider: ProviderProjection = {
  name: 'hosted',
  endpoint: 'https://api.example.com/v1',
  classification: 'remote',
  apiFormat: 'openai-compat',
  credentialState: 'available',
};

it('keeps an unstaged route edit mounted when Edit is clicked again', async () => {
  const onUnstagedChange = jest.fn();
  render(
    <RoutingCard
      routes={[{ useCase: 'chat', role: 'chat-role' }]}
      models={[model]}
      providers={[provider]}
      draft={cleanDraft('0'.repeat(64))}
      changes={[]}
      rows={new Map()}
      roleRows={new Map()}
      selectorUseCases={new Map()}
      diagnostics={[]}
      editable
      onStage={() => {}}
      onUnstagedChange={onUnstagedChange}
    />
  );

  const edit = screen.getByRole('button', { name: 'Edit route chat' });
  await userEvent.click(edit);
  const editor = screen.getByRole('group', { name: 'Route chat' });
  await userEvent.type(screen.getByLabelText('Filter models'), 'draft-model');
  await userEvent.click(screen.getByRole('option', { name: /Declare "draft-model"/ }));
  const modelName = screen.getByLabelText('Model name');
  await userEvent.type(modelName, '-edited');
  expect(onUnstagedChange).toHaveBeenLastCalledWith(routeRowKey('chat'), true);

  // [C6] Re-query: expanding wrapped the row in a rowgroup keyed differently,
  // so the node captured above is detached.
  const reopened = screen.getByRole('button', { name: 'Edit route chat' });
  await userEvent.click(reopened);

  expect(reopened).toHaveAttribute('aria-expanded', 'true');
  expect(editor).toHaveFocus();
  expect(screen.getByLabelText('Model name')).toBe(modelName);
  expect(modelName).toHaveValue('draft-model-edited');
});

it('keeps an unstaged route assignment mounted when Assign is clicked again', async () => {
  render(
    <RoutingCard
      routes={[{ useCase: 'chat', role: 'chat-role' }]}
      models={[model]}
      providers={[provider]}
      draft={cleanDraft('0'.repeat(64))}
      changes={[]}
      rows={new Map()}
      roleRows={new Map()}
      selectorUseCases={new Map()}
      diagnostics={[]}
      editable
      onStage={() => {}}
      onUnstagedChange={() => {}}
    />
  );

  const assign = screen.getByRole('button', { name: 'Assign route embedding' });
  await userEvent.click(assign);
  const editor = screen.getByRole('group', { name: 'Route embedding' });
  await userEvent.selectOptions(screen.getByLabelText('Provider'), 'hosted');
  await userEvent.type(screen.getByLabelText('Filter models'), 'draft-embedding');
  await userEvent.click(screen.getByRole('option', { name: /Declare "draft-embedding"/ }));
  const modelName = screen.getByLabelText('Model name');
  await userEvent.type(modelName, '-edited');
  expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('data-unstaged', 'true');

  const reopened = screen.getByRole('button', { name: 'Assign route embedding' });
  await userEvent.click(reopened);

  expect(reopened).toHaveAttribute('aria-expanded', 'true');
  expect(editor).toHaveFocus();
  expect(screen.getByLabelText('Model name')).toBe(modelName);
  expect(modelName).toHaveValue('draft-embedding-edited');
});

describe('route editor Done (firn-ide#284)', () => {
  const baseProps = () => ({
    routes: [{ useCase: 'chat', role: 'chat-role' }],
    models: [model],
    providers: [provider],
    draft: cleanDraft('0'.repeat(64)),
    changes: [],
    rows: new Map(),
    roleRows: new Map(),
    selectorUseCases: new Map(),
    diagnostics: [],
    editable: true,
    onStage: jest.fn(),
    onUnstagedChange: jest.fn(),
  });

  /**
   * While an editor is open, ModelBand mounts its OWN `role="status"` live
   * region for the filter match count — a second `status` role that makes a
   * plain `getByRole('status')` ambiguous. The card's persistent region is
   * the one that lives outside the routing table; that structural fact,
   * not its text, is what picks it out.
   */
  const announcementRegion = () =>
    screen
      .getAllByRole('status')
      .find((region) => !screen.getByRole('table', { name: 'Model routing' }).contains(region));

  it('closes the editor, restores focus to Edit, and announces from a region that survives', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<RoutingCard {...props} />);

    await user.click(screen.getByRole('button', { name: 'Edit route chat' }));
    // The seeded applied model satisfies the chat floor, so Done stages as-is.
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(props.onStage).toHaveBeenCalledTimes(1);
    // The editor unmounted on success…
    expect(screen.queryByRole('group', { name: 'Route chat' })).not.toBeInTheDocument();
    // …focus landed back on the strip's Edit control…
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit route chat' })).toHaveFocus()
    );
    // …and the announcement lives in a region that survived the unmount.
    expect(announcementRegion()).toHaveTextContent('chat model staged: gpt-5-mini');
  });

  it('announces again when the same model is staged twice', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<RoutingCard {...props} />);

    await user.click(screen.getByRole('button', { name: 'Edit route chat' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(announcementRegion()).toHaveTextContent('chat model staged: gpt-5-mini');

    // Re-opening the editor EMPTIES the persistent region, so an identical
    // second staging is a fresh write the live region actually announces —
    // identical consecutive text is silent to AT (§4.7).
    await user.click(screen.getByRole('button', { name: 'Edit route chat' }));
    expect(announcementRegion()).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onStage).toHaveBeenCalledTimes(2);
    expect(announcementRegion()).toHaveTextContent('chat model staged: gpt-5-mini');
  });

  it('announces again when the editor reopens through an Apply-bar chip (focusRequest)', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const view = render(<RoutingCard {...props} />);

    await user.click(screen.getByRole('button', { name: 'Edit route chat' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(announcementRegion()).toHaveTextContent('chat model staged: gpt-5-mini');

    // The Apply-bar chip path: the WORKSPACE reopens the editor by PROP
    // (focusRequest), never through the Edit button — the live-region reset
    // must fire on this opening path too, or a repeated Done writes identical
    // text the region never announces.
    view.rerender(<RoutingCard {...props} focusRequest={{ changeId: 'route:chat', nonce: 1 }} />);
    expect(announcementRegion()).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onStage).toHaveBeenCalledTimes(2);
    expect(announcementRegion()).toHaveTextContent('chat model staged: gpt-5-mini');
  });

  it('stripes a changed row and names the applied value it replaces', () => {
    const staged: Change = {
      kind: 'route',
      useCase: 'chat',
      // [C7] `type` is a ModelType ('dense' | 'moe' | 'embedding' | …), never 'chat'.
      modelFacts: { provider: provider.name, model: 'gpt-5', type: model.type },
      capabilityFacts: { caps: ['chat', 'stream'], knownCaps: ['chat', 'stream'] },
      exposedCaps: ['chat', 'stream'],
      thinkMode: '',
      confirmUnknown: false,
    };
    render(
      <RoutingCard
        {...baseProps()}
        draft={{ ...cleanDraft('0'.repeat(64)), changes: [staged] }}
        changes={[staged]}
        rows={new Map([['chat', { modified: true, keyStaged: false, needsReview: false }]])}
      />
    );
    const row = screen.getByTestId('route-row-chat');
    expect(row).toHaveAttribute('data-changed', 'true');
    expect(within(row).getByText('gpt-5')).toBeInTheDocument();
    expect(within(row).getByText(/^was$/i).parentElement).toHaveTextContent(
      `was${model.modelName}`
    );
    // The provider did not change, so there is exactly ONE was line.
    expect(within(row).getAllByText(/^was$/i)).toHaveLength(1);
  });

  it('stripes a think-only change without inventing a was line', () => {
    // [C23] The stripe follows the projected row marker; WAS lines follow applied-value
    // differences.
    const staged: Change = {
      kind: 'route',
      useCase: 'chat',
      modelFacts: { provider: provider.name, model: model.modelName, type: model.type },
      capabilityFacts: model.capabilityFacts,
      exposedCaps: model.exposedCapabilities,
      // [C7] `'on'` is not a ThinkMode ('' | 'none' | 'always' | 'toggle' | 'auto').
      thinkMode: 'always',
      confirmUnknown: false,
    };
    render(
      <RoutingCard
        {...baseProps()}
        draft={{ ...cleanDraft('0'.repeat(64)), changes: [staged] }}
        changes={[staged]}
        rows={new Map([['chat', { modified: true, keyStaged: false, needsReview: false }]])}
      />
    );
    const row = screen.getByTestId('route-row-chat');
    expect(row).toHaveAttribute('data-changed', 'true');
    expect(within(row).getAllByText(/^was$/i)).toHaveLength(1);
    expect(within(row).getByText(/^was$/i).parentElement).toHaveTextContent(
      `was${model.thinkMode === '' ? '—' : model.thinkMode}`
    );
  });

  it('a chip jump opens the editor and focuses the Model field', async () => {
    const { rerender } = render(<RoutingCard {...baseProps()} focusRequest={null} />);
    rerender(<RoutingCard {...baseProps()} focusRequest={{ changeId: 'route:chat', nonce: 1 }} />);
    expect(await screen.findByLabelText('Filter models')).toHaveFocus();
    expect(screen.getByTestId('route-row-chat')).toHaveAttribute('data-flash');
  });

  it('re-flashes the same row when the chip is clicked again', async () => {
    // [K4] A second jump inside the 1.4s window set the SAME flash value, React bailed
    // out of the render, and the row the user asked for twice flashed once. The
    // request's nonce rides along so the landing is a new value every time.
    const { rerender } = render(<RoutingCard {...baseProps()} focusRequest={null} />);
    rerender(<RoutingCard {...baseProps()} focusRequest={{ changeId: 'route:chat', nonce: 1 }} />);
    const first = screen.getByTestId('route-row-chat').getAttribute('data-flash');
    expect(first).not.toBeNull();
    rerender(<RoutingCard {...baseProps()} focusRequest={{ changeId: 'route:chat', nonce: 2 }} />);
    expect(screen.getByTestId('route-row-chat').getAttribute('data-flash')).not.toBe(first);
  });

  it('stripes and flashes a defined-model row a role chip jumps to', async () => {
    // [X11] A `role-remove` chip is the ONLY handle a staged role removal has; the row
    // it lands on must carry the same staged-change stripe and landing flash every
    // other jump target does.
    const unrouted = { ...model, role: 'spare', routedUseCases: [], removable: true };
    const props = () => ({
      ...baseProps(),
      models: [model, unrouted],
      roleRows: new Map([['spare', { modified: true, keyStaged: false, needsReview: false }]]),
    });
    const { rerender } = render(<RoutingCard {...props()} focusRequest={null} />);
    const row = screen.getByTestId('defined-model-row-spare');
    expect(row).toHaveAttribute('data-changed', 'true');
    expect(row).not.toHaveAttribute('data-flash');

    rerender(<RoutingCard {...props()} focusRequest={{ changeId: 'role:spare', nonce: 1 }} />);
    await waitFor(() =>
      expect(screen.getByTestId('defined-model-row-spare')).toHaveAttribute('data-flash')
    );
    expect(screen.getByTestId('defined-model-row-spare')).toHaveFocus();
    // The route rows keep their own namespace: a `role:` jump never flashes `route:chat`.
    expect(screen.getByTestId('route-row-chat')).not.toHaveAttribute('data-flash');
  });

  it('leaves a jump inert while the card cannot be edited', () => {
    // [A1] The shared boundary: a standing request must never open editable controls.
    const { rerender } = render(
      <RoutingCard {...baseProps()} editable={false} focusRequest={null} />
    );
    rerender(
      <RoutingCard
        {...baseProps()}
        editable={false}
        focusRequest={{ changeId: 'route:chat', nonce: 1 }}
      />
    );
    expect(screen.queryByRole('group', { name: 'Route chat' })).toBeNull();
  });

  it('keeps a refused Done expanded with its refusal', async () => {
    const user = userEvent.setup();
    const props = baseProps();
    // An unbound use case with nothing chosen: Done must refuse and stay open.
    // `embedding` is a known use case (routeUseCases unions Firn's known use
    // cases with the authored ones) that this fixture leaves OUT of `routes`,
    // so RoutingCard's `byUseCase.get('embedding') ?? null` resolves to null
    // and the row renders the Assign control rather than Edit.
    props.routes = [{ useCase: 'chat', role: 'chat-role' }];
    render(<RoutingCard {...props} />);

    await user.click(screen.getByRole('button', { name: /assign route embedding/i }));
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(props.onStage).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Route embedding' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/choose a provider/i);
  });
});

// ---------------------------------------------------------------------------
// Wave 4b (firn-ide#315): a selector-wide change reaches its sibling rows.
// ---------------------------------------------------------------------------

describe('selector-wide siblings (firn-ide#315)', () => {
  const thinking = (over: Partial<ModelProjection> = {}): ModelProjection => ({
    ...model,
    effectiveCapabilities: ['chat', 'stream', 'thinking'],
    capabilityFacts: { caps: ['chat', 'stream', 'thinking'], knownCaps: [...CAPABILITY_NAMES] },
    exposedCapabilities: ['chat', 'stream', 'thinking'],
    thinkMode: 'auto',
    ...over,
  });
  const change = (over: Partial<RouteChange> = {}): RouteChange => ({
    kind: 'route',
    useCase: 'chat',
    modelFacts: { provider: 'hosted', model: 'gpt-5-mini', type: 'dense' },
    capabilityFacts: { caps: ['chat', 'stream', 'thinking'], knownCaps: [...CAPABILITY_NAMES] },
    exposedCaps: ['chat', 'stream', 'thinking'],
    thinkMode: 'always',
    confirmUnknown: false,
    ...over,
  });
  /** Exactly what the workspace hands over: the projection of ONE staged change. */
  const renderProjected = (
    routes: { useCase: string; role: string }[],
    models: ModelProjection[],
    staged: RouteChange
  ) => {
    const draft = stageChange(cleanDraft('0'.repeat(64)), staged, new KeyVault(new Map()));
    const projected = projectDraft({ routes, models }, draft);
    render(
      <RoutingCard
        routes={routes}
        models={models}
        providers={[provider]}
        draft={draft}
        changes={projected.changes}
        rows={projected.routeRows}
        roleRows={projected.roleRows}
        selectorUseCases={projected.selectorUseCases}
        diagnostics={[]}
        editable
        onStage={() => {}}
        onUnstagedChange={() => {}}
      />
    );
  };
  // Two roles on ONE provider+model: one selector, so an override reaches both.
  const twoRoles = [
    { useCase: 'chat', role: 'chat-role' },
    { useCase: 'summarize', role: 'summarize-role' },
  ];
  const twoRoleModels = [
    thinking({ routedUseCases: ['chat'] }),
    thinking({ role: 'summarize-role', routedUseCases: ['summarize'] }),
  ];

  it('paints a selector-wide think change on the sibling row, with its own was line', () => {
    renderProjected(twoRoles, twoRoleModels, change());
    const sibling = screen.getByTestId('route-row-summarize');
    expect(sibling).toHaveAttribute('data-changed', 'true');
    expect(within(sibling).getByText('always')).toBeInTheDocument();
    expect(within(sibling).getByText(/^was$/i).parentElement).toHaveTextContent('wasauto');
    expect(within(sibling).getByText('Modified')).toBeInTheDocument();
    // The model did not change — it is the same selector — so there is exactly one was line…
    expect(within(sibling).getAllByText(/^was$/i)).toHaveLength(1);
    // …and the reach is told once, on the row that was edited.
    expect(within(sibling).queryByText(/also affects/)).not.toBeInTheDocument();
    const edited = screen.getByTestId('route-row-chat');
    expect(within(edited).getByText('also affects summarize')).toBeInTheDocument();
    expect(within(edited).getByText(/^was$/i).parentElement).toHaveTextContent('wasauto');
  });

  it('reads the sibling as Incompatible when the governing exposure drops its floor', () => {
    // summarize's override narrows the selector to chat + thinking: chat loses stream.
    renderProjected(
      twoRoles,
      twoRoleModels,
      change({ useCase: 'summarize', exposedCaps: ['chat', 'thinking'] })
    );
    expect(
      within(screen.getByTestId('route-row-chat')).getByText('Incompatible')
    ).toBeInTheDocument();
  });

  it('paints a joining change onto the sibling for the status verdict but not for think', () => {
    // summarize retargets onto chat's selector (summarize-role serves only summarize,
    // so it is a retarget, not an override): the capability override becomes the
    // selector's truth, but think is written to summarize's role alone — chat keeps
    // its own (empty) think.
    const models = [
      thinking({ modelName: 'gpt-5', thinkMode: '' }),
      thinking({ role: 'summarize-role', routedUseCases: ['summarize'] }),
    ];
    renderProjected(
      twoRoles,
      models,
      change({
        useCase: 'summarize',
        modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
        exposedCaps: ['chat', 'thinking'],
        thinkMode: 'always',
      })
    );
    const sibling = screen.getByTestId('route-row-chat');
    expect(sibling).toHaveAttribute('data-changed', 'true');
    // The capability override reaches the selector: chat loses stream.
    expect(within(sibling).getByText('Incompatible')).toBeInTheDocument();
    // Think does not: no `always`, no was line.
    expect(within(sibling).queryByText('always')).not.toBeInTheDocument();
    expect(within(sibling).queryByText(/^was$/i)).not.toBeInTheDocument();
  });

  it('does not treat a same-name, different-facts change as an override', () => {
    // Same provider+model as chat's role but different parameters: the backend
    // classifies that as a retarget (sameModelFacts is the full tuple), so no
    // SetRoleOverrides runs and summarize keeps its own (empty) think.
    const models = [
      thinking({ parameters: '7b' }),
      thinking({ role: 'summarize-role', routedUseCases: ['summarize'], thinkMode: '' }),
    ];
    renderProjected(twoRoles, models, change());
    const sibling = screen.getByTestId('route-row-summarize');
    expect(sibling).toHaveAttribute('data-changed', 'true');
    expect(within(sibling).queryByText('always')).not.toBeInTheDocument();
    expect(within(sibling).queryByText(/^was$/i)).not.toBeInTheDocument();
  });

  it('leaves a fork sibling on its applied values', () => {
    // chat and summarize share ONE role; retargeting chat forks it (spec 5.2b) and
    // summarize keeps gpt-5-mini — only the projection's marker reaches it.
    const sharedRole = [
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'summarize', role: 'chat-role' },
    ];
    const models = [
      thinking({ routedUseCases: ['chat', 'summarize'] }),
      thinking({ role: 'other-role', modelName: 'gpt-5', routedUseCases: [], thinkMode: '' }),
    ];
    renderProjected(
      sharedRole,
      models,
      change({ modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' } })
    );
    const sibling = screen.getByTestId('route-row-summarize');
    expect(within(sibling).getByText('gpt-5-mini')).toBeInTheDocument();
    expect(within(sibling).getByText('auto')).toBeInTheDocument();
    expect(within(sibling).queryByText(/^was$/i)).not.toBeInTheDocument();
    expect(sibling).toHaveAttribute('data-changed', 'true');
    const edited = screen.getByTestId('route-row-chat');
    expect(within(edited).getByText('gpt-5')).toBeInTheDocument();
    expect(within(edited).getByText('also affects summarize')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Wave 4d: a defined model can be routed from its own row.
// ---------------------------------------------------------------------------

describe('Defined models — Assign (wave 4d)', () => {
  const spare: ModelProjection = {
    ...model,
    role: 'spare',
    modelName: 'spare-m',
    routedUseCases: [],
    removable: true,
  };
  const props = () => ({
    routes: [{ useCase: 'chat', role: 'chat-role' }],
    models: [model, spare],
    providers: [provider],
    draft: cleanDraft('0'.repeat(64)),
    changes: [],
    rows: new Map(),
    roleRows: new Map(),
    selectorUseCases: new Map(),
    diagnostics: [],
    editable: true,
    onStage: jest.fn(),
    onUnstagedChange: jest.fn(),
  });
  // The list routes the MODEL: the staged change carries spare-m's facts, and
  // the backend retargets or forks the use case's own role — role `spare` is
  // never bound. The row's eyebrow still says which role defines it.
  const assign = () => screen.getByRole('button', { name: 'Assign… model spare-m, role spare' });
  const list = () => screen.getByRole('listbox', { name: 'Assign spare-m to' });
  let reveal: jest.SpyInstance | undefined;
  afterEach(() => {
    reveal?.mockRestore();
    reveal = undefined;
  });
  const optionNamed = (useCase: string) => {
    const option = within(list())
      .getAllByRole('option')
      .find((candidate) => within(candidate).queryByText(useCase) !== null);
    if (option === undefined) throw new Error(`no option ${useCase}`);
    return option;
  };

  it('labels the role cell in the record form, so a role and a use case never read alike', () => {
    render(<RoutingCard {...props()} />);
    const row = screen.getByTestId('defined-model-row-spare');
    expect(within(row).getByText('Role')).toHaveAttribute('aria-hidden', 'true');
    expect(within(row).getByText('spare')).toBeInTheDocument();
  });

  it('lists every use case with the same verdict the picker gives, and focuses the list', async () => {
    const user = userEvent.setup();
    render(<RoutingCard {...props()} />);
    // An inline disclosure, not a popup: expanded + controls say everything.
    expect(assign()).not.toHaveAttribute('aria-haspopup');
    expect(assign()).toHaveAttribute('aria-expanded', 'false');

    await user.click(assign());
    expect(assign()).toHaveAttribute('aria-expanded', 'true');
    expect(assign()).toHaveAttribute('aria-controls', list().id);
    expect(list()).toHaveFocus();
    expect(within(list()).getAllByRole('option')).toHaveLength(4);
    // spare-m declares chat + stream: agent and planning need tool_call, embedding
    // needs embed — the same clause the picker's blocked card carries.
    expect(optionNamed('agent')).toHaveAttribute('aria-disabled', 'true');
    expect(within(optionNamed('agent')).getByText('agent needs tool_call')).toBeInTheDocument();
    expect(within(optionNamed('embedding')).getByText('embedding needs embed')).toBeInTheDocument();
    expect(
      within(optionNamed('planning')).getByText('planning needs tool_call')
    ).toBeInTheDocument();
    expect(optionNamed('chat')).not.toHaveAttribute('aria-disabled');
    // The open row and its list are one outlined group, keyed apart from the bare row (C6).
    expect(screen.getByTestId('defined-model-row-spare').parentElement).toHaveAttribute(
      'role',
      'rowgroup'
    );
  });

  it('opens the chosen use case editor on this model, as an unstaged edit', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<RoutingCard {...p} />);
    await user.click(assign());
    await user.click(optionNamed('chat'));

    // The list closed and chat's editor opened on spare-m…
    expect(screen.queryByRole('listbox', { name: 'Assign spare-m to' })).not.toBeInTheDocument();
    expect(assign()).toHaveAttribute('aria-expanded', 'false');
    const editor = screen.getByRole('group', { name: 'Route chat' });
    await waitFor(() => expect(editor).toHaveFocus());
    expect(screen.getByTestId('model-detail')).toHaveAttribute('data-state', 'assigned');
    expect(screen.getByTestId('model-detail')).toHaveTextContent('spare-m');
    // …as an edit waiting for Done, not a committed state.
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('data-unstaged', 'true');
    expect(p.onUnstagedChange).toHaveBeenLastCalledWith(routeRowKey('chat'), true);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(p.onStage).toHaveBeenCalledTimes(1);
    expect(p.onStage.mock.calls[0][0][0].modelFacts.model).toBe('spare-m');
    expect(p.onStage.mock.calls[0][0][0].useCase).toBe('chat');
  });

  it('walks the list with the arrows, closes on Escape and returns focus to Assign', async () => {
    const user = userEvent.setup();
    // jsdom has no layout: the reveal is asserted through a spy on the setup
    // file's no-op, restored after the test so later suites keep the no-op.
    reveal = jest.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    render(<RoutingCard {...props()} />);
    await user.click(assign());
    const options = within(list()).getAllByRole('option');
    // The first ENABLED use case (chat) is active on open; agent is index 0 and disabled.
    expect(list()).toHaveAttribute('aria-activedescendant', options[1].id);
    await user.keyboard('{ArrowDown}');
    expect(list()).toHaveAttribute('aria-activedescendant', options[2].id);
    // The cursor is revealed on mount and on every move (the list scrolls past 320px).
    expect(reveal).toHaveBeenCalledTimes(2);
    expect(reveal).toHaveBeenLastCalledWith({ block: 'nearest' });
    await user.keyboard('{End}');
    expect(list()).toHaveAttribute('aria-activedescendant', options[3].id);
    await user.keyboard('{Home}');
    expect(list()).toHaveAttribute('aria-activedescendant', options[0].id);
    // Enter on a disabled use case is a no-op: the list stays.
    await user.keyboard('{Enter}');
    expect(list()).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Assign spare-m to' })).not.toBeInTheDocument();
    await waitFor(() => expect(assign()).toHaveFocus());
  });

  it('chooses the active use case with Enter', async () => {
    const user = userEvent.setup();
    render(<RoutingCard {...props()} />);
    await user.click(assign());
    await user.keyboard('{Enter}'); // chat is active on open
    expect(screen.getByRole('group', { name: 'Route chat' })).toBeInTheDocument();
    expect(screen.getByTestId('model-detail')).toHaveTextContent('spare-m');
  });

  it('disables a use case whose editor is already open', async () => {
    const user = userEvent.setup();
    render(<RoutingCard {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Edit route chat' }));
    await user.click(assign());
    expect(optionNamed('chat')).toHaveAttribute('aria-disabled', 'true');
    expect(within(optionNamed('chat')).getByText('editor open')).toBeInTheDocument();
  });

  it('offers no Assign while the configuration is not editable', () => {
    render(<RoutingCard {...props()} editable={false} />);
    expect(screen.queryByRole('button', { name: /Assign… model/ })).not.toBeInTheDocument();
  });

  it('offers no Assign while the row is staged for removal', () => {
    const removal = { modified: true, keyStaged: false, needsReview: false };
    const { rerender } = render(
      <RoutingCard {...props()} roleRows={new Map([['spare', removal]])} />
    );
    expect(
      screen.queryByRole('button', { name: 'Assign… model spare-m, role spare' })
    ).not.toBeInTheDocument();
    rerender(<RoutingCard {...props()} />);
    expect(assign()).toBeInTheDocument();
  });

  it('leaves a list closed by Remove closed once the removal is unstaged', async () => {
    const user = userEvent.setup();
    const p = props();
    const removal = { modified: true, keyStaged: false, needsReview: false };
    const { rerender } = render(<RoutingCard {...p} />);
    await user.click(assign());
    expect(list()).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Remove model role spare' }));
    expect(p.onStage).toHaveBeenLastCalledWith([{ kind: 'role-remove', role: 'spare' }], []);
    rerender(<RoutingCard {...p} roleRows={new Map([['spare', removal]])} />);
    expect(screen.queryByRole('listbox', { name: 'Assign spare-m to' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unstage removal of model role spare' }));
    expect(p.onStage).toHaveBeenLastCalledWith([], ['role:spare']);
    rerender(<RoutingCard {...p} />);
    // The row is assignable again, but the list the removal closed stays closed:
    // a remount would take focus from the control the user just pressed.
    expect(screen.queryByRole('listbox', { name: 'Assign spare-m to' })).not.toBeInTheDocument();
    expect(assign()).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement?.closest('[role="listbox"]')).toBeNull();
  });

  it('drops the preselect with the editor: after Cancel, Edit reopens on the row itself', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<RoutingCard {...p} />);
    await user.click(assign());
    await user.click(optionNamed('chat'));
    expect(screen.getByTestId('model-detail')).toHaveTextContent('spare-m');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit route chat' }));
    expect(screen.getByTestId('model-detail')).toHaveTextContent('gpt-5-mini');
    expect(screen.getByRole('button', { name: 'Done' })).not.toHaveAttribute('data-unstaged');
    expect(p.onStage).not.toHaveBeenCalled();
  });

  it('keeps a preselect an unstaged edit over a row that already holds a staged change', async () => {
    const user = userEvent.setup();
    const p = props();
    const staged: RouteChange = {
      kind: 'route',
      useCase: 'chat',
      modelFacts: { provider: 'hosted', model: 'gpt-5', type: 'dense' },
      capabilityFacts: { caps: ['chat', 'stream'], knownCaps: [...CAPABILITY_NAMES] },
      exposedCaps: ['chat', 'stream'],
      thinkMode: '',
      confirmUnknown: false,
    };
    const draft = stageChange(p.draft, staged, new KeyVault(new Map()));
    const projected = projectDraft({ routes: p.routes, models: p.models }, draft);
    render(
      <RoutingCard
        {...p}
        draft={draft}
        changes={projected.changes}
        rows={projected.routeRows}
        selectorUseCases={projected.selectorUseCases}
      />
    );
    await user.click(assign());
    await user.click(optionNamed('chat'));
    // The editor opens on spare-m, but the row's baseline is the STAGED change:
    // the preselect reads as unstaged until Done, and Cancel leaves the staging alone.
    expect(screen.getByTestId('model-detail')).toHaveTextContent('spare-m');
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('data-unstaged', 'true');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(p.onStage).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('route-row-chat')).getByText('gpt-5')).toBeInTheDocument();
  });
});
