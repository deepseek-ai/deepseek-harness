/**
 * One-line diagnostic for a connection-layer failure, keeping the cause chain
 * that `String(error)` drops. Node's fetch wraps the actionable failure —
 * `connect ECONNREFUSED 127.0.0.1:8932`, a TLS code, a DNS code — inside
 * `error.cause`, so the outer `TypeError: fetch failed` alone diagnoses
 * nothing. The raw identifiers are kept verbatim: they are what a person
 * pastes into a search or hands to a model.
 */

/** One readable segment of the chain; generic `Error` names are noise and dropped. */
function segmentOf(value: unknown): string {
  if (!(value instanceof Error)) return String(value)
  const base = value.name === 'Error' || value.message === ''
    ? (value.message === '' ? value.name : value.message)
    : `${value.name}: ${value.message}`
  if (base !== '' && base !== 'Error') return base
  // Some aggregate connect failures carry an empty message but a syscall code.
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code : value.name
}

/**
 * Flatten an error and its `cause` chain into `outer, cause: inner, …`.
 * @param error - the caught value; non-Errors stringify as-is.
 * @returns the joined diagnostic line.
 */
export function describeError(error: unknown): string {
  const seen = new Set<unknown>()
  const segments: string[] = []
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    // The outer segment keeps its error name (`TypeError: fetch failed`).
    segments.push(segments.length === 0 && current instanceof Error ? String(current) : segmentOf(current))
    current = current instanceof Error ? current.cause : undefined
  }
  const head = segments[0]
  if (head === undefined) return String(error)
  return head + segments.slice(1).map(segment => `, cause: ${segment}`).join('')
}
