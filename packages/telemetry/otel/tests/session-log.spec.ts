import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import OTel from '../src/index.ts'
import { Agent, createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base'
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SESSION_LOG_MAX_REQUEST_BYTES, type SessionLogRecord, type SessionLogOptions } from '../src/session-log.ts'

interface Capture {
  bytes: number
  headers: IncomingHttpHeaders
  body: { resourceLogs: { resource: unknown; scopeLogs: { logRecords: Record<string, unknown>[] }[] }[] }
}
const cleanup: (() => Promise<void>)[] = []
let ctx: Context
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  } finally {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

beforeEach(async () => {
  ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(OTel)
  vi.stubEnv('OTEL_EXPORTER_OTLP_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', undefined)
})

async function collector(statuses = [200]) {
  const captures: Capture[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const bytes = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      captures.push({ bytes: bytes.length, headers: req.headers, body: JSON.parse(bytes.toString()) as Capture['body'] })
      res.writeHead(statuses.shift() ?? 200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  cleanup.push(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('collector has no port')
  return { captures, endpoint: `http://127.0.0.1:${address.port}/v1/logs` }
}

function sessionRecord(text: string, seq = 0): SessionLogRecord {
  return {
    sessionId: SessionId('synthetic-session'),
    event: { type: 'user/message', seq: SessionSeq(seq), time: 1_800_000_000_000, surfaceOp: 'append',
      data: { content: [{ type: 'text', text }], nested: { items: [null, true, false, 0, 1.5, { text }] } } },
  }
}

function logs(capture: Capture) {
  return capture.body.resourceLogs.flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords))
}

function contents(captures: Capture[]): string[] {
  return captures.flatMap(capture => logs(capture).map((record) => {
    const attributes = record['attributes'] as { key: string; value: { stringValue: string } }[]
    return attributes.find(attribute => attribute.key === 'content')!.value.stringValue
  }))
}

function parseContent(content: string): unknown {
  return JSON.parse(content)
}

function reporter(endpoint: string, overrides: Partial<SessionLogOptions> = {}) {
  const onFailure = vi.fn()
  const sender = ctx.otel.createSessionLogReporter({
    scope: { name: '@deepseek-ai/dsh-session-telemetry-otel', version: (createRequire(import.meta.url)('../package.json') as { version: string }).version },
    exporter: { url: endpoint, timeoutMillis: 1000 }, resourceAttributes: { 'service.name': 'session-test' },
    processor: { scheduledDelayMillis: 60000 }, onFailure, ...overrides,
  })
  cleanup.push(() => sender.shutdown())
  return { sender, onFailure }
}

it('preserves full nested events without truncation or ambient headers and retains scope version', async () => {
  vi.stubEnv('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT', '8')
  vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer%20unrelated')
  const target = await collector()
  const { sender } = reporter(target.endpoint)
  const record = sessionRecord('中文\n"quote"\\path 😀')
  sender.reportSessionLog(record)
  await sender.shutdown()
  expect(contents(target.captures).map(parseContent)).toEqual([record.event])
  expect(logs(target.captures[0]!)[0]).toMatchObject({ eventName: 'session-log' })
  expect(target.captures[0]!.headers).not.toHaveProperty('authorization')
  expect(target.captures[0]!.headers).not.toHaveProperty('x-channel')
  expect(target.captures[0]!.body.resourceLogs[0]!.scopeLogs[0]).toMatchObject({
    scope: { name: '@deepseek-ai/dsh-session-telemetry-otel', version: (createRequire(import.meta.url)('../package.json') as { version: string }).version },
  })
})

it.each([CompressionAlgorithm.GZIP, CompressionAlgorithm.NONE])('bounds %s requests and preserves nested content', async (compression) => {
  const target = await collector()
  const { sender, onFailure } = reporter(target.endpoint, { exporter: { url: target.endpoint, compression, concurrencyLimit: 1 } })
  const records = [0,1,2].map(seq => sessionRecord('中"\\'.repeat(100000), seq))
  for (const record of records) sender.reportSessionLog(record)
  await sender.shutdown()
  expect(target.captures.length).toBeGreaterThan(1)
  expect(target.captures.every(c => c.bytes <= SESSION_LOG_MAX_REQUEST_BYTES)).toBe(true)
  expect(contents(target.captures).map(parseContent)).toEqual(records.map(r => r.event))
  expect(onFailure).not.toHaveBeenCalled()
})

it('admits an exact request and diagnoses an oversized record only once', async () => {
  const target = await collector()
  const record = sessionRecord('边界"\\')
  const baseline = reporter(target.endpoint).sender
  baseline.reportSessionLog(record)
  await baseline.shutdown()
  const limit = target.captures[0]!.bytes
  const exact = reporter(target.endpoint, { maxRequestBytes: limit }).sender
  exact.reportSessionLog(record)
  await exact.shutdown()
  const small = reporter(target.endpoint, { maxRequestBytes: limit - 1 })
  small.sender.reportSessionLog(record)
  await small.sender.shutdown()
  expect(target.captures.map(c => c.bytes)).toEqual([limit, limit])
  expect(small.onFailure).toHaveBeenCalledTimes(1)
  expect(small.onFailure).toHaveBeenCalledWith('Session log record rejected; content was not truncated', expect.any(Error))
})

it('continues after an oversized record and a failed HTTP request', async () => {
  const target = await collector([400,200])
  const { sender, onFailure } = reporter(target.endpoint, { maxRequestBytes: 1300 })
  const records = [sessionRecord('first'.repeat(25)), sessionRecord('x'.repeat(4000000),1), sessionRecord('last'.repeat(25),2)]
  for(const record of records) sender.reportSessionLog(record)
  await sender.shutdown()
  expect(contents(target.captures).map(parseContent)).toEqual([records[0]!.event,records[2]!.event])
  expect(onFailure).toHaveBeenCalledTimes(2)
})

it.each([0,-1,1.5,4000001,Infinity])('rejects byte limit %s', (maxRequestBytes) => {
  expect(() => reporter('http://collector.test/logs',{ maxRequestBytes })).toThrow('maxRequestBytes')
})

it.each(['maxQueueSize','maxExportBatchSize','scheduledDelayMillis','exportTimeoutMillis'] as const)('rejects invalid %s', (key) => {
  expect(() => reporter('http://collector.test/logs',{ processor:{ [key]:0 } })).toThrow(`processor.${key}`)
})

it('rejects a batch count above the queue capacity', () => {
  expect(() => reporter('http://collector.test/logs',{ processor:{ maxQueueSize:1,maxExportBatchSize:2 } })).toThrow('maxExportBatchSize must not exceed maxQueueSize')
})

it('honors explicit routing headers and caller-owned agent settings', async () => {
  const target = await collector()
  const agent = new Agent({ keepAlive:false })
  cleanup.push(async () => {agent.destroy()})
  const { sender } = reporter(target.endpoint,{ exporter:{ url:target.endpoint,userAgent:'session-test',keepAlive:true,httpAgentOptions:async () => agent,headers:async () => ({ 'x-channel':'test-channel' }) } })
  sender.reportSessionLog(sessionRecord('agent'))
  await sender.shutdown()
  expect(target.captures[0]!.headers.connection).toBe('close')
  expect(target.captures[0]!.headers['x-channel']).toBe('test-channel')
  expect(target.captures[0]!.headers['user-agent']).toContain('session-test')
})

it.each([new Error('serialize'), 'serialize', undefined])('contains serializer failures %s', (failure) => {
  const { sender,onFailure } = reporter('http://collector.test/logs')
  vi.spyOn(JsonLogsSerializer,'serializeRequest').mockImplementationOnce(() => { if(failure===undefined)return undefined; throw failure })
  sender.reportSessionLog(sessionRecord('invalid'))
  expect(onFailure).toHaveBeenCalledWith('Session log serialization failed; record rejected',expect.any(Error))
})

it('measures each record once instead of serializing the full candidate batch', async () => {
  const target = await collector()
  const { sender } = reporter(target.endpoint,{ maxRequestBytes:1300 })
  const serialize = vi.spyOn(JsonLogsSerializer,'serializeRequest')
  const records = Array.from({ length:100 },(_,seq) => sessionRecord('batch'.repeat(20),seq))
  for(const record of records)sender.reportSessionLog(record)
  await sender.shutdown()
  expect(contents(target.captures).map(parseContent)).toEqual(records.map(r=>r.event))
  expect(serialize.mock.calls.every(([records])=>records.length===1)).toBe(true)
  expect(serialize).toHaveBeenCalledTimes(records.length+target.captures.length)
})

it('keeps one transport slot across multiple byte batches and times each request independently', async () => {
  vi.useFakeTimers()
  const transport = await import('../src/transport.ts')
  const sent: number[] = []
  let active = 0
  let peak = 0
  vi.spyOn(transport, 'createLogExporter').mockReturnValue({
    export(records, callback) {
      active++
      peak = Math.max(peak, active)
      sent.push(...records.map(r => (JSON.parse(r.attributes.content as string) as { seq: number }).seq))
      setTimeout(() => { active--; callback({ code: 0 }) }, 800)
    },
    forceFlush: async () => {}, shutdown: async () => {},
  })
  const { sender, onFailure } = reporter('http://collector.test/logs', {
    exporter: { url: 'http://collector.test/logs', concurrencyLimit: 1 },
    maxRequestBytes: 1300,
    processor: { maxExportBatchSize: 3, maxQueueSize: 6, scheduledDelayMillis: 60000, exportTimeoutMillis: 1500 },
  })
  for(let seq = 0; seq < 6; seq++) sender.reportSessionLog(sessionRecord('content'.repeat(20), seq))
  const done = sender.shutdown()
  await vi.advanceTimersByTimeAsync(4800)
  await done
  expect(sent).toEqual([0,1,2,3,4,5])
  expect(peak).toBe(1)
  expect(onFailure).not.toHaveBeenCalled()
})

it('does not release the transport slot on a watchdog timeout or send queued records after the shutdown deadline', async () => {
  vi.useFakeTimers()
  const transport = await import('../src/transport.ts')
  const callback = Promise.withResolvers<(result: { code: 0 }) => void>()
  const send = vi.fn((_records, complete: (result: { code: 0 }) => void) => { callback.resolve(complete) })
  vi.spyOn(transport, 'createLogExporter').mockReturnValue({ export: send, forceFlush: async () => {}, shutdown: async () => {} })
  const { sender, onFailure } = reporter('http://collector.test/logs', {
    processor: { maxExportBatchSize: 1, maxQueueSize: 2, exportTimeoutMillis: 100, scheduledDelayMillis: 1000 },
  })
  sender.reportSessionLog(sessionRecord('first'))
  const finish = await callback.promise
  cleanup.push(async () => { sender.stopPending(); finish({ code: 0 }) })
  sender.reportSessionLog(sessionRecord('queued',1))
  await vi.advanceTimersByTimeAsync(500)
  expect(send).toHaveBeenCalledTimes(1)
  expect(onFailure).toHaveBeenCalledWith('Session log request exceeded exportTimeoutMillis; waiting for transport settlement')
  sender.stopPending()
  sender.reportSessionLog(sessionRecord('after deadline',2))
  const done = sender.shutdown()
  finish({ code:0 })
  await done
  sender.reportSessionLog(sessionRecord('late',2))
  expect(send).toHaveBeenCalledTimes(1)
})

it.each([new Error('transport'), 'transport', undefined])('contains transport failures %s and continues later requests', async (failure) => {
  const transport = await import('../src/transport.ts')
  const send = vi.fn<import('@opentelemetry/sdk-logs').LogRecordExporter['export']>()
    .mockImplementationOnce((_records, callback) => { if(failure === undefined) callback({ code:1 }); else throw failure })
    .mockImplementation((_records, callback) => { callback({ code:0 }) })
  vi.spyOn(transport,'createLogExporter').mockReturnValue({ export:send,forceFlush:async()=>{},shutdown:async()=>{} })
  const { sender,onFailure } = reporter('http://collector.test/logs',{ processor:{ maxExportBatchSize:1 } })
  sender.reportSessionLog(sessionRecord('failed'))
  sender.reportSessionLog(sessionRecord('next',1))
  await sender.shutdown()
  expect(send).toHaveBeenCalledTimes(2)
  expect(onFailure).toHaveBeenCalledTimes(1)
})

it('bounds the queued record count while a transport request is unsettled', async () => {
  const transport = await import('../src/transport.ts')
  const release = Promise.withResolvers<(result:{ code:0 })=>void>()
  vi.spyOn(transport,'createLogExporter').mockReturnValue({
    export(_records,callback){release.resolve(callback)},forceFlush:async()=>{},shutdown:async()=>{},
  })
  const { sender,onFailure } = reporter('http://collector.test/logs',{ processor:{ maxExportBatchSize:1,maxQueueSize:2 } })
  for(let seq=0;seq<4;seq++)sender.reportSessionLog(sessionRecord('queued',seq))
  const finish = await release.promise
  cleanup.push(async () => { sender.stopPending(); finish({ code: 0 }) })
  expect(onFailure).toHaveBeenCalledWith('Session log queue is full; record rejected')
  sender.stopPending()
  const done=sender.shutdown()
  finish({ code:0 })
  await done
})

it('keeps ordinary events and Session logs in independent channels through one Cordis service', async () => {
  const target = await collector()
  const ordinary = ctx.otel.createEventReporter({
    exporter: { url: target.endpoint },
    resourceAttributes: { 'service.name': 'ordinary-test' },
    scope: { name: 'ordinary-consumer', version: '1' },
    processor: { scheduledDelayMillis: 60000 },
    onFailure: () => { throw new Error('unexpected export failure') },
  })
  cleanup.push(() => ordinary.shutdown())
  const { sender } = reporter(target.endpoint)
  ordinary.emit({ eventName: 'ui.click', body: 'click', timestamp: Date.now() })
  sender.reportSessionLog(sessionRecord('authorized'))
  expect(target.captures).toEqual([])
  await sender.shutdown()
  expect(target.captures.flatMap(logs).map(r => r.eventName)).toEqual(['session-log'])
  await ordinary.shutdown()
  expect(target.captures.map(c => logs(c).map(r => r.eventName))).toEqual([['session-log'], ['ui.click']])
  await ctx.fiber.dispose()
  expect(ctx.get('otel')).toBeUndefined()
})
