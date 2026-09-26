import OTel from '@deepseek-ai/dsh-otel'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LoggerProvider } from '@opentelemetry/sdk-logs'
import { SeverityNumber } from '@opentelemetry/api-logs'
import ProductTelemetry, { Config } from '../src/index.ts'

interface Capture {
  headers: IncomingHttpHeaders
  body: { resourceLogs: { resource: unknown; scopeLogs: { logRecords: Record<string, unknown>[] }[] }[] }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  } finally {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

beforeEach(() => {
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
      captures.push({ headers: req.headers, body: JSON.parse(bytes.toString()) as Capture['body'] })
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

function config(endpoint: string, overrides: Partial<Config> = {}): Config {
  return Config({ endpoint, serviceName: 'synthetic-test', serviceVersion: '1', scheduledDelayMillis: 60_000, ...overrides })
}

function context() {
  const ctx = new Context()
  const ready = ctx.plugin(OTel)
  cleanup.push(async () => { await ready; await ctx.fiber.dispose() })
  return ctx
}

const event = { eventName: 'telemetry.synthetic', body: 'Synthetic test', timestamp: 1_800_000_000_000 }

describe('explicit product telemetry', () => {
  it.each(['gzip', 'none', undefined] as const)('drains typed events with %s compression and removes the service', async (compression) => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, compression === undefined ? {} : { compression }))
    const service = ctx.productTelemetry
    expect(target.captures).toEqual([])
    service.emit({ ...event, attributes: { text: 'test', count: 2, duration: 1.5, synthetic: true, model: { provider: 'test', count: 1, enabled: false } } })
    service.emit({ ...event, severityNumber: SeverityNumber.ERROR })
    await fiber.dispose()
    expect(ctx.get('productTelemetry')).toBeUndefined()
    service.emit(event)
    expect(target.captures).toHaveLength(1)
    const [capture] = target.captures
    expect(capture?.headers['x-channel']).toBe('dsh_otel_report')
    expect(capture?.headers['content-encoding']).toBe(compression === 'gzip' ? 'gzip' : undefined)
    const logs = capture?.body.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords))
    expect(logs).toHaveLength(2)
    expect(logs?.[0]).toMatchObject({
      eventName: event.eventName, body: { stringValue: event.body }, severityNumber: 9,
      timeUnixNano: '1800000000000000000',
    })
    expect(logs?.[0]?.['attributes']).toEqual(expect.arrayContaining([
      { key: 'text', value: { stringValue: 'test' } },
      { key: 'count', value: { intValue: 2 } },
      { key: 'duration', value: { doubleValue: 1.5 } },
      { key: 'synthetic', value: { boolValue: true } },
      { key: 'model', value: { kvlistValue: { values: [{ key: 'provider', value: { stringValue: 'test' } }, { key: 'count', value: { intValue: 1 } }, { key: 'enabled', value: { boolValue: false } }] } } },
    ]))
    expect(Number(logs?.[0]?.['observedTimeUnixNano'])).toBeGreaterThan(0)
    expect(logs?.[1]?.['severityNumber']).toBe(17)
    expect(JSON.stringify(capture)).not.toContain('user.id')
  })

  it('isolates collector headers from ambient OpenTelemetry credentials', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer%20synthetic-secret,x-user-id=synthetic-user')
    vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'x-log-token=synthetic-token,x-channel=other-collector')
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.emit(event)
    await fiber.dispose()
    expect(target.captures).toHaveLength(1)
    expect(target.captures[0]?.headers).toMatchObject({ 'x-channel': 'dsh_otel_report' })
    expect(target.captures[0]?.headers).not.toHaveProperty('authorization')
    expect(target.captures[0]?.headers).not.toHaveProperty('x-user-id')
    expect(target.captures[0]?.headers).not.toHaveProperty('x-log-token')
    expect(process.env['OTEL_EXPORTER_OTLP_HEADERS']).toContain('synthetic-secret')
  })

  it('does not export on mount or empty shutdown', async () => {
    const target = await collector()
    const fiber = await context().plugin(ProductTelemetry, config(target.endpoint))
    await fiber.dispose()
    expect(target.captures).toEqual([])
  })

  it('exports at the batch threshold and retries a transient rejection', async () => {
    const target = await collector([503, 200])
    const ctx = context()
    await ctx.plugin(ProductTelemetry, config(target.endpoint, { maxExportBatchSize: 1 }))
    ctx.productTelemetry.emit(event)
    await vi.waitFor(() => { expect(target.captures).toHaveLength(2) }, { timeout: 10_000 })
    expect(target.captures[0]?.body).toEqual(target.captures[1]?.body)
  })

  it('exports a partial batch on its configured interval', async () => {
    const target = await collector()
    const ctx = context()
    await ctx.plugin(ProductTelemetry, config(target.endpoint, { scheduledDelayMillis: 10 }))
    ctx.productTelemetry.emit(event)
    await vi.waitFor(() => { expect(target.captures).toHaveLength(1) })
  })

  it('reports a permanent export rejection without failing the caller', async () => {
    const target = await collector([400])
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    expect(() => { ctx.productTelemetry.emit(event) }).not.toThrow()
    await fiber.dispose()
    expect(target.captures).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('Product telemetry export failed', expect.any(Error))
  })

  it.each([
    { endpoint: 'broken' }, { endpoint: 'ftp://collector.test/logs' },
    { channel: '' }, { channel: 'bad\nchannel' }, { channel: '中文' }, { timeoutMillis: 0 },
    { maxExportBatchSize: 0 }, { maxExportBatchSize: 2, maxQueueSize: 1 },
    { maxQueueSize: -1 }, { scheduledDelayMillis: 0 }, { exportTimeoutMillis: Infinity },
    { shutdownTimeoutMillis: 2_147_483_648 },
  ])('rejects invalid configuration %j before exposing the service', (invalid) => {
    const ctx = context()
    expect(() => new ProductTelemetry(ctx, config('http://collector.test/v1/logs', invalid))).toThrow()
    expect(ctx.get('productTelemetry')).toBeUndefined()
  })

  it.each([
    [{ endpoint: 'broken' }, 'endpoint must be a valid HTTP(S) URL'],
    [{ channel: 'bad\nchannel' }, 'channel must be a valid HTTP header value'],
  ] as const)('names invalid transport fields before registering the service', (invalid, message) => {
    const ctx = context()
    expect(() => new ProductTelemetry(ctx, config('http://collector.test/v1/logs', invalid)))
      .toThrow(`product-telemetry-otel: ${message}`)
    expect(ctx.get('productTelemetry')).toBeUndefined()
  })

  it.each([
    ['OTEL_EXPORTER_OTLP_COMPRESSION', 'gzip'],
    ['OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', 'gzip'],
  ])('honors %s when compression is omitted', async (name, value) => {
    vi.stubEnv(name, value)
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint))
    ctx.productTelemetry.emit(event)
    await fiber.dispose()
    expect(target.captures[0]?.headers['content-encoding']).toBe('gzip')
  })

  it('bounds a stalled shutdown and observes its later settlement', async () => {
    const target = await collector()
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(ProductTelemetry, config(target.endpoint, { shutdownTimeoutMillis: 20 }))
    const pending = Promise.withResolvers<undefined>()
    vi.spyOn(LoggerProvider.prototype, 'shutdown').mockReturnValue(pending.promise)
    vi.useFakeTimers()
    const disposal = fiber.dispose()
    await vi.advanceTimersByTimeAsync(20)
    await disposal
    expect(warn).toHaveBeenCalledWith('Product telemetry shutdown deadline exceeded; pending events may be lost')
    pending.resolve(undefined)
    await pending.promise
    await vi.advanceTimersByTimeAsync(0)
  })
})

it('drains the dependent product channel when the shared OTel plugin unloads', async () => {
  const target = await collector()
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const service = await ctx.plugin(OTel)
  await ctx.plugin(ProductTelemetry, config(target.endpoint))
  ctx.productTelemetry.emit(event)
  await service.dispose()
  expect(ctx.get('otel')).toBeUndefined()
  expect(ctx.get('productTelemetry')).toBeUndefined()
  expect(target.captures).toHaveLength(1)
})
