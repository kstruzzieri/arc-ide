import { useEffect } from 'react';
import { startMainGolemRelay } from '../golem/windowRelay';

/**
 * Mounts the main window's Golem relay owner (#271 Task B6).
 *
 * One line, and deliberately so: everything the owner does lives in
 * `golem/windowRelay.ts`, which is testable without React. This exists only to
 * tie that lifetime to the App's — beside `useGolemBridge`, and in the main
 * `App` alone. The satellite starts `startGolemSatellite()` instead, and the
 * two must never both run in one JS context.
 *
 * Owner readiness is subscriptions plus core wiring, nothing else: it does not
 * wait on the AI bridge, so a saved undocked window is restored even while the
 * bridge is `unbound` or `error`, and with no repository open at all.
 */
export function useGolemWindow(): void {
  useEffect(() => startMainGolemRelay(), []);
}
