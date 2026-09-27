import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import * as Analytics from '../src/client/index.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
})
async function setup(enabled = true) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const report = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const values = [enabled]
  let wake: (() => void) | undefined
  let disposed = false
  let failure: Error | undefined
  let options: RemoteStreamOptions<boolean> | undefined
  const stream = {
    async *[Symbol.asyncIterator]() {
      while (!disposed) {
        if (failure !== undefined) throw failure
        const value = values.shift()
        if (value !== undefined) { yield { value, accept: () => {} }; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
    dispose: async () => { disposed = true; wake?.() },
  }
  const remote = {
    productAnalytics: { report, watchPolicy: vi.fn() },
    $stream: (value: RemoteStreamOptions<boolean>) => { options = value; return stream },
  }
  class TracedRemote extends Service {
    constructor(ctx: Context) { super(ctx, 'remote') }
    $stream = remote.$stream
  }
  await ctx.plugin(TracedRemote)
  await ctx.plugin({ apply(child: Context) { child.provide('remote.productAnalytics', remote.productAnalytics as never) } })
  await ctx.plugin(Analytics)
  if ('dshDesktop' in globalThis) await vi.waitFor(() => { expect(ctx.productAnalytics.enabled).toBe(enabled) })
  return { ctx, report, options: () => options!,
    async fail() { failure = new Error('terminal'); wake?.(); await vi.waitFor(() => { expect(ctx.productAnalytics.enabled).toBe(false) }) },
    async policy(enabled: boolean) {
      values.push(enabled); wake?.()
      await vi.waitFor(() => { expect(ctx.productAnalytics.enabled).toBe(enabled) })
    } }
}
it('never collects in Web even when the Host advertises analytics', async () => {
  const b = await setup()
  expect(b.ctx.productAnalytics.enabled).toBe(false)
  b.ctx.productAnalytics.track('desktop_app_launch', {})
  expect(b.report).not.toHaveBeenCalled()
})
it('drops disabled events and has no backfill when enabled', async () => {
  vi.stubGlobal('dshDesktop', {})
  const b = await setup(false)
  b.ctx.productAnalytics.track('auth_page_view', {})
  expect(b.report).not.toHaveBeenCalled()
  await b.policy(true)
  b.ctx.productAnalytics.track('auth_page_click', { button_name: 'sign_in' })
  expect(b.report).toHaveBeenCalledExactlyOnceWith({ eventName: 'auth_page_click', timestamp: expect.any(Number) as number, attributes: { button_name: 'sign_in' } })
})
it('does not retry or propagate transport rejection', async () => {
  vi.stubGlobal('dshDesktop', {})
  const b = await setup()
  b.report.mockRejectedValueOnce(new Error('offline'))
  b.ctx.productAnalytics.track('auth_page_view', {})
  await Promise.resolve()
  expect(b.report).toHaveBeenCalledTimes(1)
})

it('does not interrupt an action when Remote access fails synchronously', async () => {
  vi.stubGlobal('dshDesktop', {})
  const b = await setup()
  b.report.mockImplementationOnce(() => { throw new Error('Remote namespace detached') })
  expect(() => { b.ctx.productAnalytics.track('auth_page_view', {}) }).not.toThrow()
  await Promise.resolve()
  expect(b.report).toHaveBeenCalledOnce()
})

it('keeps the supplied occurrence time and stops new events on policy changes', async () => {
  vi.stubGlobal('dshDesktop', {})
  const b = await setup()
  b.ctx.productAnalytics.track('auth_page_view', {}, 123)
  expect(b.report).toHaveBeenCalledWith({ eventName: 'auth_page_view', attributes: {}, timestamp: 123 })
  await b.policy(false)
  b.ctx.productAnalytics.track('auth_page_view', {})
  expect(b.report).toHaveBeenCalledOnce()
})

it('fails closed on stream loss and accepts a fresh policy after reconnection', async () => {
  vi.stubGlobal('dshDesktop', {})
  const b = await setup()
  b.options().open(new AbortController().signal)
  expect(b.options().ended(true).message).toContain('policy stream ended')
  b.options().carrierFailed?.(new Error('offline'))
  expect(b.ctx.productAnalytics.enabled).toBe(false)
  await b.policy(true)
  await b.fail()
})

it('reports from a consumer without granting it the analytics Remote namespace', async () => {
  vi.stubGlobal('dshDesktop', {})
  const b = await setup()
  let click!: () => void
  await b.ctx.plugin({
    inject: ['remote'],
    apply(ctx: Context) {
      click = () => {
        expect(ctx.get('productAnalytics')?.enabled).toBe(true)
        ctx.get('productAnalytics')?.track('sidebar_menu_click', { menu_name: 'plugin' })
      }
    },
  })
  click()
  expect(b.report).toHaveBeenCalledExactlyOnceWith({
    eventName: 'sidebar_menu_click', timestamp: expect.any(Number) as number, attributes: { menu_name: 'plugin' },
  })
})
