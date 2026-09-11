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
