/**
 * The registration boundary between a sandboxed host half and the real runtime: ParameterSchemaSpec
 * normalization + validation with teaching errors, the marker-guarded `harness.defineTool` /
 * `harness.registerTool` pair, the `harness.handle` invoke-handler normalizer, the SANDBOX CONTEXT
 * FAÇADE a running plugin's `apply` receives in place of the real `ctx`, and the plugin-shape
 * helpers the run lifecycle narrows sandbox return values with. The façade is a whitelist of
 * lifecycle-safe verbs and declared services; framework internals and context-valued service
 * returns are denied.
 *
 * VM-realm schemas and canonical values are rebuilt as host objects, while rendered content and
 * presentation metadata are shape-checked before entering the registry. Common JSON-Schema spellings are normalized when they
 * have one meaning; invalid vocabulary fails during registration with a teaching error.
 * @module @deepseek-ai/dsh-cordis-host-runner/guard
 */

import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { assertSupportedJsonSchema, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const DYNAMIC_TOOL = Symbol('cordis-host-runner.dynamic-tool')
const SCHEMA_TYPES = new Set<unknown>(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array', 'json'])
const VALID_TYPES = '\'string\' | \'number\' | \'integer\' | \'boolean\' | \'null\' | \'object\' | \'array\' | \'json\''
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

type DynamicToolDefinition = ToolDefinition & { [DYNAMIC_TOOL]: true }
type DynamicToolMarker = { [DYNAMIC_TOOL]?: unknown }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null
    || typeof prototype === 'object'
      && Object.getPrototypeOf(prototype) === null
      && hasIntrinsicConstructor(prototype, 'Object')
}

/* jscpd:ignore-start -- this VM boundary mirrors the session-owned realm-safe intrinsic test */
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** Whether an array uses one realm's intrinsic Array prototype rather than a subclass. */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && Object.getPrototypeOf(objectPrototype) === null
    && hasIntrinsicConstructor(objectPrototype, 'Object')
}
/* jscpd:ignore-end */

/** Whether a schema list is a dense intrinsic array with no JSON-invisible decorations. */
function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || !hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) {
    return false
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false
  }
  return true
}

/** Reject schema records whose declarations would disappear from object enumeration. */
function assertSchemaContainerKeys(value: Record<string, unknown>, path: string): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new Error(`harness.defineTool ${path} must contain only own enumerable string keys`)
  }
}

/** Where one cloned JSON value is installed. */
type CloneDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: unknown[]; index: number }
  | { kind: 'object'; target: Record<string, unknown>; key: string }

/** Deferred work for stack-safe cross-realm JSON cloning. */
type CloneTask =
  | { kind: 'visit'; value: unknown; path: string; destination: CloneDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; path: string; target: unknown[] }
  | { kind: 'leave'; source: object }

/** Materialize realm-foreign lossless JSON without allowing JSON.stringify coercions; `path` carries the caller's own error prefix. */
function cloneJson(value: unknown, path: string): unknown {
  const ancestors = new Set<object>()
  let root: unknown
  const assign = (destination: CloneDestination, item: unknown): void => {
    if (destination.kind === 'root') {
      root = item
      return
    }
    if (destination.kind === 'array') {
      destination.target[destination.index] = item
      return
    }
    Object.defineProperty(destination.target, destination.key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  const reject = (at: string): never => {
    // Naming the executable next step matters more than naming the rule: the
    // usual cause is a handler that returns whatever its last call produced,
    // and the fix is one keyword.
    throw new Error(`${at} must be lossless JSON data (objects, arrays, strings, numbers, booleans, null) — `
      + 'not a class instance, function, Map/Set, Date, or undefined. Return a plain object built from the '
      + 'values you need, or `return null` when the caller needs no value back.')
  }

  const tasks: CloneTask[] = [{ kind: 'visit', value, path, destination: { kind: 'root' } }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!Object.hasOwn(task.source, task.index)) reject(task.path)
      tasks.push({
        kind: 'visit',
        value: task.source[task.index],
        path: `${task.path}[${task.index}]`,
        destination: { kind: 'array', target: task.target, index: task.index },
      })
      continue
    }

    const current = task.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      assign(task.destination, current)
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) reject(task.path)
      assign(task.destination, current)
      continue
    }
    if (typeof current !== 'object' || ancestors.has(current)) reject(task.path)

    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current) || Reflect.ownKeys(current).length !== current.length + 1) reject(task.path)
      const output: unknown[] = []
      assign(task.destination, output)
      ancestors.add(current)
      tasks.push({ kind: 'leave', source: current })
      for (let index = current.length - 1; index >= 0; index--) {
        tasks.push({ kind: 'array-item', source: current, index, path: task.path, target: output })
      }
      continue
    }
    if (!isPlainRecord(current)) reject(task.path)
    const record = current as Record<string, unknown>
    if (Reflect.ownKeys(record).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(record, key))) {
      reject(task.path)
    }
    const output: Record<string, unknown> = {}
    assign(task.destination, output)
    ancestors.add(record)
    tasks.push({ kind: 'leave', source: record })
    const entries = Object.entries(record)
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      /* v8 ignore next -- the loop is bounded by the captured entry count. */
      if (entry === undefined) continue
      tasks.push({
        kind: 'visit',
        value: entry[1],
        path: `${task.path}.${entry[0]}`,
        destination: { kind: 'object', target: output, key: entry[0] },
      })
    }
  }
  return root
}

/** Copy and realm-materialize the shared annotation vocabulary. */
function copyAnnotations(value: Record<string, unknown>, output: Record<string, unknown>, path: string): void {
  if (Object.hasOwn(value, 'description')) output.description = value.description
  if (Object.hasOwn(value, 'title')) output.title = value.title
  if (Object.hasOwn(value, 'default')) output.default = cloneJson(value.default, `harness.defineTool ${path}.default`)
  if (Object.hasOwn(value, 'examples')) output.examples = cloneJson(value.examples, `harness.defineTool ${path}.examples`)
}

/** Reject sandbox schema keys that the unified DSL would otherwise ignore. */
function assertSchemaKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  assertSchemaContainerKeys(value, path)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`harness.defineTool ${path}.${key} is not supported by the unified schema DSL`)
  }
}

/**
 * Normalize a sandbox-provided `parameters` value into a fresh host-realm
 * ParameterSchemaSpec. A raw JSON-Schema object wrapper retains its open root
 * default, while the direct DSL is already an implicit open property map.
 */
function normalizeParameterSchemaSpec(value: unknown, path = 'parameters'): {
  spec: Record<string, unknown>
  rootAnnotations?: Record<string, unknown>
} {
  if (!isPlainRecord(value)) {
    throw new Error(`harness.defineTool ${path} must be a ParameterSchemaSpec object`)
  }
  if (value.type === 'object') {
    assertSchemaKeys(value, path, ['type', 'properties', 'required', 'additionalProperties', ...ANNOTATION_KEYS])
    if (!isPlainRecord(value.properties)) {
      throw new Error(`harness.defineTool ${path}.properties must be an object of schemas`)
    }
    if (Object.hasOwn(value, 'additionalProperties') && value.additionalProperties !== true) {
      throw new Error(`harness.defineTool ${path}.additionalProperties must be true or omitted because the implicit parameter root is open`)
    }
    if (Object.hasOwn(value, 'required') && value.required === undefined) {
      throw new Error(`harness.defineTool ${path}.required must be an array of declared property names`)
    }
    const required = normalizeRequiredNames(value.required, value.properties, `${path}.required`)
    const rootAnnotations: Record<string, unknown> = {}
    copyAnnotations(value, rootAnnotations, path)
    return {
      spec: normalizePropertyMap(value.properties, path, required, true),
      ...(Object.keys(rootAnnotations).length === 0 ? {} : { rootAnnotations }),
    }
  }
  return { spec: normalizePropertyMap(value, path, new Set(), false) }
}

/** Validate raw required names and return their lookup set. */
function normalizeRequiredNames(value: unknown, properties: Record<string, unknown>, path: string): Set<string> {
  if (value === undefined) return new Set()
  if (!isDensePlainArray(value)) {
    throw new Error(`harness.defineTool ${path} must be an array of declared property names`)
  }
  const names = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const name = value[index]
    if (typeof name !== 'string') {
      throw new Error(`harness.defineTool ${path} must be an array of declared property names`)
    }
    names.add(name)
    if (!Object.hasOwn(properties, name)) throw new Error(`harness.defineTool ${path} names undeclared property ${JSON.stringify(name)}`)
  }
  return names
}

/** Mutable holder used only while one normalized property-map root is unresolved. */
interface NormalizeRoot {
  value?: Record<string, unknown>
}

/** Where a normalized value node is installed. */
type NormalizeValueDestination =
  | { kind: 'property'; target: Record<string, unknown>; key: string }
  | { kind: 'item'; target: Record<string, unknown> }
  | { kind: 'one-of'; target: Record<string, unknown>[]; index: number }

/** Where a normalized property map is installed. */
type NormalizeMapDestination =
  | { kind: 'root'; holder: NormalizeRoot }
  | { kind: 'properties'; target: Record<string, unknown> }

/** Deferred work for stack-safe sandbox schema normalization. */
type NormalizeTask =
  | {
    kind: 'map'
    entries: Record<string, unknown>
    path: string
    requiredNames: ReadonlySet<string>
    raw: boolean
    destination: NormalizeMapDestination
  }
  | {
    kind: 'value'
    value: unknown
    path: string
    forceRequired: boolean
    raw: boolean
    parameterProperty: boolean
    destination: NormalizeValueDestination
  }
  | { kind: 'leave'; value: object }

/** Install one normalized node without `__proto__` assignment semantics. */
function assignNormalizedValue(destination: NormalizeValueDestination, value: Record<string, unknown>): void {
  if (destination.kind === 'property') {
    Object.defineProperty(destination.target, destination.key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } else if (destination.kind === 'item') {
    destination.target.items = value
  } else {
    destination.target[destination.index] = value
  }
}

/** Install one normalized property map at its root or containing object. */
function assignNormalizedMap(destination: NormalizeMapDestination, value: Record<string, unknown>): void {
  if (destination.kind === 'root') destination.holder.value = value
  else destination.target.properties = value
}

/** Normalize one implicit property map and all descendants with explicit work frames. */
function normalizePropertyMap(
  entries: Record<string, unknown>,
  path: string,
  requiredNames: ReadonlySet<string>,
  raw: boolean,
): Record<string, unknown> {
  const holder: NormalizeRoot = {}
  const ancestors = new Set<object>()
  const tasks: NormalizeTask[] = [{
    kind: 'map',
    entries,
    path,
    requiredNames,
    raw,
    destination: { kind: 'root', holder },
  }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.value)
      continue
    }
    if (task.kind === 'map') {
      if (ancestors.has(task.entries)) throw new Error(`harness.defineTool ${task.path} is circular`)
      assertSchemaContainerKeys(task.entries, task.path)
      ancestors.add(task.entries)
      const spec: Record<string, unknown> = {}
      assignNormalizedMap(task.destination, spec)
      tasks.push({ kind: 'leave', value: task.entries })
      const mapEntries = Object.entries(task.entries)
      for (let index = mapEntries.length - 1; index >= 0; index--) {
        const entry = mapEntries[index]
        /* v8 ignore next -- the loop is bounded by the captured entry count. */
        if (entry === undefined) continue
        tasks.push({
          kind: 'value',
          value: entry[1],
          path: `${task.path}.${entry[0]}`,
          forceRequired: task.requiredNames.has(entry[0]),
          raw: task.raw,
          parameterProperty: true,
          destination: { kind: 'property', target: spec, key: entry[0] },
        })
      }
      continue
    }

    const { value, path } = task
    if (!isPlainRecord(value)) {
      throw new Error(`harness.defineTool ${path} must be a ParameterSchemaSpec property object`)
    }
    assertSchemaContainerKeys(value, path)
    if (ancestors.has(value)) throw new Error(`harness.defineTool ${path} is circular`)
    ancestors.add(value)
    const requiredKey = task.parameterProperty && !task.raw ? ['required'] : []
    if (task.parameterProperty && task.raw && Object.hasOwn(value, 'required') && value.type !== 'object') {
      throw new Error(`harness.defineTool ${path}.required belongs to the containing raw object schema`)
    }
    if (task.parameterProperty && !task.raw && Object.hasOwn(value, 'required') && value.required !== true) {
      throw new Error(`harness.defineTool ${path}.required must be true when present`)
    }
    const prop: Record<string, unknown> = {}
    assignNormalizedValue(task.destination, prop)
    tasks.push({ kind: 'leave', value })
    if (task.forceRequired || value.required === true) prop.required = true
    copyAnnotations(value, prop, path)

    if (Object.hasOwn(value, 'oneOf')) {
      assertSchemaKeys(value, path, ['oneOf', ...requiredKey, ...ANNOTATION_KEYS])
      if (!isDensePlainArray(value.oneOf) || value.oneOf.length < 2) {
        throw new Error(`harness.defineTool ${path}.oneOf must contain at least two schemas`)
      }
      const oneOf: Record<string, unknown>[] = []
      prop.oneOf = oneOf
      for (let index = value.oneOf.length - 1; index >= 0; index--) {
        tasks.push({
          kind: 'value',
          value: value.oneOf[index],
          path: `${path}.oneOf[${index}]`,
          forceRequired: false,
          raw: task.raw,
          parameterProperty: false,
          destination: { kind: 'one-of', target: oneOf, index },
        })
      }
      continue
    }

    if (task.raw && !Object.hasOwn(value, 'type')) {
      assertSchemaKeys(value, path, ANNOTATION_KEYS)
      prop.type = 'json'
      continue
    }
    if (!SCHEMA_TYPES.has(value.type) || task.raw && value.type === 'json') {
      throw new Error(`harness.defineTool ${path} must declare a valid type: ${VALID_TYPES} (got ${JSON.stringify(value.type)})`)
    }
    const type = value.type
    prop.type = type

    switch (type) {
      case 'object': {
        assertSchemaKeys(value, path, ['type', 'properties', 'additionalProperties', ...requiredKey, ...(task.raw ? ['required'] : []), ...ANNOTATION_KEYS])
        if (!task.raw && (!Object.hasOwn(value, 'additionalProperties') || typeof value.additionalProperties !== 'boolean')) {
          throw new Error(`harness.defineTool ${path}.additionalProperties must be explicitly true or false`)
        }
        if (task.raw && Object.hasOwn(value, 'additionalProperties') && typeof value.additionalProperties !== 'boolean') {
          throw new Error(`harness.defineTool ${path}.additionalProperties must be a boolean`)
        }
        if (task.raw && Object.hasOwn(value, 'required') && value.required === undefined) {
          throw new Error(`harness.defineTool ${path}.required must be an array of declared property names`)
        }
        prop.additionalProperties = task.raw ? value.additionalProperties ?? true : value.additionalProperties
        if (Object.hasOwn(value, 'properties')) {
          const properties = value.properties
          if (!isPlainRecord(properties)) throw new Error(`harness.defineTool ${path}.properties must be an object of schemas`)
          const nestedRequired = task.raw
            ? normalizeRequiredNames(value.required, properties, `${path}.required`)
            : new Set<string>()
          tasks.push({
            kind: 'map',
            entries: properties,
            path: `${path}.properties`,
            requiredNames: nestedRequired,
            raw: task.raw,
            destination: { kind: 'properties', target: prop },
          })
        } else if (task.raw && value.required !== undefined) {
          normalizeRequiredNames(value.required, {}, `${path}.required`)
        }
        break
      }
      case 'array':
        assertSchemaKeys(value, path, ['type', 'items', ...requiredKey, ...ANNOTATION_KEYS])
        if (Object.hasOwn(value, 'items')) {
          tasks.push({
            kind: 'value',
            value: value.items,
            path: `${path}.items`,
            forceRequired: false,
            raw: task.raw,
            parameterProperty: false,
            destination: { kind: 'item', target: prop },
          })
        }
        break
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertSchemaKeys(value, path, ['type', 'enum', 'const', ...requiredKey, ...ANNOTATION_KEYS])
        if (Object.hasOwn(value, 'enum')) {
          if (!isDensePlainArray(value.enum) || value.enum.length === 0) {
            throw new Error(`harness.defineTool ${path}.enum must be a non-empty array`)
          }
          prop.enum = cloneJson(value.enum, `harness.defineTool ${path}.enum`)
        }
        if (Object.hasOwn(value, 'const')) prop.const = cloneJson(value.const, `harness.defineTool ${path}.const`)
        break
      case 'json':
        assertSchemaKeys(value, path, ['type', ...requiredKey, ...ANNOTATION_KEYS])
        break
      /* v8 ignore next 2 -- SCHEMA_TYPES narrows this closed switch before dispatch. */
      default:
        throw new Error(`harness.defineTool ${path} must declare a valid type: ${VALID_TYPES}`)
    }
  }
  /* v8 ignore next -- the root map task assigns before scheduling descendants. */
  return holder.value ?? {}
}

function markDynamicTool(tool: ToolDefinition): DynamicToolDefinition {
  Object.defineProperty(tool, DYNAMIC_TOOL, { value: true })
  return tool as DynamicToolDefinition
}

function assertDynamicTool(tool: unknown): asserts tool is DynamicToolDefinition {
  if (!isPlainRecord(tool) || (tool as DynamicToolMarker)[DYNAMIC_TOOL] !== true) {
    throw new Error('dynamic tool registration must use a tool returned by harness.defineTool(...)')
  }
}

/**
 * Structurally a content block, checked AFTER the JSON round-trip: a plain
 * object carrying a string `type` tag. Deliberately nothing deeper — the
 * ContentBlock union is merge-extensible (an unknown tag must pass), and every
 * downstream consumer dispatches on `type` and falls through unknowns.
 */
function isContentBlockShape(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.type === 'string'
}

/**
 * How much of an invalid execute return the teaching error echoes back — a
 * huge blob would burn the model turn the error is trying to save.
 */
const RETURN_PREVIEW_LIMIT = 120

/**
 * Compact JSON preview of an invalid execute return for the teaching error
 * (`String(…)` for the un-stringifiable undefined case), truncated to
 * {@link RETURN_PREVIEW_LIMIT}.
 */
function describeReturn(value: JsonValue): string {
  // The caller has already crossed cloneJson, so this value is lossless JSON
  // and serialization cannot produce undefined.
  const json = JSON.stringify(value)
  return json.length > RETURN_PREVIEW_LIMIT ? `${json.slice(0, RETURN_PREVIEW_LIMIT)}…` : json
}

/**
 * Validate and host-materialize a sandbox renderer's content blocks.
 */
function assertRenderedContent(value: JsonValue): ContentBlock[] {
  if (Array.isArray(value) && value.every(isContentBlockShape)) {
    return value as unknown as ContentBlock[]
  }
  throw new Error(
    `output.render returned ${describeReturn(value)} — it must return an ARRAY of content blocks:\n`
    + '  ✓ return [{ type: \'text\', text: String(value) }]',
  )
}

/**
 * The `harness.defineTool` handed into the sandbox: the real DSL, with `parameters` normalized
 * into a fresh host-realm ParameterSchemaSpec (raw object wrappers unwrapped,
 * required arrays mapped, and explicit DSL object openness enforced) and the tool's `execute` return normalized into the host realm
 * via a JSON round-trip. Non-JSON or wrong-shape output fails that call instead of poisoning
 * the session log.
 * @param options - the standard `defineTool` options; `parameters` may be the ParameterSchemaSpec DSL or a JSON-Schema-style wrapper.
 * @returns the marker-tagged definition `harness.registerTool` (and the guarded `ctx.tools.register`) accepts.
 */
export function sandboxDefineTool(options: unknown): ToolDefinition {
  if (!isPlainRecord(options)) throw new Error('harness.defineTool options must be an object')
  const normalized = normalizeParameterSchemaSpec(options.parameters)
  if (!isPlainRecord(options.output)) {
    throw new Error('harness.defineTool output must declare { schema, render, presentationMeta? }')
  }
  const output = options.output
  if (typeof output.render !== 'function') throw new Error('harness.defineTool output.render must be a function')
  if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
    throw new Error('harness.defineTool output.presentationMeta must be a function when present')
  }
  if (typeof options.execute !== 'function') throw new Error('harness.defineTool execute must be a function')
  const schema = cloneJson(output.schema, 'harness.defineTool output.schema')
  const rawExecute = options.execute as (args: unknown, exec: unknown) => Promise<unknown>
  const rawRender = output.render as (args: unknown, value: unknown) => unknown
  const rawPresentationMeta = output.presentationMeta as ((args: unknown, value: unknown) => unknown) | undefined
  const erasedDefineTool = defineTool as (definition: unknown) => ToolDefinition
  const tool = erasedDefineTool({
    ...options,
    parameters: normalized.spec,
    output: {
      schema,
      render(args: unknown, value: unknown): ContentBlock[] {
        return assertRenderedContent(cloneJson(rawRender(args, value), 'harness.defineTool output.render result') as JsonValue)
      },
      ...rawPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: unknown): JsonValue {
          return cloneJson(rawPresentationMeta(args, value), 'harness.defineTool output.presentationMeta result') as JsonValue
        },
      } : {},
    },
    async execute(args: unknown, exec: unknown): Promise<JsonValue> {
      return cloneJson(await rawExecute(args, exec), 'harness.defineTool execute result') as JsonValue
    },
  })
  const parameters = { ...tool.parameters, ...normalized.rootAnnotations }
  assertSupportedJsonSchema(parameters)
  return markDynamicTool({
    ...tool,
    parameters,
  })
}

/**
 * Normalize one `harness.handle` registration at the sandbox boundary: the
 * method name must be a non-empty string and the handler a function whose
 * result is host-materialized through the same cross-realm JSON clone as tool
 * `execute` returns (a VM-realm object would otherwise escape the wire's
 * plain-object contract).
 * @param method - handler name the package's browser half calls through `host.call`.
 * @param fn - sandbox handler receiving the wire-decoded JSON arguments.
 * @returns the validated name and the clone-wrapped handler.
 */
export function normalizeHandler(method: unknown, fn: unknown): { method: string; handler: (args: unknown) => Promise<unknown> } {
  if (typeof method !== 'string' || method.length === 0) {
    throw new Error('harness.handle(method, fn) needs a non-empty string method name')
  }
  if (typeof fn !== 'function') {
    throw new Error(`harness.handle("${method}") needs a handler function as its second argument`)
  }
  const rawHandler = fn as (args: unknown) => unknown
  return {
    method,
    handler: async (args: unknown): Promise<unknown> =>
      cloneJson(await rawHandler(args), `harness.handle("${method}") result`),
  }
}

/**
 * The `harness.registerTool` handed into the sandbox: registers a
 * marker-verified dynamic tool on the given context's registry.
 * @param ctx - the (guarded) context whose `tools` service receives the tool.
 * @param tool - a definition produced by {@link sandboxDefineTool}; anything else is rejected.
 * @returns the registry disposer for the registration.
 */
export function sandboxRegisterTool(ctx: Context, tool: unknown): () => void {
  assertDynamicTool(tool)
  return ctx.tools.register(tool)
}

/**
 * The verbs a running host half may reach through the sandbox `ctx` façade, beyond its injected
 * services. `on`/`once` observe events, `provide` exposes a service to other packages, and the
 * timer helpers schedule work — each a fiber effect that unwinds when the package stops.
 */
const CTX_VERBS = new Set(['effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])
const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/**
 * The tool-registry façade: `register` (marker-guarded) plus READ-ONLY
 * metadata (`schemas`, and `get` returning a schema view, never the live
 * `ToolDefinition`). Exposing the raw definition would hand package code the
 * tool's `execute` function, letting it call another tool directly and bypass
 * `ToolRuntime.execute` — identity protection, pre-policy, monotonic guards,
 * around dispatch, post-policy, final observation, and result normalization. So `get` returns the same
 * name/description/parameters view as `schemas()`, and nothing invocable.
 */
function sandboxTools(ctx: Context): Record<string, unknown> {
  // Resolve reads and writes through the package's own scope.
  return {
    register: (tool: unknown): (() => void) => sandboxRegisterTool(ctx, tool),
    schemas: () => ctx.tools.schemas(scopeOf(ctx)),
    get: (name: string) => ctx.tools.schemas(scopeOf(ctx)).find(schema => schema.name === name),
  }
}

/**
 * Reject any injected-service return that is a cordis `Context`. Harness
 * services return data, never a context; a value that is one would be a
 * fresh, unguarded handle back into the runtime — the exact escape the façade
 * exists to close — so it fails loud instead of reaching sandbox code.
 */
// Twinned with the browser half's guard for the same reason as the ctx façade
// below: this is the rule "a service must never hand sandboxed code a Context",
// and each half must test against the Context class of ITS OWN face. Moving the
// rule into a shared package would move a security invariant out of the halves
// that enforce it, which is a design decision rather than a duplication fix.
/* jscpd:ignore-start */
function denyContext(value: unknown, service: string, reportFailure: (error: Error) => void): unknown {
  if (value instanceof Context) {
    return rejectGuard(reportFailure,
      `service "${service}" returned a cordis Context, which the sandbox does not expose. `
      + 'Operate through your own plugin ctx (ctx.on / ctx.provide / ctx.tools.register) '
      + 'and the services you inject — never another context.',
    )
  }
  return value
}

/**
 * Wrap an injected service so its methods forward to the real instance but
 * their return values pass through {@link denyContext}. Non-function members
 * (plain data) pass through as-is; a returned Promise is guarded on resolve.
 */
function guardedService(service: object, name: string, reportFailure: (error: Error) => void): unknown {
  return new Proxy(service, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return denyContext(value, name, reportFailure)
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args)
        if (result instanceof Promise) return result.then(v => denyContext(v, name, reportFailure))
        return denyContext(result, name, reportFailure)
      }
    },
  })
}
/* jscpd:ignore-end */

/**
 * The service names a plugin declared in `inject`, as a lookup set. Whatever
 * declaration style the plugin used — an `inject: ['bash', 'tools']` array or
 * the `{ required, optional }` object form — cordis resolves it into a single
 * name-keyed map on the fiber before `apply` runs (`{ bash: null, tools: null }`),
 * so the gate just reads that map's keys. A host half may reach only the services
 * it declared — that is what lets cordis park it when a declared provider
 * goes away.
 */
function declaredInjects(ctx: Context): Set<string> {
  return new Set(Object.keys(ctx.fiber.inject))
}

/**
 * Whitelist context for running host halves: lifecycle-safe verbs, guarded
 * tools, optional `ctx.get()` lookup, and declared-service property access.
 * Framework plumbing is denied, and service methods cannot return a Context.
 */
function sandboxContext(ctx: Context, reportFailure: (error: Error) => void): Context {
  const tools = sandboxTools(ctx)
  const declared = declaredInjects(ctx)
  // A framework member or an undeclared service — distinguish the two so the
  // error teaches the right fix (declare it in inject vs it is withheld).
  const denyRead = (prop: string): never => {
    if (ctx.get(prop) !== undefined) {
      return rejectGuard(reportFailure,
        `service "${prop}" is not injected. Declare it: inject: ['${prop}', …] on your plugin, `
        + 'so cordis parks this dynamic package if the provider later goes away.',
      )
    }
    return rejectGuard(reportFailure,
      `sandbox ctx does not expose "${prop}". Available: ctx.tools.register / ctx.on / ctx.provide / `
      + 'the timer helpers after injecting timer, and any service you declared in inject. '
      + 'Framework internals (root, fiber, registry, extend, plugin, …) are withheld by design.',
    )
  }
  // `get` is optional lookup; property access requires a declaration. `tools`
  // is the façade's own API on either path.
  const readService = (name: string, requireDeclaration: boolean): unknown => {
    if (name === 'tools') return tools
    if (requireDeclaration && !declared.has(name)) return denyRead(name)
    const service = denyContext(ctx.get(name), name, reportFailure)
    if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service
    return guardedService(service, name, reportFailure)
  }
  const get = (name: string): unknown => readService(name, false)
  // The browser half builds the same façade over its own Context
  // (`@deepseek-ai/dsh-cordis-client-runner`, whose CTX_VERBS names this one its
  // twin), and the sameness is the point: a package author meets ONE contract on
  // both halves. Folding them together is not available — the two halves compile
  // in separate programs where `Context` merges different service keys — so the
  // duplication is declared here instead of hidden behind a config exception.
  /* jscpd:ignore-start */
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'tools') return tools
      if (prop === 'get') return get
      if (typeof prop !== 'string') return undefined
      // Lazy verb forwarder — reads `ctx[verb]` only when called. Timer mixins
      // additionally require the Service declaration before Cordis resolves them.
      if (CTX_VERBS.has(prop)) {
        return (...args: unknown[]): unknown => {
          if (TIMER_VERBS.has(prop) && !declared.has('timer')) return denyRead('timer')
          const method = ctx[prop as keyof Context]
          return Reflect.apply(method as (...a: unknown[]) => unknown, ctx, args)
        }
      }
      return readService(prop, true)
    },
    // A façade is not the real ctx; block writes rather than let package code
    // stash state on a throwaway object and think it persisted.
    set(_target, prop) {
      return rejectGuard(reportFailure, `sandbox ctx is read-only; cannot assign "${String(prop)}"`)
    },
    // `in` reflects reachability: the façade API plus DECLARED services
    // (whether or not currently live). Does not resolve/wrap — no throw.
    has: (_target, prop) => prop === 'tools' || prop === 'get'
      || (typeof prop === 'string'
        && ((CTX_VERBS.has(prop) && (!TIMER_VERBS.has(prop) || declared.has('timer'))) || declared.has(prop))),
  }) as Context
  /* jscpd:ignore-end */
}

/**
 * Narrow an arbitrary sandbox return value to a runnable cordis plugin: a
 * function, or an object with an `apply` function. (A bare function passes the
 * first arm, so the object arm never sees `Function.prototype.apply`.)
 * @param value - whatever the host half returned.
 * @returns whether the value can be started via `ctx.plugin`.
 */
export function isPlugin(value: unknown): value is Plugin {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null
    && typeof (value as { apply?: unknown }).apply === 'function'
}

/**
 * Wrap a plugin so `apply` receives the sandbox context while preserving injection metadata.
 * @param plugin - the plugin the host half returned.
 * @param reportFailure - reports a guard rejection to the owning Agent.
 * @returns an equivalent plugin whose `apply` sees the sandbox context façade.
 */
export function guardedPlugin(plugin: Plugin, reportFailure: (error: Error) => void): Plugin {
  if (typeof plugin === 'function') {
    const functionPlugin = plugin as (ctx: Context, config?: unknown) => unknown
    return {
      name: pluginName(plugin),
      apply(ctx: Context, config?: unknown) {
        return functionPlugin(sandboxContext(ctx, reportFailure), config)
      },
    }
  }
  const objectPlugin = plugin as { apply(ctx: Context, config?: unknown): unknown }
  return {
    ...plugin,
    apply(ctx: Context, config?: unknown) {
      return objectPlugin.apply(sandboxContext(ctx, reportFailure), config)
    },
  }
}

function rejectGuard(reportFailure: (error: Error) => void, message: string): never {
  const error = new Error(message)
  reportFailure(error)
  throw error
}

/**
 * Display name for a running plugin: its `name` property, else anonymous.
 * @param plugin - the plugin the host half returned.
 * @returns the human-readable name used in run results and inspect output.
 */
export function pluginName(plugin: Plugin): string {
  const named = (plugin as { name?: unknown }).name
  if (typeof named === 'string' && named.length > 0) return named
  return '<anonymous>'
}
