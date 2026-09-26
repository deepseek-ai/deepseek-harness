/** What the browser half registers, when, what refreshes the model catalogue, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { SubagentCardFace } from '../src/client/index.ts'
import { SubagentModelSelectionCardController } from '../src/client/subagent-model-selection-card-controller.ts'
import { apply as hostApply } from '../src/index.ts'

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/** @param served - namespaces the Host describes; omitted answers a failed read. */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const models = vi.fn(() => Promise.resolve({ ok: true as const, value: { groups: [], failures: [] } }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const remote = new TestRemote(ctx, {
    session: { modelCatalog: models },
    settings: { describe: describeSettings },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings, models, remote }
}

/** The Plugins page's item slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-subagent apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'configForms'])
  })

  it('registers one page for both namespaces while the Host serves either, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['subagent', 'subagent-model-selection-settings'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'subagent', order: 30 })
    expect(resolveSlotLabel(entry.options.label)).toBe('子智能体')
    expect(entry.locale).toBe(NS)
    const face = (entry.inject as () => Pick<SubagentCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks).sort()).toEqual(['subagentLimitsCard', 'subagentModelSelectionCard'])
  })

  it('registers the page when only the model namespace is served, and nothing when neither is', async () => {
    const { ctx, slots, describeSettings } = await bench(['subagent-model-selection-settings'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    await ctx.plugin({ inject: [...inject], apply }).dispose()
    expect(slots.entries('plugins.item')).toHaveLength(1)

    const other = await bench(['shell'])
    declareRoot(other.slots)
    await other.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(other.describeSettings).toHaveBeenCalled() })
    expect(other.slots.entries('plugins.item')).toHaveLength(0)
    expect(describeSettings).toHaveBeenCalled()
  })

  it('refreshes the model catalogue after model inputs change or the connection resets', async () => {
    const refresh = vi.spyOn(SubagentModelSelectionCardController.prototype, 'refreshCatalog')
    const reset = vi.spyOn(SubagentModelSelectionCardController.prototype, 'resetConnection')
    const { ctx, slots, remote } = await bench(['subagent-model-selection-settings'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    refresh.mockClear()
    reset.mockClear()

    remote.emit('llm/adapters-updated', [])
    expect(refresh).toHaveBeenCalledTimes(1)
    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    expect(refresh).toHaveBeenCalledTimes(2)
    ctx.emit('connection/reset')
    expect(reset).toHaveBeenCalledTimes(1)
    refresh.mockRestore()
    reset.mockRestore()
  })

  it('collapses the page on teardown', async () => {
    const { ctx, slots } = await bench(['subagent'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})
