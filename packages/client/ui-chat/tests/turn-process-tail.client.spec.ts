/** Turn-node Locations and Assistant timing across partial windows and transient retirement. */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  SessionAssistantSettlementEntry, SessionEventLikeEntry, SessionLiveEventEntry, SessionTransientEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'

const attemptId = LlmAttemptId('turn-projection-test')
const callId = ToolCallId('turn-projection-call')
const toolBlock = { type: 'tool-call' as const, id: callId, name: 'write', arguments: '{"content":"hello"}' }

function entry(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

const opening = [
  entry({ type: 'turn/start', seq: SessionSeq(1), time: 1_000, data: { turn: 1 } }),
  entry({ type: 'step/start', seq: SessionSeq(2), time: 2_000, data: { turn: 1, step: 1 } }),
]
const deltas: SessionTransientEventEntry[] = ['', toolBlock.arguments].map((argumentsDelta, index) => ({
  type: 'transient', event: {
    type: 'assistant/live-chunk', seq: 2.1 + index / 10, time: 2_100 + index * 100,
    data: { turn: 1, step: 1, attemptId, chunk: {
      type: 'tool-call-delta', index: 0, id: callId, argumentsDelta,
      ...(index === 0 ? {} : { name: 'write' }),
    } },
  },
}))

function stream() {
  const accumulator = new AssistantStreamAccumulator()
  for (const { event } of deltas) accumulator.push({ time: event.time, chunk: event.data.chunk })
  return [...accumulator.snapshot()]
}

function harness(entries: readonly SessionEventLikeEntry[], hasMore = true) {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition, turnProcessDefinition, turnTailDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  assembler.replaceWindow(entries, hasMore)
  assembler.activateTarget('chat')
  const read = () => {
    assembler.flush()
    return assembler.snapshot('chat') as ChatSnapshot
  }
  return { assembler, read }
}

describe('Turn nodes in partial windows', () => {
  it('retains Step Locations and first-token timing through message settlement, replay, and prepend', () => {
    const value = harness(deltas)
    const committed: SessionAssistantSettlementEntry = { type: 'event', event: {
      type: 'assistant/message', seq: SessionSeq(3), time: 3_000, surfaceOp: 'append', data: {
        turn: 1, step: 1, stream: stream(),
        message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [toolBlock] }),
      },
    } }
    value.assembler.append(committed)
    expect(value.read().timeline.turns.get(1)?.steps[0]?.data.get('assistant-step')?.finalNode?.timing)
      .toMatchObject({ stepStartTime: null, firstTokenTime: 2_200, completedTime: 3_000 })
    const closing = [
      entry({ type: 'tool/call', seq: SessionSeq(4), time: 4_000,
        data: { turn: 1, step: 1, callId, name: 'write', arguments: toolBlock.arguments } }),
      entry({ type: 'tool/result', seq: SessionSeq(5), time: 5_000, surfaceOp: 'append', data: {
        turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Written' }], isError: false }),
      } }),
      entry({ type: 'step/end', seq: SessionSeq(6), time: 6_000, data: { turn: 1, step: 1 } }),
      entry({ type: 'step/start', seq: SessionSeq(7), time: 7_000, data: { turn: 1, step: 2 } }),
      entry({ type: 'assistant/message', seq: SessionSeq(8), time: 8_000, surfaceOp: 'append', data: {
        turn: 1, step: 2, stream: [],
        message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Done' }] }),
      } }),
      entry({ type: 'step/end', seq: SessionSeq(9), time: 9_000, data: { turn: 1, step: 2 } }),
      entry({ type: 'turn/end', seq: SessionSeq(10), time: 10_000, data: { turn: 1, reason: { kind: 'completed' } } }),
    ]
    for (const event of closing) value.assembler.append(event)
    const before = value.read()
    for (const kind of ['turn-process', 'turn-tail']) {
      expect(before.nodes.values().find(node => node.kind === kind)?.location)
        .toMatchObject({ kind: 'step', turn: { turn: 1 }, step: { step: 1 } })
    }
    value.assembler.settleAssistant(attemptId, committed)
    const replay = harness([committed, ...closing]).read()
    const settled = value.read()
    expect(settled.order).toEqual(replay.order)
    for (const kind of ['turn-process', 'turn-tail']) {
      const node = settled.nodes.values().find(node => node.kind === kind)
      expect(node?.location).toMatchObject({ kind: 'step', turn: { turn: 1 }, step: { step: 1 } })
      expect(node?.data).toEqual(replay.nodes.values().find(node => node.kind === kind)?.data)
    }
    expect(settled.timeline.turns.get(1)?.steps[0]?.data.get('assistant-step')?.finalNode?.timing)
      .toMatchObject({ firstTokenTime: null })
    value.assembler.prepend(opening, false)
    const complete = value.read()
    for (const kind of ['turn-process', 'turn-tail']) {
      expect(complete.nodes.values().find(node => node.kind === kind)?.location)
        .toMatchObject({ kind: 'turn', turn: { turn: 1 } })
    }
    expect(complete.timeline.turns.get(1)?.steps[0]?.data.get('assistant-step')?.finalNode?.timing)
      .toEqual({ stepStartTime: 2_000, firstTokenTime: null, completedTime: 3_000 })
  })

  it.each(['attempt', 'uncommitted'] as const)('retains a missing-start footer after %s stream retirement', (kind) => {
    const value = harness(deltas)
    // The Turn end can arrive before the Assistant end frame that retires its live chunks.
    value.assembler.append(entry({ type: 'turn/end', seq: SessionSeq(4), time: 4_000,
      data: { turn: 1, reason: { kind: 'completed' } } }))
    const before = value.read()
    const tail = before.nodes.values().find(node => node.kind === 'turn-tail')!
    expect(tail.location).toMatchObject({ kind: 'step', turn: { turn: 1 }, step: { step: 1 } })
    expect(before.timeline.turns.get(1)?.steps[0]?.data.get('assistant-step'))
      .toMatchObject({ status: 'interrupted', blocks: [{ kind: 'tool-call', callId, name: 'write' }] })
    const committed: SessionAssistantSettlementEntry | undefined = kind === 'attempt' ? { type: 'event', event: {
      type: 'assistant/attempt', seq: SessionSeq(3), time: 3_000, data: { turn: 1, step: 1, stream: stream() },
    } } : undefined
    value.assembler.settleAssistant(attemptId, committed)
    const after = value.read()
    const current = after.nodes.get(tail.key)!
    expect(current.location).toMatchObject(kind === 'attempt'
      ? { kind: 'step', turn: { turn: 1 }, step: { step: 1 } }
      : { kind: 'turn', turn: { turn: 1 } })
    expect(current.data).toMatchObject({ turn: 1, seq: 4, closing: null, branchUnavailable: true })
    expect(after.timeline.turns.get(1)?.steps[0]?.data.get('assistant-step')).toBeUndefined()
    expect(after.nodes.values().find(node => node.kind === 'assistant-step')?.visibility).toBe('hidden')
    expect(after.order).toEqual([tail.key])
  })
})
