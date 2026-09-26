/** Project native Config input constraints without executing their validators or transform callbacks. */

import type { ConfigJsonSchema, ConfigJsonSchemaObject, NativeConfigSchema } from './types.ts'
import { isNativeConfigSchema } from './native.ts'
import { createPatternCheck } from './pattern.ts'

/** Definition that projected value positions reference as `#/$defs/loaderExpression`; an enclosing document must define it. */
export const LOADER_EXPRESSION_SCHEMA: ConfigJsonSchemaObject = {
  type: 'object', properties: { __jsExpr: { type: 'string' } }, required: ['__jsExpr'],
  description: 'Inert representation of a YAML !!js scalar from the Cordis entry-list parser. Its result is evaluated and validated only at runtime. Extra marker-object fields are ignored by interpolation.',
}

/** One Config projection; unknown omission behavior is explicit rather than an invented default. */
export interface ConfigProjection {
  /** Object-form root: value positions are wrapped in `anyOf` with the loader-expression reference. */
  schema: ConfigJsonSchemaObject
  definitions: Record<string, ConfigJsonSchema>
  acceptsMissing: boolean | 'unknown'
  limitations: string[]
}

interface InputSchema extends ConfigJsonSchemaObject {
  'x-cordis'?: Record<string, unknown>
  properties?: Record<string, InputSchema>
  patternProperties?: Record<string, InputSchema>
  items?: InputSchema | false
  additionalProperties?: InputSchema | false
  propertyNames?: InputSchema
  prefixItems?: InputSchema[]
  anyOf?: InputSchema[]
  not?: InputSchema
}

interface NodeProjection {
  schema: InputSchema
  acceptsMissing: boolean | 'unknown'
  exact: boolean
  recursive: boolean
  /** Native adaptation, key normalization, or opaque code may affect surrounding validation. */
  effectful: boolean
  /** Native resolution may write adapted values or renamed keys into the input before a later union branch reads it. */
  mutating: boolean
}

/** Copy JSON-compatible schema annotations without silently converting non-JSON defaults. */
function jsonValue(value: unknown, nullifyUndefined = false): unknown {
  const visit = (item: unknown, active: Set<object>): void => {
    if (nullifyUndefined && item === undefined) return
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object') throw new Error('schema annotation is not JSON-compatible')
    if (active.has(item)) throw new Error('schema annotation contains a cycle')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error('schema annotation contains a non-JSON object')
    }
    active.add(item)
    for (const child of Object.values(item)) visit(child, active)
    active.delete(item)
  }
  visit(value, new Set())
  const result: unknown = JSON.parse(JSON.stringify(value,
    (_key: string, item: unknown) => nullifyUndefined && item === undefined ? null : item))
  return result
}

/** Native constant equality treats omitted and null-valued object members alike. */
function constant(value: unknown, objectComparison: () => void): InputSchema {
  if (Array.isArray(value)) {
    return {
      type: 'array', minItems: value.length, maxItems: value.length, items: false,
      ...(value.length ? { prefixItems: Array.from(value, item => constant(item, objectComparison)) } : {}),
    }
  }
  if (value !== null && typeof value === 'object') {
    objectComparison()
    const properties = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, constant(child, objectComparison)]))
    const inherited = Object.getOwnPropertyNames(Object.prototype)
    const required = Object.keys(properties).filter(key => !inherited.includes(key) && Reflect.get(value, key) != null)
    const pattern = inherited.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    return {
      type: 'object', properties, additionalProperties: { type: 'null' },
      patternProperties: { [`^(?:${pattern})$`]: {} },
      ...(required.length ? { required } : {}),
    }
  }
  return { const: value }
}

/** Add or remove null acceptance; a type list stays deduplicated because a wrapped projection may already accept null. */
function nullable(core: InputSchema | boolean, accepts: boolean): InputSchema | boolean {
  if (typeof core === 'boolean') return accepts ? core || { type: 'null' } : core && { not: { type: 'null' } }
  const types = typeof core.type === 'string' ? [core.type] : core.type
  if (types === undefined) return accepts ? { anyOf: [core, { type: 'null' }] } : { ...core, not: { type: 'null' } }
  const [single, ...rest] = accepts ? [...new Set([...types, 'null'])] : types.filter(type => type !== 'null')
  if (single === undefined) return false
  return { ...core, type: rest.length ? [single, ...rest] : single }
}

/** Add expression alternatives only at config VALUE positions, not property names or applicator branches. */
function expressions(schema: InputSchema, valuePosition = true, enabled = true): InputSchema {
  const result: InputSchema = { ...schema }
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties)
      .map(([key, child]) => [key, expressions(child, true, enabled)]))
  }
  for (const key of ['items', 'additionalProperties'] as const) {
    if (schema[key] !== undefined) result[key] = schema[key] === false ? false : expressions(schema[key], true, enabled)
  }
  if (schema.propertyNames) result.propertyNames = expressions(schema.propertyNames, false, false)
  if (schema.prefixItems) result.prefixItems = schema.prefixItems.map(child => expressions(child, true, enabled))
  if (schema.anyOf) result.anyOf = schema.anyOf.map(child => expressions(child, false, enabled))
  if (schema.not !== undefined) result.not = expressions(schema.not, false, false)
  if (!valuePosition || !enabled) return result
  const annotations: InputSchema = {}
  for (const key of ['title', 'description', 'default', '$comment', 'x-cordis']) {
    if (Object.hasOwn(result, key)) {
      annotations[key] = result[key]
      Reflect.deleteProperty(result, key)
    }
  }
  return { ...annotations, anyOf: [result, { $ref: '#/$defs/loaderExpression' }] }
}

/** Check native volatile containment without evaluating values or invoking unresolved lazy builders. */
function validateVolatilePlacement(
  node: NativeConfigSchema, path: string, blocked = false,
  seen = new Map<NativeConfigSchema, Set<boolean>>(),
): void {
  const states = seen.get(node) ?? new Set<boolean>()
  if (states.has(blocked)) return
  states.add(blocked)
  seen.set(node, states)
  if (node.meta.volatile && blocked) throw new Error(`${path}: volatile fields require a fixed object path without an enclosing volatile field`)
  const nested = blocked || !!node.meta.volatile
  for (const [key, child] of Object.entries(node.dict ?? {})) validateVolatilePlacement(child, `${path}/${key}`, nested, seen)
  if (node.sKey) validateVolatilePlacement(node.sKey, `${path}/keys`, true, seen)
  if (node.inner && (node.type !== 'lazy' || isNativeConfigSchema(node.inner))) {
    validateVolatilePlacement(node.inner, `${path}/inner`, true, seen)
  }
  for (const [index, child] of (node.list ?? []).entries()) validateVolatilePlacement(child, `${path}/${index}`, true, seen)
}

/**
 * Create an invocation-local projector. Ajv checks only literal defaults against generated schemas;
 * it does not fill defaults, coerce input, or call native plugin validators. Opaque input or metadata effects
 * widen validation with explicit limitations instead of simulating native mutation.
 * @returns a function projecting one trusted native Config graph into the enclosing document's definitions.
 */
export async function createConfigProjector(): Promise<(root: NativeConfigSchema, prefix: string) => ConfigProjection> {
  const { Ajv2020 } = await import('ajv/dist/2020.js')
  const validator = new Ajv2020({ strict: false, logger: false, validateFormats: false, addUsedSchema: false })
  const portablePattern = await createPatternCheck()
  // Native lazy resolution invokes each builder once; later visits through other chains reuse the first result.
  const builderResults = new Map<NativeConfigSchema, unknown>()
  return (root, prefix) => {
    validateVolatilePlacement(root, 'config')
    const completed = new Map<NativeConfigSchema, NodeProjection>()
    const strictNodes = new Map<NativeConfigSchema, NativeConfigSchema>()
    const active = new Set<NativeConfigSchema>()
    const recursiveNames = new Map<NativeConfigSchema, string>()
    const definitions: Record<string, InputSchema> = {}
    const limitations: string[] = []
    const metadataEffects: string[] = []
    const limitation = (path: string, message: string): string => {
      const text = `${path}: ${message}`
      limitations.push(text)
      return text
    }

    const visit = (node: NativeConfigSchema, path: string, strict = false): NodeProjection => {
      let key = node
      if (strict) {
        key = strictNodes.get(node) ?? { ...node }
        strictNodes.set(node, key)
      }
      const cached = completed.get(key)
      if (cached) return cached
      if (active.has(key)) {
        let name = recursiveNames.get(key)
        if (name === undefined) {
          name = `${prefix}Recursive${recursiveNames.size}`
          recursiveNames.set(key, name)
        }
        return {
          schema: { $ref: `#/$defs/${name}` }, acceptsMissing: node.type !== 'lazy' && node.meta.required ? false : 'unknown',
          exact: true, recursive: true, effectful: true, mutating: true,
        }
      }
      active.add(key)
      let projection: NodeProjection
      if (node.type === 'lazy') {
        let inner = node
        let meta = node.meta.volatile ? { ...node.meta, volatile: false } : node.meta
        const chain = new Set<NativeConfigSchema>()
        let looseProjection: NodeProjection | undefined
        while (inner.type === 'lazy') {
          const cachedInner = isNativeConfigSchema(inner.inner)
          if (meta.loose) {
            const message = limitation(path, 'lazy loose fallback can accept inputs rejected by its inner schema')
            if (!cachedInner) metadataEffects.push(limitation(path, 'unresolved loose lazy metadata propagation may affect shared schemas'))
            looseProjection = {
              schema: { 'x-cordis': { loose: true, limitations: [message] } },
              acceptsMissing: true, exact: false, recursive: false, effectful: true, mutating: false,
            }
            break
          }
          if (chain.has(inner)) throw new Error(`${path}: lazy cycle has no concrete schema`)
          chain.add(inner)
          let next: unknown = cachedInner ? inner.inner : builderResults.get(inner)
          if (next === undefined && typeof inner.builder === 'function') {
            next = Reflect.apply(inner.builder, inner, [])
            builderResults.set(inner, next)
          }
          if (!isNativeConfigSchema(next)) throw new Error(`${path}: lazy schema has no native builder result or resolved inner schema`)
          if (!cachedInner && ['required', 'default', 'min', 'max', 'step', 'pattern', 'loose', 'volatile'].some(key => (
            Object.hasOwn(meta, key) && !Object.hasOwn(next.meta, key)
            && (['required', 'loose', 'volatile'].includes(key) ? !!Reflect.get(meta, key) : Reflect.get(meta, key) != null)
          ))) {
            metadataEffects.push(limitation(path, 'lazy metadata propagation may affect shared schemas; validation requires native execution'))
          }
          // Native lazy resolution merges outer metadata only when it first invokes the builder.
          meta = cachedInner ? next.meta : { ...meta, ...next.meta }
          validateVolatilePlacement({ ...next, meta }, `${path}/lazy`, true)
          inner = next
        }
        projection = looseProjection ?? visit({ ...inner, meta }, `${path}/lazy`, strict)
        if (node.meta.volatile) {
          projection = { ...projection, schema: { ...projection.schema, 'x-cordis': { ...projection.schema['x-cordis'], volatile: true } } }
        }
      } else {
        const ownLimitations: string[] = []
        const inputLimitations: string[] = []
        let unsupported = false
        const inputLimitation = (message: string): void => {
          inputLimitations.push(message)
          ownLimitations.push(limitation(path, message))
        }
        const annotation = (value: unknown, name: string): { ok: true; value: unknown } | { ok: false } => {
          try {
            return { ok: true, value: jsonValue(value) }
          } catch (error) {
            ownLimitations.push(limitation(`${path}/${name}`, `annotation omitted: ${error instanceof Error ? error.message : String(error)}`))
            return { ok: false }
          }
        }
        const children: NodeProjection[] = []
        const child = (value: NativeConfigSchema | undefined, suffix: string, childStrict = false): NodeProjection => {
          if (value === undefined) throw new Error(`${path}: ${node.type} schema is missing ${suffix}`)
          const result = visit(value, `${path}/${suffix}`, childStrict)
          children.push(result)
          return result
        }
        const meta = { ...node.meta }
        for (const key of ['min', 'max', 'step'] as const) {
          if (meta[key] === undefined || Number.isFinite(meta[key])) continue
          // Native range checks default to [-Infinity, Infinity]; a -Infinity origin still breaks step validation.
          const inert = key === 'max' ? meta.max === Infinity : key === 'min' && meta.min === -Infinity && !meta.step
          if (!inert) inputLimitation(`non-finite ${key} constraint is omitted; native validation is required`)
          Reflect.deleteProperty(meta, key)
        }
        let core: InputSchema | boolean
        let dictionaryValidation: { keySchema: InputSchema; valueSchema: InputSchema } | undefined
        switch (node.type) {
          case 'any': core = true; break
          case 'never': core = false; break
          case 'const': {
            try {
              core = node.value == null ? false : constant(jsonValue(node.value, true), () => {
                inputLimitation('object constant inherited-member comparison requires native validation')
              })
            } catch (error) {
              core = true
              inputLimitation(`constant constraint requires native validation: ${error instanceof Error ? error.message : String(error)}`)
            }
            break
          }
          case 'boolean': core = { type: 'boolean' }; break
          case 'string': {
            core = { type: 'string' }
            if (meta.min !== undefined) {
              if (meta.min <= 1) core.minLength = Math.max(0, Math.ceil(meta.min))
              else inputLimitation('UTF-16 minimum length requires native validation')
            }
            if (meta.max !== undefined) {
              if (meta.max < 0) core = false
              else {
                const maximum = Math.floor(meta.max)
                core.maxLength = maximum
                if (maximum > 0) inputLimitation('UTF-16 maximum length requires native validation')
              }
            }
            if (meta.pattern && core !== false) {
              if (portablePattern(meta.pattern.source, meta.pattern.flags)) core.pattern = meta.pattern.source
              else inputLimitation('regular-expression syntax or Unicode semantics require native validation')
            }
            break
          }
          case 'number': {
            core = { type: 'number' }
            if (meta.min !== undefined) core.minimum = meta.min
            if (meta.max !== undefined) core.maximum = meta.max
            if (meta.step) {
              const step = Math.abs(meta.step)
              const origin = meta.min ?? 0
              if (!Number.isInteger(step) || origin % step !== 0) {
                inputLimitation('fractional or offset numeric step requires native validation')
              } else if (step === 1) core.type = 'integer'
              else core.multipleOf = step
            }
            break
          }
          case 'object': {
            const required: string[] = []
            const properties = Object.fromEntries(Object.entries(node.dict ?? {}).map(([key, field]) => {
              const value = child(field, key)
              if (value.acceptsMissing === false) required.push(key)
              return [key, value.schema]
            }))
            core = { type: 'object', properties }
            if (required.length) core.required = required
            break
          }
          case 'array': {
            const item = child(node.inner, 'items')
            core = { type: 'array', items: item.schema }
            if (meta.min !== undefined && node.inner?.meta.default == null) core.minItems = Math.max(0, Math.ceil(meta.min))
            if (meta.max !== undefined) {
              if (meta.max < 0) core = false
              else core.maxItems = Math.floor(meta.max)
            }
            break
          }
          case 'dict': {
            const valueSchema = child(node.inner, 'values').schema
            core = { type: 'object', additionalProperties: valueSchema }
            if (node.sKey) {
              const key = child(node.sKey, 'keys')
              const totalString = node.sKey.type === 'string'
                && node.sKey.meta.min === undefined && node.sKey.meta.max === undefined && node.sKey.meta.pattern === undefined
              if (!totalString && (strict || key.effectful)) {
                dictionaryValidation = { keySchema: key.schema, valueSchema }
                core = { type: 'object' }
                inputLimitation(key.effectful
                  ? 'dictionary key normalization can overwrite unvalidated values; native validation is required'
                  : 'strict dictionary filtering and value validation require native validation')
              } else core.propertyNames = key.schema
            }
            break
          }
          case 'tuple': {
            if (node.list === undefined) throw new Error(`${path}: tuple schema is missing its list`)
            const values = node.list.map((item, index) => child(item, String(index)))
            core = { type: 'array', ...(values.length ? { prefixItems: values.map(item => item.schema) } : {}) }
            const minimum = values.reduce((length, value, index) => value.acceptsMissing === false ? index + 1 : length, 0)
            if (minimum) core.minItems = minimum
            break
          }
          case 'union': {
            if (node.list === undefined) throw new Error(`${path}: union schema is missing its list`)
            const variants = node.list.map((item, index) => child(item, String(index), strict))
            if (variants.slice(0, -1).some(variant => variant.mutating)) {
              core = true
              inputLimitation('earlier union branches may alter later validation inputs; native validation is required')
            } else core = variants.length ? { anyOf: variants.map(variant => variant.schema) } : false
            break
          }
          case 'transform':
            core = child(node.inner, 'input', true).schema
            inputLimitation('transform callback validation and normalization are not executed or projected')
            break
          default:
            core = true
            unsupported = true
            inputLimitation(`native schema type ${node.type} is not statically projected`)
        }
        if (meta.loose) {
          core = true
          inputLimitation('loose validation can replace invalid values with defaults')
        }
        const recursive = children.some(value => value.recursive)
        // Only containers write adapted values or renamed keys back; a bare primitive branch cannot alter the input.
        const container = ['object', 'array', 'dict', 'tuple'].includes(node.type)
        const mutating = unsupported || children.some(value => value.mutating || (container && value.effectful))
        const exact = inputLimitations.length === 0 && children.every(value => value.exact)
        const fallback = meta.default === undefined ? undefined : annotation(meta.default, 'default')
        let acceptsMissing: boolean | 'unknown'
        if (meta.required) acceptsMissing = false
        else if (unsupported) acceptsMissing = 'unknown'
        else if (meta.default == null) acceptsMissing = true
        else if (!fallback?.ok) acceptsMissing = 'unknown'
        else if (recursive) {
          acceptsMissing = 'unknown'
          inputLimitation('recursive default validation cannot be decided statically')
        } else if (!exact) acceptsMissing = 'unknown'
        else acceptsMissing = validator.validate(core, fallback.value)
        const annotations: InputSchema = {}
        if (fallback?.ok) annotations.default = fallback.value
        const native: Record<string, unknown> = {}
        if (typeof meta.description === 'string') annotations.description = meta.description
        else if (meta.description) {
          const descriptions = annotation(meta.description, 'description')
          if (descriptions.ok) {
            native.descriptions = descriptions.value
            const description = meta.description.en ?? meta.description[''] ?? Object.values(meta.description)[0]
            if (typeof description === 'string') annotations.description = description
          }
        }
        if (dictionaryValidation) native.dictionaryValidation = dictionaryValidation
        const copy = (name: string, value: unknown): void => {
          if (value === undefined) return
          const result = annotation(value, name)
          if (result.ok) native[name] = result.value
        }
        for (const key of ['role', 'extra', 'hidden', 'disabled', 'collapse', 'link', 'comment', 'badges', 'loose', 'volatile'] as const) {
          copy(key, meta[key])
        }
        if (meta.pattern?.flags) copy('patternFlags', meta.pattern.flags)
        if (node.type === 'union') native.branchSelection = 'first-success'
        if (acceptsMissing === 'unknown') native.omissionValidation = 'runtime'
        if (ownLimitations.length) {
          native.type = node.type
          for (const key of ['min', 'max', 'step', 'pattern'] as const) copy(key, meta[key])
          native.limitations = ownLimitations
        }
        if (Object.keys(native).length) annotations['x-cordis'] = native
        const input = nullable(core, acceptsMissing !== false)
        projection = {
          schema: { ...(typeof input === 'boolean' ? input ? {} : { not: {} } : input), ...annotations },
          acceptsMissing,
          exact: exact && acceptsMissing !== 'unknown',
          recursive,
          effectful: unsupported || node.type === 'transform' || !!meta.loose || children.some(child => child.effectful),
          mutating,
        }
      }
      active.delete(key)
      const name = recursiveNames.get(key)
      if (name !== undefined) {
        definitions[name] = projection.schema
        projection = { ...projection, schema: { $ref: `#/$defs/${name}` } }
      }
      completed.set(key, projection)
      return projection
    }

    const result = visit(root, 'config')
    const schema = expressions(result.schema)
    return {
      schema: metadataEffects.length ? { anyOf: [schema, {}] } : schema,
      definitions: Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, expressions(value, false)])),
      acceptsMissing: metadataEffects.length ? 'unknown' : result.acceptsMissing,
      limitations: [...new Set(limitations)],
    }
  }
}
