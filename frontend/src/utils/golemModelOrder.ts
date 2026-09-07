/**
 * One reading order for model lists, shared by every surface that shows them:
 * the dock readout's Models cards, the configuration workspace's Defined models
 * subgroup, and the route editor's picker.
 *
 * Group by provider, in the PROVIDERS list's own order — the authored order the
 * providers card already renders — then alphabetically by role inside each
 * group. Ordering by provider NAME instead would make the two sections
 * disagree, which is the whole thing this function exists to prevent.
 *
 * Presentation only. The projection's canonical sort is a contract the corpus
 * pins (§5.6: ascending UTF-8 byte order); this sorts a copy at render and
 * never touches it.
 */

import { compareString } from '../types/golem';

interface Ordered {
  role: string;
  provider: string;
}

export function orderModelsForDisplay<T extends Ordered>(
  models: readonly T[],
  providers: readonly { name: string }[]
): T[] {
  // A model may name a provider the document does not define (a dangling
  // reference the projection reports rather than hides). Those sort after every
  // known group, keeping their own relative order.
  const groupOf = new Map(providers.map((provider, index) => [provider.name, index]));
  const unknown = providers.length;
  return [...models].sort(
    (a, b) =>
      (groupOf.get(a.provider) ?? unknown) - (groupOf.get(b.provider) ?? unknown) ||
      compareString(a.provider, b.provider) ||
      compareString(a.role, b.role)
  );
}
