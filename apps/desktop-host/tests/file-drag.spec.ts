import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { localDragResource } from '../src/file-drag.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-drag-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SessionStore)
  ctx.provide('sandboxPolicy', { workspaceRoot: root } as never)
  const id = SessionId('file-drag-test')
  ctx.sessions.create(id, { meta: { cwd: root, origin: 'subagent' } })
  const path = join(root, '报告.pdf')
  const bytes = Buffer.from('%PDF-1.4\n原始内容\n%%EOF')
  await writeFile(path, bytes)
  return { ctx, root, id, path, bytes, address: sessionFileAddress(id, '报告.pdf') }
}

it('authorizes Session-relative file reads and returns their original digest privately to main', async () => {
  const f = await fixture()
  expect(await localDragResource(f.ctx, f.address)).toEqual({
    path: await realpath(f.path), size: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex'),
  })
})

it('rejects unscoped references and missing Sessions', async () => {
  const f = await fixture()
  await expect(localDragResource(f.ctx, f.path)).rejects.toThrow('Session resource')
  await expect(localDragResource(f.ctx, sessionFileAddress('missing', f.path))).rejects.toThrow('Session unavailable')
  await expect(localDragResource(f.ctx, sessionFileAddress(f.id, f.root))).resolves.toBeNull()
})

it('does not authorize borrowing when the filesystem has no Host mapping', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  expect(await localDragResource(f.ctx, f.address)).toBeNull()
})

it('honors filesystem read denial without returning a path', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.fs, 'readByteRange').mockRejectedValue(new Error('read denied'))
  await expect(localDragResource(f.ctx, f.address)).rejects.toThrow('read denied')
})

it.skipIf(process.platform === 'win32')('declines symlink borrowing so the authorized byte reader can copy it', async () => {
  const f = await fixture()
  await symlink(f.path, join(f.root, 'linked.pdf'))
  expect(await localDragResource(f.ctx, sessionFileAddress(f.id, 'linked.pdf'))).toBeNull()
})

it('stops a chunked authorization read when the caller cancels', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<Uint8Array>()
  const reading = vi.spyOn(f.ctx.fs, 'readByteRange').mockReturnValue(pending.promise)
  const abort = new AbortController()
  const preparing = localDragResource(f.ctx, f.address, abort.signal)
  const rejected = expect(preparing).rejects.toThrow()
  await vi.waitFor(() => { expect(reading).toHaveBeenCalledOnce() })
  const signal = reading.mock.calls[0]![2]
  abort.abort()
  expect(signal?.aborted).toBe(true)
  pending.resolve(f.bytes)
  await rejected
})

it('authorizes empty files and detects content changes while reading', async () => {
  const f = await fixture()
  await writeFile(f.path, '')
  expect(await localDragResource(f.ctx, f.address)).toMatchObject({ size: 0, sha256: createHash('sha256').digest('hex') })
  await writeFile(f.path, f.bytes)
  vi.spyOn(f.ctx.fs, 'readByteRange').mockResolvedValueOnce(new Uint8Array())
  await expect(localDragResource(f.ctx, f.address)).resolves.toBeNull()
})
