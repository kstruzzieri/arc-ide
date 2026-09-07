import fs from 'fs';
import path from 'path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ModelBand,
  buildModelRows,
  type ModelBandProps,
} from '../../../components/GolemConfig/ModelBand';
import { CAPABILITY_NAMES, type CapabilityName, type ModelProjection } from '../../../types/golem';

const model = (over: Partial<ModelProjection> = {}): ModelProjection => ({
  role: 'chat-role',
  modelName: 'gpt-5-mini',
  provider: 'hosted',
  type: 'dense',
  effectiveCapabilities: ['chat', 'stream'],
  capabilityFacts: { caps: ['chat', 'stream'], knownCaps: [...CAPABILITY_NAMES] },
  exposedCapabilities: ['chat', 'stream'],
  thinkMode: '',
  routedUseCases: ['chat'],
  hasThinkTags: false,
  hasSlots: false,
  removable: false,
  ...over,
});

const agentModel = model({
  role: 'agent-role',
  modelName: 'gpt-5',
  effectiveCapabilities: ['chat', 'stream', 'tool_call'],
  capabilityFacts: { caps: ['chat', 'stream', 'tool_call'], knownCaps: [...CAPABILITY_NAMES] },
  exposedCapabilities: ['chat', 'stream', 'tool_call'],
});

const embedModel = model({
  role: 'embed-role',
  modelName: 'nomic-embed',
  effectiveCapabilities: ['embed'],
  capabilityFacts: { caps: ['embed'], knownCaps: [...CAPABILITY_NAMES] },
  exposedCapabilities: ['embed'],
});

function renderBand(over: Partial<ModelBandProps> = {}) {
  const onSelect = jest.fn();
  const onManual = jest.fn();
  const onProviderChange = jest.fn();
  const props: ModelBandProps = {
    id: 'route-editor-chat',
    useCase: 'chat',
    floor: ['chat', 'stream'] as readonly CapabilityName[],
    models: [model(), agentModel, embedModel],
    provider: 'hosted',
    providers: [
      {
        name: 'hosted',
        endpoint: 'https://api.example.com/v1',
        classification: 'remote',
        apiFormat: 'openai-compat',
        credentialState: 'available',
      },
    ],
    selected: null,
    manual: null,
    onProviderChange,
    onSelect,
    onManual,
    ...over,
  };
  const view = render(<ModelBand {...props} />);
  return { ...view, onSelect, onManual, onProviderChange, props };
}

// jsdom has no layout, so Element.scrollIntoView is undefined; the band calls
// it to keep the strip on screen. Stubbing it here is also what lets the
// scroll-mitigation test assert the call.
beforeEach(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

const cards = () => within(screen.getByRole('listbox', { name: /Models/ })).getAllByRole('option');
const cardNamed = (name: string) =>
  cards().find((card) => within(card).queryByText(name) !== null) as HTMLElement;

// ---------------------------------------------------------------------------
// Uniform compact cards, always. Treatment 1 removes in-cell expansion: the
// detail strip owns every fact beyond name and type, so a grid row can never
// inflate and the geometry never moves under the cursor.
// ---------------------------------------------------------------------------

describe('ModelBand compact cards', () => {
  it('shows name, type badge, params and context, and never capability chips', () => {
    renderBand({
      models: [model({ parameters: '30B-A3B', contextWindow: 262144 })],
      selected: model({ parameters: '30B-A3B', contextWindow: 262144 }),
    });
    const card = cardNamed('gpt-5-mini');

    expect(within(card).getByText('gpt-5-mini')).toBeVisible();
    expect(within(card).getByText('dense')).toBeVisible();
    // The metadata row after the badge, joined per the mockup — the context
    // human-scale, with the exact count on hover.
    const facts = within(card).getByText('30B-A3B · 256K ctx');
    expect(facts).toBeVisible();
    expect(facts).toHaveAttribute('title', '262144 tokens');
    // Even the assigned card stays compact.
    expect(within(card).queryByText('stream')).not.toBeInTheDocument();
  });

  it('formats the detail readout context exactly like the card', () => {
    renderBand({
      models: [model({ contextWindow: 262144 })],
      selected: model({ contextWindow: 262144 }),
    });
    const strip = screen.getByTestId('model-detail');

    const value = within(strip).getByText('256K');
    expect(value).toBeVisible();
    expect(value).toHaveAttribute('title', '262144 tokens');
    expect(within(strip).queryByText('262144')).not.toBeInTheDocument();
  });

  it('omits an absent fact entirely — no dash, no unknown, no stray separator', () => {
    // Context window undefined: the params segment stands alone.
    renderBand({ models: [model({ parameters: '30B-A3B' })] });
    const card = cardNamed('gpt-5-mini');

    expect(within(card).getByText('30B-A3B')).toBeVisible();
    expect(card.textContent).not.toMatch(/ctx|·|—|unknown/);
  });

  it('keeps the metadata row with no facts at all: the badge alone, no placeholder', () => {
    renderBand({ models: [model()] });
    const card = cardNamed('gpt-5-mini');

    expect(within(card).getByText('dense')).toBeVisible();
    // Name and badge only — nothing stands in for the absent facts.
    expect(card.textContent).toBe('gpt-5-minidense');
  });
});

// ---------------------------------------------------------------------------
// 2D keyboard navigation across the grid
// ---------------------------------------------------------------------------

describe('ModelBand keyboard navigation', () => {
  it('moves across the grid with the arrows and selects on Enter', async () => {
    const { onSelect } = renderBand();
    cards()[0].focus();

    // Cards are role-alpha, so agent-role (gpt-5) leads and owns the tab stop.
    expect(cardNamed('gpt-5')).toHaveAttribute('tabindex', '0');
    await userEvent.keyboard('{ArrowRight}');
    expect(cardNamed('gpt-5-mini')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(cardNamed('gpt-5')).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(agentModel);
  });

  it('steps by a row with ArrowDown and ArrowUp', async () => {
    const { onSelect } = renderBand();
    cards()[0].focus();

    // jsdom reports every offsetTop as 0, so the grid measures one column and a
    // row step is a single card. In a browser it is the real column count.
    await userEvent.keyboard('{ArrowDown}');
    expect(cardNamed('gpt-5-mini')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(cardNamed('gpt-5')).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(agentModel);
  });

  it('never walks past either end of the grid', async () => {
    renderBand();
    cards()[0].focus();

    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(cardNamed('gpt-5')).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    // Two eligible models here, so the last stop is the declare-free end.
    expect(cards().at(-1)).toHaveFocus();
  });

  it('never steals focus from the filter after a clamped step past the end', async () => {
    renderBand();
    cards()[0].focus();

    // A real move consumes the focus flag; the clamped step at the end must
    // not re-arm it — the stale flag used to fire on the filter's first
    // keystroke (which resets the active index) and yank focus onto the grid.
    await userEvent.keyboard('{ArrowRight}');
    expect(cardNamed('gpt-5-mini')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(cardNamed('gpt-5-mini')).toHaveFocus();

    const filter = screen.getByLabelText('Filter models');
    await userEvent.click(filter);
    await userEvent.type(filter, 'g');
    expect(filter).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// Slice D seam (types only — no inventory call today)
// ---------------------------------------------------------------------------

describe('buildModelRows', () => {
  it('scopes rows to the provider and marks every one authored today', () => {
    const rows = buildModelRows([model(), agentModel, model({ provider: 'other' })], 'hosted');

    // Role-alpha within the provider: the shared display order.
    expect(rows.map((row) => row.model.modelName)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(rows.every((row) => row.provenance === 'authored')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Locked semantics carried over from the combobox picker (§4.4)
// ---------------------------------------------------------------------------

describe('ModelBand floor filter', () => {
  it('shows only models meeting the floor and names the filter', () => {
    renderBand();

    expect(screen.getByText('filter: chat · stream')).toBeVisible();
    expect(screen.getByText(/every card below can serve chat/)).toBeVisible();
    expect(cards().map((card) => within(card).getByText(/gpt|nomic/).textContent)).toEqual([
      'gpt-5',
      'gpt-5-mini',
    ]);
  });

  it('names the empty filter when the use case has no Firn floor', () => {
    renderBand({ floor: [] });
    expect(screen.getByText('filter: none')).toBeVisible();
  });

  it('reveals the hidden models with a reason chip per failing capability', async () => {
    renderBand();
    const line = screen.getByRole('button', { name: /does not meet chat · stream/ });
    expect(line).toHaveTextContent('1 model');

    await userEvent.click(line);
    const blocked = cardNamed('nomic-embed');
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(within(blocked).getByText('✕ chat')).toBeVisible();
    expect(within(blocked).getByText('✕ stream')).toBeVisible();
    expect(within(blocked).getByText('not eligible for chat')).toBeVisible();

    // One hidden model: the toggle agrees in number — "it", not "them".
    await userEvent.click(screen.getByRole('button', { name: /hide it/ }));
    expect(cards().some((card) => within(card).queryByText('nomic-embed') !== null)).toBe(false);
    expect(screen.getByRole('button', { name: /show it/ })).toBeInTheDocument();
  });

  it('narrows the grid as the filter is typed', async () => {
    renderBand();
    await userEvent.type(screen.getByLabelText('Filter models'), 'mini');
    // One match, plus the declare card a partial name always pins.
    expect(within(cards()[0]).getByText('gpt-5-mini')).toBeVisible();
    expect(cards()).toHaveLength(2);
    expect(cards()[1]).toHaveTextContent('Declare "mini"');
  });

  it('keeps same-named models apart when their facts differ', () => {
    const small = model({ role: 'small-role', parameters: '7b' });
    const large = model({ role: 'large-role', parameters: '70b' });
    renderBand({ models: [small, large] });

    expect(cards()).toHaveLength(2);
    expect(within(cards()[0]).getByText(/70b/)).toBeVisible();
  });
});

describe('ModelBand declare path', () => {
  it('pins a declare card for a name nothing matches and opens the facts editor', async () => {
    const { onManual } = renderBand();
    await userEvent.type(screen.getByLabelText('Filter models'), 'llama-4');

    const declare = screen.getByRole('option', { name: /Declare "llama-4"/ });
    expect(within(declare).getByText(/no exact match/)).toBeVisible();

    await userEvent.click(declare);
    // Floor caps come pre-declared; the type stays unchosen (§4.4).
    expect(onManual).toHaveBeenCalledWith({
      model: 'llama-4',
      type: '',
      caps: ['chat', 'stream'],
    });
  });

  it('offers no declare card once the typed name matches exactly', async () => {
    renderBand();
    await userEvent.type(screen.getByLabelText('Filter models'), 'gpt-5-mini');
    expect(screen.queryByRole('option', { name: /Declare/ })).not.toBeInTheDocument();
  });

  it('renders the manual fields with the floor capabilities pre-checked and locked', () => {
    renderBand({ manual: { model: '', type: '', caps: ['chat', 'stream'] } });

    // The fieldset sits BENEATH the grid, never replacing it: Done demands a
    // provider, so its control has to stay on screen while declaring.
    expect(screen.getByRole('listbox', { name: /Models/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
    const manual = screen.getByRole('group', { name: 'Enter a model manually' });
    expect(within(manual).getByLabelText('Model name')).toHaveValue('');
    expect(within(manual).getByLabelText('Type')).toHaveValue('');

    const caps = within(manual).getByRole('group', { name: 'Capabilities this model supports' });
    for (const locked of ['chat', 'stream']) {
      const box = within(caps).getByLabelText(locked + ' required');
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
    }
    expect(within(caps).getByLabelText('tool_call')).not.toBeChecked();
  });

  it('reports every manual edit as complete facts in canonical order', async () => {
    const { onManual } = renderBand({
      manual: { model: '', type: '', caps: ['chat', 'stream'] },
    });

    await userEvent.type(screen.getByLabelText('Model name'), 'q');
    expect(onManual).toHaveBeenLastCalledWith({ model: 'q', type: '', caps: ['chat', 'stream'] });

    await userEvent.selectOptions(screen.getByLabelText('Type'), 'moe');
    expect(onManual).toHaveBeenLastCalledWith({ model: '', type: 'moe', caps: ['chat', 'stream'] });

    await userEvent.click(screen.getByLabelText('tool_call'));
    expect(onManual).toHaveBeenLastCalledWith({
      model: '',
      type: '',
      caps: ['chat', 'stream', 'tool_call'],
    });
  });

  it('returns to the grid from the facts editor', async () => {
    const { onManual } = renderBand({
      manual: { model: 'llama-4', type: 'dense', caps: ['chat', 'stream'] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Back to the model list' }));
    expect(onManual).toHaveBeenCalledWith(null);
  });
});

describe('ModelBand provider', () => {
  it('scopes the grid to the chosen provider and reports a change', async () => {
    const { onProviderChange } = renderBand({
      models: [model(), model({ role: 'lan-role', modelName: 'local-7b', provider: 'lan' })],
      providers: [
        {
          name: 'hosted',
          endpoint: 'https://api.example.com/v1',
          classification: 'remote',
          apiFormat: 'openai-compat',
          credentialState: 'available',
        },
        {
          name: 'lan',
          endpoint: 'http://127.0.0.1:9292/v1',
          classification: 'local',
          apiFormat: 'openai-compat',
          credentialState: 'none',
        },
      ],
    });

    expect(cards()).toHaveLength(1);
    expect(within(cards()[0]).getByText('gpt-5-mini')).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'lan');
    expect(onProviderChange).toHaveBeenCalledWith('lan');
  });
});

// ---------------------------------------------------------------------------
// Invariants the combobox picker guarded, restored on the band
// ---------------------------------------------------------------------------

describe('ModelBand row identity', () => {
  // `models` is one entry per ROLE. Two roles naming the same model with
  // byte-identical facts are one CHOICE, and rendering both gave two cards a
  // shared React key and a shared answer to "is this the selected one".
  it('collapses two roles that declare byte-identical facts', () => {
    const first = model({ role: 'first-role', parameters: '7b' });
    const second = model({ role: 'second-role', parameters: '7b' });
    renderBand({ models: [first, second], selected: first });

    expect(cards()).toHaveLength(1);
    expect(cards().filter((card) => card.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('keeps the dedup in the row builder, where Slice D will union too', () => {
    const rows = buildModelRows(
      [model({ role: 'first-role' }), model({ role: 'second-role' })],
      'hosted'
    );
    expect(rows).toHaveLength(1);
  });
});

describe('ModelBand announcements', () => {
  // The filter was silent to assistive tech once the old picker's live region
  // went with it.
  it('announces how many models the filter left', async () => {
    renderBand();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('2 models match this filter');

    await userEvent.type(screen.getByLabelText('Filter models'), 'mini');
    expect(status).toHaveTextContent('1 model matches this filter');
  });
});

describe('ModelBand Home and End', () => {
  // §4.7 names Home/End beside the arrows.
  it('jumps to the first and last card in the walk', async () => {
    renderBand();
    cards()[0].focus();

    await userEvent.keyboard('{End}');
    expect(cards().at(-1)).toHaveFocus();

    await userEvent.keyboard('{Home}');
    expect(cards()[0]).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// Structural guard: jest maps CSS-module keys to themselves (identity-obj-proxy),
// so a class that exists in NO stylesheet still "works" in these tests and
// renders unstyled in the real build. This is the only place that catches it.
// ---------------------------------------------------------------------------

describe('ModelBand stylesheet coverage', () => {
  it('resolves every styles.* reference in the tree against the shared module', () => {
    const dir = path.resolve(__dirname, '../../../components/GolemConfig');
    const css = fs.readFileSync(path.join(dir, 'GolemConfig.module.css'), 'utf8');
    // Every component that imports the shared module, discovered rather than
    // listed: a new consumer joins the guard the day it is written.
    const sources = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')] as const)
      .filter(([, source]) => source.includes("from './GolemConfig.module.css'"));
    expect(sources.length).toBeGreaterThan(5);

    for (const [name, source] of sources) {
      const used = [...source.matchAll(/styles\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
      const missing = [...new Set(used)].filter(
        (className) => !new RegExp(`\\.${className}[\\s,{:[]`).test(css)
      );
      expect({ file: name, missing }).toEqual({ file: name, missing: [] });
    }
  });
  // The grid is the one deliberate scroll region: bounded so the editor has a
  // predictable height, with a partial fifth row as the scroll affordance. The
  // strip must NOT be sticky — that overlaid the last card row and gave the
  // band a second scroll context fighting the workspace scroll.
  it('bounds the grid at four card rows and leaves the strip in normal flow', () => {
    const dir = path.resolve(__dirname, '../../../components/GolemConfig');
    const css = fs.readFileSync(path.join(dir, 'GolemConfig.module.css'), 'utf8');
    const grid = css.match(/\.modelGrid \{[^}]*\}/s)?.[0] ?? '';
    const detail = css.match(/\.detail \{[^}]*\}/s)?.[0] ?? '';

    expect(grid).toMatch(
      /max-height: calc\(4 \* var\(--golem-card-height\) \+ 3 \* var\(--golem-grid-gap\) \+ 20px\)/
    );
    expect(grid).toMatch(/overflow-y: auto/);
    expect(detail).not.toMatch(/position: sticky/);
  });

  // Mockup density: inside the strip the capability checklist flows as a
  // wrapping row of columns and sheds its boxed chrome — one tall column was
  // most of the strip's height. Its 4px row gap is the same overline-to-content
  // rhythm the facts half uses, so the two sides of the hairline match.
  it('flows the strip checklist as wrapping columns on the facts-half rhythm', () => {
    const dir = path.resolve(__dirname, '../../../components/GolemConfig');
    const css = fs.readFileSync(path.join(dir, 'GolemConfig.module.css'), 'utf8');
    const rule = css.match(/\.detail \.capabilities \{[^}]*\}/s)?.[0] ?? '';
    const stat = css.match(/\.detailStat \{[^}]*\}/s)?.[0] ?? '';

    expect(rule).toMatch(/flex-flow: row wrap/);
    expect(rule).toMatch(/border: 0/);
    expect(rule).toMatch(/gap: 4px 14px/);
    expect(stat).toMatch(/gap: 4px/);
  });
});

// ---------------------------------------------------------------------------
// Treatment 1: the master-detail strip, and preview-follows-focus
// ---------------------------------------------------------------------------

describe('ModelBand detail strip', () => {
  const strip = () => screen.getByTestId('model-detail');

  it('shows a one-line placeholder before anything is chosen', () => {
    renderBand();
    expect(strip()).toHaveTextContent(/No model assigned/);
    expect(strip()).toHaveAttribute('data-state', 'empty');
  });

  it('names the selection and its provider, and marks it assigned', () => {
    renderBand({ selected: agentModel });
    expect(strip()).toHaveAttribute('data-state', 'assigned');
    expect(within(strip()).getByText('gpt-5')).toBeVisible();
    expect(within(strip()).getByText(/from hosted/)).toBeVisible();
    expect(within(strip()).getByText('assigned')).toBeVisible();
    // and the card carries the same mark
    expect(within(cardNamed('gpt-5')).getByText('assigned')).toBeVisible();
  });

  it('never expands a card: capabilities live in the strip, not the cell', () => {
    renderBand({ selected: agentModel });
    expect(within(cardNamed('gpt-5')).queryByText('tool_call')).not.toBeInTheDocument();
    expect(within(strip()).getByText('tool_call')).toBeVisible();
  });

  it('previews the focused card without changing the assignment', async () => {
    const { onSelect } = renderBand({ selected: agentModel });
    cards()[0].focus();
    await userEvent.keyboard('{ArrowRight}');

    // The strip follows focus, read-only, and says how to commit.
    expect(strip()).toHaveAttribute('data-state', 'previewing');
    expect(within(strip()).getByText('gpt-5-mini')).toBeVisible();
    expect(within(strip()).getByText(/press Enter to choose/i)).toBeVisible();
    expect(within(strip()).queryByText('assigned')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    // The card still marked assigned is the one that IS assigned.
    expect(within(cardNamed('gpt-5')).getByText('assigned')).toBeVisible();
  });

  it('keeps the exposure editor bound to the selection while previewing', async () => {
    renderBand({
      selected: agentModel,
      exposure: <div data-testid="exposure">exposure for the selection</div>,
    });
    expect(within(strip()).getByTestId('exposure')).toBeVisible();

    cards()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    // Editing what you have not chosen would stage a lie.
    expect(within(strip()).getByTestId('exposure')).toBeVisible();
    expect(within(strip()).getByText('gpt-5-mini')).toBeVisible();
  });

  it('returns the preview to the selection on Escape', async () => {
    renderBand({ selected: agentModel });
    cards()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(strip()).toHaveAttribute('data-state', 'previewing');

    await userEvent.keyboard('{Escape}');
    expect(strip()).toHaveAttribute('data-state', 'assigned');
    expect(within(strip()).getByText('gpt-5')).toBeVisible();
  });

  // The strip is in normal flow and always visible; what can be out of sight
  // is the assigned CARD, inside the bounded grid scroller.
  it('scrolls the assigned card into view within the grid', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    const { rerender, props } = renderBand();
    expect(scrolled).toHaveLength(0); // never on first paint

    rerender(<ModelBand {...props} selected={agentModel} />);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toHaveAttribute('role', 'option');
    expect(within(scrolled[0] as HTMLElement).getByText('gpt-5')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The declare path is a first-class readout, not a dead end
// ---------------------------------------------------------------------------

describe('ModelBand declare readout', () => {
  const strip = () => screen.getByTestId('model-detail');

  it('gives a hand declaration the exposure editor too', () => {
    // RouteEditor nulls the chosen model when a declaration is made, so gating
    // the exposure half on `selected` deleted the checklist and the Think
    // control from the entire declare path.
    renderBand({
      selected: null,
      manual: { model: 'llama-4', type: 'dense', caps: ['chat', 'stream'] },
      exposure: <div data-testid="exposure">think mode and the checklist</div>,
    });

    expect(within(strip()).getByTestId('exposure')).toBeVisible();
  });

  it('wears the solid surface while declaring, not the empty placeholder', () => {
    renderBand({
      selected: null,
      manual: { model: 'llama-4', type: '', caps: ['chat', 'stream'] },
    });

    expect(strip()).toHaveAttribute('data-state', 'declaring');
    expect(strip().className).not.toMatch(/detailEmpty/);
    expect(within(strip()).getByText(/declare "llama-4"/)).toBeVisible();
  });

  it('gives the facts half the full width when there is no exposure half', () => {
    renderBand({ selected: agentModel });
    expect(within(strip()).getByText('gpt-5')).toBeVisible();
    // No exposure node passed, so the strip must not leave 7/12 blank.
    expect(strip().querySelector(`[class*='detailBody']`)).not.toHaveAttribute('data-split');
  });
});

// ---------------------------------------------------------------------------
// Preview must not outlive the grid
// ---------------------------------------------------------------------------

describe('ModelBand preview lifetime', () => {
  const strip = () => screen.getByTestId('model-detail');

  it('ends the preview when focus leaves the grid', async () => {
    renderBand({ selected: agentModel });
    cards()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(strip()).toHaveAttribute('data-state', 'previewing');

    // Tabbing or clicking out must not leave the hint over another model's
    // facts while the checkboxes belong to the assignment.
    await userEvent.click(screen.getByLabelText('Filter models'));
    expect(strip()).toHaveAttribute('data-state', 'assigned');
  });

  it('ends the preview when the filter is typed', async () => {
    renderBand({ selected: agentModel });
    cards()[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(strip()).toHaveAttribute('data-state', 'previewing');

    // The filter re-points the active index with no navigation at all.
    await userEvent.type(screen.getByLabelText('Filter models'), 'g');
    expect(strip()).toHaveAttribute('data-state', 'assigned');
  });
});

describe('ModelBand click selection', () => {
  it('selects the model when its card is clicked', async () => {
    const { onSelect } = renderBand();
    await userEvent.click(cardNamed('gpt-5-mini'));
    expect(onSelect).toHaveBeenCalledWith(model());
  });
});
