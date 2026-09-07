// Binding-level regression for the #271 center-pair Layout fields
// (internal/workspace/types.go). Exercises the REAL generated conversion
// chain — State.createFrom -> Layout.createFrom -> $Create.Nullable — rather
// than constructing a workspace.Layout by hand, so a regeneration that
// changes how the pointer/optional fields are materialized is caught here,
// not discovered later in useWorkspacePersistence.
//
// The mocked binding alone cannot prove the contract: it only shows the
// wire bytes reach the adapter unchanged. This test additionally feeds every
// returned layout to `normalizeCenterLayout` (task A1), the single place a
// persisted, possibly-malformed record becomes a trusted preference set, so
// the two halves of the contract — "what the binding hands back" and "what
// the normalizer accepts" — are checked together.
import { LoadWorkspaceState } from '../../wails/bindings';
import {
  normalizeCenterLayout,
  DEFAULT_CENTER_LAYOUT,
  DEFAULT_GOLEM_WIDTH,
  type RawCenterLayout,
} from '../../utils/centerLayout';

// The adapter's '@wailsio/runtime' import is mapped to this file, so requiring
// it by path yields the same module instance used by the generated bindings.
const v3 = require('../../__mocks__/wailsV3Runtime');

beforeEach(() => {
  jest.clearAllMocks();
});

/** A minimal raw State payload — every field the generated State constructor
 * does not default is left out so it exercises the real defaulting path. */
const rawState = (layout: unknown) => ({ layout });

/** The mapping from the wire model to the normalizer's input shape —
 * panelSizes.golem carries the preferred width. Deliberately mirrors
 * `restoreWorkspaceState` in useWorkspacePersistence.ts field for field; it is
 * reproduced rather than imported because the real one is a local expression
 * inside that function, not an export. Keep the two in step. */
const toRawCenterLayout = (layout: {
  centerOrder?: unknown;
  golemCollapsed?: unknown;
  filesCollapsed?: unknown;
  panelSizes?: { golem?: unknown };
}): RawCenterLayout => ({
  centerOrder: layout.centerOrder,
  golemWidth: layout.panelSizes?.golem,
  golemCollapsed: layout.golemCollapsed,
  filesCollapsed: layout.filesCollapsed,
});

describe('LoadWorkspaceState real generated conversion (#271 Layout fields)', () => {
  it('passes through a null whole result unchanged', async () => {
    v3.Call.ByID.mockReturnValueOnce(v3.CancellablePromise.resolve(null));
    const state = await LoadWorkspaceState('/ws');
    expect(state).toBeNull();
  });

  it('a legacy layout with no #271 keys normalizes to the collapsed-Golem default', async () => {
    v3.Call.ByID.mockReturnValueOnce(
      v3.CancellablePromise.resolve(
        rawState({
          panelSizes: { left: 260, right: 280, bottom: 200 },
          leftCollapsed: false,
          rightCollapsed: false,
          bottomCollapsed: false,
        })
      )
    );
    const state = await LoadWorkspaceState('/ws');
    expect(state).not.toBeNull();
    expect(state!.layout.golemCollapsed).toBeUndefined();
    expect(state!.layout.centerOrder).toBeUndefined();
    expect(state!.layout.panelSizes.golem).toBeUndefined();

    const prefs = normalizeCenterLayout(toRawCenterLayout(state!.layout));
    expect(prefs).toEqual(DEFAULT_CENTER_LAYOUT);
  });

  it('an explicit null golemCollapsed is treated as absent, same as missing', async () => {
    v3.Call.ByID.mockReturnValueOnce(
      v3.CancellablePromise.resolve(
        rawState({
          panelSizes: { left: 260, right: 280, bottom: 200 },
          leftCollapsed: false,
          rightCollapsed: false,
          bottomCollapsed: false,
          golemCollapsed: null,
        })
      )
    );
    const state = await LoadWorkspaceState('/ws');
    expect(state!.layout.golemCollapsed).toBeNull();

    const prefs = normalizeCenterLayout(toRawCenterLayout(state!.layout));
    expect(prefs.isGolemPanelCollapsed).toBe(true);
  });

  it('a saved false golemCollapsed survives the round trip and the normalizer', async () => {
    v3.Call.ByID.mockReturnValueOnce(
      v3.CancellablePromise.resolve(
        rawState({
          panelSizes: { left: 260, right: 280, bottom: 200, golem: 512 },
          leftCollapsed: false,
          rightCollapsed: false,
          bottomCollapsed: false,
          centerOrder: 'golem-first',
          golemCollapsed: false,
          filesCollapsed: true,
        })
      )
    );
    const state = await LoadWorkspaceState('/ws');
    expect(state!.layout.golemCollapsed).toBe(false);
    expect(state!.layout.panelSizes.golem).toBe(512);

    const prefs = normalizeCenterLayout(toRawCenterLayout(state!.layout));
    expect(prefs).toEqual({
      centerOrder: 'golem-first',
      golemWidth: 512,
      isGolemPanelCollapsed: false,
      isFilesPanelCollapsed: true,
    });
  });

  it('a saved true golemCollapsed survives the round trip and the normalizer', async () => {
    v3.Call.ByID.mockReturnValueOnce(
      v3.CancellablePromise.resolve(
        rawState({
          panelSizes: { left: 260, right: 280, bottom: 200 },
          leftCollapsed: false,
          rightCollapsed: false,
          bottomCollapsed: false,
          golemCollapsed: true,
        })
      )
    );
    const state = await LoadWorkspaceState('/ws');
    expect(state!.layout.golemCollapsed).toBe(true);

    const prefs = normalizeCenterLayout(toRawCenterLayout(state!.layout));
    expect(prefs.isGolemPanelCollapsed).toBe(true);
  });

  it('a missing or zero-width Golem panel size normalizes to the default width', async () => {
    v3.Call.ByID.mockReturnValueOnce(
      v3.CancellablePromise.resolve(
        rawState({
          panelSizes: { left: 260, right: 280, bottom: 200 }, // no golem key
          leftCollapsed: false,
          rightCollapsed: false,
          bottomCollapsed: false,
        })
      )
    );
    const missing = await LoadWorkspaceState('/ws');
    expect(normalizeCenterLayout(toRawCenterLayout(missing!.layout)).golemWidth).toBe(
      DEFAULT_GOLEM_WIDTH
    );

    v3.Call.ByID.mockReturnValueOnce(
      v3.CancellablePromise.resolve(
        rawState({
          panelSizes: { left: 260, right: 280, bottom: 200, golem: 0 },
          leftCollapsed: false,
          rightCollapsed: false,
          bottomCollapsed: false,
        })
      )
    );
    const zero = await LoadWorkspaceState('/ws');
    expect(normalizeCenterLayout(toRawCenterLayout(zero!.layout)).golemWidth).toBe(
      DEFAULT_GOLEM_WIDTH
    );
  });

  // The generated conversion is type-blind: it moves wire bytes into fields
  // without validating them. A hand-edited or corrupted workspace file could
  // put a string where a number belongs, or a number where the "files-first"
  // | "golem-first" enum belongs. `normalizeCenterLayout` — not the binding —
  // is what must refuse to cast that into a trusted preference.
  it('rejects wrong-typed order/size/collapse data instead of casting it into trusted prefs', async () => {
    v3.Call.ByID.mockReturnValueOnce(
      v3.CancellablePromise.resolve(
        rawState({
          panelSizes: { left: 260, right: 280, bottom: 200, golem: '512' },
          leftCollapsed: false,
          rightCollapsed: false,
          bottomCollapsed: false,
          centerOrder: 123,
          golemCollapsed: 'true',
          filesCollapsed: 'yes',
        })
      )
    );
    const state = await LoadWorkspaceState('/ws');
    // The wire bytes land untouched — the binding does not validate.
    expect(state!.layout.panelSizes.golem).toBe('512');
    expect(state!.layout.centerOrder).toBe(123);
    expect(state!.layout.golemCollapsed).toBe('true');
    expect(state!.layout.filesCollapsed).toBe('yes');

    // The normalizer refuses every one of them and falls back to the default.
    const prefs = normalizeCenterLayout(toRawCenterLayout(state!.layout));
    expect(prefs).toEqual(DEFAULT_CENTER_LAYOUT);
  });
});
