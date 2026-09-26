import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionAssistantSettlementEntry, SessionEventLikeEntry, SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { processGroupDefinition } from '../src/client/conversation-nodes/process-groups.ts'

const attemptId = LlmAttemptId('preparing-test')
const first = ToolCallId('write-one')
const second = ToolCallId('write-two')
const args = '{"file_path":"hello.txt","content":"hello"}'

function entry(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

const opening = [
  entry({ type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } }),
  entry({ type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } }),
]

function delta(seq: number, id = first, argumentsDelta = '', name: string | null = 'write', index = id === first ? 0 : 1): SessionEventLikeEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk', seq, time: seq,
      data: { turn: 1, step: 1, attemptId, chunk: {
        type: 'tool-call-delta', index, id, argumentsDelta,
        ...(name === null ? {} : { name }),
      } },
    },
  }
}

function call(seq: number, callId = first, name = 'write', argumentsRaw = args): SessionLiveEventEntry {
  return entry({ type: 'tool/call', seq: SessionSeq(seq), time: seq,
    data: { turn: 1, step: 1, callId, name, arguments: argumentsRaw } })
}

function result(seq: number, callId = first): SessionLiveEventEntry {
  return entry({ type: 'tool/result', seq: SessionSeq(seq), time: seq, surfaceOp: 'append', data: {
    turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Written' }], isError: false }),
  } })
}

function settlement(ids = [first, second], name = 'write', argumentsRaw = args, text = ''): SessionAssistantSettlementEntry {
  const stream = new AssistantStreamAccumulator()
  if (text !== '') stream.push({ time: 3, chunk: { type: 'text-delta', index: 0, text } })
  for (const [index, id] of ids.entries()) {
    const chunk: StreamChunk = { type: 'tool-call-delta', index: index + Number(text !== ''), id, name, argumentsDelta: argumentsRaw }
    stream.push({ time: 3, chunk })
  }
  return { type: 'event', event: {
    type: 'assistant/message', seq: SessionSeq(5), time: 5, surfaceOp: 'append', data: {
      turn: 1, step: 1, stream: [...stream.snapshot()],
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [
        ...text === '' ? [] : [{ type: 'text' as const, text }],
        ...ids.map(id => ({ type: 'tool-call' as const, id, name, arguments: argumentsRaw })),
      ] }),
    },
  } }
}

function harness(entries: readonly SessionEventLikeEntry[] = opening, hasMore = false, tool = toolDefinition) {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition, tool], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
    { entries: () => [processGroupDefinition], forTarget: target => target === 'chat' ? processGroupDefinition : undefined },
  )
  assembler.replaceWindow(entries, hasMore)
  assembler.activateTarget('chat')
  const tools = () => {
    assembler.flush()
    const snapshot = assembler.snapshot('chat') as ChatSnapshot
    return snapshot.nodes.values().filter((node): node is ChatNode<'tool-call'> => node.kind === 'tool-call' && node.visibility === 'visible')
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
  }
  const phases = () => tools().map(node => [node.id, 'kind' in node.data.root ? 'result' : node.data.root.phase])
  const material = () => tools().map(({ key, anchorSeq, data }) => ({ key, anchorSeq, data }))
  return { assembler, tools, phases, material }
}

describe('Tool preparation and durable replay', () => {
  it('batches repeated named deltas and retains the unchanged Tool node', () => {
    const start = vi.fn<typeof toolDefinition.start>((...args) => toolDefinition.start(...args))
    const h = harness(opening, false, { ...toolDefinition, start })
    expect(h.assembler.append(delta(2.1, first, '{"file_path":"file.txt","content":"'))).toBe('animation-frame')
    const original = h.tools()[0]!
    for (let index = 0; index < 100; index++) {
      expect(h.assembler.append(delta(2.2 + index / 1000, first, 'x'.repeat(128)))).toBe('animation-frame')
      expect(h.tools()[0]).toBe(original)
    }
    expect(start).toHaveBeenCalledOnce()
    expect(h.assembler.append(call(6))).toBe('immediate')
    expect(h.phases()).toEqual([[first, 'start']])
    expect(h.tools()[0]).not.toBe(original)
    expect(h.assembler.append(result(7))).toBe('immediate')
    expect(h.phases()).toEqual([[first, 'result']])
  })

  it('creates two independent live preparations and updates each call under the same key', () => {
    const h = harness()
    h.assembler.append(delta(2.1, first, '', null))
    expect(h.phases()).toEqual([])
    h.assembler.append(delta(2.2))
    const original = h.tools()[0]!
    expect(h.phases()).toEqual([[first, 'preparing']])
    expect(original.data.root).not.toHaveProperty('argsRaw')
    h.assembler.append(delta(2.3, first, '{"content":"hello', null))
    expect(h.tools()[0]?.data.root).toBe(original.data.root)
    h.assembler.append(delta(2.4, second))
    expect(h.phases()).toEqual([[first, 'preparing'], [second, 'preparing']])
    const groups = h.assembler.grouped('chat')!
    const group = groups.entries.find(entry => entry.kind === 'group')!
    if (group.kind !== 'group') throw new Error('expected a process group')
    expect(groups.groupSource(group.key).getSnapshot()?.data.summary).toMatchObject({
      counts: [{ kind: 'write', count: 2 }], preparing: true, runningDetail: '',
    })
    h.assembler.append(call(6))
    expect(h.tools()[0]?.key).toBe(original.key)
    expect(h.phases()).toEqual([[first, 'start'], [second, 'preparing']])
    expect(h.tools()[0]?.data.root).toMatchObject({ argsRaw: args })
    h.assembler.append(result(7))
    h.assembler.append(call(8, second))
    h.assembler.append(result(9, second))
    expect(h.phases()).toEqual([[first, 'result'], [second, 'result']])
  })

  it('keeps five command preparations below the Assistant message through dispatch and Step end', () => {
    const h = harness()
    const ids = Array.from({ length: 5 }, (_, index) => ToolCallId(`command-${index}`))
    const command = '{"command":"echo hello"}'
    const text = 'Running five commands'
    h.assembler.append({ type: 'transient', event: {
      type: 'assistant/live-chunk', seq: 2.01, time: 3,
      data: { turn: 1, step: 1, attemptId, chunk: { type: 'text-delta', index: 0, text } },
    } })
    for (const [index, id] of ids.entries()) h.assembler.append(delta(2.1 + index / 10, id, command, 'bash', index + 1))
    const keys = h.tools().map(node => node.key)
    const groups = h.assembler.grouped('chat')!
    const group = groups.entries.find(entry => entry.kind === 'group')!
    const order = groups.entries
    expect(order[0]).toMatchObject({ kind: 'node', groupPart: 'response' })
    expect(order[1]).toEqual(group)
    const message = settlement(ids, 'bash', command, text)
    const history = [...opening, message]
    h.assembler.append(message)
    expect(h.phases()).toEqual(ids.map(id => [id, 'preparing']))
    expect(groups.entries).toEqual(order)
    for (const [index, id] of ids.entries()) {
      const started = call(6 + index * 2, id, 'bash', command)
      h.assembler.append(started)
      expect(h.phases()).toEqual(ids.map((callId, at) => [callId, at < index ? 'result' : at === index ? 'start' : 'preparing']))
      expect(groups.entries).toEqual(order)
      const completed = result(7 + index * 2, id)
      h.assembler.append(completed)
      history.push(started, completed)
      expect(h.tools().map(node => node.key)).toEqual(keys)
      expect(groups.entries).toEqual(order)
    }
    const closed = entry({ type: 'step/end', seq: SessionSeq(16), time: 16, data: { turn: 1, step: 1 } })
    history.push(closed)
    h.assembler.append(closed)
    h.assembler.settleAssistant(attemptId)
    const replay = harness(history)
    expect(h.phases()).toEqual(ids.map(id => [id, 'result']))
    expect(h.material()).toEqual(replay.material())
    expect(groups.entries).toEqual(order)
  })

  it('hides undispatched preparations when a settled Step ends before every call starts', () => {
    const h = harness()
    h.assembler.append(delta(2.1))
    h.assembler.append(delta(2.2, second))
    const message = settlement()
    h.assembler.append(message)
    h.assembler.append(call(6))
    h.assembler.append(result(7))
    expect(h.phases()).toEqual([[first, 'result'], [second, 'preparing']])
    const closed = entry({ type: 'step/end', seq: SessionSeq(8), time: 8, data: { turn: 1, step: 1 } })
    h.assembler.append(closed)
    expect(h.phases()).toEqual([[first, 'result']])
    h.assembler.settleAssistant(attemptId)
    expect(h.material()).toEqual(harness([...opening, message, call(6), result(7), closed]).material())
  })

  it('does not create preparing rows from stored Assistant streams in history or older pages', () => {
    const message = settlement()
    const history = [...opening, message, call(6), result(7), call(8, second), result(9, second)]
    const full = harness(history)
    expect(full.phases()).toEqual([[first, 'result'], [second, 'result']])
    const paged = harness([result(9, second)], true)
    expect(paged.phases()).toEqual([[second, 'result']])
    paged.assembler.prepend([call(8, second)], true)
    expect(paged.phases()).toEqual([[second, 'result']])
    paged.assembler.prepend(history.slice(0, 5), false)
    expect(paged.material()).toEqual(full.material())
    paged.assembler.replaceWindow([...opening, message], false)
    expect(paged.phases()).toEqual([])
    paged.assembler.append(call(6))
    expect(paged.phases()).toEqual([[first, 'start']])
  })

  it('retains a dispatched call when its earlier transient start is withdrawn', () => {
    const h = harness()
    h.assembler.append(delta(2.1))
    const key = h.tools()[0]!.key
    h.assembler.append(call(6))
    expect(h.tools()[0]).toMatchObject({ key, anchorSeq: 2.1, data: { root: { phase: 'start', argsRaw: args } } })
    const message = settlement()
    h.assembler.settleAssistant(attemptId, message)
    expect(h.tools()).toHaveLength(1)
    expect(h.tools()[0]).toMatchObject({ key, anchorSeq: 6, data: { root: { phase: 'start', argsRaw: args } } })
    h.assembler.append(result(7))
    expect(h.phases()).toEqual([[first, 'result']])
    const replay = harness([...opening, message, call(6), result(7)])
    expect(h.material()).toEqual(replay.material())
  })

  it('abandons one attempt and lets a subsequent live attempt create its own preparation', () => {
    const h = harness()
    h.assembler.append(delta(2.1))
    expect(h.phases()).toEqual([[first, 'preparing']])
    h.assembler.settleAssistant(attemptId)
    expect(h.phases()).toEqual([])
    h.assembler.append(delta(2.2, second))
    expect(h.phases()).toEqual([[second, 'preparing']])
    h.assembler.replaceWindow([...opening, delta(2.2, second)], false)
    expect(h.phases()).toEqual([[second, 'preparing']])
    h.assembler.settleAssistant(attemptId)
    h.assembler.append(call(8, second))
    expect(h.phases()).toEqual([[second, 'start']])
  })
})
