import { MessageChannel } from 'node:worker_threads'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { installMandatoryUpdateOverlay } from '../src/preload-mandatory-overlay.ts'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { MandatoryUpdateView } from '../src/mandatory-update-window.ts'

const ipc = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), invoke: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
let dom: JSDOM
let channel: MessageChannel
afterEach(() => {
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  dom.window.close()
  channel?.port1.close()
  channel?.port2.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function setup() {
  dom = new JSDOM('<html><body><button>Product action</button><div data-windows-menu></div></body></html>', { url: 'dsh-app://app/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('MessageChannel', function createChannel() { channel = new MessageChannel(); return channel })
  vi.spyOn(dom.window.document, 'readyState', 'get').mockReturnValue('complete')
  const shadow = vi.spyOn(dom.window.HTMLElement.prototype, 'attachShadow')
  installMandatoryUpdateOverlay()
  const publish = ipc.on.mock.calls.find(([name]) => name === MANDATORY_IPC.state)![1] as
    (event: unknown, state: MandatoryUpdateView) => void
  const view: MandatoryUpdateView = { locale: resolveDesktopLocale('zh-CN'), policy: { blocking: true, checking: false },
    update: { phase: 'available', version: '2.0.0' }, deferred: false }
  publish({}, view)
  ipc.invoke.mockClear()
  const root = shadow.mock.results[0]!.value as ShadowRoot
  const frame = root.querySelector('iframe')!
  // JSDOM has no browsing context for a shadow-root iframe; transport uses real paired Node ports.
  const post = vi.spyOn(dom.window, 'postMessage').mockImplementation(() => {})
  Object.defineProperty(frame, 'contentWindow', { value: dom.window })
  const focus = vi.spyOn(frame, 'focus').mockImplementation(() => {})
  frame.dispatchEvent(new dom.window.Event('load'))
  expect(post).toHaveBeenCalledWith({ type: 'dsh-mandatory-connect' }, 'dsh-app://shell', [channel.port2])
  return { publish, view, root, frame, focus, host: root.host as HTMLElement }
}

it('uses an in-page frame below the caption and reuses it on updates', () => {
  const f = setup()
  expect(f.host.style.top).toBe('40px')
  expect(f.host.style.bottom).toBe('0px')
  expect(f.host.style.backdropFilter).toBe('')
  expect(f.frame.src).toBe('dsh-app://shell/mandatory-update.html')
  expect(dom.window.document.body.style.filter).toBe('')
  f.publish({}, { ...f.view, update: { phase: 'downloading', version: '2.0.0', percent: 30 } })
  expect(f.root.querySelector('iframe')).toBe(f.frame)
})

it('rejects forged window events and accepts actions only through the transferred private port', async () => {
  const f = setup()
  const data = { type: 'dsh-mandatory-action', id: 1, action: 'download', version: '2.0.0', revision: undefined }
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: f.frame.contentWindow, origin: 'dsh-app://shell', data }))
  expect(ipc.invoke).not.toHaveBeenCalled()
  const result = new Promise<unknown>(resolve => channel.port2.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'dsh-mandatory-result') resolve(message)
  }))
  channel.port2.postMessage(data)
  await expect(result).resolves.toEqual({ type: 'dsh-mandatory-result', id: 1, ok: true })
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(MANDATORY_IPC.action, 'download', '2.0.0', undefined)
})

it('keeps caption menu keyboard events available while blocking background shortcuts', () => {
  const f = setup()
  const host = dom.window.document.querySelector('[data-windows-menu]')!
  const shadow = host.attachShadow({ mode: 'open' })
  const button = dom.window.document.createElement('button')
  shadow.append(button)
  const received = vi.fn()
  button.addEventListener('keydown', received)
  for (const key of ['Enter', 'ArrowDown', 'ArrowRight']) {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
  expect(received).toHaveBeenCalledTimes(3)
  const background = new dom.window.KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })
  dom.window.document.body.dispatchEvent(background)
  expect(background.defaultPrevented).toBe(true)
  expect(f.focus).toHaveBeenCalled()
})

it('clears once without postponing removal on progress ticks, and closes the channel on navigation', () => {
  vi.useFakeTimers()
  const f = setup()
  const cleared = { ...f.view, policy: { blocking: false, checking: false } }
  f.publish({}, cleared)
  vi.advanceTimersByTime(100)
  f.publish({}, cleared)
  vi.advanceTimersByTime(50)
  expect(f.host.isConnected).toBe(false)
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  expect(ipc.off).toHaveBeenCalledWith(MANDATORY_IPC.state, expect.any(Function))
})
