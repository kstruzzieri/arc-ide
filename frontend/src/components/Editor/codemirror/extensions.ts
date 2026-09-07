/**
 * CodeMirror 6 Extensions Configuration
 *
 * Provides a modular set of editor extensions organized by functionality.
 * Each function returns extensions that can be composed based on requirements.
 */

import { Extension, Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  lineNumbers,
  highlightActiveLineGutter,
  placeholder as placeholderExtension,
  tooltips,
  type Rect,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  defaultHighlightStyle,
  indentUnit,
} from '@codemirror/language';
import {
  acceptCompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { inFileSearchExtensions, inFileSearchKeymap } from './search';
import { gitGutterExtension } from './gitGutter';
export { inFileSearchKeymap } from './search';

import { buildTheme } from './theme';
import { type SyntaxThemeId, DEFAULT_SYNTAX_THEME_ID } from './palettes';
import { diagnosticsExtensions } from './diagnostics';
import { completionExtensions } from './completion';
import { hoverExtensions } from './hover';
import { definitionExtensions } from './definition';
import { pythonHighlightExtensions } from './pythonHighlight';
export { getLanguageName } from '../../../utils/editorLanguage';

/**
 * Compartments for dynamic extension reconfiguration.
 * Allows changing language, theme, etc. without recreating the editor.
 */
export const languageCompartment = new Compartment();
export const themeCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const tabSizeCompartment = new Compartment();

/**
 * Core editing extensions - essential functionality.
 */
export function coreExtensions(): Extension[] {
  return [
    // Line numbers and gutter
    lineNumbers(),
    highlightActiveLineGutter(),

    // Special character visualization
    highlightSpecialChars(),

    // Undo/redo
    history(),

    // Code folding
    foldGutter({
      openText: '▾',
      closedText: '▸',
    }),

    // Selection rendering
    drawSelection(),
    dropCursor(),

    // Multi-cursor support
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),

    // Active line highlighting
    highlightActiveLine(),

    // Bracket matching
    bracketMatching(),

    // Auto-indent on input
    indentOnInput(),

    // Default syntax highlighting (fallback)
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ];
}

/**
 * Autocomplete and bracket extensions.
 */
export function autocompleteExtensions(): Extension[] {
  return [closeBrackets()];
}

/**
 * Search and selection extensions. Delegates to `inFileSearchExtensions()` so
 * the actual `@codemirror/search` wiring can live in `./search` (and stay
 * unit-testable without dragging in the LSP/completion/hover graph) while
 * preserving the historical function name used elsewhere in the editor stack.
 */
export function searchExtensions(): Extension[] {
  return inFileSearchExtensions();
}

/**
 * Keymap extensions - all keyboard shortcuts.
 */
export const editorKeybindings = [
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...inFileSearchKeymap,
  ...historyKeymap,
  ...foldKeymap,
  ...completionKeymap,
  ...lintKeymap,
  { key: 'Tab', run: acceptCompletion },
  indentWithTab,
];

export function keymapExtensions(): Extension[] {
  return [keymap.of(editorKeybindings)];
}

/**
 * Editor behavior extensions.
 */
export function behaviorExtensions(): Extension[] {
  return [
    // 2-space indentation by default
    indentUnit.of('  '),

    // Wrap long lines
    EditorView.lineWrapping,

    // Mount hover/completion tooltips outside the editor container so they
    // aren't clipped by split panes or overflow-hidden wrappers. Constrain
    // their available space to the visible editor viewport so panels such as
    // the bottom terminal don't end up covering the lower portion.
    tooltips({
      parent: typeof document === 'undefined' ? undefined : document.body,
      tooltipSpace: editorTooltipSpace,
    }),

    // Update listener for content changes
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        // Content changed - can trigger save indicator, etc.
      }
    }),
  ];
}

export function editorTooltipSpace(view: EditorView): Rect {
  const rect = view.scrollDOM.getBoundingClientRect();
  const insetX = 4;
  const insetY = 6;

  return {
    top: rect.top + insetY,
    left: rect.left + insetX,
    right: Math.max(rect.left + insetX, rect.right - insetX),
    bottom: Math.max(rect.top + insetY, rect.bottom - insetY),
  };
}

/**
 * Creates a placeholder extension for empty documents.
 */
export function placeholderText(text: string): Extension {
  return placeholderExtension(text);
}

/**
 * Creates a read-only extension.
 */
export function readOnly(isReadOnly: boolean): Extension {
  return EditorView.editable.of(!isReadOnly);
}

/**
 * Creates a tab size extension.
 */
export function tabSize(size: number): Extension {
  return indentUnit.of(' '.repeat(size));
}

/**
 * Complete editor setup with all standard extensions.
 * This is the recommended way to initialize the editor.
 */
export function createEditorExtensions(options: {
  filename: string;
  filePath: string;
  readOnly?: boolean;
  tabSize?: number;
  placeholder?: string;
  syntaxThemeId?: SyntaxThemeId;
  onChange?: (content: string) => void;
  onCursorChange?: (line: number, column: number) => void;
}): Extension[] {
  const {
    filename,
    filePath,
    readOnly: isReadOnly = false,
    tabSize: tabs = 2,
    placeholder,
    syntaxThemeId = DEFAULT_SYNTAX_THEME_ID,
    onChange,
    onCursorChange,
  } = options;

  const fileExt = filename.split('.').pop()?.toLowerCase();
  const isPython = fileExt === 'py' || fileExt === 'pyw' || fileExt === 'pyi';

  const extensions: Extension[] = [
    // Theme
    themeCompartment.of(buildTheme(syntaxThemeId)),

    // Core functionality
    ...coreExtensions(),

    // Autocomplete
    ...autocompleteExtensions(),

    // Search
    ...searchExtensions(),

    // Keymaps
    ...keymapExtensions(),

    // Behavior
    ...behaviorExtensions(),

    // Git change markers (dormant until a baseline is dispatched)
    gitGutterExtension(),

    // Tab size
    tabSizeCompartment.of(tabSize(tabs)),

    // Read-only mode
    readOnlyCompartment.of(readOnly(isReadOnly)),

    // Language (in compartment for dynamic switching)
    languageCompartment.of([]),

    // Python-only semantic overlay (self/cls, builtins, decorator names)
    ...(isPython ? [pythonHighlightExtensions()] : []),

    // Diagnostics (lint gutter + underlines, populated dynamically)
    ...diagnosticsExtensions(),

    // LSP Completion (compartment, initially empty)
    ...completionExtensions(),

    // LSP Hover (compartment, initially empty)
    ...hoverExtensions(),

    // LSP Definition (F12, Cmd+Click, back/forward)
    ...definitionExtensions(filePath),
  ];

  // Optional placeholder
  if (placeholder) {
    extensions.push(placeholderText(placeholder));
  }

  // Content change callback
  if (onChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      })
    );
  }

  // Cursor position change callback
  if (onCursorChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          onCursorChange(line.number, pos - line.from + 1);
        }
      })
    );
  }

  return extensions;
}

/** Reconfigures a live editor's theme compartment to the given syntax theme. */
export function applyEditorTheme(view: EditorView, id: SyntaxThemeId): void {
  view.dispatch({ effects: themeCompartment.reconfigure(buildTheme(id)) });
}
