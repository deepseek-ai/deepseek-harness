// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { HistoricalImageCache } from '../src/client/conversation/historical-images.ts'

describe('HistoricalImageCache', () => {
  it('invalidates a pending image load when its Session binding is released', async () => {
    const read = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
    const runtime = await SlotTestRuntime.create()
    const sessionId = await runtime.sessions.add({
      id: 's1',
      session: { readAttachment: () => read.promise },
    })
    const reference = runtime.sessions.retain(sessionId)
    await reference.ready
    const cache = new HistoricalImageCache(runtime.ctx, runtime.ctx.sessions)
    const attachment = {
      attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as const

    const pending = cache.resolve(sessionId, attachment)
    reference.release()
    await runtime.flush()
    read.resolve({ ok: true, value: { attachment, data: Uint8Array.of(1) } })

    await expect(pending).rejects.toThrow('ui-conversation image scope was released before loading completed')
    await runtime.dispose()
  })

  it('shows a seeded URL synchronously, replaces it with canonical bytes, and revokes both', async () => {
    const revoked: string[] = []
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:canonical')
    const originalRevoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url: string) => { revoked.push(url) }
    try {
      const read = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
      const runtime = await SlotTestRuntime.create()
      const sessionId = await runtime.sessions.add({ id: 's1', session: { readAttachment: () => read.promise } })
      const reference = runtime.sessions.retain(sessionId)
      await reference.ready
      const cache = new HistoricalImageCache(runtime.ctx, runtime.ctx.sessions)
      const attachment = {
        attachmentId: AttachmentId('image-seeded'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } as const

      expect(cache.seed(sessionId, attachment, 'blob:seeded')).toBe(true)
      expect(cache.peek(sessionId, attachment)).toBe('blob:seeded')
      expect(cache.seed(sessionId, attachment, 'blob:duplicate')).toBe(false)
      const canonical = cache.resolve(sessionId, attachment)
      read.resolve({ ok: true, value: { attachment, data: Uint8Array.of(1) } })
      await expect(canonical).resolves.toBe('blob:canonical')
      expect(cache.peek(sessionId, attachment)).toBe('blob:canonical')
      expect(revoked).toContain('blob:seeded')

      reference.release()
      await runtime.flush()
      expect(revoked).toContain('blob:canonical')
      await runtime.dispose()
    } finally {
      created.mockRestore()
      URL.revokeObjectURL = originalRevoke
    }
  })

  it('revokes a seeded preview when canonical bytes cannot be read', async () => {
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const runtime = await SlotTestRuntime.create()
      const sessionId = await runtime.sessions.add({
        id: 's1',
        session: {
          readAttachment: () => Promise.resolve({
            ok: false,
            error: new RemoteError('session/attachment-invalid', 'missing', { reason: 'missing' }),
          } as never),
        },
      })
      const reference = runtime.sessions.retain(sessionId)
      await reference.ready
      const cache = new HistoricalImageCache(runtime.ctx, runtime.ctx.sessions)
      const attachment = {
        attachmentId: AttachmentId('image-missing'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } as const

      expect(cache.seed(sessionId, attachment, 'blob:seeded')).toBe(true)
      await expect(cache.resolve(sessionId, attachment)).rejects.toThrow('attachment-invalid: missing')
      expect(cache.peek(sessionId, attachment)).toBeUndefined()
      expect(revoked).toHaveBeenCalledWith('blob:seeded')
      reference.release()
      await runtime.dispose()
    } finally {
      revoked.mockRestore()
    }
  })

  it('refuses to seed for an unknown session', async () => {
    const runtime = await SlotTestRuntime.create()
    const cache = new HistoricalImageCache(runtime.ctx, runtime.ctx.sessions)
    const attachment = {
      attachmentId: AttachmentId('image-unknown'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as const
    expect(cache.seed('missing' as never, attachment, 'blob:orphan')).toBe(false)
    await runtime.dispose()
  })
})
