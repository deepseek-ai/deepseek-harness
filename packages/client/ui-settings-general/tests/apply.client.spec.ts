/** Ownerless-copy registrations: the five seats, dictionaries, thunked labels, and HMR recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { SettingsDocumentAction } from '../src/client/SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from '../src/client/SettingsDocumentAction.tsx'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

/** The seats this plugin fills for a loopback browser (slot name → expected component). */
const SEATS = [
  ['settings.trigger', TriggerContent],
  ['settings.header', HeaderContent],
  ['settings.action', SettingsDocumentAction],
  ['settings.close', CloseLabel],
  ['settings.section', GeneralSection],
] as const

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const settingsDescribe = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: {
      writable: true,
      hasDocument: true,
      namespaces: [],
    },
  }))
  const settingsOpenDocument = vi.fn(() => Promise.resolve({
    ok: true as const, value: { opened: true as const },
  }))
  const remote = new TestRemote(ctx, {
    settings: { describe: settingsDescribe, openSettingsDocument: settingsOpenDocument },
  })
  // The fixed Host facts the shell reads its loopback-only action from.
  remote.$host = { home: undefined, isLoopback }
  ctx.provide('connection', {
    state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
    reconnect: () => {},
  } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, settingsDescribe, settingsOpenDocument }
}

/** Declare the shell's six child slots the way ui-settings' entry does. */
function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.trigger': { kind: 'single', scope: 'root' },
        'settings.header': { kind: 'single', scope: 'root' },
        'settings.action': { kind: 'list', scope: 'root' },
        'settings.close': { kind: 'single', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

function generalEntry(slots: SlotRegistry) {
  return slots.entries('settings.section').find(e => e.component === GeneralSection)
}

describe('ui-settings-general apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope'])
  })

  it('fills all five seats for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    for (const [name, component] of SEATS) {
      expect(before.slots.entries(name)[0]!.component).toBe(component)
    }
    const entry = generalEntry(before.slots)!
    expect(entry.options).toMatchObject({ id: 'general', order: 0 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.options.label)).toBe('通用设置')
    expect(before.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    expect(before.slots.entries('settings.general.item')).toEqual([])
    // The onboarding hole stays declared for feature-owned steps; this plugin
    // no longer seats one.
    expect(before.slots.entries('settings.onboarding')).toEqual([])
    const action = before.slots.entries('settings.action')[0]!
    const actionInjected = (action.inject as unknown as () => SettingsDocumentActionInjected)()
    expect(actionInjected.controller.store.getSnapshot().status).toBe('idle')
    expect(actionInjected.hooks.snapshot).toBe(actionInjected.controller.store)
    // Copy rides the standard locale seat: every seat declares the namespace.
    for (const [name] of SEATS) {
      expect(before.slots.entries(name)[0]!.locale).toBe('settings')
    }
    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const [name] of SEATS) expect(after.slots.entries(name)).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    for (const [name, component] of SEATS) {
      expect(after.slots.entries(name)[0]!.component).toBe(component)
      // The self-inflicted ledger notifications hit the duplicate guard.
      expect(after.slots.entries(name)).toHaveLength(1)
    }
    await vi.waitFor(() => {
      expect(after.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    })
  })

  it('registers the zh/en settings dictionaries and frees the seats on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings')('title')).toBe('设置')
    expect(b.locale.bind('settings')('connection.error')).toBe('连接异常')
    expect(b.locale.bind('settings')('connection.connecting')).toBe('自动重连中')
    expect(b.locale.bind('settings')('connection.connected')).toBe('连接成功')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings')('close')).toBe('Close')
    expect(b.locale.bind('settings')('connection.reconnect')).toBe('Disconnected, reconnect now')
    expect(b.locale.bind('settings')('connection.connecting')).toBe('Reconnecting')
    b.locale.setLocale('zh')
    await fiber.dispose()
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => b.locale.register('settings', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings', 'en', {})).not.toThrow()
  })

  it('the nav label thunk follows the active locale without re-registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const zhVersions = SEATS.map(([name]) => b.slots.getVersion(name))
    b.locale.setLocale('en')
    // No ledger churn: freshness rides the thunk (and the renderer's locale
    // subscription), not re-registration.
    SEATS.forEach(([name], i) => {
      expect(b.slots.getVersion(name)).toBe(zhVersions[i]!)
      expect(b.slots.entries(name)).toHaveLength(1)
    })
    expect(resolveSlotLabel(generalEntry(b.slots)!.options.label)).toBe('General')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(generalEntry(b.slots)!.options.label)).toBe('通用设置')
  })

  it('reads availability from the shared mirror and follows its reconnect refresh', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.action')[0]!
    const { controller } = (entry.inject as unknown as () => SettingsDocumentActionInjected)()
    // The mirror read once at its own boot; the action's load adds no read.
    await vi.waitFor(() => { expect(b.settingsDescribe).toHaveBeenCalledOnce() })
    await controller.load()
    expect(b.settingsDescribe).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().status).toBe('ready')
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.settingsDescribe).toHaveBeenCalledTimes(2) })
  })

  it('withholds the Host document action off-loopback', async () => {
    const b = await bench(false)
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.action')).toEqual([])
    expect(b.settingsDescribe).not.toHaveBeenCalled()
    await fiber.dispose()
    for (const [name] of SEATS) expect(b.slots.entries(name)).toEqual([])
  })

  it('re-registers after an HMR collapse of the declaring chain (stale disposers must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Declarer unload: the cascade removes every seat entry and the item
    // declaration while our local disposers go stale.
    redeclare()
    for (const [name] of SEATS) expect(b.slots.entries(name)).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
    declare(b.slots)
    await Promise.resolve()
    for (const [name, component] of SEATS) {
      expect(b.slots.entries(name)[0]!.component).toBe(component)
    }
    expect(b.slots.entries('settings.general.item')).toEqual([])
    expect(b.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    // The recovered registrations still ride the locale path.
    b.locale.setLocale('en')
    expect(resolveSlotLabel(generalEntry(b.slots)!.options.label)).toBe('General')
    b.locale.setLocale('zh')
  })

  it('removes every seat and the item declaration on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.spec('settings.general.item')).toBeDefined()
    await fiber.dispose()
    for (const [name] of SEATS) expect(b.slots.entries(name)).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
  })
})
