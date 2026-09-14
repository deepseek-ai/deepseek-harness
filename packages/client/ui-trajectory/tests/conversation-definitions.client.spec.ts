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
import { inspectSystemPrompt } from '../../ui-conversation/src/client/contract/system-prompt.ts'
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
    inspectSystemPrompt,
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

function assembler(events: readonly SessionEventLikeEntry[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(
    new TestEventDefinitions(),
    new TestViewDefinitions(),
  )
  value.replaceWindow(events, hasMore)
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

function systemMessage(text: string) {
  return {
    id: `system-${text}`,
    role: 'system',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
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
      timing: { firstTokenTime: 3_000 },
    })
    expect(finalizedPacked.requests).toMatchObject([{
      purpose: 'assistant',
      retry: 1,
    }])

    const windowed = assembler(finalizedInputs.slice(2), true)
    const assistant = () => snapshot(windowed).eventNodes.find(node => node.kind === 'assistant')
    expect(assistant()).toMatchObject({ timing: { stepStartTime: null, firstTokenTime: 3_000 } })
    windowed.prepend(finalizedInputs.slice(0, 2), false)
    windowed.flush()
    expect(assistant()).toEqual(finalizedPacked.eventNodes.find(node => node.kind === 'assistant'))

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
      timing: { firstTokenTime: 4_000 },
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
      providerMetadata: { provider: 'test', model: 'test' },
    }])
  })

  it('keeps parallel roots, raw Tool facts, and mixed-ID PTC dispatch results', () => {
    const error = {
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
      reason: ' raw\r\nreason ',
    }
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', {
        turn: 1, step: 1, callId: 'root-a', name: 'code', arguments: '{}',
      }),
      at(4, 'tool/call', {
        turn: 1, step: 1, callId: 'root-b', name: 'parallel', arguments: '{}',
      }),
      at(5, 'tool/ptc-dispatch-start', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'root-b:code:1',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      at(6, 'tool/ptc-dispatch', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'root-b:code:1',
        name: 'read',
        arguments: { path: 'README.md' },
        content: [{ type: 'text', text: 'contents' }],
      }),
      at(7, 'tool/ptc-dispatch-start', {
        rootCallId: 'root-a', parentCallId: 'root-b:code:1', subCallId: 'root-b:ptc:2',
        name: 'read', arguments: { file_path: 'nested.txt' },
      }),
      at(8, 'tool/ptc-dispatch', {
        rootCallId: 'root-a', parentCallId: 'root-b:code:1', subCallId: 'root-b:ptc:2',
        name: 'read', arguments: { file_path: 'nested.txt' },
        isError: true, error, content: [{ type: 'text', text: 'not executed' }],
      }),
      at(9, 'tool/result', {
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
      at(10, 'step/end', { turn: 1, step: 1 }),
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
        kind: 'tool-result', callId: 'root-b:code:1', parentCallId: 'root-a', call: { name: 'read' },
        subCalls: [{
          kind: 'tool-result', callId: 'root-b:ptc:2', parentCallId: 'root-b:code:1',
          callTime: 1_700_000_000_007, content: [{ type: 'text', text: 'not executed' }],
          isError: true, error, subCalls: [],
        }],
      }],
    })
    expect(tools.find(node => node.callId === 'root-b')).toMatchObject({
      subCalls: [],
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
      at(2, 'system/message', {
        turn: 1,
        step: 1,
        message: systemMessage('system prompt'),
      }, { surfaceOp: 'append' }),
      at(3, 'request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'test', model: 'test' },
          tools: [],
        },
      }),
      at(4, 'step/start', { turn: 1, step: 1 }),
      at(5, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-1', 'first'),
      }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'm1' }],
      }),
      at(8, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(9, 'step/start', { turn: 1, step: 2 }),
    ])
    value.append(at(10, 'user/message', {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'steer here' }],
      source: { kind: 'user' },
    }))
    value.flush()

    const steering = snapshot(value)
    expect(steering.eventNodes.find(node => node.seq === 10)?.kind).toBe('steering')
    expect(steering.eventNodes.find(node => node.seq === 2)).toBeUndefined()
    expect(steering.eventLocations.get(10)).toMatchObject({
      kind: 'step',
      turn: { turn: 1 },
      step: { step: 2 },
    })

    value.append(at(11, 'assistant/message', {
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
      ? request.promptChange
      : undefined)).toEqual([{ seq: 2, time: 1_700_000_000_002, kind: 'initial' }, undefined])
  })

  it('flags a replaced system node as a system prompt change anchored at the replacement', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'system/message', {
        turn: 1,
        step: 1,
        message: systemMessage('first prompt'),
      }, { surfaceOp: 'append' }),
      at(4, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(5, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-1', 'first'),
      }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(8, 'turn/start', { turn: 2 }),
      at(9, 'step/start', { turn: 2, step: 1 }),
      at(10, 'system/message', {
        turn: 2,
        step: 1,
        message: systemMessage('second prompt'),
      }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] }),
      at(11, 'request/header', {
        reason: 'series',
        header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(12, 'assistant/message', {
        turn: 2,
        step: 1,
        message: assistantMessage('assistant-2', 'second'),
      }),
    ])

    const current = snapshot(value)
    expect(current.eventNodes.map(node => node.seq)).not.toContain(10)
    expect(current.requests.map(request => request.purpose === 'assistant'
      ? [request.prompt?.system, request.promptChange]
      : undefined)).toEqual([
      ['first prompt', { seq: 3, time: 1_700_000_000_003, kind: 'initial' }],
      ['second prompt', {
        seq: 10,
        time: 1_700_000_000_010,
        kind: 'system',
        previous: { config: { provider: 'test', model: 'test' }, system: 'first prompt', tools: [] },
      }],
    ])
  })

  it('shows a complete appended prompt at the start of a headerless window', () => {
    const value = assembler([
      at(10, 'system/message', {
        turn: 2, step: 1, message: systemMessage('known prompt'),
      }, { surfaceOp: 'append' }),
      at(11, 'step/end', { turn: 2, step: 1 }),
      at(12, 'step/start', { turn: 2, step: 2 }),
      at(13, 'assistant/message', {
        turn: 2, step: 2, message: assistantMessage('window-assistant', 'answer'),
      }),
    ], true)
    const request = snapshot(value).requests.find(request => request.purpose === 'assistant')
    expect(request?.purpose === 'assistant' && request.prompt).toBeUndefined()
    expect(request?.requestConfig).toBeUndefined()
    expect(snapshot(value).systemPrompts).toMatchObject([{ seq: 10, text: 'known prompt', update: false }])
    value.prepend([
      at(1, 'system/message', { turn: 1, step: 1, message: systemMessage('original') }, { surfaceOp: 'append' }),
      at(2, 'request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } }),
    ], false)
    value.flush()
    expect(snapshot(value).systemPrompts).toBeUndefined()
    expect(snapshot(value).requests.find(request => request.purpose === 'assistant'))
      .toMatchObject({ prompt: { system: 'known prompt', config: { provider: 'test', model: 'test' } } })
  })

  it('carries an in-history prompt update into later requests as a system change at its own position', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'system/message', {
        turn: 1,
        step: 1,
        message: systemMessage('first prompt'),
      }, { surfaceOp: 'append' }),
      at(4, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(5, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-1', 'first'),
      }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(8, 'turn/start', { turn: 2 }),
      at(9, 'step/start', { turn: 2, step: 1 }),
      // An in-history route appends the changed prompt and logs no new header.
      at(10, 'system/message', {
        turn: 2,
        step: 1,
        message: systemMessage('updated prompt'),
      }, { surfaceOp: 'append' }),
      at(11, 'assistant/message', {
        turn: 2,
        step: 1,
        message: assistantMessage('assistant-2', 'second'),
      }),
      at(12, 'step/end', { turn: 2, step: 1 }),
      at(13, 'step/start', { turn: 2, step: 2 }),
      at(14, 'assistant/message', {
        turn: 2,
        step: 2,
        message: assistantMessage('assistant-3', 'third'),
      }),
      at(15, 'step/end', { turn: 2, step: 2 }),
      at(16, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
      at(17, 'turn/start', { turn: 3 }),
      at(18, 'step/start', { turn: 3, step: 1 }),
      // A later series header carries the updated prompt without a second system change.
      at(19, 'request/header', {
        reason: 'series',
        startsSeries: true,
        header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(20, 'assistant/message', {
        turn: 3,
        step: 1,
        message: assistantMessage('assistant-4', 'fourth'),
      }),
    ])

    const current = snapshot(value)
    expect(current.eventNodes.map(node => node.seq)).not.toContain(10)
    expect(current.requests.map(request => request.purpose === 'assistant'
      ? [request.prompt?.system, request.promptChange]
      : undefined)).toEqual([
      ['first prompt', { seq: 3, time: 1_700_000_000_003, kind: 'initial' }],
      ['updated prompt', {
        seq: 10,
        time: 1_700_000_000_010,
        kind: 'system',
        previous: { config: { provider: 'test', model: 'test' }, system: 'first prompt', tools: [] },
      }],
      ['updated prompt', undefined],
      ['updated prompt', undefined],
    ])
  })

  it.each(['replay', 'live'] as const)('compares consecutive A → B → C updates against B (%s)', (mode) => {
    const history = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'system/message', { turn: 1, step: 1, message: systemMessage('A') }, { surfaceOp: 'append' }),
      at(4, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(5, 'assistant/message', { turn: 1, step: 1, message: assistantMessage('a', 'a') }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'step/start', { turn: 1, step: 2 }),
      at(8, 'system/message', { turn: 1, step: 2, message: systemMessage('B') }, { surfaceOp: 'append' }),
      at(9, 'assistant/message', { turn: 1, step: 2, message: assistantMessage('b', 'b') }),
      at(10, 'step/end', { turn: 1, step: 2 }),
      at(11, 'step/start', { turn: 1, step: 3 }),
      at(12, 'system/message', { turn: 1, step: 3, message: systemMessage('C') }, { surfaceOp: 'append' }),
      at(13, 'assistant/message', { turn: 1, step: 3, message: assistantMessage('c', 'c') }),
      at(14, 'step/end', { turn: 1, step: 3 }),
    ]
    const value = assembler(mode === 'replay' ? history : [])
    if (mode === 'live') {
      for (const entry of history) {
        value.append(entry)
        value.flush()
      }
    }
    expect(snapshot(value).requests.map(request => request.purpose === 'assistant'
      ? { system: request.prompt?.system, previous: request.promptChange?.previous?.system }
      : null)).toEqual([
      { system: 'A', previous: undefined },
      { system: 'B', previous: 'A' },
      { system: 'C', previous: 'B' },
    ])
  })

  it.each(['replay', 'live', 'partial'] as const)('restores A when compaction shadows B without a new system event (%s)', (mode) => {
    const history = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'system/message', { turn: 1, step: 1, message: systemMessage('A') }, { surfaceOp: 'append' }),
      at(4, 'request/header', {
        reason: 'initial', header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(5, 'assistant/message', { turn: 1, step: 1, message: assistantMessage('a', 'a') }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'step/start', { turn: 1, step: 2 }),
      at(8, 'system/message', { turn: 1, step: 2, message: systemMessage('B') }, { surfaceOp: 'append' }),
      at(9, 'assistant/message', { turn: 1, step: 2, message: assistantMessage('b', 'b') }),
      at(10, 'step/end', { turn: 1, step: 2 }),
      at(11, 'step/start', { turn: 1, step: 3 }),
      at(12, 'user/message', {
        turn: 1, step: 3, id: 'summary', role: 'user',
        content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compaction' },
      }, { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 9 }, sourceEventSeqs: [5, 8, 9] }),
      at(13, 'request/header', {
        reason: 'series', header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(14, 'assistant/message', { turn: 1, step: 3, message: assistantMessage('restored', 'restored') }),
      at(15, 'step/end', { turn: 1, step: 3 }),
    ]
    const value = assembler(mode === 'replay' ? history : [])
    if (mode === 'partial') {
      value.replaceWindow(history.slice(7), true)
      value.flush()
      expect(snapshot(value).requests.at(-1)).toMatchObject({ prompt: { system: '' } })
      value.prepend(history.slice(0, 7), false)
      value.flush()
    }
    if (mode === 'live') {
      for (const entry of history) {
        value.append(entry)
        value.flush()
      }
    }
    expect(snapshot(value).requests.filter(request => request.purpose === 'assistant')
      .map(request => [request.prompt?.system, request.promptChange?.previous?.system])).toEqual([
      ['A', undefined], ['B', 'A'], ['A', 'B'],
    ])
    expect(snapshot(value).requests.at(-1)).toMatchObject({ promptChange: { seq: 12, kind: 'system' } })
  })

  it('withholds unknown replacement order in request headers until prepend', () => {
    const system = (seq: number, text: string, replaces?: number) => at(seq, 'system/message', {
      turn: 1, step: 1, message: systemMessage(text),
    }, { surfaceOp: replaces === undefined ? 'append' : { op: 'replace', startSeq: replaces, endSeq: replaces } })
    const value = assembler([
      system(6, 'C', 3), system(7, 'D', 5),
      at(8, 'step/start', { turn: 1, step: 1 }),
      at(9, 'request/header', { reason: 'resume', header: { config: { provider: 'test', model: 'test' } } }),
      at(10, 'assistant/message', { turn: 1, step: 1, message: assistantMessage('reply', 'reply') }),
    ])
    expect(snapshot(value).requests.at(-1)).toMatchObject({ prompt: { system: '' } })
    const uncertain = assembler([system(6, 'C', 3), system(7, 'Known but unordered')], true)
    expect(snapshot(uncertain).systemPrompts).toBeUndefined()
    value.prepend([system(1, 'A'), system(3, 'B'), system(5, 'A2', 1)], false)
    value.flush()
    expect(snapshot(value).requests.at(-1)).toMatchObject({ prompt: { system: 'C' } })
  })

  it('withholds inherited prompts when a replacement reaches an unloaded endpoint', () => {
    const value = assembler([
      at(5, 'step/start', { turn: 1, step: 1 }),
      at(6, 'system/message', { turn: 1, step: 1, message: systemMessage('B') }, { surfaceOp: 'append' }),
      at(7, 'request/header', { reason: 'resume', header: { config: { provider: 'test', model: 'test' } } }),
      at(8, 'user/message', {
        ...systemMessage('summary'), role: 'user', source: { kind: 'plugin', plugin: 'compaction' },
      }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 6 } }),
      at(9, 'assistant/message', { turn: 1, step: 1, message: assistantMessage('reply', 'reply') }),
    ])
    expect(snapshot(value).requests.at(-1)).toMatchObject({ prompt: { system: '' } })
  })

  it('retains an in-history update without a loaded header as a plain system node', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'system/message', { turn: 1, step: 1, message: systemMessage('first prompt') }, { surfaceOp: 'append' }),
      at(4, 'system/message', { turn: 1, step: 1, message: systemMessage('updated prompt') }, { surfaceOp: 'append' }),
      at(5, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'test', model: 'test' }, tools: [] },
      }),
      at(6, 'assistant/message', { turn: 1, step: 1, message: assistantMessage('assistant-1', 'first') }),
    ])

    expect(snapshot(value).requests.map(request => request.purpose === 'assistant'
      ? [request.prompt?.system, request.promptChange]
      : undefined)).toEqual([
      ['updated prompt', { seq: 4, time: 1_700_000_000_004, kind: 'initial' }],
    ])
  })

  it('pins the system-message Definition edges the engine cannot reach', () => {
    const definition = DEFINITIONS.find(candidate => candidate.kind === 'trajectory-system-message')
    if (definition === undefined) throw new Error('trajectory-system-message Definition is not registered')
    const input = at(1, 'turn/start', { turn: 1 })
    const invalidStart = { ...input, role: 'start' as const, location: { kind: 'session' as const } }
    const state = { seq: 1, time: 1, turn: 1, step: 1, text: 'system prompt', update: false }

    expect(definition.match(invalidStart.event)).toBeNull()
    expect(definition.update({ state } as never, invalidStart)).toBe(state)

    const header = DEFINITIONS.find(candidate => candidate.kind === 'trajectory-request-header')
    if (header === undefined) throw new Error('trajectory-request-header Definition is not registered')
    const headerState = { seq: 2, time: 2, prompt: { config: { provider: 'test', model: 'test' } }, location: invalidStart.location }
    expect(() => header.start({} as never, invalidStart, {} as never))
      .toThrow('trajectory-request-header start requires request/header')
    expect(header.update({ state: headerState } as never, invalidStart)).toBe(headerState)
    expect(header.buildViewNode?.({ state: undefined } as never)).toBeNull()
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
