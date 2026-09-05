import { fireEvent, render, screen } from '@testing-library/react';
import { FilesCommandBar } from '../../components/layout/FilesCommandBar';
import { useIDEStore } from '../../stores/ideStore';
import type { EditorFile } from '../../stores/ideStore';

const file = (id: string, isModified = false): EditorFile => ({
  id,
  name: id,
  path: `/repo/${id}`,
  language: 'typescript',
  encoding: 'utf-8',
  lineEndings: 'lf',
  content: '',
  isModified,
});

beforeEach(() => useIDEStore.setState(useIDEStore.getInitialState()));

it('reports open and modified counts', () => {
  useIDEStore.setState({ openFiles: [file('a.ts'), file('b.ts', true), file('c.ts', true)] });
  render(<FilesCommandBar />);
  expect(screen.getByText('3 open · 2 modified')).toBeInTheDocument();
});

it('reports the empty state and collapses the Files panel', () => {
  render(<FilesCommandBar />);
  expect(screen.getByText('no files open')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Files panel' }));
  expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(true);
});
