/**
 * The one channel between the configuration surface and the panes that can make
 * it go away — the editor tab's close button and the app-close handshake
 * (#263 spec §4.6a, §5.5).
 *
 * It carries FUNCTIONS, never data. The draft, the staged changes, and the key
 * values stay inside `GolemConfigWorkspace`'s refs, exactly where §3.2 puts
 * them: a store would make them observable, serializable, and persistable, and
 * the whole point of a key ref is that it is none of those things.
 *
 * A surface that is not mounted registers nothing, so both queries answer
 * "no work, go ahead" — closing a tab that does not exist is never guarded.
 */

/** Which transition is asking. Only the confirm verb differs. */
export type ConfigCloseIntent = 'close' | 'quit';

export interface ConfigCloseHandler {
  /** Synchronous and cheap: callers use it to decide whether to reveal the tab. */
  hasUnsavedWork(): boolean;
  /**
   * Settles anything that must not be interrupted — an in-flight settings RPC,
   * a pending consent challenge, a dirty draft — and answers whether the
   * transition may proceed. Resolving `false` leaves the surface untouched.
   */
  confirm(intent: ConfigCloseIntent): Promise<boolean>;
}

let handler: ConfigCloseHandler | null = null;

/** Called by the mounted surface; `null` on unmount. */
export function registerConfigCloseHandler(next: ConfigCloseHandler | null): void {
  handler = next;
}

export const hasUnsavedConfigWork = (): boolean => handler?.hasUnsavedWork() ?? false;

export const confirmConfigClose = (intent: ConfigCloseIntent): Promise<boolean> =>
  handler === null ? Promise.resolve(true) : handler.confirm(intent);
