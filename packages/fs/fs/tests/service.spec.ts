/**
 * Tests for the filesystem Service Definition: registration, duplicate-service
 * behavior, disposal, and the branded id factories. The provider primitives and
 * policy live in `dsh-fs-local` and `dsh-fs-observation-policy`; this seam owns only the
 * abstract service contract, so a minimal fake backend exercises it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

/** A minimal in-memory fake implementing the provider primitives. */
class FakeFileSystem extends FileSystem {
  files = new Map<string, string>()

  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }
  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string { return `file:///${encodeURIComponent(String(target.targetKey))}` }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.targetKey === parent.targetKey || String(child.targetKey).startsWith(`${parent.targetKey}/`)
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(target.targetKey)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    const content = this.files.get(path)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(target.targetKey)
    if (content === undefined) throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    return content
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = await this.readText(target)
    return (async function* () { yield content })()
  }
  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(await this.readText(target))
    if (bytes.length > maxBytes) {
      throw new FsError(`too large: ${target.displayPath}`, 'FS_TOO_LARGE')
    }
    return bytes
  }
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(target)).subarray(range.offset, range.offset + range.length)
  }
  override async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    if (target.targetKey !== 'skills') throw new FsError(`not a directory: ${target.displayPath}`, 'FS_NOT_DIRECTORY')
    return [
      {
        name: 'alpha.md',
        type: 'file',
        target: { targetKey: FsTargetKey('skills/alpha.md'), displayPath: 'skills/alpha.md' },
        size: 2,
        version: FsVersion('v1'),
      },
    ]
  }
  override async writeText(target: FsTarget, content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const before = this.files.get(target.targetKey) ?? null
    this.files.set(target.targetKey, content)
    return { operation: before !== null ? 'update' : 'create', version: FsVersion('v2'), before, after: content }
  }
  override async editText(target: FsTarget, edit: FsEditRequest): Promise<FsEditOutcome> {
    const content = this.files.get(target.targetKey) ?? ''
    const after = content.split(edit.oldString).join(edit.newString)
    this.files.set(target.targetKey, after)
    return { version: FsVersion('v3'), before: content, after }
  }
}

describe('FileSystem provider seam', () => {
  it('registers as ctx.fs and serves the primitives', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    const fs = ctx.fs as FakeFileSystem
    expect(fs.sandboxMode).toBeUndefined()
    expect(fs.processPathFromHostPath('/host/file')).toBeUndefined()
    fs.files.set('a.txt', 'hi')
    const target = await fs.resolve('a.txt')
    expect((await fs.stat(target))?.type).toBe('file')
    expect(await fs.readText(target)).toBe('hi')
  })

  it('throws when a second implementation is loaded (duplicate service)', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    await expect(ctx.plugin(FakeFileSystem)).rejects.toThrow()
  })

  it('removes the service when the providing fiber is disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FakeFileSystem)
    expect(ctx.fs).toBeDefined()
    await fiber.dispose()
    expect(ctx.fs).toBeUndefined()
  })

  it('streamText yields the same text readText returns', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    const fs = ctx.fs as FakeFileSystem
    fs.files.set('a.txt', 'one\ntwo')
    const target = await fs.resolve('a.txt')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe(await fs.readText(target))
  })

  it('readByteRange returns the window, shorter at the end and empty past it', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    const fs = ctx.fs as FakeFileSystem
    fs.files.set('a.bin', 'hello')
    const target = await fs.resolve('a.bin')
    expect(await fs.readByteRange(target, { offset: 1, length: 3 })).toEqual(new TextEncoder().encode('ell'))
    expect(await fs.readByteRange(target, { offset: 3, length: 10 })).toEqual(new TextEncoder().encode('lo'))
    expect(await fs.readByteRange(target, { offset: 9, length: 2 })).toHaveLength(0)
  })

  it('readBytes returns raw content and enforces the byte cap with FS_TOO_LARGE', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    const fs = ctx.fs as FakeFileSystem
    fs.files.set('a.bin', 'hi')
    const target = await fs.resolve('a.bin')
    expect(await fs.readBytes(target, undefined, 2)).toEqual(new TextEncoder().encode('hi'))
    await expect(fs.readBytes(target, undefined, 1)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('listDir returns child entry targets without reading file content', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    const fs = ctx.fs as FakeFileSystem
    const entries = await fs.listDir(await fs.resolve('skills'))
    expect(entries).toEqual([{
      name: 'alpha.md',
      type: 'file',
      target: { targetKey: 'skills/alpha.md', displayPath: 'skills/alpha.md' },
      size: 2,
      version: 'v1',
    }])
  })

  it('stat returns undefined for an absent target', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    const fs = ctx.fs as FakeFileSystem
    expect(await fs.stat(await fs.resolve('missing.txt'))).toBeUndefined()
  })

  it('lstat returns path metadata before resolving a target', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeFileSystem)
    const fs = ctx.fs as FakeFileSystem
    fs.files.set('a.txt', 'hi')
    expect(await fs.lstat('a.txt')).toEqual({ version: 'v1', type: 'file', size: 2 })
    expect(await fs.lstat('missing.txt')).toBeUndefined()
  })
})

describe('branded id factories', () => {
  it('FsTargetKey and FsVersion brand a string at compile time (identity at runtime)', () => {
    expect(FsTargetKey('k')).toBe('k')
    expect(FsVersion('v')).toBe('v')
  })
})

describe('FsError', () => {
  it('carries a stable code and HarnessError name', () => {
    const error = new FsError('nope', 'FS_NOT_FOUND')
    expect(error.code).toBe('FS_NOT_FOUND')
    expect(error.name).toBe('FsError')
    expect(error).toBeInstanceOf(Error)
  })

  it('chains an underlying cause through ErrorOptions', () => {
    const root = new Error('EACCES')
    const error = new FsError('cannot read', 'FS_ABORTED', { cause: root })
    expect(error.cause).toBe(root)
    expect(error.code).toBe('FS_ABORTED')
  })
})
