import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopUpdateAttention } from '../src/update-attention.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const notices: Notice[] = []
  class Notice extends EventEmitter {
    static isSupported = vi.fn(() => true)
    show = vi.fn()
    close = vi.fn()
    constructor(readonly options: unknown) { super(); notices.push(this) }
  }
  return { notices, Notice, dock: { bounce: vi.fn(() => 17), cancelBounce: vi.fn() } }
})
vi.mock('electron', () => ({ Notification: native.Notice, app: { dock: native.dock } }))
let attention: DesktopUpdateAttention | undefined
afterEach(() => { attention?.reset(); native.notices.length = 0; vi.clearAllMocks(); native.Notice.isSupported.mockReturnValue(true) })
function setup(platform: string) {
  const window = Object.assign(new EventEmitter(), { focused: false, isFocused() { return this.focused },
    isDestroyed: () => false, flashFrame: vi.fn() })
  const modal = Object.assign(new EventEmitter(), { isFocused: () => false })
  const returned = vi.fn()
  attention = new DesktopUpdateAttention(resolveDesktopLocale('zh'), platform)
  const ready = () => { attention!.ready('1.0.1-nightly.1', window as unknown as BrowserWindow, modal as unknown as BrowserWindow, returned) }
  return { window, modal, returned, ready }
}

it.each(['win32', 'darwin'])('requests one silent reminder and returns to confirmation without installing: %s', (platform) => {
  const f = setup(platform)
  f.ready(); f.ready()
  expect(native.notices).toHaveLength(1)
  expect(native.notices[0]!.options).toEqual({ title: '更新已准备就绪', body: '返回应用确认安装并重启。', silent: true })
  if (platform === 'win32') expect(f.window.flashFrame).toHaveBeenCalledWith(true)
  else expect(native.dock.bounce).toHaveBeenCalledWith('informational')
  native.notices[0]!.emit('click')
  expect(f.returned).toHaveBeenCalledOnce()
  expect(native.notices[0]!.close).toHaveBeenCalledOnce()
  f.ready()
  expect(native.notices).toHaveLength(1)
  expect(f.window.listenerCount('focus')).toBe(0)
})

it('clears on focus and ignores stale clicks, even after deferral and another background switch', () => {
  const f = setup('win32')
  f.ready()
  const notification = native.notices[0]!
  f.modal.emit('focus')
  notification.emit('click')
  f.ready()
  expect(f.returned).not.toHaveBeenCalled()
  expect(native.notices).toHaveLength(1)
  expect(f.window.flashFrame).toHaveBeenLastCalledWith(false)
  expect(f.modal.listenerCount('focus')).toBe(0)
})

it('does not notify foreground readiness and does not require notification support', () => {
  const f = setup('win32')
  f.window.focused = true
  f.ready()
  f.window.focused = false
  f.ready()
  expect(native.notices).toHaveLength(0)
  attention!.reset()
  native.Notice.isSupported.mockReturnValue(false)
  f.ready()
  expect(f.window.flashFrame).toHaveBeenCalledWith(true)
  expect(native.notices).toHaveLength(0)
})

it('keeps icon attention when the system rejects a notification', () => {
  const f = setup('darwin')
  f.ready()
  native.notices[0]!.emit('failed')
  expect(native.dock.cancelBounce).not.toHaveBeenCalled()
  attention!.reset()
  expect(native.dock.cancelBounce).toHaveBeenCalledWith(17)
  expect(f.modal.listenerCount('focus')).toBe(0)
})
