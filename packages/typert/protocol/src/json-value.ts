/**
 * Lossless JSON checks every Remote carrier shares: the Client handle before it
 * queues an uplink item, the Gateway at its wire and codec-less uplink
 * boundaries, and the in-process mock.
 */

/**
 * Test whether a value crosses JSON transport without coercion or omission.
 * @param value - candidate boundary value.
 * @returns whether the value is losslessly JSON-compatible.
 */
export function isRemoteJsonValue(value: unknown): boolean {
  return visitJsonValue(value, new Set<object>())
}

/**
 * Test whether a value may travel as one uplink item: a lossless JSON value, or
 * a top-level `undefined`, which the wire carries as an `item` frame without
 * `value`. Nested `undefined`, `NaN`, and infinities stay rejected.
 * @param value - candidate uplink item.
 * @returns whether the item crosses every carrier unchanged.
 */
export function isRemoteUplinkItem(value: unknown): boolean {
  return value === undefined || isRemoteJsonValue(value)
}

function visitJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return false
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index) || !visitJsonValue(value[index], ancestors)) return false
      }
      return true
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !visitJsonValue(Reflect.get(value, key), ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}
