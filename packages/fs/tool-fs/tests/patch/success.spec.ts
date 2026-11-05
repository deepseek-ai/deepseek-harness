/** Successful simulations and commits agree on bytes and observation guards. */
import { symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { add, move, patch, remove, setup, update } from './harness.ts'

it('applies multiple files and hunks while preserving storage line endings', async () => {
  const t = await setup()
  await t.file('a', 'old\r\ntail\r\n')
  const text = patch('*** Update File: a\n@@\n-old\n+new\n@@\n-tail\n+end', add('b'))
  const a = t.record('update', 'a')
  const b = t.record('add', 'b', 1, 9)
  expect(await t.run(text)).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: 'old\ntail\n', after: 'new\nend\n' }] },
    { status: 'completed', operation: b, changes: [{ path: b.path, before: null, after: 'new\n' }] },
  ], affectedPaths: [a.path, b.path], cancelled: false })
  expect(await t.bytes('a')).toBe('new\r\nend\r\n')
  expect(await t.bytes('b')).toBe('new\n')
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
  expect(await t.editIntent('b')).toEqual({ version: await t.version('b') })
})

it('retains aliased updates and reacquires the version produced by the preceding update', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const write = vi.spyOn(t.fs, 'patchText')
  const a = t.record('update', './a')
  const second = t.record('update', 'a', 1, 6)
  expect(await t.run(patch(update('./a'), update('a', 'new', 'last')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: 'old\n', after: 'new\n' }] },
    { status: 'completed', operation: second, changes: [{ path: a.path, before: 'new\n', after: 'last\n' }] },
  ], affectedPaths: [a.path], cancelled: false })
  expect(write.mock.calls[1]?.[2]).toEqual(t.observations[0]?.observation.kind === 'present' ? { version: t.observations[0].observation.version } : undefined)
  expect(await t.bytes('a')).toBe('last\n')
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('simulates deletion then recreation at the same target', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const a = t.record('delete', 'a')
  const second = t.record('add', 'a', 1, 3)
  expect(await t.run(patch(remove('a'), add('a')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: 'old\n', after: null }] },
    { status: 'completed', operation: second, changes: [{ path: a.path, before: null, after: 'new\n' }] },
  ], affectedPaths: [a.path], cancelled: false })
  expect(await t.bytes('a')).toBe('new\n')
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('simulates creation then update before the file exists on disk', async () => {
  const t = await setup()
  const a = t.record('add', 'a')
  const second = t.record('update', 'a', 1, 4)
  expect(await t.run(patch(add('a'), update('a', 'new', 'last')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
    { status: 'completed', operation: second, changes: [{ path: a.path, before: 'new\n', after: 'last\n' }] },
  ], affectedPaths: [a.path], cancelled: false })
  expect(await t.bytes('a')).toBe('last\n')
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('moves and patches in one provider call then updates the simulated destination', async () => {
  const t = await setup()
  await t.file('a', 'old\r\n')
  await t.file('b', 'previous\n')
  const spy = vi.spyOn(t.fs, 'moveFile')
  const a = t.record('move', 'a', 0, 2, 'b')
  const b = t.record('update', 'b', 1, 7)
  expect(await t.run(patch(move('a', 'b'), update('b', 'new', 'last')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [
      { path: b.path, before: 'previous\n', after: 'new\n' }, { path: a.path, before: 'old\n', after: null },
    ] },
    { status: 'completed', operation: b, changes: [{ path: b.path, before: 'new\n', after: 'last\n' }] },
  ], affectedPaths: [b.path, a.path], cancelled: false })
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy.mock.calls[0]?.[2].hunks).toHaveLength(1)
  await expect(t.bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.bytes('b')).toBe('last\r\n')
  await expect(t.editIntent('a')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  expect(await t.editIntent('b')).toEqual({ version: await t.version('b') })
})

it('supports unconditional updates and moves without observation policy', async () => {
  const t = await setup({ policy: false })
  await t.file('a', 'old\n', false)
  const a = t.record('update', 'a')
  const b = t.record('move', 'a', 1, 6, 'b')
  expect(await t.run(patch(update('a'), move('a', 'b', 'new', 'last')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: 'old\n', after: 'new\n' }] },
    { status: 'completed', operation: b, changes: [
      { path: b.destination, before: null, after: 'last\n' }, { path: a.path, before: 'new\n', after: null },
    ] },
  ], affectedPaths: [a.path, b.destination], cancelled: false })
  expect(await t.bytes('b')).toBe('last\n')
  await expect(t.bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.editIntent('b')).toBeUndefined()
})

it.each(['workspace-write', 'danger-full-access'] as const)('commits guarded changes under %s policy', async (mode) => {
  const t = await setup({ mode })
  const a = t.record('add', 'a')
  expect(await t.run(patch(add('a')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
  ], affectedPaths: [a.path], cancelled: false })
  expect(await t.bytes('a')).toBe('new\n')
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('allows an add to overwrite a target already created in the patch', async () => {
  const t = await setup()
  const a = t.record('add', 'a')
  expect(await t.run(patch(add('a'), add('a', 'last')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
    { status: 'completed', operation: t.record('add', 'a', 1, 4), changes: [{ path: a.path, before: 'new\n', after: 'last\n' }] },
  ], affectedPaths: [a.path], cancelled: false })
  expect(await t.bytes('a')).toBe('last\n')
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it.skipIf(process.platform === 'win32')('updates through a symbolic link and shares its observation with the target', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  await symlink('a', resolve(t.workspace, 'link'))
  const link = t.record('update', 'link')
  expect(await t.run(patch(update('link')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: link, changes: [{ path: resolve(t.workspace, 'a'), before: 'old\n', after: 'new\n' }] },
  ], affectedPaths: [resolve(t.workspace, 'a')], cancelled: false })
  expect(await t.bytes('link')).toBe('new\n')
  expect(await t.bytes('a')).toBe('new\n')
  expect(await t.editIntent('link')).toEqual({ version: await t.version('a') })
})

it('deletes a file created earlier in the patch and records confirmed absence', async () => {
  const t = await setup()
  const a = t.record('add', 'a')
  expect(await t.run(patch(add('a'), remove('a')))).toEqual({ phase: 'commit', outcomes: [
    { status: 'completed', operation: a, changes: [{ path: a.path, before: null, after: 'new\n' }] },
    { status: 'completed', operation: t.record('delete', 'a', 1, 4), changes: [{ path: a.path, before: 'new\n', after: null }] },
  ], affectedPaths: [a.path], cancelled: false })
  await expect(t.bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(t.editIntent('a')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
})
