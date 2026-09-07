import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MergeResolutionState } from '../../../components/Editor/codemirror';
import type { MergeResolutionEditor } from '../../../components/Editor/codemirror';
import type { ResolutionRefusalHandler } from '../../../components/Editor/codemirror';
import type { MergeSession, TextMergeSession } from '../../../stores/gitStore';

const controller = {
  view: { requestMeasure: jest.fn(), focus: jest.fn() },
  getResult: jest.fn(() => 'resolved result'),
  getState: jest.fn(() => ({
    activeIndex: 0,
    decisions: {},
    order: 'current-first',
  })),
  undo: jest.fn(() => true),
  redo: jest.fn(() => true),
  next: jest.fn(() => true),
  activate: jest.fn(() => true),
  reopen: jest.fn(() => true),
  setFrozen: jest.fn(),
  setTheme: jest.fn(),
  destroy: jest.fn(),
} as unknown as MergeResolutionEditor;
let syntaxThemeId = 'glacier';
let onStateChange: ((state: MergeResolutionState) => void) | undefined;
let onDocumentChanged: (() => void) | undefined;
let onResolutionRefused: ResolutionRefusalHandler | undefined;
const createMergeResolutionEditor = jest.fn(
  (
    _host: HTMLElement,
    _session: unknown,
    options: {
      onStateChange?: (state: MergeResolutionState) => void;
      onDocumentChanged?: () => void;
      onResolutionRefused?: ResolutionRefusalHandler;
      syntaxThemeId?: string;
    }
  ) => {
    onStateChange = options.onStateChange;
    onDocumentChanged = options.onDocumentChanged;
    onResolutionRefused = options.onResolutionRefused;
    return controller;
  }
);
const recordDecision = jest.fn();
const reopenDecision = jest.fn();
const selectMergeSide = jest.fn();
const mergeFinalizeAndStage = jest.fn(() => Promise.resolve(true));
const markMergeDirty = jest.fn();
const mergeOverwriteAndStage = jest.fn(() => Promise.resolve(true));
const applyMergeReload = jest.fn(() => Promise.resolve());
const acknowledgeMergeExternal = jest.fn();
const requestMergeClose = jest.fn();
const cancelMergeClose = jest.fn();
const confirmMergeClose = jest.fn();
/** The session the mocked store reports; the view reads it back after awaiting
 * a store action, so tests can model what the action did. */
let storeSession: MergeSession | null = null;

// CodeMirror is ESM-only under Jest. The view contract is tested here without
// mounting it; mergeResolution.test.ts covers the real editor behavior.
jest.mock('../../../components/Editor/codemirror', () => ({
  createMergeResolutionEditor: (
    host: HTMLElement,
    session: unknown,
    options: {
      onStateChange?: (state: MergeResolutionState) => void;
      onDocumentChanged?: () => void;
      onResolutionRefused?: ResolutionRefusalHandler;
    }
  ) => createMergeResolutionEditor(host, session, options),
}));
jest.mock('../../../stores/gitStore', () => ({
  useGitStore: {
    getState: () => ({
      recordDecision,
      reopenDecision,
      selectMergeSide,
      mergeFinalizeAndStage,
      markMergeDirty,
      mergeOverwriteAndStage,
      applyMergeReload,
      acknowledgeMergeExternal,
      requestMergeClose,
      cancelMergeClose,
      confirmMergeClose,
      mergeSession: storeSession,
    }),
  },
}));
jest.mock('../../../stores/ideStore', () => ({
  useEditorSyntaxTheme: () => syntaxThemeId,
}));

jest.mock('../../../wails/bindings', () => ({
  ...jest.requireActual('../../../wails/bindings'),
  GitConflictStages: jest.fn(),
  GitFileAtRev: jest.fn(),
}));

import {
  MergeResolutionView,
  describeMergeAnnouncement,
} from '../../../components/Editor/MergeResolutionView';
import { GitConflictStages, GitFileAtRev } from '../../../wails/bindings';
import { CancellablePromise } from '../../../wails/runtime';

const mockedStages = GitConflictStages as jest.MockedFunction<typeof GitConflictStages>;
const mockedFileAtRev = GitFileAtRev as jest.MockedFunction<typeof GitFileAtRev>;

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

const textSession = {
  kind: 'text',
  path: 'src/conflict.ts',
  absPath: '/repo/src/conflict.ts',
  repoRoot: '/repo',
  labels: {
    operation: 'merge',
    ours: { label: 'current', hash: 'abc', subject: '' },
    theirs: { label: 'incoming', hash: 'def', subject: '' },
  },
  fileQueue: ['src/conflict.ts', 'src/next.ts'],
  requestRevision: 1,
  epoch: 1,
  fileWriteRevision: 1,
  content: '<<<<<<< current\nleft\n=======\nright\n>>>>>>> incoming\n',
  encoding: 'utf-8',
  lineEndings: 'lf',
  regions: [
    {
      index: 0,
      startLine: 1,
      endLine: 5,
      ours: ['left'],
      base: [],
      theirs: ['right'],
      hasBase: false,
      oursLabel: 'current',
      theirLabel: 'incoming',
    },
  ],
  decisions: {},
  readOnly: false,
} as unknown as TextMergeSession;

const sidesSession = {
  kind: 'sides',
  path: 'logo.png',
  absPath: '/repo/logo.png',
  repoRoot: '/repo',
  labels: {
    operation: 'merge',
    ours: { label: 'current', hash: 'abc', subject: '' },
    theirs: { label: 'incoming', hash: 'def', subject: '' },
  },
  fileQueue: ['logo.png'],
  requestRevision: 2,
  epoch: 1,
  fileWriteRevision: 1,
  stages: { path: 'logo.png', ours: { hash: 'abc', size: 1 }, binary: true },
} as unknown as MergeSession;

beforeEach(() => {
  jest.clearAllMocks();
  mockedStages.mockReset();
  mockedFileAtRev.mockReset();
  syntaxThemeId = 'glacier';
  onStateChange = undefined;
  onDocumentChanged = undefined;
  onResolutionRefused = undefined;
  storeSession = null;
  applyMergeReload.mockImplementation(() => Promise.resolve());
});

describe('MergeResolutionView', () => {
  it('announces an EOF refusal without mutating and clears it after navigation, progress, or a new request', () => {
    const navigableSession = {
      ...textSession,
      regions: [...textSession.regions, { ...textSession.regions[0], index: 1 }],
    } as MergeSession;
    const { rerender } = render(<MergeResolutionView session={navigableSession} visible />);

    act(() => onResolutionRefused?.('B', 'ambiguous-eof'));

    expect(screen.getByRole('alert')).toHaveTextContent(/Take Both.*Current or Incoming/i);
    expect(recordDecision).not.toHaveBeenCalled();
    expect(reopenDecision).not.toHaveBeenCalled();
    expect(markMergeDirty).not.toHaveBeenCalled();

    act(() => onStateChange?.({ activeIndex: 1, decisions: {}, order: 'current-first' }));
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => onResolutionRefused?.('M', 'ambiguous-eof'));
    expect(screen.getByRole('alert')).toHaveTextContent(/Edit manually.*Current or Incoming/i);

    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'C' }, order: 'current-first' })
    );
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => onResolutionRefused?.('C', 'nonterminal-eof'));
    expect(screen.getByRole('alert')).toHaveTextContent(/Current.*not at the end.*Reopen/i);

    rerender(
      <MergeResolutionView
        session={{ ...navigableSession, requestRevision: 2 } as MergeSession}
        visible
      />
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('mounts a text Result editor, reflects its decisions, and finalizes only its live document', async () => {
    render(<MergeResolutionView session={textSession} visible />);

    expect(screen.getByText('src/conflict.ts')).toBeInTheDocument();
    expect(screen.getByText('2 conflicted files remaining')).toBeInTheDocument();
    expect(screen.getByText('1 unresolved')).toBeInTheDocument();
    const unresolvedRail = screen.getByRole('button', { name: 'Conflict 1: unresolved' });
    expect(unresolvedRail).toHaveTextContent('1');
    expect(unresolvedRail).toHaveClass('active');
    expect(unresolvedRail).toHaveAttribute('aria-current', 'true');
    expect(unresolvedRail).not.toHaveAttribute('aria-pressed');
    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeDisabled();
    expect(createMergeResolutionEditor).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      textSession,
      expect.objectContaining({ onStateChange: expect.any(Function) })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next unresolved' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conflict 1: unresolved' }));
    expect(controller.undo).toHaveBeenCalled();
    expect(controller.next).toHaveBeenCalledWith(1);
    expect(controller.activate).toHaveBeenCalledWith(0);

    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'I' }, order: 'current-first' })
    );
    expect(recordDecision).toHaveBeenCalledWith(0, 'I');
    const enabledFinalize = screen.getByRole('button', { name: 'Write & stage' });
    expect(enabledFinalize).toBeEnabled();
    await act(async () => {
      fireEvent.click(enabledFinalize);
      await Promise.resolve();
    });
    // Task 8 turned the advance on: no options argument at all.
    expect(mergeFinalizeAndStage).toHaveBeenCalledWith('resolved result');
  });

  it('applies the active syntax theme and updates it without remounting the editor', () => {
    const { rerender } = render(<MergeResolutionView session={textSession} visible />);

    expect(createMergeResolutionEditor).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      textSession,
      expect.objectContaining({ syntaxThemeId: 'glacier' })
    );
    expect(createMergeResolutionEditor).toHaveBeenCalledTimes(1);

    jest.mocked(controller.setTheme).mockClear();
    syntaxThemeId = 'abyssal';
    rerender(<MergeResolutionView session={textSession} visible />);

    expect(controller.setTheme).toHaveBeenCalledWith('abyssal');
    expect(createMergeResolutionEditor).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['C', 'Current'],
    ['I', 'Incoming'],
    ['B', 'Both'],
    ['M', 'Manual'],
  ] as const)(
    'names resolved %s rail entries as the Reopen action with their %s status',
    (_decision, word) => {
      render(<MergeResolutionView session={textSession} visible />);
      act(() =>
        onStateChange?.({ activeIndex: 0, decisions: { 0: _decision }, order: 'current-first' })
      );

      const rail = screen.getByRole('button', {
        name: `Reopen conflict 1 (currently ${word})`,
      });
      expect(rail).toHaveTextContent(_decision);
      expect(rail).toHaveAttribute('aria-current', 'true');
      expect(rail).not.toHaveAttribute('aria-pressed');
    }
  );

  it('renders whole-file sides from stage presence and finalizes only a selected side', async () => {
    const { rerender } = render(<MergeResolutionView session={sidesSession} visible />);

    expect(
      screen.getByRole('button', { name: 'CURRENT — current keeps this file' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'INCOMING — incoming deletes this file' })
    ).toBeInTheDocument();
    const finalize = screen.getByRole('button', { name: 'Write & stage' });
    expect(finalize).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'CURRENT — current keeps this file' }));
    expect(selectMergeSide).toHaveBeenCalledWith('ours');
    rerender(
      <MergeResolutionView
        session={{ ...sidesSession, selectedSide: 'ours' } as MergeSession}
        visible
      />
    );
    const enabledFinalize = screen.getByRole('button', { name: 'Write & stage' });
    expect(enabledFinalize).toBeEnabled();
    await act(async () => {
      fireEvent.click(enabledFinalize);
      await Promise.resolve();
    });
    expect(mergeFinalizeAndStage).toHaveBeenCalledWith();
  });

  it('freezes the text controller and blocks mutating controls while finalizing, then releases after failure', async () => {
    let finish: ((result: boolean) => void) | undefined;
    mergeFinalizeAndStage.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    render(
      <MergeResolutionView
        session={{ ...textSession, decisions: { 0: 'C' } } as MergeSession}
        visible
      />
    );
    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'C' }, order: 'current-first' })
    );

    const finalize = screen.getByRole('button', { name: 'Write & stage' });
    fireEvent.click(finalize);
    expect(finalize).toBeDisabled();
    expect(mergeFinalizeAndStage).toHaveBeenCalledTimes(1);
    expect(controller.setFrozen).toHaveBeenCalledWith(true);
    const undo = screen.getByRole('button', { name: 'Undo' });
    const next = screen.getByRole('button', { name: 'Next unresolved' });
    const rail = screen.getByRole('button', {
      name: 'Reopen conflict 1 (currently Current)',
    });
    expect(undo).toBeDisabled();
    expect(next).toBeDisabled();
    expect(rail).toBeDisabled();
    fireEvent.click(undo);
    fireEvent.click(next);
    fireEvent.click(rail);
    expect(controller.undo).not.toHaveBeenCalled();
    expect(controller.next).not.toHaveBeenCalled();
    expect(controller.activate).not.toHaveBeenCalled();

    await act(async () => {
      finish?.(false);
      await Promise.resolve();
    });
    expect(controller.setFrozen).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeEnabled();
    expect(undo).toBeEnabled();
    expect(next).toBeEnabled();
    expect(rail).toBeEnabled();
  });

  it('blocks side changes while finalizing and re-enables them after failure', async () => {
    let finish: ((result: boolean) => void) | undefined;
    mergeFinalizeAndStage.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    render(
      <MergeResolutionView
        session={{ ...sidesSession, selectedSide: 'ours' } as MergeSession}
        visible
      />
    );

    const current = screen.getByRole('button', { name: 'CURRENT — current keeps this file' });
    const incoming = screen.getByRole('button', {
      name: 'INCOMING — incoming deletes this file',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Write & stage' }));
    expect(current).toBeDisabled();
    expect(incoming).toBeDisabled();
    fireEvent.click(incoming);
    expect(selectMergeSide).not.toHaveBeenCalled();

    await act(async () => {
      finish?.(false);
      await Promise.resolve();
    });
    expect(incoming).toBeEnabled();
    fireEvent.click(incoming);
    expect(selectMergeSide).toHaveBeenCalledWith('theirs');
  });

  it('rebuilds the Result controller when the session identity changes', async () => {
    const { rerender } = render(<MergeResolutionView session={textSession} visible />);
    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'C' }, order: 'current-first' })
    );

    rerender(
      <MergeResolutionView
        session={{ ...textSession, requestRevision: 2, decisions: { 0: 'C' } } as MergeSession}
        visible
      />
    );

    // A new request revision means a revalidation installed a whole new
    // session: its regions are positional, so the previous snapshot's live
    // document can never be carried over.
    expect(createMergeResolutionEditor).toHaveBeenCalledTimes(2);
    // The gate now follows the REBUILT controller, whose decisions are empty
    // again — the old controller's resolved state must not keep it enabled.
    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write & stage' }));
      await Promise.resolve();
    });
    expect(mergeFinalizeAndStage).not.toHaveBeenCalled();
  });

  it('keeps the live Result controller across a failed-stage baseline rebase', async () => {
    const { rerender } = render(<MergeResolutionView session={textSession} visible />);
    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'C' }, order: 'current-first' })
    );

    rerender(
      <MergeResolutionView
        session={
          {
            ...textSession,
            content: (textSession as { content: string }).content + '\nrebased baseline',
            fileWriteRevision: 2,
            decisions: { 0: 'C' },
          } as MergeSession
        }
        visible
      />
    );

    expect(createMergeResolutionEditor).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write & stage' }));
      await Promise.resolve();
    });
    // Task 8 turned the advance on: no options argument at all.
    expect(mergeFinalizeAndStage).toHaveBeenCalledWith('resolved result');
  });

  it('rebuilds the Result controller for a new snapshot at the same path', () => {
    const { rerender } = render(<MergeResolutionView session={textSession} visible />);
    const newRegions = [...(textSession as { regions: unknown[] }).regions];
    const newLabels = { ...(textSession as { labels: object }).labels };

    rerender(
      <MergeResolutionView
        session={
          {
            ...textSession,
            regions: newRegions,
            labels: newLabels,
            // A fresh snapshot is always installed as a new session identity.
            requestRevision: 7,
          } as MergeSession
        }
        visible
      />
    );

    expect(createMergeResolutionEditor).toHaveBeenCalledTimes(2);
  });

  it('explains why a non-lossless text session is read-only', () => {
    render(
      <MergeResolutionView
        session={
          {
            ...textSession,
            encoding: 'UTF-16LE',
            lineEndings: 'CRLF',
            readOnly: true,
          } as MergeSession
        }
        visible
      />
    );

    expect(screen.getByText(/UTF-16LE.*CRLF.*losslessly/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeDisabled();
  });

  it('announces decisions and reopens through the live region', () => {
    render(<MergeResolutionView session={textSession} visible />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('1 conflict unresolved.');

    act(() => onStateChange?.({ activeIndex: 0, decisions: { 0: 'C' }, order: 'current-first' }));
    expect(status).toHaveTextContent('Conflict 1 resolved: took current. 0 unresolved.');

    act(() => onStateChange?.({ activeIndex: 0, decisions: {}, order: 'current-first' }));
    expect(status).toHaveTextContent('Conflict 1 reopened. 1 unresolved.');
  });

  it('resets the announcement to the new file summary when the session advances', () => {
    const { rerender } = render(<MergeResolutionView session={textSession} visible />);
    const status = screen.getByRole('status');
    act(() => onStateChange?.({ activeIndex: 0, decisions: { 0: 'C' }, order: 'current-first' }));
    expect(status).toHaveTextContent('Conflict 1 resolved: took current. 0 unresolved.');

    // Advance to a different file — fresh regions/labels identities rebuild the editor.
    const nextSession = {
      ...textSession,
      path: 'src/next.ts',
      requestRevision: 99,
      regions: [...(textSession as { regions: unknown[] }).regions],
      labels: { ...(textSession as { labels: object }).labels },
    } as MergeSession;
    rerender(<MergeResolutionView session={nextSession} visible />);

    // The previous file's "resolved" message must not linger; the new file's
    // summary is announced instead.
    expect(status).toHaveTextContent('1 conflict unresolved.');
  });
});

describe('MergeResolutionView rail reopen', () => {
  it('reopens a resolved conflict from the rail and surfaces a jump-back button', () => {
    render(<MergeResolutionView session={textSession} visible />);
    act(() => onStateChange?.({ activeIndex: 0, decisions: { 0: 'C' }, order: 'current-first' }));
    expect(screen.queryByRole('button', { name: /go to it/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reopen conflict 1 (currently Current)' }));
    expect(controller.reopen).toHaveBeenCalledWith(0);

    // The real editor would fire onStateChange after the reopen transaction; here
    // we drive it explicitly to the reopened state.
    act(() => onStateChange?.({ activeIndex: 0, decisions: {}, order: 'current-first' }));
    expect(
      screen.getByRole('button', { name: 'Conflict 1 reopened — go to it' })
    ).toBeInTheDocument();
  });

  it('jump-back activates the reopened conflict and then hides itself', () => {
    render(<MergeResolutionView session={textSession} visible />);
    act(() => onStateChange?.({ activeIndex: 0, decisions: { 0: 'C' }, order: 'current-first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen conflict 1 (currently Current)' }));
    act(() => onStateChange?.({ activeIndex: 0, decisions: {}, order: 'current-first' }));

    fireEvent.click(screen.getByRole('button', { name: 'Conflict 1 reopened — go to it' }));
    expect(controller.activate).toHaveBeenCalledWith(0);
    expect(screen.queryByRole('button', { name: /go to it/i })).not.toBeInTheDocument();
  });

  it('activating an unresolved rail entry does not reopen or surface the jump button', () => {
    render(<MergeResolutionView session={textSession} visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Conflict 1: unresolved' }));

    expect(controller.activate).toHaveBeenCalledWith(0);
    expect(controller.reopen).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /go to it/i })).not.toBeInTheDocument();
  });

  it('clears the jump affordance when the session advances to another file', () => {
    const { rerender } = render(<MergeResolutionView session={textSession} visible />);
    act(() => onStateChange?.({ activeIndex: 0, decisions: { 0: 'C' }, order: 'current-first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen conflict 1 (currently Current)' }));
    act(() => onStateChange?.({ activeIndex: 0, decisions: {}, order: 'current-first' }));
    expect(screen.getByRole('button', { name: /go to it/i })).toBeInTheDocument();

    // Advance to a different file. Fresh regions/labels identities force the
    // editor-create effect (keyed on [session.labels, session.regions]) to rebuild;
    // the stale jump target must not survive into the untouched next file.
    const nextSession = {
      ...textSession,
      path: 'src/next.ts',
      requestRevision: 99,
      regions: [...(textSession as { regions: unknown[] }).regions],
      labels: { ...(textSession as { labels: object }).labels },
    } as MergeSession;
    rerender(<MergeResolutionView session={nextSession} visible />);

    expect(screen.queryByRole('button', { name: /go to it/i })).not.toBeInTheDocument();
  });
});

describe('MergeResolutionView base strip', () => {
  it('keeps a polite live region mounted and announces loading', () => {
    mockedStages.mockReturnValue(new CancellablePromise<never>(() => undefined));

    render(<MergeResolutionView session={textSession} visible />);
    const toggle = screen.getByRole('button', { name: 'Show base (common ancestor)' });
    const liveRegion = toggle.parentElement?.querySelector('[aria-live="polite"]');

    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toBeEmptyDOMElement();
    fireEvent.click(toggle);
    expect(liveRegion).toHaveTextContent('Loading base…');
  });

  it('toggles a focusable base region and reuses successfully loaded content', async () => {
    mockedStages.mockResolvedValue({
      path: 'src/conflict.ts',
      base: { hash: 'abc', size: 12 },
      binary: false,
    } as never);
    mockedFileAtRev.mockResolvedValue({
      content: 'ancestor\n',
      binary: false,
      truncated: false,
    } as never);

    render(<MergeResolutionView session={textSession} visible />);
    const show = screen.getByRole('button', { name: 'Show base (common ancestor)' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(show);

    const hide = await screen.findByRole('button', { name: 'Hide base (common ancestor)' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    const baseRegion = await screen.findByRole('region', {
      name: 'Base version, read-only',
    });
    expect(baseRegion).toHaveTextContent('ancestor');
    expect(baseRegion).toHaveAttribute('tabindex', '0');
    baseRegion.focus();
    expect(baseRegion).toHaveFocus();
    expect(hide.parentElement?.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'Base version loaded.'
    );
    expect(mockedFileAtRev).toHaveBeenCalledWith('/repo', ':1', 'src/conflict.ts');

    fireEvent.click(hide);
    expect(screen.getByRole('button', { name: 'Show base (common ancestor)' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(
      screen.queryByRole('region', { name: 'Base version, read-only' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show base (common ancestor)' }));
    expect(
      await screen.findByRole('region', { name: 'Base version, read-only' })
    ).toHaveTextContent('ancestor');
    expect(mockedStages).toHaveBeenCalledTimes(1);
    expect(mockedFileAtRev).toHaveBeenCalledTimes(1);
  });

  it('retries a transient base error from the collapsed Show control', async () => {
    mockedStages.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce({
      path: 'src/conflict.ts',
      base: { hash: 'abc', size: 12 },
      binary: false,
    } as never);
    mockedFileAtRev.mockResolvedValue({
      content: 'ancestor\n',
      binary: false,
      truncated: false,
    } as never);

    render(<MergeResolutionView session={textSession} visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Show base (common ancestor)' }));

    const error = await screen.findByText('Could not read the base version: network unavailable');
    expect(error).toHaveAttribute('aria-live', 'polite');
    const retry = screen.getByRole('button', { name: 'Show base (common ancestor)' });
    expect(retry).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(retry);
    expect(
      await screen.findByRole('region', { name: 'Base version, read-only' })
    ).toHaveTextContent('ancestor');
    expect(mockedStages).toHaveBeenCalledTimes(2);
    expect(mockedFileAtRev).toHaveBeenCalledTimes(1);
  });

  it('clears expanded base content when the session identity changes', async () => {
    mockedStages.mockResolvedValue({
      path: 'src/conflict.ts',
      base: { hash: 'abc', size: 12 },
      binary: false,
    } as never);
    mockedFileAtRev
      .mockResolvedValueOnce({
        content: 'old ancestor\n',
        binary: false,
        truncated: false,
      } as never)
      .mockResolvedValueOnce({
        content: 'fresh ancestor\n',
        binary: false,
        truncated: false,
      } as never);

    const { rerender } = render(<MergeResolutionView session={textSession} visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Show base (common ancestor)' }));
    expect(
      await screen.findByRole('region', { name: 'Base version, read-only' })
    ).toHaveTextContent('old ancestor');

    rerender(
      <MergeResolutionView
        session={{ ...textSession, requestRevision: 2 } as MergeSession}
        visible
      />
    );
    expect(screen.getByRole('button', { name: 'Show base (common ancestor)' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(
      screen.queryByRole('region', { name: 'Base version, read-only' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show base (common ancestor)' }));
    expect(
      await screen.findByRole('region', { name: 'Base version, read-only' })
    ).toHaveTextContent('fresh ancestor');
  });

  it('explains an absent base instead of showing an empty pane', async () => {
    mockedStages.mockResolvedValue({ path: 'src/conflict.ts', binary: false } as never);

    render(<MergeResolutionView session={textSession} visible />);
    fireEvent.click(screen.getByRole('button', { name: /show base/i }));

    await waitFor(() =>
      expect(
        screen.getByText('No common ancestor — this file was added on both sides.')
      ).toHaveAttribute('aria-live', 'polite')
    );
    expect(mockedFileAtRev).not.toHaveBeenCalled();
  });

  it('explains a base blob that exists but is empty (never an empty pane)', async () => {
    mockedStages.mockResolvedValue({
      path: 'src/conflict.ts',
      base: { hash: 'abc', size: 0 },
      binary: false,
    } as never);
    mockedFileAtRev.mockResolvedValue({ content: '', binary: false, truncated: false } as never);

    render(<MergeResolutionView session={textSession} visible />);
    fireEvent.click(screen.getByRole('button', { name: /show base/i }));

    await waitFor(() =>
      expect(
        screen.getByText('The common ancestor version of this file was empty.')
      ).toBeInTheDocument()
    );
  });

  it('explains a binary base', async () => {
    mockedStages.mockResolvedValue({
      path: 'src/conflict.ts',
      base: { hash: 'abc', size: 99 },
      binary: false,
    } as never);
    mockedFileAtRev.mockResolvedValue({ content: '', binary: true, truncated: false } as never);

    render(<MergeResolutionView session={textSession} visible />);
    fireEvent.click(screen.getByRole('button', { name: /show base/i }));

    await waitFor(() =>
      expect(screen.getByText('Base version is binary — nothing to show.')).toBeInTheDocument()
    );
  });

  it('explains a truncated base', async () => {
    mockedStages.mockResolvedValue({
      path: 'src/conflict.ts',
      base: { hash: 'abc', size: 9_000_000 },
      binary: false,
    } as never);
    mockedFileAtRev.mockResolvedValue({ content: '', binary: false, truncated: true } as never);

    render(<MergeResolutionView session={textSession} visible />);
    fireEvent.click(screen.getByRole('button', { name: /show base/i }));

    await waitFor(() =>
      expect(screen.getByText('Base version is too large to display.')).toBeInTheDocument()
    );
  });
});

describe('describeMergeAnnouncement', () => {
  it('describes a single resolution with its decision and the remaining count', () => {
    expect(describeMergeAnnouncement({}, { 0: 'C' }, 2)).toBe(
      'Conflict 1 resolved: took current. 1 unresolved.'
    );
  });

  it('describes a single reopen', () => {
    expect(describeMergeAnnouncement({ 0: 'C' }, {}, 2)).toBe('Conflict 1 reopened. 2 unresolved.');
  });

  it('describes several regions changed in one transaction deterministically', () => {
    expect(describeMergeAnnouncement({ 0: 'C', 1: 'C' }, { 0: 'M', 1: 'M' }, 2)).toBe(
      'Conflicts 1, 2 resolved. 0 unresolved.'
    );
  });

  it('describes a mixed resolve-and-reopen transaction (the motivating multi-region case)', () => {
    // Region 1 newly resolved to Manual, region 2 reopened, in one transaction.
    expect(describeMergeAnnouncement({ 0: 'C', 2: 'C' }, { 0: 'C', 1: 'M' }, 4)).toBe(
      'Conflict 2 resolved: took manual. Conflict 3 reopened. 2 unresolved.'
    );
  });

  it('returns null when nothing changed', () => {
    expect(describeMergeAnnouncement({ 0: 'C' }, { 0: 'C' }, 2)).toBeNull();
  });
});

describe('MergeResolutionView external-change notice', () => {
  const withExternal = (
    base: MergeSession,
    external: Record<string, unknown>,
    over: Record<string, unknown> = {}
  ) => ({ ...base, external, ...over }) as unknown as MergeSession;

  const worktreeChange = (over: Record<string, unknown> = {}) =>
    withExternal(
      textSession,
      { kind: 'changed', hidden: false, scope: 'worktree', observedVersion: 'v1:moved' },
      over
    );
  const conflictChange = () =>
    withExternal(textSession, {
      kind: 'changed',
      hidden: false,
      scope: 'conflict',
      observedVersion: 'v1:restaged',
    });
  const resolvedOutside = () =>
    withExternal(textSession, {
      kind: 'resolved-outside',
      message: 'src/conflict.ts is no longer conflicted — it was resolved outside Firn.',
    });
  const checkFailed = () =>
    withExternal(textSession, {
      kind: 'check-failed',
      message: 'Could not check src/conflict.ts for outside changes: git exploded.',
    });

  it('offers Reload and Keep working for a worktree-scoped change as a polite notice', () => {
    render(<MergeResolutionView session={worktreeChange()} visible />);

    const notice = screen.getByTestId('merge-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('changed outside Firn');
    // The actions are siblings of the live region, not read as part of it.
    expect(notice.querySelector('button')).toBeNull();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep working/i })).toBeInTheDocument();
  });

  it('makes a conflict-scoped change Reload-only', () => {
    render(<MergeResolutionView session={conflictChange()} visible />);

    expect(screen.getByTestId('merge-notice')).toHaveTextContent(
      'Current and Incoming no longer match what you reviewed'
    );
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    // Acknowledging it would hide the fact that the sides changed meaning.
    expect(screen.queryByRole('button', { name: /keep working/i })).toBeNull();
  });

  it('hides an acknowledged worktree notice without hiding the surface', () => {
    render(
      <MergeResolutionView
        session={withExternal(textSession, {
          kind: 'changed',
          hidden: true,
          scope: 'worktree',
          observedVersion: 'v1:moved',
        })}
        visible
      />
    );

    expect(screen.queryByTestId('merge-notice')).toBeNull();
    expect(screen.getByLabelText(/merge resolution for/i)).toBeInTheDocument();
  });

  it('keeps working through the store and returns focus to the Result', () => {
    render(<MergeResolutionView session={worktreeChange()} visible />);

    fireEvent.click(screen.getByRole('button', { name: /keep working/i }));

    expect(acknowledgeMergeExternal).toHaveBeenCalledTimes(1);
    expect(controller.view.focus).toHaveBeenCalled();
  });

  it('reloads through the store and focuses the Result when the notice clears', async () => {
    storeSession = worktreeChange();
    render(<MergeResolutionView session={worktreeChange()} visible />);
    applyMergeReload.mockImplementation(() => {
      storeSession = textSession; // the swap cleared the notice
      return Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    });

    expect(applyMergeReload).toHaveBeenCalledTimes(1);
    expect(controller.view.focus).toHaveBeenCalled();
  });

  it('keeps focus on the action when a reload leaves a notice behind', async () => {
    storeSession = worktreeChange();
    render(<MergeResolutionView session={worktreeChange()} visible />);
    applyMergeReload.mockImplementation(() => Promise.resolve()); // notice survives

    const reload = screen.getByRole('button', { name: /reload/i });
    await act(async () => {
      fireEvent.click(reload);
    });

    expect(reload).toHaveFocus();
    expect(controller.view.focus).not.toHaveBeenCalled();
  });

  it('announces resolved-outside as an alert and closes through the guard', () => {
    render(<MergeResolutionView session={resolvedOutside()} visible />);

    expect(screen.getByTestId('merge-notice')).toHaveTextContent('resolved outside Firn');
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    // Never closeMergeResolution directly: a touched session still gets its
    // discard confirmation.
    expect(requestMergeClose).toHaveBeenCalledTimes(1);
  });

  it('offers Retry for a failed check and blocks finalizing', () => {
    render(<MergeResolutionView session={checkFailed()} visible />);
    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'C' }, order: 'current-first' })
    );

    expect(screen.getByTestId('merge-notice')).toHaveTextContent('Could not check');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // Every conflict is resolved, yet an unverifiable session must not write.
    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeDisabled();
  });

  it('a successful same-version Retry clears the notice without rebuilding', async () => {
    storeSession = checkFailed();
    render(<MergeResolutionView session={checkFailed()} visible />);
    applyMergeReload.mockImplementation(() => {
      storeSession = textSession;
      return Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    });

    expect(createMergeResolutionEditor).toHaveBeenCalledTimes(1);
    expect(controller.view.focus).toHaveBeenCalled();
  });

  it('freezes the document and the controls while a reload is in flight', () => {
    render(<MergeResolutionView session={worktreeChange({ reloadPending: true })} visible />);

    expect(controller.setFrozen).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: /reload/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /undo/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeDisabled();
  });

  it('shows the notice on a sides session while leaving its side choices usable', () => {
    render(
      <MergeResolutionView
        session={withExternal(sidesSession, {
          kind: 'changed',
          hidden: false,
          scope: 'worktree',
          observedVersion: 'v1:moved',
        })}
        visible
      />
    );

    expect(screen.getByTestId('merge-notice')).toHaveTextContent('changed outside Firn');
    // Keeping working has to actually be possible: the notice blocks writing,
    // not deciding.
    expect(screen.getByRole('button', { name: /CURRENT/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeDisabled();
  });

  it('returns focus to the first side choice after keep working on a sides session', () => {
    render(
      <MergeResolutionView
        session={withExternal(sidesSession, {
          kind: 'changed',
          hidden: false,
          scope: 'worktree',
          observedVersion: 'v1:moved',
        })}
        visible
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /keep working/i }));

    expect(acknowledgeMergeExternal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /CURRENT/ })).toHaveFocus();
  });

  it('renders no notice when the session is in sync', () => {
    render(<MergeResolutionView session={textSession} visible />);
    expect(screen.queryByTestId('merge-notice')).toBeNull();
    expect(screen.queryByTestId('merge-notice')).toBeNull();
  });
});

describe('MergeResolutionView dirty reporting and remaining work', () => {
  it('reports an accepted document change to the store', () => {
    render(<MergeResolutionView session={textSession} visible />);

    act(() => onDocumentChanged?.());

    // Including an edit outside every conflict region, which records no
    // decision at all.
    expect(markMergeDirty).toHaveBeenCalledTimes(1);
  });

  it('states remaining work as a count, not a false ordinal', () => {
    render(
      <MergeResolutionView
        session={{ ...textSession, fileQueue: ['a.ts', 'b.ts', 'c.ts'] } as MergeSession}
        visible
      />
    );
    expect(screen.getByText('3 conflicted files remaining')).toBeInTheDocument();
  });

  it('uses the singular for the last file', () => {
    render(
      <MergeResolutionView
        session={{ ...textSession, fileQueue: ['a.ts'] } as MergeSession}
        visible
      />
    );
    expect(screen.getByText('1 conflicted file remaining')).toBeInTheDocument();
  });
});

describe('MergeResolutionView discard confirmation', () => {
  const closeRequested = (base: MergeSession = textSession) =>
    ({ ...base, dirty: true, closeRequested: true }) as unknown as MergeSession;

  it('opens a modal alertdialog focused on the non-destructive choice', () => {
    render(<MergeResolutionView session={closeRequested()} visible />);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(screen.getByRole('button', { name: /keep working/i })).toHaveFocus();
  });

  it('says only in-session work is discarded', () => {
    render(<MergeResolutionView session={closeRequested()} visible />);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('does not change the file on disk');
    expect(dialog).toHaveTextContent('conflict markers stay exactly as they are');
  });

  it('cancels through the store and restores focus to the invoker', () => {
    render(<MergeResolutionView session={textSession} visible />);
    const invoker = screen.getByRole('button', { name: /next unresolved/i });
    invoker.focus();
    const { rerender } = { rerender: (node: React.ReactElement) => node };
    void rerender;

    // The dialog appears while the invoker holds focus.
    render(<MergeResolutionView session={closeRequested()} visible />);
    fireEvent.click(screen.getAllByRole('button', { name: /keep working/i })[0]);

    expect(cancelMergeClose).toHaveBeenCalledTimes(1);
  });

  it('discards through the store', () => {
    render(<MergeResolutionView session={closeRequested()} visible />);

    fireEvent.click(screen.getByRole('button', { name: /discard and close/i }));

    expect(confirmMergeClose).toHaveBeenCalledTimes(1);
  });

  it('a native cancel keeps the session and only dismisses the request', () => {
    render(<MergeResolutionView session={closeRequested()} visible />);

    fireEvent(screen.getByRole('alertdialog'), new Event('cancel', { cancelable: true }));

    expect(cancelMergeClose).toHaveBeenCalledTimes(1);
    expect(confirmMergeClose).not.toHaveBeenCalled();
  });

  it('renders one confirmation for a sides session too', () => {
    render(<MergeResolutionView session={closeRequested(sidesSession)} visible />);

    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });
});

describe('MergeResolutionView escape', () => {
  const surface = () => screen.getByLabelText(/merge resolution for/i);
  /** A node inside the editor host, so the event has to bubble out of the
   * editor the way a real CodeMirror keypress does. */
  const inEditor = () => {
    const host = surface().querySelector(`.${'editorHost'}`) ?? surface();
    const node = document.createElement('div');
    node.tabIndex = 0;
    host.appendChild(node);
    return node;
  };

  it('closes a pristine session through the guard, writing nothing', () => {
    render(<MergeResolutionView session={textSession} visible />);

    fireEvent.keyDown(surface(), { key: 'Escape' });

    expect(requestMergeClose).toHaveBeenCalledTimes(1);
    expect(mergeFinalizeAndStage).not.toHaveBeenCalled();
    expect(confirmMergeClose).not.toHaveBeenCalled();
  });

  it('handles Escape raised inside the editor', () => {
    render(<MergeResolutionView session={textSession} visible />);

    fireEvent.keyDown(inEditor(), { key: 'Escape' });

    expect(requestMergeClose).toHaveBeenCalledTimes(1);
  });

  it('asks the store, which decides whether a touched session needs confirmation', () => {
    render(
      <MergeResolutionView session={{ ...textSession, dirty: true } as MergeSession} visible />
    );

    fireEvent.keyDown(surface(), { key: 'Escape' });

    // The view never decides: requestMergeClose owns pristine-vs-touched.
    expect(requestMergeClose).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape the editor already consumed', () => {
    render(<MergeResolutionView session={textSession} visible />);
    const node = inEditor();

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    node.dispatchEvent(event);

    expect(requestMergeClose).not.toHaveBeenCalled();
  });

  it('ignores an Escape that is closing an IME composition', () => {
    render(<MergeResolutionView session={textSession} visible />);

    fireEvent.keyDown(surface(), { key: 'Escape', isComposing: true });
    fireEvent.keyDown(surface(), { key: 'Process', keyCode: 229 });

    expect(requestMergeClose).not.toHaveBeenCalled();
  });

  it('ignores Escape while a finalize is running', async () => {
    let release = () => {};
    mergeFinalizeAndStage.mockImplementation(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true)))
    );
    render(<MergeResolutionView session={textSession} visible />);
    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'C' }, order: 'current-first' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Write & stage' }));

    fireEvent.keyDown(surface(), { key: 'Escape' });
    expect(requestMergeClose).not.toHaveBeenCalled();

    await act(async () => {
      release();
    });
  });

  it('ignores Escape while a reload is in flight', () => {
    render(
      <MergeResolutionView
        session={{ ...textSession, reloadPending: true } as MergeSession}
        visible
      />
    );

    fireEvent.keyDown(surface(), { key: 'Escape' });

    expect(requestMergeClose).not.toHaveBeenCalled();
  });

  it('leaves other keys alone', () => {
    render(<MergeResolutionView session={textSession} visible />);

    fireEvent.keyDown(surface(), { key: 'Enter' });
    fireEvent.keyDown(surface(), { key: 'F7' });

    expect(requestMergeClose).not.toHaveBeenCalled();
  });
});

describe('MergeResolutionView overwrite consent', () => {
  const worktreeChanged = (base: MergeSession = textSession, over: Record<string, unknown> = {}) =>
    ({
      ...base,
      external: {
        kind: 'changed',
        hidden: false,
        scope: 'worktree',
        observedVersion: 'v1:moved',
      },
      ...over,
    }) as unknown as MergeSession;
  const conflictChanged = () =>
    ({
      ...textSession,
      external: {
        kind: 'changed',
        hidden: false,
        scope: 'conflict',
        observedVersion: 'v1:restaged',
      },
    }) as unknown as MergeSession;
  const resolveAll = () =>
    act(() =>
      onStateChange?.({ activeIndex: null, decisions: { 0: 'C' }, order: 'current-first' })
    );

  it('offers Write and stage for a worktree change, behind a destructive confirmation', async () => {
    render(<MergeResolutionView session={worktreeChanged()} visible />);
    resolveAll();

    const write = screen.getByRole('button', { name: 'Write & stage' });
    expect(write).toBeEnabled();
    fireEvent.click(write);

    // The click asks first: nothing is written until the user confirms.
    expect(mergeFinalizeAndStage).not.toHaveBeenCalled();
    expect(mergeOverwriteAndStage).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /overwrite and stage/i }));
    });
    expect(mergeOverwriteAndStage).toHaveBeenCalledWith('resolved result');
  });

  it('cancelling the overwrite writes nothing and restores focus', () => {
    render(<MergeResolutionView session={worktreeChanged()} visible />);
    resolveAll();
    const write = screen.getByRole('button', { name: 'Write & stage' });
    write.focus();
    fireEvent.click(write);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(mergeOverwriteAndStage).not.toHaveBeenCalled();
    expect(mergeFinalizeAndStage).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(write).toHaveFocus();
  });

  it('a native cancel on the overwrite dialog is also non-destructive', () => {
    render(<MergeResolutionView session={worktreeChanged()} visible />);
    resolveAll();
    fireEvent.click(screen.getByRole('button', { name: 'Write & stage' }));

    fireEvent(screen.getByRole('alertdialog'), new Event('cancel', { cancelable: true }));

    expect(mergeOverwriteAndStage).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('never offers an overwrite for a conflict-scoped change', () => {
    render(<MergeResolutionView session={conflictChanged()} visible />);
    resolveAll();

    expect(screen.getByRole('button', { name: 'Write & stage' })).toBeDisabled();
  });

  it('offers the overwrite on a sides session too', async () => {
    render(
      <MergeResolutionView
        session={worktreeChanged(sidesSession, { selectedSide: 'ours' })}
        visible
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Write & stage' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /overwrite and stage/i }));
    });

    // A sides session has no document to submit, only the recorded side.
    expect(mergeOverwriteAndStage).toHaveBeenCalledWith(undefined);
  });

  it('focuses the Result after a finalize that advanced to another file', async () => {
    storeSession = textSession;
    render(<MergeResolutionView session={textSession} visible />);
    resolveAll();
    mergeFinalizeAndStage.mockImplementation(() => {
      storeSession = { ...textSession, path: 'src/next.ts' } as unknown as MergeSession;
      return Promise.resolve(true);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write & stage' }));
    });

    expect(controller.view.focus).toHaveBeenCalled();
  });
});
