/** Application decisions are checked at dispatch and revocation cancels owned work. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestions, { type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ApplicationAuthorizationResult, installCuaAccess } from '../src/access.ts'
import type { CuaApplicationGrant } from '../src/access-types.ts'
import type { CuaAppHandle } from '../src/types.ts'
import { NativeClient } from '../src/native-client.ts'
import { permissionFixture } from './permission-fixture.ts'

const native = vi.hoisted(() => ({ instances: [] as Array<{
  disposed: boolean
  request: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}> }))

vi.mock('../src/native-client.ts', async original => ({
  ...await original<typeof import('../src/native-client.ts')>(),
  NativeClient: class {
    disposed = false
    request = vi.fn(async (method: string) => method === 'openPermissionSettings' ? { opened: true }
      : method === 'applicationIcons' ? {} : { accessibility: false, screenRecording: false, helper: { pid: 9 }, parent: { pid: 8 } })
    invalidate() { this.disposed = true }
    dispose = vi.fn(async () => { this.disposed = true })
    constructor() { native.instances.push(this) }
  },
}))

const unusedConnector = () => { throw new Error('Mocked native client does not connect') }

const nativeConfig = { helperPath: '/fixture', cwd: '/', timeoutMs: 1000, connectTimeoutMs: 5000, screenshotTimeoutMs: 5000, axTimeoutMs: 100,
  maxRequestBytes: 4096, maxResponseBytes: 4096, graceMs: 100, textEventIntervalMs: 1, maxClickHoldMs: 5000 }
const executablePath = '/Applications/Fixture.app/Contents/MacOS/Fixture'
const identity = ApplicationAuthorizationResult.parse({ id: 'a'.repeat(64), name: 'Test application', executablePath, persistable: true })
const handle = 'fixture-app' as CuaAppHandle
const signal = new AbortController().signal

async function setup(choice = 'Allow for this session', options: { writable?: boolean; questions?: boolean; initial?: readonly CuaApplicationGrant[] } = {}) {
  native.instances.length = 0
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  if (options.questions !== false) await ctx.plugin(UserQuestions)
  const owner = await ctx.agents.create({ sessionId: SessionId('cua-access-test') })
  const answer = vi.fn<() => Promise<AskUserQuestionAnswer>>(async () => ({ answers: [{ id: 'cua-app-access', selected: [choice] }] }))
  ctx.on('user-questions/request', answer)
  const permissions = permissionFixture(ctx, options.initial, options.writable)
  const access = installCuaAccess(ctx, { native: nativeConfig, createChannel: unusedConnector, store: permissions.store })
  const client = new NativeClient(ctx, nativeConfig, unusedConnector)
  return { ctx, owner, agent: owner.agent, answer, access, client, ...permissions }
}

it('requires another user decision after the permission page permits asking again', async () => {
  const f = await setup('Deny')
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect((await f.ctx.cuaAccess.applications()).blockedApps).toHaveLength(1)
  await f.ctx.cuaAccess.retryApproval(identity.id)
  expect((await f.ctx.cuaAccess.applications()).blockedApps).toEqual([])
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
  f.answer.mockResolvedValueOnce({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
  const retryClient = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(f.agent, retryClient, handle, identity, signal)
  expect(f.answer).toHaveBeenCalledTimes(2)
  await f.ctx.cuaAccess.revoke(identity.id)
  await f.ctx.cuaAccess.retryApproval(identity.id)
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
})

it('persists a reusable identity and revokes it before further dispatch', async () => {
  const f = await setup('Always allow')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  expect(f.grants()).toEqual([{ id: identity.id, name: identity.name, executablePath: identity.executablePath }])
  await f.ctx.cuaAccess.revoke(identity.id)
  expect(f.grants()).toEqual([])
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REVOKED')
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
})

it('joins an in-flight native operation when application access is revoked', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const entered = Promise.withResolvers<undefined>()
  const pending = f.access.run(f.client, handle, signal, async (operationSignal) => {
    const done = Promise.withResolvers<null>()
    operationSignal.addEventListener('abort', () => { done.reject(new Error('native cancelled')) }, { once: true })
    entered.resolve(undefined)
    return done.promise
  })
  const rejected = expect(pending).rejects.toThrow('APP_ACCESS_DENIED')
  await entered.promise
  await f.ctx.cuaAccess.revoke(identity.id)
  await rejected
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REVOKED')
})

it.each(['revoke', 'dispose'] as const)('waits for native cancellation to finish during %s', async (action) => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const entered = Promise.withResolvers<AbortSignal>(), cancelled = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const pending = f.access.run(f.client, handle, signal, async (operationSignal) => {
    operationSignal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
    entered.resolve(operationSignal)
    await release.promise
  })
  const rejected = expect(pending).rejects.toThrow()
  const operationSignal = await entered.promise
  let finished = false
  const closing = (action === 'revoke' ? f.ctx.cuaAccess.revoke(identity.id) : f.access.dispose())
    .then(() => { finished = true })
  try {
    await cancelled.promise
    await setImmediate()
    expect(operationSignal.aborted).toBe(true)
    expect(finished).toBe(false)
    release.resolve(undefined)
    await closing
    await rejected
    expect(finished).toBe(true)
  } finally {
    release.resolve(undefined)
    await Promise.all([closing, rejected])
  }
})

it('fails closed without a human answerer and never offers persistence without its owner', async () => {
  const f = await setup('Always allow', { writable: false, questions: false })
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_APPROVAL_UNAVAILABLE')
  await f.ctx.plugin(UserQuestions)
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.save).not.toHaveBeenCalled()
  expect((await f.ctx.cuaAccess.applications()).persistentAvailable).toBe(false)
})

it('projects task decisions, observes live config removal, and forgets a disposed task', async () => {
  const f = await setup('Always allow')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toHaveLength(1)
  await f.save([])
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REVOKED')
  await f.owner.dispose()
  f.access.forget(f.agent)
})

it('refuses to promise revocation of a saved decision without persistence', async () => {
  const { persistable: _persistable, ...grant } = identity
  const f = await setup('Deny', { initial: [grant], writable: false })
  await expect(f.ctx.cuaAccess.revoke(identity.id)).rejects.toThrow('cannot be saved')
  expect(f.grants()).toEqual([grant])
})

it('checks native permissions without converting an OS request into a grant', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const before = (await f.ctx.cuaAccess.applications())
  expect(before).toEqual({ allowedApps: [], blockedApps: [], persistentAvailable: true })
  expect(await f.ctx.cuaAccess.systemStatus()).toMatchObject({ accessibility: false, screenRecording: false })
  expect(await f.ctx.cuaAccess.requestPermission('accessibility')).toMatchObject({ accessibility: false })
  await f.ctx.cuaAccess.openSettings('screenRecording')
  const transport = native.instances[1]!
  expect(transport.request).toHaveBeenCalledWith('openPermissionSettings', { permission: 'screenRecording' }, expect.any(AbortSignal))
  transport.request.mockRejectedValueOnce(new Error('transport ended'))
  await expect(f.ctx.cuaAccess.systemStatus()).rejects.toThrow('transport ended')
  transport.disposed = true
  expect((await f.ctx.cuaAccess.systemStatus()).screenRecording).toBe(false)
  expect(transport.dispose).toHaveBeenCalledOnce()
  await f.access.dispose()
  await expect(f.ctx.cuaAccess.systemStatus()).rejects.toThrow()
  await expect(f.ctx.cuaAccess.revoke(identity.id)).rejects.toThrow()
})

it('does not open a replacement control connection after provider disposal begins', async () => {
  const f = await setup()
  await f.ctx.cuaAccess.systemStatus()
  const control = native.instances.at(-1)!
  control.disposed = true
  const released = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(() => { released.resolve(undefined) })
  control.dispose.mockImplementationOnce(async () => { entered.resolve(undefined); await released.promise })
  const pending = f.ctx.cuaAccess.systemStatus()
  const rejected = expect(pending).rejects.toThrow()
  await entered.promise
  const count = native.instances.length
  const closing = f.access.dispose()
  released.resolve(undefined)
  await Promise.all([closing, rejected])
  expect(native.instances).toHaveLength(count)
})


it('isolates other tasks and applications while revoking and forgetting one decision', async () => {
  const f = await setup()
  const owner = await f.ctx.agents.create({ sessionId: SessionId('another-cua-task') })
  const otherClient = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  const other = { ...identity, id: 'b'.repeat(64) as typeof identity.id }
  const otherHandle = 'other-app' as CuaAppHandle
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await f.access.select(f.agent, f.client, otherHandle, other, signal)
  await f.access.select(owner.agent, otherClient, otherHandle, other, signal)
  await f.ctx.cuaAccess.retryApproval(identity.id)
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { release.resolve() })
  const continuing = f.access.run(otherClient, otherHandle, signal, async (operationSignal) => {
    started.resolve()
    await release.promise
    return !operationSignal.aborted
  })
  await started.promise
  await f.ctx.cuaAccess.revoke(identity.id)
  release.resolve()
  expect(await continuing).toBe(true)
  f.access.forget(f.agent)
  await expect(f.access.run(otherClient, otherHandle, signal, async () => 'still allowed')).resolves.toBe('still allowed')
  await owner.dispose()
})

it('removes a grant whose save is already pending when another task revokes the application', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const owner = await f.ctx.agents.create({ sessionId: SessionId('cua-concurrent-save') })
  const client = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { release.resolve() })
  const save = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await save(...args) })
  f.answer.mockResolvedValueOnce({ answers: [{ id: 'cua-app-access', selected: ['Always allow'] }] })
  const selection = f.access.select(owner.agent, client, handle, identity, signal)
  const settledSelection = Promise.allSettled([selection])
  await entered.promise
  const revoked = f.ctx.cuaAccess.revoke(identity.id)
  release.resolve()
  await revoked
  await settledSelection
  expect(f.grants()).toEqual([])
  expect(f.save).toHaveBeenCalledTimes(2)
  expect(client.disposed).toBe(true)
  expect(f.client.disposed).toBe(true)
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await expect(f.access.select(owner.agent, replacement, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
})

it('keeps revoked helper handles invalid after the application is approved again', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await f.ctx.cuaAccess.revoke(identity.id)
  expect(f.client.disposed).toBe(true)
  await f.ctx.cuaAccess.retryApproval(identity.id)
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('NATIVE_CLOSED')
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  const replacementHandle = 'replacement-app' as CuaAppHandle
  await f.access.select(f.agent, replacement, replacementHandle, identity, signal)
  const oldDispatch = vi.fn(async () => 'stale window')
  await expect(f.access.run(f.client, handle, signal, oldDispatch)).rejects.toThrow('APP_ACCESS_REQUIRED')
  expect(oldDispatch).not.toHaveBeenCalled()
  await expect(f.access.run(replacement, replacementHandle, signal, async () => 'fresh window')).resolves.toBe('fresh window')
})

it('projects restored persistent grants without showing the same application as blocked', async () => {
  const f = await setup('Deny')
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  const { persistable: _persistable, ...grant } = identity
  await f.save([grant])
  expect((await f.ctx.cuaAccess.applications()).blockedApps).toEqual([])
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(f.agent, replacement, handle, identity, signal)
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toEqual([grant])
  expect(f.answer).toHaveBeenCalledOnce()
})

it('keeps access revoked when stopping the helper reports a cleanup failure', async () => {
  const f = await setup('Always allow')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  vi.spyOn(f.client, 'dispose').mockRejectedValueOnce(new Error('process range did not exit'))
  await expect(f.ctx.cuaAccess.revoke(identity.id)).rejects.toThrow('helper cleanup failed')
  expect(f.grants()).toEqual([])
  expect(f.client.disposed).toBe(true)
  const dispatch = vi.fn(async () => 'unexpected input')
  await expect(f.access.run(f.client, handle, signal, dispatch)).rejects.toThrow('APP_ACCESS_REVOKED')
  expect(dispatch).not.toHaveBeenCalled()
})

it('rejects an answer for a helper that exits while the human question is pending', async () => {
  const f = await setup()
  const answer = Promise.withResolvers<AskUserQuestionAnswer>()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] }) })
  f.answer.mockImplementationOnce(() => { entered.resolve(); return answer.promise })
  const selected = f.access.select(f.agent, f.client, handle, identity, signal)
  const rejected = expect(selected).rejects.toThrow('NATIVE_CLOSED')
  await entered.promise
  f.client.invalidate()
  answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
  await rejected
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(f.agent, replacement, handle, identity, signal)
  expect(f.answer).toHaveBeenCalledTimes(2)
})

it('keeps other session grants after revocation while requiring fresh native handles', async () => {
  const f = await setup()
  const other = { ...identity, id: 'b'.repeat(64) as typeof identity.id }
  const otherHandle = 'other-application' as CuaAppHandle
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await f.access.select(f.agent, f.client, otherHandle, other, signal)
  await f.ctx.cuaAccess.revoke(identity.id)
  await expect(f.access.run(f.client, otherHandle, signal, async () => 'old handle')).rejects.toThrow('NATIVE_CLOSED')
  const state = (await f.ctx.cuaAccess.applications())
  expect(state.blockedApps.map(app => app.id)).toEqual([identity.id])
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(f.agent, replacement, otherHandle, other, signal)
  await expect(f.access.run(replacement, otherHandle, signal, async () => 'new handle')).resolves.toBe('new handle')
  expect(f.answer).toHaveBeenCalledTimes(2)
})

it('does not let a stale revoked task invalidate another task after a saved grant is restored', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await f.ctx.cuaAccess.revoke(identity.id)
  const { persistable: _persistable, ...grant } = identity
  await f.save([grant])
  const owner = await f.ctx.agents.create({ sessionId: SessionId('cua-restored-grant') })
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(owner.agent, replacement, handle, identity, signal)
  await expect(f.access.run(f.client, handle, signal, async () => 'stale')).rejects.toThrow('APP_ACCESS_REVOKED')
  expect(replacement.disposed).toBe(false)
  await expect(f.access.run(replacement, handle, signal, async () => 'restored')).resolves.toBe('restored')
})

it('offers fixed approval actions with native metadata while keeping icons out of saved grants', async () => {
  const f = await setup('Always allow')
  const ask = vi.spyOn(f.ctx.userQuestions, 'ask')
  const icon = 'data:image/png;base64,aWNvbg=='
  await f.access.select(f.agent, f.client, handle, identity, signal, icon)
  expect(ask.mock.calls[0]?.[0].questions[0]?.intent).toMatchObject({
    kind: 'approval', approve: 'Allow for this session', reject: 'Deny', always: 'Always allow',
    subject: { name: identity.name, icon },
  })
  expect(f.grants()).toEqual([{ id: identity.id, name: identity.name, executablePath: identity.executablePath }])
})

it('reads application decisions without native work and retrieves icons separately', async () => {
  const f = await setup('Always allow')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toEqual(f.grants())
  expect(native.instances).toHaveLength(1)
  await f.ctx.cuaAccess.systemStatus()
  const control = native.instances.at(-1)!
  const pending = Promise.withResolvers<Record<string, string>>()
  onTestFinished(() => { pending.resolve({}) })
  control.request.mockReturnValueOnce(pending.promise)
  const icons = f.ctx.cuaAccess.applicationIcons()
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toEqual(f.grants())
  pending.resolve({ [executablePath]: 'data:image/png;base64,aWNvbg==' })
  expect(await icons).toEqual({ [executablePath]: 'data:image/png;base64,aWNvbg==' })
  expect(f.grants()[0]).not.toHaveProperty('icon')
})

it('skips native icon work for an empty application list and propagates icon failures independently', async () => {
  const f = await setup()
  expect(await f.ctx.cuaAccess.applicationIcons()).toEqual({})
  expect(native.instances).toHaveLength(1)
  await f.access.select(f.agent, f.client, handle, identity, signal)
  expect(await f.ctx.cuaAccess.applicationIcons()).toEqual({})
  expect(native.instances).toHaveLength(1)
  await f.save([{ id: identity.id, name: identity.name, executablePath: identity.executablePath }])
  await f.ctx.cuaAccess.systemStatus()
  native.instances.at(-1)!.request.mockRejectedValueOnce(new Error('icons unavailable'))
  await expect(f.ctx.cuaAccess.applicationIcons()).rejects.toThrow('icons unavailable')
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toHaveLength(1)
  expect((await f.ctx.cuaAccess.systemStatus()).accessibility).toBe(false)
})

it('keeps pathless grants manageable without requesting their icons', async () => {
  const grant = { id: identity.id, name: identity.name }
  const f = await setup('Always allow', { initial: [grant] })
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toEqual([grant])
  expect(await f.ctx.cuaAccess.applicationIcons()).toEqual({})
  expect(native.instances).toHaveLength(1)
  expect(native.instances[0]!.request).not.toHaveBeenCalled()
  await f.ctx.cuaAccess.revoke(identity.id)
  expect((await f.ctx.cuaAccess.applications()).allowedApps).toEqual([])
})

it('preserves captured launch metadata separately from the current helper parent', async () => {
  const f = await setup()
  await f.ctx.cuaAccess.systemStatus()
  const control = native.instances.at(-1)!
  const launchApplication = { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app', icon: 'data:image/png;base64,aWNvbg==' }
  control.request.mockResolvedValueOnce({ accessibility: false, screenRecording: false,
    helper: { pid: 9 }, parent: { pid: 1, path: '/sbin/launchd' }, launchApplication })
  expect(await f.ctx.cuaAccess.systemStatus()).toMatchObject({ parent: { pid: 1 }, launchApplication })
})


it('omits session-only grants from the permission page and retains their access after another session saves a grant', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const other = { ...identity, id: 'b'.repeat(64) as typeof identity.id, name: 'Another application', executablePath: '/Applications/Other.app' }
  await f.access.select(f.agent, f.client, 'other-application' as CuaAppHandle, other, signal)
  expect((await f.ctx.cuaAccess.applications())).toEqual({ allowedApps: [], blockedApps: [], persistentAvailable: true })
  const owner = await f.ctx.agents.create({ sessionId: SessionId('cua-always-allow') })
  const client = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  f.answer.mockResolvedValueOnce({ answers: [{ id: 'cua-app-access', selected: ['Always allow'] }] })
  await f.access.select(owner.agent, client, handle, identity, signal)
  const state = (await f.ctx.cuaAccess.applications())
  expect(state.allowedApps.map(app => app.id)).toEqual([identity.id])
  expect(state.blockedApps).toEqual([])
  await expect(f.access.run(f.client, handle, signal, async () => 'still allowed')).resolves.toBe('still allowed')
})

it.each(['function-body', 'repl', 'script'] as const)('enables retention for effective %s semantics with one profile edit', async (programFormat) => {
  const f = await setup()
  expect(f.ctx.cuaAccess.ptcConfiguration()).toEqual({ persistent: false, writable: false })
  await expect(f.ctx.cuaAccess.enablePersistentPtc()).rejects.toThrow('no editable profile entry')
  const entry = { options: { id: 'ptc-runtime' } }
  const runtime = { programFormat, retainsState: false }
  const edit = vi.fn(async (received: object, change: (current: Record<string, unknown>) => Record<string, unknown>) => {
    expect(received).toBe(entry)
    // Effective mode can come from a lower profile; a stale local flag must be replaced.
    expect(change({ timeoutMs: 4200, scriptPersistence: true })).toEqual({
      timeoutMs: 4200, executionMode: programFormat === 'script' ? 'vm-script' : 'persistent-in-memory',
      scriptPersistence: programFormat === 'script',
    })
    runtime.retainsState = true
  })
  f.ctx.provide('ptcRuntime', runtime)
  f.ctx.provide('configEditor', { entries: () => [entry], edit })
  expect(f.ctx.cuaAccess.ptcConfiguration()).toEqual({ persistent: false, writable: true })
  expect(edit).not.toHaveBeenCalled()
  await f.ctx.cuaAccess.enablePersistentPtc()
  expect(f.ctx.cuaAccess.ptcConfiguration()).toEqual({ persistent: true, writable: true })
  await f.ctx.cuaAccess.enablePersistentPtc()
  expect(edit).toHaveBeenCalledOnce()
})

it('rejects invalid application identities before a permission file or native handle can be touched', async () => {
  const f = await setup()
  const invalid = '../another-profile' as import('../src/application-types.ts').CuaApplicationId
  await expect(f.ctx.cuaAccess.revoke(invalid)).rejects.toThrow()
  await expect(f.ctx.cuaAccess.retryApproval(invalid)).rejects.toThrow()
  expect(f.save).not.toHaveBeenCalled()
  expect(f.client.disposed).toBe(false)
})

it('does not reactivate old handles when stored permission was revoked and later restored', async () => {
  const f = await setup('Always allow')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await f.save([])
  await f.save([{ id: identity.id, name: identity.name, executablePath: identity.executablePath }])
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.client.disposed).toBe(true)
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(f.agent, replacement, handle, identity, signal)
  expect(f.answer).toHaveBeenCalledOnce()
})
