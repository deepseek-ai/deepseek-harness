// @vitest-environment jsdom
/**
 * The viewer's brand seats shadow the shipped brand instead of colliding with it.
 *
 * `sidebar.brand.mark` and `sidebar.brand.name` are single slots. A served viewer page mounts the
 * owner's own plugins, so the shipped brand — including `ui-brand-official` on an official build —
 * already occupies both slots at the default rank. Registering the viewer entries at that rank is
 * the failure this suite pins: the single-slot conflict leaves the viewer entry unregistered and the
 * shipped brand keeps rendering.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { cleanup } from '@testing-library/react'
import { en, NS, zh } from '../src/client/locales.ts'
import * as viewerBrand from '../src/client/viewer-brand.tsx'
import { VIEWER_BRAND_PRIORITY } from '../src/client/viewer-brand.tsx'

afterEach(cleanup)

/** Watch the slot ledger's entry errors while the viewer brand mounts. */
function watchEntryErrors(runtime: SlotTestRuntime) {
  const entryErrors: { key: string; message: string }[] = []
  const stop = runtime.slots.onEntryError((key, _registration, error) => {
    entryErrors.push({ key, message: error instanceof Error ? error.message : String(error) })
  })
  return { entryErrors, stop }
}

/**
 * A runtime whose declared brand slots the shipped plugins can fill at their default rank.
 * @returns The runtime and the shipped-brand mount.
 */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.register(NS, { en, zh })
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    'sidebar.brand.mark': { kind: 'single', scope: 'root' },
    'sidebar.brand.name': { kind: 'single', scope: 'root' },
  })
  // The shipped brand registers one entry per slot at the default rank, exactly as its plugin does.
  const mountShipped = async (): Promise<void> => {
    await runtime.mount({
      inject: ['slots'],
      apply(ctx: ClientContext) {
        ctx.slots.register({ name: 'sidebar.brand.mark' }, () => <span data-shipped="brand-mark">shipped mark</span>)
        ctx.slots.register({ name: 'sidebar.brand.name' }, () => <span data-shipped="brand-name">shipped name</span>)
      },
    })
  }
  return { runtime, mountShipped }
}

/** Both brand seats' ranks as the ledger holds them, defaulted the way the registry ranks a missing option. */
function brandRanks(runtime: SlotTestRuntime): { mark: number[]; name: number[] } {
  return {
    mark: runtime.slots.entries('sidebar.brand.mark').map(entry => entry.options.priority ?? 0),
    name: runtime.slots.entries('sidebar.brand.name').map(entry => entry.options.priority ?? 0),
  }
}

describe('viewer brand registration', () => {
  it('mounts the viewer brand over the shipped brand and renders the viewer entries', async () => {
    const { runtime, mountShipped } = await bench()
    const { entryErrors, stop } = watchEntryErrors(runtime)
    await mountShipped()
    const handle = await runtime.mount(viewerBrand)
    expect(entryErrors).toEqual([])

    const mark = runtime.renderSlot('sidebar.brand.mark', { size: 24 })
    const name = runtime.renderSlot('sidebar.brand.name', {})
    expect(mark.container.querySelector('[data-shipped="brand-mark"]')).toBeNull()
    expect(mark.container.querySelector('svg')).not.toBeNull()
    expect(name.container.querySelector('[data-shipped="brand-name"]')).toBeNull()
    expect(name.container.textContent).toContain(zh['viewer.brand'])

    // Both entries stay on the ledger: the viewer entry is the lower rank, the shipped entry is shadowed.
    expect(brandRanks(runtime)).toEqual({
      mark: [VIEWER_BRAND_PRIORITY, 0],
      name: [VIEWER_BRAND_PRIORITY, 0],
    })

    // A viewer unload restores the shipped brand: the shadow was a registration, not a removal.
    await handle.dispose()
    expect(await mark.view.findByText('shipped mark')).toBeTruthy()
    expect(await name.view.findByText('shipped name')).toBeTruthy()
    stop()
  })

  it('keeps the viewer entries when the viewer page mounts them before the shipped brand', async () => {
    const { runtime, mountShipped } = await bench()
    const { entryErrors, stop } = watchEntryErrors(runtime)
    await runtime.mount(viewerBrand)
    await mountShipped()
    expect(entryErrors).toEqual([])
    expect(brandRanks(runtime)).toEqual({
      mark: [VIEWER_BRAND_PRIORITY, 0],
      name: [VIEWER_BRAND_PRIORITY, 0],
    })
    const mark = runtime.renderSlot('sidebar.brand.mark', { size: 24 })
    expect(mark.container.querySelector('[data-shipped="brand-mark"]')).toBeNull()
    expect(mark.container.querySelector('svg')).not.toBeNull()
    stop()
  })

  it('states the shadow rank the shipped brand is replaced from', () => {
    expect(VIEWER_BRAND_PRIORITY).toBeLessThan(0)
  })
})
