import { describe, expect, it } from 'vitest'
import type {
  ChatConversationViewNode, ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  SessionEventLikeEntry, SessionLiveEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationNodeAssembler,
  type ConversationNodeDefinition,
  type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { hasAssistantReplyContent } from '../src/client/contract/assistant-content.ts'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition } from '../src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { inspectRequestPrompt } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { requestPromptDefinition } from '../src/client/conversation-nodes/request-prompt.ts'
import { retryDefinition } from '../src/client/conversation-nodes/retry.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../src/client/conversation-nodes/turn-max-tokens.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import type {
  AssistantChatData, ManualCompactionChatData, RetryChatData, ToolChatData, TurnTailChatData,
} from '../src/client/contract/chat-nodes.ts'

const DEFINITIONS: readonly ConversationNodeDefinition[] = [
  nextStepInboxDefinition,
  messageDefinition,
  requestPromptDefinition(inspectRequestPrompt),
  assistantDefinition,
  turnProcessDefinition,
  toolDefinition,
  commandDefinition,
  compactionDefinition,
  retryDefinition,
  turnErrorDefinition,
  turnMaxTokensDefinition,
  turnTailDefinition,
]

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): ConversationNodeDefinition {
    return unknownFallbackDefinition
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
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

function assembler(entries: readonly SessionEventLikeEntry[] = [], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.activateTarget('chat')
  return value
}

function snapshot(value: ConversationNodeAssembler): ChatSnapshot {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  return current
}

function node(value: ChatSnapshot, kind: string): ChatConversationViewNode | undefined {
  return value.nodes.values().find(candidate => candidate.kind === kind)
}

function comparableSnapshot(value: ChatSnapshot) {
  const nodes = value.nodes.values()
  return {
    order: value.order,
    nodes: nodes.map(candidate => ({
      ...candidate,
      location: candidate.location.kind === 'step'
        ? {
          kind: 'step',
          turn: candidate.location.turn.turn,
          turnStatus: candidate.location.turn.status,
          step: candidate.location.step.step,
          stepStatus: candidate.location.step.status,
        }
        : candidate.location.kind === 'turn'
          ? {
            kind: 'turn',
            turn: candidate.location.turn.turn,
            turnStatus: candidate.location.turn.status,
          }
          : { kind: candidate.location.kind },
    })),
    processes: nodes.map(candidate => [
      candidate.key,
      value.nodes.processSource(candidate.key).getSnapshot(),
    ]),
    navigation: value.navigation.items(),
    legacy: value.legacy,
  }
}

function withoutEmbeddedSequenceAnchors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmbeddedSequenceAnchors)
  if (value instanceof Map) {
    return new Map([...value].map(([key, entry]) => [key, withoutEmbeddedSequenceAnchors(entry)]))
  }
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === 'anchorSeq' || key === 'controlAnchorSeq' || key === 'processStartSeq'
      ? '<representation-owned-seq>'
      : withoutEmbeddedSequenceAnchors(entry),
  ]))
}

function comparableEmbeddedSnapshot(value: ChatSnapshot): unknown {
  return withoutEmbeddedSequenceAnchors(comparableSnapshot(value))
}

function textMessage(id: string, text: string) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'fake', model: 'fake' },
  }
}

function toolResult(callId: string, text: string, isError = false) {
  return {
    id: `result-${callId}`,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError,
    }],
  }
}

describe('built-in conversation node Definitions', () => {
  it('rejects an unrelated event passed directly to the request-prompt start', () => {
    const input = at(1, 'turn/start', { turn: 1 })
    const invalidStart = {
      ...input,
      role: 'start' as const,
      location: { kind: 'session' as const },
    }

    expect(() => requestPromptDefinition(inspectRequestPrompt).start({} as never, invalidStart, {} as never))
      .toThrow('request-prompt start requires request/header')
  })

  it('keeps ordinary command-only history inactive for the Conversation shell', () => {
    const value = assembler([
      at(1, 'command/run', {
        commandId: 'command-1',
        name: 'help',
        source: { kind: 'user' },
      }),
      at(2, 'command/done', {
        commandId: 'command-1',
        kind: 'success',
      }),
    ])
    const current = snapshot(value)

    expect(current.order).toHaveLength(1)
    expect(current.nodes.get(current.order[0] ?? '')?.kind).toBe('command')
    expect(chatViewDefinition.isActive?.(current)).toBe(false)
  })

  it('keeps the Turn rail projection current when a chunk updates one node in place', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', textMessage('user-1', 'navigate here'), { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'assistant/live-chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first' },
      }),
    ])
    const opening = snapshot(value).navigation.items()
    expect(opening).toHaveLength(1)
    expect(opening[0]?.turn).toBe(1)
    expect(opening[0]?.prompt).toBe('navigate here')
    expect(opening[0]?.response).toBe('first')

    // Content-only upsert: the node keeps its key, so the rail's preview has to
    // follow the in-place update rather than the last structural publication.
    value.append(at(5, 'assistant/live-chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: ' and more' },
    }))
    value.flush()
    const streamed = snapshot(value).navigation.items()
    expect(streamed[0]?.response).toBe('first and more')
    expect(streamed).not.toBe(opening)
  })

  it('bounds each rail preview at its card budget instead of copying the whole transcript', () => {
    const long = 'x'.repeat(400)
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', textMessage('user-1', long), { surfaceOp: 'append' }),
    ])
    const items = snapshot(value).navigation.items()
    // One clipped prompt line: 49 characters plus the trailing ellipsis.
    expect(items[0]?.prompt.length).toBe(50)
    expect(items[0]?.prompt.endsWith('…')).toBe(true)
  })

  it('classifies reply content separately from reasoning and Tool protocol blocks', () => {
    expect(hasAssistantReplyContent([{ kind: 'text', text: '  ' }])).toBe(false)
    expect(hasAssistantReplyContent([{ kind: 'reasoning', text: 'thinking' }])).toBe(false)
    expect(hasAssistantReplyContent([{ kind: 'tool-call', callId: 'c', name: 'read', argsRaw: '{}' }])).toBe(false)
    expect(hasAssistantReplyContent([{ kind: 'text', text: 'answer' }])).toBe(true)
    expect(hasAssistantReplyContent([{ kind: 'image', attachment: {} as never }])).toBe(true)
    expect(hasAssistantReplyContent([{ kind: 'other', block: { type: 'future' } }])).toBe(true)
  })

  it('projects one reversible process window before the finalized answer', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', {
        ...textMessage('context-1', 'workspace context'),
        turn: 1,
        step: 1,
        source: { kind: 'plugin', plugin: 'context' },
      }, { surfaceOp: 'append' }),
      at(4, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
      }),
      at(5, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'checking' },
      }),
      at(6, 'assistant/live-chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'read', argumentsDelta: '{}' },
      }),
    ])
    const process = () => snapshot(value).timeline.turns.get(1)?.data.get('turn-process')
    expect(process()).toMatchObject({ processStartSeq: 4, answerAnchorSeq: null, answerStep: null })
    expect(node(snapshot(value), 'turn-process')?.data).toMatchObject({ answerAnchorSeq: null })

    value.append(at(7, 'tool/call', {
      turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}',
    }))
    value.append(at(8, 'tool/result', {
      turn: 1, step: 1, message: toolResult('call-1', 'done'),
    }, { surfaceOp: 'append' }))
    value.append(at(9, 'step/end', { turn: 1, step: 1 }))
    value.append(at(10, 'step/start', { turn: 1, step: 2 }))
    value.append(at(11, 'assistant/live-chunk', {
      turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'final thinking' },
    }))
    value.append(at(12, 'assistant/live-chunk', {
      turn: 1, step: 2, chunk: { type: 'text-delta', index: 1, text: 'final reply' },
    }))
    value.flush()
    expect(process()).toMatchObject({
      processStartSeq: 4,
      answerAnchorSeq: null,
      answerStep: null,
      inlineReasoning: false,
    })

    value.append(at(13, 'llm/retry', {
      retryId: 'retry-tail', turn: 1, step: 2, provider: 'fake', mode: 'normal',
      policyKey: 'fake-normal', retry: 1, maxRetries: 2, delayMs: 10,
      failure: { code: 'TRANSPORT', message: 'temporary' },
    }))
    value.flush()
    expect(process()).toMatchObject({ answerAnchorSeq: null, answerStep: null })

    value.append(at(14, 'assistant/live-chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'text-delta', index: 0, text: 'replacement reply' },
    }))
    value.flush()
    expect(process()).toMatchObject({ answerAnchorSeq: null, answerStep: null })

    value.append(at(15, 'step/end', { turn: 1, step: 2 }))
    value.append(at(16, 'turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    }))
    value.flush()
    expect(process()).toMatchObject({ answerAnchorSeq: 14.1, answerStep: 2 })

    const recovered = assembler([
      at(20, 'turn/start', { turn: 2 }),
      at(21, 'step/start', { turn: 2, step: 1 }),
      at(22, 'assistant/message', {
        turn: 2, step: 1, message: assistantMessage('recovered-1', 'settled reply'),
      }, { surfaceOp: 'append' }),
      at(23, 'step/end', { turn: 2, step: 1 }),
      at(24, 'step/start', { turn: 2, step: 2 }),
      at(25, 'assistant/live-chunk', {
        turn: 2, step: 2, chunk: { type: 'text-delta', index: 0, text: 'crash partial' },
      }),
      at(26, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } }),
    ])
    const recoveredProcess = snapshot(recovered).timeline.turns.get(2)?.data.get('turn-process')
    expect(recoveredProcess)
      .toMatchObject({ answerStep: 2, answerAnchorSeq: 25.1 })

    const partialWindow = assembler([
      at(30, 'assistant/live-chunk', {
        turn: 3, step: 4, chunk: { type: 'text-delta', index: 0, text: 'loaded tail' },
      }),
      at(31, 'step/end', { turn: 3, step: 4 }),
    ], true)
    const partialProcess = snapshot(partialWindow).timeline.turns.get(3)?.data.get('turn-process')
    expect(partialProcess)
      .toMatchObject({ processStartSeq: 30.1, answerAnchorSeq: 30.1, answerStep: 4 })
  })

  it('counts Assistant messages, Tool calls, and subagent delegations per Turn', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1, step: 1, message: assistantMessage('message-1', 'checking'),
      }, { surfaceOp: 'append' }),
      at(4, 'tool/call', {
        turn: 1, step: 1, callId: 'call-read', name: 'read', arguments: '{}',
      }),
      at(5, 'tool/result', {
        turn: 1, step: 1, message: toolResult('call-read', 'read done'),
      }, { surfaceOp: 'append' }),
      at(6, 'tool/call', {
        turn: 1, step: 1, callId: 'call-subagent', name: 'subagent_fork', arguments: '{}',
      }),
      at(7, 'tool/result', {
        turn: 1, step: 1, message: toolResult('call-subagent', 'delegation done'),
      }, { surfaceOp: 'append' }),
      at(8, 'step/end', { turn: 1, step: 1 }),
      at(9, 'step/start', { turn: 1, step: 2 }),
      at(10, 'assistant/message', {
        turn: 1, step: 2, message: assistantMessage('message-2', 'final answer'),
      }, { surfaceOp: 'append' }),
      at(11, 'step/end', { turn: 1, step: 2 }),
      at(12, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const process = snapshot(value).timeline.turns.get(1)?.data.get('turn-process')
    expect(process).toMatchObject({
      messageCount: 1,
      toolCallCount: 1,
      subagentCount: 1,
    })
  })

  it('orders the opening User before its process control and later steering', () => {
    const steering = textMessage('steer-1', 'change direction')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', {
        ...textMessage('context-1', 'runtime context'),
        source: { kind: 'plugin', plugin: 'context' },
      }, { surfaceOp: 'append' }),
      at(3, 'user/message', textMessage('user-1', 'question'), { surfaceOp: 'append' }),
      at(4, 'step/start', { turn: 1, step: 1 }),
    ])
    const opening = snapshot(value)
    expect(opening.order.map(key => opening.nodes.get(key)?.kind)).toEqual([
      'user', 'context',
    ])

    value.append(at(5, 'assistant/live-chunk', {
      turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
    }))
    value.flush()
    const running = snapshot(value)
    expect(running.order.map(key => running.nodes.get(key)?.kind)).toEqual([
      'user', 'turn-process', 'context', 'assistant-step',
    ])

    value.append(at(6, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, inserted: [steering],
    }))
    value.append(at(7, 'agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 1, inserted: [],
    }))
    value.append(at(8, 'user/message', steering, { surfaceOp: 'append' }))
    value.append(at(9, 'step/end', { turn: 1, step: 1 }))
    value.append(at(10, 'step/start', { turn: 1, step: 2 }))
    value.append(at(11, 'assistant/message', {
      turn: 1, step: 2, message: assistantMessage('answer-1', 'answer'),
    }, { surfaceOp: 'append' }))
    value.append(at(12, 'step/end', { turn: 1, step: 2 }))
    value.append(at(13, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    value.flush()
    const current = snapshot(value)

    expect(current.order.map(key => current.nodes.get(key)?.kind)).toEqual([
      'user', 'turn-process', 'context', 'steering', 'assistant-step', 'assistant-step', 'turn-tail',
    ])
  })

  it('replays pending splice chains and scopes steering to the current claim', () => {
    const first = textMessage('claim-first', 'first')
    const second = textMessage('claim-second', 'second')
    const canceled = textMessage('claim-canceled', 'canceled')
    const requeued = textMessage('claim-requeued', 'requeued')
    const later = textMessage('claim-later', 'later')
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
      at(6, 'user/message', first, { surfaceOp: 'append' }),
      at(7, 'user/message', second, { surfaceOp: 'append' }),
      at(8, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [requeued],
      }),
      at(9, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(10, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [requeued],
      }),
      at(11, 'user/message', requeued, { surfaceOp: 'append' }),
      at(12, 'user/message', canceled, { surfaceOp: 'append' }),
      at(13, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      }),
      at(14, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [later],
      }),
      at(15, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(16, 'user/message', later, { surfaceOp: 'append' }),
    ]))

    expect(current.order.map(key => current.nodes.get(key)).filter(node =>
      node?.kind === 'user' || node?.kind === 'steering')).toMatchObject([
      { kind: 'steering', data: { seq: 6 } },
      { kind: 'steering', data: { seq: 7 } },
      { kind: 'user', data: { seq: 11 } },
      { kind: 'user', data: { seq: 12 } },
      { kind: 'steering', data: { seq: 16 } },
    ])
  })

  it('orders a command-started Turn first steering before its process control', () => {
    const steering = textMessage('command-task', 'plan this change')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [steering],
      }),
      at(3, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(4, 'user/message', steering, { surfaceOp: 'append' }),
      at(5, 'step/start', { turn: 1, step: 1 }),
      at(6, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
      }),
      at(7, 'step/end', { turn: 1, step: 1 }),
      at(8, 'step/start', { turn: 1, step: 2 }),
      at(9, 'assistant/message', {
        turn: 1, step: 2, message: assistantMessage('answer-1', 'answer'),
      }, { surfaceOp: 'append' }),
      at(10, 'step/end', { turn: 1, step: 2 }),
      at(11, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const current = snapshot(value)

    expect(current.order.map(key => current.nodes.get(key)?.kind)).toEqual([
      'steering', 'turn-process', 'assistant-step', 'assistant-step', 'turn-tail',
    ])
  })

  it('keeps a first human message after process evidence at its event position', () => {
    const steering = textMessage('late-steering', 'change direction')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', {
        turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}',
      }),
      at(4, 'tool/result', {
        turn: 1, step: 1, message: toolResult('call-1', 'done'),
      }, { surfaceOp: 'append' }),
      at(5, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, inserted: [steering],
      }),
      at(6, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(7, 'user/message', steering, { surfaceOp: 'append' }),
      at(8, 'step/end', { turn: 1, step: 1 }),
      at(9, 'step/start', { turn: 1, step: 2 }),
      at(10, 'assistant/message', {
        turn: 1, step: 2, message: assistantMessage('answer-1', 'answer'),
      }, { surfaceOp: 'append' }),
      at(11, 'step/end', { turn: 1, step: 2 }),
      at(12, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const current = snapshot(value)

    expect(current.order.map(key => current.nodes.get(key)?.kind)).toEqual([
      'turn-process', 'tool-call', 'steering', 'assistant-step', 'turn-tail',
    ])
  })

  it('keeps Process before pre-User Context as answer eligibility changes', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', {
        ...textMessage('context-1', 'runtime context'),
        source: { kind: 'plugin', plugin: 'context' },
      }, { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
      }),
    ])
    const running = snapshot(value)
    expect(running.order.map(key => running.nodes.get(key)?.kind)).toEqual([
      'turn-process', 'context', 'assistant-step',
    ])

    value.append(at(5, 'step/end', { turn: 1, step: 1 }))
    value.append(at(6, 'step/start', { turn: 1, step: 2 }))
    value.append(at(7, 'assistant/message', {
      turn: 1, step: 2, message: assistantMessage('answer-1', 'answer'),
    }, { surfaceOp: 'append' }))
    value.flush()
    const answered = snapshot(value)
    expect(answered.order.map(key => answered.nodes.get(key)?.kind)).toEqual([
      'turn-process', 'context', 'assistant-step', 'assistant-step',
    ])

    value.append(at(8, 'llm/retry', {
      retryId: 'retry-tail', turn: 1, step: 2, provider: 'fake', mode: 'normal',
      policyKey: 'fake-normal', retry: 1, maxRetries: 2, delayMs: 10,
      failure: { code: 'TRANSPORT', message: 'temporary' },
    }))
    value.flush()
    const retried = snapshot(value)
    expect(retried.order.map(key => retried.nodes.get(key)?.kind)).toEqual([
      'turn-process', 'context', 'assistant-step', 'model-retry',
    ])
  })

  it('establishes the answer boundary only when a streamed answer finalizes', () => {
    const value = assembler([
      at(40, 'turn/start', { turn: 4 }),
      at(41, 'step/start', { turn: 4, step: 1 }),
      at(42, 'assistant/live-chunk', {
        turn: 4, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
      }),
      at(43, 'assistant/live-chunk', {
        turn: 4, step: 1, chunk: { type: 'text-delta', index: 1, text: 'answer' },
      }),
    ])
    const read = () => {
      const process = snapshot(value).timeline.turns.get(4)?.data.get('turn-process')
      if (process === undefined) throw new Error('turn-process data is unavailable')
      return process
    }
    const streamingNode = node(snapshot(value), 'assistant-step')
    if (streamingNode === undefined) throw new Error('streaming Assistant node is unavailable')
    const processSource = snapshot(value).nodes.processSource(streamingNode.key)
    let processNotifications = 0
    processSource.subscribe(() => { processNotifications++ })
    const streaming = read()
    value.append(at(44, 'assistant/message', {
      turn: 4, step: 1, message: assistantMessage('settled-4', 'answer'),
    }, { surfaceOp: 'append' }))
    value.flush()
    const settled = read()

    expect(streaming).toMatchObject({ answerAnchorSeq: null, answerStep: null })
    expect(settled.answerAnchorSeq).toBe(44)
    expect(settled.answerStep).toBe(1)
    expect(processNotifications).toBe(1)
    expect(processSource.getSnapshot()?.spec.answerAnchorSeq).toBe(44)
  })

  it('reuses the open Turn-process projection across continuing Assistant chunks', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'first' },
      }),
    ])
    const before = snapshot(value)
    const processNode = node(before, 'turn-process')
    const processData = before.timeline.turns.get(1)?.data.get('turn-process')
    const assistantNode = node(before, 'assistant-step')
    if (assistantNode === undefined) throw new Error('Assistant node is unavailable')
    const processSource = before.nodes.processSource(assistantNode.key)
    const processPresentation = processSource.getSnapshot()
    let processNotifications = 0
    processSource.subscribe(() => { processNotifications++ })

    value.append(at(4, 'assistant/live-chunk', {
      turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: ' second' },
    }))
    value.flush()

    const after = snapshot(value)
    expect(after.timeline.turns.get(1)?.data.get('turn-process')).toBe(processData)
    expect(node(after, 'turn-process')).toBe(processNode)
    expect(node(after, 'assistant-step')).not.toBe(assistantNode)
    expect(processSource.getSnapshot()).toBe(processPresentation)
    expect(processNotifications).toBe(0)
  })

  it('notifies process sources only for Nodes in the changed Turn', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1, step: 1, message: assistantMessage('answer-1', 'first answer'),
      }, { surfaceOp: 'append' }),
      at(4, 'step/end', { turn: 1, step: 1 }),
      at(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(6, 'turn/start', { turn: 2 }),
      at(7, 'step/start', { turn: 2, step: 1 }),
      at(8, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
      }),
    ])
    const assistants = snapshot(value).nodes.values()
      .filter((candidate): candidate is ChatConversationViewNode & { data: AssistantChatData } => (
        candidate.kind === 'assistant-step'
      ))
    const first = assistants.find(candidate => candidate.data.turn === 1)
    const second = assistants.find(candidate => candidate.data.turn === 2)
    if (first === undefined || second === undefined) throw new Error('Assistant fixtures are unavailable')
    let firstNotifications = 0
    let secondNotifications = 0
    snapshot(value).nodes.processSource(first.key).subscribe(() => { firstNotifications++ })
    snapshot(value).nodes.processSource(second.key).subscribe(() => { secondNotifications++ })

    value.append(at(9, 'assistant/message', {
      turn: 2, step: 1, message: assistantMessage('answer-2', 'second answer'),
    }, { surfaceOp: 'append' }))
    value.append(at(10, 'step/end', { turn: 2, step: 1 }))
    value.append(at(11, 'turn/end', { turn: 2, reason: { kind: 'completed' } }))
    value.flush()

    expect(firstNotifications).toBe(0)
    expect(secondNotifications).toBe(1)
  })

  it('anchors a streamed non-text answer from its block start', () => {
    const value = assembler([
      at(50, 'turn/start', { turn: 5 }),
      at(51, 'step/start', { turn: 5, step: 1 }),
      at(52, 'assistant/live-chunk', {
        turn: 5, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'image' },
      }),
    ])
    const current = snapshot(value)
    const process = node(current, 'turn-process')
    const answer = node(current, 'assistant-step')
    const processData = current.timeline.turns.get(5)?.data.get('turn-process')

    expect(process?.anchorSeq).toBe(51.9)
    expect(answer?.anchorSeq).toBe(52)
    expect(processData)
      .toMatchObject({ answerAnchorSeq: null, answerStep: null })
  })

  it('keeps one keyed Assistant node while streaming settles and materializes interruption from Location', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/live-chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'streaming' },
      }),
    ])
    const runningSnapshot = snapshot(value)
    const running = node(runningSnapshot, 'assistant-step')
    expect(running?.data).toMatchObject({ status: 'running', blocks: [{ kind: 'text', text: 'streaming' }] })
    expect(running?.location.kind === 'step'
      ? running.location.step.data.get('assistant-step')
      : undefined).toBe(running?.data)
    const order = runningSnapshot.order

    value.append(at(4, 'assistant/message', {
      turn: 1,
      step: 1,
      message: assistantMessage('assistant-1', 'settled'),
    }, { surfaceOp: 'append' }))
    value.flush()

    const settledSnapshot = snapshot(value)
    const settled = node(settledSnapshot, 'assistant-step')
    expect(settled?.key).toBe(running?.key)
    expect(settledSnapshot.order).toBe(order)
    expect(settled?.data).toMatchObject({ status: 'settled', blocks: [{ kind: 'text', text: 'settled' }] })
    expect(settled?.location.kind === 'step'
      ? settled.location.step.data.get('assistant-step')
      : undefined).toBe(settled?.data)

    const interruptedValue = assembler([
      at(10, 'turn/start', { turn: 2 }),
      at(11, 'step/start', { turn: 2, step: 1 }),
      at(12, 'assistant/live-chunk', {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'partial' },
      }),
      at(13, 'step/end', { turn: 2, step: 1 }),
    ])
    const interrupted = node(snapshot(interruptedValue), 'assistant-step')
    expect(interrupted?.data).toMatchObject({ status: 'interrupted' })
    expect((interrupted?.data as AssistantChatData).finalNode?.interrupted).toBe(true)

    const markedValue = assembler([
      at(20, 'turn/start', { turn: 3 }),
      at(21, 'step/start', { turn: 3, step: 1 }),
      at(22, 'assistant/message', {
        turn: 3,
        step: 1,
        message: assistantMessage('assistant-3', 'cut short'),
        interrupted: true,
      }, { surfaceOp: 'append' }),
    ])
    const marked = node(snapshot(markedValue), 'assistant-step')
    expect(marked?.data).toMatchObject({ status: 'interrupted', blocks: [{ kind: 'text', text: 'cut short' }] })
    expect((marked?.data as AssistantChatData).finalNode?.interrupted).toBe(true)

    const hiddenValue = assembler([
      at(20, 'turn/start', { turn: 3 }),
      at(21, 'step/start', { turn: 3, step: 1 }),
      at(22, 'llm/retry', {
        retryId: 'retry-hidden',
        turn: 3,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'temporary' },
      }),
    ])
    expect(node(snapshot(hiddenValue), 'assistant-step')).toBeUndefined()

    const toolOnlyValue = assembler([
      at(30, 'turn/start', { turn: 4 }),
      at(31, 'step/start', { turn: 4, step: 1 }),
      at(32, 'assistant/live-chunk', {
        turn: 4,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '' },
      }),
      at(33, 'assistant/message', {
        turn: 4,
        step: 1,
        message: {
          ...assistantMessage('assistant-tool-only', ''),
          content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
        },
      }, { surfaceOp: 'append' }),
    ])
    const toolOnlySnapshot = snapshot(toolOnlyValue)
    expect(toolOnlySnapshot.order).toEqual([])
    expect(node(toolOnlySnapshot, 'assistant-step')?.visibility).toBe('hidden')
    expect(toolOnlySnapshot.legacy.nodes).toMatchObject([{
      kind: 'assistant',
      seq: 33,
      timing: { firstTokenTime: 1_700_000_000_032 },
    }])

    const interruptedToolOnlyValue = assembler([
      at(35, 'turn/start', { turn: 5 }),
      at(36, 'step/start', { turn: 5, step: 1 }),
      at(37, 'assistant/live-chunk', {
        turn: 5,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-2', name: 'read', argumentsDelta: '' },
      }),
      at(38, 'step/end', { turn: 5, step: 1 }),
    ])
    const interruptedToolOnly = node(snapshot(interruptedToolOnlyValue), 'assistant-step')
    expect(interruptedToolOnly?.visibility).toBe('visible')
    expect(interruptedToolOnly?.data).toMatchObject({ status: 'interrupted' })

    const retryTimingValue = assembler([
      at(50, 'turn/start', { turn: 6 }),
      at(51, 'step/start', { turn: 6, step: 1 }),
      at(52, 'assistant/live-chunk', {
        turn: 6,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
      }),
      at(53, 'llm/retry', {
        retryId: 'retry-timing', turn: 6, step: 1, provider: 'fake', mode: 'normal',
        policyKey: 'fake-normal', retry: 1, maxRetries: 2, delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'temporary' },
      }),
      at(54, 'assistant/live-chunk', {
        turn: 6,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'second attempt' },
      }),
      at(55, 'assistant/message', {
        turn: 6,
        step: 1,
        message: assistantMessage('assistant-retried', 'done'),
      }, { surfaceOp: 'append' }),
    ])
    const retryTiming = (node(snapshot(retryTimingValue), 'assistant-step')?.data as AssistantChatData).finalNode
    expect(retryTiming?.timing?.firstTokenTime).toBe(1_700_000_000_052)

    const partialWindow = assembler([
      at(40, 'assistant/live-chunk', {
        turn: 5,
        step: 2,
        chunk: { type: 'text-delta', index: 0, text: 'loaded partial' },
      }),
      at(41, 'step/end', { turn: 5, step: 2 }),
    ], true)
    const recovered = node(snapshot(partialWindow), 'assistant-step')
    expect(recovered?.data).toMatchObject({
      status: 'interrupted',
      blocks: [{ kind: 'text', text: 'loaded partial' }],
    })
  })

  it('folds packed Assistant runs to the same Chat content and Turn Tail state as scalar deltas', () => {
    const runningHistory = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' },
      }, { time: 1_000 }),
      at(4, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '   ' },
      }, { time: 1_000 }),
      at(5, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '\t' },
      }, { time: 995 }),
      at(6, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' },
      }, { time: 1_004 }),
      at(7, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: '' },
      }),
      at(8, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'think' },
      }),
      at(9, 'assistant/live-chunk', {
        turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'ing' },
      }),
      at(10, 'assistant/live-chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '' },
      }),
      at(11, 'assistant/live-chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '{"x":' },
      }),
      at(12, 'assistant/live-chunk', {
        turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: '1}' },
      }),
    ]
    const scalar = assembler(runningHistory)
    const packedHistory = packedInputs(runningHistory)
    expect(packedHistory).toHaveLength(3)
    const runningAttempt = packedHistory.at(-1)?.event
    expect(runningAttempt?.type).toBe('assistant/attempt')
    if (runningAttempt?.type !== 'assistant/attempt') throw new Error('expected packed running attempt')
    expect(runningAttempt.data.stream.length).toBeGreaterThan(0)
    const packed = assembler(packedHistory)

    expect(comparableEmbeddedSnapshot(snapshot(packed))).toEqual(comparableEmbeddedSnapshot(snapshot(scalar)))
    const running = node(snapshot(packed), 'assistant-step')
    expect(running).toMatchObject({ anchorSeq: 12 })
    expect(running?.data).toMatchObject({
      time: 1_004,
      blocks: [
        { kind: 'text', text: '   \tanswer' },
        { kind: 'reasoning', text: 'thinking' },
        { kind: 'tool-call', callId: 'call-1', name: '', argsRaw: '{"x":1}' },
      ],
    })

    for (const value of [scalar, packed]) {
      value.append(at(13, 'step/end', { turn: 1, step: 1 }))
      value.append(at(14, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
      value.flush()
    }
    expect(comparableEmbeddedSnapshot(snapshot(packed))).toEqual(comparableEmbeddedSnapshot(snapshot(scalar)))
    expect(node(snapshot(packed), 'turn-tail')?.anchorSeq).toBe(12.2)

    const partialHistory = [
      ...runningHistory.slice(2),
      at(13, 'step/end', { turn: 1, step: 1 }),
      at(14, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const partialScalar = snapshot(assembler(partialHistory, true))
    const partialPacked = snapshot(assembler(packedInputs(partialHistory), true))
    expect(comparableEmbeddedSnapshot(partialPacked)).toEqual(comparableEmbeddedSnapshot(partialScalar))
    expect(node(partialPacked, 'assistant-step')?.data).toMatchObject({ status: 'interrupted' })
    expect(node(partialPacked, 'turn-tail')?.anchorSeq).toBe(12.2)

    const finalizedHistory = [
      at(20, 'turn/start', { turn: 2 }),
      at(21, 'step/start', { turn: 2, step: 1 }),
      at(22, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '' },
      }, { time: 2_000 }),
      at(23, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: ' ' },
      }, { time: 1_999 }),
      at(24, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'first' },
      }, { time: 2_000 }),
      at(25, 'llm/retry', {
        retryId: 'packed-retry', turn: 2, step: 1, provider: 'fake', mode: 'normal',
        policyKey: 'fake-normal', retry: 1, maxRetries: 2, delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'temporary' },
      }),
      at(26, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '' },
      }),
      at(27, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'second' },
      }),
      at(28, 'assistant/live-chunk', {
        turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: ' attempt' },
      }),
      at(29, 'assistant/message', {
        turn: 2, step: 1, message: assistantMessage('packed-final', 'done'),
      }, { surfaceOp: 'append' }),
    ]
    const finalizedScalar = snapshot(assembler(finalizedHistory))
    const finalizedInputs = packedInputs(finalizedHistory)
    expect(finalizedInputs.filter(input => input.event.type === 'assistant/attempt')).toHaveLength(1)
    const finalizedMessage = finalizedInputs.find(input => input.event.type === 'assistant/message')?.event
    if (finalizedMessage?.type !== 'assistant/message') throw new Error('expected packed final message')
    expect(finalizedMessage.data.stream.length).toBeGreaterThan(0)
    const finalizedPacked = snapshot(assembler(finalizedInputs))
    expect(comparableEmbeddedSnapshot(finalizedPacked)).toEqual(comparableEmbeddedSnapshot(finalizedScalar))
    const finalNode = (node(finalizedPacked, 'assistant-step')?.data as AssistantChatData).finalNode
    expect(finalNode?.timing?.firstTokenTime).toBe(1_999)

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
      }, { surfaceOp: 'append' }),
    ]
    const namedToolScalar = snapshot(assembler(namedToolHistory))
    const namedToolInputs = packedInputs(namedToolHistory)
    const namedToolMessage = namedToolInputs.find(input => input.event.type === 'assistant/message')?.event
    if (namedToolMessage?.type !== 'assistant/message') throw new Error('expected packed named-tool message')
    expect(namedToolMessage.data.stream.length).toBeGreaterThan(0)
    const namedToolPacked = snapshot(assembler(namedToolInputs))
    expect(comparableEmbeddedSnapshot(namedToolPacked)).toEqual(comparableEmbeddedSnapshot(namedToolScalar))
    const namedTool = (node(namedToolPacked, 'assistant-step')?.data as AssistantChatData).finalNode
    expect(namedTool?.timing?.firstTokenTime).toBe(4_000)
  })

  it('keeps one keyed Tool node from running through settlement and replays nested dispatch after prepend', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', { turn: 1, step: 1, callId: 'root', name: 'code', arguments: '{}' }),
    ])
    const runningSnapshot = snapshot(value)
    const running = node(runningSnapshot, 'tool-call')
    expect((running?.data as ToolChatData).root).toMatchObject({ callId: 'root', name: 'code' })
    const order = runningSnapshot.order

    value.append(at(4, 'tool/result', {
      turn: 1,
      step: 1,
      message: toolResult('root', 'done', true),
      error: { name: 'ToolError', code: 'failed' },
      meta: { presentation: 'raw' },
    }, { surfaceOp: 'append' }))
    value.flush()

    const settledSnapshot = snapshot(value)
    const settled = node(settledSnapshot, 'tool-call')
    expect(settled?.key).toBe(running?.key)
    expect(settledSnapshot.order).toBe(order)
    expect((settled?.data as ToolChatData).root).toMatchObject({
      kind: 'tool-result',
      callId: 'root',
      call: { name: 'code', argsRaw: '{}' },
      content: [{ type: 'text', text: 'done' }],
      isError: true,
      error: { name: 'ToolError', code: 'failed' },
      meta: { presentation: 'raw' },
    })

    const history = assembler([
      at(14, 'tool/code-dispatch-start', {
        rootCallId: 'history-root',
        parentCallId: 'history-root',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      at(15, 'tool/code-dispatch', {
        rootCallId: 'history-root',
        parentCallId: 'history-root',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
        isError: false,
        content: [{ type: 'text', text: 'contents' }],
      }),
      at(16, 'tool/result', {
        turn: 2,
        step: 1,
        message: toolResult('history-root', 'root done'),
      }, { surfaceOp: 'append' }),
    ], true)
    const before = node(snapshot(history), 'tool-call')
    expect((before?.data as ToolChatData).root.subCalls).toMatchObject([
      { kind: 'tool-result', callId: 'child', parentCallId: 'history-root', call: { name: 'read' } },
    ])

    history.prepend([
      at(10, 'turn/start', { turn: 2 }),
      at(11, 'step/start', { turn: 2, step: 1 }),
      at(13, 'tool/call', {
        turn: 2,
        step: 1,
        callId: 'history-root',
        name: 'code',
        arguments: '{}',
      }),
    ], false)
    history.flush()

    const after = node(snapshot(history), 'tool-call')
    expect(after?.key).toBe(before?.key)
    expect((after?.data as ToolChatData).root.subCalls).toMatchObject([
      { kind: 'tool-result', callId: 'child', parentCallId: 'history-root', call: { name: 'read' } },
    ])

    const firstChild = (after?.data as ToolChatData).root.subCalls[0]
    history.append(at(17, 'tool/code-dispatch-start', {
      rootCallId: 'history-root',
      parentCallId: 'history-root',
      subCallId: 'second-child',
      name: 'write',
      arguments: { path: 'out.txt' },
    }))
    history.flush()
    const withSecondChild = node(snapshot(history), 'tool-call')
    expect((withSecondChild?.data as ToolChatData).root.subCalls[0]).toBe(firstChild)
  })

  it('prepends an older turn without replacing already materialized nodes', () => {
    const value = assembler([
      at(20, 'turn/start', { turn: 2 }),
      at(21, 'user/message', textMessage('newer-user', 'newer'), { surfaceOp: 'append' }),
      at(22, 'step/start', { turn: 2, step: 1 }),
      at(23, 'assistant/message', {
        turn: 2,
        step: 1,
        message: assistantMessage('newer-assistant', 'newer answer'),
      }, { surfaceOp: 'append' }),
      at(24, 'step/end', { turn: 2, step: 1 }),
      at(25, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ], true)
    const before = snapshot(value)
    const existing = before.nodes.get(before.order.find(key => before.nodes.get(key)?.kind === 'assistant-step') ?? '')
    const store = before.nodes

    value.prepend([
      at(10, 'turn/start', { turn: 1 }),
      at(11, 'user/message', textMessage('older-user', 'older'), { surfaceOp: 'append' }),
      at(12, 'step/start', { turn: 1, step: 1 }),
      at(13, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('older-assistant', 'older answer'),
      }, { surfaceOp: 'append' }),
      at(14, 'step/end', { turn: 1, step: 1 }),
      at(15, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], false)
    value.flush()

    const after = snapshot(value)
    expect(after.nodes).toBe(store)
    expect(after.nodes.get(existing?.key ?? '')).toBe(existing)
    expect(after.order).toHaveLength(before.order.length + 4)
    expect(after.order.map(key => after.nodes.get(key)?.kind)).toEqual([
      'user', 'turn-process', 'assistant-step', 'turn-tail',
      'user', 'turn-process', 'assistant-step', 'turn-tail',
    ])
  })

  it('appends a later turn without replacing nodes from the completed turn', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', textMessage('first-user', 'first'), { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('first-assistant', 'first answer'),
      }, { surfaceOp: 'append' }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const before = snapshot(value)
    const oldOrder = before.order
    const oldNodes = oldOrder.map(key => before.nodes.get(key))

    value.append(at(7, 'turn/start', { turn: 2 }))
    value.append(at(8, 'user/message', textMessage('second-user', 'second'), { surfaceOp: 'append' }))
    value.flush()

    const after = snapshot(value)
    expect(after.nodes).toBe(before.nodes)
    expect(after.order.slice(0, oldOrder.length)).toEqual(oldOrder)
    expect(oldOrder.map(key => after.nodes.get(key))).toEqual(oldNodes)
    expect(after.order.map(key => after.nodes.get(key)?.kind)).toEqual([
      'user', 'turn-process', 'assistant-step', 'turn-tail', 'user',
    ])
  })

  it('keeps branching unavailable when a tool result follows the closing Assistant', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-before-tool', 'running a tool'),
      }, { surfaceOp: 'append' }),
      at(4, 'tool/call', { turn: 1, step: 1, callId: 'late-tool', name: 'read', arguments: '{}' }),
      at(5, 'tool/result', {
        turn: 1,
        step: 1,
        message: toolResult('late-tool', 'done'),
      }, { surfaceOp: 'append' }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    const tail = node(snapshot(value), 'turn-tail')?.data as TurnTailChatData
    expect(tail.closing?.finalNode.seq).toBe(3)
    expect(tail.branchUnavailable).toBe(true)
  })

  it('publishes exact Turn usage only after pagination supplies the full lifecycle window', () => {
    const value = assembler([
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('usage-assistant', 'done'),
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 17,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 1,
        },
      }, { surfaceOp: 'append' }),
      at(4, 'step/end', { turn: 1, step: 1 }),
      at(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], true)

    expect((node(snapshot(value), 'turn-tail')?.data as TurnTailChatData).tokenUsage).toBeUndefined()

    value.prepend([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
    ], false)
    value.flush()

    expect((node(snapshot(value), 'turn-tail')?.data as TurnTailChatData).tokenUsage).toEqual({
      uncachedInputTokens: 10,
      outputTokens: 4,
      totalTokens: 17,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
      routes: [{ provider: 'fake', model: 'fake' }],
    })
  })

  it('replays inbox predecessors after prepend and reclassifies the dependent message as steering', () => {
    const value = assembler([
      at(3, 'user/message', textMessage('steer-1', 'change direction'), { surfaceOp: 'append' }),
    ], true)
    const before = node(snapshot(value), 'user')
    expect(before).toBeDefined()

    value.prepend([
      at(1, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [textMessage('steer-1', 'change direction')],
      }),
      at(2, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 1,
        inserted: [],
      }),
    ], false)
    value.flush()

    const after = node(snapshot(value), 'steering')
    expect(after?.key).toBe(before?.key)
    expect(after?.data).toMatchObject({ kind: 'steering', messageId: 'steer-1' })
    expect(node(snapshot(value), 'user')).toBeUndefined()
  })

  it('orders claimed steering after the finalized Turn tail', () => {
    const steering = textMessage('steer-after-answer', 'change direction')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-before-steering', 'initial answer'),
      }, { surfaceOp: 'append' }),
      at(4, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [steering],
      }),
      at(5, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 1,
        inserted: [],
      }),
      at(6, 'user/message', steering, { surfaceOp: 'append' }),
      at(7, 'step/end', { turn: 1, step: 1 }),
      at(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    const current = snapshot(value)
    const steeringNode = node(current, 'steering')
    expect(steeringNode).toBeDefined()
    expect(current.locations.getTurn(1).at(-1)).toBe(steeringNode?.key)
  })

  it('classifies appended producer context from durable source metadata', () => {
    const value = assembler([
      at(1, 'user/message', {
        ...textMessage('skill-context', 'follow these instructions'),
        source: { kind: 'skill-invocation', name: 'demo-skill', form: 'instructions' },
      }, { surfaceOp: 'append' }),
    ])

    expect(node(snapshot(value), 'context')?.data).toMatchObject({
      kind: 'context',
      provenance: { role: 'inject', label: 'demo-skill' },
      form: 'instructions',
    })
  })

  it('materializes series starts and system changes but not unchanged resumes, config, or tool changes', () => {
    const tools = [{ name: 'read', description: 'Read', parameters: { type: 'object' } }]
    const expandedTools = [...tools, { name: 'write', description: 'Write', parameters: { type: 'object' } }]
    const value = assembler([
      at(1, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# Initial', tools },
      }),
      at(2, 'request/header', {
        reason: 'change',
        header: {
          config: { provider: 'fake', model: 'fake' },
          system: '# Initial',
          tools: expandedTools,
        },
      }),
      at(3, 'request/header', {
        reason: 'change',
        header: {
          config: { provider: 'fake', model: 'fake', maxTokens: 1_024 },
          system: '# Initial',
          tools: expandedTools,
        },
      }),
      at(4, 'request/header', {
        reason: 'change',
        startsSeries: true,
        header: {
          config: { provider: 'fake', model: 'fake', maxTokens: 2_048 },
          system: '# Initial',
          tools: expandedTools,
        },
      }),
      at(5, 'request/header', {
        reason: 'resume',
        header: {
          config: { provider: 'fake', model: 'fake', maxTokens: 2_048 },
          system: '# Initial',
          tools: expandedTools,
        },
      }),
      at(6, 'request/header', {
        reason: 'change',
        header: {
          config: { provider: 'fake', model: 'fake', maxTokens: 2_048 },
          system: '# Updated',
          tools: expandedTools,
        },
      }),
    ])

    const prompts = snapshot(value).nodes.values()
      .filter(candidate => candidate.kind === 'system-prompt')
    expect(prompts.map(prompt => ({ anchorSeq: prompt.anchorSeq, data: prompt.data }))).toEqual([
      { anchorSeq: 1, data: { text: '# Initial' } },
      { anchorSeq: 4, data: { text: '# Initial' } },
      { anchorSeq: 6, data: { text: '# Updated' } },
    ])

    const windowed = assembler([
      at(10, 'request/header', {
        reason: 'resume',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# Resumed prompt' },
      }),
    ], true)
    const systemless = assembler([
      at(20, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'fake', model: 'fake' } },
      }),
    ])
    expect(node(snapshot(windowed), 'system-prompt')?.data).toEqual({ text: '# Resumed prompt' })
    expect(node(snapshot(systemless), 'system-prompt')).toBeUndefined()

    windowed.prepend([
      at(5, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# Resumed prompt' },
      }),
    ], false)
    windowed.flush()
    const restored = snapshot(windowed)
    const restoredPrompts = restored.nodes.values()
      .filter(candidate => candidate.kind === 'system-prompt')
    expect(restoredPrompts.map(prompt => ({
      anchorSeq: prompt.anchorSeq,
      visibility: prompt.visibility,
      data: prompt.data,
    })).sort((left, right) => left.anchorSeq - right.anchorSeq)).toEqual([
      { anchorSeq: 5, visibility: 'visible', data: { text: '# Resumed prompt' } },
      { anchorSeq: 10, visibility: 'hidden', data: { text: '# Resumed prompt' } },
    ])
  })

  it('orders the system field before the request messages while preserving message order', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', textMessage('direct-user', 'prompt'), { surfaceOp: 'append' }),
      at(4, 'user/message', {
        ...textMessage('runtime-context', 'runtime facts'),
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
      }, { surfaceOp: 'append' }),
      at(5, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# System' },
      }),
    ])

    const current = snapshot(value)
    expect(current.order.map(key => current.nodes.get(key)?.kind)).toEqual([
      'system-prompt',
      'user',
      'context',
    ])
    expect(node(current, 'system-prompt')?.anchorSeq).toBe(1)
  })

  it('keeps the initial system prompt before the opening User as Turn process state changes', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', textMessage('direct-user', 'prompt'), { surfaceOp: 'append' }),
      at(4, 'user/message', {
        ...textMessage('runtime-context', 'runtime facts'),
        source: { kind: 'plugin', plugin: 'context' },
      }, { surfaceOp: 'append' }),
      at(5, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# System' },
      }),
    ])
    const kinds = () => {
      const current = snapshot(value)
      return current.order.map(key => current.nodes.get(key)?.kind)
    }
    const promptKey = node(snapshot(value), 'system-prompt')?.key

    expect(kinds()).toEqual(['system-prompt', 'user', 'context'])

    value.append(at(6, 'assistant/live-chunk', {
      turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
    }))
    value.flush()
    expect(kinds()).toEqual([
      'system-prompt', 'user', 'turn-process', 'context', 'assistant-step',
    ])

    value.append(at(7, 'step/end', { turn: 1, step: 1 }))
    value.append(at(8, 'step/start', { turn: 1, step: 2 }))
    value.append(at(9, 'assistant/message', {
      turn: 1, step: 2, message: assistantMessage('answer-1', 'answer'),
    }, { surfaceOp: 'append' }))
    value.append(at(10, 'step/end', { turn: 1, step: 2 }))
    value.append(at(11, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    value.flush()

    expect(kinds()).toEqual([
      'system-prompt', 'user', 'turn-process', 'context', 'assistant-step', 'assistant-step', 'turn-tail',
    ])
    expect(node(snapshot(value), 'system-prompt')?.key).toBe(promptKey)
  })

  it('keeps an append-only later user turn in the existing system-prompt series', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', textMessage('first-user', 'first'), { surfaceOp: 'append' }),
      at(4, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# System' },
      }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(7, 'turn/start', { turn: 2 }),
      at(8, 'step/start', { turn: 2, step: 1 }),
      at(9, 'user/message', textMessage('second-user', 'second'), { surfaceOp: 'append' }),
    ])

    const current = snapshot(value)
    const ordered = current.order.flatMap((key) => {
      const candidate = current.nodes.get(key)
      return candidate?.kind === 'system-prompt' || candidate?.kind === 'user' ? [candidate] : []
    })
    expect(ordered.map(candidate => candidate.kind)).toEqual(['system-prompt', 'user', 'user'])
  })

  it('keeps a windowed System prompt in place when prepend supplies the preceding header', () => {
    const reasons = ['change', 'resume', 'series'] as const
    for (const reason of reasons) {
      const windowedSystem = reason === 'series' ? '# Original' : '# Windowed'
      const windowed = assembler([
        at(5, 'turn/start', { turn: 2 }),
        at(6, 'step/start', { turn: 2, step: 1 }),
        at(7, 'user/message', textMessage(`second-user-${reason}`, 'second'), { surfaceOp: 'append' }),
        at(8, 'request/header', {
          reason,
          header: { config: { provider: 'fake', model: 'fake' }, system: windowedSystem },
        }),
      ], true)

      const before = snapshot(windowed)
      const prompt = node(before, 'system-prompt')
      const user = node(before, 'user')
      if (prompt === undefined || user === undefined) throw new Error('windowed prompt fixture is incomplete')
      const stableOrder = [user.key, prompt.key]
      expect(prompt.anchorSeq).toBe(8)
      expect(before.order.filter(key => stableOrder.includes(key))).toEqual(stableOrder)

      windowed.prepend([
        at(1, 'turn/start', { turn: 1 }),
        at(2, 'step/start', { turn: 1, step: 1 }),
        at(3, 'user/message', textMessage(`first-user-${reason}`, 'first'), { surfaceOp: 'append' }),
        at(4, 'request/header', {
          reason: 'initial',
          header: { config: { provider: 'fake', model: 'fake' }, system: '# Original' },
        }),
      ], false)
      windowed.flush()

      const restored = snapshot(windowed)
      const prompts = restored.order.flatMap((key) => {
        const candidate = restored.nodes.get(key)
        return candidate?.kind === 'system-prompt' ? [candidate] : []
      })
      expect(prompts.map(candidate => candidate.anchorSeq)).toEqual([1, 8])
      expect(restored.nodes.get(prompt.key)?.anchorSeq).toBe(8)
      expect(restored.order.filter(key => stableOrder.includes(key))).toEqual(stableOrder)
    }
  })

  it('repeats an unchanged system prompt after a surface rewrite and before an explicit later series', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', textMessage('first-user', 'first'), { surfaceOp: 'append' }),
      at(4, 'request/header', {
        reason: 'initial',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# Same' },
      }),
      at(5, 'user/message', {
        ...textMessage('compacted', 'summary'),
        source: { kind: 'plugin', plugin: 'compact' },
      }, { surfaceOp: { op: 'replace', start: 3, end: 3 } }),
      at(6, 'request/header', {
        reason: 'series',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# Same' },
      }),
      at(7, 'step/end', { turn: 1, step: 1 }),
      at(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(9, 'turn/start', { turn: 2 }),
      at(10, 'step/start', { turn: 2, step: 1 }),
      at(11, 'user/message', textMessage('second-user', 'second'), { surfaceOp: 'append' }),
      at(12, 'request/header', {
        reason: 'series',
        header: { config: { provider: 'fake', model: 'fake' }, system: '# Same' },
      }),
    ])

    const current = snapshot(value)
    const ordered = current.order.flatMap((key) => {
      const candidate = current.nodes.get(key)
      return candidate?.kind === 'system-prompt' || candidate?.kind === 'user' ? [candidate] : []
    })
    expect(ordered.map(candidate => candidate?.kind)).toEqual([
      'system-prompt', 'user', 'system-prompt', 'system-prompt', 'user',
    ])
    expect(ordered.filter(candidate => candidate?.kind === 'system-prompt')
      .map(candidate => candidate?.anchorSeq)).toEqual([1, 6, 9])
  })

  it('associates each direct message with its immediately following session recall', () => {
    const value = assembler([
      at(1, 'user/message', textMessage('citing-research', '@Research notes what changed?'), { surfaceOp: 'append' }),
      at(2, 'user/message', {
        ...textMessage('research-context', 'snapshot'),
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: [{ sessionId: 'source-a', label: 'Research notes' }],
        },
      }, { surfaceOp: 'append' }),
      at(3, 'user/message', textMessage('citing-review', '@Review next'), { surfaceOp: 'append' }),
      at(4, 'user/message', {
        ...textMessage('review-context', 'snapshot'),
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: [{ sessionId: 'source-b', label: 'Review' }],
        },
      }, { surfaceOp: 'append' }),
      at(6, 'user/message', textMessage('later-user', 'unrelated'), { surfaceOp: 'append' }),
    ])

    const current = snapshot(value)
    const messages = [...current.nodes.values()]
      .filter(candidate => candidate.kind === 'user' || candidate.kind === 'context')
    const users = [...current.nodes.values()].filter(candidate => candidate.kind === 'user')
    expect(messages.map(candidate => candidate.kind)).toEqual(['user', 'context', 'user', 'context', 'user'])
    expect(users[0]?.data).toMatchObject({ referenceLabels: ['Research notes'] })
    expect(users[1]?.data).toMatchObject({ referenceLabels: ['Review'] })
    expect(users[2]?.data).not.toHaveProperty('referenceLabels')
  })

  it('updates an already published direct node when its following recall arrives', () => {
    const value = assembler([
      at(1, 'user/message', textMessage('citing-user', '@Research notes what changed?'), { surfaceOp: 'append' }),
    ])
    const before = node(snapshot(value), 'user')
    expect(before?.data).not.toHaveProperty('referenceLabels')

    value.append(at(2, 'user/message', {
      ...textMessage('reference-context', 'snapshot'),
      source: {
        kind: 'session-reference',
        form: 'recall',
        version: 1,
        references: [{ sessionId: 'source-a', label: 'Research notes' }],
      },
    }, { surfaceOp: 'append' }))
    value.flush()

    const current = snapshot(value)
    const nodes = [...current.nodes.values()]
      .filter(candidate => candidate.kind === 'user' || candidate.kind === 'context')
    expect(nodes.map(candidate => candidate.kind)).toEqual(['user', 'context'])
    expect(nodes[0]?.key).toBe(before?.key)
    expect(nodes[0]?.data).toMatchObject({ referenceLabels: ['Research notes'] })
    expect(current.legacy.nodes[0]).toMatchObject({ referenceLabels: ['Research notes'] })
  })

  it('associates a claimed steering message with its following recall', () => {
    const steering = textMessage('steering-reference', '@Research notes continue')
    const value = assembler([
      at(1, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [steering],
      }),
      at(2, 'agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        removedCount: 1,
        inserted: [],
      }),
      at(3, 'user/message', steering, { surfaceOp: 'append' }),
      at(4, 'user/message', {
        ...textMessage('steering-reference-context', 'snapshot'),
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: [{ sessionId: 'source-a', label: 'Research notes' }],
        },
      }, { surfaceOp: 'append' }),
    ])

    expect(node(snapshot(value), 'steering')?.data).toMatchObject({
      messageId: 'steering-reference',
      referenceLabels: ['Research notes'],
    })
  })

  it('associates a direct message with the skill invocations injected for its step', () => {
    const skillInvocation = (id: string) => ({
      ...textMessage(id, 'instructions'),
      source: { kind: 'skill-invocation', name: 'demo-skill', form: 'instructions' },
    })
    const instructions = (id: string) => ({
      ...textMessage(id, 'workspace rules'),
      source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] },
    })
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'user/message', textMessage('gesture', '/demo-skill go'), { surfaceOp: 'append' }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'user/message', instructions('rules-1'), { surfaceOp: 'append' }),
      at(5, 'user/message', skillInvocation('skill-body'), { surfaceOp: 'append' }),
      at(6, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('answer-1', 'done'),
      }, { surfaceOp: 'append' }),
      at(7, 'step/end', { turn: 1, step: 1 }),
      at(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(9, 'turn/start', { turn: 2 }),
      at(10, 'user/message', textMessage('later', '/demo-skill again?'), { surfaceOp: 'append' }),
      at(11, 'step/start', { turn: 2, step: 1 }),
      at(12, 'user/message', instructions('rules-2'), { surfaceOp: 'append' }),
    ])

    const users = [...snapshot(value).nodes.values()].filter(candidate => candidate.kind === 'user')
    expect(users).toHaveLength(2)
    expect(users[0]?.data).toMatchObject({ skillNames: ['demo-skill'] })
    expect(users[1]?.data).not.toHaveProperty('skillNames')
  })

  it('updates an already published direct node when its skill injection arrives', () => {
    const value = assembler([
      at(1, 'user/message', textMessage('gesture', '/demo-skill go'), { surfaceOp: 'append' }),
    ])
    const before = node(snapshot(value), 'user')
    expect(before?.data).not.toHaveProperty('skillNames')

    value.append(at(2, 'user/message', {
      ...textMessage('skill-body', 'instructions'),
      source: { kind: 'skill-invocation', name: 'demo-skill', form: 'instructions' },
    }, { surfaceOp: 'append' }))
    value.flush()

    const after = node(snapshot(value), 'user')
    expect(after?.key).toBe(before?.key)
    expect(after?.data).toMatchObject({ skillNames: ['demo-skill'] })
  })

  it('keeps replacement copies out of Chat business nodes', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'user/message', {
        ...textMessage('replacement-user', 'model-only context'),
        source: { kind: 'plugin', plugin: 'foreign' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 1 } }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('replacement-assistant', 'rewritten answer'),
      }, { surfaceOp: { op: 'replace', start: 2, end: 2 } }),
      at(5, 'tool/call', { turn: 1, step: 1, callId: 'root', name: 'read', arguments: '{}' }),
      at(6, 'tool/result', {
        turn: 1,
        step: 1,
        message: toolResult('root', 'pruned result'),
      }, { surfaceOp: { op: 'replace', start: 3, end: 3 } }),
    ])

    const current = snapshot(value)
    expect(node(current, 'user')).toBeUndefined()
    expect(node(current, 'context')).toBeUndefined()
    expect(node(current, 'assistant-step')).toBeUndefined()
    expect((node(current, 'tool-call')?.data as ToolChatData).root).not.toHaveProperty('kind')
  })

  it('assembles retry chains and keeps manual and automatic compaction ownership separate', () => {
    const retry = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'llm/retry', {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'first' },
      }),
      at(4, 'llm/retry-started', { retryId: 'retry-1', turn: 1, step: 1, retry: 1 }),
      at(5, 'llm/retry', {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 2,
        maxRetries: 2,
        delayMs: 20,
        failure: { code: 'TRANSPORT', message: 'second' },
      }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'failed' } },
      }),
    ])
    const retryNode = node(snapshot(retry), 'model-retry')
    const retryData = retryNode?.data as RetryChatData
    expect(retryData.attempts.map(attempt => attempt.retryState)).toEqual(['started', 'cancelled'])
    expect(node(snapshot(retry), 'turn-error')?.data).toMatchObject({
      kind: 'turn-error',
      turn: 1,
      message: 'failed',
      code: 'TRANSPORT',
    })

    const compactions = assembler([
      at(10, 'command/run', {
        commandId: 'command-1',
        name: 'compact',
        source: { kind: 'user' },
      }),
      at(11, 'compaction/start', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        turn: null,
      }),
      at(12, 'compaction/summary', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        summary: [{ type: 'text', text: 'manual summary' }],
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 100,
      }),
      at(13, 'user/message', {
        ...textMessage('manual-checkpoint', 'checkpoint'),
        source: {
          kind: 'plugin',
          plugin: 'compact',
          compactionId: 'manual-1',
          sourceCommandId: 'command-1',
        },
      }, { surfaceOp: { op: 'replace', start: 1, end: 2 } }),
      at(14, 'compaction/end', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        turn: null,
      }),
      at(15, 'command/done', {
        commandId: 'command-1',
        kind: 'success',
        sourceEventSeq: 12,
      }),
      at(20, 'compaction/start', { compactionId: 'automatic-1', turn: null }),
      at(21, 'compaction/summary', {
        compactionId: 'automatic-1',
        summary: [{ type: 'text', text: 'automatic summary' }],
        shadowedSeqs: [3, 4],
        shadowedTokenCount: 200,
      }),
      at(22, 'user/message', {
        ...textMessage('automatic-checkpoint', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'automatic-1' },
      }, { surfaceOp: { op: 'replace', start: 3, end: 4 } }),
      at(23, 'compaction/end', { compactionId: 'automatic-1', turn: null }),
    ])

    const manual = node(snapshot(compactions), 'manual-compaction')
    expect((manual?.data as ManualCompactionChatData).compaction).toMatchObject({
      summary: 'manual summary',
      summaryEventSeq: 12,
    })
    const automatic = node(snapshot(compactions), 'compaction')
    expect(automatic?.data).toMatchObject({ summary: 'automatic summary', summaryEventSeq: 21 })
    expect(snapshot(compactions).nodes.values().filter(candidate => candidate.kind === 'compaction')).toHaveLength(1)
  })

  it('fills a landed compaction marker when an older page supplies its summary', () => {
    const value = assembler([
      at(13, 'user/message', {
        ...textMessage('checkpoint', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 8 } }),
    ], true)
    const before = node(snapshot(value), 'compaction')
    expect(before?.data).toMatchObject({ summary: null, summaryEventSeq: null })

    value.prepend([
      at(9, 'compaction/start', { compactionId: 'compact-1', turn: null }),
      at(10, 'compaction/summary', {
        compactionId: 'compact-1',
        summary: [
          { type: 'text', text: 'older ' },
          { type: 'image', data: 'ignored' },
          { type: 'text', text: 'summary' },
        ],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
      }),
    ], false)
    value.flush()

    const after = node(snapshot(value), 'compaction')
    expect(after?.key).toBe(before?.key)
    expect(after?.data).toMatchObject({
      summary: 'older summary',
      summaryEventSeq: 10,
      shadowedItemCount: 3,
      shadowedTokenCount: 42,
    })
  })

  it('renders a historical compaction when its start remains outside the loaded window', () => {
    const value = assembler([
      at(10, 'compaction/summary', {
        compactionId: 'compact-windowed',
        summary: [{ type: 'text', text: 'loaded summary' }],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
      }),
      at(11, 'user/message', {
        ...textMessage('checkpoint-windowed', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-windowed' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 3 } }),
    ], true)

    expect(node(snapshot(value), 'compaction')?.data).toMatchObject({
      summary: 'loaded summary',
      summaryEventSeq: 10,
      shadowedItemCount: 3,
      shadowedTokenCount: 42,
    })
  })

  it('ignores legacy compaction transactions without correlation ids', () => {
    const value = assembler([
      at(10, 'compaction/start', { turn: null }),
      at(11, 'compaction/end', { turn: null, error: 'This operation was aborted' }),
      at(20, 'compaction/start', { turn: null }),
      at(21, 'compaction/summary', {
        summary: [{ type: 'text', text: 'legacy summary' }],
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
      }),
      at(22, 'user/message', {
        ...textMessage('legacy-checkpoint', 'checkpoint'),
        source: { kind: 'plugin', plugin: 'compact' },
      }, { surfaceOp: { op: 'replace', start: 1, end: 3 } }),
      at(23, 'compaction/end', { turn: null }),
    ], true)

    expect(node(snapshot(value), 'compaction')).toBeUndefined()
  })

  it('ignores legacy retry and code-dispatch events without correlation ids', () => {
    const value = assembler([
      at(10, 'llm/retry', {
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'first legacy retry' },
      }),
      at(11, 'llm/retry-started', { turn: 1, step: 1, retry: 1 }),
      at(20, 'llm/retry', {
        turn: 2,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'second legacy retry' },
      }),
      at(30, 'tool/code-dispatch-start', {
        parentCallId: 'root',
        subCallId: 'child',
        name: 'legacy-subcall',
        arguments: {},
      }),
      at(31, 'tool/code-dispatch', {
        parentCallId: 'root',
        subCallId: 'child',
        name: 'legacy-subcall',
        arguments: {},
        content: [],
      }),
    ], true)

    expect(node(snapshot(value), 'model-retry')).toBeUndefined()
    expect(node(snapshot(value), 'tool-call')).toBeUndefined()
  })

  it('renders the exhausted-retry turn error in a partial tail window and after prepending the chain', () => {
    const value = assembler([
      at(5, 'llm/retry', {
        retryId: 'retry-paged',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 2,
        maxRetries: 2,
        delayMs: 20,
        failure: { code: 'TRANSPORT', message: 'second' },
      }),
      at(6, 'step/end', { turn: 1, step: 1 }),
      at(7, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'failed' } },
      }),
    ], true)

    expect(node(snapshot(value), 'model-retry')).toBeUndefined()
    expect(node(snapshot(value), 'turn-error')?.data).toMatchObject({
      kind: 'turn-error',
      seq: 7,
      turn: 1,
      message: 'failed',
      code: 'TRANSPORT',
    })

    value.prepend([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'llm/retry', {
        retryId: 'retry-paged',
        turn: 1,
        step: 1,
        provider: 'fake',
        mode: 'normal',
        policyKey: 'fake-normal',
        retry: 1,
        maxRetries: 2,
        delayMs: 10,
        failure: { code: 'TRANSPORT', message: 'first' },
      }),
      at(4, 'llm/retry-started', {
        retryId: 'retry-paged', turn: 1, step: 1, retry: 1,
      }),
    ], false)
    value.flush()

    const retry = node(snapshot(value), 'model-retry')
    expect((retry?.data as RetryChatData).attempts).toHaveLength(2)
    expect(node(snapshot(value), 'turn-error')?.data).toMatchObject({
      kind: 'turn-error',
      seq: 7,
      turn: 1,
      message: 'failed',
      code: 'TRANSPORT',
    })
  })

  it('materializes a max-tokens notice and keeps completed and error turns clean', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/message', {
        turn: 1, step: 1, message: assistantMessage('a1', 'truncated answer'),
      }, { surfaceOp: 'append' }),
      at(4, 'step/end', { turn: 1, step: 1 }),
      at(5, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
    ])
    const notice = node(snapshot(value), 'turn-max-tokens')
    expect(notice?.data).toMatchObject({ kind: 'turn-max-tokens', seq: 5, turn: 1, step: 1 })
    expect(node(snapshot(value), 'turn-error')).toBeUndefined()
    // The tail stays the turn's last node so its branch action survives; the
    // notice slots between the truncated closing Assistant and the tail.
    const tail = node(snapshot(value), 'turn-tail')
    expect(notice?.anchorSeq).toBeLessThan(tail?.anchorSeq ?? Number.NEGATIVE_INFINITY)
    expect(notice?.anchorSeq).toBeGreaterThan(3)

    const completed = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(node(snapshot(completed), 'turn-max-tokens')).toBeUndefined()

    const failed = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'failed' } },
      }),
    ])
    expect(node(snapshot(failed), 'turn-max-tokens')).toBeUndefined()
    expect(node(snapshot(failed), 'turn-error')).toBeDefined()
  })

  it('keeps the max-tokens notice when the window starts after the owning turn/start', () => {
    const value = assembler([
      at(9, 'turn/end', { turn: 3, reason: { kind: 'max-tokens' } }),
    ], true)
    const notice = node(snapshot(value), 'turn-max-tokens')
    expect(notice?.data).toMatchObject({ kind: 'turn-max-tokens', seq: 9, turn: 3 })
  })

  it('pins the max-tokens Definition edges the engine cannot reach', () => {
    // The engine only hands start the single matched turn/end and never emits
    // update Matches for this kind; these direct calls pin the declared
    // behavior of both required Definition members anyway.
    const match = (seq: number, type: string, data: unknown) => ({
      event: { seq, time: seq * 1_000, type, data },
      role: 'start',
      location: undefined,
    }) as unknown as Parameters<typeof turnMaxTokensDefinition.start>[1]
    const context = (state: unknown, matches: unknown[] = []) => ({
      key: 'k', kind: 'turn-max-tokens', id: '1', matches, start: undefined, state, current: new Map(),
    }) as unknown as Parameters<NonNullable<typeof turnMaxTokensDefinition.buildViewNode>>[0]
    const reader = { previous: () => undefined }

    expect(() => turnMaxTokensDefinition.start(context(undefined), match(1, 'turn/start', { turn: 1 }), reader))
      .toThrow('turn-max-tokens start requires a max-tokens turn/end')
    const state = { turn: 1, seq: 5, time: 5_000 }
    expect(turnMaxTokensDefinition.update(
      context(state) as Parameters<typeof turnMaxTokensDefinition.update>[0],
      match(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    )).toBe(state)
    expect(turnMaxTokensDefinition.buildViewNode?.(context(undefined))).toBeNull()
  })

  it('preserves nested Tools and manual compaction evidence when their start events are outside the window', () => {
    const value = assembler([
      at(12, 'tool/code-dispatch-start', {
        rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read_file', arguments: { path: 'a' },
      }),
      at(13, 'tool/code-dispatch', {
        rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read_file', arguments: { path: 'a' },
        isError: false, content: [{ type: 'text', text: 'child result' }],
      }),
      at(14, 'tool/result', {
        turn: 1,
        step: 1,
        message: toolResult('root', 'root result'),
      }, { surfaceOp: 'append' }),
      at(20, 'compaction/summary', {
        compactionId: 'manual-1',
        sourceCommandId: 'command-1',
        summary: [{ type: 'text', text: 'manual summary' }],
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 100,
      }),
      at(21, 'user/message', {
        ...textMessage('manual-checkpoint', 'checkpoint'),
        source: {
          kind: 'plugin',
          plugin: 'compact',
          compactionId: 'manual-1',
          sourceCommandId: 'command-1',
        },
      }, { surfaceOp: { op: 'replace', start: 1, end: 2 } }),
      at(22, 'command/done', {
        commandId: 'command-1',
        kind: 'success',
        sourceEventSeq: 20,
      }),
    ], true)

    const tool = node(snapshot(value), 'tool-call')
    const root = (tool?.data as ToolChatData).root
    expect(root.subCalls).toHaveLength(1)
    expect(root.subCalls[0]).toMatchObject({ callId: 'child', kind: 'tool-result' })
    const manual = node(snapshot(value), 'manual-compaction')
    expect((manual?.data as ManualCompactionChatData)).toMatchObject({
      command: { commandId: 'command-1', name: 'compact', outcome: { kind: 'success' } },
      compaction: { summary: 'manual summary', summaryEventSeq: 20 },
    })
  })
})
