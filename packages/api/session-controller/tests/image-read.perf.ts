/** Threshold-free, built-runtime measurements of uncached historical image requests. */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionAttachmentValue } from '../src/types.ts'

const WORKLOADS = {
  typical: { turns: 120, images: 8 },
  tail: { turns: 2_000, images: 32 },
} as const
const SAMPLES = 5
const WIDTH = 1024
const HEIGHT = 768

interface Timings {
  historyObservations: number
  historyQueries: number
  historySnapshots: number
  observationMs: number
  snapshotMs: number
  beforeStoreMs: number
  storeMs: number
  storeFinished: number
  started: number
}

/** Production point reads; full-text search is outside this diagnostic. */
class ImageReadSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('image read diagnostic does not search sessions'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('image read diagnostic does not search events'))
  }
}

function image(ordinal: number): Uint8Array {
  const pixels = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT)
  let seed = ordinal + 1
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const offset = y * (WIDTH * 3 + 1) + 1 + x * 3
      const value = x < WIDTH / 4 ? seed >>> 24 : (Math.floor(x / 16) + Math.floor(y / 16) + ordinal) % 256
      pixels[offset] = value
      pixels[offset + 1] = (value + ordinal * 17) % 256
      pixels[offset + 2] = (value + y) % 256
    }
  }
  const chunk = (name: string, data: Buffer): Buffer => {
    const output = Buffer.alloc(data.length + 12)
    output.writeUInt32BE(data.length)
    output.write(name, 4)
    data.copy(output, 8)
    output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4)
    return output
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH)
  header.writeUInt32BE(HEIGHT, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ])
}

function populate(session: Session, turns: number, refs: readonly ImageAttachmentRef[]): void {
  for (let turn = 1; turn <= turns; turn++) {
    const imageIndex = refs.findIndex((_, ordinal) => Math.floor(ordinal * turns / refs.length) + 1 === turn)
    const ref = refs[imageIndex]
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: MessageId(`input-${turn}`), role: 'user', source: { kind: 'user' },
      content: [
        { type: 'text', text: `Inspect synthetic module ${turn}. ` + 'Describe the visible result. '.repeat(8) },
        ...(ref === undefined ? [] : [{ type: 'image' as const, attachment: ref }]),
      ],
    }, { surfaceOp: 'append' })
    const callId = ToolCallId(`call-${turn}`)
    const call = session.append('tool/call', { turn, step: 1, callId, name: 'synthetic_read', arguments: '{}' })
    session.append('tool/result', {
      turn, step: 1,
      message: { id: MessageId(`result-${turn}`), role: 'tool', toolCallId: callId, isError: false,
        source: { kind: 'tool', callId }, content: [{ type: 'text', text: `module ${turn}\n` + 'export const value = 42;\n'.repeat(80) }] },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    const block = { type: 'text' as const, text: `Result ${turn}. ` + 'Synthetic response. '.repeat(40) }
    const stream = new AssistantStreamAccumulator()
    stream.push({ time: 1_700_000_000_000 + turn, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
    for (let offset = 0; offset < block.text.length; offset += 32) {
      stream.push({ time: 1_700_000_000_001 + turn + offset, chunk: { type: 'text-delta', index: 0, text: block.text.slice(offset, offset + 32) } })
    }
    stream.push({ time: 1_700_000_001_000 + turn, chunk: { type: 'block-end', index: 0, block } })
    stream.push({ time: 1_700_000_001_001 + turn, chunk: { type: 'finish', reason: { kind: 'stop' } } })
    session.append('assistant/message', {
      turn, step: 1, stream: [...stream.snapshot()],
      message: { id: MessageId(`reply-${turn}`), role: 'assistant', content: [block], source: { kind: 'model', provider: 'synthetic', model: 'synthetic' } },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

function memory(): { heapUsedBytes: number; rssBytes: number; peakRssBytes: number } {
  assert.ok(global.gc, 'run the diagnostic with --expose-gc')
  global.gc()
  const usage = process.memoryUsage()
  return { heapUsedBytes: usage.heapUsed, rssBytes: usage.rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
}

async function transfer(payloads: readonly string[]): Promise<readonly number[]> {
  let index = 0
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(payloads[index++])
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    const samples: number[] = []
    for (const payload of payloads) {
      const start = performance.now()
      const response: Response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(15_000) })
      const received: string = await response.text()
      samples.push(performance.now() - start)
      assert.equal(received, payload)
    }
    return samples
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  }
}

async function measure(workload: keyof typeof WORKLOADS) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-read-perf-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(ImageReadSessionQuery)
    await ctx.plugin(LocalAttachmentStore, { dshHome: root })
    const refs: ImageAttachmentRef[] = []
    for (let ordinal = 0; ordinal < WORKLOADS[workload].images; ordinal++) {
      refs.push(await ctx.attachments.saveImage({ data: image(ordinal), mediaType: 'image/png' }))
    }
    const session = ctx.sessions.create(SessionId('synthetic-image-history'), { meta: { cwd: '/synthetic-image-history' } })
    populate(session, WORKLOADS[workload].turns, refs)
    let timing: Timings = {
      historyObservations: 0, historyQueries: 0, historySnapshots: 0,
      observationMs: 0, snapshotMs: 0, beforeStoreMs: 0,
      storeMs: 0, storeFinished: 0, started: 0,
    }
    let traversedEvents = 0
    let countEvents = false
    const observeSession = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    ctx.sessionQuery.observeSession = async (...args) => {
      timing.historyObservations++
      const start = performance.now()
      try {
        return await observeSession(...args)
      } finally {
        timing.observationMs += performance.now() - start
      }
    }
    const getSession = ctx.sessions.get.bind(ctx.sessions)
    ctx.sessions.get = (id) => {
      timing.historyQueries++
      const found = getSession(id)
      return found === undefined ? undefined : new Proxy(found, {
        get(target, key) {
          const member: unknown = Reflect.get(target, key, target)
          if (key !== 'snapshotEvents' || typeof member !== 'function') return member
          return (...args: unknown[]) => {
            timing.historySnapshots++
            const start = performance.now()
            const events = Reflect.apply(member as (...args: unknown[]) => readonly unknown[], target, args)
            timing.snapshotMs += performance.now() - start
            if (!countEvents) return events
            return new Proxy(events, { get(array, property) {
              if (property !== Symbol.iterator) {
                const value: unknown = Reflect.get(array, property, array)
                return value
              }
              return function* () { for (const event of array) { traversedEvents++; yield event } }
            } })
          }
        },
      })
    }
    const attachments = ctx.attachments
    const observedAttachments = new Proxy(attachments, {
      get(target, key) {
        const member: unknown = Reflect.get(target, key, target)
        if (key !== 'readImage' || typeof member !== 'function') return member
        return async (...args: unknown[]) => {
          const start = performance.now()
          timing.beforeStoreMs = start - timing.started
          const result: unknown = await Reflect.apply(member, target, args)
          timing.storeFinished = performance.now()
          timing.storeMs = timing.storeFinished - start
          return result
        }
      },
    })
    const observedContext = new Proxy(ctx, {
      get(target, key) {
        if (key === 'attachments') return observedAttachments
        const value: unknown = Reflect.get(target, key, target)
        return value
      },
    })
    const controller = new SessionCommandController(observedContext, new ApiSessionAgentController(ctx), '/synthetic-image-history')
    const baselineMemory = memory()
    const outputs: SessionAttachmentValue[] = []
    const samples = []
    for (const ref of refs) {
      timing = {
        historyObservations: 0, historyQueries: 0, historySnapshots: 0,
        observationMs: 0, snapshotMs: 0, beforeStoreMs: 0,
        storeMs: 0, storeFinished: 0, started: performance.now(),
      }
      const cpu = process.cpuUsage()
      const value = await controller.attachment({ sessionId: session.id, attachment: ref })
      const completed = performance.now()
      const usedCpu = process.cpuUsage(cpu)
      assert.deepEqual(value.attachment, ref)
      assert.equal(`sha256:${createHash('sha256').update(Buffer.from(value.data, 'base64')).digest('hex')}`, ref.attachmentId)
      samples.push({
        controllerMs: completed - timing.started,
        controllerCpuMs: (usedCpu.user + usedCpu.system) / 1000,
        historyObservations: timing.historyObservations,
        historyQueries: timing.historyQueries, historySnapshots: timing.historySnapshots,
        observationMs: timing.observationMs, snapshotMs: timing.snapshotMs,
        scanAndDispatchMs: timing.beforeStoreMs - timing.observationMs - timing.snapshotMs,
        storeMs: timing.storeMs, base64AndReturnMs: completed - timing.storeFinished,
      })
      outputs.push(value)
    }
    const retainedMemory = memory()
    const jsonMs: number[] = []
    const payloads = outputs.map((value) => {
      const start = performance.now()
      const text = JSON.stringify(value)
      jsonMs.push(performance.now() - start)
      return text
    })
    const loopbackTransferMs = await transfer(payloads)
    countEvents = true
    timing.historyObservations = 0
    timing.historyQueries = 0
    timing.historySnapshots = 0
    for (const ref of refs) await controller.attachment({ sessionId: session.id, attachment: ref })
    const workCounts = {
      historyObservations: timing.historyObservations, historyQueries: timing.historyQueries,
      historySnapshots: timing.historySnapshots, traversedEvents,
    }
    if (process.argv.includes('--expect-no-history')) {
      assert.deepEqual(workCounts, { historyObservations: 0, historyQueries: 0, historySnapshots: 0, traversedEvents: 0 })
    }
    return {
      workload, fixture: { ...WORKLOADS[workload], events: session.seq, width: WIDTH, height: HEIGHT,
        imageBytes: refs.map(ref => ref.bytes), attachmentIds: refs.map(ref => ref.attachmentId),
        fullReferenceRequestJsonBytes: refs.map(attachment => Buffer.byteLength(JSON.stringify({ sessionId: session.id, attachment }))),
        idOnlyRequestJsonBytes: refs.map(ref => Buffer.byteLength(JSON.stringify({
          sessionId: session.id, attachmentId: ref.attachmentId,
        }))),
        responseJsonBytes: payloads.map(text => Buffer.byteLength(text)) },
      samples, jsonMs, loopbackTransferMs, workCounts, baselineMemory, retainedMemory,
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

for (const specifier of [
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-attachment-local', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query',
]) {
  assert.match(import.meta.resolve(specifier), /\/lib\/.*\.js$/, `${specifier} must resolve to built JavaScript`)
}
assert.ok(import.meta.url.endsWith('.js'), 'compile this diagnostic before running it')
assert.ok(process.execArgv.every(value => !value.includes('tsx')), 'do not use a TypeScript loader')

const workload = process.argv[3]
if (process.argv[2] === '--sample') {
  assert.ok(workload === 'typical' || workload === 'tail')
  process.stdout.write(`${JSON.stringify(await measure(workload))}\n`)
} else {
  const samples: unknown[] = []
  for (const name of Object.keys(WORKLOADS)) {
    for (let sample = 0; sample < SAMPLES; sample++) {
      const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--sample', name,
        ...process.argv.includes('--expect-no-history') ? ['--expect-no-history'] : []], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '', TSX_TSCONFIG_PATH: '' },
      })
      if (child.error !== undefined) throw child.error
      assert.equal(child.signal, null, child.stderr)
      assert.equal(child.status, 0, child.stderr)
      const report: unknown = JSON.parse(child.stdout)
      samples.push(report)
    }
  }
  process.stdout.write(JSON.stringify({
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
    clock: 'Fresh child per sample; loaded Session; first uncached request per image; OS file cache may be warm from fixture writes. Store includes file I/O, digest and header validation. observationMs measures the production SessionQuery point observation; snapshotMs measures its lazy event-array acquisition. scanAndDispatchMs is the residual before store entry after subtracting observation and snapshot acquisition. JSON and loopback HTTP transfer are separate measurements over retained responses. Gateway, browser, remote network, upload and model inference are excluded.',
    memory: 'GC after setup and after all image responses; Session and all base64 responses remain reachable. Process peak RSS includes fixture creation. No retained-memory budget.',
    samples,
  }, null, 2) + '\n')
}
