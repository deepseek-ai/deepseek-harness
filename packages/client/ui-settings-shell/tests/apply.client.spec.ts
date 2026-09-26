/** What the browser half registers, when, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { ShellCardFace } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/**
 * @param served - namespaces the Host describes; omitted answers a failed read,
 * which leaves the page nothing to register for.
 */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const remote = new TestRemote(ctx, { settings: { describe: describeSettings } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings, remote }
}

/** The Plugins page's item slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-shell apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('registers the shell page while the Host serves the namespace, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['bash-sandbox', 'ui-theme'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'shell', order: 10 })
    expect(resolveSlotLabel(entry.options.label)).toBe('终端')
    expect(entry.locale).toBe(NS)
    const face = (entry.inject as () => Pick<ShellCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['shellCard'])
    expect(face.hooks.shellCard.getSnapshot()).toMatchObject({ available: false, dirty: false })
  })

  it('registers nothing while the namespace is not served, and follows the Host when that changes', async () => {
    // A deployment composing no POSIX or PowerShell executor serves neither executor entry.
    const { ctx, slots, describeSettings, remote } = await bench(['agent-loop'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    expect(slots.entries('plugins.item')).toHaveLength(0)

    describeSettings.mockResolvedValue({
      ok: true, value: { writable: true, hasDocument: true, namespaces: [view('bash-sandbox', 1)] },
    })
    remote.emit('settings/document-updated', ['bash-sandbox', 1])
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    describeSettings.mockResolvedValue({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
    remote.emit('settings/document-updated', ['bash-sandbox', 2])
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(0) })
  })

  it('binds the page to the PowerShell executor entry when that is the composed shell', async () => {
    const { ctx, slots } = await bench(['pwsh-sandbox'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const face = (slots.entries('plugins.item')[0]!.inject as () => Pick<ShellCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['shellCard'])
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench(['bash-sandbox'])
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
  })

  it('collapses the page on teardown', async () => {
    const { ctx, slots } = await bench(['bash-sandbox'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})
