// @vitest-environment jsdom
/**
 * Settings shell registration inside the assembled web client: the shell
 * occupies the `sidebar.settings` hole ui-sidebar declares, its ledger
 * projections read the product's real sections, its connection control is the
 * roster's Connection, and it survives a Loader rebuild of the declarer.
 */
import { describe, expect, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { inject } from '../src/client/index.ts'
import type { SettingsRootInjected } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'

const SELF = '@deepseek-ai/dsh-client-ui-settings-general'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const it = createClientTest({ roster: webApp })
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000

function injectedOf(c: TestClient): SettingsRootInjected {
  const entry = c.ctx.slots.entries('sidebar.settings')[0]!
  return (entry.inject as () => SettingsRootInjected)()
}

/** The shell's child declarations (chrome, actions, sections, and onboarding overlays). */
const CHILD_SPECS = {
  'settings.trigger': { kind: 'single', scope: 'root' },
  'settings.header': { kind: 'single', scope: 'root' },
  'settings.action': { kind: 'list', scope: 'root' },
  'settings.close': { kind: 'single', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.onboarding': { kind: 'list', scope: 'root' },
} as const
const CHILD_NAMES = Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>

/**
 * Section ids the web-app roster registers, in nav order: this package, then
 * ui-settings-models, ui-settings-plugins, ui-agent-preset, and
 * ui-settings-unarchive-sessions. A plugin adding a section changes this list.
 */
const PRODUCT_SECTIONS: readonly string[] = ['general', 'models', 'plugins', 'agent-presets', 'archived-sessions']
/** Onboarding steps the web-app roster registers, in coordinator order; both come from ui-settings-models. */
const PRODUCT_ONBOARDING: readonly { id: string; order: number }[] = [
  { id: 'welcome-notice', order: -100 },
  { id: 'deepseek-official', order: 0 },
]

describe('ui-settings-general shell', () => {
  it('declares its services', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope'])
  })

  it('occupies sidebar.settings, declared by ui-sidebar, and declares every child slot', async ({ start }) => {
    const c = await start()
    expect(c.ctx.slots.entries('sidebar.settings').map(entry => entry.component)).toEqual([SettingsRoot])
    for (const name of CHILD_NAMES) expect(c.ctx.slots.spec(name)).toEqual(CHILD_SPECS[name])
  }, COLD_BOOT_TIMEOUT_MS)

  it('projects the section ledger: product sections in order, defaults for bare rows, stable snapshots', async ({ start }) => {
    const c = await start()
    const { sections } = injectedOf(c).hooks
    const product = sections.getSnapshot()
    expect(product.map(row => row.id)).toEqual(PRODUCT_SECTIONS)
    expect(product[0]).toEqual({ id: 'general', order: 0, label: expect.any(String) as string })
    c.ctx.slots.register({ name: 'settings.section', id: 'z', order: 1_000, label: 'Z' } as never, () => null)
    // No order and no label: both projection defaults apply, and order 0 sorts among the product rows.
    c.ctx.slots.register({ name: 'settings.section', id: 'a' } as never, () => null)
    const rows = sections.getSnapshot()
    expect(rows.at(-1)).toEqual({ id: 'z', order: 1_000, label: 'Z' })
    expect(rows.find(row => row.id === 'a')).toEqual({ id: 'a', order: 0, label: '' })
    expect(rows.map(row => row.order)).toEqual([...rows.map(row => row.order)].sort((x, y) => x - y))
    // Snapshot identity is stable until the ledger moves (uSES contract).
    expect(sections.getSnapshot()).toBe(rows)
    const listener = vi.fn()
    const off = sections.subscribe(listener)
    c.ctx.slots.register({ name: 'settings.section', id: 'b', order: 1, label: 'B' } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalled()
    expect(sections.getSnapshot()).not.toBe(rows)
    off()
  })

  it('projects the roster Connection control without copying its state; reconnect opens a new $events generation', async ({ start }) => {
    const c = await start()
    const injected = injectedOf(c)
    expect(injected.hooks.connectionState).toBe(c.connection.state)
    expect(injected.hooks.connectionState.getSnapshot()).toBe('connected')
    injected.reconnect()
    await c.mock.streams.opened('$events', 2)
    await vi.waitFor(() => { expect(c.connection.state.getSnapshot()).toBe('connected') })
  })

  it('projects onboarding entries into stable coordinator order', async ({ start }) => {
    const c = await start()
    const { onboardingSteps } = injectedOf(c).hooks
    expect(onboardingSteps.getSnapshot()).toEqual(PRODUCT_ONBOARDING)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'credential', order: 0 } as never, () => null)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'welcome', order: -100 } as never, () => null)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'default-order' } as never, () => null)
    const steps = onboardingSteps.getSnapshot()
    expect(steps.filter(step => !PRODUCT_ONBOARDING.some(known => known.id === step.id))).toEqual([
      { id: 'welcome', order: -100 },
      { id: 'credential', order: 0 },
      { id: 'default-order', order: 0 },
    ])
    expect(onboardingSteps.getSnapshot()).toBe(steps)
    const listener = vi.fn()
    const off = onboardingSteps.subscribe(listener)
    c.ctx.slots.register({ name: 'settings.onboarding', id: 'later', order: 10 } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    off()
  })

  it('re-registers after the declarer reloads: the cascade removes the shell, the rebuilt declaration takes it back', async ({ start }) => {
    const c = await start()
    const before = c.ctx.slots.entries('sidebar.settings')[0]
    expect(before).toBeDefined()
    await c.reload(SIDEBAR)
    await c.flush()
    expect(c.ctx.slots.entries('sidebar.settings').map(entry => entry.component)).toEqual([SettingsRoot])
    expect(c.ctx.slots.entries('sidebar.settings')[0]).not.toBe(before)
    for (const name of CHILD_NAMES) expect(c.ctx.slots.spec(name)).toEqual(CHILD_SPECS[name])
  })

  it('unregisters the shell and collapses every child slot when its row unloads', async ({ start }) => {
    const c = await start()
    await c.unload(SELF)
    await c.flush()
    expect(c.ctx.slots.entries('sidebar.settings')).toHaveLength(0)
    for (const name of CHILD_NAMES) expect(c.ctx.slots.spec(name)).toBeUndefined()
  })
})
