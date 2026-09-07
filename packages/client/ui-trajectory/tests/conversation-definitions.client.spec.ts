import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {
  SessionEventLikeEntry, SessionLiveEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler, inspectRequestPrompt } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { registerTrajectoryAssistantDefinition } from '../src/client/trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from '../src/client/trajectory-compaction-definition.ts'
import type { TrajectorySnapshot } from '../src/client/trajectory-contract.ts'
import { registerTrajectoryMessageDefinitions } from '../src/client/trajectory-message-definitions.ts'
import { registerTrajectoryRequestHeaderDefinition } from '../src/client/trajectory-request-header-definition.ts'
import { trajectoryViewDefinition } from '../src/client/trajectory-snapshot-builder.ts'
import { registerTrajectoryToolDefinition } from '../src/client/trajectory-tool-definition.ts'

const DEFINITIONS: ConversationNodeDefinition[] = []
const registrationContext = {
  uiConversation: {
    events: {
      register: (definition: ConversationNodeDefinition) => {
        DEFINITIONS.push(definition)
        return () => {}
      },
    },
    inspectRequestPrompt,
  },
} as unknown as Context

registerTrajectoryMessageDefinitions(registrationContext)
registerTrajectoryRequestHeaderDefinition(registrationContext)
registerTrajectoryAssistantDefinition(registrationContext)
registerTrajectoryToolDefinition(registrationContext)
registerTrajectoryCompactionDefinitions(registrationContext)

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [trajectoryViewDefinition]
  }
}

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): SessionLiveEventEntry {
  const payload = type === 'assistant/message' && typeof data === 'object' && data !== null
    ? { ...(data as Record<string, unknown>), stream: (data as { stream?: unknown }).stream ?? [] }
    : data
  return {
    type: 'event',
    event: {
      seq,
      time: 1_700_000_000_000 + seq,
      type,
      data: payload,
      ...extra,
    } as unknown as SessionEvent,
  }
}

function packedInputs(entries: readonly SessionLiveEventEntry[]): SessionEventLikeEntry[] {
  const output: SessionEventLikeEntry[] = []
  let active: {
    readonly turn: number
    readonly step: number
    readonly stream: AssistantStreamAccumulator
    last: SessionLiveEventEntry
  } | undefined
  const flush = (): void => {
    if (active === undefined) return
    output.push(at(active.last.event.seq, 'assistant/attempt', {
      turn: active.turn,
      step: active.step,
      stream: active.stream.snapshot(),
    }, { time: active.last.event.time }))
    active = undefined
  }
  for (const entry of entries) {
    const event = entry.event as unknown as {
      readonly type: string
      readonly time: number
      readonly data: { readonly turn?: number; readonly step?: number; readonly chunk?: StreamChunk }
    }
    if (event.type === 'assistant/live-chunk'
      && event.data.turn !== undefined
      && event.data.step !== undefined
      && event.data.chunk !== undefined) {
      if (active !== undefined && (active.turn !== event.data.turn || active.step !== event.data.step)) flush()
      const current = active ?? {
        turn: event.data.turn,
        step: event.data.step,
        stream: new AssistantStreamAccumulator(),
        last: entry,
      }
      active = current
      current.stream.push({ time: event.time, chunk: event.data.chunk })
      current.last = entry
      continue
    }
    const current = active
    if (event.type === 'assistant/message'
      && current !== undefined
      && current.turn === event.data.turn
      && current.step === event.data.step) {
      output.push({
        ...entry,
        event: {
          ...entry.event,
          data: { ...entry.event.data, stream: current.stream.snapshot() },
        } as SessionEvent,
      })
      active = undefined
      continue
    }
    flush()
    output.push(entry)
  }
  flush()
  return output
}

function assembler(events: readonly SessionEventLikeEntry[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(
    new TestEventDefinitions(),
    new TestViewDefinitions(),
  )
  value.replaceWindow(events, false)
  value.activateTarget('trajectory')
  return value
}

function snapshot(value: ConversationNodeAssembler): TrajectorySnapshot {
  const current = value.get('trajectory')
  if (current === undefined) throw new Error('trajectory view was not registered')
  return current
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'test', model: 'test' },
  }
}

describe('Trajectory conversation Definitions', () => {
  it('assembles streaming usage, preserves retry facts, and materializes interruption', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/live-chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
      }),
      at(4, 'assistant/live-chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      }),
    ])

    expect(snapshot(value).partial?.blocks).toEqual([{ kind: 'text', text: 'first attempt' }])
    expect(snapshot(value).requests).toMatchObject([{
      purpose: 'assistant',
      status: 'running',
      usage: { inputTokens: 10, outputTokens: 3 },
    }])

    value.append(at(5, 'llm/retry', {
      retryId: 'retry-1',
      turn: 1,
      step: 1,
      provider: 'test',
      mode: 'normal',
      policyKey: 'test-normal',
      retry: 1,
      maxRetries: 2,
      delayMs: 25,
      failure: { code: 'TRANSPORT', message: 'temporary failure' },
    }))
    value.append(at(6, 'assistant/live-chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'second attempt' },
    }))
    value.append(at(7, 'step/end', { turn: 1, step: 1 }))
    value.flush()

    const settled = snapshot(value)
    expect(settled.partial).toBeNull()
    expect(settled.eventNodes).toMatchObject([{
      kind: 'assistant',
      seq: 6.1,
      interrupted: true,
      blocks: [{ kind: 'text', text: 'second attempt' }],
    }])
    expect(settled.requests).toMatchObject([{
      purpose: 'assistant',
      status: 'error',
      error: 'temporary failure',
      errorCode: 'TRANSPORT',
      retry: 1,
      maxRetries: 2,
      retryDelayMs: 25,
      usage: { inputTokens: 10, outputTokens: 3 },
    }])
  })

  it('uses live Assistant deltas without replaying settled embedded streams', () => {
    const runningHistory = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' },
      }),
      at(4, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '  ' },
      }),
      at(5, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' },
      }),
      at(6, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: '' },
      }),
      at(7, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'think' },
      }),
      at(8, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'ing' },
      }),
      at(9, 'assistant/live-chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '' },
      }),
      at(10, 'assistant/live-chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '{"x":' },
      }),
      at(11, 'assistant/live-chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '1}' },
      }),
    ]
    const runningScalar = snapshot(assembler(runningHistory))
    const packedHistory = packedInputs(runningHistory)
    expect(packedHistory).toHaveLength(3)
    const runningAttempt = packedHistory.at(-1)?.event
    expect(runningAttempt?.type).toBe('assistant/attempt')
    if (runningAttempt?.type !== 'assistant/attempt') throw new Error('expected packed running attempt')
    expect(runningAttempt.data.stream.length).toBeGreaterThan(0)
    const runningPacked = snapshot(assembler(packedHistory))
    expect(runningScalar.partial?.blocks).toEqual([
      { kind: 'text', text: '  answer' },
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'tool-call', callId: 'call-1', name: '', argsRaw: '{"x":1}' },
    ])
    expect(runningPacked.partial).toBeNull()

    const partialHistory = [
      ...runningHistory.slice(2),
      at(12, 'step/end', { turn: 1, step: 1 }),
    ]
    const partialPacked = snapshot(assembler(packedInputs(partialHistory)))
    expect(partialPacked.partial).toBeNull()
    expect(partialPacked.eventNodes).toEqual([])

    const finalizedHistory = [
      at(20, 'turn/start', { turn: 2 }),
      at(21, 'step/start', { turn: 2, step: 1 }),
      at(22, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '' },
      }, { time: 3_000 }),
      at(23, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: ' ' },
      }, { time: 3_000 }),
      at(24, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'first' },
      }, { time: 2_998 }),
      at(25, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      }),
      at(26, 'llm/retry', {
        retryId: 'packed-retry', turn: 2, step: 1, provider: 'test', mode: 'normal',
        policyKey: 'test-normal', retry: 1, maxRetries: 2, delayMs: 25,
        failure: { code: 'TRANSPORT', message: 'temporary failure' },
      }),
      at(27, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '' },
      }),
      at(28, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'second' },
      }),
      at(29, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: ' attempt' },
      }),
      at(30, 'assistant/message', {
        turn: 2, step: 1, message: assistantMessage('packed-final', 'done'),
      }),
      at(31, 'step/end', { turn: 2, step: 1 }),
    ]
    const finalizedInputs = packedInputs(finalizedHistory)
    expect(finalizedInputs.filter(input => input.event.type === 'assistant/attempt')).toHaveLength(1)
    const finalizedMessage = finalizedInputs.find(input => input.event.type === 'assistant/message')?.event
    if (finalizedMessage?.type !== 'assistant/message') throw new Error('expected packed final message')
    expect(finalizedMessage.data.stream.length).toBeGreaterThan(0)
    const finalizedPacked = snapshot(assembler(finalizedInputs))
    expect(finalizedPacked.eventNodes.find(node => node.kind === 'assistant')).toMatchObject({
      blocks: [{ kind: 'text', text: 'done' }],
      timing: { firstTokenTime: null },
    })
    expect(finalizedPacked.requests).toMatchObject([{
      purpose: 'assistant',
      retry: 1,
    }])

    const namedToolHistory = [
      at(40, 'turn/start', { turn: 3 }),
      at(41, 'step/start', { turn: 3, step: 1 }),
      ...[42, 43, 44].map(seq => at(seq, 'assistant/live-chunk', {
        turn: 3, step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-2', name: 'read', argumentsDelta: '' },
      }, { time: 4_000 + seq - 42 })),
      at(45, 'assistant/message', {
        turn: 3,
        step: 1,
        message: {
          ...assistantMessage('named-tool-final', ''),
          content: [{ type: 'tool-call', id: 'call-2', name: 'read', arguments: '' }],
        },
      }),
    ]
    const namedToolInputs = packedInputs(namedToolHistory)
    const namedToolMessage = namedToolInputs.find(input => input.event.type === 'assistant/message')?.event
    if (namedToolMessage?.type !== 'assistant/message') throw new Error('expected packed named-tool message')
    expect(namedToolMessage.data.stream.length).toBeGreaterThan(0)
    const namedToolPacked = snapshot(assembler(namedToolInputs))
    expect(namedToolPacked.eventNodes.find(node => node.kind === 'assistant')).toMatchObject({
      blocks: [{ kind: 'tool-call', callId: 'call-2', name: 'read', argsRaw: '' }],
      timing: { firstTokenTime: null },
    })
  })

  it('classifies a cancellation-finalized prefix as an interrupted request result', () => {
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('interrupted-message', 'cut short'),
        interrupted: true,
      }),
      at(4, 'step/end', { turn: 1, step: 1 }),
      at(5, 'turn/end', {
        turn: 1,
        reason: { kind: 'aborted', reason: { kind: 'user' } },
      }),
    ]))

    expect(current.eventNodes).toMatchObject([{
      kind: 'assistant',
      seq: 3,
      messageId: 'interrupted-message',
      interrupted: true,
      blocks: [{ kind: 'text', text: 'cut short' }],
    }])
    expect(current.requests).toMatchObject([{
      purpose: 'assistant',
      resultSeq: 3,
      status: 'error',
      provenance: { provider: 'test', model: 'test' },
    }])
  })

  it('keeps parallel roots, raw Tool facts, and nested Code Dispatch results', () => {
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', {
        turn: 1, step: 1, callId: 'root-a', name: 'code', arguments: '{}',
      }),
      at(4, 'tool/call', {
        turn: 1, step: 1, callId: 'root-b', name: 'parallel', arguments: '{}',
      }),
      at(5, 'tool/code-dispatch-start', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      at(6, 'tool/code-dispatch', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
        content: [{ type: 'text', text: 'contents' }],
      }),
      at(7, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'result-root-a',
          role: 'user',
          source: { kind: 'tool', callId: 'root-a' },
          content: [{
            type: 'tool-result',
            toolCallId: 'root-a',
            content: [{ type: 'text', text: 'root failed' }],
            isError: true,
          }],
        },
        error: { name: 'ToolError', code: 'failed' },
        meta: { presentation: 'raw' },
      }, { surfaceOp: 'append' }),
      at(8, 'step/end', { turn: 1, step: 1 }),
    ]))

    const tools = current.eventNodes.filter(node => node.kind === 'tool-result')
    expect(tools.map(node => node.callId).sort()).toEqual(['root-a', 'root-b'])
    expect(tools.find(node => node.callId === 'root-a')).toMatchObject({
      kind: 'tool-result',
      callId: 'root-a',
      call: { name: 'code', argsRaw: '{}' },
      content: [{ type: 'text', text: 'root failed' }],
      isError: true,
      error: { name: 'ToolError', code: 'failed' },
      meta: { presentation: 'raw' },
      subCalls: [{
        kind: 'tool-result', callId: 'child', parentCallId: 'root-a', call: { name: 'read' },
      }],
    })
    expect(tools.find(node => node.callId === 'root-b')).toMatchObject({
      isError: true,
      error: { name: 'Interrupted', code: 'interrupted' },
    })
  })

  it('assembles compaction lifecycle, checkpoint replacement, and orphan interruption', () => {
    const current = snapshot(assembler([
      at(1, 'compaction/start', { compactionId: 'complete', turn: null }),
      at(2, 'compaction/summary', {
        compactionId: 'complete',
        turn: null,
        summary: 'summary',
        provider: 'test',
        model: 'test',
        maxTokens: 100,
        usage: { inputTokens: 20, outputTokens: 5 },
      }),
      at(3, 'user/message', {
        id: 'checkpoint',
        role: 'user',
        content: [{ type: 'text', text: 'summary checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'complete' },
      }),
      at(4, 'compaction/end', { compactionId: 'complete', turn: null }),
      at(5, 'compaction/start', { compactionId: 'orphan', turn: null }),
      at(6, 'session/end-seed', {}),
    ]))

    expect(current.requests).toMatchObject([
      {
        purpose: 'compaction',
        startSeq: 1,
        status: 'complete',
        resultSeq: 2,
        replacementSeq: 3,
        summary: 'summary',
      },
      {
        purpose: 'compaction',
        startSeq: 5,
        status: 'error',
        completedAt: 1_700_000_000_006,
      },
    ])
  })

  it('classifies claimed inbox input as steering and consumes one inherited prompt change', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'test', model: 'test' },
          system: 'system prompt',
          tools: [],
        },
      }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-1', 'first'),
      }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'm1' }],
      }),
      at(7, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(8, 'step/start', { turn: 1, step: 2 }),
    ])
    value.append(at(9, 'user/message', {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'steer here' }],
      source: { kind: 'user' },
    }))
    value.flush()

    const steering = snapshot(value)
    expect(steering.eventNodes.find(node => node.seq === 9)?.kind).toBe('steering')
    expect(steering.eventLocations.get(9)).toMatchObject({
      kind: 'step',
      turn: { turn: 1 },
      step: { step: 2 },
    })

    value.append(at(10, 'assistant/message', {
      turn: 1,
      step: 2,
      message: assistantMessage('assistant-2', 'second'),
    }))
    value.flush()
    const current = snapshot(value)

    expect(current.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['system prompt', 'system prompt'])
    expect(current.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.kind
      : undefined)).toEqual(['initial', undefined])
  })

  it('replays pending splice chains and scopes steering to the current claim', () => {
    const message = (id: string, text: string) => ({
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const first = message('claim-first', 'first')
    const second = message('claim-second', 'second')
    const canceled = message('claim-canceled', 'canceled')
    const requeued = message('claim-requeued', 'requeued')
    const later = message('claim-later', 'later')
    const current = snapshot(assembler([
      at(1, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [first],
      }),
      at(2, 'agent/inbox/spliced', {
        target: 'next-step', start: 1, inserted: [canceled],
      }),
      at(3, 'agent/inbox/spliced', {
        target: 'next-step', start: 1, inserted: [second],
      }),
      at(4, 'agent/inbox/spliced', {
        target: 'next-step', start: 2, removedCount: 1, inserted: [], outcome: 'canceled',
      }),
      at(5, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 2, inserted: [],
      }),
      at(6, 'user/message', first),
      at(7, 'user/message', second),
      at(8, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [requeued],
      }),
      at(9, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(10, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [requeued],
      }),
      at(11, 'user/message', requeued),
      at(12, 'user/message', canceled),
      at(13, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      }),
      at(14, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [later],
      }),
      at(15, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(16, 'user/message', later),
    ]))

    expect(current.eventNodes.filter(node =>
      node.kind === 'user' || node.kind === 'steering').map(node => ({
      kind: node.kind,
      seq: node.seq,
    }))).toEqual([
      { kind: 'steering', seq: 6 },
      { kind: 'steering', seq: 7 },
      { kind: 'user', seq: 11 },
      { kind: 'user', seq: 12 },
      { kind: 'steering', seq: 16 },
    ])
  })
})
