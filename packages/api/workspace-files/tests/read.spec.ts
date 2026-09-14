/** The `read` endpoint: its four gates and the line window it cuts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-read-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (caps?: { maxBytes?: number; maxLines?: number }): ReturnType<Harness['endpoint']> =>
  harness.endpoint(caps)

/** Twenty lines, `line 1` through `line 20`, terminated by a final newline. */
async function twentyLines(): Promise<void> {
  await writeFile(join(workspace, 'long.txt'), `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')}\n`, 'utf8')
}

/** A file whose second line carries a NUL byte past the backend's 8 KiB binary sample. */
async function lateNul(): Promise<void> {
  await writeFile(join(workspace, 'late-nul.txt'), Buffer.concat([
    Buffer.from(`${'a'.repeat(9000)}\nb`, 'utf8'),
    Buffer.from([0]),
    Buffer.from('c\n', 'utf8'),
  ]))
}

describe('workspaceFiles.read — the happy path', () => {
  it('returns the whole file as one page with its absolute path, version, and byte size', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'hello\nworld\n', 'utf8')
    const result = await endpoint().read(harness.scope, 'notes.txt', {}, signal())
    expect(result.text).toBe('hello\nworld')
    expect(result.offset).toBe(1)
    expect(result.lines).toBe(2)
    expect(result.eof).toBe(true)
    expect(result.bytes).toBe(12)
    expect(result.version.length).toBeGreaterThan(0)
    expect(result.absolutePath.endsWith('notes.txt')).toBe(true)
  })

  it('reads a nested path relative to the workspace root, not to any backend cwd', async () => {
    await mkdir(join(workspace, 'src', 'deep'), { recursive: true })
    await writeFile(join(workspace, 'src', 'deep', 'a.ts'), 'export {}\n', 'utf8')
    const result = await endpoint().read(harness.scope, 'src/deep/a.ts', {}, signal())
    expect(result.text).toBe('export {}')
  })

  it('returns an empty page for an empty file', async () => {
    await writeFile(join(workspace, 'empty.txt'), '', 'utf8')
    const result = await endpoint().read(harness.scope, 'empty.txt', {}, signal())
    expect(result).toMatchObject({ text: '', lines: 0, eof: true, bytes: 0 })
  })

  it('accepts multi-byte UTF-8 and counts the file bytes, not its characters', async () => {
    await writeFile(join(workspace, 'zh.txt'), '侧栏', 'utf8')
    const result = await endpoint().read(harness.scope, 'zh.txt', {}, signal())
    expect(result.text).toBe('侧栏')
    expect(result.bytes).toBe(6)
  })
})

describe('workspaceFiles.read — the line window', () => {
  it('cuts the requested lines and reports that more follow', async () => {
    await twentyLines()
    const result = await endpoint().read(harness.scope, 'long.txt', { offset: 6, limit: 3 }, signal())
    expect(result).toMatchObject({ offset: 6, text: 'line 6\nline 7\nline 8', lines: 3, eof: false })
  })

  it('reports eof on the page that holds the last line, whether or not the limit is reached', async () => {
    await twentyLines()
    const service = endpoint()
    const exact = await service.read(harness.scope, 'long.txt', { offset: 16, limit: 5 }, signal())
    expect(exact).toMatchObject({ text: 'line 16\nline 17\nline 18\nline 19\nline 20', lines: 5, eof: true })
    const beyond = await service.read(harness.scope, 'long.txt', { offset: 19, limit: 10 }, signal())
    expect(beyond).toMatchObject({ text: 'line 19\nline 20', lines: 2, eof: true })
  })

  it('treats a final newline as the last line terminator, not as an empty line after it', async () => {
    await writeFile(join(workspace, 'two.txt'), 'a\nb\n', 'utf8')
    await writeFile(join(workspace, 'three.txt'), 'a\nb\n\n', 'utf8')
    const service = endpoint()
    expect(await service.read(harness.scope, 'two.txt', { limit: 2 }, signal())).toMatchObject({ text: 'a\nb', lines: 2, eof: true })
    expect(await service.read(harness.scope, 'three.txt', { limit: 2 }, signal())).toMatchObject({ text: 'a\nb', lines: 2, eof: false })
    // The third line is empty, not absent: `lines` tells it from a page past the end.
    expect(await service.read(harness.scope, 'three.txt', { offset: 3 }, signal())).toMatchObject({ text: '', lines: 1, eof: true })
  })

  it('returns an empty eof page for an offset past the last line', async () => {
    await twentyLines()
    const result = await endpoint().read(harness.scope, 'long.txt', { offset: 21 }, signal())
    expect(result).toMatchObject({ offset: 21, text: '', lines: 0, eof: true })
  })

  it('defaults the limit to the configured page size', async () => {
    await twentyLines()
    const result = await endpoint({ maxLines: 5 }).read(harness.scope, 'long.txt', {}, signal())
    expect(result.text.split('\n')).toHaveLength(5)
    expect(result.eof).toBe(false)
  })

  it('refuses a limit above the configured page size and a non-positive-integer window', async () => {
    await twentyLines()
    const service = endpoint({ maxLines: 5 })
    for (const range of [{ limit: 6 }, { offset: 0 }, { limit: 1.5 }, { offset: -3 }]) {
      const failure = await failureOf(service.read(harness.scope, 'long.txt', range, signal()))
      expect(failure.code).toBe('gateway/bad-request')
    }
  })

  it('keeps carriage returns: the page is the file text, not a rendering of it', async () => {
    await writeFile(join(workspace, 'crlf.txt'), 'a\r\nb\r\n', 'utf8')
    const result = await endpoint().read(harness.scope, 'crlf.txt', {}, signal())
    expect(result.text).toBe('a\r\nb\r')
  })
})

describe('workspaceFiles.read — read access and file kinds', () => {
  it('reads an absolute path outside the workspace without mutating it', async () => {
    await writeFile(join(outside, 'notes.txt'), 'outside\nread only\n', 'utf8')
    const write = vi.spyOn(harness.ctx.fs, 'writeText')
    const edit = vi.spyOn(harness.ctx.fs, 'editText')
    const result = await endpoint().read(harness.scope, join(outside, 'notes.txt'), {}, signal())
    expect(result).toMatchObject({ text: 'outside\nread only', lines: 2, eof: true })
    expect(write).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
  })

  it('resolves a relative file outside the workspace on the Host', async () => {
    await writeFile(join(outside, 'notes.txt'), 'outside', 'utf8')
    expect(await endpoint().read(harness.scope, '../outside/notes.txt', {}, signal())).toMatchObject({ text: 'outside', eof: true })
  })

  it('preserves a filesystem provider refusal for an outside file', async () => {
    await writeFile(join(outside, 'notes.txt'), 'outside', 'utf8')
    const refusal = new FsError('backend denied read', 'FS_SANDBOX_DENIED')
    vi.spyOn(harness.ctx.fs, 'streamText').mockRejectedValue(refusal)
    await expect(endpoint().read(harness.scope, join(outside, 'notes.txt'), {}, signal())).rejects.toBe(refusal)
  })

  it('rejects a symlink that points out of the workspace — the case a prefix test cannot see', async () => {
    await writeFile(join(outside, 'secret.txt'), 'no', 'utf8')
    // The path itself is inside the workspace and would pass any string
    // comparison; only lstat (before the follow) or realpath containment catches it.
    await symlink(join(outside, 'secret.txt'), join(workspace, 'link.txt'))
    const failure = await failureOf(endpoint().read(harness.scope, 'link.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-regular-file')
    expect(failure.details).toMatchObject({ kind: 'symlink' })
  })

  it('rejects a symlink even when it points back inside the workspace', async () => {
    await writeFile(join(workspace, 'real.txt'), 'fine', 'utf8')
    await symlink(join(workspace, 'real.txt'), join(workspace, 'alias.txt'))
    const failure = await failureOf(endpoint().read(harness.scope, 'alias.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-regular-file')
  })

  it('rejects a directory, which has no text to return', async () => {
    await mkdir(join(workspace, 'src'), { recursive: true })
    const failure = await failureOf(endpoint().read(harness.scope, 'src', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-regular-file')
    expect(failure.details).toMatchObject({ kind: 'directory' })
  })

  it('reports a missing path as not found', async () => {
    const failure = await failureOf(endpoint().read(harness.scope, 'nope.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })

  it('refuses an empty path as a bad request', async () => {
    const failure = await failureOf(endpoint().read(harness.scope, '', {}, signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })
})

describe('workspaceFiles.read — gate 3: the page byte cap', () => {
  it('fails a page above the cap rather than returning it shortened', async () => {
    await writeFile(join(workspace, 'big.txt'), 'x'.repeat(4096), 'utf8')
    const failure = await failureOf(endpoint({ maxBytes: 1024 }).read(harness.scope, 'big.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/too-large')
    expect(failure.details).toMatchObject({ limit: 1024 })
  })

  it('accepts a page exactly at the cap, because the cap is inclusive', async () => {
    await writeFile(join(workspace, 'exact.txt'), `${'x'.repeat(31)}\n${'y'.repeat(32)}\n`, 'utf8')
    const result = await endpoint({ maxBytes: 64 }).read(harness.scope, 'exact.txt', {}, signal())
    expect(result.text).toHaveLength(64)
  })

  it('counts the newlines between the page lines against the cap', async () => {
    await writeFile(join(workspace, 'exact.txt'), `${'x'.repeat(31)}\n${'y'.repeat(32)}\n`, 'utf8')
    const failure = await failureOf(endpoint({ maxBytes: 63 }).read(harness.scope, 'exact.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/too-large')
  })

  it('caps the page, not the file: a small window of a file far above the cap reads', async () => {
    await writeFile(join(workspace, 'huge.txt'), Array.from({ length: 2000 }, (_, i) => `row ${i} ${'z'.repeat(100)}`).join('\n'), 'utf8')
    const result = await endpoint({ maxBytes: 1024 }).read(harness.scope, 'huge.txt', { offset: 1990, limit: 3 }, signal())
    expect(result.text.split('\n')).toHaveLength(3)
    expect(result.eof).toBe(false)
    expect(result.bytes).toBeGreaterThan(200_000)
  })
})

describe('workspaceFiles.read — gate 4: text only', () => {
  it('rejects bytes that are not valid UTF-8', async () => {
    await writeFile(join(workspace, 'bin.dat'), Buffer.from([0xff, 0xfe, 0xfd]))
    const failure = await failureOf(endpoint().read(harness.scope, 'bin.dat', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-text')
  })

  it('rejects a page that carries NUL bytes, wherever in the file the page lies', async () => {
    await writeFile(join(workspace, 'nul.dat'), Buffer.from([0x61, 0x00, 0x62]))
    const service = endpoint()
    expect((await failureOf(service.read(harness.scope, 'nul.dat', {}, signal()))).code).toBe('workspace-file/not-text')
    // Past the backend's own binary sample, so only the page scan can see it.
    await lateNul()
    expect((await failureOf(service.read(harness.scope, 'late-nul.txt', { offset: 2 }, signal()))).code).toBe('workspace-file/not-text')
  })

  it('reads a page that ends before a NUL byte, because detection is per page', async () => {
    await lateNul()
    const result = await endpoint().read(harness.scope, 'late-nul.txt', { limit: 1 }, signal())
    expect(result.text).toHaveLength(9000)
    expect(result.eof).toBe(false)
  })
})

describe('workspaceFiles.read — the file changing under its gate', () => {
  /** Run `mutate` after the path gate has looked, so what follows sees a different filesystem. */
  function afterGate(mutate: () => Promise<void>): void {
    const fs = harness.ctx.fs
    const lstat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (path, opts, signal) => {
      const entry = await lstat(path, opts, signal)
      await mutate()
      return entry
    })
  }

  it('reports a file deleted after the gate as not found, not as an internal failure', async () => {
    await writeFile(join(workspace, 'fleeting.txt'), 'x', 'utf8')
    afterGate(() => rm(join(workspace, 'fleeting.txt')))
    const failure = await failureOf(endpoint().read(harness.scope, 'fleeting.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })

  it('reports a file replaced by a directory after the gate as not a regular file', async () => {
    await writeFile(join(workspace, 'fleeting.txt'), 'x', 'utf8')
    afterGate(async () => {
      await rm(join(workspace, 'fleeting.txt'))
      await mkdir(join(workspace, 'fleeting.txt'))
    })
    const failure = await failureOf(endpoint().read(harness.scope, 'fleeting.txt', {}, signal()))
    expect(failure.code).toBe('workspace-file/not-regular-file')
    expect(failure.details).toMatchObject({ kind: 'directory' })
  })

  it('passes any other backend failure through unchanged', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'x', 'utf8')
    vi.spyOn(harness.ctx.fs, 'streamText').mockRejectedValue(new FsError('disk unreadable', 'FS_IO_ERROR'))
    await expect(endpoint().read(harness.scope, 'notes.txt', {}, signal())).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
})
