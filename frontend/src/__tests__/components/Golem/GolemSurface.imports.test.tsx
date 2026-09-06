/**
 * Task B4 — the surface's runtime dependency boundary.
 *
 * `GolemSurface` is rendered by the undocked window, which is a *satellite*: it
 * holds no conversation state, runs no bridge, and must never be able to call
 * the backend. That guarantee is about the module's whole transitive import
 * graph, not about the imports written at the top of the file — a helper three
 * modules down that happens to `import { useGolemStore }` would instantiate the
 * executing store the moment the satellite loads its chat surface.
 *
 * So this test does not read source text. It replaces each forbidden module
 * with one that throws on evaluation, then imports and renders the surface: if
 * anything in the graph reaches one, the import or the render explodes.
 */

import { render } from '@testing-library/react';
// Type-only, so it is erased: importing `parseGolemView` for real would pull
// `types/golem` — and with it the bindings — into this suite and make the guard
// fail on the fixture rather than on the surface. `GolemSurface.test.tsx` is
// where a projection is proven to be a legal wire payload; here TypeScript
// alone keeps the shape honest.
import type { GolemView } from '../../../types/golemWindow';

const FORBIDDEN = [
  '../../../stores/golemStore',
  '../../../stores/ideStore',
  '../../../hooks/useGolemBridge',
  '../../../hooks/useWorkspacePersistence',
  '../../../utils/commands',
  '../../../utils/editorSurface',
  '../../../wails/bindings',
] as const;

for (const path of FORBIDDEN) {
  jest.mock(path, () => {
    throw new Error(`GolemSurface must not reach ${path}`);
  });
}

const identity = { repoEpoch: 7, workspaceId: 'frontend', conversationId: 'conv-frontend' };

const noop = () => {};
const inertActions = {
  send: noop,
  allowAndSend: noop,
  cancelRun: noop,
  retry: noop,
  updateQueued: noop,
  removeQueued: noop,
  select: noop,
  clear: noop,
  openConfig: noop,
};

const view: GolemView = {
  bridgePhase: 'ready',
  bridgeError: null,
  hydratedIdentity: identity,
  selectedConversationId: identity.conversationId,
  composerFocusRevision: 0,
  processedThrough: 0,
  conversations: {
    [identity.conversationId]: {
      identity,
      workspaceLabel: 'Frontend',
      available: true,
      needsConsent: false,
      warnings: [],
      initError: null,
      destination: null,
      activeRunId: null,
      queuedTurns: [],
      transcript: [{ id: 'e1', runId: 'r1', kind: 'user', text: 'hello' }],
      runs: {},
      pendingConsentTurn: null,
      lastFailedTurn: false,
    },
  },
};

it('renders without any module that owns, executes or navigates the IDE', async () => {
  // Imported inside the test so a failure is this assertion, not a load error
  // in some unrelated suite — and after the mocks above are registered.
  const { GolemSurface } = await import('../../../components/Golem/GolemSurface');

  const { getByRole } = render(
    <GolemSurface
      view={view}
      draft=""
      onDraftChange={noop}
      actions={inertActions}
      frozen={false}
      composerPending={false}
      focusRevision={0}
      visible
    />
  );
  expect(getByRole('textbox', { name: /message golem/i })).toBeInTheDocument();
});
