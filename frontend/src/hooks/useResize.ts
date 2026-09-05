import { useCallback, useEffect, useRef } from 'react';

export interface UseResizeOptions {
  /** Drag direction */
  direction: 'horizontal' | 'vertical';
  /** CSS custom property to update (e.g. '--panel-left-width') */
  cssVar: string;
  /** Minimum panel size in px */
  min: number;
  /** Maximum panel size in px */
  max: number;
  /** Invert drag direction (for right/bottom panels where dragging left/up increases size) */
  inverted?: boolean;
  /** Callback fired when resize completes (mouseup or keyboard pause) with the final size */
  onResizeEnd?: (size: number) => void;
  /**
   * #271: a gesture (mouse or keyboard) began, with the size currently
   * rendered for this panel. The shell captures ownership of `cssVar` here.
   */
  onResizeStart?: (size: number) => void;
  /**
   * #271: live clamped size during the gesture, at most once per animation
   * frame. The shell recomputes its effective budget so peer panels give way
   * before paint instead of at mouseup.
   */
  onResizePreview?: (size: number) => void;
  /**
   * #271: the gesture ended without committing — unmount, an external layout
   * change (`invalidationKey`), or a release that did not move the panel.
   * Every `onResizeStart` is terminated by exactly one `onResizeEnd` *or*
   * `onResizeCancel`, so the shell can release ownership unconditionally and
   * reapply the current effective layout.
   */
  onResizeCancel?: () => void;
  /**
   * #271: external layout identity (repository/restore generation, viewport,
   * explicit collapse/order, host mode). A change cancels — never commits —
   * an in-flight gesture, so no drag from the old layout is saved into the new
   * one. It must exclude this gesture's own preview/effective-rail values.
   */
  invalidationKey?: string;
}

/** Step size in px for keyboard-based resize */
const KEYBOARD_STEP = 20;
/** Delay before firing onResizeEnd for keyboard resize (ms) */
const KEYBOARD_RESIZE_END_DELAY = 300;

/**
 * Both halves must exist: a frame we can schedule but not cancel would outlive
 * its gesture. One check gates scheduling and cancelling alike.
 */
const supportsAnimationFrame = (): boolean =>
  typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';

/** Read current pixel size from a CSS custom property */
export function readCssVarSize(cssVar: string): number {
  if (typeof document === 'undefined') return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
  return parseInt(value, 10) || 0;
}

export function useResize({
  direction,
  cssVar,
  min,
  max,
  inverted = false,
  onResizeEnd,
  onResizeStart,
  onResizePreview,
  onResizeCancel,
  invalidationKey,
}: UseResizeOptions) {
  const isDragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);
  const keyboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Size the pending keyboard burst started from; null when no burst is open. */
  const keyboardStartSize = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingPreview = useRef<number | null>(null);

  const callbacks = useRef({ onResizeEnd, onResizeStart, onResizePreview, onResizeCancel });
  useEffect(() => {
    callbacks.current = { onResizeEnd, onResizeStart, onResizePreview, onResizeCancel };
  }, [onResizeEnd, onResizeStart, onResizePreview, onResizeCancel]);

  /** Drop any scheduled frame callback; returns the preview it would have sent. */
  const takePendingPreview = useCallback((): number | null => {
    // frameRef is only ever set while supportsAnimationFrame(), so cancelling
    // it needs no second capability check.
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingPreview.current;
    pendingPreview.current = null;
    return pending;
  }, []);

  const schedulePreview = useCallback((size: number) => {
    if (!supportsAnimationFrame()) {
      callbacks.current.onResizePreview?.(size);
      return;
    }
    pendingPreview.current = size;
    if (frameRef.current !== null) return; // already coalescing into this frame
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const latest = pendingPreview.current;
      pendingPreview.current = null;
      if (latest !== null) callbacks.current.onResizePreview?.(latest);
    });
  }, []);

  /**
   * Revoke whatever gesture is open (mouse listeners and/or a pending keyboard
   * commit) without committing anything. A no-op when nothing is in flight, so
   * a normal completion is never reported as a cancellation.
   */
  const cancelGesture = useCallback(() => {
    const hadGesture = cleanupRef.current !== null || keyboardTimerRef.current !== null;
    takePendingPreview();
    if (keyboardTimerRef.current) {
      clearTimeout(keyboardTimerRef.current);
      keyboardTimerRef.current = null;
    }
    keyboardStartSize.current = null;
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (hadGesture) callbacks.current.onResizeCancel?.();
  }, [takePendingPreview]);

  // Unmount tears the gesture down as a cancellation: a cleanup callback must
  // never save a drag that outlived its layout.
  useEffect(() => {
    return () => {
      cancelGesture();
    };
  }, [cancelGesture]);

  // An external layout change (new repository, viewport, explicit collapse or
  // reorder, host mode) invalidates an in-flight gesture.
  const previousInvalidationKey = useRef(invalidationKey);
  useEffect(() => {
    if (previousInvalidationKey.current === invalidationKey) return;
    previousInvalidationKey.current = invalidationKey;
    cancelGesture();
  }, [invalidationKey, cancelGesture]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      // Guard: tear down any existing gesture before starting a new one. This
      // also discards a pending keyboard commit, so an older debounced value
      // can never land after this drag.
      cancelGesture();

      isDragging.current = true;
      startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;

      startSize.current = readCssVarSize(cssVar);
      callbacks.current.onResizeStart?.(startSize.current);

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging.current) return;

        const currentPos = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
        const delta = currentPos - startPos.current;
        const newSize = inverted ? startSize.current - delta : startSize.current + delta;
        const clamped = Math.min(max, Math.max(min, newSize));

        document.documentElement.style.setProperty(cssVar, `${clamped}px`);
        schedulePreview(clamped);
      };

      const cleanup = () => {
        isDragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        cleanupRef.current = null;
      };

      const onMouseUp = () => {
        // Flush the last preview before releasing ownership so the shell's
        // effective layout already matches the pixels on screen.
        const pending = takePendingPreview();
        if (pending !== null) callbacks.current.onResizePreview?.(pending);

        const finalSize = readCssVarSize(cssVar);
        const changed = finalSize !== startSize.current;
        cleanup();
        // A click, or a drag back to where it started, is a no-op for
        // preferences: committing here would save an effective clamp over a
        // larger preferred size. It still has to terminate the gesture, or the
        // shell would hold ownership of this CSS var forever.
        if (changed) callbacks.current.onResizeEnd?.(finalSize);
        else callbacks.current.onResizeCancel?.();
      };

      // Set cursor for the entire document during drag
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      // Store cleanup for unmount safety
      cleanupRef.current = cleanup;
    },
    [direction, cssVar, min, max, inverted, cancelGesture, schedulePreview, takePendingPreview]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isHorizontal = direction === 'horizontal';
      let delta = 0;

      if (isHorizontal) {
        if (e.key === 'ArrowLeft') delta = inverted ? KEYBOARD_STEP : -KEYBOARD_STEP;
        else if (e.key === 'ArrowRight') delta = inverted ? -KEYBOARD_STEP : KEYBOARD_STEP;
      } else {
        if (e.key === 'ArrowUp') delta = inverted ? KEYBOARD_STEP : -KEYBOARD_STEP;
        else if (e.key === 'ArrowDown') delta = inverted ? -KEYBOARD_STEP : KEYBOARD_STEP;
      }

      if (delta === 0) return;

      e.preventDefault();
      const currentSize = readCssVarSize(cssVar);
      // Only the first step of a burst opens the gesture.
      if (keyboardStartSize.current === null) {
        keyboardStartSize.current = currentSize;
        callbacks.current.onResizeStart?.(currentSize);
      }
      const clamped = Math.min(max, Math.max(min, currentSize + delta));
      document.documentElement.style.setProperty(cssVar, `${clamped}px`);
      schedulePreview(clamped);

      // Debounce onResizeEnd for keyboard: fires after user stops pressing keys
      if (keyboardTimerRef.current) {
        clearTimeout(keyboardTimerRef.current);
      }
      const burstStart = keyboardStartSize.current;
      keyboardTimerRef.current = setTimeout(() => {
        keyboardTimerRef.current = null;
        keyboardStartSize.current = null;
        const pending = takePendingPreview();
        if (pending !== null) callbacks.current.onResizePreview?.(pending);
        // A boundary keypress that could not move the panel is a no-op for
        // preferences, but still terminates the gesture it opened.
        if (clamped !== burstStart) callbacks.current.onResizeEnd?.(clamped);
        else callbacks.current.onResizeCancel?.();
      }, KEYBOARD_RESIZE_END_DELAY);
    },
    [direction, cssVar, min, max, inverted, schedulePreview, takePendingPreview]
  );

  return { onMouseDown, onKeyDown };
}
