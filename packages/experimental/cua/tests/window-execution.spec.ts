/** Window and launch admission use the live permission store at every dispatch. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NativeClient } from '../src/native-client.ts'
import { ApplicationAccess, ApplicationAuthorizationResult } from '../src/application-access.ts'
import { CuaWindowExecution } from '../src/window-execution.ts'
import { WindowRequest } from '../src/window-protocol.ts'
import { permissionFixture } from './permission-fixture.ts'

const mocked = vi.hoisted(() => ({ request: vi.fn<NativeClient['request']>() }))
vi.mock('../src/native-client.ts', async original => ({
  ...await original<typeof import('../src/native-client.ts')>(),
  NativeClient: class {
    disposed = false
    request = mocked.request
    invalidate() { this.disposed = true }
    async dispose() { this.disposed = true }
  },
}))
const identity = ApplicationAuthorizationResult.parse({ id: 'a'.repeat(64), name: 'Document', executablePath: 'C:\\Editor.exe', persistable: false })
async function setup(choice = 'Allow for this session') {
  mocked.request.mockReset()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(UserQuestions)
  const owner = await ctx.agents.create({ sessionId: SessionId('window-admission') })
  const answer = vi.fn(async () => ({ answers: [{ id: 'cua-app-access', selected: [choice] }] }))
  ctx.on('user-questions/request', answer)
  const { store } = permissionFixture(ctx)
  const access = new ApplicationAccess(ctx, { store })
  const client = new NativeClient(ctx, { helperPath: '/fixture', cwd: '/', timeoutMs: 1000, connectTimeoutMs: 1000,
    screenshotTimeoutMs: 1000, axTimeoutMs: 100, maxRequestBytes: 4096, maxResponseBytes: 4096, graceMs: 100,
    textEventIntervalMs: 0, maxClickHoldMs: 5000 }, () => { throw new Error('Mock client must not connect') })
  const windows = new CuaWindowExecution()
  const dispatch = vi.fn<(request: import('../src/types.ts').CuaOperation, signal: AbortSignal) => Promise<unknown>>(async () => ({ dispatched: true, verified: false }))
  const run = (method: string, params: object = {}) => windows.run(WindowRequest.parse({ method, params }),
    owner.agent, client, access, new AbortController().signal, undefined, 20, dispatch)
  return { access, run, dispatch, answer }
}
it('obtains window consent before input and checks revocation before subsequent input', async () => {
  const f = await setup()
  mocked.request.mockResolvedValueOnce([{ appHandle: 'window-a', windowId: 7, pid: 10, authorization: identity }])
  await expect(f.run('getWindows', { ids: [7] })).resolves.toEqual([{ windowHandle: 'window-a', windowId: 7, pid: 10 }])
  expect(f.answer).toHaveBeenCalledOnce()
  await f.run('click', { windowHandle: 'window-a', x: 1, y: 2, relative: true })
  expect(f.dispatch).toHaveBeenCalledWith({ method: 'click', params: { appHandle: 'window-a', windowId: 7, x: 1, y: 2, relative: true } }, expect.any(AbortSignal))
  await f.access.revoke(identity.id)
  await expect(f.run('typeText', { windowHandle: 'window-a', text: 'must not arrive' })).rejects.toThrow('APP_ACCESS_REVOKED')
  expect(f.dispatch).toHaveBeenCalledOnce()
})
it('does not dispatch a denied launch or grant window access from launch consent', async () => {
  const f = await setup('Deny')
  mocked.request.mockResolvedValueOnce({ appHandle: 'launch-a', authorization: identity })
  await expect(f.run('launch', { target: 'shell-entry' })).rejects.toThrow('APP_ACCESS_DENIED')
  expect(mocked.request).toHaveBeenCalledOnce()
  await expect(f.run('typeText', { windowHandle: 'launch-a', text: 'blocked' })).rejects.toThrow('WINDOW_ACCESS_REQUIRED')
  expect(f.dispatch).not.toHaveBeenCalled()
})
it('launches only after approval and returns no fabricated window', async () => {
  const f = await setup()
  mocked.request.mockResolvedValueOnce({ appHandle: 'launch-a', authorization: identity })
    .mockResolvedValueOnce({ dispatched: true, verified: false })
  await expect(f.run('launch', { target: 'shell-entry' })).resolves.toEqual({ dispatched: true, verified: false })
  expect(mocked.request.mock.calls.map(([method]) => method)).toEqual(['prepareLaunch', 'dispatchLaunch'])
  await expect(f.run('getState', { windowHandle: 'launch-a' })).rejects.toThrow('WINDOW_ACCESS_REQUIRED')
})
it('rejects duplicate IDs and mismatched native selections before asking for consent', async () => {
  const f = await setup()
  await expect(f.run('getWindows', { ids: [7, 7] })).rejects.toThrow('INVALID_ARGUMENT')
  expect(mocked.request).not.toHaveBeenCalled()
  mocked.request.mockResolvedValueOnce([{ appHandle: 'other', windowId: 8, pid: 10, authorization: identity }])
  await expect(f.run('getWindows', { ids: [7] })).rejects.toThrow('NATIVE_PROTOCOL')
  expect(f.answer).not.toHaveBeenCalled()
})

it('discovers without permission and preserves both Shell and explicit-path metadata', async () => {
  const f = await setup()
  await expect(f.run('getCapabilities')).resolves.toEqual({ dispatched: true, verified: false })
  mocked.request.mockResolvedValueOnce([])
  await expect(f.run('listWindows')).resolves.toEqual([])
  const entries = [{ id: 'shell', displayName: 'Settings', kind: 'shell' },
    { id: 'exe', displayName: 'Editor', kind: 'executable', path: 'C:\\Editor.exe' }]
  mocked.request.mockResolvedValueOnce(entries)
  await expect(f.run('findApps', { query: 'e' })).resolves.toEqual(entries)
  expect(mocked.request).toHaveBeenLastCalledWith('findApps', { query: 'e', maxAppMatches: 20 }, expect.any(AbortSignal), undefined)
  expect(f.answer).not.toHaveBeenCalled()
})
it('returns only the selected observation and rejects changes of handle, PID or window', async () => {
  const f = await setup()
  mocked.request.mockResolvedValueOnce([{ appHandle: 'window-a', windowId: 7, pid: 10, authorization: identity }])
  await f.run('getWindows', { ids: [7] })
  const state = { appHandle: 'window-a', pid: 10, windowId: 7, tree: 'AX' }
  f.dispatch.mockResolvedValueOnce(state)
  await expect(f.run('getState', { windowHandle: 'window-a' })).resolves.toEqual({ windowHandle: 'window-a', pid: 10, windowId: 7, tree: 'AX' })
  for (const change of [{ appHandle: 'other' }, { pid: 11 }, { windowId: 8 }]) {
    f.dispatch.mockResolvedValueOnce({ ...state, ...change })
    await expect(f.run('getState', { windowHandle: 'window-a' })).rejects.toThrow('NATIVE_PROTOCOL')
  }
  for (const [method, params] of [
    ['show', {}], ['screenshot', {}],
    ['drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }],
    ['click', { elementId: '1', snapshotId: 's1' }],
    ['typeText', { text: 'hello' }],
  ] as const) {
    await f.run(method, { windowHandle: 'window-a', ...params })
    const operation = f.dispatch.mock.calls.at(-1)![0]
    expect(operation.params).toMatchObject({ appHandle: 'window-a', ...params })
    if (method === 'show' || method === 'screenshot' || method === 'drag') expect(operation.params).toHaveProperty('windowId', 7)
    else expect(operation.params).not.toHaveProperty('windowId')
  }
})
it('rejects incomplete selection and reused native handles before consent', async () => {
  const f = await setup()
  mocked.request.mockResolvedValueOnce([])
  await expect(f.run('getWindows', { ids: [7] })).rejects.toThrow('NATIVE_PROTOCOL')
  mocked.request.mockResolvedValueOnce([7, 8].map(windowId => ({ appHandle: 'same', windowId, pid: 10, authorization: identity })))
  await expect(f.run('getWindows', { ids: [7, 8] })).rejects.toThrow('NATIVE_PROTOCOL')
  expect(f.answer).not.toHaveBeenCalled()
})
