import { Agent, createServer, type RequestListener } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { EventLogReporter, type EventLogOptions } from '../src/event-log.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const dispose of cleanup.splice(0).reverse()) await dispose() }
  finally { vi.restoreAllMocks() }
})

async function collector(listener: RequestListener) {
  const server = createServer(listener)
  server.on('clientError', (_error, socket) => { socket.destroy() })
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
  return `http://127.0.0.1:${address.port}/v1/logs`
}

function reporter(url: string, exporter: Partial<EventLogOptions['exporter']> = {}) {
  const onFailure = vi.fn()
  const sender = new EventLogReporter({
    exporter: { url, timeoutMillis: 1000, ...exporter },
    resourceAttributes: {}, scope: { name: 'event-test' },
    processor: { scheduledDelayMillis: 60_000 }, onFailure,
  })
  cleanup.push(() => sender.shutdown())
  return { sender, onFailure }
}
const event = { eventName: 'synthetic', body: 'Synthetic test', timestamp: 1_800_000_000_000 }

it('releases its dedicated agent after exporting explicit asynchronous headers', async () => {
  const headers: unknown[] = []
  const url = await collector((req, res) => {
    headers.push(req.headers)
    req.resume()
    req.on('end', () => { res.end('{}') })
  })
  const agent = new Agent({ keepAlive: true })
  const destroy = vi.spyOn(agent, 'destroy')
  const { sender, onFailure } = reporter(url, {
    httpAgentOptions: async () => agent, userAgent: 'synthetic-client',
    headers: async () => ({ 'x-test': 'explicit' }),
  })
  sender.emit(event)
  await sender.shutdown()
  expect(onFailure).not.toHaveBeenCalled()
  expect(headers).toMatchObject([{ 'x-test': 'explicit', 'user-agent': 'synthetic-client' }])
  expect(destroy).toHaveBeenCalled()
})

it('releases the HTTPS agent after a TLS connection failure', async () => {
  const url = await collector((_req, res) => { res.end('{}') })
  const agent = new HttpsAgent({ keepAlive: true })
  const destroy = vi.spyOn(agent, 'destroy')
  const { sender, onFailure } = reporter(url.replace('http:', 'https:'), { httpAgentOptions: () => agent })
  sender.emit(event)
  await sender.shutdown()
  expect(onFailure).toHaveBeenCalledWith('Product telemetry export failed', expect.any(Error))
  expect(destroy).toHaveBeenCalled()
})

it('rejects responses exceeding the OTLP response-body limit', async () => {
  const url = await collector((req, res) => {
    req.resume()
    req.on('end', () => { res.end(Buffer.alloc(4 * 1024 * 1024 + 1)) })
  })
  const { sender, onFailure } = reporter(url)
  sender.emit(event)
  await sender.shutdown()
  expect(onFailure).toHaveBeenCalledWith('Product telemetry export failed', expect.any(Error))
})

it('discards a queued channel on cancellation without cancelling another channel', async () => {
  let requests = 0
  const url = await collector((req, res) => {
    requests++
    req.resume()
    req.on('end', () => { res.end('{}') })
  })
  const cancelled = reporter(url)
  const active = reporter(url)
  cancelled.sender.emit(event)
  active.sender.emit(event)
  await cancelled.sender.shutdown(AbortSignal.abort())
  await active.sender.shutdown()
  expect(requests).toBe(1)
  expect(cancelled.onFailure).toHaveBeenCalled()
  expect(active.onFailure).not.toHaveBeenCalled()
})

it('does not send after cancellation while explicit headers are resolving', async () => {
  let requests = 0
  const url = await collector((_req, res) => { requests++; res.end('{}') })
  const started = Promise.withResolvers<undefined>()
  const headers = Promise.withResolvers<Record<string, string>>()
  const { sender, onFailure } = reporter(url, { headers: () => { started.resolve(undefined); return headers.promise } })
  sender.emit(event)
  const cancellation = new AbortController()
  const shutdown = sender.shutdown(cancellation.signal)
  await started.promise
  cancellation.abort()
  headers.resolve({})
  await shutdown
  expect(requests).toBe(0)
  expect(onFailure).toHaveBeenCalled()
})

it('rejects redirects without forwarding telemetry to another endpoint', async () => {
  let requests = 0
  const url = await collector((req, res) => {
    requests++
    req.resume()
    req.on('end', () => { res.writeHead(302, { location: '/redirected' }).end() })
  })
  const { sender, onFailure } = reporter(url)
  sender.emit(event)
  await sender.shutdown()
  expect(requests).toBe(1)
  expect(onFailure).toHaveBeenCalledWith('Product telemetry export failed', expect.objectContaining({ message: 'OTLP collector returned HTTP 302' }))
})

it('destroys the agent when cancellation rejects a batch already in flight', async () => {
  const received = Promise.withResolvers<undefined>()
  const url = await collector((req, _res) => {
    req.resume()
    req.on('end', () => { received.resolve(undefined) })
  })
  const agent = new Agent({ keepAlive: true })
  const destroy = vi.spyOn(agent, 'destroy')
  const sender = new EventLogReporter({
    exporter: { url, timeoutMillis: 15000, httpAgentOptions: () => agent },
    resourceAttributes: {}, scope: { name: 'event-test' },
    processor: { maxExportBatchSize: 1 }, onFailure: vi.fn(),
  })
  cleanup.push(() => sender.shutdown())
  sender.emit(event)
  await received.promise
  await sender.shutdown(AbortSignal.abort())
  expect(destroy).toHaveBeenCalledTimes(1)
})
