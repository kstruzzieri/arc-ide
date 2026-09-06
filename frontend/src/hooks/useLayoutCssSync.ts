/**
 * #271: the shell's restore/effective-size writer for the --panel-* custom
 * properties.
 *
 * Before this hook the only writers were the two gesture paths in `useResize`,
 * so a restored or clamped size never reached the layout until the next drag.
 * Each variable is written independently and only when its own effective value
 * (or the layout invalidation revision) changes — one effect writing all four
 * on any dependency change would clobber in-progress pointer input.
 */
import { useLayoutEffect, useRef } from 'react';

type Sizes = { left: number; right: number; bottom: number; golem: number };

/** The custom property each resizable panel's size is written to. */
export const CSS_VARS = {
  left: '--panel-left-width',
  right: '--panel-right-width',
  bottom: '--panel-bottom-height',
  golem: '--panel-golem-width',
} as const;

export function useLayoutCssSync(
  sizes: Sizes,
  activeCssVar: string | null = null,
  invalidationRevision = 0
): void {
  const written = useRef(new Map<string, { size: number; revision: number }>());
  const { left, right, bottom, golem } = sizes;
  useLayoutEffect(() => {
    const values = { left, right, bottom, golem };
    for (const panel of Object.keys(CSS_VARS) as (keyof Sizes)[]) {
      const cssVar = CSS_VARS[panel];
      if (cssVar === activeCssVar) {
        // Release must rewrite this variable even if its desired size is unchanged.
        written.current.delete(cssVar);
        continue;
      }
      const size = values[panel];
      const previous = written.current.get(cssVar);
      if (previous?.size === size && previous.revision === invalidationRevision) continue;
      document.documentElement.style.setProperty(cssVar, `${size}px`);
      written.current.set(cssVar, { size, revision: invalidationRevision });
    }
  }, [left, right, bottom, golem, activeCssVar, invalidationRevision]);
}
