/** Whole-patch admission rejects all writes while preserving prior observation state. */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import { expect, it, vi } from 'vitest'
import { add, move, patch, remove, setup, update } from './harness.ts'

it('reports syntax errors before resolving paths', async () => {
  const t = await setup()
  const resolve = vi.spyOn(t.fs, 'resolve')
  expect(await t.run('invalid')).toEqual({ phase: 'syntax', failure: {
    code: 'PATCH_SYNTAX', message: "Invalid patch at line 1: Expected '*** Begin Patch'",
  } })
  expect(resolve).not.toHaveBeenCalled()
  expect(t.observations).toEqual([])
  await expect(t.bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(t.editIntent('a')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
})

it('collects independent unread and confirmed-absent failures and skips valid writes', async () => {
  const t = await setup()
  await t.file('a', 'old\n', false)
  await t.absent('b')
  const a = t.record('update', 'a')
  const b = t.record('update', 'b', 1, 6)
  expect(await t.run(patch(update('a'), update('b'), add('c')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'FS_NOT_OBSERVED', message: `cannot modify "${a.path}": file has not been read — read the file, then retry` } },
    { operation: b, failure: { code: 'FS_NOT_FOUND', message: `cannot edit "${b.path}": not found` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  await expect(t.bytes('c')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(t.observations).toEqual([])
  await expect(t.editIntent('a')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  await expect(t.editIntent('b')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
})

it.each([
  { pattern: 'missing', marker: '@@', stage: 'oldLines', preview: 'missing' },
  { pattern: '🙂'.repeat(81), marker: '@@', stage: 'oldLines', preview: `${'🙂'.repeat(80)}…` },
  { pattern: 'old', marker: '@@ absent anchor', stage: 'context', preview: 'absent anchor' },
])('reports the hunk line and $stage preview without simulating a failed update', async ({ pattern, marker, stage, preview }) => {
  const t = await setup()
  await t.file('a', 'old\n')
  const a = t.record('update', 'a')
  expect(await t.run(patch(`*** Update File: a\n${marker}\n-${pattern}\n+new`, update('a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'FS_PATCH_MISMATCH', hunkLine: 3,
      message: `cannot patch "${a.path}": hunk at patch line 3 (${stage}) does not match — ${preview}` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it.each(['delete', 'move'] as const)('rejects a %s source the provider reports as a symbolic link', async (kind) => {
  const t = await setup()
  await t.file('a', 'old\n')
  vi.spyOn(t.fs, 'lstat').mockResolvedValue({ type: 'symlink', version: FsVersion('link') })
  const a = t.record(kind, 'a', 0, 2, kind === 'move' ? 'b' : undefined)
  expect(await t.run(patch(kind === 'delete' ? remove('a') : move('a', 'b')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'PATCH_SYMLINK_SOURCE',
      message: `cannot ${kind} "${a.path}": path is a symbolic link — operate on its target path instead` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
})

it.skipIf(process.platform === 'win32').each(['delete', 'move'] as const)('rejects a symbolic-link %s source without changing its target', async (kind) => {
  const t = await setup()
  await t.file('a', 'old\n')
  await symlink('a', resolve(t.workspace, 'link'))
  const a = t.record(kind, 'link', 0, 2, kind === 'move' ? 'b' : undefined)
  expect(await t.run(patch(kind === 'delete' ? remove('link') : move('link', 'b')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'PATCH_SYMLINK_SOURCE',
      message: `cannot ${kind} "${a.path}": path is a symbolic link — operate on its target path instead` } },
  ] })
  expect(await t.bytes('link')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('rejects a move to an alias of its source', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const a = t.record('move', 'a', 0, 2, 'a')
  expect(await t.run(patch(move('a', './a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'FS_SAME_TARGET', message: `cannot move "${a.path}" to itself` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it.each(['add', 'move'] as const)('attributes an unread %s destination to its resolved path', async (kind) => {
  const t = await setup()
  await t.file('a', 'old\n')
  await t.file('b', 'existing\n', false)
  const operation = kind === 'add' ? t.record('add', 'b') : t.record('move', 'a', 0, 2, 'b')
  const b = t.record('add', 'b')
  expect(await t.run(patch(kind === 'add' ? add('b') : move('a', 'b')))).toEqual({ phase: 'preflight', refusals: [
    { operation, failure: { code: 'FS_NOT_OBSERVED', message: `cannot modify "${b.path}": file has not been read — read the file, then retry` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(await t.bytes('b')).toBe('existing\n')
  expect(t.observations).toEqual([])
  await expect(t.editIntent('b')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
})

it.each(['update', 'delete', 'add', 'move'] as const)('rejects non-regular %s targets with bare guards', async (kind) => {
  const t = await setup({ policy: false })
  await mkdir(resolve(t.workspace, 'directory'))
  await t.file('a', 'old\n')
  const operation = kind === 'move' ? t.record(kind, 'a', 0, 2, 'directory') : t.record(kind, 'directory')
  const text = kind === 'add' ? add('directory') : kind === 'delete' ? remove('directory') : kind === 'move' ? move('a', 'directory') : update('directory')
  expect(await t.run(patch(text))).toEqual({ phase: 'preflight', refusals: [
    { operation, failure: { code: 'FS_NOT_REGULAR_FILE', message: `cannot modify "${resolve(t.workspace, 'directory')}": not a regular file` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect((await t.fs.stat(await t.target('directory')))?.type).toBe('directory')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toBeUndefined()
})

it.each(['update', 'add'] as const)('rejects a stale observed version before %s', async (kind) => {
  const t = await setup()
  await t.file('a', 'old\n')
  const observed = await t.editIntent('a')
  await writeFile(resolve(t.workspace, 'a'), 'external edit\n')
  const a = t.record(kind, 'a')
  expect(await t.run(patch(kind === 'add' ? add('a') : update('a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'FS_STALE_VERSION', message: `cannot ${kind === 'add' ? 'write' : 'edit'} "${a.path}": file changed since it was read — re-read the file, then retry` } },
  ] })
  expect(await t.bytes('a')).toBe('external edit\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual(observed)
})

it('rejects a NUL byte beyond the read sampling window before any write', async () => {
  const t = await setup()
  const binary = `${'text\n'.repeat(2048)}\0tail\n`
  await t.file('a', binary)
  expect(await t.run(patch(add('created'), '*** Update File: a\n@@\n-text\n+new'))).toEqual({ phase: 'preflight', refusals: [
    { operation: t.record('update', 'a', 1, 4), failure: { code: 'FS_NOT_TEXT', message: `cannot patch "${resolve(t.workspace, 'a')}": binary file` } },
  ] })
  await expect(t.bytes('created')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.bytes('a')).toBe(binary)
  expect(t.observations).toEqual([])
})

it.each(['FS_NOT_TEXT', 'FS_TOO_LARGE'] satisfies FsErrorCode[])('preserves a preflight read failure %s', async (code) => {
  const t = await setup()
  await t.file('a', 'old\n')
  vi.spyOn(t.fs, 'readText').mockRejectedValue(new FsError('cannot read fixture', code))
  expect(await t.run(patch(update('a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: t.record('update', 'a'), failure: { code, message: 'cannot read fixture' } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it.each(['delete', 'move'] as const)('simulates the missing source after %s without performing it', async (kind) => {
  const t = await setup()
  await t.file('a', 'old\n')
  const a = t.record('update', 'a', 1, kind === 'move' ? 7 : 3)
  expect(await t.run(patch(kind === 'delete' ? remove('a') : move('a', 'b'), update('a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'FS_NOT_FOUND', message: `cannot edit "${a.path}": not found` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('propagates programming defects from preflight without writes', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const defect = new Error('provider defect')
  vi.spyOn(t.fs, 'readText').mockRejectedValue(defect)
  await expect(t.run(patch(update('a')))).rejects.toBe(defect)
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('rethrows a resolution defect instead of labelling it a patch syntax failure', async () => {
  const t = await setup()
  const defect = new Error('resolver defect')
  const spy = vi.spyOn(t.fs, 'resolve').mockRejectedValue(defect)
  await expect(t.run(patch(add('a')))).rejects.toBe(defect)
  spy.mockRestore()
  await expect(t.bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(t.observations).toEqual([])
  await expect(t.editIntent('a')).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
})

it('rejects repeated deletion against simulated absence', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  const a = t.record('delete', 'a')
  expect(await t.run(patch(remove('a'), remove('a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: t.record('delete', 'a', 1, 3), failure: { code: 'FS_NOT_FOUND', message: `cannot delete "${a.path}": not found` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})

it('preserves source simulation after a move destination fails admission', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  await t.file('b', 'unread\n', false)
  const a = t.record('move', 'a', 0, 2, 'b')
  expect(await t.run(patch(move('a', 'b'), update('a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'FS_NOT_OBSERVED', message: `cannot modify "${a.destination}": file has not been read — read the file, then retry` } },
  ] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(await t.bytes('b')).toBe('unread\n')
  expect(t.observations).toEqual([])
  expect(await t.editIntent('a')).toEqual({ version: await t.version('a') })
})


it('names the missing move source operation', async () => {
  const t = await setup({ policy: false })
  expect(await t.run(patch(move('missing', 'destination')))).toEqual({
    phase: 'preflight', refusals: [{ operation: t.record('move', 'missing', 0, 2, 'destination'),
      failure: { code: 'FS_NOT_FOUND', message: `cannot move "${resolve(t.workspace, 'missing')}": not found` } }],
  })
})

it('applies unread, externally changed, and overwritten targets on context match alone without a policy', async () => {
  const t = await setup({ policy: false })
  await t.file('a', 'old\n', false)
  await t.file('b', 'old\n')
  await writeFile(resolve(t.workspace, 'b'), 'old\nexternal\n')
  await t.file('c', 'existing\n', false)
  expect((await t.run(patch(update('a'), update('b'), add('c'), remove('a')))).phase).toBe('commit')
  await expect(t.bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await t.bytes('b')).toBe('new\nexternal\n')
  expect(await t.bytes('c')).toBe('new\n')
  // Commits still publish observations for a policy mounted later.
  expect(t.observations.map(entry => [entry.path, entry.observation.kind])).toEqual([
    [resolve(t.workspace, 'a'), 'present'], [resolve(t.workspace, 'b'), 'present'],
    [resolve(t.workspace, 'c'), 'present'], [resolve(t.workspace, 'a'), 'absent'],
  ])
  await expect(t.editIntent('b')).resolves.toBeUndefined()
})

it('still rejects a mismatched hunk without a policy', async () => {
  const t = await setup({ policy: false })
  await t.file('a', 'other\n', false)
  const a = t.record('update', 'a')
  expect(await t.run(patch(update('a')))).toEqual({ phase: 'preflight', refusals: [
    { operation: a, failure: { code: 'FS_PATCH_MISMATCH', hunkLine: 3, message: `cannot patch "${a.path}": hunk at patch line 3 (oldLines) does not match — old` } },
  ] })
  expect(await t.bytes('a')).toBe('other\n')
})
