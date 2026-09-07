/**
 * Test: Active workspace accent is reflected on the IDE root element.
 *
 * TDD: Written first to define expected behavior before App.tsx is updated.
 */

import { act, render, waitFor } from '@testing-library/react';
import App from '../../App';
import { useIDEStore } from '../../stores/ideStore';
import type { workspace } from '../../wails/bindings';

// Mock Wails bindings — verbatim copy from App.test.tsx, with DetectWorkspaces added.
jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    ReadDirectory: jest.fn(),
    ReadFile: jest.fn(),
    WriteFile: jest.fn(),
    OpenFolderDialog: jest.fn(),
    GetWatchedPath: jest.fn(),
    SetWatchedPath: jest.fn(),
    CreateTerminal: jest.fn(() => Promise.resolve('term-1')),
    WriteTerminal: jest.fn(),
    CloseTerminal: jest.fn(),
    ResizeTerminal: jest.fn(),
    ConfirmBeforeCloseReady: jest.fn(() => Promise.resolve()),
    CancelBeforeClose: jest.fn(() => Promise.resolve()),
    SaveWorkspaceState: jest.fn(() => Promise.resolve()),
    LoadWorkspaceState: jest.fn(() => Promise.resolve(null)),
    ListRecentWorkspaces: jest.fn(() => Promise.resolve([])),
    LoadRunProfiles: jest.fn(() => Promise.resolve()),
    GetRunProfilesSnapshot: jest.fn(() => Promise.resolve({ profiles: [], profileState: {} })),
    SetActiveVariant: jest.fn(() => Promise.resolve()),
    LSPDidOpen: jest.fn().mockResolvedValue(undefined),
    LSPDidChange: jest.fn().mockResolvedValue(undefined),
    LSPDidSave: jest.fn().mockResolvedValue(undefined),
    LSPDidClose: jest.fn().mockResolvedValue(undefined),
    SearchWorkspace: jest.fn().mockResolvedValue({}),
    CancelSearch: jest.fn().mockResolvedValue(undefined),
    DetectWorkspaces: jest.fn(() => Promise.resolve([])),
    // App now mounts useGolemBridge; an unbound repository is the quiet default.
    GetWorkspaceInfo: jest.fn((path: string) =>
      Promise.resolve({ name: '', path, repoKey: '', repoEpoch: 0 })
    ),
    GetGolemStatus: jest.fn(() =>
      Promise.resolve({
        available: false,
        workspaceLabel: '',
        identity: { repoEpoch: 0, workspaceId: '', conversationId: '' },
        needsConsent: false,
        activeRuns: [],
      })
    ),
    RunGolemTurn: jest.fn(() => Promise.resolve(null)),
    CancelGolemRun: jest.fn(() => Promise.resolve(false)),
  };
});

jest.mock('../../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
  EventsOn: jest.fn(() => jest.fn()),
}));

jest.mock('../../hooks/useFileWatcher', () => ({
  useFileWatcher: jest.fn(),
}));

jest.mock('../../components/Editor', () => ({
  Editor: () => null,
}));

jest.mock('../../components/FileExplorer/useDirectoryTree', () => ({
  useDirectoryTree: () => ({ refetch: jest.fn() }),
}));

it('reflects the active workspace accent on the ide root', async () => {
  const defs = [
    { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
    { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
  ] as workspace.WorkspaceDef[];

  let container: HTMLElement;
  await act(async () => {
    ({ container } = render(<App />));
  });

  act(() => {
    useIDEStore.getState().setWorkspaces(defs);
    useIDEStore.getState().setActiveWorkspace('frontend');
  });

  await waitFor(() => {
    expect(container!.querySelector('[data-accent="frontend"]')).not.toBeNull();
  });
});
