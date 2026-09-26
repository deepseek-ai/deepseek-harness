/**
 * Source-independent JSON type graphs and canonical persistence fingerprints.
 * Numeric references are local to one graph; names and source locations are metadata.
 */

import { createHash } from 'node:crypto'

/** Recorded reader promise for explicitly attributed source additions. */
export interface SourceCompatibility {
  readonly version: 1
  readonly policy: 'session-source-attribution'
  readonly binding: 'session.user-message.source' | 'session.developer-message.source'
  readonly discriminator: 'kind'
  readonly unknownKinds: 'preserve'
  readonly attributionKinds: readonly string[]
}

/** One JSON property, with absence represented independently of its value type. */
export interface SchemaProperty {
  readonly name: string
  readonly type: number
  readonly optional: boolean
  readonly compatibility?: SourceCompatibility
}

/** One positional tuple element. */
export interface SchemaTupleElement {
  readonly type: number
  readonly optional: boolean
  readonly rest: boolean
}

/** A resolved persisted type; references address nodes in the enclosing graph. */
export type SchemaNode =
  | { readonly kind: 'primitive'; readonly type: 'null' | 'boolean' | 'number' | 'string' | 'never' }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'opaque'; readonly reason: 'any' | 'unknown' }
  | { readonly kind: 'array'; readonly element: number }
  | { readonly kind: 'tuple'; readonly elements: readonly SchemaTupleElement[] }
  | { readonly kind: 'object'; readonly properties: readonly SchemaProperty[]; readonly indices: readonly { readonly key: number; readonly value: number }[] }
  | { readonly kind: 'union'; readonly types: readonly number[] }

/** A self-contained minimized graph with deterministic root-first node numbering. */
export interface CanonicalSchema {
  readonly root: 0
  readonly nodes: readonly SchemaNode[]
}

/** One independently tracked persistent record vocabulary. */
export interface PersistenceRoot {
  readonly key: string
  readonly kind: 'header' | 'envelope' | 'event'
  readonly event?: string
  readonly surface?: boolean
  readonly digest: string
  readonly schema: CanonicalSchema
}

/** One reachable structural type and its non-fingerprinted source declaration metadata. */
export interface PersistenceType {
  readonly digest: string
  readonly schema: CanonicalSchema
  readonly names: readonly string[]
  readonly sources: readonly string[]
}

/** Complete current-source persistence inventory; version pins normalization too. */
export interface PersistenceSchemaInventory {
  readonly formatVersion: 1 | 2
  readonly roots: readonly PersistenceRoot[]
  readonly types: readonly PersistenceType[]
}

/**
 * Visit direct graph edges in their normalized semantic order.
 * @param node - resolved graph node.
 * @returns referenced node indices, including repeated ordered edges.
 */
export function schemaChildren(node: SchemaNode): number[] {
  switch (node.kind) {
    case 'array': return [node.element]
    case 'tuple': return node.elements.map(element => element.type)
    case 'object': return [...node.properties.map(property => property.type), ...node.indices.flatMap(index => [index.key, index.value])]
    case 'union': return [...node.types]
    case 'primitive':
    case 'literal':
    case 'opaque': return []
    default: return assertNever(node)
  }
}

function mapNode(node: SchemaNode, ref: (id: number) => number): SchemaNode {
  switch (node.kind) {
    case 'array': return { kind: 'array', element: ref(node.element) }
    case 'tuple': return { kind: 'tuple', elements: node.elements.map(element => ({ type: ref(element.type), optional: element.optional, rest: element.rest })) }
    case 'object': return {
      kind: 'object',
      properties: [...node.properties].sort((left, right) => compare(left.name, right.name))
        .map(property => ({ name: property.name, type: ref(property.type), optional: property.optional,
          ...(property.compatibility === undefined ? {} : { compatibility: {
            version: property.compatibility.version, policy: property.compatibility.policy, binding: property.compatibility.binding,
            discriminator: property.compatibility.discriminator, unknownKinds: property.compatibility.unknownKinds,
            attributionKinds: [...new Set(property.compatibility.attributionKinds)].sort(compare),
          } }),
        })),
      indices: node.indices.map(index => ({ key: ref(index.key), value: ref(index.value) }))
        .sort((left, right) => left.key - right.key || left.value - right.value),
    }
    case 'union': return { kind: 'union', types: [...new Set(node.types.map(ref))].sort((left, right) => left - right) }
    case 'primitive': return { kind: 'primitive', type: node.type }
    case 'literal': return { kind: 'literal', value: node.value }
    case 'opaque': return { kind: 'opaque', reason: node.reason }
    default: return assertNever(node)
  }
}

function partition(nodes: readonly SchemaNode[]): number[] {
  let colors = nodes.map(() => 0)
  for (;;) {
    const signatures = nodes.map((node, index) => JSON.stringify([colors[index], mapNode(node, id => colors[id] as number)]))
    const ordered = [...new Set(signatures)].sort(compare)
    const ids = new Map(ordered.map((value, index) => [value, index]))
    const next = signatures.map(value => ids.get(value) as number)
    const unchanged = new Set(next).size === new Set(colors).size
    colors = next
    if (unchanged) return colors
  }
}

/**
 * Minimize bisimilar recursive nodes and number the reachable graph deterministically.
 * @param input - resolved nodes; property and union order may be arbitrary.
 * @param root - index of the requested root.
 * @returns canonical graph excluding unreachable nodes and duplicate structures.
 */
export function canonicalizeSchema(input: readonly SchemaNode[], root: number): CanonicalSchema {
  input = normalizeUnions(input)
  const selected: number[] = []
  const positions = new Map<number, number>()
  const select = (id: number): void => {
    if (!Number.isInteger(id) || id < 0 || id >= input.length) throw new Error(`persistence schema: missing node ${String(id)}`)
    if (positions.has(id)) return
    positions.set(id, selected.length)
    selected.push(id)
    for (const child of schemaChildren(input[id] as SchemaNode)) select(child)
  }
  select(root)
  let nodes = selected.map(id => mapNode(input[id] as SchemaNode, child => positions.get(child) as number))
  let rootIndex = 0
  for (;;) {
    const colors = partition(nodes)
    const representatives = new Map<number, number>()
    colors.forEach((color, index) => { if (!representatives.has(color)) representatives.set(color, index) })
    const aliases = new Map<number, number>()
    nodes.forEach((node, index) => {
      if (node.kind !== 'union') return
      const members = [...new Set(node.types.map(child => colors[child] as number))]
      if (members.length === 1) aliases.set(index, representatives.get(members[0] as number) as number)
    })
    if (aliases.size > 0) {
      const resolve = (id: number): number => {
        const seen = new Set<number>()
        while (aliases.has(id)) {
          if (seen.has(id)) throw new Error('persistence schema: union cycle has no material type')
          seen.add(id)
          id = aliases.get(id) as number
        }
        return id
      }
      rootIndex = resolve(rootIndex)
      nodes = nodes.map((node, index) => aliases.has(index) ? nodes[resolve(index)] as SchemaNode : mapNode(node, resolve))
      continue
    }
    const emitted = new Map<number, number>()
    const result: SchemaNode[] = []
    const visit = (id: number): number => {
      const color = colors[id] as number
      const existing = emitted.get(color)
      if (existing !== undefined) return existing
      const position = result.length
      emitted.set(color, position)
      result.push({ kind: 'primitive', type: 'never' })
      const representative = representatives.get(color) as number
      const colored = mapNode(nodes[representative] as SchemaNode, child => colors[child] as number)
      result[position] = mapNode(colored, child => visit(representatives.get(child) as number))
      return position
    }
    visit(rootIndex)
    return { root: 0, nodes: result }
  }
}

function normalizeUnions(input: readonly SchemaNode[]): SchemaNode[] {
  const result = [...input]
  const flattened = (id: number, visiting: Set<number>): number[] => {
    const node = input[id]
    if (node === undefined) throw new Error(`persistence schema: missing node ${String(id)}`)
    if (node.kind !== 'union') return [id]
    if (visiting.has(id)) throw new Error('persistence schema: union cycle has no material type')
    const next = new Set(visiting).add(id)
    return node.types.flatMap(child => flattened(child, next))
  }
  for (const [id, node] of input.entries()) {
    if (node.kind !== 'union') continue
    let members = [...new Set(flattened(id, new Set()))]
    const primitives = new Set(members.flatMap((child) => {
      const value = input[child] as SchemaNode
      return value.kind === 'primitive' ? [value.type] : []
    }))
    const literals = members.flatMap((child) => {
      const value = input[child] as SchemaNode
      return value.kind === 'literal' ? [value.value] : []
    })
    if (!primitives.has('boolean') && literals.includes(true) && literals.includes(false)) {
      primitives.add('boolean')
      members.push(result.length)
      result.push({ kind: 'primitive', type: 'boolean' })
    }
    members = members.filter((child) => {
      const value = result[child] as SchemaNode
      if (value.kind === 'primitive') return value.type !== 'never'
      return value.kind !== 'literal' || !primitives.has(typeof value.value as 'string' | 'number' | 'boolean')
    })
    result[id] = members.length === 0 ? { kind: 'primitive', type: 'never' } : { kind: 'union', types: members }
  }
  return result
}

/**
 * Compute the versioned SHA-256 fingerprint of a canonical graph.
 * @param schema - canonical resolved persisted type.
 * @returns lowercase hexadecimal digest.
 */
export function schemaDigest(schema: CanonicalSchema): string {
  const version = schemaHasCompatibility(schema) ? 2 : 1
  return createHash('sha256').update(`dsh-persistence-schema-v${String(version)}\n`).update(JSON.stringify(schema)).digest('hex')
}

/**
 * Identify graphs that require the policy-aware fingerprint domain.
 * @param schema - resolved persisted type.
 * @returns whether any reachable property records compatibility metadata.
 */
export function schemaHasCompatibility(schema: CanonicalSchema): boolean {
  return schema.nodes.some(node => node.kind === 'object' && node.properties.some(property => property.compatibility !== undefined))
}

/**
 * Recognize the complete recursive JSON value language without relying on type names.
 * @param schema - canonical resolved type.
 * @returns whether the type permits arbitrary JSON values.
 */
export function isArbitraryJsonSchema(schema: CanonicalSchema): boolean {
  return schemaDigest(schema) === JSON_VALUE_DIGEST
}

const JSON_VALUE_DIGEST = schemaDigest(canonicalizeSchema([
  { kind: 'union', types: [1, 2, 3, 4, 5, 6] },
  { kind: 'primitive', type: 'null' },
  { kind: 'primitive', type: 'boolean' },
  { kind: 'primitive', type: 'number' },
  { kind: 'primitive', type: 'string' },
  { kind: 'array', element: 0 },
  { kind: 'object', properties: [], indices: [{ key: 4, value: 0 }] },
], 0))

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertNever(value: never): never {
  throw new Error(`persistence schema: unsupported node ${JSON.stringify(value)}`)
}
