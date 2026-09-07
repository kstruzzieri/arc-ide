/**
 * useDocumentSymbols — drives the Structure view (issue #168).
 *
 * Fetches `textDocument/documentSymbol` for the active editor file and exposes a
 * discriminated status so the view can render populated / empty / error /
 * unavailable states without inventing placeholder data.
 *
 * Refresh triggers:
 *  - active file changes    → immediate fetch (with a loading state)
 *  - active file edited     → debounced re-fetch (keeps current symbols visible)
 *  - server becomes ready   → fetch
 *  - refresh() called       → immediate re-fetch
 *
 * Stale-response guard: every fetch captures a monotonic token; a response is
 * applied only if its token is still the latest. Rapid tab/edit switches can
 * never surface another file's symbols.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIDEStore } from '../stores/ideStore';
import { useLSPStore, findServerStatusForFile } from '../stores/lspStore';
import { lspFamilyForFile } from '../utils/lspLanguageId';
import { flushLSPDocumentChange } from '../utils/lspDocumentSync';
import { LSPDocumentSymbol } from '../wails/bindings';
import type { DocumentSymbolNode } from '../utils/documentSymbols';

export const STRUCTURE_FETCH_DEBOUNCE_MS = 300;

export type StructureStatus =
  | 'no-file'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'unsupported'
  | 'lsp-unavailable'
  | 'error';

export interface UseDocumentSymbolsResult {
  status: StructureStatus;
  symbols: DocumentSymbolNode[];
  filePath: string | null;
  refresh: () => void;
}

type GateKind = 'no-file' | 'unsupported' | 'lsp-unavailable' | 'fetch';

interface FetchState {
  status: 'loading' | 'ready' | 'empty' | 'error';
  symbols: DocumentSymbolNode[];
  filePath: string | null;
}

const EMPTY: DocumentSymbolNode[] = [];

export function useDocumentSymbols(): UseDocumentSymbolsResult {
  const activeFileId = useIDEStore((s) => s.activeFileId);
  const openFiles = useIDEStore((s) => s.openFiles);
  const serverStatuses = useLSPStore((s) => s.serverStatuses);

  const activeFile = useMemo(
    () => openFiles.find((f) => f.id === activeFileId) ?? null,
    [openFiles, activeFileId]
  );
  const path = activeFile?.path ?? null;
  const name = activeFile?.name ?? null;
  const content = activeFile?.content ?? '';

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // The gate is derived during render — cheap and side-effect free — so we only
  // reach for state + an effect when an async documentSymbol call is actually
  // needed. This keeps synchronous setState out of the effect body.
  const gate: GateKind = useMemo(() => {
    if (!path || !name) return 'no-file';
    if (!lspFamilyForFile(name)) return 'unsupported';
    const server = findServerStatusForFile(serverStatuses, path, lspFamilyForFile(name));
    if (!server || server.state !== 'ready') return 'lsp-unavailable';
    return 'fetch';
  }, [path, name, serverStatuses]);

  const [fetchState, setFetchState] = useState<FetchState>({
    status: 'loading',
    symbols: EMPTY,
    filePath: null,
  });

  const tokenRef = useRef(0);
  const prevPathRef = useRef<string | null>(null);
  const prevNonceRef = useRef(0);

  useEffect(() => {
    if (gate !== 'fetch' || !path) return;

    const switched = path !== prevPathRef.current;
    const nonceChanged = nonce !== prevNonceRef.current;
    const immediate = switched || nonceChanged;
    prevPathRef.current = path;
    prevNonceRef.current = nonce;

    const token = ++tokenRef.current;
    const fetchPath = path;

    const run = async () => {
      try {
        await flushLSPDocumentChange(fetchPath);
        const result = await LSPDocumentSymbol(fetchPath);
        if (token !== tokenRef.current) return; // stale — a newer request won
        const symbols = (result ?? EMPTY) as DocumentSymbolNode[];
        setFetchState({
          status: symbols.length > 0 ? 'ready' : 'empty',
          symbols,
          filePath: fetchPath,
        });
      } catch {
        if (token !== tokenRef.current) return;
        setFetchState({ status: 'error', symbols: EMPTY, filePath: fetchPath });
      }
    };

    const timer = setTimeout(run, immediate ? 0 : STRUCTURE_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `content` is an intentional trigger: edits re-fetch (debounced).
  }, [gate, path, content, nonce]);

  // --- Derive the exposed status. ---
  if (gate !== 'fetch') {
    return { status: gate, symbols: EMPTY, filePath: gate === 'no-file' ? null : path, refresh };
  }
  // A fetch is in flight (or done). Until results for the *current* file land,
  // report loading — this covers the file-switch gap without a setState flash.
  if (fetchState.filePath === path) {
    return { status: fetchState.status, symbols: fetchState.symbols, filePath: path, refresh };
  }
  return { status: 'loading', symbols: EMPTY, filePath: path, refresh };
}
