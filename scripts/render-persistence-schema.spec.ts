/** Linked catalog regressions for transitive changes and shared definitions. */

import { describe, expect, it } from 'vitest'
import { canonicalizeSchema, schemaDigest, type PersistenceRoot, type PersistenceSchemaInventory, type PersistenceType, type SchemaNode } from './persistence-schema-model.ts'
import { renderPersistenceSchemaDefinitions, renderPersistenceSchemaIndex } from './render-persistence-schema.ts'
import { render } from './gen-persistence-catalog.ts'
import { classifyPersistenceChange } from './persistence-changes.ts'

function eventRoot(
  event: string,
  nodes: readonly SchemaNode[],
  types: Map<string, PersistenceType>,
  metadata: (index: number) => Pick<PersistenceType, 'names' | 'sources'>,
): PersistenceRoot {
  nodes.forEach((_, index) => {
    const schema = canonicalizeSchema(nodes, index)
    const digest = schemaDigest(schema)
    if (!types.has(digest)) types.set(digest, { digest, schema, ...metadata(index) })
  })
  const schema = canonicalizeSchema(nodes, 0)
  return { key: `event:${event}`, kind: 'event', event, surface: false, digest: schemaDigest(schema), schema }
}

function recursiveFixture(sources: readonly string[] = []): PersistenceSchemaInventory {
  const schema = canonicalizeSchema([{ kind: 'object', properties: [{ name: 'next', type: 0, optional: true }], indices: [] }], 0)
  const digest = schemaDigest(schema)
  return {
    formatVersion: 1,
    roots: [{ key: 'SessionHeader', kind: 'header', digest, schema }],
    types: [{ digest, schema, names: ['Recursive'], sources }],
  }
}

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
    return eventRoot(event, nodes, types, index => ({
      names: index === 3 ? ['ErrorInfo'] : [], sources: index === 3 ? ['packages/core/example/src/types.ts:8'] : [],
    }))
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
    const inventory = recursiveFixture()
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

function producerFixture(kinds: readonly string[], events: readonly string[]): PersistenceSchemaInventory {
  const types = new Map<string, PersistenceType>()
  const roots = events.map((event) => {
    const nodes: SchemaNode[] = [
      { kind: 'object', properties: [{ name: 'type', type: 1, optional: false }, { name: 'data', type: 2, optional: false }], indices: [] },
      { kind: 'literal', value: event },
      { kind: 'object', properties: [{ name: 'source', type: 3, optional: false }], indices: [] },
      { kind: 'union', types: kinds.map((_, index) => 4 + index * 2) },
      ...kinds.flatMap((kind, index): SchemaNode[] => [
        { kind: 'object', properties: [{ name: 'kind', type: 5 + index * 2, optional: false }], indices: [] },
        { kind: 'literal', value: kind },
      ]),
    ]
    return eventRoot(event, nodes, types, index => ({
      names: index >= 4 && index % 2 === 0 ? [`event:${event}.data.source[${String((index - 4) / 2)}]`] : [], sources: [],
    }))
  })
  return { formatVersion: 1, roots, types: [...types.values()] }
}

function currentDefinitions(inventory: PersistenceSchemaInventory): string {
  return renderPersistenceSchemaDefinitions(inventory, 'en', undefined, 2, 'current')
}

function assertLinkedOnce(markdown: string): void {
  const anchors = [...markdown.matchAll(/<a id="([^"]+)"><\/a>/gu)].map(match => match[1])
  expect(new Set(anchors).size).toBe(anchors.length)
  for (const match of markdown.matchAll(/\]\(#(persistence-type-[^)]+)\)/gu)) {
    expect(anchors, `missing target ${match[1]}`).toContain(match[1])
  }
}

describe('current persistence schema anchors', () => {
  it('names shared arrays by their declared elements independent of the first reaching root', () => {
    const nodes: SchemaNode[] = [
      { kind: 'array', element: 1 },
      { kind: 'object', properties: [{ name: 'text', type: 2, optional: false }], indices: [] },
      { kind: 'primitive', type: 'string' },
    ]
    const types = new Map<string, PersistenceType>()
    const root = eventRoot('second/event', nodes, types, index => ({ names: index === 1 ? ['ContextSnapshotSection'] : [], sources: [] }))
    const inventory: PersistenceSchemaInventory = { formatVersion: 1, roots: [root], types: [...types.values()] }
    const rendered = currentDefinitions(inventory)
    expect(rendered).toContain('### `ContextSnapshotSection[]`')
    const withEarlierRoot = { ...inventory, roots: [{ ...root, key: 'event:first/event' }, root] }
    expect(currentDefinitions(withEarlierRoot)).toContain('### `ContextSnapshotSection[]`')
    expect(rendered).not.toContain('### `event:second/event`')
    assertLinkedOnce(currentDefinitions(withEarlierRoot))
  })

  it('shows every kind/form arm, including absent, optional, broad and colliding forms', () => {
    const nodes: SchemaNode[] = [
      { kind: 'union', types: [1, 2, 3, 4, 5] },
      { kind: 'object', properties: [{ name: 'kind', type: 6, optional: false }], indices: [] },
      { kind: 'object', properties: [{ name: 'kind', type: 6, optional: false }, { name: 'form', type: 7, optional: false }, { name: 'summary', type: 8, optional: false }], indices: [] },
      { kind: 'object', properties: [{ name: 'kind', type: 6, optional: false }, { name: 'form', type: 7, optional: false }, { name: 'other', type: 8, optional: false }], indices: [] },
      { kind: 'object', properties: [{ name: 'kind', type: 6, optional: false }, { name: 'form', type: 8, optional: true }], indices: [] },
      { kind: 'object', properties: [{ name: 'kind', type: 6, optional: false }, { name: 'form', type: 9, optional: false }], indices: [{ key: 8, value: 8 }] },
      { kind: 'literal', value: 'hook|"quoted' },
      { kind: 'literal', value: 'notice' },
      { kind: 'primitive', type: 'string' },
      { kind: 'union', types: [7, 10] },
      { kind: 'literal', value: 'snapshot' },
    ]
    const types = new Map<string, PersistenceType>()
    const root = eventRoot('source/event', nodes, types, () => ({ names: [], sources: [] }))
    const inventory: PersistenceSchemaInventory = { formatVersion: 1, roots: [root], types: [...types.values()] }
    const rendered = currentDefinitions(inventory)
    expect(rendered).toContain('| `hook\\|"quoted` | not declared | none |')
    expect(rendered).toContain('| `hook\\|"quoted` | `string` (optional) | none |')
    expect(rendered.match(/\| `hook\\\|"quoted` \|/gu)).toHaveLength(5)
    expect(rendered).toContain('index signature')
    expect(rendered).toContain('other }`')
    expect(rendered).toContain('summary }`')
    assertLinkedOnce(rendered)
    const reordered = { ...inventory, types: [...inventory.types].reverse() }
    expect(currentDefinitions(reordered)).toBe(rendered)
  })

  it('falls back to complete unions for optional or broad kind discriminators', () => {
    for (const optional of [true, false]) {
      const nodes: SchemaNode[] = [
        { kind: 'union', types: [1, 2] },
        { kind: 'object', properties: [{ name: 'kind', type: optional ? 3 : 4, optional }], indices: [] },
        { kind: 'object', properties: [{ name: 'kind', type: 3, optional: false }], indices: [] },
        { kind: 'literal', value: 'example' },
        { kind: 'primitive', type: 'string' },
      ]
      const types = new Map<string, PersistenceType>()
      const root = eventRoot('broad/event', nodes, types, () => ({ names: [], sources: [] }))
      const rendered = currentDefinitions({ formatVersion: 1, roots: [root], types: [...types.values()] })
      expect(rendered).toContain('One of:')
      expect(rendered).not.toContain('| kind | Form property |')
      assertLinkedOnce(rendered)
    }
  })

  it('bounds labels for anonymous recursive arrays', () => {
    const schema = canonicalizeSchema([{ kind: 'array', element: 0 }], 0)
    const digest = schemaDigest(schema)
    const rendered = currentDefinitions({ formatVersion: 1, roots: [], types: [{ schema, digest, names: [], sources: [] }] })
    expect(rendered).toContain('### `array[]`')
    assertLinkedOnce(rendered)
    expect(rendered.length).toBeLessThan(1000)
  })

  it('labels empty objects without padding while preserving structural links and historical labels', () => {
    const nodes: SchemaNode[] = [
      { kind: 'object', properties: [{ name: 'type', type: 1, optional: false }, { name: 'data', type: 2, optional: false }], indices: [] },
      { kind: 'literal', value: 'empty/event' },
      { kind: 'array', element: 3 },
      { kind: 'object', properties: [], indices: [] },
    ]
    const types = new Map<string, PersistenceType>()
    const root = eventRoot('empty/event', nodes, types, () => ({ names: [], sources: [] }))
    const inventory: PersistenceSchemaInventory = { formatVersion: 1, roots: [root], types: [...types.values()] }
    const saved = JSON.stringify(inventory)
    const emptyDigest = schemaDigest(canonicalizeSchema(nodes, 3))
    const current = currentDefinitions(inventory)
    expect(current).toContain('### `{}`')
    expect(current).not.toContain('{  }')
    expect(current).toContain('[`{}`](#persistence-type-sha256-' + emptyDigest + ')')
    assertLinkedOnce(current)
    const historical = renderPersistenceSchemaDefinitions(inventory)
    expect(historical).toContain('### `event:empty/event.data.item`')
    expect(historical).toContain('Array of [`event:empty/event.data.item`](#persistence-type-eventemptyeventdataitem).')
    expect(JSON.stringify(inventory)).toBe(saved)
    expect(schemaDigest(root.schema)).toBe(root.digest)
  })

  it('keeps anonymous producer references when siblings and the first owning root change', () => {
    const before = producerFixture(['alpha', 'beta'], ['second/event'])
    const after = producerFixture(['new', 'beta', 'alpha'], ['first/event', 'second/event'])
    const alphaSchema = canonicalizeSchema([
      { kind: 'object', properties: [{ name: 'kind', type: 1, optional: false }], indices: [] },
      { kind: 'literal', value: 'alpha' },
    ], 0)
    const alphaDigest = schemaDigest(alphaSchema)
    const link = '[`{ kind: "alpha" }`](#persistence-type-sha256-' + alphaDigest + ')'
    expect(currentDefinitions(before)).toContain(link)
    expect(currentDefinitions(after)).toContain(link)
    expect(currentDefinitions(after)).not.toContain('.source[')
    assertLinkedOnce(currentDefinitions(after))
    const reordered = { ...after, roots: [...after.roots].reverse(), types: [...after.types].reverse() }
    expect(currentDefinitions(reordered)).toBe(currentDefinitions(after))
  })

  it('retains logical root and named aliases while structural links track changed content', () => {
    const before = fixture()
    const after = fixture(false)
    const old = currentDefinitions(before)
    const updated = currentDefinitions(after)
    for (const definitions of [old, updated]) {
      expect(definitions).toContain('<a id="persistence-type-errorinfo"></a>')
      expect(definitions).toContain('<a id="persistence-type-eventfirstevent"></a>')
    }
    expect(old).not.toBe(updated)
    const document = render([], [], after)
    expect(document).toContain('](#persistence-type-sha256-' + after.roots[0]!.digest + ')')
    assertLinkedOnce(document)
  })

  it('omits ambiguous aliases and keeps colliding labels linked to distinct definitions', () => {
    const complete = fixture()
    const first = complete.types[0] as PersistenceType
    const second = complete.types[1] as PersistenceType
    const inventory = { ...complete, types: complete.types.map(type => type === first
      ? { ...type, names: ['A.B', 'sha256-' + second.digest] }
      : type === second ? { ...type, names: ['AB'] } : type) }
    const definitions = currentDefinitions(inventory)
    expect(definitions).not.toContain('<a id="persistence-type-ab"></a>')
    expect(definitions).toContain('<a id="persistence-type-sha256-' + first.digest + '"></a>')
    expect(definitions).toContain('<a id="persistence-type-sha256-' + second.digest + '"></a>')
    assertLinkedOnce(definitions)
  })

  it('renders recursion once and leaves inventories, digests and classifications unchanged', () => {
    const inventory = recursiveFixture()
    const { schema, digest } = inventory.roots[0]!
    const saved = JSON.stringify(inventory)
    const before = fixture()
    const after = fixture(false)
    const classification = classifyPersistenceChange(before.roots[0]!, after.roots[0]!)
    const rendered = currentDefinitions(inventory)
    expect(rendered.match(/### `Recursive`/gu)).toHaveLength(1)
    expect(rendered).toContain('[`Recursive`](#persistence-type-sha256-' + digest + ')')
    assertLinkedOnce(rendered)
    currentDefinitions(after)
    expect(JSON.stringify(inventory)).toBe(saved)
    expect(schemaDigest(schema)).toBe(digest)
    expect(classifyPersistenceChange(before.roots[0]!, after.roots[0]!)).toEqual(classification)
  })

  it('shows recorded source policies only in the current catalog and preserves their fields', () => {
    const schema = canonicalizeSchema([
      { kind: 'object', properties: [{ name: 'source', type: 1, optional: false, compatibility: {
        version: 1, policy: 'session-source-attribution', binding: 'session.user-message.source',
        discriminator: 'kind', unknownKinds: 'preserve', attributionKinds: ['build-context'],
      } }], indices: [] },
      { kind: 'object', properties: [{ name: 'kind', type: 2, optional: false }], indices: [] },
      { kind: 'literal', value: 'build-context' },
    ], 0)
    const types = schema.nodes.map((_, index) => {
      const nested = canonicalizeSchema(schema.nodes, index)
      return { digest: schemaDigest(nested), schema: nested, names: [], sources: [] }
    })
    const inventory: PersistenceSchemaInventory = { formatVersion: 2, roots: [], types }
    const saved = JSON.stringify(inventory)
    expect(currentDefinitions(inventory)).toContain('Source compatibility: `source` — `session-source-attribution` v1; `session.user-message.source`; `kind`; `preserve`.')
    expect(currentDefinitions(inventory)).toContain('Attribution-only additions: `build-context`.')
    expect(renderPersistenceSchemaDefinitions(inventory, 'zh', undefined, 2, 'current')).toContain('仅表示归属的新增 kind：`build-context`.')
    expect(renderPersistenceSchemaDefinitions(inventory)).not.toContain('Source compatibility:')
    expect(JSON.stringify(inventory)).toBe(saved)
  })

  it('keeps the captured historical Markdown byte-for-byte in both historical call forms', () => {
    const inventory = recursiveFixture(['packages/core/example/src/types.ts'])
    const expected = [
      '### Persistence type fingerprints', '', 'Frozen reference.', '',
      '| Root | Kind | SHA-256 | Resolved type |', '|---|---|---|---|',
      '| `SessionHeader` | header | `c900da63847d1d27572277817e727f3a471d08f0abaf0b61b4984c32ffc6a332` | [`Recursive`](#persistence-type-recursive) |', '',
      '### Resolved persistence types', '',
      'Each definition appears once. References preserve sharing and recursion; the digest beside a definition includes its complete reachable structure. Source names and locations identify its declarations but are excluded from its digest.', '',
      '<a id="persistence-type-recursive"></a>', '', '#### `Recursive`', '',
      'SHA-256: `c900da63847d1d27572277817e727f3a471d08f0abaf0b61b4984c32ffc6a332`', '',
      'Sources: `packages/core/example/src/types.ts`', '',
      '| Property | Presence | Type |', '|---|---|---|',
      '| `next` | optional | [`Recursive`](#persistence-type-recursive) |', '',
    ].join('\n')
    const index = renderPersistenceSchemaIndex(inventory, 'en', ['Frozen reference.'], 3)
    expect(index + '\n' + renderPersistenceSchemaDefinitions(inventory, 'en', () => undefined, 3)).toBe(expected)
    expect(renderPersistenceSchemaIndex(inventory, 'en', ['Frozen reference.'], 3, 'historical') + '\n'
      + renderPersistenceSchemaDefinitions(inventory, 'en', () => undefined, 3, 'historical')).toBe(expected)
  })
})
