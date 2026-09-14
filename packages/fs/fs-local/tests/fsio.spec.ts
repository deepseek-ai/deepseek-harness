/**
 * Cordis-free tests for the raw local-filesystem I/O: path resolution, probe,
 * whole-file/streamed text reads, binary/UTF-8 rejection, atomic-write temp
 * safety, literal edit matching, and line-ending handling. Line WINDOWING is
 * policy and lives in `dsh-fs-observation-policy`, so it is not tested here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile, mkdir, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { createServer } from 'node:net'
import {
  applyLiteralEdit,
  listDirectory,
  probe,
  probeNoFollow,
  readForEdit,
  readTextForDiff,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from '../src/fsio.ts'
import type { LocalTarget } from '../src/fsio.ts'
import { copyFileDaclWin32, readFileDaclWin32 } from '../src/win32.ts'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fsio-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const localTarget = (path: string): LocalTarget => ({ displayPath: path, targetKey: FsTargetKey(path) })

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of chunks) out += chunk
  return out
}

describe('resolveLocalTarget', () => {
  it('resolves a relative path from cwd and realpaths it', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    const target = await resolveLocalTarget(dir, 'a.txt')
    expect(target.displayPath).toBe(file)
    expect(target.targetKey).toBe(await realpath(file))
  })

  it('uses the realpathed parent + basename when the file does not exist (stable across create)', async () => {
    const target = await resolveLocalTarget(dir, 'missing.txt')
    expect(target.targetKey).toBe(join(await realpath(dir), 'missing.txt'))
  })

  it('two paths to the same file via a symlink share one targetKey', async () => {
    const real = join(dir, 'real.txt')
    await writeFile(real, 'hi')
    const link = join(dir, 'link.txt')
    await symlink(real, link)
    const viaReal = await resolveLocalTarget(dir, 'real.txt')
    const viaLink = await resolveLocalTarget(dir, 'link.txt')
    expect(viaLink.targetKey).toBe(viaReal.targetKey)
    expect(viaLink.displayPath).toBe(link)
  })

  it('realpaths the nearest existing ancestor when intermediate dirs are missing', async () => {
    const target = await resolveLocalTarget(dir, 'no-such-dir/child.txt')
    expect(target.targetKey).toBe(join(await realpath(dir), 'no-such-dir', 'child.txt'))
  })

  it('keeps the key stable across create when an ancestor is a symlink', async () => {
    // A symlinked workspace root with a not-yet-created subdirectory: the
    // pre-create key (via the symlink, missing parent) must equal the
    // post-create key (file exists, realpathed) so observed-state survives.
    const realRoot = join(dir, 'real-root')
    await mkdir(realRoot)
    const linkRoot = join(dir, 'link-root')
    await symlink(realRoot, linkRoot)

    const before = await resolveLocalTarget(linkRoot, 'sub/file.txt')
    await mkdir(join(realRoot, 'sub'), { recursive: true })
    await writeFile(join(realRoot, 'sub', 'file.txt'), 'hi') // create through the real path
    const after = await resolveLocalTarget(linkRoot, 'sub/file.txt')
    expect(before.targetKey).toBe(after.targetKey)
  })

  it('rejects a blank path', async () => {
    await expect(resolveLocalTarget(dir, '   ')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('anchors a relative cwd before retaining parent traversal in a display path', async () => {
    await mkdir(join(dir, 'nested'))
    const cwd = relative(process.cwd(), dir)
    const target = await resolveLocalTarget(cwd, 'nested/../created.txt')
    expect(isAbsolute(target.displayPath)).toBe(true)
    expect(target.targetKey).toBe(join(await realpath(dir), 'created.txt'))
    expect((await resolveLocalTarget(cwd, target.displayPath)).targetKey).toBe(target.targetKey)
  })

  it.skipIf(process.platform === 'win32')('rejects parent traversal through a missing directory hierarchy', async () => {
    await expect(resolveLocalTarget(dir, 'missing/deeper/../created.txt')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it.skipIf(process.platform !== 'win32')('preserves native drive-relative cwd and path resolution', async () => {
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'created.txt'), 'native')
    const drive = parse(dir).root.slice(0, 2)
    // Resolve the temp drive independently when the checkout lives on another volume.
    const driveCwd = `${drive}${relative(resolve(drive), dir)}`
    for (const cwd of [dir, driveCwd]) {
      for (const requested of ['created.txt', `${drive}nested/../created.txt`]) {
        const target = await resolveLocalTarget(cwd, requested)
        const expected = resolve(cwd, requested)
        expect(target.displayPath).toBe(expected)
        expect(target.targetKey).toBe(await realpath(expected))
      }
    }
    const missing = await resolveLocalTarget(dir, 'missing/deeper/../created.txt')
    expect(missing.targetKey).toBe(join(await realpath(dir), 'missing', 'created.txt'))
  })

  it.skipIf(process.platform === 'win32')('resolves parent traversal after a symlink in the provider filesystem', async () => {
    const physical = join(dir, 'physical')
    await mkdir(join(physical, 'nested'), { recursive: true })
    await mkdir(join(dir, 'lexical'))
    await symlink(join(physical, 'nested'), join(dir, 'lexical', 'link'))
    const cwd = `${join(dir, 'lexical', 'link')}/..`
    const before = await resolveLocalTarget(cwd, 'created.txt')
    expect(before.targetKey).toBe(join(await realpath(physical), 'created.txt'))
    await writeFile(join(physical, 'created.txt'), 'physical')
    expect((await resolveLocalTarget(dir, 'lexical/link/../created.txt')).targetKey).toBe(before.targetKey)
    await expect(resolveLocalTarget(dir, 'missing/../created.txt')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('rejects a path whose ancestor is a file with a structured FsError (ENOTDIR)', async () => {
    // "afile" is a regular file, so "afile/child.txt" hits ENOTDIR on realpath;
    // the raw Node error must be translated into the FsError taxonomy so the tool
    // result keeps its { name, code } metadata.
    await writeFile(join(dir, 'afile'), 'i am a file')
    const err = await resolveLocalTarget(dir, 'afile/child.txt').then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(FsError)
    expect(err).toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('probe', () => {
  it('returns null for a missing path and metadata for a file', async () => {
    expect(await probe(join(dir, 'nope'))).toBeNull()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    const info = await probe(file)
    expect(info?.type).toBe('file')
    expect(info?.size).toBe(2)
    expect(typeof info?.version).toBe('string')
  })

  it('reports a directory and a non-regular type', async () => {
    const sub = join(dir, 'sub')
    await mkdir(sub)
    expect((await probe(sub))?.type).toBe('directory')
  })

  it('reports a socket/special file as type "other"', async () => {
    const sockPath = join(dir, 'sock')
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(sockPath, () => { resolve() })
      })
    } catch (error: unknown) {
      // A restricted sandbox may forbid unix-domain sockets; that is an
      // environment limit, not a filesystem regression — skip rather than fail.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return
      throw error
    }
    try {
      expect((await probe(sockPath))?.type).toBe('other')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('returns null when an ancestor path segment is a file (ENOTDIR), not a raw throw', async () => {
    await writeFile(join(dir, 'afile'), 'i am a file')
    expect(await probe(join(dir, 'afile', 'child.txt'))).toBeNull()
  })
})

describe('probeNoFollow', () => {
  it('reports symlinks without following them', async () => {
    const real = join(dir, 'real.txt')
    const link = join(dir, 'link.txt')
    await writeFile(real, 'hi')
    await symlink(real, link)

    expect((await probeNoFollow(real))?.type).toBe('file')
    const linkInfo = await probeNoFollow(link)
    expect(linkInfo?.type).toBe('symlink')
    expect(typeof linkInfo?.version).toBe('string')
    expect(linkInfo?.size).toBeGreaterThan(0)
  })

  it('returns null for a missing path or a file-valued ancestor path segment', async () => {
    expect(await probeNoFollow(join(dir, 'missing'))).toBeNull()
    await writeFile(join(dir, 'afile'), 'i am a file')
    expect(await probeNoFollow(join(dir, 'afile', 'child.txt'))).toBeNull()
  })
})

describe('listDirectory', () => {
  it.skipIf(process.platform === 'win32')('preserves physical parent traversal in displayed child paths', async () => {
    const lexical = join(dir, 'lexical')
    const physical = join(dir, 'physical')
    await mkdir(lexical)
    await mkdir(join(physical, 'nested'), { recursive: true })
    await symlink(join(physical, 'nested'), join(lexical, 'link'))
    await writeFile(join(lexical, 'same.txt'), 'lexical file')
    await writeFile(join(physical, 'same.txt'), 'physical file')

    const parent = await resolveLocalTarget(dir, 'lexical/link/..')
    const entries = await listDirectory(parent)
    const child = entries.find(entry => entry.name === 'same.txt')!
    expect(await readFile(child.target.displayPath, 'utf8')).toBe('physical file')
    expect((await resolveLocalTarget(dir, child.target.displayPath)).targetKey).toBe(child.target.targetKey)
  })

  it('lists direct children in stable order without reading content', async () => {
    const root = join(dir, 'skills')
    await mkdir(join(root, 'dir-skill'), { recursive: true })
    await writeFile(join(root, 'zeta.md'), 'zeta')
    await writeFile(join(root, 'alpha.md'), 'alpha')
    await symlink(join(root, 'missing-target'), join(root, 'broken-link'))

    const entries = await listDirectory(localTarget(root))
    expect(entries.map(entry => [entry.name, entry.type])).toEqual([
      ['alpha.md', 'file'],
      ['broken-link', 'other'],
      ['dir-skill', 'directory'],
      ['zeta.md', 'file'],
    ])
    expect(entries.find(entry => entry.name === 'alpha.md')?.size).toBe(5)
    expect(typeof entries.find(entry => entry.name === 'alpha.md')?.version).toBe('string')
    expect(entries.find(entry => entry.name === 'broken-link')?.version).toBeUndefined()
    expect(entries.find(entry => entry.name === 'dir-skill')?.size).toBeUndefined()
  })

  it('derives child target keys from the listed parent identity', async () => {
    const realOne = join(dir, 'real-one')
    const realTwo = join(dir, 'real-two')
    const link = join(dir, 'link')
    await mkdir(realOne)
    await mkdir(realTwo)
    await writeFile(join(realOne, 'same.txt'), 'one')
    await writeFile(join(realTwo, 'same.txt'), 'different two')
    await symlink(realOne, link)
    const target = await resolveLocalTarget(dir, 'link')

    await unlink(link)
    await symlink(realTwo, link)

    const entries = await listDirectory(target)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'same.txt',
      target: {
        displayPath: join(link, 'same.txt'),
        targetKey: await realpath(join(realOne, 'same.txt')),
      },
      size: 3,
    })
  })

  it('rejects missing, non-directory, and aborted listing requests', async () => {
    await expect(listDirectory(localTarget(join(dir, 'missing')))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hi')
    await expect(listDirectory(localTarget(file))).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    await expect(listDirectory(localTarget(dir), AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('translates directory permission failures into FS_PERMISSION_DENIED', async () => {
    const root = join(dir, 'restricted')
    await mkdir(root)
    await chmod(root, 0o000)
    try {
      const error = await listDirectory(localTarget(root)).then(() => undefined, (caught: unknown) => caught)
      // Root-like environments may still be able to list mode-000 directories.
      if (error === undefined) return
      expect(error).toBeInstanceOf(FsError)
      expect(error).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    } finally {
      await chmod(root, 0o700)
    }
  })

  it('translates preflight metadata IO failures into FS_IO_ERROR', async () => {
    const loop = join(dir, 'loop')
    await symlink(loop, loop)
    await expect(listDirectory(localTarget(loop))).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('translates child resolution failures into structured listing errors', async () => {
    const root = join(dir, 'listed')
    await mkdir(root)
    const loop = join(root, 'loop')
    await symlink(loop, loop)
    await expect(listDirectory(localTarget(root))).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('translates child permission failures into FS_PERMISSION_DENIED', async () => {
    const root = join(dir, 'listed')
    const protectedRoot = join(dir, 'protected')
    const secret = join(protectedRoot, 'secret')
    await mkdir(root)
    await mkdir(secret, { recursive: true })
    await symlink(secret, join(root, 'secret-link'))
    await chmod(protectedRoot, 0o000)
    try {
      const error = await listDirectory(localTarget(root)).then(() => undefined, (caught: unknown) => caught)
      // Root-like environments may still resolve through mode-000 directories.
      if (error === undefined) return
      expect(error).toBeInstanceOf(FsError)
      expect(error).toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    } finally {
      await chmod(protectedRoot, 0o700)
    }
  })
})

describe('readWholeText', () => {
  it('reads a small file', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree')
    expect(await readWholeText(localTarget(file))).toBe('one\ntwo\nthree')
  })

  it('rejects a missing file and a directory', async () => {
    await expect(readWholeText(localTarget(join(dir, 'nope')))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(readWholeText(localTarget(dir))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('rejects binary and invalid UTF-8', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x68, 0x00, 0x69]))
    await expect(readWholeText(localTarget(join(dir, 'bin')))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    await expect(readWholeText(localTarget(join(dir, 'bad')))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('honors a pre-aborted signal', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one')
    await expect(readWholeText(localTarget(file), AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('passes a live (non-aborted) signal through', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    expect(await readWholeText(localTarget(file), new AbortController().signal)).toBe('one\ntwo')
  })

  it('translates a mid-read AbortError into FS_ABORTED', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const ac = new AbortController()
    // Abort after the synchronous entry check but before readFile runs (the
    // stat await yields control back here), so readFile rejects AbortError.
    const pending = readWholeText(localTarget(file), ac.signal)
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

describe('readTextForDiff', () => {
  it('returns normalized text only when the opened file is strictly below the limit', async () => {
    const file = join(dir, 'basis.txt')
    await writeFile(file, 'a\r\nb')
    expect(await readTextForDiff(file, 5)).toBe('a\nb')
    expect(await readTextForDiff(file, 4)).toBeNull()
  })

  it('bounds the actual opened file rather than trusting an earlier path size', async () => {
    const file = join(dir, 'replaced.txt')
    await writeFile(file, 'tiny')
    const earlierSize = (await stat(file)).size
    await writeFile(file, '123456789')
    expect(earlierSize).toBeLessThan(8)
    expect(await readTextForDiff(file, 8)).toBeNull()
  })

  it('returns null when the opened file shrinks after descriptor stat', async () => {
    const file = join(dir, 'shrinking.txt')
    await writeFile(file, 'abcdef')
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open(...args: Parameters<typeof actual.open>) {
          const handle = await actual.open(...args)
          return {
            close: handle.close.bind(handle),
            read: handle.read.bind(handle),
            async stat(...statArgs: Parameters<typeof handle.stat>) {
              const info = await handle.stat(...statArgs)
              await writeFile(file, 'abc')
              return info
            },
          }
        },
      }
    })

    try {
      const { readTextForDiff: isolatedReadTextForDiff } = await import('../src/fsio.ts')
      expect(await isolatedReadTextForDiff(file, 8)).toBeNull()
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('returns null when the opened file grows after descriptor stat', async () => {
    const file = join(dir, 'growing.txt')
    await writeFile(file, 'abcdef')
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open(...args: Parameters<typeof actual.open>) {
          const handle = await actual.open(...args)
          return {
            close: handle.close.bind(handle),
            read: handle.read.bind(handle),
            async stat(...statArgs: Parameters<typeof handle.stat>) {
              const info = await handle.stat(...statArgs)
              await writeFile(file, 'abcdef-grown')
              return info
            },
          }
        },
      }
    })

    try {
      const { readTextForDiff: isolatedReadTextForDiff } = await import('../src/fsio.ts')
      expect(await isolatedReadTextForDiff(file, 32)).toBeNull()
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('returns null when the file vanishes before the basis open (deletion race)', async () => {
    expect(await readTextForDiff(join(dir, 'deleted-after-preflight.txt'), 32)).toBeNull()
  })

  it('returns null when the opened descriptor is no longer a regular file', async () => {
    const file = join(dir, 'swapped.txt')
    await writeFile(file, 'abcdef')
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open(...args: Parameters<typeof actual.open>) {
          const handle = await actual.open(...args)
          return {
            close: handle.close.bind(handle),
            read: handle.read.bind(handle),
            async stat(...statArgs: Parameters<typeof handle.stat>) {
              const info = await handle.stat(...statArgs)
              return Object.assign(info, { isFile: () => false })
            },
          }
        },
      }
    })

    try {
      const { readTextForDiff: isolatedReadTextForDiff } = await import('../src/fsio.ts')
      expect(await isolatedReadTextForDiff(file, 32)).toBeNull()
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('propagates a non-errno fault instead of masking it as a null basis', async () => {
    const file = join(dir, 'faulted.txt')
    await writeFile(file, 'abcdef')
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open() {
          throw new TypeError('forged programming fault')
        },
      }
    })

    try {
      const { readTextForDiff: isolatedReadTextForDiff } = await import('../src/fsio.ts')
      await expect(isolatedReadTextForDiff(file, 32)).rejects.toThrow('forged programming fault')
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('returns null for binary and invalid UTF-8 without blocking the caller write', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x68, 0x00, 0x69]))
    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    expect(await readTextForDiff(join(dir, 'bin'), 8)).toBeNull()
    expect(await readTextForDiff(join(dir, 'bad'), 8)).toBeNull()
  })

  it('honors a pre-aborted signal', async () => {
    const file = join(dir, 'basis.txt')
    await writeFile(file, 'text')
    await expect(readTextForDiff(file, 8, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it.each(['open', 'stat'] as const)('observes cancellation immediately after %s', async (stage) => {
    const file = join(dir, 'basis.txt')
    await writeFile(file, 'text')
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let statCalls = 0
    const allocUnsafe = Buffer.allocUnsafe.bind(Buffer)
    // Buffer.allocUnsafe is also called by vitest's fork IPC
    // (node:internal/child_process serialization), so a process-wide call count
    // is timing-racy under CI load. Attribute allocations to the fsio read path
    // instead: the abort must prevent the diff-basis buffer allocation.
    const fsioAllocations: string[] = []
    const allocate = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((size: number) => {
      const stack = new Error().stack ?? ''
      if (stack.includes('readTextForDiff')) fsioAllocations.push(stack)
      return allocUnsafe(size)
    })
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open(...args: Parameters<typeof actual.open>) {
          const handle = await actual.open(...args)
          if (stage === 'open') {
            reached.resolve(undefined)
            await release.promise
          }
          return {
            close: handle.close.bind(handle),
            read: handle.read.bind(handle),
            async stat(...statArgs: Parameters<typeof handle.stat>) {
              statCalls += 1
              const info = await handle.stat(...statArgs)
              if (stage === 'stat') {
                reached.resolve(undefined)
                await release.promise
              }
              return info
            },
          }
        },
      }
    })

    try {
      const { readTextForDiff: isolatedReadTextForDiff } = await import('../src/fsio.ts')
      const controller = new AbortController()
      const pending = isolatedReadTextForDiff(file, 8, controller.signal)
      await reached.promise
      controller.abort()
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
      expect(statCalls).toBe(stage === 'open' ? 0 : 1)
      expect(fsioAllocations).toEqual([])
    } finally {
      release.resolve(undefined)
      allocate.mockRestore()
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('bounds descriptor reads and observes cancellation before the next chunk', async () => {
    const file = join(dir, 'large-basis.txt')
    const fileBytes = 200 * 1024
    await writeFile(file, 'x'.repeat(fileBytes))
    const firstRead = Promise.withResolvers<undefined>()
    const releaseFirstRead = Promise.withResolvers<undefined>()
    const readLengths: number[] = []
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open(...args: Parameters<typeof actual.open>) {
          const handle = await actual.open(...args)
          return {
            stat: handle.stat.bind(handle),
            close: handle.close.bind(handle),
            async read(buffer: Buffer, offset: number, length: number, position: number | null) {
              readLengths.push(length)
              const result = await handle.read(buffer, offset, length, position)
              if (readLengths.length === 1) {
                firstRead.resolve(undefined)
                await releaseFirstRead.promise
              }
              return result
            },
          }
        },
      }
    })

    try {
      const { readTextForDiff: isolatedReadTextForDiff } = await import('../src/fsio.ts')
      const controller = new AbortController()
      const pending = isolatedReadTextForDiff(file, fileBytes + 1, controller.signal)
      await firstRead.promise
      expect(readLengths).toEqual([64 * 1024])
      controller.abort()
      releaseFirstRead.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
      expect(readLengths).toHaveLength(1)
    } finally {
      releaseFirstRead.resolve(undefined)
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
})

describe('streamWholeText', () => {
  it('streams the whole file as decoded text', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo\nthree')
    expect(await collect(streamWholeText(localTarget(file)))).toBe('one\ntwo\nthree')
  })

  it('streams a large multi-chunk file correctly', async () => {
    const file = join(dir, 'big.txt')
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}: ${'x'.repeat(3000)}`).join('\n')
    await writeFile(file, content)
    expect(await collect(streamWholeText(localTarget(file)))).toBe(content)
  })

  it('rejects a missing file, directory, binary, and invalid UTF-8', async () => {
    await expect(collect(streamWholeText(localTarget(join(dir, 'nope'))))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(collect(streamWholeText(localTarget(dir)))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await writeFile(join(dir, 'bin'), Buffer.from([0x68, 0x00, 0x69]))
    await expect(collect(streamWholeText(localTarget(join(dir, 'bin'))))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    await expect(collect(streamWholeText(localTarget(join(dir, 'bad'))))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('honors a pre-aborted signal', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one')
    await expect(collect(streamWholeText(localTarget(file), AbortSignal.abort()))).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('passes a live (non-aborted) signal through the stream', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    expect(await collect(streamWholeText(localTarget(file), new AbortController().signal))).toBe('one\ntwo')
  })

  it('translates a mid-stream abort into FS_ABORTED', async () => {
    // A multi-chunk file so the stream yields more than once; abort after the
    // first chunk and assert the structured code, not a raw AbortError.
    const file = join(dir, 'big.txt')
    await writeFile(file, 'x'.repeat(256 * 1024))
    const ac = new AbortController()
    const run = async (): Promise<void> => {
      let seen = 0
      for await (const _chunk of streamWholeText(localTarget(file), ac.signal)) {
        seen += 1
        if (seen === 1) ac.abort()
      }
    }
    await expect(run()).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})

// Windows drives only the read-only attribute through `chmod` and reports synthetic `stat` mode
// bits, so mode assertions are POSIX-only; native DACL preservation is asserted separately.
const posixModes = process.platform !== 'win32'

function daclAcePolicy(descriptor: Buffer): string[] {
  const daclOffset = descriptor.readUInt32LE(16)
  if (daclOffset === 0) return []
  const aceCount = descriptor.readUInt16LE(daclOffset + 4)
  const policy: string[] = []
  const seen = new Set<string>()
  let offset = daclOffset + 8
  for (let index = 0; index < aceCount; index++) {
    const size = descriptor.readUInt16LE(offset + 2)
    const ace = Buffer.from(descriptor.subarray(offset, offset + size))
    // INHERITED_ACE records which parent ACE produced this entry, not the entry's access policy.
    ace.writeUInt8(ace.readUInt8(1) & ~0x10, 1)
    const key = ace.toString('hex')
    if (!seen.has(key)) {
      seen.add(key)
      policy.push(key)
    }
    offset += size
  }
  return policy
}

describe('writeFileAtomic — temp-file safety', () => {
  it('writes through a private staging dir and owner-only temp file', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'old')
    if (posixModes) await chmod(file, 0o640)
    let inspected = false
    await writeFileAtomic(file, 'hello', 0o640, undefined, {
      inspectTemp: async ({ stagingDir, tempPath }) => {
        inspected = true
        const [staging, temp] = await Promise.all([stat(stagingDir), stat(tempPath)])
        expect(staging.isDirectory()).toBe(true)
        expect(temp.isFile()).toBe(true)
        if (posixModes) {
          expect(staging.mode & 0o777).toBe(0o700)
          expect(temp.mode & 0o777).toBe(0o600)
        }
      },
    })
    expect(inspected).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('hello')
    if (posixModes) expect((await stat(file)).mode & 0o777).toBe(0o640)
    expect((await readdir(dir)).filter(n => n.includes('.tmp'))).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('protects staged content with the existing target DACL and preserves it after replacement', async () => {
    const file = join(dir, 'protected.txt')
    await writeFile(file, 'old')
    await copyFileDaclWin32(file, file)
    const expectedDacl = await readFileDaclWin32(file)

    await writeFileAtomic(file, 'new', (await stat(file)).mode, undefined, {
      inspectTemp: async ({ tempPath }) => {
        expect(await readFileDaclWin32(tempPath)).toEqual(expectedDacl)
      },
    })

    expect(await readFile(file, 'utf8')).toBe('new')
    expect(daclAcePolicy(await readFileDaclWin32(file))).toEqual(daclAcePolicy(expectedDacl))
  })

  it('copies a Windows target DACL before content and publishes through secure replacement', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'old')
    const calls: string[] = []

    await writeFileAtomic(file, 'new', 0o666, undefined, {
      platform: 'win32',
      copyFileDacl: async (source, temp) => {
        calls.push(`copy:${source}`)
        expect(await readFile(temp, 'utf8')).toBe('')
      },
      replaceFile: async (target, temp) => {
        calls.push(`replace:${target}`)
        await rename(temp, target)
      },
    })

    expect(calls).toEqual([`copy:${file}`, `replace:${file}`])
    expect(await readFile(file, 'utf8')).toBe('new')
  })

  it('creates a new Windows file through directory inheritance without replacement calls', async () => {
    const file = join(dir, 'new.txt')
    const unexpected = async (): Promise<void> => { throw new Error('unexpected native replacement call') }

    await writeFileAtomic(file, 'new', undefined, undefined, {
      platform: 'win32',
      copyFileDacl: unexpected,
      replaceFile: unexpected,
    })

    expect(await readFile(file, 'utf8')).toBe('new')
  })

  it('recreates a vanished Windows target with the already-protected temp', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'old')
    const missing = Object.assign(new Error('target vanished'), { code: 'ENOENT' })

    await writeFileAtomic(file, 'new', 0o666, undefined, {
      platform: 'win32',
      copyFileDacl: () => Promise.resolve(),
      replaceFile: async () => { throw missing },
    })

    expect(await readFile(file, 'utf8')).toBe('new')
  })

  it('surfaces a Windows secure-replacement failure and cleans the staging directory', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'old')
    const denied = Object.assign(new Error('replace denied'), { code: 'EACCES' })

    await expect(writeFileAtomic(file, 'new', 0o666, undefined, {
      platform: 'win32',
      copyFileDacl: () => Promise.resolve(),
      replaceFile: async () => { throw denied },
    })).rejects.toBe(denied)
    expect(await readFile(file, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('maps a non-collision guarded-create publication failure and cleans staging', async () => {
    const file = join(dir, 'a.txt')
    const denied = Object.assign(new Error('link denied'), { code: 'EACCES' })

    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      linkFile: async () => { throw denied },
    }, { displayPath: file })).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: denied })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('maps a guarded-create target-inspection failure and cleans staging', async () => {
    const file = join(dir, 'a.txt')
    const linkFailure = Object.assign(new Error('link failed'), { code: 'EIO' })
    const inspectionFailure = Object.assign(new Error('inspection denied'), { code: 'EACCES' })

    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      linkFile: async () => { throw linkFailure },
      inspectPublicationTarget: async () => { throw inspectionFailure },
    }, { displayPath: file })).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: inspectionFailure })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('rejects a guarded-create collision that vanishes before inspection', async () => {
    const file = join(dir, 'a.txt')
    const collision = Object.assign(new Error('target existed'), { code: 'EEXIST' })

    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      linkFile: async () => { throw collision },
    }, { displayPath: file })).rejects.toMatchObject({
      code: 'FS_NOT_OBSERVED',
      message: `cannot overwrite existing "${file}" without reading it first`,
      cause: collision,
    })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('uses the display path and target type when guarded publication finds a competitor', async () => {
    const file = join(dir, 'a.txt')
    const displayPath = join(dir, 'linked-workspace', 'a.txt')

    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      inspectTemp: async () => { await writeFile(file, 'competitor') },
    }, { displayPath })).rejects.toMatchObject({
      code: 'FS_NOT_OBSERVED',
      message: `cannot overwrite existing "${displayPath}" without reading it first`,
    })
    expect(await readFile(file, 'utf8')).toBe('competitor')

    await rm(file)
    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      inspectTemp: async () => { await mkdir(file) },
    }, { displayPath })).rejects.toMatchObject({
      code: 'FS_NOT_REGULAR_FILE',
      message: `cannot write "${displayPath}": not a regular file`,
    })
    expect((await stat(file)).isDirectory()).toBe(true)
  })

  it('does not turn post-commit staging cleanup failure into a failed guarded write', async () => {
    const file = join(dir, 'a.txt')
    const cleanupFailure = new Error('staging cleanup failed')

    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      removeStagingDir: async () => { throw cleanupFailure },
    }, { displayPath: file })).resolves.toBeUndefined()
    expect(await readFile(file, 'utf8')).toBe('ours')
  })

  it.skipIf(!posixModes)('creates new files owner-only by default', async () => {
    const file = join(dir, 'a.txt')
    await writeFileAtomic(file, 'hello', undefined, undefined)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('opens staging paths exclusively — a pre-existing path is never clobbered', async () => {
    const file = join(dir, 'a.txt')
    const tempDirName = '.fixed-temp.tmpdir'
    await mkdir(join(dir, tempDirName))
    await writeFile(join(dir, tempDirName, 'PRECIOUS'), 'keep')
    await expect(
      writeFileAtomic(file, 'hello', undefined, undefined, { tempDirName: () => tempDirName }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(dir, tempDirName, 'PRECIOUS'), 'utf8')).toBe('keep')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates parent directories as needed', async () => {
    const file = join(dir, 'nested', 'deep', 'a.txt')
    await writeFileAtomic(file, 'hi', undefined, undefined)
    expect(await readFile(file, 'utf8')).toBe('hi')
  })

  it('passes a live (non-aborted) signal through the write', async () => {
    const file = join(dir, 'a.txt')
    await writeFileAtomic(file, 'hi', undefined, new AbortController().signal)
    expect(await readFile(file, 'utf8')).toBe('hi')
  })

  it('aborts before writing when the signal is already aborted', async () => {
    const file = join(dir, 'a.txt')
    await expect(writeFileAtomic(file, 'hi', undefined, AbortSignal.abort())).rejects.toMatchObject({ code: 'FS_ABORTED' })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans up the temp file when the final rename fails', async () => {
    const sub = join(dir, 'occupied')
    await mkdir(sub)
    await expect(writeFileAtomic(sub, 'hi', undefined, undefined)).rejects.toBeInstanceOf(Error)
    expect((await readdir(dir)).filter(n => n.includes('.tmp'))).toEqual([])
  })
})

describe('applyLiteralEdit', () => {
  it('replaces a unique match', () => {
    expect(applyLiteralEdit('a b c', 'b', 'X', false, 'f')).toEqual({ content: 'a X c', replacements: 1 })
  })

  it('rejects zero matches', () => {
    expect(() => applyLiteralEdit('a b c', 'z', 'X', false, 'f')).toThrow(expect.objectContaining({ code: 'FS_EDIT_NOT_FOUND' }))
  })

  it('rejects an empty oldString without scanning forever', () => {
    expect(() => applyLiteralEdit('a b c', '', 'X', false, 'f')).toThrow(expect.objectContaining({ code: 'FS_EDIT_NOT_FOUND' }))
  })

  it('rejects multiple matches without replaceAll', () => {
    expect(() => applyLiteralEdit('a a a', 'a', 'X', false, 'f')).toThrow(expect.objectContaining({ code: 'FS_AMBIGUOUS_EDIT' }))
  })

  it('replaces all matches with replaceAll', () => {
    expect(applyLiteralEdit('a a a', 'a', 'X', true, 'f')).toEqual({ content: 'X X X', replacements: 3 })
  })

  it('matches across normalized line endings', () => {
    expect(applyLiteralEdit('one\ntwo', 'one\ntwo', 'x', false, 'f').replacements).toBe(1)
  })
})

describe('readForEdit + restoreLineEndings', () => {
  it('round-trips CRLF: matches on LF, writes back CRLF', async () => {
    const file = join(dir, 'crlf.txt')
    await writeFile(file, 'one\r\ntwo\r\n')
    const original = await readForEdit(file, file)
    expect(original.lineEndings).toBe('CRLF')
    const edited = applyLiteralEdit(original.content, 'two', 'TWO', false, file)
    expect(restoreLineEndings(edited.content, original.lineEndings)).toBe('one\r\nTWO\r\n')
  })

  it('rejects a binary file and invalid UTF-8', async () => {
    await writeFile(join(dir, 'bin'), Buffer.from([0x00, 0x01]))
    await expect(readForEdit(join(dir, 'bin'), join(dir, 'bin'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await writeFile(join(dir, 'bad'), Buffer.from([0x68, 0xff, 0x69]))
    await expect(readForEdit(join(dir, 'bad'), join(dir, 'bad'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('passes a live (non-aborted) signal through the read', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const original = await readForEdit(file, file, new AbortController().signal)
    expect(original.content).toBe('one\ntwo')
  })

  it('translates a mid-read AbortError into FS_ABORTED', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'one\ntwo')
    const ac = new AbortController()
    // Abort after the synchronous entry check, while readFile is pending.
    const pending = readForEdit(file, file, ac.signal)
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })
})
