import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import LlmRuntime, {
  AssistantStreamAccumulator,
  BlockAssembler,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  GenerateOptions,
  LlmAdapter,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  type Config,
  type ReplayEntry,
  type SessionScript,
  apply,
  deriveReplayScript,
  inject,
  installLlmReplay,
  loadReplayScript,
  loadSessionScripts,
  name,
  parseSessionHeader,
  parseSessionLog,
  prepareSessionEventNotificationsForComparison,
  prepareSessionSnapshotFixtureForComparison,
  resolveScriptedEntry,
} from '../src/index.ts'

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    test_replay: { readonly version: 1 }
  }
}

/**
 * Unit tests for the replay llm/stream plugin. These drive the listener through
 * the REAL LlmRuntime waterfall (not a hand-rolled stub) so they verify the
 * actual LLM capability seam the snapshot harness depends on, plus the pure
 * derive/parse/load helpers that turn a recorded session JSONL into a script.
 */

const TEXT_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const COMPACTION_ID = CompactionId('replay-compaction')

/** Build a minimal session-JSONL string: a header line + the given events. */
function sessionJsonl(
  events: SessionEvent[],
  header?: { id?: string; createdAt?: number; seedLength?: number; version?: 0 | 1 | 2 },
): string {
  const version = header?.version ?? 0
  const headerLine = JSON.stringify({
    type: 'session',
    version,
    id: header?.id ?? 's1',
    createdAt: header?.createdAt ?? 0,
    ...version === 2 ? { isSeeded: false } : {},
    ...header?.seedLength !== undefined ? { seedLength: header.seedLength } : {},
    delegationDepth: 0,
  })
  return [headerLine, ...events.map(event => JSON.stringify(event))].join('\n') + '\n'
}

/** Build a valid one-turn Session around recorded model calls. */
function replaySessionJsonl(
  calls: readonly StreamChunk[][],
  header?: { id?: string; createdAt?: number; seedLength?: number; version?: 0 | 1 | 2 },
): string {
  const version = header?.version ?? 2
  const events: SessionEvent[] = []
  let seq = 0
  const push = (type: string, data: SessionEvent['data']): void => {
    events.push({ type, seq: SessionSeq(seq++), time: 0, data } as SessionEvent)
  }
  push('turn/start', { turn: 1 })
  for (const [index, chunks] of calls.entries()) {
    const step = index + 1
    push('step/start', { turn: 1, step })
    if (version === 2) {
      events.push(streamEvent(seq++, 1, step, chunks))
      for (const chunk of chunks) {
        if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') continue
        push('tool/call', {
          turn: 1,
          step,
          callId: chunk.block.id,
          name: chunk.block.name,
          arguments: chunk.block.arguments,
        })
        events.push({
          type: 'tool/result',
          seq: SessionSeq(seq++),
          time: 0,
          data: {
            turn: 1,
            step,
            message: createToolResultMessage({ callId: chunk.block.id, content: [], isError: false }),
          },
          surfaceOp: 'append',
        })
      }
    } else {
      for (const chunk of chunks) events.push(legacyChunkEvent(seq++, 1, step, chunk))
    }
    push('step/end', { turn: 1, step })
  }
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return sessionJsonl(events, { ...header, version })
}

/** Remove persistence envelopes to produce the committed snapshot projection. */
function projectSessionJsonl(complete: string): string {
  return complete.split('\n').map((line, index) => {
    if (index === 0 || line.length === 0) return line
    const { seq: _seq, time: _time, ...projected } = JSON.parse(line) as Record<string, unknown>
    return JSON.stringify(projected)
  }).join('\n')
}

/** One current durable Assistant stream event for a model attempt. */
function streamEvent(
  seq: number,
  turn: number,
  step: number,
  chunks: readonly StreamChunk[],
  time0 = 1_000,
): SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'> {
  const accumulator = new AssistantStreamAccumulator()
  const assembler = new BlockAssembler()
  for (const [index, chunk] of chunks.entries()) {
    accumulator.push({ time: time0 + index * 7, chunk })
    assembler.push(chunk)
  }
  const time = time0 + Math.max(0, chunks.length - 1) * 7
  const common = {
    seq: SessionSeq(seq),
    time,
    data: { turn, step, stream: [...accumulator.snapshot()] },
  }
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish' || finish.reason.kind === 'error') {
    return { type: 'assistant/attempt', ...common }
  }
  return {
    type: 'assistant/message',
    ...common,
    data: {
      ...common.data,
      message: createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: 'mock',
          model: 'mock',
          ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
        },
      }),
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    },
    surfaceOp: 'append',
  }
}

/** One released v0/v1 raw chunk event used only at migration inputs. */
function legacyChunkEvent(seq: number, turn: number, step: number, chunk: StreamChunk): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq: SessionSeq(seq),
    time: 0,
    data: { turn, step, chunk },
  } as unknown as SessionEvent
}

let dir: string
let file: string

/** Write a session log file and return its path. */
function writeSession(filename: string, header: { id: string; createdAt: number }, calls: StreamChunk[][]): string {
  const path = join(dir, filename)
  writeFileSync(path, replaySessionJsonl(calls, header), 'utf8')
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-replay-spec-'))
  file = join(dir, 'session.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('Session format package parity', () => {
  it('refuses catalog and Session version skew at module load', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-session-format-catalog', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-format-catalog')>()
      return {
        ...actual,
        sessionFormatCatalog: {
          ...actual.sessionFormatCatalog,
          currentVersion: SESSION_FORMAT_VERSION + 1,
        },
      }
    })
    try {
      await expect(import('../src/index.ts'))
        .rejects.toThrow(`format catalog v${SESSION_FORMAT_VERSION + 1} does not match Session v${SESSION_FORMAT_VERSION}`)
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-session-format-catalog')
      vi.resetModules()
    }
  })
})

describe('fixture format diagnostics', () => {
  it('attaches the header line to a restore-construction failure', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-session-format-catalog', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-format-catalog')>()
      return {
        ...actual,
        sessionFormatCatalog: {
          ...actual.sessionFormatCatalog,
          createRestore(): never {
            const failure: unknown = 'decoder exploded'
            throw failure
          },
        },
      }
    })
    try {
      const replay = await import('../src/index.ts')

      expect(() => replay.parseSessionLog(sessionJsonl([])))
        .toThrow('session snapshot line 1: decoder exploded')
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-session-format-catalog')
      vi.resetModules()
    }
  })

  it('attaches the header line to a restore-finalization failure', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-session-format-catalog', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-format-catalog')>()
      return {
        ...actual,
        sessionFormatCatalog: {
          ...actual.sessionFormatCatalog,
          createRestore() {
            return {
              header: { version: 2, id: 'fixture', createdAt: 0, isSeeded: false, delegationDepth: 0 },
              decodeRow() {},
              finish(): never {
                throw new Error('Session event 99 restore finalization failed')
              },
            }
          },
        },
      }
    })
    try {
      const replay = await import('../src/index.ts')

      expect(() => replay.parseSessionLog(sessionJsonl([])))
        .toThrow('session snapshot line 1: Session event 99 restore finalization failed')
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-session-format-catalog')
      vi.resetModules()
    }
  })

  it('falls back to the header when a source-range diagnostic has no matching physical prefix', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-session-format-catalog', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-format-catalog')>()
      return {
        ...actual,
        sessionFormatCatalog: {
          ...actual.sessionFormatCatalog,
          createRestore() {
            return {
              header: { version: 2, id: 'fixture', createdAt: 0, isSeeded: false, delegationDepth: 0 },
              decodeRow() {},
              finish(): never {
                throw new Error('sourceEventSeqs synthetic unmatched failure')
              },
            }
          },
        },
      }
    })
    try {
      const replay = await import('../src/index.ts')

      expect(() => replay.parseSessionLog(sessionJsonl([])))
        .toThrow('session snapshot line 1: sourceEventSeqs synthetic unmatched failure')
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-session-format-catalog')
      vi.resetModules()
    }
  })

  it('maps a non-Error row failure to its physical row', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-session-format-catalog', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-format-catalog')>()
      let row = 0
      return {
        ...actual,
        sessionFormatCatalog: {
          ...actual.sessionFormatCatalog,
          createRestore() {
            return {
              header: { version: 2, id: 'fixture', createdAt: 0, isSeeded: false, delegationDepth: 0 },
              decodeRow(): void {
                row += 1
                if (row === 2) throw 'row decoder exploded'
              },
              finish(): never { throw new Error('unexpected finish') },
            }
          },
        },
      }
    })
    try {
      const replay = await import('../src/index.ts')
      const events: SessionEvent[] = [
        { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
        { type: 'permission/preset', seq: SessionSeq(1), time: 0, data: { preset: 'auto' } },
      ]

      expect(() => replay.parseSessionLog(sessionJsonl(events)))
        .toThrow('session snapshot line 3: row decoder exploded')
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-session-format-catalog')
      vi.resetModules()
    }
  })

  it.each([
    ['physical row', 'released Session row 0 is malformed', 2],
    ['logical event', 'Session event 0 is malformed', 2],
    ['event seq', 'format v1 contains an invalid event at seq 0', 2],
    ['inherited cut', 'inherited Session cut 0 splits one Assistant attempt', 2],
    ['out-of-range physical row', 'released Session row 99 is malformed', 1],
    ['out-of-range logical event', 'Session event 99 is malformed', 1],
  ])('maps a %s finalization diagnostic to its source line', async (_label, message, line) => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-session-format-catalog', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-format-catalog')>()
      return {
        ...actual,
        sessionFormatCatalog: {
          ...actual.sessionFormatCatalog,
          createRestore() {
            return {
              header: { version: 2, id: 'fixture', createdAt: 0, isSeeded: false, delegationDepth: 0 },
              decodeRow() {},
              finish(): never { throw new Error(message) },
            }
          },
        },
      }
    })
    try {
      const replay = await import('../src/index.ts')
      const event: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }

      expect(() => replay.parseSessionLog(sessionJsonl([event])))
        .toThrow(`session snapshot line ${line}: ${message}`)
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-session-format-catalog')
      vi.resetModules()
    }
  })
})

describe('parseSessionLog', () => {
  it('reports invalid JSON at its physical source line', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })

    expect(() => parseSessionLog(`${header}\n{"type":\n`))
      .toThrow('session snapshot line 2 contains invalid JSON')
  })

  it('skips the header line and parses each event', () => {
    const events: SessionEvent[] = [{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }]
    expect(parseSessionLog(sessionJsonl(events))).toEqual(events)
  })

  it('ignores blank lines', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const ev: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }
    expect(parseSessionLog(`${header}\n\n${JSON.stringify(ev)}\n\n`)).toEqual([ev])
  })

  it('expands range-encoded source provenance', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const events = Array.from({ length: 5 }, (_, seq) => ({
      type: 'user/message',
      seq,
      time: 0,
      data: { role: 'user', id: `message-${seq}`, content: [], source: { kind: 'user' } },
      surfaceOp: 'append',
      ...(seq === 4 ? { sourceEventSeqs: [[0, 2], 3] } : {}),
    }))
    const parsed = parseSessionLog(`${header}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`)
    expect(parsed[4]).toEqual({ ...events[4], sourceEventSeqs: [0, 1, 2, 3] })
  })

  it('reports malformed range provenance with its source line', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const events = Array.from({ length: 5 }, (_, seq) => ({
      type: 'user/message',
      seq,
      time: 0,
      data: { role: 'user', id: `message-${seq}`, content: [], source: { kind: 'user' } },
      surfaceOp: 'append',
      ...(seq === 4 ? { sourceEventSeqs: [[3, 1]] } : {}),
    }))
    expect(() => parseSessionLog(`${header}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`))
      .toThrow(/session snapshot line 6: sourceEventSeqs range/)
  })

  it('locates malformed range provenance with a materialized v0 seedLength header', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0, seedLength: 0 })
    const events = Array.from({ length: 3 }, (_, seq) => ({
      type: 'user/message',
      seq,
      time: 0,
      data: { role: 'user', id: `message-${seq}`, content: [], source: { kind: 'user' } },
      surfaceOp: 'append',
      ...(seq === 2 ? { sourceEventSeqs: [[2, 1]] } : {}),
    }))

    expect(() => parseSessionLog(`${header}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`))
      .toThrow(/session snapshot line 4: sourceEventSeqs range/)
  })

  it('rejects non-object body rows with their source line', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    expect(() => parseSessionLog(`${header}\nnull\n`))
      .toThrow('session snapshot line 2 must be a JSON object')
  })

  it('rejects partial and mixed projected envelopes at their source lines', () => {
    const header = JSON.stringify({
      type: 'session', version: 0, id: 's1', createdAt: 0, delegationDepth: 0,
    })
    const partial = JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } })
    expect(() => parseSessionLog(`${header}\n${partial}\n`))
      .toThrow('session snapshot line 2 must contain both seq and time, or neither')

    const projected = JSON.stringify({ type: 'turn/start', data: { turn: 1 } })
    const complete = JSON.stringify({ type: 'permission/preset', seq: 1, time: 0, data: { preset: 'auto' } })
    expect(() => parseSessionLog(`${header}\n${projected}\n${complete}\n`))
      .toThrow('session snapshot line 3 cannot mix projected and complete body rows')
  })

  it('expands a packed chunk row into its events (a fixture recorded with packChunks on)', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const turn = JSON.stringify({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    const step = JSON.stringify({ type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } })
    const row = JSON.stringify({
      type: 'text-chunks', seq0: 2, time0: 0,
      data: { turn: 1, step: 1, index: 0, dt: [0, 0], texts: ['a', 'b', 'c'] },
    })
    expect(parseSessionLog(`${header}\n${turn}\n${step}\n${row}\n`).slice(2)).toEqual([{
      type: 'assistant/attempt',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [0, 0], texts: ['a', 'b', 'c'] }],
      },
    }])
  })

  it('synthesizes omitted ordinary and packed snapshot envelopes', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 7 })
    const ordinary = JSON.stringify({ type: 'turn/start', data: { turn: 1 } })
    const step = JSON.stringify({ type: 'step/start', data: { turn: 1, step: 1 } })
    const packed = JSON.stringify({
      type: 'text-chunks',
      data: { turn: 1, step: 1, index: 0, dt: [3], texts: ['a', 'b'] },
    })
    expect(parseSessionLog(`${header}\n${ordinary}\n${step}\n${packed}\n`)).toEqual([
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/attempt',
        seq: 2,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [3], texts: ['a', 'b'] }],
        },
      },
    ])
  })

  it('materializes tokenized request tools before released-format validation', () => {
    const source = [
      JSON.stringify({ type: 'session', version: 0, id: 'tokens', createdAt: 7, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({
        type: 'request/header',
        data: {
          header: { config: { provider: 'mock', model: 'mock' }, system: '{{system}}', tools: '{{tools}}' },
          reason: 'initial',
        },
      }),
    ].join('\n')

    expect(parseSessionLog(source)[1]).toMatchObject({
      type: 'request/header',
      data: { header: { system: '{{system}}', tools: [] } },
    })
  })

  it('materializes Python snapshot tool-name projections before format validation', () => {
    const source = [
      JSON.stringify({ type: 'session', version: 0, id: 'tool-names', createdAt: 7, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({
        type: 'request/header',
        data: {
          header: { config: { provider: 'mock', model: 'mock' }, tools: ['bash', 'workflow'] },
          reason: 'initial',
        },
      }),
    ].join('\n')

    expect(parseSessionLog(source)[1]).toMatchObject({
      type: 'request/header',
      data: { header: { tools: [
        { name: 'bash', description: '', parameters: {} },
        { name: 'workflow', description: '', parameters: {} },
      ] } },
    })
  })

  it.each([
    ['non-object request data', null],
    ['non-object request header', { header: [] }],
    ['unsupported tools projection', { header: { tools: [42] } }],
  ])('keeps %s unchanged so released-format validation rejects its source line', (_name, data) => {
    const source = [
      JSON.stringify({ type: 'session', version: 0, id: 'malformed-request', createdAt: 7, delegationDepth: 0 }),
      JSON.stringify({ type: 'request/header', data }),
    ].join('\n')

    expect(() => parseSessionLog(source)).toThrow(/session snapshot line 2:/)
  })

  it('synthesizes projected tool-call chunk envelopes from their argument count', () => {
    const callId = ToolCallId('call-1')
    const source = [
      JSON.stringify({ type: 'session', version: 0, id: 'packed-tool', createdAt: 0 }),
      JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', data: { turn: 1, step: 1 } }),
      JSON.stringify({
        type: 'tool-call-chunks',
        data: { turn: 1, step: 1, index: 0, id: 'call-1', name: 'read', dt: [0], args: ['{', '}'] },
      }),
    ].join('\n')

    expect(parseSessionLog(source).slice(2)).toEqual([{
      type: 'assistant/attempt',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        stream: [{
          type: 'tool-call-chunks',
          time0: 0,
          index: 0,
          dt: [0],
          id: callId,
          name: 'read',
          args: ['{', '}'],
        }],
      },
    }])
  })

  it.each([
    ['non-object packed data', { type: 'text-chunks', data: null }],
    ['empty packed payload', {
      type: 'text-chunks',
      data: { turn: 1, step: 1, index: 0, dt: [], texts: [] },
    }],
  ])('reports %s at its one synthesized event line', (_name, row) => {
    const source = [
      JSON.stringify({ type: 'session', version: 0, id: 'malformed-packed', createdAt: 0 }),
      JSON.stringify(row),
    ].join('\n')

    expect(() => parseSessionLog(source)).toThrow(/session snapshot line 2:/)
  })

  it('migrates projected v0 legacy messages through the released catalog before returning events', () => {
    const source = [
      JSON.stringify({ type: 'session', version: 0, id: 'legacy', createdAt: 7, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({ type: 'step/start', data: { turn: 1, step: 1 } }),
      JSON.stringify({
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          content: [{ type: 'text', text: 'migrated' }],
          provenance: { provider: 'mock', model: 'mock' },
        },
        surfaceOp: 'append',
      }),
    ].join('\n')

    expect(parseSessionLog(source)[2]).toEqual({
      type: 'assistant/message',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'legacy-message:legacy:2',
          role: 'assistant',
          content: [{ type: 'text', text: 'migrated' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
        stream: [],
      },
      surfaceOp: 'append',
    })
  })

  it('takes the direct v1 path and rejects v0-only message fields', () => {
    const current = projectSessionJsonl(replaySessionJsonl([TEXT_CHUNKS], { version: 1 }))
    expect(deriveReplayScript(parseSessionLog(current))).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])

    const source = [
      JSON.stringify({ type: 'session', version: 1, id: 'current', createdAt: 7, delegationDepth: 0 }),
      JSON.stringify({
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          content: [{ type: 'text', text: 'legacy-only' }],
          provenance: { provider: 'mock', model: 'mock' },
        },
        surfaceOp: 'append',
      }),
    ].join('\n')

    expect(() => parseSessionLog(source)).toThrow(/assistant\/message.*unexpected member "content"/)
  })

  it('refuses a retired v0 event through the released migration policy', () => {
    const source = [
      JSON.stringify({ type: 'session', version: 0, id: 'legacy', createdAt: 7, delegationDepth: 0 }),
      JSON.stringify({ type: 'mode/set', data: { mode: 'plan' } }),
    ].join('\n')

    expect(() => parseSessionLog(source)).toThrow(/unsupported legacy mode\/set event at seq 0/)
  })
})

describe('prepareSessionSnapshotFixtureForComparison', () => {
  it('encodes a migrated fixture without inventing a trailing newline and retains its cwd token', () => {
    const projected = projectSessionJsonl(replaySessionJsonl([TEXT_CHUNKS])).trimEnd()
    const [headerLine, ...bodyLines] = projected.split('\n')
    const header = { ...(JSON.parse(headerLine!) as Record<string, unknown>), cwd: '{{cwd}}/workspace' }
    const source = [JSON.stringify(header), ...bodyLines].join('\n')

    const prepared = prepareSessionSnapshotFixtureForComparison(source)
    const [preparedHeader] = prepared.split('\n')

    expect(JSON.parse(preparedHeader!)).toMatchObject({ version: SESSION_FORMAT_VERSION, cwd: '{{cwd}}/workspace' })
    expect(prepared.endsWith('\n')).toBe(false)
  })

  it('applies current Session format validation before comparison', () => {
    const source = [
      JSON.stringify({
        type: 'session',
        version: 2,
        id: 'invalid-current',
        createdAt: 0,
        cwd: '{{cwd}}',
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
      }),
      JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({
        type: 'user/message',
        data: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Show the active reminders.' }],
          source: { kind: 'user' },
          id: 'message-1',
        },
        surfaceOp: 'append',
      }),
    ].join('\n')
    expect(() => prepareSessionSnapshotFixtureForComparison(source))
      .toThrow('message must have role "user"')
  })
})

describe('prepareSessionEventNotificationsForComparison', () => {
  const wrapHeadlessEvent = (event: Record<string, unknown>) => JSON.stringify({
    type: 'session_event', sessionId: 'session-1', event,
  })

  it('migrates a v1 notification tail while retaining non-event protocol rows', () => {
    const events = [
      { type: 'turn/start', seq: 3, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 4, time: 0, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 5, time: 5, data: {
        turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
      } },
      { type: 'assistant/chunk', seq: 6, time: 6, data: {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'done' },
      } },
      { type: 'assistant/chunk', seq: 7, time: 7, data: {
        turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      } },
      { type: 'assistant/chunk', seq: 8, time: 8, data: {
        turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } },
      } },
      { type: 'assistant/message', seq: 9, time: 9, data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          id: 'message-1',
        },
      }, sourceEventSeqs: [5, 6, 7, 8], surfaceOp: 'append' },
      { type: 'step/end', seq: 10, time: 10, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 11, time: 11, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const source = [
      ...events.map(event => ({ type: 'session_event', sessionId: 'session-1', event })),
      { type: 'session_event', sessionId: 'session-1', event: {
        type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } },
      } },
      { type: 'session_event', sessionId: 'session-1', event: {
        type: 'feedback/record', seq: 12, time: 13, data: { text: 'resumed parent' },
      } },
      { type: 'result', status: 'completed' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n'

    const prepared = prepareSessionEventNotificationsForComparison(source)
    const rows = prepared.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const migrated = rows.flatMap((row) => {
      const event = row['event']
      return event !== null && typeof event === 'object' ? [event] : []
    })

    expect(migrated.some(event => 'type' in event && event.type === 'assistant/chunk')).toBe(false)
    expect(migrated.find(event => 'type' in event && event.type === 'assistant/message')).toMatchObject({
      seq: 5,
      data: { stream: expect.any(Array) as unknown },
    })
    expect(rows.at(-1)).toEqual({ type: 'result', status: 'completed' })
    expect(prepared.endsWith('\n')).toBe(true)
  })

  it('leaves a current notification stream byte-identical', () => {
    const current = `${JSON.stringify({
      method: 'session.event',
      params: {
        sessionId: 'session-1',
        event: { type: 'assistant/attempt', seq: 0, time: 0, data: { turn: 1, step: 1, stream: [] } },
      },
    })}\n`

    expect(prepareSessionEventNotificationsForComparison(current)).toBe(current)
  })

  it('omits generation-dependent delivery cursors', () => {
    const source = `${JSON.stringify({
      method: 'session.event',
      params: {
        sessionId: 'session-1',
        event: {
          type: 'session-log-deepseek/delivery-accepted',
          seq: 3,
          time: 0,
          data: { sessionId: 'source-1', sessionFormatVersion: 1, throughSeq: 21 },
        },
      },
    })}\n`

    expect(JSON.parse(prepareSessionEventNotificationsForComparison(source))).toMatchObject({
      params: { event: { data: { sessionId: 'source-1' } } },
    })
  })

  it.each([
    { tools: '{{tools}}', expected: '{{tools}}' },
    { tools: ['read'], expected: [{ name: 'read', description: '', parameters: {} }] },
  ])('migrates a projected request header with tools $tools', ({ tools, expected }) => {
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
      {
        type: 'request/header',
        seq: 2,
        time: 0,
        data: {
          header: {
            config: { provider: 'fixture', model: 'fixture' },
            system: '{{system}}',
            tools,
          },
          reason: 'initial',
        },
      },
      {
        type: 'assistant/chunk',
        seq: 3,
        time: 0,
        data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      },
      { type: 'step/end', seq: 4, time: 0, data: { turn: 1, step: 1 } },
    ]
    const source = events.map(event => JSON.stringify({
      type: 'session_event',
      sessionId: 'session-1',
      event,
    })).join('\n')

    const rows = prepareSessionEventNotificationsForComparison(source).split('\n')
      .map(line => JSON.parse(line) as { event: Record<string, unknown> })
    const request = rows.find(row => row.event['type'] === 'request/header') as {
      event: { data: { header: { tools: unknown } } }
    }

    expect(request.event.data.header.tools).toEqual(expected)
    expect(rows.some(row => row.event['type'] === 'assistant/chunk')).toBe(false)
    expect(rows.some(row => row.event['type'] === 'assistant/attempt')).toBe(true)
  })

  it('assigns an unterminated final chunk group to its last source row', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/chunk',
        seq: 2,
        time: 0,
        data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      },
    ]
    const source = events.map(event => JSON.stringify({
      method: 'session.event',
      params: { sessionId: 'session-1', event },
    })).join('\n')

    const rows = prepareSessionEventNotificationsForComparison(source).split('\n')
      .map(line => JSON.parse(line) as { params: { event: Record<string, unknown> } })

    expect(rows).toHaveLength(3)
    expect(rows.at(-1)?.params.event['type']).toBe('assistant/attempt')
    expect(prepareSessionEventNotificationsForComparison('{"type":"result"}')).toBe('{"type":"result"}')
  })

  it('keeps malformed SDK wrappers and delivery payloads outside migration unchanged', () => {
    const rows = [
      { method: 'session.event', params: { sessionId: 7, event: {} } },
      { method: 'session.event', params: { sessionId: 'session-1' } },
      {
        method: 'session.event',
        params: {
          sessionId: 'session-1',
          event: { type: 'session-log-deepseek/delivery-accepted', seq: 0, time: 0, data: null },
        },
      },
    ]
    const source = rows.map(row => JSON.stringify(row)).join('\n')

    expect(prepareSessionEventNotificationsForComparison(source)).toBe(source)
  })

  it('rejects malformed notification rows and invalid v1 tails before migration', () => {
    expect(() => prepareSessionEventNotificationsForComparison('null'))
      .toThrow('session event comparison line 1 must be an object')

    expect(() => prepareSessionEventNotificationsForComparison(wrapHeadlessEvent({
      type: 'assistant/chunk', seq: -1, time: 0, data: {},
    }))).toThrow('session event comparison requires a non-negative first seq')
    expect(() => prepareSessionEventNotificationsForComparison([
      wrapHeadlessEvent({ type: 'assistant/chunk', seq: 0, time: 0, data: {} }),
      wrapHeadlessEvent({ type: 7, seq: 1, time: 0, data: {} }),
    ].join('\n'))).toThrow('session event comparison requires a contiguous event tail for session-1')
  })

  it('delegates malformed request headers to the released-format validator', () => {
    const source = [
      wrapHeadlessEvent({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }),
      wrapHeadlessEvent({ type: 'request/header', seq: 1, time: 0, data: null }),
      wrapHeadlessEvent({ type: 'assistant/chunk', seq: 2, time: 0, data: {
        turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
      } }),
    ].join('\n')

    expect(() => prepareSessionEventNotificationsForComparison(source))
      .toThrow(/request\/header 1 data must be a JSON object/)
  })
})

describe('deriveReplayScript', () => {
  it('expands one finished embedded Assistant stream into one replay entry', () => {
    const events: SessionEvent[] = [streamEvent(1, 1, 1, TEXT_CHUNKS)]
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('separates retry calls that share one turn and step at their finish chunks', () => {
    const failed: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'empty', code: 'EMPTY_RESPONSE' } } },
    ]
    const events: SessionEvent[] = [
      streamEvent(1, 1, 1, failed),
      streamEvent(2, 1, 1, TEXT_CHUNKS),
    ]
    expect(deriveReplayScript(events)).toEqual([
      { kind: 'chunks', chunks: failed },
      { kind: 'chunks', chunks: TEXT_CHUNKS },
    ])
  })

  it('produces one entry per distinct (turn, step), in log order', () => {
    const callA = TEXT_CHUNKS
    const callB: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'two' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const events: SessionEvent[] = [
      streamEvent(1, 1, 1, callA),
      streamEvent(2, 1, 2, callB), // same turn, next step
    ]
    expect(deriveReplayScript(events)).toEqual([
      { kind: 'chunks', chunks: callA },
      { kind: 'chunks', chunks: callB },
    ])
  })

  it('separates calls across turns too', () => {
    const events: SessionEvent[] = [
      streamEvent(1, 1, 1, TEXT_CHUNKS),
      streamEvent(2, 2, 1, TEXT_CHUNKS), // new turn, step resets to 1
    ]
    expect(deriveReplayScript(events)).toHaveLength(2)
  })

  it('ignores non-Assistant-stream events', () => {
    let seq = 1
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(seq++), time: 0, data: { turn: 1 } },
      streamEvent(seq++, 1, 1, TEXT_CHUNKS),
      { type: 'turn/end', seq: SessionSeq(seq++), time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('returns an empty script for a log with no Assistant stream events', () => {
    expect(deriveReplayScript([])).toEqual([])
    expect(deriveReplayScript([streamEvent(1, 1, 1, [])])).toEqual([])
  })

  it('keeps a finish-error chunk in the derived entry (replays naturally)', () => {
    const errChunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } },
    ]
    const events = [streamEvent(1, 1, 1, errChunks)]
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: errChunks }])
  })

  it('inserts compaction/summary output between the calls surrounding it', () => {
    const overflow: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'too large', code: 'CONTEXT_WINDOW_EXCEEDED' } } },
    ]
    const block = { type: 'text' as const, text: 'durable checkpoint' }
    const rawOutput = [block]
    const usage = { inputTokens: 9, outputTokens: 2 }
    const summaryChunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block },
      { type: 'usage', usage },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    let seq = 1
    const events: SessionEvent[] = [
      streamEvent(seq++, 1, 2, overflow),
      {
        type: 'compaction/start',
        seq: SessionSeq(seq++),
        time: 0,
        data: { compactionId: COMPACTION_ID, turn: 1 },
      },
      {
        type: 'compaction/summary',
        seq: SessionSeq(seq++),
        time: 0,
        data: {
          compactionId: COMPACTION_ID,
          summary: rawOutput,
          rawOutput,
          llmStreamCall: true,
          shadowedRange: { start: SessionSeq(1), end: SessionSeq(1) },
          shadowedSeqs: [SessionSeq(1)],
          shadowedTokenCount: 20,
          provider: 'mock',
          model: 'mock',
          usage,
        },
      },
      streamEvent(seq++, 1, 2, TEXT_CHUNKS),
    ]

    expect(deriveReplayScript(events)).toEqual([
      { kind: 'chunks', chunks: overflow },
      { kind: 'chunks', chunks: summaryChunks },
      { kind: 'chunks', chunks: TEXT_CHUNKS },
    ])
  })

  it('does not infer an LLM call from compaction/summary without raw output', () => {
    const event: SessionEvent<'compaction/summary'> = {
      type: 'compaction/summary',
      seq: SessionSeq(1),
      time: 0,
      data: {
        compactionId: COMPACTION_ID,
        summary: [{ type: 'text', text: 'template result' }],
        shadowedRange: { start: SessionSeq(1), end: SessionSeq(1) },
        shadowedSeqs: [SessionSeq(1)],
        shadowedTokenCount: 20,
        provider: 'template',
        model: 'template',
      },
    }

    expect(deriveReplayScript([event])).toEqual([])
  })

  it('does not infer a local LLM call from external compact output', () => {
    const block = { type: 'text' as const, text: 'remote summary' }
    const event: SessionEvent<'compaction/summary'> = {
      type: 'compaction/summary',
      seq: SessionSeq(1),
      time: 0,
      data: {
        compactionId: COMPACTION_ID,
        summary: [block],
        rawOutput: [block],
        shadowedRange: { start: SessionSeq(1), end: SessionSeq(1) },
        shadowedSeqs: [SessionSeq(1)],
        shadowedTokenCount: 20,
        provider: 'remote',
        model: 'remote',
      },
    }

    expect(deriveReplayScript([event])).toEqual([])
  })

  it('rejects a durable compact stream marker whose complete output is absent', () => {
    const event = {
      type: 'compaction/summary',
      seq: SessionSeq(1),
      time: 0,
      data: { llmStreamCall: true },
    } as unknown as SessionEvent

    expect(() => deriveReplayScript([event]))
      .toThrow('llm-replay: compaction/summary marks an LLM stream call without rawOutput')
  })

  it('rejects a persisted marked compact LLM call without its complete output', () => {
    const source = [
      JSON.stringify({
        type: 'session', version: 0, id: 'invalid-compact', createdAt: 0, delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'user/message', seq: 0, time: 0,
        data: { role: 'user', id: 'source', content: [], source: { kind: 'user' } },
        surfaceOp: 'append',
      }),
      JSON.stringify({
        type: 'compaction/start', seq: 1, time: 0,
        data: { compactionId: COMPACTION_ID, turn: 1 },
      }),
      JSON.stringify({
        type: 'compaction/summary',
        seq: 2,
        time: 0,
        data: {
          compactionId: COMPACTION_ID,
          summary: [{ type: 'text', text: 'missing source events' }],
          llmStreamCall: true,
          shadowedRange: { start: 0, end: 0 },
          shadowedSeqs: [0],
          shadowedTokenCount: 20,
          provider: 'mock',
          model: 'mock',
        },
      }),
    ].join('\n')

    expect(() => parseSessionLog(source)).toThrow(/llmStreamCall requires rawOutput/)
  })

  it('derives a compaction/summary stream when usage is unavailable', () => {
    const block = { type: 'text' as const, text: 'summary without usage' }
    const event: SessionEvent<'compaction/summary'> = {
      type: 'compaction/summary',
      seq: SessionSeq(1),
      time: 0,
      data: {
        compactionId: COMPACTION_ID,
        summary: [block],
        rawOutput: [block],
        llmStreamCall: true,
        shadowedRange: { start: SessionSeq(1), end: SessionSeq(1) },
        shadowedSeqs: [SessionSeq(1)],
        shadowedTokenCount: 20,
        provider: 'mock',
        model: 'mock',
      },
    }

    expect(deriveReplayScript([event])).toEqual([{
      kind: 'chunks',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    }])
  })

  it('throws on a group that lacks a terminal finish chunk (a thrown stream)', () => {
    // A thrown stream(): prefix chunks logged, then turn/end (error reason), NO finish.
    const events: SessionEvent[] = [
      streamEvent(1, 1, 1, [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'par' },
      ]),
      { type: 'turn/end', seq: SessionSeq(3), time: 0, data: { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } } },
    ]
    expect(() => deriveReplayScript(events)).toThrow(/without a finish chunk.*replay\.override\.json/s)
  })

  it('names the offending (turn, step) when a group is incomplete', () => {
    const events: SessionEvent[] = [
      streamEvent(1, 2, 3, [{ type: 'block-start', index: 0, blockType: 'text' }]),
    ]
    expect(() => deriveReplayScript(events)).toThrow(/2\/3/)
  })

  it('rejects an unfinished call before consuming chunks from a new step', () => {
    const events: SessionEvent[] = [
      streamEvent(1, 1, 1, [{ type: 'block-start', index: 0, blockType: 'text' }]),
      streamEvent(2, 1, 2, [{ type: 'finish', reason: { kind: 'stop' } }]),
    ]
    expect(() => deriveReplayScript(events)).toThrow(/model call 1\/1 ended without a finish chunk/)
  })

  it('rejects an unfinished call at a compact summary boundary', () => {
    const events: SessionEvent[] = [
      streamEvent(1, 1, 1, [{ type: 'block-start', index: 0, blockType: 'text' }]),
      {
        type: 'compaction/summary',
        seq: SessionSeq(2),
        time: 0,
        data: {
          compactionId: COMPACTION_ID,
          summary: [{ type: 'text', text: 'external checkpoint' }],
          shadowedRange: { start: SessionSeq(1), end: SessionSeq(1) },
          shadowedSeqs: [SessionSeq(1)],
          shadowedTokenCount: 20,
          provider: 'external',
          model: 'external',
        },
      },
    ]

    expect(() => deriveReplayScript(events)).toThrow(/model call 1\/1 ended without a finish chunk/)
  })
})

describe('loadReplayScript', () => {
  it('derives from the session JSONL when no override is present', () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    expect(loadReplayScript({ file })).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('never rewrites a projected source fixture while migrating it in memory', () => {
    const source = projectSessionJsonl(replaySessionJsonl([TEXT_CHUNKS]))
    writeFileSync(file, source, 'utf8')

    expect(loadReplayScript({ file })).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
    expect(JSON.parse(prepareSessionSnapshotFixtureForComparison(source).split('\n')[0] as string)).toMatchObject({ version: 2 })
    expect(readFileSync(file, 'utf8')).toBe(source)
  })

  it('uses the sidecar override when present, ignoring the JSONL', () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const override: ReplayEntry[] = [{ kind: 'throw', chunks: [], message: '401', code: 'AUTH' }]
    writeFileSync(overrideFile, JSON.stringify(override), 'utf8')
    expect(loadReplayScript({ file, overrideFile })).toEqual(override)
  })

  it('uses a whole-script override reused as the primary fixture path', () => {
    const overrideFile = join(dir, 'replay.override.json')
    const override: ReplayEntry[] = [{ kind: 'hang' }]
    writeFileSync(overrideFile, JSON.stringify(override), 'utf8')

    expect(loadReplayScript({ file: overrideFile, overrideFile })).toEqual(override)
  })

  it('falls back to the JSONL when the override path is set but absent', () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    expect(loadReplayScript({ file, overrideFile: join(dir, 'nope.json') }))
      .toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('fails loud when the fixture is missing', () => {
    expect(() => loadReplayScript({ file: join(dir, 'absent.jsonl') })).toThrow(/fixture not found/)
  })

  it('rejects an override document that is neither supported form', () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, '{"not":"array"}', 'utf8')
    expect(() => loadReplayScript({ file, overrideFile })).toThrow(/document must be a ReplayEntry\[\] or \{ patches/)
  })

  it('patches form: swaps the named call index and keeps derived siblings', () => {
    const callB: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'two' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS, callB]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify({
      patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: 'transient', code: 'SERVER' } }],
    }), 'utf8')
    expect(loadReplayScript({ file, overrideFile })).toEqual([
      { kind: 'throw', chunks: [], message: 'transient', code: 'SERVER' },
      { kind: 'chunks', chunks: callB },
    ])
  })

  it('patches form: at == derived length appends (the retry-attempt slot)', () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify({
      patches: [
        { at: 0, entry: { kind: 'throw', chunks: [], message: '429', code: 'RATE_LIMIT' } },
        { at: 1, entry: { kind: 'chunks', chunks: TEXT_CHUNKS } },
      ],
    }), 'utf8')
    expect(loadReplayScript({ file, overrideFile })).toEqual([
      { kind: 'throw', chunks: [], message: '429', code: 'RATE_LIMIT' },
      { kind: 'chunks', chunks: TEXT_CHUNKS },
    ])
  })

  it('patches form: an out-of-range index fails loud with the derived length', () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify({ patches: [{ at: 2, entry: { kind: 'hang' } }] }), 'utf8')
    expect(() => loadReplayScript({ file, overrideFile })).toThrow(/patch index 2 out of range.*1 call/s)
  })

  it('validates patch and entry shapes at the file boundary', () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const invalid: Array<{ doc: unknown; message: RegExp }> = [
      { doc: null, message: /document must be/ },
      { doc: { patches: [null] }, message: /patch 0 must contain exactly at and entry/ },
      { doc: { patches: [{ at: -1, entry: { kind: 'hang' } }] }, message: /at must be a non-negative safe integer/ },
      { doc: { patches: [{ at: 1.5, entry: { kind: 'hang' } }] }, message: /at must be a non-negative safe integer/ },
      { doc: [42], message: /entry 0 must be an object/ },
      { doc: [{ kind: 'chunks', chunks: 'nope' }], message: /chunks must be an array/ },
      { doc: [{ kind: 'chunks', chunks: [], extra: true }], message: /invalid chunks-entry fields/ },
      { doc: [{ kind: 'chunks', chunks: [{ type: 'bogus' }] }], message: /known StreamChunk type/ },
      { doc: [{ kind: 'throw', chunks: [], message: 'nope', code: 'AUTH', extra: true }], message: /invalid throw-entry fields/ },
      { doc: [{ kind: 'throw', chunks: [], message: '', code: 'AUTH' }], message: /message must be a non-empty string/ },
      { doc: [{ kind: 'throw', chunks: [], message: 'nope', code: '' }], message: /code must be a non-empty string/ },
      { doc: [{ kind: 'hang', extra: true }], message: /invalid hang-entry fields/ },
      { doc: [{ kind: 'hang', readyFile: 1 }], message: /readyFile must be a non-empty string/ },
      { doc: [{ kind: 'bogus' }], message: /unknown kind/ },
    ]
    for (const { doc, message } of invalid) {
      writeFileSync(overrideFile, JSON.stringify(doc), 'utf8')
      expect(() => loadReplayScript({ file, overrideFile })).toThrow(message)
    }
  })

  it('rejects duplicate patch indexes instead of silently taking the last one', () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify({
      patches: [
        { at: 0, entry: { kind: 'hang' } },
        { at: 0, entry: { kind: 'throw', chunks: [], message: 'busy', code: 'SERVER' } },
      ],
    }), 'utf8')
    expect(() => loadReplayScript({ file, overrideFile })).toThrow(/duplicate override patch index 0/)
  })
})

describe('installLlmReplay (through the real LlmRuntime)', () => {
  function writeLog(...calls: StreamChunk[][]): void {
    writeFileSync(file, replaySessionJsonl(calls), 'utf8')
  }

  it('serves derived chunks back, short-circuiting the adapter', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    // No adapter registered for 'm' — replay must not reach it.
    installLlmReplay(ctx, { file })
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  describe('{{fromRequest:...}} substitution', () => {
    const requestMessages = [createUserMessage({
      content: [{ type: 'text' as const, text: 'stale {"goal":{"id":"goal-old"}} then {"goal":{"id":"goal-42ab"}}' }],
      source: { kind: 'user' as const },
    })]

    function scriptedCall(argumentsDelta: string): StreamChunk[] {
      return [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), name: 'update_goal', argumentsDelta },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'update_goal', arguments: argumentsDelta } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    }

    async function streamScripted(argumentsDelta: string): Promise<StreamChunk[]> {
      writeLog(TEXT_CHUNKS)
      const overrideFile = join(dir, 'replay.override.json')
      writeFileSync(overrideFile, JSON.stringify([{ kind: 'chunks', chunks: scriptedCall(argumentsDelta) }]), 'utf8')
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      installLlmReplay(ctx, { file, overrideFile })
      return drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: requestMessages }))
    }

    it('resolves the capture group from the LAST request match in every scripted string field', async () => {
      const streamed = await streamScripted('{"goal_id":"{{fromRequest:"id":"(goal-[^"]+)"}}","revision":1}')
      const delta = streamed.find(chunk => chunk.type === 'tool-call-delta')
      expect(delta).toMatchObject({ argumentsDelta: '{"goal_id":"goal-42ab","revision":1}' })
      const end = streamed.find(chunk => chunk.type === 'block-end')
      expect(end).toMatchObject({ block: { arguments: '{"goal_id":"goal-42ab","revision":1}' } })
    })

    it('substitutes the whole match when the pattern has no capture group', async () => {
      const streamed = await streamScripted('{"goal_id":"{{fromRequest:goal-[0-9a-z]+}}"}')
      const delta = streamed.find(chunk => chunk.type === 'tool-call-delta')
      expect(delta).toMatchObject({ argumentsDelta: '{"goal_id":"goal-42ab"}' })
    })

    it('keeps a trailing brace quantifier inside the pattern (terminator is the run tail)', async () => {
      const streamed = await streamScripted('{"goal_id":"{{fromRequest:goal-[0-9a-z]{4}}}"}')
      const delta = streamed.find(chunk => chunk.type === 'tool-call-delta')
      expect(delta).toMatchObject({ argumentsDelta: '{"goal_id":"goal-42ab"}' })
    })

    it('fails loud when a placeholder matches nothing in the request', async () => {
      await expect(streamScripted('{"goal_id":"{{fromRequest:task-[0-9]+}}"}'))
        .rejects.toThrow(/fromRequest.*matched nothing/)
    })

    it('fails loud on an invalid placeholder pattern', async () => {
      await expect(streamScripted('{"goal_id":"{{fromRequest:(goal-}}"}'))
        .rejects.toThrow(/fromRequest.*invalid pattern/)
    })

    it('fails loud on an unterminated placeholder', () => {
      const entry: ReplayEntry = { kind: 'chunks', chunks: scriptedCall('{"goal_id":"{{fromRequest:goal-1"}') }
      expect(() => resolveScriptedEntry(entry, requestMessages)).toThrow(/fromRequest placeholder is unterminated/)
    })

    it('returns the exact same entry when no placeholder appears', () => {
      const entry: ReplayEntry = { kind: 'chunks', chunks: TEXT_CHUNKS }
      expect(resolveScriptedEntry(entry, requestMessages)).toBe(entry)
    })

    it('skips non-string request leaves when building the corpus', () => {
      const messages = requestMessages.map(message => ({ ...message, seq: 7 })) as unknown as GenerateOptions['messages']
      const entry: ReplayEntry = { kind: 'chunks', chunks: scriptedCall('{"goal_id":"{{fromRequest:goal-42[a-z]+}}"}') }
      const resolved = resolveScriptedEntry(entry, messages)
      if (resolved.kind !== 'chunks') throw new Error('expected chunks entry')
      expect(resolved.chunks[1]).toMatchObject({ argumentsDelta: '{"goal_id":"goal-42ab"}' })
    })
  })

  it('registers a replay-only provider catalog when configured', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const { dispose } = installLlmReplay(ctx, {
      file,
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          retryPolicy: {
            mode: 'normal',
            maxRetries: 2,
            backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
          models: [
            {
              id: 'flash',
              contextWindow: 128_000,
              inputModalities: ['text', 'image'],
              defaultMaxTokens: 64_000,
              reasoningEfforts: ['off', 'max'],
              defaultReasoningEffort: 'max',
            },
            { id: 'pro', name: 'Pro', description: 'Larger model', reasoningEfforts: ['high'] },
          ],
        },
        { id: 'empty' },
      ],
    })

    expect(ctx.llm.listProviders()).toEqual([
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'empty', name: 'empty' },
    ])
    await expect(ctx.llm.listModels('deepseek')).resolves.toEqual([
      { provider: 'deepseek', id: 'flash', name: 'flash', inputModalities: ['text', 'image'] },
      { provider: 'deepseek', id: 'pro', name: 'Pro', description: 'Larger model' },
    ])
    await expect(ctx.llm.listModels('empty')).resolves.toEqual([])
    await expect(ctx.llm.resolveModelInfo('deepseek', 'flash')).resolves.toMatchObject({
      context: { contextWindow: 128_000 },
      inputModalities: ['text', 'image'],
      defaultMaxTokens: 64_000,
      reasoning: {
        efforts: [{ id: 'off', name: 'off' }, { id: 'max', name: 'max' }],
        defaultEffort: 'max',
      },
    })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'pro')).resolves.not.toHaveProperty('inputModalities')
    await expect(ctx.llm.resolveModelInfo('deepseek', 'pro')).resolves.not.toHaveProperty('context')
    // Efforts without a configured default preserve the provider's own default.
    await expect(ctx.llm.resolveModelInfo('deepseek', 'pro')).resolves.toMatchObject({
      reasoning: { efforts: [{ id: 'high', name: 'high' }] },
    })
    await expect(ctx.llm.resolveModelInfo('deepseek', 'pro')).resolves.not.toHaveProperty('defaultMaxTokens')
    await expect(ctx.llm.resolveModelInfo('deepseek', 'unlisted')).resolves.not.toHaveProperty('context')
    await expect(ctx.llm.resolveModelInfo('empty', 'unlisted')).resolves.not.toHaveProperty('context')
    expect(ctx.llm.providerRetryPolicy('deepseek')).toMatchObject({
      mode: 'normal',
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
    })
    expect(ctx.llm.providerRetryPolicy('empty')).toMatchObject({
      mode: 'normal',
      maxRetries: 5,
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    })
    expect(await drain(ctx.llm.stream({ provider: 'deepseek', model: 'pro', messages: [] }))).toEqual(TEXT_CHUNKS)

    dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects an invalid replay-provider retry policy during registration', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)

    expect(() => {
      installLlmReplay(ctx, {
        file,
        providers: [{ id: 'deepseek', retryPolicy: { mode: 'normal', maxRetries: -1 } }],
      })
    }).toThrow(/llm-replay: provider "deepseek" retryPolicy\.maxRetries/)
  })

  it('serves the Nth call the Nth derived entry (positional)', async () => {
    const second: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'two' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeLog(TEXT_CHUNKS, second)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file })
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(second)
  })

  it('settles official DeepSeek request extensions before replayed chunks', async () => {
    writeLog(TEXT_CHUNKS, TEXT_CHUNKS, TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    const accepted = vi.fn()
    ctx.deepseekLlmApiExtensions.register('test_replay', {
      prepare: () => ({ value: { version: 1 }, accept: accepted }),
    })
    installLlmReplay(ctx, { file })

    const sessionId = 'deepseek-replay' as NonNullable<GenerateOptions['sessionId']>
    await drain(ctx.llm.stream({ provider: 'deepseek-official', model: 'm', messages: [], sessionId }))
    expect(accepted).toHaveBeenCalledOnce()
    await drain(ctx.llm.stream({
      provider: 'deepseek-official',
      model: 'm',
      messages: [],
      sessionId,
      signal: new AbortController().signal,
      purpose: 'compaction',
    }))
    expect(accepted).toHaveBeenCalledTimes(2)
    await drain(ctx.llm.stream({ provider: 'another-provider', model: 'm', messages: [], sessionId }))
    expect(accepted).toHaveBeenCalledTimes(2)
  })

  it('accepts anonymous official extensions and tolerates an absent optional registry', async () => {
    writeLog(TEXT_CHUNKS)
    const withRegistry = new Context()
    await withRegistry.plugin(LlmRuntime)
    await withRegistry.plugin(DeepSeekLlmApiExtensionRegistry)
    const accepted = vi.fn()
    withRegistry.deepseekLlmApiExtensions.register('test_replay', {
      prepare: () => ({ value: { version: 1 }, accept: accepted }),
    })
    installLlmReplay(withRegistry, { file })
    await drain(withRegistry.llm.stream({ provider: 'deepseek-official', model: 'm', messages: [] }))
    expect(accepted).toHaveBeenCalledOnce()

    const withoutRegistry = new Context()
    await withoutRegistry.plugin(LlmRuntime)
    installLlmReplay(withoutRegistry, { file })
    await expect(drain(withoutRegistry.llm.stream({ provider: 'deepseek-official', model: 'm', messages: [] })))
      .resolves.toEqual(TEXT_CHUNKS)
  })

  it('accepts only throw entries that reached the post-2xx point', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: [{ type: 'block-start', index: 0, blockType: 'text' }], message: 'partial', code: 'STREAM_CLOSED' },
      { kind: 'throw', chunks: [], message: 'unauthorized', code: 'AUTH' },
      { kind: 'throw', chunks: [], message: 'empty body', code: 'EMPTY_RESPONSE', accepted: true },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    const accepted = vi.fn()
    ctx.deepseekLlmApiExtensions.register('test_replay', {
      prepare: () => ({ value: { version: 1 }, accept: accepted }),
    })
    installLlmReplay(ctx, { file, overrideFile })
    const request = { provider: 'deepseek-official', model: 'm', messages: [] }

    await expect(drain(ctx.llm.stream(request))).rejects.toThrow('partial')
    expect(accepted).toHaveBeenCalledOnce()
    await expect(drain(ctx.llm.stream(request))).rejects.toThrow('unauthorized')
    expect(accepted).toHaveBeenCalledOnce()
    await expect(drain(ctx.llm.stream(request))).rejects.toThrow('empty body')
    expect(accepted).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-boolean throw acceptance override', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: [], message: 'bad', code: 'X', accepted: 'yes' },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    expect(() => { installLlmReplay(ctx, { file, overrideFile }) }).toThrow(/accepted must be a boolean/)
  })

  it('replays a sidecar throw-entry as an LlmError with its stable code, after its prefix chunks', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const partial: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: partial, message: 'unauthorized', code: 'AUTH' },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, overrideFile })

    const seen: StreamChunk[] = []
    await expect((async () => {
      for await (const c of ctx.llm.stream({ provider: 'm', model: 'm', messages: [] })) seen.push(c)
    })()).rejects.toMatchObject({ message: 'unauthorized', code: 'AUTH' })
    expect(seen).toEqual(partial)
  })

  it('replays a sidecar hang-entry that surfaces abort when the signal fires', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, overrideFile })

    const controller = new AbortController()
    const iterator = ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
    // Deterministically consume the two pre-hang chunks (no sleep), then abort
    // and assert the next pull rejects — event-driven, per the no-sleeps rule.
    expect((await iterator.next()).value).toMatchObject({ type: 'block-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'text-delta' })
    controller.abort()
    await expect(iterator.next()).rejects.toThrow('aborted')
  })

  it('fails loud when the script is exhausted', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file })
    await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).rejects.toThrow(/exhausted/)
  })

  it('aborts mid-replay when the signal is already set', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file })
    const controller = new AbortController()
    controller.abort()
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })))
      .rejects.toThrow('aborted')
  })

  it('removes the waterfall listener when the owning fiber is disposed (HMR safety)', async () => {
    writeLog(TEXT_CHUNKS, TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)

    // A real adapter to fall through to AFTER dispose, proving the listener is gone.
    class FallthroughAdapter extends LlmAdapter {
      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['m'], new FallthroughAdapter())

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      installLlmReplay(inner, { file })
    }, { inject: ['llm'] }))

    // While installed, replay short-circuits to the derived fixture ('hi').
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)

    await fiber.dispose()
    // After dispose the listener is gone; the call reaches the real adapter.
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] })))
      .toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('rejects a malformed sidecar entry kind before installing replay', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    // A kind the union does not know — hand-edited/drifted sidecar data.
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'bogus' }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    expect(() => installLlmReplay(ctx, { file, overrideFile })).toThrow(/unknown kind/)
  })

  it('rejects a hang entry when the signal fires DURING the wait (abort listener path)', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const readyFile = join(dir, 'stream-ready')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang', readyFile }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, overrideFile })
    const controller = new AbortController()
    const iterator = ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
    // Consume the two pre-hang chunks, then start the third pull so the generator
    // is parked inside the await (signal NOT yet aborted — exercises the
    // addEventListener('abort') registration), and only THEN abort.
    expect((await iterator.next()).value).toMatchObject({ type: 'block-start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'text-delta' })
    const pending = iterator.next()
    await new Promise(r => setImmediate(r))
    expect(existsSync(readyFile)).toBe(true)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  it('aborts mid-replay of a throw-entry prefix when the signal is set', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const partial: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: partial, message: 'unauthorized', code: 'AUTH' },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, overrideFile })
    const controller = new AbortController()
    controller.abort()
    // Already aborted: the throw-entry's prefix loop surfaces 'aborted' before
    // it can reach the recorded LlmError.
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })))
      .rejects.toThrow('aborted')
  })

  it('surfaces an already-aborted signal on a hang entry before waiting', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, overrideFile })
    const controller = new AbortController()
    controller.abort()
    // The two pre-hang chunks still flow; the abort surfaces at the await.
    const iterator = ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal })[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await expect(iterator.next()).rejects.toThrow('aborted')
  })

  it('rejects a paceMs that is not a non-negative integer', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    expect(() => installLlmReplay(ctx, { file, paceMs: -1 })).toThrow(/paceMs/)
    expect(() => installLlmReplay(ctx, { file, paceMs: 1.5 })).toThrow(/paceMs/)
  })

  it('paces chunk yields when paceMs is set (each chunk waits at least the pace)', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, paceMs: 10 })
    const started = performance.now()
    const chunks = await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))
    expect(chunks).toEqual(TEXT_CHUNKS)
    // N chunks × 10ms; allow generous scheduling slack, assert the floor only.
    expect(performance.now() - started).toBeGreaterThanOrEqual(TEXT_CHUNKS.length * 10 - 5)
  })

  it('aborting DURING a pace wait cancels the stream promptly', async () => {
    writeLog(TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, paceMs: 60_000 })
    const controller = new AbortController()
    const pending = drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [], signal: controller.signal }))
    // Let the generator park inside the pace timer, then abort — the reject
    // must come from the abort listener, not the (distant) timer.
    await new Promise(r => setImmediate(r))
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  it('assertConsumed passes only after every recorded call replayed', async () => {
    writeLog(TEXT_CHUNKS, TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const handle = installLlmReplay(ctx, { file })
    await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))
    // One of two recorded calls consumed — the underrun must name the gap.
    expect(() => { handle.assertConsumed() }).toThrow(/consumed 1\/2 recorded call/)
    await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))
    expect(() => { handle.assertConsumed() }).not.toThrow()
  })

  it('paces a throw-entry prefix too (the recorded partial streams at the same cadence)', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const partial: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
    writeFileSync(overrideFile, JSON.stringify([
      { kind: 'throw', chunks: partial, message: 'boom', code: 'STREAM_CLOSED' },
    ]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file, overrideFile, paceMs: 10 })
    const started = performance.now()
    await expect(drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).rejects.toThrow('boom')
    expect(performance.now() - started).toBeGreaterThanOrEqual(5)
  })

  it('assertConsumed names an underrunning identified session by its id', async () => {
    writeLog(TEXT_CHUNKS, TEXT_CHUNKS)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const handle = installLlmReplay(ctx, { file })
    const sessionId = 'live-underrun' as NonNullable<GenerateOptions['sessionId']>
    await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [], sessionId }))
    expect(() => { handle.assertConsumed() }).toThrow(/session live-underrun consumed 1\/2/)
  })

  it('assertConsumed reports recorded scripts no live session ever bound', async () => {
    writeLog(TEXT_CHUNKS)
    const childFile = join(dir, 'session.1.jsonl')
    writeFileSync(childFile, replaySessionJsonl([TEXT_CHUNKS], { id: 'child', createdAt: 10 }), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const handle = installLlmReplay(ctx, { file, childFiles: [childFile] })
    await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [], sessionId: 'live-parent' as NonNullable<GenerateOptions['sessionId']> }))
    // The child script never bound: the scenario drove fewer sessions than recorded.
    expect(() => { handle.assertConsumed() }).toThrow(/1 recorded script\(s\) never bound/)
  })
})

describe('parseSessionHeader', () => {
  it('reads id, createdAt, and the inherited event count off the v0 header line', () => {
    expect(parseSessionHeader(sessionJsonl([], { id: 'abc', createdAt: 42 })))
      .toEqual({ id: 'abc', createdAt: 42, inheritedEventCount: 0 })
  })

  it('reads a non-zero v0 seedLength as the inherited event count', () => {
    const events: SessionEvent[] = Array.from({ length: 4 }, (_, seq) => ({
      type: 'permission/preset', seq: SessionSeq(seq), time: 0, data: { preset: 'workspace-write' },
    }))
    expect(parseSessionHeader(sessionJsonl(events, { id: 'child', createdAt: 7, seedLength: 4 })))
      .toEqual({ id: 'child', createdAt: 7, inheritedEventCount: 4 })
  })

  it('materializes omitted v0 delegation depth and tokenized cwd for projected validation', () => {
    expect(parseSessionHeader(
      '{"type":"session","version":0,"id":"projected","createdAt":7,"cwd":"{{cwd}}/workspace"}\n',
    )).toEqual({ id: 'projected', createdAt: 7, inheritedEventCount: 0 })
  })

  it('rejects a projected header that lacks required identity fields', () => {
    expect(() => parseSessionHeader('{"type":"session","version":0}\n')).toThrow(/lacks required member "id"/)
  })

  it('rejects an empty fixture instead of inventing header identity', () => {
    expect(() => parseSessionHeader('')).toThrow(/must start with a session header/)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid v0 seedLength %s', (seedLength) => {
    expect(() => parseSessionHeader(JSON.stringify({
      type: 'session', version: 0, id: 'invalid', createdAt: 0, seedLength, delegationDepth: 0,
    }))).toThrow(/seedLength/)
  })
})

describe('loadSessionScripts', () => {
  it('returns one primary script for a single-session scenario', () => {
    const f = writeSession('session.jsonl', { id: 'p', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts: SessionScript[] = loadSessionScripts({ file: f })
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toMatchObject({ recordedId: 'p', createdAt: 100, primary: true })
    expect(scripts[0]?.entries).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('orders parent + children by createdAt with the primary first on a tie', () => {
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    // One child created LATER, one child sharing the parent's createdAt (tie).
    const later = writeSession('session.1.jsonl', { id: 'late', createdAt: 200 }, [TEXT_CHUNKS])
    const tie = writeSession('session.2.jsonl', { id: 'tie', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file: f, childFiles: [later, tie] })
    // parent (100, primary) → tie (100, non-primary) → late (200).
    expect(scripts.map(s => s.recordedId)).toEqual(['parent', 'tie', 'late'])
    expect(scripts[0]?.primary).toBe(true)
  })

  it('throws when a declared child fixture is missing', () => {
    const f = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS])
    expect(() => loadSessionScripts({ file: f, childFiles: [join(dir, 'absent.jsonl')] }))
      .toThrow(/child fixture not found/)
  })

  it('derives a FORK child script from its OWN events only (skips the seeded parent prefix)', () => {
    // A fork log includes the parent's assistant chunks before `seedLength`. Deriving from the
    // whole log would replay parent responses as child calls, so only child-owned chunks qualify.
    const parentChunk: StreamChunk = { type: 'text-delta', index: 0, text: 'PARENT-RESPONSE' }
    const childChunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'CHILD-RESPONSE' }, { type: 'finish', reason: { kind: 'stop' } }]
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    // The child fixture contains one complete inherited turn followed by its own turn.
    // seedLength = 6 marks the exact cut between those lifecycles.
    const childEvents: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 0, data: { turn: 1, step: 1 } },
      legacyChunkEvent(2, 1, 1, parentChunk),
      legacyChunkEvent(3, 1, 1, { type: 'finish', reason: { kind: 'stop' } }),
      { type: 'step/end', seq: SessionSeq(4), time: 0, data: { turn: 1, step: 1 } },
      {
        type: 'turn/end', seq: SessionSeq(5), time: 0,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
      { type: 'turn/start', seq: SessionSeq(6), time: 0, data: { turn: 2 } },
      { type: 'step/start', seq: SessionSeq(7), time: 0, data: { turn: 2, step: 1 } },
      legacyChunkEvent(8, 2, 1, childChunks[0]!),
      legacyChunkEvent(9, 2, 1, childChunks[1]!),
      { type: 'step/end', seq: SessionSeq(10), time: 0, data: { turn: 2, step: 1 } },
      {
        type: 'turn/end', seq: SessionSeq(11), time: 0,
        data: { turn: 2, reason: { kind: 'completed' } },
      },
    ]
    const childPath = join(dir, 'session.1.jsonl')
    writeFileSync(childPath, sessionJsonl(childEvents, {
      id: 'child', createdAt: 200, seedLength: 6, version: 0,
    }), 'utf8')

    const scripts = loadSessionScripts({ file: f, childFiles: [childPath] })
    // The child script is ONLY the child's own model call — the parent's seeded
    // chunk is gone.
    expect(scripts[1]?.entries).toEqual([{ kind: 'chunks', chunks: childChunks }])
  })

  it('uses the override for the primary and still derives children', () => {
    writeFileSync(file, sessionJsonl([], { id: 'p', createdAt: 1 }), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const override: ReplayEntry[] = [{ kind: 'hang' }]
    writeFileSync(overrideFile, JSON.stringify(override), 'utf8')
    const child = writeSession('session.1.jsonl', { id: 'c', createdAt: 2 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file, overrideFile, childFiles: [child] })
    expect(scripts[0]?.entries).toEqual(override)
    expect(scripts[1]?.entries).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('defaults the primary header to id="" / createdAt=0 when only an override (no JSONL) exists', () => {
    // An override-only fixture: config.file does NOT exist, the override drives
    // the primary script, so the header default branch applies.
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')
    const scripts = loadSessionScripts({ file: join(dir, 'absent.jsonl'), overrideFile })
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toMatchObject({ recordedId: '', createdAt: 0, primary: true })
  })

  it('does not parse a whole-script override reused as the primary fixture path', () => {
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'hang' }]), 'utf8')

    const scripts = loadSessionScripts({ file: overrideFile, overrideFile })

    expect(scripts).toEqual([{
      recordedId: '',
      createdAt: 0,
      entries: [{ kind: 'hang' }],
      primary: true,
    }])
  })

  it('orders two same-createdAt children deterministically after the primary', () => {
    // Two children sharing a createdAt (both non-primary): exercises the sort
    // tie-break\'s "both same primary-ness" arm and a non-primary-vs-primary arm.
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    const c1 = writeSession('session.1.jsonl', { id: 'c1', createdAt: 100 }, [TEXT_CHUNKS])
    const c2 = writeSession('session.2.jsonl', { id: 'c2', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file: f, childFiles: [c1, c2] })
    // Primary first (its createdAt ties the children but primary wins); the two
    // children keep a stable relative order.
    expect(scripts[0]?.recordedId).toBe('parent')
    expect(scripts.every(s => s.createdAt === 100)).toBe(true)
    expect(scripts.map(s => s.primary)).toEqual([true, false, false])
  })

  it('keeps the primary first even when a child sorts BEFORE it in input order', () => {
    // The primary is appended first internally. A strictly earlier child sorts before it, while
    // equal creation times preserve primary-first order regardless of input order.
    const f = writeSession('session.jsonl', { id: 'parent', createdAt: 100 }, [TEXT_CHUNKS])
    const earlier = writeSession('session.1.jsonl', { id: 'early', createdAt: 100 }, [TEXT_CHUNKS])
    const scripts = loadSessionScripts({ file: f, childFiles: [earlier] })
    // Equal createdAt → primary first.
    expect(scripts.map(s => s.recordedId)).toEqual(['parent', 'early'])
  })
})

describe('installLlmReplay (per-session keying)', () => {
  const second: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'child' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  const live = (id: string): GenerateOptions =>
    ({ provider: 'm', model: 'm', messages: [], sessionId: id as NonNullable<GenerateOptions['sessionId']> })

  it('routes each live session to its own script by FIRST-CALL order', async () => {
    const parentFile = writeSession('session.jsonl', { id: 'rec-parent', createdAt: 100 }, [TEXT_CHUNKS])
    const childFile = writeSession('session.1.jsonl', { id: 'rec-child', createdAt: 200 }, [second])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile, childFiles: [childFile] })
    // The first live session to call binds to the parent script; a different
    // live session id binds to the child script — regardless of recorded ids.
    expect(await drain(ctx.llm.stream(live('live-A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('live-B')))).toEqual(second)
    // The first session's SECOND call would exhaust its 1-entry script.
    await expect(drain(ctx.llm.stream(live('live-A')))).rejects.toThrow(/exhausted/)
  })

  it('keeps each session\'s cursor independent (interleaved calls)', async () => {
    const a2: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'a2' }, { type: 'finish', reason: { kind: 'stop' } }]
    const b2: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'b2' }, { type: 'finish', reason: { kind: 'stop' } }]
    const parentFile = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS, a2])
    const childFile = writeSession('session.1.jsonl', { id: 'c', createdAt: 2 }, [second, b2])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile, childFiles: [childFile] })
    // Interleave: A#1, B#1, A#2, B#2 — each cursor advances per-session.
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(second)
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(a2)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(b2)
  })

  it('materializes typed session tokens after the matching live child binds', async () => {
    const reference: StreamChunk[] = [
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: ToolCallId('send-child'),
          name: 'send_message',
          arguments: '{"agent_id":"{{session:2}}"}',
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const parentFile = writeSession('session.jsonl', { id: '{{session:1}}', createdAt: 1 }, [TEXT_CHUNKS, reference])
    const childFile = writeSession('session.1.jsonl', { id: '{{session:2}}', createdAt: 2 }, [second])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile, childFiles: [childFile] })

    expect(await drain(ctx.llm.stream(live('live-parent')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('live-child')))).toEqual(second)
    expect(await drain(ctx.llm.stream(live('live-parent')))).toEqual([
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: ToolCallId('send-child'),
          name: 'send_message',
          arguments: '{"agent_id":"live-child"}',
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('rejects a session token before that recorded child binds', async () => {
    const reference: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: '{{session:2}}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const parentFile = writeSession('session.jsonl', { id: '{{session:1}}', createdAt: 1 }, [reference])
    const childFile = writeSession('session.1.jsonl', { id: '{{session:2}}', createdAt: 2 }, [second])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile, childFiles: [childFile] })

    await expect(drain(ctx.llm.stream(live('live-parent')))).rejects.toThrow(/used before.*bound/)
  })

  it('learns a background child id from its started-subagent tool result', async () => {
    const reference: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: '{{session:2}}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const parentFile = writeSession('session.jsonl', { id: '{{session:1}}', createdAt: 1 }, [reference])
    const childFile = writeSession('session.1.jsonl', { id: '{{session:2}}', createdAt: 2 }, [second])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile, childFiles: [childFile] })
    const options: GenerateOptions = {
      ...live('live-parent'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'started subagent live-child-before-call started subagent live-child-before-call' }],
        source: { kind: 'user' },
      })],
    }

    expect(await drain(ctx.llm.stream(options))).toEqual([
      { type: 'text-delta', index: 0, text: 'live-child-before-call' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('ignores started-subagent text after every recorded session has bound', async () => {
    const parentFile = writeSession('session.jsonl', { id: '{{session:1}}', createdAt: 1 }, [TEXT_CHUNKS])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile })

    expect(await drain(ctx.llm.stream({
      ...live('live-parent'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'started subagent unrecorded-child' }],
        source: { kind: 'user' },
      })],
    }))).toEqual(TEXT_CHUNKS)
  })

  it('treats a call with no sessionId as the single anonymous (primary) session', async () => {
    const parentFile = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile })
    // No sessionId at all — the legacy single-session path.
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('fails loud when more distinct live sessions call than were recorded', async () => {
    const parentFile = writeSession('session.jsonl', { id: 'p', createdAt: 1 }, [TEXT_CHUNKS])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, { file: parentFile }) // only ONE recorded session
    expect(await drain(ctx.llm.stream(live('first')))).toEqual(TEXT_CHUNKS)
    // A SECOND distinct live session has no script to bind to.
    await expect(drain(ctx.llm.stream(live('second')))).rejects.toThrow(/unrecorded session/)
  })
})

describe('apply (the plugin entry)', () => {
  const ORIG = {
    file: process.env.DSH_SNAPSHOT_FILE,
    override: process.env.DSH_SNAPSHOT_OVERRIDE,
    children: process.env.DSH_SNAPSHOT_CHILD_FILES,
  }
  afterEach(() => {
    if (ORIG.file === undefined) delete process.env.DSH_SNAPSHOT_FILE
    else process.env.DSH_SNAPSHOT_FILE = ORIG.file
    if (ORIG.override === undefined) delete process.env.DSH_SNAPSHOT_OVERRIDE
    else process.env.DSH_SNAPSHOT_OVERRIDE = ORIG.override
    if (ORIG.children === undefined) delete process.env.DSH_SNAPSHOT_CHILD_FILES
    else process.env.DSH_SNAPSHOT_CHILD_FILES = ORIG.children
  })

  it('exposes the namespace plugin shape (name/inject, no default export)', () => {
    expect(name).toBe('llm-replay')
    expect(inject).toEqual(['llm'])
  })

  it('installs replay and its catalog from explicit config', async () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    apply(ctx, {
      file,
      providers: [
        { id: 'm', models: [{ id: 'm', inputModalities: ['image'] }, { id: 'text' }] },
        { id: 'empty' },
      ],
      paceMs: 1,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'm', name: 'm' }, { id: 'empty', name: 'empty' }])
    await expect(ctx.llm.resolveModelInfo('m', 'm')).resolves.toMatchObject({ inputModalities: ['image'] })
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('declares flat image request pricing only for models that configure it', async () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    installLlmReplay(ctx, {
      file,
      providers: [{
        id: 'deepseek',
        models: [
          { id: 'vision', inputModalities: ['text', 'image'], imageRequestTokens: 384 },
          { id: 'plain' },
        ],
      }],
    })
    const pricing = ctx.llm.imageRequestPricing('deepseek', 'vision')
    expect(pricing).toBeDefined()
    const ref = {
      attachmentId: 'sha256:aaaaaaaa',
      mediaType: 'image/png',
      bytes: 10,
      width: 640,
      height: 480,
    } as never
    const priced = pricing?.priceImages([ref, ref])
    expect(priced?.map(price => price.visualTokens)).toEqual([384, 384])
    expect(priced?.every(price => price.text.includes('640x480px'))).toBe(true)
    expect(ctx.llm.imageRequestPricing('deepseek', 'plain')).toBeUndefined()
  })

  it('rejects imageRequestTokens on a model without the image modality during load', () => {
    const ctx = new Context()
    const providers = [{ id: 'm', models: [{ id: 'm', imageRequestTokens: 384 }] }] as unknown as
      NonNullable<Config['providers']>
    expect(() => { apply(ctx, { file, providers }) }).toThrow(
      'llm-replay: provider "m" model "m" imageRequestTokens requires inputModalities to include "image"',
    )
  })

  it.each([
    ['zero', 0],
    ['a float', 1.5],
  ])('rejects imageRequestTokens configured as %s during load', (_case, imageRequestTokens) => {
    const ctx = new Context()
    const providers = [{ id: 'm', models: [{ id: 'm', imageRequestTokens }] }] as unknown as
      NonNullable<Config['providers']>
    expect(() => { apply(ctx, { file, providers }) }).toThrow(
      'llm-replay: provider "m" model "m" imageRequestTokens must be a positive safe integer',
    )
  })

  it.each([
    ['a string', 'image'],
    ['an unknown modality', ['audio']],
  ])('rejects inputModalities configured as %s during load', (_case, inputModalities) => {
    const ctx = new Context()
    const providers = [{ id: 'm', models: [{ id: 'm', inputModalities }] }] as unknown as
      NonNullable<Config['providers']>
    expect(() => { apply(ctx, { file, providers }) }).toThrow(
      'llm-replay: provider "m" model "m" inputModalities must be an array containing only "text" and "image"',
    )
  })

  it('falls back to $DSH_SNAPSHOT_FILE / $DSH_SNAPSHOT_OVERRIDE when config is empty', async () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'chunks', chunks: TEXT_CHUNKS }]), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    process.env.DSH_SNAPSHOT_OVERRIDE = overrideFile
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    apply(ctx)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('uses only the file when no override path is configured or in the env', async () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS]), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    delete process.env.DSH_SNAPSHOT_OVERRIDE
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    apply(ctx)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })

  it('throws when no fixture path is given by config or env', async () => {
    delete process.env.DSH_SNAPSHOT_FILE
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    expect(() => { apply(ctx, {}) }).toThrow(/a fixture path is required/)
  })

  it('treats an empty-string fixture path as missing', async () => {
    delete process.env.DSH_SNAPSHOT_FILE
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    expect(() => { apply(ctx, { file: '' }) }).toThrow(/a fixture path is required/)
  })

  it('loads child fixtures from config.childFiles (per-session routing)', async () => {
    const childSecond: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'kid' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS], { id: 'p', createdAt: 1 }), 'utf8')
    const childFile = join(dir, 'session.1.jsonl')
    writeFileSync(childFile, replaySessionJsonl([childSecond], { id: 'c', createdAt: 2 }), 'utf8')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    apply(ctx, { file, childFiles: [childFile] })
    const live = (id: string): GenerateOptions =>
      ({ provider: 'm', model: 'm', messages: [], sessionId: id as NonNullable<GenerateOptions['sessionId']> })
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(childSecond)
  })

  it('falls back to $DSH_SNAPSHOT_CHILD_FILES (path-delimited) when config omits childFiles', async () => {
    const childChunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'env-kid' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS], { id: 'p', createdAt: 1 }), 'utf8')
    const childFile = join(dir, 'session.1.jsonl')
    writeFileSync(childFile, replaySessionJsonl([childChunks], { id: 'c', createdAt: 2 }), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    process.env.DSH_SNAPSHOT_CHILD_FILES = childFile // single entry, no delimiter needed
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    apply(ctx)
    const live = (id: string): GenerateOptions =>
      ({ provider: 'm', model: 'm', messages: [], sessionId: id as NonNullable<GenerateOptions['sessionId']> })
    expect(await drain(ctx.llm.stream(live('A')))).toEqual(TEXT_CHUNKS)
    expect(await drain(ctx.llm.stream(live('B')))).toEqual(childChunks)
  })

  it('ignores an empty $DSH_SNAPSHOT_CHILD_FILES (single-session)', async () => {
    writeFileSync(file, replaySessionJsonl([TEXT_CHUNKS], { id: 'p', createdAt: 1 }), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    process.env.DSH_SNAPSHOT_CHILD_FILES = ''
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    apply(ctx)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })
})
