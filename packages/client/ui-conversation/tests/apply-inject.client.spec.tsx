// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import {
  apply, inject, type ComposerBarInjected, type ConversationInjected,
  type ConversationSessionHeaderInjected, type ConversationSessionInjected, type ViewTab,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createConversationStore } from '../src/client/stores.ts'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'

usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId

type ConversationInstance = ReturnType<ReturnType<typeof createConversationStore>['create']>
type ConversationActions = ConversationInstance['actions']

function sessionFakeFor() {
  return {
    loadOlder: vi.fn<ISession['loadOlder']>(() => Promise.resolve()),
    prompt: vi.fn<ISession['prompt']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
  } satisfies SessionBehaviorOverrides
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const connectWorkspace = vi.fn(async () => ROOT)
  runtime.ctx.provide('uiWorkspace', { connectWorkspace } as never)
  const sessionFake = sessionFakeFor()
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session: sessionFake,
  }, { current: false })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'conversation': { kind: 'single', scope: 'session-maybe' },
  }, (_props: { renderSlot?: unknown }) => null)

  const feature = await runtime.mount({ inject: [...inject], apply })
  runtime.renderRoot()
  const entryOf = (key: 'conversation' | 'conversation.session' | 'conversation.session.header' | 'conversation.composer.bar') =>
    runtime.slots.entries(key)[0]!
  const conversationApi = (id: SessionId) => {
    const entry = entryOf('conversation.session')
    const instance = runtime.storeOf('conversation.session', id) as ConversationInstance
    const injected = (entry.inject as unknown as (
      sessionId: SessionId,
      actions: ConversationActions,
    ) => ConversationSessionInjected)(id, instance.actions)
    return { instance, injected }
  }
  const residentApi = (id: SessionId | undefined) => {
    const entry = entryOf('conversation')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ConversationInjected)(id)
  }
  const headerApi = (id: SessionId) => {
    const entry = entryOf('conversation.session.header')
    const instance = runtime.storeOf('conversation.session.header', id) as ConversationInstance
    const injected = (entry.inject as unknown as (
      sessionId: SessionId,
      actions: ConversationActions,
    ) => ConversationSessionHeaderInjected)(id, instance.actions)
    return { instance, injected }
  }
  const composerApi = (id: SessionId | undefined) => {
    const entry = entryOf('conversation.composer.bar')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ComposerBarInjected)(id)
  }
  const inputApi = (id: SessionId) => {
    const input = runtime.ctx.conversation.input.for(runtime.sessions.scope(id)!)
    return { state: input.state, actions: input }
  }
  const viewSource = (id: SessionId): ObservableSnapshot<readonly ViewTab[]> =>
    conversationApi(id).injected.hooks.conversationViews
  return {
    runtime, feature, slots: runtime.slots, entryOf, conversationApi, headerApi, residentApi, composerApi,
    inputApi, viewSource, sessionFake, connectWorkspace,
  }
}

describe('Conversation inject API', () => {
  it('assembles the target-neutral read face without Session side effects', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    expect(b.sessionFake.loadOlder).not.toHaveBeenCalled()
    expect(Object.keys(injected)).toEqual(['hooks', 'bindDraftMirror', 'openView'])
    expect(b.viewSource(ROOT).getSnapshot()).toEqual([])
    await b.runtime.dispose()
  })

  it('activates a target before committing an explicit View selection', async () => {
    const b = await bench()
    const binding = b.runtime.ctx.uiConversation.binding(ROOT)
    const activate = vi.spyOn(binding, 'activate')
    const removeChat = b.slots.register(
      { name: 'conversation.view', id: 'chat', order: 0 },
      (() => null) as never,
    )
    const removeTrajectory = b.slots.register(
      { name: 'conversation.view', id: 'trajectory', order: 10 },
      (() => null) as never,
    )
    await Promise.resolve()
    activate.mockClear()

    const body = b.conversationApi(ROOT)
    body.injected.openView('trajectory', 'call-1')
    expect(activate).toHaveBeenLastCalledWith('trajectory')
    expect(body.instance.store.getSnapshot()).toMatchObject({
      view: 'trajectory',
      viewRequest: { view: 'trajectory', focus: 'call-1' },
    })

    const header = b.headerApi(ROOT)
    header.injected.selectView('chat')
    expect(activate).toHaveBeenLastCalledWith('chat')
    expect(header.instance.store.getSnapshot().view).toBe('chat')

    removeTrajectory()
    removeChat()
    await b.runtime.dispose()
  })

  it('restores the selected View when a cached Session becomes current', async () => {
    const b = await bench()
    const binding = b.runtime.ctx.uiConversation.binding(ROOT)
    const activate = vi.spyOn(binding, 'activate')
    const removeChat = b.slots.register(
      { name: 'conversation.view', id: 'chat', order: 0 },
      (() => null) as never,
    )
    let removeCustom: (() => void) | undefined
    try {
      await b.runtime.flush()
      localStorage.setItem(`dsh.conversation.${ROOT}`, JSON.stringify({
        draft: '', view: 'custom', viewRequest: null,
      }))

      b.runtime.ctx.uiSession.adapter.resolve(ROOT)
      expect(activate).toHaveBeenLastCalledWith('chat')
      activate.mockClear()

      removeCustom = b.slots.register(
        { name: 'conversation.view', id: 'custom', order: 10 },
        (() => null) as never,
      )
      await b.runtime.flush()
      expect(activate).not.toHaveBeenCalled()

      await b.runtime.sessions.setCurrent(ROOT)
      expect(activate).toHaveBeenLastCalledWith('custom')
    } finally {
      removeCustom?.()
      removeChat()
      await b.runtime.dispose()
    }
  })

  it('submits through the provided input machine and mirrors accepted draft edits', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('   ')
    actions.submit()
    expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    expect(state.getSnapshot().draft).toBe('   ')

    actions.setDraft('hello')
    actions.submit()
    // Optimistic commit clears the draft at enter; the prompt lands after the
    // paint-yield inside the send pipeline.
    expect(state.getSnapshot().draft).toBe('')
    await vi.waitFor(() => {
      expect(b.sessionFake.prompt).toHaveBeenCalledWith(
        [{ type: 'text', text: 'hello' }], 'queue', expect.any(AbortSignal), expect.any(String),
      )
    })

    b.sessionFake.prompt.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }),
    })
    actions.setDraft('retry me')
    actions.submit()
    await vi.waitFor(() => { expect(b.sessionFake.prompt).toHaveBeenCalledTimes(2) })
    await Promise.resolve()
    expect(state.getSnapshot().draft).toBe('retry me')

    const mirrored: string[] = []
    const unbind = injected.bindDraftMirror(text => mirrored.push(text))
    actions.setDraft('mirrored text')
    expect(mirrored).toEqual(['mirrored text'])
    unbind()
    expect(b.inputApi(ROOT).state).toBe(state)

    b.sessionFake.cancel.mockResolvedValueOnce({
      ok: false, error: new RemoteError('gateway/internal', 'stop failed', {}),
    })
    b.composerApi(ROOT).stop!()
    await vi.waitFor(() => { expect(b.sessionFake.cancel).toHaveBeenCalledOnce() })
    await b.runtime.dispose()
  })

  it('fails loud for an unknown binding or an unloaded scoped service', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation.composer.bar')
    const injectBar = entry.inject as unknown as (
      sessionId: SessionId | undefined,
    ) => ComposerBarInjected
    expect(() => { injectBar('ghost' as SessionId).stop!() }).toThrow(/resolved no binding/)

    const absent = injectBar(undefined)
    expect(absent.keyboard).toBeUndefined()
    expect(absent.toggleCommandMenu).toBeUndefined()
    expect(absent.stop).toBeUndefined()
    expect(absent.hooks.notices.getSnapshot()).toBeNull()
    expect(absent.hooks.lexicon.getSnapshot().size).toBe(0)
    expect(absent.hooks.menuLauncher.getSnapshot()).toBeNull()

    const stop = injectBar(ROOT).stop!
    await b.feature.dispose()
    expect(() => { stop() }).toThrow(/unavailable through the session scope/)
    await b.runtime.dispose()
  })

  it('moves a draft only when Workspace navigation changes Session', async () => {
    const b = await bench()
    const resident = b.residentApi(ROOT)
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('carry me')

    b.connectWorkspace.mockResolvedValueOnce(ROOT)
    await resident.selectWorkspace('workspace-1' as WorkspaceId)
    expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [ROOT] })
    expect(state.getSnapshot().draft).toBe('carry me')

    const other = 'other-1' as SessionId
    await b.runtime.sessions.add({ id: other }, { current: false })
    b.connectWorkspace.mockResolvedValueOnce(other)
    await resident.selectWorkspace('workspace-2' as WorkspaceId)
    expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [other] })
    expect(state.getSnapshot().draft).toBe('')
    expect(b.inputApi(other).state.getSnapshot().draft).toBe('carry me')
    await b.runtime.dispose()
  })

  it('supports no-Session navigation and propagates Workspace connection failure', async () => {
    const b = await bench()
    b.connectWorkspace.mockResolvedValueOnce(ROOT)
    await b.residentApi(undefined).selectWorkspace('workspace-0' as WorkspaceId)
    expect(b.runtime.sessions.calls).toContainEqual({ method: 'open', args: [ROOT] })

    const opens = b.runtime.sessions.calls.filter(call => call.method === 'open').length
    b.connectWorkspace.mockRejectedValueOnce(new Error('offline'))
    await expect(b.residentApi(ROOT).selectWorkspace('workspace-4' as WorkspaceId))
      .rejects.toThrow('offline')
    expect(b.runtime.sessions.calls.filter(call => call.method === 'open')).toHaveLength(opens)
    await b.runtime.dispose()
  })

  it('projects the dynamic View registration ledger', async () => {
    const b = await bench()
    const source = b.viewSource(ROOT)
    const before = source.getSnapshot()
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    const removeNamed = b.slots.register(
      { name: 'conversation.view', id: 'trajectory', order: 5, label: 'Trajectory' },
      (() => null) as never,
    )
    await vi.waitFor(() => {
      expect(source.getSnapshot()).toEqual([{ id: 'trajectory', label: 'Trajectory' }])
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).not.toBe(before)

    const removeBare = b.slots.register(
      { name: 'conversation.view', id: 'bare', order: 6 },
      (() => null) as never,
    )
    await vi.waitFor(() => {
      expect(source.getSnapshot().map(view => view.label)).toEqual(['Trajectory', 'bare'])
    })
    removeNamed()
    removeBare()
    unsubscribe()
    await b.runtime.dispose()
  })
})
