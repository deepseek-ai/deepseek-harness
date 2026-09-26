/** Workspace byte reads traverse Gateway lookup and Connection's binary RPC response. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import SessionStore from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { createWebConnectionRpc } from '@deepseek-ai/dsh-client-connection/src/client/rpc.ts'
import WorkspaceFiles, { type WorkspaceByteReadOptions } from '../src/index.ts'
import { openWorkspace, type Harness } from './harness.ts'

let harness: Harness
let rpc: ReturnType<typeof createWebConnectionRpc>

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-binary-rpc-')
  const ctx = harness.ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGateway)
  await ctx.plugin((scope) => { new HostConnectionService(scope, [], {} as BrowserAuth) })
  await ctx.plugin(WorkspaceFiles, { maxBytes: 8, maxFileBytes: 4, maxLines: 100, maxEntries: 100 })
  ctx.sessions.create(harness.scope.sessionId, { meta: { cwd: harness.workspace, origin: 'subagent' } })
  const handler = (ctx.get('connection') as HostConnectionService).createSharedFetchHandler('/api')
  rpc = createWebConnectionRpc(async (path, init) => handler.fetch(new Request(new URL(path, 'http://host'), init)))
})

afterEach(async () => {
  await harness.ctx.fiber.dispose()
  await harness.dispose()
})

function read(path: string, options: WorkspaceByteReadOptions, signal = new AbortController().signal) {
  return rpc.call('/api', 'workspaceFiles/readBytes', { args: { workspaceFileScopeId: harness.scope.sessionId, path, options } }, signal)
}

it('returns complete binary contents through the ordinary Remote endpoint', async () => {
  const data = new Uint8Array([0, 128, 255, 1])
  await writeFile(join(harness.workspace, '字节.bin'), data)
  expect(await read('字节.bin', {})).toMatchObject({ ok: true, value: { offset: 0, eof: true, bytes: 4, data } })
  expect(harness.ctx.get('agents')).toBeUndefined()
})

it.each([
  [{}, [0, 1, 2, 3, 4, 5, 6, 7], 0, false],
  [{ offset: 7, length: 8 }, [7, 8, 9], 7, true],
  [{ offset: 10 }, [], 10, true],
])('preserves range %j without reading the whole oversized file', async (range, data, offset, eof) => {
  await writeFile(join(harness.workspace, 'base.html'), 'base')
  await writeFile(join(harness.workspace, 'large.bin'), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
  const complete = vi.spyOn(harness.ctx.fs, 'readBytes')
  const window = vi.spyOn(harness.ctx.fs, 'readByteRange')
  expect(await read('large.bin', { baseFile: 'base.html', range })).toMatchObject({
    ok: true, value: { offset, eof, bytes: 10, data: new Uint8Array(data) },
  })
  expect(window).toHaveBeenCalledExactlyOnceWith(expect.anything(), { offset, length: 8 }, expect.any(AbortSignal))
  expect(complete).not.toHaveBeenCalled()
})

it('preserves full-file size failures and Gateway Session lookup failures', async () => {
  await writeFile(join(harness.workspace, 'large'), '12345')
  expect(await read('large', {})).toMatchObject({ ok: false, error: { code: 'workspace-file/too-large', details: { path: 'large', limit: 4 } } })
  expect(await rpc.call('/api', 'workspaceFiles/readBytes', { args: { workspaceFileScopeId: 'missing', path: 'large', options: {} } }))
    .toMatchObject({ ok: false, error: { code: 'gateway/lookup-not-found' } })
})

it.each([{}, { range: {} }])('propagates cancellation into the filesystem for options %j', async (options) => {
  await writeFile(join(harness.workspace, 'file'), 'data')
  const entered = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const abortable = async (signal: AbortSignal | undefined): Promise<Uint8Array> => {
    if (signal === undefined) throw new Error('read did not receive cancellation')
    entered.resolve(undefined)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
    })
  }
  if ('range' in options) vi.spyOn(harness.ctx.fs, 'readByteRange').mockImplementation((_target, _range, signal) => abortable(signal))
  else vi.spyOn(harness.ctx.fs, 'readBytes').mockImplementation((_target, signal) => abortable(signal))
  const failure = new Error('tab closed')
  const pending = read('file', options, controller.signal)
  const rejected = expect(pending).rejects.toBe(failure)
  try {
    await entered.promise
    controller.abort(failure)
    await rejected
  } finally {
    controller.abort(failure)
    await rejected
  }
})
