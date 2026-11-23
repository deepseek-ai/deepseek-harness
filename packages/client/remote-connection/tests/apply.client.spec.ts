// @vitest-environment jsdom
/** Generated Remote methods and settings registrations leave with the plugin fiber. */
import { Context } from '@deepseek-ai/cordis'
import { createElement, Fragment, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSlotRenderer, StaticRemoteAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type PropsRenderSlots, type StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as gatewayApply, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/client'
import type { PairingRequestId } from '../src/types.ts'
import type { PairingInjected } from '../src/client/PairingRequests.tsx'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteConnectionContentProps, RemoteConnectionExtensionProps } from '@deepseek-ai/dsh-client-remote-connection/client'
import { en, zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

vi.mock('@deepseek-ai/dsh-client-remote-connection/remote', async () => import('./remote-fixture.ts'))

afterEach(cleanup)

function Root({ renderSlot, close }: PropsRenderSlots<'settings.section' | 'shell.overlay'> & Pick<RemoteConnectionContentProps, 'close'>) {
  const [visible, setVisible] = useState(true)
  return createElement(Fragment, null,
    createElement('button', { onClick: () => { setVisible(value => !value) } }, 'Toggle settings'),
    visible ? renderSlot('settings.section', { close }) : null,
    renderSlot('shell.overlay', {}))
}

function Replacement({ useRemoteConnection, create, cancel, reload, close }: RemoteConnectionContentProps) {
  const { phase, ticket, remainingSeconds } = useRemoteConnection(state => state)
  return createElement('section', {
    'aria-label': 'Custom connection', 'data-phase': phase,
    'data-ticket': ticket?.id, 'data-seconds': remainingSeconds,
  },
  createElement('button', { onClick: create }, 'Create'),
  createElement('button', { onClick: cancel }, 'Cancel'),
  createElement('button', { onClick: reload }, 'Reload'),
  createElement('button', { onClick: close }, 'Close'))
}

const replacementPlugin = {
  inject: ['slots'],
  apply(ctx: Context) {
    ctx.slots.inject('settings.remoteConnection.content', () => ctx.slots.register({
      name: 'settings.remoteConnection.content', priority: -1,
    }, Replacement))
  },
}

function Extension({
  label, useRemoteConnection, useLoginLink, create, cancel, reloadLink, close,
}: RemoteConnectionExtensionProps & { label: string }) {
  const { phase, ticket } = useRemoteConnection(state => state)
  const link = useLoginLink(state => state.phase)
  return createElement('section', { 'aria-label': label, 'data-phase': phase, 'data-ticket': ticket?.id, 'data-link': link },
    createElement('input', { 'aria-label': 'Option value', defaultValue: '' }),
    createElement('button', { onClick: create }, 'Create invitation'),
    createElement('button', { onClick: cancel }, 'Cancel invitation'),
    createElement('button', { onClick: reloadLink }, 'Reload link'),
    createElement('button', { onClick: close }, 'Close settings'))
}

function extensionPlugin(id: string, order: number) {
  return {
    inject: ['slots'],
    apply(ctx: Context) {
      ctx.slots.inject('settings.remoteConnection.extensions', () => ctx.slots.register({
        name: 'settings.remoteConnection.extensions', id, order, inject: () => ({ label: id }),
      }, Extension))
    },
  }
}

function PairingExtension({ useApproval, decide, dismiss }: RemoteConnectionExtensionProps) {
  const approval = useApproval(state => state)
  return createElement('section', { 'aria-label': 'Pairing extension' },
    createElement('output', { 'aria-label': 'Approval status' }, approval.available ? approval.notice ?? 'ready' : 'unavailable'),
    createElement('button', { disabled: !approval.available || approval.busy, onClick: () => { void decide('request-one' as PairingRequestId, 'allow') } }, 'Approve request'),
    createElement('button', { onClick: dismiss }, 'Dismiss approval'))
}

const pairingExtensionPlugin = {
  inject: ['slots'],
  apply(ctx: Context) {
    ctx.slots.inject('settings.remoteConnection.extensions', () => ctx.slots.register({
      name: 'settings.remoteConnection.extensions', id: 'pairing-options',
    }, PairingExtension))
  },
}

async function bench(call: ConnectionHandle['rpc']['call'], beforeMount?: (ctx: Context) => Promise<void>, allowed = true) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry).await()
  ctx.provide('connection', {
    interactions: 'answer', isLoopback: true,
    openWebSocket: () => { throw new Error('This test uses in-process RPC') },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, rpc: { call },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  } satisfies ConnectionHandle)
  await ctx.plugin({ inject: [...gatewayInject], apply: gatewayApply }).await()
  await ctx.plugin(SlotRegistry).await()
  await ctx.plugin({ inject: [...resourcesInject], apply: resourcesApply }).await()
  new StaticRemoteAccess(ctx, () => allowed)
  const slots = ctx.get('slots') as SlotRegistry
  slots.install(createSlotRenderer())
  const absentSession = createSnapshotStore<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
  slots.installScope('session', {
    current: absentSession, bindingSource: () => absentSession, renderArea: () => null,
  })
  const close = vi.fn()
  const disposeRoot = slots.register({
    name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } }, inject: () => ({ close }),
  }, Root)
  onTestFinished(disposeRoot)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  slots.installLocale(locale)
  await beforeMount?.(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, locale, fiber, close }
}

describe('remote connection settings registration', () => {
  it('keeps the Remote mounted without registering settings or polling in Desktop', async () => {
    vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
    const { ctx, slots } = await bench(call)
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(call).not.toHaveBeenCalled()
    expect(ctx.get('remote.remoteConnection')).toBeDefined()
  })

  it('keeps one navigation entry and replaces QR, link login, and pairing approvals together', async () => {
    const status = { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 }
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/pairingRequests' ? { requests: [], pollIntervalMs: 1000 }
        : endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private' : status,
    }))
    const { ctx, slots, fiber } = await bench(call)
    render(createElement(Fragment, null, slots.renderSlot('root', {})))
    await screen.findByRole('button', { name: '生成二维码' })
    expect(await screen.findByRole('region', { name: '配对申请' })).toBeTruthy()
    expect(screen.getByRole('region', { name: zh.qrTitle })).toBeTruthy()
    expect(screen.getByRole('region', { name: zh.addressTitle })).toBeTruthy()
    expect(slots.entries('settings.section')).toHaveLength(1)
    const replacement = ctx.plugin(replacementPlugin)
    await act(async () => { await replacement.await() })
    expect(screen.queryByRole('region', { name: '配对申请' })).toBeNull()
    expect(screen.queryByRole('region', { name: zh.addressTitle })).toBeNull()
    expect(screen.queryByRole('button', { name: '生成二维码' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Custom connection' })).toBeTruthy()
    expect(slots.entries('settings.section')).toHaveLength(1)
    await act(async () => { await replacement.dispose() })
    expect(await screen.findByRole('region', { name: '配对申请' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '生成二维码' })).toBeTruthy()
    expect(screen.getByRole('region', { name: zh.addressTitle })).toBeTruthy()
    await act(async () => { await fiber.dispose() })
    expect(slots.entries('settings.remoteConnection.content')).toEqual([])
    expect(slots.entries('shell.overlay')).toEqual([])
  })

  it('registers localized content and removes the section and generated namespace when unloaded', async () => {
    const status = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({ ok: true, value: endpoint === 'remoteConnection/loginUrl'
      ? 'https://host.example/?token=private' : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 } }))
    const { ctx, slots, locale, fiber } = await bench(status)
    await vi.waitFor(() => { expect(status).toHaveBeenCalledWith('/api', 'remoteConnection/status', { args: { id: null } }, expect.any(AbortSignal)) })
    const entry = slots.entries('settings.section')[0]!
    expect(entry.options.id).toBe('remote-connection')
    const face = slots.spec('settings.remoteConnection.content')?.inject
    expect(typeof face?.create).toBe('function')
    expect(typeof face?.cancel).toBe('function')
    expect(typeof face?.reload).toBe('function')
    expect(typeof face?.copyLink).toBe('function')
    expect(typeof face?.reloadLink).toBe('function')
    expect(typeof face?.decide).toBe('function')
    expect(face?.hooks).toBeDefined()
    expect(slots.spec('settings.remoteConnection.extensions')?.inject).toBe(face)
    for (const [language, title] of Object.entries({
      zh: '远程连接', en: 'Remote connection', ja: 'リモート接続', es: 'Conexión remota',
      fr: 'Connexion à distance', de: 'Fernverbindung', ru: 'Удалённое подключение', pt: 'Conexão remota',
    })) {
      if (language !== 'zh' && language !== 'en') {
        onTestFinished(locale.addLanguage({ id: language, label: language, fallback: 'en' }))
      }
      locale.setLocale(language)
      expect(resolveSlotLabel(entry.options.label)).toBe(title)
    }
    expect(ctx.get('remote.remoteConnection')).toBeDefined()
    expect(slots.entries('shell.overlay')).toHaveLength(2)
    await fiber.dispose()
    expect(slots.entries('settings.section')).toEqual([])
    expect(slots.entries('settings.remoteConnection.content')).toEqual([])
    expect(slots.spec('settings.remoteConnection.content')).toBeUndefined()
    expect(slots.spec('settings.remoteConnection.extensions')).toBeUndefined()
    expect(ctx.get('remote.remoteConnection')).toBeUndefined()
    expect(slots.entries('shell.overlay')).toEqual([])
  })

  it('keeps the clipboard unchanged when a registered copy action runs before the deployment is read', async () => {
    const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    onTestFinished(() => {
      if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    })
    const response = Promise.withResolvers<undefined>()
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/status') await response.promise
      return { ok: true, value: endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private'
        : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 } }
    })
    let ctx: Context | undefined
    try {
      const runtime = await bench(call)
      ctx = runtime.ctx
      await vi.waitFor(() => { expect(call).toHaveBeenCalledOnce() })
      const face = runtime.slots.spec('settings.remoteConnection.content')!.inject
      expect(face.hooks.remoteConnection.getSnapshot().deployment).toBeNull()
      const before = face.hooks.loginLink.getSnapshot()
      await act(async () => { face.copyLink() })
      expect(write).not.toHaveBeenCalled()
      expect(face.hooks.loginLink.getSnapshot()).toBe(before)
      expect(call).toHaveBeenCalledOnce()
    } finally {
      response.resolve(undefined)
      await ctx?.fiber.dispose()
    }
  })

  it.each(['status', 'loginUrl'] as const)('aborts an outstanding %s RPC and drains plugin teardown without its network response', async (pendingEndpoint) => {
    const requestSignals: AbortSignal[] = []
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation((_channel, endpoint, _data, signal) => {
      if (pendingEndpoint === 'loginUrl' && endpoint === 'remoteConnection/status') {
        return Promise.resolve({ ok: true, value: { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 } })
      }
      if (signal !== undefined) requestSignals.push(signal)
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('transport aborted')) }, { once: true })
      })
    })
    const { ctx, slots, fiber } = await bench(call)
    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(pendingEndpoint === 'status' ? 1 : 2) })
    expect(requestSignals.every(signal => !signal.aborted)).toBe(true)
    await fiber.dispose()
    expect(requestSignals.every(signal => signal.aborted)).toBe(true)
    expect(ctx.get('remote.remoteConnection')).toBeUndefined()
    expect(slots.entries('settings.section')).toEqual([])
    expect(slots.entries('settings.remoteConnection.content')).toEqual([])
  })

  it('appends ordered options without replacing the cards and keeps other entries and login state when one unloads', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/pairingRequests') return { ok: true, value: { requests: [], pollIntervalMs: 60_000 } }
      if (endpoint === 'remoteConnection/loginUrl') return { ok: true, value: 'https://host.example/?token=private' }
      if (endpoint === 'remoteConnection/create') {
        return { ok: true, value: { id: 'extension-invitation', url: 'https://host.example/?login=qr#private', lifetimeMs: 120_000 } }
      }
      if (endpoint === 'remoteConnection/cancel') return { ok: true, value: 'cancelled' }
      return { ok: true, value: { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 60_000 } }
    })
    const { ctx, slots, close } = await bench(call)
    render(slots.renderSlot('root', {}))
    fireEvent.click(await screen.findByRole('button', { name: zh.generate }))
    const qr = await screen.findByRole('img', { name: zh.qr })
    const later = ctx.plugin(extensionPlugin('Later options', 20))
    await act(async () => { await later.await() })
    const laterRegion = screen.getByRole('region', { name: 'Later options' })
    fireEvent.change(within(laterRegion).getByRole('textbox'), { target: { value: 'Keep this draft' } })
    const earlier = ctx.plugin(extensionPlugin('Earlier options', 10))
    await act(async () => { await earlier.await() })
    const earlierRegion = screen.getByRole('region', { name: 'Earlier options' })
    expect(screen.getAllByRole('region')).toEqual(
      [zh.title, zh.addressTitle, zh.qrTitle, zh['pairing.title'], 'Earlier options', 'Later options']
        .map(name => screen.getByRole('region', { name })),
    )
    expect(screen.getByRole('img', { name: zh.qr })).toBe(qr)
    expect(earlierRegion.dataset).toMatchObject({ phase: 'pending', ticket: 'extension-invitation', link: 'ready' })
    expect(laterRegion.dataset).toMatchObject({ phase: 'pending', ticket: 'extension-invitation', link: 'ready' })
    fireEvent.click(within(earlierRegion).getByRole('button', { name: 'Reload link' }))
    await vi.waitFor(() => { expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/loginUrl')).toHaveLength(2) })
    fireEvent.click(within(earlierRegion).getByRole('button', { name: 'Close settings' }))
    expect(close).toHaveBeenCalledOnce()

    await act(async () => { await earlier.dispose() })
    expect(screen.queryByRole('region', { name: 'Earlier options' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Later options' })).toBe(laterRegion)
    expect(within(laterRegion).getByRole('textbox')).toHaveProperty('value', 'Keep this draft')
    expect(screen.getByRole('img', { name: zh.qr })).toBe(qr)
    fireEvent.click(within(laterRegion).getByRole('button', { name: 'Cancel invitation' }))
    await vi.waitFor(() => { expect(laterRegion.dataset.phase).toBe('cancelled') })
    expect(screen.queryByRole('img', { name: zh.qr })).toBeNull()
    fireEvent.click(within(laterRegion).getByRole('button', { name: 'Create invitation' }))
    await screen.findByRole('img', { name: zh.qr })
    await act(async () => { await later.dispose() })
    expect(screen.queryByRole('region', { name: 'Later options' })).toBeNull()
    expect(screen.getByRole('img', { name: zh.qr })).toBeTruthy()
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/create')).toHaveLength(2)
  })

  it('shares an existing invitation with replacement content and restores its remaining lifetime on unload', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    onTestFinished(() => { clock.mockRestore() })
    const status = { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'pending', pollIntervalMs: 60_000 }
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/pairingRequests') return { ok: true, value: { requests: [], pollIntervalMs: 60_000 } }
      if (endpoint === 'remoteConnection/loginUrl') return { ok: true, value: 'https://host.example/?token=private' }
      if (endpoint === 'remoteConnection/create') {
        return { ok: true, value: { id: 'invitation-a', url: 'https://host.example/?login=qr#private', lifetimeMs: 120_000 } }
      }
      return { ok: true, value: status }
    })
    const { ctx, slots, close } = await bench(call)
    render(createElement(Fragment, null, slots.renderSlot('root', {})))
    fireEvent.click(await screen.findByRole('button', { name: '生成二维码' }))
    await screen.findByRole('img', { name: '一次性登录二维码' })
    const extension = ctx.plugin(extensionPlugin('Connection options', 0))
    await act(async () => { await extension.await() })
    const options = screen.getByRole('region', { name: 'Connection options' })
    fireEvent.change(within(options).getByRole('textbox'), { target: { value: 'Keep this draft' } })

    const replacement = ctx.plugin(replacementPlugin)
    await act(async () => { await replacement.await() })
    const custom = screen.getByRole('region', { name: 'Custom connection' })
    expect(screen.queryByRole('region', { name: '远程连接' })).toBeNull()
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(custom.dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-a', seconds: '120' })
    expect(screen.getByRole('region', { name: 'Connection options' })).toBe(options)
    expect(options.dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-a' })
    clock.mockReturnValue(6000)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => { expect(custom.dataset.seconds).toBe('115') })
    expect(call).toHaveBeenLastCalledWith('/api', 'remoteConnection/status', { args: { id: 'invitation-a' } }, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledOnce()

    await act(async () => { await replacement.dispose() })
    expect(screen.queryByRole('region', { name: 'Custom connection' })).toBeNull()
    expect(screen.getByRole('img', { name: '一次性登录二维码' })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe('115 秒后过期')
    expect(within(options).getByRole('textbox')).toHaveProperty('value', 'Keep this draft')
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/create')).toHaveLength(1)
  })

  it('activates early replacement registrations with the owner and delegates creation and cancellation', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/pairingRequests') return { ok: true, value: { requests: [], pollIntervalMs: 60_000 } }
      if (endpoint === 'remoteConnection/loginUrl') return { ok: true, value: 'https://host.example/?token=private' }
      if (endpoint === 'remoteConnection/create') {
        return { ok: true, value: { id: 'invitation-b', url: 'https://host.example/?login=qr#private', lifetimeMs: 120_000 } }
      }
      if (endpoint === 'remoteConnection/cancel') return { ok: true, value: 'cancelled' }
      return { ok: true, value: { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 60_000 } }
    })
    const { ctx, slots, fiber } = await bench(call, async (ctx) => {
      await ctx.plugin(replacementPlugin).await()
      await ctx.plugin(extensionPlugin('Connection options', 0)).await()
      expect(ctx.slots.entries('settings.remoteConnection.content')).toEqual([])
      expect(ctx.slots.entries('settings.remoteConnection.extensions')).toEqual([])
    })
    render(createElement(Fragment, null, slots.renderSlot('root', {})))
    const custom = await screen.findByRole('region', { name: 'Custom connection' })
    await vi.waitFor(() => { expect(custom.dataset.phase).toBe('ready') })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await vi.waitFor(() => { expect(custom.dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-b' }) })
    expect(screen.getByRole('region', { name: 'Connection options' }).dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-b' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await vi.waitFor(() => { expect(custom.dataset.phase).toBe('cancelled') })
    expect(custom.dataset.ticket).toBeUndefined()
    expect(call).toHaveBeenLastCalledWith('/api', 'remoteConnection/cancel', { args: { id: 'invitation-b' } }, expect.any(AbortSignal))
    expect(slots.entries('settings.section')).toHaveLength(1)
    await act(async () => { await fiber.dispose() })
    expect(screen.queryByRole('region')).toBeNull()
    expect(slots.entries('settings.remoteConnection.content')).toEqual([])
    expect(slots.entries('settings.remoteConnection.extensions')).toEqual([])
    expect(slots.spec('settings.remoteConnection.extensions')).toBeUndefined()
    await act(async () => { await ctx.plugin({ inject: [...inject], apply }).await() })
    const restored = screen.getByRole('region', { name: 'Custom connection' })
    await vi.waitFor(() => { expect(restored.dataset.phase).toBe('ready') })
    expect(restored.dataset.ticket).toBeUndefined()
    expect(screen.getByRole('region', { name: 'Connection options' }).dataset.ticket).toBeUndefined()
    expect(slots.entries('settings.section')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await vi.waitFor(() => { expect(restored.dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-b' }) })
    expect(screen.getByRole('region', { name: 'Connection options' }).dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-b' })
  })

  it('keeps copy feedback in the shell after the settings panel closes and localizes failures', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    onTestFinished(() => {
      if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    })
    const url = 'https://host.example/?token=private-login-token'
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/pairingRequests' ? { requests: [], pollIntervalMs: 60_000 }
        : endpoint === 'remoteConnection/loginUrl' ? url
          : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 },
    }))
    const { ctx, slots } = await bench(call)
    render(slots.renderSlot('root', {}))
    const copy = await screen.findByRole('button', { name: zh.copyLink })
    await screen.findByText(url)
    fireEvent.click(copy)
    await screen.findByText(zh.linkCopied)
    expect(write).toHaveBeenCalledWith(url)
    expect(screen.getByText(zh.linkWarning)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle settings' }))
    expect(screen.queryByRole('region', { name: zh.title })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(zh.linkCopied)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle settings' }))
    expect(screen.queryByText(zh.linkWarning)).toBeNull()
    write.mockRejectedValueOnce(new Error('clipboard permission'))
    fireEvent.click(await screen.findByRole('button', { name: zh.copyLink }))
    await screen.findByText(zh.copyFailed)
    expect(screen.queryByText(zh.linkWarning)).toBeNull()
    expect(screen.getByText(url)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.copyLink }))
    await screen.findByText(zh.linkWarning)
    expect(screen.getByRole('alert').textContent).toBe(zh.linkCopied)
    call.mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/pairingRequests' ? { requests: [], pollIntervalMs: 60_000 }
        : endpoint === 'remoteConnection/loginUrl' ? `${url}-new`
          : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 },
    }))
    act(() => { ctx.emit('connection/reset') })
    await screen.findByText(`${url}-new`)
    expect(screen.queryByText(zh.linkWarning)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.copyLink })) })
      expect(write).toHaveBeenLastCalledWith(`${url}-new`)
      expect(screen.getByRole('alert').textContent).toBe(zh.linkCopied)
      act(() => { vi.advanceTimersByTime(4000) })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByText(zh.linkWarning)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a late clipboard outcome in the shell without warning a reopened settings panel', async () => {
    const writing = Promise.withResolvers<undefined>()
    const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined).mockReturnValueOnce(writing.promise)
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    onTestFinished(() => {
      writing.resolve(undefined)
      if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    })
    const url = 'https://host.example/?token=private-login-token'
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/pairingRequests' ? { requests: [], pollIntervalMs: 60_000 }
        : endpoint === 'remoteConnection/loginUrl' ? url
          : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 },
    }))
    const { slots } = await bench(call)
    render(slots.renderSlot('root', {}))
    await screen.findByText(url)
    fireEvent.click(screen.getByRole('button', { name: zh.copyLink }))
    expect(write).toHaveBeenCalledExactlyOnceWith(url)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Toggle settings' }))
    expect(screen.getByRole('button', { name: zh.copyLink })).toHaveProperty('disabled', true)
    await act(async () => { writing.resolve(undefined); await writing.promise })
    await screen.findByText(zh.linkCopied)
    expect(screen.queryByText(zh.linkWarning)).toBeNull()
    expect(screen.getByText(url)).toBeTruthy()
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: zh.copyLink })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: zh.copyLink }))
    await screen.findByText(zh.linkWarning)
    expect(write).toHaveBeenCalledTimes(2)
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/loginUrl')).toHaveLength(1)
  })

  it('shows and copies a loopback login link, then drops it when the Host stops permitting it', async () => {
    const write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    onTestFinished(() => {
      if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    })
    let loginUrlAllowed = false
    const url = 'http://127.0.0.1:5432/'
    const link = `${url}?token=private`
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/pairingRequests' ? { requests: [], pollIntervalMs: 60_000 }
        : endpoint === 'remoteConnection/loginUrl' ? link
          : { url, availability: loginUrlAllowed ? 'unreachable-host' : 'untrusted-host', loginUrlAllowed, ticket: 'none', pollIntervalMs: 1000 },
    }))
    const { ctx, slots } = await bench(call)
    await vi.waitFor(() => { expect(call).toHaveBeenCalledOnce() })
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(2) })
    expect(call.mock.calls.every(([, endpoint]) => endpoint === 'remoteConnection/status')).toBe(true)
    const face = slots.spec('settings.remoteConnection.content')!.inject
    await vi.waitFor(() => { expect(face.hooks.remoteConnection.getSnapshot().deployment?.availability).toBe('untrusted-host') })
    face.copyLink()
    await vi.waitFor(() => { expect(write).toHaveBeenCalledExactlyOnceWith(url) })
    await vi.waitFor(() => { expect(face.hooks.loginLink.getSnapshot().notice).toBe('linkCopied') })
    expect(face.hooks.loginLink.getSnapshot().copied).toBe(false)
    loginUrlAllowed = true
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/loginUrl')).toHaveLength(1) })
    await vi.waitFor(() => { expect(face.hooks.loginLink.getSnapshot().url).toBe(link) })
    render(slots.renderSlot('root', {}))
    const address = within(screen.getByRole('region', { name: zh.addressTitle }))
    expect(address.getByText(link)).toBeTruthy()
    expect(screen.queryByRole('region', { name: zh.qrTitle })).toBeNull()
    fireEvent.click(address.getByRole('button', { name: zh.copyLink }))
    await screen.findByText(zh.linkWarning)
    expect(write).toHaveBeenLastCalledWith(link)
    loginUrlAllowed = false
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(face.hooks.remoteConnection.getSnapshot().deployment?.availability).toBe('untrusted-host') })
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/status')).toHaveLength(4)
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(face.hooks.remoteConnection.getSnapshot().deployment?.loginUrlAllowed).toBe(false) })
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/status')).toHaveLength(5)
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/loginUrl')).toHaveLength(1)
    expect(face.hooks.loginLink.getSnapshot().url).toBeNull()
    expect(screen.queryByText(link)).toBeNull()
    expect(screen.queryByText(zh.linkWarning)).toBeNull()
    face.reloadLink()
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/loginUrl')).toHaveLength(1)
    face.copyLink()
    await vi.waitFor(() => { expect(write).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => { expect(face.hooks.loginLink.getSnapshot().notice).toBe('linkCopied') })
    expect(write).toHaveBeenLastCalledWith(url)
    expect(face.hooks.loginLink.getSnapshot().copied).toBe(false)
  })

  it('requests a new link when the advertised address changes between eligible addresses', async () => {
    const previous = 'https://host.example/'
    const local = 'http://127.0.0.1/'
    let address = previous
    const nextRead = Promise.withResolvers<string>()
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/loginUrl') {
        return { ok: true, value: address === local ? await nextRead.promise : `${previous}?token=previous` }
      }
      return { ok: true, value: { url: address, availability: address === local ? 'unreachable-host' : 'available',
        loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 } }
    })
    const { slots } = await bench(call)
    onTestFinished(() => { nextRead.resolve(`${local}?token=local`) })
    const face = slots.spec('settings.remoteConnection.content')!.inject
    await vi.waitFor(() => { expect(face.hooks.loginLink.getSnapshot().url).toBe(`${previous}?token=previous`) })
    address = local
    face.reload()
    await vi.waitFor(() => { expect(face.hooks.remoteConnection.getSnapshot().deployment?.url).toBe(local) })
    expect(face.hooks.loginLink.getSnapshot().url).toBeNull()
    nextRead.resolve(`${local}?token=local`)
    await vi.waitFor(() => { expect(face.hooks.loginLink.getSnapshot().url).toBe(`${local}?token=local`) })
  })

  it.each(['en', 'zh'] as const)('copies the clean address after a credential read fails and reports clipboard outcomes in %s', async (language) => {
    const copy = language === 'en' ? en : zh
    const write = vi.fn<(text: string) => Promise<void>>().mockRejectedValueOnce(new Error('clipboard permission')).mockResolvedValue(undefined)
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    onTestFinished(() => {
      if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    })
    const url = 'https://host.example/'
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/loginUrl') throw new Error('credential transport unavailable')
      return { ok: true, value: endpoint === 'remoteConnection/pairingRequests' ? { requests: [], pollIntervalMs: 60_000 }
        : { url, availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 } }
    })
    const { slots, locale } = await bench(call)
    locale.setLocale(language)
    render(slots.renderSlot('root', {}))
    const face = slots.spec('settings.remoteConnection.content')!.inject
    await vi.waitFor(() => { expect(face.hooks.loginLink.getSnapshot().phase).toBe('error') })
    const address = within(screen.getByRole('region', { name: copy.addressTitle }))
    const action = address.getByRole('button', { name: copy.copyLink })
    expect(address.getByText(url)).toBeTruthy()
    expect(address.queryByRole('alert')).toBeNull()
    expect(address.queryByRole('button', { name: copy.retry })).toBeNull()
    expect(action).toHaveProperty('disabled', false)
    fireEvent.click(action)
    await screen.findByText(copy.copyFailed)
    expect(write).toHaveBeenLastCalledWith(url)
    expect(screen.queryByText(copy.linkWarning)).toBeNull()
    fireEvent.click(action)
    await screen.findByText(copy.linkCopied)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith(url)
    expect(address.getByRole('button', { name: copy.copyLink })).toBe(action)
    expect(screen.queryByText(copy.linkWarning)).toBeNull()
    expect(screen.getByRole('button', { name: copy.generate })).toHaveProperty('disabled', false)
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/loginUrl')).toHaveLength(1)
  })

  it('keeps plugin disposal pending until a clipboard write settles', async () => {
    let finish!: () => void
    const pendingWrite = new Promise<void>((resolve) => { finish = resolve })
    const write = vi.fn(() => pendingWrite)
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    onTestFinished(() => {
      if (descriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', descriptor)
    })
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/pairingRequests' ? { requests: [], pollIntervalMs: 60_000 }
        : endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private'
          : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 },
    }))
    const { slots, fiber } = await bench(call)
    render(slots.renderSlot('root', {}))
    const copy = await screen.findByRole('button', { name: zh.copyLink })
    await vi.waitFor(() => { expect(copy).toHaveProperty('disabled', false) })
    try {
      fireEvent.click(copy)
      expect(write).toHaveBeenCalledOnce()
      let disposed = false
      const disposal = fiber.dispose().then(() => { disposed = true })
      await vi.waitFor(() => { expect(slots.entries('settings.section')).toEqual([]) })
      expect(disposed).toBe(false)
      finish()
      await act(async () => { await disposal })
      expect(disposed).toBe(true)
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      finish()
    }
  })
})

function approvalFace(slots: SlotRegistry): PairingInjected {
  const face = slots.spec('settings.remoteConnection.content')?.inject
  if (face === undefined) throw new Error('Missing connection settings injection')
  return face
}

it('submits approval through the shared namespace and keeps its notice outside Settings', async () => {
  const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
    ok: true, value: endpoint === 'remoteConnection/decidePairing' ? 'approved'
      : endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private'
        : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 },
  }))
  const { slots, fiber } = await bench(call)
  const face = approvalFace(slots)
  await face.decide('request-one' as PairingRequestId, 'allow')
  expect(call).toHaveBeenCalledWith('/api', 'remoteConnection/decidePairing', { args: { id: 'request-one', decision: 'allow' } }, expect.any(AbortSignal))
  expect(face.hooks.approval.getSnapshot().notice).toBe('approved')
  expect(slots.entries('shell.overlay')).toHaveLength(2)
  face.dismiss()
  expect(face.hooks.approval.getSnapshot().notice).toBeNull()
  await fiber.dispose()
  expect(face.hooks.approval.getSnapshot().available).toBe(false)
})

it('shares owner approval with appended options across panel replacement', async () => {
  const decision = Promise.withResolvers<{ ok: true; value: 'approved' }>()
  onTestFinished(() => { decision.resolve({ ok: true, value: 'approved' }) })
  let approved = false
  const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
    if (endpoint === 'remoteConnection/decidePairing') {
      const result = await decision.promise
      approved = true
      return result
    }
    if (endpoint === 'remoteConnection/pairingRequests') return { ok: true, value: {
      requests: approved ? [] : [{ id: 'request-one', code: 'ABCD2345', authority: 'https://host.example', sourceIp: '192.0.2.17', expiresInMs: 60000 }],
      pollIntervalMs: 1000,
    } }
    return { ok: true, value: endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private'
      : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 } }
  })
  const { ctx, slots, fiber } = await bench(call)
  const extension = ctx.plugin(pairingExtensionPlugin)
  await extension.await()
  render(createElement(Fragment, null, slots.renderSlot('root', {})))
  const approval = await screen.findByRole('button', { name: zh['pairing.approve'] })
  const options = within(screen.getByRole('region', { name: 'Pairing extension' }))
  expect(options.getByRole('status', { name: 'Approval status' }).textContent).toBe('ready')
  fireEvent.click(options.getByRole('button', { name: 'Approve request' }))
  expect(approval.hasAttribute('disabled')).toBe(true)
  expect(options.getByRole('button', { name: 'Approve request' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { decision.resolve({ ok: true, value: 'approved' }) })
  await screen.findByText(zh['pairing.approved'])
  expect(options.getByRole('status', { name: 'Approval status' }).textContent).toBe('approved')
  expect(screen.queryByText('ABCD 2345')).toBeNull()
  expect(call).toHaveBeenCalledWith('/api', 'remoteConnection/decidePairing', { args: { id: 'request-one', decision: 'allow' } }, expect.any(AbortSignal))
  const replacement = ctx.plugin(replacementPlugin)
  await act(async () => { await replacement.await() })
  expect(screen.queryByRole('region', { name: '配对申请' })).toBeNull()
  expect(options.getByRole('status', { name: 'Approval status' }).textContent).toBe('approved')
  fireEvent.click(options.getByRole('button', { name: 'Dismiss approval' }))
  expect(screen.queryByText(zh['pairing.approved'])).toBeNull()
  expect(approvalFace(slots).hooks.approval.getSnapshot().notice).toBeNull()
  await act(async () => { await extension.dispose() })
  expect(screen.queryByRole('region', { name: 'Pairing extension' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Custom connection' })).toBeTruthy()
  await act(async () => { await fiber.dispose() })
})

it('preserves QR navigation while refusing pairing controls and reads without owner access', async () => {
  const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
    ok: true, value: endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private'
      : { url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 },
  }))
  const { ctx, slots, fiber } = await bench(call, undefined, false)
  await ctx.plugin(pairingExtensionPlugin).await()
  render(createElement(Fragment, null, slots.renderSlot('root', {})))
  await screen.findByRole('button', { name: '生成二维码' })
  expect(slots.entries('settings.section')).toHaveLength(1)
  expect(slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual(['remote-connection-copy'])
  expect(screen.queryByRole('region', { name: '配对申请' })).toBeNull()
  const options = within(screen.getByRole('region', { name: 'Pairing extension' }))
  expect(options.getByRole('status', { name: 'Approval status' }).textContent).toBe('unavailable')
  expect(options.getByRole('button', { name: 'Approve request' }).hasAttribute('disabled')).toBe(true)
  await approvalFace(slots).decide('request-one' as PairingRequestId, 'allow')
  await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(2) })
  expect(call.mock.calls.map(([, endpoint]) => endpoint)).toEqual(['remoteConnection/status', 'remoteConnection/loginUrl'])
  await act(async () => { await fiber.dispose() })
})

it('aborts a pending pairing read and decision when the shared plugin unloads', async () => {
  const signals: AbortSignal[] = []
  const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint, _args, signal) => {
    if (endpoint === 'remoteConnection/status') return { ok: true, value: {
      url: 'https://host.example/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000,
    } }
    if (endpoint === 'remoteConnection/loginUrl') return { ok: true, value: 'https://host.example/?token=private' }
    if (signal === undefined) throw new Error('Missing lifetime signal')
    signals.push(signal)
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  })
  const { ctx, slots, fiber } = await bench(call)
  const pin = new AbortController()
  onTestFinished(() => { pin.abort() })
  ctx.resources.pin('dsh-resource://device-pairing/requests', pin.signal)
  const face = approvalFace(slots)
  const decision = face.decide('request-one' as PairingRequestId, 'deny')
  await vi.waitFor(() => { expect(signals).toHaveLength(2) })
  await fiber.dispose()
  await decision
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect(slots.entries('settings.section')).toEqual([])
  expect(slots.entries('shell.overlay')).toEqual([])
  expect(face.hooks.approval.getSnapshot()).toMatchObject({ available: false, busy: false, notice: null })
})
