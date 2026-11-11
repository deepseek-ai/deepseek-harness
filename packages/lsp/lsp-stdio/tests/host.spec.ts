import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { canonicalizeWorkspace, readHostSource } from '../src/host.ts'

const execFileAsync = promisify(execFile)

let root: string
let ws: string
let ctx: Context
let fs: LocalFileSystem

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-host-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  fs = ctx.fs as LocalFileSystem
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

const BIG = 1_000_000

async function workspace() {
  return await canonicalizeWorkspace(fs, ws)
}

async function readSource(filePath: string, maxBytes = BIG, signal?: AbortSignal) {
  return await readHostSource(fs, filePath, await workspace(), maxBytes, signal)
}

describe('canonicalizeWorkspace', () => {
  it('returns the realpath of a directory', async () => {
    expect((await workspace()).canonicalPath).toBe(ws)
  })

  it('resolves a symlinked workspace to its target so aliases share identity', async () => {
    const link = join(root, 'ws-link')
    await symlink(ws, link)
    expect((await canonicalizeWorkspace(fs, link)).canonicalPath).toBe(ws)
  })

  it('rejects a missing workspace', async () => {
    const missing = join(root, 'nope')
    await expect(canonicalizeWorkspace(fs, missing)).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_NOT_FOUND',
      message: `workspace root "${missing}" does not exist`,
    })
  })

  it('adds the workspace operand to a filesystem failure while keeping its code', async () => {
    const providerFailure = new FsError('permission denied', 'FS_PERMISSION_DENIED')
    fs.resolve = async () => { throw providerFailure }
    await expect(canonicalizeWorkspace(fs, ws)).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_PERMISSION_DENIED',
      message: `workspace root "${ws}" cannot be resolved: permission denied`,
      cause: providerFailure,
    })
  })

  it('propagates a non-filesystem resolve failure unchanged', async () => {
    fs.resolve = async () => { throw 'raw workspace resolve failure' }
    await expect(canonicalizeWorkspace(fs, ws)).rejects.toBe('raw workspace resolve failure')
  })

  it('rejects a non-directory workspace', async () => {
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    await expect(canonicalizeWorkspace(fs, file)).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_NOT_DIRECTORY',
      message: `workspace root "${file}" is not a directory`,
    })
  })

  it('normalizes workspace metadata cancellation and preserves other provider failures', async () => {
    const providerFailure = new Error('workspace metadata failed')
    fs.stat = async () => { throw providerFailure }
    await expect(canonicalizeWorkspace(fs, ws)).rejects.toBe(providerFailure)

    const controller = new AbortController()
    fs.stat = async () => {
      controller.abort(new Error('workspace metadata cancelled'))
      throw providerFailure
    }
    await expect(canonicalizeWorkspace(fs, ws, controller.signal))
      .rejects.toThrow('workspace metadata cancelled')
  })
})

describe('readHostSource', () => {
  it('reads a relative path against the workspace', async () => {
    await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
    const source = await readSource('a.ts')
    expect(source.fileUrl).toBe(pathToFileURL(join(ws, 'a.ts')).href)
    expect(source.text).toBe('const x = 1\n')
  })

  it('reads an absolute path inside the workspace', async () => {
    const abs = join(ws, 'b.ts')
    await writeFile(abs, 'b')
    const source = await readSource(abs)
    expect(source.fileUrl).toBe(pathToFileURL(abs).href)
  })

  it('accepts a source reached through a symlink that stays inside the workspace', async () => {
    await mkdir(join(ws, 'real'))
    await writeFile(join(ws, 'real', 'c.ts'), 'c')
    await symlink(join(ws, 'real'), join(ws, 'linked'))
    const source = await readSource('linked/c.ts')
    expect(source.fileUrl).toBe(pathToFileURL(join(ws, 'real', 'c.ts')).href)
  })

  it('rejects a source whose canonical path escapes the workspace via symlink', async () => {
    const outside = join(root, 'outside.ts')
    await writeFile(outside, 'secret')
    await symlink(outside, join(ws, 'escape.ts'))
    await expect(readSource('escape.ts')).rejects.toMatchObject({
      name: 'LspError',
      code: 'LSP_FILE_OUTSIDE_WORKSPACE',
      message: 'source "escape.ts" resolves outside the workspace',
    })
  })

  it('rejects an absolute source outside the workspace', async () => {
    const outside = join(root, 'out.ts')
    await writeFile(outside, 'x')
    await expect(readSource(outside)).rejects.toMatchObject({ name: 'LspError', code: 'LSP_FILE_OUTSIDE_WORKSPACE' })
  })

  it('rejects a missing source', async () => {
    await expect(readSource('nope.ts')).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_NOT_FOUND',
      message: expect.stringMatching(/^source "nope\.ts" could not be read: .*not found/) as string,
    })
  })

  it('adds the source operand to a resolve failure while keeping its code', async () => {
    const canonical = await workspace()
    const providerFailure = new FsError('a parent path segment is not a directory', 'FS_NOT_FOUND')
    fs.resolve = async () => { throw providerFailure }
    await expect(readHostSource(fs, 'broken.ts', canonical, BIG)).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_NOT_FOUND',
      message: 'source "broken.ts" cannot be resolved: a parent path segment is not a directory',
      cause: providerFailure,
    })
    fs.resolve = async () => { throw 'raw resolve failure' }
    await expect(readHostSource(fs, 'broken.ts', canonical, BIG)).rejects.toBe('raw resolve failure')
  })

  it('propagates a non-filesystem read failure unchanged', async () => {
    await writeFile(join(ws, 'a.ts'), 'x')
    const canonical = await workspace()
    const providerFailure = new Error('stream defect')
    fs.streamText = async () => { throw providerFailure }
    await expect(readHostSource(fs, 'a.ts', canonical, BIG)).rejects.toBe(providerFailure)
  })

  it('rejects a non-regular source (directory)', async () => {
    await mkdir(join(ws, 'dir'))
    await expect(readSource('dir')).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_NOT_REGULAR_FILE',
      message: expect.stringMatching(/^source "dir" could not be read: .*not a regular file/) as string,
    })
  })

  // Windows has no filesystem FIFO; the directory case above pins non-regular rejection there.
  it.skipIf(process.platform === 'win32')('rejects a FIFO with no writer without blocking in open', async () => {
    const fifo = join(ws, 'pipe.ts')
    await execFileAsync('mkfifo', [fifo])
    using d = deadline(undefined, 1000, 'FIFO_READ_TIMEOUT')
    await expect(readSource('pipe.ts', BIG, d.signal)).rejects.toThrow(/not a regular file/)
  })

  it('honors a pre-aborted source read before filesystem work', async () => {
    const controller = new AbortController()
    controller.abort(new Error('source read cancelled'))
    await expect(readSource('missing.ts', BIG, controller.signal)).rejects.toThrow(/source read cancelled/)
  })

  it('treats the workspace root itself as inside, then rejects it as non-regular', async () => {
    // The filesystem containment primitive accepts the workspace itself; the
    // bounded read then rejects the directory as non-regular.
    await expect(readSource('.')).rejects.toThrow(/not a regular file/)
  })

  it('rejects an oversized source and reports the observed lower bound', async () => {
    await writeFile(join(ws, 'big.ts'), 'x'.repeat(100))
    await expect(readSource('big.ts', 10)).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_TOO_LARGE',
      message: 'source "big.ts" exceeds the 10-byte limit; reading stopped after 100 bytes',
    })
  })

  it('counts the complete UTF-8 byte length at the configured boundary', async () => {
    await writeFile(join(ws, 'multibyte.ts'), '€abc')
    await expect(readSource('multibyte.ts', 6)).resolves.toMatchObject({ text: '€abc' })
    await expect(readSource('multibyte.ts', 5)).rejects.toThrow(/5-byte limit/)
  })

  it('rejects a non-UTF-8 source', async () => {
    await writeFile(join(ws, 'bin.ts'), Buffer.from([0xff, 0xfe, 0x00]))
    await expect(readSource('bin.ts')).rejects.toMatchObject({
      name: 'FsError',
      code: 'FS_NOT_TEXT',
      message: expect.stringMatching(/invalid UTF-8|binary file/) as string,
    })
  })

  it('keeps a valid U+FFFD replacement character in otherwise-valid UTF-8', async () => {
    // The literal replacement char is valid UTF-8; a fatal decoder must accept it (only malformed
    // byte sequences are rejected).
    await writeFile(join(ws, 'repl.ts'), 'const s = "�"\n')
    const source = await readSource('repl.ts')
    expect(source.text).toBe('const s = "�"\n')
  })
})
