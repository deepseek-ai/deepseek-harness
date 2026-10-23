/** Application decisions are checked at dispatch and revocation cancels owned work. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestions, { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ApplicationAuthorizationResult, ApplicationAccess } from '../src/application-access.ts'
import type { CuaApplicationGrant } from '../src/application-types.ts'
import type { CuaAppHandle } from '../src/types.ts'
import { NativeClient } from '../src/native-client.ts'

const native = vi.hoisted(() => ({ instances: [] as Array<{
  disposed: boolean
  request: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}> }))

vi.mock('../src/native-client.ts', async original => ({
  ...await original<typeof import('../src/native-client.ts')>(),
  NativeClient: class {
    disposed = false
    request = vi.fn(async (method: string) => method === 'openPermissionSettings' ? { opened: true }
      : { accessibility: false, screenRecording: false, helper: { pid: 9 }, parent: { pid: 8 } })
    invalidate() { this.disposed = true }
    dispose = vi.fn(async () => { this.disposed = true })
    constructor() { native.instances.push(this) }
  },
}))

const unusedConnector = () => { throw new Error('Mocked native client does not connect') }

const nativeConfig = { helperPath: '/fixture', cwd: '/', timeoutMs: 1000, connectTimeoutMs: 5000, screenshotTimeoutMs: 5000, axTimeoutMs: 100,
  maxRequestBytes: 4096, maxResponseBytes: 4096, graceMs: 100, textEventIntervalMs: 1, maxClickHoldMs: 5000 }
const identity = ApplicationAuthorizationResult.parse({ id: 'a'.repeat(64), name: 'Test application', executablePath: '/Applications/Fixture.app/Contents/MacOS/Fixture', persistable: true })
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
  const answer = vi.fn<(request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>>(async () => ({ answers: [{ id: 'cua-app-access', selected: [choice] }] }))
  ctx.on('user-questions/request', answer)
  let grants: readonly CuaApplicationGrant[] = options.initial ?? []
  const save = vi.fn(async (next: readonly CuaApplicationGrant[]) => { grants = next })
  let writable = options.writable !== false
  const access = new ApplicationAccess(ctx, { grants: () => grants, get save() { return writable ? save : undefined } })
  const client = new NativeClient(ctx, nativeConfig, unusedConnector)
  return { ctx, owner, agent: owner.agent, answer, save, access, client, grants: () => grants,
    setWritable(value: boolean) { writable = value },
  }
}

it('refuses raw handle dispatch until getApp obtains consent', async () => {
  const f = await setup()
  const dispatch = vi.fn(async () => null)
  await expect(f.access.run(f.client, handle, signal, dispatch)).rejects.toThrow('APP_ACCESS_REQUIRED')
  expect(dispatch).not.toHaveBeenCalled()
})

it.each([
  { persistable: true, writable: true, withIcon: true, offeredAlways: true },
  { persistable: false, writable: true, withIcon: false, offeredAlways: false },
  { persistable: true, writable: false, withIcon: true, offeredAlways: false },
])('describes fixed approval for %j', async ({ persistable, writable, withIcon, offeredAlways }) => {
  const f = await setup('Allow for this session', { writable })
  const icon = 'data:image/png;base64,aWNvbg=='
  await f.access.select(f.agent, f.client, handle, { ...identity, persistable }, signal, withIcon ? icon : undefined)
  const request = f.answer.mock.calls[0]![0]
  const question = request.questions[0]!
  expect(question).toMatchObject({
    id: 'cua-app-access',
    question: 'Allow computer use to launch if needed, read, capture, and control Test application?',
    detail: 'Session access lasts until DSH restarts or computer use is disabled.',
    intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny',
      subject: { name: 'Test application' }, display: {
        question: { en: 'Allow computer use to launch, read, capture and control this application?',
          zh: '允许 Computer Use 启动、读取、截图和控制此应用吗？',
          ja: 'Computer Use によるこのアプリの起動、読み取り、画面キャプチャ、操作を許可しますか？' },
        detail: { en: 'Session access lasts until DSH restarts or computer use is disabled.',
          zh: '会话授权在 DSH 重启或关闭 Computer Use 后失效。',
          ja: 'セッションの許可は DSH の再起動または Computer Use の無効化まで有効です。' },
        approve: { en: 'Allow for this session', zh: '本会话允许', ja: 'このセッションで許可',
          es: 'Permitir durante esta sesión', fr: 'Autoriser pour cette session', de: 'Für diese Sitzung zulassen',
          ru: 'Разрешить для этого сеанса', pt: 'Permitir nesta sessão' },
      },
    },
  })
  expect(question.options).toEqual(offeredAlways
    ? [{ label: 'Allow for this session' }, { label: 'Deny' }, { label: 'Always allow' }]
    : [{ label: 'Allow for this session' }, { label: 'Deny' }])
  if (offeredAlways) expect(question.intent).toHaveProperty('always', 'Always allow')
  else expect(question.intent).not.toHaveProperty('always')
  if (withIcon) expect(question.intent).toHaveProperty('subject.icon', icon)
  else expect(question.intent).not.toHaveProperty('subject.icon')
  expect(f.grants()).toEqual([])
})

it('reuses session consent across application handles and connections without saving it', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await expect(f.access.run(f.client, handle, signal, async () => 'read')).resolves.toBe('read')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  expect(f.answer).toHaveBeenCalledOnce()
  expect(f.save).not.toHaveBeenCalled()
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await expect(f.access.run(replacement, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
  await f.access.select(f.agent, replacement, 'fresh-app' as CuaAppHandle, identity, signal)
  await f.access.select(f.agent, replacement, 'restarted-app' as CuaAppHandle, identity, signal)
  expect(f.answer).toHaveBeenCalledOnce()
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
  await expect(f.access.run(replacement, 'restarted-app' as CuaAppHandle, signal, async () => 'read')).resolves.toBe('read')
})

it('does not repeatedly ask after an application is denied', async () => {
  const f = await setup('Deny')
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.answer).toHaveBeenCalledOnce()
  expect(f.grants()).toEqual([])
})

it('treats explicit question cancellation as a denial for the current task', async () => {
  const f = await setup()
  f.answer.mockRejectedValueOnce(new UserQuestionError('user cancelled', 'ASK_CANCELLED'))
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.answer).toHaveBeenCalledOnce()
})

it('preserves an unavailable answerer error without granting access', async () => {
  const f = await setup()
  f.answer.mockRejectedValueOnce(new UserQuestionError('no answerer', 'NO_PROVIDER'))
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('no answerer')
  f.answer.mockRejectedValueOnce(new Error('connection closed'))
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('connection closed')
  expect(f.grants()).toEqual([])
})

it('refuses a forged Always allow answer for an unsigned application', async () => {
  const f = await setup('Always allow')
  await expect(f.access.select(f.agent, f.client, handle, { ...identity, persistable: false }, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.save).not.toHaveBeenCalled()
})

it('reuses only saved signed identities when a task or helper is replaced', async () => {
  const { persistable: _persistable, ...grant } = identity
  const f = await setup('Deny', { initial: [grant] })
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(f.agent, replacement, handle, identity, signal)
  expect(f.answer).not.toHaveBeenCalled()
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
  await expect(f.access.run(replacement, handle, signal, async () => 'read')).resolves.toBe('read')
  const changed = { ...identity, id: 'b'.repeat(64) as typeof identity.id }
  await expect(f.access.select(f.agent, replacement, 'second' as CuaAppHandle, changed, signal)).rejects.toThrow('APP_ACCESS_DENIED')
})

it.each([
  { answers: [] },
  { answers: [{ id: 'another-question', selected: ['Allow for this session'] }] },
  { answers: [{ id: 'cua-app-access', selected: ['Allow for this session', 'Deny'] }] },
  { answers: [{ id: 'cua-app-access', selected: [], custom: 'Always allow' }] },
  { answers: [{ id: 'cua-app-access', selected: ['Allow for this session'], custom: 'different scope' }] },
])('does not interpret an incomplete or free-text answer as consent: %j', async (answer) => {
  const f = await setup()
  f.answer.mockResolvedValueOnce(answer)
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
})

it('keeps a persistence failure closed and permits an explicit later decision', async () => {
  const f = await setup('Always allow')
  f.save.mockRejectedValueOnce(new Error('write refused'))
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('write refused')
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  expect(f.grants()).toHaveLength(1)
})

it('merges a concurrently saved decision using the latest grant list', async () => {
  const f = await setup('Always allow')
  const answer = Promise.withResolvers<AskUserQuestionAnswer>()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  f.answer.mockImplementationOnce(() => { entered.resolve(); return answer.promise })
  const selected = f.access.select(f.agent, f.client, handle, identity, signal)
  await entered.promise
  await f.save([{ id: identity.id, name: 'Old label', executablePath: '/old' }])
  answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Always allow'] }] })
  await selected
  expect(f.grants()).toEqual([{ id: identity.id, name: identity.name, executablePath: identity.executablePath }])
})

it('refuses queued persistence when the profile writer disappears', async () => {
  const f = await setup('Always allow')
  const saving: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { release.resolve() })
  f.save.mockImplementationOnce(async () => { saving.resolve(); await release.promise })
  const first = f.access.select(f.agent, f.client, handle, identity, signal)
  await saving.promise
  const other = { ...identity, id: 'b'.repeat(64) as typeof identity.id }
  const second = f.access.select(f.agent, f.client, 'second' as CuaAppHandle, other, signal)
  const refused = expect(second).rejects.toThrow('cannot be saved')
  await vi.waitFor(() => { expect(f.answer).toHaveBeenCalledTimes(2) })
  await setImmediate()
  f.setWritable(false)
  release.resolve()
  await first
  await refused
  expect(f.save).toHaveBeenCalledOnce()
})

it('serializes duplicate application questions and rejects every waiting selection after denial', async () => {
  const f = await setup()
  const answer = Promise.withResolvers<AskUserQuestionAnswer>()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] }) })
  f.answer.mockImplementationOnce(() => { entered.resolve(); return answer.promise })
  const first = f.access.select(f.agent, f.client, handle, identity, signal)
  await entered.promise
  const second = f.access.select(f.agent, f.client, handle, identity, signal)
  const result = Promise.allSettled([first, second])
  answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] })
  for (const settled of await result) {
    expect(settled.status).toBe('rejected')
    if (settled.status === 'rejected') expect(String(settled.reason)).toContain('APP_ACCESS_DENIED')
  }
  expect(f.answer).toHaveBeenCalledOnce()
  await expect(f.access.run(f.client, handle, signal, async () => 'leaked access')).rejects.toThrow('APP_ACCESS_REQUIRED')
})

it('reuses one accepted question for duplicate selections', async () => {
  const f = await setup()
  const answer = Promise.withResolvers<AskUserQuestionAnswer>()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  onTestFinished(() => { answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] }) })
  f.answer.mockImplementationOnce(() => { entered.resolve(); return answer.promise })
  const first = f.access.select(f.agent, f.client, handle, identity, signal)
  await entered.promise
  const second = f.access.select(f.agent, f.client, 'another-handle' as CuaAppHandle, identity, signal)
  answer.resolve({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
  await Promise.all([first, second])
  expect(f.answer).toHaveBeenCalledOnce()
  await expect(f.access.run(f.client, handle, signal, async () => 'allowed')).resolves.toBe('allowed')
})

it('reports delegated approval as a main-task action without granting access', async () => {
  const f = await setup()
  f.answer.mockRejectedValueOnce(new UserQuestionError('ask_user_question is unavailable', 'DELEGATED_CALLER'))
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_APPROVAL_UNAVAILABLE')
  expect(f.grants()).toEqual([])
})

it('keeps another task allowed when the same application is denied in a new task', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const owner = await f.ctx.agents.create({ sessionId: SessionId('cua-task-denial') })
  const client = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  f.answer.mockResolvedValueOnce({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] })
  await expect(f.access.select(owner.agent, client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.client.disposed).toBe(false)
  await expect(f.access.run(f.client, handle, signal, async () => 'still allowed')).resolves.toBe('still allowed')
})

it('enforces a removed saved grant before its configuration notification arrives', async () => {
  const f = await setup('Always allow')
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await f.save([])
  const dispatch = vi.fn(async () => 'unauthorized input')
  await expect(f.access.run(f.client, handle, signal, dispatch)).rejects.toThrow('APP_ACCESS_REVOKED')
  expect(dispatch).not.toHaveBeenCalled()
  expect(f.client.disposed).toBe(true)
})

it('cancels native work when saved consent is removed from configuration', async () => {
  const f = await setup('Always allow')
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
  await f.save([])
  f.ctx.emit('loader/volatile-update', [['allowedApps']])
  f.ctx.emit('loader/volatile-update', [['allowedApps']])
  await rejected
  expect(f.client.disposed).toBe(true)
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REVOKED')
  await f.save([{ id: identity.id, name: identity.name, executablePath: identity.executablePath }])
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(f.agent, replacement, handle, identity, signal)
  await expect(f.access.run(f.client, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
  await expect(f.access.run(replacement, handle, signal, async () => 'fresh')).resolves.toBe('fresh')
  f.access.forget(f.agent)
  await expect(f.access.run(replacement, handle, signal, async () => null)).rejects.toThrow('APP_ACCESS_REQUIRED')
})

it('fails closed without a human answerer and never offers persistence without its owner', async () => {
  const f = await setup('Always allow', { writable: false, questions: false })
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_APPROVAL_UNAVAILABLE')
  await f.ctx.plugin(UserQuestions)
  await expect(f.access.select(f.agent, f.client, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.save).not.toHaveBeenCalled()
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
})

it('refuses closed helpers and forgets one task without removing another task', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const owner = await f.ctx.agents.create({ sessionId: SessionId('other-consented-task') })
  const other = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(owner.agent, other, handle, identity, signal)
  f.ctx.emit('loader/volatile-update', [['allowedApps']])
  f.access.forget(f.agent)
  await expect(f.access.run(other, handle, signal, async () => 'kept')).resolves.toBe('kept')
  other.invalidate()
  await expect(f.access.run(other, handle, signal, async () => null)).rejects.toThrow('NATIVE_CLOSED')
  await expect(f.access.select(owner.agent, other, handle, identity, signal)).rejects.toThrow('NATIVE_CLOSED')
})

it('keeps an active task operation running when a different task denies the same application', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<null>()
  const pending = f.access.run(f.client, handle, signal, async (operationSignal) => {
    entered.resolve(operationSignal)
    return release.promise
  })
  try {
    const operationSignal = await entered.promise
    const owner = await f.ctx.agents.create({ sessionId: SessionId('denying-task') })
    const other = new NativeClient(f.ctx, nativeConfig, unusedConnector)
    f.answer.mockResolvedValueOnce({ answers: [{ id: 'cua-app-access', selected: ['Deny'] }] })
    await expect(f.access.select(owner.agent, other, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
    expect(operationSignal.aborted).toBe(false)
    release.resolve(null)
    await expect(pending).resolves.toBeNull()
  } finally { release.resolve(null); await pending }
})


it.each(['Allow for this session', 'Deny'])('retains %s when the same session gets a new agent', async (choice) => {
  const f = await setup(choice)
  const select = f.access.select(f.agent, f.client, handle, identity, signal)
  if (choice === 'Deny') await expect(select).rejects.toThrow('APP_ACCESS_DENIED')
  else await select
  await f.owner.dispose()
  f.access.forget(f.agent)
  const owner = await f.ctx.agents.create({ sessionId: f.agent.id })
  const client = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  const resumed = f.access.select(owner.agent, client, handle, identity, signal)
  if (choice === 'Deny') await expect(resumed).rejects.toThrow('APP_ACCESS_DENIED')
  else {
    await resumed
    await expect(f.access.run(client, handle, signal, async () => 'resumed')).resolves.toBe('resumed')
  }
  expect(f.answer).toHaveBeenCalledOnce()
})

it('asks separately for another session and a changed application identity', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  const owner = await f.ctx.agents.create({ sessionId: SessionId('separate-session') })
  const client = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await f.access.select(owner.agent, client, handle, identity, signal)
  expect(f.answer).toHaveBeenCalledTimes(2)
  await f.access.select(f.agent, f.client, 'changed-app' as CuaAppHandle,
    { ...identity, id: 'b'.repeat(64) as typeof identity.id }, signal)
  expect(f.answer).toHaveBeenCalledTimes(3)
})

it('revokes session consent even after its agent and connection are released', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  f.access.forget(f.agent)
  await f.access.revoke(identity.id)
  const replacement = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await expect(f.access.select(f.agent, replacement, handle, identity, signal)).rejects.toThrow('APP_ACCESS_DENIED')
  expect(f.answer).toHaveBeenCalledOnce()
  f.access.retryApproval(identity.id)
  await f.access.select(f.agent, replacement, handle, identity, signal)
  expect(f.answer).toHaveBeenCalledTimes(2)
})

it('clears session consent when the provider is disabled and recreated', async () => {
  const f = await setup()
  await f.access.select(f.agent, f.client, handle, identity, signal)
  await f.access.dispose()
  const access = new ApplicationAccess(f.ctx, { grants: f.grants, save: f.save })
  const client = new NativeClient(f.ctx, nativeConfig, unusedConnector)
  await access.select(f.agent, client, handle, identity, signal)
  expect(f.answer).toHaveBeenCalledTimes(2)
})
