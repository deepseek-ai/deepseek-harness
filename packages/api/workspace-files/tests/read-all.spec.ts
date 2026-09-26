/** Full-file reads retain the ordinary file gates and never return a silently truncated result. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => { harness = await openWorkspace('dsh-workspace-files-read-all-') })
afterEach(async () => { await harness.dispose() })

describe('workspaceFiles.readBytes — complete files', () => {
  it('reads the complete bytes independently of the window cap', async () => {
    const bytes = Buffer.from([0, 255, 1, 2])
    await writeFile(join(harness.workspace, 'file.bin'), bytes)
    const result = await harness.endpoint({ maxBytes: 1, maxFileBytes: 4 }).readBytes(harness.scope, 'file.bin', {}, signal())
    expect(Buffer.from(result.data)).toEqual(bytes)
    expect(result).toMatchObject({ offset: 0, eof: true, bytes: 4 })
  })

  it('returns an empty complete file', async () => {
    await writeFile(join(harness.workspace, 'empty'), '')
    const result = await harness.endpoint().readBytes(harness.scope, 'empty', {}, signal())
    expect(result.data.byteLength).toBe(0)
    expect(result).toMatchObject({ offset: 0, eof: true, bytes: 0 })
  })

  it.each(['workspace', 'outside'] as const)('maps the filesystem size refusal for a %s file', async (location) => {
    const path = join(harness[location], 'large')
    await writeFile(path, 'abcde')
    expect(await failureOf(harness.endpoint({ maxFileBytes: 4 }).readBytes(harness.scope, path, {}, signal())))
      .toEqual({ code: 'workspace-file/too-large', details: { path, limit: 4 } })
  })

  it.each([undefined, 1])('checks the actual bytes when stat reports %s', async (size) => {
    await writeFile(join(harness.workspace, 'growing'), 'abcde')
    vi.spyOn(harness.ctx.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('v'), ...size === undefined ? {} : { size } })
    expect((await failureOf(harness.endpoint({ maxFileBytes: 4 }).readBytes(harness.scope, 'growing', {}, signal()))).code)
      .toBe('workspace-file/too-large')
  })

  it('reads outside files while retaining missing-file and kind failures', async () => {
    await mkdir(join(harness.workspace, 'directory'))
    await writeFile(join(harness.outside, 'outside'), 'outside')
    const files = harness.endpoint()
    expect((await failureOf(files.readBytes(harness.scope, 'missing', {}, signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(files.readBytes(harness.scope, 'directory', {}, signal()))).code).toBe('workspace-file/not-regular-file')
    const outside = await files.readBytes(harness.scope, join(harness.outside, 'outside'), {}, signal())
    expect(Buffer.from(outside.data).toString()).toBe('outside')
  })

  it.each([new Error('Read denied'), new DOMException('Cancelled', 'AbortError'), null, 'backend failure', { code: 'FS_NOT_FOUND' }])(
    'preserves non-size filesystem failures: %s', async (failure) => {
      await writeFile(join(harness.workspace, 'file'), '1234')
      vi.spyOn(harness.ctx.fs, 'readBytes').mockRejectedValueOnce(failure)
      await expect(harness.endpoint().readBytes(harness.scope, 'file', {}, signal())).rejects.toBe(failure)
    },
  )

  it('maps a size refusal by code without requiring a shared error class', async () => {
    await writeFile(join(harness.workspace, 'file'), '1234')
    const failure = { code: 'FS_TOO_LARGE' }
    vi.spyOn(harness.ctx.fs, 'readBytes').mockRejectedValueOnce(failure)
    await expect(harness.endpoint({ maxFileBytes: 4 }).readBytes(harness.scope, 'file', {}, signal()))
      .rejects.toMatchObject({ code: 'workspace-file/too-large', details: { path: 'file', limit: 4 }, cause: failure })
  })
})

describe('workspaceFiles.readBytes — base file', () => {
  it('resolves relative paths from the base file directory on the Host', async () => {
    await mkdir(join(harness.workspace, 'nested'))
    await writeFile(join(harness.workspace, 'nested/base.txt'), 'base')
    await writeFile(join(harness.workspace, 'nested/near.txt'), 'near')
    await writeFile(join(harness.workspace, 'root.txt'), 'root')
    const files = harness.endpoint()
    const near = await files.readBytes(harness.scope, './near.txt', { baseFile: 'nested/base.txt' }, signal())
    const root = await files.readBytes(harness.scope, '../root.txt', { baseFile: 'nested/base.txt' }, signal())
    expect(Buffer.from(near.data).toString()).toBe('near')
    expect(Buffer.from(root.data).toString()).toBe('root')
    const fromRoot = await files.readBytes(harness.scope, 'nested\\near.txt', { baseFile: 'root.txt' }, signal())
    expect(Buffer.from(fromRoot.data).toString()).toBe('near')
  })

  it.each(['', '/outside', 'C:\\outside', '\\\\host\\share', 'https://example.test/a.js', 'bad\0path'])('rejects non-relative path %j', async (path) => {
    expect((await failureOf(harness.endpoint().readBytes(harness.scope, path, { baseFile: 'base' }, signal()))).code).toBe('gateway/bad-request')
  })

  it('resolves related files on either side of the workspace root', async () => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    await writeFile(join(harness.outside, 'outside'), 'outside')
    const files = harness.endpoint()
    expect((await failureOf(files.readBytes(harness.scope, 'file', { baseFile: 'missing' }, signal()))).code).toBe('workspace-file/not-found')
    const fromOutside = await files.readBytes(harness.scope, '../workspace/base', { baseFile: join(harness.outside, 'outside') }, signal())
    const toOutside = await files.readBytes(harness.scope, '../outside/outside', { baseFile: 'base' }, signal())
    expect(Buffer.from(fromOutside.data).toString()).toBe('base')
    expect(Buffer.from(toOutside.data).toString()).toBe('outside')
  })

  it('reads sibling assets beside an outside HTML file with escaped path characters', async () => {
    await mkdir(join(harness.outside, 'space # assets'))
    const base = join(harness.outside, 'space # assets', 'page.html')
    await writeFile(base, '<script src="./app.js"></script>')
    await writeFile(join(harness.outside, 'space # assets', 'app.js'), 'EXTERNAL_ASSET')
    const result = await harness.endpoint().readBytes(harness.scope, './app.js', { baseFile: base }, signal())
    expect(Buffer.from(result.data).toString()).toBe('EXTERNAL_ASSET')
  })

  it.each([
    ['C:\\external\\page.html', 'C:\\external\\app.js'],
    ['\\\\server\\share\\page.html', '\\\\server\\share\\app.js'],
    ['/external/back\\slash.html', '/external/app.js'],
  ])('uses the backend process-path syntax for related reads from %s', async (base, expected) => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    const files = harness.endpoint()
    vi.spyOn(harness.ctx.fs, 'processPath').mockReturnValue(base)
    const lstat = harness.ctx.fs.lstat.bind(harness.ctx.fs)
    const inspect = vi.spyOn(harness.ctx.fs, 'lstat').mockImplementation((path, options, abort) =>
      path === 'base' ? lstat(path, options, abort) : Promise.resolve(undefined))
    const caller = signal()
    await expect(files.readBytes(harness.scope, './app.js', { baseFile: 'base' }, caller)).rejects.toMatchObject({ code: 'workspace-file/not-found' })
    expect(inspect).toHaveBeenLastCalledWith(expected, { cwd: harness.workspace }, caller)
  })

  it('combines a base file with a bounded range without applying the complete-file cap', async () => {
    await mkdir(join(harness.workspace, 'nested'))
    await writeFile(join(harness.workspace, 'nested/base.html'), 'base')
    await writeFile(join(harness.workspace, 'nested/asset.bin'), new Uint8Array([0, 255, 128, 4, 5, 6]))
    const completeRead = vi.spyOn(harness.ctx.fs, 'readBytes')
    const rangeRead = vi.spyOn(harness.ctx.fs, 'readByteRange')
    const caller = signal()
    const result = await harness.endpoint({ maxBytes: 2, maxFileBytes: 1 }).readBytes(
      harness.scope, './asset.bin', { baseFile: 'nested/base.html', range: { offset: 1, length: 2 } }, caller,
    )
    expect([...result.data]).toEqual([255, 128])
    expect(result).toMatchObject({ absolutePath: await realpath(join(harness.workspace, 'nested/asset.bin')), offset: 1, eof: false, bytes: 6 })
    expect(rangeRead).toHaveBeenCalledExactlyOnceWith(expect.anything(), { offset: 1, length: 2 }, caller)
    expect(completeRead).not.toHaveBeenCalled()
  })

  it('checks the base file kind before reading the target', async () => {
    await mkdir(join(harness.workspace, 'directory'))
    await writeFile(join(harness.workspace, 'target'), 'target')
    expect((await failureOf(harness.endpoint().readBytes(harness.scope, 'target', { baseFile: 'directory' }, signal()))).code)
      .toBe('workspace-file/not-regular-file')
  })

  it('rejects a related symlink rather than following it', async () => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    await writeFile(join(harness.workspace, 'target'), 'target')
    await symlink('target', join(harness.workspace, 'link'))
    expect((await failureOf(harness.endpoint().readBytes(harness.scope, 'link', { baseFile: 'base' }, signal()))).code).toBe('workspace-file/not-regular-file')
  })
})
