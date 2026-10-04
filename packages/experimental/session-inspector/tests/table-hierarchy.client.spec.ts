/** Disclosure state and sticky ancestors use the same depth-first row hierarchy. */

import { expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { InspectorTableHierarchy, inspectorRowCollapsed, type InspectorDisclosure, type InspectorRow } from '../src/client/views/table-model.ts'
import { InspectorRecordSource } from '../src/client/views/table-model.ts'

const rows: readonly InspectorRow[] = [
  { key: 'assistant', depth: 0 },
  { key: 'reasoning', parent: 'assistant', depth: 1, disclosure: 'closed' },
  { key: 'reasoning-delta', parent: 'reasoning', depth: 2 },
  { key: 'tool', parent: 'assistant', depth: 1, disclosure: 'open' },
  { key: 'tool-delta', parent: 'tool', depth: 2 },
  { key: 'group', depth: 0 },
  { key: 'node', parent: 'group', depth: 1 },
]

it('keeps the Assistant and active block headers above the virtual viewport', () => {
  const hierarchy = new InspectorTableHierarchy(rows, new Map())
  expect(hierarchy.rows.map(row => row.key)).toEqual(['assistant', 'reasoning', 'tool', 'tool-delta', 'group', 'node'])
  expect(hierarchy.stickyIndexes(3)).toEqual([0, 2])
  expect(hierarchy.stickyIndexes(5)).toEqual([4])
  expect(hierarchy.stickyIndexes(100)).toEqual([])
})

it('hides every descendant of a manually collapsed Assistant', () => {
  const choices = new Map<string, InspectorDisclosure>([['assistant', { state: undefined, collapsed: true }]])
  expect(new InspectorTableHierarchy(rows, choices).rows.map(row => row.key)).toEqual(['assistant', 'group', 'node'])
})

it('resets an open-block override at closure but allows reopening the closed block', () => {
  const open: InspectorRow = { key: 'block', depth: 1, disclosure: 'open' }
  const closed: InspectorRow = { ...open, disclosure: 'closed' }
  const choices = new Map<string, InspectorDisclosure>([['block', { state: 'open', collapsed: false }]])
  expect(inspectorRowCollapsed(open, choices)).toBe(false)
  expect(inspectorRowCollapsed(closed, choices)).toBe(true)
  choices.set('block', { state: 'closed', collapsed: false })
  expect(inspectorRowCollapsed(closed, choices)).toBe(false)
})

it('does not create a sticky header for an ancestor outside the loaded window', () => {
  const hierarchy = new InspectorTableHierarchy([{ key: 'child', parent: 'unloaded', depth: 1 }], new Map())
  expect(hierarchy.stickyIndexes(0)).toEqual([])
})

it('clears a keyed row projection when its source is removed', () => {
  const source = createSnapshotStore<string | undefined>('before')
  const row = new InspectorRecordSource(source, value => ({ type: 'text', identity: value, location: '', value }))
  expect(row.getSnapshot()?.value).toBe('before')
  source.set(undefined)
  expect(row.getSnapshot()).toBeUndefined()
})
