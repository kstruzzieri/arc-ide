/**
 * End-to-end Golem settings apply flows (#263 Slice B, spec §4.6/§4.6a/§5.6).
 *
 * Every result variant and every transport rejection is driven through the real
 * workspace, because the thing under test is the TRANSITION: which draft
 * survives, which key refs survive, and which action the surface then offers.
 *
 * Key refs are deliberately unreachable from a test, so retention is asserted
 * the only honest way — by what the NEXT request carries. A retained key
 * reappears in `keys`; a dropped one leaves `keys` empty and its row back on the
 * applied credential state.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';
import {
  confirmConfigClose,
  hasUnsavedConfigWork,
} from '../../../components/GolemConfig/configCloseGuard';
import * as golemConfig from '../../../types/golemConfig';
import { ACTIVE_PROFILE_KEY } from '../../../types/golemConfig';
import { GolemContractError, CAPABILITY_NAMES } from '../../../types/golem';
import type { ModelProjection, ProviderProjection } from '../../../types/golem';

jest.mock('../../../wails/bindings', () => ({
  ReloadGolemSettings: jest.fn(),
  ApplyGolemSettings: jest.fn(),
  CreateGolemSettings: jest.fn(),
  ConfirmGolemSettingsApply: jest.fn(),
  CancelGolemSettingsApply: jest.fn(),
  ConfirmGolemDestinationGrants: jest.fn(),
  PrepareGolemDestinationGrants: jest.fn(),
  ListGolemProfiles: jest.fn(),
  LoadGolemProfile: jest.fn(),
}));
import {
  ApplyGolemSettings,
  CancelGolemSettingsApply,
  ConfirmGolemDestinationGrants,
  ConfirmGolemSettingsApply,
  CreateGolemSettings,
  ListGolemProfiles,
  LoadGolemProfile,
  PrepareGolemDestinationGrants,
  ReloadGolemSettings,
} from '../../../wails/bindings';

const testRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const movedRevision = 'f'.repeat(64);
const profileRevision = 'a'.repeat(64);

const KEY = 'sk-live-value';

const model = (over: Partial<ModelProjection> = {}): ModelProjection => ({
  role: 'chat-role',
  modelName: 'gpt-5-mini',
  provider: 'hosted',
  type: 'dense',
  effectiveCapabilities: ['chat', 'stream'],
  capabilityFacts: { caps: ['chat', 'stream'], knownCaps: [...CAPABILITY_NAMES] },
  exposedCapabilities: ['chat', 'stream'],
  thinkMode: '',
  routedUseCases: ['chat'],
  hasThinkTags: true,
  hasSlots: false,
  removable: false,
  ...over,
});

/** A second model on the same provider, so a retarget has somewhere to go. */
const other = model({
  role: 'other-role',
  modelName: 'gpt-5',
  effectiveCapabilities: ['chat', 'stream', 'tool_call'],
  capabilityFacts: { caps: ['chat', 'stream', 'tool_call'], knownCaps: [...CAPABILITY_NAMES] },
  exposedCapabilities: ['chat', 'stream', 'tool_call'],
  routedUseCases: [],
  hasThinkTags: false,
  removable: true,
});

const hosted = (over: Partial<ProviderProjection> = {}): ProviderProjection => ({
  name: 'hosted',
  endpoint: 'https://api.example.com/v1',
  classification: 'remote',
  apiFormat: 'openai-compat',
  credentialState: 'available',
  ...over,
});

const readyProjection = {
  state: 'ready',
  sourceOrigin: 'user_config',
  revision: testRevision,
  readOnly: false,
  editable: true,
  routes: [{ useCase: 'chat', role: 'chat-role' }],
  models: [model(), other],
  providers: [hosted()],
  diagnostics: [],
};

const missingProjection = {
  state: 'missing',
  sourceOrigin: 'none',
  readOnly: false,
  editable: false,
  routes: [],
  models: [],
  providers: [],
  diagnostics: [{ code: 'config_missing', subjectKind: '', subjectName: '', blocking: true }],
};

const loadedProfile = {
  status: 'loaded',
  profileId: 'curated/local',
  sourceRevision: profileRevision,
  projection: {
    state: 'ready',
    readOnly: false,
    editable: true,
    routes: [{ useCase: 'chat', role: 'chat-role' }],
    models: [model({ hasThinkTags: false })],
    providers: [hosted({ credentialState: 'none' })],
    diagnostics: [],
  },
};

/**
 * §4.8: the picker's START FROM group lists whatever the live list projection
 * carries, so it has no curated rows at all without a list result — this is
 * what makes `startCuratedViaMenu` below reach `curated/local`.
 */
const profileListResult = () => ({
  status: 'loaded',
  profiles: [
    { id: 'curated/local', description: 'Vetted local lineup', curated: true },
    { id: 'user/mine', curated: false },
  ],
});

const destination = (over: Record<string, unknown> = {}) => ({
  provider: 'hosted',
  model: 'gpt-5-mini',
  endpoint: 'https://api.example.com/v1',
  classification: 'remote',
  provenance: ['agent'],
  ...over,
});

const challenge = (over: Record<string, unknown> = {}) => ({
  token: 'challenge-token-1',
  expiresAt: Date.now() + 600_000,
  destinations: [destination()],
  ...over,
});

const reload = (projection: unknown = readyProjection, busy = false) =>
  (ReloadGolemSettings as jest.Mock).mockResolvedValue({ busy, projection });

const applyReturns = (result: unknown) =>
  (ApplyGolemSettings as jest.Mock).mockResolvedValue(result);

const lastApply = () => (ApplyGolemSettings as jest.Mock).mock.calls.at(-1)?.[0];
const lastConfirm = () => (ConfirmGolemSettingsApply as jest.Mock).mock.calls.at(-1)?.[0];

const openProvider = async (name = 'hosted') =>
  await userEvent.click(screen.getByRole('button', { name: `Edit provider ${name}` }));
const openRoute = async (useCase: string, label = 'Edit') =>
  await userEvent.click(screen.getByRole('button', { name: `${label} route ${useCase}` }));
const stage = async () => await userEvent.click(screen.getByRole('button', { name: 'Done' }));
const cancelEditor = async () =>
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
/** Choose a model card in the band (the option is found by its NAME node). */
async function pickModel(name: string) {
  const card = within(screen.getByRole('listbox', { name: /Models/ }))
    .getAllByRole('option')
    .find((option) => within(option).queryByText(name) !== null);
  if (card === undefined) throw new Error(`no model card named ${name}`);
  await userEvent.click(card);
}

/** The declare path: type a name nothing matches, then take the declare card. */
async function declareModel(name: string) {
  const filter = screen.getByLabelText('Filter models');
  await userEvent.clear(filter);
  await userEvent.type(filter, name);
  await userEvent.click(screen.getByRole('option', { name: new RegExp(`Declare "${name}"`) }));
}

const clickApply = async () => await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

/** #312: the picker replaced the native select. [C3] Query the trigger by ROLE — while the
 *  list is open the listbox answers to the label "Source" too. This file drives interactions
 *  through the static `userEvent` export (not a `.setup()` session), so the helper does too. */
const sourceTrigger = () => screen.getByRole('button', { name: 'Source' });

/**
 * §4.8 bootstraps through the Source picker's own START FROM group now — the
 * Configuration menu's `Start from curated` / `Start blank` items are gone
 * (#312 reduced that menu to the one Save write action, `SaveProfileButton`).
 * Every former Start interaction routes through these instead; the picker
 * closes behind the choice, so each helper is a complete open-choose cycle.
 */
const startBlankViaMenu = async () => {
  await userEvent.click(sourceTrigger());
  await userEvent.click(await screen.findByRole('option', { name: /Blank draft/ }));
};
const startCuratedViaMenu = async () => {
  await userEvent.click(sourceTrigger());
  await userEvent.click(await screen.findByRole('option', { name: /Curated local/ }));
};
/** Choose an option by name, optionally inside a group; closes the list afterwards even when
 *  the option was disabled (a disabled click leaves the list open). */
const pickSource = async (name: string | RegExp, group?: string) => {
  await userEvent.click(sourceTrigger());
  const list = await screen.findByRole('listbox', { name: 'Source' });
  const scope =
    group === undefined ? within(list) : within(within(list).getByRole('group', { name: group }));
  await userEvent.click(scope.getByRole('option', { name }));
  if (screen.queryByRole('listbox', { name: 'Source' }) !== null)
    await userEvent.keyboard('{Escape}');
};
const sourceValue = () => sourceTrigger().getAttribute('data-value');

/** Stages one provider-key-set on `hosted`, the change every key assertion uses. */
async function stageKey(): Promise<void> {
  await openProvider();
  await userEvent.type(screen.getByLabelText('New API key'), KEY);
  await stage();
  await cancelEditor();
}

/** Stages one non-key change, so a terminal path has something to retain. */
async function stageEndpoint(url = 'https://api.example.com/v2'): Promise<void> {
  await openProvider();
  const endpoint = screen.getByLabelText('Endpoint');
  await userEvent.clear(endpoint);
  await userEvent.type(endpoint, url);
  await stage();
  await cancelEditor();
}

async function mountWorkspace(): Promise<void> {
  render(<GolemConfigWorkspace onClose={() => {}} />);
  await screen.findByTestId('provider-row-hosted');
}

// jsdom ships <dialog> without its modal methods; the merge surface's tests
// stand it up the same way.
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

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  reload();
  (ListGolemProfiles as jest.Mock).mockResolvedValue(profileListResult());
  (CancelGolemSettingsApply as jest.Mock).mockResolvedValue({ status: 'cancelled' });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The bar itself
// ---------------------------------------------------------------------------

describe('Apply bar', () => {
  it('appears only when the draft is dirty and names each change as a chip', async () => {
    await mountWorkspace();
    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('golem-config-masthead')).queryByText('Modified')
    ).not.toBeInTheDocument();

    await stageKey();
    // §4.2: the masthead keeps the document's verdict and overlays the draft's.
    const masthead = screen.getByTestId('golem-config-masthead');
    expect(within(masthead).getByText('Ready')).toBeInTheDocument();
    expect(within(masthead).getByText('Modified')).toBeInTheDocument();

    const bar = screen.getByTestId('golem-config-draft');
    expect(within(bar).getByText('1 staged change')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'hosted · API key' })).toBeEnabled();
    expect(within(bar).getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(within(bar).getByRole('button', { name: 'Discard' })).toBeEnabled();
  });

  it('tells a cleared key apart from a set one on the chip', async () => {
    // [F7] Both key changes once read `name · API key`, so the bar could not say which
    // of two opposite intents Apply would send.
    await mountWorkspace();
    await openProvider();
    await userEvent.click(screen.getByLabelText('Clear the stored API key'));
    await stage();
    await cancelEditor();

    const bar = screen.getByTestId('golem-config-draft');
    expect(within(bar).getByRole('button', { name: 'hosted · API key cleared' })).toBeEnabled();
    expect(within(bar).queryByRole('button', { name: 'hosted · API key' })).toBeNull();
  });

  it('says a model role was removed, not just "removed"', async () => {
    // [C6] A provider and a model role may carry the SAME name, and both chips read
    // `<name> · removed` — two different removals, one indistinguishable label.
    await mountWorkspace();
    await userEvent.click(screen.getByRole('button', { name: 'Remove model role other-role' }));
    const bar = screen.getByTestId('golem-config-draft');
    expect(within(bar).getByRole('button', { name: 'other-role · model removed' })).toBeEnabled();
  });

  it('opens and focuses the editor its chip names', async () => {
    await mountWorkspace();
    await stageKey();
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'hosted · API key' }));
    expect(screen.getByLabelText('Endpoint')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Edit provider hosted' })).toHaveFocus();
  });

  // A chip click is a one-shot request. Every draft reset remounts the cards,
  // and a request left standing would be replayed by that fresh mount.
  it('does not replay a chip click when the draft resets', async () => {
    applyReturns({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await mountWorkspace();
    await stageKey();
    await userEvent.click(screen.getByRole('button', { name: 'hosted · API key' }));
    expect(screen.getByLabelText('Endpoint')).toBeInTheDocument();

    await clickApply();
    expect(await screen.findByText('Configuration applied.')).toBeVisible();
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it('blocks Apply while an editor holds unstaged fields', async () => {
    await mountWorkspace();
    await stageKey();
    await openProvider();
    await userEvent.type(screen.getByLabelText('Endpoint'), '-more');

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(
      screen.getByText(/Apply is unavailable while an editor has unstaged changes/)
    ).toBeVisible();
  });

  it('discards the draft and its key refs', async () => {
    await mountWorkspace();
    await stageKey();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('provider-row-hosted')).getByText('Key present')
    ).toBeVisible();
  });

  it('refuses locally when the draft cannot form a valid request', async () => {
    jest.spyOn(golemConfig, 'buildApplyRequest').mockImplementation(() => {
      throw new GolemContractError();
    });
    await mountWorkspace();
    await stageKey();
    await clickApply();

    expect(ApplyGolemSettings).not.toHaveBeenCalled();
    expect(await screen.findByText(/A staged change is invalid/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Terminal results
// ---------------------------------------------------------------------------

describe('terminal apply results', () => {
  // On a real configuration the cards are screens tall and Apply sits at the
  // bottom of the scroll container, so an outcome rendered ABOVE them lands out
  // of view and the click reads as doing nothing. The result has to be adjacent
  // to the control that caused it. jsdom has no layout, so the provable form of
  // that is DOM order: every result surface follows both cards.
  it('renders the outcome after the cards, beside the control that caused it', async () => {
    applyReturns({ status: 'busy' });
    await mountWorkspace();
    await stageKey();
    await clickApply();

    const notice = await screen.findByText(/Nothing was written; retry when idle/);
    const page = notice.closest(`[class*='body']`) as HTMLElement;
    const order = (el: Element | null) =>
      [...page.children].findIndex((child) => child === el || child.contains(el as Node));

    const routing = screen.getByRole('table', { name: 'Model routing' });
    expect(order(notice)).toBeGreaterThan(order(routing));
    expect(order(screen.getByRole('button', { name: 'Retry' }))).toBeGreaterThan(order(routing));
    // And the bar it belongs to is last.
    expect(order(screen.getByTestId('golem-config-draft'))).toBeGreaterThan(order(notice));
  });

  it('sends the whole request and clears the draft and keys once applied', async () => {
    applyReturns({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await mountWorkspace();
    await stageKey();
    await clickApply();

    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(1));
    expect(lastApply()).toEqual({
      targetRevision: testRevision,
      source: { kind: 'applied' },
      changes: [{ kind: 'provider-key-set', name: 'hosted' }],
      keys: { hosted: KEY },
    });

    expect(await screen.findByText('Configuration applied.')).toBeVisible();
    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
    expect(screen.getByText(`rev ${movedRevision.slice(0, 12)}`)).toBeInTheDocument();
  });

  it('warns when an applied write is not known to be durable', async () => {
    applyReturns({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
      warning: 'durability_uncertain',
    });
    await mountWorkspace();
    await stageKey();
    await clickApply();

    expect(await screen.findByText(/could not confirm the write reached disk/)).toBeVisible();
  });

  it('keeps every non-key change for review after a conflict and drops the keys', async () => {
    applyReturns({ status: 'conflict', conflict: 'target', consentOutcome: 'recorded' });
    await mountWorkspace();
    await stageEndpoint();
    await stageKey();
    await clickApply();

    expect(
      await screen.findByText('Destination approval saved; configuration not applied.')
    ).toBeVisible();
    const row = screen.getByTestId('provider-row-hosted');
    expect(within(row).getByText('Needs review')).toBeInTheDocument();
    expect(within(row).queryByText('Key staged')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    // The reload adopts the fresh revision; the retained row still waits.
    reload({ ...readyProjection, revision: movedRevision });
    applyReturns({ status: 'busy' });
    await userEvent.click(screen.getByRole('button', { name: 'Reload & review draft' }));
    await screen.findByText(`rev ${movedRevision.slice(0, 12)}`);

    await stageEndpoint('https://api.example.com/v3');
    await clickApply();
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(2));
    expect(lastApply()).toEqual({
      targetRevision: movedRevision,
      source: { kind: 'applied' },
      changes: [
        { kind: 'provider-update', name: 'hosted', endpoint: 'https://api.example.com/v3' },
      ],
      keys: {},
    });
  });

  // The conflict panel is the only way back from a conflict, so a reload that
  // did not land must not take it away — that would strand the draft with
  // `Needs review` rows and no action at all.
  it('keeps the conflict panel when the review reload comes back busy', async () => {
    applyReturns({ status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' });
    await mountWorkspace();
    await stageEndpoint();
    await clickApply();
    await screen.findByRole('button', { name: 'Reload & review draft' });

    reload(readyProjection, true);
    await userEvent.click(screen.getByRole('button', { name: 'Reload & review draft' }));
    expect(await screen.findByRole('button', { name: 'Reload & review draft' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument();

    reload({ ...readyProjection, revision: movedRevision });
    await userEvent.click(screen.getByRole('button', { name: 'Reload & review draft' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Reload & review draft' })
      ).not.toBeInTheDocument()
    );
    expect(screen.getByText(`rev ${movedRevision.slice(0, 12)}`)).toBeInTheDocument();
  });

  // A challenge conflict is not a moved document: the approval simply stopped
  // matching the request. There is nothing to reload, so the panel says so and
  // its action hands the retained rows back for re-staging.
  it('names a challenge conflict for what it is and returns to the draft', async () => {
    applyReturns({ status: 'conflict', conflict: 'challenge', consentOutcome: 'unchanged' });
    await mountWorkspace();
    await stageEndpoint();
    await clickApply();

    expect(
      await screen.findByText(/destination approval no longer matches this request/)
    ).toBeVisible();
    expect(screen.queryByText(/The configuration moved/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload & review draft' })).not.toBeInTheDocument();

    const reloads = (ReloadGolemSettings as jest.Mock).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Return to draft' }));
    await waitFor(() =>
      expect(screen.queryByText(/destination approval no longer matches/)).not.toBeInTheDocument()
    );
    // Nothing to reload: the panel dismissed and the draft is back under review.
    expect(ReloadGolemSettings).toHaveBeenCalledTimes(reloads);
    expect(
      within(screen.getByTestId('provider-row-hosted')).getByText('Needs review')
    ).toBeInTheDocument();
  });

  it('reloads cleanly when a conflict is discarded', async () => {
    applyReturns({ status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' });
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Discard draft' });

    reload({ ...readyProjection, revision: movedRevision });
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));

    await waitFor(() => expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument());
    expect(await screen.findByText(`rev ${movedRevision.slice(0, 12)}`)).toBeInTheDocument();
  });

  it('routes a diagnostic result onto the row it names and keeps the rows staged', async () => {
    applyReturns({
      status: 'diagnostics',
      diagnostics: [
        { code: 'provider_in_use', subjectKind: 'provider', subjectName: 'hosted', blocking: true },
      ],
      consentOutcome: 'uncertain',
    });
    await mountWorkspace();
    await stageEndpoint();
    await stageKey();
    await clickApply();

    const row = await screen.findByTestId('provider-row-hosted');
    // [C6] The row-owned diagnostic is a sibling `detailRow` in the row's rowgroup.
    expect(
      within(row.parentElement!).getByText('This provider is still used by a model.')
    ).toBeVisible();
    expect(
      screen.getByText('Destination approval may have been saved; configuration was not applied.')
    ).toBeVisible();
    // Nothing was written: the endpoint stays staged, the key does not.
    expect(within(row).getByText('Modified')).toBeInTheDocument();
    expect(within(row).queryByText('Key staged')).not.toBeInTheDocument();

    applyReturns({ status: 'busy' });
    await clickApply();
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(2));
    expect(lastApply().keys).toEqual({});
  });

  it('keeps a diagnostic naming no row on the page', async () => {
    applyReturns({
      status: 'diagnostics',
      diagnostics: [
        { code: 'provider_in_use', subjectKind: 'provider', subjectName: 'ghost', blocking: true },
      ],
      consentOutcome: 'unchanged',
    });
    await mountWorkspace();
    await stageKey();
    await clickApply();

    const page = await screen.findByRole('list', { name: 'Configuration diagnostics' });
    expect(within(page).getByText('provider ghost')).toBeVisible();
  });

  it('treats a limited result as terminal for keys', async () => {
    applyReturns({
      status: 'limited',
      diagnostics: [
        {
          code: 'identifier_not_editable',
          subjectKind: 'provider',
          subjectName: 'hosted',
          blocking: false,
        },
      ],
    });
    await mountWorkspace();
    await stageEndpoint();
    await stageKey();
    await clickApply();

    expect(await screen.findByText(/This configuration cannot be written/)).toBeVisible();
    const row = screen.getByTestId('provider-row-hosted');
    expect(within(row).queryByText('Key staged')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Nonterminal results: the only three that keep key refs alive
// ---------------------------------------------------------------------------

describe('nonterminal apply results', () => {
  it('names the destination and resends the whole request with its keys on Confirm', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    (ConfirmGolemSettingsApply as jest.Mock).mockResolvedValue({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await mountWorkspace();
    await stageKey();
    await clickApply();

    const consent = await screen.findByRole('alert');
    expect(within(consent).getByText(/hosted/)).toBeVisible();
    expect(within(consent).getByText(/gpt-5-mini/)).toBeVisible();
    expect(within(consent).getByText(/https:\/\/api\.example\.com\/v1/)).toBeVisible();
    // The routing hop that reaches it, and the singular lead: one destination,
    // and the word "remote" — this is a consent to egress, not a local write.
    expect(within(consent).getByText('Reached by agent')).toBeVisible();
    expect(within(consent).getByText(/Approve this remote destination before/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm destination' }));
    await waitFor(() => expect(ConfirmGolemSettingsApply).toHaveBeenCalledTimes(1));
    expect(lastConfirm()).toEqual({
      challengeToken: 'challenge-token-1',
      request: {
        targetRevision: testRevision,
        source: { kind: 'applied' },
        changes: [{ kind: 'provider-key-set', name: 'hosted' }],
        keys: { hosted: KEY },
      },
    });
    expect(await screen.findByText('Configuration applied.')).toBeVisible();
  });

  // §5.2: Busy is the only nonterminal confirmation result, and it "leaves the
  // token and key refs retryable". Losing the challenge here would send the
  // user back through Call 1 to re-approve a destination already approved.
  it('keeps the challenge when a Confirm comes back busy and retries the same token', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    (ConfirmGolemSettingsApply as jest.Mock).mockResolvedValueOnce({ status: 'busy' });
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm destination' }));

    expect(await screen.findByText(/Nothing was written; retry when idle/)).toBeVisible();
    // The consent panel is still standing on the same destination.
    expect(screen.getByRole('button', { name: 'Confirm destination' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel approval' })).toBeEnabled();

    (ConfirmGolemSettingsApply as jest.Mock).mockResolvedValueOnce({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ConfirmGolemSettingsApply).toHaveBeenCalledTimes(2));
    expect(lastConfirm().challengeToken).toBe('challenge-token-1');
    // Retry went back through Call 2, never Call 1.
    expect(ApplyGolemSettings).toHaveBeenCalledTimes(1);
  });

  it('expires a challenge cleanly when Confirm returns Busy after its deadline', async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    let settleConfirm!: (value: unknown) => void;
    applyReturns({
      status: 'consent_required',
      challenge: challenge({ expiresAt: Date.now() + 1000 }),
    });
    (ConfirmGolemSettingsApply as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolveConfirm) => {
          settleConfirm = resolveConfirm;
        })
    );
    await mountWorkspace();
    await user.click(screen.getByRole('button', { name: 'Edit provider hosted' }));
    await user.type(screen.getByLabelText('New API key'), KEY);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm destination' }));

    await act(async () => {
      jest.advanceTimersByTime(1001);
    });
    await act(async () => {
      settleConfirm({ status: 'busy' });
      await Promise.resolve();
    });

    expect(screen.getByText(/approval request expired/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm destination' })).not.toBeInTheDocument();
  });

  // The retained request is what Retry resends, so it must stay immutable: an
  // edit made beside the Retry button would be invisible to the resend and then
  // erased by the settle of a write that never carried it.
  it('freezes the draft while a busy request is still retryable', async () => {
    applyReturns({ status: 'busy' });
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Retry' });

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'hosted · API key' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Edit provider hosted' })).not.toBeInTheDocument();
    // The ways out stay open.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    // Retry resends exactly what was retained, and the draft unlocks only when
    // that request settles.
    applyReturns({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Configuration applied.')).toBeVisible();
    expect(lastApply()).toEqual((ApplyGolemSettings as jest.Mock).mock.calls[0][0]);
    expect(screen.getByRole('button', { name: 'Edit provider hosted' })).toBeEnabled();
  });

  it('retries a busy result with the same request and keys', async () => {
    applyReturns({ status: 'busy' });
    await mountWorkspace();
    await stageKey();
    await clickApply();

    expect(await screen.findByText(/Nothing was written; retry when idle/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(2));
    expect(lastApply()).toEqual((ApplyGolemSettings as jest.Mock).mock.calls[0][0]);
    expect(lastApply().keys).toEqual({ hosted: KEY });
  });

  it('restages the exact backend drop set and keeps the keys', async () => {
    applyReturns({
      status: 'drop_confirmation_required',
      drops: [{ changeId: 'route:chat', fields: ['slots', 'think_tags'] }],
    });
    await mountWorkspace();
    await stageKey();

    // A real retarget: a different model on the same provider.
    await openRoute('chat');
    await pickModel('gpt-5');
    await userEvent.click(screen.getByLabelText('Remove them and continue'));
    // #284: Done on success closes the route editor itself now.
    await stage();
    await clickApply();

    expect(await screen.findByText(/slots/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and restage' }));

    applyReturns({ status: 'busy' });
    await clickApply();
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(2));
    const request = lastApply();
    expect(request.keys).toEqual({ hosted: KEY });
    expect(request.changes).toContainEqual(
      expect.objectContaining({
        kind: 'route',
        useCase: 'chat',
        confirmDrops: ['slots', 'think_tags'],
      })
    );
  });

  it('drops the keys but keeps the rows when the challenge expires', async () => {
    applyReturns({
      status: 'consent_required',
      challenge: challenge({ expiresAt: Date.now() - 1000 }),
    });
    await mountWorkspace();
    await stageEndpoint();
    await stageKey();
    await clickApply();

    expect(await screen.findByText(/approval request expired/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm destination' })).not.toBeInTheDocument();
    const row = screen.getByTestId('provider-row-hosted');
    expect(within(row).getByText('Modified')).toBeInTheDocument();
    expect(within(row).queryByText('Key staged')).not.toBeInTheDocument();

    applyReturns({ status: 'busy' });
    await clickApply();
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(2));
    expect(lastApply().keys).toEqual({});
  });

  it('cancels the challenge and drops the keys while keeping the rows', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    await mountWorkspace();
    await stageEndpoint();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Cancel approval' });

    await userEvent.click(screen.getByRole('button', { name: 'Cancel approval' }));
    await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledWith('challenge-token-1'));
    expect(await screen.findByText(/approval request was cancelled/)).toBeVisible();
    const row = screen.getByTestId('provider-row-hosted');
    expect(within(row).getByText('Modified')).toBeInTheDocument();
    expect(within(row).queryByText('Key staged')).not.toBeInTheDocument();
  });

  it('locks every challenge action while Discard is cancelling its token', async () => {
    let settleCancel!: (value: unknown) => void;
    applyReturns({ status: 'consent_required', challenge: challenge() });
    (CancelGolemSettingsApply as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolveCancel) => {
          settleCancel = resolveCancel;
        })
    );
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Confirm destination' });

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: 'Confirm destination' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel approval' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();

    settleCancel({ status: 'cancelled' });
    await waitFor(() => expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument());
  });

  // §4.6a: while challenged, the only enabled draft actions are Confirm,
  // Cancel, and the cancel-then-transition paths. Everything the request is
  // made of is frozen, because the token is bound to that exact request.
  it('freezes every editing action while a challenge is pending', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Confirm destination' });

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'hosted · API key' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Edit provider hosted' })).not.toBeInTheDocument();
    // The panel's own actions, and the cancel-then-transition paths, stay live.
    expect(screen.getByRole('button', { name: 'Confirm destination' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel approval' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
  });

  // §3.3: Discard "invalidates a pending settings challenge" — it must never
  // abandon a token the backend still honours.
  it('cancels the pending challenge before Discard clears the draft', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Confirm destination' });

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledWith('challenge-token-1'));
    await waitFor(() => expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Confirm destination' })).not.toBeInTheDocument();
  });

  it('keeps the draft and the challenge when Discard cannot cancel the token', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    (CancelGolemSettingsApply as jest.Mock).mockRejectedValue('gone');
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Confirm destination' });

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText(/could not be cancelled/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm destination' })).toBeInTheDocument();
    expect(screen.getByTestId('golem-config-draft')).toBeInTheDocument();
  });

  it('keeps the challenge when its cancellation fails', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    (CancelGolemSettingsApply as jest.Mock).mockRejectedValue('gone');
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel approval' }));

    expect(await screen.findByText(/could not be cancelled/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm destination' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Grant-only destination approval (spec D13, I15; F17, F20)
//
// The action approves destinations for the ACTIVE configuration and writes no
// document, so the invariant under test in most of these is a NEGATIVE one:
// the staged draft and every key ref it holds come through Confirm, Cancel and
// a lapsed prompt untouched. Retention is asserted the same honest way the rest
// of this file asserts it — by the row markers and by what the next Apply
// carries.
// ---------------------------------------------------------------------------

/** A two-destination batch: one routed hop and one recommendation entry. */
const grantChallenge = (over: Record<string, unknown> = {}) => ({
  token: 'grant-token-1',
  expiresAt: Date.now() + 600_000,
  destinations: [
    destination(),
    destination({
      provider: 'hosted-mirror',
      model: '',
      endpoint: 'https://mirror.example.com/v1',
      provenance: ['agent (recommendation)'],
    }),
  ],
  ...over,
});

const prepareReturns = (result: unknown) =>
  (PrepareGolemDestinationGrants as jest.Mock).mockResolvedValue(result);

const approve = async () =>
  await userEvent.click(screen.getByRole('button', { name: 'Check destinations…' }));

describe('grant-only destination approval', () => {
  it('preserves unstaged provider fields until they are staged before approval', async () => {
    prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
    await mountWorkspace();
    await openProvider();
    await userEvent.type(screen.getByLabelText('Endpoint'), '-edited');
    await userEvent.type(screen.getByLabelText('New API key'), KEY);

    const action = screen.getByRole('button', { name: 'Check destinations…' });
    expect(action).toBeDisabled();
    await userEvent.click(action);
    expect(PrepareGolemDestinationGrants).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.example.com/v1-edited');
    expect(screen.getByLabelText('New API key')).toHaveValue(KEY);

    await stage();
    expect(action).toBeEnabled();
  });

  it('lists the whole batch and records it on Confirm', async () => {
    prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
    (ConfirmGolemDestinationGrants as jest.Mock).mockResolvedValue({ status: 'granted' });
    await mountWorkspace();
    await approve();

    const consent = await screen.findByRole('alert');
    // The grant-only explainer (no write is pending) and the destination-check
    // rationale — not the old "Approve these N remote destinations" lead.
    // [X13] Visible, not merely present: this explainer replaced one that was asserted
    // visible, and the whole point of the panel is that the reader can SEE what they
    // are approving.
    expect(
      within(consent).getByText(
        /Remote destinations your agent route can reach that have no approval yet/
      )
    ).toBeVisible();
    // [C13] The ticking countdown is aria-hidden; the alert announces the expiry once, statically.
    expect(within(consent).getByText(/expires in \d+:\d{2}/)).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(within(consent).getByText(/^Expires at /)).toBeVisible();
    expect(within(consent).getAllByText('remote')).toHaveLength(2);
    // One line per destination: endpoint, provider, and the model only when the
    // entry names one.
    expect(within(consent).getByText('https://api.example.com/v1')).toBeVisible();
    expect(within(consent).getByText('gpt-5-mini')).toBeVisible();
    expect(within(consent).getByText('https://mirror.example.com/v1')).toBeVisible();
    expect(within(consent).getByText('hosted-mirror')).toBeVisible();
    expect(within(consent).getByText('Reached by agent')).toBeVisible();
    expect(within(consent).getByText('Reached by agent (recommendation)')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Approve 2 destinations' }));
    await waitFor(() =>
      expect(ConfirmGolemDestinationGrants).toHaveBeenCalledWith('grant-token-1')
    );
    expect(await screen.findByText(/Destinations approved/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve 2 destinations' })
    ).not.toBeInTheDocument();
    // Nothing about the configuration was written, and Call 1 ran exactly once.
    expect(ApplyGolemSettings).not.toHaveBeenCalled();
    expect(ConfirmGolemSettingsApply).not.toHaveBeenCalled();
    expect(PrepareGolemDestinationGrants).toHaveBeenCalledTimes(1);
  });

  // F17. The settings-apply cancel keeps clearing the vault — that is
  // "cancels the challenge and drops the keys while keeping the rows" above,
  // and it still passes unchanged.
  it('leaves the draft and its key refs standing through confirm, cancel, and a lapse', async () => {
    prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
    (ConfirmGolemDestinationGrants as jest.Mock).mockResolvedValue({ status: 'granted' });
    await mountWorkspace();
    await stageEndpoint();
    await stageKey();

    const staged = () => {
      const row = screen.getByTestId('provider-row-hosted');
      expect(within(row).getByText('Modified')).toBeInTheDocument();
      expect(within(row).getByText('Key staged')).toBeInTheDocument();
    };
    staged();

    await approve();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve 2 destinations' }));
    expect(await screen.findByText(/Destinations approved/)).toBeVisible();
    staged();

    await approve();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledWith('grant-token-1'));
    expect(await screen.findByText(/approval request was cancelled/)).toBeVisible();
    staged();

    // A prompt left standing past its deadline: no timer fires (nothing to
    // settle), and the next interaction is a Cancel.
    (PrepareGolemDestinationGrants as jest.Mock).mockResolvedValueOnce({
      status: 'consent_required',
      challenge: grantChallenge({ expiresAt: Date.now() - 1 }),
    });
    await approve();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve 2 destinations' }));
    expect(await screen.findByText(/approval request expired/)).toBeVisible();
    expect(ConfirmGolemDestinationGrants).toHaveBeenCalledTimes(1); // never the lapsed token
    staged();

    // The honest proof: the very next Apply still carries the staged row AND
    // the key value the vault has been holding the whole time.
    applyReturns({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await clickApply();
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(1));
    expect(lastApply().keys).toEqual({ hosted: KEY });
    expect(lastApply().changes).toEqual([
      { kind: 'provider-update', name: 'hosted', endpoint: 'https://api.example.com/v2' },
      { kind: 'provider-key-set', name: 'hosted' },
    ]);
  });

  // F20. Cancel revokes the token rather than letting it sit out its TTL, and
  // the draft is none of its business either.
  it('revokes the token on Cancel and keeps the draft', async () => {
    prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
    await mountWorkspace();
    await stageKey();
    await approve();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledTimes(1));
    expect(CancelGolemSettingsApply).toHaveBeenCalledWith('grant-token-1');
    expect(ConfirmGolemDestinationGrants).not.toHaveBeenCalled();
    expect(await screen.findByText(/Nothing was approved/)).toBeVisible();
    expect(
      within(screen.getByTestId('provider-row-hosted')).getByText('Key staged')
    ).toBeInTheDocument();
  });

  // Fix round 1, finding 1. A settings-apply disclosure — the drop-
  // confirmation panel here — is the ONLY copy of `outcome.drops`
  // (`restageDrops` reads it back). A fresh Prepare replaces the whole
  // outcome, so the action must stay off until the user has resolved it,
  // rather than silently destroying a disclosure they are still looking at.
  it('disables the action while a drop disclosure is on screen, and the drops survive', async () => {
    applyReturns({
      status: 'drop_confirmation_required',
      drops: [{ changeId: 'route:chat', fields: ['slots', 'think_tags'] }],
    });
    await mountWorkspace();
    await stageKey();
    await openRoute('chat');
    await pickModel('gpt-5');
    await userEvent.click(screen.getByLabelText('Remove them and continue'));
    // #284: Done on success closes the route editor itself now.
    await stage();
    await clickApply();

    expect(await screen.findByText(/slots/)).toBeVisible();
    const action = screen.getByRole('button', { name: 'Check destinations…' });
    expect(action).toBeDisabled();

    // A disabled control fires nothing: Prepare never runs, and the
    // disclosure survives the click attempt intact.
    await userEvent.click(action);
    expect(PrepareGolemDestinationGrants).not.toHaveBeenCalled();
    expect(screen.getByText(/slots/)).toBeVisible();
  });

  it('names a changed configuration on conflict and offers the action again', async () => {
    prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
    (ConfirmGolemDestinationGrants as jest.Mock).mockResolvedValue({ status: 'conflict' });
    await mountWorkspace();
    await approve();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve 2 destinations' }));

    expect(
      await screen.findByText(/configuration changed while this approval was open/)
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve 2 destinations' })
    ).not.toBeInTheDocument();
    const action = screen.getByRole('button', { name: 'Check destinations…' });
    expect(action).toBeEnabled();

    // And it prepares afresh rather than reusing the spent challenge.
    prepareReturns({ status: 'none' });
    await userEvent.click(action);
    expect(await screen.findByText(/Nothing to approve/)).toBeVisible();
    expect(PrepareGolemDestinationGrants).toHaveBeenCalledTimes(2);
  });

  // Every closed status that answers with a line rather than a prompt. The
  // config_invalid line must never read as "nothing to approve" (R3).
  const inlineOutcomes: Array<[string, RegExp]> = [
    ['none', /^Nothing to approve\./],
    ['unavailable', /fix or remove .*restart Firn.*then approve again/],
    ['busy', /Nothing was written; retry when idle/],
    ['config_invalid', /Configuration failed to load — fix the diagnostics above first/],
    ['uncertain', /could not confirm whether the approval was saved/],
  ];

  it.each(inlineOutcomes)('answers %s inline with no prompt', async (status, copy) => {
    prepareReturns({ status });
    await mountWorkspace();
    await approve();

    expect(await screen.findByText(copy)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve 2 destinations' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check destinations…' })).toBeEnabled();
    if (status === 'config_invalid') {
      expect(screen.queryByText(/Nothing to approve/)).not.toBeInTheDocument();
    }
  });

  it('says what failed when the grant call is refused', async () => {
    (PrepareGolemDestinationGrants as jest.Mock).mockRejectedValue('service unavailable');
    await mountWorkspace();
    await approve();

    expect(await screen.findByTestId('golem-grant-notice')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Approve 2 destinations' })
    ).not.toBeInTheDocument();
  });

  it.each(['rejected', 'malformed'])(
    'cancels a %s confirmation without losing staged keys',
    async (response) => {
      prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
      if (response === 'rejected') {
        (ConfirmGolemDestinationGrants as jest.Mock).mockRejectedValue('connection lost');
      } else {
        (ConfirmGolemDestinationGrants as jest.Mock).mockResolvedValue({ status: 'unexpected' });
      }
      (CancelGolemSettingsApply as jest.Mock).mockRejectedValue('also unavailable');
      await mountWorkspace();
      await stageKey();
      await approve();
      await userEvent.click(await screen.findByRole('button', { name: 'Approve 2 destinations' }));

      await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledWith('grant-token-1'));
      expect(CancelGolemSettingsApply).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('golem-grant-notice')).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Approve 2 destinations' })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check destinations…' })).toBeEnabled();

      applyReturns({ status: 'applied', projection: readyProjection });
      await clickApply();
      await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(1));
      expect(lastApply().keys).toEqual({ hosted: KEY });
    }
  );

  it('does not replay a chip click when a grant round trip remounts the cards', async () => {
    // [K5] The grant landing flips the surface lock, which remounts both cards — and a
    // fresh card replays whatever focusRequest still stands, reopening an editor the
    // user had left behind a whole round trip ago.
    prepareReturns({ status: 'granted' });
    await mountWorkspace();
    await stageKey();
    await userEvent.click(screen.getByRole('button', { name: 'hosted · API key' }));
    expect(screen.getByLabelText('Endpoint')).toBeInTheDocument();
    await cancelEditor();
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();

    await approve();
    expect(await screen.findByTestId('golem-grant-notice')).toBeVisible();
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
  });

  it('does not replay a chip click when an Apply lands a drop disclosure', async () => {
    // [N4] The twin of the grant path above, on the settings path the clear was MISSING
    // from. `drop_confirmation_required` RETAINS the keys, so its settle skips
    // `resetCards` — and the landing releases `sending`, which remounts both cards with
    // editing available again. A `focusRequest` left standing reopened the editor the
    // user had closed a round trip ago. The clear now happens once, in `beginOperation`,
    // for every lock cycle.
    applyReturns({
      status: 'drop_confirmation_required',
      drops: [{ changeId: 'route:chat', fields: ['slots', 'think_tags'] }],
    });
    await mountWorkspace();
    await stageKey();
    await userEvent.click(screen.getByRole('button', { name: 'hosted · API key' }));
    expect(screen.getByLabelText('Endpoint')).toBeInTheDocument();
    await cancelEditor();
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();

    await clickApply();
    expect(await screen.findByText(/slots/)).toBeVisible();
    // Editing is available again beside the disclosure — and nothing reopened on its own.
    expect(screen.getByRole('button', { name: 'Edit provider hosted' })).toBeEnabled();
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
  });

  // The grant-only notice never reaches `settle` on its own, so a later
  // settings apply must clear it explicitly — otherwise "Destinations
  // approved. Your configuration was not changed." would still be on screen
  // beside a fresh "Configuration applied." notice, contradicting it.
  it('clears the grant-only notice once a later Apply lands', async () => {
    prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
    (ConfirmGolemDestinationGrants as jest.Mock).mockResolvedValue({ status: 'granted' });
    await mountWorkspace();
    await approve();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve 2 destinations' }));
    expect(await screen.findByTestId('golem-grant-notice')).toHaveTextContent(
      'Destinations approved. Your configuration was not changed.'
    );

    await stageEndpoint();
    applyReturns({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await clickApply();

    expect(await screen.findByText('Configuration applied.')).toBeVisible();
    expect(screen.queryByTestId('golem-grant-notice')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Outcome-unknown recovery
// ---------------------------------------------------------------------------

describe('outcome-unknown recovery', () => {
  it('disables every write and offers only Recover state after a lost Apply', async () => {
    window.localStorage.setItem(
      ACTIVE_PROFILE_KEY,
      JSON.stringify({ version: 1, profileId: 'curated/local', appliedRevision: testRevision })
    );
    (ApplyGolemSettings as jest.Mock).mockRejectedValue('connection lost');
    await mountWorkspace();
    await stageEndpoint();
    await stageKey();
    await clickApply();

    expect(
      await screen.findByText('The Apply result is unknown. Refresh before making more changes.')
    ).toBeVisible();
    expect(window.localStorage.getItem(ACTIVE_PROFILE_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit provider hosted' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recover state' })).toBeEnabled();

    // The retained non-key operation waits for an explicit re-stage.
    expect(
      within(screen.getByTestId('provider-row-hosted')).getByText('Needs review')
    ).toBeInTheDocument();
  });

  it('keeps the recovery state while the reload is busy', async () => {
    (ApplyGolemSettings as jest.Mock).mockRejectedValue('connection lost');
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Recover state' });

    reload(readyProjection, true);
    await userEvent.click(screen.getByRole('button', { name: 'Recover state' }));
    expect(await screen.findByRole('button', { name: 'Recover state' })).toBeInTheDocument();

    reload({ ...readyProjection, revision: movedRevision });
    await userEvent.click(screen.getByRole('button', { name: 'Recover state' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Recover state' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('sends one best-effort cancel after a lost Confirm', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    (ConfirmGolemSettingsApply as jest.Mock).mockRejectedValue('connection lost');
    (CancelGolemSettingsApply as jest.Mock).mockRejectedValue('also gone');
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm destination' }));

    expect(await screen.findByText(/The Apply result is unknown/)).toBeVisible();
    await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledWith('challenge-token-1'));
    expect(CancelGolemSettingsApply).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Unsaved-work transitions (§4.6a)
// ---------------------------------------------------------------------------

describe('unsaved-work transitions', () => {
  it('reloads immediately when Refresh finds nothing staged', async () => {
    await mountWorkspace();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(ReloadGolemSettings).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('confirms before Refresh discards a dirty draft', async () => {
    await mountWorkspace();
    await stageKey();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(ReloadGolemSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('golem-config-draft')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & reload',
      })
    );
    await waitFor(() => expect(ReloadGolemSettings).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
  });

  it('confirms before Refresh discards unstaged editor fields', async () => {
    await mountWorkspace();
    await openProvider();
    await userEvent.type(screen.getByLabelText('Endpoint'), '-stale');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alertdialog')).toBeVisible();
  });

  it('locks a retained draft while its conflict reload is pending', async () => {
    let settleReload!: (value: unknown) => void;
    applyReturns({ status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' });
    await mountWorkspace();
    await stageEndpoint();
    await clickApply();
    await screen.findByRole('button', { name: 'Reload & review draft' });
    await userEvent.click(screen.getByRole('button', { name: 'hosted · endpoint' }));
    expect(screen.getByLabelText('Endpoint')).toBeEnabled();
    (ReloadGolemSettings as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolveReload) => {
          settleReload = resolveReload;
        })
    );

    await userEvent.click(screen.getByRole('button', { name: 'Reload & review draft' }));

    await waitFor(() => expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'hosted · endpoint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    settleReload({
      busy: false,
      projection: { ...readyProjection, revision: movedRevision },
    });
    await screen.findByText(`rev ${movedRevision.slice(0, 12)}`);
    expect(screen.getByRole('button', { name: 'hosted · endpoint' })).toBeEnabled();
  });

  it('acknowledges a clean shutdown without mounting a dialog', async () => {
    await mountWorkspace();
    expect(hasUnsavedConfigWork()).toBe(false);
    await expect(confirmConfigClose('quit')).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks before a dirty shutdown and lands focus on Keep editing', async () => {
    await mountWorkspace();
    await stageKey();
    expect(hasUnsavedConfigWork()).toBe(true);

    const pending = confirmConfigClose('quit');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await expect(pending).resolves.toBe(false);

    const second = confirmConfigClose('quit');
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard & quit' })
    );
    await expect(second).resolves.toBe(true);
  });

  // [W2] WKWebView with Full Keyboard Access off skips buttons on Tab, so the
  // dialog owns its own keys: every move key hands focus to the other button,
  // which makes Tab, Shift+Tab and the arrows wrap between exactly two choices.
  it('moves focus between its two buttons on Tab and the arrows', async () => {
    await mountWorkspace();
    await stageKey();
    const pending = confirmConfigClose('quit');
    const dialog = await screen.findByRole('alertdialog');
    const keep = within(dialog).getByRole('button', { name: 'Keep editing' });
    const discard = within(dialog).getByRole('button', { name: 'Discard & quit' });
    expect(keep).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(discard).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(keep).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(discard).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    expect(keep).toHaveFocus();

    await userEvent.click(keep);
    await expect(pending).resolves.toBe(false);
  });

  it('cancels a pending challenge before it lets the app close', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Cancel approval' });

    const pending = confirmConfigClose('close');
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & close',
      })
    );
    await expect(pending).resolves.toBe(true);
    expect(CancelGolemSettingsApply).toHaveBeenCalledWith('challenge-token-1');
  });

  // Fix round 1, finding 3. A grant-only prompt is the one case `unsaved` is
  // true for a reason that has nothing to do with a staged change or a key —
  // a CLEAN draft with only an open approval. The dialog must describe THAT,
  // not claim staged changes and an API key are being dropped. It still runs
  // the same cancel-then-teardown path (harmless here: nothing is staged, so
  // `settleDraft`/`vault.clear()` have nothing to drop).
  it('shows grant-aware copy and revokes the token when a clean surface closes on an open approval', async () => {
    prepareReturns({ status: 'consent_required', challenge: grantChallenge() });
    await mountWorkspace();
    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
    await approve();
    await screen.findByRole('button', { name: 'Approve 2 destinations' });
    expect(hasUnsavedConfigWork()).toBe(true);

    const pending = confirmConfigClose('close');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Cancel the pending approval?')).toBeVisible();
    expect(
      within(dialog).getByText('The destination approval is cancelled. Nothing staged is dropped.')
    ).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel approval' }));
    await expect(pending).resolves.toBe(true);
    expect(CancelGolemSettingsApply).toHaveBeenCalledWith('grant-token-1');
    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
  });

  it('keeps the surface open when the challenge cannot be cancelled', async () => {
    applyReturns({ status: 'consent_required', challenge: challenge() });
    (CancelGolemSettingsApply as jest.Mock).mockRejectedValue('gone');
    await mountWorkspace();
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Cancel approval' });

    const pending = confirmConfigClose('close');
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & close',
      })
    );
    await expect(pending).resolves.toBe(false);
    expect(await screen.findByText(/could not be cancelled/)).toBeVisible();
  });

  it('reports no unsaved work once the surface is gone', async () => {
    const { unmount } = render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-hosted');
    unmount();

    expect(hasUnsavedConfigWork()).toBe(false);
    await expect(confirmConfigClose('quit')).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap (state = missing)
// ---------------------------------------------------------------------------

describe('bootstrap through the Source picker', () => {
  beforeEach(() => {
    reload(missingProjection);
    (LoadGolemProfile as jest.Mock).mockResolvedValue(loadedProfile);
  });

  // The `no profile picker` clause this test used to carry is gone on purpose:
  // Slice C ships the masthead source select, so asserting its absence would
  // now be a lie. Task 8 (ruling 4) then replaced the two empty cards with a
  // dedicated bootstrap empty state, so the Start actions this test drives
  // now live there instead of the picker's own START FROM group. What the
  // test still pins is the §4.8 rule that holds regardless of surface — Save
  // refuses without a Ready applied configuration, while a Start action
  // bootstraps one. (The select's own Missing-state shape is pinned by
  // GolemConfigProfiles.test.tsx.)
  it('offers both starting points and refuses Save while Missing', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const masthead = screen.getByTestId('golem-config-masthead');
    const empty = await screen.findByRole('region', { name: 'No applied configuration' });
    expect(within(empty).getByRole('button', { name: 'Start blank' })).toBeEnabled();
    expect(within(empty).getByRole('button', { name: 'Start from curated local' })).toBeEnabled();

    const save = within(masthead).getByRole('button', { name: 'Save as profile…' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Nothing to save until a configuration is applied.');

    await userEvent.click(within(empty).getByRole('button', { name: 'Start from curated local' }));
    await waitFor(() => expect(LoadGolemProfile).toHaveBeenCalledWith('curated/local'));
    expect(await screen.findByRole('table', { name: 'Providers' })).toBeInTheDocument();

    expect(within(masthead).getByRole('button', { name: 'Save as profile…' })).toBeDisabled();
    expect(within(masthead).getByRole('button', { name: 'Save as profile…' })).toHaveAttribute(
      'title',
      'Nothing to save until a configuration is applied.'
    );
  });

  it('loads the curated profile as the draft source and paints its rows as pending', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startCuratedViaMenu();
    await waitFor(() => expect(LoadGolemProfile).toHaveBeenCalledWith('curated/local'));

    expect(await screen.findByTestId('provider-row-hosted')).toBeInTheDocument();
    expect(within(screen.getByTestId('route-row-chat')).getByText('Modified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'source → curated/local' })).toBeInTheDocument();
  });

  it('locks source choices and Refresh while a profile load is pending', async () => {
    let settleProfile!: (value: unknown) => void;
    (LoadGolemProfile as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolveProfile) => {
          settleProfile = resolveProfile;
        })
    );
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startCuratedViaMenu();

    // The picker closed behind the choice, and the pending load locks the
    // whole surface — so nothing can be reopened at all, which subsumes the
    // two former CTAs' own disabled attributes.
    expect(screen.getByRole('button', { name: 'Save as profile…' })).toBeDisabled();
    expect(sourceTrigger()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();

    settleProfile(loadedProfile);
    expect(await screen.findByRole('button', { name: 'source → curated/local' })).toBeVisible();
  });

  it('does not let an older profile response overwrite a later blank source', async () => {
    let settleProfile!: (value: unknown) => void;
    (LoadGolemProfile as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolveProfile) => {
          settleProfile = resolveProfile;
        })
    );
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await userEvent.click(sourceTrigger());
    const profile = await screen.findByRole('option', { name: /Curated local/ });
    const blank = screen.getByRole('option', { name: /Blank draft/ });

    // Both handlers run against the SAME render — the picker's own close and
    // the source lock both land only on the next one — so this is exactly the
    // double-dispatch the two fixed CTAs could produce.
    act(() => {
      fireEvent.click(profile);
      fireEvent.click(blank);
    });
    expect(
      await screen.findByRole('button', { name: 'source → blank configuration' })
    ).toBeVisible();

    await act(async () => {
      settleProfile(loadedProfile);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'source → blank configuration' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'source → curated/local' })
    ).not.toBeInTheDocument();
  });

  // §4.8 freezes the Save-as-profile BUTTON while a consent challenge holds
  // the visible request — Save has no business reaching a request it never
  // wrote. The picker keeps the narrower source lock, because a source switch
  // is a §4.6a cancel-then-transition path, so that is where "reachable
  // during consent" is now proved.
  it('keeps a source switch reachable during consent and locks it during cancellation', async () => {
    let settleCancel!: (value: unknown) => void;
    (CreateGolemSettings as jest.Mock).mockResolvedValueOnce({
      status: 'consent_required',
      challenge: challenge(),
    });
    (CancelGolemSettingsApply as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolveCancel) => {
          settleCancel = resolveCancel;
        })
    );
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startCuratedViaMenu();
    await screen.findByRole('button', { name: 'source → curated/local' });
    await clickApply();
    await screen.findByRole('button', { name: 'Confirm destination' });

    expect(screen.getByRole('button', { name: 'Save as profile…' })).toBeDisabled();
    expect(sourceTrigger()).toBeEnabled();

    // This bootstrap never reaches Ready, so the applied entry reads "No
    // applied configuration" rather than "Applied" — match either.
    await pickSource(/applied/i);
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & switch',
      })
    );
    await waitFor(() => expect(CancelGolemSettingsApply).toHaveBeenCalledTimes(1));

    expect(sourceTrigger()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save as profile…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm destination' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel approval' })).toBeDisabled();

    settleCancel({ status: 'cancelled' });
    await waitFor(() => expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument());
    expect(sourceValue()).toBe('applied');
  });

  // The one test in this describe that starts from a LOADED document. The
  // switch that cancels the consent has to come through the picker (Save is
  // frozen while a challenge stands), and the picker only lists profiles
  // when the document is Ready — while Missing it shows the applied-absent
  // state alone (§4.8). The profile source itself is still adopted through
  // the picker's START FROM group, so the bootstrap path is the one under
  // test either way.
  it('clears cancelled consent before a replacement profile load can fail', async () => {
    reload(readyProjection);
    let rejectProfile!: (reason: unknown) => void;
    (LoadGolemProfile as jest.Mock)
      .mockResolvedValueOnce(loadedProfile)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectProfile = reject;
          })
      )
      .mockResolvedValueOnce(loadedProfile);
    applyReturns({ status: 'consent_required', challenge: challenge() });
    await mountWorkspace();
    await startCuratedViaMenu();
    await screen.findByRole('button', { name: 'source → curated/local' });
    await stageKey();
    await clickApply();
    await screen.findByRole('button', { name: 'Confirm destination' });

    await pickSource(/mine/, 'Yours');
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & switch',
      })
    );
    await waitFor(() => expect(LoadGolemProfile).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole('button', { name: 'Confirm destination' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel approval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    await act(async () => {
      rejectProfile('Profile source is unavailable.');
      await Promise.resolve();
    });
    expect(await screen.findByText('Profile source is unavailable.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm destination' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel approval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    // §4.8: the failed load above restored the PRIOR source — still
    // curated/local — with its clean preview. A profile source is inherently
    // unsaved (draftChangeCount counts a non-applied source as one change), so
    // the guard intercepts this next switch too, and the third load resolves
    // onto curated/local again.
    await pickSource(/mine/, 'Yours');
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & switch',
      })
    );
    await screen.findByRole('button', { name: 'source → curated/local' });
    applyReturns({ status: 'busy' });
    await clickApply();
    await screen.findByRole('button', { name: 'Retry' });
    expect(lastApply().keys).toEqual({});
  });

  // The curated bootstrap end to end. The loaded, scrubbed profile document IS
  // the change, so zero staged mutations is a complete write — no gate, no
  // "stage something first".
  it('applies a curated profile with no staged changes and records its provenance', async () => {
    (CreateGolemSettings as jest.Mock).mockResolvedValue({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startCuratedViaMenu();
    await screen.findByRole('button', { name: 'source → curated/local' });

    expect(screen.getByText('1 staged change')).toBeInTheDocument();
    const applyButton = screen.getByRole('button', { name: 'Apply' });
    expect(applyButton).toBeEnabled();
    expect(screen.queryByText(/Stage at least one change/)).not.toBeInTheDocument();

    await userEvent.click(applyButton);
    await waitFor(() => expect(CreateGolemSettings).toHaveBeenCalledTimes(1));
    expect((CreateGolemSettings as jest.Mock).mock.calls[0][0]).toEqual({
      source: {
        kind: 'profile',
        profileId: 'curated/local',
        sourceRevision: profileRevision,
      },
      changes: [],
      keys: {},
    });

    expect(await screen.findByText('Configuration applied.')).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(ACTIVE_PROFILE_KEY) ?? 'null')).toEqual({
      version: 1,
      profileId: 'curated/local',
      appliedRevision: movedRevision,
    });
  });

  // A staged provider-add has no applied row underneath it, so its own strip is
  // the whole handle: reopen it, correct it, or take it back.
  it('reopens a staged provider-add on its staged values and re-stages a correction', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startBlankViaMenu();

    await userEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    await userEvent.type(screen.getByLabelText('Provider name'), 'local');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'http://127.0.0.1:11434/v1');
    await stage();

    const row = screen.getByTestId('provider-row-local');
    expect(within(row).getByText('http://127.0.0.1:11434/v1')).toBeInTheDocument();
    expect(within(row).getByText('Modified')).toBeInTheDocument();

    // Reopening seeds from the staged change. The name is that change's stable
    // identity, so it is fixed here exactly as it is on an applied row: editing
    // it in place would create a SECOND provider while the first stayed staged.
    await userEvent.click(within(row).getByRole('button', { name: 'Edit provider local' }));
    expect(screen.getByRole('group', { name: 'Staged provider local' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Provider name')).not.toBeInTheDocument();
    expect(screen.getByText(/unstage this provider and add it again/)).toBeVisible();
    const endpoint = screen.getByLabelText('Endpoint');
    expect(endpoint).toHaveValue('http://127.0.0.1:11434/v1');

    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'http://127.0.0.1:9292/v1');
    await stage();
    await cancelEditor();

    // Still ONE change on the provider identity, carrying the correction, and
    // exactly one strip — no fork into a second provider.
    expect(screen.getByText('2 staged changes')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('provider-row-local')).getByText('http://127.0.0.1:9292/v1')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('table', { name: 'Providers' }))
        .getAllByRole('row')
        .slice(1)
    ).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /· new provider$/ })).toHaveLength(1);
  });

  it('unstages a provider-add from its own strip', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startBlankViaMenu();

    await userEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    await userEvent.type(screen.getByLabelText('Provider name'), 'local');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'http://127.0.0.1:11434/v1');
    await userEvent.type(screen.getByLabelText('New API key'), KEY);
    await stage();
    expect(screen.getByRole('button', { name: 'local · API key' })).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByTestId('provider-row-local')).getByRole('button', {
        name: 'Unstage provider local',
      })
    );

    // The provider AND the key operation it carried are both gone — no full
    // Discard required.
    expect(screen.queryByTestId('provider-row-local')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'local · new provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'local · API key' })).not.toBeInTheDocument();
    expect(screen.getByText('1 staged change')).toBeInTheDocument(); // the source
  });

  // Same one-shot rule as a draft reset, different trigger: a source switch
  // remounts the cards too, so a standing chip request must not ride along.
  it('does not replay a chip click across a bootstrap source switch', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startBlankViaMenu();
    await userEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    await userEvent.type(screen.getByLabelText('Provider name'), 'local');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'http://127.0.0.1:11434/v1');
    // Staging hands the add to its own strip and closes the blank form.
    await stage();

    // The chip lands on that strip, which reopens on the STAGED values.
    await userEvent.click(screen.getByRole('button', { name: 'local · new provider' }));
    expect(screen.getByRole('group', { name: 'Staged provider local' })).toBeInTheDocument();

    await startCuratedViaMenu();
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard & switch',
      })
    );

    await screen.findByRole('button', { name: 'source → curated/local' });
    expect(screen.queryByRole('group', { name: 'Staged provider local' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
  });

  it('creates from a blank builder once the bootstrap inputs are complete', async () => {
    (CreateGolemSettings as jest.Mock).mockResolvedValue({ status: 'busy' });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByText(/nothing is written until you Apply/);
    await startBlankViaMenu();
    expect(
      await screen.findByRole('button', { name: 'source → blank configuration' })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByText(/needs one provider and an agent route/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    await userEvent.type(screen.getByLabelText('Provider name'), 'local');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'http://127.0.0.1:11434/v1');
    await stage(); // the add form closes; the staged provider now has a strip

    await openRoute('agent', 'Assign');
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'local');
    // No model exists on a brand-new provider: the declare card is the path.
    await declareModel('qwen3');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'dense');
    // #284: Done on success closes the route editor itself now.
    await stage();

    await clickApply();
    await waitFor(() => expect(CreateGolemSettings).toHaveBeenCalledTimes(1));
    const request = (CreateGolemSettings as jest.Mock).mock.calls[0][0];
    expect(request.targetRevision).toBeUndefined();
    expect(request.source).toEqual({ kind: 'blank' });
    expect(ApplyGolemSettings).not.toHaveBeenCalled();
  });

  // [A6] regression: `reviewConflict()`'s 'target' branch reloads unconditionally
  // (no unsaved guard — it calls `load(true)` directly) and keeps every retained
  // change for review, so it is the one organic way to land the bootstrap empty
  // state on top of a still-dirty draft whose source was never touched (`applied`
  // the whole time). Clicking a bootstrap button there must still run the §4.6a
  // dirty-draft guard, and answering "Keep editing" must leave focus exactly
  // where it was — the guard refused the start, so `bootstrapFrom` must not
  // move focus to the Source trigger.
  it('does not move focus off a bootstrap button when the dirty-draft guard is Kept', async () => {
    reload(readyProjection);
    applyReturns({ status: 'conflict', conflict: 'target', consentOutcome: 'unchanged' });
    await mountWorkspace();
    await stageEndpoint();
    await clickApply();
    await screen.findByRole('button', { name: 'Reload & review draft' });

    reload(missingProjection);
    await userEvent.click(screen.getByRole('button', { name: 'Reload & review draft' }));
    const empty = await screen.findByRole('region', { name: 'No applied configuration' });
    const startBlankButton = within(empty).getByRole('button', { name: 'Start blank' });

    await userEvent.click(startBlankButton);
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' })
    );

    expect(startBlankButton).toHaveFocus();
    expect(screen.getByRole('region', { name: 'No applied configuration' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Wave 4c: a card the picker offers can no longer be refused by a sibling floor.
// ---------------------------------------------------------------------------

describe('route picker floors (wave 4c)', () => {
  const agentModel = model({
    role: 'agent-role',
    modelName: 'gpt-5',
    effectiveCapabilities: ['chat', 'stream', 'tool_call'],
    capabilityFacts: { caps: ['chat', 'stream', 'tool_call'], knownCaps: [...CAPABILITY_NAMES] },
    exposedCapabilities: ['chat', 'stream', 'tool_call'],
    routedUseCases: ['agent'],
    hasThinkTags: false,
  });
  // agent falls back to reason-role, so the backend lists it among deepseek's routed use cases.
  const deep = model({
    role: 'reason-role',
    modelName: 'deepseek',
    routedUseCases: ['agent', 'reasoning'],
    hasThinkTags: false,
  });
  // The projection parser requires routes sorted by use case and models by role
  // (types/golem.ts parseSettingsProjection): an unsorted fixture never mounts.
  const projection = {
    ...readyProjection,
    routes: [
      { useCase: 'agent', role: 'agent-role' },
      { useCase: 'chat', role: 'chat-role' },
      { useCase: 'reasoning', role: 'reason-role' },
    ],
    models: [agentModel, model(), deep],
  };
  const grid = () => within(screen.getByRole('listbox', { name: /Models/ }));
  const cardNamed = (name: string) => {
    const card = grid()
      .getAllByRole('option')
      .find((option) => within(option).queryByText(name) !== null);
    if (card === undefined) throw new Error(`no card named ${name}`);
    return card;
  };

  it('cannot pick a model a sibling floor refuses, and says which sibling', async () => {
    reload(projection);
    await mountWorkspace();
    await openRoute('reasoning');

    // Keeping deepseek is an override of reason-role's selector, which agent
    // reaches through its fallback: agent's floor governs it, and the applied
    // model is short of it. gpt-5-mini is a fork of reasoning alone onto
    // chat-role's selector — agent stays on reason-role — so it is eligible.
    expect(screen.getByText('Model — every card below can serve reasoning')).toBeInTheDocument();
    expect(
      grid()
        .getAllByRole('option')
        .map((card) => within(card).getByText(/gpt|deepseek/).textContent)
    ).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(screen.getByText(/does not declare/)).toHaveTextContent(
      'deepseek does not declare tool_call: agent needs tool_call.'
    );

    await userEvent.click(screen.getByRole('button', { name: /1 model is not eligible/ }));
    expect(within(cardNamed('deepseek')).getByText('agent needs tool_call')).toBeInTheDocument();
    await pickModel('gpt-5');
    expect(screen.getByTestId('model-detail')).toHaveTextContent('gpt-5');
    expect(screen.queryByText(/does not declare/)).not.toBeInTheDocument();
    // A blocked card is shown for its reason, never chosen: the readout keeps the choice.
    await userEvent.click(cardNamed('deepseek'));
    expect(screen.getByTestId('model-detail')).toHaveTextContent('gpt-5');
  });
});

// ---------------------------------------------------------------------------
// Wave 4b (firn-ide#315): the sibling row shows the change before Apply, and
// Apply still sends ONE change.
// ---------------------------------------------------------------------------

describe('selector-wide siblings (firn-ide#315)', () => {
  it('paints a think change on the sibling row before Apply, and sends one change', async () => {
    const thinking = (over: Partial<ModelProjection>) =>
      model({
        effectiveCapabilities: ['chat', 'stream', 'thinking'],
        capabilityFacts: { caps: ['chat', 'stream', 'thinking'], knownCaps: [...CAPABILITY_NAMES] },
        exposedCapabilities: ['chat', 'stream', 'thinking'],
        thinkMode: 'auto',
        hasThinkTags: false,
        ...over,
      });
    reload({
      ...readyProjection,
      routes: [
        { useCase: 'chat', role: 'chat-role' },
        { useCase: 'summarize', role: 'summarize-role' },
      ],
      models: [
        thinking({ routedUseCases: ['chat'] }),
        thinking({ role: 'summarize-role', routedUseCases: ['summarize'] }),
      ],
    });
    applyReturns({
      status: 'applied',
      projection: { ...readyProjection, revision: movedRevision },
    });
    await mountWorkspace();

    await openRoute('chat');
    await userEvent.selectOptions(screen.getByLabelText('Think mode'), 'always');
    // summarize has no floor on record: the selector-wide change needs the acknowledgement.
    await userEvent.click(screen.getByLabelText('Apply anyway'));
    await stage();

    const sibling = screen.getByTestId('route-row-summarize');
    expect(sibling).toHaveAttribute('data-changed', 'true');
    expect(within(sibling).getByText('always')).toBeInTheDocument();
    expect(within(sibling).getByText(/^was$/i).parentElement).toHaveTextContent('wasauto');
    expect(
      within(screen.getByTestId('route-row-chat')).getByText('also affects summarize')
    ).toBeInTheDocument();
    // One change, one chip: the sibling is reached by the selector, not staged twice.
    const bar = screen.getByTestId('golem-config-draft');
    expect(within(bar).getByText('1 staged change')).toBeInTheDocument();

    await clickApply();
    await waitFor(() => expect(ApplyGolemSettings).toHaveBeenCalledTimes(1));
    expect(lastApply().changes).toEqual([
      expect.objectContaining({ kind: 'route', useCase: 'chat', thinkMode: 'always' }),
    ]);
  });
});
