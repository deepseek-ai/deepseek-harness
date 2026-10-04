/** Deterministic current-generation Session corpus whose length distribution follows `corpus-shape.ts`. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  eventLines,
  generationLogPath,
  toHeaderLine,
} from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { anchorShape, sessionShape, type SessionShape } from './corpus-shape.ts'

/** Time of every body's first event; Sessions are created in the preceding minutes. */
const TIME_ZERO = 1_700_000_000_000
/** Prime stride that permutes creation order independently of length rank. */
const CREATION_STRIDE = 7_919
/** Concurrent frame compressions and file writes while materializing a corpus. */
const IO_CONCURRENCY = 8
/** Measured local Sessions per project directory: 1,650 Sessions in 88 directories. */
const SESSIONS_PER_PROJECT = 19
/** Every sixth Session is a subagent child; the measured share is 288 of 1,650. */
const CHILD_EVERY = 6
/** Turn-one system prompt size; the measured median largest event is 21.9 KB. */
const SYSTEM_PROMPT_CHARS = 20_000
/** Characters per streamed text or reasoning delta; the measured mean is 3.9. */
const DELTA_CHARS = 4
/** Share of remaining payload characters by message slot. */
const PAYLOAD_SHARE = { user: 0.1, reasoning: 0.2, text: 0.25, toolResult: 0.45 } as const
/** Distinct words in the synthetic vocabulary and total words in the shared text pool. */
const VOCABULARY = { words: 8_192, poolWords: 2_000_000 } as const
/** Word ranks used by the measured searches: one frequent and one uncommon token. */
export const SEARCH_QUERIES = [vocabularyWord(40), vocabularyWord(1_500)] as const

/** Physical and logical facts of one written corpus. */
export interface SyntheticCorpusFacts {
  /** Logical Sessions. */
  readonly sessions: number
  /** Distinct event bodies; Sessions of one anchor share one body. */
  readonly distinctBodies: number
  /** Project directories. */
  readonly projects: number
  /** Logical events across all Sessions. */
  readonly events: number
  /** Decompressed JSONL bytes across all Sessions. */
  readonly logicalBytes: number
  /** Stored Zstandard bytes across all Sessions. */
  readonly compressedBytes: number
  /** Zstandard frames across all Sessions. */
  readonly frames: number
}

/** One written Session. */
export interface WrittenSession {
  /** Stored header. */
  readonly header: SessionHeader
  /** Measured anchor whose body the Session stores. */
  readonly anchor: number
}

/**
 * Identify one Session by length rank.
 * @param rank - zero-based ascending length rank.
 * @returns stable Session id.
 */
export function corpusSessionId(rank: number): SessionId {
  return SessionId('bench-' + String(rank).padStart(5, '0'))
}

function vocabularyWord(rank: number): string {
  let value = rank + VOCABULARY.words
  let word = ''
  const letters = 'etaoinsrhdlucmfywgpbvkxqjz'
  while (value > 0) {
    word += letters[value % letters.length]
    value = Math.floor(value / letters.length)
  }
  return word
}

/** Mulberry32: a small deterministic generator for fixture construction only. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Zipf-distributed prose from which every message body takes a deterministic slice. */
class TextPool {
  private readonly text: string

  constructor() {
    const next = random(1)
    const cumulative: number[] = []
    let total = 0
    for (let rank = 1; rank <= VOCABULARY.words; rank++) {
      total += 1 / rank
      cumulative.push(total)
    }
    const words = Array.from({ length: VOCABULARY.words }, (_, rank) => vocabularyWord(rank))
    const parts: string[] = []
    for (let index = 0; index < VOCABULARY.poolWords; index++) {
      const target = next() * total
      let low = 0
      let high = cumulative.length - 1
      while (low < high) {
        const middle = (low + high) >>> 1
        if ((cumulative[middle] as number) < target) low = middle + 1
        else high = middle
      }
      parts.push(words[low] as string, index % 13 === 12 ? '.\n' : ' ')
    }
    this.text = parts.join('')
  }

  slice(next: () => number, length: number): string {
    if (length <= 0) return ''
    const span = Math.min(length, this.text.length)
    const start = Math.floor(next() * (this.text.length - span))
    return this.text.slice(start, start + span)
  }
}

interface PayloadPlan {
  readonly userChars: number
  readonly reasoningChars: number
  readonly textChars: number
  readonly resultChars: number
}

function planPayload(shape: SessionShape, toolSteps: number, payloadChars: number): PayloadPlan {
  const replies = toolSteps + shape.turns
  const textShare = toolSteps === 0 ? PAYLOAD_SHARE.text + PAYLOAD_SHARE.toolResult : PAYLOAD_SHARE.text
  return {
    userChars: Math.ceil((payloadChars * PAYLOAD_SHARE.user) / shape.turns),
    reasoningChars: Math.ceil((payloadChars * PAYLOAD_SHARE.reasoning) / replies),
    textChars: Math.ceil((payloadChars * textShare) / replies),
    resultChars: toolSteps === 0 ? 0 : Math.ceil((payloadChars * PAYLOAD_SHARE.toolResult) / toolSteps),
  }
}

function streamChunks(content: readonly ContentBlock[], finish: 'stop' | 'tool-calls'): StreamChunk[] {
  const chunks: StreamChunk[] = []
  content.forEach((block, index) => {
    chunks.push({ type: 'block-start', index, blockType: block.type })
    if (block.type === 'text' || block.type === 'reasoning') {
      const type = block.type === 'text' ? 'text-delta' : 'reasoning-delta'
      for (let offset = 0; offset < block.text.length; offset += DELTA_CHARS) {
        chunks.push({ type, index, text: block.text.slice(offset, offset + DELTA_CHARS) })
      }
    } else if (block.type === 'tool-call') {
      chunks.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments })
    }
    chunks.push({ type: 'block-end', index, block })
  })
  chunks.push({ type: 'usage', usage: { inputTokens: 20_000, outputTokens: 500 } })
  chunks.push({ type: 'finish', reason: { kind: finish } })
  return chunks
}

/** Raw log builder emitting the fields `Session.append` records, without its per-append validation. */
class RawLog {
  readonly events: SessionEvent[] = []
  readonly frameStarts = new Set<number>()

  constructor(private readonly createdAt: number) {}

  get seq(): number {
    return this.events.length
  }

  /** Start a durable flush batch at the next event. */
  flush(): void {
    this.frameStarts.add(this.events.length)
  }

  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    surface: { readonly surfaceOp?: 'append'; readonly sourceEventSeqs?: readonly number[] } = {},
  ): number {
    const seq = this.events.length
    this.events.push({ type, seq, time: this.createdAt + seq * 1_000, data, ...surface } as SessionEvent<T>)
    return seq
  }
}

/** Authors one Session with production stream compaction; replay validation belongs to the fixture test. */
function authorEvents(
  shape: SessionShape,
  payloadChars: number,
  pool: TextPool,
  seed: number,
): { readonly events: SessionEvent[]; readonly frameStarts: ReadonlySet<number> } {
  const next = random(seed)
  const toolSteps = Math.max(0, Math.ceil((shape.events - 6 * shape.turns - 1) / 5))
  const plan = planPayload(shape, toolSteps, payloadChars)
  const log = new RawLog(TIME_ZERO)
  for (let turn = 1; turn <= shape.turns; turn++) {
    const turnSteps = Math.floor(toolSteps / shape.turns) + (turn <= toolSteps % shape.turns ? 1 : 0)
    log.flush()
    log.append('turn/start', { turn })
    log.append('step/start', { turn, step: 1 })
    if (turn === 1) log.append('system/message', {
      turn, step: 1,
      message: {
        id: MessageId('system-head'), role: 'system',
        content: [{ type: 'text', text: pool.slice(next, SYSTEM_PROMPT_CHARS) }],
        source: { kind: 'system-prompt' },
      },
    }, { surfaceOp: 'append' })
    log.append('user/message', {
      id: MessageId('prompt-' + String(turn)), role: 'user',
      content: [{ type: 'text', text: pool.slice(next, plan.userChars) }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    for (let step = 1; step <= turnSteps + 1; step++) {
      if (step > 1) log.append('step/start', { turn, step })
      const callId = step <= turnSteps ? ToolCallId(`call-${String(turn)}-${String(step)}`) : undefined
      const content: ContentBlock[] = [
        { type: 'reasoning', text: pool.slice(next, plan.reasoningChars) },
        { type: 'text', text: pool.slice(next, plan.textChars) },
        ...callId === undefined ? [] : [{
          type: 'tool-call' as const, id: callId, name: 'read_file',
          arguments: JSON.stringify({ path: `src/module-${String(turn)}-${String(step)}.ts` }),
        }],
      ]
      const stream = new AssistantStreamAccumulator()
      const time = TIME_ZERO + log.seq * 1_000
      for (const [index, chunk] of streamChunks(content, callId === undefined ? 'stop' : 'tool-calls').entries()) {
        stream.push({ time: time + index, chunk })
      }
      log.flush()
      log.append('assistant/message', {
        turn, step,
        message: {
          id: MessageId(`reply-${String(turn)}-${String(step)}`), role: 'assistant', content,
          source: { kind: 'model', provider: 'bench', model: 'bench' },
        },
        stream: [...stream.snapshot()],
      }, { surfaceOp: 'append' })
      if (callId !== undefined) {
        log.flush()
        const callSeq = log.append('tool/call', {
          turn, step, callId, name: 'read_file', arguments: JSON.stringify({ path: `src/module-${String(turn)}-${String(step)}.ts` }),
        })
        log.flush()
        log.append('tool/result', {
          turn, step,
          message: {
            id: MessageId('result-' + callId), role: 'tool', toolCallId: callId, isError: false,
            source: { kind: 'tool', callId },
            content: [{ type: 'text', text: pool.slice(next, plan.resultChars) }],
          },
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
      }
      log.append('step/end', { turn, step })
    }
    log.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { events: log.events, frameStarts: log.frameStarts }
}

function frameTexts(events: readonly SessionEvent[], frameStarts: ReadonlySet<number>): string[] {
  const frames: string[] = []
  let start = 0
  for (let index = 1; index <= events.length; index++) {
    if (index === events.length || frameStarts.has(index)) {
      frames.push(eventLines(events.slice(start, index)) + '\n')
      start = index
    }
  }
  return frames
}

function headerLine(header: SessionHeader): string {
  return JSON.stringify(toHeaderLine(header)) + '\n'
}

/** Size facts of one anchor body, saved beside its compressed frames. */
export interface AnchorBodyFacts {
  readonly frameCount: number
  readonly events: number
  readonly logicalBytes: number
}

/** One compressed event body shared by every Session of one measured anchor. */
interface AnchorBody extends AnchorBodyFacts {
  readonly frames: Buffer
}

/** One corpus written from authored anchor bodies. */
export interface WrittenCorpus {
  /** Physical and logical totals. */
  readonly facts: SyntheticCorpusFacts
  /** Every stored Session in rank order. */
  readonly sessions: readonly WrittenSession[]
}

/**
 * Tell whether one corpus rank stores a subagent child.
 * @param rank - zero-based ascending length rank.
 * @returns whether the rank is a child of the preceding rank.
 */
export function subagentRank(rank: number): boolean {
  return rank % CHILD_EVERY === CHILD_EVERY - 1
}

/**
 * Build the stored header of one corpus rank.
 * @param rank - zero-based ascending length rank.
 * @param count - corpus size.
 * @returns the rank's header; every sixth rank is a subagent child of the preceding rank.
 */
export function corpusHeader(rank: number, count: number): SessionHeader {
  if (count % CREATION_STRIDE === 0) throw new Error('corpus size must be coprime with the creation stride')
  const child = subagentRank(rank)
  // Creation time is a fixed permutation of length rank. List order follows each body's last prompt time,
  // which Sessions sharing an anchor also share.
  const createdAt = TIME_ZERO - (((rank * CREATION_STRIDE) % count) + 1) * 60_000
  return {
    version: SESSION_FORMAT_VERSION,
    id: corpusSessionId(rank),
    createdAt,
    cwd: `/bench/project-${String(rank % Math.ceil(count / SESSIONS_PER_PROJECT))}`,
    isSeeded: false,
    ...child
      ? { origin: 'subagent' as const, parentSession: corpusSessionId(rank - 1), delegationDepth: 1 }
      : { delegationDepth: 0 },
  }
}

/**
 * Build the header under which one anchor's projections are folded before identity rebinding.
 * @param anchor - measured anchor index.
 * @returns a top-level header outside every corpus.
 */
export function anchorHeader(anchor: number): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(`bench-anchor-${String(anchor).padStart(2, '0')}`),
    createdAt: TIME_ZERO - 60_000,
    cwd: '/bench/anchors',
    isSeeded: false,
    delegationDepth: 0,
  }
}

function anchorBodyPath(directory: string, anchor: number): string {
  return join(directory, `anchor-${String(anchor).padStart(2, '0')}.zst`)
}

/**
 * Run one asynchronous compression or file operation per index with bounded concurrency.
 * @param count - number of indexes, starting at zero.
 * @param operation - operation for one index.
 */
export async function forEachConcurrently(count: number, operation: (index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < count; index = next++) await operation(index)
  }
  await Promise.all(Array.from({ length: IO_CONCURRENCY }, () => worker()))
}

/** Authors each anchor body once, exchanges bodies between seeding processes, and writes corpora that share them. */
export class SyntheticCorpusWriter {
  private pool: TextPool | undefined
  private readonly bodies = new Map<number, AnchorBody>()
  /** Stored-byte model from the previous anchor: fixed system prompt, bytes per event, and bytes per payload character. */
  private model = { bytesPerEvent: 0, bytesPerChar: 4 }

  /**
   * Author one anchor's body; its body bytes alone reach the anchor's logical-byte target.
   * @param anchor - measured anchor index.
   * @returns the authored events, which the writer does not retain.
   */
  async author(anchor: number): Promise<readonly SessionEvent[]> {
    const shape = anchorShape(anchor)
    // Start from the previous anchor's model, then take secant steps from below.
    const { bytesPerEvent, bytesPerChar } = this.model
    let payloadChars = Math.max(0, Math.ceil(
      (1.01 * (shape.logicalBytes - SYSTEM_PROMPT_CHARS - bytesPerEvent * shape.events)) / bytesPerChar,
    ))
    let previous: { readonly payloadChars: number; readonly bytes: number } | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
      this.pool ??= new TextPool()
      const authored = authorEvents(shape, payloadChars, this.pool, anchor + 1)
      if (authored.events.length < shape.events) {
        throw new Error(`corpus anchor ${String(anchor)} authored ${String(authored.events.length)} of ${String(shape.events)} events`)
      }
      const frames = frameTexts(authored.events, authored.frameStarts)
      const bytes = frames.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
      if (previous !== undefined && payloadChars > previous.payloadChars) {
        this.model.bytesPerChar = (bytes - previous.bytes) / (payloadChars - previous.payloadChars)
      }
      this.model.bytesPerEvent = (bytes - SYSTEM_PROMPT_CHARS - this.model.bytesPerChar * payloadChars) / authored.events.length
      if (bytes < shape.logicalBytes) {
        previous = { payloadChars, bytes }
        // Every message rounds its share up, so each step adds at least one character per event.
        payloadChars += Math.ceil((1.01 * (shape.logicalBytes - bytes)) / this.model.bytesPerChar) + shape.events
        continue
      }
      // Each pending compression owns a native Zstandard context, so compression is bounded like writes.
      const compressed: Buffer[] = []
      await forEachConcurrently(frames.length, async (index) => {
        compressed[index] = await compressZstdFrame(frames[index] as string)
      })
      this.bodies.set(anchor, {
        frames: Buffer.concat(compressed), frameCount: frames.length, events: authored.events.length, logicalBytes: bytes,
      })
      return authored.events
    }
    throw new Error(`corpus anchor ${String(anchor)} did not reach ${String(shape.logicalBytes)} logical bytes`)
  }

  /**
   * Save one authored body's compressed frames for another process.
   * @param directory - body directory shared by the seeding processes.
   * @param anchor - authored anchor index.
   * @returns the body's size facts.
   */
  async saveBody(directory: string, anchor: number): Promise<AnchorBodyFacts> {
    const body = this.bodies.get(anchor)
    if (body === undefined) throw new Error(`corpus anchor ${String(anchor)} was not authored`)
    await mkdir(directory, { recursive: true })
    await writeFile(anchorBodyPath(directory, anchor), body.frames)
    return { frameCount: body.frameCount, events: body.events, logicalBytes: body.logicalBytes }
  }

  /**
   * Load one body saved by another process.
   * @param directory - body directory shared by the seeding processes.
   * @param anchor - anchor index.
   * @param facts - size facts recorded with the body.
   */
  async loadBody(directory: string, anchor: number, facts: AnchorBodyFacts): Promise<void> {
    this.bodies.set(anchor, { ...facts, frames: await readFile(anchorBodyPath(directory, anchor)) })
  }

  /**
   * Write every rank of one corpus from authored bodies.
   * @param root - JSONL persistence root.
   * @param count - corpus size; the length distribution is sampled at this many ranks.
   * @returns totals and the stored headers.
   */
  async writeCorpus(root: string, count: number): Promise<WrittenCorpus> {
    const totals = { events: 0, logicalBytes: 0, compressedBytes: 0, frames: 0 }
    const sessions: WrittenSession[] = []
    await forEachConcurrently(count, async (rank) => {
      const { anchor } = sessionShape(rank, count)
      const body = this.bodies.get(anchor)
      if (body === undefined) throw new Error(`corpus anchor ${String(anchor)} was not authored`)
      const header = corpusHeader(rank, count)
      const line = headerLine(header)
      const physical = Buffer.concat([await compressZstdFrame(line), body.frames])
      const path = generationLogPath(root, header.cwd, header.id, SESSION_FORMAT_VERSION, 'zstd')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, physical)
      sessions[rank] = { header, anchor }
      totals.events += body.events
      totals.logicalBytes += Buffer.byteLength(line) + body.logicalBytes
      totals.compressedBytes += physical.byteLength
      totals.frames += body.frameCount + 1
    })
    return {
      facts: {
        sessions: count,
        projects: Math.ceil(count / SESSIONS_PER_PROJECT),
        distinctBodies: new Set(sessions.map(session => session.anchor)).size,
        ...totals,
      },
      sessions,
    }
  }
}
