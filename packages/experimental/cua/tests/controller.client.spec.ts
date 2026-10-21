/** Permission refreshes preserve observations and join user actions before withdrawal. */
import { setImmediate } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cua/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { CuaApplicationId, CuaApplicationState, CuaSystemPermissionState } from '../src/access-types.ts'
import { PermissionController } from '../src/client/controller.ts'

const value: CuaSystemPermissionState = { accessibility: true, screenRecording: false, helper: { pid: 9 }, parent: { pid: 8 } }
const applications: CuaApplicationState = {
  allowedApps: [], blockedApps: [], settingsNamespace: 'cua', persistentAvailable: true }
type CuaRemote = Context['remote']['cuaAccess']
function fixture() {
  const actions = {
    ptcConfiguration: vi.fn<CuaRemote['ptcConfiguration']>(async () => ({ ok: true, value: { persistent: false, writable: true } })),
    systemStatus: vi.fn<CuaRemote['systemStatus']>(async () => ({ ok: true, value })),
    applications: vi.fn<CuaRemote['applications']>(async () => ({ ok: true, value: applications })),
    applicationIcons: vi.fn<CuaRemote['applicationIcons']>(async () => ({ ok: true, value: {} })),
    requestPermission: vi.fn<CuaRemote['requestPermission']>(async () => ({ ok: true, value })),
    openSettings: vi.fn<CuaRemote['openSettings']>(async () => ({ ok: true, value: undefined })),
    revoke: vi.fn<CuaRemote['revoke']>(async () => ({ ok: true, value: undefined })),
    retryApproval: vi.fn<CuaRemote['retryApproval']>(async () => ({ ok: true, value: undefined })),
    enablePersistentPtc: vi.fn<CuaRemote['enablePersistentPtc']>(async () => ({ ok: true, value: undefined })),
  }
  const controller = new PermissionController(actions)
  return { actions, controller, face: controller.face() }
}

it('refreshes after a user request without treating the request itself as a grant', async () => {
  const f = fixture()
  f.face.request('screenRecording')
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.actions.requestPermission).toHaveBeenCalledWith('screenRecording')
  expect(f.controller.state.getSnapshot().system.value?.screenRecording).toBe(false)
  expect(f.controller.state.getSnapshot().toast?.kind).toBe('requested')
  f.face.dismissToast()
  expect(f.controller.state.getSnapshot().toast).toBeNull()
  await f.controller.dispose()
})

it('retains the last observation while marking a failed refresh', async () => {
  const f = fixture()
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().system.value).toEqual(value) })
  f.actions.systemStatus.mockRejectedValueOnce(new Error('connection closed'))
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().system.error).toBe('connection closed') })
  expect(f.controller.state.getSnapshot().system.value).toEqual(value)
  await f.controller.dispose()
})

it.each([new Error('write refused'), 'write refused'])('reports settings and revocation outcomes through the shared toast state', async (error) => {
  const f = fixture()
  f.face.openSettings('accessibility')
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().toast?.kind).toBe('opened') })
  f.face.revoke('a'.repeat(64) as CuaApplicationId)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().toast?.kind).toBe('revoked') })
  f.face.retryApproval('a'.repeat(64) as CuaApplicationId)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().toast?.kind).toBe('retryAllowed') })
  f.actions.revoke.mockRejectedValueOnce(error)
  f.face.revoke('a'.repeat(64) as CuaApplicationId)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().toast).toMatchObject({ kind: 'failed', message: 'write refused' }) })
  await f.controller.dispose()
})

it('joins a pending read without publishing after disposal or starting queued actions', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<CuaSystemPermissionState>()
  const entered = Promise.withResolvers<undefined>()
  f.actions.systemStatus.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    return { ok: true, value: await pending.promise }
  })
  f.face.refresh()
  await entered.promise
  f.face.request('accessibility')
  const before = f.controller.state.getSnapshot()
  const closed = f.controller.dispose()
  pending.resolve(value)
  await closed
  expect(f.controller.state.getSnapshot()).toBe(before)
  expect(f.actions.requestPermission).not.toHaveBeenCalled()
  f.face.refresh()
  expect(f.actions.systemStatus).toHaveBeenCalledOnce()
})

it('revokes access while icons are pending, serializes writes, and joins reads on disposal', async () => {
  const f = fixture(), icons = Promise.withResolvers<Record<string, string>>()
  const action = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(async () => { icons.resolve({}); action.resolve(undefined); await f.controller.dispose() })
  f.actions.applicationIcons.mockImplementationOnce(async () => ({ ok: true, value: await icons.promise }))
  f.actions.revoke.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await action.promise
    return { ok: true, value: undefined }
  })
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().applications.busy).toBe(false) })
  expect(f.controller.state.getSnapshot().icons.busy).toBe(true)
  f.face.revoke('a'.repeat(64) as CuaApplicationId)
  await entered.promise
  f.face.retryApproval('a'.repeat(64) as CuaApplicationId)
  await setImmediate()
  expect(f.actions.retryApproval).not.toHaveBeenCalled()
  action.resolve(undefined)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.actions.retryApproval).toHaveBeenCalledOnce()
  expect(f.controller.state.getSnapshot().toast?.kind).toBe('retryAllowed')
  const before = f.controller.state.getSnapshot()
  let disposed = false
  const closed = f.controller.dispose().then(() => { disposed = true })
  await setImmediate()
  expect(disposed).toBe(false)
  icons.resolve({ '/old/app': 'old-icon' })
  await closed
  expect(f.controller.state.getSnapshot()).toBe(before)
})

it('ignores stale toast completion after the permission UI is disposed', async () => {
  const f = fixture()
  f.face.request('accessibility')
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().toast?.kind).toBe('requested') })
  await f.controller.dispose()
  const before = f.controller.state.getSnapshot()
  f.face.dismissToast()
  f.controller.setChanging(false)
  f.face.refresh()
  expect(f.controller.state.getSnapshot()).toBe(before)
})

it.each(['success', 'failure'])('settles an in-flight action %s after disposal without publishing', async (outcome) => {
  const f = fixture(), pending = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(async () => { pending.resolve(undefined); await f.controller.dispose() })
  f.actions.requestPermission.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await pending.promise
    return { ok: true, value }
  })
  f.face.request('accessibility')
  await entered.promise
  const before = f.controller.state.getSnapshot(), closed = f.controller.dispose()
  if (outcome === 'failure') pending.reject(new Error('permission request ended after withdrawal'))
  else pending.resolve(undefined)
  await closed
  expect(f.controller.state.getSnapshot()).toBe(before)
  expect(f.actions.systemStatus).not.toHaveBeenCalled()
})

it('contains a late read rejection and supports errors without an Error instance', async () => {
  const f = fixture()
  f.actions.systemStatus.mockRejectedValueOnce('offline')
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().system.error).toBe('offline') })
  const pending = Promise.withResolvers<CuaSystemPermissionState>(), entered = Promise.withResolvers<undefined>()
  f.actions.systemStatus.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    return { ok: true, value: await pending.promise }
  })
  f.face.refresh()
  await entered.promise
  const before = f.controller.state.getSnapshot(), closed = f.controller.dispose()
  pending.reject(new Error('late disconnect'))
  await closed
  expect(f.controller.state.getSnapshot()).toBe(before)
})


it.each(['success', 'failure'])('does not publish an older refresh %s while the activation refresh is queued', async (outcome) => {
  const f = fixture()
  const first = Promise.withResolvers<CuaSystemPermissionState>(), firstEntered = Promise.withResolvers<undefined>()
  const latest = Promise.withResolvers<CuaSystemPermissionState>(), latestEntered = Promise.withResolvers<undefined>()
  onTestFinished(async () => { first.resolve(value); latest.resolve(value); await f.controller.dispose() })
  f.actions.systemStatus.mockImplementationOnce(async () => {
    firstEntered.resolve(undefined)
    return { ok: true, value: await first.promise }
  })
  f.actions.systemStatus.mockImplementationOnce(async () => {
    latestEntered.resolve(undefined)
    return { ok: true, value: await latest.promise }
  })
  const observations: Array<ReturnType<typeof f.controller.state.getSnapshot>> = []
  const unsubscribe = f.controller.state.subscribe(() => { observations.push(f.controller.state.getSnapshot()) })
  onTestFinished(unsubscribe)
  f.face.refresh()
  await firstEntered.promise
  f.face.refresh()
  if (outcome === 'failure') first.reject(new Error('provider is reloading'))
  else first.resolve({ ...value, screenRecording: true })
  await latestEntered.promise
  expect(observations.every(state => state.system.error === null && state.system.value === null && state.busy)).toBe(true)
  latest.resolve(value)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot()).toMatchObject({ busy: false, system: { error: null, value } }) })
  expect(observations.every(state => state.system.error === null)).toBe(true)
})

it('keeps a user-action failure visible when a refresh is queued behind it', async () => {
  const f = fixture(), action = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(async () => { action.resolve(undefined); await f.controller.dispose() })
  f.actions.requestPermission.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await action.promise
    return { ok: true, value }
  })
  f.face.request('accessibility')
  await entered.promise
  f.face.refresh()
  action.reject(new Error('permission request failed'))
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.controller.state.getSnapshot()).toMatchObject({ system: { value, error: null },
    toast: { kind: 'failed', message: 'permission request failed' } })
})


it.each(['success', 'failure'])('drops a permission read %s from the previous bundle activation', async (outcome) => {
  const f = fixture()
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  const pending = Promise.withResolvers<CuaSystemPermissionState>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(async () => { pending.resolve(value); await f.controller.dispose() })
  f.actions.systemStatus.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    return { ok: true, value: await pending.promise }
  })
  f.face.refresh()
  await entered.promise
  f.controller.setChanging(true)
  f.controller.setChanging(true)
  expect(f.controller.state.getSnapshot()).toMatchObject({ busy: true, system: { error: null, value } })
  f.face.request('accessibility')
  expect(f.actions.requestPermission).not.toHaveBeenCalled()
  if (outcome === 'failure') pending.reject(new Error('old helper stopped'))
  else pending.resolve({ ...value, screenRecording: true })
  await Promise.allSettled([pending.promise])
  expect(f.controller.state.getSnapshot()).toMatchObject({ busy: true, system: { error: null, value } })
  f.controller.setChanging(false)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.controller.state.getSnapshot()).toMatchObject({ system: { error: null, value } })
  expect(f.actions.systemStatus).toHaveBeenCalledTimes(3)
})

it.each(['success', 'failure'])('does not publish a user-action %s after its bundle is replaced', async (outcome) => {
  const f = fixture(), pending = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(async () => { pending.resolve(undefined); await f.controller.dispose() })
  f.actions.requestPermission.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await pending.promise
    return { ok: true, value }
  })
  f.face.request('accessibility')
  await entered.promise
  f.controller.setChanging(true)
  if (outcome === 'failure') pending.reject(new Error('old request cancelled'))
  else pending.resolve(undefined)
  f.controller.setChanging(false)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.controller.state.getSnapshot()).toMatchObject({ toast: null, system: { error: null, value } })
  expect(f.actions.systemStatus).toHaveBeenCalledOnce()
})

it('publishes each observation before the other queries finish', async () => {
  const f = fixture()
  const system = Promise.withResolvers<CuaSystemPermissionState>()
  const apps = Promise.withResolvers<CuaApplicationState>()
  const icons = Promise.withResolvers<Record<string, string>>()
  onTestFinished(async () => { system.resolve(value); apps.resolve(applications); icons.resolve({}); await f.controller.dispose() })
  f.actions.systemStatus.mockImplementationOnce(async () => ({ ok: true, value: await system.promise }))
  f.actions.applications.mockImplementationOnce(async () => ({ ok: true, value: await apps.promise }))
  f.actions.applicationIcons.mockImplementationOnce(async () => ({ ok: true, value: await icons.promise }))
  f.face.refresh()
  apps.resolve(applications)
  await vi.waitFor(() => {
    expect(f.controller.state.getSnapshot().applications).toEqual({ value: applications, error: null, busy: false })
  })
  expect(f.controller.state.getSnapshot().system).toMatchObject({ value: null, busy: true })
  system.resolve(value)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().system).toEqual({ value, error: null, busy: false }) })
  expect(f.controller.state.getSnapshot().icons).toMatchObject({ value: null, busy: true })
  icons.reject(new Error('icon unavailable'))
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.controller.state.getSnapshot()).toMatchObject({
    system: { value, error: null }, applications: { value: applications, error: null },
    icons: { value: null, error: 'icon unavailable', busy: false },
  })
})

it('keeps application decisions available when system inspection fails', async () => {
  const f = fixture()
  f.actions.systemStatus.mockRejectedValueOnce(new Error('helper offline'))
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.controller.state.getSnapshot()).toMatchObject({
    system: { value: null, error: 'helper offline' },
    applications: { value: applications, error: null, busy: false },
  })
  await f.controller.dispose()
})

it.each(['success', 'failure'])('drops old icon %s after disabling and reenabling the bundle', async (outcome) => {
  const f = fixture(), pending = Promise.withResolvers<Record<string, string>>()
  onTestFinished(async () => { pending.resolve({}); await f.controller.dispose() })
  f.actions.applicationIcons.mockImplementationOnce(async () => ({ ok: true, value: await pending.promise }))
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().system.busy).toBe(false) })
  f.controller.setChanging(true)
  f.controller.setChanging(false)
  if (outcome === 'success') pending.resolve({ '/old/app': 'old-icon' })
  else pending.reject(new Error('old helper stopped'))
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.controller.state.getSnapshot().icons).toEqual({ value: {}, error: null, busy: false })
})


it.each([
  ['ptcConfiguration', 'runtime'], ['systemStatus', 'system'],
  ['applications', 'applications'], ['applicationIcons', 'icons'],
] as const)('contains an unsuccessful %s response in its own query section', async (method, key) => {
  const f = fixture()
  onTestFinished(() => f.controller.dispose())
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  const previous = f.controller.state.getSnapshot()[key].value
  f.actions[method].mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'query refused', {}) })
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  expect(f.controller.state.getSnapshot()[key]).toEqual({ value: previous, busy: false, error: 'query refused' })
  expect(f.controller.state.getSnapshot().toast).toBeNull()
})

it.each(['requestPermission', 'openSettings', 'revoke', 'retryApproval'] as const)(
  'reports an unsuccessful %s response instead of a success notice', async (method) => {
    const f = fixture()
    onTestFinished(() => f.controller.dispose())
    f.actions[method].mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'action refused', {}) })
    if (method === 'requestPermission') f.face.request('accessibility')
    else if (method === 'openSettings') f.face.openSettings('accessibility')
    else f.face[method]('a'.repeat(64) as CuaApplicationId)
    await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
    expect(f.controller.state.getSnapshot().toast).toMatchObject({ kind: 'failed', message: 'action refused' })
    expect(f.actions.systemStatus).toHaveBeenCalledOnce()
  },
)


it('preserves settled failures and values while all four observations are paused', async () => {
  const f = fixture()
  const error = new Error('unavailable')
  f.actions.ptcConfiguration.mockRejectedValueOnce(error)
  f.actions.systemStatus.mockRejectedValueOnce(error)
  f.actions.applications.mockRejectedValueOnce(error)
  f.actions.applicationIcons.mockRejectedValueOnce(error)
  f.face.refresh()
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  f.controller.setChanging(true)
  for (const key of ['runtime', 'system', 'applications', 'icons'] as const) {
    expect(f.controller.state.getSnapshot()[key]).toMatchObject({ error: 'unavailable', busy: true })
  }
  f.face.refresh()
  expect(f.actions.systemStatus).toHaveBeenCalledOnce()
  f.controller.setChanging(false)
  await vi.waitFor(() => { expect(f.controller.state.getSnapshot().busy).toBe(false) })
  for (const key of ['runtime', 'system', 'applications', 'icons'] as const) {
    expect(f.controller.state.getSnapshot()[key].error).toBeNull()
  }
  await f.controller.dispose()
})
