/** Generic invocation-owned values returned by synchronous Client Context resolvers. */

/** Shared identity across independently bundled Context providers and Gateway. */
export const TYPERT_OWNED_VALUE = Symbol.for('dsh.typert.owned-value')

/** A borrowed payload paired with the invocation owner's idempotent cleanup. */
export interface TypertOwnedValue<Value> extends Disposable {
  readonly [TYPERT_OWNED_VALUE]: true
  readonly value: Value
}

/**
 * Transfer cleanup ownership without adding another resource reference count.
 * @param value - resolved payload passed to the invocation.
 * @param release - non-throwing synchronous release, called at most once.
 * @returns an owned payload disposed after invocation and reply settlement.
 */
export function typertOwnedValue<Value>(value: Value, release: () => void): TypertOwnedValue<Value> {
  let active = true
  return {
    [TYPERT_OWNED_VALUE]: true,
    value,
    [Symbol.dispose]() {
      if (!active) return
      active = false
      release()
    },
  }
}

/**
 * Identify invocation-owned values using the shared marker.
 * @param value - borrowed or owned resolver result.
 * @returns whether the result carries invocation cleanup.
 */
export function isTypertOwnedValue(value: unknown): value is TypertOwnedValue<unknown> {
  return typeof value === 'object' && value !== null
    && TYPERT_OWNED_VALUE in value && value[TYPERT_OWNED_VALUE] === true
}
