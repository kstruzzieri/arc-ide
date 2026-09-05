// #271 Task A3: the shell's restore/effective-size CSS writer.
//
// Before this hook the ONLY writers of the --panel-* custom properties were
// the two gesture paths in useResize, so a restored or clamped size never
// reached the layout until the next drag. The hook closes that gap without
// stealing the variable an in-flight gesture owns.
import { renderHook } from '@testing-library/react';
import { useLayoutCssSync } from '../../hooks/useLayoutCssSync';

const BASE = { left: 260, right: 280, bottom: 200, golem: 420 };

const readVar = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  for (const name of [
    '--panel-left-width',
    '--panel-right-width',
    '--panel-bottom-height',
    '--panel-golem-width',
  ]) {
    document.documentElement.style.removeProperty(name);
  }
});

describe('useLayoutCssSync', () => {
  it('writes every variable on mount and only the changed one afterwards', () => {
    const spy = jest.spyOn(document.documentElement.style, 'setProperty');
    try {
      const { rerender } = renderHook(({ sizes }) => useLayoutCssSync(sizes), {
        initialProps: { sizes: BASE },
      });

      expect(spy.mock.calls).toEqual([
        ['--panel-left-width', '260px'],
        ['--panel-right-width', '280px'],
        ['--panel-bottom-height', '200px'],
        ['--panel-golem-width', '420px'],
      ]);

      spy.mockClear();
      rerender({ sizes: { ...BASE, golem: 512 } });

      // A Golem-only change must not rewrite the three rails.
      expect(spy.mock.calls).toEqual([['--panel-golem-width', '512px']]);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves owned CSS on peer changes and restores it when ownership ends', () => {
    const sizes = { left: 260, right: 280, bottom: 200, golem: 420 };
    const spy = jest.spyOn(document.documentElement.style, 'setProperty');
    const { rerender, unmount } = renderHook(
      ({ bottom, active, revision }) => useLayoutCssSync({ ...sizes, bottom }, active, revision),
      { initialProps: { bottom: 200, active: null as string | null, revision: 0 } }
    );
    expect(spy).toHaveBeenCalledWith('--panel-golem-width', '420px');
    rerender({ bottom: 200, active: '--panel-left-width', revision: 0 });
    document.documentElement.style.setProperty('--panel-left-width', '310px');
    spy.mockClear();
    rerender({ bottom: 240, active: '--panel-left-width', revision: 0 });
    expect(spy.mock.calls).toEqual([['--panel-bottom-height', '240px']]);
    expect(document.documentElement.style.getPropertyValue('--panel-left-width')).toBe('310px');
    rerender({ bottom: 240, active: null, revision: 1 });
    expect(document.documentElement.style.getPropertyValue('--panel-left-width')).toBe('260px');
    unmount();
    spy.mockRestore();
  });

  it('a bumped revision rewrites unchanged sizes so a cancelled gesture cannot stick', () => {
    const { rerender } = renderHook(({ revision }) => useLayoutCssSync(BASE, null, revision), {
      initialProps: { revision: 0 },
    });
    expect(readVar('--panel-left-width')).toBe('260px');

    // A gesture that starts and cancels inside one commit never lets the effect
    // observe `activeCssVar`, so only the revision can invalidate its direct
    // CSS write.
    document.documentElement.style.setProperty('--panel-left-width', '333px');
    rerender({ revision: 0 });
    expect(readVar('--panel-left-width')).toBe('333px');

    rerender({ revision: 1 });
    expect(readVar('--panel-left-width')).toBe('260px');
  });

  it('never rewrites the variable an active gesture owns, even when its size changes', () => {
    const spy = jest.spyOn(document.documentElement.style, 'setProperty');
    try {
      const { rerender } = renderHook(
        ({ golem, active }) => useLayoutCssSync({ ...BASE, golem }, active),
        { initialProps: { golem: 420, active: null as string | null } }
      );

      rerender({ golem: 420, active: '--panel-golem-width' });
      spy.mockClear();

      // The shell's effective budget shrank Golem mid-drag; the gesture still owns it.
      rerender({ golem: 380, active: '--panel-golem-width' });
      expect(spy.mock.calls).toEqual([]);

      // Release: the desired size is written once ownership ends.
      rerender({ golem: 380, active: null });
      expect(spy.mock.calls).toEqual([['--panel-golem-width', '380px']]);
    } finally {
      spy.mockRestore();
    }
  });
});
