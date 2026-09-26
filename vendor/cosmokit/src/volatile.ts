/** Shared config references used by schema validators and plugin runtimes. */

const write = Symbol.for('cosmokit.volatile.write')

/** Recursively readonly data returned by a volatile config reference. */
export type VolatileSnapshot<T> = T extends object ? { readonly [K in keyof T]: VolatileSnapshot<T[K]> } : T

/** A stable reference; keep the reference, or capture its value for one operation only. */
export interface Volatile<T> {
  /** @returns the current immutable snapshot, including undefined for an absent value. */
  get(): VolatileSnapshot<T>
}

interface WritableVolatile extends Volatile<unknown> {
  [write](value: unknown): void
}

function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (typeof value === 'function') throw new TypeError('volatile config cannot contain functions')
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new TypeError('volatile config cannot contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Object.freeze(value.map(item => snapshot(item, ancestors)))
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('volatile config objects must be plain objects or arrays')
    }
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])))
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Create a detached reference containing an immutable copy of the supplied data.
 * @param value - validated config data; class instances and functions are unsupported.
 * @returns a reference whose value is updated only by its owning runtime.
 */
export function createVolatile<T>(value: T): Volatile<T> {
  let current = snapshot(value)
  return Object.freeze({
    get: () => current,
    [write]: (value: unknown) => { current = value },
  }) as Volatile<T>
}

/**
 * Identify references across ESM/CJS copies of the shared library.
 * @param value - a parsed config value.
 * @returns whether the value implements the shared reference protocol.
 */
export function isVolatile(value: unknown): value is Volatile<unknown> {
  return typeof value === 'object' && value !== null && write in value
}

/**
 * Collect config references without descending into their snapshots or opaque objects.
 * @internal
 * @param value - parsed config; cyclic ordinary fields are visited once per path.
 * @returns references and their object-key paths, including an empty path for a root reference.
 */
export function volatileEntries(value: unknown): { path: string[]; ref: Volatile<unknown> }[] {
  const ancestors = new Set<object>()
  function visit(value: unknown, path: string[]): { path: string[]; ref: Volatile<unknown> }[] {
    if (isVolatile(value)) return [{ path, ref: value }]
    if (!value || typeof value !== 'object' || ancestors.has(value)) return []
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return []
    ancestors.add(value)
    try {
      return Object.entries(value).flatMap(([key, child]) => visit(child, [...path, key]))
    } finally {
      ancestors.delete(value)
    }
  }
  return visit(value, [])
}

/**
 * Commit an already validated immutable snapshot from another reference.
 * @internal
 * @param target - the owning plugin's stable reference.
 * @param source - a newly parsed candidate reference.
 */
export function updateVolatile(target: Volatile<unknown>, source: Volatile<unknown>): void {
  ;(target as WritableVolatile)[write](source.get())
}
