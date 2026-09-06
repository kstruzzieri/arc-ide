import { useShallow } from 'zustand/react/shallow';
import { selectGolemUndocked, useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import { FilesIcon } from '../icons';
import { PanelCommandBar } from './PanelCommandBar';

/** The FILES bar: identity plus open/modified counts (#271 spec §2.2). */
export function FilesCommandBar() {
  // The counts, not the array: `updateFileContent` maps a fresh `openFiles` on
  // every accepted keystroke, and subscribing to it would re-render the bar at
  // typing rate to arrive at the same two numbers.
  const { open, modified } = useIDEStore(
    useShallow((s) => ({
      open: s.openFiles.length,
      modified: s.openFiles.filter((f) => f.isModified).length,
    }))
  );
  const setFilesPanelCollapsed = useIDEStore((s) => s.setFilesPanelCollapsed);
  // While the satellite owns the chat, Files is the entire center: there is no
  // second panel for a collapse to reveal, so the control is not offered at
  // all. The pair invariant would refuse the collapse either way. The shared
  // selector keeps this bar and the shell on the same tick.
  const golemUndocked = useGolemStore(selectGolemUndocked);
  const meta =
    open === 0 ? 'no files open' : `${open} open${modified ? ` · ${modified} modified` : ''}`;

  return (
    <PanelCommandBar
      panel="files"
      name="FILES"
      tile={<FilesIcon />}
      meta={<span>{meta}</span>}
      onCollapse={golemUndocked ? undefined : () => setFilesPanelCollapsed(true)}
    />
  );
}
