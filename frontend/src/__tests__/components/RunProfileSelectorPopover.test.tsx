import { render, screen, fireEvent, within } from '@testing-library/react';
import { RunProfileSelector } from '../../components/Header/RunProfileSelector';
import { useIDEStore } from '../../stores/ideStore';

const mockStart = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn().mockResolvedValue(undefined);
const mockRestart = jest.fn().mockResolvedValue(undefined);
const mockSetVariant = jest.fn().mockResolvedValue(undefined);
jest.mock('../../wails/bindings', () => ({
  StartRunProfile: (...a: unknown[]) => mockStart(...a),
  StopRunProfile: (...a: unknown[]) => mockStop(...a),
  RestartRunProfile: (...a: unknown[]) => mockRestart(...a),
  SetActiveVariant: (...a: unknown[]) => mockSetVariant(...a),
}));

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    runProfiles: [
      { id: 'p1', name: 'dev', type: 'single', source: 'user', workspaceId: 'ws1' },
      { id: 'p2', name: 'test', type: 'single', source: 'user', workspaceId: 'ws1' },
    ],
    runProfileState: {},
    runOutputs: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
    hiddenProfileIds: [],
    stoppingProfileIds: [],
    restartingProfileIds: [],
    activeWorkspaceId: 'ws1', // workspace view (NOT a treeViewMode field)
    workspaces: [{ id: 'ws1', name: 'frontend', path: '/x', accent: 'frontend' }] as never,
    selectedProfileId: 'p1',
  });
});

function open() {
  render(<RunProfileSelector />);
  fireEvent.click(
    screen.getByRole('button', { name: /No profile|dev|test|api/i, expanded: false })
  );
}

test('opens popover and lists profiles as rows', () => {
  open();
  const pop = screen.getByRole('dialog', { name: /run profiles/i });
  expect(within(pop).getByText('dev')).toBeInTheDocument();
  expect(within(pop).getByText('test')).toBeInTheDocument();
});

test('row click selects the profile without running it', () => {
  open();
  const pop = screen.getByRole('dialog');
  fireEvent.click(within(pop).getByText('test'));
  expect(useIDEStore.getState().selectedProfileId).toBe('p2');
  expect(mockStart).not.toHaveBeenCalled();
});

test('inline run button runs that row immediately', () => {
  open();
  const pop = screen.getByRole('dialog');
  fireEvent.click(within(pop).getByRole('button', { name: /Run test/i }));
  expect(mockStart).toHaveBeenCalledWith('p2');
});

test('inline action stops a running row', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: {
        runInstanceId: 'r1',
        profileId: 'p2',
        state: 'running',
        exitCode: 0,
        entries: [],
      },
    },
    runInstanceIdsByProfile: { p2: ['r1'] },
    latestRunInstanceIdByProfile: { p2: 'r1' },
  });
  open();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Stop test/i }));
  expect(mockStop).toHaveBeenCalledWith('p2');
});

test('inline action restarts a failed row', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: {
        runInstanceId: 'r1',
        profileId: 'p2',
        state: 'failed',
        exitCode: 1,
        entries: [],
      },
    },
    runInstanceIdsByProfile: { p2: ['r1'] },
    latestRunInstanceIdByProfile: { p2: 'r1' },
  });
  open();
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: /Restart test/i })
  );
  expect(mockRestart).toHaveBeenCalledWith('p2');
});

test('Escape closes the popover', () => {
  open();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /dev/i, expanded: false })).toHaveFocus();
});

test('clicking the trigger again closes the popover', () => {
  open();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /dev/i, expanded: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('project view groups rows by workspace', () => {
  useIDEStore.setState({
    runProfiles: [
      {
        id: 'p1',
        name: 'dev',
        type: 'single',
        source: 'user',
        workspaceId: 'ws1',
        workspaceName: 'frontend',
      },
      {
        id: 'p2',
        name: 'api',
        type: 'single',
        source: 'user',
        workspaceId: 'ws2',
        workspaceName: 'backend',
      },
    ],
    workspaces: [
      { id: 'ws1', name: 'frontend', path: '/x', accent: 'frontend' },
      { id: 'ws2', name: 'backend', path: '/y', accent: 'python' },
    ] as never,
    activeWorkspaceId: 'project', // project view
    selectedProfileId: null,
  });
  open();
  const pop = screen.getByRole('dialog');
  expect(within(pop).getByText('frontend')).toBeInTheDocument();
  expect(within(pop).getByText('backend')).toBeInTheDocument();
  expect(within(pop).getByText('dev')).toBeInTheDocument();
  expect(within(pop).getByText('api')).toBeInTheDocument();
});

test('changing the env variant calls SetActiveVariant', () => {
  useIDEStore.setState({
    runProfiles: [
      {
        id: 'p1',
        name: 'dev',
        type: 'single',
        source: 'user',
        workspaceId: 'ws1',
        envVariants: [
          { name: 'dev', envFile: '.env' },
          { name: 'prod', envFile: '.env.prod' },
        ],
      },
    ],
    activeWorkspaceId: 'ws1',
    selectedProfileId: 'p1',
  });
  open();
  const pop = screen.getByRole('dialog');
  fireEvent.change(within(pop).getByLabelText('Env variant for dev'), {
    target: { value: 'prod' },
  });
  expect(mockSetVariant).toHaveBeenCalledWith('p1', 'prod');
});

test('env variant selector preserves base as the empty value', () => {
  useIDEStore.setState({
    runProfiles: [
      {
        id: 'p1',
        name: 'dev',
        type: 'single',
        source: 'user',
        workspaceId: 'ws1',
        envVariants: [
          { name: 'dev', envFile: '.env' },
          { name: 'prod', envFile: '.env.prod' },
        ],
      },
    ],
    activeWorkspaceId: 'ws1',
    selectedProfileId: 'p1',
  });
  open();
  const select = within(screen.getByRole('dialog')).getByLabelText(
    'Env variant for dev'
  ) as HTMLSelectElement;
  expect(select.value).toBe('');
  expect(within(select).getByRole('option', { name: 'base' })).toHaveValue('');

  fireEvent.change(select, { target: { value: 'prod' } });
  fireEvent.change(select, { target: { value: '' } });
  expect(mockSetVariant).toHaveBeenLastCalledWith('p1', '');
});

test('shows the selected target as an outside-view row when it is in another workspace', () => {
  useIDEStore.setState({
    runProfiles: [
      { id: 'p1', name: 'dev', type: 'single', source: 'user', workspaceId: 'ws1' },
      { id: 'p2', name: 'api', type: 'single', source: 'user', workspaceId: 'ws2' },
    ],
    activeWorkspaceId: 'ws1', // workspace view scoped to ws1
    selectedProfileId: 'p2', // lives in ws2 -> outside this view
  });
  open();
  const pop = screen.getByRole('dialog');
  expect(within(pop).getByText(/Selected \(outside this view\)/i)).toBeInTheDocument();
  expect(within(pop).getByText('api')).toBeInTheDocument();
});
