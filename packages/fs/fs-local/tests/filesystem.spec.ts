/**
 * Tests for the local backend through the `ctx.fs` Service Definition: stat, whole-
 * file/streamed text reads, atomic guarded writes (createIfAbsent /
 * replaceIfVersion), version-guarded literal edits, concurrency races, symlink
 * identity, and HMR/disposal. Read WINDOWING is policy and lives in
 * `dsh-fs-observation-policy`, so it is not exercised here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { constants as bufferConstants } from 'node:buffer'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

let dir: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  fs = ctx.fs as LocalFileSystem
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

function lockCount(localFs: LocalFileSystem): number {
  return (localFs as unknown as { locks: Map<string, Promise<unknown>> }).locks.size
}

/** The version the backend currently reports for a resolved target. */
async function versionOf(target: FsTarget): Promise<FsVersion> {
  const info = await fs.stat(target)
  if (!info) throw new Error('expected target to exist')
  return info.version
}

async function remountWithDiffLimit(diffBasisMaxBytes: number): Promise<void> {
  await fiber.dispose()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir, diffBasisMaxBytes })
  fs = ctx.fs as LocalFileSystem
}

describe('registration', () => {
  it('registers LocalFileSystem as ctx.fs with a default cwd', async () => {
    const bare = new Context()
    const bareFiber = await bare.plugin(LocalFileSystem)
    expect((bare.fs as LocalFileSystem).config.cwd).toBe(process.cwd())
    expect((bare.fs as LocalFileSystem).config.diffBasisMaxBytes).toBe(10 * 1024 * 1024)
    await bareFiber.dispose()
  })

  it('maps only absolute host paths into its process path namespace', () => {
    const path = join(dir, 'image.png')
    expect(fs.processPathFromHostPath(path)).toBe(path)
    expect(fs.processPathFromHostPath('image.png')).toBeUndefined()
  })

  it('rejects non-positive, fractional, unsafe, or unallocatable diff-basis limits', async () => {
    const maxDiffBasisBytes = Math.min(
      bufferConstants.MAX_LENGTH,
      bufferConstants.MAX_STRING_LENGTH,
    )
    const valid = new Context()
    const validFiber = await valid.plugin(LocalFileSystem, { diffBasisMaxBytes: maxDiffBasisBytes })
    expect((valid.fs as LocalFileSystem).config.diffBasisMaxBytes).toBe(maxDiffBasisBytes)
    await validFiber.dispose()

    for (const diffBasisMaxBytes of [0, -1, 1.5, maxDiffBasisBytes + 1, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = new Context()
      await expect(invalid.plugin(LocalFileSystem, { diffBasisMaxBytes })).rejects.toThrow(
        `fs-local: diffBasisMaxBytes must be a positive safe integer no greater than ${maxDiffBasisBytes}`,
      )
      await invalid.fiber.dispose()
    }
  })
})

describe('resolve', () => {
  it('resolves a relative path against opts.cwd, not config.cwd', async () => {
    // config.cwd is `dir`; a call supplying a DIFFERENT cwd bases the relative
    // path there (the per-session workspace mapping — mirrors tool-bash workdir).
    const other = await mkdtemp(join(tmpdir(), 'dsh-fs-other-'))
    try {
      await writeFile(join(other, 'x.txt'), 'in other')
      const viaOther = await fs.resolve('x.txt', { cwd: other })
      expect(await fs.readText(viaOther)).toBe('in other')
      // Same relative path with no opts falls back to config.cwd (= dir), where
      // x.txt does not exist.
      await expect(fs.readText(await fs.resolve('x.txt'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('ignores opts.cwd for an ABSOLUTE path', async () => {
    await writeFile(join(dir, 'abs.txt'), 'absolute')
    const target = await fs.resolve(join(dir, 'abs.txt'), { cwd: '/nonexistent-base' })
    expect(await fs.readText(target)).toBe('absolute')
  })

  it('honors a pre-aborted signal', async () => {
    await expect(fs.resolve('a.txt', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('honors a signal aborted while resolution is in flight', async () => {
    const controller = new AbortController()
    const pending = fs.resolve('a.txt', { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('projects process paths, file URLs, and canonical containment', async () => {
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'nested', 'file.txt'), 'text')
    const root = await fs.resolve('.')
    const child = await fs.resolve('nested/file.txt')
    const outside = await fs.resolve('..')

    expect(fs.processPath(child)).toBe(await realpath(join(dir, 'nested', 'file.txt')))
    expect(fs.fileUrl(child)).toBe(pathToFileURL(await realpath(join(dir, 'nested', 'file.txt'))).href)
    expect(fs.contains(root, root)).toBe(true)
    expect(fs.contains(root, child)).toBe(true)
    expect(fs.contains(root, outside)).toBe(false)
  })
})

describe('stat', () => {
  it('returns file metadata, directory type, and undefined for absent', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const fileInfo = await fs.stat(await fs.resolve('a.txt'))
    expect(fileInfo?.type).toBe('file')
    expect(fileInfo?.size).toBe(5)
    expect(typeof fileInfo?.version).toBe('string')

    expect((await fs.stat(await fs.resolve('.')))?.type).toBe('directory')
    expect(await fs.stat(await fs.resolve('missing.txt'))).toBeUndefined()
  })

  it('changes version after a same-size rewrite even when mtime is restored', async () => {
    const path = join(dir, 'same-size.txt')
    await writeFile(path, 'first')
    const target = await fs.resolve(path)
    const beforeInfo = await stat(path)
    const beforeVersion = await versionOf(target)

    await fs.writeText(target, 'other')
    await utimes(path, beforeInfo.atime, beforeInfo.mtime)

    expect((await stat(path)).size).toBe(beforeInfo.size)
    expect(await versionOf(target)).not.toBe(beforeVersion)
  })

  it('honors a pre-aborted signal', async () => {
    await expect(fs.stat(await fs.resolve('a.txt'), AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('lstat', () => {
  it.skipIf(process.platform !== 'win32')('uses the same native drive-relative paths as resolve', async () => {
    await writeFile(join(dir, 'created.txt'), 'native')
    const drive = parse(dir).root.slice(0, 2)
    for (const cwd of [dir, `${drive}${relative(process.cwd(), dir)}`]) {
      for (const path of ['created.txt', `${drive}created.txt`]) {
        const target = await fs.resolve(path, { cwd })
        expect(await fs.lstat(path, { cwd })).toEqual(await fs.stat(target))
      }
    }
  })

  it('reports path metadata without following the final symlink component', async () => {
    await writeFile(join(dir, 'real.txt'), 'hello')
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'))

    expect((await fs.lstat('real.txt'))?.type).toBe('file')
    expect((await fs.lstat('link.txt'))?.type).toBe('symlink')
    expect(await fs.lstat('missing.txt')).toBeUndefined()
  })

  it('resolves relative paths against opts.cwd and honors a pre-aborted signal', async () => {
    const other = await mkdtemp(join(tmpdir(), 'dsh-fs-other-'))
    try {
      await writeFile(join(other, 'x.txt'), 'in other')
      expect((await fs.lstat('x.txt', { cwd: other }))?.type).toBe('file')
      await expect(fs.lstat('x.txt', { cwd: other }, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
      await expect(fs.lstat('   ')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe('metadata cancellation', () => {
  it('rejects stat and lstat when their signals abort while the metadata probes are in flight', async () => {
    await writeFile(join(dir, 'slow.txt'), 'hello')
    const statStarted = Promise.withResolvers<undefined>()
    const statRelease = Promise.withResolvers<undefined>()
    const lstatStarted = Promise.withResolvers<undefined>()
    const lstatRelease = Promise.withResolvers<undefined>()
    let isolatedCtx: Context | undefined
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async stat(path: string) {
          statStarted.resolve(undefined)
          await statRelease.promise
          return actual.stat(path, { bigint: true })
        },
        async lstat(path: string) {
          lstatStarted.resolve(undefined)
          await lstatRelease.promise
          return actual.lstat(path, { bigint: true })
        },
      }
    })

    try {
      const { LocalFileSystem: IsolatedLocalFileSystem } = await import('../src/index.ts')
      isolatedCtx = new Context()
      await isolatedCtx.plugin(IsolatedLocalFileSystem, { cwd: dir })
      const isolatedFs = isolatedCtx.fs as InstanceType<typeof IsolatedLocalFileSystem>
      const target = await isolatedFs.resolve('slow.txt')
      const statController = new AbortController()
      const lstatController = new AbortController()
      const pendingStat = isolatedFs.stat(target, statController.signal)
      const pendingLstat = isolatedFs.lstat('slow.txt', undefined, lstatController.signal)

      await Promise.all([statStarted.promise, lstatStarted.promise])
      statController.abort()
      lstatController.abort()
      const statRejected = expect(pendingStat).rejects.toMatchObject({ code: 'FS_ABORTED' })
      const lstatRejected = expect(pendingLstat).rejects.toMatchObject({ code: 'FS_ABORTED' })
      statRelease.resolve(undefined)
      lstatRelease.resolve(undefined)

      await Promise.all([statRejected, lstatRejected])
    } finally {
      statRelease.resolve(undefined)
      lstatRelease.resolve(undefined)
      await isolatedCtx?.fiber.dispose()
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
})

describe('readText / streamText', () => {
  it('reads whole-file text', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree')
    expect(await fs.readText(await fs.resolve('a.txt'))).toBe('one\ntwo\nthree')
  })

  it('streams the same text', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree')
    const target = await fs.resolve('a.txt')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('one\ntwo\nthree')
  })

  it('rejects a missing file, a directory, binary, and invalid UTF-8', async () => {
    await expect(fs.readText(await fs.resolve('nope'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(fs.readText(await fs.resolve('.'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })

    await writeFile(join(dir, 'bin'), Buffer.from([0x68, 0x00, 0x69]))
    await expect(fs.readText(await fs.resolve('bin'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })

    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    await expect(fs.readText(await fs.resolve('bad'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })
})

describe('readBytes', () => {
  it('reads raw bytes without decoding or NUL rejection', async () => {
    const raw = Buffer.from([0x68, 0x00, 0x69, 0xff])
    await writeFile(join(dir, 'a.bin'), raw)
    expect(Buffer.from(await fs.readBytes(await fs.resolve('a.bin'), undefined, raw.length))).toEqual(raw)
  })

  it('accepts a file exactly at maxBytes and rejects one past it', async () => {
    await writeFile(join(dir, 'a.bin'), Buffer.alloc(4, 1))
    const target = await fs.resolve('a.bin')
    expect((await fs.readBytes(target, undefined, 4)).length).toBe(4)
    await expect(fs.readBytes(target, undefined, 3)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('bounds content I/O when a file grows after stat preflight', async () => {
    await writeFile(join(dir, 'a.bin'), Buffer.alloc(4, 1))
    const target = await fs.resolve('a.bin')
    fs.internals.inspectReadBytesAfterStat = () => writeFile(join(dir, 'a.bin'), Buffer.alloc(1024 * 1024, 2))

    await expect(fs.readBytes(target, undefined, 4)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('rejects a missing file and a directory', async () => {
    await expect(fs.readBytes(await fs.resolve('nope'), undefined, 1024)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(fs.readBytes(await fs.resolve('.'), undefined, 1024)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('reads under a live signal and rejects an already-aborted one with FS_ABORTED', async () => {
    await writeFile(join(dir, 'a.bin'), 'data')
    const live = new AbortController()
    expect((await fs.readBytes(await fs.resolve('a.bin'), live.signal, 1024)).length).toBe(4)
    const controller = new AbortController()
    controller.abort()
    await expect(fs.readBytes(await fs.resolve('a.bin'), controller.signal, 1024)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('readByteRange', () => {
  /** 256 bytes, each equal to its offset. */
  const ramp = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

  it('reads a window from the middle of a file larger than the window', async () => {
    await writeFile(join(dir, 'ramp.bin'), ramp)
    const window = await fs.readByteRange(await fs.resolve('ramp.bin'), { offset: 100, length: 4 }, new AbortController().signal)
    expect([...window]).toEqual([100, 101, 102, 103])
  })

  it('shortens a window the file ends inside and empties one at or past the end', async () => {
    await writeFile(join(dir, 'ramp.bin'), ramp)
    const target = await fs.resolve('ramp.bin')
    expect([...await fs.readByteRange(target, { offset: 253, length: 10 })]).toEqual([253, 254, 255])
    expect((await fs.readByteRange(target, { offset: 256, length: 10 })).length).toBe(0)
    expect((await fs.readByteRange(target, { offset: 1000, length: 10 })).length).toBe(0)
  })

  it('returns an empty window for length 0 without touching content', async () => {
    await writeFile(join(dir, 'ramp.bin'), ramp)
    expect((await fs.readByteRange(await fs.resolve('ramp.bin'), { offset: 0, length: 0 })).length).toBe(0)
  })

  it('carries NUL and invalid UTF-8 untouched', async () => {
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41])
    await writeFile(join(dir, 'a.bin'), raw)
    expect(Buffer.from(await fs.readByteRange(await fs.resolve('a.bin'), { offset: 0, length: 4 }))).toEqual(raw)
  })

  it('rejects a missing file, a directory, and an already-aborted signal', async () => {
    await expect(fs.readByteRange(await fs.resolve('nope'), { offset: 0, length: 1 })).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(fs.readByteRange(await fs.resolve('.'), { offset: 0, length: 1 })).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await writeFile(join(dir, 'a.bin'), 'data')
    const controller = new AbortController()
    controller.abort()
    await expect(fs.readByteRange(await fs.resolve('a.bin'), { offset: 0, length: 1 }, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('listDir', () => {
  it('lists files and directories in stable name order with resolved child targets', async () => {
    await mkdir(join(dir, 'skills', 'dir-skill'), { recursive: true })
    await writeFile(join(dir, 'skills', 'zeta.md'), 'zeta')
    await writeFile(join(dir, 'skills', 'alpha.md'), 'alpha')
    await symlink(join(dir, 'skills', 'missing-target'), join(dir, 'skills', 'broken-link'))

    const entries = await fs.listDir(await fs.resolve('skills'))
    expect(entries.map(entry => [entry.name, entry.type])).toEqual([
      ['alpha.md', 'file'],
      ['broken-link', 'other'],
      ['dir-skill', 'directory'],
      ['zeta.md', 'file'],
    ])
    expect(entries.map(entry => entry.target.displayPath)).toEqual([
      join(dir, 'skills', 'alpha.md'),
      join(dir, 'skills', 'broken-link'),
      join(dir, 'skills', 'dir-skill'),
      join(dir, 'skills', 'zeta.md'),
    ])
    const materializedEntries = entries.filter(entry => entry.version !== undefined)
    expect(materializedEntries.map(entry => entry.target.targetKey))
      .toEqual(await Promise.all(materializedEntries.map(entry => realpath(entry.target.displayPath))))
    expect(entries.find(entry => entry.name === 'alpha.md')?.size).toBe(5)
    expect(typeof entries.find(entry => entry.name === 'alpha.md')?.version).toBe('string')
    expect(entries.find(entry => entry.name === 'broken-link')?.version).toBeUndefined()
    expect(entries.find(entry => entry.name === 'dir-skill')?.size).toBeUndefined()
  })

  it('reports a missing directory as FS_NOT_FOUND', async () => {
    await expect(fs.listDir(await fs.resolve('missing'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('reports a file target as FS_NOT_DIRECTORY', async () => {
    await writeFile(join(dir, 'a.txt'), 'text')
    await expect(fs.listDir(await fs.resolve('a.txt'))).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
  })

  it('honors a pre-aborted signal', async () => {
    await mkdir(join(dir, 'skills'), { recursive: true })
    await expect(fs.listDir(await fs.resolve('skills'), AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('writeText', () => {
  it('createIfAbsent creates a new file', async () => {
    const target = await fs.resolve('new.txt')
    const outcome = await fs.writeText(target, 'fresh', { kind: 'createIfAbsent' })
    expect(outcome.operation).toBe('create')
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('fresh')
  })

  it('createIfAbsent rejects an existing file as FS_NOT_OBSERVED', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const target = await fs.resolve('a.txt')
    await expect(fs.writeText(target, 'new', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('old')
  })

  it('createIfAbsent preserves a competitor created after the initial probe', async () => {
    const path = join(dir, 'a.txt')
    const target = await fs.resolve('a.txt')
    fs.internals.inspectTemp = async () => { await writeFile(path, 'competitor') }

    await expect(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await readFile(path, 'utf8')).toBe('competitor')
  })

  it('reports a createIfAbsent race with the unresolved display path', async () => {
    const realDirectory = join(dir, 'real-workspace')
    const linkedDirectory = join(dir, 'linked-workspace')
    await mkdir(realDirectory)
    await symlink(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    const target = await fs.resolve('linked-workspace/a.txt')
    fs.internals.inspectTemp = async () => { await writeFile(join(realDirectory, 'a.txt'), 'competitor') }

    await expect(fs.writeText(target, 'ours', { kind: 'createIfAbsent' })).rejects.toMatchObject({
      code: 'FS_NOT_OBSERVED',
      message: `cannot overwrite existing "${join(linkedDirectory, 'a.txt')}" without reading it first`,
    })
    expect(await readFile(join(realDirectory, 'a.txt'), 'utf8')).toBe('competitor')
  })

  it('createIfAbsent rejects a competing directory as not a regular file', async () => {
    const path = join(dir, 'a.txt')
    const target = await fs.resolve('a.txt')
    fs.internals.inspectTemp = async () => { await mkdir(path) }

    await expect(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  it('createIfAbsent rejects and preserves a dangling symbolic link', async () => {
    const path = join(dir, 'dangling')
    await symlink(join(dir, 'missing-target'), path)
    const target = await fs.resolve('dangling')

    await expect(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaceIfVersion replaces when the version matches', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const target = await fs.resolve('a.txt')
    const outcome = await fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: await versionOf(target) })
    expect(outcome.operation).toBe('update')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new')
  })

  it('replaceIfVersion rejects a stale version', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1')
    const target = await fs.resolve('a.txt')
    const stale = await versionOf(target)
    await writeFile(join(dir, 'a.txt'), 'changed-externally')
    await expect(fs.writeText(target, 'v2', { kind: 'replaceIfVersion', version: stale }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('replaceIfVersion rejects a deleted target as stale, without recreating it', async () => {
    const path = join(dir, 'a.txt')
    await writeFile(path, 'v1')
    const target = await fs.resolve('a.txt')
    const version = await versionOf(target)
    await unlink(path)
    await expect(fs.writeText(target, 'v2', { kind: 'replaceIfVersion', version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects writing onto a directory', async () => {
    const target = await fs.resolve('.')
    await expect(fs.writeText(target, 'x', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('unconditionally creates a new file with no expectation (bare provider)', async () => {
    const target = await fs.resolve('new.txt')
    const outcome = await fs.writeText(target, 'fresh')
    expect(outcome.operation).toBe('create')
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('fresh')
  })

  it('unconditionally OVERWRITES an existing file with no expectation (bare provider)', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const target = await fs.resolve('a.txt')
    const outcome = await fs.writeText(target, 'clobbered')
    expect(outcome.operation).toBe('update')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('clobbered')
  })

  it('rejects writing onto a directory even with no expectation', async () => {
    const target = await fs.resolve('.')
    await expect(fs.writeText(target, 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('a create reports before:null and after = the written content (no prior file)', async () => {
    const target = await fs.resolve('new.txt')
    const outcome = await fs.writeText(target, 'fresh')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('fresh')
  })

  it('an overwrite reports before = the OLD content and after = the new content', async () => {
    await writeFile(join(dir, 'a.txt'), 'old body')
    const target = await fs.resolve('a.txt')
    const outcome = await fs.writeText(target, 'new body')
    expect(outcome.before).toBe('old body')
    expect(outcome.after).toBe('new body')
  })

  it('an overwrite returns LF-normalized before AND after (a CRLF rewrite is not every-line-changed)', async () => {
    // The applied-hunk diff bases on `before`/`after`; if `after` kept CRLF while
    // `before` is LF-normalized, a CRLF rewrite would read as every line changed.
    // Both sides are LF so only the genuinely-changed line diffs.
    await writeFile(join(dir, 'a.txt'), 'a\r\nb\r\nc\r\n')
    const target = await fs.resolve('a.txt')
    const outcome = await fs.writeText(target, 'a\r\nB\r\nc\r\n')
    expect(outcome.before).toBe('a\nb\nc\n')
    expect(outcome.after).toBe('a\nB\nc\n')
  })

  it('an overwrite of a BINARY prior file reports before:null (undiffable), still succeeds', async () => {
    await writeFile(join(dir, 'a.bin'), Buffer.from([0x00, 0x01, 0x02]))
    const target = await fs.resolve('a.bin')
    const outcome = await fs.writeText(target, 'now text')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('now text')
  })

  it('an overwrite of an INVALID-UTF-8 (non-NUL) prior file reports before:null, still succeeds', async () => {
    // 0xff is never valid UTF-8 but is not a NUL, so it exercises the decoder's
    // fatal-throw path (not the NUL-scan short-circuit): an undiffable prior file
    // still yields a successful write with no before-content basis.
    await writeFile(join(dir, 'a.bin'), Buffer.from([0x68, 0xff, 0x69]))
    const target = await fs.resolve('a.bin')
    const outcome = await fs.writeText(target, 'now valid')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('now valid')
  })

  it('an overwrite of a prior file AT the whole-file bound reports before:null (undiffable), still succeeds', async () => {
    // The configured bound keeps the fixture small; 8 bytes at a bound of 8
    // pins the exclusive edge without coupling this provider to a read tool.
    await remountWithDiffLimit(8)
    await writeFile(join(dir, 'big.txt'), '12345678')
    const target = await fs.resolve('big.txt')
    const outcome = await fs.writeText(target, 'tiny')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('tiny')
  })

  it('an overwrite whose NEW content is at the whole-file bound reports before:null (no huge contextual diff)', async () => {
    // The bound gates BOTH sides of the diff pair: a small prior file rewritten
    // with at/above-bound content yields no contextual-hunk basis either, since
    // a small-to-huge rewrite's hunk is as large as the new content — the
    // consumer must fall back to the whole-file diff card, exactly like a
    // create of the same size.
    await remountWithDiffLimit(8)
    await writeFile(join(dir, 'grow.txt'), 'tiny')
    const target = await fs.resolve('grow.txt')
    const outcome = await fs.writeText(target, '12345678')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('12345678')
  })

  it('gates the NEW content by UTF-8 byte length, not character count', async () => {
    // Three CJK characters are 9 UTF-8 bytes: below an 8-byte bound by
    // characters but at/above it by bytes, so the basis must be declined.
    await remountWithDiffLimit(8)
    await writeFile(join(dir, 'cjk.txt'), 'tiny')
    const target = await fs.resolve('cjk.txt')
    const outcome = await fs.writeText(target, '你好吗')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('你好吗')
  })

  it('an overwrite with BOTH sides below the whole-file bound keeps its contextual before basis', async () => {
    await remountWithDiffLimit(8)
    await writeFile(join(dir, 'small.txt'), '1234567')
    const target = await fs.resolve('small.txt')
    const outcome = await fs.writeText(target, 'new')
    expect(outcome.before).toBe('1234567')
    expect(outcome.after).toBe('new')
  })

  it('releases per-target mutation locks after success and failure', async () => {
    const target = await fs.resolve('a.txt')
    await fs.writeText(target, 'created', { kind: 'createIfAbsent' })
    expect(lockCount(fs)).toBe(0)
    await expect(fs.writeText(target, 'again', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(lockCount(fs)).toBe(0)
  })

  it('replaceIfVersion returns the post-write version (matches a fresh stat)', async () => {
    await writeFile(join(dir, 'a.txt'), 'v1')
    const target = await fs.resolve('a.txt')
    const before = await versionOf(target)
    const outcome = await fs.writeText(target, 'a much longer replacement body', { kind: 'replaceIfVersion', version: before })
    expect(outcome.version).not.toBe(before)
    expect(outcome.version).toBe(await versionOf(target))
  })

  it('honors a pre-aborted signal without creating the file', async () => {
    const target = await fs.resolve('aborted.txt')
    await expect(fs.writeText(target, 'x', undefined, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(stat(join(dir, 'aborted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(lockCount(fs)).toBe(0)
  })

  it('two concurrent guarded writes: one updates, the other is rejected as stale', async () => {
    await writeFile(join(dir, 'a.txt'), 'base')
    const target = await fs.resolve('a.txt')
    const version = await versionOf(target)
    const results = await Promise.allSettled([
      fs.writeText(target, 'one', { kind: 'replaceIfVersion', version }),
      fs.writeText(target, 'two', { kind: 'replaceIfVersion', version }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(r => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(lockCount(fs)).toBe(0)
  })
})

describe('editText', () => {
  it('applies a literal edit at the matching version', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const target = await fs.resolve('a.txt')
    const outcome = await fs.editText(target, { oldString: 'world', newString: 'there', replaceAll: false }, { version: await versionOf(target) })
    expect(outcome.after).toBe('hello there')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello there')
  })

  it('reports before/after content (the applied-hunk basis), LF-normalized', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\r\nOLD\r\nb\r\n')
    const target = await fs.resolve('a.txt')
    const outcome = await fs.editText(target, { oldString: 'OLD', newString: 'NEW', replaceAll: false })
    expect(outcome.before).toBe('a\nOLD\nb\n')
    expect(outcome.after).toBe('a\nNEW\nb\n')
    // The written file keeps the original CRLF endings (before/after are the
    // LF-normalized diff basis, not the on-disk bytes).
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a\r\nNEW\r\nb\r\n')
  })

  it('checks the stale version BEFORE literal matching', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const target = await fs.resolve('a.txt')
    const stale = await versionOf(target)
    // Change the file so 'world' is gone — a stale edit must report STALE, not NOT_FOUND.
    await writeFile(join(dir, 'a.txt'), 'goodbye')
    await expect(fs.editText(target, { oldString: 'world', newString: 'there', replaceAll: false }, { version: stale }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('unconditionally edits the current content with no expectation (bare provider)', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const target = await fs.resolve('a.txt')
    // No version guard: any current content is edited, regardless of version.
    const outcome = await fs.editText(target, { oldString: 'world', newString: 'there', replaceAll: false })
    expect(outcome.after).toBe('hello there')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello there')
  })

  it('reports a missing target as FS_STALE_VERSION even with no expectation (bare provider)', async () => {
    const target = await fs.resolve('missing.txt')
    await expect(fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('still reports literal-match codes with no expectation (FS_EDIT_NOT_FOUND, unrelated to freshness)', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const target = await fs.resolve('a.txt')
    await expect(fs.editText(target, { oldString: 'absent', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
  })

  it('rejects a deleted target as stale (before matching)', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const target = await fs.resolve('a.txt')
    const version = await versionOf(target)
    await unlink(join(dir, 'a.txt'))
    await expect(fs.editText(target, { oldString: 'hello', newString: 'bye', replaceAll: false }, { version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('rejects a non-regular target', async () => {
    const target = await fs.resolve('.')
    await expect(fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }, { version: FsVersion('v') }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('rejects zero matches and ambiguous matches at the right version', async () => {
    await writeFile(join(dir, 'a.txt'), 'a a a')
    const target = await fs.resolve('a.txt')
    const version = await versionOf(target)
    await expect(fs.editText(target, { oldString: 'z', newString: 'X', replaceAll: false }, { version }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(fs.editText(target, { oldString: 'a', newString: 'X', replaceAll: false }, { version }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
  })

  it('replaces all matches with replaceAll', async () => {
    await writeFile(join(dir, 'a.txt'), 'a a a')
    const target = await fs.resolve('a.txt')
    const outcome = await fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: true }, { version: await versionOf(target) })
    expect(outcome.after).toBe('b b b')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('b b b')
  })

  it('rejects invalid UTF-8 without rewriting the file', async () => {
    const path = join(dir, 'bad.txt')
    const bytes = Buffer.from([0x68, 0xff, 0x69])
    await writeFile(path, bytes)
    const target = await fs.resolve('bad.txt')
    const version = await versionOf(target)
    await expect(fs.editText(target, { oldString: 'h', newString: 'H', replaceAll: false }, { version }))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    expect(await readFile(path)).toEqual(bytes)
  })

  it('two concurrent edits: one wins, the other is rejected as stale', async () => {
    await writeFile(join(dir, 'a.txt'), 'base')
    const target = await fs.resolve('a.txt')
    const version = await versionOf(target)
    const results = await Promise.allSettled([
      fs.editText(target, { oldString: 'base', newString: 'one', replaceAll: false }, { version }),
      fs.editText(target, { oldString: 'base', newString: 'two', replaceAll: false }, { version }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(r => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(lockCount(fs)).toBe(0)
  })

  it('honors a pre-aborted signal without rewriting the file', async () => {
    await writeFile(join(dir, 'a.txt'), 'keep')
    const target = await fs.resolve('a.txt')
    await expect(fs.editText(target, { oldString: 'keep', newString: 'x', replaceAll: false }, undefined, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('keep')
    expect(lockCount(fs)).toBe(0)
  })

  it('a successful edit refreshes the version so an immediate follow-up edit proceeds', async () => {
    await writeFile(join(dir, 'a.txt'), 'one two')
    const target = await fs.resolve('a.txt')
    const first = await fs.editText(target, { oldString: 'one', newString: 'ONE', replaceAll: false }, { version: await versionOf(target) })
    // The version the first edit returned is a valid guard for a second edit —
    // no intervening re-stat needed.
    const second = await fs.editText(target, { oldString: 'two', newString: 'TWO', replaceAll: false }, { version: first.version })
    expect(second.after).toBe('ONE TWO')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('ONE TWO')
  })

  it('concurrent write vs edit at the same version: one wins, the other is stale', async () => {
    await writeFile(join(dir, 'a.txt'), 'base')
    const target = await fs.resolve('a.txt')
    const version = await versionOf(target)
    const results = await Promise.allSettled([
      fs.writeText(target, 'written', { kind: 'replaceIfVersion', version }),
      fs.editText(target, { oldString: 'base', newString: 'edited', replaceAll: false }, { version }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(r => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(lockCount(fs)).toBe(0)
  })
})

describe('symlink targetKey identity', () => {
  it('two paths to the same file via a symlink share one version and write the real target', async () => {
    await writeFile(join(dir, 'real.txt'), 'hello')
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'))
    const viaReal = await fs.resolve('real.txt')
    const viaLink = await fs.resolve('link.txt')
    expect(viaLink.targetKey).toBe(viaReal.targetKey)

    const version = await versionOf(viaReal)
    await fs.editText(viaLink, { oldString: 'hello', newString: 'bye', replaceAll: false }, { version })
    expect(await readFile(join(dir, 'real.txt'), 'utf8')).toBe('bye') // link preserved
  })

  it('a stale change is detected across both paths', async () => {
    await writeFile(join(dir, 'real.txt'), 'hello')
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'))
    const viaReal = await fs.resolve('real.txt')
    const stale = await versionOf(viaReal)
    await writeFile(join(dir, 'real.txt'), 'changed')
    const viaLink = await fs.resolve('link.txt')
    await expect(fs.editText(viaLink, { oldString: 'hello', newString: 'bye', replaceAll: false }, { version: stale }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })
})

describe('HMR / disposal', () => {
  it('disposing the fiber withdraws ctx.fs', async () => {
    const local = new Context()
    const localFiber = await local.plugin(LocalFileSystem, { cwd: dir })
    expect(local.fs).toBeDefined()
    await localFiber.dispose()
    expect(local.fs).toBeUndefined()
  })
})
