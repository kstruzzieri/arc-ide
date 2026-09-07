import { Compartment } from '@codemirror/state';
import { hoverTooltip, type EditorView, type Tooltip } from '@codemirror/view';
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { LSPHover, LSPDefinition } from '../../../wails/bindings';
import { BrowserOpenURL, ClipboardSetText } from '../../../wails/runtime';
import { getLoadedLanguageSupport } from './languages';
import { decodeLSPContent } from '../../../utils/lspContent';
import { fileURIToPath } from '../../../utils/lspUri';
import { navigateToEditorLocation } from '../../../utils/editorNavigation';
import { useIDEStore } from '../../../stores/ideStore';
import { flushLSPDocumentChange } from '../../../utils/lspDocumentSync';

/** Compartment for the LSP hover tooltip. Empty when no LSP is active. */
export const hoverCompartment = new Compartment();

export function hoverExtensions() {
  return [hoverCompartment.of([])];
}

export function reconfigureHover(filePath: string) {
  return hoverTooltip(createLSPHoverSource(filePath), {
    hideOn: (tr) => tr.docChanged,
    hoverTime: 180,
  });
}

export function createLSPHoverSource(filePath: string) {
  return async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    const requestDoc = view.state.doc;
    const wordRange = view.state.wordAt(pos) ?? (pos > 0 ? view.state.wordAt(pos - 1) : null);
    const targetRange = hoverTargetRange(wordRange, pos);
    if (!targetRange) return null;
    const requestPos = hoverRequestPos(targetRange, pos);

    const line = view.state.doc.lineAt(requestPos);
    const lspLine = line.number - 1;
    const lspChar = requestPos - line.from;

    let result;
    try {
      await flushLSPDocumentChange(filePath);
      if (view.state.doc !== requestDoc) return null;
      result = await LSPHover(filePath, lspLine, lspChar);
      if (view.state.doc !== requestDoc) return null;
    } catch {
      return null;
    }

    if (!result || !result.contents) return null;

    const content = decodeLSPContent(result.contents);
    if (!content) return null;

    return {
      pos: targetRange.from,
      end: targetRange.to,
      above: true,
      create: () => {
        const dom = createHoverTooltipDOM(content.value, filePath, lspLine, lspChar);
        return { dom };
      },
    };
  };
}

export function hoverTargetRange(
  wordRange: { from: number; to: number } | null,
  _pos: number
): { from: number; to: number } | null {
  if (!wordRange) return null;
  return {
    from: wordRange.from,
    to: wordRange.to,
  };
}

export function hoverRequestPos(targetRange: { from: number; to: number }, pos: number): number {
  return Math.min(Math.max(pos, targetRange.from), Math.max(targetRange.from, targetRange.to - 1));
}

function createHoverTooltipDOM(
  rawContent: string,
  filePath: string,
  line: number,
  character: number
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'firn-hover-tooltip';

  const { signature, docs } = splitSignatureAndDocs(rawContent);

  if (signature) {
    const sigDiv = document.createElement('div');
    sigDiv.className = 'firn-hover-signature';
    renderHighlightedSignature(sigDiv, signature, filePath);
    container.appendChild(sigDiv);
  }

  if (signature && docs) {
    const sep = document.createElement('div');
    sep.className = 'firn-hover-separator';
    container.appendChild(sep);
  }

  if (docs) {
    const docsDiv = document.createElement('div');
    docsDiv.className = 'firn-hover-docs';
    renderDocumentation(docsDiv, docs);
    container.appendChild(docsDiv);
  }

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'firn-hover-actions';

  const goToDef = document.createElement('a');
  goToDef.className = 'firn-hover-action';
  goToDef.textContent = 'Go to Definition';
  goToDef.href = '#';
  goToDef.addEventListener('click', (e) => {
    e.preventDefault();
    flushLSPDocumentChange(filePath)
      .then(() => LSPDefinition(filePath, line, character))
      .then((locations) => {
        if (!locations || locations.length === 0) return;
        const loc = locations[0];
        const path = fileURIToPath(loc.uri);
        if (path) {
          // Push current position so Back works after hover-initiated navigation
          useIDEStore.getState().pushNavigationHistory({
            fileId: filePath,
            line: line + 1, // Convert LSP 0-based to 1-based
            column: character + 1,
          });
          navigateToEditorLocation(path, loc.range.start.line + 1, loc.range.start.character + 1);
        }
      })
      .catch(() => {
        // Non-critical: user clicked "Go to Definition" in tooltip
      });
  });
  actionsDiv.appendChild(goToDef);

  const copyType = document.createElement('a');
  copyType.className = 'firn-hover-action';
  copyType.textContent = 'Copy Type';
  copyType.href = '#';
  copyType.addEventListener('click', (e) => {
    e.preventDefault();
    void ClipboardSetText(signature || rawContent).catch(() => {});
  });
  actionsDiv.appendChild(copyType);

  container.appendChild(actionsDiv);

  return container;
}

function splitSignatureAndDocs(content: string): { signature: string; docs: string } {
  const codeBlockMatch = content.match(/^```[\w]*\n([\s\S]*?)```\n?([\s\S]*)$/);
  if (codeBlockMatch) {
    return {
      signature: codeBlockMatch[1].trim(),
      docs: codeBlockMatch[2].trim(),
    };
  }

  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1) {
    return { signature: content, docs: '' };
  }
  return {
    signature: content.slice(0, firstNewline).trim(),
    docs: content.slice(firstNewline + 1).trim(),
  };
}

export interface SignatureHighlightPart {
  text: string;
  className: string;
}

const HIGHLIGHT_RULES: Array<{ pattern: RegExp; className: string }> = [
  {
    pattern:
      /\b(const|let|var|function|class|type|interface|enum|import|export|from|extends|implements|return|if|else|for|while|new|async|await|readonly|static|public|private|protected|abstract|declare|namespace|module)\b/g,
    className: 'firn-hover-keyword',
  },
  {
    pattern: /\b[A-Z][A-Z0-9_]{2,}\b/g,
    className: 'firn-hover-constant',
  },
  {
    pattern: /(?<=\b(?:const|let|var)\s+)\b[A-Za-z_$][\w$]*\b/g,
    className: 'firn-hover-variable',
  },
  {
    pattern: /(?<![\w$])[a-z_$][\w$]*(?=\s*:)/g,
    className: 'firn-hover-variable',
  },
  {
    pattern:
      /(?<=:\s*|\|\s*|<|,\s*)\b(string|number|boolean|void|undefined|null|unknown|never|any|object|symbol|bigint)\b/g,
    className: 'firn-hover-type',
  },
  { pattern: /(?<=:\s*|<|,\s*)\b[A-Z]\w*/g, className: 'firn-hover-type' },
  { pattern: /\b\w+(?=\s*\()/g, className: 'firn-hover-function' },
  { pattern: /(["'`])(?:(?!\1).)*\1/g, className: 'firn-hover-string' },
  // eslint-disable-next-line no-useless-escape
  { pattern: /[{}()\[\]<>:;,=&|?!.]/g, className: 'firn-hover-punctuation' },
];

/**
 * Maps Lezer highlight tags to the hover's `firn-hover-*` color classes (which
 * carry palette colors via CSS). Using the real language parser instead of the
 * TypeScript-only regex rules highlights every supported language — most
 * visibly Go, whose `func`/space-separated types the regex never matched.
 */
const hoverHighlighter = tagHighlighter([
  { tag: t.keyword, class: 'firn-hover-keyword' },
  { tag: t.controlKeyword, class: 'firn-hover-keyword' },
  { tag: t.definitionKeyword, class: 'firn-hover-keyword' },
  { tag: t.moduleKeyword, class: 'firn-hover-keyword' },
  { tag: t.modifier, class: 'firn-hover-keyword' },
  { tag: t.typeName, class: 'firn-hover-type' },
  { tag: t.className, class: 'firn-hover-type' },
  { tag: t.namespace, class: 'firn-hover-type' },
  { tag: t.standard(t.typeName), class: 'firn-hover-type' },
  { tag: t.function(t.variableName), class: 'firn-hover-function' },
  { tag: t.function(t.definition(t.variableName)), class: 'firn-hover-function' },
  { tag: t.function(t.propertyName), class: 'firn-hover-function' },
  { tag: t.propertyName, class: 'firn-hover-variable' },
  { tag: t.variableName, class: 'firn-hover-variable' },
  { tag: t.string, class: 'firn-hover-string' },
  { tag: t.special(t.string), class: 'firn-hover-string' },
  { tag: t.number, class: 'firn-hover-constant' },
  { tag: t.bool, class: 'firn-hover-constant' },
  { tag: t.atom, class: 'firn-hover-constant' },
  { tag: t.comment, class: 'firn-hover-punctuation' },
  { tag: t.operator, class: 'firn-hover-punctuation' },
  { tag: t.punctuation, class: 'firn-hover-punctuation' },
  { tag: t.paren, class: 'firn-hover-punctuation' },
  { tag: t.brace, class: 'firn-hover-punctuation' },
  { tag: t.bracket, class: 'firn-hover-punctuation' },
  { tag: t.separator, class: 'firn-hover-punctuation' },
]);

/** Per-character class array via the real Lezer parser for `filename`'s
 * language, or null when the extension has no registered language. */
function parserCharStyles(text: string, filename: string): string[] | null {
  const support = getLoadedLanguageSupport(filename);
  if (!support) return null;
  const tree = support.language.parser.parse(text);
  const charStyles: string[] = new Array(text.length).fill('');
  highlightTree(tree, hoverHighlighter, (from, to, classes) => {
    for (let i = from; i < to; i++) charStyles[i] = classes;
  });
  return charStyles;
}

/** Per-character class array from the TypeScript-oriented regex rules. */
function regexCharStyles(text: string): string[] {
  const charStyles: string[] = new Array(text.length).fill('');
  for (const rule of HIGHLIGHT_RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      for (let i = match.index; i < match.index + match[0].length; i++) {
        if (!charStyles[i]) {
          charStyles[i] = rule.className;
        }
      }
    }
  }
  return charStyles;
}

export function highlightSignatureParts(text: string, filename?: string): SignatureHighlightPart[] {
  const charStyles = (filename && parserCharStyles(text, filename)) || regexCharStyles(text);

  const parts: SignatureHighlightPart[] = [];
  let currentClass = charStyles[0] || '';
  let currentText = text[0] || '';

  for (let i = 1; i < text.length; i++) {
    const cls = charStyles[i] || '';
    if (cls === currentClass) {
      currentText += text[i];
    } else {
      parts.push({ text: currentText, className: currentClass });
      currentClass = cls;
      currentText = text[i];
    }
  }
  if (currentText) {
    parts.push({ text: currentText, className: currentClass });
  }

  return parts;
}

function renderHighlightedSignature(container: HTMLElement, text: string, filename: string): void {
  const pre = document.createElement('pre');
  pre.className = 'firn-hover-code';

  for (const part of highlightSignatureParts(text, filename)) {
    appendSpan(pre, part.text, part.className);
  }

  container.appendChild(pre);
}

function appendSpan(parent: HTMLElement, text: string, className: string): void {
  if (className) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
  } else {
    parent.appendChild(document.createTextNode(text));
  }
}

function renderDocumentation(container: HTMLElement, text: string): void {
  const parts = text.split(/(```[\w]*\n[\s\S]*?```)/g);

  for (const part of parts) {
    const codeMatch = part.match(/^```[\w]*\n([\s\S]*?)```$/);
    if (codeMatch) {
      const pre = document.createElement('pre');
      pre.className = 'firn-hover-doc-code';
      pre.textContent = codeMatch[1].trim();
      container.appendChild(pre);
    } else if (part.trim()) {
      const p = document.createElement('div');
      p.className = 'firn-hover-doc-text';
      renderDocText(p, part.trim());
      container.appendChild(p);
    }
  }
}

export interface DocSegment {
  text: string;
  /** Present when the segment is a link (markdown `[text](url)` or a bare URL). */
  url?: string;
}

const DOC_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/g;

/** Splits documentation text into plain and link segments so gopls-style
 * `[name](https://pkg.go.dev/...)` references render as clickable links. */
export function splitDocLinks(text: string): DocSegment[] {
  const segments: DocSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  DOC_LINK_RE.lastIndex = 0;
  while ((match = DOC_LINK_RE.exec(text)) !== null) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    const url = match[2] ?? match[3];
    const label = match[1] ?? match[3];
    segments.push({ text: label, url });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

/** Appends `text` to `container`, rendering embedded links as anchors that open
 * externally via the Wails runtime. */
function appendTextWithLinks(container: HTMLElement, text: string): void {
  for (const segment of splitDocLinks(text)) {
    if (segment.url) {
      const link = document.createElement('a');
      link.className = 'firn-hover-link';
      link.textContent = segment.text;
      link.href = segment.url;
      const url = segment.url;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        BrowserOpenURL(url);
      });
      container.appendChild(link);
    } else {
      container.appendChild(document.createTextNode(segment.text));
    }
  }
}

function renderDocText(container: HTMLElement, text: string): void {
  // Collapse runs of blank lines to one — gopls docs are padded with them,
  // which otherwise leave large empty gaps in the tooltip.
  const lines = collapseBlankRuns(text.split('\n'));
  for (const line of lines) {
    const tagMatch = line.match(/^(\s*@\w+)/);
    if (tagMatch) {
      const span = document.createElement('span');
      span.className = 'firn-hover-doc-tag';
      span.textContent = tagMatch[1];
      container.appendChild(span);
      appendTextWithLinks(container, line.slice(tagMatch[1].length));
    } else {
      appendTextWithLinks(container, line);
    }
    container.appendChild(document.createTextNode('\n'));
  }
}

/** Collapses consecutive blank lines to a single one and trims leading/trailing
 * blanks, so documentation renders compactly. */
export function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}
