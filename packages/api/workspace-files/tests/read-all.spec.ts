/** Full-file reads retain the ordinary file gates and never return a silently truncated result. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => { harness = await openWorkspace('dsh-workspace-files-read-all-') })
afterEach(async () => { await harness.dispose() })

describe('workspaceFiles.readAll', () => {
  it('reads the complete bytes independently of the window cap', async () => {
    const bytes = Buffer.from([0, 255, 1, 2])
    await writeFile(join(harness.workspace, 'file.bin'), bytes)
    const result = await harness.endpoint({ maxBytes: 1, maxFileBytes: 4 }).readAll(harness.scope, 'file.bin', signal())
    expect(Buffer.from(result.data, 'base64')).toEqual(bytes)
    expect(result).toMatchObject({ offset: 0, eof: true, bytes: 4 })
  })

  it('returns an empty complete file', async () => {
    await writeFile(join(harness.workspace, 'empty'), '')
    expect(await harness.endpoint().readAll(harness.scope, 'empty', signal())).toMatchObject({ data: '', offset: 0, eof: true, bytes: 0 })
  })

  it.each(['workspace', 'outside'] as const)('rejects a known oversized %s file before reading bytes', async (location) => {
    const path = join(harness[location], 'large')
    await writeFile(path, 'abcde')
    const read = vi.spyOn(harness.ctx.fs, 'readByteRange')
    expect(await failureOf(harness.endpoint({ maxFileBytes: 4 }).readAll(harness.scope, path, signal())))
      .toEqual({ code: 'workspace-file/too-large', details: { path, limit: 4 } })
    expect(read).not.toHaveBeenCalled()
  })

  it.each([undefined, 1])('checks the actual bytes when stat reports %s', async (size) => {
    await writeFile(join(harness.workspace, 'growing'), 'abcde')
    vi.spyOn(harness.ctx.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('v'), ...size === undefined ? {} : { size } })
    expect((await failureOf(harness.endpoint({ maxFileBytes: 4 }).readAll(harness.scope, 'growing', signal()))).code)
      .toBe('workspace-file/too-large')
  })

  it('reads outside files while retaining missing-file and kind failures', async () => {
    await mkdir(join(harness.workspace, 'directory'))
    await writeFile(join(harness.outside, 'outside'), 'outside')
    const files = harness.endpoint()
    expect((await failureOf(files.readAll(harness.scope, 'missing', signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(files.readAll(harness.scope, 'directory', signal()))).code).toBe('workspace-file/not-regular-file')
    const outside = await files.readAll(harness.scope, join(harness.outside, 'outside'), signal())
    expect(Buffer.from(outside.data, 'base64').toString()).toBe('outside')
  })
})

describe('workspaceFiles.readRelated', () => {
  it('resolves relative paths from the base file directory on the Host', async () => {
    await mkdir(join(harness.workspace, 'nested'))
    await writeFile(join(harness.workspace, 'nested/base.txt'), 'base')
    await writeFile(join(harness.workspace, 'nested/near.txt'), 'near')
    await writeFile(join(harness.workspace, 'root.txt'), 'root')
    const files = harness.endpoint()
    const near = await files.readRelated(harness.scope, 'nested/base.txt', './near.txt', signal())
    const root = await files.readRelated(harness.scope, 'nested/base.txt', '../root.txt', signal())
    expect(Buffer.from(near.data, 'base64').toString()).toBe('near')
    expect(Buffer.from(root.data, 'base64').toString()).toBe('root')
    const fromRoot = await files.readRelated(harness.scope, 'root.txt', 'nested\\near.txt', signal())
    expect(Buffer.from(fromRoot.data, 'base64').toString()).toBe('near')
  })

  it.each(['', '/outside', 'C:\\outside', '\\\\host\\share', 'https://example.test/a.js', 'bad\0path'])('rejects non-relative path %j', async (path) => {
    expect((await failureOf(harness.endpoint().readRelated(harness.scope, 'base', path, signal()))).code).toBe('gateway/bad-request')
  })

  it('resolves related files on either side of the workspace root', async () => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    await writeFile(join(harness.outside, 'outside'), 'outside')
    const files = harness.endpoint()
    expect((await failureOf(files.readRelated(harness.scope, 'missing', 'file', signal()))).code).toBe('workspace-file/not-found')
    const fromOutside = await files.readRelated(harness.scope, join(harness.outside, 'outside'), '../workspace/base', signal())
    const toOutside = await files.readRelated(harness.scope, 'base', '../outside/outside', signal())
    expect(Buffer.from(fromOutside.data, 'base64').toString()).toBe('base')
    expect(Buffer.from(toOutside.data, 'base64').toString()).toBe('outside')
  })

  it('reads sibling assets beside an outside HTML file with escaped path characters', async () => {
    await mkdir(join(harness.outside, 'space # assets'))
    const base = join(harness.outside, 'space # assets', 'page.html')
    await writeFile(base, '<script src="./app.js"></script>')
    await writeFile(join(harness.outside, 'space # assets', 'app.js'), 'EXTERNAL_ASSET')
    const result = await harness.endpoint().readRelated(harness.scope, base, './app.js', signal())
    expect(Buffer.from(result.data, 'base64').toString()).toBe('EXTERNAL_ASSET')
  })

  it.each([
    ['C:\\external\\page.html', 'C:\\external\\app.js'],
    ['\\\\server\\share\\page.html', '\\\\server\\share\\app.js'],
    ['/external/back\\slash.html', '/external/app.js'],
  ])('uses the backend process-path syntax for related reads from %s', async (base, expected) => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    const files = harness.endpoint()
    vi.spyOn(harness.ctx.fs, 'processPath').mockReturnValue(base)
    const read = vi.spyOn(files, 'readAll').mockResolvedValue({ absolutePath: expected, version: 'v', offset: 0, data: '', eof: true })
    const caller = signal()
    await files.readRelated(harness.scope, 'base', './app.js', caller)
    expect(read).toHaveBeenCalledWith(harness.scope, expected, caller)
  })

  it('rejects a related symlink rather than following it', async () => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    await writeFile(join(harness.workspace, 'target'), 'target')
    await symlink('target', join(harness.workspace, 'link'))
    expect((await failureOf(harness.endpoint().readRelated(harness.scope, 'base', 'link', signal()))).code).toBe('workspace-file/not-regular-file')
  })
})
