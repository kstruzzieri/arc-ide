import { useResize } from '../../hooks/useResize';
import { ChevronRightIcon, ChevronDownIcon } from '../icons';
import styles from './ResizeHandle.module.css';

/** Stable style objects to avoid creating new references on each render */
const ROTATE_180 = { transform: 'rotate(180deg)' } as const;

interface ResizeHandleProps {
  /** Which boundary this handle controls */
  direction: 'horizontal' | 'vertical';
  /** CSS variable to update */
  cssVar: string;
  /** Minimum panel size */
  min: number;
  /** Maximum panel size */
  max: number;
  /** Invert drag (for right/bottom panels) */
  inverted?: boolean;
  /** Whether the associated panel is collapsed */
  isCollapsed?: boolean;
  /** Toggle collapse callback */
  onToggleCollapse?: () => void;
  /** Collapse chevron direction when panel is visible */
  collapseDirection?: 'left' | 'right' | 'up' | 'down';
  /** Callback fired when drag ends with the final size */
  onResizeEnd?: (size: number) => void;
  /** #271: a gesture began, with the size currently rendered for this panel */
  onResizeStart?: (size: number) => void;
  /** #271: live clamped size during the gesture (at most once per frame) */
  onResizePreview?: (size: number) => void;
  /** #271: the gesture was revoked; nothing is committed */
  onResizeCancel?: () => void;
  /** #271: external layout identity — a change cancels an in-flight gesture */
  invalidationKey?: string;
  /** Current panel size from store (used for aria-valuenow) */
  panelSize?: number;
}

export function ResizeHandle({
  direction,
  cssVar,
  min,
  max,
  inverted = false,
  isCollapsed = false,
  onToggleCollapse,
  collapseDirection = 'left',
  onResizeEnd,
  onResizeStart,
  onResizePreview,
  onResizeCancel,
  invalidationKey,
  panelSize = 0,
}: ResizeHandleProps) {
  const { onMouseDown, onKeyDown } = useResize({
    direction,
    cssVar,
    min,
    max,
    inverted,
    onResizeEnd,
    onResizeStart,
    onResizePreview,
    onResizeCancel,
    invalidationKey,
  });

  const isHorizontal = direction === 'horizontal';

  // Determine chevron icon based on collapse state and direction
  const getChevronIcon = () => {
    if (isCollapsed) {
      // When collapsed, point toward the hidden panel (to expand)
      if (collapseDirection === 'left') return <ChevronRightIcon />;
      if (collapseDirection === 'right') return <ChevronRightIcon style={ROTATE_180} />;
      if (collapseDirection === 'up') return <ChevronDownIcon style={ROTATE_180} />;
      return <ChevronDownIcon style={ROTATE_180} />;
    }
    // When visible, point in collapse direction (to collapse)
    if (collapseDirection === 'left') return <ChevronRightIcon style={ROTATE_180} />;
    if (collapseDirection === 'right') return <ChevronRightIcon />;
    if (collapseDirection === 'up') return <ChevronDownIcon />;
    return <ChevronDownIcon />;
  };

  const currentSize = isCollapsed ? 0 : panelSize;

  return (
    <div
      className={`${styles.handle} ${isHorizontal ? styles.horizontal : styles.vertical}`}
      data-testid="resize-handle"
    >
      <div
        className={styles.dragZone}
        onMouseDown={isCollapsed ? undefined : onMouseDown}
        onKeyDown={isCollapsed ? undefined : onKeyDown}
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label={`Resize ${cssVar.replace('--', '').replace(/-/g, ' ')}`}
        aria-valuenow={currentSize}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={isCollapsed ? -1 : 0}
      />
      {onToggleCollapse && (
        <button
          className={styles.collapseBtn}
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? 'Expand panel' : 'Collapse panel'}
          type="button"
        >
          {getChevronIcon()}
        </button>
      )}
    </div>
  );
}
