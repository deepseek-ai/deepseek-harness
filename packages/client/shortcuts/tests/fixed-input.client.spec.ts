// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/dom'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { installKeyboard } from '../src/client/dom.ts'
import ShortcutsService from '../src/client/index.ts'
import { ShortcutRegistry } from '../src/client/registry.ts'
import type { ShortcutFixedCommand, ShortcutFixedInput } from '../src/client/types.ts'
import type { ShortcutCommandId } from '../src/protocol.ts'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear() })
const press = (target: EventTarget, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}
function mount() {
  const dispatch = vi.fn(() => ({ status: 'pass' as const }))
  const fixed = vi.fn<(input: ShortcutFixedInput) => void>()
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  dispose = installKeyboard(window, { dispatch, runtime: 'web', platform: 'windows' }, fixed)
  return { input, dispatch, fixed }
}

it('runs fixed handlers after local ownership and preserves their consumption for application dispatch', () => {
  const { input, dispatch, fixed } = mount()
  input.addEventListener('keydown', (event) => { event.preventDefault() }, { once: true })
  press(input)
  expect(fixed.mock.lastCall?.[0]).toMatchObject({ type: 'keydown', gesture: { defaultPrevented: true } })
  fixed.mockImplementation((event) => { if (event.type === 'keydown') event.consume() })
  expect(press(input).defaultPrevented).toBe(true)
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPrevented: true }), expect.anything(), expect.any(Function))
  fireEvent.compositionStart(input)
  press(input)
  expect(fixed.mock.lastCall?.[0]).toMatchObject({ type: 'keydown', gesture: { composing: true } })
  fireEvent.compositionEnd(input)
  press(input)
  expect(fixed.mock.lastCall?.[0]).toMatchObject({ type: 'keydown', gesture: { composing: true } })
})

it('resets sequences when local controls stop propagation, including two inputs in the same task', async () => {
  vi.useFakeTimers()
  const { input, fixed } = mount()
  input.addEventListener('keydown', (event) => { event.stopPropagation() }, { once: true })
  press(input)
  expect(fixed).not.toHaveBeenCalled()
  press(input)
  expect(fixed.mock.calls.map(([event]) => event.type)).toEqual(['reset', 'keydown'])
  input.addEventListener('keydown', (event) => { event.stopPropagation() }, { once: true })
  press(input)
  await vi.runOnlyPendingTimersAsync()
  expect(fixed).toHaveBeenLastCalledWith({ type: 'reset' })
})

it('resets on focus, pointer, blur, and modal transitions even when focus stays unchanged', async () => {
  const { input, fixed } = mount()
  fireEvent.focusIn(input); fireEvent.pointerDown(input); fireEvent.blur(window)
  expect(fixed.mock.calls.map(([event]) => event.type)).toEqual(['reset', 'reset', 'reset'])
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
  const wrapper = document.createElement('div'); wrapper.append(dialog); document.body.append(wrapper)
  await Promise.resolve()
  expect(fixed).toHaveBeenCalledTimes(4)
  dialog.setAttribute('aria-modal', 'false')
  await Promise.resolve()
  expect(fixed).toHaveBeenCalledTimes(5)
  dialog.setAttribute('aria-modal', 'true')
  press(input)
  expect(fixed.mock.calls.slice(-2).map(([event]) => event.type)).toEqual(['reset', 'keydown'])
  wrapper.remove()
  await Promise.resolve()
  expect(fixed).toHaveBeenLastCalledWith({ type: 'reset' })
  fixed.mockClear()
  document.body.append(document.createTextNode('stream'))
  await Promise.resolve()
  expect(fixed).not.toHaveBeenCalled()
})

it('releases listeners, modal observation, and pending local-input resets on disposal', async () => {
  vi.useFakeTimers()
  const { input, fixed } = mount()
  input.addEventListener('keydown', (event) => { event.stopPropagation() }, { once: true })
  press(input)
  dispose?.()
  fireEvent.focusIn(input); fireEvent.pointerDown(input); fireEvent.blur(window); press(input)
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
  document.body.append(dialog)
  await vi.runOnlyPendingTimersAsync()
  expect(fixed).not.toHaveBeenCalled()
})

it('publishes fixed reservations and removes them with their owning registration', () => {
  const registry = new ShortcutRegistry('web', 'windows')
  let label = 'Stop reply'
  const command: ShortcutFixedCommand = { id: 'response.stop' as ShortcutCommandId, label: () => label, keys: ['Esc', 'Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'application' }
  const off = registry.registerFixed(command)
  expect(registry.fixedCatalog.getSnapshot()).toEqual([{ id: 'response.stop', label, keys: ['Esc', 'Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'application' }])
  expect(registry.definitions()).toEqual([{ id: 'response.stop', defaults: {}, fixed: [{ code: 'Escape', modifiers: [] }] }])
  expect(() => registry.registerFixed(command)).toThrow('Duplicate')
  expect(() => registry.register({ ...command, aliases: [], defaults: {}, regions: [], modals: [], resolve: () => ({ status: 'pass' }) })).toThrow('Duplicate')
  label = '停止回复'; registry.refreshLabels()
  expect(registry.fixedCatalog.getSnapshot()[0]?.label).toBe(label)
  off(); off()
  expect(registry.fixedCatalog.getSnapshot()).toEqual([])
  expect(registry.definitions()).toEqual([])
})

it('contains observer failures and makes prior consumption visible to later observers', async () => {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const service = new ShortcutsService(ctx)
    const offFixed = service.registerFixed({ id: 'response.stop' as ShortcutCommandId, label: () => 'Stop', keys: ['Esc', 'Esc'], bindings: [{ code: 'Escape', modifiers: [] }], group: 'input' })
    expect(service.stopSequenceMs).toBe(500)
    expect(service.fixedCatalog.getSnapshot()).toHaveLength(1)
    service.observeFixedInput(() => { throw new Error('owner failure') })
    const off = service.observeFixedInput((event) => { if (event.type === 'keydown') event.consume() })
    const last = vi.fn<(input: ShortcutFixedInput) => void>()
    service.observeFixedInput(last)
    expect(press(document.body).defaultPrevented).toBe(true)
    expect(last.mock.lastCall?.[0]).toMatchObject({ gesture: { defaultPrevented: true } })
    expect(error).toHaveBeenCalled()
    off(); offFixed()
    expect(press(document.body).defaultPrevented).toBe(false)
    await ctx.fiber.dispose()
    last.mockClear(); press(document.body)
    expect(last).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})

it('delivers resets and skips an observer removed earlier in the same dispatch', async () => {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  try {
    const service = new ShortcutsService(ctx)
    let off = (): void => {}
    const first = vi.fn(() => { off() })
    service.observeFixedInput(first)
    const removed = vi.fn()
    off = service.observeFixedInput(removed)
    fireEvent.focusIn(document.body)
    expect(first).toHaveBeenLastCalledWith({ type: 'reset' })
    expect(removed).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})
