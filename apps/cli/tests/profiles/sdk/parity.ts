/**
 * Comparison of the model context that the shipped SDK profile with native tool execution and the Desktop standard
 * agent preset assemble, with exact recorded exceptions.
 */
import { parityExceptions } from './parity-exceptions.ts'

/**
 * Compared layer: `tool` is one-sided tool presence, `schema` a model-facing tool schema field, `section` a system
 * prompt section or runtime context entry, `skill` a session skill catalog entry, `message` another message injected
 * into the first request, keyed by its first line up to a colon, `order` the relative order of the entries both sides
 * have in one sequence, and `config` a plugin row of the profile composition.
 */
export type ParityKind = 'tool' | 'schema' | 'section' | 'skill' | 'message' | 'order' | 'config'

/** One observed difference between the SDK and Desktop sides. */
export interface ParityDifference {
  kind: ParityKind
  /** Entry name, or `<entry>:<JSON pointer>` when both sides have the entry with different content. */
  key: string
  /** The only side that has the entry; absent when both sides have it with different content. */
  side?: 'sdk' | 'desktop'
}

/** A recorded difference that the comparison accepts. */
export interface ParityException extends ParityDifference {
  /** Why the difference exists. */
  reason: string
  /** Present for an inconsistency that should be fixed; names the tracking issue. Absent for an intended difference. */
  debt?: { issue: string }
}

const EXCEPTIONS_FILE = 'apps/cli/tests/profiles/sdk/parity-exceptions.ts'

function escapePointer(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * List the JSON pointers of the deepest differing locations of two JSON values.
 * Arrays of different length differ as a whole.
 * @param sdk - SDK value.
 * @param desktop - Desktop value.
 * @param pointer - pointer of the compared values.
 * @returns differing pointers in key order; empty when the values are equal.
 */
export function jsonDifferences(sdk: unknown, desktop: unknown, pointer = ''): string[] {
  if (isRecord(sdk) && isRecord(desktop)) {
    const keys = [...new Set([...Object.keys(sdk), ...Object.keys(desktop)])].sort()
    return keys.flatMap(key => jsonDifferences(sdk[key], desktop[key], `${pointer}/${escapePointer(key)}`))
  }
  if (Array.isArray(sdk) && Array.isArray(desktop) && sdk.length === desktop.length) {
    return sdk.flatMap((item, index) => jsonDifferences(item, desktop[index], `${pointer}/${index}`))
  }
  return JSON.stringify(sdk) === JSON.stringify(desktop) ? [] : [pointer]
}

/**
 * Compare two named entry tables.
 * @param presence - kind reported for an entry only one side has.
 * @param content - kind reported for differing content of a shared entry.
 * @param sdk - SDK entries by name.
 * @param desktop - Desktop entries by name.
 * @returns differences sorted by entry name.
 */
export function compareEntries(
  presence: ParityKind, content: ParityKind,
  sdk: ReadonlyMap<string, unknown>, desktop: ReadonlyMap<string, unknown>,
): ParityDifference[] {
  const names = [...new Set([...sdk.keys(), ...desktop.keys()])].sort()
  return names.flatMap((name): ParityDifference[] => {
    if (!desktop.has(name)) return [{ kind: presence, key: name, side: 'sdk' }]
    if (!sdk.has(name)) return [{ kind: presence, key: name, side: 'desktop' }]
    return jsonDifferences(sdk.get(name), desktop.get(name))
      .map(pointer => ({ kind: content, key: pointer === '' ? name : `${name}:${pointer}` }))
  })
}

/**
 * Compare the relative order of the entries both sides have; entries only one side has are reported by the entry
 * comparison, so they do not count here.
 * @param sequence - name of the compared sequence, reported as the difference key.
 * @param sdk - SDK entry names in model order.
 * @param desktop - Desktop entry names in model order.
 * @returns one `order` difference when the shared entries appear in a different order, otherwise none.
 */
export function compareOrder(sequence: string, sdk: readonly string[], desktop: readonly string[]): ParityDifference[] {
  const shared = (names: readonly string[], other: readonly string[]) => names.filter(name => other.includes(name))
  return JSON.stringify(shared(sdk, desktop)) === JSON.stringify(shared(desktop, sdk)) ? [] : [{ kind: 'order', key: sequence }]
}

function label(difference: ParityDifference): string {
  const where = difference.side === undefined ? 'differs' : `${difference.side} only`
  return `${difference.kind} ${difference.key} (${where})`
}

function matches(exception: ParityException, difference: ParityDifference): boolean {
  return exception.kind === difference.kind && exception.key === difference.key && exception.side === difference.side
}

/**
 * Accept exactly the recorded differences of the compared kinds, rejecting both unrecorded differences and
 * exceptions that no longer match one.
 * @param kinds - layers the caller compared; exceptions of other layers are not consulted.
 * @param differences - observed differences of those layers.
 * @param exceptions - recorded differences with their reasons.
 */
export function assertParity(
  kinds: readonly ParityKind[], differences: readonly ParityDifference[],
  exceptions: readonly ParityException[] = parityExceptions,
): void {
  const unexpected = [...differences]
  const stale: string[] = []
  for (const exception of exceptions) {
    if (!kinds.includes(exception.kind)) continue
    if (!exception.reason.trim()) throw new Error(`Parity exception requires a reason: ${label(exception)}`)
    if (exception.debt !== undefined && !exception.debt.issue.trim()) {
      throw new Error(`Parity debt requires an issue: ${label(exception)}`)
    }
    const index = unexpected.findIndex(difference => matches(exception, difference))
    if (index === -1) stale.push(label(exception))
    else unexpected.splice(index, 1)
  }
  if (unexpected.length === 0 && stale.length === 0) return
  throw new Error([
    'SDK/Desktop model context mismatch',
    ...unexpected.map(difference => `  ${label(difference)}`),
    `Stale exceptions: ${stale.join(', ') || '(none)'}`,
    `Align both profiles, or record the difference in ${EXCEPTIONS_FILE} with a reason; an inconsistency left unfixed also needs debt.issue. Remove an exception once its difference is gone.`,
  ].join('\n'))
}
