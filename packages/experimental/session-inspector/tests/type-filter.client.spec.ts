/** Type fragments retain matching rows with enough hierarchy to inspect their context. */

import { expect, it, vi } from 'vitest'
import { InspectorTableHierarchy, type InspectorRow } from '../src/client/views/table-model.ts'
import { InspectorTypeFilter } from '../src/client/views/type-filter.ts'

const rows: readonly InspectorRow[] = [
  { key: 'assistant', depth: 0 },
  { key: 'block', parent: 'assistant', depth: 1, disclosure: 'closed' },
  { key: 'delta-1', parent: 'block', depth: 2 },
  { key: 'delta-2', parent: 'block', depth: 2 },
  { key: 'end', parent: 'block', depth: 2 },
  { key: 'tool', depth: 0 },
]
const types = new Map([
  ['assistant', 'assistant/message'], ['block', 'block-start'],
  ['delta-1', 'reasoning-delta'], ['delta-2', 'reasoning-delta'],
  ['end', 'block-end'], ['tool', 'tool/call'],
])
const typeOf = (key: string): string | undefined => types.get(key)

it('matches case-insensitive fragments with optional surrounding stars', () => {
  const filter = new InspectorTypeFilter('  *DeLtA*  ')
  expect(filter.query).toBe('DeLtA')
  expect(filter.active).toBe(true)
  expect(filter.matches('reasoning-delta')).toBe(true)
  expect(filter.matches('tool-call-delta')).toBe(true)
  expect(filter.matches('block-start')).toBe(false)
  expect(filter.matches(undefined)).toBe(false)
  expect(new InspectorTypeFilter('tool/').matches('tool/call')).toBe(true)
})

it.each(['', '   ', '***', ' * * '])('leaves the original hierarchy untouched for %j', (query) => {
  const filter = new InspectorTypeFilter(query)
  const reader = vi.fn(typeOf)
  const result = filter.apply(rows, reader)
  expect(filter.active).toBe(false)
  expect(result.rows).toBe(rows)
  expect(result.matches).toEqual(new Set(rows.map(row => row.key)))
  expect(reader).not.toHaveBeenCalled()
})

it('reveals matching descendants of closed blocks without including unrelated children', () => {
  const result = new InspectorTypeFilter('delta').apply(rows, typeOf)
  expect([...result.matches]).toEqual(['delta-1', 'delta-2'])
  expect(result.rows).toEqual([
    { key: 'assistant', depth: 0, disclosure: 'open' },
    { key: 'block', parent: 'assistant', depth: 1, disclosure: 'open' },
    rows[2], rows[3],
  ])
  const hierarchy = new InspectorTableHierarchy(result.rows, new Map())
  expect(hierarchy.rows).toEqual(result.rows)
  expect(hierarchy.stickyIndexes(3)).toEqual([0, 1])
  expect(rows[1]?.disclosure).toBe('closed')
  expect(new InspectorTableHierarchy(result.rows, new Map([
    ['block', { state: 'open', collapsed: true }],
  ])).rows.map(row => row.key)).toEqual(['assistant', 'block'])
})

it('removes empty disclosures and produces an empty result when no type matches', () => {
  const result = new InspectorTypeFilter('block-start').apply(rows, typeOf)
  expect(result.rows).toEqual([
    { key: 'assistant', depth: 0, disclosure: 'open' },
    { key: 'block', parent: 'assistant', depth: 1 },
  ])
  expect(new InspectorTypeFilter('absent').apply(rows, typeOf)).toEqual({ rows: [], matches: new Set() })
})

it('asynchronously suggests distinct loaded types independently of row disclosure', async () => {
  const reader = vi.fn(typeOf)
  const suggestions = new InspectorTypeFilter('*DELTA*').suggest(rows, reader)
  expect(reader).not.toHaveBeenCalled()
  expect(await suggestions).toEqual(['reasoning-delta'])
  expect(await new InspectorTypeFilter('').suggest([...rows, { key: 'missing', depth: 0 }], reader))
    .toEqual(['assistant/message', 'block-end', 'block-start', 'reasoning-delta', 'tool/call'])
})
