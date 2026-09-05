import { act, fireEvent, render, screen } from '@testing-library/react';
import { PanelRail } from '../../components/layout/PanelRail';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import * as platform from '../../utils/platform';

beforeEach(() => {
  __resetGolemStore();
  useIDEStore.setState(useIDEStore.getInitialState());
});
afterEach(() => jest.restoreAllMocks());

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

it('reorders on the platform chord while collapsed, and ignores a plain arrow', () => {
  jest.spyOn(platform, 'isMac').mockReturnValue(true);
  render(<PanelRail panel="golem" onExpand={jest.fn()} />);
  const button = screen.getByRole('button', { name: 'Expand Golem panel' });
  expect(button).toHaveAttribute('data-side', 'right');

  fireEvent.keyDown(button, { key: 'ArrowLeft' });
  expect(useIDEStore.getState().centerOrder).toBe('files-first');

  fireEvent.keyDown(button, { key: 'ArrowLeft', metaKey: true, shiftKey: true });
  expect(useIDEStore.getState().centerOrder).toBe('golem-first');
  expect(button).toHaveAttribute('data-side', 'left');
});
