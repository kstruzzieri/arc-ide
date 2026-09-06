import golemIcon from '../../assets/branding/golem-icon.svg';
import { dockGolem, focusGolemWindow, reportGolemWindowError } from '../../golem/windowRelay';
import { useCenterOrder, useIDEStore } from '../../stores/ideStore';
import { useGolemStore } from '../../stores/golemStore';
import { reorderTargetForKey } from '../../utils/centerReorder';
import { golemAttention, type GolemAttention } from '../../utils/golemAttention';
import { isMac } from '../../utils/platform';
import styles from './PanelRail.module.css';

const ATTENTION_TEXT: Record<NonNullable<GolemAttention>, string> = {
  approval: 'approval needed',
  running: 'running',
};

/**
 * What the Golem slot becomes while the satellite window owns the conversation
 * (#271 spec §5.3). The ordinary `PanelRail` is one button meaning "expand",
 * and expanding is exactly what this window cannot do: the chat is not here.
 * So the same 40px identity carries the two things that *are* possible —
 * bring that window forward, or bring the conversation back — as two real
 * buttons inside one named group, rather than one control with a mode.
 *
 * It keeps the rest of the rail's contract: the pinned project accent, the
 * attention dot with its text, and the center-reorder chord, which still works
 * because reordering the pair is a layout act this window still owns.
 */
export function GolemUndockedRail() {
  const attention = useGolemStore(golemAttention);
  const phase = useGolemStore((s) => s.windowState.phase);
  const order = useCenterOrder();
  const side = order === 'files-first' ? 'right' : 'left';
  // A re-dock is already in flight: a second request would open nothing and
  // only make the transfer look repeatable.
  const closing = phase === 'closing';

  return (
    <div
      className={styles.rail}
      role="group"
      aria-label="Golem window"
      data-panel="golem"
      data-attention={attention ?? undefined}
      data-side={side}
      // The chord bubbles from either button; the group is the rail's identity.
      onKeyDown={(e) => {
        const target = reorderTargetForKey(e, 'golem', isMac());
        if (!target) return;
        e.preventDefault();
        const held = document.activeElement;
        useIDEStore.getState().setCenterOrder(target);
        // Reorder moves these nodes in the DOM; keep focus where it was.
        requestAnimationFrame(() => {
          if (held instanceof HTMLElement && held.isConnected) held.focus();
        });
      }}
    >
      <span className={styles.glyph} aria-hidden="true">
        <img src={golemIcon} alt="" draggable={false} />
      </span>
      {attention && <span className={styles.dot} aria-hidden="true" />}
      <span className={styles.label} aria-hidden="true">
        GOLEM
      </span>
      {attention && <span className={styles.railNote}>{ATTENTION_TEXT[attention]}</span>}
      <button
        type="button"
        className={styles.railAction}
        aria-label="Focus Golem window"
        title="Focus Golem window"
        onClick={() => {
          void focusGolemWindow().catch(reportGolemWindowError);
        }}
      >
        <span aria-hidden="true">⧉</span>
      </button>
      <button
        type="button"
        className={styles.railAction}
        aria-label="Dock Golem panel"
        title={closing ? 'Docking the Golem panel…' : 'Dock Golem panel'}
        disabled={closing}
        onClick={() => {
          void dockGolem().catch(reportGolemWindowError);
        }}
      >
        <span aria-hidden="true">⇤</span>
      </button>
    </div>
  );
}
