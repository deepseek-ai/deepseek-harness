/** The change summary route and the changed-file and common-folder native opens over the Host-served summaries. */
import { mkdtemp, rm, writeFile, mkdir, realpath, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionEventReadRequest } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPresentOpen } from '../src/present-open.ts'
import {
  changedFileUrl, changesDiffUrl, changesSummaryUrl, CHANGES_DIFF_PATH, CHANGES_OPEN_PATH, CHANGED_FILES_PATH, isChangedFile, isChangesDiff,
  isChangesEvent, isChangesSummary,
} from '../src/changes.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

const changed = (path: string, display = path): WorkspaceChangedFile => ({ path, display, added: 1, deleted: 0 })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-changes-open-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'src', 'lib'), { recursive: true })
  await writeFile(join(cwd, 'src', 'lib', 'a.ts'), 'a')
  await writeFile(join(cwd, 'src', 'b.ts'), 'b')
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'outside')
  const data: WorkspaceChangesSummary = {
    turn: 1, cwd, total: 3, added: 3, deleted: 0, snapshot: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
    files: [changed('src/lib/a.ts'), changed('src/b.ts'), changed(outside, '~/outside.txt')],
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd })
  ctx.provide('sandboxPolicy', { workspaceRoot: cwd } as never)
  await ctx.plugin({
    inject: ['fs', 'sandboxPolicy'],
    apply: (scope) => { new WorkspaceFiles(scope, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 }) },
  })
  const readEvent = vi.fn(async (_request: SessionEventReadRequest) => {
    throw new SessionQueryError('missing', 'SESSION_QUERY_EVENT_NOT_FOUND')
  })
  ctx.provide('sessionQuery', { readEvent } as never)
  const summary = vi.fn((sessionId: SessionId, seq: number) => sessionId === 'owner' && seq === 9 ? data : undefined)
  const comparison: WorkspaceFileDiff = {
    kind: 'text', path: 'src/lib/a.ts', display: 'src/lib/a.ts', before: true, after: true, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
  }
  const diff = vi.fn(async (sessionId: SessionId, seq: number, index: number, _signal: AbortSignal) =>
    sessionId === 'owner' && seq === 9 && index === 0 ? comparison : undefined)
  ctx.provide('workspaceChanges', { summary, diff })
  const opener = vi.fn(async (_request: { path: string; action?: 'reveal' }, _signal: AbortSignal) => ({ opened: true as const }))
  const applications = vi.fn(async () => [{ id: 'player', name: 'Player', default: true, icon: null }])
  ctx.provide('sessionController', { workspacePathApplications: applications, openWorkspacePath: opener, workspaceDesktop: () => ({ name: 'desktop', available: true, fileManager: 'finder' }) } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  await ctx.plugin({
    inject: ['connection', 'sessionQuery', 'sessionController', 'workspaceFiles', 'fs', 'sandboxPolicy', 'workspaceChanges'],
    apply: registerPresentOpen,
  })
  const handler = connection.createSharedFetchHandler('/api')
  const open = (query = '?sessionId=owner&seq=9&index=0') => handler.fetch(new Request(`http://localhost${CHANGES_OPEN_PATH}${query}`, { method: 'POST' }))
  const read = (query = '?sessionId=owner&seq=9') => handler.fetch(new Request(`http://localhost${CHANGED_FILES_PATH}${query}`))
  const compare = (query = '?sessionId=owner&seq=9&index=0') => handler.fetch(new Request(`http://localhost${CHANGES_DIFF_PATH}${query}`))
  return { handler, applications, root, cwd, ctx, data, readEvent, open, read, compare, comparison, diff, opener, outside, summary }
}

describe('change summary route', () => {
  it('serves the Host-held summary without its working directory, and 404 once it is gone', async () => {
    const { read, data, summary } = await fixture()
    expect(changesSummaryUrl(SessionId('owner'), 9)).toBe('api/changes.summary?sessionId=owner&seq=9')
    const response = await read()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    // The working directory and snapshot ids stay on the Host.
    expect(await response.json()).toEqual({ turn: 1, total: 3, added: 3, deleted: 0, files: data.files })
    expect((await read('?sessionId=owner&seq=8')).status).toBe(404)
    expect((await read('?sessionId=other&seq=9')).status).toBe(404)
    for (const bad of ['', '?seq=9', '?sessionId=owner', '?sessionId=owner&seq=x', '?sessionId=owner&seq=1.5']) {
      expect((await read(bad)).status).toBe(400)
    }
    expect(summary).toHaveBeenCalledTimes(3)
  })
})

describe('change comparison route', () => {
  it('serves the Host-computed comparison, 404 once it is gone, and 500 when the read fails', async () => {
    const { compare, comparison, diff } = await fixture()
    expect(changesDiffUrl(SessionId('owner'), 9, 0)).toBe('api/changes.diff?sessionId=owner&seq=9&index=0')
    const response = await compare()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(comparison)
    expect(diff).toHaveBeenLastCalledWith('owner', 9, 0, expect.any(AbortSignal))
    expect((await compare('?sessionId=owner&seq=9&index=1')).status).toBe(404)
    expect((await compare('?sessionId=owner&seq=8&index=0')).status).toBe(404)
    expect((await compare('?sessionId=other&seq=9&index=0')).status).toBe(404)
    for (const bad of ['', '?seq=9&index=0', '?sessionId=owner&seq=9', '?sessionId=owner&seq=9&index=-1', '?sessionId=owner&seq=x&index=0']) {
      expect((await compare(bad)).status).toBe(400)
    }
    diff.mockRejectedValueOnce(new Error('/private/objects'))
    const failed = await compare()
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('/private/objects')
  })

  it('validates served comparisons', () => {
    const text = { kind: 'text', path: 'a', display: 'a', before: true, after: false, coarse: true, hunks: [] }
    expect(isChangesDiff(text)).toBe(true)
    expect(isChangesDiff({ ...text, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-x', ' y', '+z'] }] })).toBe(true)
    expect(isChangesDiff({ kind: 'binary', path: 'a', display: 'a' })).toBe(true)
    expect(isChangesDiff({ kind: 'oversized', path: 'a', display: 'a' })).toBe(true)
    expect(isChangesDiff({ kind: 'other', path: 'a', display: 'a' })).toBe(false)
    expect(isChangesDiff({ kind: 'binary', path: '', display: 'a' })).toBe(false)
    expect(isChangesDiff({ ...text, before: 'yes' })).toBe(false)
    expect(isChangesDiff({ ...text, hunks: [{ oldStart: -1, oldLines: 1, newStart: 1, newLines: 0, lines: [] }] })).toBe(false)
    expect(isChangesDiff({ ...text, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['x'] }] })).toBe(false)
    expect(isChangesDiff({ ...text, hunks: [null] })).toBe(false)
    expect(isChangesDiff(null)).toBe(false)
  })
})

describe('changed files native open route', () => {
  it('opens a listed file inside or outside the workspace with its verified Host path', async () => {
    const { cwd, open, opener, outside } = await fixture()
    expect(changedFileUrl(SessionId('owner'), 9, 0)).toBe('api/changes.open?sessionId=owner&seq=9&index=0')
    const response = await open()
    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(opener).toHaveBeenLastCalledWith({ path: await realpath(join(cwd, 'src', 'lib', 'a.ts')) }, expect.any(AbortSignal))
    expect((await open('?sessionId=owner&seq=9&index=2')).status).toBe(204)
    expect(opener.mock.lastCall?.[0].path).toBe(await realpath(outside))
  })

  it.each(['', '?seq=9', '?sessionId=owner', '?sessionId=owner&seq=9', '?sessionId=owner&seq=9&index=-1', '?sessionId=owner&seq=9&index=1.5', '?sessionId=owner&seq=x'])(
    'rejects invalid coordinates before reading: %s', async (query) => {
      const { open, readEvent } = await fixture()
      expect((await open(query)).status).toBe(400)
      expect(readEvent).not.toHaveBeenCalled()
    })

  it('refuses unrelated Sessions, forgotten summaries, unknown indices, and missing files', async () => {
    const { open, readEvent, opener, cwd } = await fixture()
    expect((await open('?sessionId=other&seq=9&index=0')).status).toBe(404)
    expect((await open('?sessionId=owner&seq=8&index=0')).status).toBe(404)
    expect((await open('?sessionId=owner&seq=9&index=5')).status).toBe(404)
    expect(readEvent).not.toHaveBeenCalled()
    await unlink(join(cwd, 'src', 'lib', 'a.ts'))
    expect((await open()).status).toBe(404)
    expect(opener).not.toHaveBeenCalled()
  })

  it('refuses opening without a desktop or a verified Host mapping and reports launcher failures', async () => {
    const { ctx, open, opener } = await fixture()
    const desktop = vi.spyOn(ctx.sessionController, 'workspaceDesktop').mockReturnValue({ name: 'desktop', available: false, fileManager: null })
    expect((await open()).status).toBe(409)
    desktop.mockRestore()
    const mapping = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    expect((await open()).status).toBe(422)
    mapping.mockRestore()
    opener.mockRejectedValueOnce(new Error('/private/host/path'))
    const failed = await open()
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('/private/host/path')
    expect((await open()).status).toBe(204)
  })

  it('validates served summaries and logged announcements', () => {
    expect(isChangedFile({ path: 'a', display: 'a', added: 1, deleted: 2, binary: true })).toBe(true)
    expect(isChangedFile({ path: 'a', display: 'a', added: 1, deleted: 2, binary: false })).toBe(false)
    expect(isChangedFile({ path: 'a', display: 'a', added: 0, deleted: 0, oversized: true })).toBe(true)
    expect(isChangedFile({ path: 'a', display: 'a', added: 0, deleted: 0, oversized: 1 })).toBe(false)
    expect(isChangedFile({ path: '', display: 'a', added: 1, deleted: 2 })).toBe(false)
    expect(isChangedFile({ path: 'a', display: '', added: 1, deleted: 2 })).toBe(false)
    expect(isChangedFile({ path: 'a', display: 'a', added: 1.5, deleted: 2 })).toBe(false)
    expect(isChangedFile([])).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 0, added: 0, deleted: 0, files: [] })).toBe(true)
    expect(isChangesSummary({ turn: 1, total: 1, added: 1, deleted: 0, files: [{ path: 'a', display: 'a', added: 1, deleted: 0 }] })).toBe(true)
    expect(isChangesSummary({ turn: '1', total: 0, added: 0, deleted: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 0, total: 0, added: 0, deleted: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 1.5, added: 0, deleted: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 0, added: 0, deleted: 'x', files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 1, added: 1, deleted: 0, files: [{ path: 'a' }] })).toBe(false)
    expect(isChangesSummary([])).toBe(false)
    expect(isChangesEvent({ turn: 1 })).toBe(true)
    expect(isChangesEvent({ turn: 1, extra: true })).toBe(true)
    expect(isChangesEvent({ turn: 0 })).toBe(false)
    expect(isChangesEvent({ turn: '1' })).toBe(false)
    expect(isChangesEvent(null)).toBe(false)
  })
})


it('queries handlers only after file authorization and forwards explicit application choices', async () => {
  const { handler, applications, opener, open, ctx } = await fixture()
  const url = 'http://localhost/api/changes.open?sessionId=owner&seq=9&index=0'
  const response = await handler.fetch(new Request(url))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([{ id: 'player', name: 'Player', default: true, icon: null }])
  expect(opener).not.toHaveBeenCalled()
  expect((await open('?sessionId=owner&seq=9&index=0&application=player')).status).toBe(204)
  expect(opener.mock.lastCall?.[0]).toMatchObject({ application: 'player' })
  expect((await handler.fetch(new Request(url.replace('index=0', 'index=999')))).status).toBe(404)
  vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  expect((await handler.fetch(new Request(url))).status).toBe(422)
  expect(applications).toHaveBeenCalledOnce()
})


it('rejects an unsupported changed-file action before invoking the desktop', async () => {
  const { open, opener } = await fixture()
  expect((await open('?sessionId=owner&seq=9&index=0&action=remove')).status).toBe(400)
  expect(opener).not.toHaveBeenCalled()
})
