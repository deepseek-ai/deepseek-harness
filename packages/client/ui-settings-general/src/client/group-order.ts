/** Ordering for the General Settings group ledger. */

/** Minimal registration shape needed to order groups. */
interface OrderedGroupEntry {
  options: { order?: number | undefined }
}

/**
 * Compare two group registrations by their declared order.
 * @param a - first registration.
 * @param b - second registration.
 * @returns a negative value when the first registration sorts first.
 */
export function compareGroupOrder(a: OrderedGroupEntry, b: OrderedGroupEntry): number {
  return (a.options.order ?? 0) - (b.options.order ?? 0)
}
