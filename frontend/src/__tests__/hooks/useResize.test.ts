import { renderHook, act } from '@testing-library/react';
import { useResize } from '../../hooks/useResize';

// Mock document.documentElement.style.setProperty
const setPropertySpy = jest.spyOn(document.documentElement.style, 'setProperty');

beforeEach(() => {
  setPropertySpy.mockClear();
  // Set initial CSS var value
  document.documentElement.style.setProperty('--panel-left-width', '260px');
});

describe('useResize', () => {
  it('should return onMouseDown handler', () => {
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    expect(result.current.onMouseDown).toBeDefined();
    expect(typeof result.current.onMouseDown).toBe('function');
  });

  it('should update CSS variable on horizontal drag', () => {
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    // Simulate mousedown
    act(() => {
      result.current.onMouseDown({
        clientX: 260,
        clientY: 0,
        preventDefault: jest.fn(),
      } as unknown as React.MouseEvent);
    });

    // Simulate mousemove
    act(() => {
      const event = new MouseEvent('mousemove', { clientX: 310, clientY: 0 });
      document.dispatchEvent(event);
    });

    // Should have updated the CSS var (260 + 50 = 310)
    expect(setPropertySpy).toHaveBeenCalledWith('--panel-left-width', '310px');
  });

  it('should clamp to minimum value', () => {
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    act(() => {
      result.current.onMouseDown({
        clientX: 260,
        clientY: 0,
        preventDefault: jest.fn(),
      } as unknown as React.MouseEvent);
    });

    // Drag far left (260 - 200 = 60, below min 150)
    act(() => {
      const event = new MouseEvent('mousemove', { clientX: 60, clientY: 0 });
      document.dispatchEvent(event);
    });

    expect(setPropertySpy).toHaveBeenCalledWith('--panel-left-width', '150px');
  });

  it('should clamp to maximum value', () => {
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    act(() => {
      result.current.onMouseDown({
        clientX: 260,
        clientY: 0,
        preventDefault: jest.fn(),
      } as unknown as React.MouseEvent);
    });

    // Drag far right (260 + 300 = 560, above max 500)
    act(() => {
      const event = new MouseEvent('mousemove', { clientX: 560, clientY: 0 });
      document.dispatchEvent(event);
    });

    expect(setPropertySpy).toHaveBeenCalledWith('--panel-left-width', '500px');
  });

  it('should stop updating after mouseup', () => {
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    act(() => {
      result.current.onMouseDown({
        clientX: 260,
        clientY: 0,
        preventDefault: jest.fn(),
      } as unknown as React.MouseEvent);
    });

    // Mouseup to stop dragging
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    setPropertySpy.mockClear();

    // Further mousemove should not update
    act(() => {
      const event = new MouseEvent('mousemove', { clientX: 400, clientY: 0 });
      document.dispatchEvent(event);
    });

    // setProperty should NOT have been called with our var after mouseup
    const calls = setPropertySpy.mock.calls.filter((c) => c[0] === '--panel-left-width');
    expect(calls).toHaveLength(0);
  });

  it('should clean up event listeners on unmount during active drag', () => {
    const { result, unmount } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    // Start a drag
    act(() => {
      result.current.onMouseDown({
        clientX: 260,
        clientY: 0,
        preventDefault: jest.fn(),
      } as unknown as React.MouseEvent);
    });

    setPropertySpy.mockClear();

    // Unmount while drag is active
    unmount();

    // Further mousemove should not update (listeners cleaned up)
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 0 }));
    });

    const calls = setPropertySpy.mock.calls.filter((c) => c[0] === '--panel-left-width');
    expect(calls).toHaveLength(0);
  });

  it('should resize via keyboard arrow keys', () => {
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    // Press ArrowRight to increase size
    act(() => {
      result.current.onKeyDown({
        key: 'ArrowRight',
        preventDefault: jest.fn(),
      } as unknown as React.KeyboardEvent);
    });

    // 260 + 20 = 280
    expect(setPropertySpy).toHaveBeenCalledWith('--panel-left-width', '280px');
  });

  it('should clamp keyboard resize to min/max', () => {
    // Set near max
    document.documentElement.style.setProperty('--panel-left-width', '495px');

    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
      })
    );

    // Press ArrowRight — 495 + 20 = 515, clamped to 500
    act(() => {
      result.current.onKeyDown({
        key: 'ArrowRight',
        preventDefault: jest.fn(),
      } as unknown as React.KeyboardEvent);
    });

    expect(setPropertySpy).toHaveBeenCalledWith('--panel-left-width', '500px');
  });

  it('should invert direction for right panel', () => {
    document.documentElement.style.setProperty('--panel-right-width', '280px');

    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-right-width',
        min: 150,
        max: 500,
        inverted: true,
      })
    );

    act(() => {
      result.current.onMouseDown({
        clientX: 500,
        clientY: 0,
        preventDefault: jest.fn(),
      } as unknown as React.MouseEvent);
    });

    // Drag left by 50px — inverted means panel gets LARGER
    act(() => {
      const event = new MouseEvent('mousemove', { clientX: 450, clientY: 0 });
      document.dispatchEvent(event);
    });

    expect(setPropertySpy).toHaveBeenCalledWith('--panel-right-width', '330px');
  });
});

// #271 Task A3: a resize is a *gesture* the shell can observe (start/preview)
// and revoke (cancel), not just a size that appears at mouseup.
describe('useResize gesture ownership (#271)', () => {
  const mouseDown = (
    handler: (e: React.MouseEvent) => void,
    clientX: number,
    clientY = 0
  ): void => {
    handler({ clientX, clientY, preventDefault: jest.fn() } as unknown as React.MouseEvent);
  };

  const move = (clientX: number, clientY = 0): void => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY }));
  };

  const arrow = (handler: (e: React.KeyboardEvent) => void, key: string): void => {
    handler({ key, preventDefault: jest.fn() } as unknown as React.KeyboardEvent);
  };

  it('announces the gesture start with the currently rendered size', () => {
    const onResizeStart = jest.fn();
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
        onResizeStart,
      })
    );

    act(() => mouseDown(result.current.onMouseDown, 260));
    expect(onResizeStart).toHaveBeenCalledWith(260);

    act(() => document.dispatchEvent(new MouseEvent('mouseup')));

    // Keyboard is a gesture too, and only its first step starts one.
    onResizeStart.mockClear();
    act(() => arrow(result.current.onKeyDown, 'ArrowRight'));
    act(() => arrow(result.current.onKeyDown, 'ArrowRight'));
    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResizeStart).toHaveBeenCalledWith(260);
  });

  it('previews at most once per frame and flushes the last preview before committing', () => {
    jest.useFakeTimers();
    try {
      const onResizePreview = jest.fn();
      const onResizeEnd = jest.fn();
      const onResizeCancel = jest.fn();
      const { result } = renderHook(() =>
        useResize({
          direction: 'horizontal',
          cssVar: '--panel-left-width',
          min: 150,
          max: 500,
          onResizePreview,
          onResizeEnd,
          onResizeCancel,
        })
      );

      act(() => mouseDown(result.current.onMouseDown, 260));
      act(() => {
        move(300);
        move(330);
      });
      expect(onResizePreview).not.toHaveBeenCalled();

      act(() => jest.advanceTimersByTime(20));
      expect(onResizePreview).toHaveBeenCalledTimes(1);
      expect(onResizePreview).toHaveBeenLastCalledWith(330);

      // A move in the same frame as the release must still reach the shell,
      // so mouseup never jumps back from the final rendered preview.
      act(() => move(350));
      act(() => document.dispatchEvent(new MouseEvent('mouseup')));
      expect(onResizePreview).toHaveBeenLastCalledWith(350);
      expect(onResizeEnd).toHaveBeenCalledTimes(1);
      expect(onResizeEnd).toHaveBeenCalledWith(350);
      // A completed drag terminates as a commit, never also as a cancellation.
      expect(onResizeCancel).not.toHaveBeenCalled();

      // No stray frame callback survives the commit.
      onResizePreview.mockClear();
      act(() => jest.advanceTimersByTime(50));
      expect(onResizePreview).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each<[string, number | undefined]>([
    ['a click with no movement', undefined],
    ['a drag that returns to its initial rendered size', 260],
  ])('releases without committing a preference for %s', (_name, endX) => {
    const onResizeStart = jest.fn();
    const onResizeEnd = jest.fn();
    const onResizeCancel = jest.fn();
    const { result } = renderHook(() =>
      useResize({
        direction: 'horizontal',
        cssVar: '--panel-left-width',
        min: 150,
        max: 500,
        onResizeStart,
        onResizeEnd,
        onResizeCancel,
      })
    );

    act(() => mouseDown(result.current.onMouseDown, 260));
    if (endX !== undefined) {
      act(() => {
        move(400);
        move(endX);
      });
    }
    act(() => document.dispatchEvent(new MouseEvent('mouseup')));

    // Suppression applies to the commit only. The gesture must still terminate,
    // or the shell's transient ownership record leaks and its CSS variable is
    // never written again.
    expect(onResizeEnd).not.toHaveBeenCalled();
    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResizeCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels rather than commits when unmounted mid-drag, dropping pending work', () => {
    jest.useFakeTimers();
    try {
      const onResizeEnd = jest.fn();
      const onResizeCancel = jest.fn();
      const onResizePreview = jest.fn();
      const { result, unmount } = renderHook(() =>
        useResize({
          direction: 'horizontal',
          cssVar: '--panel-left-width',
          min: 150,
          max: 500,
          onResizeEnd,
          onResizeCancel,
          onResizePreview,
        })
      );

      // A pending keyboard commit and a pending preview frame are both open.
      act(() => arrow(result.current.onKeyDown, 'ArrowRight'));
      act(() => mouseDown(result.current.onMouseDown, 280));
      act(() => move(350));
      onResizeCancel.mockClear(); // the mousedown already cancelled the keyboard burst
      onResizePreview.mockClear();
      setPropertySpy.mockClear();

      unmount();

      expect(onResizeCancel).toHaveBeenCalledTimes(1);
      expect(onResizeEnd).not.toHaveBeenCalled();
      expect(document.body.style.cursor).toBe('');

      // Nothing scheduled before the unmount may still run after it.
      act(() => move(400));
      act(() => jest.advanceTimersByTime(1000));

      expect(setPropertySpy.mock.calls.filter((c) => c[0] === '--panel-left-width')).toHaveLength(
        0
      );
      expect(onResizePreview).not.toHaveBeenCalled();
      expect(onResizeEnd).not.toHaveBeenCalled();
      expect(onResizeCancel).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels an in-flight drag when the external invalidation key changes', () => {
    const onResizeEnd = jest.fn();
    const onResizeCancel = jest.fn();
    const { result, rerender } = renderHook(
      ({ invalidationKey }) =>
        useResize({
          direction: 'horizontal',
          cssVar: '--panel-left-width',
          min: 150,
          max: 500,
          onResizeEnd,
          onResizeCancel,
          invalidationKey,
        }),
      { initialProps: { invalidationKey: '/workspace/A' } }
    );

    act(() => mouseDown(result.current.onMouseDown, 260));
    act(() => move(330));
    setPropertySpy.mockClear();

    // Repository B restored under the drag.
    rerender({ invalidationKey: '/workspace/B' });

    expect(onResizeCancel).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).not.toHaveBeenCalled();

    // Listeners are gone: no cleanup callback may save A's drag into B.
    act(() => move(400));
    expect(setPropertySpy.mock.calls.filter((c) => c[0] === '--panel-left-width')).toHaveLength(0);

    act(() => document.dispatchEvent(new MouseEvent('mouseup')));
    expect(onResizeEnd).not.toHaveBeenCalled();
  });

  it('cancels a pending keyboard commit when the external invalidation key changes', () => {
    jest.useFakeTimers();
    try {
      const onResizeEnd = jest.fn();
      const onResizeCancel = jest.fn();
      const { result, rerender } = renderHook(
        ({ invalidationKey }) =>
          useResize({
            direction: 'horizontal',
            cssVar: '--panel-left-width',
            min: 150,
            max: 500,
            onResizeEnd,
            onResizeCancel,
            invalidationKey,
          }),
        { initialProps: { invalidationKey: '/workspace/A' } }
      );

      act(() => arrow(result.current.onKeyDown, 'ArrowRight'));
      rerender({ invalidationKey: '/workspace/B' });

      expect(onResizeCancel).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(1000));
      expect(onResizeEnd).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cannot commit a stale keyboard value once a mouse gesture starts', () => {
    jest.useFakeTimers();
    try {
      const onResizeEnd = jest.fn();
      const { result } = renderHook(() =>
        useResize({
          direction: 'horizontal',
          cssVar: '--panel-left-width',
          min: 150,
          max: 500,
          onResizeEnd,
        })
      );

      act(() => arrow(result.current.onKeyDown, 'ArrowRight')); // 260 -> 280, pending
      act(() => mouseDown(result.current.onMouseDown, 280));
      act(() => move(360));
      act(() => document.dispatchEvent(new MouseEvent('mouseup')));

      expect(onResizeEnd).toHaveBeenCalledTimes(1);
      expect(onResizeEnd).toHaveBeenCalledWith(360);

      act(() => jest.advanceTimersByTime(1000));
      expect(onResizeEnd).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases a keyboard step that cannot move off its boundary without committing', () => {
    jest.useFakeTimers();
    try {
      document.documentElement.style.setProperty('--panel-left-width', '500px');
      const onResizeStart = jest.fn();
      const onResizeEnd = jest.fn();
      const onResizeCancel = jest.fn();
      const { result } = renderHook(() =>
        useResize({
          direction: 'horizontal',
          cssVar: '--panel-left-width',
          min: 150,
          max: 500,
          onResizeStart,
          onResizeEnd,
          onResizeCancel,
        })
      );

      act(() => arrow(result.current.onKeyDown, 'ArrowRight'));
      act(() => jest.advanceTimersByTime(1000));

      expect(onResizeEnd).not.toHaveBeenCalled();
      expect(onResizeStart).toHaveBeenCalledTimes(1);
      expect(onResizeCancel).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('commits a completed keyboard burst exactly once', () => {
    jest.useFakeTimers();
    try {
      const onResizeStart = jest.fn();
      const onResizeEnd = jest.fn();
      const onResizeCancel = jest.fn();
      const { result } = renderHook(() =>
        useResize({
          direction: 'horizontal',
          cssVar: '--panel-left-width',
          min: 150,
          max: 500,
          onResizeStart,
          onResizeEnd,
          onResizeCancel,
        })
      );

      act(() => arrow(result.current.onKeyDown, 'ArrowRight'));
      act(() => arrow(result.current.onKeyDown, 'ArrowRight'));
      act(() => jest.advanceTimersByTime(1000));

      expect(onResizeStart).toHaveBeenCalledTimes(1);
      expect(onResizeEnd).toHaveBeenCalledTimes(1);
      expect(onResizeEnd).toHaveBeenCalledWith(300);
      expect(onResizeCancel).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
