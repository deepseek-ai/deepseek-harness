/** Snapshot text stores one node table keyed by subgraph digest and restores every root and type graph. */

import { describe, expect, it } from 'vitest'
import { parseHistoricalPersistenceSnapshot, parsePersistenceSnapshot } from './persistence-changes.ts'
import { canonicalizeSchema, encodePersistenceSnapshot, schemaDigest, type PersistenceSchemaInventory, type SchemaNode } from './persistence-schema-model.ts'
import { reviewPersistenceSchemas } from './persistence-review.ts'
import { renderPersistenceSchemaDefinitions } from './render-persistence-schema.ts'

function inventory(): PersistenceSchemaInventory {
  const schema = canonicalizeSchema([
    { kind: 'object', properties: [{ name: 'child', type: 1, optional: false }], indices: [] },
    { kind: 'object', properties: [{ name: 'next', type: 1, optional: true }, { name: 'value', type: 2, optional: false }], indices: [] },
    { kind: 'primitive', type: 'string' },
  ], 0)
  return {
    formatVersion: 1,
    roots: ['SessionHeader', 'JsonlHeaderLine'].map(key => ({ key, kind: 'header', digest: schemaDigest(schema), schema })),
    types: schema.nodes.map((_, index) => {
      const type = canonicalizeSchema(schema.nodes, index)
      return { digest: schemaDigest(type), schema: type, names: index === 1 ? ['Recursive'] : [], sources: ['packages/example/src/types.ts'] }
    }).sort((left, right) => left.digest.localeCompare(right.digest)),
  }
}

interface SnapshotJson {
  roots: Record<string, unknown>[]
  types: Record<string, unknown>[]
  nodes: Record<string, Record<string, unknown>>
}

function edit(text: string, change: (value: SnapshotJson) => void): string {
  const value = JSON.parse(text) as SnapshotJson
  change(value)
  return JSON.stringify(value)
}

describe('persistence snapshot text', () => {
  it('stores each shared node once and restores graphs without changing reports', () => {
    const original = inventory()
    const text = encodePersistenceSnapshot(original)
    const parsed = JSON.parse(text) as SnapshotJson
    expect(Object.keys(parsed.nodes)).toHaveLength(3)
    expect(parsed.roots[0]).toEqual({ key: 'SessionHeader', kind: 'header', digest: original.roots[0]!.digest })
    expect(text.split('\n').every(line => !/"type": \d/u.test(line))).toBe(true)
    const restored = parsePersistenceSnapshot(text)
    expect(restored).toEqual(original)
    expect(reviewPersistenceSchemas(original, restored)).toEqual(reviewPersistenceSchemas(original, original))
    expect(parseHistoricalPersistenceSnapshot(text)).toEqual(original)
    expect(encodePersistenceSnapshot(restored)).toBe(text)
  })

  it('changes only the new node and its ancestors when a union gains a variant', () => {
    const graph = (variants: readonly string[]): PersistenceSchemaInventory => {
      const nodes: SchemaNode[] = [
        { kind: 'object', properties: [{ name: 'other', type: 1, optional: false }, { name: 'source', type: 2, optional: false }], indices: [] },
        { kind: 'object', properties: [{ name: 'value', type: 3, optional: false }], indices: [] },
        { kind: 'union', types: variants.map((_, index) => 4 + index) },
        { kind: 'primitive', type: 'number' },
        ...variants.map((value): SchemaNode => ({ kind: 'literal', value })),
      ]
      const schema = canonicalizeSchema(nodes, 0)
      return { formatVersion: 1, roots: [{ key: 'SessionHeader', kind: 'header', digest: schemaDigest(schema), schema }], types: [] }
    }
    const keys = (value: PersistenceSchemaInventory): string[] =>
      Object.keys((JSON.parse(encodePersistenceSnapshot(value)) as SnapshotJson).nodes)
    const before = new Set(keys(graph(['a', 'c'])))
    const after = keys(graph(['a', 'b', 'c']))
    expect(after.filter(key => !before.has(key))).toHaveLength(3)
    expect([...before].filter(key => !after.includes(key))).toHaveLength(2)
  })

  it.each([true, false])('retains independent recursive types with root graphs=%s', (withRoots) => {
    const base = inventory()
    const schema = canonicalizeSchema([
      { kind: 'object', properties: [{ name: 'next', type: 0, optional: true }, { name: 'flag', type: 1, optional: false }], indices: [] },
      { kind: 'literal', value: false },
    ], 0)
    const independent = { digest: schemaDigest(schema), schema, names: ['example.ts#Independent', 'example.ts#Alias'], sources: ['example.ts'] }
    const original = { ...base, roots: withRoots ? base.roots : [], types: [independent, ...base.types] }
    const restored = parsePersistenceSnapshot(encodePersistenceSnapshot(original))
    expect(restored).toEqual(original)
    expect(renderPersistenceSchemaDefinitions(restored)).toBe(renderPersistenceSchemaDefinitions(original))
  })

  it('rejects tampered node keys, unknown references, orphan nodes, and digest mismatches', () => {
    const text = encodePersistenceSnapshot(inventory())
    const rootKey = inventory().roots[0]!.digest.slice(0, 16)
    const second = Object.keys((JSON.parse(text) as SnapshotJson).nodes).find(key => key !== rootKey)!
    expect(() => parsePersistenceSnapshot(edit(text, (value) => {
      value.nodes = Object.fromEntries(Object.entries(value.nodes).map(([key, node]) => [key === rootKey ? 'f'.repeat(16) : key, node]))
    }))).toThrow('key does not match')
    expect(() => parsePersistenceSnapshot(edit(text, (value) => { value.nodes[rootKey] = { kind: 'array', element: '0'.repeat(16) } })))
      .toThrow('unknown schema node')
    expect(() => parsePersistenceSnapshot(edit(text, (value) => { value.nodes[second] = { kind: 'primitive', type: 'number' } })))
      .toThrow('key does not match')
    expect(() => parsePersistenceSnapshot(edit(encodePersistenceSnapshot({ ...inventory(), roots: [] }), (value) => { value.types = [] })))
      .toThrow('not reachable from any root or type')
    expect(() => parsePersistenceSnapshot(edit(text, (value) => { value.roots[0]!.digest = 'f'.repeat(64) }))).toThrow('no schema node for digest prefix')
  })

  it('rejects node entries whose properties or union members are not in canonical order', () => {
    const text = encodePersistenceSnapshot(inventory())
    const nodes = (JSON.parse(text) as SnapshotJson).nodes
    const [objectKey] = Object.entries(nodes).find(([, node]) => ((node.properties as unknown[] | undefined)?.length ?? 0) > 1)!
    expect(() => parsePersistenceSnapshot(edit(text, (value) => {
      (value.nodes[objectKey]!.properties as unknown[]).reverse()
    }))).toThrow('node is not canonical')
    const unionSchema = canonicalizeSchema([
      { kind: 'union', types: [1, 2] }, { kind: 'literal', value: 'a' }, { kind: 'literal', value: 'b' },
    ], 0)
    const union = encodePersistenceSnapshot({ formatVersion: 1, roots: [],
      types: [{ digest: schemaDigest(unionSchema), schema: unionSchema, names: [], sources: [] }] })
    const [unionKey] = Object.entries((JSON.parse(union) as SnapshotJson).nodes).find(([, node]) => node.kind === 'union')!
    expect(() => parsePersistenceSnapshot(edit(union, (value) => {
      const types = value.nodes[unionKey]!.types as string[]
      value.nodes[unionKey]!.types = [types[0], ...types]
    }))).toThrow('node is not canonical')
  })

  it('rejects valid content outside the canonical text layout', () => {
    const text = encodePersistenceSnapshot(inventory())
    expect(() => parsePersistenceSnapshot(JSON.stringify(JSON.parse(text), null, 2) + '\n')).toThrow('canonical layout')
  })

  it('rejects invalid type metadata', () => {
    const text = encodePersistenceSnapshot(inventory())
    expect(() => parsePersistenceSnapshot(edit(text, (value) => { value.types[0]!.names = [3] }))).toThrow('type name')
    expect(() => parsePersistenceSnapshot(edit(text, (value) => { value.types[0]!.sources = [3] }))).toThrow('type source')
    expect(() => parsePersistenceSnapshot(edit(text, (value) => { value.types[0]!.schema = {} }))).toThrow('unknown field schema')
    expect(() => parseHistoricalPersistenceSnapshot(edit(text, (value) => { value.types[0]!.sources = ['types.ts:3'] })))
      .toThrow('must omit line numbers')
  })
})
