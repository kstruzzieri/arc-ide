import {
  inferCommandWorkspaceType,
  pickWorkspaceForCommand,
  commandWorkspaceMismatch,
} from '../../utils/commandWorkspace';
import type { workspace } from '../../wails/bindings';

const ws = (id: string, type: string, name = id): workspace.WorkspaceDef =>
  ({
    id,
    name,
    relDir: id === 'project' ? '' : id,
    type,
    accent: 'frontend',
  }) as workspace.WorkspaceDef;

const defs = [
  ws('project', 'project', 'Project'),
  ws('frontend', 'frontend', 'Frontend'),
  ws('go', 'go', 'Go'),
];

describe('inferCommandWorkspaceType', () => {
  it.each([
    ['go test ./...', 'go'],
    ['npm run dev', 'frontend'],
    ['pnpm build', 'frontend'],
    ['pytest -q', 'python'],
    ['uv run app', 'python'],
    ['/usr/bin/go test', 'go'],
    ['VITE_KEY=1 npm run dev', 'frontend'],
  ])('%s -> %s', (cmd, expected) => {
    expect(inferCommandWorkspaceType(cmd)).toBe(expected);
  });

  it.each(['./run.sh', 'make build', 'docker compose up', 'sh -c "echo hi"', ''])(
    'infers nothing for wrapper/unknown command %s',
    (cmd) => {
      expect(inferCommandWorkspaceType(cmd)).toBeNull();
    }
  );
});

describe('pickWorkspaceForCommand', () => {
  it('picks the matching non-project workspace by command type', () => {
    expect(pickWorkspaceForCommand('go test ./...', defs, 'frontend')).toBe('go');
    expect(pickWorkspaceForCommand('npm run dev', defs, 'go')).toBe('frontend');
  });

  it('falls back when the command type is unknown', () => {
    expect(pickWorkspaceForCommand('./deploy.sh', defs, 'frontend')).toBe('frontend');
  });

  it('falls back when no workspace of the matching type exists', () => {
    const noGo = [ws('project', 'project'), ws('frontend', 'frontend')];
    expect(pickWorkspaceForCommand('go test', noGo, 'frontend')).toBe('frontend');
  });

  it('selects Node when it is the only JavaScript workspace', () => {
    const nodeOnly = [ws('project', 'project'), ws('node', 'node', 'Node')];
    expect(pickWorkspaceForCommand('npm run dev', nodeOnly, 'project')).toBe('node');
  });

  it('preserves an active Node fallback in a mixed JavaScript repository', () => {
    const mixedJavaScript = [
      ws('project', 'project'),
      ws('frontend', 'frontend', 'Frontend'),
      ws('node', 'node', 'Node'),
    ];
    expect(pickWorkspaceForCommand('npm run dev', mixedJavaScript, 'node')).toBe('node');
  });
});

describe('commandWorkspaceMismatch', () => {
  it('warns when a language command lands in a different-language workspace', () => {
    const msg = commandWorkspaceMismatch('go test ./...', ws('frontend', 'frontend', 'Frontend'));
    expect(msg).toContain('Go');
    expect(msg).toContain('Frontend');
  });

  it('does not warn when the command matches the workspace type', () => {
    expect(commandWorkspaceMismatch('npm run dev', ws('frontend', 'frontend'))).toBeNull();
  });

  it('does not warn when an npm command targets a Node workspace', () => {
    expect(commandWorkspaceMismatch('npm run dev', ws('node', 'node', 'Node'))).toBeNull();
  });

  it('labels Node when a Go command targets a Node workspace', () => {
    const msg = commandWorkspaceMismatch('go test ./...', ws('node', 'node', 'Node'));
    expect(msg).toContain('Go');
    expect(msg).toContain('Node');
  });

  it('does not warn for project/infra workspaces that can host anything', () => {
    expect(commandWorkspaceMismatch('go test', ws('project', 'project'))).toBeNull();
    expect(commandWorkspaceMismatch('go test', ws('infra', 'docker'))).toBeNull();
  });

  it('does not warn for unknown commands or a missing workspace', () => {
    expect(commandWorkspaceMismatch('./run.sh', ws('frontend', 'frontend'))).toBeNull();
    expect(commandWorkspaceMismatch('go test', undefined)).toBeNull();
  });
});
