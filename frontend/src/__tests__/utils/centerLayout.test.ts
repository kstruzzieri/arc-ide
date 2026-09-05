import {
  DEFAULT_CENTER_LAYOUT,
  DEFAULT_GOLEM_WIDTH,
  initialCenterReveal,
  normalizeCenterLayout,
} from '../../utils/centerLayout';

describe('normalizeCenterLayout', () => {
  it('returns the defaults for an empty legacy record', () => {
    expect(normalizeCenterLayout({})).toEqual(DEFAULT_CENTER_LAYOUT);
  });

  it('keeps a valid golem-first order and rejects an unknown one', () => {
    expect(normalizeCenterLayout({ centerOrder: 'golem-first' }).centerOrder).toBe('golem-first');
    expect(normalizeCenterLayout({ centerOrder: 'sideways' }).centerOrder).toBe('files-first');
  });

  it('rounds a finite positive width and falls back for zero, negative, NaN, or non-numbers', () => {
    expect(normalizeCenterLayout({ golemWidth: 501.6 }).golemWidth).toBe(502);
    expect(normalizeCenterLayout({ golemWidth: 0.1 }).golemWidth).toBe(1);
    expect(normalizeCenterLayout({ golemWidth: Number.POSITIVE_INFINITY }).golemWidth).toBe(
      DEFAULT_GOLEM_WIDTH
    );
    expect(normalizeCenterLayout({ golemWidth: 0 }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
    expect(normalizeCenterLayout({ golemWidth: -20 }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
    expect(normalizeCenterLayout({ golemWidth: Number.NaN }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
    expect(normalizeCenterLayout({ golemWidth: '420' }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
  });

  it('preserves an explicitly saved open Golem panel (false wins over the collapsed default)', () => {
    expect(normalizeCenterLayout({ golemCollapsed: false }).isGolemPanelCollapsed).toBe(false);
    expect(normalizeCenterLayout({ golemCollapsed: null }).isGolemPanelCollapsed).toBe(true);
    expect(normalizeCenterLayout({ golemCollapsed: undefined }).isGolemPanelCollapsed).toBe(true);
  });

  it('never yields both panels collapsed: the malformed pair becomes Files open / Golem collapsed', () => {
    const prefs = normalizeCenterLayout({ golemCollapsed: true, filesCollapsed: true });
    expect(prefs).toMatchObject({ isGolemPanelCollapsed: true, isFilesPanelCollapsed: false });
  });
});

describe('initialCenterReveal', () => {
  it('is Golem only when Golem is the sole open panel', () => {
    expect(
      initialCenterReveal({
        ...DEFAULT_CENTER_LAYOUT,
        isFilesPanelCollapsed: true,
        isGolemPanelCollapsed: false,
      })
    ).toBe('golem');
  });

  it('is Files when both are open or when Files is the sole open panel', () => {
    expect(initialCenterReveal({ ...DEFAULT_CENTER_LAYOUT, isGolemPanelCollapsed: false })).toBe(
      'files'
    );
    expect(initialCenterReveal(DEFAULT_CENTER_LAYOUT)).toBe('files');
  });
});
