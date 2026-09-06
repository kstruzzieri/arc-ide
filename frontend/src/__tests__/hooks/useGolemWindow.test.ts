/**
 * Task B6 — the one mount point for the main window's relay owner.
 *
 * The hook itself is a lifetime, so that is all this asserts: one owner per
 * mount, torn down on unmount, and a StrictMode double-mount leaving exactly
 * one live owner rather than two racing ones.
 */

import { StrictMode } from 'react';
import { renderHook } from '@testing-library/react';

const startMock = jest.fn();
jest.mock('../../golem/windowRelay', () => ({
  startMainGolemRelay: (...args: unknown[]) => startMock(...args) as () => void,
}));

import { useGolemWindow } from '../../hooks/useGolemWindow';

const stops: jest.Mock[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  stops.length = 0;
  startMock.mockImplementation(() => {
    const stop = jest.fn();
    stops.push(stop);
    return stop;
  });
});

it('starts one relay owner and retires it on unmount', () => {
  const { unmount } = renderHook(() => useGolemWindow());

  expect(startMock).toHaveBeenCalledTimes(1);
  expect(stops[0]).not.toHaveBeenCalled();

  unmount();

  expect(stops[0]).toHaveBeenCalledTimes(1);
});

it('leaves exactly one live owner under StrictMode', () => {
  const { unmount } = renderHook(() => useGolemWindow(), { wrapper: StrictMode });

  // React mounts, tears down and mounts again: two starts, the first retired.
  expect(startMock).toHaveBeenCalledTimes(2);
  expect(stops[0]).toHaveBeenCalledTimes(1);
  expect(stops[1]).not.toHaveBeenCalled();

  unmount();

  expect(stops[1]).toHaveBeenCalledTimes(1);
});
