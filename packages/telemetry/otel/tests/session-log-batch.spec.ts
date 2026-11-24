import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import OTel from '../src/index.ts'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionLogBatch, SessionLogBatchEvent } from '../src/session-log-batch.ts'
import type { SessionLogReporter } from '../src/session-log.ts'

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
  }
})

beforeEach(async () => {
  ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(OTel)
  vi.stubEnv('OTEL_EXPORTER_OTLP_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', undefined)
})

async function collector() {
  const captures: Capture[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const bytes = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      captures.push({ bytes: bytes.length, headers: req.headers, body: JSON.parse(bytes.toString()) as Capture['body'] })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
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

function reporter(endpoint: string): SessionLogReporter {
  const sender = ctx.otel.createSessionLogReporter({
    scope: { name: '@deepseek-ai/dsh-session-telemetry-otel', version: (createRequire(import.meta.url)('../package.json') as { version: string }).version },
    exporter: { url: endpoint, timeoutMillis: 1000 },
    resourceAttributes: { 'service.name': 'session-batch-test' },
    processor: { scheduledDelayMillis: 60000 },
    onFailure: () => { throw new Error('unexpected export failure') },
  })
  cleanup.push(() => sender.shutdown())
  return sender
}

function logs(capture: Capture): Record<string, unknown>[] {
  return capture.body.resourceLogs.flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords))
}

/** Attribute lookup for one captured record. */
function attribute(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const attributes = record['attributes'] as { key: string; value: Record<string, unknown> }[]
  return attributes.find(candidate => candidate.key === key)?.value
}

const SESSION_ID = brandString<SessionId>('synthetic-session')

function batch(events: SessionLogBatchEvent[], overrides: Partial<SessionLogBatch> = {}): SessionLogBatch {
  const first = events[0]
  const last = events.at(-1)
  return {
    sessionId: SESSION_ID,
    formatVersion: 4,
    afterSeq: first === undefined ? 0 : Number(first.seq) - 1,
    throughSeq: last === undefined ? 0 : Number(last.seq),
    batchId: 'batch-1',
    purpose: 'conversation',
    events,
    ...overrides,
  }
}

it('ships one record per batch with delivery attributes and an events-array body', async () => {
  const target = await collector()
  const sender = reporter(target.endpoint)
  const events: SessionLogBatchEvent[] = [
    { type: 'turn/start', seq: SessionSeq(1025), time: 1_800_000_000_000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: SessionSeq(1026),
      time: 1_800_000_000_001,
      surfaceOp: 'append',
      sourceEventSeqs: [SessionSeq(1025)],
      data: { content: [{ type: 'text', text: 'hello' }] },
    },
  ]
  sender.reportSessionLogBatch(batch(events))
  await sender.shutdown()

  const records = logs(target.captures[0]!)
  expect(records).toHaveLength(1)
  const [record] = records
  expect(record!['eventName']).toBe('session-log')
  expect(record!['timeUnixNano']).toBe(String(1_800_000_000_001 * 1_000_000))
  expect(attribute(record!, 'session.id')).toEqual({ stringValue: SESSION_ID })
  expect(attribute(record!, 'session.format_version')).toEqual({ intValue: 4 })
  expect(attribute(record!, 'delivery.batch_id')).toEqual({ stringValue: 'batch-1' })
  expect(attribute(record!, 'delivery.after_seq')).toEqual({ intValue: 1024 })
  expect(attribute(record!, 'delivery.through_seq')).toEqual({ intValue: 1026 })
  expect(attribute(record!, 'delivery.event_count')).toEqual({ intValue: 2 })
  expect(attribute(record!, 'delivery.purpose')).toEqual({ stringValue: 'conversation' })
  expect(record!['attributes']).toHaveLength(7)
  const body = JSON.parse((record!['body'] as { stringValue: string }).stringValue) as { events: unknown[] }
  expect(body.events).toEqual([
    { type: 'turn/start', seq: 1025, time: 1_800_000_000_000, data: { turn: 1 } },
    { type: 'user/message', seq: 1026, time: 1_800_000_000_001, data: { content: [{ type: 'text', text: 'hello' }] }, surfaceOp: 'append', sourceEventSeqs: [1025] },
  ])
})

it('serializes each event exactly as the per-event content attribute does', async () => {
  const target = await collector()
  const sender = reporter(target.endpoint)
  const events: SessionLogBatchEvent[] = [
    { type: 'developer/message', seq: SessionSeq(5), time: 1_799_999_999_998, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'developer' }] } },
    { type: 'system/message', seq: SessionSeq(6), time: 1_799_999_999_999, surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(2) }, sourceEventSeqs: [SessionSeq(1)], data: { content: [{ type: 'text', text: 'system' }] } },
    {
      type: 'assistant/message',
      seq: SessionSeq(7),
      time: 1_800_000_000_000,
      surfaceOp: { op: 'replace', startSeq: SessionSeq(3), endSeq: SessionSeq(5) },
      data: { content: [{ type: 'text', text: '中文\n"quote"\\path 😀' }], nested: { items: [null, true, false, 0, 1.5] } },
    },
    { type: 'tool/result', seq: SessionSeq(8), time: 1_800_000_000_001, surfaceOp: 'append', data: { ok: false } },
    { type: 'turn/end', seq: SessionSeq(9), time: 1_800_000_000_002, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  for (const event of events) sender.reportSessionLog({ sessionId: SESSION_ID, event })
  sender.reportSessionLogBatch(batch(events))
  await sender.shutdown()

  const sent = target.captures.flatMap(logs)
  const perEvent: unknown[] = sent
    .filter(record => attribute(record, 'content') !== undefined)
    .map((record): unknown => JSON.parse(attribute(record, 'content')!['stringValue'] as string))
  const batched = sent
    .filter(record => attribute(record, 'content') === undefined)
    .flatMap(record => (JSON.parse(record['body'] !== undefined ? (record['body'] as { stringValue: string }).stringValue : '{"events":[]}') as { events: unknown[] }).events)
  expect(batched).toEqual(perEvent)
  expect(batched[0]).toMatchObject({ type: 'developer/message', surfaceOp: 'append' })
  expect(batched[1]).toMatchObject({ type: 'system/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1] })
  expect(batched[2]).toMatchObject({ type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5 } })
})

it('carries restored unknown ignorable records with opaque surface metadata', async () => {
  const target = await collector()
  const sender = reporter(target.endpoint)
  // Raw JSON from an older generation: the writer may have stored surface metadata.
  const opaque = JSON.parse('[{"type":"fixture/unknown","seq":4,"time":5,"data":{"kept":true},"ignorable":true,"surfaceOp":{"op":"replace","startSeq":1,"endSeq":2},"sourceEventSeqs":[1]}]') as SessionLogBatchEvent[]
  sender.reportSessionLogBatch(batch(opaque))
  await sender.shutdown()
  const body = JSON.parse((logs(target.captures[0]!)[0]!['body'] as { stringValue: string }).stringValue) as { events: unknown[] }
  expect(body.events).toEqual([
    { seq: 4, time: 5, data: { kept: true }, type: 'fixture/unknown', ignorable: true, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1] },
  ])
})

it('omits opaque surface metadata an unknown ignorable record never carried', async () => {
  const target = await collector()
  const sender = reporter(target.endpoint)
  const opaque = JSON.parse('[{"type":"fixture/unknown","seq":4,"time":5,"data":{},"ignorable":true}]') as SessionLogBatchEvent[]
  sender.reportSessionLogBatch(batch(opaque))
  await sender.shutdown()
  const body = JSON.parse((logs(target.captures[0]!)[0]!['body'] as { stringValue: string }).stringValue) as { events: unknown[] }
  expect(body.events).toEqual([{ seq: 4, time: 5, data: {}, type: 'fixture/unknown', ignorable: true }])
})

it('reports the batch severity and defaults to INFO', async () => {
  const target = await collector()
  const sender = reporter(target.endpoint)
  sender.reportSessionLogBatch(batch([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }]))
  sender.reportSessionLogBatch(batch([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }], {
    batchId: 'batch-2', severityNumber: 17,
  }))
  await sender.shutdown()
  const records = target.captures.flatMap(logs)
  expect(records.map(record => record['severityNumber'])).toEqual([9, 17])
  expect(records.map(record => record['severityText'])).toEqual(['INFO', 'ERROR'])
})

it('rejects a batch without events', async () => {
  const target = await collector()
  const sender = reporter(target.endpoint)
  expect(() => { sender.reportSessionLogBatch(batch([])) }).toThrow('Session log batch must carry at least one event')
})

it('reports the same session-level attributes as the per-event record', async () => {
  const target = await collector()
  const sender = reporter(target.endpoint)
  const event: SessionLogBatchEvent = {
    type: 'user/message',
    seq: SessionSeq(4),
    time: 1_800_000_000_000,
    surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'parity' }] },
  }
  sender.reportSessionLog({
    sessionId: SESSION_ID,
    event,
    attributes: {
      'session.id': SESSION_ID,
      'session.format_version': 4,
      'event.type': 'user/message',
      'event.seq': 4,
      'session.cwd': '/tmp/parity',
      'session.parent_id': 'session-parent',
      'session.seed_length': 7,
    },
  })
  sender.reportSessionLogBatch(batch([event], {
    formatVersion: 4,
    afterSeq: 3,
    throughSeq: 4,
    cwd: '/tmp/parity',
    parentSessionId: 'session-parent',
    seedLength: 7,
  }))
  await sender.shutdown()

  const [perEvent, perBatch] = logs(target.captures[0]!)
  const attributes = (record: Record<string, unknown>, include: (key: string) => boolean): Record<string, unknown> => Object.fromEntries(
    (record['attributes'] as { key: string; value: Record<string, unknown> }[])
      .filter(({ key }) => include(key))
      .map(({ key, value }) => [key, value]),
  )
  // The legacy sessionId attribute duplicates session.id; event identity moves into body.events.
  const perEventAttributes = attributes(perEvent!, key => key !== 'content' && key !== 'sessionId' && key !== 'event.type' && key !== 'event.seq')
  const perBatchAttributes = attributes(perBatch!, key => !key.startsWith('delivery.'))
  expect(perBatchAttributes).toEqual(perEventAttributes)
  expect(perBatchAttributes).toMatchObject({
    'session.cwd': { stringValue: '/tmp/parity' },
    'session.parent_id': { stringValue: 'session-parent' },
    'session.seed_length': { intValue: 7 },
  })
})
