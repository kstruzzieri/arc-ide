// The `.js` extension is load-bearing: jest's adapter mapper is anchored as
// `wails/runtime$`, so this specifier slips past it and the extension-strip
// mapper resolves it back to the REAL src/wails/runtime.ts. Importing
// '../../wails/runtime' here would test the mock instead of the adapter.
import { EventsOn, WindowSetTitle, BrowserOpenURL, ClipboardSetText } from '../../wails/runtime.js';
import * as bindings from '../../wails/bindings';

// The adapter's '@wailsio/runtime' import is mapped to this file, so requiring
// it by path yields the same module instance — and by path rather than by
// package name so the "only the adapters know v3" guard stays green.
const v3 = require('../../__mocks__/wailsV3Runtime');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('wails adapter surface', () => {
  it('forwards window, browser and clipboard calls to the v3 runtime', async () => {
    WindowSetTitle('Firn — a.ts');
    expect(v3.Window.SetTitle).toHaveBeenCalledWith('Firn — a.ts');

    BrowserOpenURL('https://example.test/docs');
    expect(v3.Browser.OpenURL).toHaveBeenCalledWith('https://example.test/docs');

    const written = Promise.resolve();
    v3.Clipboard.SetText.mockReturnValueOnce(written);
    expect(ClipboardSetText('copied')).toBe(written);
    expect(v3.Clipboard.SetText).toHaveBeenCalledWith('copied');
    await written;
  });

  // Both void-returning adapters swallow a rejection the same way; the mocks
  // are never reassigned, so they can be captured here.
  it.each([
    ['WindowSetTitle', v3.Window.SetTitle, () => WindowSetTitle('Firn — a.ts')],
    ['BrowserOpenURL', v3.Browser.OpenURL, () => BrowserOpenURL('https://example.test/docs')],
  ])('logs and swallows a rejected %s promise instead of throwing', async (name, v3Fn, call) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error(`${name} failed`);
    v3Fn.mockReturnValueOnce(Promise.reject(err));

    expect(call).not.toThrow();
    await Promise.resolve(); // flush the microtask queue so the .catch runs

    expect(warn).toHaveBeenCalledWith(`${name} failed:`, err);
    warn.mockRestore();
  });

  it('registers an unwrapping listener and returns the v3 cleanup unchanged', () => {
    const cleanup = jest.fn();
    v3.Events.On.mockReturnValueOnce(cleanup);
    const cb = jest.fn();

    expect(EventsOn<{ termId: string }>('terminal:output', cb)).toBe(cleanup);
    expect(v3.Events.On).toHaveBeenCalledWith('terminal:output', expect.any(Function));

    // The registered listener must unwrap WailsEvent.data before calling back.
    v3.Events.On.mock.calls[0][1]({ data: { termId: 't1' } });
    expect(cb).toHaveBeenCalledWith({ termId: 't1' });
  });

  it('exposes bindings functions and model namespaces', () => {
    expect(typeof (bindings as Record<string, unknown>).OpenFolderDialog).toBe('function');
    expect(typeof (bindings as Record<string, unknown>).ToggleMaximize).toBe('function');
    expect(bindings.git).toBeDefined();
    expect(bindings.runprofile).toBeDefined();
  });
});
