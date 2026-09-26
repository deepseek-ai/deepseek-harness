import { describe, expect, it } from 'vitest'
import { bindingIssue, editShortcutDocument, effectiveShortcuts, normalizeBinding, parseBinding, parseShortcutDefinitions,
  parseShortcutDocument, parseShortcutEdit } from '../src/protocol.ts'
import type { ShortcutCommandId, ShortcutDefinition, ShortcutDocument } from '../src/protocol.ts'

const id = (value: string) => value as ShortcutCommandId
it('reserves the macOS Web control-command combination', () => {
  expect(bindingIssue({ code: 'KeyB', modifiers: ['control', 'meta'] }, 'web', 'macos')).toBe('reserved')
})
const primary = (code: string) => ({ code, modifiers: ['primary'] as const })
const definitions: readonly ShortcutDefinition[] = [
  { id: id('test.one'), defaults: {
    'desktop:macos': primary('KeyB'),
    'desktop:windows': primary('KeyB'),
    'desktop:linux': primary('KeyB'),
  } },
  { id: id('test.two'), defaults: {
    'desktop:macos': primary('KeyJ'),
    'desktop:windows': primary('KeyJ'),
    'desktop:linux': primary('KeyJ'),
  } },
]

describe('preference document validation and conflict resolution', () => {
  it('distinguishes inherited, cleared, reset, and dormant preferences without touching other profiles', () => {
    const document: ShortcutDocument = { schemaVersion: 1, profiles: {
      'desktop:macos': { 'dormant.command': primary('KeyU'), 'test.one': null },
      'web:windows': { 'test.one': primary('Slash') },
    } }
    expect(parseShortcutDocument(JSON.stringify(document))).toEqual(document)
    expect(effectiveShortcuts(definitions, document, 'desktop', 'macos')[0]).toMatchObject({ modified: true, binding: null })
    const reset = editShortcutDocument(document, { type: 'reset', id: id('test.one') }, 'desktop', 'macos')
    expect(reset.profiles['desktop:macos']).toEqual({ 'dormant.command': primary('KeyU') })
    expect(effectiveShortcuts(definitions, reset, 'desktop', 'macos')[0]).toMatchObject({ modified: false, binding: { code: 'KeyB' } })
    expect(editShortcutDocument(document, { type: 'reset-all' }, 'desktop', 'macos').profiles)
      .toEqual({ 'desktop:macos': {}, 'web:windows': document.profiles['web:windows'] })
  })

  it.each(['{', 'null', '[]', '{"schemaVersion":0,"profiles":{}}', '{"schemaVersion":1,"profiles":{"alien":{}}}',
    '{"schemaVersion":1,"profiles":{"web:macos":{"bad":null}}}', '{"schemaVersion":1,"profiles":{},"extra":1}',
    '{"schemaVersion":1,"profiles":{"web:macos":{"test.one":{"code":"KeyB","modifiers":["bogus"]}}}}'])('retains invalid documents: %s', (raw) => {
    expect(parseShortcutDocument(raw)).toBe('invalid')
  })
  it('refuses future versions without interpreting their fields', () => {
    expect(parseShortcutDocument('{"schemaVersion":3,"profiles":17}')).toBe('future')
    expect(parseShortcutDocument(null)).toEqual({ schemaVersion: 1, profiles: {} })
    expect(() => parseBinding({ code: 'KeyB', modifiers: ['primary'], extra: true })).toThrow()
    expect(() => parseBinding({ code: 'Unknown', modifiers: [] })).toThrow()
  })

  it('lets explicit overrides displace new defaults, but disables both conflicting explicit overrides', () => {
    const document: ShortcutDocument = { schemaVersion: 1, profiles: { 'desktop:windows': { 'test.one': primary('KeyJ') } } }
    const rows = effectiveShortcuts(definitions, document, 'desktop', 'windows')
    expect(rows.map(row => row.conflicts)).toEqual([[], [id('test.one')]])
    const both = editShortcutDocument(document, { type: 'set', id: id('test.two'), binding: { code: 'KeyJ', modifiers: ['control'] } }, 'desktop', 'windows')
    expect(effectiveShortcuts([...definitions].reverse(), both, 'desktop', 'windows').map(row => row.conflicts))
      .toEqual([[id('test.one')], [id('test.two')]])
  })

  it('keeps Linux desktop and browser reservations', () => {
    const platform = 'linux'
    const check = (code: string, modifiers: readonly ('primary' | 'control' | 'alt' | 'shift' | 'meta')[], runtime: 'web' | 'desktop' = 'desktop') =>
      bindingIssue(normalizeBinding({ code, modifiers }, platform), runtime, platform)
    for (const code of ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'Tab', 'Escape', 'Space', 'Enter']) expect(check(code, ['primary'])).toBe('reserved')
    expect(check('KeyA', ['primary', 'shift'])).toBeNull()
    expect(check('KeyA', ['primary'])).toBe('reserved')
    expect(check('KeyJ', [])).toBe('modifier-required')
    expect(check('KeyJ', ['shift'])).toBe('modifier-required')
    expect(check('KeyJ', ['primary'])).toBeNull()
    for (const code of ['KeyN', 'KeyP', 'KeyW', 'KeyR', 'KeyO', 'KeyJ']) expect(check(code, ['primary'], 'web')).toBe('unsupported-browser')
    for (const code of ['Comma', 'Period']) expect(check(code, ['primary', 'shift'], 'web')).toBeNull()
    expect(check('Slash', ['primary'], 'web')).toBeNull()
    expect(check('F4', ['alt'], 'desktop')).toBe('reserved')
    expect(check('KeyL', ['meta', 'control'], 'desktop')).toBe('reserved')
  })

  it.each(['macos', 'windows'] as const)('accepts %s desktop editing and system combinations, and single keys', (platform) => {
    for (const [code, modifiers] of [
      ...['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyA', 'KeyQ', 'KeyH', 'Tab', 'Space'].map(code => [code, ['primary']] as const),
      ['KeyC', ['control']], ['KeyX', ['control']], ['KeyN', ['shift']], ['Tab', ['control']], ['Tab', ['shift']],
      ['Escape', ['alt']], ['F4', ['alt']], ['KeyL', ['meta']], ['Delete', ['control', 'alt']],
      ['KeyL', ['control', 'meta']], ['ArrowLeft', ['alt']],
    ] as const) expect(bindingIssue(normalizeBinding({ code, modifiers }, platform), 'desktop', platform)).toBeNull()
    expect(bindingIssue(normalizeBinding({ code: 'KeyC', modifiers: [] }, platform), 'desktop', platform)).toBeNull()
    expect(bindingIssue(normalizeBinding(primary('KeyC'), platform), 'web', platform)).toBe('reserved')
    let document: ShortcutDocument = { schemaVersion: 1, profiles: {} }
    for (const entry of definitions) document = editShortcutDocument(document, { type: 'set', id: entry.id, binding: primary('KeyC') }, 'desktop', platform)
    expect(effectiveShortcuts(definitions, document, 'desktop', platform).map(row => row.conflicts))
      .toEqual([[id('test.two')], [id('test.one')]])
  })

  it.each([
    ['web', 'macos'], ['web', 'windows'], ['desktop', 'macos'], ['desktop', 'windows'],
  ] as const)('accepts three and four distinct modifiers in %s on %s and still detects conflicts', (runtime, platform) => {
    for (const modifiers of [
      ['control', 'alt', 'shift'], ['control', 'alt', 'meta'], ['control', 'shift', 'meta'],
      ['alt', 'shift', 'meta'], ['control', 'alt', 'shift', 'meta'],
    ] as const) {
      for (const code of ['KeyN', 'KeyR', 'KeyX', 'Tab', 'F4']) {
        expect(bindingIssue(normalizeBinding({ code, modifiers }, platform), runtime, platform)).toBeNull()
      }
    }
    const binding = { code: 'KeyX', modifiers: ['primary', 'alt', 'shift'] as const }
    let document: ShortcutDocument = { schemaVersion: 1, profiles: {} }
    for (const entry of definitions) document = editShortcutDocument(document, { type: 'set', id: entry.id, binding }, runtime, platform)
    expect(effectiveShortcuts(definitions, document, runtime, platform).map(row => row.conflicts))
      .toEqual([[id('test.two')], [id('test.one')]])
    expect(bindingIssue(normalizeBinding({ code: 'KeyN', modifiers: [] }, platform), runtime, platform)).toBe(runtime === 'desktop' ? null : 'modifier-required')
  })

  it('counts expanded distinct modifiers and keeps Linux reservations', () => {
    expect(normalizeBinding({ code: 'KeyX', modifiers: ['primary', 'meta', 'shift'] }, 'macos').modifiers).toEqual(['shift', 'meta'])
    expect(bindingIssue(normalizeBinding({ code: 'KeyN', modifiers: ['primary', 'control', 'control'] }, 'windows'), 'web', 'windows')).toBe('unsupported-browser')
    expect(bindingIssue(normalizeBinding({ code: 'KeyN', modifiers: ['control', 'alt', 'shift'] }, 'linux'), 'web', 'linux')).toBe('unsupported-browser')
  })

  it('selects each owner-declared profile without inheriting or rewriting another profile', () => {
    const entry: ShortcutDefinition = { id: id('page.refresh'), defaults: {
      'desktop:macos': primary('KeyR'), 'desktop:windows': primary('KeyR'),
      'web:macos': { code: 'KeyP', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
    } }
    const document: ShortcutDocument = { schemaVersion: 1, profiles: {} }
    const effective = (runtime: 'desktop' | 'web', platform: 'macos' | 'windows' | 'linux', source = document) =>
      effectiveShortcuts([entry], source, runtime, platform)[0]?.binding
    expect(effective('desktop', 'macos')).toEqual({ code: 'KeyR', modifiers: ['meta'] })
    expect(effective('desktop', 'windows')).toEqual({ code: 'KeyR', modifiers: ['control'] })
    expect(effective('web', 'macos')).toEqual({ code: 'KeyP', modifiers: ['shift', 'meta'] })
    expect(effective('web', 'windows')).toEqual({ code: 'KeyJ', modifiers: ['control', 'alt'] })
    expect(effective('desktop', 'linux')).toBeNull()
    expect(effective('web', 'linux')).toBeNull()
    const override = editShortcutDocument(document, { type: 'set', id: entry.id, binding: null }, 'web', 'macos')
    expect(effective('web', 'macos', override)).toBeNull()
    const reset = editShortcutDocument(override, { type: 'reset', id: entry.id }, 'web', 'macos')
    expect(effective('web', 'macos', reset)).toEqual({ code: 'KeyP', modifiers: ['shift', 'meta'] })
    expect(() => parseShortcutDefinitions([entry])).not.toThrow()
    expect(() => parseShortcutDefinitions([entry, { ...entry, id: id('other.refresh') }])).toThrow('Conflicting')
  })

  it('keeps browser admission separate from per-profile default selection', () => {
    for (const platform of ['macos', 'windows'] as const) {
      const primary = platform === 'macos' ? 'meta' : 'control'
      for (const other of ['alt', 'shift'] as const) {
        expect(bindingIssue(normalizeBinding({ code: 'KeyX', modifiers: [primary, other] }, platform), 'web', platform)).toBeNull()
      }
    }
    expect(bindingIssue(normalizeBinding(primary('Backquote'), 'macos'), 'web', 'macos')).toBe('unsupported-browser')
    expect(bindingIssue(normalizeBinding({ code: 'KeyB', modifiers: ['alt'] }, 'macos'), 'web', 'macos')).toBe('reserved')
    expect(bindingIssue(normalizeBinding(primary('KeyN'), 'windows'), 'web', 'windows')).toBe('unsupported-browser')
  })

  it('validates IPC edits and active definitions rather than trusting renderer fields', () => {
    expect(parseShortcutDefinitions(definitions)).toEqual(definitions)
    expect(parseShortcutEdit({ type: 'set', id: 'test.one', binding: null })).toEqual({ type: 'set', id: 'test.one', binding: null })
    expect(parseShortcutEdit({ type: 'reset', id: 'test.one' }).type).toBe('reset')
    expect(parseShortcutEdit({ type: 'reset-all' }).type).toBe('reset-all')
    for (const value of [null, {}, { type: 'recover' }, { type: 'reset', id: '../x' }, { type: 'reset-all', path: '/tmp' }, { type: 'other', id: 'test.one' }]) expect(() => parseShortcutEdit(value)).toThrow()
    for (const value of [null, [{ ...definitions[0], defaults: {
      'desktop:macos': null,
      'desktop:windows': null,
      'desktop:linux': null,
    } }], [...definitions, definitions[0]],
    [{ ...definitions[0], defaults: { other: primary('KeyJ') } }], [{ ...definitions[0], defaults: {
      'web:macos': primary('KeyN'),
      'web:windows': primary('KeyN'),
      'web:linux': primary('KeyN'),
    } }],
    [{ ...definitions[0], defaults: {
      'desktop:macos': primary('KeyC'),
      'desktop:windows': primary('KeyC'),
      'desktop:linux': primary('KeyC'),
    } }]]) expect(() => parseShortcutDefinitions(value)).toThrow()
  })
})
