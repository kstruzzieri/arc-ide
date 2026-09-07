import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranchIcon, ChevronDownIcon } from '../icons';
import { useGitStore } from '../../stores/gitStore';
import styles from './BranchSwitcher.module.css';

/** Fixed-position coordinates for the portaled popup. */
interface PopupPos {
  top: number;
  left: number;
}

/** The popup's CSS max-width; the anchor clamp keeps this span on-screen. */
const POPUP_MAX_WIDTH = 280;

/**
 * Branch name + searchable checkout/create popup. Shared by the git panel
 * header and the always-visible app header widget, so both stay in sync and
 * both answer the status-bar / shortcut focus handoff. Renders nothing when
 * the workspace is not a git repository.
 */
export function BranchSwitcher({
  compact = false,
  respondToFocusRequest = true,
}: {
  compact?: boolean;
  /** Whether a status-bar / shortcut focus request opens this instance. The
   * always-visible header widget owns the handoff; the panel copy stays local
   * so a single request never opens two popups at once. */
  respondToFocusRequest?: boolean;
}) {
  const isRepo = useGitStore((s) => s.status?.isRepo ?? false);
  const branch = useGitStore((s) => (s.status?.isRepo ? s.status.branch : ''));
  const branches = useGitStore((s) => s.branches);
  const focusRevision = useGitStore((s) => s.focusBranchRevision);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<PopupPos | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Status-bar / shortcut handoff: a bumped revision opens the popup. Render-
  // phase state adjustment (the React "derive state from props" pattern).
  const [seenRevision, setSeenRevision] = useState(focusRevision);
  if (focusRevision !== seenRevision) {
    setSeenRevision(focusRevision);
    if (respondToFocusRequest) setOpen(true);
  }

  // Anchor the fixed-position popup under the trigger's left edge, clamped so
  // its widest possible span stays on-screen. (Right-edge anchoring broke once
  // the panel trigger moved to its own left-aligned row: a short branch name
  // put rect.right near the window's left, hanging the menu off-screen.)
  // Recomputed on open and on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = wrapRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_MAX_WIDTH - 8)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, compact]);

  // `pos` is a dependency because the very first open renders before the
  // placement effect has produced coordinates: the popup (and its input)
  // mounts on the pos-carrying re-render, after an [open]-only effect would
  // already have run with no input to focus. Focusing an already-focused
  // input on subsequent pos updates (scroll/resize) is a no-op.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    // Refresh the branch list each time the popup opens so it reflects
    // branches created in a terminal since the last git refresh.
    void useGitStore.getState().loadBranches();
  }, [open]);

  // Close on outside click / Escape. The popup is portaled out of wrapRef, so
  // check both the trigger wrap and the popup before treating a click as
  // "outside".
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!isRepo) return null;

  // Case-insensitive: "Main" must find "main", not offer to create a
  // casing-duplicate branch that fails on case-insensitive ref storage.
  const q = query.toLowerCase();
  const filtered = branches.filter((b) => b.toLowerCase().includes(q));
  const exactExists = branches.some((b) => b.toLowerCase() === q);

  const checkout = (name: string, create: boolean) => {
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
    void useGitStore.getState().checkout(name, create);
  };

  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Branch: ${branch}. Open branch switcher`}
        title={`Branch: ${branch}`}
      >
        <GitBranchIcon aria-hidden="true" />
        <span className={styles.name}>{branch}</span>
        <ChevronDownIcon aria-hidden="true" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popupRef}
            className={styles.popup}
            data-testid="branch-popup"
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
          >
            <input
              ref={inputRef}
              className={styles.search}
              placeholder="Find or create branch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Find or create branch"
            />
            <ul role="listbox" aria-label="Branches" className={styles.list}>
              {filtered.map((b) => (
                <li key={b}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={b === branch}
                    className={`${styles.option} ${b === branch ? styles.current : ''}`}
                    onClick={() => checkout(b, false)}
                  >
                    {b}
                  </button>
                </li>
              ))}
              {query && !exactExists && (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={`${styles.option} ${styles.create}`}
                    onClick={() => checkout(query, true)}
                  >
                    Create branch {query}
                  </button>
                </li>
              )}
              {filtered.length === 0 && !query && <li className={styles.empty}>No branches</li>}
            </ul>
          </div>,
          document.body
        )}
    </div>
  );
}
