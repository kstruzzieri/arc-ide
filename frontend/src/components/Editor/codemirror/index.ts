/**
 * CodeMirror 6 Integration for Firn IDE
 *
 * Re-exports all CodeMirror utilities and components for use throughout the app.
 */

// Theme
export {
  firnGlacier,
  firnGlacierTheme,
  firnGlacierHighlightStyle,
  buildTheme,
  buildSyntaxTheme,
  buildChrome,
  buildHighlightStyle,
  defaultEditorTheme,
} from './theme';
export {
  SYNTAX_THEMES,
  SYNTAX_THEME_BY_ID,
  DEFAULT_SYNTAX_THEME_ID,
  isSyntaxThemeId,
  getSyntaxPalette,
  type SyntaxThemeId,
  type SyntaxPalette,
  type SyntaxThemeDefinition,
} from './palettes';

// Extensions and utilities
export {
  createEditorExtensions,
  applyEditorTheme,
  getLanguageName,
  languageCompartment,
  themeCompartment,
  readOnlyCompartment,
  tabSizeCompartment,
  coreExtensions,
  autocompleteExtensions,
  searchExtensions,
  inFileSearchKeymap,
  keymapExtensions,
  behaviorExtensions,
  placeholderText,
  readOnly,
  tabSize,
} from './extensions';
export { loadLanguageSupport } from './languages';

// Diagnostics
export { updateEditorDiagnostics, lspToCMDiagnostics, diagnosticsCompartment } from './diagnostics';

// Completion
export { completionCompartment, reconfigureCompletion, resetCompletion } from './completion';

// Hover
export { hoverCompartment, reconfigureHover } from './hover';

// Definition
export { definitionExtensions } from './definition';

// Document reconciliation (non-undoable external content sync)
export { reconcileDoc } from './reconcileDoc';

// Merge resolution Result-spine editor
export {
  changedRegionIndexes,
  createMergeResolutionEditor,
  markerBlockRange,
  markerBlockRanges,
  nextUnresolved,
  resolutionLines,
  type MarkerBlockRange,
  type MappedMergeRegion,
  type MergeChoice,
  type MergeDirection,
  type MergeOrder,
  type MergeResolutionEditor,
  type MergeResolutionState,
  type ResolutionRefusalHandler,
} from './mergeResolution';

// Re-export commonly used CodeMirror types
export { EditorView } from '@codemirror/view';
export { EditorState, type Extension } from '@codemirror/state';

// Git change gutter
export {
  gitGutterExtension,
  setGitBaseline,
  gotoNextGitChange,
  gotoPrevGitChange,
} from './gitGutter';
