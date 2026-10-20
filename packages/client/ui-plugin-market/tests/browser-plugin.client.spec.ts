// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { PluginDetailDocumentId } from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DiscoverFace } from '../src/client/market-store.ts'

it('contributes Discover to the Plugins page, follows Host changes, and withdraws with its fiber', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const market = {
    listIndexes: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    read: vi.fn(),
    setIndexes: vi.fn(),
  }
  const remote = new TestRemote(ctx, { pluginMarket: market, pluginRegistryProbe: { fastest: vi.fn() } })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'plugins.tab': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
  const [entry] = slots.entries('plugins.tab')
  expect(entry?.options.id).toBe('discover')
  expect(resolveSlotLabel(entry?.options.label)).toBe('Discover')
  remote.emit('plugin-market/changed', [])
  remote.emit('plugin-manager/changed', [{ reason: 'install' }])
  ctx.emit('connection/reset')
  expect(market.listIndexes).not.toHaveBeenCalled()
  const injected: object = entry!.inject!()
  const face = injected as DiscoverFace
  expect(face.resolveText({ en: 'English' })).toBe('English')
  expect(face.detailImage(brandString<PluginDetailDocumentId>('d'), 'img/a b.png'))
    .toBe(new URL('api/plugin-market/detail-file?document=d&path=img%2Fa%20b.png', document.baseURI).href)
  face.ensure()
  await vi.waitFor(() => { expect(face.hooks.discover.getSnapshot().status).toBe('ready') })
  remote.emit('plugin-market/changed', [])
  ctx.emit('connection/reset')
  await vi.waitFor(() => { expect(market.listIndexes).toHaveBeenCalledTimes(3) })
  await fiber.dispose()
  expect(slots.entries('plugins.tab')).toEqual([])
})
