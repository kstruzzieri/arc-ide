/**
 * Masthead profile select and the Configuration menu (#263 Slice C, spec
 * §4.8/§5.6): list fetch, selection guard, loading affordance, the visible
 * description, and the naming/bootstrap flows the menu owns.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';
import { confirmConfigClose } from '../../../components/GolemConfig/configCloseGuard';

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
  CancelGolemSettingsApply,
  ListGolemProfiles,
  LoadGolemProfile,
  PrepareGolemDestinationGrants,
  ReloadGolemSettings,
  SaveGolemProfileAs,
} from '../../../wails/bindings';

const REV = (c: string) => c.repeat(64);

// Copied verbatim from GolemConfigWorkspace.test.tsx (fixtures are copied, not
// imported across test files).
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

const emptyProjection = (state: string, sourceOrigin: string) => ({
  state,
  sourceOrigin,
  readOnly: false,
  editable: false,
  routes: [],
  models: [],
  providers: [],
  diagnostics: [],
});

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

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Configuration' }));
};

describe('Configuration menu', () => {
  beforeEach(() => jest.clearAllMocks());

  it('saves the applied configuration create-only and reports success', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/mine', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Profile saved.');
    // §4.8: Enter/Save issues CREATE-ONLY — {id, appliedRevision}, no
    // expectedRevision member at all.
    expect(SaveGolemProfileAs).toHaveBeenCalledWith({
      id: 'user/mine',
      appliedRevision: readyProjection.revision,
    });
    // The list refreshes so the new profile appears.
    expect((ListGolemProfiles as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces the durability warning on the nil-error saved path', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/mine', revision: REV('c') },
      warning: 'durability_uncertain',
    });
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/could not confirm the write reached disk/i);
  });

  it('refuses an invalid name inline without crossing Wails', async () => {
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'Bad Name!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That profile name is invalid.');
    expect(SaveGolemProfileAs).not.toHaveBeenCalled();
  });

  it('turns a create collision into revision acquisition and an explicit Overwrite', async () => {
    (SaveGolemProfileAs as jest.Mock)
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'profile_target' })
      .mockResolvedValueOnce({ status: 'saved', profile: { id: 'user/mine', revision: REV('d') } });
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Acquisition loaded the collider WITHOUT staging it…
    await screen.findByText(/already exists/i);
    expect(LoadGolemProfile).toHaveBeenCalledWith('user/mine');
    expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
      'applied'
    );
    // …and Overwrite binds {id, acquired revision, appliedRevision}.
    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    await screen.findByText('Profile saved.');
    expect(SaveGolemProfileAs).toHaveBeenLastCalledWith({
      id: 'user/mine',
      expectedRevision: REV('b'),
      appliedRevision: readyProjection.revision,
    });
  });

  it('an unreadable collider yields the choose-another-name outcome', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'conflict',
      conflict: 'profile_target',
    });
    (LoadGolemProfile as jest.Mock).mockResolvedValue({
      status: 'diagnostics',
      diagnostics: [{ code: 'config_invalid', profileId: 'user/mine' }],
    });
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/choose another name, or repair the file outside firn/i);
    expect(screen.queryByRole('button', { name: 'Overwrite' })).not.toBeInTheDocument();
  });

  it('a transport-rejected save gets its own recovery notice and never auto-retries', async () => {
    (SaveGolemProfileAs as jest.Mock).mockRejectedValue(new Error('transport down'));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/save result is unknown/i);
    expect(SaveGolemProfileAs).toHaveBeenCalledTimes(1);
  });

  it('save never touches the staged draft', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/mine', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    // Stage one change; the Apply bar appears.
    await user.click(screen.getByRole('button', { name: /edit route/i }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByText(/1 change waiting for Apply/i);

    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    // §4.8: the staged configuration draft is untouched.
    expect(screen.getByText(/1 change waiting for Apply/i)).toBeInTheDocument();
  });

  it('save leaves staged keys in the vault for the next Apply', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/mine', revision: REV('c') },
    });
    (ApplyGolemSettings as jest.Mock).mockResolvedValue({
      status: 'applied',
      projection: readyProjection,
    });
    await mountReady();
    const user = userEvent.setup();
    // Stage a key on the existing provider (flow per GolemConfigFlows.test.tsx:
    // Edit provider button, New API key field, Done stages it, Cancel closes
    // the row so the notice step's own Done control below is unambiguous).
    await user.click(screen.getByRole('button', { name: 'Edit provider llama-swap' }));
    await user.type(screen.getByLabelText('New API key'), 'sk-test-key');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalled());
    const request = (ApplyGolemSettings as jest.Mock).mock.calls[0][0] as {
      keys: Record<string, string>;
    };
    expect(request.keys).toEqual({ 'llama-swap': 'sk-test-key' });
  });

  it('starts from a curated profile through the submenu', async () => {
    // (The §4.6a dirty guard on this path is exercised by Task 6's select
    // guard test — the submenu routes through the same selectSource.)
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('curated/local'));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Start from curated' }));
    await user.click(screen.getByRole('button', { name: 'local' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        'curated/local'
      )
    );
    expect(LoadGolemProfile).toHaveBeenCalledWith('curated/local');
  });

  it('starts blank and lists the Blank draft option', async () => {
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Start blank' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        '__blank__'
      )
    );
    expect(screen.getByRole('option', { name: 'Blank draft' })).toBeInTheDocument();
  });

  // Ruling 13: a limited list blocks CREATE only (§5.6 scopes the profile
  // count limit to creation). Start blank is purely local and the curated
  // block always sorts inside the first maxProjectionEntries rows, so both
  // Start actions stay enabled — a limited list must never strand a
  // Missing-state user with zero bootstrap path.
  it('refuses create while the list is limited but leaves the Start actions enabled', async () => {
    // The parameterized helper mounts against the limited list directly — a
    // pre-set mock would be overwritten by the helper's own default.
    await mountReady(listResult({ status: 'limited' }));
    const user = userEvent.setup();
    await openMenu(user);
    expect(screen.getByRole('button', { name: 'Save applied as profile…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start from curated' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start blank' })).toBeEnabled();
    expect(screen.getByText('Too many profiles exist to create another.')).toBeInTheDocument();
    // The list-limited copy no longer gates Start at all.
    expect(screen.queryByText('Too many profiles to display.')).not.toBeInTheDocument();
    // Selection of LISTED rows stays allowed (§4.8).
    const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
    expect(select).not.toBeDisabled();
  });

  // Ruling 9(a). Task 6's `unavailable` list-state test could not fail:
  // `buildProfileSelectModel` renders `unloaded` and `unavailable` alike. The
  // menu's curated notice is where the state finally becomes observable.
  it('names the transport failure in the curated submenu when the list is unavailable', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
    (ListGolemProfiles as jest.Mock).mockRejectedValue(new Error('transport down'));
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    await screen.findByLabelText('Configuration source');
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Start from curated' }));
    expect(
      screen.getByText('Configuration service unavailable. Refresh before trying again.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'local' })).not.toBeInTheDocument();
  });

  // Ruling 9(b). `refreshProfileList`'s `status === 'diagnostics'` branch had
  // never been driven, and it is the ONE input that makes `unavailable`
  // distinguishable from `unloaded` on screen: a diagnostics list yields a
  // profile-domain sentence no other list state can produce.
  it('surfaces the profile diagnostic when the list itself answers diagnostics', async () => {
    await mountReady({ status: 'diagnostics', diagnostics: [{ code: 'io' }] });
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Start from curated' }));
    expect(screen.getByText('The profile could not be read or saved.')).toBeInTheDocument();
    expect(
      screen.queryByText('Configuration service unavailable. Refresh before trying again.')
    ).not.toBeInTheDocument();
  });

  it('while Missing the select shows only the applied-absent state and Start actions bootstrap it', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: emptyProjection('missing', 'none'),
    });
    (ListGolemProfiles as jest.Mock).mockResolvedValue(listResult());
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('curated/local'));
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    const select = (await screen.findByLabelText('Configuration source')) as HTMLSelectElement;
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());

    // §4.8: ONLY the applied-configuration-absent state — no optgroups, no
    // profile rows, even though the loaded list carries them.
    expect(
      within(select).getByRole('option', { name: 'No applied configuration' })
    ).toBeInTheDocument();
    expect(select.querySelector('optgroup')).toBeNull();
    expect(within(select).queryByRole('option', { name: 'local' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await openMenu(user);
    expect(screen.getByRole('button', { name: 'Save applied as profile…' })).toBeDisabled();
    expect(screen.getByText('Save needs a Ready applied configuration.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start blank' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start from curated' })).toBeEnabled();

    // A Start action stages a draft; the select then truthfully names that
    // draft source — as the selected (disabled) option, optgroups still absent.
    await user.click(screen.getByRole('button', { name: 'Start from curated' }));
    await user.click(screen.getByRole('button', { name: 'local' }));
    await waitFor(() => expect(select.value).toBe('curated/local'));
    expect(select.querySelector('optgroup')).toBeNull();
    const staged = within(select).getByRole('option', { name: 'local' }) as HTMLOptionElement;
    expect(staged.selected).toBe(true);
    expect(staged).toBeDisabled();
  });

  it('a failed selection from a blank draft returns to the blank draft', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue({
      status: 'diagnostics',
      diagnostics: [{ code: 'io' }],
    });
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Start blank' }));
    const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('__blank__'));

    await user.selectOptions(select, 'user/mine');
    // A blank draft is inherently unsaved work, so the §4.6a guard intercepts
    // the switch — confirm it, or the failing load never runs.
    await user.click(await screen.findByRole('button', { name: 'Discard & switch' }));
    await screen.findByText('The profile could not be read or saved.');
    // §4.8: back to the PRIOR source — the blank draft, not Applied.
    expect(select.value).toBe('__blank__');
    expect(screen.getByRole('option', { name: 'Blank draft' })).toBeInTheDocument();
  });

  it('a refresh AFTER acquisition never rewrites the frozen tuple', async () => {
    (SaveGolemProfileAs as jest.Mock)
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'profile_target' })
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'active_revision' });
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/already exists/i);

    // Keyboard-activated Refresh (no pointerdown, so the popover stays open)
    // loads a NEW applied revision AFTER acquisition completed — the tuple is
    // already frozen, so nothing may substitute the refreshed value in.
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: { ...readyProjection, revision: REV('9') },
    });
    screen.getByRole('button', { name: 'Refresh' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(ReloadGolemSettings).toHaveBeenCalledTimes(2));
    await screen.findByText(`rev ${REV('9').slice(0, 12)}`);
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    // The FROZEN tuple went out — the revision current when acquisition
    // completed, never the later refresh — and the honest active_revision
    // conflict surfaced.
    await screen.findByText('Configuration changed; Refresh and try again.');
    expect(SaveGolemProfileAs).toHaveBeenLastCalledWith({
      id: 'user/mine',
      expectedRevision: REV('b'),
      appliedRevision: readyProjection.revision,
    });
  });

  it('a refresh landing BEFORE acquisition completes freezes the NEW applied revision', async () => {
    // The ruling pins ACQUISITION time, not create-dispatch time: a Refresh
    // that settles while the collider load is still in flight is part of the
    // world the overwrite confirmation describes, so ITS revision freezes —
    // a create-dispatch capture (or a stale render closure) would freeze the
    // superseded one and manufacture a phantom active_revision conflict.
    (SaveGolemProfileAs as jest.Mock)
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'profile_target' })
      .mockResolvedValueOnce({ status: 'saved', profile: { id: 'user/mine', revision: REV('d') } });
    let resolveLoad: (value: unknown) => void = () => undefined;
    (LoadGolemProfile as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(LoadGolemProfile).toHaveBeenCalledWith('user/mine'));

    // Keyboard-activated Refresh moves the applied revision WHILE the
    // acquisition is still in flight.
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: { ...readyProjection, revision: REV('9') },
    });
    screen.getByRole('button', { name: 'Refresh' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(ReloadGolemSettings).toHaveBeenCalledTimes(2));
    await screen.findByText(`rev ${REV('9').slice(0, 12)}`);

    await act(async () => {
      resolveLoad(profileLoadResult('user/mine'));
      await Promise.resolve();
    });
    await user.click(await screen.findByRole('button', { name: 'Overwrite' }));
    await screen.findByText('Profile saved.');
    // The tuple froze the acquisition-completion revision — the refreshed one.
    expect(SaveGolemProfileAs).toHaveBeenLastCalledWith({
      id: 'user/mine',
      expectedRevision: REV('b'),
      appliedRevision: REV('9'),
    });
  });

  it('a delayed acquisition cannot resurrect an abandoned overwrite flow', async () => {
    let resolveLoad: (value: unknown) => void = () => undefined;
    (SaveGolemProfileAs as jest.Mock)
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'profile_target' })
      .mockResolvedValueOnce({
        status: 'saved',
        profile: { id: 'user/other', revision: REV('d') },
      });
    (LoadGolemProfile as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // The collision resolved; the collider acquisition is now pending. Abandon it.
    await waitFor(() => expect(LoadGolemProfile).toHaveBeenCalledWith('user/mine'));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    // The OLD acquisition finally resolves — into a dead generation: no
    // overwrite step may appear.
    await act(async () => {
      resolveLoad(profileLoadResult('user/mine'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start blank' })).toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: 'Overwrite' })).not.toBeInTheDocument();
    expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument();

    // A fresh naming flow proceeds untouched by the dead continuation.
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'other');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    expect(SaveGolemProfileAs).toHaveBeenLastCalledWith({
      id: 'user/other',
      appliedRevision: readyProjection.revision,
    });
  });

  it('a list turning limited while the popover is open refuses the pending create', async () => {
    let resolveList: (value: unknown) => void = () => undefined;
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
    (ListGolemProfiles as jest.Mock)
      .mockResolvedValueOnce(listResult()) // the mount fetch
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveList = resolve;
        })
      ); // the onOpen refresh, still in flight while naming opens
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    await screen.findByLabelText('Configuration source');
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');

    resolveList(listResult({ status: 'limited' }));
    // §4.8: the restriction lands on the OPEN popover's descendants, not only
    // the trigger.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(screen.getByText('Too many profiles exist to create another.')).toBeInTheDocument();
    // The handler is gated too, not only the control: submit the form directly.
    fireEvent.submit(screen.getByLabelText('Profile name').closest('form') as HTMLFormElement);
    expect(SaveGolemProfileAs).not.toHaveBeenCalled();
  });

  it('a limited list arriving mid-flow leaves the standing Overwrite available', async () => {
    // §5.6: while the list is limited, CREATION is refused but replacing an
    // existing profile by exact id/revision stays open — Overwrite is a replace.
    (SaveGolemProfileAs as jest.Mock)
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'profile_target' })
      .mockResolvedValueOnce({ status: 'saved', profile: { id: 'user/mine', revision: REV('d') } });
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/already exists/i);

    (ListGolemProfiles as jest.Mock).mockResolvedValue(listResult({ status: 'limited' }));
    screen.getByRole('button', { name: 'Refresh' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect((ListGolemProfiles as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3)
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Overwrite' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    await screen.findByText('Profile saved.');
  });

  it('the close handshake drains until stable: a write dispatched during its wait still holds it', async () => {
    // The round-2 finding's interleaving, verbatim: "Save pending → Close
    // awaits current aggregate → user starts a grant RPC → close acknowledges
    // while that RPC is pending." The later write must keep the draft clean
    // (a dirty draft stalls the close on the §4.6a discard prompt and masks
    // the drain assertion), so this test drives the grant-only approval —
    // the shipped clean-draft write — as that later registration.
    let resolveSave: (value: unknown) => void = () => undefined;
    (SaveGolemProfileAs as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    let resolveGrants: (value: unknown) => void = () => undefined;
    (PrepareGolemDestinationGrants as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveGrants = resolve;
      })
    );
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Close starts while ONLY the deferred Save is registered: a Save that
    // never entered the close-wait set at all would let the handshake
    // acknowledge immediately, right here.
    let closed = false;
    const close = confirmConfigClose('close').then((ok) => {
      closed = true;
      return ok;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);

    // A LATER registered write is dispatched WHILE the handshake is already
    // awaiting. It must be one that keeps the draft CLEAN — staging + Apply
    // would dirty the draft and stall the close on the §4.6a discard prompt,
    // masking the drain assertion. The grant-only approval (spec D13) is the
    // shipped clean-draft write: it approves destinations for the ACTIVE
    // configuration, writes no document, and never touches the draft. Its
    // Prepare call is deferred by the mock (resolveGrants below).
    await user.click(screen.getByRole('button', { name: 'Approve missing destinations' }));
    await waitFor(() => expect(PrepareGolemDestinationGrants).toHaveBeenCalled());

    await act(async () => {
      resolveSave({ status: 'saved', profile: { id: 'user/mine', revision: REV('c') } });
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A drain-ONCE handshake acknowledges here: the promise it captured held
    // only the Save, and the grant approval it never saw is still in flight.
    expect(closed).toBe(false);

    await act(async () => {
      resolveGrants({ status: 'none' });
      await Promise.resolve();
    });
    await expect(close).resolves.toBe(true);
  });

  it('registerWrite composes: an EARLIER write still holds the close even after a LATER write settles first', async () => {
    // Review finding on Task 7: the drain-until-stable loop above re-awaits
    // whenever writeRef.current changes identity DURING its await, so a
    // single-slot (non-composing) writeRef also passes that test — the loop
    // notices the Save→grant overwrite mid-wait and re-awaits the grant. That
    // masks whether registerWrite's Promise.all composition is doing
    // anything. This test inverts the settle order so composition is the
    // ONLY thing that can hold the close: the LATER-registered write (the
    // grant approval) settles FIRST, before the close handshake ever starts.
    // A non-composing assignment would leave writeRef.current pointing only
    // at the already-resolved grant by the time confirmConfigClose captures
    // it, so the drain loop's first await resolves immediately and the close
    // acknowledges with the EARLIER write (Save) still in flight — the exact
    // §5.5 violation registerWrite exists to prevent.
    let resolveSave: (value: unknown) => void = () => undefined;
    (SaveGolemProfileAs as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    let resolveGrants: (value: unknown) => void = () => undefined;
    (PrepareGolemDestinationGrants as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveGrants = resolve;
      })
    );
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The LATER write registers while the EARLIER (Save) write is still
    // pending — same as the drain test above.
    await user.click(screen.getByRole('button', { name: 'Approve missing destinations' }));
    await waitFor(() => expect(PrepareGolemDestinationGrants).toHaveBeenCalled());

    // Unlike the drain test above: the LATER write settles FIRST, and the
    // microtask queue is flushed, BEFORE the close handshake starts at all.
    await act(async () => {
      resolveGrants({ status: 'none' });
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only now does the close handshake begin — it captures whatever
    // writeRef.current holds at THIS moment.
    let closed = false;
    const close = confirmConfigClose('close').then((ok) => {
      closed = true;
      return ok;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // With composition, the captured slot still depends on the unresolved
    // Save. Without it, the slot holds only the already-resolved grant and
    // this assertion fails.
    expect(closed).toBe(false);

    await act(async () => {
      resolveSave({ status: 'saved', profile: { id: 'user/mine', revision: REV('c') } });
      await Promise.resolve();
    });
    await expect(close).resolves.toBe(true);
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Start blank' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configuration' })).toHaveFocus();
  });

  // Fix for the review finding: a `role="status"` mounted together with its
  // text is generally never announced. The distinguishing proof against that
  // bug is exactly this ordering — the channel must exist, empty, BEFORE any
  // notice, and only then receive the text.
  it('the announcement region exists before any notice and receives the notice text after', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/mine', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    // Pre-exists, empty — captured before any save action, the same node
    // instance is checked again below (it is never unmounted).
    const region = screen.getByTestId('golem-profile-menu-announcement');
    expect(region).toHaveTextContent('');

    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    expect(region).toHaveTextContent('Profile saved.');
  });

  // Fix for the review finding: a step transition dropped focus to <body>,
  // leaving a keyboard user to Tab from the document start. Mirrors
  // RoutingCard's pendingFocus pattern.
  it('focuses the name field on entering the naming step', async () => {
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    expect(screen.getByLabelText('Profile name')).toHaveFocus();
  });

  it('focuses the Overwrite confirm button on entering the overwrite step', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValueOnce({
      status: 'conflict',
      conflict: 'profile_target',
    });
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/already exists/i);
    expect(screen.getByRole('button', { name: 'Overwrite' })).toHaveFocus();
  });

  it('focuses Done on entering the notice step', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/mine', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });
});

describe('availability matrix (§4.8)', () => {
  beforeEach(() => jest.clearAllMocks());

  const mountState = async (projection: unknown, list: unknown = listResult()) => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({ busy: false, projection });
    (ListGolemProfiles as jest.Mock).mockResolvedValue(list);
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    await screen.findByLabelText('Configuration source');
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
  };

  // §5.6: `revision` is present exactly for Ready/Limited documents — a
  // revision-less Limited projection is rejected by the shipped parser and the
  // mount would never establish the state it advertises.
  const matrixProjection = (state: 'invalid' | 'limited', origin: string) =>
    state === 'limited'
      ? { ...emptyProjection('limited', origin), revision: REV('9') }
      : emptyProjection('invalid', origin);

  it.each([
    ['invalid', 'env'],
    ['limited', 'user_config'],
  ] as const)(
    'while %s: Save refused, Start refused, profile options disabled',
    async (state, origin) => {
      await mountState(matrixProjection(state, origin));
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Configuration' }));
      expect(screen.getByRole('button', { name: 'Save applied as profile…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Start blank' })).toBeDisabled();
      expect(
        screen.getByText('Unavailable while the configuration is Invalid or Limited.')
      ).toBeInTheDocument();
      const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
      const option = within(select).getByRole('option', { name: 'local' });
      expect(option).toBeDisabled();
    }
  );

  it('while ready: everything is offered', async () => {
    await mountState(readyProjection);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Configuration' }));
    expect(screen.getByRole('button', { name: 'Save applied as profile…' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start from curated' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start blank' })).toBeEnabled();
  });

  it('while a selection load is in flight the select disables with the affordance', async () => {
    let resolveLoad: (value: unknown) => void = () => undefined;
    (LoadGolemProfile as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    await mountState(readyProjection);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'user/mine');
    expect(screen.getByLabelText('Configuration source')).toBeDisabled();
    expect(screen.getByText('Loading profile…')).toBeInTheDocument();
    resolveLoad(profileLoadResult('user/mine'));
    await waitFor(() => expect(screen.getByLabelText('Configuration source')).toBeEnabled());
  });

  it('while a Save is in flight the other profile actions disable', async () => {
    let resolveSave: (value: unknown) => void = () => undefined;
    (SaveGolemProfileAs as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    await mountState(readyProjection);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Configuration' }));
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByLabelText('Configuration source')).toBeDisabled();
    resolveSave({ status: 'saved', profile: { id: 'user/mine', revision: REV('c') } });
    await screen.findByText('Profile saved.');
  });
});

describe('select shows the source (§4.8 invariants)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('successful Apply returns the select to Applied', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    (ApplyGolemSettings as jest.Mock).mockResolvedValue({
      status: 'applied',
      projection: readyProjection,
    });
    await mountReady();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'user/mine');
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        'user/mine'
      )
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        'applied'
      )
    );
  });

  it('Discard returns the select to Applied', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    (CancelGolemSettingsApply as jest.Mock).mockResolvedValue({ status: 'cancelled' });
    await mountReady();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'user/mine');
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        'user/mine'
      )
    );
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        'applied'
      )
    );
  });

  it('a list-only refresh that lost the selected profile retains it as the selected, disabled option', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/other', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    const select = screen.getByLabelText('Configuration source') as HTMLSelectElement;
    await user.selectOptions(select, 'user/mine');
    await waitFor(() => expect(select.value).toBe('user/mine'));

    // The list refresh a successful Save triggers — a LIST-ONLY refresh, no
    // §4.6a transition — no longer carries user/mine.
    (ListGolemProfiles as jest.Mock).mockResolvedValue(
      listResult({
        profiles: [
          {
            id: 'curated/local',
            description: 'Vetted local lineup',
            curated: true,
            revision: REV('a'),
          },
        ],
      })
    );
    await user.click(screen.getByRole('button', { name: 'Configuration' }));
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'other');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');

    // §4.8: retained as the SELECTED option, marked unavailable and not
    // re-choosable — never a snap to a lie. This is the rendered proof the
    // pure-model rule stands in the real select.
    expect(select.value).toBe('user/mine');
    const retained = within(select).getByRole('option', {
      name: 'mine (unavailable)',
    }) as HTMLOptionElement;
    expect(retained.selected).toBe(true);
    expect(retained).toBeDisabled();
  });

  it('a list refresh alone never changes the selected source', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/other', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Configuration source'), 'user/mine');
    await waitFor(() =>
      expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
        'user/mine'
      )
    );
    // A successful save triggers refreshProfileList (a list refresh with no
    // §4.6a transition) — the selection must not move. Save requires ready
    // state, which the profile-source draft still satisfies via projection.
    await user.click(screen.getByRole('button', { name: 'Configuration' }));
    await user.click(screen.getByRole('button', { name: 'Save applied as profile…' }));
    await user.type(screen.getByLabelText('Profile name'), 'other');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    expect((screen.getByLabelText('Configuration source') as HTMLSelectElement).value).toBe(
      'user/mine'
    );
  });
});
