/** The `readBytes` endpoint: the byte window it cuts, its defaults and cap, and the gates it shares with `read`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-read-bytes-')
  workspace = harness.workspace
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (caps?: { maxBytes?: number; maxFileBytes?: number }): ReturnType<Harness['endpoint']> => harness.endpoint(caps)

/** 256 bytes, each equal to its offset: the window's content names its position. */
const RAMP = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

describe('workspaceFiles.readBytes — the window', () => {
  it('returns the whole file as one window by default, with its absolute path, version, and size', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    const result = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: {} }, signal())
    expect(Buffer.from(result.data).equals(RAMP)).toBe(true)
    expect(result).toMatchObject({ offset: 0, eof: true, bytes: 256 })
    expect(result.absolutePath.endsWith('ramp.bin')).toBe(true)
    expect(result.version.length).toBeGreaterThan(0)
  })

  it('cuts the requested window and reports that more follows', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    const result = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: { offset: 16, length: 8 } }, signal())
    expect([...result.data]).toEqual([16, 17, 18, 19, 20, 21, 22, 23])
    expect(result).toMatchObject({ offset: 16, eof: false, bytes: 256 })
  })

  it('reads only a window of a file above both byte caps', async () => {
    await writeFile(join(workspace, 'huge.bin'), Buffer.alloc(200_000, 7))
    const rangeRead = vi.spyOn(harness.ctx.fs, 'readByteRange')
    const completeRead = vi.spyOn(harness.ctx.fs, 'readBytes')
    const caller = signal()
    const result = await endpoint({ maxBytes: 1024, maxFileBytes: 4 }).readBytes(harness.scope, 'huge.bin', { range: { offset: 199_000, length: 1024 } }, caller)
    expect(rangeRead).toHaveBeenCalledExactlyOnceWith(expect.anything(), { offset: 199_000, length: 1024 }, caller)
    expect(completeRead).not.toHaveBeenCalled()
    expect(result.data).toHaveLength(1000)
    expect(result).toMatchObject({ eof: true, bytes: 200_000 })
  })

  it('infers eof from a short window when the backend reports no size', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    vi.spyOn(harness.ctx.fs, 'stat').mockResolvedValue({ version: FsVersion('v-sizeless'), type: 'file' })
    const full = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: { offset: 0, length: 256 } }, signal())
    expect(full.eof).toBe(false)
    const short = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: { offset: 250, length: 10 } }, signal())
    expect(short).toMatchObject({ eof: true })
    expect(short.bytes).toBeUndefined()
  })

  it('reports eof on the window that holds the last byte, whether or not the length is reached', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    const exact = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: { offset: 248, length: 8 } }, signal())
    expect(exact.eof).toBe(true)
    expect(exact.data).toHaveLength(8)
    const short = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: { offset: 250, length: 100 } }, signal())
    expect(short.eof).toBe(true)
    expect([...short.data]).toEqual([250, 251, 252, 253, 254, 255])
  })

  it('returns an empty eof window for an offset at or past the end', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    const result = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: { offset: 300, length: 8 } }, signal())
    expect(result.data).toHaveLength(0)
    expect(result).toMatchObject({ offset: 300, eof: true, bytes: 256 })
  })

  it('returns an empty eof window for an empty file', async () => {
    await writeFile(join(workspace, 'empty.bin'), Buffer.alloc(0))
    const result = await endpoint().readBytes(harness.scope, 'empty.bin', { range: {} }, signal())
    expect(result.data).toHaveLength(0)
    expect(result).toMatchObject({ offset: 0, eof: true, bytes: 0 })
  })

  it('carries bytes a text read would refuse: NUL and invalid UTF-8 round-trip as bytes', async () => {
    const raw = Buffer.from([0, 0xff, 0xfe, 0x80, 0x41, 0])
    await writeFile(join(workspace, 'blob.bin'), raw)
    const result = await endpoint().readBytes(harness.scope, 'blob.bin', { range: {} }, signal())
    expect(Buffer.from(result.data).equals(raw)).toBe(true)
  })

  it('names the version a stat of the same file reports', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    const stat = await endpoint().stat(harness.scope, 'ramp.bin', signal())
    const result = await endpoint().readBytes(harness.scope, 'ramp.bin', { range: {} }, signal())
    expect(result.version).toBe(stat.version)
  })
})

describe('workspaceFiles.readBytes — defaults and cap', () => {
  it('defaults the length to the configured byte cap', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP.subarray(0, 64))
    const result = await endpoint({ maxBytes: 64 }).readBytes(harness.scope, 'ramp.bin', { range: {} }, signal())
    expect(result.data).toHaveLength(64)
    expect(result.eof).toBe(true)
  })

  it('refuses a window longer than the cap as too-large rather than shortening it', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    const failure = await failureOf(endpoint({ maxBytes: 64 }).readBytes(harness.scope, 'ramp.bin', { range: { length: 65 } }, signal()))
    expect(failure.code).toBe('workspace-file/too-large')
    expect(failure.details).toMatchObject({ limit: 64 })
  })

  it('accepts a window exactly at the cap', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP.subarray(0, 64))
    const result = await endpoint({ maxBytes: 64 }).readBytes(harness.scope, 'ramp.bin', { range: { length: 64 } }, signal())
    expect(result.data).toHaveLength(64)
  })

  it('refuses a negative or fractional offset and a non-positive length as bad requests', async () => {
    await writeFile(join(workspace, 'ramp.bin'), RAMP)
    // Beyond-safe integers and a window whose end overflows are refused too: they cannot index a file.
    const ranges = [
      { offset: -1 }, { offset: 1.5 }, { length: 0 }, { length: 2.5 },
      { offset: 2 ** 53 }, { offset: Number.MAX_SAFE_INTEGER, length: 2 },
    ]
    for (const range of ranges) {
      const failure = await failureOf(endpoint().readBytes(harness.scope, 'ramp.bin', { range }, signal()))
      expect(failure.code).toBe('gateway/bad-request')
    }
  })
})

describe('workspaceFiles.readBytes — the gates it shares with read', () => {
  it('rejects a directory, a missing path, and an empty path', async () => {
    await mkdir(join(workspace, 'dir'))
    expect((await failureOf(endpoint().readBytes(harness.scope, 'dir', { range: {} }, signal()))).code).toBe('workspace-file/not-regular-file')
    expect((await failureOf(endpoint().readBytes(harness.scope, 'missing.bin', { range: {} }, signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(endpoint().readBytes(harness.scope, '', { range: {} }, signal()))).code).toBe('gateway/bad-request')
  })

  it('reads a bounded byte window outside the workspace', async () => {
    await writeFile(join(harness.outside, 'sample.bin'), RAMP)
    const result = await endpoint().readBytes(harness.scope, join(harness.outside, 'sample.bin'), { range: { offset: 2, length: 4 } }, signal())
    expect(result.data).toEqual(RAMP.subarray(2, 6))
    expect(result).toMatchObject({ offset: 2, eof: false })
  })
})
