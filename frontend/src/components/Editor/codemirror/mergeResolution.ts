import {
  ChangeDesc,
  Compartment,
  EditorState,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import { acceptCompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  invertedEffects,
  indentWithTab,
  isolateHistory,
  redo,
  undo,
} from '@codemirror/commands';
import { foldKeymap } from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { Decoration, EditorView, keymap, lineNumbers, WidgetType } from '@codemirror/view';
import type { git } from '../../../wails/bindings';
import type { InlineDiffSegment } from '../../../utils/lineDiff';
import type { MergeDecision, TextMergeSession } from '../../../stores/gitStore';
import { DEFAULT_SYNTAX_THEME_ID, getSyntaxPalette, type SyntaxThemeId } from './palettes';
import { sideWordMarks, type SideWordMarks } from './mergeWordMarks';
import { inFileSearchExtensions, inFileSearchKeymap } from './search';
import { buildChrome } from './theme';

// ponytail: 1,000-line whole-document ceiling; use viewport-only provenance if larger merges need stripes.
const MAX_PROVENANCE_LINES = 1_000;

export type MergeChoice = Exclude<MergeDecision, 'M'>;
export type MergeOrder = 'current-first' | 'incoming-first';
export type MergeDirection = 1 | -1;
export type ResolutionRefusalHandler = (
  choice: MergeChoice | 'M',
  reason: 'ambiguous-eof' | 'nonterminal-eof'
) => void;

export interface MarkerBlockRange {
  from: number;
  to: number;
}

export interface MappedMergeRegion extends MarkerBlockRange {
  index: number;
  trailingNewline?: boolean;
}

export interface MergeResolutionState {
  activeIndex: number | null;
  decisions: Record<number, MergeDecision>;
  order: MergeOrder;
}

function normalizeDocument(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

/** The marker lines are part of the replaced block; their following newline is not. */
export function markerBlockRange(
  content: string,
  startLine: number,
  endLine: number
): MarkerBlockRange {
  return markerBlockRanges(content, [{ startLine, endLine }])[0];
}

/** Maps marker line pairs after one document-wide line-start scan. */
export function markerBlockRanges(
  content: string,
  regions: readonly Pick<git.ConflictRegion, 'startLine' | 'endLine'>[]
): MarkerBlockRange[] {
  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lineStarts.push(index + 1);
  }
  return regions.map(({ startLine, endLine }) => {
    if (startLine < 1 || endLine < startLine || endLine > lineStarts.length) {
      throw new RangeError(`Invalid conflict marker lines ${startLine}-${endLine}`);
    }
    return {
      from: lineStarts[startLine - 1],
      to: endLine === lineStarts.length ? content.length : lineStarts[endLine] - 1,
    };
  });
}

/** Finds the next still-unresolved region, wrapping at either end. */
export function nextUnresolved(
  decisions: Record<number, MergeDecision>,
  regionCount: number,
  current: number | null,
  direction: MergeDirection = 1
): number | null {
  if (regionCount === 0) return null;
  const start = current === null ? (direction === 1 ? -1 : 0) : current;
  for (let offset = 1; offset <= regionCount; offset += 1) {
    const candidate = (start + direction * offset + regionCount) % regionCount;
    if (decisions[candidate] === undefined) return candidate;
  }
  return null;
}

export function resolutionLines(
  region: git.ConflictRegion,
  choice: MergeChoice,
  order: MergeOrder
): string[] {
  if (choice === 'C') return region.ours;
  if (choice === 'I') return region.theirs;
  return order === 'current-first'
    ? [...region.ours, ...region.theirs]
    : [...region.theirs, ...region.ours];
}

function resolutionEOFTarget(
  region: git.ConflictRegion,
  choice: MergeChoice,
  order: MergeOrder
): boolean | null | undefined {
  const ours = region.oursEndsWithNewline;
  const theirs = region.theirsEndsWithNewline;
  if (ours === undefined && theirs === undefined) return null;
  if (choice === 'C') return ours;
  if (choice === 'I') return theirs;

  const sides =
    order === 'current-first'
      ? ([
          ['ours', region.ours],
          ['theirs', region.theirs],
        ] as const)
      : ([
          ['theirs', region.theirs],
          ['ours', region.ours],
        ] as const);
  for (let index = sides.length - 1; index >= 0; index -= 1) {
    const [side, lines] = sides[index];
    if (lines.length > 0)
      return side === 'ours' ? region.oursEndsWithNewline : region.theirsEndsWithNewline;
  }
  if (ours === undefined || theirs === undefined || ours !== theirs) return undefined;
  return ours;
}

/** Regions touched by document changes in pre-transaction coordinates. */
export function changedRegionIndexes(
  regions: readonly MappedMergeRegion[],
  changes: readonly MarkerBlockRange[]
): number[] {
  return regions
    .filter(({ from, to, trailingNewline }) =>
      changes.some((change) =>
        change.from === change.to
          ? from === to
            ? change.from === from
            : change.from >= from && (trailingNewline ? change.from < to : change.from <= to)
          : change.from < to && change.to > from
      )
    )
    .map(({ index }) => index);
}

class MergeRegionRange extends RangeValue {
  override startSide = -1;
  override endSide = 1;

  constructor(
    readonly index: number,
    readonly trailingNewline: boolean
  ) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return other instanceof MergeRegionRange && other.index === this.index;
  }
}

interface ResolutionFieldState extends MergeResolutionState {
  ranges: RangeSet<MergeRegionRange>;
  frozen: boolean;
}

interface DecisionEffect {
  index: number;
  decision?: MergeDecision;
}

function rangeSnapshot(ranges: RangeSet<MergeRegionRange>): MappedMergeRegion[] {
  const snapshot: MappedMergeRegion[] = [];
  ranges.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    snapshot.push({ index: value.index, from, to, trailingNewline: value.trailingNewline });
  });
  return snapshot;
}

function rangesIn(state: ResolutionFieldState): MappedMergeRegion[] {
  return rangeSnapshot(state.ranges);
}

function rangeSetFromSnapshot(snapshot: readonly MappedMergeRegion[]): RangeSet<MergeRegionRange> {
  return RangeSet.of(
    snapshot.map(({ index, from, to, trailingNewline }) =>
      new MergeRegionRange(index, trailingNewline === true).range(from, to)
    ),
    true
  );
}

/** Keeps an insertion at the following-line boundary outside its conflict range. */
function mapRanges(
  ranges: RangeSet<MergeRegionRange>,
  changes: ChangeDesc
): RangeSet<MergeRegionRange> {
  const boundaryInsertions = new Map<number, number>();
  const before = rangeSnapshot(ranges);
  changes.iterChangedRanges((fromA: number, toA: number, fromB: number, toB: number) => {
    if (fromA !== toA) return;
    for (const range of before) {
      if (range.from < range.to && range.trailingNewline && range.to === fromA) {
        boundaryInsertions.set(
          range.index,
          (boundaryInsertions.get(range.index) ?? 0) + toB - fromB
        );
      }
    }
  }, true);
  const mapped = ranges.map(changes);
  if (boundaryInsertions.size === 0) return mapped;
  const mappedByIndex = new Map(rangeSnapshot(mapped).map((range) => [range.index, range]));
  return RangeSet.of(
    before.map((original) => {
      const range = mappedByIndex.get(original.index)!;
      return new MergeRegionRange(original.index, original.trailingNewline === true).range(
        range.from,
        range.to - (boundaryInsertions.get(original.index) ?? 0)
      );
    }),
    true
  );
}

/**
 * Names the document lines a block occupies, for the card title. The gutter skips
 * these lines (the card replaces them), so this is the only place the user can see
 * which part of the file the card stands for. Computed from live document state, not
 * the parse-time region coordinates, so it stays right after earlier conflicts
 * resolve and shift everything below them.
 */
function describeLineRange(state: EditorState, from: number, to: number): string {
  const first = state.doc.lineAt(from).number;
  // `to` sits on the block's trailing newline; step back so the range does not
  // claim the following line.
  const last = state.doc.lineAt(Math.max(from, to - 1)).number;
  return first === last ? `line ${first}` : `lines ${first}-${last}`;
}

function appendSide(
  parent: HTMLElement,
  label: string,
  lines: string[],
  marks?: InlineDiffSegment[][],
  emptyText = '(deletes this block)'
): void {
  const side = document.createElement('section');
  side.className = 'cm-mergeResolution-side';
  const heading = document.createElement('div');
  heading.className = 'cm-mergeResolution-sideLabel';
  heading.textContent = label;
  const body = document.createElement('pre');
  body.className = 'cm-mergeResolution-lines';
  if (lines.length === 0) {
    body.textContent = emptyText;
  } else if (!marks) {
    body.textContent = lines.join('\n');
  } else {
    lines.forEach((line, index) => {
      if (index > 0) body.appendChild(document.createTextNode('\n'));
      for (const segment of marks[index] ?? [{ text: line, type: 'same' as const }]) {
        if (segment.type === 'same') {
          body.appendChild(document.createTextNode(segment.text));
          continue;
        }
        const mark = document.createElement('span');
        mark.className = `cm-mergeResolution-word-${segment.type}`;
        mark.textContent = segment.text;
        body.appendChild(mark);
      }
    });
  }
  side.append(heading, body);
  parent.appendChild(side);
}

class MergeResolutionWidget extends WidgetType {
  constructor(
    private readonly region: git.ConflictRegion,
    private readonly index: number,
    private readonly active: boolean,
    private readonly order: MergeOrder,
    private readonly labels: TextMergeSession['labels'],
    private readonly readOnly: boolean,
    private readonly frozen: boolean,
    private readonly marks: SideWordMarks | null,
    /** Live line range this block occupies, e.g. `lines 2-6`. The gutter skips these
     * lines because the card replaces them, so the card itself names the gap. */
    private readonly lineRange: string,
    private readonly act: (view: EditorView, index: number, choice: MergeChoice | 'M') => void,
    private readonly activate: (view: EditorView, index: number) => void
  ) {
    super();
  }

  override eq(other: MergeResolutionWidget): boolean {
    return (
      other.index === this.index &&
      other.active === this.active &&
      other.order === this.order &&
      other.region === this.region &&
      other.frozen === this.frozen &&
      other.lineRange === this.lineRange
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const currentLabel = `CURRENT — ${this.labels.ours.label}`;
    const incomingLabel = `INCOMING — ${this.labels.theirs.label}`;
    if (!this.active) {
      const root = document.createElement('button');
      root.type = 'button';
      root.className = 'cm-mergeResolution-strip';
      root.dataset.regionIndex = String(this.index);
      root.disabled = this.frozen;
      // A collapsed strip replaces its block too, so it also leaves a gutter gap —
      // name its lines for the same reason the expanded card does.
      root.setAttribute(
        'aria-label',
        `Open conflict ${this.index + 1}, ${this.lineRange}: ${currentLabel} / ${incomingLabel}`
      );
      root.textContent = `Conflict ${this.index + 1} · ${this.lineRange}: ${currentLabel} / ${incomingLabel}`;
      root.addEventListener('click', (event) => {
        event.preventDefault();
        if (this.frozen) return;
        this.activate(view, this.index);
      });
      return root;
    }

    const root = document.createElement('section');
    root.className = 'cm-mergeResolution-card cm-mergeResolution-active';
    root.dataset.regionIndex = String(this.index);

    const title = document.createElement('div');
    title.className = 'cm-mergeResolution-title';
    title.textContent = `Conflict ${this.index + 1} · ${this.lineRange}`;
    root.appendChild(title);
    appendSide(root, currentLabel, this.region.ours, this.marks?.a);
    appendSide(root, incomingLabel, this.region.theirs, this.marks?.b);
    if (this.region.hasBase) {
      appendSide(
        root,
        'BASE — common ancestor',
        this.region.base,
        undefined,
        '(no lines in the common ancestor)'
      );
    }

    const actions = document.createElement('div');
    actions.className = 'cm-mergeResolution-actions';
    // Preview is ephemeral view state: append/remove a ghost <pre> directly in the
    // card DOM, never a transaction — so the decoration facet never recomputes and the
    // focused button is never rebuilt. A real state change produces a fresh card with
    // no ghost, clearing preview automatically.
    let ghost: HTMLElement | null = null;
    const renderGhost = (choice: MergeChoice | null) => {
      if (choice === null) {
        ghost?.remove();
        ghost = null;
      } else {
        if (!ghost) {
          ghost = document.createElement('pre');
          ghost.className = 'cm-mergeResolution-ghost';
          ghost.setAttribute('aria-hidden', 'true');
          root.appendChild(ghost);
        }
        // Same function applyResolution uses — preview can never disagree with apply.
        ghost.textContent = resolutionLines(this.region, choice, this.order).join('\n');
      }
      // Not a transaction, so tell CodeMirror to re-measure the block's height.
      view.requestMeasure();
    };
    const button = (label: string, choice: MergeChoice | 'M') => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'cm-mergeResolution-action';
      element.dataset.decision = choice;
      element.textContent = label;
      element.disabled = this.frozen;
      element.setAttribute('aria-disabled', String(this.readOnly || this.frozen));
      element.addEventListener('click', (event) => {
        event.preventDefault();
        if (this.readOnly || this.frozen) return;
        this.act(view, this.index, choice);
      });
      if (choice !== 'M' && !this.frozen) {
        let hovered = false;
        let focused = false;
        const sync = () => renderGhost(hovered || focused ? choice : null);
        element.addEventListener('pointerenter', () => {
          hovered = true;
          sync();
        });
        element.addEventListener('pointerleave', () => {
          hovered = false;
          sync();
        });
        element.addEventListener('focus', () => {
          focused = true;
          sync();
        });
        element.addEventListener('blur', () => {
          focused = false;
          sync();
        });
      }
      actions.appendChild(element);
    };
    button('Take Current', 'C');
    button('Take Incoming', 'I');
    button('Take Both', 'B');
    const order = document.createElement('button');
    order.type = 'button';
    order.className = 'cm-mergeResolution-order';
    order.textContent = this.order === 'current-first' ? 'Current first' : 'Incoming first';
    order.disabled = this.readOnly || this.frozen;
    order.addEventListener('click', (event) => {
      event.preventDefault();
      if (this.readOnly || this.frozen) return;
      view.dispatch({
        effects: setMergeOrder.of(
          this.order === 'current-first' ? 'incoming-first' : 'current-first'
        ),
      });
      view.focus();
    });
    actions.appendChild(order);
    button('Edit manually', 'M');
    root.appendChild(actions);
    return root;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const setMergeDecision = StateEffect.define<DecisionEffect>();
const setMergeActive = StateEffect.define<number | null>();
const setMergeOrder = StateEffect.define<MergeOrder>();
const setMergeFrozen = StateEffect.define<boolean>();
const restoreMergeRanges = StateEffect.define<MappedMergeRegion[]>({
  // History maps stored effects through a ChangeDesc before replaying them. RangeSet moves each
  // snapshot record without coalescing identities; ambiguous shared insertions are rejected
  // below, while iterChangedRanges keeps the following-line boundary rule during remapping.
  map: (snapshot, changes) => rangeSnapshot(mapRanges(rangeSetFromSnapshot(snapshot), changes)),
});

function hasMergeStateEffect(effects: readonly StateEffect<unknown>[]): boolean {
  return effects.some((effect) => effect.is(setMergeDecision) || effect.is(restoreMergeRanges));
}

function hasAmbiguousSharedInsertion(
  regions: readonly MappedMergeRegion[],
  changes: readonly MarkerBlockRange[]
): boolean {
  return changes.some((change) => {
    if (change.from !== change.to) return false;
    const touched = new Set(changedRegionIndexes(regions, [change]));
    return (
      touched.size > 1 &&
      regions.some((region) => touched.has(region.index) && region.from === region.to)
    );
  });
}

function stateSnapshot(state: ResolutionFieldState): MergeResolutionState {
  return { activeIndex: state.activeIndex, decisions: state.decisions, order: state.order };
}

function transactionChanges(tr: {
  changes: {
    iterChanges: (f: (from: number, to: number) => void, individual?: boolean) => void;
  };
}): MarkerBlockRange[] {
  const changes: MarkerBlockRange[] = [];
  tr.changes.iterChanges((from, to) => changes.push({ from, to }), true);
  return changes;
}

interface OriginalMarkerBlock {
  text: string;
  startsAfterNewline: boolean;
}

function resolutionExtension(
  session: TextMergeSession,
  onStateChange?: (state: MergeResolutionState) => void,
  onDocumentChanged?: () => void,
  onResolutionRefused?: ResolutionRefusalHandler
): {
  extension: Extension[];
  field: StateField<ResolutionFieldState>;
  originalBlocks: OriginalMarkerBlock[];
} {
  const document = normalizeDocument(session.content);
  const markerRanges = markerBlockRanges(document, session.regions);
  const originalBlocks = markerRanges.map(({ from, to }) => ({
    text: document.slice(from, to),
    startsAfterNewline: from > 0 && document[from - 1] === '\n',
  }));
  const regionWordMarks = session.regions.map((region) =>
    sideWordMarks(region.ours, region.theirs)
  );
  const regionRanges = session.regions.map((region, index) => {
    const range = markerRanges[index];
    const trailingNewline = document[range.to] === '\n';
    return new MergeRegionRange(index, trailingNewline).range(
      range.from,
      range.to + (trailingNewline ? 1 : 0)
    );
  });
  const activate = (view: EditorView, index: number) => activateRegion(view, field, index);
  const apply = (view: EditorView, index: number, choice: MergeChoice | 'M') =>
    applyResolution(view, field, session, index, choice, onResolutionRefused);

  const field = StateField.define<ResolutionFieldState>({
    create: () => ({
      ranges: RangeSet.of(regionRanges, true),
      decisions: { ...session.decisions },
      activeIndex: nextUnresolved(session.decisions, session.regions.length, null, 1),
      order: 'current-first',
      frozen: false,
    }),
    update(value, tr) {
      let ranges = tr.docChanged ? mapRanges(value.ranges, tr.changes) : value.ranges;
      let decisions = value.decisions;
      let activeIndex = value.activeIndex;
      let order = value.order;
      let frozen = value.frozen;
      for (const effect of tr.effects) {
        if (effect.is(restoreMergeRanges)) {
          ranges = rangeSetFromSnapshot(effect.value);
        } else if (effect.is(setMergeDecision)) {
          decisions = { ...decisions };
          if (effect.value.decision === undefined) delete decisions[effect.value.index];
          else decisions[effect.value.index] = effect.value.decision;
        } else if (effect.is(setMergeActive)) {
          activeIndex = effect.value;
        } else if (effect.is(setMergeOrder)) {
          order = effect.value;
        } else if (effect.is(setMergeFrozen)) {
          frozen = effect.value;
        }
      }
      return { ranges, decisions, activeIndex, order, frozen };
    },
    provide: (field) => [
      EditorState.readOnly.from(field, (value) => session.readOnly || value.frozen),
      EditorView.editable.from(field, (value) => !session.readOnly && !value.frozen),
      EditorView.decorations.compute(['doc', field], (state) => {
        const value = state.field(field);
        const ranges = rangesIn(value);
        const showProvenance =
          ranges.reduce((lineCount, { from, to, index }) => {
            if (value.decisions[index] === undefined || from === to) return lineCount;
            return (
              lineCount +
              state.doc.lineAt(Math.max(from, to - 1)).number -
              state.doc.lineAt(from).number +
              1
            );
          }, 0) <= MAX_PROVENANCE_LINES;
        const decorations: Range<Decoration>[] = [];
        for (const { from, to, index } of ranges) {
          const decision = value.decisions[index];
          if (decision === undefined) {
            decorations.push(
              Decoration.replace({
                block: true,
                widget: new MergeResolutionWidget(
                  session.regions[index],
                  index,
                  value.activeIndex === index,
                  value.order,
                  session.labels,
                  session.readOnly,
                  value.frozen,
                  regionWordMarks[index],
                  describeLineRange(state, from, to),
                  apply,
                  activate
                ),
              }).range(from, to)
            );
            continue;
          }
          if (!showProvenance || from === to) continue;
          const last = state.doc.lineAt(Math.max(from, to - 1));
          for (
            let line = state.doc.lineAt(from);
            line.from <= last.from;
            line = state.doc.line(line.number + 1)
          ) {
            decorations.push(
              Decoration.line({ class: `cm-mergeResolution-provenance-${decision}` }).range(
                line.from
              )
            );
            if (line.number === state.doc.lines) break;
          }
        }
        return Decoration.set(decorations, true);
      }),
    ],
  });

  return {
    field,
    originalBlocks,
    extension: [
      field,
      EditorState.transactionFilter.of((tr) => {
        const frozen = tr.startState.field(field).frozen;
        if (!frozen) return tr;
        return tr.docChanged ||
          tr.effects.some((effect) => effect.is(setMergeDecision) || effect.is(setMergeOrder))
          ? []
          : tr;
      }),
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || hasMergeStateEffect(tr.effects)) return tr;
        const state = tr.startState.field(field);
        const mapped = rangesIn(state);
        const changes = transactionChanges(tr);
        if (hasAmbiguousSharedInsertion(mapped, changes)) return [];
        const touched = changedRegionIndexes(mapped, changes);
        return touched.some((index) => state.decisions[index] === undefined) ? [] : tr;
      }),
      EditorState.transactionExtender.of((tr) => {
        if (!tr.docChanged || hasMergeStateEffect(tr.effects)) return null;
        const touched = changedRegionIndexes(
          rangesIn(tr.startState.field(field)),
          transactionChanges(tr)
        );
        return touched.length === 0
          ? null
          : { effects: touched.map((index) => setMergeDecision.of({ index, decision: 'M' })) };
      }),
      invertedEffects.of((tr) => {
        const before = tr.startState.field(field);
        const decisionEffects = tr.effects.flatMap((effect) => {
          if (!effect.is(setMergeDecision)) return [];
          return [
            setMergeDecision.of({
              index: effect.value.index,
              decision: before.decisions[effect.value.index],
            }),
          ];
        });
        return [
          ...(tr.docChanged ? [restoreMergeRanges.of(rangeSnapshot(before.ranges))] : []),
          ...decisionEffects,
          ...(tr.effects.some((effect) => effect.is(setMergeDecision)) &&
          tr.effects.some((effect) => effect.is(setMergeActive))
            ? [setMergeActive.of(before.activeIndex)]
            : []),
        ];
      }),
      EditorView.updateListener.of((update) => {
        // Any accepted document change means the Result was touched — including
        // an edit outside every conflict region, which records no decision. The
        // store owns the sticky bit; this only reports the event.
        if (update.docChanged) onDocumentChanged?.();
        if (update.transactions.length > 0)
          onStateChange?.(stateSnapshot(update.state.field(field)));
      }),
    ],
  };
}

export interface MergeResolutionEditor {
  view: EditorView;
  getResult: () => string;
  getState: () => MergeResolutionState;
  undo: () => boolean;
  redo: () => boolean;
  setFrozen: (frozen: boolean) => void;
  setTheme: (themeId: SyntaxThemeId) => void;
  next: (direction?: MergeDirection) => boolean;
  activate: (index: number) => boolean;
  reopen: (index: number, options?: { activate?: boolean }) => boolean;
  destroy: () => void;
}

/** Mounts the Result-spine editor with native history and the normal editor keymaps. */
export function createMergeResolutionEditor(
  parent: HTMLElement,
  session: TextMergeSession,
  options: {
    extensions?: Extension[];
    onStateChange?: (state: MergeResolutionState) => void;
    /** Called for every accepted document-changing transaction, undo included. */
    onDocumentChanged?: () => void;
    onResolutionRefused?: ResolutionRefusalHandler;
    syntaxThemeId?: SyntaxThemeId;
  } = {}
): MergeResolutionEditor {
  const support = resolutionExtension(
    session,
    options.onStateChange,
    options.onDocumentChanged,
    options.onResolutionRefused
  );
  const theme = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: normalizeDocument(session.content),
      extensions: [
        theme.of(buildChrome(getSyntaxPalette(options.syntaxThemeId ?? DEFAULT_SYNTAX_THEME_ID))),
        // The result spine is a real document, so number it like one. Conflict cards
        // are block-replaced ranges, so their marker lines share a single gutter slot
        // until the conflict is resolved and the real result lines take their place.
        lineNumbers(),
        history(),
        ...inFileSearchExtensions(),
        ...support.extension,
        keymap.of([
          {
            key: 'F7',
            run: (target) => navigate(target, support.field, session.regions.length, 1),
            shift: (target) => navigate(target, support.field, session.regions.length, -1),
          },
          {
            key: 'Mod-1',
            run: (target) =>
              choose(target, support.field, session, 'C', options.onResolutionRefused),
          },
          {
            key: 'Mod-2',
            run: (target) =>
              choose(target, support.field, session, 'I', options.onResolutionRefused),
          },
          {
            key: 'Mod-3',
            run: (target) =>
              choose(target, support.field, session, 'B', options.onResolutionRefused),
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...inFileSearchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...lintKeymap,
          { key: 'Tab', run: acceptCompletion },
          indentWithTab,
        ]),
        ...(options.extensions ?? []),
      ],
    }),
  });
  const read = () => view.state.field(support.field);
  return {
    view,
    getResult: () => view.state.doc.toString(),
    getState: () => stateSnapshot(read()),
    undo: () => {
      if (read().frozen) return false;
      const changed = undo(view);
      if (changed) view.focus();
      return changed;
    },
    redo: () => {
      if (read().frozen) return false;
      const changed = redo(view);
      if (changed) view.focus();
      return changed;
    },
    setFrozen: (frozen) => view.dispatch({ effects: setMergeFrozen.of(frozen) }),
    setTheme: (themeId) =>
      view.dispatch({ effects: theme.reconfigure(buildChrome(getSyntaxPalette(themeId))) }),
    next: (direction = 1) => navigate(view, support.field, session.regions.length, direction),
    activate: (index) => activateRegion(view, support.field, index),
    reopen: (index, options) =>
      reopenRegion(view, support.field, support.originalBlocks, index, options?.activate === true),
    destroy: () => view.destroy(),
  };
}

function navigate(
  view: EditorView,
  field: StateField<ResolutionFieldState>,
  regionCount: number,
  direction: MergeDirection
): boolean {
  const current = view.state.field(field);
  const index = nextUnresolved(current.decisions, regionCount, current.activeIndex, direction);
  if (index === null) return false;
  return activateRegion(view, field, index);
}

function activateRegion(
  view: EditorView,
  field: StateField<ResolutionFieldState>,
  index: number
): boolean {
  const range = rangesIn(view.state.field(field)).find((item) => item.index === index);
  if (!range) return false;
  view.dispatch({
    effects: setMergeActive.of(index),
    selection: { anchor: range.from },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/**
 * Returns true when the choice was applied OR when a fail-closed refusal was
 * reported through `onResolutionRefused` — "handled", so the Mod-N keybinding
 * is consumed rather than falling through. The remaining false returns are the
 * silent guards whose states correspond to a disabled control.
 */
function applyResolution(
  view: EditorView,
  field: StateField<ResolutionFieldState>,
  session: TextMergeSession,
  index: number,
  choice: MergeChoice | 'M',
  onResolutionRefused?: ResolutionRefusalHandler
): boolean {
  if (session.readOnly) return false;
  const state = view.state.field(field);
  if (state.frozen) return false;
  const range = rangesIn(state).find((item) => item.index === index);
  const region = session.regions[index];
  if (!range || !region || state.decisions[index] !== undefined) return false;
  // Manual starts from both real sides, preserving every line for the user to edit.
  const decision: MergeDecision = choice === 'M' ? 'M' : choice;
  const effectiveChoice = choice === 'M' ? 'B' : choice;
  const lines = resolutionLines(region, effectiveChoice, state.order);
  const eofTarget = resolutionEOFTarget(region, effectiveChoice, state.order);
  if (eofTarget === undefined) {
    onResolutionRefused?.(choice, 'ambiguous-eof');
    return onResolutionRefused !== undefined;
  }
  let changes: { from: number; to: number; insert: string };
  if (eofTarget === null) {
    changes = {
      from: range.from,
      to: range.to,
      insert: `${lines.join('\n')}${lines.length > 0 && range.trailingNewline ? '\n' : ''}`,
    };
  } else {
    const document = view.state.doc.toString();
    if (range.to !== document.length) {
      onResolutionRefused?.(choice, 'nonterminal-eof');
      return onResolutionRefused !== undefined;
    }
    let result = document.slice(0, range.from) + lines.join('\n');
    if (eofTarget) {
      if (lines.length > 0 || !result.endsWith('\n')) result += '\n';
    } else {
      // Exactly one newline: the EOF flag describes a single byte (is the blob's
      // last byte an LF), never a run. Stripping greedily would delete real
      // trailing blank lines carried in from an earlier region's resolution.
      result = result.replace(/\n$/, '');
    }
    let from = 0;
    while (from < document.length && from < result.length && document[from] === result[from]) {
      from += 1;
    }
    changes = { from, to: document.length, insert: result.slice(from) };
  }
  const decisions = { ...state.decisions, [index]: decision };
  const activeIndex =
    choice === 'M' ? index : nextUnresolved(decisions, session.regions.length, index, 1);
  view.dispatch({
    changes,
    effects: [setMergeDecision.of({ index, decision }), setMergeActive.of(activeIndex)],
    annotations: isolateHistory.of('full'),
    ...(choice === 'M'
      ? {
          selection: {
            anchor: Math.min(
              range.from,
              view.state.doc.length - (changes.to - changes.from) + changes.insert.length
            ),
          },
          scrollIntoView: true,
        }
      : {}),
  });
  view.focus();
  if (choice !== 'M' && activeIndex !== null) activateRegion(view, field, activeIndex);
  return true;
}

/** Re-inserts a resolved region's original marker block, exactly as parsed. */
function reopenRegion(
  view: EditorView,
  field: StateField<ResolutionFieldState>,
  originalBlocks: readonly OriginalMarkerBlock[],
  index: number,
  activate: boolean
): boolean {
  const state = view.state.field(field);
  if (state.frozen) return false;
  if (state.decisions[index] === undefined) return false;
  const snapshot = rangesIn(state);
  const range = snapshot.find((item) => item.index === index);
  const original = originalBlocks[index];
  if (!range || original === undefined) return false;
  if (
    range.from < range.to &&
    snapshot.some(
      (item) =>
        item.index !== index && item.from < item.to && item.from < range.to && item.to > range.from
    )
  )
    return false;

  const leadingNewline =
    original.startsAfterNewline &&
    range.from > 0 &&
    view.state.doc.sliceString(range.from - 1, range.from) !== '\n'
      ? '\n'
      : '';
  const insert = `${leadingNewline}${original.text}${range.trailingNewline ? '\n' : ''}`;
  const delta = insert.length - (range.to - range.from);
  // Rebuild the range snapshot deterministically by ORIGINAL REGION ORDER (index),
  // never by coordinate comparison. Regions parse in document order, so index order
  // IS document order; a lower-index region is before the reopened block, a higher
  // one is after. This is what makes co-located collapsed regions (two empty
  // resolutions at the same offset) resolve correctly and REVERSIBLY — a coordinate
  // test like `item.from >= range.to` would move the earlier sibling the wrong way
  // and corrupt reverse-order reopen. rangeSetFromSnapshot sorts, so the array need
  // not be pre-sorted.
  const pinned: MappedMergeRegion[] = snapshot.map((item) => {
    if (item.index === index) {
      return {
        index,
        from: range.from,
        to: range.from + insert.length,
        trailingNewline: range.trailingNewline,
      };
    }
    if (item.index > index) {
      return { ...item, from: item.from + delta, to: item.to + delta };
    }
    // item.index < index: strictly before the reopened block in document order.
    return item;
  });

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    effects: [
      setMergeDecision.of({ index, decision: undefined }),
      restoreMergeRanges.of(pinned),
      ...(activate ? [setMergeActive.of(index)] : []),
    ],
    annotations: isolateHistory.of('full'),
    ...(activate ? { selection: { anchor: range.from }, scrollIntoView: true } : {}),
  });
  if (activate) view.focus();
  return true;
}

function choose(
  view: EditorView,
  field: StateField<ResolutionFieldState>,
  session: TextMergeSession,
  choice: MergeChoice,
  onResolutionRefused?: ResolutionRefusalHandler
): boolean {
  const state = view.state.field(field);
  const index = state.activeIndex;
  if (index === null) return false;
  return applyResolution(view, field, session, index, choice, onResolutionRefused);
}
