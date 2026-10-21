// @vitest-environment jsdom
/**
 * Ownerless-copy registrations inside the assembled web client: the five
 * seats, the `settings` dictionaries, the locale-following nav label, the
 * loopback-only document action over the real settings mirror, and recovery
 * across Loader rebuilds of the declaring chain.
 */
import { describe, expect, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { graphFromRoster } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/roster.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '@deepseek-ai/dsh-client-locale/src/locale-settings.ts'
import { inject } from '../src/client/index.ts'
import type { DeveloperToolsRowInjected } from '../src/client/DeveloperToolsRow.tsx'
import { HostReleasePrompt, type HostReleasePromptInjected } from '../src/client/HostReleasePrompt.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { SettingsDocumentAction } from '../src/client/SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from '../src/client/SettingsDocumentAction.tsx'

const SELF = '@deepseek-ai/dsh-client-ui-settings-general'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const it = createClientTest({ roster: webApp })
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000
/** Dictionary namespace this plugin owns; every seat it fills declares it. */
const NS = 'settings'

/** The seats this plugin fills for a loopback browser (slot name → expected component). */
const SEATS = [
  ['settings.trigger', TriggerContent],
  ['settings.header', HeaderContent],
  ['settings.action', SettingsDocumentAction],
  ['settings.close', CloseLabel],
  ['settings.section', GeneralSection],
] as const

/** One Host view of the locale preference, including its revision fence. */
function localeView(preference: string, revision = 0): SettingsNamespaceView {
  return {
    ns: LOCALE_SETTINGS_NAMESPACE,
    // The Remote wire serializes nested Schema values before the client rehydrates them.
    schema: JSON.parse(JSON.stringify(LocaleSettingsSchema.toJSON())) as SettingsNamespaceView['schema'],
    value: { preference },
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision,
  }
}

async function client(mock: RemoteMock, start: () => Promise<TestClient>, hasDocument = false) {
  const settings = mock.remote.settings
  settings.describe.mockResolvedValue(ok({ writable: true, hasDocument, namespaces: [localeView('zh')] }))
  const c = await start()
  // The locale adopts the Host preference once the describe mirror holds the document.
  await c.ctx.configForms.describe().ensure()
  return { c, settings }
}

/** This plugin's rows in a seat: the list seats also carry feature-owned rows (the product's other sections and actions). */
function ownEntries(c: TestClient, name: (typeof SEATS)[number][0]) {
  return c.ctx.slots.entries(name).filter(entry => entry.locale === NS)
}

function generalEntry(c: TestClient) {
  return ownEntries(c, 'settings.section').find(entry => entry.component === GeneralSection)!
}

function generalLabel(c: TestClient): string | undefined {
  return resolveSlotLabel(generalEntry(c).options.label)
}

function developerToolsRowOf(c: TestClient): DeveloperToolsRowInjected {
  const developerRow = c.ctx.slots.entries('settings.general.item').find(row => row.options.id === 'developer-tools')!
  return (developerRow.inject as unknown as () => DeveloperToolsRowInjected)()
}

function actionInjectedOf(c: TestClient): SettingsDocumentActionInjected {
  const entry = ownEntries(c, 'settings.action')[0]!
  return (entry.inject as unknown as () => SettingsDocumentActionInjected)()
}

function expectSeated(c: TestClient): void {
  for (const [name, component] of SEATS) {
    expect(ownEntries(c, name).map(entry => entry.component)).toEqual([component])
  }
}

/** The page authority the `connection` plugin classifies at apply, reconfigured through the jsdom instance vitest exposes. */
function setPageUrl(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure(settings: { url: string }): void } }).jsdom.reconfigure({ url })
}

describe('ui-settings-general apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.settings', 'configForms', 'shortcuts', 'modules'])
  })

  it('fills the five seats of the shell it declares, with the locale-following General label', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    expect(c.ctx.locale.getSnapshot().active).toBe('zh')
    expectSeated(c)
    const entry = generalEntry(c)
    expect(entry.options).toMatchObject({ id: 'general', order: 0 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(generalLabel(c)).toBe('通用设置')
    expect(c.ctx.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    // The shared developer-tool control belongs to General; onboarding remains feature-owned.
    expect(c.ctx.slots.entries('settings.general.item').filter(row => row.locale === NS).map(row => row.options.id)).toEqual(['developer-tools', 'current-version'])
    expect(c.ctx.slots.entries('settings.onboarding').filter(row => row.locale === NS)).toEqual([])
    const developer = developerToolsRowOf(c)
    expect(developer.hooks.developerTools).toBe(c.ctx.configForms.developerTools.enabled)
    expect(developer.hooks.developerTools.getSnapshot()).toBe(false)
    const setEnabled = vi.spyOn(c.ctx.configForms.developerTools, 'setEnabled').mockResolvedValue(undefined)
    await developer.setEnabled(true)
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true)
    const { controller, hooks } = actionInjectedOf(c)
    expect(controller.store.getSnapshot().status).toBe('idle')
    expect(hooks.snapshot).toBe(controller.store)
    // Copy rides the standard locale seat: every row this plugin seats declares the namespace.
    for (const [name, component] of SEATS) {
      expect(c.ctx.slots.entries(name).find(row => row.component === component)!.locale).toBe(NS)
    }
  }, COLD_BOOT_TIMEOUT_MS)

  it('reports a Coding Tools toggle only when a known value changes to the requested one', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    const track = vi.fn()
    c.ctx.provide('productAnalytics', { enabled: true, track } as never)
    const form = c.ctx.configForms.get<{ enabled: boolean }>('ui-settings')
    const snapshot = form.getSnapshot()
    let value: { enabled: boolean } | undefined = { enabled: false }
    let accepted = true
    let now = 100
    const reads = vi.spyOn(form, 'getSnapshot').mockImplementation(() => ({ ...snapshot, value }))
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const write = vi.spyOn(c.ctx.configForms.developerTools, 'setEnabled').mockImplementation(async (enabled) => {
      now += 50
      if (accepted) value = { enabled }
    })
    onTestFinished(() => {
      reads.mockRestore()
      clock.mockRestore()
      write.mockRestore()
    })
    const row = developerToolsRowOf(c)

    // The event carries the click time, before the write settles.
    await row.setEnabled(true)
    expect(track).toHaveBeenCalledExactlyOnceWith('code_work_view_toggle', { is_enabled: true }, 100)

    // Requesting the current value writes but changes nothing.
    await row.setEnabled(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenCalledOnce()

    // A write that settles without the requested value is not a toggle.
    accepted = false
    await row.setEnabled(false)
    expect(value).toEqual({ enabled: true })
    expect(track).toHaveBeenCalledOnce()

    // A rejected write reports its failure and no toggle.
    accepted = true
    write.mockRejectedValueOnce(new Error('not accepted'))
    await expect(row.setEnabled(false)).rejects.toThrow('not accepted')
    expect(track).toHaveBeenCalledOnce()

    // Without a known previous value the change cannot be attributed.
    value = undefined
    await row.setEnabled(false)
    expect(value).toEqual({ enabled: false })
    expect(track).toHaveBeenCalledOnce()

    value = { enabled: true }
    now = 300
    await row.setEnabled(false)
    expect(track).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenLastCalledWith('code_work_view_toggle', { is_enabled: false }, 300)
  })

  it('registers the zh/en settings dictionaries and frees the seats when its row unloads', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start)
    const english = localeView('en', 1)
    settings.mutate.mockResolvedValueOnce(ok(english))
    const t = c.ctx.locale.bind(NS)
    expect(t('title')).toBe('设置')
    expect(t('connection.error')).toBe('连接异常，刷新重试')
    expect(t('connection.connecting')).toBe('重新连接中')
    expect(t('connection.connected')).toBe('连接成功')
    c.ctx.locale.setLocale('en')
    expect(t('close')).toBe('Close')
    expect(t('connection.reconnect')).toBe('Disconnected, reconnect now')
    expect(t('connection.connecting')).toBe('Reconnecting')
    await vi.waitFor(() => {
      expect(settings.mutate.mock.calls).toEqual([
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'en' }], 0],
      ])
      expect(c.ctx.configForms.describe().getSnapshot().view?.namespaces).toEqual([english])
    })
    await c.unload(SELF)
    await c.flush()
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => { c.ctx.locale.register(NS, 'zh', {})() }).not.toThrow()
    expect(() => { c.ctx.locale.register(NS, 'en', {})() }).not.toThrow()
  })

  it('the nav label thunk follows the active locale without re-registration', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start)
    const english = localeView('en', 1)
    const chinese = localeView('zh', 2)
    settings.mutate.mockResolvedValueOnce(ok(english)).mockResolvedValueOnce(ok(chinese))
    const zhVersions = SEATS.map(([name]) => c.ctx.slots.getVersion(name))
    c.ctx.locale.setLocale('en')
    // No ledger churn: freshness rides the thunk (and the renderer's locale
    // subscription), not re-registration.
    SEATS.forEach(([name], i) => {
      expect(c.ctx.slots.getVersion(name)).toBe(zhVersions[i]!)
      expect(ownEntries(c, name)).toHaveLength(1)
    })
    expect(generalLabel(c)).toBe('General')
    await vi.waitFor(() => {
      expect(c.ctx.configForms.describe().getSnapshot().view?.namespaces).toEqual([english])
    })
    c.ctx.locale.setLocale('zh')
    expect(generalLabel(c)).toBe('通用设置')
    await vi.waitFor(() => {
      expect(settings.mutate.mock.calls).toEqual([
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'en' }], 0],
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'zh' }], 1],
      ])
      expect(c.ctx.configForms.describe().getSnapshot().view?.namespaces).toEqual([chinese])
    })
  })

  it('reads availability from the shared mirror and follows its reconnect refresh', async ({ mock, start }) => {
    const { c } = await client(mock, start, true)
    const { controller } = actionInjectedOf(c)
    // Boot reads the document twice: the mirror's own `ensure` at apply, then
    // the `connection/reset` of the first connection. The action's load adds none.
    expect(c.mock.log.calls('settings/describe')).toHaveLength(2)
    await controller.load()
    expect(c.mock.log.calls('settings/describe')).toHaveLength(2)
    expect(controller.store.getSnapshot().status).toBe('ready')
    c.connection.reconnect()
    await c.mock.streams.opened('$events', 2)
    await vi.waitFor(() => { expect(c.mock.log.calls('settings/describe')).toHaveLength(3) })
  })

  it('keeps Host preferences off-loopback and withholds only the native document action', async ({ mock, start }) => {
    const loopbackUrl = location.href
    setPageUrl('http://198.51.100.7:3000/')
    onTestFinished(() => { setPageUrl(loopbackUrl) })
    const { c, settings } = await client(mock, start)
    expect(c.connection.isLoopback).toBe(false)
    // The stored Host locale applies off-loopback; only the native document
    // action stays loopback-only.
    expect(c.ctx.locale.getSnapshot().active).toBe('zh')
    expect(ownEntries(c, 'settings.action')).toEqual([])
    const english = localeView('en', 1)
    settings.mutate.mockResolvedValueOnce(ok(english))
    c.ctx.locale.setLocale('en')
    await vi.waitFor(() => {
      expect(settings.mutate.mock.calls).toEqual([
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'en' }], 0],
      ])
    })
    await c.unload(SELF)
    await c.flush()
    for (const [name] of SEATS) expect(ownEntries(c, name)).toEqual([])
  })

  it('updates remote locale consumers after Host commits and reconnects', async ({ mock, start }) => {
    const originalUrl = location.href
    setPageUrl('http://198.51.100.7:3000/')
    onTestFinished(() => { setPageUrl(originalUrl) })
    const { c, settings } = await client(mock, start)
    expect(c.connection.isLoopback).toBe(false)
    expect(c.ctx.locale.getSnapshot().active).toBe('zh')
    settings.describe.mockResolvedValue(ok({
      writable: true, hasDocument: false, namespaces: [localeView('en', 1)],
    }))
    await c.mock.streams.opened('$events', 1)
    c.mock.streams.push('$events', {
      type: 'emit', event: 'settings/document-updated', args: [LOCALE_SETTINGS_NAMESPACE, 1],
    })
    await vi.waitFor(() => {
      expect(c.ctx.locale.getSnapshot().active).toBe('en')
      expect(generalLabel(c)).toBe('General')
    })
    settings.describe.mockResolvedValue(ok({
      writable: true, hasDocument: false, namespaces: [localeView('zh', 2)],
    }))
    c.connection.reconnect()
    await c.mock.streams.opened('$events', 2)
    await vi.waitFor(() => {
      expect(c.ctx.locale.getSnapshot().active).toBe('zh')
      expect(generalLabel(c)).toBe('通用设置')
    })
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('re-registers after a Loader rebuild of the declaring chain (stale disposers must not block)', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start)
    const before = SEATS.map(([name]) => ownEntries(c, name)[0])
    await c.reload(SIDEBAR)
    await c.flush()
    expectSeated(c)
    SEATS.forEach(([name], index) => {
      expect(ownEntries(c, name)[0]).not.toBe(before[index])
    })
    expect(c.ctx.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    expect(c.ctx.slots.entries('settings.general.item').filter(row => row.locale === NS).map(row => row.options.id)).toEqual(['developer-tools', 'current-version'])
    // The recovered registrations still ride the locale path.
    const english = localeView('en', 1)
    const chinese = localeView('zh', 2)
    settings.mutate.mockResolvedValueOnce(ok(english)).mockResolvedValueOnce(ok(chinese))
    c.ctx.locale.setLocale('en')
    expect(generalLabel(c)).toBe('General')
    c.ctx.locale.setLocale('zh')
    expect(generalLabel(c)).toBe('通用设置')
    await vi.waitFor(() => {
      expect(settings.mutate.mock.calls).toEqual([
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'en' }], 0],
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'zh' }], 1],
      ])
      expect(c.ctx.configForms.describe().getSnapshot().view?.namespaces).toEqual([chinese])
    })
  })

  it('removes every seat and the item declaration when its row unloads', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    expect(c.ctx.slots.spec('settings.general.item')).toBeDefined()
    await c.unload(SELF)
    await c.flush()
    for (const [name] of SEATS) expect(ownEntries(c, name)).toHaveLength(0)
    expect(c.ctx.slots.entries('settings.general.item').filter(row => row.locale === NS)).toEqual([])
    expect(c.ctx.slots.spec('settings.general.item')).toBeUndefined()
  })

  it('asks about another Host release in the shell overlay and stops asking once dismissed', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    const overlay = () => c.ctx.slots.entries('shell.overlay').find(row => row.options.id === 'host-release-change')
    expect(overlay()?.component).toBe(HostReleasePrompt)
    expect(overlay()?.locale).toBe(NS)
    const face = overlay()!.inject!()
    const { dismissRelease, reloadPage, hooks } = face
    if (typeof dismissRelease !== 'function' || typeof reloadPage !== 'function' || typeof hooks !== 'object' || hooks === null) {
      throw new TypeError('host-release-change inject face is incomplete')
    }
    const injected = { dismissRelease, reloadPage, hooks } as HostReleasePromptInjected
    expect(injected.hooks.releaseChange).toBe(c.ctx.modules.entries.releaseChange)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const release = { version: '2.0.0' }
    await c.ctx.modules.entries.sync({ ...graphFromRoster(webApp.rows), release })
    expect(injected.hooks.releaseChange.getSnapshot()).toEqual({ page: undefined, previous: undefined, host: release })
    expect(warn).toHaveBeenCalledOnce()
    injected.dismissRelease()
    expect(injected.hooks.releaseChange.getSnapshot()).toBeUndefined()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    onTestFinished(() => { vi.unstubAllGlobals() })
    injected.reloadPage()
    expect(reload).toHaveBeenCalledOnce()
    await c.unload(SELF)
    await c.flush()
    expect(overlay()).toBeUndefined()
  })
})
