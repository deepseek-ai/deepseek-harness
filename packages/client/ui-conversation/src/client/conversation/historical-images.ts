/** Session-scoped durable image URL cache shared by Conversation targets. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'

interface ImageUrlEntry {
  readonly binding: SessionBinding
  current?: string
  pending: Promise<string>
}

/** Resolve durable Conversation images and release their browser URLs with Session scope. */
export class HistoricalImageCache {
  private readonly entries = new WeakMapWithValues<SessionBinding, Map<string, ImageUrlEntry>>()
  private readonly scopeDisposers = new WeakMapWithValues<SessionBinding, () => void>()
  private readonly urls = new Set<string>()
  private disposed = false

  /**
   * @param ctx - Owning ui-conversation fiber.
   * @param sessions - Session Controller object layer.
   */
  constructor(ctx: Context, private readonly sessions: ISessions) {
    ctx.effect(() => () => { this.dispose() }, 'ui-conversation historical image cache')
  }

  /**
   * Resolve and cache one session-authorized image URL.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference.
   * @returns browser URL valid until the Session binding is released.
   */
  resolve(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('ui-conversation image cache is disposed'))
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) {
      return Promise.reject(new Error(`ui-conversation: unknown session "${sessionId}"`))
    }
    const entries = this.bindScope(binding)
    const key = attachment.attachmentId
    const cached = entries.get(key)
    if (cached !== undefined) return cached.pending
    const entry: ImageUrlEntry = {
      binding,
      pending: Promise.resolve(''),
    }
    entries.set(key, entry)
    entry.pending = this.loadCanonical(key, entry, attachment)
    return entry.pending
  }

  /**
   * Return an already-displayable URL without starting a read.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference.
   * @returns current preview or canonical URL when cached.
   */
  peek(sessionId: SessionId, attachment: ImageAttachmentRef): string | undefined {
    const binding = this.sessions.binding(sessionId)
    return binding === undefined ? undefined : this.entries.get(binding)?.get(attachment.attachmentId)?.current
  }

  /**
   * Adopt a submission preview while fetching the durable admitted bytes.
   * The preview is available synchronously, then replaced and revoked when
   * the canonical attachment read completes.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference the URL temporarily displays.
   * @param url - browser URL to adopt.
   * @returns whether the cache took ownership.
   */
  seed(sessionId: SessionId, attachment: ImageAttachmentRef, url: string): boolean {
    if (this.disposed) return false
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return false
    const entries = this.bindScope(binding)
    const key = attachment.attachmentId
    if (entries.has(key)) return false
    const entry: ImageUrlEntry = {
      binding,
      current: url,
      pending: Promise.resolve(url),
    }
    this.urls.add(url)
    entries.set(key, entry)
    entry.pending = this.loadCanonical(key, entry, attachment).catch((error: unknown) => {
      if (entries.get(key) === entry && entry.current === url) {
        entries.delete(key)
        this.releaseUrl(url)
      }
      throw error
    })
    // Seed begins the durable read before a transcript image necessarily
    // mounts. Keep that legitimate no-consumer path from becoming an
    // unhandled rejection; resolve() still returns the rejecting promise.
    void entry.pending.catch(() => {})
    return true
  }

  private loadCanonical(
    key: string,
    entry: ImageUrlEntry,
    attachment: ImageAttachmentRef,
  ): Promise<string> {
    return entry.binding.session.readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        this.assertLive(key, entry)
        let url: string
        if (typeof URL.createObjectURL !== 'function') {
          url = `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        } else {
          const bytes = Uint8Array.from(result.value.data)
          url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
        }
        this.assertLive(key, entry)
        this.urls.add(url)
        const previous = entry.current
        entry.current = url
        if (previous !== undefined && previous !== url) this.releaseUrl(previous)
        return url
      })
      .catch((error: unknown) => {
        const entries = this.entries.get(entry.binding)
        if (entries?.get(key) === entry && entry.current === undefined) entries.delete(key)
        throw error
      })
  }

  private assertLive(key: string, entry: ImageUrlEntry): void {
    if (this.disposed) throw new Error('ui-conversation image cache was disposed before loading completed')
    if (this.entries.get(entry.binding)?.get(key) !== entry) {
      throw new Error('ui-conversation image scope was released before loading completed')
    }
  }

  private bindScope(binding: SessionBinding): Map<string, ImageUrlEntry> {
    const existing = this.entries.get(binding)
    if (existing !== undefined) return existing
    const entries = new Map<string, ImageUrlEntry>()
    this.entries.set(binding, entries)
    const dispose = binding.ctx.effect(() => () => {
      this.scopeDisposers.delete(binding)
      this.release(binding, entries)
    }, 'ui-conversation historical image scope')
    const release = (): void => { void dispose() }
    this.scopeDisposers.set(binding, release)
    return entries
  }

  private release(binding: SessionBinding, entries: Map<string, ImageUrlEntry>): void {
    if (this.entries.get(binding) === entries) this.entries.delete(binding)
    for (const entry of entries.values()) {
      if (entry.current !== undefined) this.releaseUrl(entry.current)
    }
    entries.clear()
  }

  private releaseUrl(url: string): void {
    if (!this.urls.delete(url)) return
    revokeUrl(url)
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of [...this.scopeDisposers.values]) dispose()
    this.scopeDisposers.clear()
    for (const url of this.urls) revokeUrl(url)
    this.urls.clear()
    for (const entries of this.entries.values) entries.clear()
    this.entries.clear()
  }
}

function revokeUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
