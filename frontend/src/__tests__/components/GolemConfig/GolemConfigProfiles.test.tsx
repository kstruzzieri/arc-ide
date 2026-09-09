/**
 * Masthead profile select (#263 Slice C, spec §4.8/§5.6): list fetch,
 * selection guard, loading affordance, and the visible description.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';

jest.mock('../../../wails/bindings', () => ({
  ReloadGolemSettings: jest.fn(),
  PrepareGolemDestinationGrants: jest.fn(),
  ListGolemProfiles: jest.fn(),
  LoadGolemProfile: jest.fn(),
  SaveGolemProfileAs: jest.fn(),
  CancelGolemSettingsApply: jest.fn(),
  ApplyGolemSettings: jest.fn(),
  CreateGolemSettings: jest.fn(),
  ConfirmGolemSettingsApply: jest.fn(),
}));
import {
  ApplyGolemSettings,
  ListGolemProfiles,
  LoadGolemProfile,
  ReloadGolemSettings,
  SaveGolemProfileAs,
} from '../../../wails/bindings';

const REV = (c: string) => c.repeat(64);

// Copied verbatim from GolemConfigWorkspace.test.tsx (fixtures are copied, not
// imported across test files). Only the pieces this suite actually exercises
// are carried over: `emptyProjection` is unused here.
const testRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const model = (over: Record<string, unknown> = {}) => ({
  role: 'agent-m',
  modelName: 'qwen3-coder-30b',
  provider: 'llama-swap',
  type: 'dense',
  effectiveCapabilities: ['chat', 'stream', 'tool_call'],
  capabilityFacts: {
    caps: ['chat', 'stream', 'tool_call'],
    knownCaps: ['chat', 'generate', 'stream', 'embed', 'tool_call', 'thinking', 'insert'],
  },
  exposedCapabilities: ['chat', 'stream', 'tool_call'],
  thinkMode: 'auto',
  routedUseCases: ['agent'],
  hasThinkTags: false,
  hasSlots: false,
  removable: false,
  ...over,
});

const readyProjection = {
  state: 'ready',
  sourceOrigin: 'user_config',
  revision: testRevision,
  readOnly: false,
  editable: true,
  routes: [{ useCase: 'agent', role: 'agent-m' }],
  models: [model()],
  providers: [
    {
      name: 'llama-swap',
      endpoint: 'http://127.0.0.1:9292/v1',
      classification: 'local',
      apiFormat: 'openai-compat',
      credentialState: 'none',
    },
  ],
  diagnostics: [],
};

const listResult = (over: Partial<{ status: string; profiles: unknown[] }> = {}) => ({
  status: 'loaded',
  profiles: [
    { id: 'curated/local', description: 'Vetted local lineup', curated: true, revision: REV('a') },
    { id: 'user/mine', curated: false },
  ],
  ...over,
});

// `extraProvider` appends a marker provider row so a test can prove WHICH
// preview is on screen (providers stay in ascending name order: 'llama-swap'
// < 'preview-extra').
const profileLoadResult = (profileId: string, extraProvider?: string) => ({
  status: 'loaded',
  profileId,
  sourceRevision: REV('b'),
  projection: {
    state: 'ready',
    readOnly: false,
    editable: true,
    routes: readyProjection.routes,
    models: readyProjection.models,
    providers: [
      ...readyProjection.providers.map((p) => ({ ...p, credentialState: 'none' })),
      ...(extraProvider === undefined
        ? []
        : [
            {
              name: extraProvider,
              endpoint: 'http://127.0.0.1:9999/v1',
              classification: 'local',
              apiFormat: 'openai-compat',
              credentialState: 'none',
            },
          ]),
    ],
    diagnostics: [],
  },
});

// Parameterized so a test can mount against a different LIST projection
// without the helper overwriting its mock (the default is the loaded list).
const mountReady = async (list: unknown = listResult()) => {
  (ReloadGolemSettings as jest.Mock).mockResolvedValue({
    busy: false,
    projection: readyProjection,
  });
  (ListGolemProfiles as jest.Mock).mockResolvedValue(list);
  render(<GolemConfigWorkspace onClose={jest.fn()} />);
  await screen.findByLabelText('Configuration source');
  await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
};

// jsdom ships <dialog> without its modal methods; the merge surface's tests
// stand it up the same way (see GolemConfigFlows.test.tsx).
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

describe('masthead profile select', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists Applied, Curated, and Yours, and names the current source', async () => {
    await mountReady();
    const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
    expect(select.value).toBe('applied');
    expect(within(select).getByRole('group', { name: 'Curated' })).toBeInTheDocument();
    expect(within(select).getByRole('group', { name: 'Yours' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'local' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'mine' })).toBeInTheDocument();
  });

  it('selecting a profile stages the preview and never writes', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'user/mine');
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        'user/mine'
      )
    );
    expect(LoadGolemProfile).toHaveBeenCalledWith('user/mine');
    expect(ApplyGolemSettings).not.toHaveBeenCalled();
    expect(SaveGolemProfileAs).not.toHaveBeenCalled();
  });

  it('a failed selection load surfaces bounded copy and keeps the prior source', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue({
      status: 'diagnostics',
      diagnostics: [{ code: 'not_found', profileId: 'user/mine' }],
    });
    await mountReady();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'user/mine');
    await screen.findByText('That profile no longer exists.');
    expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
      'applied'
    );
  });

  it('a failed selection from a profile source restores that source AND its preview', async () => {
    (LoadGolemProfile as jest.Mock)
      .mockResolvedValueOnce(profileLoadResult('curated/local', 'preview-extra'))
      .mockResolvedValueOnce({
        status: 'diagnostics',
        diagnostics: [{ code: 'not_found', profileId: 'user/mine' }],
      });
    await mountReady();
    const user = userEvent.setup();
    const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
    await user.selectOptions(select, 'curated/local');
    await waitFor(() => expect(select.value).toBe('curated/local'));
    // The curated preview is on screen: its marker provider row renders.
    // (`findByText(/preview-extra/)` is ambiguous here — ProvidersCard also
    // renders the same name into an "Edit provider preview-extra" srOnly
    // label — so the row's own test id proves it unambiguously instead.)
    await screen.findByTestId('provider-row-preview-extra');

    await user.selectOptions(select, 'user/mine');
    // A profile source is inherently unsaved work, so the §4.6a guard
    // intercepts the switch — confirm it, or the failing load never runs.
    await user.click(await screen.findByRole('button', { name: 'Discard & switch' }));
    await screen.findByText('That profile no longer exists.');
    // §4.8: the select returns to the PRIOR source — never a silent snap to
    // Applied — and the prior source's clean preview is back on screen.
    expect(select.value).toBe('curated/local');
    expect(screen.getByTestId('provider-row-preview-extra')).toBeInTheDocument();
  });

  it('shows the selected profile description as visible text', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('curated/local'));
    await mountReady();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'curated/local');
    await screen.findByText('Vetted local lineup');
    const select = screen.getByLabelText('Configuration source');
    expect(select).toHaveAttribute('aria-describedby', 'golem-profile-select-desc');
  });

  // Review finding 1 (Task 6): `buildProfileSelectModel` renders `{kind:
  // 'unloaded'}` and `{kind:'unavailable'}` identically — both yield zero
  // optgroup rows, an 'applied' value, and an empty description
  // (profileSelect.ts `rows`/`listed` derivation) — so a rejected fetch
  // cannot be told apart from one that simply hasn't resolved yet by
  // anything this test can observe. It does NOT prove the state reached
  // `unavailable`; it proves only that a rejected list fetch never crashes
  // the masthead and never disturbs the selected source. The assertion that
  // actually discriminates `unavailable` (the curated notice text) belongs
  // to Task 7, once the Configuration menu renders
  // `profileList.kind === 'unavailable' ? profileList.message : …`.
  it('a rejected list fetch leaves the masthead usable and the source applied', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
    (ListGolemProfiles as jest.Mock).mockRejectedValue(new Error('transport down'));
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    const select = (await screen.findByLabelText('Configuration source')) as HTMLSelectElement;
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
    expect(select.value).toBe('applied');
    expect(within(select).queryByRole('group', { name: 'Curated' })).not.toBeInTheDocument();
  });

  it('guards a source switch while work is unsaved', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    // Dirty the draft through a real editor staging (reuse the flow used by
    // GolemConfigFlows.test.tsx: open the chat route editor and press Done).
    await user.click(screen.getByRole('button', { name: /edit route/i }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'user/mine');
    // §4.6a: the prompt intercepts; Keep editing cancels the switch.
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(LoadGolemProfile).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
      'applied'
    );
  });

  // Review finding 2 (Task 6): `refreshProfileList` fires on mount AND from
  // both branches of `refresh()`, so overlapping fetches are reachable in
  // normal use. Without the generation guard, a slow first response that
  // lands after a faster, newer one would repaint the options with stale
  // data.
  it('drops a stale list response that lands after a newer one already repainted', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
    let resolveFirst!: (value: unknown) => void;
    (ListGolemProfiles as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(listResult({ profiles: [{ id: 'user/second', curated: false }] }));

    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    // Wait for the ready state so Refresh is enabled, then confirm the first
    // (mount) list fetch is the one still in flight.
    await screen.findByTestId('provider-row-llama-swap');
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalledTimes(1));

    const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
    const user = userEvent.setup();
    // Refresh triggers a second, overlapping `refreshProfileList` call while
    // the first is still pending.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalledTimes(2));
    // The second (newer) call resolves on its own and repaints the options.
    await waitFor(() =>
      expect(within(select).queryByRole('option', { name: 'second' })).toBeInTheDocument()
    );

    // Now the FIRST (older, superseded) call resolves with a DIFFERENT list.
    // The generation guard must drop it.
    await act(async () => {
      resolveFirst(listResult({ profiles: [{ id: 'user/first', curated: false }] }));
      await Promise.resolve();
    });

    expect(within(select).queryByRole('option', { name: 'second' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'first' })).not.toBeInTheDocument();
  });

  // Review finding 3 (Task 6): `selectSource`'s `current` and
  // `buildProfileSelectModel`'s `value` must derive from the same
  // `sourceSelectValue` mapping. If they ever diverged, re-selecting the
  // ALREADY active profile source would stop no-opping and would re-issue
  // `LoadGolemProfile` on every reselection of the current value.
  it('re-selecting the already active profile source is a no-op', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
    await user.selectOptions(select, 'user/mine');
    await waitFor(() => expect(select.value).toBe('user/mine'));
    expect(LoadGolemProfile).toHaveBeenCalledTimes(1);

    await user.selectOptions(select, 'user/mine');
    expect(LoadGolemProfile).toHaveBeenCalledTimes(1);
  });
});
