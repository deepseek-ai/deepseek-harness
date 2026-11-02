/** Sequential commits retain known effects and distinguish unchanged from uncertain failures. */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { expect, it, vi } from 'vitest'
import { add, move, patch, remove, setup, update } from './harness.ts'

class LostReplyFileSystem extends LocalFileSystem {
  override async patchText(...args: Parameters<LocalFileSystem['patchText']>): ReturnType<LocalFileSystem['patchText']> {
    await super.patchText(...args)
    throw new FsError('reply lost', 'FS_IO_ERROR')
  }
}

it.each(['delete', 'move'] as const)('retains the first commit when %s removal fails and observes only published changes', async (kind) => {
  const t = await setup()
  await t.file('source', 'old\n')
  const sourceGuard = await t.editIntent('source')
  t.fs.internals.removeFile = async () => { throw Object.assign(new Error('removal denied'), { code: 'EACCES' }) }
  const a = t.record('add', 'a')
  const b = t.record(kind, 'source', 1, 4, kind === 'move' ? 'destination' : undefined)
  const c = t.record('add', 'c', 2, kind === 'move' ? 9 : 5)
  const destination = resolve(t.workspace, 'destination')
  expect(await t.run(patch(add('a'), kind === 'move' ? move('source', 'destination') : remove('source'), add('c')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
    { status: 'failed', operation: b, failure: { code: 'FS_PERMISSION_DENIED', message: `cannot delete "${b.path}": removal denied` },
      changes: kind === 'move' ? [{ path: destination, before: null, after: 'new\n' }] : [] },
    { status: 'skipped', operation: c },
  ], affectedPaths: kind === 'move' ? [a.path, destination] : [a.path], cancelled: false })
  expect(await t.bytes('a')).toBe('new\n')
  expect(await t.bytes('source')).toBe('old\n')
  await expect(t.bytes('c')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
  expect(await t.editIntent('source')).toEqual(sourceGuard)
  expect(t.observations.map(event => event.path)).toEqual(kind === 'move' ? [a.path, destination] : [a.path])
  if (kind === 'move') {
    expect(await t.bytes('destination')).toBe('new\n')
    expect(await t.editIntent('destination')).toEqual({ version: await t.version('destination') })
  }
})

it('stops between operations after cancellation without undoing the first write', async () => {
  const t = await setup()
  t.ctx.on('fs/observed', () => { t.controller.abort() })
  const a = t.record('add', 'a')
  expect(await t.run(patch(add('a'), add('b'), add('c')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
    { status: 'skipped', operation: t.record('add', 'b', 1, 4) },
    { status: 'skipped', operation: t.record('add', 'c', 2, 6) },
  ], affectedPaths: [a.path], cancelled: true })
  expect(await t.bytes('a')).toBe('new\n')
  await expect(t.bytes('b')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
  await expect(t.editIntent('b')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
})

it('reports cancellation during staged writing as unknown without a stat comparison', async () => {
  const t = await setup()
  let writes = 0
  t.fs.internals.inspectTemp = () => { if (++writes === 2) t.controller.abort() }
  const a = t.record('add', 'a')
  // The staged file never reaches its target, so a stat comparison would have called this failed.
  expect(await t.run(patch(add('a'), add('b'), add('c')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
    { status: 'unknown', operation: t.record('add', 'b', 1, 4), failure: { code: 'FS_ABORTED', message: 'write aborted — re-read the affected files before retrying' } },
    { status: 'skipped', operation: t.record('add', 'c', 2, 6) },
  ], affectedPaths: [a.path], cancelled: true })
  expect(await t.bytes('a')).toBe('new\n')
  await expect(t.bytes('b')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
  await expect(t.editIntent('b')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
})

it('does not mark a fully completed patch cancelled when its final observation aborts', async () => {
  const t = await setup()
  t.ctx.on('fs/observed', () => { t.controller.abort() })
  const a = t.record('add', 'a')
  expect(await t.run(patch(add('a')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
  ], affectedPaths: [a.path], cancelled: false })
  expect(await t.bytes('a')).toBe('new\n')
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('reports unknown after the provider changes disk and loses its reply without recording an observation', async () => {
  const t = await setup({ provider: LostReplyFileSystem })
  await t.file('a', 'old\n')
  const observed = await t.editIntent('a')
  expect(await t.run(patch(update('a'), add('b')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'unknown', operation: t.record('update', 'a'), failure: { code: 'FS_IO_ERROR', message: 'reply lost — re-read the affected files before retrying' } },
    { status: 'skipped', operation: t.record('add', 'b', 1, 6) },
  ], affectedPaths: [], cancelled: false })
  expect(await t.bytes('a')).toBe('new\n')
  await expect(t.bytes('b')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual(observed)
})

it.each(['unchanged', 'stat fails', 'stat defect'] as const)('verifies an I/O failure after provider entry: %s', async (scenario) => {
  const t = await setup()
  await t.file('a', 'old\n')
  const observed = await t.editIntent('a')
  const defect = new Error('stat defect')
  vi.spyOn(t.fs, 'patchText').mockImplementation(async () => {
    if (scenario !== 'unchanged') vi.spyOn(t.fs, 'stat').mockRejectedValue(scenario === 'stat fails' ? new FsError('stat failed', 'FS_IO_ERROR') : defect)
    throw new FsError('write failed', 'FS_IO_ERROR')
  })
  const request = t.run(patch(update('a'), add('b')))
  if (scenario === 'stat defect') await expect(request).rejects.toBe(defect)
  else expect(await request).toEqual({ phase: 'commit', outcomes: [
    scenario === 'unchanged'
      ? { status: 'failed', operation: t.record('update', 'a'), failure: { code: 'FS_IO_ERROR', message: 'write failed' }, changes: [] }
      : { status: 'unknown', operation: t.record('update', 'a'), failure: { code: 'FS_IO_ERROR', message: 'write failed — re-read the affected files before retrying' } },
    { status: 'skipped', operation: t.record('add', 'b', 1, 6) },
  ], affectedPaths: [], cancelled: false })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual(observed)
})

it('checks both move targets when its destination was published but the reply is lost', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const observed = await t.editIntent('a')
  vi.spyOn(t.fs, 'moveFile').mockImplementation(async (_source, destination) => {
    await writeFile(destination.targetKey, 'published\n')
    throw new FsError('move reply lost', 'FS_IO_ERROR')
  })
  expect(await t.run(patch(move('a', 'b'), add('c')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'unknown', operation: t.record('move', 'a', 0, 2, 'b'), failure: { code: 'FS_IO_ERROR', message: 'move reply lost — re-read the affected files before retrying' } },
    { status: 'skipped', operation: t.record('add', 'c', 1, 7) },
  ], affectedPaths: [], cancelled: false })
  expect(await t.bytes('a')).toBe('old\n')
  expect(await t.bytes('b')).toBe('published\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual(observed)
  await expect(t.editIntent('b')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
})

it('retains preceding changes when an external edit invalidates the next commit guard', async () => {
  const t = await setup()
  await t.file('b', 'old\n')
  const observed = await t.editIntent('b')
  const write = t.fs.writeText.bind(t.fs)
  vi.spyOn(t.fs, 'writeText').mockImplementation(async (...args) => {
    const result = await write(...args)
    await writeFile(resolve(t.workspace, 'b'), 'external edit\n')
    return result
  })
  const a = t.record('add', 'a')
  const b = t.record('update', 'b', 1, 4)
  expect(await t.run(patch(add('a'), update('b'), add('c')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
    { status: 'failed', operation: b, failure: { code: 'FS_STALE_VERSION', message: expect.stringContaining('re-read the file, then retry') as string }, changes: [] },
    { status: 'skipped', operation: t.record('add', 'c', 2, 8) },
  ], affectedPaths: [a.path], cancelled: false })
  expect(await t.bytes('a')).toBe('new\n')
  expect(await t.bytes('b')).toBe('external edit\n')
  await expect(t.bytes('c')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
  expect(await t.editIntent('b')).toEqual(observed)
})

it('propagates programmer defects from mutation and preserves observed state', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const defect = new Error('mutation defect')
  vi.spyOn(t.fs, 'patchText').mockRejectedValue(defect)
  await expect(t.run(patch(update('a')))).rejects.toBe(defect)
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('reports the locked move source after an external edit following preflight', async () => {
  const t = await setup({ policy: false })
  await t.file('a', 'old\n')
  const originalMove = t.fs.moveFile.bind(t.fs)
  vi.spyOn(t.fs, 'moveFile').mockImplementation(async (...args) => {
    await writeFile(resolve(t.workspace, 'a'), 'old\nexternal\n')
    return originalMove(...args)
  })
  const reads = vi.spyOn(t.fs, 'readText')
  expect(await t.run(patch(move('a', 'b')))).toMatchObject({ phase: 'commit', outcomes: [{ status: 'completed', operation: t.record('move', 'a', 0, 2, 'b'), changes: [
    { path: resolve(t.workspace, 'b'), before: null, after: 'new\nexternal\n' },
    { path: resolve(t.workspace, 'a'), before: 'old\nexternal\n', after: null },
  ] }] })
  expect(reads).toHaveBeenCalledTimes(1)
  expect(await t.bytes('b')).toBe('new\nexternal\n')
})

it('stops at the first provider sandbox denial under read-only policy', async () => {
  const t = await setup({ mode: 'read-only' })
  await t.file('a', 'old\n')
  const b = t.record('add', 'b')
  expect(await t.run(patch(add('b'), update('a'), remove('a')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'failed', operation: b, failure: { code: 'FS_SANDBOX_DENIED', message: expect.stringContaining('[sandbox: file access denied under read-only mode]') as string }, changes: [] },
    { status: 'skipped', operation: t.record('update', 'a', 1, 4) },
    { status: 'skipped', operation: t.record('delete', 'a', 2, 8) },
  ], affectedPaths: [], cancelled: false })
  expect(await t.bytes('a')).toBe('old\n')
  await expect(t.bytes('b')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(t.observations).toEqual([])
})

it('retains earlier writes when the provider denies a move destination outside writable roots', async () => {
  const t = await setup({ mode: 'workspace-write' })
  await t.file('a', 'old\n')
  const outside = resolve(process.cwd(), 'patch-commit-outside-root')
  const b = t.record('add', 'b')
  expect(await t.run(patch(add('b'), move('a', outside)))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: b, changes: [{ path: b.path, before: null, after: 'new\n' }] },
    { status: 'failed', operation: t.record('move', 'a', 1, 4, outside), failure: { code: 'FS_SANDBOX_DENIED', message: expect.stringContaining('[sandbox: file access denied under workspace-write mode]') as string }, changes: [] },
  ], affectedPaths: [b.path], cancelled: false })
  expect(await t.bytes('a')).toBe('old\n')
  expect(await t.bytes('b')).toBe('new\n')
  expect(t.observations.map(event => event.path)).toEqual([b.path])
})
