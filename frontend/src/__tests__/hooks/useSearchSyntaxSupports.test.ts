import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { LanguageSupport } from '@codemirror/language';
import { useSearchSyntaxSupports } from '../../hooks/useSearchSyntaxSupports';
import * as languages from '../../components/Editor/codemirror/languages';

function fakeSupport(name: string): LanguageSupport {
  return { __name: name } as unknown as LanguageSupport;
}

// Minimal LanguageDescription stand-in: only `.name` is read for grouping.
function desc(name: string) {
  return { name } as ReturnType<typeof languages.getLanguageDescription>;
}

describe('useSearchSyntaxSupports', () => {
  const getDesc = jest.spyOn(languages, 'getLanguageDescription');
  const getLoaded = jest.spyOn(languages, 'getLoadedLanguageSupport');
  const load = jest.spyOn(languages, 'loadLanguageSupport');

  beforeEach(() => {
    jest.clearAllMocks();
    getDesc.mockImplementation((f: string) =>
      f.endsWith('.ts') || f.endsWith('.tsx')
        ? desc('TypeScript')
        : f.endsWith('.py')
          ? desc('Python')
          : null
    );
    getLoaded.mockReturnValue(null);
  });

  it('returns an empty map on first render (monochrome first commit)', () => {
    // Never resolves: this test only asserts the synchronous first-render value,
    // so we avoid a post-test setState (and its act() warning).
    load.mockImplementation(() => new Promise<never>(() => {}));
    const { result } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts'] },
    });
    expect(result.current.size).toBe(0);
  });

  it('publishes support after load resolves, keyed by filename', async () => {
    const ts = fakeSupport('TypeScript');
    load.mockResolvedValue(ts);
    const { result } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts', 'b.tsx'] },
    });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('a.ts')).toBe(ts);
    expect(result.current.get('b.tsx')).toBe(ts);
  });

  it('requests each distinct language once even with many files', async () => {
    load.mockResolvedValue(fakeSupport('TypeScript'));
    renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts', 'b.ts', 'c.tsx', 'd.ts'] },
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('uses the warm sync path without calling loadLanguageSupport', async () => {
    const ts = fakeSupport('TypeScript');
    getLoaded.mockReturnValue(ts);
    const { result } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts'] },
    });
    await waitFor(() => expect(result.current.get('a.ts')).toBe(ts));
    expect(load).not.toHaveBeenCalled();
  });

  it('retains resolved support while a newly visible language is pending', async () => {
    const ts = fakeSupport('TypeScript');
    const python = fakeSupport('Python');
    let resolvePython: (support: LanguageSupport) => void = () => {};
    load.mockImplementation((filename: string) =>
      filename.endsWith('.py')
        ? new Promise((resolve) => {
            resolvePython = resolve;
          })
        : Promise.resolve(ts)
    );
    const { result, rerender } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts'] },
    });
    await waitFor(() => expect(result.current.get('a.ts')).toBe(ts));

    rerender({ f: ['a.ts', 'a.py'] });

    expect(result.current.get('a.ts')).toBe(ts);
    expect(result.current.get('a.py')).toBeUndefined();
    await act(async () => {
      resolvePython(python);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.get('a.py')).toBe(python));
  });

  it('publishes each language independently as its load resolves', async () => {
    const ts = fakeSupport('TypeScript');
    const python = fakeSupport('Python');
    let resolveTypeScript: (support: LanguageSupport) => void = () => {};
    let resolvePython: (support: LanguageSupport) => void = () => {};
    load.mockImplementation(
      (filename: string) =>
        new Promise((resolve) => {
          if (filename.endsWith('.py')) resolvePython = resolve;
          else resolveTypeScript = resolve;
        })
    );
    const { result } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts', 'a.py'] },
    });

    await act(async () => {
      resolveTypeScript(ts);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.get('a.ts')).toBe(ts));
    expect(result.current.get('a.py')).toBeUndefined();
    await act(async () => {
      resolvePython(python);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.get('a.py')).toBe(python));
  });

  it('omits unsupported and failed languages, and can retry on a later input', async () => {
    // The real loadLanguageSupport CATCHES failures and resolves null (it never
    // rejects — see languages.ts:82), so the failure case is a null resolution.
    load.mockResolvedValueOnce(null).mockResolvedValue(fakeSupport('TypeScript'));
    const { result, rerender } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts', 'readme.unknown'] },
    });
    // 'readme.unknown' has no language description -> skipped: only TS requested.
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(result.current.get('a.ts')).toBeUndefined();
    // New input array identity -> new generation retries the failed language.
    rerender({ f: ['a.ts'] });
    await waitFor(() => expect(result.current.get('a.ts')).toBeTruthy());
  });

  it('ignores a stale load that resolves after the input changed', async () => {
    let resolveFirst: (s: LanguageSupport) => void = () => {};
    load
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res;
          })
      )
      .mockResolvedValue(fakeSupport('Python'));
    const { result, rerender } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts'] },
    });
    rerender({ f: ['a.py'] }); // supersede before the first load resolves
    await waitFor(() => expect(result.current.get('a.py')).toBeTruthy());
    // Resolve the superseded TS load INSIDE an awaited async act so the promise
    // continuation actually flushes; the stale generation must be ignored.
    await act(async () => {
      resolveFirst(fakeSupport('TypeScript'));
      await Promise.resolve();
    });
    expect(result.current.get('a.ts')).toBeUndefined();
  });

  it('does not publish (schedule a transition) after unmount', async () => {
    // React 19 SILENTLY ignores post-unmount setState — so a console.error probe
    // would false-pass. Instead assert the hook's active-guard short-circuits the
    // resolution BEFORE it reaches startTransition. Under ts-jest's CommonJS
    // interop the hook's `import { startTransition }` resolves through the react
    // module object, so spying on it observes the hook's own call.
    let resolveLoad: (s: LanguageSupport) => void = () => {};
    load.mockImplementation(
      () =>
        new Promise((res) => {
          resolveLoad = res;
        })
    );
    const transitionSpy = jest.spyOn(React, 'startTransition');
    const { unmount } = renderHook(({ f }) => useSearchSyntaxSupports(f), {
      initialProps: { f: ['a.ts'] },
    });
    transitionSpy.mockClear(); // ignore any transition from the mounted lifecycle
    unmount();
    await act(async () => {
      resolveLoad(fakeSupport('TypeScript'));
      await Promise.resolve();
    });
    expect(transitionSpy).not.toHaveBeenCalled();
    transitionSpy.mockRestore();
  });
});
