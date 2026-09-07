import { acceptCompletion } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';

jest.mock('../../../../wails/bindings', () => ({
  LSPComplete: jest.fn(),
  LSPResolveCompletionItem: jest.fn(),
}));

jest.mock('../../../../utils/lspDocumentSync', () => ({
  flushLSPDocumentChange: jest.fn(() => Promise.resolve(false)),
}));

import { LSPComplete, LSPResolveCompletionItem } from '../../../../wails/bindings';
import { CancellablePromise } from '../../../../wails/runtime';
import { flushLSPDocumentChange } from '../../../../utils/lspDocumentSync';
import {
  COMPLETION_RESOLVE_CACHE_LIMIT,
  clearCompletionResolveCache,
  completionResolveCacheSize,
  createLSPCompletionSource,
  parseResolvedCompletionDetail,
  positionCompletionInfo,
  resolveCompletionItem,
  sortLSPCompletionItems,
} from '../../../../components/Editor/codemirror/completion';
import {
  editorKeybindings,
  editorTooltipSpace,
} from '../../../../components/Editor/codemirror/extensions';

beforeEach(() => {
  jest.clearAllMocks();
  clearCompletionResolveCache();
});

describe('sortLSPCompletionItems', () => {
  it('preserves server ordering while demoting internal-style names', () => {
    const sorted = sortLSPCompletionItems([
      { label: '__dirname', sortText: '0001' },
      { label: 'squareMeters', sortText: '0010' },
      { label: '_esri', sortText: '0002' },
      { label: 'meters', sortText: '0009' },
    ]);

    expect(sorted.map((item) => item.label)).toEqual([
      'meters',
      'squareMeters',
      '__dirname',
      '_esri',
    ]);
  });
});

describe('resolveCompletionItem', () => {
  const mockResolve = LSPResolveCompletionItem as jest.MockedFunction<
    typeof LSPResolveCompletionItem
  >;

  it('decodes RawMessage byte arrays before sending resolve requests', async () => {
    const data = encodeRawJSON({ entryId: 7, source: 'tsserver' });
    const documentation = encodeRawJSON({
      kind: 'markdown',
      value: 'Existing docs',
    });

    mockResolve.mockResolvedValue({
      label: 'readFile',
      detail: '(method) readFile(path: string): Promise<string>',
    } as Awaited<ReturnType<typeof LSPResolveCompletionItem>>);

    await resolveCompletionItem('/project/src/file.ts', {
      label: 'readFile',
      data,
      documentation,
    });

    expect(mockResolve).toHaveBeenCalledWith(
      '/project/src/file.ts',
      expect.objectContaining({
        data: { entryId: 7, source: 'tsserver' },
        documentation: {
          kind: 'markdown',
          value: 'Existing docs',
        },
      })
    );
  });

  it('caps the resolve cache to avoid unbounded workspace growth', async () => {
    mockResolve.mockImplementation((_path, item) => CancellablePromise.resolve(item));

    for (let i = 0; i < COMPLETION_RESOLVE_CACHE_LIMIT + 1; i += 1) {
      await resolveCompletionItem('/project/src/file.ts', {
        label: `item${i}`,
        data: { i },
      });
    }

    expect(completionResolveCacheSize()).toBe(COMPLETION_RESOLVE_CACHE_LIMIT);
  });
});

describe('createLSPCompletionSource', () => {
  const mockComplete = LSPComplete as jest.MockedFunction<typeof LSPComplete>;
  const mockFlush = flushLSPDocumentChange as jest.MockedFunction<typeof flushLSPDocumentChange>;

  it('does not send backend requests after CodeMirror aborts the query', async () => {
    const state = EditorState.create({ doc: 'con' });
    const source = createLSPCompletionSource('/project/src/file.ts', new Set());

    const result = await source({
      state,
      pos: 3,
      explicit: false,
      aborted: true,
      addEventListener: jest.fn(),
      matchBefore: (expr: RegExp) => {
        const text = state.sliceDoc(0, 3);
        const match = text.match(expr);
        return match ? { from: 0, to: 3, text: match[0] } : null;
      },
    } as never);

    expect(result).toBeNull();
    expect(mockFlush).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('drops backend results when CodeMirror aborts an in-flight query', async () => {
    const state = EditorState.create({ doc: 'con' });
    const source = createLSPCompletionSource('/project/src/file.ts', new Set());
    let aborted = false;
    let abortListener = () => {};
    let resolveComplete: (value: Awaited<ReturnType<typeof LSPComplete>>) => void = () => {};

    mockComplete.mockReturnValue(
      new CancellablePromise((resolve) => {
        resolveComplete = resolve;
      })
    );

    const pending = source({
      state,
      pos: 3,
      explicit: false,
      get aborted() {
        return aborted;
      },
      addEventListener: (_type: 'abort', listener: () => void) => {
        abortListener = listener;
      },
      matchBefore: (expr: RegExp) => {
        const text = state.sliceDoc(0, 3);
        const match = text.match(expr);
        return match ? { from: 0, to: 3, text: match[0] } : null;
      },
    } as never);

    await Promise.resolve();
    await Promise.resolve();
    expect(mockComplete).toHaveBeenCalledTimes(1);

    aborted = true;
    abortListener();
    resolveComplete({
      isIncomplete: false,
      items: [{ label: 'console' }],
    } as Awaited<ReturnType<typeof LSPComplete>>);

    await expect(pending).resolves.toBeNull();
  });
});

describe('editorKeybindings', () => {
  it('accepts the selected completion on Tab before indentation runs', () => {
    const acceptTabIndex = editorKeybindings.findIndex(
      (binding) => binding.key === 'Tab' && binding.run === acceptCompletion
    );
    const indentTabIndex = editorKeybindings.findIndex((binding) => binding === indentWithTab);

    expect(acceptTabIndex).toBeGreaterThan(-1);
    expect(indentTabIndex).toBeGreaterThan(-1);
    expect(acceptTabIndex).toBeLessThan(indentTabIndex);
  });
});

describe('parseResolvedCompletionDetail', () => {
  it('extracts parameter tails and return types from resolved method details', () => {
    expect(parseResolvedCompletionDetail('has', '(method) has(value: string): boolean')).toEqual({
      tail: '(value: string)',
      rightText: 'boolean',
    });
  });

  it('extracts property types from resolved property details', () => {
    expect(
      parseResolvedCompletionDetail('DEFAULT_CHUNK_SIZE', '(property) DEFAULT_CHUNK_SIZE: number')
    ).toEqual({
      rightText: 'number',
    });
  });
});

describe('positionCompletionInfo', () => {
  it('falls back below the selected option instead of covering the section header', () => {
    expect(
      positionCompletionInfo(
        {} as never,
        { left: 260, right: 780, top: 120, bottom: 420 },
        { left: 260, right: 780, top: 150, bottom: 186 },
        { left: 0, right: 340, top: 0, bottom: 180 },
        { left: 220, right: 820, top: 100, bottom: 440 }
      )
    ).toEqual({
      style: 'top: 72px; left: 0; max-width: 360px; max-height: 244px',
      class: 'cm-completionInfo-below-option',
    });
  });
});

describe('editorTooltipSpace', () => {
  it('uses the visible editor viewport instead of the whole window', () => {
    const view = {
      scrollDOM: {
        getBoundingClientRect: () => ({
          top: 100,
          left: 40,
          right: 840,
          bottom: 520,
        }),
      },
    };

    expect(editorTooltipSpace(view as never)).toEqual({
      top: 106,
      left: 44,
      right: 836,
      bottom: 514,
    });
  });
});

function encodeRawJSON(value: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}
