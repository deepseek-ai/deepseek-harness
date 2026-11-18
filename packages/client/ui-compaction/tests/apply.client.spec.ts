/**
 * The plugin's registrations with recorded copy, content-preview service, and
 * Session Remote face: the dictionaries, the `compactionPreviews` service with
 * localized block labels, title, and failure lines while the optional
 * `contentPreviews` service is present, cancellation of reads that outlive that
 * service, and the removal of every registration when the plugin goes.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEventsPage } from '@deepseek-ai/dsh-api-session-controller/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const page: SessionEventsPage = {
  cursor: 7,
  hasMore: false,
  records: [{
    type: 'event',
    event: {
      type: 'user/message', seq: 7, time: 1,
      data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'Summary' }, { type: 'image' }] },
    },
  }],
}

async function boot(options: { realLocale?: boolean; withPreviews?: boolean } = {}) {
  const ctx = new Context()
  const resources = new ResourceRegistry(ctx)
  const dictionaries = new Map<string, unknown>()
  const locale = options.realLocale === true ? new LocaleRuntime(ctx) : {
    bind: vi.fn((ns: string) => (key: string) => `${ns}:${key}`),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const contentPreviews = { open: vi.fn<Context['contentPreviews']['open']>() }
  const events = vi.fn(async () => ({ ok: true as const, value: page }))
  ctx.provide('resources', resources)
  ctx.provide('locale', locale as never)
  const providePreviews = (): () => void => ctx.provide('contentPreviews', contentPreviews as never)
  if (options.withPreviews !== false) providePreviews()
  ctx.provide('remote', { session: { events } } as never)
  ctx.provide('remote.session', { events } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  return { ctx, resources, dictionaries, contentPreviews, events, fiber, providePreviews }
}

const sessionId = brandString<SessionId>('session-1')
const session = { kind: 'session' as const, sessionId }

describe('ui-compaction direct previews', () => {
  it('reads a checkpoint and passes localized Markdown directly to the preview', async () => {
    const h = await boot()
    const preview = h.ctx.get('compactionPreviews')!
    expect(await preview.open(sessionId, session, 7, new AbortController().signal)).toBeNull()
    expect(h.contentPreviews.open).toHaveBeenCalledWith({ mediaType: 'text/markdown', text: 'Summary\n\n*[compaction:block.image]*' }, { title: 'compaction:preview.title', key: 'compaction:session-1:7' })
    expect(h.dictionaries.has('compaction')).toBe(true)
    await h.fiber.dispose()
    expect(h.ctx.get('compactionPreviews')).toBeUndefined()
    expect(h.dictionaries.size).toBe(0)
  })

  it('follows the optional preview service lifetime', async () => {
    const h = await boot({ withPreviews: false })
    expect(h.ctx.get('compactionPreviews')).toBeUndefined()
    const withdraw = h.providePreviews()
    await vi.waitFor(() => { expect(h.ctx.get('compactionPreviews')).toBeDefined() })
    withdraw()
    await vi.waitFor(() => { expect(h.ctx.get('compactionPreviews')).toBeUndefined() })
  })

  it('does not open content after cancellation', async () => {
    const h = await boot()
    const controller = new AbortController()
    controller.abort()
    expect(await h.ctx.get('compactionPreviews')!.open(sessionId, session, 7, controller.signal)).toBeNull()
    expect(h.contentPreviews.open).not.toHaveBeenCalled()
  })

  it('does not open a completed read after the plugin is disposed', async () => {
    const h = await boot()
    const result = Promise.withResolvers<{ ok: true; value: SessionEventsPage }>()
    h.events.mockImplementationOnce(() => result.promise)
    const pending = h.ctx.get('compactionPreviews')!.open(sessionId, session, 7, new AbortController().signal)
    await h.fiber.dispose()
    result.resolve({ ok: true, value: page })
    expect(await pending).toBeNull()
    expect(h.contentPreviews.open).not.toHaveBeenCalled()
  })

  it('cancels a pending read when the preview service is withdrawn, even after a new provider arrives', async () => {
    const h = await boot({ withPreviews: false })
    const withdraw = h.providePreviews()
    await vi.waitFor(() => { expect(h.ctx.get('compactionPreviews')).toBeDefined() })
    const result = Promise.withResolvers<{ ok: true; value: SessionEventsPage }>()
    let transport: AbortSignal | undefined
    h.events.mockImplementationOnce(((_request: unknown, signal: AbortSignal) => {
      transport = signal
      return result.promise
    }) as never)
    const caller = new AbortController()
    const pending = h.ctx.get('compactionPreviews')!.open(sessionId, session, 7, caller.signal)
    withdraw()
    await vi.waitFor(() => { expect(h.ctx.get('compactionPreviews')).toBeUndefined() })
    expect(transport?.aborted).toBe(true)
    const replacement = { open: vi.fn<Context['contentPreviews']['open']>() }
    const withdrawReplacement = h.ctx.provide('contentPreviews', replacement as never)
    onTestFinished(() => { withdrawReplacement() })
    await vi.waitFor(() => { expect(h.ctx.get('compactionPreviews')).toBeDefined() })
    result.resolve({ ok: true, value: page })
    expect(await pending).toBeNull()
    expect(caller.signal.aborted).toBe(false)
    expect(h.contentPreviews.open).not.toHaveBeenCalled()
    expect(replacement.open).not.toHaveBeenCalled()
    expect(await h.ctx.get('compactionPreviews')!.open(sessionId, session, 7, caller.signal)).toBeNull()
    expect(replacement.open).toHaveBeenCalledOnce()
  })

  it('reports unavailable checkpoints and read failures to the caller', async () => {
    const h = await boot()
    const previews = h.ctx.get('compactionPreviews')!
    const open = previews.open.bind(previews)
    h.events.mockResolvedValueOnce({ ok: true, value: { ...page, records: [] } })
    expect(await open(sessionId, session, 7, new AbortController().signal)).toBe('compaction:preview.notFound')
    h.events.mockRejectedValueOnce(new Error('connection closed'))
    expect(await open(sessionId, session, 7, new AbortController().signal)).toBe('compaction:preview.readFailed')
    expect(h.contentPreviews.open).not.toHaveBeenCalled()
  })

  it('has an empty node half', () => { expect(() => { nodeApply() }).not.toThrow() })
})
