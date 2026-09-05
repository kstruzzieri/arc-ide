import { useIDEStore, useOpenFiles } from '../../stores/ideStore';
import { FilesIcon } from '../icons';
import { PanelCommandBar } from './PanelCommandBar';

/** The FILES bar: identity plus open/modified counts (#271 spec §2.2). */
export function FilesCommandBar() {
  const openFiles = useOpenFiles();
  const setFilesPanelCollapsed = useIDEStore((s) => s.setFilesPanelCollapsed);
  const modified = openFiles.filter((f) => f.isModified).length;
  const meta =
    openFiles.length === 0
      ? 'no files open'
      : `${openFiles.length} open${modified ? ` · ${modified} modified` : ''}`;

  return (
    <PanelCommandBar
      panel="files"
      name="FILES"
      tile={<FilesIcon />}
      meta={<span>{meta}</span>}
      onCollapse={() => setFilesPanelCollapsed(true)}
    />
  );
}
