// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { ConnectorsFace } from '../src/client/connectors-store.ts'
import { apply as applyHost } from '../src/index.ts'

it('keeps the Host entry empty', () => { expect(applyHost).not.toThrow() })

it('contributes the Connectors tab, follows Host changes, and withdraws the tab with its fiber', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const listBundles = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
  const remote = new TestRemote(ctx, { pluginManager: { listBundles } })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'plugins.tab': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
  const [entry] = slots.entries('plugins.tab')
  expect(entry?.options.id).toBe('connectors')
  expect(resolveSlotLabel(entry?.options.label)).toBe('Connectors')
  remote.emit('plugin-manager/changed', [{ reason: 'install' }])
  ctx.emit('connection/reset')
  expect(listBundles).not.toHaveBeenCalled()
  const injected: object = entry!.inject!()
  const face = injected as ConnectorsFace
  expect(face.version).toBe(process.env.DSH_CLIENT_VERSION)
  face.ensure()
  await vi.waitFor(() => { expect(face.hooks.connectors.getSnapshot().status).toBe('ready') })
  remote.emit('plugin-manager/changed', [{ reason: 'install' }])
  ctx.emit('connection/reset')
  await vi.waitFor(() => { expect(listBundles).toHaveBeenCalledTimes(3) })
  await fiber.dispose()
  expect(slots.entries('plugins.tab')).toEqual([])
  expect(locale.bind('connectors')('title')).toBe('title')
})
