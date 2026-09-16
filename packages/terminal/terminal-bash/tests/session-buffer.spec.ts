import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import type { TerminalReadRequest } from '@deepseek-ai/dsh-terminal'
import type { ResolvedConfig } from '../src/config.ts'
import { LocalPtySession } from '../src/session.ts'

class OutputProducer implements SubprocessTerminalHandle {
  readonly pid = 123
  readonly output = new PassThrough()
  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  readonly done = this.outcome.promise

  emit(text: string | Uint8Array): void {
    this.output.write(typeof text === 'string' ? Buffer.from(text) : text)
  }

  exit(): void {
    this.output.end()
    this.outcome.resolve({ exitCode: 0, signal: null })
  }

  async write(): Promise<void> {}
  async resize(): Promise<void> {}
  async inspectActivity() { return { state: 'unknown' as const, revision: 0 } }

  async inspectForeground() { return undefined }
  async signalForeground(): Promise<number> { return this.pid }
  async terminate(): Promise<void> {
    this.exit()
    await this.done
  }
}

const sessions: LocalPtySession[] = []

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close('buffer test cleanup')))
})

function fixture(overrides: Partial<ResolvedConfig> = {}) {
  const config: ResolvedConfig = {
    backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: [], rows: 24, cols: 80,
    scrollbackLines: 10_000, scrollbackMaxBytes: 4 * 1024 * 1024, maxReadBytes: 256 * 1024,
    pollIntervalMs: 60_000, exactProbeAfterMs: 60_000, idleSilenceMs: 60_000,
    handoffGraceMs: 60_000, timeoutMs: 60_000, disposeGraceMs: 60_000,
    ...overrides,
  }
  const producer = new OutputProducer()
  const session = new LocalPtySession(producer, config)
  sessions.push(session)
  return { producer, session }
}

// The reference deliberately retains the eager line-first, then UTF-8-tail algorithm.
function referenceTail(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + size > maxBytes) break
    bytes += size
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

class ReferenceBuffer {
  private text = ''
  private truncated = false

  constructor(private readonly maxBytes: number, private readonly maxLines?: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) return
    this.text += chunk
    if (this.maxLines !== undefined) {
      const lines = this.text.split('\n')
      if (lines.length > this.maxLines) {
        this.text = lines.slice(-this.maxLines).join('\n')
        this.truncated = true
      }
    }
    const bounded = referenceTail(this.text, this.maxBytes)
    this.text = bounded.text
    this.truncated ||= bounded.truncated
  }

  snapshot() { return { text: this.text, truncated: this.truncated } }

  consume() {
    const result = { delta: this.text, truncated: this.truncated }
    this.text = ''
    this.truncated = false
    return result
  }
}

function referenceRead(buffer: ReferenceBuffer, maxBytes: number, request: TerminalReadRequest = {}) {
  const snapshot = buffer.snapshot()
  const lines = snapshot.text.split('\n')
  const totalLines = snapshot.text.length === 0 ? 0 : lines.length
  const offset = request.offset ?? 0
  if (offset >= totalLines) {
    return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
  }
  const end = totalLines - offset
  const bounded = referenceTail(lines.slice(Math.max(0, end - (request.count ?? 500)), end).join('\n'), maxBytes)
  const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
  return {
    text: bounded.text, totalLines, lineBegin: offset, lineEnd: offset + returnedLines,
    truncated: snapshot.truncated || bounded.truncated,
  }
}

function deterministicChunks(alphabet: readonly string[], count: number): string[] {
  let state = 0x12345678
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return alphabet[state % alphabet.length] as string
  })
}

describe('LocalPtySession incremental output compatibility', () => {
  it('retains the exact tail across the default 4 MiB scrollback limit while consuming active output', async () => {
    const limit = 4 * 1024 * 1024
    const { producer, session } = fixture({ maxReadBytes: limit })
    const operation = session.startSend({ text: '', submit: false })
    const chunk = 'a'.repeat(4096)
    for (let index = 0; index < limit / chunk.length; index += 1) producer.emit(chunk)
    expect(session.read({})).toEqual({
      text: 'a'.repeat(limit), totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false,
    })

    producer.emit('界😀TAIL')
    const retained = `${'a'.repeat(limit - 11)}界😀TAIL`
    expect(session.read({})).toEqual({
      text: retained, totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: true,
    })
    expect(operation.readOutput()).toEqual({ delta: retained, truncated: true })
    expect(operation.readOutput()).toEqual({ delta: '', truncated: false })
    producer.emit('é')
    expect(operation.readOutput()).toEqual({ delta: 'é', truncated: false })
    producer.emit('done')
    producer.exit()
    await expect(operation.done).resolves.toEqual({
      viewport: 'done', waitReason: 'session_exit',
      sessionStatus: { kind: 'exited', exitCode: 0, signal: null }, truncated: true,
    })
    expect(operation.readOutput()).toEqual({ delta: 'done', truncated: false })
    expect(operation.readOutput()).toEqual({ delta: '', truncated: false })
  })

  it('counts trailing empty lines and keeps scrollback truncation sticky after empty reads', () => {
    const { producer, session } = fixture({ scrollbackLines: 3, scrollbackMaxBytes: 64, maxReadBytes: 64 })
    producer.emit('a\nb\n')
    expect(session.read({})).toEqual({ text: 'a\nb\n', totalLines: 3, lineBegin: 0, lineEnd: 3, truncated: false })
    producer.emit('\n')
    expect(session.read({})).toEqual({ text: 'b\n\n', totalLines: 3, lineBegin: 0, lineEnd: 3, truncated: true })
    expect(session.read({ count: 1 })).toEqual({ text: '', totalLines: 3, lineBegin: 0, lineEnd: 0, truncated: true })
    expect(session.read({ offset: 2, count: 1 }).text).toBe('b')
    expect(session.read({ offset: 3 }).truncated).toBe(true)
    producer.emit('')
    producer.emit('c')
    expect(session.read({}).text).toBe('b\n\nc')
    expect(session.read({}).truncated).toBe(true)
  })

  it('decodes split UTF-8 before byte eviction and bounds an oversized multibyte chunk', async () => {
    const { producer, session } = fixture({ scrollbackMaxBytes: 11, maxReadBytes: 11 })
    const operation = session.startSend({ text: '', submit: false })
    producer.emit('abc')
    const encoded = Buffer.from('界😀éz')
    producer.emit(encoded.subarray(0, 5))
    producer.emit(encoded.subarray(5, 7))
    producer.emit(encoded.subarray(7))
    expect(session.read({}).text).toBe('c界😀éz')
    expect(operation.readOutput()).toEqual({ delta: 'c界😀éz', truncated: true })
    producer.emit('界😀'.repeat(1000) + 'éEND')
    expect(session.read({}).text).toBe('😀éEND')
    expect(operation.readOutput()).toEqual({ delta: '😀éEND', truncated: true })
    expect(operation.readOutput()).toEqual({ delta: '', truncated: false })
    producer.emit('ok')
    producer.exit()
    expect((await operation.done).viewport).toBe('ok')
  })

  it('resets operation truncation independently of retained scrollback', async () => {
    const { producer, session } = fixture({ scrollbackMaxBytes: 128, maxReadBytes: 5 })
    const operation = session.startSend({ text: '', submit: false })
    for (let index = 0; index < 4; index += 1) {
      producer.emit('123456')
      expect(operation.readOutput()).toEqual({ delta: '23456', truncated: true })
      expect(operation.readOutput()).toEqual({ delta: '', truncated: false })
      producer.emit('é')
      expect(operation.readOutput()).toEqual({ delta: 'é', truncated: false })
    }
    producer.exit()
    expect(await operation.done).toMatchObject({ viewport: '', truncated: false, waitReason: 'session_exit' })
    expect(operation.readOutput()).toEqual({ delta: '', truncated: false })
  })

  it.each([[1, 1, 1], [17, 7, 3], [64, 13, 5]])(
    'matches eager reads and active output with byte caps %i/%i and %i lines',
    async (scrollbackMaxBytes, maxReadBytes, scrollbackLines) => {
      const { producer, session } = fixture({ scrollbackMaxBytes, maxReadBytes, scrollbackLines })
      const scrollback = new ReferenceBuffer(scrollbackMaxBytes, scrollbackLines)
      const output = new ReferenceBuffer(maxReadBytes)
      const operation = session.startSend({ text: '', submit: false })
      const chunks = deterministicChunks(['a', 'bc', '\n', '\n\n', '界', '😀', 'éz', '', 'long line\nend\n'], 120)
      for (const [index, chunk] of chunks.entries()) {
        producer.emit(chunk)
        scrollback.append(chunk)
        output.append(chunk)
        for (const request of [{}, { offset: 1, count: 2 }, { offset: 9, count: 1 }]) {
          expect(session.read(request)).toEqual(referenceRead(scrollback, maxReadBytes, request))
        }
        if (index % 7 === 0) expect(operation.readOutput()).toEqual(output.consume())
      }
      producer.exit()
      const expected = output.snapshot()
      expect(await operation.done).toMatchObject({
        viewport: expected.text, truncated: expected.truncated || scrollback.snapshot().truncated,
        waitReason: 'session_exit',
      })
      expect(operation.readOutput()).toEqual(output.consume())
      expect(operation.readOutput()).toEqual(output.consume())
    },
  )

  it('retains tiny producer chunks through multiple coalesced-node rollovers', async () => {
    const limit = 5000
    const { producer, session } = fixture({ scrollbackMaxBytes: limit, maxReadBytes: limit })
    const operation = session.startSend({ text: '', submit: false })
    const text = '0123456789'.repeat(1000)
    const checkpoints = new Set([1, 4096, 4097, 5000, 5001, 8193, text.length])
    for (let index = 0; index < text.length; index += 1) {
      producer.emit(text[index] as string)
      if (checkpoints.has(index + 1)) {
        expect(session.read({})).toEqual({
          text: text.slice(Math.max(0, index + 1 - limit), index + 1),
          totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: index + 1 > limit,
        })
      }
    }
    expect(operation.readOutput()).toEqual({ delta: text.slice(-limit), truncated: true })
    expect(operation.readOutput()).toEqual({ delta: '', truncated: false })
    producer.emit('fresh')
    producer.exit()
    expect(await operation.done).toMatchObject({ viewport: 'fresh', truncated: true, waitReason: 'session_exit' })
  })

  it('preserves split surrogate pairs when copied coalesced text reaches the eviction head', () => {
    const limit = 4100
    const { session } = fixture({ scrollbackMaxBytes: limit, maxReadBytes: limit })
    // Lone UTF-16 halves cannot pass through the session's TextDecoder unchanged.
    const buffer = session['scrollback']
    const reference = new ReferenceBuffer(limit, 10_000)
    const chunks = ['H', 'a'.repeat(4095), '\ud83d', '\ude00', 'xy', 'b'.repeat(4094), 'z', '\ud800', '\udfff']
    for (const chunk of chunks) {
      buffer.append(chunk)
      reference.append(chunk)
      expect(buffer.snapshot()).toEqual(reference.snapshot())
    }
    expect(buffer.snapshot()).toEqual({ text: `y${'b'.repeat(4094)}z\ud800\udfff`, truncated: true })
    expect(buffer.consume()).toEqual(reference.consume())
    expect(buffer.consume()).toEqual(reference.consume())
  })

  it.each([1, 2, 3, 4, 5, 8, 17])('preserves lone and split surrogates with a %i-byte limit', (maxBytes) => {
    const { session } = fixture({ scrollbackMaxBytes: maxBytes, maxReadBytes: maxBytes, scrollbackLines: 3 })
    // TextDecoder replaces lone surrogates; only these UTF-16 cases use the private buffer.
    const buffer = session['scrollback']
    const reference = new ReferenceBuffer(maxBytes, 3)
    const chunks = [
      '\ud83d', '\ude00', 'x', '\ud83d', '', '\ude00', '\n', '\ud800', 'abc', '\udfff',
      'prefix'.repeat(20) + '\ud800', '\udfff', '\n\n\n',
      ...deterministicChunks(['a', '\ud800', '\udfff', '\ud83d\ude00', '\n', 'é', '界', '', '\n\n'], 150),
    ]
    for (const [index, chunk] of chunks.entries()) {
      buffer.append(chunk)
      reference.append(chunk)
      expect(buffer.snapshot()).toEqual(reference.snapshot())
      if (index % 19 === 18) {
        expect(buffer.consume()).toEqual(reference.consume())
        expect(buffer.consume()).toEqual(reference.consume())
      }
    }
    expect(buffer.consume()).toEqual(reference.consume())
    buffer.append('x')
    reference.append('x')
    expect(buffer.snapshot()).toEqual(reference.snapshot())
  })
})
