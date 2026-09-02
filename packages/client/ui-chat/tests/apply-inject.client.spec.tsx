// @vitest-environment jsdom
/** Chat inject factories exercised over independently mounted Conversation and Chat plugins. */
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  RemoteError, SlotTestRuntime, TestRemote, stubSettingsScope, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import {
  apply as applyConversation, inject as injectConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  apply as applyChat, inject as injectChat, type ChatViewInjected, type DetailsInjected,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { createChatStore } from '../src/client/stores.ts'

usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId
const ATTACHMENT = {
  attachmentId: AttachmentId('image-1'),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
} as const

type ChatInstance = ReturnType<ReturnType<typeof createChatStore>['create']>
type ChatActions = ChatInstance['actions']

function sessionFakeFor() {
  return {
    loadOlder: vi.fn<ISession['loadOlder']>(() => Promise.resolve()),
    loadThrough: vi.fn<ISession['loadThrough']>(() => Promise.resolve()),
    readAttachment: vi.fn<ISession['readAttachment']>(() => Promise.resolve({
      ok: true,
      value: { attachment: ATTACHMENT, data: Uint8Array.of(1) },
    })),
    prompt: vi.fn<ISession['prompt']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
  } satisfies SessionBehaviorOverrides
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
  runtime.ctx.provide('layout', layout as never)
  const openWorkspacePath = vi.fn<ClientRemote['session']['openWorkspacePath']>(
    () => Promise.resolve({ ok: true, value: { opened: true } }),
  )
  new TestRemote(runtime.ctx, { session: { openWorkspacePath } })
  runtime.ctx.provide('uiWorkspace', {
    connectWorkspace: vi.fn(async () => ROOT),
  } as never)
  const session = sessionFakeFor()
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session,
  }, { current: false })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
    'details': { kind: 'single', scope: 'session' },
  }, (_props: { renderSlot?: unknown }) => null)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  runtime.renderRoot()

  const chatViewApi = (id: SessionId) => {
    const entry = runtime.slots.entries('conversation.view')[0]!
    const instance = runtime.storeOf('conversation.view', id) as ChatInstance
    const injected = (entry.inject as unknown as (
      sessionId: SessionId,
      actions: ChatActions,
    ) => ChatViewInjected)(id, instance.actions)
    return { instance, injected }
  }
  return { runtime, layout, openWorkspacePath, session, chatViewApi }
}

describe('Chat inject API', () => {
  it('loads older history and forks through the Session Controller', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(ROOT)
    injected.loadOlder()
    expect(b.session.loadOlder).toHaveBeenCalledOnce()

    void injected.loadThrough(SessionSeq(42))
    expect(b.session.loadThrough).toHaveBeenCalledWith(42)

    injected.forkAt(17)
    await vi.waitFor(() => {
      expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [ROOT] })
    })
    expect(b.runtime.sessions.calls).toContainEqual({
      method: 'fork', args: [{ sessionId: ROOT, atSeq: 17, increaseTitle: true }],
    })

    const fork = vi.spyOn(b.runtime.sessions, 'fork').mockRejectedValueOnce(new Error('fork failed'))
    injected.forkAt(18)
    await vi.waitFor(() => {
      expect(fork).toHaveBeenCalledWith({ sessionId: ROOT, atSeq: 18, increaseTitle: true })
    })
    await b.runtime.dispose()
  })

  it('writes Chat selection before opening details', async () => {
    const b = await bench()
    const { instance, injected } = b.chatViewApi(ROOT)
    injected.openDetails({ turnSeq: 2, callId: 'c1' })
    expect(instance.store.getSnapshot().selection).toEqual({ turnSeq: 2, callId: 'c1' })
    expect(b.layout.openDetails).toHaveBeenCalledOnce()
    expect(b.runtime.storeOf('details', ROOT)).toBe(instance)
    expect(b.runtime.storeOf('conversation.session', ROOT)).not.toBe(instance)
    await b.runtime.dispose()
  })

  it('resolves file paths against the Session cwd and preserves failures', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(ROOT)
    await injected.openFile('src/a.ts')
    expect(b.openWorkspacePath).toHaveBeenCalledWith({ path: '/proj/src/a.ts' })

    b.openWorkspacePath.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'xdg-open is not available', {}),
    })
    await expect(injected.openFile('src/b.ts')).rejects.toThrow('path open failed: xdg-open is not available')
    await b.runtime.dispose()
  })

  it('fails loud when a Chat View inject resolves no Session', async () => {
    const b = await bench()
    const entry = b.runtime.slots.entries('conversation.view')[0]!
    const injectView = entry.inject as unknown as (
      sessionId: SessionId,
      actions: ChatActions,
    ) => ChatViewInjected
    expect(() => injectView('never-listed' as SessionId, {} as ChatActions))
      .toThrow(/unknown session/)
    await b.runtime.dispose()
  })

  it('closes details while sharing selection through the Chat store', async () => {
    const b = await bench()
    const entry = b.runtime.slots.entries('details')[0]!
    const injected = (entry.inject as unknown as () => DetailsInjected)()
    expect(Object.keys(injected)).toEqual(['closeDetails'])
    injected.closeDetails()
    expect(b.layout.closeDetails).toHaveBeenCalledOnce()
    expect(b.runtime.storeOf('details', ROOT)).toBe(b.runtime.storeOf('conversation.view', ROOT))
    await b.runtime.dispose()
  })

  it('owns image loading, scroll memory, and optional closing-file mentions', async () => {
    const b = await bench()
    const { injected } = b.chatViewApi(ROOT)
    const owner = {} as never

    expect(injected.fileMentions(owner)).toBeUndefined()
    const mentions = { resolve: vi.fn() } as never
    const forClosing = vi.fn(() => mentions)
    b.runtime.ctx.provide('chatFileMentions', { forClosing } as never)
    expect(injected.fileMentions(owner)).toBe(mentions)
    expect(forClosing).toHaveBeenCalledWith(owner)

    expect(injected.chatScroll.read()).toBeNull()
    const position = { anchorKey: 'node-1', anchorTop: 4, scrollTop: 12 }
    injected.chatScroll.save(position)
    expect(injected.chatScroll.read()).toEqual(position)
    injected.chatScroll.save(null)
    expect(injected.chatScroll.read()).toBeNull()

    const loaded = await injected.loadImage(ATTACHMENT)
    expect(loaded).toEqual(expect.any(String))
    expect(b.session.readAttachment).toHaveBeenCalledWith(ATTACHMENT.attachmentId)
    expect(injected.loadImage.peek?.(ATTACHMENT)).toBe(loaded)
    await b.runtime.dispose()
  })
})
