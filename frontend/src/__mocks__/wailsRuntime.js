// Mock for the wails runtime adapter (src/wails/runtime.ts), which tests reach
// through the '(../)+wails/runtime' moduleNameMapper entry and routinely replace
// wholesale with jest.mock(..., factory). It must stay a SEPARATE module from
// wailsV3Runtime.js: sharing one file would give both specifiers the same jest
// module id, so a test's adapter factory would also blank out @wailsio/runtime
// for the generated bindings. Neither file may require the other, so this
// CancellablePromise is a deliberate duplicate of the one over there.
class CancellablePromise extends Promise {
  cancel() {
    return CancellablePromise.resolve();
  }
  cancelOn() {
    return this;
  }
}

// Exactly the adapter's exports, no more: a mock that offers v2 names the
// adapter never re-exported (EventsEmit, the Log* family, the EventsOff
// variants) lets a test pass against an API production does not have.
module.exports = {
  CancellablePromise,
  EventsOn: jest.fn(() => jest.fn()),
  WindowSetTitle: jest.fn(),
  BrowserOpenURL: jest.fn(),
  ClipboardSetText: jest.fn(() => Promise.resolve()),
};
