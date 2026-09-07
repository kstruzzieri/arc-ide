import { render, screen } from '@testing-library/react';
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
