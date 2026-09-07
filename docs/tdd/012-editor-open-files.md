# Issue #12: Editor - Open Files from Explorer

## Issue Summary

Connect file explorer interactions to the editor. Enable opening a workspace folder, then single click selects a file (visual highlight), double click opens it in the editor with proper tab management and language detection.

## Acceptance Criteria

- [x] **Open Folder button works** (prerequisite - DONE)
- [ ] Single click opens file (user preference over original spec)
- [ ] File content loaded into CodeMirror
- [ ] Tab created for opened file
- [ ] Language detection from extension
- [ ] Handle large files gracefully
- [ ] Integration tests

## UI/UX Polish Sub-tasks

Per design mockup (`docs/mockups/arc.html`):

- [ ] **Header double-click maximize** - Double-click header bar to maximize/restore window
- [ ] **Folders sorted first** - Folders appear before files in tree (alphabetically within each group)
- [ ] **Open folder icon** - Expanded folders show open folder icon (`--icon-folder-open: #6A9AB0`)
- [ ] **Selection highlight** - Selected file has accent background (`--accent-dim`)
- [ ] **File type icons** - Each file type has colored icon (TS: #3178C6, JS: #F7DF1E, JSON: #F59E0B, etc.)
- [ ] **Root folder with path** - Top of tree shows project name + path label (e.g., "firn-ide ~/projects/...")

## TDD: Before (Failing Tests)

### Criterion 0: Open Folder button works (PREREQUISITE)

**Rationale:** Users cannot open files if they cannot first open a workspace folder. The "Open Folder" button currently does nothing - it needs to invoke the Wails native directory dialog, set the workspace, and trigger directory tree loading.

**Test Code (FileExplorer.test.tsx):**
```typescript
import { OpenFolderDialog } from '../../../wails/bindings';

jest.mock('../../../wails/bindings', () => ({
  OpenFolderDialog: jest.fn(),
}));

describe('Open Folder', () => {
  it('calls OpenFolderDialog when Open Folder button is clicked', async () => {
    (OpenFolderDialog as jest.Mock).mockResolvedValue('/Users/test/project');

    render(<FileExplorer />);
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

    await waitFor(() => {
      expect(OpenFolderDialog).toHaveBeenCalled();
    });
  });

  it('sets workspace when folder is selected', async () => {
    (OpenFolderDialog as jest.Mock).mockResolvedValue('/Users/test/project');

    render(<FileExplorer />);
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

    await waitFor(() => {
      const state = useIDEStore.getState();
      expect(state.workspace).toEqual({
        name: 'project',
        path: '/Users/test/project',
      });
    });
  });

  it('fetches directory tree after folder is opened', async () => {
    (OpenFolderDialog as jest.Mock).mockResolvedValue('/Users/test/project');
    (ReadDirectory as jest.Mock).mockResolvedValue([
      { name: 'src', path: '/Users/test/project/src', isDir: true, size: 0, modTime: 0 },
    ]);

    render(<FileExplorer />);
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

    await waitFor(() => {
      expect(ReadDirectory).toHaveBeenCalledWith('/Users/test/project');
    });

    await waitFor(() => {
      expect(screen.getByText('src')).toBeInTheDocument();
    });
  });

  it('does nothing when dialog is cancelled', async () => {
    (OpenFolderDialog as jest.Mock).mockResolvedValue(''); // Empty string = cancelled

    render(<FileExplorer />);
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

    await waitFor(() => {
      expect(OpenFolderDialog).toHaveBeenCalled();
    });

    const state = useIDEStore.getState();
    expect(state.workspace).toBeNull();
  });
});
```

**Initially Failing, Now Passing:**
```
PASS src/__tests__/components/FileExplorer/FileExplorer.test.tsx
  Open Folder
    ✓ calls OpenFolderDialog when Open Folder button is clicked
    ✓ sets workspace when folder is selected
    ✓ fetches directory tree after folder is opened
    ✓ shows directory tree after folder is opened
    ✓ does nothing when dialog is cancelled
```

**Implementation:**
- Backend: Added `OpenFolderDialog()` in `app.go` wrapping `runtime.OpenDirectoryDialog`
- Frontend: Added `handleOpenFolder` callback in `FileExplorer.tsx`
- Store: Updated `setDirectoryTree` to reset `isLoadingTree: false`

**Original Failing Output:**
```
FAIL src/__tests__/components/FileExplorer/FileExplorer.test.tsx
  ● Open Folder › calls OpenDirectoryDialog when Open Folder button is clicked

    expect(OpenDirectoryDialog).toHaveBeenCalled()

    Expected number of calls: >= 1
    Received number of calls:    0

    // Button has no onClick handler
```

---


### Criterion 1: Single click selects, double click opens

**Rationale:** Users expect click behavior consistent with desktop file managers - single click to select/highlight, double click to open. This allows selecting files for context actions (rename, delete) without opening them.

**Test Code (TreeNode.test.tsx):**
```typescript
describe('click behavior', () => {
  it('single click calls onSelect but not onOpen', () => {
    const onSelect = jest.fn();
    const onOpen = jest.fn();
    render(
      <TreeNode
        {...defaultProps}
        entry={mockFile}
        onSelect={onSelect}
        onOpen={onOpen}
      />
    );

    fireEvent.click(screen.getByText('test.ts'));
    expect(onSelect).toHaveBeenCalledWith(mockFile);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('double click calls onOpen', () => {
    const onSelect = jest.fn();
    const onOpen = jest.fn();
    render(
      <TreeNode
        {...defaultProps}
        entry={mockFile}
        onSelect={onSelect}
        onOpen={onOpen}
      />
    );

    fireEvent.doubleClick(screen.getByText('test.ts'));
    expect(onOpen).toHaveBeenCalledWith(mockFile);
  });
});
```

**Test Code (ideStore.test.ts):**
```typescript
describe('selection state', () => {
  it('has selectedPath state', () => {
    const state = useIDEStore.getState();
    expect(state.selectedPath).toBeDefined();
  });

  it('setSelectedPath updates selectedPath', () => {
    const { setSelectedPath } = useIDEStore.getState();
    setSelectedPath('/workspace/src/index.ts');
    expect(useIDEStore.getState().selectedPath).toBe('/workspace/src/index.ts');
  });
});
```

**Failing Output:**
```
FAIL src/__tests__/components/FileExplorer/TreeNode.test.tsx
  ● TreeNode › click behavior › single click calls onSelect but not onOpen

    TypeError: onOpen is not a function

FAIL src/__tests__/stores/ideStore.test.ts
  ● selection state › has selectedPath state

    expect(received).toBeDefined()
    Received: undefined
```

---

### Criterion 2: File content loaded into CodeMirror

**Rationale:** When a file is double-clicked, its content must be fetched from the backend and displayed in the CodeMirror editor. The content should be properly loaded without truncation.

**Test Code (FileExplorer.test.tsx):**
```typescript
describe('file opening', () => {
  it('loads file content on double click', async () => {
    (ReadFile as jest.Mock).mockResolvedValue({
      content: 'const x = 1;',
      encoding: 'utf-8',
      lineEndings: 'lf',
      size: 12,
      isBinary: false,
    });

    render(<FileExplorer />);
    fireEvent.doubleClick(screen.getByText('App.tsx'));

    await waitFor(() => {
      expect(ReadFile).toHaveBeenCalledWith('/workspace/src/App.tsx');
    });

    await waitFor(() => {
      const state = useIDEStore.getState();
      const file = state.openFiles.find(f => f.path === '/workspace/src/App.tsx');
      expect(file?.content).toBe('const x = 1;');
    });
  });
});
```

**Failing Output:**
```
FAIL src/__tests__/components/FileExplorer/FileExplorer.test.tsx
  ● file opening › loads file content on double click

    expect(ReadFile).toHaveBeenCalledWith('/workspace/src/App.tsx')

    Expected: "/workspace/src/App.tsx"
    Received: (function was not called)

    // Note: Currently single click opens - test expects double click
```

---

### Criterion 3: Tab created for opened file

**Rationale:** Each opened file should appear as a tab in the editor tab bar. Re-opening an already-open file should switch to that tab, not create a duplicate.

**Test Code (Editor.test.tsx):**
```typescript
describe('tab management', () => {
  it('creates tab when file is opened', () => {
    useIDEStore.getState().openFile({
      id: '/workspace/test.ts',
      name: 'test.ts',
      path: '/workspace/test.ts',
      language: 'typescript',
      encoding: 'utf-8',
      content: 'export {}',
      isModified: false,
    });

    render(<Editor />);
    expect(screen.getByRole('tab', { name: /test.ts/i })).toBeInTheDocument();
  });

  it('does not create duplicate tab for already open file', () => {
    const file = {
      id: '/workspace/test.ts',
      name: 'test.ts',
      path: '/workspace/test.ts',
      language: 'typescript',
      encoding: 'utf-8',
      content: 'export {}',
      isModified: false,
    };

    useIDEStore.getState().openFile(file);
    useIDEStore.getState().openFile(file);

    render(<Editor />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(1);
  });
});
```

**Status:** Tests should pass - this functionality exists.

---

### Criterion 4: Language detection from extension

**Rationale:** The editor must automatically detect the language for syntax highlighting based on file extension. This enables proper code coloring without user intervention.

**Test Code (FileExplorer.test.tsx):**
```typescript
describe('language detection', () => {
  it.each([
    ['test.ts', 'typescript'],
    ['test.tsx', 'typescript'],
    ['test.js', 'javascript'],
    ['test.jsx', 'javascript'],
    ['test.go', 'go'],
    ['test.py', 'python'],
    ['test.json', 'json'],
    ['test.md', 'markdown'],
    ['test.css', 'css'],
    ['test.html', 'html'],
    ['test.unknown', 'plaintext'],
  ])('detects %s as %s', async (filename, expectedLang) => {
    (ReadFile as jest.Mock).mockResolvedValue({
      content: '',
      encoding: 'utf-8',
      lineEndings: 'lf',
      size: 0,
      isBinary: false,
    });

    const entry: filesystem.FileEntry = {
      name: filename,
      path: `/workspace/${filename}`,
      isDir: false,
      size: 0,
      modTime: 0,
    };

    // Directly test getLanguageFromPath
    const lang = getLanguageFromPath(entry.path);
    expect(lang).toBe(expectedLang);
  });
});
```

**Status:** Tests should pass - `getLanguageFromPath()` exists.

---

### Criterion 5: Handle large files gracefully

**Rationale:** Opening very large files can freeze the UI. The system should warn users before opening files above a size threshold and offer options to proceed or cancel.

**Test Code (FileExplorer.test.tsx):**
```typescript
const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB

describe('large file handling', () => {
  it('shows warning for files larger than threshold', async () => {
    (ReadFile as jest.Mock).mockResolvedValue({
      content: 'x'.repeat(LARGE_FILE_THRESHOLD + 1),
      encoding: 'utf-8',
      lineEndings: 'lf',
      size: LARGE_FILE_THRESHOLD + 1,
      isBinary: false,
    });

    render(<FileExplorer />);
    fireEvent.doubleClick(screen.getByText('large-file.json'));

    await waitFor(() => {
      expect(screen.getByText(/large file warning/i)).toBeInTheDocument();
    });
  });

  it('shows file size in warning dialog', async () => {
    const size = 5 * 1024 * 1024; // 5MB
    (ReadFile as jest.Mock).mockResolvedValue({
      content: 'x',
      encoding: 'utf-8',
      lineEndings: 'lf',
      size,
      isBinary: false,
    });

    render(<FileExplorer />);
    fireEvent.doubleClick(screen.getByText('huge-file.log'));

    await waitFor(() => {
      expect(screen.getByText(/5.*MB/i)).toBeInTheDocument();
    });
  });

  it('opens file when user confirms warning', async () => {
    (ReadFile as jest.Mock).mockResolvedValue({
      content: 'large content',
      encoding: 'utf-8',
      lineEndings: 'lf',
      size: LARGE_FILE_THRESHOLD + 1,
      isBinary: false,
    });

    render(<FileExplorer />);
    fireEvent.doubleClick(screen.getByText('large-file.json'));

    await waitFor(() => {
      expect(screen.getByText(/large file warning/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /open anyway/i }));

    await waitFor(() => {
      const state = useIDEStore.getState();
      expect(state.openFiles).toHaveLength(1);
    });
  });

  it('does not open file when user cancels warning', async () => {
    (ReadFile as jest.Mock).mockResolvedValue({
      content: 'large content',
      encoding: 'utf-8',
      lineEndings: 'lf',
      size: LARGE_FILE_THRESHOLD + 1,
      isBinary: false,
    });

    render(<FileExplorer />);
    fireEvent.doubleClick(screen.getByText('large-file.json'));

    await waitFor(() => {
      expect(screen.getByText(/large file warning/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    const state = useIDEStore.getState();
    expect(state.openFiles).toHaveLength(0);
  });

  it('shows binary file warning', async () => {
    (ReadFile as jest.Mock).mockResolvedValue({
      content: '',
      encoding: 'binary',
      lineEndings: 'lf',
      size: 1000,
      isBinary: true,
    });

    render(<FileExplorer />);
    fireEvent.doubleClick(screen.getByText('image.png'));

    await waitFor(() => {
      expect(screen.getByText(/binary file/i)).toBeInTheDocument();
    });
  });
});
```

**Failing Output:**
```
FAIL src/__tests__/components/FileExplorer/FileExplorer.test.tsx
  ● large file handling › shows warning for files larger than threshold

    TestingLibraryElementError: Unable to find an element with the text: /large file warning/i

  ● large file handling › shows binary file warning

    TestingLibraryElementError: Unable to find an element with the text: /binary file/i
```

---

### Criterion 6: Integration tests

**Rationale:** End-to-end flow must work: double-click file in explorer → ReadFile called → store updated → CodeMirror renders content. Tests verify the complete data flow.

**Test Code (integration.test.tsx):**
```typescript
describe('FileExplorer → Editor integration', () => {
  beforeEach(() => {
    useIDEStore.setState({
      workspace: { name: 'test', path: '/workspace' },
      directoryTree: [
        { name: 'App.tsx', path: '/workspace/App.tsx', isDir: false, size: 100, modTime: 0 },
      ],
      openFiles: [],
      activeFileId: null,
      selectedPath: null,
    });
  });

  it('double-click opens file and shows in editor', async () => {
    (ReadFile as jest.Mock).mockResolvedValue({
      content: 'export function App() { return <div>Hello</div>; }',
      encoding: 'utf-8',
      lineEndings: 'lf',
      size: 51,
      isBinary: false,
    });

    render(
      <>
        <FileExplorer />
        <Editor />
      </>
    );

    // File explorer shows file
    expect(screen.getByText('App.tsx')).toBeInTheDocument();

    // Double click to open
    fireEvent.doubleClick(screen.getByText('App.tsx'));

    // Tab appears in editor
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /App.tsx/i })).toBeInTheDocument();
    });

    // Content loaded (CodeMirror renders)
    await waitFor(() => {
      const state = useIDEStore.getState();
      expect(state.activeFileId).toBe('/workspace/App.tsx');
      expect(state.openFiles[0].content).toContain('export function App');
    });
  });

  it('single click selects file without opening', async () => {
    render(
      <>
        <FileExplorer />
        <Editor />
      </>
    );

    fireEvent.click(screen.getByText('App.tsx'));

    // File is selected
    await waitFor(() => {
      const state = useIDEStore.getState();
      expect(state.selectedPath).toBe('/workspace/App.tsx');
    });

    // But not opened
    expect(useIDEStore.getState().openFiles).toHaveLength(0);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('selected file has visual highlight', () => {
    useIDEStore.setState({ selectedPath: '/workspace/App.tsx' });

    render(<FileExplorer />);

    const treeNode = screen.getByText('App.tsx').closest('[role="treeitem"]');
    expect(treeNode).toHaveAttribute('aria-selected', 'true');
  });
});
```

**Failing Output:**
```
FAIL src/__tests__/integration/FileExplorerEditor.test.tsx
  ● FileExplorer → Editor integration › double-click opens file and shows in editor

    TestingLibraryElementError: Unable to find role="tab"
    // Double click doesn't trigger open (single click does currently)

  ● FileExplorer → Editor integration › single click selects file without opening

    expect(state.selectedPath).toBe('/workspace/App.tsx')
    Expected: "/workspace/App.tsx"
    Received: undefined
    // selectedPath state doesn't exist yet
```

---

## Test Summary

```
$ npm test -- --testPathPatterns="(TreeNode|FileExplorer|Editor|ideStore)"

Test Suites: 4 failed, 4 total
Tests:       8 failed, 38 passed, 46 total
```

## Implementation Plan

### Phase 1: Open Folder (Prerequisite)

1. **Add Open Folder handler**
   - Import `OpenFolderDialog` from the Wails bindings adapter
   - Add `onClick` to "Open Folder" button in FileExplorerEmpty
   - Call `OpenFolderDialog()` to show native folder picker
   - On selection: call `setWorkspace()` with folder name/path
   - Trigger `ReadDirectory` to load file tree

### Phase 2: Selection State

2. **Add selection state to store**
   - Add `selectedPath: string | null` state
   - Add `setSelectedPath` action

3. **Update TreeNode click behavior**
   - Single click → calls `onSelect` (highlights file)
   - Double click → calls `onOpen` (opens in editor)
   - Update props: add `onOpen` callback

4. **Update FileExplorer handlers**
   - `handleSelect` → updates `selectedPath` (visual highlight)
   - `handleOpen` → calls `ReadFile` and `openFile`

5. **Update TreeNode styling**
   - Add `aria-selected="true"` for selected path
   - Add CSS highlight for selected state

### Phase 3: Large File Handling

6. **Add large file handling**
   - Check `size` from ReadFile response
   - Show warning dialog for files > 1MB
   - Show warning for binary files
   - Allow "Open Anyway" or "Cancel"

## Related

- PR: TBD
- Depends on: #7 (ReadDirectory), #8 (ReadFile), #11 (File Explorer Display)
- Blocks: #13 (Editor - Save Files)
