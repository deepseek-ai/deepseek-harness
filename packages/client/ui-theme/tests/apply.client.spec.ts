/** ui-theme apply wiring: service provision, settings dictionaries riding the
 * locale service, declaration-aware Appearance row registration, snapshot
 * projection into the row store, and HMR collapse recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, SETTINGS_NS } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AppearanceRowInjected, FontSizeRowInjected, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema } from '../src/theme-settings.ts'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import { FontSizeRow } from '../src/client/FontSizeRow.tsx'
import type { createAppearanceRowStore, createFontSizeRowStore } from '../src/client/settings-store.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

const SLOT = 'settings.general.item'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const section: Record<string, unknown> = { preference: 'system', fontSize: 14 }
  const namespace = () => ({
    ns: THEME_SETTINGS_NAMESPACE,
    schema: ThemeSettingsSchema.toJSON(),
    value: { ...section },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  })
  const describe = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [namespace()] },
  }))
  const mutate = vi.fn((_ns: string, ops: { path: string[]; value: unknown }[]) => {
    const op = ops[0]!
    section[op.path[0]!] = op.value
    return Promise.resolve({ ok: true as const, value: namespace() })
  })
  const events = new TestRemote(ctx, { settings: { describe, mutate } })
  events.$host = { home: undefined, isLoopback }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, describe, mutate, events,
    setHostSection: (next: Record<string, unknown>) => { Object.assign(section, next) },
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
  const entry = slots.entries(SLOT).find(e => e.component === AppearanceRow)!
  const handle = entry.store as ReturnType<typeof createAppearanceRowStore>
  const instance = handle.create()
  const face = (entry.inject as unknown as (a: typeof instance.actions) => AppearanceRowInjected)(instance.actions)
  return { entry, instance, face }
}

/** The same choreography for the font-size row entry. */
function fontSizeFaceOf(slots: SlotRegistry) {
  const entry = slots.entries(SLOT).find(e => e.component === FontSizeRow)!
  const handle = entry.store as ReturnType<typeof createFontSizeRowStore>
  const instance = handle.create()
  const face = (entry.inject as unknown as (a: typeof instance.actions) => FontSizeRowInjected)(instance.actions)
  return { entry, instance, face }
}

describe('ui-theme apply', () => {
  it('declares the slot and locale services', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'configForms'])
  })

  it('provides the service, registers localized copy, and registers both rows (declaration before or after apply)', async () => {
    const before = await bench()
    declareItems(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.locale.bind(SETTINGS_NS)('appearance.title')).toBe('外观')
    expect(before.locale.bind(SETTINGS_NS)('fontSize.title')).toBe('字号大小')
    before.locale.setLocale('en')
    expect(before.locale.bind(SETTINGS_NS)('appearance.title')).toBe('Appearance')
    const entry = before.slots.entries(SLOT).find(e => e.component === AppearanceRow)!
    expect(entry.options).toMatchObject({ id: 'appearance', order: 10 })
    const fontEntry = before.slots.entries(SLOT).find(e => e.component === FontSizeRow)!
    expect(fontEntry.options).toMatchObject({ id: 'font-size', order: 11 })
    expect(fontEntry.locale).toBe(SETTINGS_NS)

    const after = await bench()
    const fiber = after.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(after.slots.entries(SLOT)).toHaveLength(0)
    declareItems(after.slots)
    await Promise.resolve()
    expect(after.slots.entries(SLOT).some(e => e.component === AppearanceRow)).toBe(true)
    expect(after.slots.entries(SLOT).some(e => e.component === FontSizeRow)).toBe(true)
  })

  it('projects service snapshots into the row store and routes face writes back', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    // An event ahead of any inject hits the unbound-actions arm.
    theme.setTheme('dark')

    const { instance, face } = faceOf(b.slots)
    // The inject-time re-sync sealed the init window: the mirror is current.
    expect(instance.getSnapshot().preference).toBe('dark')
    // Copy rides the standard locale seat: the entry declares the namespace.
    expect(b.slots.entries(SLOT).find(e => e.component === AppearanceRow)!.locale).toBe(SETTINGS_NS)

    face.setTheme('system')
    expect(theme.getTheme().preference).toBe('system')
    expect(instance.getSnapshot().preference).toBe('system')
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(2) })
  })

  it('projects font-size snapshots into its row store and routes face writes back', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    // An event ahead of any inject hits the unbound-actions arm.
    theme.setFontSize(16)

    const { instance, face } = fontSizeFaceOf(b.slots)
    // The inject-time re-sync sealed the init window: the mirror is current.
    expect(instance.getSnapshot().fontSize).toBe(16)

    face.setFontSize(12)
    expect(theme.getTheme().fontSize).toBe(12)
    expect(instance.getSnapshot().fontSize).toBe(12)
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(2) })
  })

  it('loads Host settings at boot, refreshes its namespace, and keeps remote browsers process-local', async () => {
    const b = await bench()
    // The shared mirror read once at bench time; a Host-side change reaches it
    // through the document invalidation, exactly as production announces one.
    b.setHostSection({ preference: 'dark', fontSize: 17 })
    b.events.emit('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('dark') })
    expect(theme.getTheme().fontSize).toBe(17)
    // The mirror refreshes on every document commit (ns-agnostic); the scope's
    // derived value only moves when its own namespace changed.
    b.events.emit('settings/document-updated', ['unrelated', 0])
    await vi.waitFor(() => { expect(b.describe).toHaveBeenCalledTimes(3) })
    expect(theme.getTheme().preference).toBe('dark')
    b.setHostSection({ preference: 'light' })
    b.events.emit('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('light') })
    b.setHostSection({ preference: 'dark' })
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('dark') })

    const remote = await bench(false)
    declareItems(remote.slots)
    await remote.ctx.plugin({ inject: [...inject], apply }).await()
    const remoteTheme = remote.ctx.get('theme') as ThemeRuntime
    remoteTheme.setTheme('dark')
    await Promise.resolve()
    expect(remote.describe).not.toHaveBeenCalled()
    expect(remote.mutate).not.toHaveBeenCalled()
  })

  it('activates before a slow settings refresh and converges when it settles', async () => {
    const b = await bench()
    b.setHostSection({ preference: 'dark' })
    const describe = b.describe.getMockImplementation()!
    const pending = deferred<Awaited<ReturnType<typeof describe>>>()
    b.describe.mockImplementationOnce(() => pending.promise)
    // The refresh hangs on the wire; the mirror keeps serving the last good
    // answer, so activation never blocks on the settings transport.
    b.events.emit('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    expect(theme.getTheme().preference).toBe('system')
    pending.resolve(await describe())
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('dark') })
    await fiber.dispose()
  })

  it('ignores an invalid preference crossing the settings wire', async () => {
    const b = await bench()
    b.setHostSection({ preference: 'sepia' })
    b.events.emit('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    await vi.waitFor(() => { expect(b.describe).toHaveBeenCalledTimes(2) })
    expect(theme.getTheme().preference).toBe('system')
  })

  it('recovers after an HMR collapse of the declaring entry (stale disposer must not block)', async () => {
    const b = await bench()
    const host = declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries(SLOT)).toHaveLength(2)

    // Collapse: the declarer dies, the cascade removes our entries while the
    // apply closure still holds its (now stale) disposers.
    host()
    expect(b.slots.entries(SLOT)).toHaveLength(0)

    declareItems(b.slots)
    await Promise.resolve()
    expect(b.slots.entries(SLOT).some(e => e.component === AppearanceRow)).toBe(true)
    expect(b.slots.entries(SLOT).some(e => e.component === FontSizeRow)).toBe(true)
  })

  it('teardown removes the rows and the dictionaries; teardown without a declaration is quiet', async () => {
    const b = await bench()
    declareItems(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(SLOT)).toHaveLength(2)
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    // Dictionary disposal: translation falls back to the bare key.
    expect(b.locale.bind(SETTINGS_NS)('appearance.title')).toBe('appearance.title')

    // Never-declared bench: the effect disposer's dispose arm stays undefined.
    const quiet = await bench()
    const f2 = quiet.ctx.plugin({ inject: [...inject], apply })
    await f2.await()
    await f2.dispose()
    expect(quiet.slots.entries(SLOT)).toHaveLength(0)
  })
})
