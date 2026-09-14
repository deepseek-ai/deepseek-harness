/**
 * Lossless-JSON snapshots for the dependency-free source bootstrap closure.
 * @module @deepseek-ai/dsh-ptc-runtime-node/json-wire
 */

import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'

/* jscpd:ignore-start -- the source bootstrap mirrors session JSON helpers without workspace runtime imports */
type IntrinsicCallable = (this: unknown, ...args: unknown[]) => unknown

const intrinsicFunctionToString = Reflect.get(Function.prototype, 'toString') as IntrinsicCallable
const intrinsicReflectApply = Reflect.get(Reflect, 'apply') as (
  target: IntrinsicCallable,
  thisArgument: unknown,
  argumentsList: readonly unknown[],
) => unknown
const IntrinsicError = Error
const IntrinsicSet = Set
const intrinsicArrayIsArray = Array.isArray
const intrinsicArrayPrototype = Array.prototype
const intrinsicNumberIsFinite = Number.isFinite
const intrinsicNumberIsSafeInteger = Number.isSafeInteger
const intrinsicObjectCreate = Object.create
const intrinsicObjectDefineProperty = Object.defineProperty
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf
const intrinsicObjectHasOwn = Object.hasOwn
const intrinsicObjectIs = Object.is
const intrinsicObjectKeys = Object.keys
const intrinsicObjectPrototype = Object.prototype
const intrinsicObjectPropertyIsEnumerable = Reflect.get(intrinsicObjectPrototype, 'propertyIsEnumerable') as IntrinsicCallable
const intrinsicReflectOwnKeys = Reflect.ownKeys
const intrinsicSetAdd = Reflect.get(Set.prototype, 'add') as IntrinsicCallable
const intrinsicSetDelete = Reflect.get(Set.prototype, 'delete') as IntrinsicCallable
const intrinsicSetHas = Reflect.get(Set.prototype, 'has') as IntrinsicCallable

/** Build a data descriptor that cannot inherit model-defined accessor fields. */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = intrinsicObjectCreate(null) as PropertyDescriptor
  descriptor.value = value
  return descriptor
}

/** Define an ordinary enumerable data slot without a prototype-bearing descriptor. */
function defineEnumerableDataProperty(target: object, key: PropertyKey, value: unknown): void {
  const descriptor = dataDescriptor(value)
  descriptor.enumerable = true
  descriptor.configurable = true
  descriptor.writable = true
  intrinsicObjectDefineProperty(target, key, descriptor)
}

/** Append without consulting a model-mutated `Array.prototype`. */
function append<T>(target: T[], value: T): void {
  defineEnumerableDataProperty(target, target.length, value)
}

/** Pop without consulting a model-mutated `Array.prototype`. */
function takeLast<T>(target: T[]): T | undefined {
  if (target.length === 0) return undefined
  const index = target.length - 1
  const value = target[index]
  intrinsicObjectDefineProperty(target, 'length', dataDescriptor(index))
  return value
}

/** Whether one captured-intrinsic Set contains a value. */
function setHas<T>(target: Set<T>, value: T): boolean {
  return intrinsicReflectApply(intrinsicSetHas, target, [value]) as boolean
}

/** Add to one captured-intrinsic Set. */
function setAdd<T>(target: Set<T>, value: T): void {
  intrinsicReflectApply(intrinsicSetAdd, target, [value])
}

/** Delete from one captured-intrinsic Set. */
function setDelete<T>(target: Set<T>, value: T): void {
  intrinsicReflectApply(intrinsicSetDelete, target, [value])
}

/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && intrinsicReflectApply(intrinsicFunctionToString, constructor, []) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** Whether a candidate is a foreign realm's intrinsic `Object.prototype`. */
function isForeignIntrinsicObjectPrototype(value: object): boolean {
  return intrinsicObjectGetPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = intrinsicObjectGetPrototypeOf(value)
  if (prototype === intrinsicArrayPrototype) return true
  if (!intrinsicArrayIsArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = intrinsicObjectGetPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && isForeignIntrinsicObjectPrototype(objectPrototype)
}

/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value: object): boolean {
  const prototype: unknown = intrinsicObjectGetPrototypeOf(value)
  return prototype === null
    || prototype === intrinsicObjectPrototype
    || typeof prototype === 'object' && isForeignIntrinsicObjectPrototype(prototype)
}

/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value: object): string[] | undefined {
  const keys = intrinsicReflectOwnKeys(value)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key !== 'string' || !intrinsicReflectApply(intrinsicObjectPropertyIsEnumerable, value, [key])) return undefined
  }
  return keys as string[]
}

type SnapshotDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: PtcJsonValue[]; index: number }
  | { kind: 'object'; target: Record<string, PtcJsonValue>; key: string }

type SnapshotTask =
  | { kind: 'visit'; value: unknown; destination: SnapshotDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; target: PtcJsonValue[] }
  | { kind: 'object-property'; source: Record<string, unknown>; key: string; target: Record<string, PtcJsonValue> }
  | { kind: 'leave'; source: object }

/**
 * Validate and detach one process-boundary value without loading another
 * workspace package at runtime. This mirrors the session-owned canonical
 * JSON boundary while remaining safe to import from the unbuilt bootstrap.
 * Its iterative traversal adds no JavaScript call-stack depth limit.
 *
 * @param value - the candidate completion value.
 * @returns a detached lossless-JSON snapshot, or `undefined` when invalid.
 */
export function snapshotPtcJsonValue(value: unknown): PtcJsonValue | undefined {
  const active = new IntrinsicSet<object>()
  let root: PtcJsonValue | undefined
  const assign = (destination: SnapshotDestination, item: PtcJsonValue): void => {
    if (destination.kind === 'root') {
      root = item
    } else if (destination.kind === 'array') {
      defineEnumerableDataProperty(destination.target, destination.index, item)
    } else {
      defineEnumerableDataProperty(destination.target, destination.key, item)
    }
  }

  const tasks: SnapshotTask[] = [{ kind: 'visit', value, destination: { kind: 'root' } }]
  for (let task = takeLast(tasks); task !== undefined; task = takeLast(tasks)) {
    if (task.kind === 'leave') {
      setDelete(active, task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!intrinsicObjectHasOwn(task.source, task.index)) return undefined
      append(tasks, {
        kind: 'visit',
        value: task.source[task.index],
        destination: { kind: 'array', target: task.target, index: task.index },
      })
      continue
    }
    if (task.kind === 'object-property') {
      append(tasks, {
        kind: 'visit',
        value: task.source[task.key],
        destination: { kind: 'object', target: task.target, key: task.key },
      })
      continue
    }

    const candidate = task.value
    if (candidate === null) {
      assign(task.destination, null)
      continue
    }
    if (typeof candidate === 'boolean' || typeof candidate === 'string') {
      assign(task.destination, candidate)
      continue
    }
    if (typeof candidate === 'number') {
      if (!intrinsicNumberIsFinite(candidate) || intrinsicObjectIs(candidate, -0)) return undefined
      assign(task.destination, candidate)
      continue
    }
    if (typeof candidate !== 'object') return undefined
    if (setHas(active, candidate)) return undefined

    if (intrinsicArrayIsArray(candidate)) {
      if (!hasPlainArrayPrototype(candidate)) return undefined
      const length = candidate.length
      if (intrinsicReflectOwnKeys(candidate).length !== length + 1) return undefined
      const target: PtcJsonValue[] = []
      assign(task.destination, target)
      setAdd(active, candidate)
      append(tasks, { kind: 'leave', source: candidate })
      for (let index = length - 1; index >= 0; index--) {
        append(tasks, { kind: 'array-item', source: candidate, index, target })
      }
      continue
    }

    if (!hasPlainObjectPrototype(candidate)) return undefined
    const keys = enumerableStringKeys(candidate)
    if (keys === undefined) return undefined
    const target: Record<string, PtcJsonValue> = {}
    assign(task.destination, target)
    setAdd(active, candidate)
    append(tasks, { kind: 'leave', source: candidate })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) return undefined
      append(tasks, { kind: 'object-property', source: candidate as Record<string, unknown>, key, target })
    }
  }
  return root
}

interface ArrayWireToken {
  kind: 'array'
  length: number
}

interface ObjectWireToken {
  kind: 'object'
  keys: string[]
}

type PtcJsonToken = null | boolean | number | string | ArrayWireToken | ObjectWireToken

/**
 * A pre-order, bounded-depth transport for one lossless JSON value. Container
 * markers and scalar leaves share one flat token array, so JSON serialization
 * does not recurse through the value's application nesting.
 */
export type PtcJsonWire = PtcJsonToken[]

/**
 * Flatten one validated JSON value for the process control channel.
 * @param value - the lossless JSON value to transport.
 * @returns a pre-order token stream whose own nesting is bounded.
 */
export function encodePtcJsonWire(value: PtcJsonValue): PtcJsonWire {
  const wire: PtcJsonWire = []
  const pending: PtcJsonValue[] = [value]
  for (let current = takeLast(pending); current !== undefined; current = takeLast(pending)) {
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') {
      append(wire, current)
      continue
    }
    if (intrinsicArrayIsArray(current)) {
      append(wire, { kind: 'array', length: current.length })
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        if (item === undefined) throw new IntrinsicError('cannot encode a sparse JSON array')
        append(pending, item)
      }
      continue
    }
    const keys = intrinsicObjectKeys(current)
    append(wire, { kind: 'object', keys })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) throw new IntrinsicError('cannot encode a missing JSON object key')
      const item = current[key]
      if (item === undefined) throw new IntrinsicError('cannot encode an undefined JSON object property')
      append(pending, item)
    }
  }
  return wire
}

type DecodeFrame =
  | { kind: 'array'; target: PtcJsonValue[]; length: number; index: number }
  | { kind: 'object'; target: Record<string, PtcJsonValue>; keys: string[]; index: number }

/** Whether an array contains exactly its dense indexed slots and `length`. */
function isDenseArray(value: unknown[]): boolean {
  if (!hasPlainArrayPrototype(value) || intrinsicReflectOwnKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    if (!intrinsicObjectHasOwn(value, index)) return false
  }
  return true
}

/** Whether one exact string-key list contains a key, without consulting its prototype. */
function keysContain(keys: string[], expected: string): boolean {
  for (let index = 0; index < keys.length; index++) {
    if (keys[index] === expected) return true
  }
  return false
}

/** Return one exact container marker, or reject any extra/missing fields. */
function containerToken(value: object): ArrayWireToken | ObjectWireToken | undefined {
  if (intrinsicArrayIsArray(value) || !hasPlainObjectPrototype(value)) return undefined
  const keys = enumerableStringKeys(value)
  if (keys === undefined) return undefined
  const token = value as Record<string, unknown>
  if (token.kind === 'array') {
    if (keys.length !== 2 || !keysContain(keys, 'kind') || !keysContain(keys, 'length')) return undefined
    const length = token.length
    return typeof length === 'number' && intrinsicNumberIsSafeInteger(length) && length >= 0
      ? { kind: 'array', length }
      : undefined
  }
  if (token.kind === 'object') {
    if (keys.length !== 2 || !keysContain(keys, 'kind') || !keysContain(keys, 'keys')) return undefined
    const objectKeys = token.keys
    if (!intrinsicArrayIsArray(objectKeys) || !isDenseArray(objectKeys)) return undefined
    const unique = new IntrinsicSet<string>()
    const normalizedKeys: string[] = []
    const objectKeyValues = objectKeys as unknown[]
    for (let index = 0; index < objectKeyValues.length; index++) {
      const key = objectKeyValues[index]
      if (typeof key !== 'string' || setHas(unique, key)) return undefined
      setAdd(unique, key)
      append(normalizedKeys, key)
    }
    return { kind: 'object', keys: normalizedKeys }
  }
  return undefined
}

/**
 * Rebuild one lossless JSON value from the flat process wire format.
 * Malformed or incomplete traffic returns `undefined`; traversal is iterative
 * and therefore independent of the transported value's application depth.
 * @param input - untrusted message-port payload.
 * @returns the detached JSON value, or `undefined` when the wire is invalid.
 */
export function decodePtcJsonWire(input: unknown): PtcJsonValue | undefined {
  try {
    if (!intrinsicArrayIsArray(input) || !isDenseArray(input) || input.length === 0) return undefined
    const wire = input as unknown[]
    const frames: DecodeFrame[] = []
    let root: PtcJsonValue | undefined
    let rootAssigned = false

    const attach = (value: PtcJsonValue): boolean => {
      const parent = frames[frames.length - 1]
      if (!parent) {
        if (rootAssigned) return false
        root = value
        rootAssigned = true
        return true
      }
      /* v8 ignore next -- completed frames are popped before another token can attach. */
      if (parent.index >= (parent.kind === 'array' ? parent.length : parent.keys.length)) return false
      if (parent.kind === 'array') {
        append(parent.target, value)
      } else {
        const key = parent.keys[parent.index]
        /* v8 ignore next -- object frames are built from validated keys and their exact length. */
        if (key === undefined) return false
        defineEnumerableDataProperty(parent.target, key, value)
      }
      parent.index += 1
      return true
    }

    for (let tokenIndex = 0; tokenIndex < wire.length; tokenIndex++) {
      const token = wire[tokenIndex]
      let value: PtcJsonValue
      let frame: DecodeFrame | undefined
      if (token === null || typeof token === 'boolean' || typeof token === 'string') {
        value = token
      } else if (typeof token === 'number') {
        if (!intrinsicNumberIsFinite(token) || intrinsicObjectIs(token, -0)) return undefined
        value = token
      } else {
        if (typeof token !== 'object') return undefined
        const marker = containerToken(token)
        if (!marker) return undefined
        const remainingTokens = wire.length - tokenIndex - 1
        if (marker.kind === 'array') {
          if (marker.length > remainingTokens) return undefined
          const target: PtcJsonValue[] = []
          value = target
          if (marker.length > 0) frame = { kind: 'array', target, length: marker.length, index: 0 }
        } else {
          if (marker.keys.length > remainingTokens) return undefined
          const target: Record<string, PtcJsonValue> = {}
          value = target
          if (marker.keys.length > 0) frame = { kind: 'object', target, keys: marker.keys, index: 0 }
        }
      }
      if (!attach(value)) return undefined
      if (frame) append(frames, frame)
      while (frames.length > 0) {
        const current = frames[frames.length - 1]
        /* v8 ignore next -- the loop condition guarantees a final frame. */
        if (current === undefined) break
        if (current.index < (current.kind === 'array' ? current.length : current.keys.length)) break
        takeLast(frames)
      }
    }
    return frames.length === 0 ? root : undefined
  } catch {
    return undefined
  }
}
/* jscpd:ignore-end */
