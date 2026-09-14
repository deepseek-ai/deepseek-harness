/** Browser-owned time-zone sampling for one prompt RPC. */

/**
 * Resolve the current browser IANA zone for one outbound operation.
 * @returns The browser-provided canonical zone.
 * @throws when the runtime cannot provide a non-empty zone.
 */
export function resolvedClientTimeZone(): string {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error('browser time zone is unavailable')
  }
  return timeZone
}
