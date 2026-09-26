import { describe, expect, it, vi } from 'vitest'
import { ShortcutPersistence } from '../src/protocol.ts'
import type { ShortcutCommandId, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutEdit } from '../src/protocol.ts'

const one = 'test.one' as ShortcutCommandId
it('rejects an unsupported Web binding without writing preferences', async () => {
  const storage = { read: () => null, write: vi.fn() }
  const store = new ShortcutPersistence(storage, 'web', 'linux', false, () => {})
  store.setDefinitions([{ id: one, defaults: {} }])
  const snapshot = await store.readCurrent()
  expect(await store.edit({ type: 'set', id: one, binding: { code: 'KeyB', modifiers: ['control'] } }, snapshot.revision))
    .toMatchObject({ status: 'conflict', issue: 'unsupported-browser', conflicts: [] })
  expect(storage.write).not.toHaveBeenCalled()
})
const two = 'test.two' as ShortcutCommandId
const binding = { code: 'KeyJ', modifiers: ['primary'] as const }
const definitions: readonly ShortcutDefinition[] = [{ id: one, defaults: {
  'desktop:macos': { ...binding, code: 'KeyB' },
  'desktop:windows': { ...binding, code: 'KeyB' },
  'desktop:linux': { ...binding, code: 'KeyB' },
} },
{ id: two, defaults: {
  'desktop:macos': { ...binding, code: 'Comma' },
  'desktop:windows': { ...binding, code: 'Comma' },
  'desktop:linux': { ...binding, code: 'Comma' },
} }]
const edit: ShortcutEdit = { type: 'set', id: one, binding }

function fixture(reread = false) {
  let raw: string | null = null
  let state!: ShortcutConfigSnapshot
  const publish = vi.fn((snapshot: ShortcutConfigSnapshot) => { state = snapshot })
  const storage = { read: vi.fn(async () => raw),
    write: vi.fn(async (next: string) => { raw = next }) }
  const store = new ShortcutPersistence(storage, 'desktop', 'windows', reread, publish)
  store.setDefinitions(definitions)
  return { store, storage, publish, state: () => state, raw: () => raw, external: (value: string) => { raw = value } }
}

describe('serialized preference persistence', () => {
  it('publishes a save once and only after durable completion; rejects the competing old revision', async () => {
    const f = fixture()
    const initial = await f.store.readCurrent()
    let release!: () => void
    let started!: () => void
    const writing = new Promise<void>((resolve) => { started = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    f.storage.write.mockImplementationOnce(async () => { started(); await barrier })
    const first = f.store.edit(edit, initial.revision)
    const second = f.store.edit({ type: 'reset-all' }, initial.revision)
    await writing
    f.publish.mockClear()
    expect(f.state()).toBe(initial)
    release()
    expect((await first).status).toBe('saved')
    expect((await second).status).toBe('stale')
    expect(f.publish).toHaveBeenCalledOnce()
    expect(f.state().document.profiles['desktop:windows']?.[one]).toEqual(binding)
  })

  it('keeps the previous configuration and revision on write failure, allowing the same draft to retry', async () => {
    const f = fixture(); const initial = await f.store.readCurrent()
    f.storage.write.mockRejectedValueOnce(new Error('disk full'))
    expect((await f.store.edit(edit, initial.revision)).status).toBe('write-failed')
    expect(f.state()).toBe(initial)
    expect(f.raw()).toBeNull()
    expect((await f.store.edit(edit, initial.revision)).status).toBe('saved')
    const stored: unknown = JSON.parse(f.raw()!)
    expect(stored).toMatchObject({ profiles: { 'desktop:windows': { [one]: binding } } })
    const restarted = fixture(); restarted.external(f.raw()!)
    expect((await restarted.store.readCurrent()).document).toEqual(f.state().document)
  })

  it.each(['{broken', '{"schemaVersion":3,"profiles":{}}'])('retains accepted bindings and original bytes after reading %s', async (raw) => {
    const f = fixture(); await f.store.readCurrent(); await f.store.edit(edit, f.state().revision)
    const accepted = f.state().document
    f.external(raw)
    const bad = await f.store.readCurrent()
    expect(bad.status).toBe('unreadable'); expect(bad.document).toBe(accepted)
    for (const operation of [edit, { type: 'reset-all' }, { type: 'reset', id: one }] as ShortcutEdit[]) {
      expect((await f.store.edit(operation, bad.revision)).status).toBe('unreadable')
    }
    expect(f.raw()).toBe(raw)

  })

  it('uses defaults on the first bad read and prevents writes until the source becomes readable', async () => {
    const f = fixture(); f.storage.read.mockRejectedValueOnce(new Error('denied'))
    expect((await f.store.readCurrent()).usingDefaults).toBe(true)
    f.storage.read.mockRejectedValueOnce(new Error('still denied'))
    expect((await f.store.readCurrent()).error).toBe('read')
    expect((await f.store.edit({ type: 'reset-all' }, f.state().revision)).status).toBe('unreadable')
    expect(f.storage.write).not.toHaveBeenCalled()
    f.external('{'); expect((await f.store.readCurrent()).error).toBe('invalid')
    f.external('{"schemaVersion":1,"profiles":{}}'); expect((await f.store.readCurrent()).status).toBe('ready')
  })

  it('rereads before a browser write and requires an explicit review of external updates', async () => {
    const f = fixture(true); const initial = await f.store.readCurrent()
    f.external('{"schemaVersion":1,"profiles":{"web:macos":{"sleeping.command":null}}}')
    expect((await f.store.edit(edit, initial.revision)).status).toBe('stale')
    expect(f.storage.write).not.toHaveBeenCalled()
    expect((await f.store.edit(edit, f.state().revision)).status).toBe('saved')
    expect(f.state().document.profiles['web:macos']).toEqual({ 'sleeping.command': null })
  })

  it('accepts Windows single keys and editing combinations but rejects explicit/default conflicts', async () => {
    const f = fixture(); await f.store.readCurrent()
    expect((await f.store.edit({ ...edit, binding: { code: 'KeyC', modifiers: ['control'] } }, f.state().revision)).status).toBe('saved')
    expect((await f.store.edit({ ...edit, binding: { code: 'KeyC', modifiers: [] } }, f.state().revision)).status).toBe('saved')
    expect((await f.store.edit({ ...edit, binding: { ...binding, code: 'Comma' } }, f.state().revision)).status).toBe('conflict')
    await f.store.edit(edit, f.state().revision)
    expect((await f.store.edit({ ...edit, id: two }, f.state().revision)).conflicts).toEqual([one])
    expect((await f.store.edit({ type: 'set', id: two, binding: { ...binding, code: 'KeyB' } }, f.state().revision)).status).toBe('saved')
    expect((await f.store.edit({ type: 'reset', id: one }, f.state().revision)).status).toBe('conflict')
    expect((await f.store.edit({ type: 'reset-all' }, f.state().revision)).status).toBe('saved')
  })

  it('rejects early/unknown/stale-owner edits and does not publish a late read after disposal', async () => {
    const f = fixture()
    expect((await f.store.edit(edit, f.state().revision)).status).toBe('not-ready')
    await f.store.readCurrent()
    expect((await f.store.edit({ ...edit, id: 'missing.command' as ShortcutCommandId }, f.state().revision)).status).toBe('not-ready')
    f.store.setDefinitions(null)
    expect((await f.store.edit(edit, f.state().revision)).status).toBe('not-ready')
    f.store.dispose(); f.publish.mockClear(); f.external('{')
    await f.store.readCurrent()
    expect(f.publish).not.toHaveBeenCalled()
  })
})


it('continues transactions after a rejected unsupported code and contains subscriber failures', async () => {
  const f = fixture(); await f.store.readCurrent()
  await expect(f.store.edit({ ...edit, binding: { ...binding, code: 'Unidentified' } }, f.state().revision)).rejects.toThrow('Unsupported')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    f.publish.mockImplementationOnce(() => { throw new Error('subscriber failed') })
    const result = await f.store.edit(edit, f.state().revision)
    expect(result.status).toBe('saved')
    expect(error).toHaveBeenCalledWith('Shortcut configuration subscriber failed:', expect.any(Error))
    expect((await f.store.readCurrent()).document).toEqual(result.snapshot.document)
  } finally { error.mockRestore() }
})
