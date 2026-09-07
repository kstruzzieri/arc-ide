import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

jest.mock('../../../../wails/bindings', () => {
  const actual = jest.requireActual('../../../../wails/bindings');
  return {
    ...actual,
    LSPHover: jest.fn(),
    LSPDefinition: jest.fn(),
  };
});

jest.mock('../../../../wails/runtime', () => ({
  // Spread the real adapter so CancellablePromise stays available to the test.
  ...jest.requireActual('../../../../wails/runtime'),
  ClipboardSetText: jest.fn(() => Promise.resolve()),
  BrowserOpenURL: jest.fn(),
}));

jest.mock('../../../../utils/lspDocumentSync', () => ({
  flushLSPDocumentChange: jest.fn(() => Promise.resolve(false)),
}));

import { LSPHover } from '../../../../wails/bindings';
import { lsp } from '../../../../wails/bindings';
import { CancellablePromise } from '../../../../wails/runtime';
import { flushLSPDocumentChange } from '../../../../utils/lspDocumentSync';
import { loadLanguageSupport } from '../../../../components/Editor/codemirror/languages';
import {
  collapseBlankRuns,
  createLSPHoverSource,
  highlightSignatureParts,
  hoverRequestPos,
  hoverTargetRange,
  splitDocLinks,
} from '../../../../components/Editor/codemirror/hover';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createLSPHoverSource', () => {
  const mockHover = LSPHover as jest.MockedFunction<typeof LSPHover>;
  const mockFlush = flushLSPDocumentChange as jest.MockedFunction<typeof flushLSPDocumentChange>;

  it('drops hover requests when the document changes while flushing', async () => {
    const { view, setDoc } = createMutableEditorView('const value = 1');
    mockFlush.mockImplementation(async () => {
      setDoc('const other = 1');
      return false;
    });

    const result = await createLSPHoverSource('/project/src/file.ts')(view, 7);

    expect(result).toBeNull();
    expect(mockHover).not.toHaveBeenCalled();
  });

  it('drops hover results when the document changes while the request is in flight', async () => {
    const { view, setDoc } = createMutableEditorView('const value = 1');
    let resolveHover: (value: Awaited<ReturnType<typeof LSPHover>>) => void = () => {};

    mockHover.mockReturnValue(
      new CancellablePromise((resolve) => {
        resolveHover = resolve;
      })
    );

    const pending = createLSPHoverSource('/project/src/file.ts')(view, 7);
    await Promise.resolve();

    expect(mockHover).toHaveBeenCalledTimes(1);

    setDoc('const other = 1');
    resolveHover(
      lsp.Hover.createFrom({
        contents: encodeRawJSON({ kind: 'markdown', value: 'value docs' }),
      })
    );

    await expect(pending).resolves.toBeNull();
  });
});

describe('hoverTargetRange', () => {
  it('returns null when there is no word under the cursor', () => {
    expect(hoverTargetRange(null, 12)).toBeNull();
  });

  it('anchors the tooltip to the full symbol range', () => {
    expect(hoverTargetRange({ from: 24, to: 31 }, 27)).toEqual({
      from: 24,
      to: 31,
    });
  });

  it('clamps the hover request position inside the hovered symbol', () => {
    expect(hoverRequestPos({ from: 24, to: 31 }, 31)).toBe(30);
  });
});

describe('highlightSignatureParts', () => {
  it('classifies TypeScript hover signatures into syntax color parts (regex fallback)', () => {
    expect(
      highlightSignatureParts('const ANNOTATION_COLORS: Record<AnnotationType, string>')
    ).toEqual([
      { text: 'const', className: 'firn-hover-keyword' },
      { text: ' ', className: '' },
      { text: 'ANNOTATION_COLORS', className: 'firn-hover-constant' },
      { text: ':', className: 'firn-hover-punctuation' },
      { text: ' ', className: '' },
      { text: 'Record', className: 'firn-hover-type' },
      { text: '<', className: 'firn-hover-punctuation' },
      { text: 'AnnotationType', className: 'firn-hover-type' },
      { text: ',', className: 'firn-hover-punctuation' },
      { text: ' ', className: '' },
      { text: 'string', className: 'firn-hover-type' },
      { text: '>', className: 'firn-hover-punctuation' },
    ]);
  });

  it('uses the regex fallback until the file language has loaded', () => {
    const parts = highlightSignatureParts('func LogWarning(ctx context.Context)', '/proj/app.go');

    expect(parts).not.toContainEqual({ text: 'func', className: 'firn-hover-keyword' });
  });

  it('highlights a Go signature with the already-loaded Go parser', async () => {
    await expect(loadLanguageSupport('/proj/app.go')).resolves.not.toBeNull();
    const parts = highlightSignatureParts(
      'func LogWarning(ctx context.Context, message string)',
      '/proj/app.go'
    );
    // The TS regex never knew `func`; the parser does.
    expect(parts).toContainEqual({ text: 'func', className: 'firn-hover-keyword' });
    expect(parts).toContainEqual({ text: 'LogWarning', className: 'firn-hover-function' });
    expect(parts).toContainEqual({ text: 'Context', className: 'firn-hover-type' });
    expect(parts).toContainEqual({ text: 'string', className: 'firn-hover-type' });
    // Round-trips the exact source text.
    expect(parts.map((p) => p.text).join('')).toBe(
      'func LogWarning(ctx context.Context, message string)'
    );
  });

  it('falls back to the regex highlighter for an unknown extension', () => {
    const parts = highlightSignatureParts('const x = 1', '/proj/file.unknownext');
    expect(parts).toContainEqual({ text: 'const', className: 'firn-hover-keyword' });
  });
});

describe('splitDocLinks', () => {
  it('extracts a markdown link', () => {
    expect(splitDocLinks('see [LogWarning](https://pkg.go.dev/x#L) now')).toEqual([
      { text: 'see ' },
      { text: 'LogWarning', url: 'https://pkg.go.dev/x#L' },
      { text: ' now' },
    ]);
  });

  it('linkifies a bare URL', () => {
    expect(splitDocLinks('bare https://example.com end')).toEqual([
      { text: 'bare ' },
      { text: 'https://example.com', url: 'https://example.com' },
      { text: ' end' },
    ]);
  });

  it('returns a single plain segment when there are no links', () => {
    expect(splitDocLinks('no links here')).toEqual([{ text: 'no links here' }]);
  });
});

describe('collapseBlankRuns', () => {
  it('collapses consecutive blank lines to one and trims the edges', () => {
    expect(collapseBlankRuns(['', 'a', '', '', 'b', '', ''])).toEqual(['a', '', 'b']);
  });

  it('leaves already-compact text untouched', () => {
    expect(collapseBlankRuns(['a', '', 'b'])).toEqual(['a', '', 'b']);
  });
});

function createMutableEditorView(doc: string): {
  view: EditorView;
  setDoc: (nextDoc: string) => void;
} {
  let currentState = EditorState.create({ doc });
  return {
    view: {
      get state() {
        return currentState;
      },
    } as EditorView,
    setDoc: (nextDoc: string) => {
      currentState = EditorState.create({ doc: nextDoc });
    },
  };
}

function encodeRawJSON(value: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}
