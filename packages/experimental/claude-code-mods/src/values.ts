/**
 * Small value helpers shared by the engine and the host: reading a mod's
 * untyped call input, wording a thrown value, and JSON encoding as typed by
 * what it does.
 * @module
 */

/**
 * The message of a thrown value: an Error's `message`, anything else as text.
 * @param error - the thrown value.
 * @returns the message text.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A mod's call input as a field record; anything that is not an object reads as empty.
 * @param input - the value a mod passed.
 * @returns the fields, or an empty record.
 */
export function record(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}

/**
 * Require one string field of a mod's call input.
 * @param value - the field value.
 * @param what - the field, named in the error.
 * @returns the string.
 * @throws TypeError when the value is not a string.
 */
export function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`)
  return value
}

/**
 * `JSON.stringify` as typed by what it does: undefined for a value JSON cannot carry.
 * @param value - the value to encode.
 * @returns the JSON text, or undefined.
 */
export function stringify(value: unknown): string | undefined {
  const encoded: string | undefined = JSON.stringify(value)
  return encoded
}
