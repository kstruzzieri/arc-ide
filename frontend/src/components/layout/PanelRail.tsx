import golemIcon from '../../assets/branding/golem-icon.svg';
import { useCenterOrder, useIDEStore } from '../../stores/ideStore';
import { useGolemStore } from '../../stores/golemStore';
import type { CenterPanel } from '../../utils/centerLayout';
import { reorderTargetForKey } from '../../utils/centerReorder';
import { golemAttention, type GolemAttention } from '../../utils/golemAttention';
import { isMac } from '../../utils/platform';
import { ChevronRightIcon, FilesIcon } from '../icons';
import styles from './PanelRail.module.css';

const LABEL: Record<CenterPanel, string> = { files: 'Files', golem: 'Golem' };
const ATTENTION_TEXT: Record<NonNullable<GolemAttention>, string> = {
  approval: 'approval needed',
  running: 'running',
};
const NO_ATTENTION = (): GolemAttention => null;

interface PanelRailProps {
  panel: CenterPanel;
  onExpand: () => void;
}

/**
 * The 40px collapsed identity rail (#271 spec §2.4): one button carrying the
 * panel glyph, a Golem attention dot paired with sr text, a vertical wordmark
 * and an expand chevron. The whole rail is the target.
 */
export function PanelRail({ panel, onExpand }: PanelRailProps) {
  const attention = useGolemStore(panel === 'golem' ? golemAttention : NO_ATTENTION);
  const label = LABEL[panel];
  const order = useCenterOrder();
  const side = (panel === 'files') === (order === 'files-first') ? 'left' : 'right';
  const name = attention
    ? `Expand ${label} panel — ${ATTENTION_TEXT[attention]}`
    : `Expand ${label} panel`;

  return (
    <button
      type="button"
      className={styles.rail}
      data-panel={panel}
      data-attention={attention ?? undefined}
      data-side={side}
      aria-label={name}
      title={name}
      onClick={onExpand}
      // A collapsed panel keeps the reorder chord (spec §4.2); the rail is its
      // own focus target, so there is nothing to bubble past here.
      onKeyDown={(e) => {
        const target = reorderTargetForKey(e, panel, isMac());
        if (!target) return;
        e.preventDefault();
        const rail = e.currentTarget;
        useIDEStore.getState().setCenterOrder(target);
        // Reorder moves this node in the DOM; keep focus on the moved rail.
        requestAnimationFrame(() => {
          if (rail.isConnected) rail.focus();
        });
      }}
    >
      <span className={styles.glyph} aria-hidden="true">
        {panel === 'golem' ? <img src={golemIcon} alt="" draggable={false} /> : <FilesIcon />}
      </span>
      {attention && <span className={styles.dot} aria-hidden="true" />}
      <span className={styles.label} aria-hidden="true">
        {label.toUpperCase()}
      </span>
      <span className={styles.chevron} aria-hidden="true">
        <ChevronRightIcon />
      </span>
    </button>
  );
}
