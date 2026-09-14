/** Linked catalog regressions for transitive changes and shared definitions. */

import { describe, expect, it } from 'vitest'
import { canonicalizeSchema, schemaDigest, type PersistenceSchemaInventory, type PersistenceType, type SchemaNode } from './persistence-schema-model.ts'
import { renderPersistenceSchemaDefinitions, renderPersistenceSchemaIndex } from './render-persistence-schema.ts'

function fixture(optional = true): PersistenceSchemaInventory {
  const types = new Map<string, PersistenceType>()
  const roots = ['first/event', 'second/event'].map((event) => {
    const nodes: SchemaNode[] = [
      { kind: 'object', properties: [{ name: 'type', type: 1, optional: false }, { name: 'data', type: 2, optional: false }], indices: [] },
      { kind: 'literal', value: event },
      { kind: 'object', properties: [{ name: 'error', type: 3, optional: true }], indices: [] },
      { kind: 'object', properties: [{ name: 'reason', type: 4, optional }], indices: [] },
      { kind: 'primitive', type: 'string' },
    ]
    nodes.forEach((_, index) => {
      const schema = canonicalizeSchema(nodes, index)
      const digest = schemaDigest(schema)
      if (!types.has(digest)) types.set(digest, { digest, schema, names: index === 3 ? ['ErrorInfo'] : [], sources: index === 3 ? ['packages/core/example/src/types.ts:8'] : [] })
    })
    const schema = canonicalizeSchema(nodes, 0)
    return { key: `event:${event}`, kind: 'event' as const, event, surface: false, digest: schemaDigest(schema), schema }
  })
  return { formatVersion: 1, roots, types: [...types.values()] }
}

describe('persistence schema catalog', () => {
  it('shows a shared nested definition once and updates both affected root fingerprints', () => {
    const before = fixture()
    const after = fixture(false)
    const definitions = renderPersistenceSchemaDefinitions(after)
    expect(definitions.match(/### `ErrorInfo`/gu)).toHaveLength(1)
    expect(definitions).toContain('| `reason` | required | `string` |')
    expect(definitions).toContain('[`ErrorInfo`](#persistence-type-errorinfo)')
    const index = renderPersistenceSchemaIndex(after)
    for (const [position, root] of after.roots.entries()) {
      expect(root.digest).not.toBe(before.roots[position]?.digest)
      expect(index).toContain(root.digest)
    }
  })

  it('keeps named definition anchors when their digest changes', () => {
    const before = renderPersistenceSchemaDefinitions(fixture())
    const after = renderPersistenceSchemaDefinitions(fixture(false))
    expect(before).toContain('<a id="persistence-type-errorinfo"></a>')
    expect(after).toContain('<a id="persistence-type-errorinfo"></a>')
    expect(before).not.toBe(after)
  })

  it('renders historical source paths and nested headings within their reference section', () => {
    const current = fixture()
    const inventory = { ...current, types: current.types.map(type => ({ ...type, sources: type.sources.map(source => source.replace(/:\d+$/u, '')) })) }
    const definitions = renderPersistenceSchemaDefinitions(inventory, 'en', () => undefined, 3)
    expect(definitions).toContain('Sources: `packages/core/example/src/types.ts`')
    expect(definitions).not.toContain('types.ts:8')
    expect(definitions).not.toContain('(../packages/')
    expect(definitions).toContain('### Resolved persistence types')
    expect(definitions).toContain('#### `ErrorInfo`')
    const index = renderPersistenceSchemaIndex(inventory, 'en', ['[Historical schema](v0.schema.json)'], 3)
    expect(index).toContain('[Historical schema](v0.schema.json)')
    expect(index).toContain('### Persistence type fingerprints')
    expect(index).not.toContain('(persistence-schema.json)')
    expect(renderPersistenceSchemaDefinitions(current)).toContain('[`packages/core/example/src/types.ts:8`](../packages/core/example/src/types.ts)')
  })

  it('refuses a current inventory that omits a referenced definition', () => {
    const complete = fixture()
    const missing: PersistenceSchemaInventory = { ...complete, types: [] }
    expect(() => renderPersistenceSchemaIndex(missing)).toThrow(/absent from the inventory/u)
  })

  it('renders a recursive definition through a finite self-reference', () => {
    const schema = canonicalizeSchema([{ kind: 'object', properties: [{ name: 'next', type: 0, optional: true }], indices: [] }], 0)
    const digest = schemaDigest(schema)
    const inventory: PersistenceSchemaInventory = {
      formatVersion: 1,
      roots: [{ key: 'SessionHeader', kind: 'header', digest, schema }],
      types: [{ digest, schema, names: ['Recursive'], sources: [] }],
    }
    expect(renderPersistenceSchemaDefinitions(inventory)).toContain('| `next` | optional | [`Recursive`](#persistence-type-recursive) |')
  })

  it('uses intrinsic scalar labels even when an alias or reference supplied a name', () => {
    const schema = canonicalizeSchema([{ kind: 'primitive', type: 'string' }], 0)
    const digest = schemaDigest(schema)
    const inventory: PersistenceSchemaInventory = {
      formatVersion: 1,
      roots: [],
      types: [{ digest, schema, names: ['SessionHeader.agentPreset'], sources: [] }],
    }
    const rendered = renderPersistenceSchemaDefinitions(inventory)
    expect(rendered).toContain('### `string`')
    expect(rendered).not.toContain('### `SessionHeader.agentPreset`')
  })
})
