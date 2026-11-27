// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EMPTY_CHAT_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-chat/client'
import { EMPTY_CONVERSATION_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  allowAllAccess,
  bindSnapshotSelector,
  chatSnapshot,
  conversationSnapshot,
  responsiveHooks,
  SlotTestRuntime,
  usePinnedBrowserLanguages,
} from '../src/index.ts'

const originalLanguages = [...navigator.languages]
const originalLanguage = navigator.language

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'trt.panel-info': { kind: 'keyed'; scope: 'root'; owner: { label: string } }
  }
}

usePinnedBrowserLanguages('zh-CN', 'en-US')
afterEach(cleanup)
afterAll(() => {
  expect(navigator.languages).toEqual(originalLanguages)
  expect(navigator.language).toBe(originalLanguage)
})

function entry(seq: number): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      type: 'fixture/event',
      seq,
      time: seq,
      data: { seq },
      ignorable: true,
    } as unknown as SessionLiveEventEntry['event'],
  }
}

describe('fixture helpers', () => {
  it('allows every action on every resource through the hand-built access Hooks', () => {
    expect(allowAllAccess.useRemoteAccess('session/list')).toBe(true)
    expect(allowAllAccess.useAccess('session/fork')).toBe(true)
    expect(allowAllAccess.useSessionAccess('s1' as SessionId, 'session/fork')).toBe(true)
    expect(allowAllAccess.useWorkspaceAccess('w1' as WorkspaceId, 'workspace/follow')).toBe(true)
  })

  it('installs an allow-all remoteAccess service whose sources never change', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const source = runtime.ctx.remoteAccess.source('session', 's1', 'session/fork')
      expect(source.getSnapshot()).toBe(true)
      const unsubscribe = source.subscribe(() => {})
      unsubscribe()
      expect(source.getSnapshot()).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  it('retracts default root sources without removing their live replacements', async () => {
    const runtime = await SlotTestRuntime.create()
    const hooks = { workspaces: runtime.workspaces.list, panelInfo: runtime.panelInfo, theme: runtime.theme }
    const props = responsiveHooks()
    let releaseReplacement: (() => void) | undefined
    try {
      expect(runtime.ctx.get('uiResponsive')).toBeDefined()
      runtime.releaseWorkspaceSource()
      runtime.releasePanelInfoSource()
      runtime.releaseThemeSource()
      await runtime.releaseResponsiveSource()
      expect(runtime.ctx.get('uiResponsive')).toBeUndefined()
      releaseReplacement = runtime.slots.provideRoot({ hooks, props: { useMediaQuery: props.useMediaQuery, useMobile: props.useMobile } })
      runtime.releaseWorkspaceSource()
      runtime.releasePanelInfoSource()
      runtime.releaseThemeSource()
      await runtime.releaseResponsiveSource()
      for (const key of ['workspaces', 'panelInfo', 'theme'] as const) {
        expect(() => runtime.slots.provideRoot({ hooks: { [key]: hooks[key] } }))
          .toThrow(`duplicate root standard hook '${key}'`)
      }
      for (const key of ['useMediaQuery', 'useMobile', 'useDocumentPortal', 'useDocumentViewport'] as const) {
        expect(() => runtime.slots.provideRoot({ props: { [key]: props[key] } }))
          .toThrow(`duplicate root standard prop '${key}'`)
      }
    } finally {
      try {
        releaseReplacement?.()
        runtime.releaseWorkspaceSource()
        runtime.releasePanelInfoSource()
        runtime.releaseThemeSource()
        await runtime.releaseResponsiveSource()
      } finally {
        await runtime.dispose()
      }
    }
  })

  it('drives panel hooks, retains keyed selection on owner updates, and releases the default source', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      await runtime.declare({ 'trt.panel-info': { kind: 'keyed', scope: 'root' } })
      runtime.slots.register({ name: 'trt.panel-info', key: 'probe' },
        ({ usePanelInfo, label }: PropsRuntime<'trt.panel-info'>) => (
          <span>{label}:{usePanelInfo(info => info.activePanelId) ?? 'conversation'}</span>
        ))
      const view = runtime.renderSlot('trt.panel-info', { label: 'first' }, { entryKey: 'probe' })
      expect(view.container.textContent).toBe('first:conversation')
      act(() => { runtime.panelInfo.set({ activePanelId: 'custom' as MainPanelId }) })
      expect(view.container.textContent).toBe('first:custom')
      view.update({ label: 'next' })
      expect(view.container.textContent).toBe('next:custom')
      const replacement = createSnapshotStore<PanelInfo>({ activePanelId: null })
      await act(async () => {
        await runtime.mount({
          inject: ['slots'],
          // Release and replace in one step: a render between them would find no usePanelInfo.
          apply(ctx) {
            runtime.releasePanelInfoSource()
            ctx.slots.provideRoot({ hooks: { panelInfo: replacement } })
          },
        })
      })
      expect(view.container.textContent).toBe('next:conversation')
    } finally {
      await runtime.dispose()
    }
  })

  it('supplies fixed, replaceable answers for hand-built responsive props', () => {
    const defaults = responsiveHooks()
    expect(defaults.useMediaQuery('(max-width: 640px)')).toBe(false)
    expect(defaults.useMobile()).toBe(false)
    expect(defaults.useDocumentPortal()).toBe(defaults.useDocumentPortal())
    expect(defaults.useDocumentViewport()).toBe(defaults.useDocumentViewport())
    const portal = () => <aside />
    const viewport = { width: 390, height: 844 }
    const fixed = responsiveHooks({ mobile: true, matches: query => query === '(hover: none)', portal, viewport })
    expect(fixed.useMobile()).toBe(true)
    expect(fixed.useMediaQuery('(hover: none)')).toBe(true)
    expect(fixed.useMediaQuery('(max-width: 640px)')).toBe(false)
    expect(fixed.useDocumentPortal()).toBe(portal)
    expect(fixed.useDocumentViewport()).toBe(viewport)
  })

  it('keeps the document props available without the responsive service', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      await runtime.releaseResponsiveSource()
      await runtime.declare({ 'trt.panel-info': { kind: 'keyed', scope: 'root' } })
      runtime.slots.register({ name: 'trt.panel-info', key: 'document' },
        ({ useDocumentPortal, useDocumentViewport }: PropsRuntime<'trt.panel-info'>) => {
          const Portal = useDocumentPortal()
          const { width, height } = useDocumentViewport()
          return <Portal><span>{width}×{height}</span></Portal>
        })
      const view = runtime.renderSlot('trt.panel-info', { label: 'document' }, { entryKey: 'document' })
      expect(view.container.textContent).toBe('1024×768')
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects uploads and reading marks until a suite replaces their default stubs', async () => {
    const runtime = await SlotTestRuntime.create()
    expect(runtime.ctx.uiSession.sessionStatus.readingReady.getSnapshot()).toBe(true)
    await expect(runtime.fileUpload.upload('fixture-session' as SessionId)).rejects.toThrow('file upload is not stubbed')
    await expect(runtime.ctx.uiSession.sessionStatus.mark('fixture-session' as SessionId, true)).rejects.toThrow('reading mark is not stubbed')
    await expect(runtime.fileUpload.uploadImage('fixture-session' as SessionId)).rejects.toThrow('image upload is not stubbed')
    await runtime.dispose()
  })

  it('builds independent Conversation and Chat snapshots with optional overrides', () => {
    const conversation = conversationSnapshot()
    expect(conversation).toEqual(EMPTY_CONVERSATION_SNAPSHOT)
    expect(conversation).not.toBe(EMPTY_CONVERSATION_SNAPSHOT)
    const activeTargets = new Set(['chat'])
    expect(conversationSnapshot({ activeTargets }).activeTargets).toBe(activeTargets)

    const chat = chatSnapshot()
    expect(chat).toEqual(EMPTY_CHAT_SNAPSHOT)
    expect(chat).not.toBe(EMPTY_CHAT_SNAPSHOT)
    const order = ['node-1']
    expect(chatSnapshot({ order }).order).toBe(order)
  })

  it('binds an observable snapshot through the production selector hook', () => {
    const source = createSnapshotStore({ value: 1 })
    const useValue = bindSnapshotSelector(source)
    const view = renderHook(() => useValue(snapshot => snapshot.value))
    expect(view.result.current).toBe(1)

    act(() => { source.update((draft) => { draft.value = 2 }) })
    expect(view.result.current).toBe(2)
  })

  it('pins both browser language fields for the calling suite', () => {
    expect(navigator.languages).toEqual(['zh-CN', 'en-US'])
    expect(navigator.language).toBe('zh-CN')
  })
})

describe('Session fixture lifecycle', () => {
  it('initializes and drives complete event windows through replace, prepend, and append', async () => {
    const runtime = await SlotTestRuntime.create()
    const first = entry(1)
    const older = entry(0)
    const live = entry(2)

    await runtime.sessions.add({ id: 'events', events: [first] })
    expect(runtime.sessions.behavior('events').eventSource.getSnapshot()).toMatchObject({
      entries: [first],
      hasMore: false,
      change: { kind: 'replace', entries: [first] },
    })

    await runtime.sessions.add({ id: 'has-more', hasMore: true })
    expect(runtime.sessions.behavior('has-more').eventSource.getSnapshot()).toMatchObject({
      entries: [],
      hasMore: true,
    })

    await runtime.sessions.replaceEvents('events', [first])
    await runtime.sessions.prependEvents('events', [older])
    await runtime.sessions.appendEvent('events', live)
    expect(runtime.sessions.behavior('events').eventSource.getSnapshot()).toMatchObject({
      entries: [older, first, live],
      hasMore: false,
      change: { kind: 'append', entries: [live] },
    })
    await runtime.dispose()
  })

  it('requires an explicit create stub and records successful create and refresh calls', async () => {
    const runtime = await SlotTestRuntime.create()
    await expect(runtime.sessions.create()).rejects.toThrow(/create is not stubbed/)
    await runtime.sessions.add({ id: 'created' })
    const create = vi.fn(() => Promise.resolve('created' as SessionId))
    runtime.sessions.stubCreate(create)

    await expect(runtime.sessions.create({ cwd: '/workspace' })).resolves.toBe('created')
    await expect(runtime.sessions.refresh()).resolves.toBeUndefined()
    expect(create).toHaveBeenCalledWith({ cwd: '/workspace' })
    expect(runtime.sessions.calls.slice(-2)).toEqual([
      { method: 'create', args: [{ cwd: '/workspace' }] },
      { method: 'refresh', args: [] },
    ])
    await runtime.dispose()
  })

  it('borrows only retained scopes and disposes their generation with the runtime', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 'scope-only' })
    expect(runtime.sessions.scope('scope-only')).toBeUndefined()
    const reference = runtime.sessions.retain('scope-only' as SessionId)
    await reference.ready
    const scope = runtime.sessions.scope('scope-only')
    expect(scope).toBeDefined()
    const release = vi.fn()
    scope?.effect(() => release, 'fixture scope release')

    runtime.releaseWorkspaceSource()
    await runtime.dispose()
    expect(release).toHaveBeenCalledOnce()
    expect(() => reference.binding).toThrow('released')
  })
})
