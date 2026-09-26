import { isNullable } from './misc.ts'
import { isVolatile } from './volatile.ts'

type GlobalConstructorNames = keyof {
  [K in keyof typeof globalThis as typeof globalThis[K] extends abstract new (...args: any) => any ? K : never]: K
}

/** Create a predicate for a global constructor name. */
export function is<K extends GlobalConstructorNames>(type: K): (value: any) => value is InstanceType<typeof globalThis[K]>
/** Test whether a value matches a global constructor name. */
export function is<K extends GlobalConstructorNames>(type: K, value: any): value is InstanceType<typeof globalThis[K]>
/** Test values using `instanceof` with a `toStringTag` fallback. */
export function is<K extends GlobalConstructorNames>(type: K, value?: any): any {
  if (arguments.length === 1) return (value: any) => is(type, value)
  return type in globalThis && value instanceof (globalThis[type] as any)
    || Object.prototype.toString.call(value).slice(8, -1) === type
}

function isArrayBufferLike(value: any): value is ArrayBufferLike {
  return is('ArrayBuffer', value) || is('SharedArrayBuffer', value)
}

function isArrayBufferSource(value: any): value is Binary.Source {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value)
}

/** Binary source detection and base64/hex conversion helpers. */
export namespace Binary {
  export type Source<T extends ArrayBufferLike = ArrayBufferLike> = T | ArrayBufferView<T>

  export const is = isArrayBufferLike
  export const isSource = isArrayBufferSource

  export function fromSource<T extends ArrayBufferLike>(source: Source<T>): T {
    if (ArrayBuffer.isView(source)) {
      // https://stackoverflow.com/questions/8609289/convert-a-binary-nodejs-buffer-to-javascript-arraybuffer#answer-31394257
      return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as T
    } else {
      return source
    }
  }

  export function toBase64(source: Source) {
    source = fromSource(source)
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(source).toString('base64')
    }
    let binary = ''
    const bytes = new Uint8Array(source)
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  export function fromBase64(source: string) {
    if (typeof Buffer !== 'undefined') return fromSource(Buffer.from(source, 'base64'))
    return Uint8Array.from(atob(source), c => c.charCodeAt(0))
  }

  export function toHex(source: Source) {
    source = fromSource(source)
    if (typeof Buffer !== 'undefined') return Buffer.from(source).toString('hex')
    return Array.from(new Uint8Array(source), byte => byte.toString(16).padStart(2, '0')).join('')
  }

  export function fromHex(source: string) {
    if (typeof Buffer !== 'undefined') return fromSource(Buffer.from(source, 'hex'))
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1)
    const buffer: number[] = []
    for (let i = 0; i < hex.length; i += 2) {
      buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16))
    }
    return Uint8Array.from(buffer).buffer
  }
}

/** Decode a base64 string into binary data. */
export const base64ToArrayBuffer = Binary.fromBase64
/** Encode binary data as base64. */
export const arrayBufferToBase64 = Binary.toBase64
/** Decode a hex string into binary data. */
export const hexToArrayBuffer = Binary.fromHex
/** Encode binary data as hex. */
export const arrayBufferToHex = Binary.toHex

/** Deep-clone common JavaScript values while preserving prototypes. */
export function clone<T>(source: T): T
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
export function clone(source: any, refs = new Map<any, any>()) {
  if (!source || typeof source !== 'object') return source
  if (is('Date', source)) return new Date(source.valueOf())
  if (is('RegExp', source)) return new RegExp(source.source, source.flags)
  if (isArrayBufferLike(source)) return source.slice(0)
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
  const cached = refs.get(source)
  if (cached) return cached
  if (Array.isArray(source)) {
    const result: any[] = []
    refs.set(source, result)
    source.forEach((value, index) => {
      result[index] = Reflect.apply(clone, null, [value, refs])
    })
    return result
  }
  const result = Object.create(Object.getPrototypeOf(source))
  refs.set(source, result)
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) }
    if ('value' in descriptor) {
      descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs])
    }
    Reflect.defineProperty(result, key, descriptor)
  }
  return result
}

/**
 * Compare values recursively, treating two volatile references as equal regardless of value.
 * Strict comparison distinguishes null/undefined, treats opaque objects by identity,
 * compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
 * @param a - first value.
 * @param b - second value.
 * @param strict - whether to require strict data equality outside volatile references.
 * @returns whether the values compare equal.
 */
export function deepEqual(a: any, b: any, strict?: boolean): boolean {
  const ancestors = new Set<object>()
  function compare(a: any, b: any): boolean {
    if (a === b) return true
    if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b)
    if (!strict && isNullable(a) && isNullable(b)) return true
    if (typeof a !== typeof b || typeof a !== 'object' || !a || !b) return false
    if (ancestors.has(a)) return false

    function check<T>(test: (x: any) => x is T, then: (a: T, b: T) => boolean) {
      return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : undefined
    }

    ancestors.add(a)
    try {
      return check(Array.isArray, (a, b) => {
        if (a.length !== b.length) return false
        for (let index = 0; index < a.length; index++) {
          if (!compare(a[index], b[index])) return false
        }
        return true
      })
        ?? check(is('Date'), (a, b) => a.valueOf() === b.valueOf())
        ?? check(is('URL'), (a, b) => a.href === b.href)
        ?? check(is('RegExp'), (a, b) => a.source === b.source && a.flags === b.flags)
        ?? check(isArrayBufferLike, (a, b) => {
          if (a.byteLength !== b.byteLength) return false
          const viewA = new Uint8Array(a)
          const viewB = new Uint8Array(b)
          for (let i = 0; i < viewA.length; i++) {
            if (viewA[i] !== viewB[i]) return false
          }
          return true
        })
        ?? ((!strict || [a, b].every(value => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
          && Object.keys({ ...a, ...b }).every(key => compare(a[key], b[key])))
    } finally {
      ancestors.delete(a)
    }
  }
  return compare(a, b)
}
