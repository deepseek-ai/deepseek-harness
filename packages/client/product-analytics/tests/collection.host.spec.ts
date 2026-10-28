import OTel from '@deepseek-ai/dsh-otel'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProductTelemetry, { Config as TelemetryConfig, type ProductTelemetryRecord } from '@deepseek-ai/dsh-host-product-telemetry-otel'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import Analytics from '../src/index.ts'
import { collectEnvironment, type EnvironmentAttributes } from '../src/environment.ts'

vi.mock('../src/environment.ts', () => ({ collectEnvironment: vi.fn() }))
const environment: EnvironmentAttributes = {
  os_name: 'windows', os_version: 'win32 10.0.26300', os_version_full: '10.0.26300.9457', os_build: '26300',
  os_arch: 'arm64', app_arch: 'x64', cpu_model: 'Fixture CPU', cpu_logical_count: 16, cpu_physical_core_count: 8,
  memory_total_bytes: 34359738368, missing_fields: {},
}
const { missing_fields: _missingFields, ...commonEnvironment } = environment
beforeEach(() => { vi.resetAllMocks(); vi.mocked(collectEnvironment).mockResolvedValue(environment) })

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function setup(enabled: boolean) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const getDeviceIdentity = vi.fn().mockResolvedValue({ deviceId: 'login-device', userId: 'user-1', osVersion: 'fixture-os', ignored: 'private-field' })
  const emit = vi.fn<(record: ProductTelemetryRecord) => void>()
  ctx.provide('deepseekAccount', { getDeviceIdentity } as never)
  ctx.provide('webServer', {} as never)
  ctx.provide('productTelemetry', { emit } as never)
  const fiber = await ctx.plugin(Analytics, { enabled, appVersion: 'test-version' })
  return { ctx, fiber, getDeviceIdentity, emit }
}

it('disabled collection does not read identity or submit an event', async () => {
  const b = await setup(false)
  expect(b.ctx.productAnalytics.enabled()).toBe(false)
  await b.ctx.productAnalytics.report({ eventName: 'desktop_app_launch', timestamp: 100, attributes: {} })
  expect(collectEnvironment).not.toHaveBeenCalled()
  expect(b.getDeviceIdentity).not.toHaveBeenCalled()
  expect(b.emit).not.toHaveBeenCalled()
})

it('reuses login identity and copies only approved common fields', async () => {
  const b = await setup(true)
  await b.ctx.productAnalytics.report({ eventName: 'auth_page_click', timestamp: 100, attributes: { button_name: 'sign_in' } })
  expect(b.getDeviceIdentity).toHaveBeenCalledWith()
  expect(b.emit).toHaveBeenCalledExactlyOnceWith({
    eventName: 'auth_page_click', body: 'auth_page_click', timestamp: 100,
    attributes: { ...commonEnvironment, button_name: 'sign_in', device_id: 'login-device', user_id: 'user-1', app_version: 'test-version' },
  })
  expect(JSON.stringify(b.emit.mock.calls)).not.toContain('private-')
  expect(b.emit.mock.calls[0]![0].attributes).not.toHaveProperty('missing_fields')
})

it('missing identity does not discard an otherwise valid event', async () => {
  const b = await setup(true)
  b.getDeviceIdentity.mockRejectedValueOnce(new Error('credential store unavailable'))
  await b.ctx.productAnalytics.report({ eventName: 'plugin_add_button_click', timestamp: 100, attributes: {} })
  expect(b.emit.mock.calls[0]?.[0].attributes).toEqual({ ...commonEnvironment, app_version: 'test-version' })
})

it('unload suppresses an identity lookup that settles after disposal', async () => {
  const b = await setup(true)
  const pending = Promise.withResolvers<undefined>()
  b.getDeviceIdentity.mockReturnValueOnce(pending.promise)
  const reporting = b.ctx.productAnalytics.report({ eventName: 'desktop_app_launch', timestamp: 100, attributes: {} })
  await b.fiber.dispose()
  pending.resolve(undefined)
  await reporting
  expect(b.emit).not.toHaveBeenCalled()
})

it('writes the selected event through the real exporter to an isolated collector', async () => {
  const captures: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => { captures.push(Buffer.concat(chunks).toString()); res.end('{}') })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => { const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing collector port')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.provide('credentials', { readRecord: async () => undefined } as never)
  ctx.provide('deepseekAccount', { getDeviceIdentity: async () => undefined } as never)
  ctx.provide('webServer', {} as never)
  await ctx.plugin(OTel)
  const exporter = await ctx.plugin(ProductTelemetry, TelemetryConfig({ endpoint: `http://127.0.0.1:${address.port}/v1/logs`, serviceName: 'test', serviceVersion: '1', compression: 'none' }))
  const analytics = await ctx.plugin(Analytics, { enabled: true })
  await ctx.productAnalytics.report({ eventName: 'api_key_save_click', timestamp: 1_800_000_000_000, attributes: {} })
  await analytics.dispose()
  const { cpu_physical_core_count: _cores, ...partialEnvironment } = environment
  vi.mocked(collectEnvironment).mockResolvedValueOnce({ ...partialEnvironment, os_version_full: '10.0.26300.9458',
    missing_fields: { cpu_physical_core_count: 'timeout' },
  })
  await ctx.plugin(Analytics, { enabled: true })
  await ctx.productAnalytics.report({ eventName: 'api_key_save_click', timestamp: 1_800_000_000_001, attributes: {} })
  await exporter.dispose()
  expect(captures).toHaveLength(1)
  expect(JSON.parse(captures[0]!)).toMatchObject({ resourceLogs: [{ scopeLogs: [{ logRecords: [
    { eventName: 'api_key_save_click', timeUnixNano: '1800000000000000000' },
    { eventName: 'api_key_save_click', timeUnixNano: '1800000000001000000' },
  ] }] }] })
  expect(captures[0]).toContain('10.0.26300.9457')
  expect(captures[0]).toContain('10.0.26300.9458')
  expect(captures[0]).toContain('"stringValue":"cpu_physical_core_count=timeout"')
  expect(captures[0]).not.toContain('kvlistValue')
  expect(collectEnvironment).toHaveBeenCalledTimes(2)
  expect(captures[0]).not.toContain('device_id')
  expect(captures[0]).not.toContain('app_version')
})

it.each([true, false])('collects live manual and automatic compaction only when enabled: %s', async (enabled) => {
  const b = await setup(enabled)
  const session = Session.create(SessionId('analytics-compaction'))
  b.ctx.emit('session/event', session, { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } })
  for (const turn of [null, 1]) {
    b.ctx.emit('session/event', session, { type: 'compaction/start', seq: SessionSeq(1), time: 1,
      data: { compactionId: CompactionId('analytics-compaction'), turn } })
  }
  if (enabled) await vi.waitFor(() => { expect(b.emit).toHaveBeenCalledTimes(2) })
  expect(b.emit.mock.calls.map(([event]) => event.attributes?.trigger_type)).toEqual(enabled ? ['manual', 'auto'] : [])
  expect(b.getDeviceIdentity).toHaveBeenCalledTimes(enabled ? 2 : 0)
})

it('omits an unavailable account and isolates exporter submission failure', async () => {
  const b = await setup(true)
  b.getDeviceIdentity.mockRejectedValueOnce(new Error('account unavailable'))
  await b.ctx.productAnalytics.report({ eventName: 'desktop_app_launch', timestamp: 1, attributes: {} })
  expect(b.emit.mock.calls[0]![0].attributes).not.toHaveProperty('user_id')
  b.emit.mockImplementationOnce(() => { throw new Error('exporter unavailable') })
  await expect(b.ctx.productAnalytics.report({ eventName: 'desktop_app_launch', timestamp: 2, attributes: {} })).resolves.toBeUndefined()
})


it('requires the exporter even when collection is disabled', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.provide('deepseekAccount', { getDeviceIdentity: async () => undefined } as never)
  const fiber = ctx.plugin(Analytics, { enabled: false })
  await Promise.resolve()
  expect(ctx.get('productAnalytics')).toBeUndefined()
  ctx.provide('productTelemetry', { emit: vi.fn() } as never)
  await fiber
  expect(ctx.productAnalytics.enabled()).toBe(false)
})

it('streams live policy changes and rejects intake disabled during identity lookup', async () => {
  const b = await setup(true)
  const lifetime = new AbortController()
  const iterator = b.ctx.productAnalytics.watchPolicy(lifetime.signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ value: true, done: false })
  const identity = Promise.withResolvers<undefined>()
  b.getDeviceIdentity.mockReturnValueOnce(identity.promise)
  const report = b.ctx.productAnalytics.report({ eventName: 'auth_page_view', timestamp: 1, attributes: {} })
  const next = iterator.next()
  // Loader commits the stable Config reference before publishing this notification.
  const { updateVolatile, createVolatile } = await import('../../../../vendor/cosmokit/src/volatile.ts')
  const config = b.fiber.effectiveConfig as import('../src/index.ts').Config
  updateVolatile(config.enabled, createVolatile(false))
  b.fiber.ctx.emit('loader/volatile-update', [['enabled']])
  expect(await next).toEqual({ value: false, done: false })
  identity.resolve(undefined)
  await report
  expect(b.emit).not.toHaveBeenCalled()
  const closed = iterator.next()
  lifetime.abort()
  expect(await closed).toEqual({ value: undefined, done: true })
})

it('wakes pending policy readers on disposal and registers hidden settings presentation', async () => {
  const b = await setup(true)
  const dispose = vi.fn()
  const configure = vi.fn(() => dispose)
  b.ctx.provide('settings', { configure } as never)
  await vi.waitFor(() => { expect(configure).toHaveBeenCalledWith({ auto: false }, b.fiber) })
  const iterator = b.ctx.productAnalytics.watchPolicy(new AbortController().signal)[Symbol.asyncIterator]()
  await iterator.next()
  const pending = iterator.next()
  await b.fiber.dispose()
  expect(await pending).toEqual({ done: true, value: undefined })
  expect(dispose).toHaveBeenCalledOnce()
})

it('shares one environment query across concurrent events and keeps identity fresh', async () => {
  const b = await setup(true)
  const pending = Promise.withResolvers<EnvironmentAttributes>()
  vi.mocked(collectEnvironment).mockReturnValueOnce(pending.promise)
  const first = b.ctx.productAnalytics.report({ eventName: 'auth_page_view', timestamp: 1, attributes: {} })
  b.getDeviceIdentity.mockResolvedValueOnce({ userId: 'user-2', osVersion: 'untrusted-os' })
  const second = b.ctx.productAnalytics.report({ eventName: 'desktop_app_launch', timestamp: 2, attributes: {} })
  expect(collectEnvironment).toHaveBeenCalledTimes(1)
  expect(b.emit).not.toHaveBeenCalled()
  pending.resolve(environment)
  await Promise.all([first, second])
  expect(b.emit.mock.calls.map(([record]) => record.attributes?.user_id)).toEqual(['user-1', 'user-2'])
  expect(b.emit.mock.calls.map(([record]) => record.attributes?.os_version_full)).toEqual(['10.0.26300.9457', '10.0.26300.9457'])
  expect(b.emit.mock.calls).toHaveLength(2)
  await b.ctx.productAnalytics.report({ eventName: 'auth_page_view', timestamp: 3, attributes: {} })
  expect(collectEnvironment).toHaveBeenCalledTimes(1)
  expect(b.getDeviceIdentity).toHaveBeenCalledTimes(3)
})

it('caches failed environment fields without discarding the event or retrying each interaction', async () => {
  const b = await setup(true)
  vi.mocked(collectEnvironment).mockResolvedValue({ os_name: 'windows', app_arch: 'x64', missing_fields: { os_version_full: 'timeout' } })
  for (const timestamp of [1, 2]) await b.ctx.productAnalytics.report({ eventName: 'auth_page_view', timestamp, attributes: {} })
  expect(collectEnvironment).toHaveBeenCalledTimes(1)
  expect(b.emit.mock.calls).toHaveLength(2)
  expect(b.emit.mock.calls[0]![0].attributes?.missing_fields).toBe('os_version_full=timeout')
})

it('aborts and awaits environment sampling on disposal without emitting late results', async () => {
  const b = await setup(true)
  const pending = Promise.withResolvers<EnvironmentAttributes>()
  vi.mocked(collectEnvironment).mockReturnValueOnce(pending.promise)
  const report = b.ctx.productAnalytics.report({ eventName: 'desktop_app_launch', timestamp: 1, attributes: {} })
  const signal = vi.mocked(collectEnvironment).mock.calls[0]![0].signal
  const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  let disposed = false
  const disposal = b.fiber.dispose().then(() => { disposed = true })
  await aborted
  expect(disposed).toBe(false)
  pending.resolve(environment)
  await Promise.all([report, disposal])
  expect(b.emit).not.toHaveBeenCalled()
})


it('encodes failed fields as a sorted scalar and omits an empty failure list', async () => {
  const b = await setup(true)
  vi.mocked(collectEnvironment).mockResolvedValueOnce({ ...environment,
    missing_fields: { os_version_full: 'timeout', cpu_physical_core_count: 'query-failed' },
  })
  await b.ctx.productAnalytics.report({ eventName: 'auth_page_view', timestamp: 1, attributes: {} })
  expect(b.emit.mock.calls[0]![0].attributes?.missing_fields).toBe('cpu_physical_core_count=query-failed,os_version_full=timeout')
})
