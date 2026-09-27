import OTel from '@deepseek-ai/dsh-otel'
/** Desktop-only collector policy and bounded shutdown against an unresponsive receiver. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Telemetry from '@deepseek-ai/dsh-host-product-telemetry-otel'
import Analytics from '@deepseek-ai/dsh-client-product-analytics'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })

it.each(['desktop', 'web'])('limits collection and its shutdown to the Desktop launch: %s', async (profile) => {
  const received = Promise.withResolvers<undefined>()
  const server = createServer((req) => { req.resume(); req.once('end', () => { received.resolve(undefined) }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing collector address')
  vi.stubEnv('DSH_CLIENT_VERSION', 'test-version')
  vi.stubEnv('DSH_PRODUCT_ANALYTICS_OTLP_URL', `http://127.0.0.1:${address.port}/logs`)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  const identity = vi.fn().mockResolvedValue(undefined)
  ctx.provide('deepseekAccount', { getDeviceIdentity: identity } as never)
  await ctx.plugin(OTel)
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.telemetry = Telemetry
  ctx.loader.builtins.analytics = Analytics
  const rows = loadOverlayPatches('analytics', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'desktop-product-telemetry' || row.id === 'product-analytics')
  const entries = rows.map(row => ({ ...row, name: row.id === 'desktop-product-telemetry' ? 'cordis:telemetry' : 'cordis:analytics' }))
  await ctx.loader.root.update(entries)
  await ctx.loader.await()
  const entry = ctx.loader.resolve('desktop-product-telemetry')
  expect(entry.disabled).toBe(profile !== 'desktop')
  if (profile !== 'desktop') {
    expect(ctx.get('productTelemetry')).toBeUndefined()
    expect(ctx.get('productAnalytics')).toBeUndefined()
    return
  }
  expect(rows[0]!.config).toMatchObject({ timeoutMillis: 1000, exportTimeoutMillis: 1500, shutdownTimeoutMillis: 2000 })
  const analytics = ctx.productAnalytics
  const analyticsFiber = ctx.loader.resolve('product-analytics').fiber
  const telemetryFiber = entry.fiber
  const lifetime = new AbortController()
  onTestFinished(() => { lifetime.abort() })
  const policy = analytics.watchPolicy(lifetime.signal)[Symbol.asyncIterator]()
  expect(await policy.next()).toEqual({ value: true, done: false })
  for (const enabled of [false, true]) {
    const changed = policy.next()
    await ctx.loader.root.update(entries.map(row => row.id === 'product-analytics'
      ? { ...row, config: { ...row.config as Record<string, unknown>, enabled } } : row))
    await ctx.loader.await()
    expect(await changed).toEqual({ value: enabled, done: false })
    expect(ctx.loader.resolve('product-analytics').fiber === analyticsFiber).toBe(true)
    expect(entry.fiber === telemetryFiber).toBe(true)
    if (!enabled) {
      await analytics.report({ eventName: 'desktop_app_launch', timestamp: 1, attributes: {} })
      expect(identity).not.toHaveBeenCalled()
    }
  }
  const emit = vi.spyOn(ctx.productTelemetry, 'emit')
  await analytics.report({ eventName: 'desktop_app_launch', timestamp: 1, attributes: {} })
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ attributes: { app_version: 'test-version' } }))
  lifetime.abort()
  await policy.return?.()
  ctx.productTelemetry.emit({ eventName: 'desktop_upgrade_install_restart_click', body: 'upgrade', timestamp: Date.now() })
  const disposal = entry.fiber!.dispose()
  await received.promise
  await disposal
})
