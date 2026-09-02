import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import LlmRuntime, { ToolCallId, createUserMessage, GenerateOptions, LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
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
function sessionJsonl(events: SessionEvent[], header?: { id?: string; createdAt?: number; seedLength?: number }): string {
  const headerLine = JSON.stringify({
    type: 'session',
    version: 0,
    id: header?.id ?? 's1',
    createdAt: header?.createdAt ?? 0,
    ...header?.seedLength !== undefined ? { seedLength: header.seedLength } : {},
  })
  return [headerLine, ...events.map(e => JSON.stringify(e))].join('\n') + '\n'
}

/** A SessionEvent of type assistant/chunk for (turn, step). */
function chunkEvent(seq: SessionSeq, turn: number, step: number, chunk: StreamChunk): SessionEvent {
  return { type: 'assistant/chunk', seq, time: 0, data: { turn, step, chunk } }
}

let dir: string
let file: string

/** Write a session log file and return its path. */
function writeSession(filename: string, header: { id: string; createdAt: number }, calls: StreamChunk[][]): string {
  let seq = 1
  const events: SessionEvent[] = []
  calls.forEach((chunks, step) => { for (const c of chunks) events.push(chunkEvent(SessionSeq(seq++), 1, step + 1, c)) })
  const path = join(dir, filename)
  writeFileSync(path, sessionJsonl(events, header), 'utf8')
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

describe('parseSessionLog', () => {
  it('skips the header line and parses each event', () => {
    const events = [chunkEvent(SessionSeq(1), 1, 1, TEXT_CHUNKS[0] as StreamChunk)]
    expect(parseSessionLog(sessionJsonl(events))).toEqual(events)
  })

  it('ignores blank lines', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const ev = chunkEvent(SessionSeq(1), 1, 1, TEXT_CHUNKS[0] as StreamChunk)
    expect(parseSessionLog(`${header}\n\n${JSON.stringify(ev)}\n\n`)).toEqual([ev])
  })

  it('expands range-encoded source provenance', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const event = {
      ...chunkEvent(SessionSeq(4), 1, 1, TEXT_CHUNKS[0] as StreamChunk),
      sourceEventSeqs: [[1, 3], 5],
    }
    expect(parseSessionLog(`${header}\n${JSON.stringify(event)}\n`)).toEqual([{
      ...event,
      sourceEventSeqs: [1, 2, 3, 5],
    }])
  })

  it('reports malformed range provenance with its source line', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const event = {
      ...chunkEvent(SessionSeq(4), 1, 1, TEXT_CHUNKS[0] as StreamChunk),
      sourceEventSeqs: [[3, 1]],
    }
    expect(() => parseSessionLog(`${header}\n${JSON.stringify(event)}\n`))
      .toThrow('session snapshot line 2: sourceEventSeqs ranges require start <= end')
  })

  it('rejects non-object body rows with their source line', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    expect(() => parseSessionLog(`${header}\nnull\n`))
      .toThrow('session snapshot line 2 must be a JSON object')
  })

  it('expands a packed chunk row into its events (a fixture recorded with packChunks on)', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 0 })
    const row = JSON.stringify({
      type: 'text-chunks', seq0: 1, time0: 0,
      data: { turn: 1, step: 1, index: 0, dt: [0, 0], texts: ['a', 'b', 'c'] },
    })
    expect(parseSessionLog(`${header}\n${row}\n`)).toEqual([
      chunkEvent(SessionSeq(1), 1, 1, { type: 'text-delta', index: 0, text: 'a' }),
      chunkEvent(SessionSeq(2), 1, 1, { type: 'text-delta', index: 0, text: 'b' }),
      chunkEvent(SessionSeq(3), 1, 1, { type: 'text-delta', index: 0, text: 'c' }),
    ])
  })

  it('synthesizes omitted ordinary and packed snapshot envelopes', () => {
    const header = JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 7 })
    const ordinary = JSON.stringify({ type: 'turn/start', data: { turn: 1 } })
    const packed = JSON.stringify({
      type: 'text-chunks',
      data: { turn: 1, step: 1, index: 0, dt: [3], texts: ['a', 'b'] },
    })
    expect(parseSessionLog(`${header}\n${ordinary}\n${packed}\n`)).toEqual([
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      chunkEvent(SessionSeq(1), 1, 1, { type: 'text-delta', index: 0, text: 'a' }),
      { ...chunkEvent(SessionSeq(2), 1, 1, { type: 'text-delta', index: 0, text: 'b' }), time: 3 },
    ])
  })
})

describe('deriveReplayScript', () => {
  it('groups one finished assistant/chunk stream into one replay entry', () => {
    const events: SessionEvent[] = TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('separates retry calls that share one turn and step at their finish chunks', () => {
    const failed: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'empty', code: 'EMPTY_RESPONSE' } } },
    ]
    let seq = 1
    const events: SessionEvent[] = [
      ...failed.map(chunk => chunkEvent(SessionSeq(seq++), 1, 1, chunk)),
      ...TEXT_CHUNKS.map(chunk => chunkEvent(SessionSeq(seq++), 1, 1, chunk)),
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
    let seq = 1
    const events: SessionEvent[] = [
      ...callA.map(c => chunkEvent(SessionSeq(seq++), 1, 1, c)),
      ...callB.map(c => chunkEvent(SessionSeq(seq++), 1, 2, c)), // same turn, next step
    ]
    expect(deriveReplayScript(events)).toEqual([
      { kind: 'chunks', chunks: callA },
      { kind: 'chunks', chunks: callB },
    ])
  })

  it('separates calls across turns too', () => {
    let seq = 1
    const events: SessionEvent[] = [
      ...TEXT_CHUNKS.map(c => chunkEvent(SessionSeq(seq++), 1, 1, c)),
      ...TEXT_CHUNKS.map(c => chunkEvent(SessionSeq(seq++), 2, 1, c)), // new turn, step resets to 1
    ]
    expect(deriveReplayScript(events)).toHaveLength(2)
  })

  it('ignores non-assistant/chunk events', () => {
    let seq = 1
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(seq++), time: 0, data: { turn: 1 } },
      ...TEXT_CHUNKS.map(c => chunkEvent(SessionSeq(seq++), 1, 1, c)),
      { type: 'turn/end', seq: SessionSeq(seq++), time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(deriveReplayScript(events)).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('returns an empty script for a log with no assistant/chunk events', () => {
    expect(deriveReplayScript([])).toEqual([])
  })

  it('keeps a finish-error chunk in the derived entry (replays naturally)', () => {
    const errChunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } },
    ]
    const events = errChunks.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))
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
      ...overflow.map(chunk => chunkEvent(SessionSeq(seq++), 1, 2, chunk)),
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
      ...TEXT_CHUNKS.map(chunk => chunkEvent(SessionSeq(seq++), 1, 2, chunk)),
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

  it('rejects a persisted marked compact LLM call without its complete output', () => {
    const [event] = parseSessionLog([
      JSON.stringify({ type: 'session', version: 0, id: 'invalid-compact', createdAt: 0 }),
      JSON.stringify({
        type: 'compaction/summary',
        seq: 1,
        time: 0,
        data: {
          compactionId: COMPACTION_ID,
          summary: [{ type: 'text', text: 'missing source events' }],
          llmStreamCall: true,
          shadowedRange: { start: 1, end: 1 },
          shadowedSeqs: [1],
          shadowedTokenCount: 20,
          provider: 'mock',
          model: 'mock',
        },
      }),
    ].join('\n'))

    expect(() => deriveReplayScript(event === undefined ? [] : [event]))
      .toThrow(/LLM stream call without rawOutput/)
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
      chunkEvent(SessionSeq(1), 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
      chunkEvent(SessionSeq(2), 1, 1, { type: 'text-delta', index: 0, text: 'par' }),
      { type: 'turn/end', seq: SessionSeq(3), time: 0, data: { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } } },
    ]
    expect(() => deriveReplayScript(events)).toThrow(/without a finish chunk.*replay\.override\.json/s)
  })

  it('names the offending (turn, step) when a group is incomplete', () => {
    const events: SessionEvent[] = [
      chunkEvent(SessionSeq(1), 2, 3, { type: 'block-start', index: 0, blockType: 'text' }),
    ]
    expect(() => deriveReplayScript(events)).toThrow(/2\/3/)
  })

  it('rejects an unfinished call before consuming chunks from a new step', () => {
    const events: SessionEvent[] = [
      chunkEvent(SessionSeq(1), 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
      chunkEvent(SessionSeq(2), 1, 2, { type: 'finish', reason: { kind: 'stop' } }),
    ]
    expect(() => deriveReplayScript(events)).toThrow(/model call 1\/1 ended without a finish chunk/)
  })

  it('rejects an unfinished call at a compact summary boundary', () => {
    const events: SessionEvent[] = [
      chunkEvent(SessionSeq(1), 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
    expect(loadReplayScript({ file })).toEqual([{ kind: 'chunks', chunks: TEXT_CHUNKS }])
  })

  it('uses the sidecar override when present, ignoring the JSONL', () => {
    writeFileSync(file, sessionJsonl([]), 'utf8')
    const overrideFile = join(dir, 'replay.override.json')
    const override: ReplayEntry[] = [{ kind: 'throw', chunks: [], message: '401', code: 'AUTH' }]
    writeFileSync(overrideFile, JSON.stringify(override), 'utf8')
    expect(loadReplayScript({ file, overrideFile })).toEqual(override)
  })

  it('falls back to the JSONL when the override path is set but absent', () => {
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
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
    let seq = 1
    writeFileSync(file, sessionJsonl([
      ...TEXT_CHUNKS.map(c => chunkEvent(SessionSeq(seq++), 1, 1, c)),
      ...callB.map(c => chunkEvent(SessionSeq(seq++), 1, 2, c)),
    ]), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
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
    let seq = 1
    const events: SessionEvent[] = []
    calls.forEach((chunks, step) => {
      for (const c of chunks) events.push(chunkEvent(SessionSeq(seq++), 1, step + 1, c))
    })
    writeFileSync(file, sessionJsonl(events), 'utf8')
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
    writeFileSync(childFile, sessionJsonl(
      TEXT_CHUNKS.map((chunk, i) => chunkEvent(SessionSeq(i + 1), 1, 1, chunk)),
      { id: 'child', createdAt: 10 },
    ), 'utf8')
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
    expect(parseSessionHeader('{"type":"session","version":0,"id":"child","createdAt":7,"seedLength":4}\n'))
      .toEqual({ id: 'child', createdAt: 7, inheritedEventCount: 4 })
  })

  it('falls back to id="" / createdAt=0 / inheritedEventCount=0 when the header lacks them', () => {
    expect(parseSessionHeader('{"type":"session","version":0}\n')).toEqual({ id: '', createdAt: 0, inheritedEventCount: 0 })
  })

  it('falls back on an empty buffer (no header line)', () => {
    expect(parseSessionHeader('')).toEqual({ id: '', createdAt: 0, inheritedEventCount: 0 })
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid v0 seedLength %s', (seedLength) => {
    expect(() => parseSessionHeader(JSON.stringify({ type: 'session', version: 0, seedLength })))
      .toThrow(/SessionLogOffset/)
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
    // The child fixture: 2 seeded parent events (a chunk + its finish) then the
    // child's own turn. seedLength = 2 marks where the inherited prefix ends.
    const childEvents: SessionEvent[] = [
      chunkEvent(SessionSeq(0), 1, 1, parentChunk),
      chunkEvent(SessionSeq(1), 1, 1, { type: 'finish', reason: { kind: 'stop' } }),
      chunkEvent(SessionSeq(2), 2, 1, childChunks[0]!),
      chunkEvent(SessionSeq(3), 2, 1, childChunks[1]!),
    ]
    const childPath = join(dir, 'session.1.jsonl')
    writeFileSync(childPath, sessionJsonl(childEvents, { id: 'child', createdAt: 200, seedLength: 2 }), 'utf8')

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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c))), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c)), { id: 'p', createdAt: 1 }), 'utf8')
    const childFile = join(dir, 'session.1.jsonl')
    writeFileSync(childFile, sessionJsonl(childSecond.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c)), { id: 'c', createdAt: 2 }), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c)), { id: 'p', createdAt: 1 }), 'utf8')
    const childFile = join(dir, 'session.1.jsonl')
    writeFileSync(childFile, sessionJsonl(childChunks.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c)), { id: 'c', createdAt: 2 }), 'utf8')
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
    writeFileSync(file, sessionJsonl(TEXT_CHUNKS.map((c, i) => chunkEvent(SessionSeq(i + 1), 1, 1, c)), { id: 'p', createdAt: 1 }), 'utf8')
    process.env.DSH_SNAPSHOT_FILE = file
    process.env.DSH_SNAPSHOT_CHILD_FILES = ''
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    apply(ctx)
    expect(await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))).toEqual(TEXT_CHUNKS)
  })
})
