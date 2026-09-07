import { startTransition, useEffect, useRef, useState } from 'react';
import type { LanguageSupport } from '@codemirror/language';
import {
  getLanguageDescription,
  getLoadedLanguageSupport,
  loadLanguageSupport,
} from '../components/Editor/codemirror/languages';

const EMPTY: ReadonlyMap<string, LanguageSupport> = new Map();

/**
 * Panel-level loader: given the distinct filenames of currently visible match
 * rows, returns a filename→LanguageSupport map for the languages that have
 * loaded. Guarantees:
 *   - Empty map on the initial render; later inputs retain support for filenames
 *     that remain visible while newly requested languages load.
 *   - One import per distinct language (grouped by LanguageDescription name).
 *   - Each language publishes as soon as it resolves, independently of slower
 *     languages in the same input.
 *   - Unsupported files, failed imports, and superseded/unmounted loads never
 *     publish support. `LanguageDescription.load()` already dedupes and clears
 *     failed promises, so no local promise cache is kept (a later input retries).
 */
export function useSearchSyntaxSupports(
  visibleFilenames: readonly string[]
): ReadonlyMap<string, LanguageSupport> {
  // Adjust-state-on-input-change synchronously before commit. Preserve only
  // exact filenames that remain visible; everything else is loaded by the
  // generation-scoped effect below.
  const [state, setState] = useState<{
    key: readonly string[];
    map: ReadonlyMap<string, LanguageSupport>;
  }>({ key: visibleFilenames, map: EMPTY });
  if (state.key !== visibleFilenames) {
    const retained = new Map<string, LanguageSupport>();
    for (const filename of visibleFilenames) {
      const support = state.map.get(filename);
      if (support) retained.set(filename, support);
    }
    setState({ key: visibleFilenames, map: retained });
  }

  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    let active = true;

    // Group filenames by language name; keep one representative filename to feed
    // the extension-based loaders.
    const groups = new Map<string, { sample: string; filenames: string[] }>();
    for (const filename of visibleFilenames) {
      const description = getLanguageDescription(filename);
      if (!description) continue;
      const group = groups.get(description.name);
      if (group) group.filenames.push(filename);
      else groups.set(description.name, { sample: filename, filenames: [filename] });
    }
    if (groups.size === 0)
      return () => {
        active = false;
      };

    for (const { sample, filenames } of groups.values()) {
      void (async () => {
        const support = getLoadedLanguageSupport(sample) ?? (await loadLanguageSupport(sample));
        if (!support || !active || generationRef.current !== generation) return;

        startTransition(() => {
          if (!active || generationRef.current !== generation) return;
          setState((current) => {
            if (current.key !== visibleFilenames) return current;
            const map = new Map(current.map);
            let changed = false;
            for (const filename of filenames) {
              if (map.get(filename) === support) continue;
              map.set(filename, support);
              changed = true;
            }
            return changed ? { key: visibleFilenames, map } : current;
          });
        });
      })();
    }

    return () => {
      active = false;
    };
  }, [visibleFilenames]);

  return state.key === visibleFilenames ? state.map : EMPTY;
}
