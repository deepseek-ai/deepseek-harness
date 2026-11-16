/** Per-generation reference counts of owner-declared retained facets. */
import type { SessionRetainInfo, SessionRetainOptions } from '../contract/sessions.ts'
import type { SessionRetainFacet } from '../index.ts'

type FacetCounts = NonNullable<SessionRetainInfo['retainedFacets']>

/**
 * The facet keys a retain request sets to `true`.
 * @param facets - the request's facet record.
 * @returns the facets one reference retains for its lifetime.
 */
export function heldFacets(facets: SessionRetainOptions['facets']): readonly SessionRetainFacet[] {
  if (facets === undefined) return []
  return (Object.keys(facets) as SessionRetainFacet[]).filter(facet => facets[facet] === true)
}

/**
 * Count one reference's facets in or out of a retain-info snapshot.
 * @param counts - the previous positive facet counts, absent when none.
 * @param facets - the facets of the retained or released reference.
 * @param delta - `1` when the reference is retained, `-1` when it is released.
 * @returns the frozen positive counts, or undefined when no facet remains retained.
 */
export function shiftFacetCounts(
  counts: FacetCounts | undefined,
  facets: readonly SessionRetainFacet[],
  delta: 1 | -1,
): FacetCounts | undefined {
  if (facets.length === 0) return counts
  // The facet key type is empty in programs where no owner has declared a facet, so counts are built over strings.
  const next = new Map<string, number>(Object.entries(counts ?? {}))
  for (const facet of facets) next.set(facet, (next.get(facet) ?? 0) + delta)
  const positive = [...next].filter(([, count]) => count > 0)
  if (positive.length === 0) return undefined
  // Facet names are dictionary keys, including names also present on Object.prototype.
  const record: FacetCounts = Object.assign(Object.create(null) as object, Object.fromEntries(positive))
  return Object.freeze(record)
}
