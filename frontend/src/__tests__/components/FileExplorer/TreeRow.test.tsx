// src/__tests__/components/FileExplorer/TreeRow.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { TreeRow, rowDomId } from '../../../components/FileExplorer/TreeRow';

const noop = () => {};

const baseProps = {
  rowId: rowDomId('/repo/a.ts'),
  isActive: false,
  canExpand: false,
  unreadable: false,
  fileAccent: null,
  onToggle: noop,
  onSelect: noop,
  onOpen: noop,
};

describe('TreeRow git decoration', () => {
  const entryProps = {
    ...baseProps,
    kind: 'entry' as const,
    path: '/repo/a.ts',
    name: 'a.ts',
    depth: 1,
    level: 2,
    isDir: false,
    isExpanded: false,
    isSelected: false,
    regionAccent: null,
    setSize: 1,
    posInSet: 1,
  };

  it('renders a status badge and data attribute for a modified file', () => {
    render(<TreeRow {...entryProps} gitStatus="modified" />);

    const row = screen.getByRole('treeitem');
    expect(row).toHaveAttribute('data-git', 'modified');
    expect(screen.getByTestId('git-badge')).toHaveTextContent('M');
  });

  it.each([
    ['added', 'A'],
    ['deleted', 'D'],
    ['renamed', 'R'],
    ['untracked', 'U'],
    ['conflicted', '!'],
  ] as const)('maps %s to badge letter %s', (status, letter) => {
    render(<TreeRow {...entryProps} gitStatus={status} />);

    expect(screen.getByTestId('git-badge')).toHaveTextContent(letter);
  });

  it('renders no badge or attribute without git status', () => {
    render(<TreeRow {...entryProps} />);

    expect(screen.getByRole('treeitem')).not.toHaveAttribute('data-git');
    expect(screen.queryByTestId('git-badge')).not.toBeInTheDocument();
  });
});

describe('TreeRow', () => {
  it('renders a file with its name and no chevron', () => {
    render(
      <TreeRow
        {...baseProps}
        kind="entry"
        path="/repo/a.ts"
        name="a.ts"
        depth={1}
        level={2}
        isDir={false}
        isExpanded={false}
        isSelected={false}
        regionAccent={null}
        setSize={1}
        posInSet={1}
      />
    );
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /toggle/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-accent-marker')).not.toBeInTheDocument();
  });

  it('creates a sanitized active-descendant id from a path key', () => {
    expect(rowDomId('/repo/src/App test.tsx')).toBe('treeitem-%2Frepo%2Fsrc%2FApp%20test.tsx');
  });

  it('renders a folder with a toggle button and fires onToggle', () => {
    const onToggle = jest.fn();
    render(
      <TreeRow
        {...baseProps}
        onToggle={onToggle}
        kind="entry"
        path="/repo/src"
        name="src"
        depth={1}
        level={2}
        isDir={true}
        isExpanded={false}
        isSelected={false}
        regionAccent={null}
        setSize={1}
        posInSet={1}
        canExpand={true}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /toggle/i }));
    expect(onToggle).toHaveBeenCalledWith('entry', '/repo/src');
  });

  it('calls onSelect when the row is clicked', () => {
    const onSelect = jest.fn();
    render(
      <TreeRow
        {...baseProps}
        onSelect={onSelect}
        kind="entry"
        path="/repo/a.ts"
        name="a.ts"
        depth={1}
        level={2}
        isDir={false}
        isExpanded={false}
        isSelected={false}
        regionAccent={null}
        setSize={1}
        posInSet={1}
      />
    );
    fireEvent.click(screen.getByRole('treeitem'));
    expect(onSelect).toHaveBeenCalledWith('/repo/a.ts');
  });

  it('applies the tinted class and --region-accent var when an accent is set', () => {
    const { container } = render(
      <TreeRow
        {...baseProps}
        kind="entry"
        path="/repo/frontend/x.ts"
        name="x.ts"
        depth={2}
        level={3}
        isDir={false}
        isExpanded={false}
        isSelected={false}
        regionAccent="frontend"
        setSize={1}
        posInSet={1}
      />
    );
    const row = container.querySelector('[role="treeitem"]') as HTMLElement;
    expect(row.className).toContain('tinted');
    expect(row.getAttribute('style')).toContain('--region-accent');
  });

  it('keeps file and region accents independent without changing Git or tree semantics', () => {
    const props = {
      ...baseProps,
      kind: 'entry' as const,
      path: '/repo/frontend/Dockerfile',
      rowId: rowDomId('/repo/frontend/Dockerfile'),
      name: 'Dockerfile',
      depth: 2,
      level: 3,
      isDir: false,
      isExpanded: false,
      isSelected: true,
      regionAccent: 'frontend' as const,
      fileAccent: 'docker' as const,
      setSize: 2,
      posInSet: 1,
      gitStatus: 'modified' as const,
    };
    render(<TreeRow {...props} />);

    const row = screen.getByRole('treeitem', { name: 'Dockerfile' });
    expect(row.style.getPropertyValue('--region-accent')).toBe('var(--accent-frontend)');
    expect(row.style.getPropertyValue('--file-accent')).toBe('var(--accent-docker)');
    expect(screen.getByTestId('file-accent-marker')).toHaveAttribute('aria-hidden', 'true');
    expect(row).toHaveAttribute('id', rowDomId('/repo/frontend/Dockerfile'));
    expect(row).toHaveAttribute('tabindex', '-1');
    expect(row).toHaveAttribute('aria-level', '3');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).toHaveAttribute('data-git', 'modified');
    expect(screen.getByTestId('git-badge')).toHaveTextContent('M');
  });

  it('clears the workspace ownership rail when a virtual row is recycled', () => {
    const props = {
      ...baseProps,
      kind: 'entry' as const,
      path: '/repo/frontend/App.tsx',
      name: 'App.tsx',
      depth: 2,
      level: 3,
      isDir: false,
      isExpanded: false,
      isSelected: true,
      isActive: true,
      regionAccent: 'frontend' as const,
      ownershipAccent: 'go' as const,
      setSize: 1,
      posInSet: 1,
    };
    const { rerender } = render(<TreeRow {...props} />);

    const row = screen.getByRole('treeitem', { name: 'App.tsx' });
    expect(row.className).toContain('ownershipRail');
    expect(row.style.getPropertyValue('--ownership-accent')).toBe('var(--accent-go)');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row.className).toContain('active');

    rerender(<TreeRow {...props} ownershipAccent={null} />);
    expect(row.className).not.toContain('ownershipRail');
    expect(row.style.getPropertyValue('--ownership-accent')).toBe('');
  });

  it('renders unreadable visually and in the tree item name without changing row state', () => {
    render(
      <TreeRow
        {...baseProps}
        kind="entry"
        path="/repo/src"
        name="src"
        depth={1}
        level={2}
        isDir={true}
        isExpanded={false}
        isSelected={true}
        isActive={true}
        regionAccent="frontend"
        fileAccent={null}
        setSize={2}
        posInSet={1}
        canExpand={true}
        unreadable={true}
        gitStatus="modified"
      />
    );

    const row = screen.getByRole('treeitem', { name: 'src, unreadable' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).toHaveAttribute('aria-level', '2');
    expect(row).toHaveAttribute('tabindex', '-1');
    expect(row.className).toContain('active');
    expect(row.style.getPropertyValue('--region-accent')).toBe('var(--accent-frontend)');
    expect(row).toHaveAttribute('data-git', 'modified');
    expect(screen.getByTestId('git-badge')).toHaveTextContent('M');
    const indicator = screen.getByTestId('unreadable-indicator');
    expect(indicator).toHaveAttribute('title', 'Unable to read this item');
    expect(indicator).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Toggle src' })).toHaveAttribute('tabindex', '-1');
  });

  it('keeps an unreadable file marker independent from its file accent', () => {
    render(
      <TreeRow
        {...baseProps}
        kind="entry"
        path="/repo/Dockerfile"
        name="Dockerfile"
        depth={1}
        level={2}
        isDir={false}
        isExpanded={false}
        isSelected={false}
        regionAccent={null}
        fileAccent="docker"
        setSize={1}
        posInSet={1}
        unreadable={true}
      />
    );

    expect(screen.getByRole('treeitem', { name: 'Dockerfile, unreadable' })).toHaveStyle({
      '--file-accent': 'var(--accent-docker)',
    });
    expect(screen.getByTestId('file-accent-marker')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('unreadable-indicator')).toHaveAttribute('aria-hidden', 'true');
  });

  it('exposes both tinted and aria-selected when a region file is selected', () => {
    // Precondition for the .row.tinted[aria-selected='true'] rule that makes a
    // selected file inherit its region/workspace accent (Project + Workspace
    // consistent). Both hooks must coexist on the row.
    const { container } = render(
      <TreeRow
        {...baseProps}
        kind="entry"
        path="/repo/frontend/x.ts"
        name="x.ts"
        depth={2}
        level={3}
        isDir={false}
        isExpanded={false}
        isSelected={true}
        regionAccent="frontend"
        setSize={1}
        posInSet={1}
      />
    );
    const row = container.querySelector('[role="treeitem"]') as HTMLElement;
    expect(row.className).toContain('tinted');
    expect(row.getAttribute('style')).toContain('--region-accent');
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it('exposes both tinted and active classes for the active region row', () => {
    // Precondition for the .row.tinted.active rule that draws the focus/active
    // outline in the region accent instead of the global --accent.
    const { container } = render(
      <TreeRow
        {...baseProps}
        isActive={true}
        kind="entry"
        path="/repo/frontend/x.ts"
        name="x.ts"
        depth={2}
        level={3}
        isDir={false}
        isExpanded={false}
        isSelected={false}
        regionAccent="frontend"
        setSize={1}
        posInSet={1}
      />
    );
    const row = container.querySelector('[role="treeitem"]') as HTMLElement;
    expect(row.className).toContain('tinted');
    expect(row.className).toContain('active');
  });

  it('sets aria attributes from the flat data', () => {
    render(
      <TreeRow
        {...baseProps}
        kind="entry"
        path="/repo/src"
        name="src"
        depth={1}
        level={2}
        isDir={true}
        isExpanded={true}
        isSelected={true}
        regionAccent={null}
        setSize={3}
        posInSet={2}
      />
    );
    const row = screen.getByRole('treeitem');
    expect(row).toHaveAttribute('aria-level', '2');
    expect(row).toHaveAttribute('aria-setsize', '3');
    expect(row).toHaveAttribute('aria-posinset', '2');
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(row).toHaveAttribute('aria-selected', 'true');
  });

  it('dims hidden (dot-prefixed) folders via data-hidden', () => {
    const { container } = render(
      <TreeRow
        {...baseProps}
        kind="entry"
        path="/repo/.git"
        name=".git"
        depth={1}
        level={2}
        isDir={true}
        isExpanded={false}
        isSelected={false}
        regionAccent={null}
        setSize={1}
        posInSet={1}
      />
    );
    expect(container.querySelector('[data-hidden]')).toBeInTheDocument();
  });

  it('keeps the shortened root path in an unreadable root accessible name', () => {
    render(
      <TreeRow
        {...baseProps}
        kind="root"
        name="Go"
        rootPath="/repo/backend"
        depth={0}
        level={1}
        isDir={true}
        isExpanded={false}
        isSelected={false}
        regionAccent={null}
        setSize={1}
        posInSet={1}
        canExpand={true}
        unreadable={true}
      />
    );

    // The label override must not drop the path a sighted user still sees.
    expect(
      screen.getByRole('treeitem', { name: 'Go, unreadable, /repo/backend' })
    ).toBeInTheDocument();
  });

  it('renders the root row with its label and path and toggles the root', () => {
    const onToggle = jest.fn();
    render(
      <TreeRow
        {...baseProps}
        onToggle={onToggle}
        kind="root"
        name="repo"
        rootPath="/Users/me/repo"
        depth={0}
        level={1}
        isDir={true}
        isExpanded={true}
        isSelected={false}
        regionAccent={null}
        setSize={1}
        posInSet={1}
        canExpand={true}
      />
    );
    expect(screen.getByText('repo')).toBeInTheDocument();
    expect(screen.getByText('~/repo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /toggle/i }));
    expect(onToggle).toHaveBeenCalledWith('root', undefined);
  });
});
