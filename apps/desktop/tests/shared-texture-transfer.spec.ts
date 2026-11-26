/**
 * A texture Main sends to the product renderer settles once: released after Main's and the renderer's references are
 * gone, or invalidated when its document goes first.
 */
import { beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  /** Electron's callback for Main's own import reference. */
  mainReleased: undefined as (() => void) | undefined,
  imported: {
    release: vi.fn((callback?: () => void) => { f.mainReleased = callback }),
    setReleaseSyncToken: vi.fn<(token: Electron.SharedTextureSyncToken) => void>(),
    startTransferSharedTexture: vi.fn(() => ({ transfer: 'transfer-data' })),
  },
}))
vi.mock('electron', () => ({ sharedTexture: { subtle: { importSharedTexture: () => f.imported } } }))
import { DESKTOP_IPC } from '../src/ipc.ts'
import { sendSharedTexture, type SentSharedTextureSettlement } from '../src/shared-texture/transfer.ts'

const frameSend = vi.fn<(channel: string, message: unknown) => void>()
const frame = { send: frameSend } as Partial<Electron.WebFrameMain> as Electron.WebFrameMain
const texture = { handle: { ntHandle: Buffer.alloc(8, 1) }, width: 4, height: 2, pixelFormat: 'bgra' as const }
const settle = vi.fn<(settlement: SentSharedTextureSettlement) => void>()
const send = () => sendSharedTexture(frame, 1, texture, '{"viewId":"view"}', settle)

beforeEach(() => {
  vi.clearAllMocks()
  f.mainReleased = undefined
})

it.each(['renderer', 'Main'] as const)('settles released once after both references are gone, the %s reference last', async (last) => {
  const sent = send()
  expect(frameSend).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.sharedTexture,
    { id: 1, transfer: { transfer: 'transfer-data' }, metadata: '{"viewId":"view"}' })
  sent.imported({ syncToken: 'created' })
  await expect(sent.delivered).resolves.toBeUndefined()
  expect(f.imported.setReleaseSyncToken).toHaveBeenCalledExactlyOnceWith({ syncToken: 'created' })
  if (last === 'renderer') f.mainReleased!()
  else sent.released()
  expect(settle).not.toHaveBeenCalled()
  if (last === 'renderer') sent.released()
  else f.mainReleased!()
  expect(settle).toHaveBeenCalledExactlyOnceWith('released')
  sent.released()
  sent.abandon()
  expect(settle).toHaveBeenCalledOnce()
  expect(f.imported.release).toHaveBeenCalledOnce()
})

it('settles released once Main\'s reference is gone when the renderer refuses the texture without importing it', async () => {
  const sent = send()
  sent.imported({ error: 'Shared textures have no consumer' })
  await expect(sent.delivered).rejects.toThrow('The product renderer could not import the shared texture: Shared textures have no consumer')
  expect(f.imported.release).toHaveBeenCalledOnce()
  expect(f.imported.setReleaseSyncToken).not.toHaveBeenCalled()
  expect(settle).not.toHaveBeenCalled()
  f.mainReleased!()
  expect(settle).toHaveBeenCalledExactlyOnceWith('released')
  // The texture is reusable; a later report or document loss changes nothing.
  sent.released()
  sent.abandon()
  expect(settle).toHaveBeenCalledOnce()
})

it('invalidates a frame whose GPU sync token could not be applied', async () => {
  const sent = send()
  f.imported.setReleaseSyncToken.mockImplementationOnce(() => { throw new Error('GPU lost') })
  sent.imported({ syncToken: 'created' })
  await expect(sent.delivered).rejects.toThrow('GPU lost')
  expect(f.imported.release).toHaveBeenCalledOnce()
  sent.released()
  f.mainReleased!()
  expect(settle).toHaveBeenCalledExactlyOnceWith('invalidated')
})

it('settles invalidated at once when the document goes before the renderer imports, still releasing Main\'s reference', async () => {
  const sent = send()
  const rejection = expect(sent.delivered).rejects.toThrow('The product document closed before importing the shared texture')
  sent.abandon()
  expect(settle).toHaveBeenCalledExactlyOnceWith('invalidated')
  expect(f.imported.release).toHaveBeenCalledOnce()
  expect(f.imported.setReleaseSyncToken).not.toHaveBeenCalled()
  await rejection
  // The renderer's and Electron's later reports, and a second abandon, change nothing.
  sent.imported({ syncToken: 'late' })
  sent.released()
  f.mainReleased!()
  sent.abandon()
  expect(settle).toHaveBeenCalledOnce()
  expect(f.imported.release).toHaveBeenCalledOnce()
  expect(f.imported.setReleaseSyncToken).not.toHaveBeenCalled()
})

it('settles invalidated when the document goes while the renderer still holds the texture', async () => {
  const sent = send()
  sent.imported({ syncToken: 'created' })
  await sent.delivered
  f.mainReleased!()
  sent.abandon()
  expect(settle).toHaveBeenCalledExactlyOnceWith('invalidated')
  sent.released()
  expect(settle).toHaveBeenCalledOnce()
  await expect(sent.delivered).resolves.toBeUndefined()
})

it('returns a texture whose send failed with its delivery rejected, still abandonable until Main\'s reference is gone', async () => {
  frameSend.mockImplementationOnce(() => { throw new Error('Render frame was disposed') })
  const sent = send()
  await expect(sent.delivered).rejects.toThrow('Render frame was disposed')
  expect(f.imported.release).toHaveBeenCalledOnce()
  expect(settle).not.toHaveBeenCalled()
  sent.abandon()
  expect(settle).toHaveBeenCalledExactlyOnceWith('invalidated')
  f.mainReleased!()
  expect(settle).toHaveBeenCalledOnce()
})
