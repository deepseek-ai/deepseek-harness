/** What the browser half registers, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { PluginsSettingsSectionInjected } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { apply as hostApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/** The Settings shell's section slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers one Built-in plugins section and declares its tab slot, contributing no tab of its own', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('内置插件')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
  })

  it('injects a live tab projection ordered by the contributions', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    const sectionFace = (section.inject as () => Pick<PluginsSettingsSectionInjected, 'hooks'>)()
    const initialTabs = sectionFace.hooks.tabs.getSnapshot()
    expect(initialTabs).toEqual([])
    expect(sectionFace.hooks.tabs.getSnapshot()).toBe(initialTabs)

    const unsubscribe = sectionFace.hooks.tabs.subscribe(vi.fn())
    slots.register({ name: 'settings.plugins.tab', id: 'plain' } as never, () => null)
    slots.register({ name: 'settings.plugins.tab', id: 'first', order: -1 } as never, () => null)
    // Tabs follow their contribution's order, whatever order they registered in.
    expect(sectionFace.hooks.tabs.getSnapshot()).toEqual([
      { id: 'first', order: -1, label: '' },
      { id: 'plain', order: 0, label: '' },
    ])
    unsubscribe()
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('collapses the section on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')).toHaveLength(1)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
