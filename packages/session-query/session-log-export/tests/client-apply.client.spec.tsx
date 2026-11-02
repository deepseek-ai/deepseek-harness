import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionMarkdownCopyToast } from '../src/client/CopyToast.tsx'
import type { SessionMarkdownCopyToastInjected } from '../src/client/CopyToast.tsx'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { SessionLogDownloadHeaderInjected } from '../src/client/HeaderAction.tsx'

const SID = 'session-export-apply' as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

function injectedOf(entry: { inject?: ((...args: never[]) => object) | undefined } | undefined): object {
  if (entry?.inject === undefined) throw new Error('slot entry has no injection')
  return entry.inject()
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, declaration, fiber }
}

describe('session-log-download browser plugin', () => {
  it('follows feedback plugin availability and opens the selected Session form', async () => {
    const b = await bench()
    const entry = b.slots.entries('conversation.session.header.utilities')[0]!
    const injected = injectedOf(entry) as SessionLogDownloadHeaderInjected
    expect(injected.hooks.feedbackAvailable.getSnapshot()).toBe(false)
    injected.openFeedback(SID)

    const openSession = vi.fn()
    const feedback = b.ctx.plugin((ctx) => { ctx.provide('feedbackUi', { openSession }) })
    await feedback.await()
    await vi.waitFor(() => { expect(injected.hooks.feedbackAvailable.getSnapshot()).toBe(true) })
    injected.openFeedback(SID)
    expect(openSession).toHaveBeenCalledWith(SID)

    await feedback.dispose()
    await vi.waitFor(() => { expect(injected.hooks.feedbackAvailable.getSnapshot()).toBe(false) })
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(1)
    await b.fiber.dispose()
  })

  it('provides one controller and removes its Header and overlay contributions on disposal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale'])
    expect(b.ctx.sessionLogDownload).toBeDefined()
    expect(b.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(SessionLogDownloadHeaderAction)
    expect(entry?.options).toMatchObject({ id: 'session-log-download' })
    const injected = injectedOf(entry) as SessionLogDownloadHeaderInjected
    await injected.request(SID)
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    injected.dismiss(SID)
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.open).toBe(false)

    const overlay = b.slots.entries('shell.overlay')[0]
    expect(overlay?.component).toBe(SessionMarkdownCopyToast)
    expect(overlay?.options).toMatchObject({ id: 'session-log-download.copy-toast' })
    const overlayInjected = injectedOf(overlay) as SessionMarkdownCopyToastInjected
    await injected.copyMarkdown(SID)
    expect(injected.hooks.sessionMarkdownCopy.getSnapshot().notice?.kind).toBe('preparationFailed')
    overlayInjected.dismiss()
    expect(injected.hooks.sessionMarkdownCopy.getSnapshot().notice).toBeNull()

    await b.fiber.dispose()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('downloads only for an export execution acknowledged by this browser client', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const first = await bench()
    const second = await bench()

    first.ctx.emit('command/executed', SID, 'plan', { kind: 'success' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'error', text: 'bad path' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'success' })
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledOnce()
      expect(first.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    })
    expect(second.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]).toBeUndefined()

    await first.fiber.dispose()
    await second.fiber.dispose()
  })

  it('re-registers after the declaring Header slot collapses and returns', async () => {
    const b = await bench()
    b.declaration()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    const redeclare = declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('conversation.session.header.utilities')[0]?.component).toBe(SessionLogDownloadHeaderAction)
    expect(b.slots.entries('shell.overlay')[0]?.component).toBe(SessionMarkdownCopyToast)
    redeclare()
    await b.fiber.dispose()
  })
})
