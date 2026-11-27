// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { inject, mountConnectors } from '../src/client/mount.ts'
import { AddServerAction } from '../src/client/AddServerAction.tsx'
import type { ConnectorsFace } from '../src/client/connectors-store.ts'
import type { CustomServersFace } from '../src/client/custom-servers-store.ts'
import { CustomServersSection } from '../src/client/CustomServersSection.tsx'
import type { CustomServersList } from '../src/types.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-client-ui-connectors', descriptors: [] }

/** The Remote double, accepting the generated `connectors` contribution as the Client Remote service would. */
class MountingRemote extends TestRemote {
  readonly mounted = vi.fn()
  readonly unmounted = vi.fn(async () => {})

  override $mount(value?: TypertRemoteContribution): Promise<() => Promise<void>> {
    this.mounted(value)
    return Promise.resolve(this.unmounted)
  }
}

async function bench(namespaces: Readonly<Record<string, object>> = { pluginManager: { listBundles: vi.fn() } }) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const remote = new MountingRemote(ctx, namespaces)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'plugins.tab': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply: (child: Context) => mountConnectors(child, contribution) })
  await fiber.await()
  return { ctx, locale, remote, slots, fiber }
}

it('contributes the Connectors tab, follows Host changes, and withdraws the tab with its fiber', async () => {
  const listBundles = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
  const { ctx, locale, remote, slots, fiber } = await bench({ pluginManager: { listBundles } })
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
  expect(remote.mounted).toHaveBeenCalledWith(contribution)
  await fiber.dispose()
  expect(slots.entries('plugins.tab')).toEqual([])
  expect(locale.bind('connectors')('title')).toBe('title')
  expect(remote.unmounted).toHaveBeenCalledOnce()
})

it('adds the custom servers section and its add action once its Remote and the manager\'s exist, follows the server rows once the section asks, and closes their stream before its Remote goes', async () => {
  const { remote, slots, fiber } = await bench()
  expect(slots.entries('connectors.custom')).toEqual([])
  expect(slots.entries('connectors.actions')).toEqual([])

  const steps: string[] = []
  remote.unmounted.mockImplementation(async () => { steps.push('remote unmounted') })
  /** The Host stream: the list, then nothing until the client closes it. */
  async function* watchServers(signal: AbortSignal): AsyncGenerator<CustomServersList> {
    steps.push('stream opened')
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    signal.addEventListener('abort', () => {
      steps.push('stream closed')
      closed.resolve()
    }, { once: true })
    yield { available: true, revision: 'r1', servers: [] }
    await closed.promise
  }
  remote.provideNamespaces({
    connectors: { watchServers, saveServer: vi.fn(), removeServer: vi.fn(), setServerEnabled: vi.fn() },
    mcpManager: { probe: vi.fn() },
  })
  await vi.waitFor(() => { expect(slots.entries('connectors.custom')).toHaveLength(1) })
  const [entry] = slots.entries('connectors.custom')
  expect(entry).toMatchObject({ locale: 'connectors', component: CustomServersSection })
  const injected: object = entry!.inject!()
  const face = injected as CustomServersFace
  // The add action reads the state the section reads.
  const [action] = slots.entries('connectors.actions')
  expect(action).toMatchObject({ locale: 'connectors', component: AddServerAction })
  expect(action?.options.id).toBe('add-server')
  expect(action!.inject!()).toBe(injected)
  expect(steps).toEqual([])
  face.ensure()
  await vi.waitFor(() => { expect(face.hooks.customServers.getSnapshot()).toMatchObject({ status: 'ready', revision: 'r1' }) })
  expect(steps).toEqual(['stream opened'])

  await fiber.dispose()
  expect(slots.entries('connectors.custom')).toEqual([])
  expect(slots.entries('connectors.actions')).toEqual([])
  expect(steps).toEqual(['stream opened', 'stream closed', 'remote unmounted'])
})

it('loads the browser entry through its generated Remote contribution', async () => {
  vi.doMock('@deepseek-ai/dsh-client-ui-connectors/remote', () => ({ default: contribution }))
  onTestFinished(() => { vi.doUnmock('@deepseek-ai/dsh-client-ui-connectors/remote') })
  const browser = await import('../src/client/index.ts')
  expect(browser.inject).toEqual(inject)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const remote = new MountingRemote(ctx, { pluginManager: { listBundles: vi.fn() } })
  const fiber = ctx.plugin({ inject: [...browser.inject], apply: browser.apply })
  await fiber.await()
  expect(remote.mounted).toHaveBeenCalledWith(contribution)
  await fiber.dispose()
  expect(remote.unmounted).toHaveBeenCalledOnce()
})
