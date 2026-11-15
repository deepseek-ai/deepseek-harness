/** Per-generation reference counts of owner-declared retained facets. */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionRetainOptions } from '../contract/sessions.ts'
import type { SessionRetainFacet } from '../index.ts'

interface FacetCount {
  count: number
  readonly listeners: Set<() => void>
  readonly source: ObservableSnapshot<boolean>
}

/**
 * The facet keys a retain request sets to `true`.
 * @param facets - the request's facet record.
 * @returns the facets one reference retains for its lifetime.
 */
export function heldFacets(facets: SessionRetainOptions['facets']): readonly SessionRetainFacet[] {
  if (facets === undefined) return []
  return (Object.keys(facets) as SessionRetainFacet[]).filter(facet => facets[facet] === true)
}

/** Facet counts of one live Client generation; observers are notified only when a facet starts or stops being retained. */
export class RetainedFacets {
  private readonly counts = new Map<SessionRetainFacet, FacetCount>()

  /**
   * Observe one facet of this generation.
   * @param facet - owner-declared facet name.
   * @returns the identity-stable source reading whether any live reference retains `facet`.
   */
  source(facet: SessionRetainFacet): ObservableSnapshot<boolean> {
    return this.entry(facet).source
  }

  /**
   * Count one new reference for each of its facets.
   * @param facets - facets one new reference retains.
   */
  retain(facets: readonly SessionRetainFacet[]): void {
    for (const facet of facets) this.shift(facet, 1)
  }

  /**
   * Uncount one released reference from each of its facets.
   * @param facets - facets of one released reference.
   */
  release(facets: readonly SessionRetainFacet[]): void {
    for (const facet of facets) this.shift(facet, -1)
  }

  /** End every facet when the generation retires. */
  releaseAll(): void {
    for (const entry of this.counts.values()) {
      if (entry.count === 0) continue
      entry.count = 0
      notifySubscribers(entry.listeners, '[session-controller] retained facet')
    }
  }

  private shift(facet: SessionRetainFacet, delta: 1 | -1): void {
    const entry = this.entry(facet)
    const wasHeld = entry.count > 0
    entry.count += delta
    if (wasHeld !== entry.count > 0) notifySubscribers(entry.listeners, '[session-controller] retained facet')
  }

  private entry(facet: SessionRetainFacet): FacetCount {
    const existing = this.counts.get(facet)
    if (existing !== undefined) return existing
    const listeners = new Set<() => void>()
    const created: FacetCount = {
      count: 0,
      listeners,
      source: {
        getSnapshot: () => created.count > 0,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    }
    this.counts.set(facet, created)
    return created
  }
}
