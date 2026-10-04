/** Log inspection submits original coordinates without reading Chat nodes. */

import { expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { sessionLogChatTarget } from '../src/client/views/session-log/chat-target.ts'

it('keeps a user message’s original sequence without inventing Turn or Step coordinates', () => {
  const event: SessionEvent<'user/message'> = { type: 'user/message', surfaceOp: 'append', seq: SessionSeq(10), time: 0,
    data: { id: 'input-1' as MessageId, role: 'user', content: [{ type: 'text', text: 'earlier input' }], source: { kind: 'user' } } }
  expect(sessionLogChatTarget({ event })).toEqual({ anchorSeq: 10 })
})

it('preserves tool identity for both calls and results', () => {
  const callId = 'call-1' as ToolCallId
  const call: SessionEvent<'tool/call'> = { type: 'tool/call', seq: SessionSeq(3), time: 0,
    data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' } }
  const result: SessionEvent<'tool/result'> = { type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(10), time: 1,
    data: { turn: 1, step: 1, message: { id: 'result' as MessageId, role: 'tool', toolCallId: callId,
      source: { kind: 'tool', callId }, content: [] } } }
  expect(sessionLogChatTarget({ event: call })).toEqual({ anchorSeq: 3, callId, turn: 1, step: 1 })
  expect(sessionLogChatTarget({ event: result })).toEqual({ anchorSeq: 10, callId, turn: 1, step: 1 })
})

it('describes Assistant children by their owning event and reasoning or response part', () => {
  const event: SessionEvent<'assistant/attempt'> = { type: 'assistant/attempt', seq: SessionSeq(15), time: 0,
    data: { turn: 1, step: 1, stream: [] } }
  expect(sessionLogChatTarget({ event, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } }))
    .toEqual({ anchorSeq: 15, nodeKind: 'assistant-step', turn: 1, step: 1, groupPart: 'reasoning' })
  expect(sessionLogChatTarget({ event, chunk: { type: 'block-start', index: 0, blockType: 'text' } }).groupPart).toBe('response')
  expect(sessionLogChatTarget({ event, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'done' } } }).groupPart).toBe('reasoning')
  expect(sessionLogChatTarget({ event, chunk: { type: 'text-delta', index: 0, text: 'answer' } }).groupPart).toBe('response')
  const id = 'stream-call' as ToolCallId
  expect(sessionLogChatTarget({ event, chunk: { type: 'tool-call-delta', index: 1, id, argumentsDelta: '{}' } }).callId).toBe(id)
  expect(sessionLogChatTarget({ event, chunk: { type: 'block-end', index: 1,
    block: { type: 'tool-call', id, name: 'bash', arguments: '{}' } } }).callId).toBe(id)
})

it('preserves a nested dispatch identity and its root tool call', () => {
  const root = 'root' as ToolCallId
  const child = 'child' as ToolCallId
  const event: SessionEvent<'tool/ptc-dispatch-start'> = {
    type: 'tool/ptc-dispatch-start', seq: SessionSeq(20), time: 0,
    data: { rootCallId: root, parentCallId: root, subCallId: child, name: 'bash', arguments: {} },
  }
  expect(sessionLogChatTarget({ event })).toEqual({ anchorSeq: 20, callId: child, rootCallId: root })
})
