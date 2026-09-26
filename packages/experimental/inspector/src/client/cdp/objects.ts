/** Client-local object handles and CDP-compatible RemoteObject serialization. */

import {
  inspectorId,
  type ClientRemoteObjectHandle,
} from '../../shared/bridge/ids.ts'
import { isJsonValue, type InspectorJsonValue } from '../../shared/json.ts'
import type { ClientRuntimeRemoteObject } from '../../shared/bridge/messages/runtime/index.ts'
import type {
  RuntimeObjectPreview,
  RuntimePropertyPreview,
  RuntimeRemoteObjectSubtype,
  RuntimeRemoteObjectType,
} from '../../shared/cdp/index.ts'
import { ClientRuntimeExecutionError } from './errors.ts'
import { identifyRealmObject } from '../../shared/cordis/object-registry.ts'

const MAX_CLASS_PROTOTYPE_DEPTH = 32

interface StoredObject {
  readonly value: unknown
  readonly group: string | undefined
}

/** Opaque set of handles allocated by one Client Runtime operation. */
export type ClientObjectAllocation = symbol

/** Serialization choices inherited by child RemoteObjects. */
export interface ClientRuntimeObjectOptions {
  readonly group?: string
  readonly generatePreview?: boolean
  readonly returnByValue?: boolean
}

/** Per-DevTools-session owner of all live Client object references. */
export class ClientObjectStore {
  private readonly objects = new Map<ClientRemoteObjectHandle, StoredObject>()
  private readonly groups = new Map<string, Set<ClientRemoteObjectHandle>>()
  private readonly allocations = new Map<ClientObjectAllocation, Set<ClientRemoteObjectHandle>>()
  private nextOrdinal = 1

  constructor(private readonly maxObjects: number) {}

  /**
   * Start tracking handles allocated by one independently settling operation.
   * @returns An opaque allocation identity.
   */
  beginAllocation(): ClientObjectAllocation {
    const allocation = Symbol('Client Runtime object allocation')
    this.allocations.set(allocation, new Set())
    return allocation
  }

  /**
   * Keep an operation's handles and release its allocation bookkeeping.
   * @param allocation - Allocation returned by {@link beginAllocation}.
   */
  commitAllocation(allocation: ClientObjectAllocation): void {
    this.allocations.delete(allocation)
  }

  /**
   * Resolve one handle or fail without exposing another session's objects.
   * @param handle - Client-local object handle.
   * @returns The retained JavaScript value.
   */
  get(handle: ClientRemoteObjectHandle): unknown {
    const object = this.objects.get(handle)
    if (object === undefined) throw new ClientRuntimeExecutionError('object-not-found', 'Client RemoteObject was released')
    return object.value
  }

  /**
   * Read the object group inherited by values reached through one handle.
   * @param handle - Client-local object handle.
   * @returns Its object group, or `undefined` when it is ungrouped.
   */
  group(handle: ClientRemoteObjectHandle): string | undefined {
    const object = this.objects.get(handle)
    if (object === undefined) throw new ClientRuntimeExecutionError('object-not-found', 'Client RemoteObject was released')
    return object.group
  }

  /**
   * Convert a live value to the JSON-safe RemoteObject protocol.
   * @param value - Value owned by this Client realm.
   * @param options - Object group and serialization options.
   * @param allocation - Optional operation that owns any newly retained handle.
   * @returns A primitive value or opaque Client handle with display metadata.
   */
  serialize(
    value: unknown,
    options: ClientRuntimeObjectOptions = {},
    allocation?: ClientObjectAllocation,
  ): ClientRuntimeRemoteObject {
    const primitive = serializePrimitive(value)
    if (primitive !== undefined) return primitive
    if (options.returnByValue === true) {
      return {
        descriptor: {
          type: typeof value === 'function' ? 'function' : 'object',
          value: serializeByValue(value),
          description: describe(value),
        },
      }
    }
    const type: RuntimeRemoteObjectType = typeof value === 'function' ? 'function' : typeof value === 'symbol' ? 'symbol' : 'object'
    const subtype = type === 'object' ? subtypeOf(value) : undefined
    const objectReference = identifyRealmObject(value)
    return {
      descriptor: {
        type,
        ...(subtype === undefined ? {} : { subtype }),
        className: className(value),
        description: describe(value),
        ...(options.generatePreview === true && type === 'object' ? { preview: preview(value, type, subtype) } : {}),
      },
      object: { handle: this.register(value, options.group, allocation) },
      ...(objectReference === undefined ? {} : { semanticReference: objectReference }),
    }
  }

  /**
   * Release exactly one handle. Releasing an unknown handle is idempotent.
   * @param handle - Client-local object handle.
   */
  release(handle: ClientRemoteObjectHandle): void {
    const object = this.objects.get(handle)
    if (object === undefined) return
    this.objects.delete(handle)
    if (object.group === undefined) return
    const members = this.groups.get(object.group)
    members?.delete(handle)
    if (members?.size === 0) this.groups.delete(object.group)
  }

  /**
   * Release every handle in one DevTools object group.
   * @param group - DevTools object-group name.
   */
  releaseGroup(group: string): void {
    const members = this.groups.get(group)
    if (members === undefined) return
    for (const handle of members) this.objects.delete(handle)
    this.groups.delete(group)
  }

  /**
   * Discard exactly the handles allocated by one failed operation.
   * @param allocation - Allocation returned by {@link beginAllocation}.
   */
  rollback(allocation: ClientObjectAllocation): void {
    const handles = this.allocations.get(allocation)
    if (handles === undefined) return
    this.allocations.delete(allocation)
    for (const handle of handles) this.release(handle)
  }

  /** Release the whole DevTools session. */
  clear(): void {
    this.objects.clear()
    this.groups.clear()
    this.allocations.clear()
  }

  private register(
    value: unknown,
    group: string | undefined,
    allocation: ClientObjectAllocation | undefined,
  ): ClientRemoteObjectHandle {
    if (this.objects.size >= this.maxObjects) {
      throw new ClientRuntimeExecutionError('result-too-large', `Client Runtime retained-object limit ${String(this.maxObjects)} reached`)
    }
    const ordinal = this.nextOrdinal++
    const handle = inspectorId<'ClientRemoteObjectHandle'>(`object-${String(ordinal)}`, 'handle')
    this.objects.set(handle, { value, group })
    if (allocation !== undefined) this.allocations.get(allocation)?.add(handle)
    if (group !== undefined) {
      let members = this.groups.get(group)
      if (members === undefined) {
        members = new Set()
        this.groups.set(group, members)
      }
      members.add(handle)
    }
    return handle
  }
}

function serializePrimitive(value: unknown): ClientRuntimeRemoteObject | undefined {
  if (value === undefined) return { descriptor: { type: 'undefined' } }
  if (value === null) return { descriptor: { type: 'object', subtype: 'null', value: null } }
  if (typeof value === 'string') return { descriptor: { type: 'string', value } }
  if (typeof value === 'boolean') return { descriptor: { type: 'boolean', value } }
  if (typeof value === 'bigint') {
    const text = `${String(value)}n`
    return { descriptor: { type: 'bigint', unserializableValue: text, description: text } }
  }
  if (typeof value !== 'number') return undefined
  if (Number.isFinite(value) && !Object.is(value, -0)) {
    return { descriptor: { type: 'number', value, description: String(value) } }
  }
  const text = Object.is(value, -0) ? '-0' : String(value)
  return { descriptor: { type: 'number', unserializableValue: text, description: text } }
}

function serializeByValue(value: unknown): InspectorJsonValue {
  let serialized: unknown
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new ClientRuntimeExecutionError('unsupported', `Value cannot be returned by value: ${renderError(error)}`)
  }
  if (typeof serialized !== 'string') throw new ClientRuntimeExecutionError('unsupported', 'Value cannot be returned by value')
  const result: unknown = JSON.parse(serialized)
  if (!isJsonValue(result)) throw new ClientRuntimeExecutionError('unsupported', 'Value is outside the JSON value set')
  return result
}

function preview(
  value: unknown,
  type: RuntimeRemoteObjectType,
  subtype: RuntimeRemoteObjectSubtype | undefined,
): RuntimeObjectPreview {
  const properties: RuntimePropertyPreview[] = []
  let overflow = false
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    let keys: readonly PropertyKey[] = []
    try {
      keys = Reflect.ownKeys(value)
    } catch {
      overflow = true
    }
    for (const key of keys) {
      if (properties.length === 5) {
        overflow = true
        break
      }
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      } catch {
        continue
      }
      if (descriptor === undefined) continue
      if (!('value' in descriptor)) {
        properties.push({ name: String(key), type: 'accessor' })
        continue
      }
      const propertyType = remoteType(descriptor.value)
      const propertySubtype = propertyType === 'object' ? subtypeOf(descriptor.value) : undefined
      properties.push({
        name: String(key),
        type: propertyType,
        value: previewText(descriptor.value),
        ...(propertySubtype === undefined ? {} : { subtype: propertySubtype }),
      })
    }
  }
  return {
    type,
    ...(subtype === undefined ? {} : { subtype }),
    description: describe(value),
    overflow,
    properties,
  }
}

function remoteType(value: unknown): RuntimeRemoteObjectType {
  if (value === null) return 'object'
  return typeof value
}

function subtypeOf(value: unknown): RuntimeRemoteObjectSubtype | undefined {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (ArrayBuffer.isView(value)) return value instanceof DataView ? 'dataview' : 'typedarray'
  if (typeof value !== 'object') return undefined
  for (const [prototype, subtype] of SUBTYPES_BY_PROTOTYPE) {
    if (inheritsFrom(value, prototype)) return subtype
  }
  return undefined
}

function className(value: unknown): string {
  if (typeof value === 'function') return functionName(value)
  if (typeof value === 'symbol') return 'Symbol'
  if (typeof value !== 'object' || value === null) return 'Object'
  const visited = new Set<object>()
  let prototype = prototypeOf(value)
  while (prototype !== null && visited.size < MAX_CLASS_PROTOTYPE_DEPTH && !visited.has(prototype)) {
    visited.add(prototype)
    const constructor = Reflect.getOwnPropertyDescriptor(prototype, 'constructor')
    const candidate: unknown = constructor !== undefined && 'value' in constructor ? constructor.value : undefined
    if (typeof candidate === 'function') {
      return functionName(candidate)
    }
    prototype = prototypeOf(prototype)
  }
  return 'Object'
}

function describe(value: unknown): string {
  if (typeof value === 'function') {
    try {
      return Function.prototype.toString.call(value)
    } catch {
      return functionName(value)
    }
  }
  const subtype = subtypeOf(value)
  if (subtype === 'array') {
    const descriptor = Reflect.getOwnPropertyDescriptor(value as object, 'length')
    const length: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
    return `Array(${typeof length === 'number' ? String(length) : '?'})`
  }
  if (subtype === 'error') {
    const stack = ownString(value as object, 'stack')
    if (stack !== undefined) return stack
    const name = ownString(value as object, 'name') ?? className(value)
    const message = ownString(value as object, 'message')
    return message === undefined || message.length === 0 ? name : `${name}: ${message}`
  }
  if (subtype === 'date') {
    try {
      return Date.prototype.toString.call(value)
    } catch {
      return 'Date'
    }
  }
  if (subtype === 'regexp') {
    try {
      return RegExp.prototype.toString.call(value)
    } catch {
      return 'RegExp'
    }
  }
  return className(value)
}

function previewText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 100)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
    return String(value)
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return describe(value).slice(0, 100)
}

function functionName(value: object): string {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'name')
    const name: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
    return typeof name === 'string' && name.length > 0 ? name : 'Function'
  } catch {
    return 'Function'
  }
}

function prototypeOf(value: object): object | null {
  try {
    return Reflect.getPrototypeOf(value)
  } catch {
    return null
  }
}

function inheritsFrom(value: object, expected: object): boolean {
  const visited = new Set<object>()
  let current = prototypeOf(value)
  while (current !== null && visited.size < MAX_CLASS_PROTOTYPE_DEPTH && !visited.has(current)) {
    if (current === expected) return true
    visited.add(current)
    current = prototypeOf(current)
  }
  return false
}

function ownString(value: object, key: string): string | undefined {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SUBTYPES_BY_PROTOTYPE: readonly (readonly [object, RuntimeRemoteObjectSubtype])[] = [
  [RegExp.prototype, 'regexp'],
  [Date.prototype, 'date'],
  [Map.prototype, 'map'],
  [Set.prototype, 'set'],
  [WeakMap.prototype, 'weakmap'],
  [WeakSet.prototype, 'weakset'],
  [Error.prototype, 'error'],
  [Promise.prototype, 'promise'],
  [ArrayBuffer.prototype, 'arraybuffer'],
  [DataView.prototype, 'dataview'],
]
