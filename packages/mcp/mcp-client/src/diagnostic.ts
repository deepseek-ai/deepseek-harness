/**
 * Connection diagnostics retain cause chains. Configurations that resolve
 * secrets replace every known secret value before text leaves the instance.
 */

/** Local failure whose message contains no expanded configuration or upstream text. */
export class McpLocalError extends Error {}

/** Placeholder written in place of a known secret value. */
const REDACTED = '[redacted]'

/**
 * Replace every occurrence of known secret values, longest first so a secret
 * that contains another is replaced whole.
 * @param text - diagnostic or upstream text.
 * @param secrets - non-empty secret values known to the instance.
 * @returns the text with each occurrence replaced by `[redacted]`.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) out = out.replaceAll(secret, REDACTED)
  return out
}

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
