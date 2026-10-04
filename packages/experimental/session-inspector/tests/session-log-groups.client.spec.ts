/** Turn/Step intervals preserve original log rows, sticky ancestry, and live stream identities. */

import { MutableSessionEventSource, type SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { LlmAttemptId, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionLogModel } from '../src/client/views/session-log/model.ts'
import { InspectorTableHierarchy } from '../src/client/views/table-model.ts'
import { InspectorTypeFilter } from '../src/client/views/type-filter.ts'

const message = (seq: number): SessionEvent<'user/message'> => ({
  type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq), time: seq,
  data: { id: `input-${seq}` as MessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `input ${seq}` }] },
})
const events: readonly SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
  { type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } },
  message(3),
  { type: 'assistant/attempt', seq: SessionSeq(4), time: 4, data: { turn: 1, step: 1, stream: [
    { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', index: 0, time0: 3, dt: [], texts: ['thinking'] },
    { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } } },
  ] } },
  { type: 'step/end', seq: SessionSeq(5), time: 5, data: { turn: 1, step: 1 } },
  message(6),
  { type: 'step/start', seq: SessionSeq(7), time: 7, data: { turn: 1, step: 2 } },
  { type: 'tool/call', seq: SessionSeq(8), time: 8,
    data: { turn: 1, step: 2, callId: 'call' as ToolCallId, name: 'bash', arguments: '{}' } },
  { type: 'step/end', seq: SessionSeq(9), time: 9, data: { turn: 1, step: 2 } },
  { type: 'turn/end', seq: SessionSeq(10), time: 10, data: { turn: 1, reason: { kind: 'interrupted' } } },
  message(11),
  { type: 'turn/start', seq: SessionSeq(12), time: 12, data: { turn: 2 } },
  { type: 'turn/end', seq: SessionSeq(13), time: 13, data: { turn: 2, reason: { kind: 'interrupted' } } },
]
const entries = (values: readonly SessionEvent[]): SessionEventLikeEntry[] => values.map(event => ({ type: 'event', event }))

it('nests each Step inside its Turn and retains closers at the end of the corresponding group', () => {
  const source = new MutableSessionEventSource()
  source.replace(entries(events), false)
  const model = new SessionLogModel(source)
  const rows = model.getSnapshot()
  expect(rows.filter(row => !row.key.includes('/chunk:')).map(row => [row.key, row.parent, row.depth])).toEqual([
    ['event:1', undefined, 0], ['event:2', 'event:1', 1], ['event:3', 'event:2', 2],
    ['event:4', 'event:2', 2], ['event:5', 'event:2', 2], ['event:6', 'event:1', 1],
    ['event:7', 'event:1', 1], ['event:8', 'event:7', 2], ['event:9', 'event:7', 2],
    ['event:10', 'event:1', 1], ['event:11', undefined, 0],
    ['event:12', undefined, 0], ['event:13', 'event:12', 1],
  ])
  expect(rows.filter(row => ['event:1', 'event:2', 'event:7', 'event:12'].includes(row.key))
    .every(row => row.disclosure === 'open')).toBe(true)
  expect(rows.find(row => row.key === 'event:4/chunk:1'))
    .toEqual({ key: 'event:4/chunk:1', parent: 'event:4/chunk:0', depth: 4 })
  expect(model.row('event:5').getSnapshot()?.value).toBe(events[4])
  expect(model.row('event:10').getSnapshot()?.value).toBe(events[9])
  expect(model.chatAnchor('event:3')?.event).toBe(events[2])
  const hierarchy = new InspectorTableHierarchy(rows, new Map([
    ['event:4/chunk:0', { state: 'closed', collapsed: false }],
  ]))
  const sticky = (key: string) => hierarchy.stickyIndexes(hierarchy.rows.findIndex(row => row.key === key))
    .map(index => hierarchy.rows[index]!.key)
  expect(sticky('event:4/chunk:1')).toEqual(['event:1', 'event:2', 'event:4', 'event:4/chunk:0'])
  expect(sticky('event:5')).toEqual(['event:1', 'event:2'])
  expect(sticky('event:8')).toEqual(['event:1', 'event:7'])
  expect(sticky('event:10')).toEqual(['event:1'])
  expect(sticky('event:11')).toEqual([])
})

it('retains Turn/Step context while filtering and folds a whole Step independently', () => {
  const source = new MutableSessionEventSource()
  source.replace(entries(events), false)
  const model = new SessionLogModel(source)
  const filtered = new InspectorTypeFilter('user/message').apply(model.getSnapshot(), key => model.row(key).getSnapshot()?.type)
  expect([...filtered.matches]).toEqual(['event:3', 'event:6', 'event:11'])
  expect(filtered.rows.map(row => row.key)).toEqual(['event:1', 'event:2', 'event:3', 'event:6', 'event:11'])
  const folded = new InspectorTableHierarchy(model.getSnapshot(), new Map([
    ['event:2', { state: 'open', collapsed: true }],
  ]))
  expect(folded.rows.map(row => row.key)).toEqual([
    'event:1', 'event:2', 'event:6', 'event:7', 'event:8', 'event:9', 'event:10', 'event:11', 'event:12', 'event:13',
  ])
})

it('adds loaded start headers around existing rows without replacing their raw record sources', () => {
  const source = new MutableSessionEventSource()
  source.replace(entries(events.slice(2)), true)
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  const row = model.row('event:3')
  const record = row.getSnapshot()
  expect(model.getSnapshot()[0]).toEqual({ key: 'event:3', depth: 0 })
  expect(model.getSnapshot().find(row => row.key === 'event:8')).toMatchObject({ parent: 'event:7', depth: 1 })
  expect(model.getSnapshot().find(row => row.key === 'event:10')).toEqual({ key: 'event:10', depth: 0 })
  source.prepend(entries(events.slice(0, 2)), false)
  expect(model.getSnapshot().find(row => row.key === 'event:3')).toEqual({ key: 'event:3', parent: 'event:2', depth: 2 })
  expect(model.row('event:3')).toBe(row)
  expect(row.getSnapshot()).toBe(record)
})

it('keeps a live Assistant inside its Step through settlement without folding the Step or Turn', () => {
  const source = new MutableSessionEventSource()
  source.replace(entries(events.slice(0, 2)), false)
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  const attemptId = 'live-group' as LlmAttemptId
  source.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 3, time: 3,
    data: { attemptId, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'live' } } } })
  const key = 'attempt:live-group'
  expect(model.getSnapshot().find(row => row.key === key)).toEqual({ key, parent: 'event:2', depth: 2 })
  expect(model.getSnapshot().find(row => row.key === `${key}/chunk:0`)).toEqual({ key: `${key}/chunk:0`, parent: key, depth: 3 })
  source.settleAssistant(attemptId, { type: 'event', event: {
    type: 'assistant/attempt', seq: SessionSeq(4), time: 4, data: { turn: 1, step: 1,
      stream: [{ type: 'text-chunks', index: 0, time0: 3, dt: [], texts: ['live'] }] },
  } })
  source.append(entries([events[4]!])[0]!)
  source.append(entries([events[9]!])[0]!)
  expect(model.getSnapshot().find(row => row.key === key)).toEqual({ key, parent: 'event:2', depth: 2 })
  expect(new InspectorTableHierarchy(model.getSnapshot(), new Map()).rows.map(row => row.key))
    .toEqual(['event:1', 'event:2', key, `${key}/chunk:0`, 'event:5', 'event:10'])
})
