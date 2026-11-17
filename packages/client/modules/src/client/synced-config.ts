/**
 * Browser-synced plugin configuration. Each plugin activation receives its own Config object of
 * `SyncedConfigRef`s, as a Host activation resolves its own volatile references; only the page's entry
 * controller writes values, and it stops writing to an activation once that activation's teardown begins.
 */
import type { VolatileSnapshot } from '@deepseek-ai/cordis'
import type { SyncedConfigRef, SyncedConfigValues } from '@deepseek-ai/dsh-client-config/types'
import { notifySubscribers } from './notify.ts'

/** Controller-side access to one reference: set without notifying, then notify once every field is set. */
interface RefPort {
  set(value: unknown): void
  notify(): void
}

/** The page's implementation of one {@link SyncedConfigRef}; only the activation that created it writes, through its port. */
class SyncedConfigReference<T> implements SyncedConfigRef<T> {
  #value: VolatileSnapshot<T>
  readonly #listeners = new Set<() => void>()

  /**
   * @param value - frozen initial value.
   * @param attach - receives the controller's port; called once during construction.
   */
  constructor(value: VolatileSnapshot<T>, attach: (port: RefPort) => void) {
    this.#value = value
    attach({
      set: (next) => { this.#value = next as VolatileSnapshot<T> },
      notify: () => { notifySubscribers(this.#listeners, 'synced configuration') },
    })
  }

  /** @returns the current frozen value; undefined when the Host sends none. */
  readonly get: () => VolatileSnapshot<T> = () => this.#value
  /** @returns the same value as {@link get}. */
  readonly getSnapshot: () => VolatileSnapshot<T> = () => this.#value
  /**
   * Observe value changes; every changed field of one update is set before any subscriber runs.
   * @param listener - called after each change.
   * @returns the disposer.
   */
  readonly subscribe: (listener: () => void) => () => void = (listener) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}

/** Structural equality of JSON values; object key order does not matter. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  return leftKeys.length === Object.keys(right).length
    && leftKeys.every(key => Object.hasOwn(right, key) && sameJson(Reflect.get(left, key), Reflect.get(right, key)))
}

function freeze(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** The Config object of one plugin activation. */
class SyncedConfigActivation {
  private values: SyncedConfigValues
  private readonly ports = new Map<string, RefPort>()
  private readonly refs = new Map<string, SyncedConfigReference<unknown>>()
  /** Read-only object whose properties create field references on first access. */
  readonly config: object

  constructor(values: SyncedConfigValues) {
    this.values = values
    // An extensible empty target keeps the Proxy invariants satisfied for fields that appear later.
    this.config = new Proxy({}, {
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      get: (_target, property) => typeof property === 'string' ? this.ref(property) : undefined,
      has: (_target, property) => typeof property === 'string' && Object.hasOwn(this.values, property),
      ownKeys: () => Object.keys(this.values),
      getOwnPropertyDescriptor: (_target, property) => typeof property === 'string' && Object.hasOwn(this.values, property)
        ? { configurable: true, enumerable: true, value: this.ref(property) }
        : undefined,
    })
  }

  /** Set every changed field, then notify the changed fields' subscribers. */
  write(values: SyncedConfigValues): void {
    const previous = this.values
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(values)])]
      .filter(field => !sameJson(previous[field], values[field]))
    if (changed.length === 0) return
    this.values = values
    const ports = changed.flatMap((field) => {
      const port = this.ports.get(field)
      return port === undefined ? [] : [{ port, value: values[field] }]
    })
    for (const { port, value } of ports) port.set(value)
    for (const { port } of ports) port.notify()
  }

  private ref(field: string): SyncedConfigReference<unknown> {
    let ref = this.refs.get(field)
    if (ref === undefined) {
      ref = new SyncedConfigReference<unknown>(this.values[field], (port) => { this.ports.set(field, port) })
      this.refs.set(field, ref)
    }
    return ref
  }
}

/** Latest synced values of one package and the Config object of its current plugin activation. */
export class SyncedConfigEntry {
  private values: SyncedConfigValues
  private current: SyncedConfigActivation | undefined

  /** @param values - Host-validated values; they are frozen and not checked against any schema. */
  constructor(values: SyncedConfigValues) {
    this.values = freeze(structuredClone(values)) as SyncedConfigValues
  }

  /** Whether no field currently has a value. */
  get empty(): boolean {
    return Object.keys(this.values).length === 0
  }

  /** The current activation's Config object; undefined between a teardown and the next activation. */
  get config(): object | undefined {
    return this.current?.config
  }

  /**
   * Start an activation: a new Config object holding the latest values; the previous activation stops receiving writes.
   * @returns the object to hand to the activation's `apply`.
   */
  activate(): object {
    this.current = new SyncedConfigActivation(this.values)
    return this.current.config
  }

  /**
   * An activation's teardown has begun; later values wait for the next activation.
   * @param config - the ending activation's object; omitted, the current activation ends.
   */
  release(config?: object): void {
    if (config === undefined || this.current?.config === config) this.current = undefined
  }

  /**
   * Replace the values; the current activation receives the changed fields, if one is running.
   * @param values - the package's complete values; absent fields read undefined.
   */
  update(values: SyncedConfigValues): void {
    this.values = freeze(structuredClone(values)) as SyncedConfigValues
    this.current?.write(this.values)
  }
}
