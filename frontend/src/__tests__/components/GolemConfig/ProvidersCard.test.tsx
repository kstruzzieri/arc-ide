import type { ComponentProps } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvidersCard } from '../../../components/GolemConfig/ProvidersCard';
import type { ProviderProjection } from '../../../types/golem';
import { KeyVault, type Change } from '../../../types/golemConfig';

const provider: ProviderProjection = {
  name: 'llama-swap',
  endpoint: 'http://127.0.0.1:9292/v1',
  classification: 'local',
  apiFormat: 'openai-compat',
  credentialState: 'none',
};

const cardProps = (over: Partial<ComponentProps<typeof ProvidersCard>> = {}) => ({
  providers: [provider],
  usage: new Map<string, readonly string[]>(),
  usedProviders: [],
  changes: [] as Change[],
  rows: new Map(),
  diagnostics: [],
  vault: new KeyVault(new Map<string, string>()),
  editable: true,
  onStage: () => {},
  onUnstagedChange: () => {},
  ...over,
});

describe('usage and change trace (ruling 7)', () => {
  it('says which routes use each provider', () => {
    render(
      <ProvidersCard {...cardProps({ usage: new Map([['llama-swap', ['agent', 'chat']]]) })} />
    );
    expect(
      within(screen.getByTestId('provider-row-llama-swap')).getByText('used by agent, chat')
    ).toBeInTheDocument();
  });

  it('marks an unrouted provider', () => {
    render(<ProvidersCard {...cardProps()} />);
    expect(
      within(screen.getByTestId('provider-row-llama-swap')).getByText('not routed')
    ).toBeInTheDocument();
  });

  it('names the applied endpoint under a staged endpoint change', () => {
    const staged: Change = {
      kind: 'provider-update',
      name: 'llama-swap',
      endpoint: 'https://new.example/v1',
    };
    render(
      <ProvidersCard
        {...cardProps({
          changes: [staged],
          rows: new Map([['llama-swap', { modified: true, keyStaged: false, needsReview: false }]]),
        })}
      />
    );
    const row = screen.getByTestId('provider-row-llama-swap');
    expect(row).toHaveAttribute('data-changed', 'true');
    expect(within(row).getByText('https://new.example/v1')).toBeInTheDocument();
    expect(within(row).getByText(/^was$/i).parentElement).toHaveTextContent(
      `was${provider.endpoint}`
    );
  });

  it('shows a staged endpoint as Pending, never the stale classification', () => {
    const staged: Change = {
      kind: 'provider-update',
      name: 'llama-swap',
      endpoint: 'https://remote.example/v1',
    };
    render(
      <ProvidersCard
        {...cardProps({
          changes: [staged],
          rows: new Map([['llama-swap', { modified: true, keyStaged: false, needsReview: false }]]),
        })}
      />
    );
    const row = screen.getByTestId('provider-row-llama-swap');
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(within(row).queryByText('Local')).toBeNull();
    expect(within(row).getByText('openai-compat')).toBeInTheDocument(); // the Type sub-line survives
  });

  it('leaves a jump inert while the card cannot be edited', () => {
    // [A1] The shared boundary: a standing request must never open editable controls.
    const { rerender } = render(
      <ProvidersCard {...cardProps({ editable: false, focusRequest: null })} />
    );
    rerender(
      <ProvidersCard
        {...cardProps({
          editable: false,
          focusRequest: { changeId: 'provider:llama-swap', nonce: 1 },
        })}
      />
    );
    expect(screen.queryByRole('group', { name: 'Edit provider llama-swap' })).toBeNull();
  });
});

it('keeps an unstaged provider edit mounted when Edit is clicked again', async () => {
  const onUnstagedChange = jest.fn();
  render(
    <ProvidersCard
      providers={[provider]}
      usedProviders={[]}
      changes={[]}
      rows={new Map()}
      usage={new Map()}
      diagnostics={[]}
      vault={new KeyVault(new Map<string, string>())}
      editable
      onStage={() => {}}
      onUnstagedChange={onUnstagedChange}
    />
  );

  const edit = screen.getByRole('button', { name: 'Edit provider llama-swap' });
  await userEvent.click(edit);
  const editor = screen.getByRole('group', { name: 'Edit provider llama-swap' });
  const endpoint = screen.getByLabelText('Endpoint');
  await userEvent.type(endpoint, '-draft');
  expect(onUnstagedChange).toHaveBeenLastCalledWith('llama-swap', true);

  // [C6] Re-query: expanding wrapped the row in a rowgroup with a different React
  // key, so the node captured above is detached and clicking it reaches nothing.
  const reopened = screen.getByRole('button', { name: 'Edit provider llama-swap' });
  await userEvent.click(reopened);

  expect(reopened).toHaveAttribute('aria-expanded', 'true');
  expect(editor).toHaveFocus();
  expect(screen.getByLabelText('Endpoint')).toBe(endpoint);
  expect(endpoint).toHaveValue('http://127.0.0.1:9292/v1-draft');
});

it('returns focus to the header button when the add form is cancelled', async () => {
  // [F6] Cancel unmounts the form, so without an explicit target focus falls to <body>
  // and a keyboard user restarts from the top of the document.
  render(<ProvidersCard {...cardProps({ providers: [] })} />);
  const add = screen.getByRole('button', { name: 'Add provider' });
  expect(add).toHaveAttribute('id', 'golem-provider-add-button');
  await userEvent.click(add);
  await userEvent.click(
    within(screen.getByRole('group', { name: 'Add a provider' })).getByRole('button', {
      name: 'Cancel',
    })
  );
  expect(screen.queryByRole('group', { name: 'Add a provider' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Add provider' })).toHaveFocus();
});

it('keeps an unstaged provider addition mounted when Add provider is clicked again', async () => {
  render(
    <ProvidersCard
      providers={[]}
      usedProviders={[]}
      changes={[]}
      rows={new Map()}
      usage={new Map()}
      diagnostics={[]}
      vault={new KeyVault(new Map<string, string>())}
      editable
      onStage={() => {}}
      onUnstagedChange={() => {}}
    />
  );

  const add = screen.getByRole('button', { name: 'Add provider' });
  await userEvent.click(add);
  const editor = screen.getByRole('group', { name: 'Add a provider' });
  const name = screen.getByLabelText('Provider name');
  await userEvent.type(name, 'draft-provider');
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();

  await userEvent.click(add);

  expect(add).toHaveAttribute('aria-expanded', 'true');
  expect(editor).toHaveFocus();
  expect(screen.getByLabelText('Provider name')).toBe(name);
  expect(name).toHaveValue('draft-provider');
});

it('keeps an applied strip and a staged add of the same name apart', async () => {
  // [K6] A profile-source conflict reload keeps the draft, so a staged `provider-add`
  // can meet an applied provider of the SAME name. Keyed on the name alone, the two
  // strips collided: React reused one node for both and the second Edit reached the
  // first editor. The strip's own `editorId` is what distinguishes them.
  // React is the only witness that two siblings shared a key, and it reports it
  // through console.error — so that is what this asserts on.
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <ProvidersCard
      {...cardProps({
        providers: [provider],
        stagedProviders: [{ ...provider, endpoint: 'http://127.0.0.1:9999/v1' }],
        changes: [
          { kind: 'provider-add', name: provider.name, endpoint: 'http://127.0.0.1:9999/v1' },
        ],
      })}
    />
  );
  expect(screen.getAllByTestId('provider-row-llama-swap')).toHaveLength(2);
  // Only the staged strip can be unstaged, so it is the one that owns that control.
  const [applied, staged] = screen.getAllByTestId('provider-row-llama-swap');
  expect(within(applied).queryByRole('button', { name: /Unstage/ })).toBeNull();
  expect(within(staged).getByRole('button', { name: /Unstage/ })).toBeInTheDocument();
  expect(applied).toHaveAttribute('id', 'golem-provider-editor-0-row');
  expect(staged).toHaveAttribute('id', 'golem-provider-staged-editor-0-row');

  await userEvent.click(within(staged).getByRole('button', { name: /Edit provider/ }));
  // The staged strip has no applied row underneath it, which is what makes its editor
  // the STAGED one — and proves the click did not reach the applied strip's editor.
  expect(screen.getByRole('group', { name: 'Staged provider llama-swap' })).toHaveAttribute(
    'id',
    'golem-provider-staged-editor-0'
  );
  const reported = errors.mock.calls.map((call) => call.join(' ')).join('\n');
  errors.mockRestore();
  expect(reported).not.toContain('same key');
});

it('keeps a later staged strip mounted when an earlier one is unstaged', async () => {
  // [N2] The strips were keyed on the POSITIONAL editor id, so unstaging the first
  // staged add shifted every later index — React remounted the next strip and its
  // open editor's unstaged endpoint was silently discarded (§4.6a). The key is the
  // list plus the name now, so the surviving strip keeps its identity.
  const staged = (name: string, endpoint: string): ProviderProjection => ({
    ...provider,
    name,
    endpoint,
  });
  const adds: Change[] = [
    { kind: 'provider-add', name: 'alpha', endpoint: 'http://alpha.local/v1' },
    { kind: 'provider-add', name: 'beta', endpoint: 'http://beta.local/v1' },
  ];
  const onStage = jest.fn();
  const { rerender } = render(
    <ProvidersCard
      {...cardProps({
        providers: [],
        stagedProviders: [
          staged('alpha', 'http://alpha.local/v1'),
          staged('beta', 'http://beta.local/v1'),
        ],
        changes: adds,
        onStage,
      })}
    />
  );

  await userEvent.click(
    within(screen.getByTestId('provider-row-beta')).getByRole('button', { name: /Edit provider/ })
  );
  const endpoint = screen.getByLabelText('Endpoint');
  await userEvent.type(endpoint, '-draft');
  expect(endpoint).toHaveValue('http://beta.local/v1-draft');

  await userEvent.click(
    within(screen.getByTestId('provider-row-alpha')).getByRole('button', { name: /Unstage/ })
  );
  expect(onStage).toHaveBeenCalledWith([], ['provider:alpha', 'provider-key:alpha']);
  // The parent's unstage lands as a shorter list, which is what shifted the indices.
  rerender(
    <ProvidersCard
      {...cardProps({
        providers: [],
        stagedProviders: [staged('beta', 'http://beta.local/v1')],
        changes: [adds[1]],
        onStage,
      })}
    />
  );

  expect(screen.getByRole('group', { name: 'Staged provider beta' })).toBeInTheDocument();
  expect(screen.getByLabelText('Endpoint')).toBe(endpoint);
  expect(endpoint).toHaveValue('http://beta.local/v1-draft');
});
