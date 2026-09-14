/** The `--json` run projection: commit-point emission, ordering, bounding, and disposal. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { boundJsonLine, MAX_STRING_BYTES, projectJsonRun, type JsonProjectionOptions } from '../src/json-stream.ts'

interface ProjectionHarness {
  readonly lines: string[]
  readonly projection: ReturnType<typeof projectJsonRun>
  readonly agent: Agent
  readonly session: Session
  readonly parsed: () => Record<string, unknown>[]
  emitSession(event: SessionEvent): void
  emitRawSession(session: unknown, event: SessionEvent): void
}

/** One committed assistant message carrying the given content blocks. */
function assistantMessage(content: unknown[], usage?: unknown): SessionEvent {
  return {
    type: 'assistant/message',
    data: {
      stream: [],
      turn: 1,
      step: 1,
      ...usage === undefined ? {} : { usage },
      message: {
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
  } as unknown as SessionEvent
}

/** One discarded attempt whose stream reports the given usage sample. */
function attemptWithUsage(usage: unknown): SessionEvent {
  return {
    type: 'assistant/attempt',
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
  } as unknown as SessionEvent
}

/** One step boundary event closing the accumulated usage window. */
function stepEnd(): SessionEvent {
  return { type: 'step/end', data: { turn: 1, step: 1 } } as unknown as SessionEvent
}

/** One tool result event with the given surface placement. */
function toolResult(
  callId: string,
  content: unknown[],
  surfaceOp: 'append' | { op: 'replace'; startSeq: number; endSeq: number } = 'append',
): SessionEvent {
  return {
    type: 'tool/result',
    surfaceOp,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: callId, content, isError: false }] },
    },
  } as unknown as SessionEvent
}

/** Drive the projector through a minimal Context and Agent double. */
function harness(
  options: JsonProjectionOptions = {},
  agentId = 'session-1',
  cwd: string | null = '/',
): ProjectionHarness {
  const lines: string[] = []
  const sessionListeners = new Set<(session: unknown, event: SessionEvent) => void>()
  const ctx = {
    on(name: string, handler: unknown) {
      if (name === 'session/event') sessionListeners.add(handler as never)
      return () => { sessionListeners.delete(handler as never) }
    },
  } as unknown as Context
  const session = {} as Session
  const agent = { id: agentId, session } as unknown as Agent
  const projection = projectJsonRun(ctx, agent, {
    write: (chunk: string) => { lines.push(chunk); return true },
  }, { ...options, ...cwd === null ? {} : { cwd } })
  return {
    lines,
    projection,
    agent,
    session,
    parsed: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
    emitSession: (event) => { for (const listener of sessionListeners) listener(session, event) },
    emitRawSession: (rawSession, event) => { for (const listener of sessionListeners) listener(rawSession, event) },
  }
}

describe('--json projection', () => {
  it('opens with the session event before any observed event', () => {
    const test = harness()
    expect(test.parsed()).toEqual([{ type: 'session', sessionId: 'session-1', cwd: '/' }])
  })

  it('defaults the reported cwd and the per-string cap', () => {
    const test = harness({}, 'session-1', null)
    expect(test.parsed()[0]).toEqual({ type: 'session', sessionId: 'session-1', cwd: process.cwd() })
    test.emitSession(assistantMessage([{ type: 'text', text: 'x'.repeat(9000) }]))
    expect(test.parsed()[1]?.truncated).toBe(true)
    expect((test.parsed()[1]?.text as string).length).toBe(8 * 1024)
  })

  it('reports turn and step boundaries with the turn-end reason', () => {
    const test = harness()
    test.emitSession({ type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
    test.emitSession({ type: 'step/start', data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    test.emitSession({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent)
    expect(test.parsed().slice(1)).toEqual([
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
    ])
  })

  it('projects committed reasoning and text in content order', () => {
    const test = harness()
    test.emitSession(assistantMessage([
      { type: 'reasoning', text: 'think' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'text', text: 'answer' },
    ]))
    expect(test.parsed().slice(1)).toEqual([
      { type: 'thinking', text: 'think' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('ignores a discarded attempt so retried content never reaches the stream', () => {
    const test = harness()
    test.emitSession({
      type: 'assistant/attempt',
      data: { turn: 1, step: 1, stream: [] },
    } as unknown as SessionEvent)
    test.emitSession({ type: 'session/title', data: { title: 'ignored' } } as unknown as SessionEvent)
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
  })

  it('attaches step usage to step_end and omits it when absent', () => {
    const test = harness()
    test.emitSession({ type: 'step/end', data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    test.emitSession(assistantMessage([{ type: 'text', text: 'x' }], { inputTokens: 3, outputTokens: 4 }))
    test.emitSession({ type: 'step/end', data: { turn: 1, step: 2 } } as unknown as SessionEvent)
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
    expect(events[3]).toEqual({
      type: 'status', phase: 'step_end', turn: 1, step: 2,
      usage: { inputTokens: 3, outputTokens: 4 },
    })
  })

  it('reports tool results as completed or errored and keeps the final event last', () => {
    const test = harness()
    test.emitSession(toolResult('c1', [{ type: 'text', text: 'a.txt' }]))
    test.emitSession({
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'c2',
            content: [{ type: 'image' }, { type: 'text' }, { type: 'text', text: 'boom' }],
            isError: true,
          }],
        },
      },
    } as unknown as SessionEvent)
    test.projection.finish('done')
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'a.txt' })
    expect(events[2]).toEqual({ type: 'tool_result', callId: 'c2', status: 'error', result: 'boom' })
    expect(events.at(-1)).toEqual({ type: 'final', text: 'done' })
  })

  it('skips a compaction replacement of an older tool result', () => {
    const test = harness()
    test.emitSession(toolResult('old', [{ type: 'text', text: 'history' }], { op: 'replace', startSeq: 1, endSeq: 2 }))
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
  })

  it('keeps non-JSON tool arguments raw and bounds nested values', () => {
    const test = harness({ maxStringBytes: 11 }, 's1')
    test.emitSession({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'raw', name: 'bash', arguments: 'not json' },
    } as unknown as SessionEvent)
    test.emitSession({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'nested',
        name: 'bash',
        arguments: JSON.stringify({ items: ['éééééé', null, true], n: 1 }),
      },
    } as unknown as SessionEvent)
    const events = test.parsed()
    expect(events[1]).toEqual({ type: 'tool_call', callId: 'raw', tool: 'bash', input: 'not json' })
    expect(events[2]).toEqual({
      type: 'tool_call',
      callId: 'nested',
      tool: 'bash',
      input: { items: ['ééééé', null, true], n: 1 },
      truncated: true,
    })
  })

  it('keeps raw arguments that JSON cannot round-trip, such as an overflowing number', () => {
    const test = harness({}, 's1')
    test.emitSession({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'inf', name: 'bash', arguments: '{"n":1e400}' },
    } as unknown as SessionEvent)
    expect(test.parsed()[1]).toEqual({ type: 'tool_call', callId: 'inf', tool: 'bash', input: '{"n":1e400}' })
  })

  it('keeps a literal __proto__ key and bounds over-long object keys', () => {
    const proto = harness({ maxStringBytes: 32 }, 's1')
    proto.emitSession({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'p',
        name: 'bash',
        arguments: '{"__proto__":{"polluted":true},"a":1}',
      },
    } as unknown as SessionEvent)
    const protoInput = proto.parsed()[1]?.input as Record<string, unknown>
    expect(Object.keys(protoInput)).toEqual(['__proto__', 'a'])
    expect(protoInput['__proto__']).toEqual({ polluted: true })

    const longKey = harness({ maxStringBytes: 8 }, 's1')
    longKey.emitSession({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'k',
        name: 'bash',
        arguments: JSON.stringify({ ['k'.repeat(20)]: 1 }),
      },
    } as unknown as SessionEvent)
    const longEvent = longKey.parsed()[1] as { input: Record<string, unknown>; truncated?: boolean }
    expect(Object.keys(longEvent.input)).toEqual(['kkkkkkkk'])
    expect(longEvent.truncated).toBe(true)
  })

  it('drops a split trailing multibyte character when truncating', () => {
    const test = harness({ maxStringBytes: 5 }, 's1')
    test.emitSession(assistantMessage([{ type: 'text', text: 'ééé' }]))
    expect(test.parsed()[1]).toEqual({ type: 'text', text: 'éé', truncated: true })
  })

  it('normalizes empty tool arguments to an empty object like the executor', () => {
    const test = harness({}, 's1')
    test.emitSession({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'empty', name: 'bash', arguments: '' },
    } as unknown as SessionEvent)
    expect(test.parsed()[1]).toEqual({ type: 'tool_call', callId: 'empty', tool: 'bash', input: {} })
  })

  it('bounds one whole event line, dropping structured fields before scalars', () => {
    const input = Array.from({ length: 20_000 }, (_, index) => index)
    const line = boundJsonLine({ type: 'tool_call', callId: 'c', tool: 'bash', input }, MAX_STRING_BYTES, 1024)
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1024)
    expect(JSON.parse(line)).toEqual({ type: 'tool_call', callId: 'c', tool: 'bash', truncated: true })
  })

  it('reduces a payload to its type when even its scalars exceed the line cap', () => {
    const line = boundJsonLine({ type: 'text', text: 'x'.repeat(2000) }, 4096, 64)
    expect(JSON.parse(line)).toEqual({ type: 'text', truncated: true })
    expect(JSON.parse(boundJsonLine({ type: 'text', text: 'ok' }))).toEqual({ type: 'text', text: 'ok' })
  })

  it('caps an error line even when control characters expand under JSON escaping', () => {
    const line = boundJsonLine({ type: 'error', message: '\u0000'.repeat(MAX_STRING_BYTES) })
    expect(Buffer.byteLength(line, 'utf8') + 1).toBeLessThanOrEqual(32 * 1024)
    expect(JSON.parse(line)).toEqual({ type: 'error', truncated: true })
  })

  it('reserves the trailing newline inside the whole-line cap', () => {
    // A 64-byte line exactly fills a 64-byte cap; the writer's newline must
    // force the scalar fallback rather than write 65 bytes.
    const line = boundJsonLine({ type: 'text', text: 'x'.repeat(39) }, 4096, 64)
    expect(Buffer.byteLength(line, 'utf8') + 1).toBeLessThanOrEqual(64)
    expect(JSON.parse(line)).toEqual({ type: 'text', truncated: true })
  })

  it('cuts a payload that nests past the depth budget instead of overflowing the stack', () => {
    let deepArray: unknown = 'leaf'
    for (let level = 0; level < 200; level += 1) deepArray = [deepArray]
    expect(JSON.parse(boundJsonLine({ type: 'tool_call', input: deepArray })))
      .toMatchObject({ type: 'tool_call', truncated: true })

    let deepObject: unknown = 'leaf'
    for (let level = 0; level < 200; level += 1) deepObject = { next: deepObject }
    expect(JSON.parse(boundJsonLine({ type: 'tool_call', input: deepObject })))
      .toMatchObject({ type: 'tool_call', truncated: true })
  })

  it('sums retried attempt usage into the step total and drops an unshared bucket', () => {
    const test = harness()
    test.emitSession(attemptWithUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4 }))
    test.emitSession(assistantMessage(
      [{ type: 'text', text: 'ok' }],
      { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    ))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({
      type: 'status', phase: 'step_end', turn: 1, step: 1,
      usage: { inputTokens: 13, outputTokens: 3, totalTokens: 16 },
    })
  })

  it('sums every optional bucket both attempts report', () => {
    const test = harness()
    const sample = {
      inputTokens: 2, outputTokens: 1, totalTokens: 3,
      cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1,
    }
    test.emitSession(attemptWithUsage(sample))
    test.emitSession(attemptWithUsage(sample))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toMatchObject({
      usage: {
        inputTokens: 4, outputTokens: 2, totalTokens: 6,
        cacheReadTokens: 2, cacheWriteTokens: 2, reasoningTokens: 2,
      },
    })
  })

  it('drops a bucket only the later attempt reports', () => {
    const test = harness()
    test.emitSession(attemptWithUsage({ inputTokens: 1, outputTokens: 1 }))
    test.emitSession(attemptWithUsage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 2 }))
    test.emitSession(stepEnd())
    const usage = (test.parsed().at(-1) as { usage: Record<string, unknown> }).usage
    expect(usage).toEqual({ inputTokens: 2, outputTokens: 2 })
    expect(usage).not.toHaveProperty('cacheWriteTokens')
  })

  it('reads a message usage sample from its stream when the field is absent', () => {
    const test = harness()
    test.emitSession({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } }],
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent)
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toMatchObject({ usage: { inputTokens: 5, outputTokens: 1 } })
  })

  it('omits the step total when a later attempt reports no usage sample', () => {
    const test = harness()
    test.emitSession(attemptWithUsage({ inputTokens: 7, outputTokens: 3 }))
    test.emitSession(assistantMessage([{ type: 'text', text: 'ok' }]))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
  })

  it('omits the step total when an earlier attempt reports no usage sample', () => {
    const test = harness()
    test.emitSession({
      type: 'assistant/attempt',
      data: { turn: 1, step: 1, stream: [] },
    } as unknown as SessionEvent)
    test.emitSession(assistantMessage([{ type: 'text', text: 'ok' }], { inputTokens: 1, outputTokens: 1 }))
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
  })

  it('omits the step total when no attempt reports a usage sample', () => {
    const test = harness()
    test.emitSession(stepEnd())
    expect(test.parsed().at(-1)).toEqual({ type: 'status', phase: 'step_end', turn: 1, step: 1 })
  })

  it('writes the terminal final event without bounding its answer', () => {
    const test = harness({ maxStringBytes: 4 })
    test.projection.finish('abcdefgh')
    expect(test.parsed().at(-1)).toEqual({ type: 'final', text: 'abcdefgh' })
  })

  it('ignores events from another Session and stops writing after dispose', () => {
    const test = harness()
    test.emitRawSession({}, assistantMessage([{ type: 'text', text: 'foreign' }]))
    test.projection.dispose()
    test.emitSession(assistantMessage([{ type: 'text', text: 'late' }]))
    test.projection.finish('ignored')
    expect(test.parsed().map(event => event.type)).toEqual(['session'])
  })

  it('bounds one projected payload through the line writer', () => {
    expect(JSON.parse(boundJsonLine({ type: 'error', message: 'x'.repeat(20) }, 8, 4096)))
      .toEqual({ type: 'error', message: 'xxxxxxxx', truncated: true })
    expect(JSON.parse(boundJsonLine({ type: 'error', message: 'ok' }))).toEqual({ type: 'error', message: 'ok' })
  })
})
