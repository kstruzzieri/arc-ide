import { useCallback, useRef, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useIDEStore } from '../../stores/ideStore';
import type { CenterPanel } from '../../utils/centerLayout';
import { CENTER_DRAG_MIME, reorderTargetForKey } from '../../utils/centerReorder';
import { isMac } from '../../utils/platform';
import { GripIcon, MinusIcon } from '../icons';
import styles from './PanelCommandBar.module.css';

const LABEL: Record<CenterPanel, string> = { files: 'Files', golem: 'Golem' };

export interface PanelCommandBarProps {
  panel: CenterPanel;
  /** Display name, already uppercase (FILES / GOLEM). */
  name: string;
  /** Glyph for the 26px tile. Decorative; the name carries the meaning. */
  tile: ReactNode;
  /** Live dot, counts — rendered after the name inside the identity. */
  meta?: ReactNode;
  /** Right-aligned controls. Siblings of the identity, never inside it (spec §4.1). */
  controls?: ReactNode;
  /**
   * Omitted when this panel cannot be collapsed at all — #271 B6's undocked
   * layout, where Files is the whole center and the pair invariant would
   * refuse the collapse anyway. A disabled control would advertise an action
   * that does not exist here.
   */
  onCollapse?: () => void;
}

/**
 * The 38px command bar every center panel opens with (#271 spec §2.2, mockup
 * center-split-v2a.html). The identity region is the panel's focus target and
 * — from Task A7 — its drag and keyboard reorder handle. Everything clickable
 * lives in the controls slot beside it, so a button press can never start a
 * drag and a drag can never swallow a click.
 */
export function PanelCommandBar({
  panel,
  name,
  tile,
  meta,
  controls,
  onCollapse,
}: PanelCommandBarProps) {
  const label = LABEL[panel];
  const identityRef = useRef<HTMLDivElement>(null);
  const centerDrag = useIDEStore((s) => s.centerDrag);
  const isDragging = centerDrag === panel;

  const onDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(CENTER_DRAG_MIME, panel);
      useIDEStore.getState().setCenterDrag(panel);
    },
    [panel]
  );
  const onDragEnd = useCallback(() => {
    useIDEStore.getState().setCenterDrag(null);
    // Reorder moves this node in the DOM; keep focus on the moved header.
    requestAnimationFrame(() => identityRef.current?.focus());
  }, []);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Only the header itself: a chord bubbling from a control is not a reorder.
      if (e.target !== e.currentTarget) return;
      const target = reorderTargetForKey(e, panel, isMac());
      if (!target) return;
      e.preventDefault();
      useIDEStore.getState().setCenterOrder(target);
      requestAnimationFrame(() => identityRef.current?.focus());
    },
    [panel]
  );

  return (
    <div className={styles.bar} data-panel={panel}>
      <div
        ref={identityRef}
        className={styles.identity}
        role="group"
        tabIndex={0}
        aria-label={`${label} panel header`}
        aria-roledescription="movable panel header"
        // One chord, the one this platform actually accepts — `onKeyDown`
        // rejects the other modifier, so advertising both misleads.
        aria-keyshortcuts={
          isMac()
            ? 'Meta+Shift+ArrowLeft Meta+Shift+ArrowRight'
            : 'Control+Shift+ArrowLeft Control+Shift+ArrowRight'
        }
        data-dragging={isDragging || undefined}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onKeyDown={onKeyDown}
      >
        <span className={styles.grip} aria-hidden="true">
          <GripIcon />
        </span>
        <span className={styles.tile} aria-hidden="true">
          {tile}
        </span>
        <span className={styles.name}>{name}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </div>
      <div className={styles.controls}>
        {controls}
        {onCollapse && (
          <PanelBarButton label={`Collapse ${label} panel`} onClick={onCollapse}>
            <MinusIcon aria-hidden="true" />
          </PanelBarButton>
        )}
      </div>
    </div>
  );
}

export interface PanelBarButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Tooltip; defaults to the label. */
  title?: string;
  children: ReactNode;
}

/** A 24px icon button in the bar's control slot. */
export function PanelBarButton({ label, onClick, disabled, title, children }: PanelBarButtonProps) {
  return (
    <button
      type="button"
      className={styles.control}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
