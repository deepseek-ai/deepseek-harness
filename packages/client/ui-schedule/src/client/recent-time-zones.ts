/** Browser-local recently selected IANA time zones. */

const STORAGE_KEY = 'dsh.schedule.recent-time-zones.v1'
const LIMIT = 5

/** First-run choices follow the device rather than guessing location from UI language. */
function defaults(system: string): readonly string[] {
  return [...new Set([system, 'UTC'])]
}

/**
 * Load up to five recent zones, or the system-zone/UTC first-run seed.
 * @param system - the host's current IANA zone.
 * @returns recent IANA zones in most-recent-first order.
 */
export function loadRecentTimeZones(system: string): readonly string[] {
  if (typeof localStorage === 'undefined') return defaults(system)
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return defaults(system)
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return defaults(system)
    const zones = [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value !== ''))]
    return zones.length === 0 ? defaults(system) : zones.slice(0, LIMIT)
  } catch {
    return defaults(system)
  }
}

/**
 * Promote one exact IANA id and persist the bounded list when storage is available.
 * @param recent - current most-recent-first IANA zones.
 * @param zone - exact IANA zone to promote.
 * @returns the updated bounded most-recent-first list.
 */
export function rememberTimeZone(recent: readonly string[], zone: string): readonly string[] {
  const next = [zone, ...recent.filter(value => value !== zone)].slice(0, LIMIT)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // A private or full browser store must not block editing the rule.
    }
  }
  return next
}
