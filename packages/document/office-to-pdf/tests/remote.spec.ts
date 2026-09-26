/** Authorized source identity and cancellation survive Host rendering. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import type { FileSystem, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { OfficeToPdfError, OfficeToPdfKey, type OfficeToPdfResult } from '../src/index.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OfficeToPdf from '../src/index.ts'

const scope = { sessionId: SessionId('document-test'), workspaceRoot: '/workspace' }
const source = { absolutePath: '/workspace/report.DOCX', version: 'source-v1', bytes: 4 }
const rawSource = { ...source, data: new Uint8Array([80, 75, 3, 4]) }
const wireSource = { ...source, offset: 0, eof: true, data: rawSource.data }
let generation: OfficeToPdf['generation']
const cacheKey = OfficeToPdfKey('test-result')
const pdf = new Uint8Array([37, 80, 68, 70, 45])
let ctx: Context
const target = { targetKey: 'office-source' as FsTarget['targetKey'], displayPath: source.absolutePath }
const sourceInfo = { type: 'file' as const, version: source.version as FsInfo['version'], size: source.bytes }
let read: ReturnType<typeof vi.fn<FileSystem['readBytes']>>
let fileInfo: ReturnType<typeof vi.fn<FileSystem['stat']>>
let processPath: ReturnType<typeof vi.fn<FileSystem['processPath']>>
let authorize: ReturnType<typeof vi.fn<WorkspaceFiles['readBytes']>>
let metadata: ReturnType<typeof vi.fn<WorkspaceFiles['stat']>>
let render: ReturnType<typeof vi.fn<OfficeToPdf['convert']>>

beforeEach(async () => {
  ctx = new Context()
  read = vi.fn<FileSystem['readBytes']>().mockResolvedValue(rawSource.data)
  fileInfo = vi.fn<FileSystem['stat']>().mockResolvedValue(sourceInfo)
  processPath = vi.fn<FileSystem['processPath']>().mockReturnValue(source.absolutePath)
  ctx.provide('fs', { resolve: vi.fn().mockResolvedValue(target), stat: fileInfo, processPath, readBytes: read } as never)
  authorize = vi.fn<WorkspaceFiles['readBytes']>().mockResolvedValue({ ...wireSource, eof: false, data: rawSource.data.subarray(0, 1) })
  metadata = vi.fn<WorkspaceFiles['stat']>().mockResolvedValue(source)
  await ctx.plugin(OfficeToPdf)
  generation = ctx.officeToPdf.generation
  render = vi.spyOn(ctx.officeToPdf, 'convert').mockImplementation(async (request, signal) => {
    const loaded = await request.source.read(signal!, 4)
    expect(loaded.bytes).toBe(rawSource.data)
    return { pdf, missingFonts: ['Missing Serif'], generation, cacheKey }
  })
  ctx.provide('workspaceFiles', { stat: metadata, readBytes: authorize } as never)
})
afterEach(async () => { await ctx.fiber.dispose() })

it.each(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])('converts authorized %s bytes and returns the PDF under source identity', async (extension) => {
  const path = `report.${extension.toUpperCase()}`
  const result = await ctx.officeToPdf.render(scope, path, 'foreground', new AbortController().signal)
  expect(read).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal), 4)
  expect(authorize).toHaveBeenCalledExactlyOnceWith(scope, path, { range: { offset: 0, length: 1 } }, expect.any(AbortSignal))
  expect(render).toHaveBeenCalledOnce()
  expect(render.mock.calls[0]?.[0]).toMatchObject({ extension, priority: 'foreground', source: { version: source.version, bytes: 4 } })
  expect(result).toEqual({ ...wireSource, data: pdf, bytes: pdf.length, missingFonts: ['Missing Serif'], generation })
  expect(ctx.get('agents')).toBeUndefined()
})

it('preserves authorization failures without starting conversion', async () => {
  const failure = new RemoteError('workspace-file/not-found', 'File missing', { path: 'report.DOCX' })
  metadata.mockRejectedValueOnce(failure)
  await expect(ctx.officeToPdf.render(scope, 'report.DOCX', 'foreground', new AbortController().signal)).rejects.toBe(failure)
  expect(render).not.toHaveBeenCalled()
})

it('keeps an unknown source size absent so the provider can reserve its input limit', async () => {
  const { bytes: _bytes, ...unknownSize } = source
  metadata.mockResolvedValue(unknownSize)
  await ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal)
  expect(render.mock.calls[0]![0].source).not.toHaveProperty('bytes')
  expect(read).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal), 4)
})

it('refuses a cached PDF when source metadata remains readable but content access is denied', async () => {
  let cached: OfficeToPdfResult | undefined
  render.mockImplementation(async (request, signal) => {
    if (cached !== undefined) return cached
    await request.source.read(signal!, 4)
    cached = { pdf, missingFonts: [], generation, cacheKey }
    return cached
  })
  await ctx.officeToPdf.render(scope, 'report.DOCX', 'foreground', new AbortController().signal)
  const failure = new Error('read denied')
  authorize.mockRejectedValueOnce(failure)
  await expect(ctx.officeToPdf.render(scope, 'report.DOCX', 'foreground', new AbortController().signal)).rejects.toBe(failure)
  expect(render).toHaveBeenCalledOnce()
  expect(read).toHaveBeenCalledOnce()
})

it('refuses a source replaced while checking read access before cache lookup', async () => {
  metadata.mockResolvedValueOnce({ ...source, version: 'v2' })
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'source-changed' } })
  expect(render).not.toHaveBeenCalled()
})

it('rejects unsupported extensions before reading a source', async () => {
  await expect(ctx.officeToPdf.render(scope, 'report.odt', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'unsupported-format' } })
  expect(read).not.toHaveBeenCalled()
})

it.each(['invalid-document', 'output-too-large', 'timeout', 'invalid-output'] as const)('maps %s without returning source or diagnostic bytes', async (code) => {
  render.mockRejectedValueOnce(new OfficeToPdfError(code, 'private engine detail'))
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', message: 'Office conversion failed.', details: { reason: code } })
})

it('cancels before reading and refuses a late authorized read after cancellation', async () => {
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', AbortSignal.abort())).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(read).not.toHaveBeenCalled()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<Uint8Array>()
  read.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
  const controller = new AbortController()
  const work = ctx.officeToPdf.render(scope, 'report.docx', 'foreground', controller.signal)
  const rejected = expect(work).rejects.toMatchObject({ code: 'gateway/cancelled' })
  await entered.promise
  controller.abort()
  release.resolve(rawSource.data)
  await rejected
  expect(render).toHaveBeenCalledOnce()
})

it('cancels and joins an outstanding conversion when the provider unloads', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<OfficeToPdfResult>()
  render.mockImplementationOnce((_input, signal) => { entered.resolve(signal!); return release.promise })
  const work = ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal)
  const rejected = expect(work).rejects.toMatchObject({ code: 'gateway/cancelled' })
  const signal = await entered.promise
  let disposed = false
  const closing = ctx.fiber.dispose().then(() => { disposed = true })
  try {
    await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
    expect(disposed).toBe(false)
  } finally { release.resolve({ pdf, missingFonts: [], generation, cacheKey }); await rejected; await closing }
})

it('exposes the current renderer generation and refuses busy work before loading source bytes', async () => {
  expect(ctx.officeToPdf.getGeneration(new AbortController().signal)).toBe(generation)
  render.mockRejectedValueOnce(new OfficeToPdfError('busy', 'capacity'))
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'background', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'busy' } })
  expect(metadata).toHaveBeenCalledOnce()
  expect(read).not.toHaveBeenCalled()
})

it.each([{ absolutePath: '/workspace/replaced.docx' }, { version: 'v2' }])('refuses bytes when source metadata changes during the bounded read: %j', async (change) => {
  metadata.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, ...change })
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'source-changed' } })
})

it('classifies a grown queued source as changed without increasing its read reservation', async () => {
  const failure = { code: 'FS_TOO_LARGE' }
  read.mockRejectedValueOnce(failure)
  metadata.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, bytes: 8, version: 'v2' })
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'source-changed' } })
  expect(read).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal), 4)
})

it('classifies a size failure when source identity is unchanged', async () => {
  const failure = { code: 'FS_TOO_LARGE' }
  read.mockRejectedValueOnce(failure)
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'input-too-large' } })
  expect(metadata).toHaveBeenCalledTimes(2)
})

it.each([
  new Error('Source read denied'),
  new RemoteError('workspace-file/not-found', 'Source missing', { path: 'report.docx' }),
])('preserves a non-size bounded-read failure without another metadata query: %s', async (failure) => {
  read.mockRejectedValueOnce(failure)
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal)).rejects.toBe(failure)
  expect(metadata).toHaveBeenCalledOnce()
})

it.each([
  new Error('Current source metadata denied'),
  new RemoteError('workspace-file/not-found', 'Current source missing', { path: 'report.docx' }),
])('preserves a source metadata failure during the size recheck: %s', async (failure) => {
  read.mockRejectedValueOnce({ code: 'FS_TOO_LARGE' })
  metadata.mockResolvedValueOnce(source).mockRejectedValueOnce(failure)
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal)).rejects.toBe(failure)
  expect(metadata).toHaveBeenCalledTimes(2)
})

it.each([{ absolutePath: '/workspace/replaced.docx' }, { version: 'v2' }])('refuses a different bounded-read source even if the final metadata matches: %j', async (change) => {
  if ('absolutePath' in change) processPath.mockReturnValueOnce(change.absolutePath)
  else fileInfo.mockResolvedValueOnce({ ...sourceInfo, version: change.version as FsInfo['version'] })
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'source-changed' } })
})

it.each(['workspaceFiles', 'fs'] as const)('reports unavailable file access when %s is absent', async (missing) => {
  const independent = new Context()
  try {
    await independent.plugin(OfficeToPdf)
    if (missing === 'workspaceFiles') independent.provide('fs', {} as never)
    else independent.provide('workspaceFiles', {} as never)
    expect(independent.get(missing)).toBeUndefined()
    await expect(independent.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
      .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'unavailable' } })
    expect(() => independent.officeToPdf.getGeneration(AbortSignal.abort())).toThrow()
  } finally { await independent.fiber.dispose() }
})

it.each([undefined, { ...sourceInfo, type: 'directory' as const }])('rejects a source that disappears or stops being a file before reading', async (info) => {
  fileInfo.mockResolvedValueOnce(info)
  await expect(ctx.officeToPdf.render(scope, 'report.docx', 'foreground', new AbortController().signal))
    .rejects.toMatchObject({ code: 'document-render/failed', details: { reason: 'source-changed' } })
  expect(read).not.toHaveBeenCalled()
})
