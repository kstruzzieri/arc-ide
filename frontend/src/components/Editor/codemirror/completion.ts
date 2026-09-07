/**
 * CodeMirror LSP Completion Integration
 *
 * Keeps the editor's autocomplete configuration in a reconfigurable compartment
 * so we can use language-mode fallbacks when no LSP is ready and switch to
 * LSP-only completions once a server is available.
 */

import { Compartment } from '@codemirror/state';
import {
  autocompletion,
  type Completion,
  type CompletionSection,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  snippet,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { LSPComplete, LSPResolveCompletionItem } from '../../../wails/bindings';
import { decodeLSPContent } from '../../../utils/lspContent';
import { flushLSPDocumentChange } from '../../../utils/lspDocumentSync';

const SVG_NS = 'http://www.w3.org/2000/svg';

type LSPTextEdit = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
};

export type LSPCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  labelDetails?: {
    detail?: string;
    description?: string;
  };
  documentation?: unknown;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LSPTextEdit;
  filterText?: string;
  sortText?: string;
  commitCharacters?: string[];
  data?: unknown;
};

type FirnCompletion = Completion & {
  firnKind?: number;
  firnMeta?: string;
  firnTail?: string;
  firnInfoHeader?: string;
};

type CompletionPresentation = {
  tail?: string;
  rightText?: string;
  meta?: string;
  infoHeader?: string;
};

type ParsedCompletionDetail = {
  tail?: string;
  rightText?: string;
};

const completionResolveCache = new Map<string, Promise<LSPCompletionItem>>();
export const COMPLETION_RESOLVE_CACHE_LIMIT = 500;
const PROPERTY_ACCESS_RESOLVE_LIMIT = 12;
const SCOPE_RESOLVE_LIMIT = 6;

const COMPLETION_SECTIONS: Record<string, CompletionSection> = {
  members: createCompletionSection('Members', 0),
  scope: createCompletionSection('In Scope', 1),
  imports: createCompletionSection('Imports', 2),
  types: createCompletionSection('Types', 3),
  keywords: createCompletionSection('Keywords', 4),
  snippets: createCompletionSection('Snippets', 5),
};

/** Compartment for autocomplete behavior. */
export const completionCompartment = new Compartment();

/**
 * Returns the initial autocomplete extensions.
 * When LSP becomes ready, reconfigure with `reconfigureCompletion()`.
 */
export function completionExtensions() {
  return [completionCompartment.of(createCompletionExtension())];
}

/** Returns the default completion configuration with language-mode fallbacks. */
export function resetCompletion() {
  clearCompletionResolveCache();
  return createCompletionExtension();
}

/**
 * Reconfigures autocomplete to use only the LSP completion source when the
 * matching language server is ready.
 */
export function reconfigureCompletion(filePath: string, triggerCharacters: string[]) {
  const triggerSet = new Set(triggerCharacters);
  const source = createLSPCompletionSource(filePath, triggerSet);
  return createCompletionExtension(source);
}

function createCompletionExtension(source?: CompletionSource) {
  return autocompletion({
    activateOnTyping: true,
    filterStrict: true,
    maxRenderedOptions: 12,
    defaultKeymap: false,
    aboveCursor: true,
    icons: false,
    optionClass: completionOptionClass,
    compareCompletions: compareCompletionOptions,
    addToOptions: [
      {
        render: renderKindIcon,
        position: 20,
      },
      {
        render: renderCompletionTail,
        position: 45,
      },
      {
        render: renderCompletionMeta,
        position: 70,
      },
    ],
    override: source ? [source] : null,
  });
}

export function positionCompletionInfo(
  _view: EditorView,
  list: { left: number; right: number; top: number; bottom: number },
  option: { left: number; right: number; top: number; bottom: number },
  info: { left: number; right: number; top: number; bottom: number },
  space: { left: number; right: number; top: number; bottom: number }
): { style?: string; class?: string } {
  const margin = 10;
  const infoWidth = info.right - info.left;
  const listWidth = list.right - list.left;
  const spaceRight = Math.max(0, space.right - list.right - margin);
  const spaceLeft = Math.max(0, list.left - space.left - margin);
  const optionBottom = Math.max(0, option.bottom - list.top);
  const belowRoom = Math.max(0, space.bottom - option.bottom - margin);

  if (spaceRight >= Math.min(infoWidth, 220)) {
    return {
      style: `left: calc(100% + ${margin}px); top: 0; max-width: ${Math.min(340, spaceRight)}px`,
      class: 'cm-completionInfo-right',
    };
  }

  if (spaceLeft >= Math.min(infoWidth, 220)) {
    return {
      style: `right: calc(100% + ${margin}px); top: 0; max-width: ${Math.min(340, spaceLeft)}px`,
      class: 'cm-completionInfo-left',
    };
  }

  const sharedMaxWidth = Math.min(360, Math.max(240, listWidth - 24));
  const availableHeight = Math.max(140, Math.min(260, belowRoom || space.bottom - space.top - 24));

  return {
    style: `top: ${optionBottom + 6}px; left: 0; max-width: ${Math.min(sharedMaxWidth, space.right - space.left)}px; max-height: ${availableHeight}px`,
    class: 'cm-completionInfo-below-option',
  };
}

// --- Completion Source ---

export function createLSPCompletionSource(
  filePath: string,
  triggerChars: Set<string>
): CompletionSource {
  return async function lspCompletionSource(
    ctx: CompletionContext
  ): Promise<CompletionResult | null> {
    let aborted = ctx.aborted;
    ctx.addEventListener(
      'abort',
      () => {
        aborted = true;
      },
      { onDocChange: true }
    );
    const isAborted = () => aborted || ctx.aborted;

    const { pos, explicit } = ctx;
    const lineText = ctx.state.doc.lineAt(pos);
    const charBefore = pos > lineText.from ? ctx.state.sliceDoc(pos - 1, pos) : '';
    const identifier = ctx.matchBefore(/[\w$]*/);
    const identifierFrom = identifier?.from ?? pos;
    const typedText = ctx.state.sliceDoc(identifierFrom, pos);
    const isPropertyAccess =
      identifierFrom > 0 && ctx.state.sliceDoc(identifierFrom - 1, identifierFrom) === '.';

    let triggerCharacter = '';
    if (!explicit && triggerChars.has(charBefore)) {
      triggerCharacter = charBefore;
    } else if (!explicit) {
      if (!typedText) return null;
    }

    const line = lineText.number - 1;
    const character = pos - lineText.from;

    if (isAborted()) return null;

    let result;
    try {
      await flushLSPDocumentChange(filePath, ctx.state.doc.toString());
      if (isAborted()) return null;
      result = await LSPComplete(filePath, line, character, triggerCharacter);
      if (isAborted()) return null;
    } catch {
      return null;
    }

    if (!result || !result.items || result.items.length === 0) return null;

    const sortedItems = sortLSPCompletionItems(result.items as LSPCompletionItem[]);
    const resolvedItems = await resolveCompletionItems(filePath, sortedItems, isPropertyAccess);
    if (isAborted()) return null;

    const completions: Completion[] = resolvedItems.map((item) => {
      const presentation = completionPresentation(item, isPropertyAccess);
      const completion: FirnCompletion = {
        label: item.label,
        detail: presentation.rightText,
        sortText: item.sortText || item.label,
        boost: completionBoost(item.kind, item.label, typedText, isPropertyAccess),
        firnMeta: presentation.meta,
        firnTail: presentation.tail,
        firnInfoHeader: presentation.infoHeader,
        section: completionSectionForItem(item, isPropertyAccess),
      };

      if (item.kind) {
        completion.firnKind = item.kind;
      }

      const type = completionTypeForKind(item.kind);
      if (type) {
        completion.type = type;
      }

      const insertionText = item.textEdit?.newText ?? item.insertText ?? item.label;
      const isSnippet = item.insertTextFormat === 2;

      if (item.textEdit) {
        const { range } = item.textEdit;
        completion.apply = (
          view: EditorView,
          _completion: Completion,
          _from: number,
          _to: number
        ) => {
          const doc = view.state.doc;
          const startLine = doc.line(range.start.line + 1);
          const endLine = doc.line(range.end.line + 1);
          const editFrom = startLine.from + range.start.character;
          const editTo = endLine.from + range.end.character;

          if (isSnippet) {
            snippet(insertionText)(view, _completion, editFrom, editTo);
          } else {
            view.dispatch({
              changes: { from: editFrom, to: editTo, insert: insertionText },
              selection: { anchor: editFrom + insertionText.length },
            });
          }
        };
      } else if (isSnippet) {
        completion.apply = (
          view: EditorView,
          _completion: Completion,
          from: number,
          to: number
        ) => {
          snippet(insertionText)(view, _completion, from, to);
        };
      } else if (insertionText !== item.label) {
        completion.apply = insertionText;
      }

      return completion;
    });

    const from = identifierFrom;

    return {
      from,
      options: completions,
      // Let CodeMirror filter the LSP list against the currently typed token.
      // This keeps variable/value suggestions responsive and avoids showing the
      // entire server result set for partial identifiers like "uni".
      validFor: result.isIncomplete ? undefined : /^[\w$]*$/,
    };
  };
}

async function resolveCompletionItems(
  filePath: string,
  items: readonly LSPCompletionItem[],
  isPropertyAccess: boolean
): Promise<LSPCompletionItem[]> {
  const resolveLimit = isPropertyAccess ? PROPERTY_ACCESS_RESOLVE_LIMIT : SCOPE_RESOLVE_LIMIT;

  return Promise.all(
    items.map((item, index) => {
      if (index >= resolveLimit || !shouldResolveCompletionItem(item)) {
        return Promise.resolve(item);
      }
      return resolveCompletionItem(filePath, item);
    })
  );
}

function shouldResolveCompletionItem(item: LSPCompletionItem): boolean {
  return item.data !== undefined || (!item.detail && !item.labelDetails?.detail);
}

export async function resolveCompletionItem(
  filePath: string,
  item: LSPCompletionItem
): Promise<LSPCompletionItem> {
  const key = completionResolveKey(filePath, item);
  const cached = completionResolveCache.get(key);
  if (cached) {
    return cached;
  }

  const pending = LSPResolveCompletionItem(
    filePath,
    completionItemForResolve(item) as Parameters<typeof LSPResolveCompletionItem>[1]
  )
    .then((resolved) => ({
      ...item,
      ...(resolved as unknown as LSPCompletionItem),
    }))
    .catch(() => {
      completionResolveCache.delete(key);
      return item;
    });

  completionResolveCache.set(key, pending);
  trimCompletionResolveCache();
  return pending;
}

export function clearCompletionResolveCache(): void {
  completionResolveCache.clear();
}

export function completionResolveCacheSize(): number {
  return completionResolveCache.size;
}

function trimCompletionResolveCache(): void {
  while (completionResolveCache.size > COMPLETION_RESOLVE_CACHE_LIMIT) {
    const oldestKey = completionResolveCache.keys().next().value;
    if (oldestKey === undefined) return;
    completionResolveCache.delete(oldestKey);
  }
}

function completionItemForResolve(item: LSPCompletionItem): LSPCompletionItem {
  const decodedData = decodeRawJSONMessage(item.data);
  const decodedDocumentation = decodeRawJSONMessage(item.documentation);

  if (decodedData === item.data && decodedDocumentation === item.documentation) {
    return item;
  }

  return {
    ...item,
    data: decodedData,
    documentation: decodedDocumentation,
  };
}

function decodeRawJSONMessage(raw: unknown): unknown {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((item) => typeof item === 'number')) {
    return raw;
  }

  try {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(raw));
    return JSON.parse(text);
  } catch {
    return raw;
  }
}

function completionResolveKey(filePath: string, item: LSPCompletionItem): string {
  return [
    filePath,
    item.label,
    item.sortText ?? '',
    item.filterText ?? '',
    serializeCompletionPayload(item.data),
  ].join('\u0000');
}

function serializeCompletionPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

// --- Ordering helpers ---

interface SortableCompletionItem {
  label: string;
  sortText?: string;
}

export function sortLSPCompletionItems<T extends SortableCompletionItem>(items: readonly T[]): T[] {
  return [...items].sort(compareLSPCompletionItems);
}

function compareLSPCompletionItems(a: SortableCompletionItem, b: SortableCompletionItem): number {
  const internalDelta =
    Number(isInternalCompletionLabel(a.label)) - Number(isInternalCompletionLabel(b.label));
  if (internalDelta !== 0) return internalDelta;
  return (a.sortText || a.label).localeCompare(b.sortText || b.label);
}

function compareCompletionOptions(a: Completion, b: Completion): number {
  const internalDelta =
    Number(isInternalCompletionLabel(a.label)) - Number(isInternalCompletionLabel(b.label));
  if (internalDelta !== 0) return internalDelta;
  return (a.sortText || a.label).localeCompare(b.sortText || b.label);
}

function createCompletionSection(name: string, rank: number): CompletionSection {
  return {
    name,
    rank,
    header: (section) => {
      const el = document.createElement('completion-section');
      el.className = 'firn-completion-section';
      el.textContent = section.name;
      return el;
    },
  };
}

function completionSectionForItem(
  item: Pick<LSPCompletionItem, 'detail' | 'kind' | 'labelDetails'>,
  isPropertyAccess = false
): Completion['section'] | undefined {
  if (isPropertyAccess) {
    return COMPLETION_SECTIONS.members;
  }
  const sourceDescription = item.labelDetails?.description ?? item.detail;
  if (item.kind === 15) {
    return COMPLETION_SECTIONS.snippets;
  }
  if (item.kind === 14 || item.kind === 24) {
    return COMPLETION_SECTIONS.keywords;
  }
  if (looksLikeImportPath(sourceDescription)) {
    return COMPLETION_SECTIONS.imports;
  }
  if (isTypeishCompletionKind(item.kind)) {
    return COMPLETION_SECTIONS.types;
  }
  return COMPLETION_SECTIONS.scope;
}

function completionBoost(
  kind: number | undefined,
  label: string,
  typedText: string,
  isPropertyAccess: boolean
): number {
  let boost = isInternalCompletionLabel(label) ? -8 : 0;

  if (!typedText) {
    return boost;
  }

  if (label === typedText) {
    boost += 8;
  } else if (label.startsWith(typedText)) {
    boost += 4;
  }

  if (isPropertyAccess) {
    if (kind === 2 || kind === 5 || kind === 6 || kind === 10 || kind === 12 || kind === 21) {
      boost += 3;
    }
    if (kind === 3 || kind === 7 || kind === 8 || kind === 9 || kind === 14 || kind === 15) {
      boost -= 4;
    }
  } else {
    if (kind === 6 || kind === 13 || kind === 21) {
      boost += 2;
    }
    if (kind === 4 || kind === 7 || kind === 8 || kind === 9 || kind === 25) {
      boost -= 1;
    }
  }

  return Math.max(-99, Math.min(99, boost));
}

function isInternalCompletionLabel(label: string): boolean {
  return /^_{1,2}[A-Za-z0-9]/.test(label) || label === '_';
}

function completionOptionClass(completion: Completion): string {
  const classes = ['firn-completion-option'];
  if (isInternalCompletionLabel(completion.label)) {
    classes.push('firn-completion-option-internal');
  }

  const tone = completionVisualTone(
    (completion as FirnCompletion).firnKind,
    (completion as FirnCompletion).firnMeta,
    completion.label
  );
  if (tone) {
    classes.push(`firn-completion-option-${tone}`);
  }
  return classes.join(' ');
}

function completionVisualTone(kind?: number, meta?: string, label?: string): string | undefined {
  if (looksLikeConstantLabel(label) && kind !== 14 && kind !== 24 && !looksLikeImportPath(meta)) {
    return 'constant';
  }
  if (kind === 2 || kind === 3) {
    return 'callable';
  }
  if (kind === 5 || kind === 10 || kind === 12) {
    return 'member';
  }
  if (kind === 6) {
    return 'value';
  }
  if (kind === 4 || kind === 7 || kind === 8 || kind === 22 || kind === 25) {
    return 'type';
  }
  if (kind === 13 || kind === 20 || kind === 21) {
    return 'constant';
  }
  if (kind === 9 || looksLikeImportPath(meta)) {
    return 'import';
  }
  if (kind === 14 || kind === 24) {
    return 'keyword';
  }
  return undefined;
}

// --- Kind Icons (built with safe DOM methods, no innerHTML) ---

const KIND_ICONS: Record<number, { letter: string; color: string }> = {
  2: { letter: 'M', color: '#FDA4AF' },
  3: { letter: 'F', color: '#7DD3FC' },
  4: { letter: 'N', color: '#FDE68A' },
  5: { letter: 'f', color: '#94A3B8' },
  6: { letter: 'V', color: '#C4B5FD' },
  7: { letter: 'C', color: '#FCD34D' },
  8: { letter: 'I', color: '#86EFAC' },
  9: { letter: 'm', color: '#38BDF8' },
  10: { letter: 'P', color: '#94A3B8' },
  13: { letter: 'E', color: '#F9A8D4' },
  20: { letter: 'e', color: '#F9A8D4' },
  14: { letter: 'K', color: '#FDBA74' },
  15: { letter: 'S', color: '#A5B4FC' },
  21: { letter: 'c', color: '#67E8F9' },
  22: { letter: 'S', color: '#67E8F9' },
  24: { letter: 'O', color: '#93C5FD' },
  25: { letter: 'T', color: '#FDA4AF' },
};

function completionKindLabel(kind?: number): string | undefined {
  switch (kind) {
    case 2:
      return 'method';
    case 3:
      return 'function';
    case 4:
      return 'constructor';
    case 5:
      return 'field';
    case 6:
      return 'variable';
    case 7:
      return 'class';
    case 8:
      return 'interface';
    case 9:
      return 'module';
    case 10:
      return 'property';
    case 12:
      return 'value';
    case 13:
      return 'enum';
    case 14:
      return 'keyword';
    case 15:
      return 'snippet';
    case 20:
      return 'enum member';
    case 21:
      return 'constant';
    case 22:
      return 'struct';
    case 24:
      return 'operator';
    case 25:
      return 'type parameter';
    default:
      return undefined;
  }
}

function completionPresentation(
  item: Pick<LSPCompletionItem, 'label' | 'kind' | 'detail' | 'labelDetails' | 'documentation'>,
  isPropertyAccess = false
): CompletionPresentation {
  const parsed = parseResolvedCompletionDetail(item.label, item.detail);
  const labelTail = normalizeCompletionText(item.labelDetails?.detail, 72);
  const normalizedDetail = normalizeCompletionText(item.detail, 120);
  const sourceDescription = normalizeCompletionText(item.labelDetails?.description);
  const rightText = parsed.rightText ?? completionRightTextFallback(item.kind);
  const tail = labelTail ?? parsed.tail;

  return {
    tail,
    rightText,
    meta: completionMetaText({
      detail: item.detail,
      documentation: item.documentation,
      kind: item.kind,
      isPropertyAccess,
      parsed,
      sourceDescription,
    }),
    infoHeader:
      normalizedDetail ??
      normalizeCompletionText(
        [completionKindLabel(item.kind), tail, rightText ? `: ${rightText}` : '']
          .filter(Boolean)
          .join(' '),
        120
      ),
  };
}

export function parseResolvedCompletionDetail(
  label: string,
  detail?: string
): ParsedCompletionDetail {
  const normalizedDetail = normalizeCompletionText(detail, 160);
  if (!normalizedDetail || looksLikeImportPath(normalizedDetail)) {
    return {};
  }

  let remainder = normalizedDetail.replace(/^\(([^)]+)\)\s*/, '');
  if (remainder.startsWith(label)) {
    remainder = remainder.slice(label.length).trim();
  }

  if (!remainder) {
    return {};
  }

  if (remainder.startsWith(':')) {
    return {
      rightText: normalizeCompletionText(remainder.slice(1).trim(), 52),
    };
  }

  if (!remainder.startsWith('(') && !remainder.startsWith('<')) {
    return {};
  }

  const { head, type } = splitResolvedTypeSuffix(remainder);
  return {
    tail: normalizeCompletionText(head, 72),
    rightText: normalizeCompletionText(type, 52),
  };
}

function splitResolvedTypeSuffix(text: string): { head: string; type?: string } {
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;

  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];

    if (char === ')') parens += 1;
    if (char === '(') parens -= 1;
    if (char === ']') brackets += 1;
    if (char === '[') brackets -= 1;
    if (char === '}') braces += 1;
    if (char === '{') braces -= 1;
    if (char === '>') angles += 1;
    if (char === '<') angles -= 1;

    if (char === ':' && parens === 0 && brackets === 0 && braces === 0 && angles === 0) {
      return {
        head: text.slice(0, index).trim(),
        type: text.slice(index + 1).trim() || undefined,
      };
    }
  }

  return { head: text.trim() };
}

function completionMetaText({
  detail,
  documentation,
  kind,
  isPropertyAccess = false,
  parsed,
  sourceDescription,
}: {
  detail?: string;
  documentation?: unknown;
  kind?: number;
  isPropertyAccess?: boolean;
  parsed: ParsedCompletionDetail;
  sourceDescription?: string;
}): string | undefined {
  if (sourceDescription) {
    return sourceDescription;
  }

  const normalizedDetail = normalizeCompletionText(detail);
  if (normalizedDetail && looksLikeImportPath(normalizedDetail)) {
    return normalizedDetail;
  }

  const docsPreview = completionDocumentationPreview(documentation);
  if (docsPreview) {
    return docsPreview;
  }

  if (normalizedDetail && !parsed.tail && !parsed.rightText) {
    return normalizedDetail;
  }

  if (parsed.tail || parsed.rightText) {
    return undefined;
  }

  return completionKindDescription(kind, isPropertyAccess);
}

function completionRightTextFallback(kind?: number): string | undefined {
  switch (kind) {
    case 4:
    case 7:
    case 8:
    case 13:
    case 22:
    case 25:
      return completionKindLabel(kind);
    default:
      return undefined;
  }
}

function completionKindDescription(kind?: number, isPropertyAccess = false): string | undefined {
  switch (kind) {
    case 2:
      return isPropertyAccess ? 'Method on this value' : 'Method available here';
    case 3:
      return 'Function available in scope';
    case 4:
      return isPropertyAccess ? 'Constructor exposed on this value' : 'Constructor available here';
    case 5:
    case 10:
      return isPropertyAccess ? 'Property on this value' : 'Object member';
    case 6:
    case 12:
      return isPropertyAccess ? 'Value on this object' : 'Value available in scope';
    case 7:
      return isPropertyAccess ? 'Class exposed on this value' : 'Class available in scope';
    case 8:
      return 'Interface definition';
    case 9:
      return 'Module or namespace';
    case 13:
      return 'Enum type';
    case 14:
      return 'Language keyword';
    case 15:
      return 'Snippet template';
    case 20:
      return 'Enum member';
    case 21:
      return isPropertyAccess ? 'Constant member on this value' : 'Constant value';
    case 22:
      return 'Structured type';
    case 24:
      return 'Operator keyword';
    case 25:
      return 'Type parameter';
    default:
      return undefined;
  }
}

function normalizeCompletionText(text?: string, maxLength = 88): string | undefined {
  if (!text) return undefined;

  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;

  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}…` : compact;
}

function completionDocumentationPreview(raw?: unknown): string | undefined {
  const content = decodeLSPContent(raw);
  const firstLine = content?.value
    .replace(/```[\w-]*\n?/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return normalizeCompletionText(firstLine);
}

function isTypeishCompletionKind(kind?: number): boolean {
  return (
    kind === 4 ||
    kind === 7 ||
    kind === 8 ||
    kind === 13 ||
    kind === 20 ||
    kind === 22 ||
    kind === 25
  );
}

function looksLikeImportPath(text?: string): boolean {
  if (!text) return false;
  return (
    text.includes('/') ||
    text.startsWith('./') ||
    text.startsWith('../') ||
    /^@?[\w.-]+(?:\/[\w.-]+)+$/.test(text)
  );
}

function looksLikeConstantLabel(label?: string): boolean {
  return Boolean(label && /^[A-Z][A-Z0-9_]{2,}$/.test(label));
}

function completionTypeForKind(kind?: number): Completion['type'] | undefined {
  switch (kind) {
    case 2:
      return 'method';
    case 3:
      return 'function';
    case 4:
      return 'class';
    case 5:
    case 10:
    case 12:
      return 'property';
    case 6:
      return 'variable';
    case 7:
      return 'class';
    case 8:
      return 'interface';
    case 9:
      return 'namespace';
    case 13:
    case 20:
    case 21:
      return 'constant';
    case 14:
      return 'keyword';
    case 15:
      return 'snippet';
    case 22:
    case 25:
      return 'type';
    default:
      return undefined;
  }
}

function createKindSvg(config: { letter: string; color: string }): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '2');
  rect.setAttribute('y', '2');
  rect.setAttribute('width', '12');
  rect.setAttribute('height', '12');
  rect.setAttribute('rx', '3');
  rect.setAttribute('fill', config.color);
  rect.setAttribute('opacity', '0.12');
  rect.setAttribute('stroke', config.color);
  rect.setAttribute('stroke-opacity', '0.35');
  svg.appendChild(rect);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', '8');
  text.setAttribute('y', '10.9');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-size', '8.5');
  text.setAttribute('font-weight', '600');
  text.setAttribute('font-family', 'monospace');
  text.setAttribute('fill', config.color);
  text.textContent = config.letter;
  svg.appendChild(text);

  return svg;
}

function createFallbackSvg(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');

  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '2.75');
  circle.setAttribute('fill', '#475569');
  svg.appendChild(circle);

  return svg;
}

export function renderKindIcon(completion: Completion): HTMLElement | null {
  const kind = (completion as FirnCompletion).firnKind;

  const span = document.createElement('span');
  span.className = 'firn-completion-icon';
  span.setAttribute('aria-hidden', 'true');

  const config = kind ? KIND_ICONS[kind] : undefined;
  span.appendChild(config ? createKindSvg(config) : createFallbackSvg());

  return span;
}

function renderCompletionTail(completion: Completion): HTMLElement | null {
  const tail = (completion as FirnCompletion).firnTail;
  if (!tail) return null;

  const span = document.createElement('span');
  span.className = 'firn-completion-tail';
  span.textContent = tail;
  return span;
}

function renderCompletionMeta(completion: Completion): HTMLElement | null {
  const meta = (completion as FirnCompletion).firnMeta;
  if (!meta) return null;

  const span = document.createElement('span');
  span.className = looksLikeImportPath(meta)
    ? 'firn-completion-meta firn-completion-meta-source'
    : 'firn-completion-meta';
  span.textContent = meta;
  return span;
}
