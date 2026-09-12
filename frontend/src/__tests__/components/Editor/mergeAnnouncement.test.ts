import { describeMergeAnnouncement } from '../../../components/Editor/mergeAnnouncement';

describe('describeMergeAnnouncement', () => {
  it('describes a single resolution with its decision and the remaining count', () => {
    expect(describeMergeAnnouncement({}, { 0: 'C' }, 2)).toBe(
      'Conflict 1 resolved: took current. 1 unresolved.'
    );
  });

  it('describes a single reopen', () => {
    expect(describeMergeAnnouncement({ 0: 'C' }, {}, 2)).toBe('Conflict 1 reopened. 2 unresolved.');
  });

  it('describes several regions changed in one transaction deterministically', () => {
    expect(describeMergeAnnouncement({ 0: 'C', 1: 'C' }, { 0: 'M', 1: 'M' }, 2)).toBe(
      'Conflicts 1, 2 resolved. 0 unresolved.'
    );
  });

  it('describes a mixed resolve-and-reopen transaction (the motivating multi-region case)', () => {
    // Region 1 newly resolved to Manual, region 2 reopened, in one transaction.
    expect(describeMergeAnnouncement({ 0: 'C', 2: 'C' }, { 0: 'C', 1: 'M' }, 4)).toBe(
      'Conflict 2 resolved: took manual. Conflict 3 reopened. 2 unresolved.'
    );
  });

  it('returns null when nothing changed', () => {
    expect(describeMergeAnnouncement({ 0: 'C' }, { 0: 'C' }, 2)).toBeNull();
  });
});
