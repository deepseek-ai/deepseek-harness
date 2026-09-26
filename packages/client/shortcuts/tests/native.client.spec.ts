// @vitest-environment jsdom
/** Trusted native inputs preserve current configuration, frame identity, and modal arbitration. */
import { afterEach, expect, it, vi } from 'vitest'
import { installNativeKeyboard } from '../src/client/native.ts'
import { ShortcutRegistry } from '../src/client/registry.ts'
import type { DesktopShortcutInput, ShortcutCommandId } from '../src/protocol.ts'

afterEach(() => { document.body.replaceChildren() })

it.each(['macos', 'windows'] as const)('prioritizes %s custom native bindings across editable and terminal regions and modals with revision checks', (platform) => {
  const registry = new ShortcutRegistry('desktop', platform)
  const run = vi.fn()
  registry.register({ id: 'session.new' as ShortcutCommandId, label: () => 'New', aliases: [],
    defaults: {
      'desktop:macos': { code: 'KeyN', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyN', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyN', modifiers: ['primary'] },
    }, regions: ['page', 'editable'], modals: [],
    resolve: () => ({ status: 'handled', run }) })
  registry.configure({ ...registry.config.getSnapshot(), revision: 'custom' as never,
    document: { schemaVersion: 1, profiles: { [`desktop:${platform}`]: { 'session.new': { code: 'KeyC', modifiers: ['primary'] } } } } })
  let deliver: (input: DesktopShortcutInput) => void = () => {}
  const reset = vi.fn()
  const off = installNativeKeyboard(window, { subscribe: (listener) => { deliver = listener; return () => {} }, closeWindow: vi.fn() },
    registry, () => registry.config.getSnapshot(), reset)
  const input: DesktopShortcutInput = { kind: 'keyboard', frameName: '', revision: registry.config.getSnapshot().revision,
    code: 'KeyC', control: platform === 'windows', alt: false, shift: false, meta: platform === 'macos', repeat: false }
  const target = document.createElement('textarea')
  const terminal = document.createElement('div')
  terminal.className = 'xterm'; terminal.append(target); document.body.append(terminal)
  target.focus()
  deliver(input)
  expect(run).toHaveBeenCalledTimes(1)
  expect(reset).toHaveBeenCalledTimes(1)
  deliver({ ...input, repeat: true })
  deliver({ ...input, revision: 'old' as typeof input.revision })
  expect(run).toHaveBeenCalledTimes(1)
  expect(reset).toHaveBeenCalledTimes(2)
  terminal.className = ''
  deliver(input)
  expect(run).toHaveBeenCalledTimes(2)
  terminal.setAttribute('role', 'dialog'); terminal.setAttribute('aria-modal', 'true')
  deliver(input)
  expect(run).toHaveBeenCalledTimes(3)
  terminal.remove()
  deliver(input)
  expect(run).toHaveBeenCalledTimes(4)
  off()
})

it('rejects old configuration and iframe identities, consumes repeats, and invokes unbound menu actions', () => {
  const registry = new ShortcutRegistry('desktop', 'macos')
  const run = vi.fn()
  const offCommand = registry.register({ id: 'page.close' as ShortcutCommandId, label: () => 'Close', aliases: [],
    defaults: {
      'desktop:macos': { code: 'KeyW', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyW', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyW', modifiers: ['primary'] },
    }, regions: ['page'], modals: [],
    resolve: () => ({ status: 'handled', run }) })
  let deliver: (input: DesktopShortcutInput) => void = () => {}
  const release = vi.fn()
  const off = installNativeKeyboard(window, {
    subscribe: (listener) => { deliver = listener; return release }, closeWindow: vi.fn() }, registry,
  () => registry.config.getSnapshot())
  const revision = registry.config.getSnapshot().revision
  const input = { kind: 'iframe' as const, revision, frameName: 'current', code: 'KeyW', meta: true,
    control: false, alt: false, shift: false, repeat: false }
  deliver(input)
  const frame = document.createElement('iframe')
  document.body.append(frame)
  frame.focus()
  deliver(input)
  expect(run).not.toHaveBeenCalled()
  frame.name = 'current'
  deliver(input)
  expect(run).not.toHaveBeenCalled()
  frame.setAttribute('data-html-preview', '')
  deliver({ ...input, revision: 'old' as typeof revision })
  deliver({ ...input, repeat: true })
  expect(run).not.toHaveBeenCalled()
  deliver(input)
  expect(run).toHaveBeenCalledTimes(1)
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  deliver(input)
  deliver({ kind: 'menu', revision, commandId: 'page.close' as ShortcutCommandId })
  expect(run).toHaveBeenCalledTimes(2)
  modal.remove()
  registry.configure({ ...registry.config.getSnapshot(), revision: 'unbound' as typeof revision,
    document: { schemaVersion: 1, profiles: { 'desktop:macos': { 'page.close': null } } } })
  deliver({ ...input, revision: 'unbound' as typeof revision })
  expect(run).toHaveBeenCalledTimes(2)
  deliver({ kind: 'menu', revision: 'unbound' as typeof revision, commandId: 'page.close' as ShortcutCommandId })
  expect(run).toHaveBeenCalledTimes(3)
  offCommand()
  deliver({ kind: 'menu', revision: 'unbound' as typeof revision, commandId: 'page.close' as ShortcutCommandId })
  expect(run).toHaveBeenCalledTimes(3)
  off()
  expect(release).toHaveBeenCalledTimes(1)
})

it.each(['macos', 'windows'] as const)('runs a custom %s chord across text fields and verified embedded pages, once per press', (platform) => {
  const registry = new ShortcutRegistry('desktop', platform)
  const run = vi.fn()
  registry.register({ id: 'session.new' as ShortcutCommandId, label: () => 'New', aliases: [], defaults: {},
    regions: ['page'], modals: [], resolve: () => ({ status: 'handled', run }) })
  registry.configure({ ...registry.config.getSnapshot(), revision: 'chord' as never,
    document: { schemaVersion: 2, profiles: { [`desktop:${platform}`]: { 'session.new': { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } } } } })
  let deliver: (input: DesktopShortcutInput) => void = () => {}
  const off = installNativeKeyboard(window, { subscribe: (listener) => { deliver = listener; return () => {} }, closeWindow: vi.fn() },
    registry, () => registry.config.getSnapshot())
  try {
    const field = document.createElement('textarea'); document.body.append(field); field.focus()
    const input: DesktopShortcutInput = { kind: 'keyboard', frameName: '', revision: registry.config.getSnapshot().revision,
      code: 'KeyA', secondCode: 'KeyB', control: false, alt: false, shift: false, meta: false, repeat: false }
    deliver(input); deliver({ ...input, repeat: true })
    expect(run).toHaveBeenCalledOnce()
    const frame = document.createElement('iframe'); frame.name = 'browser'; frame.setAttribute('data-sidebar-browser-frame', '')
    document.body.append(frame); frame.focus()
    deliver({ ...input, kind: 'iframe', frameName: 'browser' })
    expect(run).toHaveBeenCalledTimes(2)
    deliver({ ...input, kind: 'iframe', frameName: 'old' })
    expect(run).toHaveBeenCalledTimes(2)
  } finally { off() }
})

it('checks the focused browser guest lease before dispatch and retains its embedding context across shadow focus', () => {
  const registry = new ShortcutRegistry('desktop', 'macos')
  const run = vi.fn()
  const resolve = vi.fn(() => ({ status: 'handled' as const, run }))
  registry.register({ id: 'browser.new' as ShortcutCommandId, label: () => 'Browser', aliases: [],
    defaults: { 'desktop:macos': { code: 'KeyT', modifiers: ['primary'] } }, regions: ['page'], modals: [], resolve })
  let deliver: (input: DesktopShortcutInput) => void = () => {}
  const off = installNativeKeyboard(window, { subscribe: (listener) => { deliver = listener; return () => {} }, closeWindow: vi.fn() },
    registry, () => registry.config.getSnapshot())
  const input: DesktopShortcutInput = { kind: 'webview', frameName: 'guest', revision: registry.config.getSnapshot().revision,
    code: 'KeyT', control: false, alt: false, shift: false, meta: true, repeat: false }
  const frame = document.createElement('webview')
  frame.tabIndex = 0
  frame.setAttribute('name', 'guest')
  document.body.append(frame)
  frame.focus()
  const shadow = document.createElement('div').attachShadow({ mode: 'open' })
  Object.defineProperty(shadow, 'activeElement', { value: document.createElement('input') })
  const shadowRoot = vi.spyOn(frame, 'shadowRoot', 'get').mockReturnValue(shadow)
  try {
    deliver(input)
    expect(run).not.toHaveBeenCalled()
    frame.setAttribute('data-sidebar-browser-frame', 'webview')
    deliver({ ...input, frameName: '' })
    deliver({ ...input, frameName: 'old' })
    deliver({ ...input, revision: 'old' as typeof input.revision })
    expect(run).not.toHaveBeenCalled()
    deliver(input)
    expect(run).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ source: 'webview', target: frame }))
    deliver({ ...input, repeat: true })
    frame.remove()
    deliver(input)
    expect(run).toHaveBeenCalledOnce()
  } finally {
    shadowRoot.mockRestore()
    off()
  }
})
