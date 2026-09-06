/**
 * Task B8 — the Golem conversation view.
 *
 * TDD: written before `components/Golem/GolemPanel.tsx` exists.
 *
 * Everything the panel shows is read from `golemStore`, so these tests drive
 * the store the way the bridge does — status hydration, streamed events, run
 * status — and assert only on what a user (or a screen reader) can perceive.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { useMemo, useState } from 'react';
import { CommandPalette } from '../../../components/CommandPalette';
import { GolemPanel } from '../../../components/Golem';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';
import { useDraftStore } from '../../../golem/draftStore';
import { useGitStore } from '../../../stores/gitStore';
import { __resetGolemStore, useGolemStore } from '../../../stores/golemStore';
import { useIDEStore } from '../../../stores/ideStore';
import { parseGolemStatus } from '../../../types/golem';
import { createCommands } from '../../../utils/commands';

const mockRunGolemTurn = jest.fn();
const mockCancelGolemRun = jest.fn();
const mockReloadGolemSettings = jest.fn();

jest.mock('../../../wails/bindings', () => {
  const actual = jest.requireActual('../../../wails/bindings');
  return {
    ...actual,
    RunGolemTurn: (...args: unknown[]) => mockRunGolemTurn(...args),
    CancelGolemRun: (...args: unknown[]) => mockCancelGolemRun(...args),
    ReloadGolemSettings: (...args: unknown[]) => mockReloadGolemSettings(...args),
  };
});

// The command-palette focus-interplay test below mounts the real
// CommandPalette, which relies on <dialog> methods jsdom does not implement.
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
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: jest.fn(),
  });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

const EPOCH = 7;
const WS = 'frontend';
const CONV = 'conv-frontend';
const OTHER_WS = 'backend';
const OTHER_CONV = 'conv-backend';
const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const RUN_BG = '33333333-3333-4333-8333-333333333333';

const identity = { repoEpoch: EPOCH, workspaceId: WS, conversationId: CONV };
const runIdentity = (runId: string, over: Partial<typeof identity> = {}) => ({
  ...identity,
  ...over,
  runId,
});

const remoteDestination = {
  provider: 'anthropic',
  model: 'claude-opus',
  endpoint: 'https://api.example.test/v1',
  classification: 'remote' as const,
  digest: 'digest-remote',
};
const localDestination = {
  provider: 'ollama',
  model: 'qwen3',
  endpoint: 'http://127.0.0.1:11434',
  classification: 'local' as const,
  digest: 'digest-local',
};

const challengeFor = (runId: string) => ({
  id: 'challenge-1',
  identity: runIdentity(runId),
  destination: remoteDestination,
  destinationDigest: remoteDestination.digest,
  expiresAt: Date.now() + 5 * 60_000,
});

const statusPayload = (over: Record<string, unknown> = {}) => ({
  available: true,
  workspaceLabel: 'Frontend',
  identity,
  destination: localDestination,
  needsConsent: false,
  activeRuns: [],
  ...over,
});

const acceptedAdmission = (runId: string) => ({
  state: 'accepted',
  identity: runIdentity(runId),
  destination: localDestination,
  context: { included: 0, bytes: 0, excluded: 0 },
});

const consentAdmission = (runId: string) => ({
  state: 'needs_consent',
  identity: runIdentity(runId),
  destination: remoteDestination,
  context: { included: 0, bytes: 0, excluded: 0 },
  consentChallenge: challengeFor(runId),
});

const eventPayload = (over: Record<string, unknown> = {}) => ({
  protocol: 1,
  threadId: CONV,
  runId: RUN_A,
  seq: 1,
  type: 'run.started',
  payload: {},
  raw: '{}',
  ...over,
});

// ── crypto ────────────────────────────────────────────────────────────────────

let uuidQueue: string[] = [];
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: {
      randomUUID: () => {
        const next = uuidQueue.shift();
        if (!next) throw new Error('test exhausted the queued UUIDs');
        return next;
      },
    },
  });
});

afterAll(() => {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
});

// ── harness ───────────────────────────────────────────────────────────────────

const store = () => useGolemStore.getState();

const hydrate = (over: Record<string, unknown> = {}) => {
  act(() => {
    store().hydrateStatus(parseGolemStatus(statusPayload(over)));
  });
};

const selectFocused = () => {
  act(() => {
    store().selectConversation(CONV);
  });
};

const composer = () => screen.getByRole('textbox', { name: /message golem/i });
const sendButton = () => screen.getByRole('button', { name: 'Send' });
const liveRegion = (): HTMLElement => {
  const region = document.querySelector('[aria-live="polite"]');
  if (!(region instanceof HTMLElement)) throw new Error('no polite live region');
  return region;
};

const type = (value: string) => {
  fireEvent.change(composer(), { target: { value } });
};

const pressEnter = (over: Record<string, unknown> = {}) => {
  fireEvent.keyDown(composer(), { key: 'Enter', ...over });
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const applyGolemStyles = () => {
  const element = document.createElement('style');
  element.textContent = [
    readFileSync('src/styles/reset.css', 'utf8'),
    readFileSync('src/components/Golem/GolemPanel.module.css', 'utf8'),
  ].join('\n');
  document.head.appendChild(element);
  return element;
};

/**
 * jsdom has no layout, so a scroll container's geometry has to be supplied.
 * `scrollTop` is backed by a real value here because the assertion is whether
 * the panel wrote to it.
 */
const fakeScroll = (
  element: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }
) => {
  let scrollTop = geometry.scrollTop;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  fireEvent.scroll(element);
};

beforeEach(() => {
  __resetGolemStore();
  // Composer drafts are host-lifetime now (#271 B4), so they outlive a store
  // reset by design — which is exactly why each test has to clear them.
  useDraftStore.setState({ drafts: {} });
  useIDEStore.setState(useIDEStore.getInitialState());
  jest.clearAllMocks();
  uuidQueue = [RUN_A, RUN_B];
  mockRunGolemTurn.mockResolvedValue(acceptedAdmission(RUN_A));
  mockCancelGolemRun.mockResolvedValue(undefined);
  mockReloadGolemSettings.mockResolvedValue({
    busy: false,
    projection: {
      state: 'missing',
      sourceOrigin: 'none',
      readOnly: false,
      editable: false,
      routes: [],
      models: [],
      providers: [],
      diagnostics: [{ code: 'config_missing', subjectKind: '', subjectName: '', blocking: true }],
    },
  });
});

// ── identity and destination ──────────────────────────────────────────────────

describe('GolemPanel destination', () => {
  it('shows the backend workspace label, classification, provider, model, and endpoint', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('ollama')).toBeInTheDocument();
    expect(screen.getByText('qwen3')).toBeInTheDocument();

    // The endpoint moved behind the Connection disclosure (#271 D5).
    await userEvent.click(screen.getByText('Connection'));
    expect(screen.getByText('http://127.0.0.1:11434')).toBeVisible();
  });

  it('classifies a remote destination as Remote', () => {
    hydrate({ destination: remoteDestination });
    selectFocused();
    render(<GolemPanel visible />);

    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.queryByText('Local')).not.toBeInTheDocument();
  });

  it('states the fixed Phase 1 context scope', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    await userEvent.click(screen.getByText('Connection'));
    expect(screen.getByText('Context: prompt only')).toBeVisible();
  });
});

// ── header live indicator (the breathing logo + sr-only phase) ────────────────

describe('GolemPanel live indicator', () => {
  it('names the live phase and breathes the logo, and is quiet while idle', async () => {
    hydrate();
    selectFocused();
    const { container } = render(<GolemPanel visible />);
    // The logo is decorative (alt="", aria-hidden) so it has no role; query it
    // directly to read its live-pulse attribute.
    const logo = () => container.querySelector('img') as HTMLImageElement;

    expect(screen.queryByText('RUNNING')).not.toBeInTheDocument();
    expect(logo()).not.toHaveAttribute('data-live');

    type('long one');
    pressEnter();
    await flush();

    // The phase is readable (sr-only) and the logo carries the visual pulse.
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(logo()).toHaveAttribute('data-live', 'true');

    // A cancel the backend has not answered yet is its own phase, and the
    // sr-only label is the only surface that names it.
    mockCancelGolemRun.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: /cancel the current golem run/i }));

    expect(screen.getByText('CANCELING')).toBeInTheDocument();
    expect(screen.queryByText('RUNNING')).not.toBeInTheDocument();
    expect(logo()).toHaveAttribute('data-live', 'true');

    act(() => {
      store().ingestRunStatus({ identity: runIdentity(RUN_A), state: 'canceled' });
    });

    expect(screen.queryByText('CANCELING')).not.toBeInTheDocument();
    expect(logo()).not.toHaveAttribute('data-live');
  });

  it('shows a working notice while a run is live and removes it on terminal', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    expect(screen.queryByText(/Thinking|Responding|Running/)).not.toBeInTheDocument();

    type('do the thing');
    pressEnter();
    await flush();

    // No tool running yet → thinking; the notice is present and obvious.
    expect(screen.getByText('Thinking…')).toBeInTheDocument();

    // A running tool becomes the activity verbatim.
    act(() => {
      store().ingestEvent(
        eventPayload({
          seq: 2,
          type: 'tool.started',
          payload: { toolCallId: 'call-1', name: 'search', preview: '' },
        })
      );
    });
    expect(screen.getByText('Running search…')).toBeInTheDocument();
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();

    // Terminal clears the notice entirely.
    act(() => {
      store().ingestEvent(eventPayload({ seq: 3, type: 'run.finished', payload: {} }));
    });
    expect(screen.queryByText(/Thinking|Responding|Running/)).not.toBeInTheDocument();
  });

  it('announces a stable working state without exposing the ticking elapsed time', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    type('do the thing');
    pressEnter();
    await flush();

    expect(liveRegion()).toHaveTextContent('Golem is working.');
    expect(liveRegion()).not.toHaveTextContent(/\d+s/);
    expect(liveRegion()).toHaveAttribute('aria-atomic', 'false');

    act(() => {
      store().ingestEvent(
        eventPayload({ seq: 2, type: 'message.delta', payload: { messageId: 'm1', text: 'hi' } })
      );
    });
    expect(liveRegion()).toHaveTextContent('Golem is working.');

    mockCancelGolemRun.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: /cancel the current golem run/i }));

    expect(liveRegion()).toHaveTextContent('Golem is canceling.');
    expect(liveRegion()).not.toHaveTextContent(/\d+s/);
  });

  it('restarts elapsed time when a queued run takes over', async () => {
    jest.useFakeTimers();
    try {
      hydrate();
      selectFocused();
      render(<GolemPanel visible />);

      type('first');
      pressEnter();
      await flush();
      act(() => jest.advanceTimersByTime(2200));
      expect(screen.getByText('2s')).toBeInTheDocument();

      type('second');
      pressEnter();
      mockRunGolemTurn.mockResolvedValueOnce(acceptedAdmission(RUN_B));
      act(() => {
        store().ingestEvent(eventPayload({ seq: 2, type: 'run.finished', payload: {} }));
      });
      await flush();

      expect(store().conversations[CONV].activeRunId).toBe(RUN_B);
      expect(screen.getByText('0s')).toBeInTheDocument();
      expect(screen.queryByText('2s')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('announces a terminal run before the queued run working state', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    type('first');
    pressEnter();
    await flush();
    const firstWorkingAnnouncement = within(liveRegion()).getByText('Golem is working.');
    type('second');
    pressEnter();

    mockRunGolemTurn.mockResolvedValueOnce(acceptedAdmission(RUN_B));
    act(() => {
      store().ingestEvent(eventPayload({ seq: 2, type: 'run.finished', payload: {} }));
    });
    await flush();

    expect(liveRegion()).toHaveTextContent('Golem finished its reply. Golem is working.');
    expect(within(liveRegion()).getByText('Golem is working.')).not.toBe(firstWorkingAnnouncement);
  });

  it('disables the live reply caret animation for reduced motion', () => {
    const stylesheet = applyGolemStyles();
    try {
      const media = Array.from(stylesheet.sheet?.cssRules ?? []).find(
        (rule) => (rule as CSSMediaRule).media?.mediaText === '(prefers-reduced-motion: reduce)'
      ) as CSSMediaRule | undefined;
      const caret = Array.from(media?.cssRules ?? []).find((rule) =>
        (rule as CSSStyleRule).selectorText?.includes('.entryText::after')
      ) as CSSStyleRule | undefined;
      expect(caret?.style.animation).toBe('none');
    } finally {
      stylesheet.remove();
    }
  });

  it('flags a turn the consent shelf is holding', async () => {
    hydrate({ destination: remoteDestination });
    selectFocused();
    mockRunGolemTurn.mockResolvedValueOnce(consentAdmission(RUN_A));
    render(<GolemPanel visible />);

    type('send this remotely');
    pressEnter();
    await flush();

    expect(screen.getByText('APPROVAL')).toBeInTheDocument();
  });
});

// ── blocked states ────────────────────────────────────────────────────────────

describe('GolemPanel blocked states', () => {
  it('sends when nothing blocks the conversation', () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);
    type('hello');

    expect(sendButton()).toBeEnabled();
  });

  it('reports no workspace and disables send', () => {
    render(<GolemPanel visible />);

    expect(screen.getByText('Open a workspace to chat with Golem.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('reports a binding still in flight and disables send', () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);
    type('hello');
    act(() => {
      useGolemStore.setState({ bridgePhase: 'binding' });
    });

    expect(screen.getByText('Connecting to Golem…')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('reports a stale hydration and disables send', () => {
    hydrate();
    hydrate({
      identity: { repoEpoch: EPOCH, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
      workspaceLabel: 'Backend',
    });
    selectFocused();
    render(<GolemPanel visible />);
    type('hello');

    expect(screen.getByText('This workspace is no longer open.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('reports an unavailable backend and disables send', () => {
    hydrate({ available: false });
    selectFocused();
    render(<GolemPanel visible />);
    type('hello');

    expect(screen.getByText('Golem is unavailable in this workspace.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('renders config, policy, and consent warnings inline rather than only as a toast', () => {
    hydrate({
      available: false,
      needsConsent: true,
      warnings: ['Policy blocks remote providers.', 'No API key is configured.'],
      initError: 'golem.yaml could not be read.',
    });
    selectFocused();
    const { container } = render(<GolemPanel visible />);

    expect(within(container).getByText('Policy blocks remote providers.')).toBeInTheDocument();
    expect(within(container).getByText('No API key is configured.')).toBeInTheDocument();
    expect(within(container).getByText('golem.yaml could not be read.')).toBeInTheDocument();
    expect(
      within(container).getByText(
        'This workspace asks for approval before sending anything to a provider.'
      )
    ).toBeInTheDocument();
  });

  it('prefers the backend init error over the generic unavailable copy', () => {
    hydrate({ available: false, initError: 'golem.yaml could not be read.' });
    selectFocused();
    render(<GolemPanel visible />);

    expect(screen.queryByText('Golem is unavailable in this workspace.')).not.toBeInTheDocument();
    expect(screen.getByText('golem.yaml could not be read.')).toBeInTheDocument();
  });
});

// ── composer ──────────────────────────────────────────────────────────────────

describe('GolemPanel composer', () => {
  beforeEach(() => {
    hydrate();
    selectFocused();
  });

  it('sends on Enter and stages the prompt visibly while clearing the draft', async () => {
    render(<GolemPanel visible />);

    type('hello there');
    pressEnter();
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    expect(mockRunGolemTurn.mock.calls[0][0]).toMatchObject({
      identity: runIdentity(RUN_A),
      message: 'hello there',
      consentChallengeId: '',
    });
    expect(composer()).toHaveValue('');
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('leaves Shift+Enter to the textarea so it inserts a newline', () => {
    render(<GolemPanel visible />);

    type('first line');
    const event = fireEvent.keyDown(composer(), {
      key: 'Enter',
      shiftKey: true,
      cancelable: true,
    });

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    // Not prevented: the textarea's own newline insertion must still happen.
    expect(event).toBe(true);
    expect(composer()).toHaveValue('first line');
  });

  it('disables send for a blank or whitespace-only draft', () => {
    render(<GolemPanel visible />);

    expect(sendButton()).toBeDisabled();
    type('   ');
    expect(sendButton()).toBeDisabled();
    pressEnter();
    expect(mockRunGolemTurn).not.toHaveBeenCalled();

    type('real');
    expect(sendButton()).toBeEnabled();
  });

  it('does not send an Enter that is committing an IME composition, but does send the next one', async () => {
    render(<GolemPanel visible />);

    type('こんにちは');
    // `isComposing` is on the native event; the key is identical either way.
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    await flush();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();

    pressEnter();
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
  });

  it('sends from the Send button too', async () => {
    render(<GolemPanel visible />);

    type('via button');
    fireEvent.click(sendButton());
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
  });
});

// ── composer focus requests ───────────────────────────────────────────────────

describe('GolemPanel composer focus', () => {
  // ⌘⇧I in the first second of a repository arrives while the bridge is still
  // binding, so the textarea is disabled and cannot take focus. The request has
  // to stay armed until it can be honoured.
  it('honours a focus request raised before the conversation bound', () => {
    render(<GolemPanel visible />);
    expect(composer()).toBeDisabled();

    act(() => store().requestComposerFocus());
    expect(document.activeElement).not.toBe(composer());

    // The bind path: `hydrateStatus` selects the conversation without raising a
    // focus request of its own, so only the armed one can move focus here.
    hydrate();

    expect(composer()).toBeEnabled();
    expect(document.activeElement).toBe(composer());
  });

  it('does not re-spend an honoured request on a later visibility flip', () => {
    hydrate();
    selectFocused();
    const { rerender } = render(<GolemPanel visible />);

    act(() => store().requestComposerFocus());
    expect(document.activeElement).toBe(composer());

    act(() => composer().blur());
    rerender(<GolemPanel visible={false} />);
    rerender(<GolemPanel visible />);

    expect(document.activeElement).not.toBe(composer());
  });
});

// ── draft durability ──────────────────────────────────────────────────────────

describe('GolemPanel draft', () => {
  it('survives an unmount, so the draft outlives any remount of the panel', () => {
    hydrate();
    selectFocused();
    const { unmount } = render(<GolemPanel visible />);

    type('half-written thought');
    unmount();
    render(<GolemPanel visible />);

    expect(composer()).toHaveValue('half-written thought');
  });

  it('survives a workspace change and stays attached to its own conversation', () => {
    hydrate();
    hydrate({
      identity: { repoEpoch: EPOCH, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
      workspaceLabel: 'Backend',
    });
    selectFocused();
    render(<GolemPanel visible />);
    type('frontend draft');

    act(() => {
      store().selectConversation(OTHER_CONV);
    });
    expect(composer()).toHaveValue('');

    act(() => {
      store().selectConversation(CONV);
    });
    expect(composer()).toHaveValue('frontend draft');
  });
});

// ── host admission (#271 B4) ──────────────────────────────────────────────────
//
// The docked host owns the composer text and drops it only when the store's
// admission accepted it. A refusal keeps what the user typed and says why.

describe('GolemPanel admission', () => {
  const newChatButton = () => screen.getByRole('button', { name: 'New chat' });
  const toast = () => useIDEStore.getState().toast;

  beforeEach(() => {
    hydrate();
    selectFocused();
  });

  it('clears an accepted draft immediately, before the provider has answered', () => {
    // Never resolves: the draft must go on local admission alone.
    mockRunGolemTurn.mockReturnValue(new Promise(() => {}));
    render(<GolemPanel visible />);

    type('hello there');
    pressEnter();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
    expect(composer()).toHaveValue('');
    expect(toast()).toBeNull();
  });

  it('keeps a refused draft and explains the refusal', () => {
    render(<GolemPanel visible />);
    type('keep this');

    // The binding is gone, so the store refuses. The textarea stays enabled —
    // the conversation is still known — so Enter really does reach the adapter.
    act(() => {
      store().invalidateBinding();
    });
    pressEnter();

    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(composer()).toHaveValue('keep this');
    expect(toast()).toMatchObject({ type: 'error' });
    expect(toast()?.message).toEqual(expect.any(String));
    expect(toast()?.message).not.toBe('');
  });

  it('refuses New chat while a run is live and keeps the draft', () => {
    mockRunGolemTurn.mockReturnValue(new Promise(() => {}));
    render(<GolemPanel visible />);

    type('first');
    pressEnter();
    type('leftover');

    // The store would refuse a clear here (a live run could re-hydrate a
    // cleared conversation), so the button is disabled rather than lying.
    expect(newChatButton()).toBeDisabled();
    expect(composer()).toHaveValue('leftover');
  });

  it('accepts New chat when the only thing to clear is the draft', () => {
    render(<GolemPanel visible />);

    // An empty transcript and no queue: only this host knows there is anything
    // to clear at all, and the store accepts on its idle guard alone.
    type('just a draft');
    expect(newChatButton()).toBeEnabled();
    fireEvent.click(newChatButton());

    expect(composer()).toHaveValue('');
    expect(toast()).toBeNull();
  });

  it('freezes every action the moment a handoff starts', () => {
    const { rerender } = render(<GolemPanel visible />);
    type('mid-thought');

    rerender(<GolemPanel visible frozen />);

    expect(composer()).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    expect(newChatButton()).toBeDisabled();

    // A click or keydown that raced the barrier is refused by the handler too,
    // not only by `disabled` — and the draft is still here for the new owner.
    pressEnter();
    fireEvent.click(sendButton());
    expect(mockRunGolemTurn).not.toHaveBeenCalled();
    expect(composer()).toHaveValue('mid-thought');
  });
});

// ── queue ─────────────────────────────────────────────────────────────────────

describe('GolemPanel queue', () => {
  const startBusyRun = async () => {
    hydrate();
    selectFocused();
    mockRunGolemTurn.mockReturnValue(new Promise(() => {}));
    render(<GolemPanel visible />);
    type('first');
    pressEnter();
    await flush();
  };

  it('queues a send made while a run is busy and keeps it editable and removable', async () => {
    await startBusyRun();

    type('second');
    pressEnter();
    await flush();

    const queued = screen.getByRole('textbox', { name: /queued message/i });
    expect(queued).toHaveValue('second');
    expect(composer()).toHaveValue('');
    // Only the first turn reached the backend.
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);

    fireEvent.change(queued, { target: { value: 'second, edited' } });
    expect(store().conversations[CONV].queuedTurns[0].message).toBe('second, edited');

    fireEvent.click(screen.getByRole('button', { name: /remove queued message/i }));
    expect(store().conversations[CONV].queuedTurns).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: /queued message/i })).not.toBeInTheDocument();
  });

  it('numbers each queued control instead of repeating one name n times', async () => {
    await startBusyRun();

    type('second');
    pressEnter();
    await flush();
    type('third');
    pressEnter();
    await flush();

    expect(screen.getByRole('textbox', { name: 'Queued message 1' })).toHaveValue('second');
    expect(screen.getByRole('textbox', { name: 'Queued message 2' })).toHaveValue('third');
    expect(screen.getByRole('button', { name: 'Remove queued message 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove queued message 2' })).toBeInTheDocument();
  });
});

// ── consent ───────────────────────────────────────────────────────────────────

describe('GolemPanel consent', () => {
  const askConsent = async () => {
    hydrate({ destination: remoteDestination });
    selectFocused();
    mockRunGolemTurn.mockResolvedValueOnce(consentAdmission(RUN_A));
    render(<GolemPanel visible />);
    type('send this remotely');
    pressEnter();
    await flush();
  };

  it('shows the real destination and both choices', async () => {
    await askConsent();

    const shelf = screen.getByRole('group', { name: /approval/i });
    expect(within(shelf).getByText('anthropic')).toBeInTheDocument();
    expect(within(shelf).getByText('claude-opus')).toBeInTheDocument();
    expect(within(shelf).getByText('https://api.example.test/v1')).toBeInTheDocument();
    expect(within(shelf).getByRole('button', { name: 'Allow & send' })).toBeInTheDocument();
    expect(within(shelf).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('still offers Cancel while the shelf holds the turn', async () => {
    await askConsent();

    // A turn awaiting approval is a run the backend still owns, so the composer
    // keeps the way out that every other live phase has.
    expect(store().conversations[CONV].runs[RUN_A].phase).toBe('needs-consent');
    expect(
      screen.getByRole('button', { name: /cancel the current golem run/i })
    ).toBeInTheDocument();
  });

  it('allowing retries the same turn once with the opaque challenge id', async () => {
    await askConsent();
    mockRunGolemTurn.mockResolvedValue(acceptedAdmission(RUN_A));

    fireEvent.click(screen.getByRole('button', { name: 'Allow & send' }));
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(2);
    expect(mockRunGolemTurn.mock.calls[1][0]).toMatchObject({
      identity: runIdentity(RUN_A),
      message: 'send this remotely',
      consentChallengeId: 'challenge-1',
    });
    expect(store().conversations[CONV].pendingConsentTurn).toBeNull();
  });

  it('disables approval while the consent grant is being admitted', async () => {
    await askConsent();
    mockRunGolemTurn.mockImplementationOnce(() => new Promise(() => {}));

    const allow = screen.getByRole('button', { name: 'Allow & send' });
    fireEvent.click(allow);

    expect(allow).toBeDisabled();
  });

  it('disables cancellation while the consent grant is being admitted', async () => {
    await askConsent();
    let resolveGrant!: (value: unknown) => void;
    mockRunGolemTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGrant = resolve;
        })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allow & send' }));

    const decline = screen.getByRole('button', { name: 'Not now' });
    expect(decline).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: /cancel the current golem run/i })
    ).not.toBeInTheDocument();
    fireEvent.click(decline);
    expect(mockCancelGolemRun).not.toHaveBeenCalled();

    resolveGrant(acceptedAdmission(RUN_A));
    await flush();
    expect(
      screen.getByRole('button', { name: /cancel the current golem run/i })
    ).toBeInTheDocument();
  });

  it('declining cancels the pending run identity', async () => {
    await askConsent();

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await flush();

    expect(mockCancelGolemRun).toHaveBeenCalledTimes(1);
    expect(mockCancelGolemRun.mock.calls[0][0]).toMatchObject(runIdentity(RUN_A));
    // No second turn: declining must not smuggle the prompt out.
    expect(mockRunGolemTurn).toHaveBeenCalledTimes(1);
  });

  it('announces the shelf once rather than on every render', async () => {
    await askConsent();

    const announced = liveRegion().textContent;
    expect(announced).toMatch(/approval/i);
    expect(announced).toContain('anthropic');

    // A re-render that changes nothing about the challenge must not re-announce,
    // which for a polite region means the text must not change.
    type('unrelated keystrokes');
    expect(liveRegion().textContent).toBe(announced);
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });
});

// ── transcript and announcements ──────────────────────────────────────────────

describe('GolemPanel transcript', () => {
  const startRun = async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);
    type('what is up');
    pressEnter();
    await flush();
  };

  const delta = (text: string, seq: number) =>
    act(() => {
      store().ingestEvent(
        eventPayload({ seq, type: 'message.delta', payload: { messageId: 'm1', text } })
      );
    });

  const finish = (seq = 3) =>
    act(() => {
      store().ingestEvent(eventPayload({ seq, type: 'run.finished', payload: {} }));
    });

  it('keeps a live reply plain and parses markdown only after the run finishes', async () => {
    await startRun();
    delta('**streaming**', 2);

    const live = screen.getByText('**streaming**');
    expect(live.querySelector('strong')).toBeNull();

    finish();

    const transcript = screen.getByRole('region', { name: 'Golem transcript' });
    const settled = within(transcript).getByText('streaming');
    expect(settled.tagName).toBe('STRONG');
    expect(within(transcript).queryByText('**streaming**')).toBeNull();
  });

  it('restores ordinary list markers while leaving GFM task lists unbulleted', async () => {
    const stylesheet = applyGolemStyles();
    try {
      await startRun();
      delta('- bullet\n\n1. numbered\n\n- [ ] task', 2);
      finish();

      const bullet = screen.getByText('bullet').closest('ul');
      const numbered = screen.getByText('numbered').closest('ol');
      const task = screen.getByText('task').closest('ul');
      expect(bullet).not.toBeNull();
      expect(numbered).not.toBeNull();
      expect(task).not.toBeNull();
      expect(getComputedStyle(bullet!)).toHaveProperty('listStyle', 'disc');
      expect(getComputedStyle(numbered!)).toHaveProperty('listStyle', 'decimal');
      expect(getComputedStyle(task!)).toHaveProperty('listStyle', 'none');
    } finally {
      stylesheet.remove();
    }
  });

  it('does not expose an unsafe link destination after sanitization', async () => {
    await startRun();
    delta('[bad](javascript:alert(1))', 2);
    finish();

    const region = screen.getByRole('region', { name: 'Golem transcript' });
    expect(region).toHaveTextContent('bad');
    expect(region).not.toHaveTextContent('javascript:');
    expect(region.querySelector('a')).toBeNull();
  });

  it('renders assistant markdown but keeps raw HTML inert', async () => {
    await startRun();

    // Two blocks in one delta so the bold and the literal HTML never share a
    // paragraph: **x** must become real bold, <b>y</b> must stay visible text.
    delta('**x**\n\n<b>y</b>', 2);
    finish();

    // Real markdown: a <strong>, not the literal asterisks.
    const bold = screen.getByText('x');
    expect(bold.tagName).toBe('STRONG');
    expect(screen.queryByText('**x**')).toBeNull();

    // The security invariant: raw HTML from the model is inert text. getByText
    // is the guard — an innerHTML render would show a bold "y" whose text
    // content is "y", and this exact-text query would find nothing. No
    // rehype-raw, no dangerouslySetInnerHTML, so the <b> never becomes live.
    const literal = screen.getByText('<b>y</b>');
    expect(literal.querySelector('b')).toBeNull();
  });

  it('renders a fenced code block as a pre > code with the code text', async () => {
    await startRun();
    delta('```\nconst a = 1;\n```', 2);
    finish();

    const code = screen.getByRole('region', { name: 'Golem transcript' }).querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('const a = 1;');
  });

  it('renders a markdown list as list items', async () => {
    await startRun();
    delta('- a\n- b', 2);
    finish();

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('a');
    expect(items[1]).toHaveTextContent('b');
  });

  it('renders a link as non-navigating text with a visible destination', async () => {
    await startRun();
    delta('[t](http://x.test/p)', 2);
    finish();

    const region = screen.getByRole('region', { name: 'Golem transcript' });
    const link = screen.getByText('t');
    // In WKWebView an <a href> click navigates the whole app to an attacker
    // URL — so there must be no navigating anchor at all.
    expect(link.closest('a')).toBeNull();
    expect(region.querySelector('a[href]')).toBeNull();
    expect(region).toHaveTextContent('t (http://x.test/p)');
  });

  it('drops an image to its alt text with no img element', async () => {
    await startRun();
    delta('![a pixel](http://x.test/p.png)', 2);
    finish();

    const region = screen.getByRole('region', { name: 'Golem transcript' });
    // The webview would fetch an <img src>; alt survives as plain text instead.
    expect(screen.getByText('a pixel')).toBeInTheDocument();
    expect(region.querySelector('img')).toBeNull();
  });

  it('renders a user prompt as literal text, not markdown', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);
    type('**x**');
    pressEnter();
    await flush();

    // Markdown is assistant-only: a user's own **x** is not model output.
    const prompt = screen.getByText('**x**');
    expect(prompt.tagName).not.toBe('STRONG');
    expect(prompt.querySelector('strong')).toBeNull();
  });

  it('keeps exactly one polite live region stable through deltas', async () => {
    await startRun();

    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
    const working = liveRegion().textContent;
    expect(working).toBe('Golem is working.');

    delta('par', 2);
    delta('tial', 3);

    expect(liveRegion().textContent).toBe(working);
    expect(screen.getByText('partial')).toBeInTheDocument();
  });

  it('announces a completed message when the run finishes', async () => {
    await startRun();
    delta('all done now', 2);

    act(() => {
      store().ingestEvent(eventPayload({ seq: 3, type: 'run.finished', payload: {} }));
    });

    expect(liveRegion()).toHaveTextContent('all done now');
  });

  it('announces a failure transition', async () => {
    await startRun();

    act(() => {
      store().ingestEvent(
        eventPayload({ seq: 2, type: 'run.failed', payload: { message: 'the provider refused' } })
      );
    });

    expect(liveRegion()).toHaveTextContent(/the provider refused/);
  });

  it('announces an error that arrives without moving any phase', async () => {
    await startRun();
    expect(liveRegion()).toHaveTextContent('Golem is working.');

    mockCancelGolemRun.mockRejectedValueOnce('the backend refused the cancel');
    fireEvent.click(screen.getByRole('button', { name: /cancel the current golem run/i }));
    await flush();

    // A refused cancel puts the run back where it was, so no phase moved and
    // no run is terminal — the error row is the only thing that changed.
    expect(store().conversations[CONV].runs[RUN_A].phase).toBe('running');
    expect(liveRegion()).toHaveTextContent('the backend refused the cancel');
  });

  it('announces a cancellation transition', async () => {
    await startRun();

    act(() => {
      store().ingestRunStatus({ identity: runIdentity(RUN_A), state: 'canceled' });
    });

    expect(liveRegion()).toHaveTextContent(/cancel/i);
  });

  it('exposes the scrolling transcript as a focusable region', async () => {
    await startRun();

    const region = screen.getByRole('region', { name: 'Golem transcript' });
    // WKWebView does not make a bare scroll container keyboard-focusable, so a
    // keyboard-only reader could not scroll back through the conversation.
    expect(region).toHaveAttribute('tabindex', '0');
    act(() => region.focus());
    expect(document.activeElement).toBe(region);
    // `log` would carry an implicit aria-live and fight the one deliberate
    // polite region.
    expect(region).not.toHaveAttribute('aria-live');
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('follows the stream while the reader is already at the newest row', async () => {
    await startRun();
    const region = screen.getByRole('region', { name: 'Golem transcript' });
    fakeScroll(region, { scrollTop: 400, scrollHeight: 500, clientHeight: 100 });

    delta('streaming on', 2);

    expect(region.scrollTop).toBe(500);
  });

  it('leaves a reader who has scrolled back exactly where they are', async () => {
    await startRun();
    const region = screen.getByRole('region', { name: 'Golem transcript' });
    fakeScroll(region, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });

    delta('streaming on', 2);

    expect(region.scrollTop).toBe(0);
  });

  it('leaves every entry but the streaming one referentially stable across a delta', async () => {
    await startRun();
    delta('first', 2);
    const before = store().conversations[CONV].transcript;

    delta(' and more', 3);
    const after = store().conversations[CONV].transcript;

    // Reference stability is what lets the memoized row skip: the array is new
    // on every publish, but only the entry the delta touched is. Asserting the
    // enabling condition rather than a render count — a render-count spy would
    // need the in-file row component exported, which the plan forbids.
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[after.length - 1]).not.toBe(before[before.length - 1]);
  });
});

// ── focus ─────────────────────────────────────────────────────────────────────

describe('GolemPanel focus', () => {
  it('focuses the composer when the focus revision changes, but not on streamed events', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    type('draft');
    pressEnter();
    await flush();

    act(() => composer().blur());
    expect(document.activeElement).not.toBe(composer());

    act(() => {
      store().selectConversation(CONV);
    });
    expect(document.activeElement).toBe(composer());

    act(() => composer().blur());
    act(() => {
      store().ingestEvent(
        eventPayload({ seq: 2, type: 'message.delta', payload: { messageId: 'm1', text: 'hi' } })
      );
    });

    expect(document.activeElement).not.toBe(composer());
  });
});

// ── conversations and background runs ─────────────────────────────────────────

describe('GolemPanel conversations', () => {
  const withBackground = () => {
    hydrate({
      available: false,
      identity: { repoEpoch: EPOCH, workspaceId: OTHER_WS, conversationId: OTHER_CONV },
      workspaceLabel: 'Backend',
      initError: 'Backend Golem is misconfigured.',
    });
    hydrate({
      activeRuns: [
        {
          identity: { ...runIdentity(RUN_BG), workspaceId: 'infra', conversationId: 'conv-infra' },
          workspaceLabel: 'Infra',
          state: 'running',
        },
      ],
    });
    selectFocused();
  };

  it('lists the focused, background, and failed conversations', () => {
    withBackground();
    render(<GolemPanel visible />);

    const list = screen.getByRole('group', { name: /conversations/i });
    expect(within(list).getByRole('button', { name: /Frontend/ })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Backend/ })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /Infra/ })).toBeInTheDocument();
  });

  it('selecting another conversation never changes the IDE workspace', () => {
    withBackground();
    useIDEStore.setState({ activeWorkspaceId: WS });
    render(<GolemPanel visible />);

    const list = screen.getByRole('group', { name: /conversations/i });
    fireEvent.click(within(list).getByRole('button', { name: /Backend/ }));

    expect(store().selectedConversationId).toBe(OTHER_CONV);
    expect(useIDEStore.getState().activeWorkspaceId).toBe(WS);
  });

  it('keeps the focused conversation own run out of the background strip', () => {
    hydrate({
      activeRuns: [{ identity: runIdentity(RUN_BG), workspaceLabel: 'Frontend', state: 'running' }],
    });
    selectFocused();
    render(<GolemPanel visible />);

    // The composer's own Cancel already governs this run; repeating it in the
    // strip would offer the same run twice, inches apart.
    expect(
      screen.getByRole('button', { name: /cancel the current golem run/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /show the golem run in frontend/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /cancel the golem run in frontend/i })
    ).not.toBeInTheDocument();
  });

  it('cancels a background run through that run own identity', async () => {
    withBackground();
    render(<GolemPanel visible />);

    fireEvent.click(screen.getByRole('button', { name: /cancel the golem run in infra/i }));
    await flush();

    expect(mockCancelGolemRun).toHaveBeenCalledTimes(1);
    expect(mockCancelGolemRun.mock.calls[0][0]).toMatchObject({
      repoEpoch: EPOCH,
      workspaceId: 'infra',
      conversationId: 'conv-infra',
      runId: RUN_BG,
    });
  });

  it('names the background run phase, which no other surface reports', () => {
    withBackground();
    render(<GolemPanel visible />);

    // The visible row reads "Infra · running"; an aria-label that stopped at
    // the workspace would hide the phase from a screen reader entirely, and the
    // status bar only ever reports a count.
    expect(
      screen.getByRole('button', { name: 'Show the Golem run in Infra: running' })
    ).toBeInTheDocument();
  });

  it('selects a background run by its own conversation, not the focused one', () => {
    withBackground();
    render(<GolemPanel visible />);

    fireEvent.click(screen.getByRole('button', { name: /show the golem run in infra/i }));

    expect(store().selectedConversationId).toBe('conv-infra');
    expect(useIDEStore.getState().activeWorkspaceId).toBe(
      useIDEStore.getInitialState().activeWorkspaceId
    );
  });
});

// ── cancel and retry ──────────────────────────────────────────────────────────

describe('GolemPanel cancel and retry', () => {
  it('offers Cancel as a real button while a run is live', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);
    type('long one');
    pressEnter();
    await flush();

    const cancel = screen.getByRole('button', { name: /cancel the current golem run/i });
    expect(cancel.tagName).toBe('BUTTON');

    fireEvent.click(cancel);
    await flush();

    expect(mockCancelGolemRun).toHaveBeenCalledTimes(1);
    expect(mockCancelGolemRun.mock.calls[0][0]).toMatchObject(runIdentity(RUN_A));
  });

  it('offers Retry as a real button for a failed turn it still holds the request for', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);
    type('retry me');
    pressEnter();
    await flush();

    act(() => {
      store().ingestEvent(
        eventPayload({ seq: 2, type: 'run.failed', payload: { message: 'boom' } })
      );
    });

    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry.tagName).toBe('BUTTON');

    mockRunGolemTurn.mockResolvedValue(acceptedAdmission(RUN_B));
    fireEvent.click(retry);
    await flush();

    expect(mockRunGolemTurn).toHaveBeenCalledTimes(2);
    expect(mockRunGolemTurn.mock.calls[1][0]).toMatchObject({
      identity: runIdentity(RUN_B),
      message: 'retry me',
    });
  });

  it('never offers Retry for a status-hydrated run it has no request for', () => {
    hydrate({
      activeRuns: [{ identity: runIdentity(RUN_BG), workspaceLabel: 'Frontend', state: 'running' }],
    });
    selectFocused();
    render(<GolemPanel visible />);

    act(() => {
      store().ingestRunStatus({
        identity: runIdentity(RUN_BG),
        state: 'failed',
        message: 'died in the background',
      });
    });

    // Surfaced (transcript row plus the announcement) but not retryable: the
    // store never captured a request for a run it only learned about by status.
    expect(screen.getAllByText(/died in the background/).length).toBeGreaterThan(0);
    expect(store().conversations[CONV].lastFailedTurn).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

// ── bar tile ──────────────────────────────────────────────────────────────────

describe('GolemPanel header', () => {
  it('shows the Golem logo decoratively in the bar tile beside the GOLEM name', () => {
    hydrate();
    selectFocused();
    const { container } = render(<GolemPanel visible />);

    // GOLEM stays the accessible name; the image is decorative, so it must be
    // hidden from the accessibility tree — empty alt, inside the hidden tile.
    expect(screen.getByText('GOLEM')).toBeInTheDocument();
    const logo = container.querySelector('img');
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute('alt', '');
    expect(logo?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

// ── tool activity clustering ──────────────────────────────────────────────────

describe('GolemPanel tool clustering', () => {
  beforeEach(() => {
    hydrate();
    selectFocused();
  });

  const startRun = async () => {
    const view = render(<GolemPanel visible />);
    type('go');
    pressEnter();
    await flush();
    return view;
  };

  const toolFinished = (
    seq: number,
    over: { toolCallId?: string; name?: string; preview?: string; isError?: boolean } = {}
  ) =>
    act(() => {
      store().ingestEvent(
        eventPayload({
          seq,
          type: 'tool.finished',
          payload: {
            toolCallId: over.toolCallId ?? `call-${seq}`,
            name: over.name ?? 'search',
            preview: over.preview ?? '',
            isError: over.isError ?? false,
          },
        })
      );
    });

  const toolStarted = (
    seq: number,
    over: { toolCallId?: string; name?: string; preview?: string } = {}
  ) =>
    act(() => {
      store().ingestEvent(
        eventPayload({
          seq,
          type: 'tool.started',
          payload: {
            toolCallId: over.toolCallId ?? `call-${seq}`,
            name: over.name ?? 'search',
            preview: over.preview ?? '',
          },
        })
      );
    });

  const assistantDelta = (seq: number, text: string) =>
    act(() => {
      store().ingestEvent(
        eventPayload({ seq, type: 'message.delta', payload: { messageId: 'm1', text } })
      );
    });

  it('folds consecutive tool calls into one collapsed cluster and reveals the chips on expand', async () => {
    await startRun();
    toolFinished(2, { toolCallId: 'c1', name: 'search' });
    toolFinished(3, { toolCallId: 'c2', name: 'search' });
    toolFinished(4, { toolCallId: 'c3', name: 'search' });
    toolFinished(5, { toolCallId: 'c4', name: 'glob' });

    const header = screen.getByRole('button', { name: /4 tool calls, all completed/i });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveTextContent('4 tools');
    expect(header).toHaveTextContent('search ×3, glob');
    // Collapsed: the individual chips are not in the DOM at all.
    expect(screen.queryAllByText('search')).toHaveLength(0);
    expect(screen.queryByText('glob')).not.toBeInTheDocument();

    fireEvent.click(header);

    expect(screen.getByRole('button', { name: /4 tool calls, all completed/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getAllByText('search')).toHaveLength(3);
    expect(screen.getByText('glob')).toBeInTheDocument();
  });

  it('splits tool calls into two clusters when a non-tool entry falls between them', async () => {
    await startRun();
    toolFinished(2, { toolCallId: 'a1', name: 'search' });
    toolFinished(3, { toolCallId: 'a2', name: 'search' });
    assistantDelta(4, 'thinking'); // a reply breaks the run of tools
    toolFinished(5, { toolCallId: 'b1', name: 'glob' });
    toolFinished(6, { toolCallId: 'b2', name: 'glob' });

    const clusters = screen.getAllByRole('button', { name: /tool calls,/i });
    expect(clusters).toHaveLength(2);
    // Never one combined cluster spanning the reply.
    expect(screen.queryByRole('button', { name: /4 tool calls/i })).not.toBeInTheDocument();
  });

  it('renders a lone tool call as a chip with no cluster wrapper', async () => {
    await startRun();
    toolFinished(2, { toolCallId: 'solo', name: 'search' });

    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tool calls,/i })).not.toBeInTheDocument();
  });

  it('defaults the newest cluster to expanded while it holds a running tool', async () => {
    await startRun();
    toolFinished(2, { toolCallId: 'd1', name: 'search' }); // done
    toolStarted(3, { toolCallId: 'd2', name: 'glob' }); // still running

    // Last cluster, holds a running tool, so it opens without a click.
    const header = screen.getByRole('button', { name: /2 tool calls, in progress/i });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('glob')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('reveals a tool chip detail as text, rendering markup literally', async () => {
    const { container } = await startRun();
    toolFinished(2, { toolCallId: 'call-x', name: 'search', preview: '<b>x</b>' });

    const chip = screen.getByRole('button', { name: /search/i });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');

    // The preview renders as literal text, never a real <b> element.
    const preview = screen.getByText('<b>x</b>');
    expect(preview.querySelector('b')).toBeNull();
    expect(screen.getByText('call-x')).toBeInTheDocument();

    // The raw provider event body is owner-only and never projected (#271 B4),
    // so the surface — which renders the same projection in both windows —
    // has nothing to dump. No <pre> means no route for unsanitized markup.
    expect(container.querySelector('pre')).toBeNull();
  });

  it('says so when a tool call reported no preview, rather than inventing detail', async () => {
    await startRun();
    toolFinished(2, { toolCallId: 'call-y', name: 'read', preview: '' });

    fireEvent.click(screen.getByRole('button', { name: /read/i }));
    expect(screen.getByText('This tool call reported no preview.')).toBeInTheDocument();
  });

  it('keeps the streaming assistant reply as the transcript last child after a tool cluster', async () => {
    await startRun();
    toolFinished(2, { toolCallId: 'q1', name: 'search' });
    toolFinished(3, { toolCallId: 'q2', name: 'search' });
    assistantDelta(4, 'the answer');

    const region = screen.getByRole('region', { name: 'Golem transcript' });
    // The caret selector is `.entry.assistant:last-child`; the reply must stay
    // the transcript's last child for the streaming caret to keep matching.
    const last = region.lastElementChild;
    expect(last?.className).toContain('entry');
    expect(last?.className).toContain('assistant');
    expect(last).toHaveTextContent('the answer');
  });
});

// ── composer auto-grow ────────────────────────────────────────────────────────

describe('GolemPanel composer auto-grow', () => {
  beforeEach(() => {
    hydrate();
    selectFocused();
  });

  it('grows the composer to fit a multi-line draft and shrinks back when it clears', () => {
    render(<GolemPanel visible />);
    const box = composer();
    // jsdom has no layout, so the grow target has to be supplied — the assertion
    // is whether the panel wrote a clamped scrollHeight to the inline height.
    let scrollHeight = 132;
    Object.defineProperty(box, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    type('a\nb\nc\nd\ne');
    expect(box.style.height).toBe('132px');

    scrollHeight = 400; // taller than the 160px ceiling
    type('a\nb\nc\nd\ne\nf\ng\nh');
    expect(box.style.height).toBe('160px');

    scrollHeight = 44;
    type(''); // cleared after a send
    expect(box.style.height).toBe('44px');
  });
});

// ── new chat ──────────────────────────────────────────────────────────────────

describe('GolemPanel new chat', () => {
  const newChatButton = () => screen.getByRole('button', { name: /new chat/i });

  it('clears a populated transcript and returns focus to the composer', async () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    type('hello there');
    pressEnter();
    await flush();
    act(() => {
      store().ingestEvent(
        eventPayload({
          seq: 2,
          type: 'message.delta',
          payload: { messageId: 'm1', text: 'a reply' },
        })
      );
    });
    act(() => {
      store().ingestEvent(eventPayload({ seq: 3, type: 'run.finished', payload: {} }));
    });

    // Idle with content: the reset is available.
    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(newChatButton()).toBeEnabled();

    fireEvent.click(newChatButton());

    expect(screen.queryByText('hello there')).not.toBeInTheDocument();
    expect(store().conversations[CONV].transcript).toHaveLength(0);
    // The reset re-arms the composer the same way selecting the panel does.
    expect(document.activeElement).toBe(composer());
  });

  it('is disabled while a run is live, with a reason', async () => {
    hydrate();
    selectFocused();
    mockRunGolemTurn.mockReturnValue(new Promise(() => {}));
    render(<GolemPanel visible />);

    type('long one');
    pressEnter();
    await flush();

    const button = newChatButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Finish or cancel the current run first');
  });

  it('is disabled while a consent is pending', async () => {
    hydrate({ destination: remoteDestination });
    selectFocused();
    mockRunGolemTurn.mockResolvedValueOnce(consentAdmission(RUN_A));
    render(<GolemPanel visible />);

    type('send this remotely');
    pressEnter();
    await flush();

    expect(newChatButton()).toBeDisabled();
  });

  it('is disabled when the conversation is already empty', () => {
    hydrate();
    selectFocused();
    render(<GolemPanel visible />);

    expect(newChatButton()).toBeDisabled();
  });
});

// ── configuration routing ────────────────────────────────────────────────────

describe('configuration routing', () => {
  it('offers Review configuration from the unavailable state', async () => {
    hydrate({ available: false, initError: 'golem.yaml could not be read.' });
    selectFocused();
    render(<GolemPanel visible />);

    await userEvent.click(screen.getByRole('button', { name: /review configuration/i }));

    // The editor-area tab is the one configuration surface now (#271 D1): the
    // panel keeps showing the chat, it does not swap itself out for a readout.
    expect(useGolemStore.getState()).toMatchObject({
      configTabOpen: true,
      configTabFocused: true,
    });
    expect(screen.queryByRole('heading', { name: /configuration/i })).toBeNull();
  });
});

// ── command palette focus interplay ──────────────────────────────────────────
//
// The command-palette test file (CommandPalette.test.tsx) renders the palette
// in isolation with stub commands, so it cannot exercise this: the real command
// palette closing must not steal focus back from the configuration surface it
// just opened. Since #263 Slice B that surface is the app-global workspace tab
// the Editor mounts; this harness stands in for the Editor so the real palette
// and the real workspace still meet somewhere.

function PaletteAndPanelHarness() {
  const [open, setOpen] = useState(false);
  const commands = useMemo(() => createCommands(jest.fn()), []);
  const configTabOpen = useGolemStore((state) => state.configTabOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <GolemPanel visible />
      {configTabOpen && <GolemConfigWorkspace onClose={() => {}} />}
      <CommandPalette open={open} commands={commands} onClose={() => setOpen(false)} />
    </>
  );
}

describe('configuration workspace and command palette focus interplay', () => {
  it('opens the app-global tab and lets its heading keep focus after the palette closes', async () => {
    hydrate();
    selectFocused();
    const user = userEvent.setup();
    render(<PaletteAndPanelHarness />);

    await user.click(screen.getByRole('button', { name: 'Open palette' }));
    const combobox = await screen.findByRole('combobox', { name: 'Command palette' });
    await user.type(combobox, 'configuration');
    await user.keyboard('{Enter}');

    expect(useGolemStore.getState().configTabOpen).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Golem Configuration' })).toHaveFocus()
    );
  });
});

// ── the GOLEM command bar (#271 Task A6) ─────────────────────────────────────

describe('#271 command bar', () => {
  it('renders the GOLEM bar and routes the gear to the configuration tab', () => {
    render(<GolemPanel visible />);
    expect(screen.getByRole('group', { name: 'Golem panel header' })).toBeInTheDocument();
    expect(screen.getByText('GOLEM')).toBeInTheDocument();
    // No hydrated destination: the chips row still says which machine it is,
    // honestly, rather than dropping the classification badge entirely.
    expect(screen.getByText('Unknown')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
    expect(useGolemStore.getState()).toMatchObject({ configTabOpen: true, configTabFocused: true });
    expect(useGitStore.getState().diffFocused).toBe(false);
    // The in-panel readout is gone (D1): nothing switches the panel's view.
    expect(screen.queryByRole('heading', { name: /configuration/i })).toBeNull();
  });

  it('collapses the island from the bar', () => {
    useIDEStore.getState().revealCenterPanel('golem');
    render(<GolemPanel visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Golem panel' }));
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(true);
  });

  it('keeps the connection details behind an accessible disclosure closed by Escape', async () => {
    hydrate();
    render(<GolemPanel visible />);
    const summary = screen.getByText('Connection');
    expect(screen.getByText('Context: prompt only')).not.toBeVisible();
    await userEvent.click(summary);
    expect(screen.getByText('Context: prompt only')).toBeVisible();

    // Escape reaches the disclosure from anywhere inside it, so the assertion
    // starts from focus that is not already on the summary.
    summary.blur();
    fireEvent.keyDown(summary.closest('details') as HTMLElement, { key: 'Escape' });

    expect(screen.getByText('Context: prompt only')).not.toBeVisible();
    // Dismissing a disclosure must hand the keyboard back to the control that
    // opened it, not drop focus on the document (spec §7).
    expect(document.activeElement).toBe(summary);
  });
});
