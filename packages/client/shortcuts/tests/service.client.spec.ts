// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import ShortcutsService from '../src/client/index.ts'
import { initialShortcutConfig } from '../src/protocol.ts'
import type { DesktopKeyboardApi, DesktopShortcutsApi, ShortcutConfigSnapshot, ShortcutCommandId } from '../src/protocol.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  delete document.documentElement.dataset.platform
  Reflect.deleteProperty(window, 'dshDesktop')
  localStorage.clear()
  vi.restoreAllMocks()
})
const snapshot = (sequence: number): ShortcutConfigSnapshot => ({ ...initialShortcutConfig(), sequence, status: 'ready' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function desktop() {
  document.documentElement.dataset.platform = 'darwin'
  let publish!: (value: ShortcutConfigSnapshot) => void
  const unsubscribe = vi.fn()
  const api = {
    get: vi.fn<DesktopShortcutsApi['get']>().mockResolvedValue(snapshot(1)),
    edit: vi.fn<DesktopShortcutsApi['edit']>().mockResolvedValue({ status: 'saved', snapshot: snapshot(3) }),
    recording: vi.fn<DesktopShortcutsApi['recording']>().mockResolvedValue(),
    subscribe: vi.fn<DesktopShortcutsApi['subscribe']>((listener) => { publish = listener; return unsubscribe }),
  }
  const keyboard = {
    closeWindow: vi.fn<DesktopKeyboardApi['closeWindow']>().mockResolvedValue(),
    subscribe: vi.fn<DesktopKeyboardApi['subscribe']>(() => () => {}),
  }
  Object.defineProperty(window, 'dshDesktop', { configurable: true, value: { shortcuts: api, keyboard } })
  return { api, keyboard, publish: (value: ShortcutConfigSnapshot) => { publish(value) }, unsubscribe }
}
function mount() {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const dispose = async () => { await ctx.fiber.dispose() }
  disposers.push(dispose)
  const service = new ShortcutsService(ctx)
  return { ctx, service, dispose }
}

it('closes the Desktop window with the latest accepted revision and propagates bridge errors', async () => {
  const f = desktop()
  const { service } = mount()
  await vi.waitFor(() => { expect(service.config.getSnapshot().status).toBe('ready') })
  const latest = snapshot(10)
  f.publish(latest)
  await service.closeWindow()
  expect(f.keyboard.closeWindow).toHaveBeenCalledExactlyOnceWith(latest.revision)
  const failure = new Error('Window unavailable')
  f.keyboard.closeWindow.mockRejectedValueOnce(failure)
  await expect(service.closeWindow()).rejects.toBe(failure)
})

it('rejects a native window close outside Desktop', async () => {
  const { service } = mount()
  await expect(service.closeWindow()).rejects.toThrow('Desktop keyboard bridge unavailable')
})

it('describes registered binding conflicts on Linux Desktop', async () => {
  desktop()
  document.documentElement.dataset.platform = 'linux'
  const { service } = mount()
  const off = service.register(command)
  await vi.waitFor(() => { expect(service.config.getSnapshot().status).toBe('ready') })
  expect(service.describeBinding({ code: 'KeyB', modifiers: ['control'] }).conflicts).toEqual([command.id])
  off()
  expect(service.describeBinding({ code: 'KeyB', modifiers: ['control'] }).conflicts).toEqual([])
})
const command = { id: 'test.toggle' as ShortcutCommandId, label: () => 'Toggle', aliases: [],
  defaults: {
    'desktop:macos': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:windows': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:linux': { code: 'KeyB', modifiers: ['primary'] as const },
  }, regions: ['page'] as const, modals: [],
  resolve: () => ({ status: 'handled' as const, run() {} }) }

it('waits for the Desktop handshake and ignores older get, edit, and broadcast replies', async () => {
  const f = desktop(), first = deferred<ShortcutConfigSnapshot>()
  f.api.get.mockReturnValueOnce(first.promise)
  const { service } = mount()
  f.publish(snapshot(20))
  expect(service.config.getSnapshot().status).toBe('loading')
  const off = service.register(command)
  await vi.waitFor(() => { expect(service.config.getSnapshot().status).toBe('ready') })
  f.publish(snapshot(10)); first.resolve(snapshot(1)); await first.promise
  expect(service.config.getSnapshot().sequence).toBe(10)
  f.publish(snapshot(9))
  await service.edit({ type: 'reset-all' }, service.config.getSnapshot().revision)
  expect(service.config.getSnapshot().sequence).toBe(10)
  f.api.edit.mockResolvedValueOnce({ status: 'saved', snapshot: snapshot(12) })
  await service.edit({ type: 'reset-all' }, service.config.getSnapshot().revision)
  expect(service.config.getSnapshot().sequence).toBe(12)
  await service.recording(true); expect(f.api.recording).toHaveBeenCalledWith(true)
  off()
  expect(f.api.get).toHaveBeenLastCalledWith([])
})

it.each(['darwin', 'win32', 'linux'])('rejects %s Desktop startup without its native keyboard bridge', (platform) => {
  const { api } = desktop()
  document.documentElement.dataset.platform = platform
  Object.defineProperty(window, 'dshDesktop', { configurable: true, value: { shortcuts: api } })
  const read = vi.spyOn(Storage.prototype, 'getItem'), write = vi.spyOn(Storage.prototype, 'setItem')
  expect(() => mount()).toThrow('Desktop keyboard bridge unavailable')
  expect(api.get).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

it('reports unavailable Desktop storage without reading or writing localStorage', async () => {
  const { keyboard } = desktop()
  Object.defineProperty(window, 'dshDesktop', { configurable: true, value: { keyboard } })
  const read = vi.spyOn(Storage.prototype, 'getItem'), write = vi.spyOn(Storage.prototype, 'setItem')
  const { service } = mount()
  expect(service.config.getSnapshot().status).toBe('unreadable')
  expect((await service.edit({ type: 'reset-all' }, service.config.getSnapshot().revision)).status).toBe('unreadable')
  await expect(service.recording(true)).rejects.toThrow('bridge unavailable')
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

it('retains accepted bindings when the Desktop bridge rejects reads and writes', async () => {
  const f = desktop(); const { service } = mount()
  await vi.waitFor(() => { expect(service.config.getSnapshot().status).toBe('ready') })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('IPC disconnected')
  f.api.edit.mockRejectedValueOnce(failure)
  const accepted = service.config.getSnapshot()
  expect((await service.edit({ type: 'reset-all' }, accepted.revision)).status).toBe('write-failed')
  expect(service.config.getSnapshot()).toBe(accepted)
  expect(error).toHaveBeenCalledExactlyOnceWith('Shortcut preference save failed', failure)
  f.api.get.mockRejectedValueOnce(new Error('handshake failed'))
  service.register(command)
  await vi.waitFor(() => { expect(service.config.getSnapshot().error).toBe('read') })
})

it.each(['resolve', 'reject'] as const)('suppresses %s completions after disposal and releases the bridge subscription', async (outcome) => {
  const f = desktop(), pending = deferred<ShortcutConfigSnapshot>()
  f.api.get.mockReturnValue(pending.promise)
  f.api.edit.mockImplementation(async () => ({ status: 'saved', snapshot: await pending.promise }))
  const { service, dispose } = mount()
  const off = service.register(command), edit = service.edit({ type: 'reset-all' }, service.config.getSnapshot().revision)
  const accepted = service.config.getSnapshot()
  await dispose(); off(); f.publish(snapshot(50))
  if (outcome === 'resolve') pending.resolve(snapshot(30))
  else pending.reject(new Error('window closed'))
  await edit
  expect(service.config.getSnapshot()).toBe(accepted)
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('persists Web edits and presents normalized bindings through the public service', async () => {
  const { service, ctx } = mount()
  await vi.waitFor(() => { expect(service.config.getSnapshot().status).toBe('ready') })
  expect(service.describeBinding(null)).toEqual({ binding: null, keys: [], issue: null, conflicts: [] })
  expect(service.describeBinding({ code: 'Slash', modifiers: ['primary'] }))
    .toMatchObject({ issue: null, binding: { code: 'Slash', modifiers: ['control'] } })
  const off = service.register({ ...command, defaults: {
    'web:macos': { code: 'Slash', modifiers: ['primary'] },
    'web:windows': { code: 'Slash', modifiers: ['primary'] },
    'web:linux': { code: 'Slash', modifiers: ['primary'] },
  } })
  await vi.waitFor(() => { expect(service.config.getSnapshot().status).toBe('ready') })
  const changed = vi.fn(); service.catalog.subscribe(changed)
  ctx.locale.setLocale('zh'); expect(changed).toHaveBeenCalled()
  expect((await service.edit({ type: 'set', id: command.id, binding: null }, service.config.getSnapshot().revision)).status).toBe('saved')
  expect(service.catalog.getSnapshot()[0]?.keys).toEqual([])
  await service.recording(true); off()
})

it('publishes fixed reservations to Desktop and reports their conflicts while their owner is mounted', () => {
  const f = desktop(), { service } = mount()
  const off = service.registerFixed({ id: 'menu.close' as ShortcutCommandId, label: () => 'Close', keys: ['Esc'],
    bindings: [{ code: 'Escape', modifiers: [] }], group: 'menus' })
  expect(f.api.get).toHaveBeenLastCalledWith([{ id: 'menu.close', defaults: {}, fixed: [{ code: 'Escape', modifiers: [] }] }])
  expect(service.describeBinding({ code: 'Escape', modifiers: [] }).conflicts).toEqual(['menu.close'])
  expect(service.describeBinding({ code: 'KeyA', secondCode: 'Escape', modifiers: [] }).conflicts).toEqual(['menu.close'])
  expect(service.describeBinding({ code: 'Escape', modifiers: ['alt'] }).conflicts).toEqual([])
  off()
  expect(service.describeBinding({ code: 'Escape', modifiers: [] }).conflicts).toEqual([])
  expect(f.api.get).toHaveBeenLastCalledWith([])
})

it('propagates catalog publication failures after a successful preference save', async () => {
  const f = desktop()
  const { service } = mount()
  const label = vi.fn(() => 'Toggle')
  service.register({ ...command, label })
  await vi.waitFor(() => { expect(service.config.getSnapshot().status).toBe('ready') })
  label.mockImplementationOnce(() => { throw new Error('Command label unavailable') })
  await expect(service.edit({ type: 'reset-all' }, service.config.getSnapshot().revision))
    .rejects.toThrow('Command label unavailable')
  expect(f.api.edit).toHaveBeenCalledOnce()
})
