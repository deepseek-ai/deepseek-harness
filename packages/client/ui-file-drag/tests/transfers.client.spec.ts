// @vitest-environment jsdom
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FILE_DRAG_TOKEN_TYPE, type DesktopFileDrag, type FileDragHandle } from '@deepseek-ai/dsh-util-file-drag'
import { FileTransfers } from '../src/client/transfers.ts'

const revokeUrl = vi.fn<(url: string) => void>()
beforeEach(() => {
  revokeUrl.mockReset()
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:copy'), revokeObjectURL: revokeUrl }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const blobSource = () => ({ kind: 'blob' as const, blob: new Blob(['%PDF-original'], { type: 'application/pdf' }), name: 'report', mediaType: '' })
const signal = () => new AbortController().signal
const native = (): DesktopFileDrag => ({
  prepare: vi.fn(async () => 'handle' as FileDragHandle), cancel: vi.fn(), start: vi.fn(async () => true), release: vi.fn(),
})
function transfer(): DataTransfer {
  const data = new Map<string, string>()
  return Object.assign({} as DataTransfer, { items: { clear: vi.fn() }, effectAllowed: 'none',
    setData: (key: string, value: string) => { data.set(key, value) }, getData: (key: string) => data.get(key) ?? '' })
}

it('borrows an authorized resource before fetching URL bytes', async () => {
  const desktop = native()
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const files = new FileTransfers(desktop, vi.fn())
  const prepared = await files.prepare({ kind: 'url', url: '/api/file', name: 'report.pdf', mediaType: 'application/pdf', resourceAddress: 'dsh-resource://file/session/s/report.pdf' }, signal())
  expect(desktop.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: 'resource', address: 'dsh-resource://file/session/s/report.pdf' }), expect.any(String))
  expect(fetcher).not.toHaveBeenCalled()
  expect(prepared.start(transfer(), document.createElement('div'))).toBe(false)
  await Promise.resolve()
  prepared.release()
  await Promise.resolve()
  expect(desktop.release).toHaveBeenCalledOnce()
  prepared.release()
  expect(prepared.start(transfer(), document.createElement('div'))).toBe(false)
  files.dispose()
})

it('compares original Blob bytes by digest and copies a mismatching resource', async () => {
  const desktop = native()
  vi.mocked(desktop.prepare).mockResolvedValueOnce(undefined)
  const files = new FileTransfers(desktop, vi.fn())
  const prepared = await files.prepare({ ...blobSource(), resourceAddress: 'dsh-resource://file/session/s/report.pdf', outputExtension: '.bin' }, signal())
  expect(desktop.prepare).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'resource', size: 13 }), expect.any(String))
  const request = vi.mocked(desktop.prepare).mock.calls[0]![0]
  expect(request.kind === 'resource' ? request.sha256 : undefined).toMatch(/^[a-f0-9]{64}$/u)
  expect(desktop.prepare).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'bytes', name: 'report.bin', outputExtension: '.bin' }), expect.any(String))
  prepared.release()
  files.dispose()
})

it('fetches generic remote bytes and preserves explicit unknown types and extensions', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('sheet-bytes', { headers: { 'Content-Type': 'application/x-custom' } }))
  vi.stubGlobal('fetch', fetcher)
  const files = new FileTransfers(undefined, vi.fn())
  const prepared = await files.prepare({ kind: 'url', url: '/sheet', name: 'sheet.custom', mediaType: '' }, signal())
  const data = transfer()
  const node = document.createElement('div')
  expect(prepared.start(data, node)).toBe(true)
  const file = files.read(data)!
  expect(file.name).toBe('sheet.custom')
  expect(await file.text()).toBe('sheet-bytes')
  expect(data.getData(FILE_DRAG_TOKEN_TYPE)).not.toBe('')
  node.dispatchEvent(new Event('dragend'))
  expect(files.read(data)).toBeUndefined()
  prepared.release()
  files.dispose()
})

it('keeps retained files through the drop task and retires them afterward', async () => {
  const files = new FileTransfers(undefined, vi.fn())
  const prepared = await files.prepare(blobSource(), signal())
  const data = transfer()
  prepared.start(data, document.createElement('div'))
  prepared.release()
  window.dispatchEvent(new Event('drop'))
  expect(files.read(data)).toBeDefined()
  await Promise.resolve()
  expect(files.read(data)).toBeUndefined()
  expect(revokeUrl).toHaveBeenCalledOnce()
  expect(prepared.start(data, document.createElement('div'))).toBe(false)
  files.dispose()
})

it('replaces active transfers and disposes mounted preparations', async () => {
  const files = new FileTransfers(undefined, vi.fn())
  const first = await files.prepare(blobSource(), signal())
  const second = await files.prepare(blobSource(), signal())
  const a = transfer(), b = transfer()
  first.start(a, document.createElement('div'))
  second.start(b, document.createElement('div'))
  expect(files.read(a)).toBeUndefined()
  expect(files.read(b)).toBeDefined()
  files.dispose()
  expect(files.read(b)).toBeUndefined()
  expect(revokeUrl).toHaveBeenCalledTimes(2)
  await expect(files.prepare(blobSource(), signal())).rejects.toThrow('File transfers disposed')
})

it('reports native start rejection and releases failed preparation', async () => {
  const desktop = native()
  const failed = vi.fn()
  const files = new FileTransfers(desktop, failed)
  const prepared = await files.prepare(blobSource(), signal())
  vi.mocked(desktop.start).mockRejectedValueOnce(new Error('OS failed'))
  prepared.start(transfer(), document.createElement('div'))
  await Promise.resolve()
  expect(failed).toHaveBeenCalledOnce()
  files.dispose()
  vi.mocked(desktop.prepare).mockResolvedValue(undefined)
  const retry = new FileTransfers(desktop, failed)
  await expect(retry.prepare(blobSource(), signal())).rejects.toThrow('File preparation unavailable')
  retry.dispose()
})

it('rejects unreadable remote files without retaining a preparation', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 404 })))
  const files = new FileTransfers(undefined, vi.fn())
  await expect(files.prepare({ kind: 'url', url: '/missing', mediaType: '' }, signal())).rejects.toThrow('File read failed')
  files.dispose()
})

it('copies already loaded PDF bytes when optional resource authorization rejects', async () => {
  const desktop = native()
  vi.mocked(desktop.prepare).mockRejectedValueOnce(new Error('Host resource unavailable'))
  const files = new FileTransfers(desktop, vi.fn())
  const prepared = await files.prepare({ ...blobSource(), resourceAddress: 'dsh-resource://file/session/s/report.pdf' }, signal())
  const request = vi.mocked(desktop.prepare).mock.calls[1]![0]
  expect(request.kind).toBe('bytes')
  expect(request.name).toBe('report.pdf')
  if (request.kind === 'bytes') expect(new TextDecoder().decode(request.bytes)).toBe('%PDF-original')
  prepared.release()
  files.dispose()
})

it('sends cancellation before native preparation has returned its handle', async () => {
  const desktop = native()
  const pending = Promise.withResolvers<FileDragHandle | undefined>()
  vi.mocked(desktop.prepare).mockReturnValue(pending.promise)
  const files = new FileTransfers(desktop, vi.fn())
  const controller = new AbortController()
  const preparing = files.prepare(blobSource(), controller.signal)
  const rejected = expect(preparing).rejects.toThrow()
  await vi.waitFor(() => { expect(desktop.prepare).toHaveBeenCalledOnce() })
  const requestId = vi.mocked(desktop.prepare).mock.calls[0]![1]
  controller.abort()
  expect(desktop.cancel).toHaveBeenCalledWith(requestId)
  pending.resolve('late' as FileDragHandle)
  await rejected
  expect(desktop.release).toHaveBeenCalledWith('late')
  files.dispose()
})

it('does not let an older drop microtask clear a newer transfer and supplies a MIME for untyped files', async () => {
  const files = new FileTransfers(undefined, vi.fn())
  const first = await files.prepare(blobSource(), signal())
  const second = await files.prepare({ kind: 'blob', blob: new Blob(['raw']), name: 'raw.custom', mediaType: '' }, signal())
  const a = transfer(), b = transfer()
  first.start(a, document.createElement('div'))
  first.release()
  window.dispatchEvent(new Event('drop'))
  second.start(b, document.createElement('div'))
  await Promise.resolve()
  expect(files.read(b)?.name).toBe('raw.custom')
  expect(b.getData('DownloadURL')).toBe('application/octet-stream:raw.custom:blob:copy')
  files.dispose()
})

it.each(['abort', 'dispose'] as const)('releases a native preparation completed after %s', async (action) => {
  const desktop = native()
  const pending = Promise.withResolvers<FileDragHandle | undefined>()
  vi.mocked(desktop.prepare).mockReturnValue(pending.promise)
  const files = new FileTransfers(desktop, vi.fn())
  const abort = new AbortController()
  const preparing = files.prepare(blobSource(), abort.signal)
  const rejected = expect(preparing).rejects.toThrow()
  await vi.waitFor(() => { expect(desktop.prepare).toHaveBeenCalledOnce() })
  if (action === 'abort') abort.abort()
  else files.dispose()
  pending.resolve('late' as FileDragHandle)
  await rejected
  expect(desktop.release).toHaveBeenCalledWith('late')
  files.dispose()
})

it('rejects a Web preparation when the plugin is disposed while fetching', async () => {
  const pending = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => pending.promise))
  const files = new FileTransfers(undefined, vi.fn())
  const preparing = files.prepare({ kind: 'url', url: '/pending', mediaType: 'application/pdf' }, signal())
  const rejected = expect(preparing).rejects.toThrow()
  files.dispose()
  pending.resolve(new Response('pdf'))
  await rejected
})
