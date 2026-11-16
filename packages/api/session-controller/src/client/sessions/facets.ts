/** Per-generation reference counts: sources, owner-declared facets, and the event connection. */
import type { SessionRetainInfo, SessionRetainOptions } from '../contract/sessions.ts'
import type { SessionReferenceSource, SessionRetainFacet } from '../index.ts'

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

/** What one reference counts while it lives. */
export interface RetainedUse {
  readonly source: SessionReferenceSource
  readonly facets: readonly SessionRetainFacet[]
  readonly connected: boolean
}

/** Source labels are dictionary keys, including names also present on Object.prototype. */
function freezeRetainedBy(counts: Partial<Record<SessionReferenceSource, number>>): SessionRetainInfo['retainedBy'] {
  Object.setPrototypeOf(counts, null)
  return Object.freeze(counts)
}

/** Retain info of a generation that no reference holds. */
export const EMPTY_RETAIN_INFO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: freezeRetainedBy({}) })

/**
 * Count one reference in or out of a generation's retain info.
 * @param info - the generation's current retain info.
 * @param use - what the retained or released reference counts.
 * @param delta - `1` when the reference is retained, `-1` when it is released.
 * @returns the frozen next retain info; {@link EMPTY_RETAIN_INFO} once no reference remains.
 */
export function shiftRetention(info: SessionRetainInfo, use: RetainedUse, delta: 1 | -1): SessionRetainInfo {
  const referenceCount = info.referenceCount + delta
  if (referenceCount === 0) return EMPTY_RETAIN_INFO
  const { [use.source]: sourceCount = 0, ...otherSources } = info.retainedBy
  const nextSource = sourceCount + delta
  const retainedBy = freezeRetainedBy(nextSource > 0 ? { ...otherSources, [use.source]: nextSource } : otherSources)
  const retainedFacets = shiftFacetCounts(info.retainedFacets, use.facets, delta)
  const connectionCount = (info.connectionCount ?? 0) + (use.connected ? delta : 0)
  return Object.freeze({
    referenceCount,
    retainedBy,
    ...(retainedFacets === undefined ? {} : { retainedFacets }),
    ...(connectionCount === 0 ? {} : { connectionCount }),
  })
}

/**
 * Count one reference's facets in or out of a retain-info snapshot.
 * @param counts - the previous positive facet counts, absent when none.
 * @param facets - the facets of the retained or released reference.
 * @param delta - `1` when the reference is retained, `-1` when it is released.
 * @returns the frozen positive counts, or undefined when no facet remains retained.
 */
function shiftFacetCounts(
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
