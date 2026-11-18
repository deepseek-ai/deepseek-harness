/** Browser-zone facts from committed or proposed user-rpc messages and model-facing policy text. */

import { canonicalizeTimeZone } from '@deepseek-ai/dsh-util-time'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Browser-zone facts for the messages selected while preparing a request. */
export type BrowserTimeZoneContext =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'mixed'; readonly timeZones: readonly string[] }
  | { readonly kind: 'missing' }

/**
 * Read the raw zone reported by a user-rpc source; validation belongs to request preparation.
 * @param message - user message; only user sources with a string rpcId and clientTimeZone contribute.
 * @returns the reported zone, or undefined when no user-rpc zone was reported.
 */
export function reportedBrowserTimeZone(message: UserMessage): string | undefined {
  const source = message.source
  return source.kind === 'user'
    && 'rpcId' in source
    && typeof source.rpcId === 'string'
    && 'clientTimeZone' in source
    && typeof source.clientTimeZone === 'string'
    ? source.clientTimeZone
    : undefined
}

/** Validate a reported zone at request preparation, preserving the platform refusal. */
function browserTimeZone(value: string): string {
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
 * Derive the unique, mixed, or missing browser zone for the selected request messages.
 * @param messages - proposed messages, or entered plus proposed messages selected by the legacy reader.
 * @param enteredTimeZones - reported zones from committed messages, before the proposed messages.
 * @returns Sorted, duplicate-free browser-zone facts.
 * @throws TypeError when a user-rpc source carries an invalid or noncanonical zone.
 */
export function deriveBrowserTimeZoneContext(
  messages: readonly UserMessage[],
  enteredTimeZones: readonly string[] = [],
): BrowserTimeZoneContext {
  const reported = messages.flatMap((message) => {
    const timeZone = reportedBrowserTimeZone(message)
    return timeZone === undefined ? [] : [timeZone]
  })
  const timeZones = [...new Set([...enteredTimeZones, ...reported].map(browserTimeZone))].sort()
  const [timeZone, ...remaining] = timeZones
  if (timeZone === undefined) return { kind: 'missing' }
  if (remaining.length === 0) return { kind: 'resolved', timeZone }
  return { kind: 'mixed', timeZones }
}

/**
 * Render the model instruction for one browser-zone context.
 * @param context - browser-zone facts selected for this request.
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
