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

/** #312: the picker replaced the native select. [C3] Query the trigger by ROLE — while the
 *  list is open the listbox answers to the label "Source" too. */
const sourceTrigger = () => screen.getByRole('button', { name: 'Source' });
/** Choose an option by name, optionally inside a group; closes the list afterwards even when
 *  the option was disabled (a disabled click leaves the list open). */
const pickSource = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp,
  group?: string
) => {
  await user.click(sourceTrigger());
  const list = await screen.findByRole('listbox', { name: 'Source' });
  const scope =
    group === undefined ? within(list) : within(within(list).getByRole('group', { name: group }));
  await user.click(scope.getByRole('option', { name }));
  if (screen.queryByRole('listbox', { name: 'Source' }) !== null) await user.keyboard('{Escape}');
};
const sourceValue = () => sourceTrigger().getAttribute('data-value');

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
  await screen.findByRole('button', { name: 'Source' });
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
    const user = userEvent.setup();
    expect(sourceValue()).toBe('applied');
    await user.click(sourceTrigger());
    const list = screen.getByRole('listbox', { name: 'Source' });
    expect(within(list).getByRole('group', { name: 'Curated' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'Yours' })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'local' })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'mine' })).toBeInTheDocument();
  });

  it('selecting a profile stages the preview and never writes', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, /mine/, 'Yours');
    await waitFor(() => expect(sourceValue()).toBe('user/mine'));
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
    await pickSource(user, /mine/, 'Yours');
    await screen.findByText('That profile no longer exists.');
    expect(sourceValue()).toBe('applied');
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
    await pickSource(user, 'local', 'Curated');
    await waitFor(() => expect(sourceValue()).toBe('curated/local'));
    // The curated preview is on screen: its marker provider row renders.
    // (`findByText(/preview-extra/)` is ambiguous here — ProvidersCard also
    // renders the same name into an "Edit provider preview-extra" srOnly
    // label — so the row's own test id proves it unambiguously instead.)
    await screen.findByTestId('provider-row-preview-extra');

    await pickSource(user, /mine/, 'Yours');
    // A profile source is inherently unsaved work, so the §4.6a guard
    // intercepts the switch — confirm it, or the failing load never runs.
    await user.click(await screen.findByRole('button', { name: 'Discard & switch' }));
    await screen.findByText('That profile no longer exists.');
    // §4.8: the select returns to the PRIOR source — never a silent snap to
    // Applied — and the prior source's clean preview is back on screen.
    expect(sourceValue()).toBe('curated/local');
    expect(screen.getByTestId('provider-row-preview-extra')).toBeInTheDocument();
  });

  it('shows the selected profile description as visible text', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('curated/local'));
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, 'local', 'Curated');
    await screen.findByText('Vetted local lineup');
    expect(sourceTrigger()).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('golem-profile-select-desc')
    );
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
    await screen.findByRole('button', { name: 'Source' });
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
    expect(sourceValue()).toBe('applied');
    const user = userEvent.setup();
    await user.click(sourceTrigger());
    expect(
      within(screen.getByRole('listbox', { name: 'Source' })).queryByRole('group', {
        name: 'Curated',
      })
    ).not.toBeInTheDocument();
  });

  it('returns focus to the Source trigger once a pick lands', async () => {
    // [F3] The picker's own close focuses the trigger, but the trigger is DISABLED while
    // the load is in flight — focus falls to <body> there. The start outcome is what
    // brings it back, in the commit that re-enables the control.
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('curated/local'));
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, 'local', 'Curated');
    await waitFor(() => expect(sourceValue()).toBe('curated/local'));
    await waitFor(() => expect(sourceTrigger()).toHaveFocus());
  });

  it('leaves focus on the trigger, and does not steal it later, when the guard refuses', async () => {
    // [K1] `Keep editing` refuses the start. The picker's OWN close already restored
    // the trigger before the guard opened, and the dialog hands it back there — so the
    // trigger legitimately holds focus. What must not happen is a later,
    // outcome-driven steal from wherever the user went next.
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /edit route/i }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await pickSource(user, /mine/, 'Yours');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(sourceValue()).toBe('applied');
    expect(LoadGolemProfile).not.toHaveBeenCalled();
    expect(sourceTrigger()).toHaveFocus();

    const refresh = screen.getByRole('button', { name: 'Refresh' });
    refresh.focus();
    await act(async () => {}); // flush any pending focus effect
    expect(refresh).toHaveFocus();
  });

  it('returns focus to the Source trigger when the pick FAILS', async () => {
    // [K1] The failure path is where focus was actually stranded: the picker closed,
    // the trigger was disabled for the load, and the refusal notice arrived with focus
    // on <body>. The notice is no use to a reader who cannot get back to the control.
    (LoadGolemProfile as jest.Mock).mockResolvedValue({
      status: 'diagnostics',
      diagnostics: [{ code: 'not_found', profileId: 'user/mine' }],
    });
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, /mine/, 'Yours');
    await screen.findByText('That profile no longer exists.');
    expect(sourceValue()).toBe('applied');
    await waitFor(() => expect(sourceTrigger()).toHaveFocus());
  });

  it('re-adopts the profile a START FROM entry names even when it is already the source', async () => {
    // [K3] `selectSource` short-circuits on `value === current`, so START FROM Curated
    // local was a silent no-op once `curated/local` WAS the source — exactly when a
    // user reaches for it, to throw a bad draft away and start over from that profile.
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('curated/local'));
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, 'local', 'Curated');
    await waitFor(() => expect(sourceValue()).toBe('curated/local'));
    await user.click(screen.getByRole('button', { name: /edit route/i }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByTestId('golem-config-draft')).toBeInTheDocument();
    (LoadGolemProfile as jest.Mock).mockClear();

    await pickSource(user, /^Curated local/, 'Start from');
    // §4.6a still guards it: the staged work is discarded, not silently dropped.
    await user.click(await screen.findByRole('button', { name: 'Discard & switch' }));
    await waitFor(() => expect(LoadGolemProfile).toHaveBeenCalledWith('curated/local'));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('golem-config-draft')).queryByRole('button', {
          name: /route/,
        })
      ).toBeNull()
    );
  });

  // [W3] §3.3 counts the replacement source as a change, so the guard fires on a
  // draft holding nothing else. The shipped copy then claimed staged changes and
  // an API key were being dropped — neither existed.
  it('names only the source when the source is the only thing the draft replaces', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('curated/local'));
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, 'local', 'Curated');
    await waitFor(() => expect(sourceValue()).toBe('curated/local'));

    await pickSource(user, /mine/, 'Yours');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'This draft only replaces the source; switching drops that replacement. Nothing has been written, and the file on disk does not change.'
    );
    expect(dialog).not.toHaveTextContent(/API key/);

    // One staged change and the shipped discard copy is back, key sentence and all.
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await user.click(screen.getByRole('button', { name: /edit route/i }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await pickSource(user, /mine/, 'Yours');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'The staged changes and any API key you entered are dropped.'
    );
  });

  it('guards a source switch while work is unsaved', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    // Dirty the draft through a real editor staging (reuse the flow used by
    // GolemConfigFlows.test.tsx: open the chat route editor and press Done).
    await user.click(screen.getByRole('button', { name: /edit route/i }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await pickSource(user, /mine/, 'Yours');
    // §4.6a: the prompt intercepts; Keep editing cancels the switch.
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(LoadGolemProfile).not.toHaveBeenCalled();
    expect(sourceValue()).toBe('applied');
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
      .mockResolvedValueOnce(listResult({ profiles: [{ id: 'user/second', curated: false }] }))
      // #312: opening the picker itself fires another `refreshProfileList` call
      // (its `onOpen`), a third call this test's original two-call mock chain
      // never anticipated — give every call from here on the same 'second'
      // list so the picker-open probe below settles predictably.
      .mockResolvedValue(listResult({ profiles: [{ id: 'user/second', curated: false }] }));

    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    // Wait for the ready state so Refresh is enabled, then confirm the first
    // (mount) list fetch is the one still in flight.
    await screen.findByTestId('provider-row-llama-swap');
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalledTimes(1));

    const user = userEvent.setup();
    // Refresh triggers a second, overlapping `refreshProfileList` call while
    // the first is still pending.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalledTimes(2));
    await user.click(sourceTrigger());
    const list = screen.getByRole('listbox', { name: 'Source' });
    // The second (newer) call resolves on its own and repaints the options.
    await waitFor(() =>
      expect(within(list).queryByRole('option', { name: 'second' })).toBeInTheDocument()
    );

    // Now the FIRST (older, superseded) call resolves with a DIFFERENT list.
    // The generation guard must drop it.
    await act(async () => {
      resolveFirst(listResult({ profiles: [{ id: 'user/first', curated: false }] }));
      await Promise.resolve();
    });

    expect(within(list).queryByRole('option', { name: 'second' })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: 'first' })).not.toBeInTheDocument();
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
    await pickSource(user, /mine/, 'Yours');
    await waitFor(() => expect(sourceValue()).toBe('user/mine'));
    expect(LoadGolemProfile).toHaveBeenCalledTimes(1);

    await pickSource(user, /mine/, 'Yours');
    expect(LoadGolemProfile).toHaveBeenCalledTimes(1);
  });
});

/** #312: the trigger opens the naming step directly — no intermediate item. */
const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Save as profile…' }));
};

describe('Save as profile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is a plain masthead button with no Start actions behind it', async () => {
    await mountReady();
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save as profile…' }));
    expect(screen.getByRole('group', { name: 'Save as profile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start blank' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start from curated' })).toBeNull();
    // The naming field is the first step: nothing else stands between the button and the name.
    expect(screen.getByLabelText('Profile name')).toHaveFocus();
    // The popover names its scope: the APPLIED configuration, never the staged draft.
    expect(
      screen.getByText(
        'Saves the applied configuration on disk as a named profile. Staged edits are not included until you Apply.'
      )
    ).toBeInTheDocument();
  });

  it('names the reason while disabled', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: emptyProjection('missing', 'none'),
    });
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    const save = await screen.findByRole('button', { name: 'Save as profile…' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Nothing to save until a configuration is applied.');
  });

  it('keeps the Save popover open when the Source picker handles Escape', async () => {
    // [X7] SaveProfileButton closes on a DOCUMENT-level Escape. The picker handles its
    // own Escape first and must stop it there, or dismissing the list also throws away
    // a half-typed profile name.
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    sourceTrigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox', { name: 'Source' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Source' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Save as profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Profile name')).toHaveValue('mine');
  });

  it('names its own in-flight save as the reason the trigger is disabled', async () => {
    // [F5] `pending` is the component's OWN flow bit; the workspace's `reason` cannot
    // see it, so without a local fallback the disabled trigger carried an empty title.
    (SaveGolemProfileAs as jest.Mock).mockImplementation(() => new Promise(() => {}));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const trigger = screen.getByRole('button', { name: 'Save as profile…' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'A save is already in progress.');
  });

  it('saves the applied configuration create-only and reports success', async () => {
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/mine', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
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
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/could not confirm the write reached disk/i);
  });

  it('refuses an invalid name inline without crossing Wails', async () => {
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
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
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Acquisition loaded the collider WITHOUT staging it…
    await screen.findByText(/already exists/i);
    expect(LoadGolemProfile).toHaveBeenCalledWith('user/mine');
    expect(sourceValue()).toBe('applied');
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
    await screen.findByText(/1 staged change/i);

    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    // §4.8: the staged configuration draft is untouched.
    expect(screen.getByText(/1 staged change/i)).toBeInTheDocument();
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
    const save = screen.getByRole('button', { name: 'Save as profile…' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Too many profiles exist to create another.');
    await user.click(sourceTrigger());
    const startFrom = within(screen.getByRole('listbox', { name: 'Source' })).getByRole('group', {
      name: 'Start from',
    });
    expect(within(startFrom).getByRole('option', { name: /Blank draft/ })).not.toHaveAttribute(
      'aria-disabled'
    );
    expect(within(startFrom).getByRole('option', { name: /Curated local/ })).not.toHaveAttribute(
      'aria-disabled'
    );
    // The list-limited copy no longer gates Start at all.
    expect(screen.queryByText('Too many profiles to display.')).not.toBeInTheDocument();
    // Selection of LISTED rows stays allowed (§4.8).
    expect(sourceTrigger()).not.toBeDisabled();
  });

  // Ruling 9(a). Task 6's `unavailable` list-state test could not fail:
  // `buildProfileSelectModel` renders `unloaded` and `unavailable` alike. The
  // picker's list notice is where the state finally becomes observable.
  it('names the transport failure in the curated submenu when the list is unavailable', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
    (ListGolemProfiles as jest.Mock).mockRejectedValue(new Error('transport down'));
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    await screen.findByRole('button', { name: 'Source' });
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
    const user = userEvent.setup();
    await user.click(sourceTrigger());
    expect(
      screen.getByText('Configuration service unavailable. Refresh before trying again.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'local' })).not.toBeInTheDocument();
  });

  // Ruling 9(b). `refreshProfileList`'s `status === 'diagnostics'` branch had
  // never been driven, and it is the ONE input that makes `unavailable`
  // distinguishable from `unloaded` on screen: a diagnostics list yields a
  // profile-domain sentence no other list state can produce.
  it('surfaces the profile diagnostic when the list itself answers diagnostics', async () => {
    await mountReady({ status: 'diagnostics', diagnostics: [{ code: 'io' }] });
    const user = userEvent.setup();
    await user.click(sourceTrigger());
    expect(screen.getByText('The profile could not be read or saved.')).toBeInTheDocument();
    expect(
      screen.queryByText('Configuration service unavailable. Refresh before trying again.')
    ).not.toBeInTheDocument();
  });

  // [A5] A pending initial list request must never be reported as a failure —
  // `unloaded` and `unavailable` render identically everywhere except this
  // notice line.
  it('a pending initial list shows Loading profiles… and no failure', async () => {
    (ReloadGolemSettings as jest.Mock).mockResolvedValue({
      busy: false,
      projection: readyProjection,
    });
    (ListGolemProfiles as jest.Mock).mockReturnValue(new Promise(() => {}));
    render(<GolemConfigWorkspace onClose={jest.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Source' }));
    expect(screen.getByText('Loading profiles…')).toBeInTheDocument();
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
    await screen.findByRole('button', { name: 'Source' });
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());

    const user = userEvent.setup();
    // §4.8: ONLY the applied-configuration-absent state — no Curated/Yours
    // groups, no profile rows, even though the loaded list carries them.
    expect(sourceTrigger()).toHaveTextContent('No applied configuration');
    await user.click(sourceTrigger());
    let list = screen.getByRole('listbox', { name: 'Source' });
    expect(
      within(list).getByRole('option', { name: 'No applied configuration' })
    ).toBeInTheDocument();
    expect(within(list).queryByRole('group', { name: 'Curated' })).toBeNull();
    expect(within(list).queryByRole('group', { name: 'Yours' })).toBeNull();
    expect(within(list).queryByRole('option', { name: 'local' })).not.toBeInTheDocument();
    const startFrom = within(list).getByRole('group', { name: 'Start from' });

    // A Start action stages a draft; the picker then truthfully names that
    // draft source — as the selected (disabled) entry, groups still absent.
    await user.click(within(startFrom).getByRole('option', { name: /Curated local/ }));
    await waitFor(() => expect(sourceValue()).toBe('curated/local'));
    // #312: the trigger names the staged source with its group prefix — the
    // CSS supplies the ' · ' separator (a ::after generated string, invisible
    // to jsdom's textContent), so the group and the slug are asserted apart.
    expect(sourceTrigger()).toHaveTextContent('Curated');
    expect(sourceTrigger()).toHaveTextContent('local');
    await user.click(sourceTrigger());
    list = screen.getByRole('listbox', { name: 'Source' });
    expect(within(list).queryByRole('group', { name: 'Curated' })).toBeNull();
    expect(within(list).queryByRole('group', { name: 'Yours' })).toBeNull();
    const staged = within(list).getByRole('option', { name: 'local' });
    expect(staged).toHaveAttribute('aria-selected', 'true');
    expect(staged).toHaveAttribute('aria-disabled', 'true');
  });

  it('a failed selection from a blank draft returns to the blank draft', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue({
      status: 'diagnostics',
      diagnostics: [{ code: 'io' }],
    });
    await mountReady();
    const user = userEvent.setup();
    await user.click(sourceTrigger());
    await user.click(await screen.findByRole('option', { name: /Blank draft/ }));
    await waitFor(() => expect(sourceValue()).toBe('__blank__'));

    await pickSource(user, /mine/, 'Yours');
    // A blank draft is inherently unsaved work, so the §4.6a guard intercepts
    // the switch — confirm it, or the failing load never runs.
    await user.click(await screen.findByRole('button', { name: 'Discard & switch' }));
    await screen.findByText('The profile could not be read or saved.');
    // §4.8: back to the PRIOR source — the blank draft, not Applied.
    expect(sourceValue()).toBe('__blank__');
    await user.click(sourceTrigger());
    expect(
      within(screen.getByRole('listbox', { name: 'Source' })).getByRole('option', {
        name: 'Blank draft',
      })
    ).toBeInTheDocument();
  });

  it('a refresh AFTER acquisition never rewrites the frozen tuple', async () => {
    (SaveGolemProfileAs as jest.Mock)
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'profile_target' })
      .mockResolvedValueOnce({ status: 'conflict', conflict: 'active_revision' });
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
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
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // The collision resolved; the collider acquisition is now pending. Abandon it.
    await waitFor(() => expect(LoadGolemProfile).toHaveBeenCalledWith('user/mine'));
    // Naming's Back closes the whole popover ([C14]) — there is no idle step
    // to fall back into any more.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('group', { name: 'Save as profile' })).not.toBeInTheDocument();

    // The OLD acquisition finally resolves — into a dead generation: no
    // overwrite step may appear.
    await act(async () => {
      resolveLoad(profileLoadResult('user/mine'));
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Overwrite' })).not.toBeInTheDocument();
    expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument();

    // A fresh naming flow proceeds untouched by the dead continuation.
    await openMenu(user);
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
    await screen.findByRole('button', { name: 'Source' });
    await waitFor(() => expect(ListGolemProfiles).toHaveBeenCalled());
    const user = userEvent.setup();
    // #312: Save no longer refreshes the list itself (that `onOpen` moved to
    // the Source picker) — open and close the picker to fire the second,
    // still-pending fetch this test drives, then open Save's naming step.
    await user.click(sourceTrigger());
    await user.keyboard('{Escape}');
    await openMenu(user);
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
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/already exists/i);

    (ListGolemProfiles as jest.Mock).mockResolvedValue(listResult({ status: 'limited' }));
    screen.getByRole('button', { name: 'Refresh' }).focus();
    await user.keyboard('{Enter}');
    // #312: Save no longer refreshes the list itself (only the mount fetch
    // and this Refresh do), so the count floor drops from 3 to 2.
    await waitFor(() =>
      expect((ListGolemProfiles as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2)
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
    await user.click(screen.getByRole('button', { name: 'Check destinations…' }));
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
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The LATER write registers while the EARLIER (Save) write is still
    // pending — same as the drain test above.
    await user.click(screen.getByRole('button', { name: 'Check destinations…' }));
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
    expect(screen.queryByRole('group', { name: 'Save as profile' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as profile…' })).toHaveFocus();
  });

  it('restores focus to the trigger when Escape closes a save that is still in flight', async () => {
    // [K2] `close(true)` called `focus()` on the trigger synchronously — while the
    // in-flight save still had it DISABLED, which makes the call a no-op and drops
    // focus to <body>. The request now waits for the commit that re-enables it.
    let settle: ((result: unknown) => void) | undefined;
    (SaveGolemProfileAs as jest.Mock).mockImplementation(
      () => new Promise((resolve) => (settle = resolve))
    );
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const trigger = screen.getByRole('button', { name: 'Save as profile…' });
    expect(trigger).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Profile name')).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus(); // still disabled: nothing could take it yet

    await act(async () => {
      settle?.({ status: 'saved', profile: { id: 'user/mine', revision: REV('c') } });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save as profile…' })).toHaveFocus()
    );
  });

  it('drops the held focus request when the user has moved on during the save', async () => {
    // [N1] The [K2] hold had no owner check and never expired: Escape mid-save, click
    // Edit, start typing, and the settling RPC yanked focus out of the editor and onto
    // the Save trigger. The request survives only while NOTHING else holds focus.
    let settle: ((result: unknown) => void) | undefined;
    (SaveGolemProfileAs as jest.Mock).mockImplementation(
      () => new Promise((resolve) => (settle = resolve))
    );
    await mountReady();
    const user = userEvent.setup();
    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Save as profile…' })).toBeDisabled();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Edit provider llama-swap' }));
    const endpoint = screen.getByLabelText('Endpoint');
    await user.type(endpoint, '-draft');
    expect(endpoint).toHaveFocus();

    await act(async () => {
      settle?.({ status: 'saved', profile: { id: 'user/mine', revision: REV('c') } });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save as profile…' })).toBeEnabled()
    );
    expect(endpoint).toHaveFocus();
    expect(endpoint).toHaveValue('http://127.0.0.1:9292/v1-draft');
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
    await screen.findByRole('button', { name: 'Source' });
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
      expect(screen.getByRole('button', { name: 'Save as profile…' })).toBeDisabled();
      await user.click(sourceTrigger());
      const list = screen.getByRole('listbox', { name: 'Source' });
      const startFrom = within(list).getByRole('group', { name: 'Start from' });
      expect(within(startFrom).getByRole('option', { name: /Blank draft/ })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
      // [N5] ONE refusal notice names both halves; two near-identical <p>s under one
      // list said the same thing twice and both landed in `aria-describedby`.
      expect(
        screen.getAllByText(
          'Profiles and Start from are unavailable while the configuration is Invalid or Limited.'
        )
      ).toHaveLength(1);
      const option = within(list).getByRole('option', { name: 'local' });
      expect(option).toHaveAttribute('aria-disabled', 'true');
    }
  );

  it('while ready: everything is offered', async () => {
    await mountState(readyProjection);
    expect(screen.getByRole('button', { name: 'Save as profile…' })).toBeEnabled();
    const user = userEvent.setup();
    await user.click(sourceTrigger());
    const startFrom = within(screen.getByRole('listbox', { name: 'Source' })).getByRole('group', {
      name: 'Start from',
    });
    expect(within(startFrom).getByRole('option', { name: /Blank draft/ })).not.toHaveAttribute(
      'aria-disabled'
    );
    expect(within(startFrom).getByRole('option', { name: /Curated local/ })).not.toHaveAttribute(
      'aria-disabled'
    );
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
    await pickSource(user, /mine/, 'Yours');
    expect(sourceTrigger()).toBeDisabled();
    // [C12][A6] the sr-only status announcement and the visible spinner line
    // are two separate elements now, both carrying the same text.
    expect(screen.getAllByText('Loading profile…')).toHaveLength(2);
    resolveLoad(profileLoadResult('user/mine'));
    await waitFor(() => expect(sourceTrigger()).toBeEnabled());
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
    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(sourceTrigger()).toBeDisabled();
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
    await pickSource(user, /mine/, 'Yours');
    await waitFor(() => expect(sourceValue()).toBe('user/mine'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sourceValue()).toBe('applied'));
  });

  it('Discard returns the select to Applied', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    (CancelGolemSettingsApply as jest.Mock).mockResolvedValue({ status: 'cancelled' });
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, /mine/, 'Yours');
    await waitFor(() => expect(sourceValue()).toBe('user/mine'));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(sourceValue()).toBe('applied'));
  });

  it('a list-only refresh that lost the selected profile retains it as the selected, disabled option', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/other', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, /mine/, 'Yours');
    await waitFor(() => expect(sourceValue()).toBe('user/mine'));

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
    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'other');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');

    // §4.8: retained as the SELECTED entry, marked unavailable and not
    // re-choosable — never a snap to a lie. This is the rendered proof the
    // pure-model rule stands in the real picker.
    expect(sourceValue()).toBe('user/mine');
    expect(sourceTrigger()).toHaveTextContent('unavailable');
    await user.click(sourceTrigger());
    const retained = within(screen.getByRole('listbox', { name: 'Source' })).getByRole('option', {
      name: /^mine/,
    });
    expect(retained).toHaveAttribute('aria-selected', 'true');
    expect(retained).toHaveAttribute('aria-disabled', 'true');
    expect(retained).toHaveTextContent('unavailable');
  });

  it('a list refresh alone never changes the selected source', async () => {
    (LoadGolemProfile as jest.Mock).mockResolvedValue(profileLoadResult('user/mine'));
    (SaveGolemProfileAs as jest.Mock).mockResolvedValue({
      status: 'saved',
      profile: { id: 'user/other', revision: REV('c') },
    });
    await mountReady();
    const user = userEvent.setup();
    await pickSource(user, /mine/, 'Yours');
    await waitFor(() => expect(sourceValue()).toBe('user/mine'));
    // A successful save triggers refreshProfileList (a list refresh with no
    // §4.6a transition) — the selection must not move. Save requires ready
    // state, which the profile-source draft still satisfies via projection.
    await openMenu(user);
    await user.type(screen.getByLabelText('Profile name'), 'other');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Profile saved.');
    expect(sourceValue()).toBe('user/mine');
  });
});
