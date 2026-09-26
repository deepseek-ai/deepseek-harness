/** Semantic review regressions independent of traversal ordinals and display names. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyPersistenceChange } from './persistence-changes.ts'
import { canonicalizeSchema, schemaDigest, type PersistenceSchemaInventory, type SchemaNode, type SchemaProperty } from './persistence-schema-model.ts'
import { renderPersistenceReview, reviewPersistenceSchemas, runPersistenceReview } from './persistence-review.ts'

function fixture(options: {
  extraKind?: boolean
  changed?: boolean
  ambiguous?: boolean
  reorder?: boolean
  tuple?: boolean
  recursive?: boolean
} = {}): PersistenceSchemaInventory {
  const nodes: SchemaNode[] = []
  const add = (node: SchemaNode): number => nodes.push(node) - 1
  const literal = (value: string): number => add({ kind: 'literal', value })
  const text = add({ kind: 'primitive', type: 'string' })
  const number = add({ kind: 'primitive', type: 'number' })
  const object = (properties: SchemaProperty[]): number => add({ kind: 'object', properties, indices: [] })
  const property = (name: string, type: number, optional = false): SchemaProperty => ({ name, type, optional })
  const snapshot = object([property('kind', literal('hooks-codex')), property('form', literal('snapshot')), property('sections', add({ kind: 'array', element: text }))])
  const notice = object([property('kind', literal('hooks-codex')), property('form', literal('notice')), property('summary', text)])
  const changing = object([property('kind', literal('changing')), property('value', options.changed ? number : text)])
  const variants = [snapshot, notice, changing]
  if (options.ambiguous) variants.push(object([property('kind', literal('changing')), property('extra', text)]))
  if (options.extraKind) variants.unshift(object([property('kind', literal('tool-registry'))]))
  if (options.reorder) variants.reverse()
  const source = add({ kind: 'union', types: variants })
  const payloadProperties = [property('source', source)]
  if (options.tuple) payloadProperties.push(property('tuple', add({ kind: 'tuple', elements: (options.changed ? [number, text] : [text, number]).map(type => ({ type, optional: false, rest: false })) })))
  if (options.recursive) payloadProperties.push(property('next', nodes.length, true))
  const payload = object(payloadProperties)
  const roots = ['agent/inbox/spliced', 'user/message'].map((event) => {
    const data = event === 'agent/inbox/spliced' ? object([property('inserted', add({ kind: 'array', element: payload }))]) : payload
    const index = object([property('type', literal(event)), property('data', data)])
    const schema = canonicalizeSchema(nodes, index)
    return { key: `event:${event}`, event, kind: 'event' as const, surface: false, digest: schemaDigest(schema), schema }
  })
  const types = [...new Map(nodes.map((_, index) => {
    const schema = canonicalizeSchema(nodes, index)
    const digest = schemaDigest(schema)
    const ordinal = index === snapshot ? options.extraKind ? 107 : 106 : index === notice ? options.extraKind ? 108 : 107 : undefined
    return [digest, { digest, schema, names: ordinal === undefined ? [] : [`event:agent/inbox/spliced.data.inserted[0].source[${String(ordinal)}]`], sources: [] }]
  })).values()]
  return { formatVersion: 1, roots, types }
}

describe('persistence review', () => {
  it('reports a new kind once across containing roots and never renames unchanged ordinal 107 alternatives', () => {
    const before = fixture()
    const after = fixture({ extraKind: true })
    const saved = JSON.stringify([before, after])
    const old107 = before.types.find(type => type.names.some(name => name.endsWith('[107]')))
    const new107 = after.types.find(type => type.names.some(name => name.endsWith('[107]')))
    expect(old107?.digest).not.toBe(new107?.digest)
    expect(after.types.find(type => type.digest === old107?.digest)?.names[0]).toMatch(/\[108\]$/u)
    const report = reviewPersistenceSchemas(before, after)
    expect(report.evidence).toHaveLength(1)
    expect(report.evidence[0]).toMatchObject({ kind: 'kind-added', before: null, locations: [
      { root: 'event:agent/inbox/spliced', path: 'event:agent/inbox/spliced.data.inserted[].source[kind="tool-registry"]' },
      { root: 'event:user/message', path: 'event:user/message.data.source[kind="tool-registry"]' },
    ] })
    const markdown = renderPersistenceReview(report)
    expect(markdown).not.toContain('hooks-codex')
    expect(markdown).not.toMatch(/source\[\d+\]/u)
    for (const root of report.roots) expect(root.changes).toEqual(classifyPersistenceChange(
      before.roots.find(item => item.key === root.root)!, after.roots.find(item => item.key === root.root)!,
    ))
    expect(JSON.stringify([before, after])).toBe(saved)
    expect(reviewPersistenceSchemas(before, {
      ...fixture({ extraKind: true, reorder: true }), roots: [...after.roots].reverse(), types: [...after.types].reverse(),
    })).toEqual(report)
  })

  it('shows existing kind changes alongside additions without weakening their compatibility result', () => {
    const report = reviewPersistenceSchemas(fixture(), fixture({ extraKind: true, changed: true }))
    expect(report.evidence.map(item => item.kind).sort()).toEqual(['kind-added', 'type-changed'])
    expect(report.evidence.find(item => item.kind === 'type-changed')?.locations[0]?.path).toBe('event:agent/inbox/spliced.data.inserted[].source[kind="changing"].value')
    expect(report.roots.every(root => root.changes.some(change => change.requiresVersionBump))).toBe(true)
  })

  it('keeps ambiguous kind matches as additions and removals even when another arm is unchanged', () => {
    const report = reviewPersistenceSchemas(fixture({ ambiguous: true }), fixture({ ambiguous: true, changed: true }))
    expect(report.evidence.map(item => item.kind).sort()).toEqual(['variant-added', 'variant-removed'])
    expect(report.evidence.every(item => item.locations.every(location => !location.path.endsWith('.value')))).toBe(true)
  })

  it('retains numeric tuple positions and stops recursion without losing sibling evidence', () => {
    const report = reviewPersistenceSchemas(
      fixture({ tuple: true, recursive: true }), fixture({ changed: true, tuple: true, recursive: true }),
    )
    const paths = report.evidence.flatMap(item => item.locations.map(location => location.path))
    expect(paths).toContain('event:user/message.data.tuple[0]')
    expect(paths).toContain('event:user/message.data.tuple[1]')
    expect(paths.every(path => path.length < 200)).toBe(true)
  })

  it('separates new roots from structural definitions and preserves classifier diagnostics', () => {
    const before = fixture()
    const after = { ...before, roots: before.roots.slice(1) }
    const report = reviewPersistenceSchemas(before, after)
    expect(report.roots).toHaveLength(1)
    expect(report.roots[0]?.changes).toEqual(classifyPersistenceChange(before.roots[0]!, null))
    expect(report.evidence).toEqual([])
    expect(renderPersistenceReview(report)).toContain('Root removed: `event:agent/inbox/spliced`')
  })

  it('reads explicit files without writes and rejects invalid inventories and arguments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'persistence-review-'))
    try {
      const before = join(directory, 'before.json')
      const after = join(directory, 'after.json')
      const oldText = JSON.stringify(fixture())
      const newText = JSON.stringify(fixture({ extraKind: true }))
      writeFileSync(before, oldText)
      writeFileSync(after, newText)
      const args = ['--before', before, '--after', after]
      expect(JSON.parse(runPersistenceReview([...args, '--json']))).toEqual(reviewPersistenceSchemas(fixture(), fixture({ extraKind: true })))
      expect(runPersistenceReview(args)).toContain('# Persistence schema review')
      expect(readFileSync(before, 'utf8')).toBe(oldText)
      expect(readFileSync(after, 'utf8')).toBe(newText)
      expect(() => runPersistenceReview(['--before', before])).toThrow(/--after/u)
      expect(() => runPersistenceReview([...args, '--write'])).toThrow()
      writeFileSync(after, '{"formatVersion":99}')
      expect(() => runPersistenceReview(args)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
