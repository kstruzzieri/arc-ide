/**
 * Task B4 — the passive Golem chat surface.
 *
 * Nothing here touches a store. The surface is driven exactly the way the
 * undocked window will drive it: a `GolemView` that has been through
 * `parseGolemView` (so the fixture is provably a legal wire payload), a draft
 * string with a host callback, and the nine explicit actions.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { GolemSurface, type GolemSurfaceActions } from '../../../components/Golem/GolemSurface';
import { parseGolemView } from '../../../types/golemWindow';
import type { GolemView } from '../../../types/golemWindow';

const identity = { repoEpoch: 7, workspaceId: 'frontend', conversationId: 'conv-frontend' };
const other = { repoEpoch: 7, workspaceId: 'backend', conversationId: 'conv-backend' };
const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_BG = '33333333-3333-4333-8333-333333333333';

const destination = {
  provider: 'anthropic',
  model: 'claude-opus',
  endpoint: 'https://api.example.test/v1',
  classification: 'remote' as const,
  digest: 'digest-remote',
};

const actionsMock = (): jest.Mocked<GolemSurfaceActions> => ({
  send: jest.fn(),
  allowAndSend: jest.fn(),
  cancelRun: jest.fn(),
  retry: jest.fn(),
  updateQueued: jest.fn(),
  removeQueued: jest.fn(),
  select: jest.fn(),
  clear: jest.fn(),
  openConfig: jest.fn(),
});

/** A ready, bound, idle projection — validated, so it is a legal wire payload. */
function baseView(over: Record<string, unknown> = {}): GolemView {
  return parseGolemView({
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
        destination,
        activeRunId: null,
        queuedTurns: [],
        transcript: [],
        runs: {},
        pendingConsentTurn: null,
        lastFailedTurn: false,
      },
    },
    ...over,
  });
}

const composer = () => screen.getByRole('textbox', { name: /message golem/i });
const sendButton = () => screen.getByRole('button', { name: 'Send' });

interface HarnessProps {
  view: GolemView;
  actions: GolemSurfaceActions;
  frozen?: boolean;
  composerPending?: boolean;
  visible?: boolean;
  focusRevision?: number;
  initialDrafts?: Record<string, string>;
}

/**
 * The host, in miniature: it owns a draft map keyed by conversation, exactly
 * like `useDraftStore`, so "typing only changes the supplied callback" and
 * "switching conversation preserves each draft" are observable.
 */
function Harness({
  view,
  actions,
  frozen = false,
  composerPending = false,
  visible = true,
  focusRevision = 0,
  initialDrafts = {},
}: HarnessProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const selected = view.selectedConversationId ?? '';
  return (
    <GolemSurface
      view={view}
      draft={drafts[selected] ?? ''}
      onDraftChange={(text) => setDrafts((current) => ({ ...current, [selected]: text }))}
      actions={actions}
      frozen={frozen}
      composerPending={composerPending}
      focusRevision={focusRevision}
      visible={visible}
    />
  );
}

describe('GolemSurface dispatch', () => {
  it('sends the conversation id and the typed text explicitly', () => {
    const actions = actionsMock();
    render(<Harness view={baseView()} actions={actions} />);

    fireEvent.change(composer(), { target: { value: 'explain this' } });
    expect(composer()).toHaveValue('explain this');
    // Typing changes only the host's callback: no action is dispatched for it.
    expect(actions.send).not.toHaveBeenCalled();

    fireEvent.click(sendButton());
    expect(actions.send).toHaveBeenCalledWith(identity.conversationId, 'explain this');
  });

  it('sends on Enter but leaves an IME-composing Enter to the composition', () => {
    const actions = actionsMock();
    render(
      <Harness
        view={baseView()}
        actions={actions}
        initialDrafts={{ [identity.conversationId]: 'hi' }}
      />
    );

    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    expect(actions.send).not.toHaveBeenCalled();

    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(actions.send).toHaveBeenCalledTimes(1);
  });

  it('approves the exact run and challenge the user is looking at', () => {
    const actions = actionsMock();
    const challenge = {
      id: 'challenge-1',
      identity: { ...identity, runId: RUN_A },
      destination,
      destinationDigest: destination.digest,
      expiresAt: Date.now() + 60_000,
    };
    const view = baseView({
      conversations: {
        [identity.conversationId]: {
          ...baseView().conversations[identity.conversationId],
          activeRunId: RUN_A,
          runs: {
            [RUN_A]: {
              identity: { ...identity, runId: RUN_A },
              phase: 'needs-consent',
              lastSeq: -1,
            },
          },
          pendingConsentTurn: { identity: { ...identity, runId: RUN_A }, challenge },
        },
      },
    });
    render(<Harness view={view} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: /allow & send/i }));
    expect(actions.allowAndSend).toHaveBeenCalledWith(
      identity.conversationId,
      RUN_A,
      'challenge-1'
    );

    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(actions.cancelRun).toHaveBeenCalledWith(RUN_A);
  });

  it('edits and removes queued turns and offers Retry from the projected flag', () => {
    const actions = actionsMock();
    const view = baseView({
      conversations: {
        [identity.conversationId]: {
          ...baseView().conversations[identity.conversationId],
          lastFailedTurn: true,
          queuedTurns: [{ queueId: 'q1', state: 'queued', message: 'next up', contextRefs: [] }],
        },
      },
    });
    render(<Harness view={view} actions={actions} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Queued message 1' }), {
      target: { value: 'next up, revised' },
    });
    expect(actions.updateQueued).toHaveBeenCalledWith(
      identity.conversationId,
      'q1',
      'next up, revised'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message 1' }));
    expect(actions.removeQueued).toHaveBeenCalledWith(identity.conversationId, 'q1');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(actions.retry).toHaveBeenCalledWith(identity.conversationId);
  });

  it('cancels a background run by that run own identity', () => {
    const actions = actionsMock();
    const base = baseView();
    const view = baseView({
      conversations: {
        ...base.conversations,
        [other.conversationId]: {
          identity: other,
          workspaceLabel: 'Backend',
          available: true,
          needsConsent: false,
          warnings: [],
          initError: null,
          destination: null,
          activeRunId: RUN_BG,
          queuedTurns: [],
          transcript: [],
          runs: {
            [RUN_BG]: { identity: { ...other, runId: RUN_BG }, phase: 'running', lastSeq: 2 },
          },
          pendingConsentTurn: null,
          lastFailedTurn: false,
        },
      },
    });
    render(<Harness view={view} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel the golem run in backend/i }));
    expect(actions.cancelRun).toHaveBeenCalledWith(RUN_BG);

    fireEvent.click(screen.getByRole('button', { name: /show the golem run in backend/i }));
    expect(actions.select).toHaveBeenCalledWith(other.conversationId);
  });

  it('opens the configuration from an unavailable notice', () => {
    const actions = actionsMock();
    const view = baseView({
      conversations: {
        [identity.conversationId]: {
          ...baseView().conversations[identity.conversationId],
          available: false,
          initError: null,
        },
      },
    });
    render(<Harness view={view} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: 'Review configuration' }));
    expect(actions.openConfig).toHaveBeenCalledTimes(1);
  });
});

describe('GolemSurface barriers', () => {
  const withTwoConversations = () => {
    const base = baseView();
    return baseView({
      conversations: {
        ...base.conversations,
        [other.conversationId]: {
          identity: other,
          workspaceLabel: 'Backend',
          available: true,
          needsConsent: false,
          warnings: [],
          initError: null,
          destination: null,
          activeRunId: null,
          queuedTurns: [],
          transcript: [],
          runs: {},
          pendingConsentTurn: null,
          lastFailedTurn: false,
        },
      },
    });
  };

  it('frozen blocks every button, the composer and the keyboard', () => {
    const actions = actionsMock();
    const view = baseView({
      conversations: {
        [identity.conversationId]: {
          ...baseView().conversations[identity.conversationId],
          lastFailedTurn: true,
          activeRunId: RUN_A,
          runs: {
            [RUN_A]: { identity: { ...identity, runId: RUN_A }, phase: 'running', lastSeq: 1 },
          },
          queuedTurns: [{ queueId: 'q1', state: 'queued', message: 'q', contextRefs: [] }],
        },
      },
    });
    render(
      <Harness
        view={view}
        actions={actions}
        frozen
        initialDrafts={{ [identity.conversationId]: 'mid-thought' }}
      />
    );

    expect(composer()).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove queued message 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel the current golem run/i })).toBeDisabled();

    // The handlers refuse too, so a keydown or click already in flight when the
    // barrier went up cannot slip an action past it — including an IME Enter.
    fireEvent.keyDown(composer(), { key: 'Enter' });
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    fireEvent.click(sendButton());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: /cancel the current golem run/i }));
    fireEvent.change(composer(), { target: { value: 'typed while frozen' } });

    expect(actions.send).not.toHaveBeenCalled();
    expect(actions.retry).not.toHaveBeenCalled();
    expect(actions.cancelRun).not.toHaveBeenCalled();
    expect(composer()).toHaveValue('mid-thought');
  });

  it('composerPending locks only the selected composer and its Send', () => {
    const actions = actionsMock();
    const view = withTwoConversations();
    render(
      <Harness
        view={view}
        actions={actions}
        composerPending
        initialDrafts={{ [identity.conversationId]: 'in flight' }}
      />
    );

    expect(composer()).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(actions.send).not.toHaveBeenCalled();

    // Everything that is not this composer stays usable.
    const switcher = screen.getByRole('button', { name: 'Backend' });
    expect(switcher).toBeEnabled();
    fireEvent.click(switcher);
    expect(actions.select).toHaveBeenCalledWith(other.conversationId);
  });

  it('keeps each conversation own draft across a selection change', () => {
    const actions = actionsMock();
    const view = withTwoConversations();
    const { rerender } = render(
      <Harness
        view={view}
        actions={actions}
        initialDrafts={{
          [identity.conversationId]: 'frontend draft',
          [other.conversationId]: 'backend draft',
        }}
      />
    );
    expect(composer()).toHaveValue('frontend draft');

    rerender(
      <Harness
        view={{ ...view, selectedConversationId: other.conversationId }}
        actions={actions}
        initialDrafts={{
          [identity.conversationId]: 'frontend draft',
          [other.conversationId]: 'backend draft',
        }}
      />
    );
    expect(composer()).toHaveValue('backend draft');
  });
});

describe('GolemSurface visibility', () => {
  it('a hidden surface neither takes focus nor announces', () => {
    const actions = actionsMock();
    const view = baseView({
      conversations: {
        [identity.conversationId]: {
          ...baseView().conversations[identity.conversationId],
          runs: {
            [RUN_A]: {
              identity: { ...identity, runId: RUN_A },
              phase: 'failed',
              lastSeq: 1,
              error: 'the provider refused',
            },
          },
        },
      },
    });
    const { rerender } = render(
      <Harness view={view} actions={actions} visible={false} focusRevision={0} />
    );

    // A request raised while hidden waits rather than being dropped, and the
    // hidden host stays silent so two windows never speak the same line. The
    // region must be *absent*, not merely empty: a live region that mounts
    // with content already in it is not announced, so a region parked here
    // holding the last reply would re-announce it on expand or re-dock.
    rerender(<Harness view={view} actions={actions} visible={false} focusRevision={1} />);
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();
    expect(document.activeElement).not.toBe(composer());

    rerender(<Harness view={view} actions={actions} visible focusRevision={1} />);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'the provider refused'
    );
    expect(document.activeElement).toBe(composer());
  });

  it('leaves the focus request armed while the composer is locked', () => {
    const actions = actionsMock();
    const view = baseView();
    const { rerender } = render(
      <Harness view={view} actions={actions} composerPending focusRevision={0} />
    );

    rerender(<Harness view={view} actions={actions} composerPending focusRevision={2} />);
    expect(document.activeElement).not.toBe(composer());

    // Still armed once the lock opens: an unconsumed request is not a lost one.
    rerender(<Harness view={view} actions={actions} focusRevision={2} />);
    expect(document.activeElement).toBe(composer());
  });

  // #271 B7. A view with no conversation cannot answer a focus request with the
  // composer, and the projection cannot say whether one is still coming: the
  // pre-bind state and "no repository open" are the same state. So the request
  // is diverted to a real control now *and* kept for the composer.
  it('lands a focus request on the first available control when the composer is disabled', () => {
    const actions = actionsMock();
    const view = baseView({ selectedConversationId: null, conversations: {} });
    const { rerender } = render(<Harness view={view} actions={actions} focusRevision={0} />);
    const textarea = composer();
    expect(textarea).toBeDisabled();

    rerender(<Harness view={view} actions={actions} focusRevision={1} />);
    expect(document.activeElement).not.toBe(textarea);
    // The only named, reachable thing this view offers.
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Golem transcript' }));

    // Diverted once per revision: a later unrelated render must not pull the
    // focus back off wherever the user has since moved it.
    (document.activeElement as HTMLElement).blur();
    rerender(<Harness view={view} actions={actions} focusRevision={1} />);
    expect(document.activeElement).toBe(document.body);

    // Still the composer's request, though: a conversation arriving on the same
    // revision claims it, which is what makes an unbound window's ⌘⇧I land.
    rerender(<Harness view={baseView()} actions={actions} focusRevision={1} />);
    expect(document.activeElement).toBe(composer());
  });

  it('prefers a real control over the transcript when the view offers one', () => {
    const actions = actionsMock();
    const view = baseView({
      selectedConversationId: null,
      conversations: {
        [identity.conversationId]: baseView().conversations[identity.conversationId],
        [other.conversationId]: {
          ...baseView().conversations[identity.conversationId],
          identity: other,
          workspaceLabel: 'Backend',
        },
      },
    });
    const { rerender } = render(<Harness view={view} actions={actions} focusRevision={0} />);
    rerender(<Harness view={view} actions={actions} focusRevision={1} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Frontend' }));
  });
});
