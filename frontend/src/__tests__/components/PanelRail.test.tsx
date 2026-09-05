import { act, fireEvent, render, screen } from '@testing-library/react';
import { PanelRail } from '../../components/layout/PanelRail';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';

beforeEach(() => __resetGolemStore());

it('renders a single button named for its panel and expands on click', () => {
  const onExpand = jest.fn();
  render(<PanelRail panel="files" onExpand={onExpand} />);
  const button = screen.getByRole('button', { name: 'Expand Files panel' });
  fireEvent.click(button);
  expect(onExpand).toHaveBeenCalledTimes(1);
  expect(button).toHaveAttribute('data-panel', 'files');
});

it('names the Golem attention state in the accessible label, never colour alone', () => {
  render(<PanelRail panel="golem" onExpand={jest.fn()} />);
  expect(screen.getByRole('button', { name: 'Expand Golem panel' })).not.toHaveAttribute(
    'data-attention'
  );

  act(() =>
    useGolemStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        c1: {
          identity: { repoEpoch: 1, workspaceId: 'project', conversationId: 'c1' },
          workspaceLabel: 'repo',
          available: true,
          needsConsent: false,
          warnings: [],
          initError: null,
          destination: null,
          rawEvents: [],
          transcript: [],
          runs: {},
          activeRunId: 'r1',
          draft: '',
          queuedTurns: [],
          pendingConsentTurn: null,
          lastFailedTurn: null,
        },
      },
    }))
  );
  const button = screen.getByRole('button', { name: 'Expand Golem panel — running' });
  expect(button).toHaveAttribute('data-attention', 'running');
});
