/** Windowed lookup of one assistant message in a stored Session log. */
import type { MessageId } from '@deepseek-ai/dsh-llm/types'
import { expect, it } from 'vitest'
import { findReply, replyAt } from '../src/message.ts'
import { logHandle, prompt, reply } from './log-double.ts'

const never = new AbortController().signal
const id = (value: string): MessageId => value as MessageId

function log(length: number, replies: Record<number, object>): object[] {
  return Array.from({ length }, (_unused, seq) => replies[seq] ?? prompt(seq))
}

it('searches from the newest window backward when the log length is known and joins the text blocks', async () => {
  const { handle, reads } = logHandle(log(600, { 10: reply(10, 'early', '第一段。', '第二段。'), 590: reply(590, 'late', '最新。') }))
  expect(await findReply(handle as never, id('late'), 600, never)).toEqual({ seq: 590, markdown: '最新。' })
  expect(reads).toEqual([{ offset: 344, length: 256 }])
  reads.length = 0
  expect(await findReply(handle as never, id('early'), 600, never)).toEqual({ seq: 10, markdown: '第一段。第二段。' })
  expect(reads).toEqual([{ offset: 344, length: 256 }, { offset: 88, length: 256 }, { offset: 0, length: 88 }])
  expect(await findReply(handle as never, id('absent'), 600, never)).toBeUndefined()
  expect(await findReply(handle as never, id('early'), 0, never)).toBeUndefined()
})

it('searches forward until a short window when the log length is unknown', async () => {
  const { handle, reads } = logHandle(log(300, { 280: reply(280, 'second-window', '找到了。') }))
  expect(await findReply(handle as never, id('second-window'), undefined, never)).toEqual({ seq: 280, markdown: '找到了。' })
  expect(reads).toEqual([{ offset: 0, length: 256 }, { offset: 256, length: 256 }])
  expect(await findReply(handle as never, id('absent'), undefined, never)).toBeUndefined()
  const exact = logHandle(log(256, {}))
  expect(await findReply(exact.handle as never, id('absent'), undefined, never)).toBeUndefined()
  expect(exact.reads).toEqual([{ offset: 0, length: 256 }, { offset: 256, length: 256 }])
})

it('matches only an assistant message with the requested identity', async () => {
  const { handle } = logHandle([prompt(0, 'shared'), reply(1, 'shared', '回答。'), reply(2, 'other', '别的。')])
  expect(await findReply(handle as never, id('shared'), 3, never)).toEqual({ seq: 1, markdown: '回答。' })
  expect(await replyAt(handle as never, id('shared'), 1, never)).toEqual({ seq: 1, markdown: '回答。' })
  expect(await replyAt(handle as never, id('shared'), 0, never)).toBeUndefined()
  expect(await replyAt(handle as never, id('shared'), 2, never)).toBeUndefined()
  expect(await replyAt(handle as never, id('shared'), 9, never)).toBeUndefined()
})

it('stops reading when the caller cancels', async () => {
  const { handle } = logHandle(log(10, {}))
  const cancelled = new AbortController()
  cancelled.abort(new Error('listener left'))
  await expect(findReply(handle as never, id('x'), 10, cancelled.signal)).rejects.toThrow('listener left')
})
