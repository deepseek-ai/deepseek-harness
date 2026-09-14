/** Native delivery actions resolve the viewed Session's current workspace files. */
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionEventReadRequest } from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPresentOpen } from '../src/present-open.ts'
import { presentedFileUrl, PRESENT_OPEN_PATH } from '../src/presented.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-open-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const file = { path: '日记模板.docx' }
  await writeFile(join(cwd, file.path), Uint8Array.of(80, 75, 0, 255))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const session: { cwd?: string } = { cwd }
  await ctx.plugin(LocalFileSystem, { cwd })
  ctx.provide('sandboxPolicy', { workspaceRoot: cwd } as never)
  await ctx.plugin({
    inject: ['fs', 'sandboxPolicy'],
    apply: (scope) => { new WorkspaceFiles(scope, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 }) },
  })
  const resolveAgent = vi.fn<Context['sessionController']['resolveAgent']>(() => { throw new Error('Agent activation is unavailable') })
  const readEvent = vi.fn(async (request: SessionEventReadRequest) => {
    if (request.sessionId !== 'owner') throw new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')
    if (request.seq !== 7) throw new SessionQueryError('missing', 'SESSION_QUERY_EVENT_NOT_FOUND')
    return { session, target: { type: 'deliverables/presented', data: { turn: 1, callId: 'present-call', files: [file] } } as SessionEvent }
  })
  ctx.provide('sessionQuery', { readEvent } as never)
  const opener = vi.fn(async (_request: { path: string; action?: 'reveal' }, _signal: AbortSignal) => ({ opened: true as const }))
  ctx.provide('sessionController', { resolveAgent, openWorkspacePath: opener, workspaceDesktop: () => ({ name: 'desktop', available: true, fileManager: 'finder' }) } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: ['connection', 'sessionQuery', 'sessionController', 'workspaceFiles', 'fs', 'sandboxPolicy'], apply: registerPresentOpen })
  await fiber
  const handler = connection.createSharedFetchHandler('/api')
  const open = (query = '?sessionId=owner&seq=7&index=0', signal?: AbortSignal) => handler.fetch(new Request(
    `http://localhost${PRESENT_OPEN_PATH}${query}`, { method: 'POST', signal: signal ?? null },
  ))
  return { root, cwd, ctx, fiber, file, session, readEvent, open, opener, handler, resolveAgent }
}

describe('Presented workspace file native open route', () => {
  it('opens the source itself with current bytes and leaves it intact at disposal', async () => {
    const { cwd, open, file, fiber, opener, handler, ctx } = await fixture()
    const source = await realpath(join(cwd, file.path))
    expect(presentedFileUrl(SessionId('owner'), 7, 0)).toBe(`${PRESENT_OPEN_PATH}?sessionId=owner&seq=7&index=0`)
    expect((await handler.fetch(new Request(`http://localhost${PRESENT_OPEN_PATH}`))).status).toBe(404)
    expect((await handler.fetch(new Request('http://localhost/api/present.download?sessionId=owner&seq=7&index=0'))).status).toBe(404)
    for (const contents of ['current source', 'edited source']) {
      await writeFile(source, contents)
      const response = await open()
      expect(response.status).toBe(204)
      expect(response.headers.get('content-disposition')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(opener.mock.lastCall?.[0].path).toBe(source)
      expect(await readFile(opener.mock.lastCall![0].path, 'utf8')).toBe(contents)
    }
    expect(ctx.get('attachments')).toBeUndefined()
    await fiber.dispose()
    expect(await readFile(source, 'utf8')).toBe('edited source')
    expect((await open()).status).toBe(404)
  })

  it('resolves inherited declarations in the viewed fork workspace', async () => {
    const { root, file, readEvent, session, open, opener } = await fixture()
    const fork = join(root, 'fork')
    await mkdir(fork)
    await writeFile(join(fork, file.path), 'child source')
    session.cwd = fork
    readEvent.mockResolvedValueOnce({ session, target: { type: 'deliverables/presented', data: { turn: 1, callId: 'inherited', files: [file] } } as SessionEvent })
    expect((await open('?sessionId=fork&seq=7&index=0')).status).toBe(204)
    expect(opener.mock.lastCall?.[0].path).toBe(await realpath(join(fork, file.path)))
  })

  it.each(['', '?seq=7&index=0', '?sessionId=owner&index=0', '?sessionId=owner&seq=7',
    '?sessionId=owner&seq=-1&index=0', '?sessionId=owner&seq=7&index=0.1',
    '?sessionId=owner&seq=9007199254740992&index=0', '?sessionId=owner&seq=7&index=9007199254740992',
  ])('rejects invalid coordinates before reading: %s', async (query) => {
    const { open, readEvent } = await fixture()
    expect((await open(query)).status).toBe(400)
    expect(readEvent).not.toHaveBeenCalled()
  })

  it('refuses unrelated Sessions, absent events, and undeclared file indices', async () => {
    const { open, readEvent, session, opener } = await fixture()
    expect((await open('?sessionId=other&seq=7&index=0')).status).toBe(404)
    expect((await open('?sessionId=owner&seq=8&index=0')).status).toBe(404)
    expect((await open('?sessionId=owner&seq=7&index=1')).status).toBe(404)
    readEvent.mockResolvedValueOnce({ session, target: { type: 'turn/start' } as SessionEvent })
    expect((await open()).status).toBe(404)
    expect(opener).not.toHaveBeenCalled()
  })

  it.each([null, [], 'invalid', {}, { turn: 1, callId: 'call', files: null },
    { turn: 1, callId: 'call', files: [null] }, { turn: 1, callId: 'call', files: [{ path: '' }] },
    { turn: 1, callId: 'call', files: [{ path: 'a', description: 1 }] },
  ])('refuses malformed recorded delivery data: %j', async (data) => {
    const { open, readEvent, session, opener } = await fixture()
    readEvent.mockResolvedValueOnce({ session, target: { type: 'deliverables/presented', data } as unknown as SessionEvent })
    expect((await open()).status).toBe(404)
    expect(opener).not.toHaveBeenCalled()
  })

  it('reports removed files and directories without launching', async () => {
    const { cwd, file, open, opener } = await fixture()
    await unlink(join(cwd, file.path))
    expect((await open()).status).toBe(404)
    file.path = '.'
    expect((await open()).status).toBe(404)
    expect(opener).not.toHaveBeenCalled()
  })

  it('opens external regular files through absolute and relative paths but refuses final symlinks', async () => {
    const { root, cwd, file, open, opener } = await fixture()
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside')
    const source = join(cwd, file.path)
    await unlink(source)
    await symlink(outside, source)
    expect((await open()).status).toBe(404)
    expect(opener).not.toHaveBeenCalled()
    for (const path of ['../outside.txt', outside]) {
      file.path = path
      expect((await open()).status).toBe(204)
      expect(opener.mock.lastCall?.[0].path).toBe(await realpath(outside))
    }
  })

  it('reports query and launcher failures without leaking Host paths and allows retry', async () => {
    const { open, readEvent, opener } = await fixture()
    readEvent.mockRejectedValueOnce(new SessionQueryError('corrupt', 'SESSION_QUERY_CORRUPT_SESSION'))
    expect((await open()).status).toBe(500)
    opener.mockRejectedValueOnce(new Error('/private/host/path'))
    const response = await open()
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('/private/host/path')
    expect((await open()).status).toBe(204)
  })

  it('honors cancellation before lookup', async () => {
    const { open, readEvent } = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(open(undefined, controller.signal)).rejects.toThrow('cancelled')
    expect(readEvent).not.toHaveBeenCalled()
  })

  it('disposal aborts and awaits a pending native launch', async () => {
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { open, fiber, opener } = await fixture()
    opener.mockImplementation(async (_request, signal) => {
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(undefined)
      await release.promise
      signal.throwIfAborted()
      return { opened: true }
    })
    const request = open().catch((error: unknown) => error)
    await entered.promise
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await Promise.all([request, disposal])
  })
})


it('reports the serving desktop and reveals only an authorized declared source', async () => {
  const { cwd, file, open, opener, handler } = await fixture()
  const info = await handler.fetch(new Request('http://localhost/api/present.host'))
  expect(await info.json()).toEqual({ name: 'desktop', available: true, fileManager: 'finder' })
  expect((await open('?sessionId=owner&seq=7&index=0&action=reveal')).status).toBe(204)
  expect(opener).toHaveBeenCalledWith({ path: await realpath(join(cwd, file.path)), action: 'reveal' }, expect.any(AbortSignal))
  expect((await open('?sessionId=owner&seq=7&index=0&action=delete')).status).toBe(400)
  file.path = '..'
  expect((await open('?sessionId=owner&seq=7&index=0&action=reveal')).status).toBe(404)
  expect(opener).toHaveBeenCalledOnce()
})

it('refuses native actions when the configured Host desktop is unavailable', async () => {
  const { ctx, open, opener, handler } = await fixture()
  vi.spyOn(ctx.sessionController, 'workspaceDesktop').mockReturnValue({ name: 'desktop', available: false, fileManager: 'finder' })
  expect(await (await handler.fetch(new Request('http://localhost/api/present.host'))).json()).toMatchObject({ available: false })
  for (const action of ['open', 'reveal']) {
    expect((await open(`?sessionId=owner&seq=7&index=0&action=${action}`)).status).toBe(409)
  }
  expect(opener).not.toHaveBeenCalled()
})


it('refuses native opening without a matching Host mapping even when a same-name Host file exists', async () => {
  const { ctx, open, opener } = await fixture()
  const mapping = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  expect((await open()).status).toBe(422)
  mapping.mockReturnValue('/another-filesystem/file')
  expect((await open()).status).toBe(422)
  expect(opener).not.toHaveBeenCalled()
})

it('opens a viewed child Session without activating an Agent', async () => {
  const { session, readEvent, open, opener, resolveAgent } = await fixture()
  readEvent.mockResolvedValueOnce({ session, target: { type: 'deliverables/presented', data: { turn: 1, callId: 'child', files: [{ path: '日记模板.docx' }] } } as SessionEvent })
  expect((await open('?sessionId=child&seq=7&index=0')).status).toBe(204)
  expect(opener).toHaveBeenCalledOnce()
  expect(resolveAgent).not.toHaveBeenCalled()
})

it('uses the deployment workspace root when the viewed Session has no cwd', async () => {
  const { session, open, cwd, file, opener } = await fixture()
  delete session.cwd
  expect((await open()).status).toBe(204)
  expect(opener.mock.lastCall?.[0].path).toBe(await realpath(join(cwd, file.path)))
})
