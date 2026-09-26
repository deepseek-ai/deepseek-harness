/** Physical shortcut chords share normalization, conflicts, and persistence rules. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { bindingIssue, bindingKey, effectiveShortcuts, normalizeBinding, parseBinding, parseShortcutDocument,
  parseShortcutDefinitions, presentBinding, ShortcutPersistence } from '../src/protocol.ts'
import type { ShortcutBinding, ShortcutCommandId, ShortcutDefinition } from '../src/protocol.ts'
import { ShortcutRegistry } from '../src/client/registry.ts'

const id = 'test.action' as ShortcutCommandId
const other = 'test.other' as ShortcutCommandId
const pair = { code: 'KeyA', secondCode: 'KeyB', modifiers: [] } as const
const definitions = [{ id, defaults: {} }, { id: other, defaults: {} }]

it.each(['macos', 'windows'] as const)('rejects overlapping %s defaults at registration and IPC ingress without disabling the active command', (platform) => {
  const modifier = platform === 'macos' ? 'meta' : 'control'
  for (const code of ['KeyA', 'KeyB']) {
    const single: ShortcutBinding = { code, modifiers: ['primary'] }
    const chord: ShortcutBinding = { ...pair, modifiers: [modifier] }
    for (const [first, second] of [[single, chord], [chord, single]] as const) {
      const catalog: ShortcutDefinition[] = [
        { id, defaults: { [`desktop:${platform}`]: first } },
        { id: other, defaults: { [`desktop:${platform}`]: second } },
      ]
      expect(() => parseShortcutDefinitions(catalog)).toThrow('Conflicting')
      const registry = new ShortcutRegistry('desktop', platform)
      const run = vi.fn()
      const register = (definition: ShortcutDefinition) => registry.register({ ...definition, label: () => definition.id,
        aliases: [], regions: ['page'], modals: [], resolve: () => ({ status: 'handled', run }) })
      register(catalog[0]!)
      const accepted = registry.catalog.getSnapshot()
      expect(() => register(catalog[1]!)).toThrow('Conflicting')
      expect(registry.catalog.getSnapshot()).toBe(accepted)
      expect(registry.dispatch({ ...first, meta: platform === 'macos', control: platform === 'windows',
        alt: false, shift: false, repeat: false, composing: false, defaultPrevented: false },
      { region: 'page', modal: null, target: null }, vi.fn()).status).toBe('handled')
      expect(run).toHaveBeenCalledOnce()
      expect(parseShortcutDefinitions([catalog[0], { id: other, defaults: { [`desktop:${platform}`]: {
        ...second, modifiers: [modifier, 'shift'],
      } } }])).toHaveLength(2)
    }
  }
})

it.each([['web', 'macos'], ['web', 'windows'], ['web', 'linux'], ['desktop', 'linux']] as const)(
  'rejects bare keys and chords in %s on %s', (runtime, platform) => {
    for (const binding of [pair, { code: 'KeyA', modifiers: [] }, { ...pair, modifiers: ['control', 'alt', 'shift', 'meta'] }] as const) {
      expect(bindingIssue(normalizeBinding(binding, platform), runtime, platform)).not.toBeNull()
    }
  })

it('canonicalizes unordered pairs, rejects invalid main keys, and omits unsupported ARIA accelerators', () => {
  const reversed = normalizeBinding({ ...pair, code: 'KeyB', secondCode: 'KeyA' }, 'macos')
  expect(reversed).toEqual(pair)
  expect(bindingKey(reversed)).toBe('KeyA+KeyB')
  expect(presentBinding(reversed, 'macos')).toEqual({ keys: ['A', 'B'], aria: undefined })
  expect(presentBinding(reversed, 'windows')).toEqual({ keys: ['A', 'B'], aria: undefined })
  expect(presentBinding({ ...reversed, modifiers: ['control', 'shift'] }, 'windows').keys)
    .toEqual(['Ctrl', '+', 'Shift', '+', 'A', 'B'])
  for (const input of [
    { ...pair, secondCode: 'KeyA' }, { ...pair, secondCode: 'ShiftLeft' }, { ...pair, thirdCode: 'KeyC' },
    { ...pair, secondCode: ['KeyB', 'KeyC'] }, { code: 'MetaLeft', modifiers: ['control'] }, { modifiers: ['meta'] },
  ]) expect(() => parseBinding(input)).toThrow()
})

it.each(['macos', 'windows'] as const)('migrates %s preferences on write and rejects both directions of single/chord conflicts', async (platform) => {
  let raw = JSON.stringify({ schemaVersion: 1, profiles: { 'web:macos': { 'dormant.web': null } } })
  const original = raw
  const store = new ShortcutPersistence({ read: () => raw, write: (next) => { raw = next } }, 'desktop', platform, false, () => {})
  onTestFinished(() => { store.dispose() })
  store.setDefinitions(definitions)
  let state = await store.readCurrent()
  expect(raw).toBe(original)
  const saved = await store.edit({ type: 'set', id, binding: pair }, state.revision)
  expect(saved.status).toBe('saved')
  expect(JSON.parse(raw)).toEqual({ schemaVersion: 2, profiles: { 'web:macos': { 'dormant.web': null }, [`desktop:${platform}`]: { [id]: pair } } })
  expect(parseShortcutDocument(raw)).toEqual(saved.snapshot.document)
  expect(parseShortcutDocument(raw.replace('"schemaVersion": 2', '"schemaVersion": 1'))).toBe('invalid')
  state = saved.snapshot
  for (const code of ['KeyA', 'KeyB']) {
    const rejected = await store.edit({ type: 'set', id: other, binding: { code, modifiers: [] } }, state.revision)
    expect(rejected).toMatchObject({ status: 'conflict', conflicts: [id] })
  }
  const cleared = await store.edit({ type: 'reset-all' }, state.revision)
  const single = await store.edit({ type: 'set', id, binding: { code: 'KeyB', modifiers: [] } }, cleared.snapshot.revision)
  expect((await store.edit({ type: 'set', id: other, binding: pair }, single.snapshot.revision)).status).toBe('conflict')
  const overlapping = { schemaVersion: 2 as const, profiles: { [`desktop:${platform}`]: { [id]: pair, [other]: { code: 'KeyA', modifiers: [] } } } }
  expect(effectiveShortcuts(definitions, overlapping, 'desktop', platform).map(row => row.conflicts)).toEqual([[other], [id]])
})

it.each(['macos', 'windows'] as const)('rejects direct %s writes that overlap fixed actions and disables previously saved conflicts', async (platform) => {
  const fixedId = 'menu.dismiss' as ShortcutCommandId
  const catalog = parseShortcutDefinitions([...definitions,
    { id: fixedId, defaults: {}, fixed: [{ code: 'Escape', modifiers: [] }] }])
  const storage = { read: () => null, write: vi.fn() }
  const store = new ShortcutPersistence(storage, 'desktop', platform, false, () => {})
  onTestFinished(() => { store.dispose() })
  store.setDefinitions(catalog)
  const state = await store.readCurrent()
  for (const binding of [{ code: 'Escape', modifiers: [] }, { code: 'KeyA', secondCode: 'Escape', modifiers: [] }] as const) {
    expect(await store.edit({ type: 'set', id, binding }, state.revision)).toMatchObject({ status: 'conflict', conflicts: [fixedId] })
    expect(effectiveShortcuts(catalog, { schemaVersion: 2, profiles: { [`desktop:${platform}`]: { [id]: binding } } },
      'desktop', platform).find(row => row.id === id)?.conflicts).toEqual([fixedId])
  }
  expect(storage.write).not.toHaveBeenCalled()
  expect((await store.edit({ type: 'set', id: fixedId, binding: null }, state.revision)).status).toBe('not-ready')
  expect((await store.edit({ type: 'set', id, binding: { code: 'Escape', modifiers: ['control', 'alt'] } }, state.revision)).status).toBe('saved')
  store.setDefinitions(definitions)
  expect((await store.edit({ type: 'set', id, binding: { code: 'Escape', modifiers: [] } }, (await store.readCurrent()).revision)).status).toBe('saved')
})

it('rejects malformed fixed reservations at catalog IPC ingress', () => {
  for (const fixed of [[], null, [null], [{ code: 'MetaLeft', modifiers: [] }], [{ code: 'Escape', modifiers: [], extra: true }]]) {
    expect(() => parseShortcutDefinitions([{ id, defaults: {}, fixed }])).toThrow()
  }
  expect(() => parseShortcutDefinitions([{ id, defaults: {
    'desktop:macos': pair,
    'desktop:windows': pair,
    'desktop:linux': pair,
  }, fixed: [{ code: 'Escape', modifiers: [] }] }])).toThrow()
})
