import { GolemContractError } from '../../types/golem';
import {
  parseGolemAck,
  parseGolemDraftMap,
  parseGolemViewAction,
  parseGolemWindowEnvelope,
  parseGolemWindowState,
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

it('parses draft maps (empty strings kept) and acks', () => {
  expect(parseGolemDraftMap({ c1: '', c2: 'text' })).toEqual({ c1: '', c2: 'text' });
  expect(() => parseGolemDraftMap({ c1: 5 })).toThrow(GolemContractError);
  expect(parseGolemAck({ id: 9, ok: false, reason: 'busy' })).toEqual({
    id: 9,
    ok: false,
    reason: 'busy',
  });
});
