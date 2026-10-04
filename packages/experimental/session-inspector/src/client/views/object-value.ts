/** Shallow, typed runtime-object inspection without JSON conversion or implicit getter calls. */

/** One original field or collection entry, evaluated only when its parent is expanded. */
export interface InspectorObjectEntry {
  readonly key: string
  readonly name: string
  readonly value: unknown
  readonly accessor?: boolean
  /** An array slot without an own property, distinct from an explicit undefined value. */
  readonly absent?: boolean
  /** Synthetic disclosure for non-index collection properties. */
  readonly properties?: boolean
}

class CollectionProperties {
  constructor(readonly value: object, readonly length: number) {}
}

const typedArrayLength: (this: object) => number =
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/unbound-method -- Intrinsic getter; invoked with .call(array).
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!

function indexedLength(value: object): number | undefined {
  if (Array.isArray(value)) return value.length
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return typedArrayLength.call(value)
  return undefined
}

function field(value: object, key: string | symbol, index: number): InspectorObjectEntry {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return { key: typeof key === 'symbol' ? `symbol:${index}` : key, name: String(key), value: descriptor?.value,
    ...descriptor === undefined ? { absent: true } : 'value' in descriptor ? {} : { accessor: true } }
}

/** Display of one value; child enumeration never recursively visits child values. */
export class InspectorObjectValue {
  /** Shallow type or scalar preview; no child getters are evaluated. */
  readonly label: string
  /** Whether this value permits child enumeration rather than opaque scalar display. */
  readonly expandable: boolean

  /** @param value - Original runtime value, including Maps, Sets, and class instances. */
  constructor(private readonly value: unknown) {
    this.expandable = value !== null && typeof value === 'object'
      && !(value instanceof Date || value instanceof RegExp || value instanceof WeakMap || value instanceof WeakSet)
    if (value instanceof Map) this.label = `Map(${value.size})`
    else if (value instanceof Set) this.label = `Set(${value.size})`
    else if (Array.isArray(value)) this.label = `Array(${value.length})`
    else if (value instanceof Date) this.label = `Date(${Number.isNaN(value.getTime()) ? 'Invalid' : value.toISOString()})`
    else if (value instanceof RegExp) this.label = String(value)
    else if (value instanceof WeakMap) this.label = 'WeakMap'
    else if (value instanceof WeakSet) this.label = 'WeakSet'
    else if (value instanceof ArrayBuffer) this.label = `ArrayBuffer(${value.byteLength})`
    else if (value instanceof CollectionProperties) this.label = 'Object'
    else if (value !== null && typeof value === 'object') {
      const prototype: unknown = Object.getPrototypeOf(value)
      const constructor: unknown = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
      this.label = typeof constructor === 'function' ? constructor.name : 'Object'
    } else if (typeof value === 'string') this.label = JSON.stringify(value)
    else if (typeof value === 'bigint') this.label = `${value}n`
    else if (typeof value === 'function') this.label = `[Function ${value.name}]`
    else this.label = String(value)
  }

  /**
   * Enumerate one level without evaluating accessors or descending into children.
   * @returns Original children; Map keys remain values rather than being coerced to property names.
   */
  *entries(): IterableIterator<InspectorObjectEntry> {
    const value = this.value
    if (value instanceof Map) {
      let index = 0
      const entries: ReadonlyMap<unknown, unknown> = value
      for (const [key, item] of entries) {
        yield { key: String(index), name: String(index++), value: { key, value: item } }
      }
    } else if (value instanceof Set) {
      let index = 0
      for (const item of value) yield { key: String(index), name: String(index++), value: item }
    } else if (value instanceof ArrayBuffer || value instanceof DataView) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      yield { key: 'bytes', name: 'bytes', value: bytes }
    } else if (value !== null && typeof value === 'object') {
      const length = indexedLength(value)
      if (length !== undefined) {
        yield { key: 'properties', name: '', properties: true, value: new CollectionProperties(value, length) }
        for (let index = 0; index < length; index++) yield field(value, String(index), index)
      } else {
        const target = value instanceof CollectionProperties ? value.value : value
        for (const [index, key] of Reflect.ownKeys(target).entries()) {
          if (value instanceof CollectionProperties && typeof key === 'string'
            && (key === 'length' && Array.isArray(target)
              || String(Number(key)) === key && Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < value.length)) continue
          const entry = field(target, key, index)
          if (!entry.absent) yield entry
        }
      }
    }
  }
}
