/** Guarded mutations assert disk bytes and partial outcomes through the real local provider. */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as fsio from '../src/fsio.ts'
import { LocalFileSystem } from '../src/index.ts'

function hunks(old = 'old', replacement = 'new', context?: string) {
  const [operation] = parsePatch(`*** Begin Patch\n*** Update File: a\n${context === undefined ? '@@' : `@@ ${context}`}\n-${old}\n+${replacement}\n*** End Patch`)
  if (operation?.kind !== 'update') throw new Error('Expected update')
  return operation.hunks
}

async function setup(diffBasisMaxBytes = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patch-provider-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes })
  const fs = ctx.fs as LocalFileSystem
  const file = async (name: string, content?: string) => {
    if (content !== undefined) await writeFile(join(root, name), content)
    return fs.resolve(name)
  }
  const bytes = (name: string) => readFile(join(root, name), 'utf8')
  const version = async (target: FsTarget) => {
    const info = await fs.stat(target)
    if (!info) throw new Error('Expected file')
    return info.version
  }
  return { fs, root, file, bytes, version }
}

describe('patchText', () => {
  it.each(['\n', '\r\n'])('keeps storage ending %j and returns LF bases', async (ending) => {
    const { fs, file, bytes, version } = await setup()
    const target = await file('a', `old${ending}tail${ending}`)
    const result = await fs.patchText(target, hunks(), { version: await version(target) })
    expect(result).toEqual({ version: await version(target), before: 'old\ntail\n', after: 'new\ntail\n' })
    expect(await bytes('a')).toBe(`new${ending}tail${ending}`)
  })

  it.each([undefined, 'missing'])('reports the unmatched hunk stage for anchor %s without writing', async (context) => {
    const { fs, file, bytes } = await setup()
    const target = await file('a', 'original\n')
    const pending = fs.patchText(target, hunks('old', 'new', context))
    await expect(pending).rejects.toMatchObject({ code: 'FS_PATCH_MISMATCH' })
    await expect(pending).rejects.toThrow(`hunk at patch line 3 (${context === undefined ? 'oldLines' : 'context'})`)
    expect(await bytes('a')).toBe('original\n')
  })

  it('cancels staged publication and leaves the original file', async () => {
    const { fs, file, bytes } = await setup()
    const target = await file('a', 'old\n')
    const controller = new AbortController()
    fs.internals.inspectTemp = () => { controller.abort() }
    await expect(fs.patchText(target, hunks(), undefined, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(await bytes('a')).toBe('old\n')
  })
})

describe('source guards', () => {
  it.each(['patch', 'delete', 'move'] as const)('%s rejects missing, directory, and stale sources', async (operation) => {
    const { fs, file, root, bytes } = await setup()
    const destination = await file('destination', 'untouched')
    const run = (target: FsTarget, expected?: { version: FsVersion }) => {
      if (operation === 'patch') return fs.patchText(target, hunks(), expected)
      if (operation === 'delete') return fs.deleteFile(target, expected)
      return fs.moveFile(target, destination, expected === undefined ? {} : { expectedSource: expected })
    }
    const missing = await file('missing')
    await expect(run(missing)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(run(missing, { version: FsVersion('old') })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await mkdir(join(root, 'directory'))
    await expect(run(await fs.resolve('directory'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    const source = await file('a', 'old\n')
    await expect(run(source, { version: FsVersion('stale') })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await bytes('a')).toBe('old\n')
    expect(await bytes('destination')).toBe('untouched')
  })
})

describe('deleteFile', () => {
  it.each([
    { content: 'old\r\n', limit: 1024, before: 'old\n' },
    { content: 'abcd', limit: 4, before: null },
    { content: 'abcde', limit: 4, before: null },
    { content: '\0binary', limit: 1024, before: null },
  ])('removes a file and returns basis $before at limit $limit', async ({ content, limit, before }) => {
    const { fs, file, bytes, version } = await setup(limit)
    const target = await file('a', content)
    expect(await fs.deleteFile(target, { version: await version(target) })).toEqual({ before })
    await expect(bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['EACCES', 'EPERM', 'EIO'])('maps removal failure %s and keeps the file', async (code) => {
    const { fs, file, bytes } = await setup()
    const target = await file('a', 'old')
    fs.internals.removeFile = async () => { throw Object.assign(new Error('injected removal failure'), { code }) }
    await expect(fs.deleteFile(target)).rejects.toMatchObject({ code: code === 'EIO' ? 'FS_IO_ERROR' : 'FS_PERMISSION_DENIED' })
    expect(await bytes('a')).toBe('old')
  })
})

describe('moveFile', () => {
  it.each([false, true])('publishes source bytes and mode (existing destination: %s)', async (exists) => {
    const { fs, file, bytes, root, version } = await setup()
    const source = await file('a', 'old\r\ntail\r\n')
    const destination = await file('nested/b')
    await mkdir(join(root, 'nested'))
    if (exists) await writeFile(join(root, 'nested/b'), 'destination\n')
    if (process.platform !== 'win32') await chmod(join(root, 'a'), 0o640)
    const expectedDestination = exists
      ? { kind: 'replaceIfVersion' as const, version: await version(destination) }
      : { kind: 'createIfAbsent' as const }
    const result = await fs.moveFile(source, destination, { expectedSource: { version: await version(source) }, expectedDestination })
    expect(result).toEqual({ sourceBefore: 'old\ntail\n', sourceDeleted: true, destination: {
      operation: exists ? 'update' : 'create', version: await version(destination),
      before: exists ? 'destination\n' : null, after: 'old\ntail\n',
    } })
    expect(await bytes('nested/b')).toBe('old\r\ntail\r\n')
    await expect(bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') expect((await stat(join(root, 'nested/b'))).mode & 0o777).toBe(0o640)
  })

  it('bounds the source basis by diffBasisMaxBytes while still publishing the whole text', async () => {
    const { fs, file, bytes } = await setup(16)
    const text = `${'x'.repeat(32)}\n`
    const source = await file('large', text)
    const result = await fs.moveFile(source, await file('moved'), {})
    expect(result).toEqual({ sourceBefore: null, sourceDeleted: true, destination: { operation: 'create', version: expect.any(String) as string, before: null, after: text } })
    expect(await bytes('moved')).toBe(text)
  })

  it('creates missing parent directories and applies hunks before publication', async () => {
    const { fs, file, bytes } = await setup()
    const source = await file('a', 'old\r\n')
    const destination = await file('new/sub/b')
    const result = await fs.moveFile(source, destination, { hunks: hunks() })
    expect(result).toMatchObject({ sourceDeleted: true, destination: { operation: 'create', before: null, after: 'new\n' } })
    expect(await bytes('new/sub/b')).toBe('new\r\n')
    await expect(bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([false, true])('declines an over-limit destination basis (large source: %s)', async (largeSource) => {
    const { fs, file } = await setup(4)
    const source = await file('a', largeSource ? 'large' : 'a')
    const destination = await file('b', largeSource ? 'b' : 'large')
    expect(await fs.moveFile(source, destination, {})).toMatchObject({ sourceDeleted: true, destination: { before: null } })
  })

  it('refuses same identities, destination conflicts, directories, and mismatched hunks without changing either file', async () => {
    const { fs, file, root, bytes } = await setup()
    const source = await file('a', 'old\n')
    const destination = await file('b', 'destination')
    await expect(fs.moveFile(source, await fs.resolve('./a'), {})).rejects.toMatchObject({ code: 'FS_SAME_TARGET' })
    await expect(fs.moveFile(source, destination, { expectedDestination: { kind: 'createIfAbsent' } })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    await expect(fs.moveFile(source, destination, { expectedDestination: { kind: 'replaceIfVersion', version: FsVersion('stale') } })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.moveFile(source, await file('absent'), { expectedDestination: { kind: 'replaceIfVersion', version: FsVersion('stale') } })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await mkdir(join(root, 'directory'))
    await expect(fs.moveFile(source, await fs.resolve('directory'), {})).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(fs.moveFile(source, destination, { hunks: hunks('missing') })).rejects.toMatchObject({ code: 'FS_PATCH_MISMATCH' })
    expect(await bytes('a')).toBe('old\n')
    expect(await bytes('b')).toBe('destination')
  })

  it.each(['EACCES', 'EIO'])('reports source failure %s after publishing the destination', async (code) => {
    const { fs, file, bytes, version } = await setup()
    const source = await file('a', 'old\n')
    const destination = await file('b', 'previous')
    fs.internals.removeFile = async () => { throw Object.assign(new Error('injected'), { code }) }
    expect(await fs.moveFile(source, destination, {})).toEqual({
      destination: { operation: 'update', version: await version(destination), before: 'previous', after: 'old\n' },
      sourceBefore: 'old\n', sourceDeleted: false,
      sourceFailure: { code: code === 'EACCES' ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR', message: `cannot delete "${source.displayPath}": injected` },
    })
    expect(await bytes('a')).toBe('old\n')
    expect(await bytes('b')).toBe('old\n')
  })

  it('keeps both files and releases both locks after destination publication fails', async () => {
    const { fs, file, bytes } = await setup()
    const source = await file('a', 'old\n')
    const destination = await file('b', 'previous')
    fs.internals.inspectTemp = () => { throw new Error('staging failure') }
    await expect(fs.moveFile(source, destination, {})).rejects.toThrow('staging failure')
    expect(await bytes('a')).toBe('old\n')
    expect(await bytes('b')).toBe('previous')
    delete fs.internals.inspectTemp
    await Promise.all([fs.writeText(source, 'left'), fs.writeText(destination, 'right')])
    expect(await bytes('a')).toBe('left')
    expect(await bytes('b')).toBe('right')
  })

  it('ignores cancellation after destination staging starts and reports both completed effects', async () => {
    const { fs, file, bytes } = await setup()
    const source = await file('a', 'old')
    const destination = await file('b')
    const controller = new AbortController()
    fs.internals.inspectTemp = () => { controller.abort() }
    expect(await fs.moveFile(source, destination, {}, controller.signal)).toMatchObject({ sourceDeleted: true })
    expect(await bytes('b')).toBe('old')
    await expect(bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('orders opposite-direction moves without deadlock and retains FIFO ownership', async () => {
    const { fs, file, bytes } = await setup()
    const a = await file('a', 'left')
    const b = await file('b', 'right')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const inspect = vi.fn(async () => { entered.resolve(undefined); await release.promise })
    fs.internals.inspectTemp = inspect
    const forward = fs.moveFile(a, b, {})
    await entered.promise
    const backward = fs.moveFile(b, a, {})
    release.resolve(undefined)
    expect(await Promise.all([forward, backward])).toMatchObject([{ sourceDeleted: true }, { sourceDeleted: true }])
    expect(await bytes('a')).toBe('left')
    await expect(bytes('b')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('moves the resolved symlink target while leaving the source link', async () => {
    const { fs, file, root, bytes } = await setup()
    await file('a', 'source')
    await symlink(join(root, 'a'), join(root, 'link'))
    expect((await fs.lstat('link'))?.type).toBe('symlink')
    await fs.moveFile(await fs.resolve('link'), await file('b'), {})
    expect(await bytes('b')).toBe('source')
    expect((await fs.lstat('link'))?.type).toBe('symlink')
    await expect(bytes('a')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it.each(['patch', 'delete', 'move'] as const)('%s rejects pre-cancellation without changing disk', async (operation) => {
  const { fs, file, bytes } = await setup()
  const source = await file('a', 'old\n')
  const destination = await file('b', 'destination')
  const signal = AbortSignal.abort()
  const pending = operation === 'patch' ? fs.patchText(source, hunks(), undefined, signal)
    : operation === 'delete' ? fs.deleteFile(source, undefined, signal) : fs.moveFile(source, destination, {}, signal)
  await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  expect(await bytes('a')).toBe('old\n')
  expect(await bytes('b')).toBe('destination')
})

it.each(['delete', 'move'] as const)('%s observes cancellation at the last pre-commit checkpoint', async (operation) => {
  const { fs, file, bytes } = await setup()
  const source = await file('a', 'old')
  const destination = await file('b', 'destination')
  const controller = new AbortController()
  fs.internals.inspectBeforeMutation = () => { controller.abort() }
  const pending = operation === 'delete' ? fs.deleteFile(source, undefined, controller.signal)
    : fs.moveFile(source, destination, {}, controller.signal)
  await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  expect(await bytes('a')).toBe('old')
  expect(await bytes('b')).toBe('destination')
  fs.internals = {}
  expect(await fs.moveFile(source, destination, {})).toMatchObject({ sourceDeleted: true })
})

it('does not treat source mode as an existing Windows destination', async () => {
  const { fs, file, bytes } = await setup()
  const source = await file('a', 'source')
  const destination = await file('b')
  const copyFileDacl = vi.fn(async () => { throw new Error('Cannot copy security from absent destination') })
  fs.internals = { platform: 'win32', copyFileDacl }
  expect(await fs.moveFile(source, destination, {})).toMatchObject({ sourceDeleted: true })
  expect(copyFileDacl).not.toHaveBeenCalled()
  expect(await bytes('b')).toBe('source')
})

it('rethrows an unexpected source-removal defect after destination publication', async () => {
  const { fs, file, bytes } = await setup()
  const source = await file('a', 'source')
  const destination = await file('b')
  const defect = new Error('unexpected removal defect')
  const remove = vi.spyOn(fsio, 'removeFile').mockRejectedValueOnce(defect)
  onTestFinished(() => { remove.mockRestore() })
  await expect(fs.moveFile(source, destination, {})).rejects.toBe(defect)
  expect(await bytes('a')).toBe('source')
  expect(await bytes('b')).toBe('source')
})
