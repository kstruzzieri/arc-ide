import type { search } from '../wails/bindings';

export type MatchRange = Pick<search.MatchRange, 'start' | 'end'>;

export interface LineMatch {
  line: number;
  column: number;
  text: string;
  submatches: MatchRange[];
}

export interface FileResult {
  path: string;
  relativePath: string;
  matches: LineMatch[];
}

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchRequest {
  requestId: string;
  root: string;
  query: string;
  options: SearchOptions;
}

export type SearchStatus =
  | 'success'
  | 'no_matches'
  | 'missing_tool'
  | 'invalid_regex'
  | 'canceled'
  | 'failed';

// Frontend-facing response. The generated Wails type has `status: string`; we
// narrow it to the `SearchStatus` literal union and re-type `files` in terms
// of our local `FileResult` (which is structurally identical but doesn't carry
// the generated `convertValues` helper).
export type SearchResponse = Omit<search.SearchResponse, 'status' | 'files' | 'convertValues'> & {
  status: SearchStatus;
  files: FileResult[];
};

// SearchUIState is a discriminated union of the mutually exclusive UI states.
// Each variant carries only the data the panel needs to render that state.
//
// Backend response metadata (durationMs, matchCap, totalFiles, totalLines,
// truncated) is only attached to states where it is meaningful for display:
// `results` renders match counts and truncation, `no-matches` may want
// duration. Terminal-error states carry only `message`.
export type SearchUIState =
  | { kind: 'no-workspace' }
  | { kind: 'empty-query' }
  | { kind: 'loading'; requestId: string }
  | {
      kind: 'results';
      files: FileResult[];
      totalFiles: number;
      totalLines: number;
      truncated: boolean;
      matchCap: number;
      durationMs: number;
    }
  | { kind: 'no-matches'; durationMs: number }
  | { kind: 'missing-tool'; message: string }
  | { kind: 'invalid-regex'; message: string }
  | { kind: 'canceled' }
  | { kind: 'failed'; message: string };

export const defaultSearchOptions: SearchOptions = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
};
