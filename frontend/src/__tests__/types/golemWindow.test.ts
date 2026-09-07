import { GolemContractError } from '../../types/golem';
import {
  parseGolemAck,
  parseGolemDraftMap,
  parseGolemViewAction,
  parseGolemViewError,
  parseGolemWindowBootstrap,
  parseGolemWindowEnvelope,
  parseGolemWindowState,
  type GolemView,
  type GolemWindowState,
} from '../../types/golemWindow';

it('parses a window state and rejects unknown modes and phases', () => {
  expect(
    parseGolemWindowState({
      mode: 'undocked',
      phase: 'ready',
      instance: 3,
      restorePending: false,
      stateRevision: 4,
      handoff: 1,
    })
  ).toEqual({
    mode: 'undocked',
    phase: 'ready',
    instance: 3,
    restorePending: false,
    stateRevision: 4,
    handoff: 1,
  });
  expect(() =>
    parseGolemWindowState({
      mode: 'sideways',
      phase: 'ready',
      instance: 3,
      restorePending: false,
      stateRevision: 4,
      handoff: 1,
    })
  ).toThrow(GolemContractError);
  expect(() =>
    parseGolemWindowState({
      mode: 'docked',
      phase: 'flying',
      instance: 0,
      restorePending: false,
      stateRevision: 0,
      handoff: 0,
    })
  ).toThrow(GolemContractError);
});

it('carries Go’s failure reason only when it is a non-blank string', () => {
  const base = {
    mode: 'undocked',
    phase: 'ready',
    instance: 3,
    restorePending: false,
    stateRevision: 4,
    handoff: 1,
  };
  expect(parseGolemWindowState({ ...base, reason: 'draft transfer deadline expired' })).toEqual({
    ...base,
    reason: 'draft transfer deadline expired',
  });
  // `omitempty` on the wire: absent and blank both mean "no reason".
  expect(parseGolemWindowState(base)).not.toHaveProperty('reason');
  expect(parseGolemWindowState({ ...base, reason: '   ' })).not.toHaveProperty('reason');
  // Bounded like every other display message.
  expect(parseGolemWindowState({ ...base, reason: 'x'.repeat(1000) }).reason!.length).toBe(200);
  expect(() => parseGolemWindowState({ ...base, reason: 7 })).toThrow(GolemContractError);
  expect(() => parseGolemWindowState({ ...base, reason: null })).toThrow(GolemContractError);
});

it('parses an envelope but leaves the payload untyped', () => {
  const env = parseGolemWindowEnvelope({
    from: 'satellite',
    message: {
      kind: 'action',
      instance: 1,
      id: 4,
      revision: 0,
      handoff: 0,
      payload: { type: 'select', conversationId: 'c1' },
    },
  });
  expect(env.from).toBe('satellite');
  expect(env.message.kind).toBe('action');
  expect(env.message.id).toBe(4);
  expect(() => parseGolemWindowEnvelope({ from: 'stranger', message: {} })).toThrow(
    GolemContractError
  );
});

it('accepts projection error envelopes with a bounded nonblank reason', () => {
  const envelope = parseGolemWindowEnvelope({
    from: 'main',
    message: {
      kind: 'view-error',
      instance: 1,
      id: 0,
      revision: 3,
      handoff: 0,
      payload: { reason: 'projection unavailable' },
    },
  });
  expect(parseGolemViewError(envelope.message.payload)).toBe('projection unavailable');
  expect(parseGolemViewError({ reason: 'x'.repeat(300) })).toHaveLength(200);
  for (const value of [null, {}, { reason: null }, { reason: '' }, { reason: '   ' }]) {
    expect(() => parseGolemViewError(value)).toThrow(GolemContractError);
  }
});

it('parses every action variant and rejects unknown or malformed ones', () => {
  expect(parseGolemViewAction({ type: 'send', conversationId: 'c1', text: 'hi' })).toEqual({
    type: 'send',
    conversationId: 'c1',
    text: 'hi',
  });
  expect(parseGolemViewAction({ type: 'openConfig' })).toEqual({ type: 'openConfig' });
  expect(() => parseGolemViewAction({ type: 'send', conversationId: 'c1' })).toThrow(
    GolemContractError
  );
  expect(() => parseGolemViewAction({ type: 'patchStore', set: {} })).toThrow(GolemContractError);
});

const bootstrapState: GolemWindowState = {
  mode: 'undocked',
  phase: 'ready',
  instance: 3,
  restorePending: false,
  stateRevision: 4,
  handoff: 1,
};

const bootstrapView: GolemView = {
  bridgePhase: 'ready',
  bridgeError: null,
  hydratedIdentity: null,
  selectedConversationId: null,
  conversations: {},
  composerFocusRevision: 0,
  processedThrough: 0,
};

it('pairs a bootstrap projection with its revision, both ways', () => {
  expect(
    parseGolemWindowBootstrap({ state: bootstrapState, view: bootstrapView, revision: 5 })
  ).toEqual({ state: bootstrapState, view: bootstrapView, revision: 5 });
  // Revision zero is the one shape that may carry no projection.
  expect(parseGolemWindowBootstrap({ state: bootstrapState, view: null, revision: 0 })).toEqual({
    state: bootstrapState,
    view: null,
    revision: 0,
  });
  // A revision that names a projection must carry it...
  expect(() =>
    parseGolemWindowBootstrap({ state: bootstrapState, view: null, revision: 5 })
  ).toThrow(GolemContractError);
  // ...and a projection must carry the revision that identifies it.
  expect(() =>
    parseGolemWindowBootstrap({ state: bootstrapState, view: bootstrapView, revision: 0 })
  ).toThrow(GolemContractError);
});

it('accepts only a newer projection failure for the bootstrap instance', () => {
  const bootstrap = { state: bootstrapState, view: bootstrapView, revision: 5 };
  const viewError = {
    kind: 'view-error',
    instance: bootstrapState.instance,
    id: 0,
    revision: 6,
    handoff: 0,
    payload: { reason: 'Projection unavailable' },
  };
  expect(parseGolemWindowBootstrap({ ...bootstrap, viewError }).viewError).toEqual(viewError);
  for (const invalid of [
    null,
    { ...viewError, kind: 'view' },
    { ...viewError, instance: 4 },
    { ...viewError, id: 1 },
    { ...viewError, handoff: 1 },
    { ...viewError, revision: 5 },
    { ...viewError, payload: { reason: '' } },
  ]) {
    expect(() => parseGolemWindowBootstrap({ ...bootstrap, viewError: invalid })).toThrow(
      GolemContractError
    );
  }
});

it('parses draft maps (empty strings kept) and acks', () => {
  expect(parseGolemDraftMap({ c1: '', c2: 'text' })).toEqual({ c1: '', c2: 'text' });
  expect(() => parseGolemDraftMap({ c1: 5 })).toThrow(GolemContractError);
  expect(parseGolemAck({ id: 9, ok: false, reason: 'busy' })).toEqual({
    id: 9,
    ok: false,
    reason: 'busy',
  });
});
