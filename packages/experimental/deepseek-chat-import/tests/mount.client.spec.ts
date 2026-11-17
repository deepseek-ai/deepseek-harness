// @vitest-environment jsdom
/** The Remote namespace and the sidebar action leave with the plugin; imports check limits, upload, then always refresh. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { DeepseekChatImportInjected } from '../src/client/ImportSessions.tsx'
import { inject, mountImport } from '../src/client/mount.ts'
import type { UploadAnswer } from '../src/client/upload.ts'
import type { DeepseekChatImportLimits, DeepseekChatImportResult } from '../src/types.ts'

const upload = vi.hoisted(() => ({ answer: { ok: false, transport: 'unset' } as UploadAnswer }))
vi.mock('../src/client/upload.ts', () => ({
  uploadArchive: vi.fn(() => Promise.resolve(upload.answer)),
}))
const { uploadArchive } = await import('../src/client/upload.ts')

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-deepseek-chat-import', descriptors: [] }
const W1 = 'w1' as WorkspaceId
const RESULT: DeepseekChatImportResult = {
  workspaceId: 'w1', workspacePath: '/home/a/project', sessionIds: ['s1'], conversationCount: 1, omittedByLimit: 0, skipped: [],
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.mocked(uploadArchive).mockClear()
  vi.doUnmock('@deepseek-ai/dsh-deepseek-chat-import/remote')
})

async function fixture(
  limits: RemoteResult<DeepseekChatImportLimits> = { ok: true, value: { maxUploadBytes: 8 } },
  refreshed: () => Promise<void> = () => Promise.resolve(),
) {
  const ctx = new Context()
  contexts.push(ctx)
  const unmount = vi.fn(() => Promise.resolve())
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    $mount(value: TypertRemoteContribution) { expect(value).toBe(contribution); return Promise.resolve(unmount) }
  }
  new TestRemote()
  const refresh = vi.fn(refreshed)
  ctx.provide('remote.deepseekChatImport', { limits: vi.fn((_signal?: AbortSignal) => Promise.resolve(limits)) } as never)
  ctx.provide('sessions', { refresh } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: { 'sidebar.session.action': { kind: 'hoc', scope: 'root' } } } as never, () => null)
  return { ctx, unmount, refresh }
}

function importFace(value: Record<string, unknown>): asserts value is Record<string, unknown> & DeepseekChatImportInjected {
  assert(typeof value.importArchive === 'function')
}

function injected(ctx: Context): DeepseekChatImportInjected {
  const entry = ctx.slots.entries('sidebar.session.action')[0]
  assert(entry !== undefined && typeof entry.inject === 'function')
  const face = entry.inject()
  importFace(face)
  return face
}

const file = (bytes: number) => new File([new Uint8Array(bytes)], 'deepseek_data.zip')
const run = (ctx: Context, bytes = 4) => injected(ctx).importArchive(file(bytes), W1, () => {}, new AbortController().signal)
const answer = (value: UploadAnswer) => { upload.answer = value }

it('uploads within the limit, refreshes the Session list, and withdraws both contributions', async () => {
  const b = await fixture()
  const dispose = await mountImport(b.ctx, contribution)
  expect(b.ctx.slots.spec('sidebar.session.action')).toEqual({ kind: 'hoc', scope: 'root' })
  expect(b.ctx.slots.entries('sidebar.session.action').map(entry => [entry.options.id, entry.locale]))
    .toEqual([['deepseek-chat-import', 'deepseekChatImport']])
  answer({ ok: true, value: RESULT })
  expect(await run(b.ctx)).toEqual({ ok: true, result: RESULT })
  expect(uploadArchive).toHaveBeenCalledWith(expect.any(File), W1, expect.any(Function), expect.any(AbortSignal))
  expect(b.refresh).toHaveBeenCalledOnce()
  expect(b.ctx.locale.bind('deepseekChatImport')('action.label')).toBe('Import DeepSeek chats')
  await dispose()
  expect(b.ctx.slots.entries('sidebar.session.action')).toEqual([])
  expect(b.unmount).toHaveBeenCalledOnce()
})

it('reduces limit, size, transport, and import failures and refreshes the Session list after each', async () => {
  const b = await fixture()
  await mountImport(b.ctx, contribution)
  expect(await run(b.ctx, 9)).toEqual({ ok: false, reason: 'too-large', message: 'the file exceeds 8 bytes', limit: 8 })
  expect(uploadArchive).not.toHaveBeenCalled()
  answer({ ok: false, transport: 'the upload connection failed' })
  expect(await run(b.ctx)).toEqual({ ok: false, reason: 'upload-failed', message: 'the upload connection failed' })
  answer({ ok: false, error: { reason: 'missing-manifest', message: 'the archive has no manifest.json' } })
  // Only the browser's own pre-check knows a trustworthy byte limit.
  expect(await run(b.ctx)).toEqual({ ok: false, reason: 'missing-manifest', message: 'the archive has no manifest.json' })
  const entryLimit = 'manifest.json declares 268435456 uncompressed bytes, more than the 268435456-byte entry limit'
  answer({ ok: false, error: { reason: 'too-large', message: entryLimit } })
  expect(await run(b.ctx)).toEqual({ ok: false, reason: 'too-large', message: entryLimit })
  expect(b.refresh).toHaveBeenCalledTimes(4)
  const failing = await fixture({ ok: false, error: new RemoteError('gateway/internal', 'transport lost', {}) })
  await mountImport(failing.ctx, contribution)
  expect(await run(failing.ctx)).toEqual({ ok: false, reason: 'unknown', message: 'transport lost' })
  expect(failing.refresh).toHaveBeenCalledOnce()
})

it('keeps the outcome when the list refresh fails and refreshes after a thrown upload', async () => {
  const b = await fixture(undefined, () => Promise.reject(new Error('list offline')))
  await mountImport(b.ctx, contribution)
  const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
  answer({ ok: true, value: RESULT })
  expect(await run(b.ctx)).toEqual({ ok: true, result: RESULT })
  expect(warn).toHaveBeenCalledWith('deepseek-chat-import: session list refresh failed', new Error('list offline'))
  vi.mocked(uploadArchive).mockRejectedValueOnce(new Error('xhr unavailable'))
  await expect(run(b.ctx)).rejects.toThrow('xhr unavailable')
  expect(b.refresh).toHaveBeenCalledTimes(2)
})

it('loads the browser entry through its generated Remote contribution', async () => {
  const b = await fixture()
  vi.doMock('@deepseek-ai/dsh-deepseek-chat-import/remote', () => ({ default: contribution }))
  const browser = await import('../src/client/index.ts')
  expect(browser.inject).toEqual(inject)
  const fiber = b.ctx.plugin({ inject: [...browser.inject], apply: browser.apply })
  await fiber
  expect(b.ctx.slots.entries('sidebar.session.action')).toHaveLength(1)
  await fiber.dispose()
  expect(b.ctx.slots.entries('sidebar.session.action')).toEqual([])
  expect(b.unmount).toHaveBeenCalledOnce()
})
