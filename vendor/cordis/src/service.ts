import { defineProperty, isNullable } from '@deepseek-ai/cosmokit'
import { Context } from './context.ts'
import { locate } from './reflect.ts'
import { createCallable, joinPrototype, symbols, type Tracker } from './utils.ts'

/**
 * Base class for services that expose a named API on `ctx`.
 *
 * Subclasses call `super(ctx, name)` from their constructor. The service is
 * registered immediately and is automatically removed with the owning fiber.
 */
export abstract class Service<out T = never> {
  /** Symbol key of an instance method run after construction (class plugins). */
  static readonly init: unique symbol = symbols.init
  /** Symbol key of the availability predicate passed to `ctx.provide()`. */
  static readonly check: unique symbol = symbols.check
  /** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
  static readonly invoke: unique symbol = symbols.invoke
  /** Symbol key of the phantom intercept-metadata type parameter. */
  static readonly metadata: unique symbol = symbols.metadata
  /** Symbol key of the helper deriving an extended service instance. */
  static readonly extend: unique symbol = symbols.extend
  /** Symbol key of the tracker metadata used for context tracing. */
  static readonly tracker: unique symbol = symbols.tracker
  /** Symbol key of the intercept-metadata merge hook below. */
  static readonly mergeIntercept: unique symbol = symbols.mergeIntercept
  /** Symbol key of the intercept-metadata resolution helper below. */
  static readonly resolveIntercept: unique symbol = symbols.resolveIntercept

  declare [symbols.metadata]: T

  /** The service name this instance is registered under. */
  public name!: string

  /**
   * Register this instance as `name` in the current context.
   *
   * Calls `ctx.reflect.provide(name, this, this[Service.check])`, so the
   * service is unregistered automatically when the owning fiber unloads.
   * Services with a `[Service.invoke]` body return a callable instance.
   *
   * @param ctx — the context to register in (stored as `this.ctx`).
   * @param name — the service name; defaults to the static `provide` field.
   */
  constructor(protected ctx: Context, name: string) {
    name ??= this.constructor['provide'] as string

    let self = this
    const tracker: Tracker = {
      associate: name,
      property: 'ctx',
    }
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker)
    }
    self.ctx = ctx
    self.name = name
    defineProperty(self, symbols.tracker, tracker)

    self.ctx.reflect.provide(name, self, this[symbols.check])
    return self
  }

  protected [symbols.filter](ctx: Context) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name]
  }

  protected [symbols.extend](props?: any) {
    let self: any
    if (this[Service.invoke]) {
      self = createCallable(this.name, this, this[symbols.tracker])
    } else {
      self = Object.create(this)
    }
    return Object.assign(self, props)
  }

  /**
   * Merge intercept metadata values, lowest precedence first.
   *
   * Override to customize merging; the default is a shallow `Object.assign`.
   *
   * @param values — the metadata values in increasing precedence.
   * @returns the merged metadata.
   */
  [symbols.mergeIntercept](...values: T[]): T {
    return Object.assign({}, ...values)
  }

  /**
   * Resolve the intercept metadata visible to the current caller.
   *
   * The metadata injected by the fiber that admits the access applies first,
   * then intercepts added by ancestor contexts, closest to the root first.
   * The values are combined with `[Service.mergeIntercept]`.
   *
   * @returns the merged metadata.
   */
  [symbols.resolveIntercept](): T {
    const values: T[] = []
    let intercept = this.ctx[Context.intercept]
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) {
        values.unshift(intercept[this.name])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    const value = locate((this as any)[symbols.caller] ?? this.ctx, this.name)?.fiber?.inject[this.name]
    if (!isNullable(value)) values.unshift(value)
    const merge = this[symbols.mergeIntercept] ?? Service.prototype[symbols.mergeIntercept]
    return merge.apply(this, values)
  }

  static [Symbol.hasInstance](instance: any) {
    if (!instance) return false
    let constructor = instance.constructor
    while (constructor) {
      // constructor may be a proxy
      constructor = constructor.prototype?.constructor
      if (constructor === this) return true
      constructor &&= Object.getPrototypeOf(constructor)
    }
    return false
  }
}
