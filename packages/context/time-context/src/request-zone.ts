/** Browser-zone derivation and model-facing policy text for one open request turn. */

import { canonicalizeTimeZone } from '@deepseek-ai/dsh-util-time'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Browser-zone facts derived from user-rpc messages in one open turn. */
export type BrowserTimeZoneContext =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'mixed'; readonly timeZones: readonly string[] }
  | { readonly kind: 'missing' }

/**
 * Read and validate a Host-canonicalized browser zone from one ordinary user-rpc message.
 *
 * A request may only name a zone another process resolves back to the same
 * identity, so the shared vocabulary's canonical answer must equal the reported
 * value; an alias is refused here rather than silently rewritten.
 */
function browserTimeZone(message: UserMessage): string | undefined {
  const source = message.source
  const value = source.kind === 'user'
    && 'rpcId' in source
    && typeof source.rpcId === 'string'
    && 'clientTimeZone' in source
    && typeof source.clientTimeZone === 'string'
    ? source.clientTimeZone
    : undefined
  if (value === undefined) return undefined
  const resolved = canonicalizeTimeZone(value)
  if (resolved.kind === 'accepted') {
    if (resolved.timeZone !== value) {
      throw new TypeError(`browser time zone must be canonical: ${JSON.stringify(value)}`)
    }
    return value
  }
  switch (resolved.reason) {
    case 'unsupported':
      throw new TypeError(`browser time zone is unsupported: ${JSON.stringify(value)}`, { cause: resolved.cause })
    case 'blank':
    case 'padded':
    case 'not_area_location':
      throw new TypeError(`browser time zone must be canonical UTC or IANA Area/Location: ${JSON.stringify(value)}`)
    /* v8 ignore next 2 -- Intl answers a canonical Area/Location for every name it accepts. */
    case 'not_canonical_shape':
      throw new TypeError(`browser time zone must be canonical: ${JSON.stringify(value)}`)
    /* v8 ignore next 2 -- TimeZoneRejection is closed; this arm only makes adding a reason a compile error. */
    default:
      assertNever(resolved.reason, 'TimeZoneRejection')
  }
}

/**
 * Derive the unique, mixed, or missing browser zone for one open turn.
 * @param messages - Entered and proposed user messages belonging to the turn.
 * @returns Sorted, duplicate-free browser-zone facts.
 * @throws TypeError when a user-rpc source carries an invalid or noncanonical zone.
 */
export function deriveBrowserTimeZoneContext(
  messages: readonly UserMessage[],
): BrowserTimeZoneContext {
  const timeZones = [...new Set(messages.flatMap((message) => {
    const timeZone = browserTimeZone(message)
    return timeZone === undefined ? [] : [timeZone]
  }))].sort()
  const [timeZone, ...remaining] = timeZones
  if (timeZone === undefined) return { kind: 'missing' }
  if (remaining.length === 0) return { kind: 'resolved', timeZone }
  return { kind: 'mixed', timeZones }
}

/**
 * Render the model instruction for one browser-zone context.
 * @param context - Browser-zone facts for the open turn.
 * @returns One durable policy line.
 */
export function renderBrowserTimeZoneContext(context: BrowserTimeZoneContext): string {
  switch (context.kind) {
    case 'resolved':
      return `Browser time zone for this request: ${context.timeZone}. `
        + 'Interpret otherwise-unqualified dates and times in this zone.'
    case 'mixed':
      return `Browser time zone for this request: mixed ${JSON.stringify(context.timeZones)}. `
        + 'Ask the user to clarify otherwise-unqualified dates and times.'
    case 'missing':
      return 'Browser time zone for this request: unavailable. '
        + 'Ask the user to clarify otherwise-unqualified dates and times.'
    /* v8 ignore next 2 -- the closed BrowserTimeZoneContext union is exhausted above. */
    default:
      return assertNever(context, 'BrowserTimeZoneContext')
  }
}
