import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GolemConfigWorkspace } from '../../../components/GolemConfig/GolemConfigWorkspace';

jest.mock('../../../wails/bindings', () => ({
  ReloadGolemSettings: jest.fn(),
  PrepareGolemDestinationGrants: jest.fn(),
  ListGolemProfiles: jest.fn(),
  LoadGolemProfile: jest.fn(),
}));
import {
  ListGolemProfiles,
  LoadGolemProfile,
  PrepareGolemDestinationGrants,
  ReloadGolemSettings,
} from '../../../wails/bindings';

const testRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const model = (over: Record<string, unknown> = {}) => ({
  role: 'agent-m',
  modelName: 'qwen3-coder-30b',
  provider: 'llama-swap',
  type: 'dense',
  effectiveCapabilities: ['chat', 'stream', 'tool_call'],
  capabilityFacts: {
    caps: ['chat', 'stream', 'tool_call'],
    knownCaps: ['chat', 'generate', 'stream', 'embed', 'tool_call', 'thinking', 'insert'],
  },
  exposedCapabilities: ['chat', 'stream', 'tool_call'],
  thinkMode: 'auto',
  routedUseCases: ['agent'],
  hasThinkTags: false,
  hasSlots: false,
  removable: false,
  ...over,
});

const readyProjection = {
  state: 'ready',
  sourceOrigin: 'user_config',
  revision: testRevision,
  readOnly: false,
  editable: true,
  routes: [{ useCase: 'agent', role: 'agent-m' }],
  models: [model()],
  providers: [
    {
      name: 'llama-swap',
      endpoint: 'http://127.0.0.1:9292/v1',
      classification: 'local',
      apiFormat: 'openai-compat',
      credentialState: 'none',
    },
  ],
  diagnostics: [],
};

const emptyProjection = (state: string, sourceOrigin: string) => ({
  state,
  sourceOrigin,
  readOnly: false,
  editable: false,
  routes: [],
  models: [],
  providers: [],
  diagnostics: [],
});

const resolve = (projection: unknown, busy = false) =>
  (ReloadGolemSettings as jest.Mock).mockResolvedValue({ busy, projection });

// jsdom resolves no CSS from a module, so the one honest guard for a purely
// visual rule is the stylesheet itself. Keith rejected the left-only accent bar
// on rounded surfaces; severity now reads through a full border, and nothing
// should quietly reintroduce a one-sided rule.
describe('GolemConfig stylesheet', () => {
  const css = () =>
    fs.readFileSync(
      path.resolve(__dirname, '../../../components/GolemConfig/GolemConfig.module.css'),
      'utf8'
    );

  it('carries no left-only accent bars', () => {
    // The 3px bar down one rounded edge is the treatment Keith rejected. A 1px
    // hairline dividing two halves of a grid is structure, not an accent, so
    // the guard names the signature rather than banning the property.
    expect(css()).not.toMatch(/border-left(-color)?:\s*(3px|var\(--(accent|status|palette))/);
  });

  // Each tone owns the whole outline in a full-strength semantic colour. A
  // dimmed or partial treatment is what made three intents look alike.
  it.each([
    ['info', '--accent'],
    ['caution', '--status-warning'],
    ['blocking', '--palette-red'],
  ])('gives the %s tone the %s outline on every notice surface', (tone, token) => {
    const rule = css().match(new RegExp(`\\[data-tone='${tone}'\\][^}]*}`, 's'));
    expect(rule?.[0]).toContain(`border-color: var(${token})`);
    for (const surface of ['notice', 'disclosure', 'panel', 'rowDiagnostic', 'diagnostic']) {
      expect(css()).toContain(`.${surface}[data-tone='${tone}']`);
    }
  });

  // The old boolean is gone: a non-blocking diagnostic is a caution, not a
  // neutral aside, so every surface reads through the one tone vocabulary.
  it('no longer styles anything through the blocking boolean', () => {
    expect(css()).not.toContain('data-blocking');
  });

  it('upgrades records to subgrid tables only where subgrid exists, squeezing only the long columns', () => {
    const text = css();
    // [A7] The BASE is the record form: the header row is hidden VISUALLY (never removed
    // from the tree) and the inline labels show.
    expect(text.match(/^\.headRow \{[^}]*\}/ms)?.[0]).toMatch(/clip: rect\(0, 0, 0, 0\)/);
    expect(text.match(/^\.headRow \{[^}]*\}/ms)?.[0]).not.toMatch(/display: none/);
    expect(text.match(/^\.recordLabel \{[^}]*\}/ms)?.[0]).toMatch(/display: inline/);
    // The table form lives inside @supports (subgrid) AND the >= 600 container query.
    const supports =
      text.match(/@supports \(grid-template-columns: subgrid\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(supports).toMatch(/@container golem-config \(min-width: 600px\)/);
    // [A3] Identifier columns are bounded and wrap; only short enumerated columns are max-content.
    // [X4] The identifier cap is itself container-relative, and the fluid column keeps a
    // floor, so one 256-byte identifier can never squeeze its neighbour to nothing.
    expect(supports).toMatch(
      /\.providerTable \{[^}]*grid-template-columns: fit-content\(min\(200px, 22cqw\)\) minmax\(8ch, 1fr\) max-content max-content max-content/s
    );
    expect(supports).toMatch(
      /\.routeTable \{[^}]*grid-template-columns: fit-content\(min\(200px, 22cqw\)\) fit-content\(min\(200px, 22cqw\)\) minmax\(8ch, 1fr\) max-content max-content max-content/s
    );
    expect(supports).toMatch(
      /\.definedTable \{[^}]*grid-template-columns: fit-content\(min\(200px, 22cqw\)\) fit-content\(min\(200px, 22cqw\)\) minmax\(8ch, 1fr\) max-content/s
    );
    // [X4] The last resort is a scrolling CARD, never a scrolling page.
    expect(text).toMatch(/\.cardBody \{[^}]*overflow-x: auto/s);
    expect(supports).toMatch(/\.row,\s*\.headRow \{[^}]*grid-template-columns: subgrid/s);
    expect(supports).toMatch(/\.headRow \{[^}]*position: static/s);
    expect(supports).toMatch(/\.recordLabel \{[^}]*display: none/s);
    expect(text).not.toMatch(/\.(identifier|useCase|providerCell) \{[^}]*white-space: nowrap/s);
    // Editing group outline and the three tones.
    expect(text).toMatch(/\.editGroup \{[^}]*border: 1px solid var\(--accent\)/s);
    expect(text).toMatch(/\.editGroup \{[^}]*box-shadow: 0 0 0 3px rgba\(18, 181, 205, 0\.12\)/s);
    expect(text).toMatch(/\.cardHead \{[^}]*background-color: var\(--surface-elevated\)/s);
    expect(supports).toMatch(/\.headRow \{[^}]*background-color: var\(--surface-frame\)/s);
    expect(text).toMatch(/\.table > \.row:nth-child\(even\) \{[^}]*rgba\(2, 6, 23, 0\.32\)/s);
    // The Type cell stacks its apiFormat under the classification at EVERY width.
    expect(text.match(/^\.metaCell \{[^}]*\}/ms)?.[0]).toMatch(/flex-direction: column/);
    // The Add form renders outside the table, so it carries its own accent boundary.
    expect(text).toMatch(/\.cardBody > \.editor \{[^}]*border: 1px solid var\(--accent\)/s);
  });

  it('never relies on subgrid outside the @supports block', () => {
    // [A7][C19] A Safari 15 WebKit gets the record form at every width — usable, aligned by
    // construction — instead of independently sized rows pretending to be a table.
    const text = css();
    const outside = text.replace(/@supports \(grid-template-columns: subgrid\) \{[\s\S]*?\n\}/, '');
    expect(outside).not.toMatch(/subgrid/);
    expect(text).not.toMatch(/@supports not/);
  });

  // One control box for every single-line field, on the BASE class: a
  // min-height let a select's intrinsic metrics beat the input beside it (the
  // band provider select, then the API-format select), so the height is
  // explicit and the select draws its own caret. A per-row copy of the rule
  // is the drift this pins against.
  it('normalizes selects and inputs to one explicit control box', () => {
    const input = css().match(/^\.input \{[^}]*\}/m)?.[0] ?? '';
    expect(input).toMatch(/height: 30px/);
    expect(input).not.toMatch(/min-height/);

    const select = css().match(/^select\.input \{[^}]*\}/m)?.[0] ?? '';
    expect(select).toMatch(/appearance: none/);
  });

  it('the configuration menu panel can never outgrow its pane', () => {
    const text = css();
    const panel = text.match(/\.menuPanel\s*\{[^}]*\}/)?.[0] ?? '';
    // Container-relative clamp against `.root`'s inline size (the trigger,
    // not the masthead, is the positioned ancestor now, so a percentage can
    // no longer reach the pane width directly) and no fixed floor: a 200px
    // pane, at 100% or 200% zoom, always fits the panel, because the cqw
    // term shrinks along with the PANE — unlike vw, which tracks the OS
    // viewport and can be far larger than a docked, resizable pane.
    expect(panel).toContain('max-width: min(320px, calc(100cqw - 32px))');
    expect(panel).not.toMatch(/\bvw\b/);
    expect(panel).not.toMatch(/min-width:\s*[1-9]/);
  });

  it('lays the masthead out mobile-first by container width only, never viewport', () => {
    const text = css();
    expect(text).not.toMatch(/\d(vw|vh)\b/);
    // [A7] The BASE is the stacked form: full-width picker, wrapping actions, full-row check button.
    expect(text.match(/^\.picker \{[^}]*\}/ms)?.[0]).toMatch(/flex: 1 1 100%/);
    expect(text.match(/^\.actions > \.checkDestinations \{[^}]*\}/ms)?.[0]).toMatch(
      /flex: 1 1 100%/
    );
    // The two-row form fixes the picker at 280px and puts the actions on their own row…
    const twoRow =
      text.match(/@container golem-config \(min-width: 600px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(twoRow).toMatch(/\.picker \{[^}]*flex: 0 0 280px/s);
    expect(twoRow).toMatch(/\.actions \{[^}]*flex: 1 1 100%/s);
    expect(twoRow).toMatch(/\.actions > \.checkDestinations \{[^}]*flex: none/s);
    // …and the one-row form stops the control row wrapping at all.
    const oneRow =
      text.match(/@container golem-config \(min-width: 800px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(oneRow).toMatch(/\.controls \{[^}]*flex-wrap: nowrap/s);
    expect(oneRow).toMatch(/\.actions \{[^}]*flex: none/s);
    // [C18] A container query can never style its own container: no `.root` rule may live inside one.
    for (const block of text.match(/@container golem-config[^{]*\{[\s\S]*?\n\}/g) ?? []) {
      expect(block).not.toMatch(/\n\s*\.root \{/);
    }
  });

  // [X8] Equal-specificity modules cascade by ORDER: a base rule declared after an
  // upgrade silently cancels it. Every mobile-first base must precede the queries.
  it('declares the missing-state base before any container upgrade can build on it', () => {
    const text = css();
    expect(text.indexOf('\n.emptyState {')).toBeGreaterThan(-1);
    // The at-rule itself, anchored to column 0 — the prose above the base rule names
    // the query too, and a bare substring search would find that comment first.
    expect(text.indexOf('\n.emptyState {')).toBeLessThan(text.indexOf('\n@container golem-config'));
  });

  // [X9] Same cascade rule for the button modifiers: `.button` would otherwise
  // re-assert its padding, border and colour over anything declared earlier.
  it('declares every button modifier after the base button rules', () => {
    const text = css();
    const base = text.indexOf('\n.button {');
    for (const modifier of ['.closeIcon', '.warn', '.quiet', '.small', '.primary', '.danger']) {
      expect(text.indexOf(`\n${modifier} {`)).toBeGreaterThan(base);
    }
  });

  // [K7] Hover and the keyboard cursor shared one background, so the pointer
  // sweeping the list looked exactly like the row Enter would choose.
  it('tells the keyboard-active option apart from a hovered one', () => {
    const text = css();
    const active = text.match(/\.pickerOption\[data-active\] \{[^}]*\}/)?.[0] ?? '';
    expect(active).toContain('outline: 2px solid var(--focus-ring)');
    expect(active).toContain('outline-offset: -2px');
    // The shared hover background stays: the ring ADDS a signal, it does not replace one.
    expect(text).toContain('.pickerOption[data-active],\n.pickerOption:hover {');
  });

  // [W1] `.button`'s own padding and line-height beat symmetric padding on a
  // 28px box, so the cross drew off-centre. The flex centre is the guard.
  it('centres the close glyph instead of trusting padding', () => {
    const rule = css().match(/^\.closeIcon \{[^}]*\}/m)?.[0] ?? '';
    expect(rule).toContain('justify-content: center');
    expect(rule).toContain('align-items: center');
    expect(rule).toContain('padding: 0');
  });

  // [W2] reset.css zeroes every margin, which cancels the UA stylesheet's
  // `dialog { margin: auto }`: the modal drew at the window's top-left, under
  // the frameless titlebar and across the macOS traffic lights.
  it('centres the confirmation dialog clear of the frameless titlebar', () => {
    const rule = css().match(/^\.dialog \{[^}]*\}/m)?.[0] ?? '';
    expect(rule).toContain('margin: auto');
    expect(rule).toContain('inset: 40px 0 0');
    // Pinned edges with an auto size would stretch the box to fill them.
    expect(rule).toContain('height: fit-content');
    expect(rule).toContain('max-height: calc(100% - 80px)');
  });

  it('the picker popover clamps to the pane like the save popover', () => {
    const list = css().match(/\.pickerList\s*\{[^}]*\}/)?.[0] ?? '';
    expect(list).toContain('width: min(320px, calc(100cqw - 32px))');
  });
});

describe('GolemConfigWorkspace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolve(readyProjection);
    (ListGolemProfiles as jest.Mock).mockResolvedValue({ status: 'loaded', profiles: [] });
  });

  it('loads once on mount and renders the masthead verdict, source, and revision', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // Queried by test id, not by the `banner` role: the real surface renders
    // inside the shell's <main>, where a <header> is a section header.
    const masthead = await screen.findByTestId('golem-config-masthead');
    expect(within(masthead).getByRole('heading', { name: 'Golem Configuration' })).toBeVisible();
    expect(within(masthead).getByText('Ready')).toBeInTheDocument();
    expect(within(masthead).getByText('User configuration directory')).toBeInTheDocument();
    expect(within(masthead).getByText(`rev ${testRevision.slice(0, 12)}`)).toHaveAttribute(
      'title',
      testRevision
    );
    expect(ReloadGolemSettings).toHaveBeenCalledTimes(1);
  });

  /**
   * Spec I15: the approval action is PERMANENT. Nothing probes for missing
   * destinations on mount and no runtime event tells this surface when the set
   * changes, so the action cannot appear conditionally — it is always there,
   * and every click asks afresh.
   */
  it('always offers the destination approval action', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // Before the first load lands there is nothing to approve against yet, so
    // the action is present and waiting rather than absent.
    const action = screen.getByRole('button', { name: 'Check destinations…' });
    expect(action).toBeInTheDocument();
    expect(action).toBeDisabled();

    await screen.findByTestId('provider-row-llama-swap');
    expect(screen.getByRole('button', { name: 'Check destinations…' })).toBeEnabled();
    // A permanent action asks nothing on its own.
    expect(PrepareGolemDestinationGrants).not.toHaveBeenCalled();
  });

  it('keeps the approval action on a configuration that could not load', async () => {
    (ReloadGolemSettings as jest.Mock).mockRejectedValue('no service');
    render(<GolemConfigWorkspace onClose={() => {}} />);

    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('button', { name: 'Check destinations…' })).toBeInTheDocument();
  });

  it('explains the destination check before the click', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const action = await screen.findByRole('button', { name: 'Check destinations…' });
    expect(action).toHaveAttribute(
      'title',
      'Lists remote destinations your agent route can reach that are not yet approved. Approving writes only the consent store; your configuration is unchanged.'
    );
  });

  it('moves focus to the heading when the tab opens', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByRole('heading', { name: 'Golem Configuration' });
    expect(screen.getByRole('heading', { name: 'Golem Configuration' })).toHaveFocus();
  });

  it('renders a provider strip with endpoint, classification, format, and key state', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('provider-row-llama-swap');
    expect(within(row).getByText('llama-swap')).toBeInTheDocument();
    expect(within(row).getByText('http://127.0.0.1:9292/v1')).toBeInTheDocument();
    expect(within(row).getByText('Local')).toBeInTheDocument();
    expect(within(row).getByText('openai-compat')).toBeInTheDocument();
    expect(within(row).getByText('No key')).toBeInTheDocument();
  });

  it('renders a routing strip joining the use case to its model and provider', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('route-row-agent');
    expect(within(row).getByText('agent')).toBeInTheDocument();
    expect(within(row).getByText('llama-swap')).toBeInTheDocument();
    expect(within(row).getByText('qwen3-coder-30b')).toBeInTheDocument();
    expect(within(row).getByText('auto')).toBeInTheDocument();
    expect(within(row).getByText('Ready')).toBeInTheDocument();
  });

  it('renders each card as a table whose header names the columns once', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const providerRow = await screen.findByTestId('provider-row-llama-swap');
    const providers = screen.getByRole('table', { name: 'Providers' });
    expect(within(providers).getAllByRole('row').slice(1)).toEqual([providerRow]);
    expect(
      within(providers)
        .getAllByRole('columnheader')
        .map((h) => h.textContent)
    ).toEqual(['Provider', 'Endpoint', 'Type', 'API key', 'Actions']);
    expect(within(providerRow).getAllByRole('cell')).toHaveLength(5);

    const routeRow = screen.getByTestId('route-row-agent');
    const routes = screen.getByRole('table', { name: 'Model routing' });
    // §4.1: the rows are Firn's known use cases plus the authored ones, so a
    // known use case with no route is an offer rather than an omission.
    expect(within(routes).getAllByRole('row').slice(1)).toEqual([
      routeRow,
      screen.getByTestId('route-row-chat'),
      screen.getByTestId('route-row-embedding'),
      screen.getByTestId('route-row-planning'),
    ]);
    expect(
      within(routes)
        .getAllByRole('columnheader')
        .map((h) => h.textContent)
    ).toEqual(['Use case', 'Provider', 'Model', 'Think', 'Status', 'Actions']);
    // The record-form inline labels are visual echoes only — never a second announcement.
    for (const label of within(routeRow).queryAllByText(/^(Think|Type|API key)$/)) {
      expect(label).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('wraps an open route row and its editor in one rowgroup', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await userEvent.click(
      within(await screen.findByTestId('route-row-agent')).getByRole('button', { name: /^Edit/ })
    );
    // [C6] Re-query after expansion: the row is re-rendered inside a NEW wrapper (distinct React
    // key), so a reference captured before the click must not be reused — and the group must be a
    // different node from the row, or "contains" would be self-containment.
    const row = screen.getByTestId('route-row-agent');
    const group = screen.getByRole('rowgroup');
    expect(group).not.toBe(row);
    expect(row).toHaveAttribute('role', 'row');
    expect(group).toContainElement(row);
    const editor = screen.getByRole('group', { name: 'Route agent' });
    expect(group).toContainElement(editor);
    expect(editor.closest('[role="cell"]')).toHaveAttribute('aria-colspan', '6');
    expect(within(row).getByText('editing')).toBeInTheDocument();
  });

  it('Cancel returns focus to the row Edit button in both cards', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const providerEdit = within(await screen.findByTestId('provider-row-llama-swap')).getByRole(
      'button',
      { name: /^Edit/ }
    );
    await userEvent.click(providerEdit);
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Edit provider llama-swap' })).getByRole('button', {
        name: 'Cancel',
      })
    );
    // [C22] Re-query: the row remounted when its rowgroup wrapper went away.
    expect(
      within(screen.getByTestId('provider-row-llama-swap')).getByRole('button', { name: /^Edit/ })
    ).toHaveFocus();
    await userEvent.click(
      within(screen.getByTestId('route-row-agent')).getByRole('button', { name: /^Edit/ })
    );
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Route agent' })).getByRole('button', {
        name: 'Cancel',
      })
    );
    expect(
      within(screen.getByTestId('route-row-agent')).getByRole('button', { name: /^Edit/ })
    ).toHaveFocus();
  });

  it('keeps meaningful placeholder copy off the disabled-contrast class', async () => {
    resolve({
      ...readyProjection,
      routes: [
        { useCase: 'agent', role: 'agent-m' },
        { useCase: 'embedding', role: 'ghost' },
      ],
      providers: [
        {
          name: 'llama-swap',
          endpoint: '',
          classification: 'unknown',
          apiFormat: 'openai-compat',
          credentialState: 'none',
        },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // `.absent` is --text-disabled (2.50:1 on the strip) and is reserved for the
    // bare em-dash. Both of these are the reader's only lead on what is wrong,
    // so they must sit on a class that clears the §4.7 floor.
    const providerRow = await screen.findByTestId('provider-row-llama-swap');
    expect(within(providerRow).getByText('no endpoint')).toHaveClass('endpointCell');

    const routeRow = screen.getByTestId('route-row-embedding');
    expect(within(routeRow).getByText('role ghost has no model')).toHaveClass('modelCell');
  });

  it('the blocking banner subject jumps to the route and focuses its Model field', async () => {
    resolve({
      ...readyProjection,
      diagnostics: [
        {
          code: 'agent_capabilities_insufficient',
          subjectKind: 'model',
          subjectName: readyProjection.models[0].role,
          blocking: true,
        },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const link = await screen.findByRole('button', {
      name: `model ${readyProjection.models[0].role}`,
    });
    await userEvent.click(link);
    expect(await screen.findByLabelText('Filter models')).toHaveFocus();
  });

  it('a diagnostic jump is inert while the surface cannot be edited', async () => {
    resolve({
      ...readyProjection,
      // The contract forbids a read-only `ready` projection (golem.ts:1030); `limited`
      // with `readOnly` IS the shipped loaded-but-unwritable state.
      state: 'limited',
      readOnly: true,
      editable: false,
      diagnostics: [
        {
          code: 'agent_capabilities_insufficient',
          subjectKind: 'model',
          subjectName: readyProjection.models[0].role,
          blocking: true,
        },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const link = await screen.findByRole('button', {
      name: `model ${readyProjection.models[0].role}`,
    });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute(
      'title',
      'Editing is unavailable while this configuration cannot be changed.'
    );
    await userEvent.click(link);
    expect(screen.queryByRole('group', { name: /^Route / })).toBeNull();
  });

  it('marks a route with no resolvable model as No model', async () => {
    resolve({
      ...readyProjection,
      routes: [
        { useCase: 'agent', role: 'agent-m' },
        { useCase: 'embedding', role: 'ghost' },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('route-row-embedding');
    expect(within(row).getByText('No model')).toBeInTheDocument();
  });

  it('marks a route whose exposed capabilities miss the use-case floor as Incompatible', async () => {
    resolve({
      ...readyProjection,
      models: [model({ exposedCapabilities: ['chat', 'stream'] })],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('route-row-agent');
    expect(within(row).getByText('Incompatible')).toBeInTheDocument();
  });

  it('lists defined models that no use case routes to', async () => {
    resolve({
      ...readyProjection,
      models: [
        model(),
        model({
          role: 'spare',
          modelName: 'nomic-embed',
          routedUseCases: [],
          exposedCapabilities: ['embed'],
          thinkMode: '',
        }),
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    const row = await screen.findByTestId('defined-model-row-spare');
    expect(within(row).getByText('nomic-embed')).toBeInTheDocument();
    expect(screen.getByText('Defined models')).toBeInTheDocument();
    expect(screen.queryByTestId('defined-model-row-agent-m')).not.toBeInTheDocument();
  });

  it('renders the bootstrap empty state while Missing instead of two empty cards', async () => {
    resolve({
      ...emptyProjection('missing', 'none'),
      diagnostics: [{ code: 'config_missing', subjectKind: '', subjectName: '', blocking: true }],
    });
    (ListGolemProfiles as jest.Mock).mockResolvedValue({
      status: 'loaded',
      profiles: [{ id: 'curated/local', curated: true, description: 'Vetted local lineup' }],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const empty = await screen.findByRole('region', { name: 'No applied configuration' });
    expect(
      within(empty).getByRole('button', { name: 'Start from curated local' })
    ).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: 'Start blank' })).toBeInTheDocument();
    expect(within(empty).getByText(/Vetted local lineup/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Providers' })).toBeNull();
    expect(screen.getByText('No models.json was found at any discovery location.')).toBeVisible();
  });

  it('bootstraps a blank draft from the empty state and focuses the Source trigger', async () => {
    resolve(emptyProjection('missing', 'none'));
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const empty = await screen.findByRole('region', { name: 'No applied configuration' });
    await userEvent.click(within(empty).getByRole('button', { name: 'Start blank' }));
    // A blank draft starts with no staged provider, so the card shows its own
    // "Add a provider first" placeholder rather than a populated table — the
    // empty STATE (the bootstrap section) is what must be gone, not the rows.
    expect(await screen.findByRole('region', { name: 'Providers' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'No applied configuration' })).toBeNull();
    // The focus move lands in the same commit as the empty state unmounting,
    // but that commit settles asynchronously relative to the click's promise
    // chain — waitFor polls for it instead of racing a synchronous check.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Source' })).toHaveFocus());
  });

  it('bootstraps from a curated profile in the empty state and focuses the Source trigger', async () => {
    resolve(emptyProjection('missing', 'none'));
    (ListGolemProfiles as jest.Mock).mockResolvedValue({
      status: 'loaded',
      profiles: [{ id: 'curated/local', curated: true, description: 'Vetted local lineup' }],
    });
    (LoadGolemProfile as jest.Mock).mockResolvedValue({
      status: 'loaded',
      profileId: 'curated/local',
      sourceRevision: testRevision,
      projection: {
        state: 'ready',
        readOnly: readyProjection.readOnly,
        editable: readyProjection.editable,
        routes: readyProjection.routes,
        models: readyProjection.models,
        providers: readyProjection.providers,
        diagnostics: readyProjection.diagnostics,
      },
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const empty = await screen.findByRole('region', { name: 'No applied configuration' });
    await userEvent.click(within(empty).getByRole('button', { name: 'Start from curated local' }));
    expect(await screen.findByRole('table', { name: 'Providers' })).toBeInTheDocument();
    // See the blank-draft test above: the commit that grants focus lands
    // asynchronously relative to the click's own promise chain.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Source' })).toHaveFocus());
  });

  it('names the reason the bootstrap Start buttons are disabled', async () => {
    // [K12][C2] A greyed-out Start button on a Missing configuration is the only
    // thing on screen; without a title it is a dead end. The ladder derives both
    // `disabled` and the title, so they cannot disagree.
    resolve(emptyProjection('missing', 'none'));
    (ListGolemProfiles as jest.Mock).mockResolvedValue({
      status: 'loaded',
      profiles: [{ id: 'curated/local', curated: true }],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const empty = await screen.findByRole('region', { name: 'No applied configuration' });
    const blank = within(empty).getByRole('button', { name: 'Start blank' });
    const curated = within(empty).getByRole('button', { name: 'Start from curated local' });
    expect(blank).toBeEnabled();
    expect(blank).not.toHaveAttribute('title');

    // A Refresh that has not answered yet owns the surface: `sourceLocked`.
    (ReloadGolemSettings as jest.Mock).mockImplementation(() => new Promise(() => {}));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    for (const button of [blank, curated]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Wait for the current operation to finish.');
    }
  });

  it('explains that editing is unavailable while Limited', async () => {
    resolve({
      ...readyProjection,
      state: 'limited',
      readOnly: true,
      diagnostics: [
        { code: 'duplicate_keys', subjectKind: 'provider', subjectName: 'hosted', blocking: false },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    expect(
      await screen.findByText(/Editing is unavailable while this configuration is Limited/)
    ).toBeInTheDocument();
    // Limited keeps the runtime entities visible.
    expect(screen.getByTestId('provider-row-llama-swap')).toBeInTheDocument();
    expect(
      screen.getByText(/Duplicate JSON keys make this configuration read-only\./)
    ).toBeInTheDocument();
    expect(screen.getByText('provider hosted')).toBeInTheDocument();
  });

  it('explains that editing is unavailable while Invalid and offers Refresh', async () => {
    resolve({
      ...emptyProjection('invalid', 'env'),
      diagnostics: [{ code: 'json_invalid', subjectKind: '', subjectName: '', blocking: true }],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    expect(
      await screen.findByText(/Editing is unavailable: this configuration could not be loaded/)
    ).toBeInTheDocument();
    expect(screen.getByText('The configuration file is not valid JSON.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('names the diagnostic subject by kind, never by name alone', async () => {
    resolve({
      ...readyProjection,
      // Transport order is blocking, then code, then subject kind and name.
      diagnostics: [
        {
          code: 'agent_capabilities_insufficient',
          subjectKind: 'use_case',
          subjectName: 'agent',
          blocking: true,
        },
        {
          code: 'provider_endpoint_unsupported',
          subjectKind: 'provider',
          subjectName: 'agent',
          blocking: true,
        },
      ],
    });
    render(<GolemConfigWorkspace onClose={() => {}} />);

    // The provider named `agent` has no row here, so its diagnostic stays on
    // the page and must carry its kind. The use case DOES have a row, and
    // §4.3 puts its diagnostic there — which is the same disambiguation by a
    // different route: neither reader ever sees a bare "agent".
    expect(await screen.findByText('provider agent')).toBeInTheDocument();
    // [C6] A row-owned diagnostic is a sibling `detailRow` inside the row's
    // rowgroup, not a child of the row: the rowgroup is the scope that owns both.
    expect(
      within(screen.getByTestId('route-row-agent').parentElement!).getByText(
        'The agent model must support chat, stream, and tool_call.'
      )
    ).toBeInTheDocument();
  });

  it('shows the busy notice for an explicit Refresh only', async () => {
    resolve(readyProjection, true);
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');
    expect(screen.queryByText(/Golem is busy/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Golem is busy/)).toHaveAttribute('role', 'status');
  });

  it('announces the state verdict in a live region', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');
    // #284 gave RoutingCard its own persistent `role="status"` region, so a
    // plain `getByRole('status')` is ambiguous here — matched by content
    // instead, the way the neighboring "Golem is busy" assertion above does.
    expect(
      screen.getByText('Configuration Ready. Source User configuration directory.')
    ).toHaveAttribute('role', 'status');
  });

  it('disables Refresh while a load is in flight', async () => {
    let settle!: (value: unknown) => void;
    (ReloadGolemSettings as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((r) => {
          settle = r;
        })
    );
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    expect(refresh).toBeDisabled();

    settle({ busy: false, projection: readyProjection });
    await screen.findByTestId('provider-row-llama-swap');
    expect(refresh).toBeEnabled();
  });

  it('closes an open editor while Refresh owns the surface', async () => {
    let settle!: (value: unknown) => void;
    (ReloadGolemSettings as jest.Mock)
      .mockResolvedValueOnce({ busy: false, projection: readyProjection })
      .mockImplementationOnce(
        () =>
          new Promise((resolveReload) => {
            settle = resolveReload;
          })
      );
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');
    await userEvent.click(screen.getByRole('button', { name: 'Edit provider llama-swap' }));
    expect(screen.getByLabelText('Endpoint')).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit provider llama-swap' })
    ).not.toBeInTheDocument();

    settle({
      busy: false,
      projection: { ...readyProjection, revision: 'f'.repeat(64) },
    });
    await screen.findByText(`rev ${'f'.repeat(12)}`);
    expect(screen.getByRole('button', { name: 'Edit provider llama-swap' })).toBeEnabled();
  });

  it('drops a response that lands after unmount', async () => {
    let settle!: (value: unknown) => void;
    (ReloadGolemSettings as jest.Mock).mockImplementation(
      () =>
        new Promise((r) => {
          settle = r;
        })
    );
    const { unmount } = render(<GolemConfigWorkspace onClose={() => {}} />);
    unmount();
    settle({ busy: false, projection: readyProjection });
    await waitFor(() => expect(ReloadGolemSettings).toHaveBeenCalledTimes(1));
  });

  it('offers a bounded message and Retry when the call is rejected', async () => {
    (ReloadGolemSettings as jest.Mock).mockRejectedValue('Golem is unavailable.');
    render(<GolemConfigWorkspace onClose={() => {}} />);

    expect(await screen.findByText('Golem is unavailable.')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });

    resolve(readyProjection);
    await userEvent.click(retry);
    expect(await screen.findByTestId('provider-row-llama-swap')).toBeInTheDocument();
  });

  it('turns a malformed payload into the fixed contract error', async () => {
    resolve({ state: 'weird' });
    render(<GolemConfigWorkspace onClose={() => {}} />);
    expect(await screen.findByText('Golem returned an unexpected response.')).toBeInTheDocument();
  });

  it('closes through the masthead Close action', async () => {
    const onClose = jest.fn();
    render(<GolemConfigWorkspace onClose={onClose} />);
    await screen.findByTestId('provider-row-llama-swap');

    await userEvent.click(screen.getByRole('button', { name: 'Close configuration' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts Close in the identity row as an icon button', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const masthead = await screen.findByTestId('golem-config-masthead');
    const close = within(masthead).getByRole('button', { name: 'Close configuration' });
    // First child of the masthead is the identity row; Close lives inside it, not among the actions.
    expect(masthead.firstElementChild).toContainElement(close);
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps Save as profile inside the actions row beside Refresh and Check destinations', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    const masthead = await screen.findByTestId('golem-config-masthead');
    const save = within(masthead).getByRole('button', { name: 'Save as profile…' });
    const refresh = within(masthead).getByRole('button', { name: 'Refresh' });
    const check = within(masthead).getByRole('button', { name: 'Check destinations…' });
    // All three share ONE actions container, and Save's wrapper is its first child so the
    // `.actions > .menuRoot` sizing rules can match.
    const actions = refresh.parentElement!;
    expect(actions).toContainElement(check);
    expect(actions).toContainElement(save);
    expect(actions.firstElementChild).toContainElement(save);
  });

  it('renders no draft bar until something is staged', async () => {
    render(<GolemConfigWorkspace onClose={() => {}} />);
    await screen.findByTestId('provider-row-llama-swap');

    // The editors themselves are Task 8's and are present; what a clean draft
    // must not show is the Apply/Discard surface over an empty change set.
    expect(screen.getByRole('button', { name: 'Edit provider llama-swap' })).toBeInTheDocument();
    expect(screen.queryByTestId('golem-config-draft')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
  });
});
