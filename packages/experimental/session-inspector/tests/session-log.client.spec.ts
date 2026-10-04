/** Raw log pagination and settlement preserve original delta boundaries. */

import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { LlmAttemptId, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionLogModel } from '../src/client/views/session-log/model.ts'
import { InspectorTableHierarchy } from '../src/client/views/table-model.ts'
import { SessionLogGroups } from '../src/client/views/session-log/groups.ts'

const attemptId = 'attempt-1' as LlmAttemptId
const durable = (seq: number): SessionEventLikeEntry => ({
  type: 'event', event: { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: seq } },
})
const delta = (seq: number, text: string): SessionEventLikeEntry => ({
  type: 'transient', event: { type: 'assistant/live-chunk', seq, time: seq,
    data: { attemptId, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } } },
})

it('reuses published historical rows and groups only new roots while appending deltas', () => {
  const source = new MutableSessionEventSource()
  source.replace(Array.from({ length: 2000 }, (_, index) => durable(index + 1)), false)
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  const grouped = vi.spyOn(SessionLogGroups.prototype, 'append')
  onTestFinished(() => { grouped.mockRestore() })
  const before = model.getSnapshot()
  source.append(delta(2001, 'first'))
  const first = model.getSnapshot()
  for (let index = 0; index < 100; index++) source.append(delta(2002 + index, 'more'))
  const after = model.getSnapshot()
  expect(grouped).toHaveBeenCalledTimes(1)
  expect(after.slice(0, before.length).every((row, index) => row === before[index])).toBe(true)
  expect(after[first.length - 1]).toBe(first[first.length - 1])
  expect(first).toHaveLength(2002)
  expect(after).toHaveLength(2102)
})

it('keeps earlier snapshots immutable across interleaved blocks and a later log root', () => {
  const source = new MutableSessionEventSource()
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  let seq = 0
  const append = (chunk: StreamChunk) => {
    source.append({ type: 'transient', event: {
      type: 'assistant/live-chunk', seq: ++seq, time: seq, data: { attemptId, turn: 1, step: 1, chunk },
    } })
  }
  append({ type: 'block-start', index: 0, blockType: 'reasoning' })
  append({ type: 'block-start', index: 1, blockType: 'text' })
  source.append(durable(++seq))
  const before = model.getSnapshot()
  append({ type: 'reasoning-delta', index: 0, text: 'a' })
  append({ type: 'text-delta', index: 1, text: 'b' })
  append({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'a' } })
  expect(before.map(row => row.key)).toEqual(['attempt:attempt-1', 'attempt:attempt-1/chunk:0', 'attempt:attempt-1/chunk:1', 'event:3'])
  expect(before[1]?.disclosure).toBe('open')
  const rebuilt = new SessionLogModel(source)
  expect(model.getSnapshot()).toEqual(rebuilt.getSnapshot())
  expect(model.getSnapshot().at(-1)?.key).toBe('event:3')
})

it('maps picked Chat identities to tool calls, reasoning blocks, and loaded Step or Turn records', () => {
  const source = new MutableSessionEventSource()
  source.replace([
    durable(1),
    { type: 'event', event: { type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } } },
    { type: 'event', event: { type: 'assistant/attempt', seq: SessionSeq(3), time: 3,
      data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }] } } },
    { type: 'event', event: { type: 'tool/call', seq: SessionSeq(4), time: 4,
      data: { turn: 1, step: 1, callId: 'call-1' as ToolCallId, name: 'bash', arguments: '{}' } } },
  ], false)
  const model = new SessionLogModel(source)
  expect(model.pick({ callId: 'call-1', anchorSeq: 3 })).toBe('event:4')
  expect(model.pick({ anchorSeq: 3, groupPart: 'reasoning' })).toBe('event:3/chunk:0')
  expect(model.pick({ nodeKind: 'assistant-step', turn: 1, step: 1 })).toBe('event:3')
  expect(model.pick({ turn: 1, step: 1 })).toBe('event:2')
  expect(model.pick({ turn: 1 })).toBe('event:1')
  expect(model.pick({ turn: 9 })).toBeUndefined()
  expect(model.chatAnchor('event:3/chunk:0')).toMatchObject({ event: { type: 'assistant/attempt', seq: 3 },
    chunk: { type: 'block-start', blockType: 'reasoning' } })
  expect(model.chatAnchor('missing')).toBeUndefined()
  source.append(delta(5, 'live'))
  expect(model.pick({ anchorSeq: 5 })).toBe('attempt:attempt-1')
  expect(model.chatAnchor('attempt:attempt-1/chunk:0')).toMatchObject({ event: { type: 'assistant/live-chunk' },
    chunk: { type: 'text-delta', text: 'live' } })
})

it('nests interleaved reasoning and tool deltas under their block-start and folds each block at block-end', () => {
  const source = new MutableSessionEventSource()
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  let sequence = 0
  const append = (chunk: StreamChunk) => {
    source.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: ++sequence, time: sequence,
      data: { attemptId, turn: 1, step: 1, chunk } } })
  }
  const visible = () => new InspectorTableHierarchy(model.getSnapshot(), new Map()).rows.map(row => row.key)
  append({ type: 'block-start', index: 0, blockType: 'reasoning' })
  append({ type: 'reasoning-delta', index: 0, text: 'first' })
  append({ type: 'block-start', index: 1, blockType: 'tool-call' })
  append({ type: 'tool-call-delta', index: 1, id: 'call-1' as ToolCallId, argumentsDelta: '{}' })
  append({ type: 'reasoning-delta', index: 0, text: 'second' })
  expect(model.row('attempt:attempt-1/chunk:0').getSnapshot()).toMatchObject({
    collapsedSummary: 'blockType: reasoning · firstsecond',
    value: { type: 'block-start', index: 0, blockType: 'reasoning' },
  })
  expect(model.row('attempt:attempt-1/chunk:2').getSnapshot()?.collapsedSummary).toBeUndefined()
  expect(model.getSnapshot().map(row => row.key)).toEqual([
    'attempt:attempt-1', 'attempt:attempt-1/chunk:0', 'attempt:attempt-1/chunk:1',
    'attempt:attempt-1/chunk:4', 'attempt:attempt-1/chunk:2', 'attempt:attempt-1/chunk:3',
  ])
  expect(model.getSnapshot().find(row => row.key.endsWith('/chunk:3')))
    .toMatchObject({ parent: 'attempt:attempt-1/chunk:2', depth: 2 })
  expect(visible()).toHaveLength(6)
  append({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'firstsecond' } })
  expect(visible()).toEqual(['attempt:attempt-1', 'attempt:attempt-1/chunk:0', 'attempt:attempt-1/chunk:2', 'attempt:attempt-1/chunk:3'])
  append({ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1' as ToolCallId, name: 'bash', arguments: '{}' } })
  expect(visible()).toEqual(['attempt:attempt-1', 'attempt:attempt-1/chunk:0', 'attempt:attempt-1/chunk:2'])
  expect(model.getSnapshot().filter(row => row.depth === 1).every(row => row.disclosure === 'closed')).toBe(true)
  expect(model.row('attempt:attempt-1/chunk:0').getSnapshot()?.collapsedSummary).toBe('blockType: reasoning · firstsecond')
})

it('restores closed historical blocks collapsed and leaves an unfinished block open', () => {
  const source = new MutableSessionEventSource()
  source.replace([{ type: 'event', event: { type: 'assistant/attempt', seq: SessionSeq(1), time: 5,
    data: { turn: 1, step: 1, stream: [
      { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', index: 0, time0: 2, dt: [], texts: ['closed'] },
      { type: 'chunk', time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'closed' } } },
      { type: 'chunk', time: 4, chunk: { type: 'block-start', index: 1, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', index: 1, time0: 5, dt: [], texts: ['unfinished'] },
    ] } } }], false)
  const model = new SessionLogModel(source)
  const hierarchy = new InspectorTableHierarchy(model.getSnapshot(), new Map())
  expect(hierarchy.rows.map(row => row.key)).toEqual(['event:1', 'event:1/chunk:0', 'event:1/chunk:3', 'event:1/chunk:4'])
  expect(hierarchy.stickyIndexes(3)).toEqual([0, 2])
  expect(model.row('event:1/chunk:3').getSnapshot()?.collapsedSummary).toBe('blockType: reasoning · unfinished')
})

it('groups live deltas even when another log entry arrives between them', () => {
  const source = new MutableSessionEventSource()
  source.replace([durable(1)], true)
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  source.append(delta(2, 'one'))
  source.append(durable(3))
  source.append(delta(4, 'two'))
  expect(model.getSnapshot().map(row => row.key)).toEqual([
    'event:1', 'attempt:attempt-1', 'attempt:attempt-1/chunk:0', 'attempt:attempt-1/chunk:1', 'event:3',
  ])
  expect(model.row('attempt:attempt-1/chunk:1').getSnapshot()?.value).toMatchObject({ text: 'two' })
  const retained = model.row('event:1')
  const value = retained.getSnapshot()
  source.prepend([durable(0)], false)
  expect(model.getSnapshot()[0]?.key).toBe('event:0')
  expect(model.row('event:1')).toBe(retained)
  expect(retained.getSnapshot()).toBe(value)
})

it('replaces transient rows with lossless text, reasoning, and tool-call stream children', () => {
  const source = new MutableSessionEventSource()
  source.replace([delta(1, 'live')], false)
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  const transient = model.row('attempt:attempt-1/chunk:0')
  source.settleAssistant(attemptId, { type: 'event', event: {
    type: 'assistant/attempt', seq: SessionSeq(2), time: 50, data: { turn: 1, step: 1, stream: [
      { type: 'text-chunks', index: 0, time0: 10, dt: [2], texts: ['a', 'b'] },
      { type: 'reasoning-chunks', index: 1, time0: 20, dt: [], texts: ['thinking'] },
      { type: 'tool-call-chunks', index: 2, id: 'call-1' as ToolCallId, time0: 30, dt: [3], args: ['{"x":', '1}'] },
    ] },
  } })
  const rows = model.getSnapshot()
  expect(rows).toHaveLength(6)
  expect(rows.slice(1).every(row => row.depth === 1 && row.parent === 'attempt:attempt-1')).toBe(true)
  expect(rows.slice(1).map(row => model.row(row.key).getSnapshot()?.time)).toEqual([10, 12, 20, 30, 33])
  expect(model.row('attempt:attempt-1/chunk:3').getSnapshot()?.value).toMatchObject({ type: 'tool-call-delta', argumentsDelta: '{"x":' })
  expect(model.row('attempt:attempt-1').getSnapshot()).toMatchObject({ type: 'assistant/attempt', identity: '2' })
  expect(model.row('attempt:attempt-1/chunk:0')).toBe(transient)
  expect(model.chatAnchor('attempt:attempt-1/chunk:0')).toMatchObject({ event: { type: 'assistant/attempt', seq: 2 },
    chunk: { type: 'text-delta', text: 'a' } })
  const child = transient.getSnapshot()
  source.prepend([durable(0)], false)
  expect(model.row('attempt:attempt-1/chunk:0').getSnapshot()).toBe(child)
})

it('stops observing hidden tables and catches up when they reopen', () => {
  const source = new MutableSessionEventSource()
  const model = new SessionLogModel(source)
  const changed = vi.fn()
  const stop = model.subscribe(changed)
  stop()
  source.append(durable(1))
  expect(changed).not.toHaveBeenCalled()
  expect(model.getSnapshot()).toEqual([])
  onTestFinished(model.subscribe(changed))
  expect(model.getSnapshot().map(row => row.key)).toEqual(['event:1'])
})

it('releases settled identities outside the loaded window while retaining loaded rows across rebuilds', () => {
  const source = new MutableSessionEventSource()
  source.replace([delta(1, 'first')], false)
  const model = new SessionLogModel(source)
  onTestFinished(model.subscribe(vi.fn()))
  const first = { type: 'event', event: { type: 'assistant/attempt', seq: SessionSeq(2), time: 2,
    data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', index: 0, time0: 1, dt: [], texts: ['first'] }] } },
  } satisfies SessionEventLikeEntry
  source.settleAssistant(attemptId, first)
  const removed = model.row('attempt:attempt-1')
  const secondAttempt = 'attempt-2' as LlmAttemptId
  source.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: 3, time: 3,
    data: { attemptId: secondAttempt, turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'second' } } } })
  const second = { type: 'event', event: { type: 'assistant/attempt', seq: SessionSeq(4), time: 4,
    data: { turn: 1, step: 2, stream: [{ type: 'text-chunks', index: 0, time0: 3, dt: [], texts: ['second'] }] } },
  } satisfies SessionEventLikeEntry
  source.settleAssistant(secondAttempt, second)
  const retained = model.row('attempt:attempt-2')

  source.replace([second], true)
  expect(removed.getSnapshot()).toBeUndefined()
  expect(model.row('attempt:attempt-2')).toBe(retained)
  expect(model.pick({ anchorSeq: 4 })).toBe('attempt:attempt-2')
  source.prepend([first], false)
  expect(model.pick({ anchorSeq: 2 })).toBe('event:2')
  expect(model.getSnapshot().some(row => row.key === 'attempt:attempt-1')).toBe(false)
  expect(model.row('attempt:attempt-2')).toBe(retained)

  source.replace([], false)
  source.replace([second], false)
  expect(model.pick({ anchorSeq: 4 })).toBe('event:4')
})

it('shares observation and accepts a settlement whose live frames were never loaded', () => {
  const source = new MutableSessionEventSource()
  const model = new SessionLogModel(source)
  const stops = [model.subscribe(vi.fn()), model.subscribe(vi.fn())]
  onTestFinished(() => { for (const stop of stops.splice(0)) stop() })
  stops.pop()!()
  source.settleAssistant(attemptId, { type: 'event', event: { type: 'assistant/attempt', seq: SessionSeq(1), time: 1,
    data: { turn: 1, step: 1, stream: [] } } })
  expect(model.getSnapshot().map(row => row.key)).toEqual(['event:1'])
  expect(model.pick({ anchorSeq: 1, groupPart: 'reasoning' })).toBe('event:1')
  expect(model.chatAnchor('event:1/chunk:0')).toBeUndefined()
})
