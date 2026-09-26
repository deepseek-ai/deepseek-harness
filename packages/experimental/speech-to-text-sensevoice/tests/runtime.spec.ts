/** Preparation publishes verified assets and joins failed or cancelled installer processes. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import { downloadAsset } from '../src/runtime.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-runtime-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}
const bytes = Buffer.from('verified model')
const asset = { name: 'model.bin', url: 'https://example.invalid/model', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
const signal = (): AbortSignal => new AbortController().signal

it('publishes verified files, reuses them offline, and replaces corrupted cached files', async () => {
  const root = await fixture(), fetcher = vi.fn(async () => new Response(bytes))
  vi.stubGlobal('fetch', fetcher)
  const path = await downloadAsset(asset, root, signal())
  expect(await readFile(path)).toEqual(bytes)
  await downloadAsset(asset, root, signal())
  expect(fetcher).toHaveBeenCalledOnce()
  await writeFile(path, 'corrupt')
  await downloadAsset(asset, root, signal())
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(await readdir(root)).toEqual(['model.bin'])
})

it('rejects altered downloads and HTTP failures without leaving partial files', async () => {
  const root = await fixture()
  vi.stubGlobal('fetch', async () => new Response('corrupt'))
  await expect(downloadAsset(asset, root, signal())).rejects.toMatchObject({ download: { reason: 'integrity', resource: asset.name } })
  vi.stubGlobal('fetch', async () => new Response(bytes))
  await expect(downloadAsset({ ...asset, sha256: 'bad-digest' }, root, signal())).rejects.toMatchObject({ download: { reason: 'integrity' } })
  await expect(downloadAsset({ ...asset, bytes: 1 }, root, signal())).rejects.toMatchObject({ download: { reason: 'integrity' } })
  vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }))
  await expect(downloadAsset(asset, root, signal())).rejects.toMatchObject({ download: {
    reason: 'http', resource: asset.name, source: 'https://example.invalid', status: 503,
  } })
  vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
  await expect(downloadAsset(asset, root, signal())).rejects.toThrow('200')
  expect(await readdir(root)).toEqual([])
})

it('reports fetch causes without exposing credentials, query strings or raw cause messages', async () => {
  const root = await fixture()
  const cause = Object.assign(new Error('private proxy details'), { code: 'ENOTFOUND' })
  vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed', { cause }) })
  await expect(downloadAsset({ ...asset, url: 'https://user:secret@example.invalid/model?token=private' }, root, signal()))
    .rejects.toMatchObject({
      message: 'Unable to prepare model.bin from https://example.invalid: dns (ENOTFOUND)',
      download: { reason: 'dns', resource: 'model.bin', source: 'https://example.invalid', code: 'ENOTFOUND' },
    })
  expect(await readdir(root)).toEqual([])
})

it('reports the redirected source and cleans interrupted downloads while preserving verified files for retry', async () => {
  const root = await fixture()
  vi.stubGlobal('fetch', async () => new Response(bytes))
  await downloadAsset(asset, root, signal())
  const other = { ...asset, name: 'tokens.txt' }
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 2))
    controller.error(Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }))
  } }))
  Object.defineProperty(response, 'url', { value: 'https://cdn.example.invalid/model?signature=private' })
  vi.stubGlobal('fetch', async () => response)
  await expect(downloadAsset(other, root, signal())).rejects.toMatchObject({ download: {
    reason: 'network', source: 'https://cdn.example.invalid', code: 'ECONNRESET', resource: 'tokens.txt',
  } })
  expect(await readdir(root)).toEqual(['model.bin'])
  const retry = vi.fn(async () => new Response(bytes))
  vi.stubGlobal('fetch', retry)
  await downloadAsset(asset, root, signal()); await downloadAsset(other, root, signal())
  expect(retry).toHaveBeenCalledOnce()
  expect(await readFile(join(root, 'model.bin'))).toEqual(bytes)
})

it.each([false, true])('distinguishes explicit cancellation from a preparation deadline (timeout: %s)', async (timedOut) => {
  const root = await fixture(), abort = new AbortController(), started = Promise.withResolvers<undefined>()
  const reason = timedOut ? new TimeoutReason('SPEECH_PREPARE_TIMEOUT', 1000) : new Error('user cancelled')
  vi.stubGlobal('fetch', async () => await new Promise<Response>((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => { reject(reason) }, { once: true })
    started.resolve(undefined)
  }))
  const pending = downloadAsset(asset, root, abort.signal)
  const rejected = timedOut ? expect(pending).rejects.toMatchObject({ download: { reason: 'timeout', resource: asset.name } })
    : expect(pending).rejects.toBe(reason)
  cleanup.push(async () => { abort.abort(); await pending.catch(() => {}) })
  await started.promise; abort.abort(reason); await rejected
  expect(await readdir(root)).toEqual([])
})

it('cancels streaming downloads and refuses invalid cache locations', async () => {
  const root = await fixture(), cancel = new AbortController(), reading = Promise.withResolvers<undefined>()
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
    start(controller) { cancel.signal.addEventListener('abort', () => { controller.error(cancel.signal.reason) }, { once: true }) },
    pull() { reading.resolve(undefined) },
  })))
  const pending = downloadAsset(asset, root, cancel.signal)
  const rejected = expect(pending).rejects.toThrow()
  await reading.promise; cancel.abort()
  await rejected
  expect(await readdir(root)).toEqual([])
  await expect(downloadAsset(asset, root, cancel.signal)).rejects.toThrow()
  const child = join(root, 'invalid')
  await writeFile(child, 'file')
  await expect(downloadAsset(asset, child, signal())).rejects.toThrow()
})
