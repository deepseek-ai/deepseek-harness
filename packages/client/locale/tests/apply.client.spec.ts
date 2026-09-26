/** locale apply wiring: service + dictionaries provision, declaration-aware
 * Language row registration, snapshot projection into the row store, and
 * recovery after an HMR collapse of the declaring entry. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import {
  apply, inject, SETTINGS_NS,
} from '@deepseek-ai/dsh-client-locale/client'
import type { LanguageRowInjected, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '../src/locale-settings.ts'
import { LanguageRow } from '../src/client/LanguageRow.tsx'
import type { createLanguageRowStore } from '../src/client/settings-store.ts'

const SLOT = 'settings.general.item'
afterEach(() => { vi.unstubAllGlobals() })

async function bench(preference?: string) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  let revision = 0
  const namespace = () => ({
    ns: LOCALE_SETTINGS_NAMESPACE,
    schema: LocaleSettingsSchema.toJSON(),
    value: preference === undefined ? {} : { preference },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision,
  })
  const describe = vi.fn(async () => ({
    ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [namespace()] },
  }))
  const mutate = vi.fn(async (_ns: string, ops: { value: string }[]) => {
    preference = ops[0]!.value
    revision += 1
    return { ok: true as const, value: namespace() }
  })
  const events = new TestRemote(ctx, { settings: { describe, mutate } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, describe, mutate, events,
    setHostPreference: (next: string | undefined) => { preference = next; revision += 1 },
  }
}

/** Stand in for the settings shell: declare the General item slot from root. */
function declareItems(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

/** Mirror the framework's inject choreography: bake a real instance from the
 * declared handle and hand its actions to the entry's inject factory. */
function faceOf(slots: SlotRegistry) {
  const entry = slots.entries(SLOT).find(e => e.component === LanguageRow)!
  const handle = entry.store as ReturnType<typeof createLanguageRowStore>
  const instance = handle.create()
  const face = (entry.inject as unknown as (a: typeof instance.actions) => LanguageRowInjected)(instance.actions)
  return { entry, instance, face }
}

describe('locale apply', () => {
  it.each(['resolve', 'reject'] as const)('contains a late native initialization %s after unloading', async (outcome) => {
    const b = await bench()
    const ready = Promise.withResolvers<unknown>()
    const read = vi.fn(() => ready.promise)
    const onChange = vi.fn()
    vi.stubGlobal('__DSH_LOCALE__', { read, onChange })
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await vi.waitFor(() => { expect(read).toHaveBeenCalledOnce() })
      const disposal = fiber.dispose()
      if (outcome === 'resolve') ready.resolve({ languages: ['zh-CN'], preference: null })
      else ready.reject(new Error('native window closed'))
      await disposal
      expect(b.ctx.get('locale')).toBeUndefined()
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      ready.resolve({ languages: ['zh-CN'], preference: null })
      await b.ctx.fiber.dispose()
    }
  })

  it('awaits native initialization and reports later changes only while mounted', async () => {
    const b = await bench('zh')
    const ready = Promise.withResolvers<unknown>()
    const onChange = vi.fn()
    vi.stubGlobal('__DSH_LOCALE__', { read: () => ready.promise, onChange })
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      expect(b.ctx.get('locale')).toBeUndefined()
      ready.resolve({ languages: ['en-US'], preference: 'zh' })
      await fiber.await()
      const locale = b.ctx.get('locale') as LocaleRuntime
      expect(locale.getSnapshot().active).toBe('zh')
      expect(onChange).toHaveBeenLastCalledWith('zh')
      locale.setLocale('en')
      expect(onChange).toHaveBeenLastCalledWith('en')
      await fiber.dispose()
      const calls = onChange.mock.calls.length
      b.ctx.emit('locale/change', { active: 'zh', locales: [], revision: 99 })
      expect(onChange).toHaveBeenCalledTimes(calls)
    } finally {
      ready.resolve({ languages: ['en-US'], preference: 'zh' })
      await b.ctx.fiber.dispose()
    }
  })

  // These are wiring specs, not default-language specs. A fresh LocaleRuntime
  // with no jsdom `window` skips browser detection and opens on FALLBACK_LOCALE
  // (en); each test that reads localized copy stages its locale explicitly via
  // setLocale/Host preference instead of leaning on a dead browser pin.

  it('declares the slot service', () => {
    expect(inject).toEqual(['slots', 'remote', 'configForms'])
  })

  it('provides the service with base + settings dictionaries and registers the row (declaration before or after apply)', async () => {
    const before = await bench()
    declareItems(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = before.ctx.get('locale') as LocaleRuntime
    // Base dictionaries are registered: the (ns, locale) seats are occupied.
    expect(() => locale.register('common', 'zh', {})).toThrow('already has locale')
    expect(() => locale.register('common', 'en', {})).toThrow('already has locale')
    // The lane has no jsdom `window`, so detection never runs and a fresh
    // service opens on FALLBACK_LOCALE (en); read the zh side explicitly.
    locale.setLocale('zh')
    expect(locale.bind(SETTINGS_NS)('language.title')).toBe('语言')
    const entry = before.slots.entries(SLOT).find(e => e.component === LanguageRow)!
    expect(entry.options).toMatchObject({ id: 'language', order: 0 })

    const after = await bench()
    const fiber = after.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(after.slots.entries(SLOT)).toHaveLength(0)
    declareItems(after.slots)
    await Promise.resolve()
    expect(after.slots.entries(SLOT).some(e => e.component === LanguageRow)).toBe(true)
  })

  it('projects service snapshots into the row store and routes face writes back', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = b.ctx.get('locale') as LocaleRuntime
    // An event ahead of any inject hits the unbound-actions arm.
    locale.setLocale('en')

    const { entry, instance, face } = faceOf(b.slots)
    // The inject-time re-sync sealed the init window: the mirror is current.
    expect(instance.getSnapshot().active).toBe('en')
    expect(instance.getSnapshot().options.map(o => o.id)).toEqual(['zh', 'en'])
    // Copy rides the standard locale seat: the entry declares the namespace.
    expect(entry.locale).toBe(SETTINGS_NS)
    expect(locale.bind(SETTINGS_NS)('language.title')).toBe('Language')

    face.setLocale('zh')
    expect(locale.getLocale().active).toBe('zh')
    expect(instance.getSnapshot().active).toBe('zh')
    expect(locale.bind(SETTINGS_NS)('language.title')).toBe('语言')
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(2) })
  })

  it('projects external locale registration and disposal into the Language row', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { instance } = faceOf(b.slots)

    const languagePack = b.ctx.plugin({
      inject: ['locale'],
      apply: packCtx => packCtx.effect(
        () => packCtx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }),
        'test language pack registration',
      ),
    })
    await languagePack.await()
    expect(instance.getSnapshot().options).toEqual([
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
      { id: 'ja', label: '日本語' },
    ])

    await languagePack.dispose()
    expect(instance.getSnapshot().options.map(option => option.id)).toEqual(['zh', 'en'])
  })

  it('loads and refreshes the explicit Host preference after nonblocking activation', async () => {
    const b = await bench()
    // The shared mirror read once at bench time; a Host-side change reaches it
    // through the document invalidation, exactly as production announces one.
    // Preference must differ from the provisional locale (FALLBACK_LOCALE = en
    // with no window), or clearing it below would be unobservable.
    b.setHostPreference('zh')
    b.events.emit('settings/document-updated', [LOCALE_SETTINGS_NAMESPACE, 0])
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = b.ctx.get('locale') as LocaleRuntime
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('zh') })
    // Cleared preference falls back to the provisional locale.
    b.setHostPreference(undefined)
    b.events.emit('settings/document-updated', [LOCALE_SETTINGS_NAMESPACE, 0])
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('en') })
    // Re-selecting zh after the clear is an explicit pick of the provisional
    // value and must persist as a written preference.
    b.setHostPreference('zh')
    b.events.emit('settings/document-updated', [LOCALE_SETTINGS_NAMESPACE, 0])
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('zh') })
    expect(b.describe).toHaveBeenCalledTimes(4)
  })

  it('recovers after an HMR collapse of the declaring entry (stale disposer must not block)', async () => {
    const b = await bench()
    const host = declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries(SLOT)).toHaveLength(1)

    // Collapse: the declarer dies, the cascade removes our entry while the
    // apply closure still holds its (now stale) disposer.
    host()
    expect(b.slots.entries(SLOT)).toHaveLength(0)

    declareItems(b.slots)
    await Promise.resolve()
    expect(b.slots.entries(SLOT).some(e => e.component === LanguageRow)).toBe(true)
  })

  it('teardown removes the row; teardown without a declaration is quiet', async () => {
    const b = await bench()
    declareItems(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(SLOT)).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)

    // Never-declared bench: the effect disposer's dispose arm stays undefined.
    const quiet = await bench()
    const f2 = quiet.ctx.plugin({ inject: [...inject], apply })
    await f2.await()
    await f2.dispose()
    expect(quiet.slots.entries(SLOT)).toHaveLength(0)
  })
})
