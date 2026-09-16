/** Terminal output ingestion and readiness with a deterministic provider boundary. */
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import type { SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { LocalPtySession } from './session-adapter.ts'

const MIB = 1024 * 1024
const CHUNK_BYTES = 16 * 1024

/** One fresh-session sample; retained heap includes the live session and returned output. */
export interface TerminalIoReport {
  mode: string
  capacityBytes: number
  chunkBytes: number
  prefillBytes: number
  timedBytes: number
  ingestMs: number
  completeMs: number
  retainedHeapBytes: number
  viewportBytes: number
  readBytes: number
  truncated: boolean
}

async function measure(capacityBytes: number, mode: string): Promise<TerminalIoReport> {
  const chunkBytes = mode === 'filtered' ? 64 * 1024 : mode === 'tiny' ? 16 : CHUNK_BYTES
  const chunk = Buffer.alloc(chunkBytes, 'x')
  if (mode === 'filtered') {
    // Each decoded callback has 56 KiB of discarded OSC followed by an 8 KiB string slice.
    chunk.write('\x1b]0;', 0)
    chunk[56 * 1024 - 1] = 7
  }
  const prefillBytes = mode === 'steady' ? capacityBytes : 0
  const timedBytes = mode === 'filtered' ? 513 * chunkBytes : mode === 'steady' ? MIB : 5 * MIB
  const output = new Readable({ read() {} })
  const ended = Promise.withResolvers<SubprocessOutcome>()
  const writeReady = Promise.withResolvers<void>()
  const terminal: SubprocessTerminalHandle = {
    pid: 1,
    output,
    done: ended.promise,
    async write() { writeReady.resolve() },
    async resize() {},
    async inspectActivity() { return { state: 'unknown', revision: 0 } },
    async inspectForeground() { return { processGroupId: 1, inputWaiting: false } },
    async signalForeground() { return 1 },
    async terminate() {
      output.emit('end')
      ended.resolve({ exitCode: 0, signal: null })
      await ended.promise
    },
  }
  global.gc?.()
  const heapBefore = process.memoryUsage().heapUsed
  const session = new LocalPtySession(terminal, {
    backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: [],
    rows: 40, cols: 160, scrollbackLines: 10_000, scrollbackMaxBytes: capacityBytes,
    maxReadBytes: Math.min(256 * 1024, capacityBytes),
    pollIntervalMs: 1, exactProbeAfterMs: 150, idleSilenceMs: 1,
    handoffGraceMs: 1, timeoutMs: 120_000, disposeGraceMs: 1,
  })
  try {
    if (prefillBytes > 0) {
      const prefill = session.startSend({ text: 'prefill', submit: false })
      await writeReady.promise
      for (let bytes = 0; bytes < prefillBytes; bytes += chunkBytes) output.emit('data', chunk)
      const ready = await prefill.done
      if (ready.waitReason !== 'inferred_idle') throw new Error('prefill did not reach readiness')
    }
    const start = performance.now()
    const operation = session.startSend({ text: '', submit: false })
    for (let bytes = 0; bytes < timedBytes; bytes += chunkBytes) output.emit('data', chunk)
    const ingestMs = performance.now() - start
    const result = await operation.done
    const read = session.read({ count: 10_000 })
    const completeMs = performance.now() - start
    if (result.waitReason !== 'inferred_idle' || !result.truncated || !read.truncated) {
      throw new Error('output did not reach bounded ready endpoint')
    }
    const expectedBytes = Math.min(256 * 1024, capacityBytes)
    if (Buffer.byteLength(result.viewport) !== expectedBytes || Buffer.byteLength(read.text) !== expectedBytes) {
      throw new Error('bounded output endpoint has unexpected byte count')
    }
    global.gc?.()
    return {
      mode, capacityBytes, chunkBytes, prefillBytes, timedBytes, ingestMs, completeMs,
      retainedHeapBytes: process.memoryUsage().heapUsed - heapBefore,
      viewportBytes: Buffer.byteLength(result.viewport), readBytes: Buffer.byteLength(read.text),
      truncated: result.truncated && read.truncated,
    }
  } finally {
    await session.close('benchmark complete')
    output.destroy()
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-terminal': import.meta.resolve('@deepseek-ai/dsh-terminal'),
})
const capacityBytes = Number(process.argv[2])
const mode = process.argv[3]
if (![128 * 1024, 4 * MIB].includes(capacityBytes) || (mode !== 'steady' && mode !== 'full' && mode !== 'tiny' && mode !== 'filtered')) {
  throw new Error('usage: terminal-io.worker.js <131072|4194304> <steady|full|tiny|filtered>')
}
console.log(JSON.stringify(await measure(capacityBytes, mode)))
