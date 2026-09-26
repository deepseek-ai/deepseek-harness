import { Binary, clone, deepEqual, filterKeys, isNullable, isPlainObject, pick, valueMap, type Dict } from '@deepseek-ai/cosmokit'
import { createVolatile, isVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const kSchema = Symbol.for('schemastery')
const kValidationError = Symbol.for('ValidationError')

declare global {
  namespace Schemastery {
    /** Convert primitive constructors, constants, and existing schemas into a schema type. */
    export type From<X> =
      | X extends string | number | boolean ? Schema<X>
      : X extends Schema<any, any, SchemaMode> ? X
      : X extends typeof String ? Schema<string>
      : X extends typeof Number ? Schema<number>
      : X extends typeof Boolean ? Schema<boolean>
      : X extends typeof Function ? Schema<Function, (...args: any[]) => any>
      : X extends Constructor<infer S> ? Schema<S>
      : never

    type TypeS1<X> = X extends Schema<infer S, infer _T, infer _M> ? S : never
    type Inverse<X> = X extends Schema<infer _S, infer T, infer M> ? (arg: SchemaOutput<T, M>) => void : never

    /** Input type accepted by a schema-like value. */
    export type TypeS<X> = TypeS1<From<X>>
    /** Output type returned by a schema-like value after validation. */
    export type TypeT<X> = ReturnType<From<X>>
    /** Resolver callback used by custom schema types registered with `Schema.extend()`. */
    export type Resolve = (data: any, schema: Schema, options: Options, strict?: boolean) => [any, any?]

    /** Input type accepted by one schema in an intersection. */
    export type IntersectS<X> = From<X> extends Schema<infer S, infer _T, infer _M> ? S : never
    /** Output type returned by one schema in an intersection. */
    export type IntersectT<X> = Inverse<From<X>> extends ((arg: infer T) => void) ? T : never

    type TupleS<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeS<L>?, ...TupleS<R>] : any[]
    type TupleT<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeT<L>?, ...TupleT<R>] : any[]
    type ObjectS<X extends Dict> = { [K in keyof X]?: TypeS<X[K]> | null } & Dict
    type ObjectT<X extends Dict> = { [K in keyof X]: TypeT<X[K]> } & Dict
    type Constructor<T = any> = new (...args: any[]) => T

    /** Static constructor and factory methods exposed by the default `Schema` export. */
    export interface Static {
      <T = any>(options: Partial<Schema<T>>): Schema<T>
      new <T = any>(options: Partial<Schema<T>>): Schema<T>
      prototype: Schema
      /** Validate a value against a schema node and return `[output, adaptedInput?]`. */
      resolve: Resolve
      /** Infer a schema from a primitive value, constructor, or existing schema. */
      from<X = any>(source?: X): From<X>
      /** Register a resolver for a custom schema `type`. */
      extend(type: string, resolve: Resolve): void
      /** Accept any value without validation. */
      any<T = any>(): Schema<T>
      /** Accept only nullable input. */
      never(): Schema<never>
      /** Accept exactly one constant value. */
      const<const T>(value: T): Schema<T>
      /** Accept strings, with optional metadata constraints added by instance methods. */
      string(): Schema<string>
      /** Accept numbers, with optional range and step constraints. */
      number(): Schema<number>
      /** Accept non-negative integer numbers. */
      natural(): Schema<number>
      /** Accept a number between 0 and 1 and mark it as a slider. */
      percent(): Schema<number>
      /** Accept booleans. */
      boolean(): Schema<boolean>
      /** Accept `Date` instances or parse datetime strings into `Date` objects. */
      date(): Schema<string | Date, Date>
      /** Accept `RegExp` instances or parse strings into regular expressions. */
      regExp(flag?: string): Schema<string | RegExp, RegExp>
      /** Accept binary sources and normalize them to `ArrayBufferLike`. */
      arrayBuffer(): Schema<Binary.Source, ArrayBufferLike>
      arrayBuffer(encoding: 'hex' | 'base64'): Schema<Binary.Source | string, ArrayBufferLike>
      /** Accept a numeric bitset or string keys and normalize to a number. */
      bitset<K extends string>(bits: Partial<Record<K, number>>): Schema<number | readonly K[], number>
      /** Accept functions. */
      function(): Schema<Function, (...args: any[]) => any>
      /** Accept instances of a constructor or objects whose constructor name matches. */
      is(constructor: string): Schema
      is<T>(constructor: Constructor<T>): Schema<T>
      /** Accept arrays whose elements match `inner`. */
      array<X>(inner: X): Schema<TypeS<X>[], TypeT<X>[]>
      /** Accept plain objects with values matching `inner` and optional key schema. */
      dict<X, Y extends Schema<any, string> = Schema<string>>(inner: X, sKey?: Y): Schema<Dict<TypeS<X>, TypeS<Y>>, Dict<TypeT<X>, TypeT<Y>>>
      /** Accept tuple arrays where each index matches the corresponding schema. */
      tuple<const X extends readonly any[]>(list: X): Schema<TupleS<X>, TupleT<X>>
      /** Accept plain objects; infer fields from the dictionary, not the enclosing schema's output type. */
      object<X extends Dict>(dict: X): Schema<ObjectS<NoInfer<X>>, ObjectT<NoInfer<X>>>
      /** Accept values matching at least one schema in `list`. */
      union<const X>(list: readonly X[]): Schema<TypeS<X>, TypeT<X>>
      /** Accept values matching every schema in `list`, merging object outputs. */
      intersect<const X>(list: readonly X[]): Schema<IntersectS<X>, IntersectT<X>>
      /** Validate with `inner`, then convert the result with `callback`. */
      transform<X, T>(inner: X, callback: (value: TypeS<X>, options: Schemastery.Options) => T, preserve?: boolean): Schema<TypeS<X>, T>
      /** Defer construction of a recursive schema until validation or serialization. */
      lazy<X extends Schema<any, any, SchemaMode>>(callback: () => X): X
      ValidationError: typeof ValidationError
    }

    /** Runtime validation options shared by all schema calls. */
    interface Options {
      /** Remove invalid object properties instead of throwing when possible. */
      autofix?: boolean
      /** Skip validation for selected values and schema nodes. */
      ignore?(data: any, schema: Schema): boolean
      /** Path used to format nested validation errors. */
      path?: (keyof any)[]
    }

    /** UI and validation metadata attached by schema builder methods. */
    export interface Meta<T = any> {
      default?: T extends {} ? Partial<T> : T
      required?: boolean
      /** Parse this node as a stable config reference; its type and UI metadata remain unchanged. */
      volatile?: boolean
      disabled?: boolean
      collapse?: boolean
      badges?: { text: string; type: string }[]
      hidden?: boolean
      loose?: boolean
      role?: string
      extra?: any
      link?: string
      description?: string | Dict<string>
      comment?: string
      pattern?: { source: string; flags?: string }
      max?: number
      min?: number
      step?: number
    }
  }

  /** Callable schema instance that validates input and returns normalized output. */
  interface Schemastery<S = any, T = S, Mode extends SchemaMode = 'plain'> {
    (data?: S | null, options?: Schemastery.Options): SchemaOutput<T, Mode>
    new (data?: S | null, options?: Schemastery.Options): SchemaOutput<T, Mode>
    [kSchema]: true
    uid: number
    meta: Schemastery.Meta<T>
    type: string
    sKey?: Schema
    inner?: Schema
    list?: Schema[]
    dict?: Dict<Schema>
    bits?: Dict<number>
    callback?: Function
    constructor?: string | Function
    builder?: Function
    value?: T
    refs?: Dict<Schema>
    preserve?: boolean
    '~standard': StandardSchemaV1.Props // <S, T>
    /** Format this schema as a compact TypeScript-like type string. */
    toString(inline?: boolean): string
    /** Serialize this schema, preserving shared and recursive references. */
    toJSON(): Schema<S, T, Mode>
    /** Mark nullable input as invalid unless a default supplies a fallback. */
    required<R extends boolean = true>(value?: R): Schema<S, T, SetRequired<Mode, R>>
    /**
     * Parse this config field as a stable reference containing immutable data.
     * @returns a schema whose output supports get(), including when the field is absent.
     */
    volatile(): Schema<NoInfer<S>, NoInfer<T>, Mode extends 'defined' | 'volatile-defined' ? 'volatile-defined' : 'volatile'>
    /** Hide this schema node from UI renderers. */
    hidden(value?: boolean): Schema<S, T, Mode>
    /** Return the default value instead of throwing when validation fails. */
    loose(value?: boolean): Schema<S, T, Mode>
    /** Attach a renderer role and optional role-specific metadata. */
    role(text: string, extra?: any): Schema<S, T, Mode>
    /** Attach an external documentation link. */
    link(link: string): Schema<S, T, Mode>
    /** Set the fallback value used for nullable input. */
    default(value: T | NoInfer<Partial<S>>): Schema<S, T, SetRequired<Mode, true>>
    /** Attach an auxiliary comment for documentation or form UIs. */
    comment(text: string): Schema<S, T, Mode>
    /** Attach a localized or plain description for documentation or form UIs. */
    description(text: string): Schema<S, T, Mode>
    /** Mark this schema node as disabled for form UIs. */
    disabled(value?: boolean): Schema<S, T, Mode>
    /** Request collapsed rendering for nested form UIs. */
    collapse(value?: boolean): Schema<S, T, Mode>
    /** Add a deprecated badge to this schema node. */
    deprecated(): Schema<S, T, Mode>
    /** Add an experimental badge to this schema node. */
    experimental(): Schema<S, T, Mode>
    /** Require strings to match a regular expression. */
    pattern(regexp: RegExp): Schema<S, T, Mode>
    /** Set an inclusive maximum for numbers or collection lengths. */
    max(value: number): Schema<S, T, Mode>
    /** Set an inclusive minimum for numbers or collection lengths. */
    min(value: number): Schema<S, T, Mode>
    /** Set the numeric increment constraint. */
    step(value: number): Schema<S, T, Mode>
    /** Add or replace an object property schema. */
    set(key: string, value: Schema): Schema<S, T, Mode>
    /** Append a tuple, union, or intersection member schema. */
    push(value: Schema): Schema<S, T, Mode>
    /** Remove values equal to schema defaults from normalized output. */
    simplify(value?: any): any
    /** Return a schema clone with descriptions merged from locale messages. */
    i18n(messages: Dict): Schema<S, T, Mode>
    /** Attach arbitrary metadata consumed by form renderers and downstream tools. */
    extra<K extends keyof Schemastery.Meta>(key: K, value: Schemastery.Meta[K]): Schema<S, T, Mode>
  }
}

declare namespace globalThis {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  export let __schemastery_index__: number
  export let __schemastery_refs__: Record<number, Schema> | undefined
}

globalThis.__schemastery_index__ ??= 0
globalThis.__schemastery_refs__ = undefined

class ValidationError extends TypeError {
  name = 'ValidationError'

  constructor(message: string, public options: Schemastery.Options) {
    let prefix = '$'
    for (const segment of options.path || []) {
      if (typeof segment === 'string') {
        prefix += '.' + segment
      } else if (typeof segment === 'number') {
        prefix += '[' + segment + ']'
      } else if (typeof segment === 'symbol') {
        prefix += `[Symbol(${segment.toString()})]`
      }
    }
    if (prefix.startsWith('.')) prefix = prefix.slice(1)
    super((prefix === '$' ? '' : `${prefix} `) + message)
  }

  static is(error: any): error is ValidationError {
    return !!error?.[kValidationError]
  }
}

Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true,
})

type SchemaMode = 'plain' | 'defined' | 'volatile' | 'volatile-defined'
type SchemaOutput<T, M extends SchemaMode> = M extends 'volatile' ? Volatile<T | undefined>
  : M extends 'volatile-defined' ? Volatile<T> : T
type SetRequired<M extends SchemaMode, R extends boolean> = M extends 'volatile' | 'volatile-defined'
  ? R extends true ? 'volatile-defined' : 'volatile'
  : R extends true ? 'defined' : 'plain'

type Schema<S = any, T = S, Mode extends SchemaMode = 'plain'> = Schemastery<S, T, Mode>

const Schema = function (options: Schema) {
  const schema = function (data: any, options: Schemastery.Options = {}) {
    return Schema.resolve(data, schema, options)[0]
  } as Schema

  if (options.refs) {
    const refs = valueMap(options.refs, options => new Schema(options))
    const getRef = (uid: any) => refs[uid]!
    for (const key in refs) {
      const options = refs[key]!
      options.sKey = getRef(options.sKey)
      options.inner = getRef(options.inner)
      options.list = options.list && options.list.map(getRef)
      options.dict = options.dict && valueMap(options.dict, getRef)
    }
    return refs[options.uid!]
  }

  Object.assign(schema, options)
  if (typeof schema.callback === 'string') {
    try {
      // eslint-disable-next-line no-new-func
      schema.callback = new Function('return ' + schema.callback)()
    } catch {}
  }
  Object.defineProperty(schema, 'uid', { value: globalThis.__schemastery_index__++ })
  Object.setPrototypeOf(schema, Schema.prototype)
  schema.meta ||= {}
  schema.toString = schema.toString.bind(schema)
  return schema
} as Schemastery.Static

Schema.prototype = Object.create(Function.prototype)

Schema.prototype[kSchema] = true

Object.defineProperty(Schema.prototype, '~standard', {
  get(this: Schema) {
    return {
      version: 1,
      vendor: 'schemastery',
      validate: (value: unknown) => {
        try {
          return { value: Schema.resolve(value, this, {})[0] }
        } catch (error) {
          if (ValidationError.is(error)) {
            return { issues: [{ message: error.message, path: error.options.path }] }
          }
          throw error
        }
      },
    }
  },
})

Schema.ValidationError = ValidationError

Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }))
    return this.uid as any
  }

  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } as Schema }
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }))
  const result = { uid: this.uid, refs: globalThis.__schemastery_refs__ }
  globalThis.__schemastery_refs__ = undefined
  return result
}

Schema.prototype.set = function set(key, value) {
  this.dict![key] = value
  return this
}

Schema.prototype.push = function push(value) {
  this.list!.push(value)
  return this
}

function mergeDesc(original: undefined | string | Dict<string>, messages: Dict) {
  const result: Dict<string> = typeof original === 'string' ? { '': original } : { ...original }
  for (const locale in messages) {
    const value = messages[locale]
    if (value?.$description || value?.$desc) {
      result[locale] = value.$description || value.$desc
    } else if (typeof value === 'string') {
      result[locale] = value
    }
  }
  return result
}

function getInner(value: any) {
  return value?.$value ?? value?.$inner
}

function extractKeys(data: any) {
  return filterKeys(data ?? {}, key => !key.startsWith('$'))
}

Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this)
  const desc = mergeDesc(schema.meta.description, messages)
  if (Object.keys(desc).length) schema.meta.description = desc
  if (schema.dict) {
    schema.dict = valueMap(schema.dict, (inner, key) => {
      return inner.i18n(valueMap(messages, (data) => getInner(data)?.[key] ?? data?.[key]))
    })
  }
  if (schema.list) {
    schema.list = schema.list!.map((inner, index) => {
      return inner.i18n(valueMap(messages, (data = {}) => {
        if (Array.isArray(getInner(data))) return getInner(data)[index]
        if (Array.isArray(data)) return data[index]
        return extractKeys(data)
      }))
    })
  }
  if (schema.inner) {
    schema.inner = schema.inner.i18n(valueMap(messages, (data) => {
      if (getInner(data)) return getInner(data)
      return extractKeys(data)
    }))
  }
  if (schema.sKey) {
    schema.sKey = schema.sKey.i18n(valueMap(messages, (data) => data?.$key))
  }
  return schema
}

Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this)
  schema.meta = { ...schema.meta, [key]: value }
  return schema
}

for (const key of ['required', 'disabled', 'collapse', 'hidden', 'loose']) {
  Object.assign(Schema.prototype, {
    [key](this: Schema, value = true) {
      const schema = Schema(this)
      schema.meta = { ...schema.meta, [key]: value }
      return schema
    },
  })
}

Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this)
  schema.meta.badges ||= []
  schema.meta.badges.push({ text: 'deprecated', type: 'danger' })
  return schema
}

Schema.prototype.experimental = function experimental() {
  const schema = Schema(this)
  schema.meta.badges ||= []
  schema.meta.badges.push({ text: 'experimental', type: 'warning' })
  return schema
}

Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this)
  const pattern = pick(regexp, ['source', 'flags'])
  schema.meta = { ...schema.meta, pattern }
  return schema
}

Schema.prototype.simplify = function simplify(this: Schema, value) {
  if (isVolatile(value)) value = value.get()
  if (deepEqual(value, this.meta.default, this.type === 'dict')) return null
  if (isNullable(value)) return value
  if (this.type === 'object' || this.type === 'dict') {
    const result: Dict = {}
    for (const key in value) {
      const schema = this.type === 'object' ? this.dict![key] : this.inner
      const item = schema?.simplify(value[key])
      if (this.type === 'dict' || !isNullable(item)) result[key] = item
    }
    if (deepEqual(result, this.meta.default, this.type === 'dict')) return null
    return result
  } else if (this.type === 'array' || this.type === 'tuple') {
    const result: any[] = []
    ;(value as any[]).forEach((value, index) => {
      const schema = this.type === 'array' ? this.inner : this.list![index]
      const item = schema ? schema.simplify(value) : value
      result.push(item)
    })
    return result
  } else if (this.type === 'intersect') {
    const result: Dict = {}
    for (const item of this.list!) {
      Object.assign(result, item.simplify(value))
    }
    return result
  } else if (this.type === 'union') {
    for (const schema of this.list!) {
      try {
        Schema.resolve(value, schema, {})
        return schema.simplify(value)
      } catch {}
    }
  }
  return value
}

Schema.prototype.toString = function toString(inline?: boolean) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`
}

Schema.prototype.role = function role(role, extra) {
  const schema = Schema(this)
  schema.meta = { ...schema.meta, role, extra }
  return schema
}

for (const key of ['default', 'link', 'comment', 'description', 'max', 'min', 'step']) {
  Object.assign(Schema.prototype, {
    [key](this: Schema, value: any) {
      const schema = Schema(this)
      schema.meta = { ...schema.meta, [key]: value }
      return schema
    },
  })
}

Schema.prototype.volatile = function volatile() {
  if (this.meta.volatile) throw new TypeError('volatile schema is already wrapped')
  return this.extra('volatile', true)
}

const resolvers: Dict<Schemastery.Resolve> = {}
const checkedVolatile = Symbol('checked-volatile-schema')

function validateVolatileSchema(schema: Schema, path: (keyof any)[] = [], blocked = false, seen = new Map<Schema, Set<boolean>>()) {
  const states = seen.get(schema) ?? new Set<boolean>()
  if (states.has(blocked)) return
  states.add(blocked)
  seen.set(schema, states)
  if (schema.meta?.volatile && blocked) {
    throw new ValidationError('volatile fields require a fixed object path without an enclosing volatile field', { path })
  }
  const nested = blocked || !!schema.meta?.volatile
  if (schema.dict) {
    for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen)
  }
  if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, '<key>'], true, seen)
  if (schema.inner && (schema.type !== 'lazy' || schema.inner[kSchema])) {
    validateVolatileSchema(schema.inner, [...path, '*'], true, seen)
  }
  if (schema.list) {
    for (let index = 0; index < schema.list.length; index++) {
      validateVolatileSchema(schema.list[index]!, [...path, String(index)], true, seen)
    }
  }
}

Schema.extend = function extend(type, resolve) {
  resolvers[type] = resolve
}

Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
  if (!schema) return [data]
  if (!(options as Schemastery.Options & { [checkedVolatile]?: boolean })[checkedVolatile]) {
    validateVolatileSchema(schema, options.path)
    options = { ...options, [checkedVolatile]: true } as Schemastery.Options
  }
  if (schema.meta?.volatile) {
    const inner = Schema(schema)
    inner.meta = { ...schema.meta, volatile: false }
    const [value, adapted] = Schema.resolve(data, inner, options, strict)
    try {
      return [createVolatile(value), adapted]
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error), options)
    }
  }
  if (options.ignore?.(data, schema)) return [data]

  if (isNullable(data) && schema.type !== 'lazy') {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options)
    let current = schema
    let fallback = schema.meta.default
    while (current?.type === 'intersect' && isNullable(fallback)) {
      current = current.list![0]
      fallback = current?.meta.default
    }
    if (isNullable(fallback)) return [data]
    data = clone(fallback)
  }

  const callback = resolvers[schema.type]
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options)

  try {
    return callback(data, schema, options, strict)
  } catch (error) {
    if (!schema.meta.loose) throw error
    return [schema.meta.default]
  }
}

Schema.from = function from(source: any) {
  if (isNullable(source)) {
    return Schema.any()
  } else if (['string', 'number', 'boolean'].includes(typeof source)) {
    return Schema.const(source).required()
  } else if (source[kSchema]) {
    return source
  } else if (typeof source === 'function') {
    switch (source) {
      case String: return Schema.string().required()
      case Number: return Schema.number().required()
      case Boolean: return Schema.boolean().required()
      case Function: return Schema.function().required()
      default: return Schema.is(source).required()
    }
  } else {
    throw new TypeError(`cannot infer schema from ${source}`)
  }
}

Schema.lazy = function lazy(builder) {
  const toJSON = () => {
    if (!schema.inner![kSchema]) {
      schema.inner = schema.builder!()
      schema.inner!.meta = { ...schema.meta, ...schema.inner!.meta }
    }
    return schema.inner!.toJSON()
  }
  const schema = new Schema({ type: 'lazy', builder, inner: { toJSON } as any })
  return schema as any
}

Schema.natural = function natural() {
  return Schema.number().step(1).min(0)
}

Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role('slider')
}

Schema.date = function date() {
  return Schema.union([
    Schema.is(Date),
    Schema.transform(Schema.string().role('datetime'), (value, options) => {
      const date = new Date(value)
      if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options)
      return date
    }, true),
  ])
}

Schema.regExp = function regExp(flag = '') {
  return Schema.union([
    Schema.is(RegExp),
    Schema.transform(Schema.string().role('regexp', { flag }), (value, options) => {
      try {
        return new RegExp(value, flag)
      } catch (e: any) {
        throw new ValidationError(e.message, options)
      }
    }, true),
  ])
}

Schema.arrayBuffer = function arrayBuffer(encoding?: 'hex' | 'base64'): any {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any<ArrayBufferView>(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value)
      throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options)
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === 'base64'
          ? Binary.fromBase64(value)
          : Binary.fromHex(value)
      } catch (e: any) {
        throw new ValidationError(e.message, options)
      }
    }, true)] as const : [],
  ])
}

Schema.extend('lazy', (data, schema, options, strict) => {
  if (!schema.inner![kSchema]) {
    schema.inner = schema.builder!()
    schema.inner!.meta = { ...schema.meta, ...schema.inner!.meta }
    validateVolatileSchema(schema.inner!, options.path, true)
  }
  return Schema.resolve(data, schema.inner!, options, strict)
})

Schema.extend('any', (data) => {
  return [data]
})

Schema.extend('never', (data, _, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options)
})

Schema.extend('const', (data, { value }, options) => {
  if (deepEqual(data, value)) return [value]
  throw new ValidationError(`expected ${value} but got ${data}`, options)
})

function checkWithinRange(data: number, meta: Schemastery.Meta<any>, description: string, options: Schemastery.Options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options)
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options)
}

Schema.extend('string', (data, { meta }, options) => {
  if (typeof data !== 'string') throw new ValidationError(`expected string but got ${data}`, options)
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags)
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options)
  }
  checkWithinRange(data.length, meta, 'string length', options)
  return [data]
})

function decimalShift(data: number, digits: number) {
  const str = data.toString()
  if (str.includes('e')) return data * Math.pow(10, digits)
  const index = str.indexOf('.')
  if (index === -1) return data * Math.pow(10, digits)
  const frac = str.slice(index + 1)
  const integer = str.slice(0, index)
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, '0'))
  return +(integer + frac.slice(0, digits) + '.' + frac.slice(digits))
}

function isMultipleOf(data: number, min: number, step: number) {
  step = Math.abs(step)
  if (!/^\d+\.\d+$/.test(step.toString())) {
    return (data - min) % step === 0
  }
  const index = step.toString().indexOf('.')
  const digits = step.toString().slice(index + 1).length
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0
}

Schema.extend('number', (data, { meta }, options) => {
  if (typeof data !== 'number') throw new ValidationError(`expected number but got ${data}`, options)
  checkWithinRange(data, meta, 'number', options)
  const { step } = meta
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) {
    throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options)
  }
  return [data]
})

Schema.extend('boolean', (data, _, options) => {
  if (typeof data === 'boolean') return [data]
  throw new ValidationError(`expected boolean but got ${data}`, options)
})

Schema.extend('bitset', (data, { bits, meta }, options) => {
  let value = 0, keys: string[] = []
  if (typeof data === 'number') {
    value = data
    for (const key in bits!) {
      if (data & bits![key]!) {
        keys.push(key)
      }
    }
  } else if (Array.isArray(data)) {
    keys = data
    for (const key of keys) {
      if (typeof key !== 'string') throw new ValidationError(`expected string but got ${key}`, options)
      if (key in bits!) value |= bits![key]!
    }
  } else {
    throw new ValidationError(`expected number or array but got ${data}`, options)
  }
  if (value === meta.default) return [value]
  return [value, keys]
})

Schema.extend('function', (data, _, options) => {
  if (typeof data === 'function') return [data]
  throw new ValidationError(`expected function but got ${data}`, options)
})

Schema.extend('is', (data, { constructor }, options) => {
  if (typeof constructor === 'function') {
    if (data instanceof constructor) return [data]
    throw new ValidationError(`expected ${constructor.name} but got ${data}`, options)
  } else {
    if (isNullable(data)) {
      throw new ValidationError(`expected ${constructor} but got ${data}`, options)
    }
    let prototype = Object.getPrototypeOf(data)
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data]
      prototype = Object.getPrototypeOf(prototype)
    }
    throw new ValidationError(`expected ${constructor} but got ${data}`, options)
  }
})

function property(data: any, key: keyof any, schema: Schema, options: Schemastery.Options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key],
    })
    if (adapted !== undefined) data[key] = adapted
    return value
  } catch (e) {
    if (!options?.autofix) throw e
    delete data[key]
    return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default
  }
}

Schema.extend('array', (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options)
  checkWithinRange(data.length, meta, 'array length', options, !isNullable(inner!.meta.default))
  return [data.map((_, index) => property(data, index, inner!, options))]
})

Schema.extend('dict', (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options)
  const result: any = {}
  for (const key in data) {
    let rKey: string
    try {
      rKey = Schema.resolve(key, sKey!, options)[0]
    } catch (error) {
      if (strict) continue
      throw error
    }
    result[rKey] = property(data, key, inner!, options)
    data[rKey] = data[key]
    if (key !== rKey) delete data[key]
  }
  return [result]
})

Schema.extend('tuple', (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options)
  const result = list!.map((inner, index) => property(data, index, inner, options))
  if (strict) return [result]
  result.push(...data.slice(list!.length))
  return [result]
})

function merge(result: any, data: any) {
  for (const key in data) {
    if (key in result) continue
    result[key] = data[key]
  }
}

Schema.extend('object', (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options)
  const result: any = {}
  for (const key in dict) {
    const value = property(data, key, dict![key]!, options)
    if (!isNullable(value) || key in data) {
      result[key] = value
    }
  }
  if (!strict) merge(result, data)
  return [result]
})

Schema.extend('union', (data, { list, toString }, options, strict) => {
  const messages: any[] = []
  for (const inner of list!) {
    try {
      return Schema.resolve(data, inner, options, strict)
    } catch (error) {
      messages.push(error)
    }
  }
  throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options)
})

Schema.extend('intersect', (data, { list, toString }, options, strict) => {
  if (!list!.length) return [data]
  let result
  for (const inner of list!) {
    const value: any = Schema.resolve(data, inner, options, true)[0]
    if (isNullable(value)) continue
    if (isNullable(result)) {
      result = value
    } else if (typeof result !== typeof value) {
      throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options)
    } else if (typeof value === 'object') {
      merge(result ??= {}, value)
    } else if (result !== value) {
      throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options)
    }
  }
  if (!strict && isPlainObject(data)) merge(result, data)
  return [result]
})

Schema.extend('transform', (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner!, options, true)
  if (preserve) {
    return [callback!(result)]
  // } else if (isPlainObject(data)) {
  //   const temp: any = {}
  //   for (const key in result) {
  //     if (!(key in data)) continue
  //     temp[key] = data[key]
  //     delete data[key]
  //   }
  //   Object.assign(data, callback!(temp))
  //   return [callback!(result)]
  } else {
    return [callback!(result), callback!(adapted)]
  }
})

type Formatter = (schema: Schema, inline?: boolean) => string
const formatters: Dict<Formatter> = {}

function defineMethod(name: string, keys: (keyof Schema)[], format: Formatter) {
  formatters[name] = format
  Object.assign(Schema, {
    [name](...args: any[]) {
      const schema = new Schema({ type: name } as Schema)
      keys.forEach((key, index) => {
        switch (key) {
          case 'sKey': schema.sKey = args[index] ?? Schema.string(); break
          case 'inner': schema.inner = Schema.from(args[index]); break
          case 'list': schema.list = args[index].map(Schema.from); break
          case 'dict': schema.dict = valueMap(args[index], Schema.from); break
          case 'bits': {
            schema.bits = {}
            for (const key in args[index]) {
              if (typeof args[index][key] !== 'number') continue
              schema.bits[key] = args[index][key]
            }
            break
          }
          case 'callback': {
            const callback = schema.callback = args[index]
            ;callback['toJSON'] ||= () => callback.toString()
            break
          }
          case 'constructor': {
            const constructor = schema.constructor = args[index]
            if (typeof constructor === 'function') {
              ;constructor['toJSON'] ||= () => constructor['name']
            }
            break
          }
          default: schema[key] = args[index] as never
        }
      })
      if (name === 'object' || name === 'dict') {
        schema.meta.default = {}
      } else if (name === 'array' || name === 'tuple') {
        schema.meta.default = []
      } else if (name === 'bitset') {
        schema.meta.default = 0
      }
      return schema
    },
  })
}

defineMethod('is', ['constructor'], ({ constructor }) => {
  if (typeof constructor === 'function') {
    return constructor.name
  } else {
    return constructor!
  }
})

defineMethod('any', [], () => 'any')
defineMethod('never', [], () => 'never')
defineMethod('const', ['value'], ({ value }) => typeof value === 'string' ? JSON.stringify(value) : value)
defineMethod('string', [], () => 'string')
defineMethod('number', [], () => 'number')
defineMethod('boolean', [], () => 'boolean')
defineMethod('bitset', ['bits'], () => 'bitset')
defineMethod('function', [], () => 'function')
defineMethod('array', ['inner'], ({ inner }) => `${inner!.toString(true)}[]`)
defineMethod('dict', ['inner', 'sKey'], ({ inner, sKey }) => `{ [key: ${sKey!.toString()}]: ${inner!.toString()} }`)
defineMethod('tuple', ['list'], ({ list }) => `[${list!.map((inner) => inner.toString()).join(', ')}]`)

defineMethod('object', ['dict'], ({ dict }) => {
  if (Object.keys(dict!).length === 0) return '{}'
  return `{ ${Object.entries(dict!).map(([key, inner]) => {
    return `${key}${inner!.meta.required ? '' : '?'}: ${inner!.toString()}`
  }).join(', ')} }`
})

defineMethod('union', ['list'], ({ list }, inline) => {
  const result = list!.map(({ toString: format }) => format()).join(' | ')
  return inline ? `(${result})` : result
})

defineMethod('intersect', ['list'], ({ list }) => {
  return `${list!.map((inner) => inner.toString(true)).join(' & ')}`
})

defineMethod('transform', ['inner', 'callback', 'preserve'], ({ inner }, isInner) => inner!.toString(isInner))

export default Schema
