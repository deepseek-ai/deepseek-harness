/** Folded reasoning summaries are bounded and independent of interleaved blocks. */

import { expect, it } from 'vitest'
import { AssistantLogStream } from '../src/client/views/session-log/stream.ts'
import { INSPECTOR_PREVIEW_LIMIT } from '../src/client/views/format.ts'

it('joins only matching reasoning deltas, including before manual folding of an unfinished block', () => {
  const stream = new AssistantLogStream('assistant')
  expect(stream.append({ type: 'block-start', index: 0, blockType: 'reasoning' }).collapsed)
    .toEqual({ key: 'assistant/chunk:0', summary: 'blockType: reasoning' })
  stream.append({ type: 'reasoning-delta', index: 0, text: 'first ' })
  stream.append({ type: 'block-start', index: 1, blockType: 'reasoning' })
  expect(stream.append({ type: 'reasoning-delta', index: 1, text: 'other' }).collapsed)
    .toEqual({ key: 'assistant/chunk:2', summary: 'blockType: reasoning · other' })
  expect(stream.append({ type: 'reasoning-delta', index: 0, text: 'second' }).collapsed)
    .toEqual({ key: 'assistant/chunk:0', summary: 'blockType: reasoning · first second' })
  expect(stream.append({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first second' } }).collapsed?.summary)
    .toBe('blockType: reasoning · first second')
  expect(stream.append({ type: 'reasoning-delta', index: 9, text: 'no start' }).collapsed).toBeUndefined()
})

it('keeps the normal preview bound while retaining original chunk counts', () => {
  const stream = new AssistantLogStream('assistant')
  stream.append({ type: 'block-start', index: 3, blockType: 'reasoning' })
  const summary = stream.append({ type: 'reasoning-delta', index: 3, text: 'x'.repeat(500) }).collapsed!.summary
  expect(summary.length).toBe(INSPECTOR_PREVIEW_LIMIT)
  expect(summary.startsWith('blockType: reasoning · ')).toBe(true)
  expect(stream.append({ type: 'reasoning-delta', index: 3, text: 'tail' }).collapsed?.summary).toBe(summary)
  expect(stream.length).toBe(3)
})

it('keeps a finish chunk outside indexed content blocks', () => {
  const stream = new AssistantLogStream('assistant')
  expect(stream.append({ type: 'finish', reason: { kind: 'stop' } })).toEqual({
    key: 'assistant/chunk:0', index: 0, position: 0, row: { key: 'assistant/chunk:0', parent: 'assistant', depth: 1 },
  })
})
