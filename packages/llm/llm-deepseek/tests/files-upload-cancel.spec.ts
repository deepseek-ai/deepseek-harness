/** Cancelling a turn while its Files upload starts, through the real `fetch` and a loopback server. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment/types'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DeepSeekFileStore } from '../src/file-store.ts'
import { RequestFiles } from '../src/request-files.ts'
import { DeepSeekUploadIndex } from '../src/upload-index.ts'

const IMAGE_BYTES = 2 * 1024 * 1024
const POLICY = {
  expiresAfterSeconds: 604_800, refreshMarginSeconds: 3_600, quotaCleanupBatch: 100,
  uploadMaxRetries: 0, uploadRetryDelayMs: 500, uploadConcurrency: 3, uploadTimeoutMs: 60_000,
}

function image(): RequestImageAttachment {
  const attachmentId = brandString<AttachmentId>(`sha256:${'a'.repeat(64)}`)
  return {
    variantId: brandString<ImageVariantId>(`sha256:${'b'.repeat(64)}`),
    attachment: { attachmentId, mediaType: 'image/png', bytes: IMAGE_BYTES, width: 1_024, height: 512 },
    data: new Uint8Array(IMAGE_BYTES).fill(7),
    mediaType: 'image/png',
    bytes: IMAGE_BYTES,
    width: 1_024,
    height: 512,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
  }
}

/** Loopback Files endpoint that accepts every upload; closed, with its connections, when the test finishes. */
async function filesEndpoint(): Promise<string> {
  const http = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        id: 'file-api-one', type: 'file', size_bytes: IMAGE_BYTES,
        created_at: '2023-11-14T22:13:20.000Z', filename: 'image.png', mime_type: 'image/png',
      }))
    })
  })
  http.listen(0, '127.0.0.1')
  onTestFinished(async () => {
    const closed = new Promise<void>((resolve, reject) => {
      http.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    http.closeAllConnections()
    await closed
  })
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback port')
  return `http://127.0.0.1:${address.port}`
}

describe('a turn cancelled while its Files upload starts', () => {
  it.each([
    ['the next microtask', (cancel: () => void) => { queueMicrotask(cancel) }],
    ['the next setImmediate turn', (cancel: () => void) => { setImmediate(cancel) }],
  ] as const)('leaves no unhandled rejection when cancelled in %s after the upload request was issued', async (_when, schedule) => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', record)
    onTestFinished(() => { process.off('unhandledRejection', record) })
    const root = await mkdtemp(join(tmpdir(), 'dsh-files-upload-cancel-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const baseURL = await filesEndpoint()

    const turn = new AbortController()
    const cancelled = new Error('turn cancelled')
    const transport = Promise.withResolvers<undefined>()
    const store = new DeepSeekFileStore({
      index: new DeepSeekUploadIndex(join(root, 'index.json')),
      fetch: (input, init) => {
        const response = fetch(input, init)
        const settled = () => { transport.resolve(undefined) }
        void response.then(settled, settled)
        schedule(() => { turn.abort(cancelled) })
        return response
      },
    })
    const files = new RequestFiles(store, { baseURL, headers: { 'x-api-key': 'key' } }, POLICY, turn.signal, () => {})
    const version = image()

    await expect(files.resolveAll(new Map([[version.attachment.attachmentId, version]]))).rejects.toBe(cancelled)
    await transport.promise
    // Node reports an unhandled rejection only after a later event-loop turn; with a FormData body it arrived in the
    // first turn after the transport settled. The bound only ends the wait when nothing is reported.
    for (let turns = 0; turns < 50 && unhandled.length === 0; turns += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }

    expect(unhandled).toEqual([])
  })
})
