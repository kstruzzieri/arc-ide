import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvidersCard } from '../../../components/GolemConfig/ProvidersCard';
import type { ProviderProjection } from '../../../types/golem';
import { KeyVault } from '../../../types/golemConfig';

const provider: ProviderProjection = {
  name: 'llama-swap',
  endpoint: 'http://127.0.0.1:9292/v1',
  classification: 'local',
  apiFormat: 'openai-compat',
  credentialState: 'none',
};

it('keeps an unstaged provider edit mounted when Edit is clicked again', async () => {
  const onUnstagedChange = jest.fn();
  render(
    <ProvidersCard
      providers={[provider]}
      usedProviders={[]}
      changes={[]}
      rows={new Map()}
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

  await userEvent.click(edit);

  expect(edit).toHaveAttribute('aria-expanded', 'true');
  expect(editor).toHaveFocus();
  expect(screen.getByLabelText('Endpoint')).toBe(endpoint);
  expect(endpoint).toHaveValue('http://127.0.0.1:9292/v1-draft');
});

it('keeps an unstaged provider addition mounted when Add provider is clicked again', async () => {
  render(
    <ProvidersCard
      providers={[]}
      usedProviders={[]}
      changes={[]}
      rows={new Map()}
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
