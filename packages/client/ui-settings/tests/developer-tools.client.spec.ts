/** Developer-tool choices share settings validation, persistence and accepted-state publication. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { stubConfigForm, TestRemote, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { DEVELOPER_TOOLS_NAMESPACE, DeveloperToolsSettingsSchema, type DeveloperToolsSettings } from '../src/developer-tools-settings.ts'
import { DeveloperToolsPreference } from '../src/client/developer-tools.ts'
import { apply as clientApply, inject } from '../src/client/index.ts'


describe('developer tools settings', () => {
  it('reports a refused Host write after recovering accepted state', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const describeCall = vi.fn().mockResolvedValue({ ok: true, value: {
      writable: true, hasDocument: true, namespaces: [{
        ns: DEVELOPER_TOOLS_NAMESPACE,
        schema: DeveloperToolsSettingsSchema.toJSON(),
        value: { enabled: false }, revision: 1, autoGenerate: true, applies: 'live', secrets: [],
      }],
    } })
    const mutate = vi.fn().mockResolvedValue({
      ok: false, error: new RemoteError('settings/rejected', 'conflict', { ns: DEVELOPER_TOOLS_NAMESPACE }),
    })
    new TestRemote(ctx, { settings: { describe: describeCall, mutate } })
    await ctx.plugin({ inject, apply: clientApply }).await()
    await ctx.configForms.describe().ensure()
    await expect(ctx.configForms.developerTools.setEnabled(true)).rejects.toThrow('not saved')
    expect(mutate).toHaveBeenCalledWith(DEVELOPER_TOOLS_NAMESPACE, [{ op: 'set', path: ['enabled'], value: true }], 1)
    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(ctx.configForms.developerTools.enabled.getSnapshot()).toBe(false)
  })

  it.each([false, true])('withholds features during a delayed Host read before accepting %s', async (enabled) => {
    const ctx = new Context()
    const accepted = { ok: true, value: {
      writable: true, hasDocument: true, namespaces: [{
        ns: DEVELOPER_TOOLS_NAMESPACE,
        schema: DeveloperToolsSettingsSchema.toJSON(),
        value: { enabled }, revision: 1, applies: 'live', secrets: [],
      }],
    } }
    const pending = Promise.withResolvers<typeof accepted>()
    onTestFinished(async () => { pending.resolve(accepted); await ctx.fiber.dispose() })
    new TestRemote(ctx, { settings: { describe: () => pending.promise } })
    await ctx.plugin({ inject, apply: clientApply }).await()
    const preference = ctx.configForms.developerTools
    const changed = vi.fn()
    const dispose = preference.enabled.subscribe(changed)
    onTestFinished(dispose)
    expect(preference.enabled.getSnapshot()).toBe(false)
    pending.resolve(accepted)
    await ctx.configForms.describe().ensure()
    expect(preference.enabled.getSnapshot()).toBe(enabled)
    expect(changed).toHaveBeenCalledTimes(enabled ? 1 : 0)
  })

  it('keeps features disabled when the initial Host read fails', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    new TestRemote(ctx, { settings: { describe: () => Promise.reject(new Error('disconnected')) } })
    await ctx.plugin({ inject, apply: clientApply }).await()
    await ctx.configForms.describe().ensure()
    expect(ctx.configForms.developerTools.enabled.getSnapshot()).toBe(false)
  })

  it('shares one remote-browser preference across consumers and disposes it with the plugin', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const describeCall = vi.fn()
    const remote = new TestRemote(ctx, { settings: { describe: describeCall } })
    remote.$host = { home: undefined, isLoopback: false }
    const fiber = ctx.plugin({ inject, apply: clientApply })
    await fiber.await()
    const preference = ctx.configForms.developerTools
    expect(fiber.ctx.configForms.developerTools.enabled).toBe(preference.enabled)
    expect(preference.enabled.getSnapshot()).toBe(true)
    await preference.setEnabled(true)
    expect(fiber.ctx.configForms.developerTools.enabled.getSnapshot()).toBe(true)
    expect(describeCall).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(ctx.get('configForms')).toBeUndefined()
  })
  it('stays off until accepted settings arrive, then follows a stored false and external changes', async () => {
    const host = stubConfigForm<DeveloperToolsSettings>()
    const preference = new DeveloperToolsPreference(host.scope)
    expect(preference.enabled.getSnapshot()).toBe(false)
    const notify = vi.fn()
    const dispose = preference.enabled.subscribe(notify)
    host.publish({ status: 'ready', value: { enabled: false } })
    expect(preference.enabled.getSnapshot()).toBe(false)
    expect(notify).not.toHaveBeenCalled()
    await preference.setEnabled(true)
    expect(host.set).toHaveBeenCalledWith('enabled', true)
    host.publish({ value: { enabled: true } })
    expect(preference.enabled.getSnapshot()).toBe(true)
    dispose()
  })
})

it('keeps remote browser choices local and publishes only changed values', async () => {
  const host = stubConfigForm<DeveloperToolsSettings>()
  host.publish({ mode: 'memory' })
  const preference = new DeveloperToolsPreference(host.scope)
  const notify = vi.fn()
  const dispose = preference.enabled.subscribe(notify)
  expect(preference.enabled.getSnapshot()).toBe(true)
  await preference.setEnabled(false)
  expect(preference.enabled.getSnapshot()).toBe(false)
  await preference.setEnabled(false)
  expect(notify).toHaveBeenCalledOnce()
  await preference.setEnabled(true)
  expect(preference.enabled.getSnapshot()).toBe(true)
  expect(notify).toHaveBeenCalledTimes(2)
  expect(host.set).not.toHaveBeenCalled()
  dispose()
})

it('ignores host revisions that do not change enablement', () => {
  const host = stubConfigForm<DeveloperToolsSettings>()
  const preference = new DeveloperToolsPreference(host.scope)
  const notify = vi.fn()
  const dispose = preference.enabled.subscribe(notify)
  host.publish({ revision: 1 })
  host.publish({ value: { enabled: false } })
  expect(notify).not.toHaveBeenCalled()
  host.publish({ value: { enabled: true } })
  expect(notify).toHaveBeenCalledOnce()
  dispose()
})

it('keeps an unavailable Host namespace disabled', () => {
  const host = stubConfigForm<DeveloperToolsSettings>()
  const preference = new DeveloperToolsPreference(host.scope)
  host.publish({ status: 'unavailable' })
  expect(preference.enabled.getSnapshot()).toBe(false)
})
