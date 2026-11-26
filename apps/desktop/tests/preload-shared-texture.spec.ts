/** `dshDesktop.textures` imports each texture Main sends, lends it to the document's consumer, and reports its lifetime to Main. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import type { SharedTextureLease } from '@deepseek-ai/dsh-shared-texture/types'

const f = vi.hoisted(() => ({
  finish: vi.fn<(transfer: Electron.SharedTextureTransfer) => unknown>(),
}))
vi.mock('electron', () => ({ sharedTexture: { subtle: { finishTransferSharedTexture: f.finish } } }))

import { createSharedTextureClientExport } from '../src/shared-texture/preload.ts'

type Listener = (event: unknown, message: unknown) => void
let listener: Listener | undefined
const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
const ipc = {
  on: vi.fn((channel: string, next: Listener) => {
    expect(channel).toBe(DESKTOP_IPC.sharedTexture)
    listener = next
  }),
  send,
}
const bridge = () => createSharedTextureClientExport(ipc)

function texture() {
  const close = vi.fn()
  const frame = { close } as Partial<VideoFrame> as VideoFrame
  let gpuDone: (() => void) | undefined
  const imported = {
    getVideoFrame: vi.fn(() => frame),
    getFrameCreationSyncToken: vi.fn(() => ({ syncToken: 'created' })),
    release: vi.fn((callback?: () => void) => { gpuDone = callback }),
  }
  f.finish.mockReturnValueOnce(imported)
  return { frame, close, imported, gpuDone: () => { gpuDone?.() } }
}
const transfer = { transfer: 'data', syncToken: 'source', pixelFormat: 'bgra', codedSize: { width: 4, height: 2 }, visibleRect: { x: 0, y: 0, width: 4, height: 2 }, timestamp: 0 }
/** Deliver one transfer from Main, whose metadata is the Host's JSON text. */
const deliver = (id: unknown, metadata: unknown = '{}', data: unknown = transfer) => { listener!({}, { id, transfer: data, metadata }) }

beforeEach(() => { listener = undefined })
afterEach(() => { vi.clearAllMocks() })

test('reports the import at once and the release only after the consumer released the lease and the GPU finished', () => {
  const consumer = vi.fn<(lease: SharedTextureLease) => void>()
  bridge().onFrame(consumer)
  const { frame, close, imported, gpuDone } = texture()
  const metadata = { viewId: 'view', requestId: 'request', extra: [1, 2] }
  deliver(1, JSON.stringify(metadata))
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(transfer)
  expect(send.mock.calls).toEqual([[DESKTOP_IPC.sharedTextureImported, 1, { syncToken: 'created' }]])
  const lease = consumer.mock.calls[0]![0]
  expect(lease).toMatchObject({ frame, metadata })
  expect(imported.release).not.toHaveBeenCalled()
  lease.release()
  lease.release()
  expect(close).toHaveBeenCalledOnce()
  expect(imported.release).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledOnce()
  gpuDone()
  expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.sharedTextureReleased, 1)
})

test('lends parsed metadata: an empty text is null and any JSON value passes through', () => {
  const consumer = vi.fn<(lease: SharedTextureLease) => void>()
  bridge().onFrame(consumer)
  for (const [index, [text, value]] of ([['', null], ['"label"', 'label'], ['0', 0], ['[1,{"a":null}]', [1, { a: null }]]] as const).entries()) {
    texture()
    deliver(index + 1, text)
    expect(consumer.mock.calls[index]![0].metadata).toEqual(value)
  }
  expect(f.finish).toHaveBeenCalledTimes(4)
})

test('refuses metadata that is not JSON text before importing the texture', () => {
  const consumer = vi.fn<(lease: SharedTextureLease) => void>()
  bridge().onFrame(consumer)
  deliver(1, '{')
  expect(send.mock.calls).toEqual([[DESKTOP_IPC.sharedTextureImported, 1, { error: 'Shared-texture metadata is not valid JSON' }]])
  // Main forwards the Host's text; a parsed value is not a transfer Main sent.
  deliver(2, { viewId: 'view' })
  expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.sharedTextureImported, 2, { error: 'Invalid shared-texture transfer' })
  expect(f.finish).not.toHaveBeenCalled()
  expect(consumer).not.toHaveBeenCalled()
})

test('reports a failed import or an invalid transfer to Main, and ignores a transfer without an identifier', () => {
  bridge().onFrame(vi.fn())
  f.finish.mockImplementationOnce(() => { throw new Error('GPU is not available') })
  deliver(1)
  expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.sharedTextureImported, 1, { error: 'GPU is not available' })
  const { imported } = texture()
  imported.getFrameCreationSyncToken.mockImplementationOnce(() => { throw new Error('released') })
  deliver(2)
  expect(imported.release).toHaveBeenCalledOnce()
  expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.sharedTextureImported, 2, { error: 'released', invalidated: true })
  const invalidTransfers = [
    null, { ...transfer, transfer: 1 }, { ...transfer, codedSize: { width: 4 } }, { ...transfer, visibleRect: null },
  ]
  for (const invalid of invalidTransfers) {
    deliver(3, '{}', invalid)
    expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.sharedTextureImported, 3, { error: 'Invalid shared-texture transfer' })
  }
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  send.mockClear()
  deliver('invalid')
  listener!({}, null)
  expect(send).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledTimes(2)
  expect(f.finish).toHaveBeenCalledTimes(2)
})

test('refuses textures without a consumer before importing them, and refuses a second consumer', () => {
  const instance = bridge()
  deliver(1)
  const dispose = instance.onFrame(vi.fn())
  expect(() => instance.onFrame(vi.fn())).toThrow('already have a consumer')
  dispose()
  deliver(2)
  expect(send.mock.calls).toEqual([
    [DESKTOP_IPC.sharedTextureImported, 1, { error: 'Shared textures have no consumer' }],
    [DESKTOP_IPC.sharedTextureImported, 2, { error: 'Shared textures have no consumer' }],
  ])
  expect(f.finish).not.toHaveBeenCalled()
})

test('a disposer of a replaced consumer leaves the current consumer in place', () => {
  const instance = bridge()
  const first = vi.fn()
  const disposeFirst = instance.onFrame(first)
  disposeFirst()
  const second = vi.fn((lease: SharedTextureLease) => { lease.release() })
  instance.onFrame(second)
  disposeFirst()
  texture()
  deliver(1)
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledOnce()
})

test('a consumer that throws still releases the texture', () => {
  bridge().onFrame(() => { throw new Error('consumer failed') })
  const { close, imported } = texture()
  expect(() => { deliver(1) }).toThrow('consumer failed')
  expect(close).toHaveBeenCalledOnce()
  expect(imported.release).toHaveBeenCalledOnce()
})
