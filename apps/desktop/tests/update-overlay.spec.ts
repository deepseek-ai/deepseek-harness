import { EventEmitter } from 'node:events'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron'
import { DesktopUpdateOverlays } from '../src/update-overlay.ts'

const native = vi.hoisted(() => ({ create: vi.fn<(options: BrowserWindowConstructorOptions) => object>() }))
vi.mock('electron', () => ({ BrowserWindow: function (options: object) { return native.create(options) } }))

afterEach(() => { vi.restoreAllMocks() })

function visibilityFixture(visible = true) {
  const visibility = { visible }
  const parent: ParentFixture & Pick<BrowserWindow, 'isVisible'> = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) }),
    isDestroyed: (): boolean => false,
    isVisible: () => visibility.visible,
  })
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
    setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => window.destroyed,
  })
  native.create.mockReturnValue(window)
  new DesktopUpdateOverlays().create(parent as BrowserWindow, 'owned', 'Update required', false)
  return { parent, window, visibility }
}

it('restores a ready overlay each time its parent is shown and releases visibility ownership on close', async () => {
  const { parent, window, visibility } = visibilityFixture()
  window.emit('ready-to-show')
  expect(window.show).toHaveBeenCalledOnce()
  for (let index = 0; index < 2; index++) {
    visibility.visible = false
    parent.emit('hide')
    visibility.visible = true
    parent.emit('show')
    await Promise.resolve()
  }
  expect(window.show).toHaveBeenCalledTimes(3)
  await Promise.resolve()
  expect(parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
  window.destroyed = true
  window.emit('closed')
  expect(parent.listenerCount('show')).toBe(0)
  expect(parent.webContents.insertCSS).not.toHaveBeenCalled()
  expect(parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
  parent.emit('show')
  expect(window.show).toHaveBeenCalledTimes(3)
})

it('waits for both a visible parent and a ready document, in either order', async () => {
  for (const readyFirst of [true, false]) {
    const { parent, window, visibility } = visibilityFixture(false)
    if (readyFirst) window.emit('ready-to-show')
    else { visibility.visible = true; parent.emit('show') }
    expect(window.show).not.toHaveBeenCalled()
    if (readyFirst) { visibility.visible = true; parent.emit('show') }
    else window.emit('ready-to-show')
    await Promise.resolve()
    expect(window.show).toHaveBeenCalledOnce()
    window.destroyed = true
    window.emit('closed')
  }
})

it('does not show or change parent styles when closed before its document is ready', async () => {
  const { parent, window, visibility } = visibilityFixture(false)
  window.destroyed = true
  window.emit('closed')
  window.emit('ready-to-show')
  visibility.visible = true
  parent.emit('show')
  await Promise.resolve()
  expect(window.show).not.toHaveBeenCalled()
  expect(parent.listenerCount('show')).toBe(0)
  expect(parent.webContents.insertCSS).not.toHaveBeenCalled()
  expect(parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
})

it('releases a macOS overlay after its parent has already been destroyed', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const { parent, window } = visibilityFixture()
  await Promise.resolve()
  vi.spyOn(parent, 'isDestroyed').mockReturnValue(true)
  Object.defineProperty(parent, 'webContents', { get() { throw new Error('Object has been destroyed') } })
  window.destroyed = true
  expect(() => window.emit('closed')).not.toThrow()
  for (const event of ['focus', 'move', 'resize', 'show']) expect(parent.listenerCount(event)).toBe(0)
})

type ParentFixture = EventEmitter & Pick<BrowserWindow, 'getContentBounds' | 'isDestroyed'> & {
  webContents: EventEmitter & Pick<WebContents, 'insertCSS' | 'removeInsertedCSS'>
}

it('keeps the macOS mandatory overlay stationary and blocks parent keyboard input until close', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const parent: ParentFixture = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) }),
    isDestroyed: () => false,
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
    setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => false,
  })
  native.create.mockReturnValue(window)
  try {
    new DesktopUpdateOverlays().create(parent as BrowserWindow, 'owned', 'Update required', false)
    expect(native.create).toHaveBeenLastCalledWith(expect.objectContaining({ modal: false, transparent: true, frame: false }))
    const event = { preventDefault: vi.fn() }
    parent.webContents.emit('before-input-event', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    window.emit('closed')
    expect(parent.listenerCount('focus')).toBe(0)
    expect(parent.webContents.listenerCount('before-input-event')).toBe(0)
  } finally { platform.mockRestore() }
})

it('blocks each parent until its last owned overlay closes and invalidates each transition', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  onTestFinished(() => { platform.mockRestore() })
  const parent = (): ParentFixture => Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) }),
    isDestroyed: () => false,
  })
  const firstParent = parent() as BrowserWindow
  const secondParent = parent() as BrowserWindow
  const overlays = new DesktopUpdateOverlays()
  const isolated = new DesktopUpdateOverlays()
  native.create.mockImplementation(() => {
    const window = Object.assign(new EventEmitter(), {
      webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
      setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => false,
    })
    onTestFinished(() => { window.emit('closed') })
    return window
  })
  expect(overlays.input(firstParent)).toEqual({ revision: 0, blocked: false })
  const first = overlays.create(firstParent, 'owned', 'Update required', false)
  const second = overlays.create(firstParent, 'owned', 'Confirm installation', false)
  const other = overlays.create(secondParent, 'owned', 'Update required', false)
  expect(overlays.input(firstParent)).toMatchObject({ revision: 2, blocked: true })
  expect(overlays.input(secondParent)).toMatchObject({ revision: 1, blocked: true })
  expect(isolated.input(firstParent)).toEqual({ revision: 0, blocked: false })
  first.emit('closed')
  expect(overlays.input(firstParent)).toMatchObject({ revision: 3, blocked: true })
  expect(firstParent.webContents.listenerCount('before-input-event')).toBe(1)
  second.emit('closed')
  expect(overlays.input(firstParent)).toMatchObject({ revision: 4, blocked: false })
  expect(firstParent.listenerCount('move')).toBe(0)
  expect(firstParent.listenerCount('resize')).toBe(0)
  expect(firstParent.listenerCount('focus')).toBe(0)
  expect(firstParent.webContents.listenerCount('before-input-event')).toBe(0)
  expect(overlays.input(secondParent)).toMatchObject({ revision: 1, blocked: true })
  other.emit('closed')
  expect(overlays.input(secondParent)).toMatchObject({ revision: 2, blocked: false })
})
