import { defineProperty } from '@deepseek-ai/cosmokit'
import type { Context, Service } from './index.ts'

/** Ordered collection of disposable values with O(1) deletion by value. */
export class DisposableList<T extends WeakKey> {
  private sn = 0
  private map = new Map<number, T>()
  private weak = new WeakMap<T, number>()

  get length() {
    return this.map.size
  }

  push(value: T) {
    const sn = ++this.sn
    this.map.set(sn, value)
    this.weak.set(value, sn)
    return () => this.map.delete(sn)
  }

  delete(value: T) {
    const sn = this.weak.get(value)
    if (!sn) return false
    return this.map.delete(sn)
  }

  clear() {
    const values = [...this.map.values()]
    this.map.clear()
    return values.reverse()
  }

  [Symbol.iterator]() {
    return this.map.values()
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return [...this]
  }
}

/** Metadata used by traceable proxies to rebind `ctx` and associated services. */
export interface Tracker {
  associate?: string
  property?: string
  noShadow?: boolean
}

/** Shared symbols used to avoid public property-name collisions. */
export const symbols = {
  // internal symbols
  shadow: Symbol.for('cordis.shadow'),
  caller: Symbol.for('cordis.caller'),
  receiver: Symbol.for('cordis.receiver'),
  original: Symbol.for('cordis.original'),
  metadata: Symbol.for('cordis.metadata'),
  initHooks: Symbol.for('cordis.initHooks'),
  checkProto: Symbol.for('cordis.checkProto'),

  // context symbols
  effect: Symbol.for('cordis.effect') as typeof Context.effect,
  filter: Symbol.for('cordis.filter') as typeof Context.filter,
  isolate: Symbol.for('cordis.isolate') as typeof Context.isolate,
  intercept: Symbol.for('cordis.intercept') as typeof Context.intercept,

  // service symbols
  init: Symbol.for('cordis.init') as typeof Service.init,
  check: Symbol.for('cordis.check') as typeof Service.check,
  config: Symbol.for('cordis.config') as typeof Service.config,
  invoke: Symbol.for('cordis.invoke') as typeof Service.invoke,
  extend: Symbol.for('cordis.extend') as typeof Service.extend,
  tracker: Symbol.for('cordis.tracker') as typeof Service.tracker,
  resolveConfig: Symbol.for('cordis.resolveConfig') as typeof Service.resolveConfig,
}

const GeneratorFunction = function* () {}.constructor
const AsyncGeneratorFunction = async function* () {}.constructor

/** Return true when a plugin callback should be constructed with `new`. */
export function isConstructor(func: any): func is new (...args: any) => any {
  // async function or arrow function
  if (!func.prototype) return false
  // generator function or malformed definition
  // we cannot use below check because `mock.fn()` is proxied
  // if (func.prototype.constructor !== func) return false
  if (func instanceof GeneratorFunction) return false
  // polyfilled AsyncGeneratorFunction === Function
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false
  return true
}

/** Merge two prototype chains while preserving descriptors from `proto1`. */
export function joinPrototype(proto1: {}, proto2: {}) {
  if (proto1 === Object.prototype) return proto2
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2))
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key)!)
  }
  return result
}

/** Return true for non-null objects and functions. */
export function isObject(value: any): value is {} {
  return value && (typeof value === 'object' || typeof value === 'function')
}

/** Find a property descriptor by walking an object's prototype chain. */
export function getPropertyDescriptor(target: any, prop: string | symbol) {
  let proto = target
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop)
    if (desc) return desc
    proto = Object.getPrototypeOf(proto)
  }
}

/** Wrap services/functions so method calls see the caller's active context. */
export function getTraceable<T>(ctx: Context, value: T): T {
  if (!isObject(value)) return value
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker)
}

/** Return a proxy that overlays readonly or writable properties onto a target. */
export function withProps(target: any, props?: {}) {
  if (!props) return target
  return new Proxy(target, {
    get: (target, prop, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.get(props, prop, receiver)
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.set(props, prop, value, receiver)
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

function withProp(target: any, prop: string | symbol, value: any) {
  return withProps(target, Object.defineProperty(Object.create(null), prop, {
    value,
    writable: false,
  }))
}

function createShadow(useSite: Context, target: any, property: string | undefined, receiver: any) {
  if (!property) return receiver
  const value = getPropertyDescriptor(target, property)?.value
  if (!value) return receiver
  const defSite = (value[symbols.shadow] as Context | undefined) ?? value
  return withProp(receiver, property, useSite.extend({ [symbols.shadow]: defSite }))
}

function createShadowMethod(ctx: Context, value: any, outer: any, shadow: {}) {
  return new Proxy(value, {
    apply: (target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
}

// `ctx` may be a shadow, i.e. a pair of:
// - def site: where the accessing code was defined, governs service resolution
// - use site: where the service is consumed, governs intercept, isolate and effects
function createTraceable(ctx: Context, value: any, tracker: Tracker) {
  const defSite = (ctx[symbols.shadow] as Context | undefined) ?? ctx
  const useSite = ctx[symbols.shadow] ? Object.getPrototypeOf(ctx) as Context : ctx
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      if (prop === symbols.original) return target
      if (prop === symbols.caller) return defSite
      if (prop === tracker.property) return useSite
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      // `ctx` rather than `useSite`, so that `ctx.foo.bar` and `ctx['foo.bar']` are
      // governed by the same def site
      if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver))
      }
      let shadow: any, innerValue: any
      const desc = getPropertyDescriptor(target, prop)
      if (desc && 'value' in desc) {
        innerValue = desc.value
      } else {
        shadow = createShadow(useSite, target, tracker.property, receiver)
        innerValue = Reflect.get(target, prop, shadow)
      }
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        return createTraceable(useSite, innerValue, innerTracker)
      } else if (!tracker.noShadow && typeof innerValue === 'function') {
        shadow ??= createShadow(useSite, target, tracker.property, receiver)
        return createShadowMethod(useSite, innerValue, receiver, shadow)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      if (prop === symbols.original) return false
      if (prop === symbols.caller) return false
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver))
      }
      const shadow = createShadow(useSite, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)
    },
    apply: (target, thisArg, args) => {
      const receiver = tracker.noShadow
        ? proxy
        : createShadow(useSite, target, tracker.property, proxy)
      return applyTraceable(receiver, target, thisArg, args)
    },
  })
  return proxy
}

function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

/** Create a callable service object that dispatches through `symbols.invoke`. */
export function createCallable(name: string, proto: {}, tracker: Tracker) {
  const self = function (...args: any[]) {
    const proxy = createTraceable(self['ctx'], self, tracker)
    return Reflect.apply(proxy, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}

interface StackInfo {
  offset: number
  error: Error
}

function handleError(info: StackInfo, reason: any, getOuterStack: () => string[]): never {
  const innerLines = info.error.stack!.split('\n')

  // malformed error
  if (typeof reason?.stack !== 'string') {
    const outerError = new Error(reason)
    const lines = outerError.stack!.split('\n')
    lines.splice(1, Infinity, ...getOuterStack())
    outerError.stack = lines.join('\n')
    throw outerError
  }

  // long stack trace
  const lines: string[] = reason.stack.split('\n')
  let index = lines.indexOf(innerLines[2])
  if (index === -1) throw reason

  index -= info.offset
  while (index > 0) {
    if (!lines[index - 1].endsWith(' (<anonymous>)')) break
    index -= 1
  }
  lines.splice(index, Infinity, ...getOuterStack())
  reason.stack = lines.join('\n')
  throw reason
}

/** Run a callback and splice outer call-site frames into thrown async errors. */
export function composeError<T>(callback: (info: StackInfo) => T, getOuterStack = buildOuterStack()): T {
  const info: StackInfo = { offset: 1, error: new Error() }

  try {
    const result: any = callback(info)
    if (isObject(result) && 'then' in result) {
      return (result as any).then(undefined, (reason) => handleError(info, reason, getOuterStack)) as T
    } else {
      return result
    }
  } catch (reason: any) {
    handleError(info, reason, getOuterStack)
  }
}

/** Capture a lazy stack-frame supplier for later error composition. */
export function buildOuterStack(offset = 0) {
  const outerError = new Error()
  return () => outerError.stack!.split('\n').slice(3 + offset)
}
