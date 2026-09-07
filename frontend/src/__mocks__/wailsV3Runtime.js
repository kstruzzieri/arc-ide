// Mock for @wailsio/runtime, the v3 package. The generated bindings execute
// $Call/$Create at module load, so this must stay live for every suite —
// including the many that replace the adapter mock (wailsRuntime.js) with their
// own factory. Keeping the two mocks in separate files keeps their jest module
// ids distinct, so one cannot clobber the other, so neither file may require
// the other.

class CancellablePromise extends Promise {
  cancel() {
    return CancellablePromise.resolve();
  }
  cancelOn() {
    return this;
  }
}

const Events = {
  On: jest.fn(() => jest.fn()),
  Off: jest.fn(),
  Emit: jest.fn(),
};
const Window = { SetTitle: jest.fn(() => Promise.resolve()) };
const Browser = { OpenURL: jest.fn(() => Promise.resolve()) };
const Clipboard = { SetText: jest.fn(() => Promise.resolve()) };
const Call = {
  ByID: jest.fn(() => CancellablePromise.resolve()),
  ByName: jest.fn(() => CancellablePromise.resolve()),
};
// The creation functions below are a verbatim copy of the shipped
// node_modules/@wailsio/runtime/dist/create.js (@wailsio/runtime 3.0.0-beta.16,
// pinned in frontend/package.json). The generated bindings run them for real,
// so a test that parses a generated instance is only as faithful as this copy:
// any divergence from the shipped file is a bug, not a licence.
// src/__tests__/wails/runtimeMockFidelity.test.ts holds the two side by side.

function Any(source) {
  return source;
}

function ByteSlice(source) {
  return source == null ? '' : source;
}

function Array(element) {
  if (element === Any) {
    return (source) => (source === null ? [] : source);
  }
  return (source) => {
    if (source === null) {
      return [];
    }
    for (let i = 0; i < source.length; i++) {
      source[i] = element(source[i]);
    }
    return source;
  };
}

function Map(key, value) {
  if (value === Any) {
    return (source) => (source === null ? {} : source);
  }
  return (source) => {
    if (source === null) {
      return {};
    }
    for (const key in source) {
      source[key] = value(source[key]);
    }
    return source;
  };
}

function Nullable(element) {
  if (element === Any) {
    return Any;
  }
  return (source) => (source === null ? null : element(source));
}

function Struct(createField) {
  let allAny = true;
  for (const name in createField) {
    if (createField[name] !== Any) {
      allAny = false;
      break;
    }
  }
  if (allAny) {
    return Any;
  }
  return (source) => {
    for (const name in createField) {
      if (name in source) {
        source[name] = createField[name](source[name]);
      }
    }
    return source;
  };
}

function DateFromTime(source) {
  return new Date(source);
}

const Create = {
  Any,
  ByteSlice,
  Array,
  Map,
  Nullable,
  Struct,
  DateFromTime,
  Events: {},
};

module.exports = {
  Events,
  Window,
  Browser,
  Clipboard,
  Call,
  Create,
  CancellablePromise,
};
