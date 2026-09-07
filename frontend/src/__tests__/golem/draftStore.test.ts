import { useDraftStore } from '../../golem/draftStore';

beforeEach(() => useDraftStore.getState().installAll({}));

it('keeps drafts per conversation and hands the whole map over, empties included', () => {
  const s = useDraftStore.getState();
  s.setDraft('c1', 'hello');
  s.setDraft('c2', '');
  expect(useDraftStore.getState().drafts).toEqual({ c1: 'hello', c2: '' });
  expect(useDraftStore.getState().takeAll()).toEqual({ c1: 'hello', c2: '' });
  useDraftStore.getState().installAll({ c3: 'moved' });
  expect(useDraftStore.getState().drafts).toEqual({ c3: 'moved' });
  useDraftStore.getState().clear('c3');
  expect(useDraftStore.getState().drafts).toEqual({ c3: '' });
});

it('hands out a copy, not the live map, and skips no-op writes', () => {
  const s = useDraftStore.getState();
  s.setDraft('c1', 'hello');
  const before = useDraftStore.getState().drafts;
  s.setDraft('c1', 'hello');
  expect(useDraftStore.getState().drafts).toBe(before);

  const taken = useDraftStore.getState().takeAll();
  taken.c1 = 'mutated by the caller';
  expect(useDraftStore.getState().drafts.c1).toBe('hello');

  const installed = { c9: 'from the wire' };
  useDraftStore.getState().installAll(installed);
  installed.c9 = 'mutated after install';
  expect(useDraftStore.getState().drafts).toEqual({ c9: 'from the wire' });
});
