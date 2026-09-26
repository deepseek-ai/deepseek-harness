// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { webShortcutStorage, SHORTCUT_STORAGE_KEY } from '../src/client/storage.ts'
import type { ShortcutCommandId, ShortcutConfigSnapshot } from '../src/protocol.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })
const id = 'shortcuts.open' as ShortcutCommandId
const definitions = [{ id, defaults: {
  'web:macos': { code: 'Slash', modifiers: ['primary'] as const },
  'web:windows': { code: 'Slash', modifiers: ['primary'] as const },
  'web:linux': { code: 'Slash', modifiers: ['primary'] as const },
} }]

it('syncs same-origin updates, rejects stale drafts, and releases the storage listener', async () => {
  let latest!: ShortcutConfigSnapshot
  const publish = vi.fn((value: ShortcutConfigSnapshot) => { latest = value })
  const adapter = webShortcutStorage(window, 'macos', publish)
  try {
    const initial = await adapter.get(definitions)
    adapter.subscribe(publish)(); await adapter.recording(true)
    publish.mockClear()
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: { 'web:macos': { [id]: null } } }))
    window.dispatchEvent(new StorageEvent('storage', { key: SHORTCUT_STORAGE_KEY }))
    await vi.waitFor(() => { expect(latest.document.profiles['web:macos']?.[id]).toBeNull() })
    expect((await adapter.edit({ type: 'reset', id }, initial.revision)).status).toBe('stale')
    expect((await adapter.edit({ type: 'reset', id }, latest.revision)).status).toBe('saved')
    const stored: unknown = JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY)!)
    expect(stored).toMatchObject({ profiles: { 'web:macos': {} } })
    adapter.dispose(); publish.mockClear()
    localStorage.removeItem(SHORTCUT_STORAGE_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
  } finally { adapter.dispose() }
})

it('retains drafts after quota failure and refuses to replace future data', async () => {
  let latest!: ShortcutConfigSnapshot
  const adapter = webShortcutStorage(window, 'windows', (value) => { latest = value })
  try {
    await adapter.get(definitions)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    expect((await adapter.edit({ type: 'set', id, binding: null }, latest.revision)).status).toBe('write-failed')
    expect(localStorage.getItem(SHORTCUT_STORAGE_KEY)).toBeNull()
    write.mockRestore()
    const raw = '{"schemaVersion":9}'
    localStorage.setItem(SHORTCUT_STORAGE_KEY, raw)
    await adapter.get(definitions)
    expect((await adapter.edit({ type: 'reset-all' }, latest.revision)).status).toBe('unreadable')
    expect(localStorage.getItem(SHORTCUT_STORAGE_KEY)).toBe(raw)

  } finally { adapter.dispose() }
})
