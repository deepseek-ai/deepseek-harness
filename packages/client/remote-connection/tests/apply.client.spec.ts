// @vitest-environment jsdom
/** Generated Remote methods and settings registrations leave with the plugin fiber. */
import { Context } from '@deepseek-ai/cordis'
import { createElement, Fragment, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type PropsRenderSlots, type StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as gatewayApply, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteConnectionContentProps } from '@deepseek-ai/dsh-client-remote-connection/client'
import { zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

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

async function bench(call: ConnectionHandle['rpc']['call'], beforeMount?: (ctx: Context) => Promise<void>) {
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
  it('registers localized content and removes the section and generated namespace when unloaded', async () => {
    const status = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({ ok: true, value: endpoint === 'remoteConnection/loginUrl'
      ? 'https://host.example/?token=private' : { url: 'https://host.example/', availability: 'available', ticket: 'none', pollIntervalMs: 1000 } }))
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
    expect(face?.hooks).toBeDefined()
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
    expect(slots.entries('shell.overlay')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('settings.section')).toEqual([])
    expect(slots.entries('settings.remoteConnection.content')).toEqual([])
    expect(slots.spec('settings.remoteConnection.content')).toBeUndefined()
    expect(ctx.get('remote.remoteConnection')).toBeUndefined()
    expect(slots.entries('shell.overlay')).toEqual([])
  })

  it.each(['status', 'loginUrl'] as const)('aborts an outstanding %s RPC and drains plugin teardown without its network response', async (pendingEndpoint) => {
    const requestSignals: AbortSignal[] = []
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation((_channel, endpoint, _data, signal) => {
      if (pendingEndpoint === 'loginUrl' && endpoint === 'remoteConnection/status') {
        return Promise.resolve({ ok: true, value: { url: 'https://host.example/', availability: 'available', ticket: 'none', pollIntervalMs: 1000 } })
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

  it('shares an existing invitation with replacement content and restores its remaining lifetime on unload', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    onTestFinished(() => { clock.mockRestore() })
    const status = { url: 'https://host.example/', availability: 'available', ticket: 'pending', pollIntervalMs: 60_000 }
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/loginUrl') return { ok: true, value: 'https://host.example/?token=private' }
      if (endpoint === 'remoteConnection/create') {
        return { ok: true, value: { id: 'invitation-a', url: 'https://host.example/remote-login#private', lifetimeMs: 120_000 } }
      }
      return { ok: true, value: status }
    })
    const { ctx, slots, close } = await bench(call)
    render(createElement(Fragment, null, slots.renderSlot('root', {})))
    fireEvent.click(await screen.findByRole('button', { name: '生成二维码' }))
    await screen.findByRole('img', { name: '一次性登录二维码' })

    const replacement = ctx.plugin(replacementPlugin)
    await act(async () => { await replacement.await() })
    const custom = screen.getByRole('region', { name: 'Custom connection' })
    expect(screen.queryByRole('region', { name: '远程连接' })).toBeNull()
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(custom.dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-a', seconds: '120' })
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
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/create')).toHaveLength(1)
  })

  it('activates early replacement registrations with the owner and delegates creation and cancellation', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => {
      if (endpoint === 'remoteConnection/loginUrl') return { ok: true, value: 'https://host.example/?token=private' }
      if (endpoint === 'remoteConnection/create') {
        return { ok: true, value: { id: 'invitation-b', url: 'https://host.example/remote-login#private', lifetimeMs: 120_000 } }
      }
      if (endpoint === 'remoteConnection/cancel') return { ok: true, value: 'cancelled' }
      return { ok: true, value: { url: 'https://host.example/', availability: 'available', ticket: 'none', pollIntervalMs: 60_000 } }
    })
    const { ctx, slots, fiber } = await bench(call, async (ctx) => {
      await ctx.plugin(replacementPlugin).await()
      expect(ctx.slots.entries('settings.remoteConnection.content')).toEqual([])
    })
    render(createElement(Fragment, null, slots.renderSlot('root', {})))
    const custom = await screen.findByRole('region', { name: 'Custom connection' })
    await vi.waitFor(() => { expect(custom.dataset.phase).toBe('ready') })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await vi.waitFor(() => { expect(custom.dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-b' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await vi.waitFor(() => { expect(custom.dataset.phase).toBe('cancelled') })
    expect(custom.dataset.ticket).toBeUndefined()
    expect(call).toHaveBeenLastCalledWith('/api', 'remoteConnection/cancel', { args: { id: 'invitation-b' } }, expect.any(AbortSignal))
    expect(slots.entries('settings.section')).toHaveLength(1)
    await act(async () => { await fiber.dispose() })
    expect(screen.queryByRole('region')).toBeNull()
    expect(slots.entries('settings.remoteConnection.content')).toEqual([])
    await act(async () => { await ctx.plugin({ inject: [...inject], apply }).await() })
    const restored = screen.getByRole('region', { name: 'Custom connection' })
    await vi.waitFor(() => { expect(restored.dataset.phase).toBe('ready') })
    expect(restored.dataset.ticket).toBeUndefined()
    expect(slots.entries('settings.section')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await vi.waitFor(() => { expect(restored.dataset).toMatchObject({ phase: 'pending', ticket: 'invitation-b' }) })
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
      ok: true, value: endpoint === 'remoteConnection/loginUrl' ? url
        : { url: 'https://host.example/', availability: 'available', ticket: 'none', pollIntervalMs: 1000 },
    }))
    const { ctx, slots } = await bench(call)
    render(slots.renderSlot('root', {}))
    const copy = await screen.findByRole('button', { name: zh.copyLink })
    await vi.waitFor(() => { expect(copy).toHaveProperty('disabled', false) })
    fireEvent.click(copy)
    await screen.findByText(zh.linkCopied)
    expect(write).toHaveBeenCalledWith(url)
    expect(screen.getByText(zh.linkWarning)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle settings' }))
    expect(screen.queryByRole('region', { name: zh.title })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(zh.linkCopied)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle settings' }))
    write.mockRejectedValueOnce(new Error('clipboard permission'))
    fireEvent.click(await screen.findByRole('button', { name: zh.copied }))
    await screen.findByText(zh.copyFailed)
    expect(screen.getByText(zh.linkWarning)).toBeTruthy()
    expect(screen.getByText(url)).toBeTruthy()
    call.mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/loginUrl' ? `${url}-new`
        : { url: 'https://host.example/', availability: 'available', ticket: 'none', pollIntervalMs: 1000 },
    }))
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: zh.copyLink })).toHaveProperty('disabled', false) })
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

  it('prefetches the login link only after deployment becomes available', async () => {
    let available = false
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async (_channel, endpoint) => ({
      ok: true, value: endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private'
        : { url: 'https://host.example/', availability: available ? 'available' : 'untrusted-host', ticket: 'none', pollIntervalMs: 1000 },
    }))
    const { ctx, slots } = await bench(call)
    await vi.waitFor(() => { expect(call).toHaveBeenCalledOnce() })
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(2) })
    expect(call.mock.calls.every(([, endpoint]) => endpoint === 'remoteConnection/status')).toBe(true)
    available = true
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/loginUrl')).toHaveLength(1) })
    const face = slots.spec('settings.remoteConnection.content')!.inject
    available = false
    act(() => { face.reload() })
    await vi.waitFor(() => { expect(face.hooks.remoteConnection.getSnapshot().deployment?.availability).toBe('untrusted-host') })
    act(() => { ctx.emit('connection/reset') })
    await vi.waitFor(() => { expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'remoteConnection/status')).toHaveLength(5) })
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
      ok: true, value: endpoint === 'remoteConnection/loginUrl' ? 'https://host.example/?token=private'
        : { url: 'https://host.example/', availability: 'available', ticket: 'none', pollIntervalMs: 1000 },
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
