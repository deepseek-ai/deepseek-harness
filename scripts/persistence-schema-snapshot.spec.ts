/** Compact inventories retain root fingerprints and restore shared recursive type graphs. */

import { describe, expect, it } from 'vitest'
import { parseHistoricalPersistenceSnapshot, parsePersistenceSnapshot } from './persistence-changes.ts'
import { canonicalizeSchema, persistenceSchemaSnapshot, schemaDigest, type PersistenceSchemaInventory } from './persistence-schema-model.ts'
import { reviewPersistenceSchemas } from './persistence-review.ts'
import { renderPersistenceSchemaDefinitions, renderPersistenceSchemaIndex } from './render-persistence-schema.ts'

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

describe('compact persistence snapshots', () => {
  it('stores only root graphs and restores shared recursive definitions without changing reports', () => {
    const original = inventory()
    const snapshot = persistenceSchemaSnapshot(original)
    expect(snapshot.roots).toEqual(original.roots)
    expect(snapshot.types).toEqual(original.types.map(({ digest, names, sources }) => ({ digest, names, sources })))
    const restored = parsePersistenceSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(restored).toEqual(original)
    expect(reviewPersistenceSchemas(original, restored)).toEqual(reviewPersistenceSchemas(original, original))
    for (const rendering of ['current', 'historical'] as const) {
      expect(renderPersistenceSchemaIndex(restored, 'en', undefined, 2, rendering))
        .toBe(renderPersistenceSchemaIndex(original, 'en', undefined, 2, rendering))
      expect(renderPersistenceSchemaDefinitions(restored, 'en', undefined, 2, rendering))
        .toBe(renderPersistenceSchemaDefinitions(original, 'en', undefined, 2, rendering))
    }
    expect(parseHistoricalPersistenceSnapshot(snapshot)).toEqual(original)
  })

  it.each([true, false])('retains independent recursive types with root graphs=%s', (withRoots) => {
    const base = inventory()
    const schema = canonicalizeSchema([
      { kind: 'object', properties: [{ name: 'next', type: 0, optional: true }, { name: 'flag', type: 1, optional: false }], indices: [] },
      { kind: 'literal', value: false },
    ], 0)
    const independent = { digest: schemaDigest(schema), schema, names: ['example.ts#Independent', 'example.ts#Alias'], sources: ['example.ts'] }
    const original = { ...base, roots: withRoots ? base.roots : [], types: [independent, ...base.types] }
    const snapshot = persistenceSchemaSnapshot(original)
    expect(snapshot.types[0]).toEqual(independent)
    if (withRoots) expect(snapshot.types.slice(1).every(type => type.schema === undefined)).toBe(true)
    else expect(snapshot.types).toEqual(original.types)
    const restored = parsePersistenceSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(restored).toEqual(original)
    expect(parseHistoricalPersistenceSnapshot(snapshot)).toEqual(original)
    expect(persistenceSchemaSnapshot(restored)).toEqual(snapshot)
    expect(renderPersistenceSchemaDefinitions(restored)).toBe(renderPersistenceSchemaDefinitions(original))
  })

  it('reads legacy full graphs and keeps partial acknowledgement inventories empty', () => {
    const original = inventory()
    expect(parsePersistenceSnapshot(JSON.parse(JSON.stringify(original)))).toEqual(original)
    const partial = { ...original, types: [] }
    expect(parsePersistenceSnapshot(persistenceSchemaSnapshot(partial))).toEqual(partial)
  })

  it('rejects compact digests that do not identify a root subgraph', () => {
    const snapshot = persistenceSchemaSnapshot(inventory())
    const schema = canonicalizeSchema([{ kind: 'literal', value: 'unreachable' }], 0)
    expect(() => parsePersistenceSnapshot({ ...snapshot, types: [{ digest: schemaDigest(schema), names: [], sources: [] }] }))
      .toThrow('is not reachable from roots')
  })

  it('still validates explicit legacy graphs instead of replacing them with root graphs', () => {
    const original = inventory()
    const schema = canonicalizeSchema([{ kind: 'primitive', type: 'number' }], 0)
    expect(() => parsePersistenceSnapshot({ ...original, types: original.types.map(type => ({ ...type, schema })) }))
      .toThrow('shared schema digest mismatch')
  })

  it('rejects invalid metadata and malformed explicit schemas in compact inventories', () => {
    const snapshot = persistenceSchemaSnapshot(inventory())
    const type = snapshot.types[0]!
    expect(() => parsePersistenceSnapshot({ ...snapshot, types: [{ ...type, names: [3] }] })).toThrow('type name')
    expect(() => parsePersistenceSnapshot({ ...snapshot, types: [{ ...type, sources: [3] }] })).toThrow('type source')
    expect(() => parsePersistenceSnapshot({ ...snapshot, types: [{ ...type, schema: null }] })).toThrow('shared schema')
    expect(() => parseHistoricalPersistenceSnapshot({ ...snapshot, types: [{ ...type, sources: ['types.ts:3'] }] }))
      .toThrow('must omit line numbers')
  })
})
