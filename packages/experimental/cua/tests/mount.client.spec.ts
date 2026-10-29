/** The optional permission namespace and existing page slots share one disposal lifetime. */
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { CuaApplicationState, CuaSystemPermissionState } from '../src/access-types.ts'
import { expect, it, vi } from 'vitest'
import type { PermissionFace } from '../src/client/controller.ts'
import { mountCuaPermissions, inject } from '../src/client/mount.ts'
import type { ApplicationApprovalProps } from '../src/client/ApplicationApproval.tsx'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-cua', descriptors: [] }
const value: CuaApplicationState & { system: CuaSystemPermissionState } = {
  system: { accessibility: false, screenRecording: false, helper: { pid: 2 }, parent: { pid: 1 } },
  allowedApps: [], blockedApps: [], persistentAvailable: true }

function actionsOf(value: Record<string, unknown>): asserts value is Record<string, unknown> & PermissionFace {
  assert(typeof value.refresh === 'function' && typeof value.request === 'function' && typeof value.openSettings === 'function')
  assert(typeof value.revoke === 'function' && typeof value.dismissToast === 'function')
  assert(typeof value.retryApproval === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

async function fixture(fail = false) {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(received: TypertRemoteContribution) {
      expect(received).toBe(contribution)
      const owned = this.ctx.effect(() => unmount)
      return () => owned()
    }
  }
  new Remote()
  const changes = createSnapshotStore(false)
  ctx.provide('pluginChanges', { bundle: (name) => {
    expect(name).toBe('@deepseek-ai/dsh-cua-bundle')
    return changes
  } })
  const setDefault = vi.fn(async () => true)
  const setPersistent = vi.fn<() => Promise<RemoteResult<void>>>().mockResolvedValue({ ok: true, value: undefined })
  const runtimeConfiguration = vi.fn<() => Promise<RemoteResult<{ persistent: boolean; writable: boolean }>>>()
    .mockResolvedValue({ ok: true, value: { persistent: false, writable: true } })
  const preset = createSnapshotStore({ status: 'ready' as const, value: { default: 'standard' },
    base: {}, user: {}, revision: 1, writable: true })
  ctx.provide('configForms', { get: (namespace: string) => {
    expect(namespace).toBe('agent-preset-registry')
    return { ...preset, set: setDefault }
  } })
  const status = vi.fn<() => Promise<RemoteResult<CuaApplicationState>>>().mockResolvedValue({ ok: true, value })
  const systemStatus = vi.fn<() => Promise<RemoteResult<CuaSystemPermissionState>>>().mockResolvedValue({ ok: true, value: value.system })
  const applicationIcons = vi.fn<() => Promise<RemoteResult<Record<string, string>>>>().mockResolvedValue({ ok: true, value: {} })
  const requestPermission = vi.fn<() => Promise<RemoteResult<CuaSystemPermissionState>>>()
    .mockResolvedValue({ ok: true, value: value.system })
  const openSettings = vi.fn<() => Promise<RemoteResult<void>>>().mockResolvedValue({ ok: true, value: undefined })
  const revoke = vi.fn<() => Promise<RemoteResult<void>>>().mockResolvedValue({ ok: true, value: undefined })
  const retryApproval = vi.fn<() => Promise<RemoteResult<void>>>().mockResolvedValue({ ok: true, value: undefined })
  ctx.provide('remote.cuaAccess', {
    ptcConfiguration: runtimeConfiguration, enablePersistentPtc: setPersistent,
    applications: status, systemStatus, applicationIcons, requestPermission, openSettings, revoke, retryApproval })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    'conversation.composer': { kind: 'chain', scope: 'session' },
  } } as never, () => null)
  if (fail) vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot unavailable') })
  return { ctx, changes, unmount, status, systemStatus, applicationIcons,
    requestPermission, openSettings, revoke, retryApproval, setDefault, setPersistent, runtimeConfiguration,
  }
}

it('withdraws the permission Remote and all controls with the optional plugin', async () => {
  const f = await fixture()
  try {
    const fiber = f.ctx.plugin({ inject: [...inject], apply: ctx => mountCuaPermissions(ctx, contribution) })
    await fiber
    const approval = f.ctx.slots.entries('conversation.composer')[0]!
    const select = approval.select as (owner: { pendingInteraction: undefined }) => unknown
    expect(select({ pendingInteraction: undefined })).toBeNull()
    const presentation = approval.inject!() as Pick<ApplicationApprovalProps, 'resolveText'>
    expect(presentation.resolveText({ en: 'Localized', zh: 'Localized' })).toBe('Localized')
    const entry = f.ctx.slots.entries('plugins.bundle.config')[0]!
    const actions = entry.inject!()
    actionsOf(actions)
    actions.refresh()
    await vi.waitFor(() => { expect(actions.hooks.cuaPermissions.getSnapshot().applications.value).toEqual(value) })
    actions.request('accessibility')
    await vi.waitFor(() => { expect(actions.hooks.cuaPermissions.getSnapshot().toast?.kind).toBe('requested') })
    actions.openSettings('screenRecording')
    await vi.waitFor(() => { expect(actions.hooks.cuaPermissions.getSnapshot().toast?.kind).toBe('opened') })
    actions.revoke('a'.repeat(64) as import('../src/access-types.ts').CuaApplicationId)
    await vi.waitFor(() => { expect(actions.hooks.cuaPermissions.getSnapshot().toast?.kind).toBe('revoked') })
    actions.retryApproval('a'.repeat(64) as import('../src/access-types.ts').CuaApplicationId)
    await vi.waitFor(() => { expect(actions.hooks.cuaPermissions.getSnapshot().toast?.kind).toBe('retryAllowed') })
    const failed = { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
    for (const [target, invoke] of [
      [f.runtimeConfiguration, actions.refresh], [f.status, actions.refresh], [f.systemStatus, actions.refresh],
      [f.applicationIcons, actions.refresh], [f.requestPermission, () => { actions.request('accessibility') }],
      [f.openSettings, () => { actions.openSettings('accessibility') }],
      [f.revoke, () => { actions.revoke('a'.repeat(64) as import('../src/access-types.ts').CuaApplicationId) }],
      [f.retryApproval, () => { actions.retryApproval('a'.repeat(64) as import('../src/access-types.ts').CuaApplicationId) }],
    ] as const) {
      actions.refresh()
      await vi.waitFor(() => { expect(actions.hooks.cuaPermissions.getSnapshot().busy).toBe(false) })
      target.mockResolvedValueOnce(failed)
      invoke()
      await vi.waitFor(() => {
        const state = actions.hooks.cuaPermissions.getSnapshot()
        const error = target === f.runtimeConfiguration ? state.runtime.error : target === f.status ? state.applications.error
          : target === f.systemStatus ? state.system.error
            : target === f.applicationIcons ? state.icons.error : state.toast?.kind === 'failed' ? state.toast.message : null
        expect(error).toContain('offline')
      })
    }
    for (const name of ['plugins.bundle.activation', 'shell.overlay'] as const) {
      const other = f.ctx.slots.entries(name)[0]!
      const otherActions = other.inject!()
      actionsOf(otherActions)
      expect(otherActions.hooks.cuaPermissions).toBe(actions.hooks.cuaPermissions)
    }
    const settings = f.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()
    assert(typeof settings.setPtcDefault === 'function')
    expect(f.ctx.slots.entries('plugins.bundle.activation')[0]!.inject!()).not.toHaveProperty('setPtcDefault')
    expect(f.setDefault).not.toHaveBeenCalled()
    await (settings.setPtcDefault as () => Promise<boolean>)()
    expect(f.setDefault).toHaveBeenCalledExactlyOnceWith('selectedDefault', 'ptc')
    assert(typeof settings.setPersistentPtc === 'function')
    expect(f.ctx.slots.entries('plugins.bundle.activation')[0]!.inject!()).not.toHaveProperty('setPersistentPtc')
    expect(f.setPersistent).not.toHaveBeenCalled()
    await (settings.setPersistentPtc as () => Promise<boolean>)()
    expect(f.setPersistent).toHaveBeenCalledExactlyOnceWith()
    f.setPersistent.mockResolvedValueOnce(failed)
    await expect((settings.setPersistentPtc as () => Promise<boolean>)()).rejects.toThrow('offline')
    await fiber.dispose()
    expect(f.ctx.slots.entries('conversation.composer')).toHaveLength(0)
    expect(f.ctx.slots.entries('plugins.bundle.config')).toHaveLength(0)
    expect(f.ctx.slots.entries('shell.overlay')).toHaveLength(0)
    expect(f.unmount).toHaveBeenCalledOnce()
  } finally { await f.ctx.fiber.dispose() }
})

it('withdraws the Remote contribution when UI registration fails', async () => {
  const f = await fixture(true)
  try {
    await expect(mountCuaPermissions(f.ctx, contribution)).rejects.toThrow('slot unavailable')
    expect(f.unmount).toHaveBeenCalledOnce()
  } finally { await f.ctx.fiber.dispose() }
})

it.each(['plugin', 'root'])('keeps the Remote mounted until an accepted revoke completes during %s disposal', async (owner) => {
  const f = await fixture()
  const response = Promise.withResolvers<RemoteResult<void>>(), entered = Promise.withResolvers<undefined>()
  f.revoke.mockImplementationOnce(() => { entered.resolve(undefined); return response.promise })
  f.unmount.mockImplementation(async () => { response.resolve({ ok: false, error: new RemoteError('gateway/internal', 'unmounted', {}) }) })
  let closing: Promise<void> | undefined
  try {
    const fiber = await f.ctx.plugin({ inject: [...inject], apply: ctx => mountCuaPermissions(ctx, contribution) })
    const actions = f.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()
    actionsOf(actions)
    actions.revoke('a'.repeat(64) as import('../src/access-types.ts').CuaApplicationId)
    await entered.promise
    let closed = false
    closing = Promise.resolve(owner === 'plugin' ? fiber.dispose() : f.ctx.fiber.dispose()).then(() => { closed = true })
    await setImmediate()
    expect(f.unmount).not.toHaveBeenCalled()
    expect(closed).toBe(false)
    response.resolve({ ok: true, value: undefined })
    await closing
    expect(f.unmount).toHaveBeenCalledOnce()
  } finally {
    response.resolve({ ok: true, value: undefined })
    await closing
    await f.ctx.fiber.dispose()
  }
})

it('refreshes application storage on reconnect', async () => {
  const f = await fixture()
  try {
    await f.ctx.plugin({ inject: [...inject], apply: ctx => mountCuaPermissions(ctx, contribution) })
    f.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(f.status).toHaveBeenCalledOnce() })
  } finally { await f.ctx.fiber.dispose() }
})


it('resumes queries when a management operation settles without a mounted permission page', async () => {
  const f = await fixture()
  try {
    f.changes.set(true)
    const fiber = await f.ctx.plugin({ inject: [...inject], apply: ctx => mountCuaPermissions(ctx, contribution) })
    const actions = f.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()
    actionsOf(actions)
    expect(actions.hooks.cuaPermissions.getSnapshot().changing).toBe(true)
    actions.refresh()
    f.ctx.emit('connection/reset')
    await setImmediate()
    expect(f.status).not.toHaveBeenCalled()
    f.changes.set(false)
    await vi.waitFor(() => { expect(actions.hooks.cuaPermissions.getSnapshot().busy).toBe(false) })
    expect(f.status).toHaveBeenCalledOnce()
    f.changes.set(true)
    await fiber.dispose()
    f.changes.set(false)
    expect(f.status).toHaveBeenCalledOnce()
  } finally { await f.ctx.fiber.dispose() }
})
