import { useIDEStore } from '../../stores/ideStore';
import type { workspace } from '../../wails/bindings';

const defs = [
  { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
  { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
] as workspace.WorkspaceDef[];

describe('workspace identity store slice', () => {
  beforeEach(() => {
    useIDEStore.setState({ workspaces: [], activeWorkspaceId: 'project' });
  });

  it('setWorkspaces stores the list', () => {
    useIDEStore.getState().setWorkspaces(defs);
    expect(useIDEStore.getState().workspaces).toHaveLength(2);
  });

  it('setActiveWorkspace accepts a valid id', () => {
    useIDEStore.getState().setWorkspaces(defs);
    useIDEStore.getState().setActiveWorkspace('frontend');
    expect(useIDEStore.getState().activeWorkspaceId).toBe('frontend');
  });

  it('setActiveWorkspace falls back to project for an unknown id', () => {
    useIDEStore.getState().setWorkspaces(defs);
    useIDEStore.getState().setActiveWorkspace('nope');
    expect(useIDEStore.getState().activeWorkspaceId).toBe('project');
  });

  it('setWorkspaces resets active id when it disappears from the new list', () => {
    useIDEStore.getState().setWorkspaces(defs);
    useIDEStore.getState().setActiveWorkspace('frontend');
    useIDEStore.getState().setWorkspaces([defs[0]]); // frontend gone
    expect(useIDEStore.getState().activeWorkspaceId).toBe('project');
  });
});
