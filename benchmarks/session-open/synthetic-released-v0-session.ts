/** Deterministic released-v0 Zstandard Session input for opening benchmarks. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { generationLogFilename } from '../../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'
import {
  SYNTHETIC_SESSION_CWD,
  SYNTHETIC_SESSION_DIRECTORY,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_V0_FILENAME,
} from './session-open.constants.ts'

export {
  SYNTHETIC_SESSION_CWD,
  SYNTHETIC_SESSION_DIRECTORY,
  SYNTHETIC_SESSION_ID,
  SYNTHETIC_V0_FILENAME,
} from './session-open.constants.ts'

/** Fixed workload parameters used by every Session-opening scenario. */
export interface SyntheticV0SessionShape {
  /** Completed turns, each with one user prompt and one streamed assistant reply. */
  readonly turns: number
  /** Text deltas per reply; each reply also contains one quarter as many reasoning deltas. */
  readonly textDeltas: number
}

/** Canonical current-generation filename produced by the runtime under test. */
export const SYNTHETIC_CURRENT_FILENAME = generationLogFilename(SESSION_FORMAT_VERSION, 'zstd')
/** Report label for a fresh-process reopen of the runtime's current generation. */
export const SYNTHETIC_CURRENT_GENERATION = `current-v${String(SESSION_FORMAT_VERSION)}`

const TIME_ZERO = 1_700_000_000_000
/** One body frame per row preserves the historical many-frame workload deterministically. */
const ROWS_PER_FRAME = 1

type SyntheticPhysicalRow = Readonly<Record<string, unknown>>

/** Complete metadata returned after writing one synthetic source generation. */
export interface SyntheticV0SessionWrite {
  readonly path: string
  readonly compressedBytes: number
  readonly logicalBytes: number
  readonly events: number
  readonly rows: number
  readonly frames: number
}

/** Owns the immutable released-v0 physical layout used only as benchmark input. */
class ReleasedV0FixtureBuilder {
  readonly rows: SyntheticPhysicalRow[] = []
  private seq = 0
  private time = TIME_ZERO

  get eventCount(): number {
    return this.seq
  }

  appendTurns(shape: SyntheticV0SessionShape): void {
    const reasoningDeltas = Math.floor(shape.textDeltas / 4)
    for (let turn = 1; turn <= shape.turns; turn += 1) {
      this.appendTurn(turn, reasoningDeltas, shape.textDeltas)
    }
  }

  private appendTurn(turn: number, reasoningDeltaCount: number, textDeltaCount: number): void {
    this.appendEvent('turn/start', { turn })
    this.appendEvent('user/message', {
      id: `user-${String(turn)}`,
      role: 'user',
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    this.appendEvent('step/start', { turn, step: 1 })
    const firstChunkSeq = this.appendChunk(turn, { type: 'block-start', index: 0, blockType: 'reasoning' })
    const reasoningDeltas = Array.from(
      { length: reasoningDeltaCount },
      (_, index) => `r${String(index)} `,
    )
    this.appendDeltas('reasoning', turn, 0, reasoningDeltas)
    const reasoning = reasoningDeltas.join('')
    this.appendChunk(turn, { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
    this.appendChunk(turn, { type: 'block-start', index: 1, blockType: 'text' })
    const textDeltas = Array.from(
      { length: textDeltaCount },
      (_, index) => `w${String(index)} `,
    )
    this.appendDeltas('text', turn, 1, textDeltas)
    const text = textDeltas.join('')
    this.appendChunk(turn, { type: 'block-end', index: 1, block: { type: 'text', text } })
    const usage = { inputTokens: 100, outputTokens: textDeltaCount }
    this.appendChunk(turn, { type: 'usage', usage })
    const lastChunkSeq = this.appendChunk(turn, { type: 'finish', reason: { kind: 'stop' } })
    this.appendEvent('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `assistant-${String(turn)}`,
        role: 'assistant',
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage,
    }, { sourceEventSeqs: [[firstChunkSeq, lastChunkSeq]], surfaceOp: 'append' })
    this.appendEvent('step/end', { turn, step: 1 })
    this.appendEvent('turn/end', { turn, reason: { kind: 'completed' } })
  }

  private appendChunk(turn: number, chunk: unknown): number {
    return this.appendEvent('assistant/chunk', { turn, step: 1, chunk })
  }

  private appendDeltas(
    kind: 'reasoning' | 'text',
    turn: number,
    index: number,
    deltas: readonly string[],
  ): void {
    if (deltas.length < 3) {
      for (const delta of deltas) {
        this.appendChunk(turn, {
          type: `${kind}-delta`,
          index,
          text: delta,
        })
      }
      return
    }
    this.rows.push({
      type: `${kind}-chunks`,
      seq0: this.seq,
      time0: this.time,
      data: {
        turn,
        step: 1,
        index,
        dt: Array.from({ length: deltas.length - 1 }, () => 1),
        texts: deltas,
      },
    })
    this.seq += deltas.length
    this.time += deltas.length
  }

  private appendEvent(
    type: string,
    data: unknown,
    extra: Readonly<Record<string, unknown>> = {},
  ): number {
    const seq = this.seq
    this.rows.push({ type, seq, time: this.time, data, ...extra })
    this.seq += 1
    this.time += 1
    return seq
  }
}

/**
 * Write one deterministic released-v0 Zstandard generation.
 * @param root - JSONL persistence root.
 * @param shape - workload size.
 * @returns physical and logical workload facts.
 */
export async function writeSyntheticReleasedV0Session(
  root: string,
  shape: SyntheticV0SessionShape,
): Promise<SyntheticV0SessionWrite> {
  const fixture = new ReleasedV0FixtureBuilder()
  fixture.appendTurns(shape)
  const header = {
    type: 'session',
    version: 0,
    id: SYNTHETIC_SESSION_ID,
    createdAt: TIME_ZERO,
    cwd: SYNTHETIC_SESSION_CWD,
    delegationDepth: 0,
  }
  const headerLine = `${JSON.stringify(header)}\n`
  const bodyFrames: Buffer[] = []
  let logicalBytes = Buffer.byteLength(headerLine)
  for (let index = 0; index < fixture.rows.length; index += ROWS_PER_FRAME) {
    const rows = fixture.rows.slice(index, index + ROWS_PER_FRAME)
    const text = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
    logicalBytes += Buffer.byteLength(text)
    bodyFrames.push(await compressZstdFrame(text))
  }
  const physical = Buffer.concat([
    await compressZstdFrame(headerLine),
    ...bodyFrames,
  ])
  const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const path = join(directory, SYNTHETIC_V0_FILENAME)
  await writeFile(path, physical)
  return {
    path,
    compressedBytes: physical.byteLength,
    logicalBytes,
    events: fixture.eventCount,
    rows: fixture.rows.length,
    frames: fixture.rows.length + 1,
  }
}
