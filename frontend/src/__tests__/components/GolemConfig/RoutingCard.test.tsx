import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoutingCard, routeRowKey } from '../../../components/GolemConfig/RoutingCard';
import {
  CAPABILITY_NAMES,
  type ModelProjection,
  type ProviderProjection,
} from '../../../types/golem';
import { cleanDraft } from '../../../types/golemConfig';

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

  await userEvent.click(edit);

  expect(edit).toHaveAttribute('aria-expanded', 'true');
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

  await userEvent.click(assign);

  expect(assign).toHaveAttribute('aria-expanded', 'true');
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
    diagnostics: [],
    editable: true,
    onStage: jest.fn(),
    onUnstagedChange: jest.fn(),
  });

  /**
   * While an editor is open, ModelBand mounts its OWN `role="status"` live
   * region for the filter match count — a second `status` role that makes a
   * plain `getByRole('status')` ambiguous. The card's persistent region is
   * the one that lives outside the routing rows list; that structural fact,
   * not its text, is what picks it out.
   */
  const announcementRegion = () =>
    screen
      .getAllByRole('status')
      .find((region) => !screen.getByRole('list', { name: 'Model routing' }).contains(region));

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
