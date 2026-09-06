/**
 * Task B5 — which root the bundle mounts.
 *
 * The two windows share one Vite bundle, so the branch has to be taken *before*
 * anything that owns the IDE is imported: a static `import App from './App'`
 * would evaluate the executing stores, the bridge and workspace persistence
 * inside the satellite window even though nothing ever renders them. These
 * tests therefore poison whole modules and mount for real, rather than checking
 * that a string selector returns the expected name.
 */

const OWNERS = [
  '../App',
  '../stores/golemStore',
  '../stores/ideStore',
  '../hooks/useGolemBridge',
  '../hooks/useKeyboardShortcuts',
  '../hooks/useWorkspacePersistence',
  '../utils/commands',
  '../components/CommandPalette/CommandPalette',
] as const;

const stopSatellite = jest.fn();
const relayActions = {
  send: jest.fn(),
  allowAndSend: jest.fn(),
  cancelRun: jest.fn(),
  retry: jest.fn(),
  updateQueued: jest.fn(),
  removeQueued: jest.fn(),
  select: jest.fn(),
  clear: jest.fn(),
  openConfig: jest.fn(),
};

function mockSatelliteRelay(): void {
  jest.doMock('../golem/windowSatellite', () => ({
    startGolemSatellite: () => stopSatellite,
    satelliteActions: () => relayActions,
    requestReDock: () => Promise.resolve(),
    retryGolemConnection: () => undefined,
  }));
}

const goTo = (path: string) => window.history.replaceState(null, '', path);

// React's own act, not Testing Library's: this file never renders a component
// itself, and importing RTL inside a test would register its hooks there.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `jest.resetModules()` gives every test a fresh React, so an `act` bound to
 * the copy this file imported at load time would not see the new renderer's
 * work and the assertions would run against an unflushed root.
 */
async function mountFresh(): Promise<void> {
  const { act } = await import('react');
  const { mountFirn } = await import('../entry');
  await act(async () => {
    await mountFirn();
  });
}

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  goTo('/');
});

it('names the satellite route for that exact hash and nothing else', async () => {
  const { selectRoot } = await import('../entry');
  expect(selectRoot('#/golem-window')).toBe('golem-window');
  expect(selectRoot('#/golem-window/')).toBe('ide');
  expect(selectRoot('#/golem-window?instance=2')).toBe('ide');
  expect(selectRoot('#/')).toBe('ide');
  expect(selectRoot('')).toBe('ide');
});

it('mounts the satellite without importing the IDE owner graph', async () => {
  for (const path of OWNERS)
    jest.doMock(path, () => {
      throw new Error(`the satellite route must not reach ${path}`);
    });
  mockSatelliteRelay();
  goTo('/#/golem-window');

  await mountFresh();

  expect(document.querySelector('[aria-label="Golem"]')).not.toBeNull();
  expect(document.title).toBe('Firn — Golem');
});

it('mounts the IDE for every other route without importing the satellite root', async () => {
  jest.doMock('../App', () => ({
    __esModule: true,
    default: () => <div data-testid="ide-root" />,
  }));
  jest.doMock('../components/GolemWindow/GolemWindowRoot', () => {
    throw new Error('the IDE route must not reach the satellite root');
  });

  await mountFresh();

  expect(document.querySelector('[data-testid="ide-root"]')).not.toBeNull();
});

it('reports a missing #root instead of mounting nothing', async () => {
  document.body.innerHTML = '';
  const { mountFirn } = await import('../entry');
  await expect(mountFirn()).rejects.toThrow(/#root/);
});
