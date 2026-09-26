// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/dom'
import { installKeyboard, detectEnvironment } from '../src/client/dom.ts'
import { ShortcutRegistry } from '../src/client/registry.ts'
import type { ShortcutFixedInput } from '../src/client/types.ts'
import type { ShortcutCommandId } from '../src/protocol.ts'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks() })

function mount(runtime: 'desktop' | 'web' = 'web', platform: 'macos' | 'windows' = 'windows') {
  const registry = new ShortcutRegistry(runtime, platform)
  const run = vi.fn()
  registry.register({ id: 'shortcuts.open' as ShortcutCommandId, label: () => 'Shortcuts', aliases: [],
    defaults: {
      'desktop:macos': { code: 'Slash', modifiers: ['primary'] },
      'desktop:windows': { code: 'Slash', modifiers: ['primary'] },
      'desktop:linux': { code: 'Slash', modifiers: ['primary'] },
      'web:macos': { code: 'Slash', modifiers: ['primary'] },
      'web:windows': { code: 'Slash', modifiers: ['primary'] },
      'web:linux': { code: 'Slash', modifiers: ['primary'] },
    },
    regions: ['page', 'editable'], modals: ['shortcuts'], resolve: () => ({ status: 'handled', run }) })
  dispose = installKeyboard(window, registry)
  const input = document.createElement('input'); document.body.append(input); input.focus()
  return { registry, input, run }
}
const press = (target: EventTarget, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}

it.each(['macos', 'windows'] as const)('leaves configurable %s shortcuts to native input while retaining DOM fixed-action observation', (platform) => {
  const { registry, input, run } = mount('desktop', platform)
  dispose?.()
  const fixed = vi.fn<(input: ShortcutFixedInput) => void>()
  dispose = installKeyboard(window, registry, fixed, true)
  expect(press(input, { ctrlKey: platform === 'windows', metaKey: platform === 'macos' }).defaultPrevented).toBe(false)
  registry.configure({ ...registry.config.getSnapshot(), revision: 'pair' as never,
    document: { schemaVersion: 2, profiles: { [`desktop:${platform}`]: {
      'shortcuts.open': { code: 'KeyF', secondCode: 'KeyG', modifiers: [] },
    } } } })
  press(input, { code: 'KeyF', key: 'f', ctrlKey: false })
  press(input, { code: 'KeyG', key: 'g', ctrlKey: false })
  expect(run).not.toHaveBeenCalled()
  expect(fixed.mock.lastCall?.[0]).toMatchObject({ type: 'keydown', gesture: { code: 'KeyG' } })
})

const optionCommandN = { key: 'Dead', code: 'KeyN', ctrlKey: false, altKey: true, metaKey: true } as const
const commandSlash = { ctrlKey: false, metaKey: true } as const
function mountMacNewSession() {
  const fixture = mount('web', 'macos')
  const newSession = vi.fn()
  const unregister = fixture.registry.register({ id: 'session.new' as ShortcutCommandId, label: () => 'New session', aliases: [],
    defaults: {
      'desktop:macos': { code: 'KeyN', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyN', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyN', modifiers: ['primary'] },
      'web:macos': { code: 'KeyN', modifiers: ['primary', 'alt'] },
    }, regions: ['page', 'editable'], modals: [],
    resolve: () => ({ status: 'handled', run: newSession }) })
  return { ...fixture, newSession, unregister }
}

it('consumes bound macOS Web Option+Command+N without leaving dead-key state on repeats or subsequent commands', () => {
  const { input, newSession, run } = mountMacNewSession()
  expect(press(input, optionCommandN).defaultPrevented).toBe(true)
  expect(press(input, { ...optionCommandN, repeat: true }).defaultPrevented).toBe(true)
  expect(newSession).toHaveBeenCalledOnce()
  expect(press(input, commandSlash).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledOnce()
  expect(press(input, optionCommandN).defaultPrevented).toBe(true)
  expect(newSession).toHaveBeenCalledTimes(2)
})

it('preserves an unbound Dead key and the following input', () => {
  const { input, unregister, newSession, run } = mountMacNewSession()
  unregister()
  expect(press(input, optionCommandN).defaultPrevented).toBe(false)
  expect(press(input, commandSlash).defaultPrevented).toBe(false)
  expect(press(input, commandSlash).defaultPrevented).toBe(true)
  expect(newSession).not.toHaveBeenCalled()
  expect(run).toHaveBeenCalledOnce()
})

it('keeps real composition, composition-ending input, legacy IME, AltGraph and accent input guarded for Option+Command+N', () => {
  const { input, newSession } = mountMacNewSession()
  fireEvent.compositionStart(input)
  expect(press(input, optionCommandN).defaultPrevented).toBe(false)
  fireEvent.compositionEnd(input)
  expect(press(input, optionCommandN).defaultPrevented).toBe(false)
  for (const extra of [
    { isComposing: true },
    { keyCode: 229 },
    { metaKey: false }, { code: 'KeyE' }, { ctrlKey: true }, { shiftKey: true },
  ]) {
    fireEvent.blur(window)
    expect(press(input, { ...optionCommandN, ...extra }).defaultPrevented).toBe(false)
  }
  fireEvent.blur(window)
  const altGraph = new KeyboardEvent('keydown', { ...optionCommandN, bubbles: true, cancelable: true })
  vi.spyOn(altGraph, 'getModifierState').mockReturnValue(true)
  input.dispatchEvent(altGraph)
  expect(altGraph.defaultPrevented).toBe(false)
  fireEvent.blur(window)
  expect(press(input, { ...optionCommandN, metaKey: false }).defaultPrevented).toBe(false)
  expect(press(input, optionCommandN).defaultPrevented).toBe(false)
  expect(newSession).not.toHaveBeenCalled()
})

it.each([['desktop', 'macos'], ['web', 'windows']] as const)('keeps Dead key protection in %s on %s', (runtime, platform) => {
  const { input, run } = mount(runtime, platform)
  const keys = { metaKey: platform === 'macos', ctrlKey: platform === 'windows' }
  expect(press(input, { ...keys, key: 'Dead' }).defaultPrevented).toBe(false)
  expect(press(input, keys).defaultPrevented).toBe(false)
  expect(run).not.toHaveBeenCalled()
  expect(press(input, keys).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledOnce()
})

it('detects the client OS and separates Web from the preload marker', () => {
  expect(detectEnvironment(document, { platform: 'MacIntel' } as Navigator)).toEqual({ runtime: 'web', platform: 'macos' })
  expect(detectEnvironment(document, { platform: 'Win32' } as Navigator)).toEqual({ runtime: 'web', platform: 'windows' })
  const html = document.documentElement
  const previous = html.dataset.platform
  try {
    html.dataset.platform = 'linux'
    expect(detectEnvironment(document, navigator)).toEqual({ runtime: 'desktop', platform: 'linux' })
  } finally {
    if (previous === undefined) delete html.dataset.platform
    else html.dataset.platform = previous
  }
})

it('passes browser navigation/editing and local consumption; disposes the listener', () => {
  const { input, run } = mount()
  for (const key of ['N', 'P', 'O', 'R', 'W', 'C', 'V', 'Z']) expect(press(input, { code: `Key${key}` }).defaultPrevented).toBe(false)
  const local = (event: Event) => { event.preventDefault() }
  input.addEventListener('keydown', local)
  expect(press(input).defaultPrevented).toBe(true)
  expect(run).not.toHaveBeenCalled()
  input.removeEventListener('keydown', local)
  expect(press(input).defaultPrevented).toBe(true)
  expect(press(input, { repeat: true }).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledOnce()
  dispose?.()
  expect(press(input).defaultPrevented).toBe(false)
})

it('preserves composition, late closing keys, 229, AltGraph, and dead-key input', () => {
  const { input, run } = mount()
  fireEvent.compositionStart(input)
  expect(press(input).defaultPrevented).toBe(false)
  fireEvent.compositionEnd(input)
  expect(press(input).defaultPrevented).toBe(false)
  expect(press(input, { isComposing: true }).defaultPrevented).toBe(false)
  // oxlint-disable-next-line typescript/no-deprecated -- Exercise legacy IME input.
  expect(press(input, { keyCode: 229 }).defaultPrevented).toBe(false)
  expect(press(input, { key: 'Dead' }).defaultPrevented).toBe(false)
  const event = new KeyboardEvent('keydown', { code: 'Slash', ctrlKey: true, bubbles: true, cancelable: true })
  vi.spyOn(event, 'getModifierState').mockReturnValue(true)
  input.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(run).not.toHaveBeenCalled()
  fireEvent.keyUp(input)
  expect(press(input).defaultPrevented).toBe(true)
})

it('accepts a shortcut after the composition-closing key is released inside a local control', () => {
  const { input, run } = mount()
  fireEvent.compositionStart(input)
  fireEvent.compositionEnd(input)
  input.addEventListener('keyup', (event) => { event.stopPropagation() }, { once: true })
  fireEvent.keyUp(input, { key: 'Enter', code: 'Enter' })
  expect(press(input).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledOnce()
})

it('blocks background commands during dialogs and gives terminal input ownership', () => {
  const { input, run } = mount()
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
  document.body.append(dialog)
  expect(press(input).defaultPrevented).toBe(true)
  expect(run).not.toHaveBeenCalled()
  dialog.dataset.shortcutModal = 'shortcuts'
  expect(press(input).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledOnce()
  const terminal = document.createElement('div'); terminal.className = 'xterm'; terminal.append(input); document.body.append(terminal)
  expect(press(input).defaultPrevented).toBe(false)
  fireEvent.blur(window)
})

it('routes body focus and window-delivered input through the same application command', () => {
  const { input, run } = mount()
  input.remove()
  expect(press(document.body).defaultPrevented).toBe(true)
  expect(press(window).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledTimes(2)
})

it('passes the original input element to a feature target resolver', () => {
  const { registry, input } = mount()
  const dispatch = vi.spyOn(registry, 'dispatch')
  press(input)
  expect(dispatch).toHaveBeenLastCalledWith(expect.anything(), { region: 'editable', modal: null, target: input }, expect.any(Function))
  input.remove()
  press(window)
  expect(dispatch).toHaveBeenLastCalledWith(expect.anything(), { region: 'page', modal: null, target: document.body }, expect.any(Function))
})
