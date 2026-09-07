import { render, screen } from '@testing-library/react';
import { Header } from '../../components/Header/Header';
import { useIDEStore } from '../../stores/ideStore';

jest.mock('../../wails/bindings', () => ({
  StartRunProfile: jest.fn().mockResolvedValue(undefined),
  StopRunProfile: jest.fn().mockResolvedValue(undefined),
  RestartRunProfile: jest.fn().mockResolvedValue(undefined),
  SetActiveVariant: jest.fn().mockResolvedValue(undefined),
  OpenFolderDialog: jest.fn().mockResolvedValue(''),
}));

jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn(() => jest.fn()),
  EventsOff: jest.fn(),
  WindowSetTitle: jest.fn(),
}));

beforeEach(() => {
  useIDEStore.setState({
    runProfiles: [{ id: 'p1', name: 'dev', type: 'single', source: 'user', workspaceId: 'ws1' }],
    runProfileState: {},
    runOutputs: {},
    hiddenProfileIds: [],
    stoppingProfileIds: [],
    restartingProfileIds: [],
    activeWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'frontend', path: '/x', accent: 'frontend' }] as never,
    selectedProfileId: null,
    recentWorkspaces: [],
  });
});

test('renders the run-profile selector in the header', () => {
  render(<Header onOpenCommandPalette={jest.fn()} />);
  expect(screen.getByRole('button', { name: /Run selected profile: dev/i })).toBeInTheDocument();
});
