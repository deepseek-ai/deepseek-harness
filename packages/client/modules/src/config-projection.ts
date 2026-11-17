/**
 * Projection of one running plugin's Config onto the values the browser may receive: top-level volatile fields only,
 * with every `role('secret')` position removed, including positions inside volatile objects, dictionaries, and arrays.
 */
import { isDeepStrictEqual } from 'node:util'
import type { Volatile } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SyncedConfigValues } from '@deepseek-ai/dsh-client-config/types'

/** Schemastery node fields the projection reads; a Schemastery schema satisfies it structurally. */
export interface SchemaNode {
  type: string
  meta: { role?: unknown; volatile?: unknown }
  dict?: Record<string, SchemaNode>
  inner?: SchemaNode
  list?: SchemaNode[]
}

/** A volatile field of a parsed Config is a reference; detected structurally so this package needs no Cosmokit copy. */
function isReference(value: unknown): value is Volatile<unknown> {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'get') === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a child field Schemastery always sets for the node types that use it.
 * @param node - schema node.
 * @param key - `dict` for objects, `inner` for dictionaries, arrays, and transforms, `list` for unions and intersections.
 * @returns the field.
 */
function part<K extends 'dict' | 'inner' | 'list'>(node: SchemaNode, key: K): NonNullable<SchemaNode[K]> {
  const value = node[key]
  /* v8 ignore next -- Schemastery constructs every object, dict, array, transform, union, and intersect node with this field. */
  if (value === undefined) throw new TypeError(`client-modules: ${node.type} schema has no ${key}`)
  return value
}

/** Every union branch is applied, so a field any branch declares secret is removed. */
function stripSecrets(node: SchemaNode, value: unknown): unknown {
  if (value === undefined || node.meta.role === 'secret') return undefined
  switch (node.type) {
    case 'object': {
      if (!isRecord(value)) return value
      // As the settings redaction does, keys this branch does not declare stay, so union and intersection members do not
      // drop each other's fields.
      const dict = part(node, 'dict')
      const undeclared = Object.entries(value).filter(([key]) => !(key in dict))
      return { ...Object.fromEntries(undeclared), ...collect(Object.entries(dict).map(([key, child]) => [key, child, value[key]])) }
    }
    case 'dict': {
      const inner = part(node, 'inner')
      return isRecord(value) ? collect(Object.entries(value).map(([key, entry]) => [key, inner, entry])) : value
    }
    case 'array':
      // A secret array item is dropped from the list rather than replaced by a placeholder.
      return Array.isArray(value) ? value.map(entry => stripSecrets(part(node, 'inner'), entry)).filter(entry => entry !== undefined) : value
    case 'union':
    case 'intersect':
      return part(node, 'list').reduce<unknown>((current, child) => stripSecrets(child, current), value)
    case 'transform':
      return stripSecrets(part(node, 'inner'), value)
    default:
      return value
  }
}

/** Rebuild an object from stripped properties, omitting those that strip to undefined. */
function collect(properties: [string, SchemaNode, unknown][]): Record<string, unknown> {
  const rebuilt: Record<string, unknown> = {}
  for (const [key, child, entry] of properties) {
    const stripped = stripSecrets(child, entry)
    if (stripped !== undefined) rebuilt[key] = stripped
  }
  return rebuilt
}

/** Top-level object fields of a Config schema; intersections contribute the fields of each object member. */
function topFields(node: SchemaNode): [string, SchemaNode][] {
  if (node.type === 'object') return Object.entries(part(node, 'dict'))
  if (node.type === 'intersect') return part(node, 'list').flatMap(topFields)
  return []
}

/**
 * Whether a Config schema declares a top-level volatile field, the only fields synced to the browser.
 * @param schema - the plugin's Host Config schema.
 * @returns true when at least one top-level field is volatile.
 */
export function hasSyncedFields(schema: SchemaNode): boolean {
  return topFields(schema).some(([, node]) => node.meta.volatile === true)
}

/**
 * Project a running plugin's effective Config onto its browser-synced values.
 * @param schema - the plugin's Host Config schema.
 * @param effective - the fiber's effective Config, whose volatile fields are references.
 * @param id - package name, used in diagnostics.
 * @returns the synced values, or undefined when the schema declares no top-level volatile field.
 * @throws TypeError when a synced value is not lossless JSON.
 */
export function syncedValues(schema: SchemaNode, effective: unknown, id: string): SyncedConfigValues | undefined {
  const fields = topFields(schema).filter(([, node]) => node.meta.volatile === true)
  if (fields.length === 0) return undefined
  const source = isRecord(effective) ? effective : {}
  const values: Record<string, JsonValue> = {}
  for (const [key, node] of fields) {
    const raw = source[key]
    const stripped = stripSecrets(node, isReference(raw) ? raw.get() : raw)
    if (stripped === undefined) continue
    const json = JSON.parse(JSON.stringify(stripped)) as JsonValue
    if (!isDeepStrictEqual(json, stripped)) {
      throw new TypeError(`client-modules: ${id} Config field ${key} is not lossless JSON and cannot be synced to the browser`)
    }
    values[key] = json
  }
  return values
}
