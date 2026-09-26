import { describe, expect, it, vi } from 'vitest'
import { bindingKey, initialShortcutConfig, normalizeBinding, presentBinding } from '../src/protocol.ts'
import type { ShortcutCommandId } from '../src/protocol.ts'
import { ShortcutRegistry } from '../src/client/registry.ts'
import { isWebBindingAllowed } from '../src/binding.ts'
import type { ShortcutCommand, ShortcutGesture } from '../src/client/types.ts'

const context = { region: 'page', modal: null, target: null } as const
it('admits modified Web combinations and refuses two-key chords', () => {
  expect(isWebBindingAllowed({ code: 'KeyB', modifiers: ['control', 'alt', 'shift'] }, 'windows')).toBe(true)
  expect(isWebBindingAllowed({ code: 'KeyB', secondCode: 'KeyJ', modifiers: [] }, 'macos')).toBe(false)
})

it('leaves Linux terminal control-W and control-R with the terminal while dispatching other bindings', () => {
  for (const [code, modifiers, status] of [
    ['KeyW', ['control'], 'pass'], ['KeyR', ['control'], 'pass'], ['KeyB', ['control'], 'handled'],
    ['KeyB', ['alt'], 'handled'],
    ['KeyB', ['control', 'alt'], 'handled'], ['KeyB', ['control', 'shift'], 'handled'],
  ] as const) {
    const registry = new ShortcutRegistry('desktop', 'linux')
    const run = vi.fn(), consume = vi.fn()
    registry.register(command({ defaults: { 'desktop:linux': { code, modifiers } }, regions: ['terminal'],
      resolve: () => ({ status: 'handled', run }) }))
    expect(registry.dispatch({ ...gesture, code, control: modifiers.some(value => value === 'control'),
      meta: false, alt: modifiers.some(value => value === 'alt'),
      shift: modifiers.some(value => value === 'shift') }, { ...context, region: 'terminal' }, consume).status).toBe(status)
    expect(run).toHaveBeenCalledTimes(status === 'handled' ? 1 : 0)
    expect(consume).toHaveBeenCalledTimes(status === 'handled' ? 1 : 0)
  }
})

it('dispatches a Windows Web terminal binding with Control, Meta, and Shift', () => {
  const registry = new ShortcutRegistry('web', 'windows')
  const run = vi.fn(), consume = vi.fn()
  registry.register(command({ defaults: { 'web:windows': { code: 'KeyB', modifiers: ['control', 'meta', 'shift'] } },
    regions: ['terminal'], resolve: () => ({ status: 'handled', run }) }))
  expect(registry.dispatch({ ...gesture, control: true, shift: true }, { ...context, region: 'terminal' }, consume).status).toBe('handled')
  expect(run).toHaveBeenCalledOnce()
  expect(consume).toHaveBeenCalledOnce()
})

it.each(['pass', 'blocked'] as const)('does not execute a menu command whose owner returns %s', (status) => {
  const registry = new ShortcutRegistry('desktop', 'macos')
  const resolve = vi.fn<ShortcutCommand['resolve']>(() => status === 'pass' ? { status } : { status, reason: 'unavailable' })
  registry.register(command({ resolve }))
  registry.invoke('test.toggle' as ShortcutCommandId, context)
  expect(resolve).toHaveBeenCalledWith({ ...context, source: 'menu' })
})
const gesture: ShortcutGesture = { code: 'KeyB', control: false, alt: false, shift: false, meta: true,
  repeat: false, composing: false, defaultPrevented: false }
function command(overrides: Partial<ShortcutCommand> = {}): ShortcutCommand {
  return { id: 'test.toggle' as ShortcutCommandId, label: () => 'Toggle', aliases: ['toggle'],
    defaults: {
      'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyB', modifiers: ['primary'] },
    }, regions: ['page', 'editable'], modals: [],
    resolve: () => ({ status: 'handled', run: () => {} }), ...overrides }
}

describe('physical key registry', () => {
  it('normalizes primary/control together on Windows and presents platform-specific keys', () => {
    const binding = { code: 'KeyB', modifiers: ['primary', 'control', 'shift'] as const }
    expect(bindingKey(normalizeBinding(binding, 'windows'))).toBe('control+shift+KeyB')
    expect(presentBinding(normalizeBinding(binding, 'macos'), 'macos')).toEqual({ keys: ['⌃', '⇧', '⌘', 'B'], aria: 'Control+Shift+Meta+B' })
    expect(presentBinding(normalizeBinding({ code: 'Slash', modifiers: ['primary'] }, 'windows'), 'windows'))
      .toEqual({ keys: ['Ctrl', '+', '/'], aria: 'Control+/' })
    expect(presentBinding(null, 'linux')).toEqual({ keys: [], aria: undefined })
    expect(() => normalizeBinding({ code: 'Unidentified', modifiers: [] }, 'macos')).toThrow('Unsupported')
  })

  it('rejects duplicate ids, cross-platform default conflicts, and unverified Web combinations atomically', () => {
    const registry = new ShortcutRegistry('desktop', 'macos')
    const off = registry.register(command())
    expect(() => registry.register(command())).toThrow('Duplicate')
    expect(() => registry.register(command({ id: 'other.toggle' as ShortcutCommandId,
      defaults: {
        'desktop:macos': { code: 'KeyB', modifiers: ['control'] },
        'desktop:windows': { code: 'KeyB', modifiers: ['control'] },
        'desktop:linux': { code: 'KeyB', modifiers: ['control'] },
      } }))).toThrow('windows')
    expect(() => registry.register(command({ id: 'web.new' as ShortcutCommandId,
      defaults: {
        'web:macos': { code: 'KeyN', modifiers: ['primary'] },
        'web:windows': { code: 'KeyN', modifiers: ['primary'] },
        'web:linux': { code: 'KeyN', modifiers: ['primary'] },
      } }))).toThrow('Unsupported Web')
    expect(() => registry.register(command({ id: 'system.copy' as ShortcutCommandId,
      defaults: {
        'desktop:macos': { code: 'KeyC', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyC', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyC', modifiers: ['primary'] },
      } }))).toThrow('Reserved')
    expect(registry.catalog.getSnapshot()).toHaveLength(1)
    const changed = vi.fn()
    registry.catalog.subscribe(changed)
    off(); off()
    expect(changed).toHaveBeenCalledOnce()
    expect(registry.catalog.getSnapshot()).toEqual([])
    expect(registry.dispatch(gesture, context, vi.fn())).toEqual({ status: 'pass' })
  })

  it('consumes before executing, ignores repeats, and matches every modifier exactly', () => {
    const registry = new ShortcutRegistry('desktop', 'macos')
    const consumed = vi.fn()
    const run = vi.fn(() => { expect(consumed).toHaveBeenCalled() })
    registry.register(command({ resolve: () => ({ status: 'handled', run }) }))
    expect(registry.dispatch(gesture, context, consumed).status).toBe('handled')
    expect(registry.dispatch({ ...gesture, repeat: true }, context, consumed).status).toBe('handled')
    expect(run).toHaveBeenCalledOnce()
    expect(consumed).toHaveBeenCalledTimes(2)
    const passed = [{ shift: true }, { alt: true }, { control: true }, { meta: false }, { composing: true }, { defaultPrevented: true }]
    for (const extra of passed) {
      expect(registry.dispatch({ ...gesture, ...extra }, context, consumed).status).toBe('pass')
    }
    expect(consumed).toHaveBeenCalledTimes(2)
  })

  it('prioritizes desktop bindings in terminals and modals while retaining owner refusal reasons', () => {
    const registry = new ShortcutRegistry('desktop', 'macos')
    const consumed = vi.fn()
    const resolve = vi.fn<ShortcutCommand['resolve']>(() => ({ status: 'blocked', reason: 'No target' }))
    registry.register(command({ resolve }))
    expect(registry.dispatch(gesture, { ...context, modal: 'settings' }, consumed)).toMatchObject({ status: 'blocked', reason: 'No target' })
    expect(resolve).toHaveBeenCalledOnce()
    expect(registry.dispatch(gesture, { region: 'terminal', modal: null, target: null }, consumed).status).toBe('blocked')
    expect(registry.dispatch(gesture, context, consumed)).toMatchObject({ status: 'blocked', reason: 'No target' })
    resolve.mockReturnValue({ status: 'pass' })
    expect(registry.dispatch(gesture, context, consumed).status).toBe('pass')
    expect(consumed).toHaveBeenCalledTimes(3)
  })

  it('publishes stable effective rows with Windows Web three-key defaults', () => {
    const registry = new ShortcutRegistry('web', 'windows')
    let label = 'Settings'
    registry.register(command({ label: () => label, defaults: { 'web:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] } } }))
    const first = registry.catalog.getSnapshot()
    expect(registry.catalog.getSnapshot()).toBe(first)
    expect(first[0]?.keys).toEqual(['Ctrl', '+', 'Alt', '+', 'B'])
    label = '设置'
    registry.refreshLabels()
    expect(registry.catalog.getSnapshot()[0]?.label).toBe('设置')
    expect(registry.dispatch({ ...gesture, control: true, meta: false }, context, vi.fn()).status).toBe('pass')
  })
})

it.each(['Space', 'Escape', 'ArrowUp'])('uses standard ARIA names for %s', (code) => {
  expect(presentBinding(normalizeBinding({ code, modifiers: [] }, 'windows'), 'windows').aria).toBe(code)
})


it('keeps commands disabled during startup and publishes config/catalog together before dispatch changes', () => {
  const config = initialShortcutConfig()
  const registry = new ShortcutRegistry('desktop', 'macos', config)
  const run = vi.fn()
  registry.register(command({ resolve: () => ({ status: 'handled', run }) }))
  expect(registry.dispatch(gesture, context, vi.fn()).status).toBe('pass')
  const snapshot = { ...config, status: 'ready' as const, document: { schemaVersion: 1 as const,
    profiles: { 'desktop:macos': { 'test.toggle': { code: 'KeyJ', modifiers: ['primary'] as const } } } } }
  registry.catalog.subscribe(() => {
    expect(registry.config.getSnapshot()).toBe(snapshot)
    expect(registry.catalog.getSnapshot()[0]?.keys).toEqual(['⌘', 'J'])
  })
  registry.configure(snapshot)
  expect(registry.dispatch(gesture, context, vi.fn()).status).toBe('pass')
  expect(registry.dispatch({ ...gesture, code: 'KeyJ' }, context, vi.fn()).status).toBe('handled')
  expect(run).toHaveBeenCalledOnce()
})

it('blocks conflicting dormant overrides when their plugins return, then releases every row on unload', () => {
  const registry = new ShortcutRegistry('desktop', 'macos')
  registry.configure({ ...initialShortcutConfig(), status: 'ready', document: { schemaVersion: 1,
    profiles: { 'desktop:macos': { 'test.toggle': { code: 'KeyJ', modifiers: ['primary'] }, 'other.toggle': { code: 'KeyJ', modifiers: ['primary'] } } } } })
  const run = vi.fn()
  const off = registry.register(command({ resolve: () => ({ status: 'handled', run }) }))
  expect(registry.dispatch({ ...gesture, code: 'KeyJ' }, context, vi.fn()).status).toBe('handled')
  const other = registry.register(command({ id: 'other.toggle' as ShortcutCommandId, defaults: {}, resolve: () => ({ status: 'handled', run }) }))
  const consumed = vi.fn()
  expect(registry.dispatch({ ...gesture, code: 'KeyJ' }, context, consumed).status).toBe('blocked')
  expect(consumed).toHaveBeenCalledOnce()
  expect(run).toHaveBeenCalledOnce()
  other(); off()
  expect(registry.catalog.getSnapshot()).toEqual([])
  expect(registry.dispatch({ ...gesture, code: 'KeyJ' }, context, vi.fn()).status).toBe('pass')
})

it.each(['macos', 'windows'] as const)('keeps %s priority identical before saving, after saving the same default, and after resetting', (platform) => {
  const registry = new ShortcutRegistry('desktop', platform)
  const run = vi.fn()
  registry.register(command({ regions: ['page'], modals: [], resolve: () => ({ status: 'handled', run }) }))
  for (const [index, modified] of [false, true, false].entries()) {
    registry.configure({ ...registry.config.getSnapshot(), revision: `revision-${index}` as never,
      document: { schemaVersion: 2, profiles: modified ? {
        [`desktop:${platform}`]: { 'test.toggle': { code: 'KeyB', modifiers: ['primary'] } },
      } : {} } })
    expect(registry.catalog.getSnapshot()[0]?.modified).toBe(modified)
    const input = { ...gesture, meta: platform === 'macos', control: platform === 'windows' }
    for (const region of ['page', 'editable', 'terminal'] as const) {
      for (const modal of [null, 'settings']) {
        expect(registry.dispatch(input, { region, modal, target: null }, vi.fn()).status).toBe('handled')
      }
    }
  }
  expect(run).toHaveBeenCalledTimes(18)
})
