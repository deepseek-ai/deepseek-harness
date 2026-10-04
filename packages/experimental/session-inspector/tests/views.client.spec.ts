// @vitest-environment jsdom
/** Session Inspector's Sidebar page follows slot and plugin lifetimes. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ChatSnapshotBuilder } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ConversationGroupStore } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/group-store.ts'
import type { ConversationSnapshot, GroupKey, NodeKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionInspectorInjected } from '../src/client/views/View.tsx'
import { chatNodeWithLocation } from './chat-node-fixture.client.ts'
import { apply, inject } from '../src/client/index.ts'
import * as discovery from '../src/index.ts'
import { en, zh } from '../src/client/locales.ts'

async function fixture(services?: { sessions: object; uiConversation: object; uiSession: object }) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', services?.sessions ?? {})
  ctx.provide('uiConversation', services?.uiConversation ?? {})
  ctx.provide('uiSession', services?.uiSession ?? {})
  const tabs = new SidebarRightTabRegistry(ctx)
  ctx.provide('sidebarRightTabs', tabs)
  ctx.locale.setLocale('en')
  await ctx.plugin(SlotRegistry).await()
  const declare = () => ctx.slots.register({
    name: 'root',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
      'sidebar.right.pane.tab': {
        kind: 'keyed', scope: 'session',
        inject: { hooks: { tabInfo: () => { throw new Error('Tab body is not rendered in this registration test') } } },
      },
    },
  }, (_props: PropsRenderSlots<'conversation.view' | 'sidebar.right.pane.tab'>) => null)
  return { ctx, tabs, declare }
}

const ID = '@deepseek-ai/dsh-experimental-session-inspector'
const KIND = 'session-inspector-log'

function inspectorInjector(ctx: Context) {
  const entry = ctx.slots.entries('sidebar.right.pane.tab')[0]!
  // Stored entries erase positional injectors; this registration owns the Session Inspector source type.
  return entry.inject as NonNullable<typeof entry.inject> & ((key: SessionId) => SessionInspectorInjected)
}

describe('Session Inspector Sidebar tab', () => {
  it('keeps Host discovery inert and exposes only the named plugin entry', () => {
    expect('default' in discovery).toBe(false)
    expect(() => { discovery.apply() }).not.toThrow()
  })
  it('registers a page in the Sidebar guide without adding a Conversation View', async () => {
    const { ctx, tabs, declare } = await fixture()
    declare()
    const fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    const entries = () => ctx.slots.entries('sidebar.right.pane.tab')
    expect(entries().map(entry => entry.options.key)).toEqual([ID])
    expect(ctx.slots.entries('conversation.view')).toEqual([])
    expect(tabs.get(KIND)?.patterns).toBeUndefined()
    expect(tabs.get(KIND)?.title('')).toBe(en['tab.title'])
    expect(tabs.guide().map(entry => ({ kind: entry.kind, title: entry.title() })))
      .toEqual([{ kind: KIND, title: en['tab.title'] }])
    expect(tabs.guide()[0]?.description?.()).toBe(en['tab.description'])
    expect(tabs.get('nodejs-inspector')).toBeUndefined()
    ctx.locale.setLocale('zh')
    expect(tabs.get(KIND)?.title('')).toBe(zh['tab.title'])
    expect(tabs.guide()[0]?.description?.()).toBe('在侧边栏分析当前会话原始日志和聊天分组数据')
    await fiber.dispose()
    expect(entries()).toEqual([])
    expect(tabs.get(KIND)).toBeUndefined()
    expect(tabs.guide()).toEqual([])
    await ctx.plugin({ apply, inject }).await()
    expect(tabs.get(KIND)?.id).toBe(ID)
    expect(entries()).toHaveLength(1)
  })

  it('waits for the Sidebar slot and follows its redeclaration', async () => {
    const { ctx, declare } = await fixture()
    const fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    const ids = () => ctx.slots.entries('sidebar.right.pane.tab').map(entry => entry.options.key)
    expect(ids()).toEqual([])
    const collapse = declare()
    expect(ids()).toEqual([ID])
    collapse()
    expect(ids()).toEqual([])
    declare()
    expect(ids()).toEqual([ID])
  })

  it('binds cached sources, pagination, and exact or approximate picking to the inspected Session', async () => {
    const id = 'inspected-session' as SessionId
    const eventSource = new MutableSessionEventSource()
    eventSource.replace([
      { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } } },
    ], false)
    const node = chatNodeWithLocation()
    if (node.location.kind !== 'step') throw new Error('Expected a Step Location')
    const builder = new ChatSnapshotBuilder()
    let chat: ChatSnapshot | undefined = builder.replace({ nodes: [node],
      timeline: { turnOrder: [1], turns: new Map([[1, node.location.turn]]) } })
    const groups = new ConversationGroupStore()
    const groupKey = 'picked-group' as GroupKey
    groups.prepareAndInstall({ entries: [{ kind: 'group', key: groupKey }], groups: { kind: 'replace', snapshots: [{
      key: groupKey, members: [{ kind: 'node', key: node.key as NodeKey }], data: {},
    }] } }, key => chat?.nodes.get(key))
    const views = { get: () => chat, grouped: () => groups } as ConversationSnapshot['views']
    const snapshot = createSnapshotStore<ConversationSnapshot>({ views, activeTargets: new Set(['chat']) })
    const loadOlder = vi.fn(async () => {})
    let binding = { eventSource, session: { loadOlder } }
    const current = createSnapshotStore({ key: id })
    const services = {
      sessions: { binding: (key: SessionId) => key === id ? binding : undefined },
      uiConversation: { binding: () => ({ snapshot, openTurn: createSnapshotStore<number | undefined>(1),
        activate: vi.fn(), target: () => { throw new Error('unused') } }) },
      uiSession: { adapter: { current } },
    }
    const { ctx, declare } = await fixture(services)
    declare()
    const fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    const create = inspectorInjector(ctx)
    expect(() => create('unknown' as SessionId)).toThrow('unknown Session')
    const sources = create(id)
    expect(sources.pickChat(document.createElement('button'), vi.fn(), vi.fn())).toBeUndefined()
    expect(create(id)).toBe(sources)
    expect(sources.objects.updates).toBe(snapshot)
    expect(sources.recordType(`node:${node.key}:`, 'chat-node')).toBe('assistant')
    expect(sources.recordType('event:2', 'session-log')).toBe('step/start')
    expect(sources.recordType('missing', 'chat-node')).toBeUndefined()
    expect(sources.logChatTarget('event:2')).toMatchObject({ anchorSeq: 2, turn: 1, step: 1 })
    expect(sources.logChatTarget('missing')).toBeUndefined()
    expect(sources.pickRow({ nodeKey: node.key }, 'chat-node')).toBe(`node:${node.key}:`)
    expect(sources.pickRow({ nodeKey: node.key }, 'session-log')).toBe('event:2')
    expect(sources.pickRow({ groupKey }, 'session-log')).toBe('event:2')
    expect(sources.pickRow({ groupKey: 'missing' }, 'session-log')).toBeUndefined()
    expect(sources.resolveChatTargets({ anchorSeq: 2 })[0]?.nodeKey).toBe(node.key)
    await sources.loadOlder()
    expect(loadOlder).toHaveBeenCalledOnce()
    const host = document.createElement('div')
    host.dataset.slot = 'main.conversation'
    host.innerHTML = '<div data-slot="conversation.view"><div data-chat-flow></div></div>'
    document.body.append(host)
    onTestFinished(() => { host.remove() })
    expect(sources.chatRoot()).toBe(host.querySelector('[data-chat-flow]'))
    current.set({ key: 'another-session' as SessionId })
    expect(sources.chatRoot()).toBeUndefined()
    chat = undefined
    expect(sources.resolveChatTargets({ anchorSeq: 2 })).toEqual([{ anchorSeq: 2 }])
    expect(sources.pickRow({ nodeKey: node.key }, 'session-log')).toBeUndefined()
    binding = { ...binding }
    expect(create(id)).not.toBe(sources)
    current.set({ key: id })
    const root = sources.chatRoot()!
    root.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300)
    const owner = document.createElement('button')
    host.append(owner)
    const cancelled = vi.fn()
    const picked = vi.fn(() => true)
    const stopFirst = sources.pickChat(owner, picked, cancelled)!
    const firstMask = document.querySelector<HTMLElement>('[data-session-inspector-picker]')!
    const stopPicking = create(id).pickChat(owner, picked, cancelled)!
    const mask = document.querySelector<HTMLElement>('[data-session-inspector-picker]')!
    expect(firstMask.isConnected).toBe(false)
    expect(cancelled).toHaveBeenCalledOnce()
    stopFirst()
    expect(mask.isConnected).toBe(true)
    cancelled.mockClear()
    const other = await fixture(services)
    other.declare()
    const otherFiber = other.ctx.plugin({ apply, inject })
    await otherFiber.await()
    inspectorInjector(other.ctx)(id).pickChat(owner, picked, cancelled)
    expect(document.querySelectorAll('[data-session-inspector-picker]')).toHaveLength(2)
    await fiber.dispose()
    expect(mask.isConnected).toBe(false)
    expect(document.querySelectorAll('[data-session-inspector-picker]')).toHaveLength(1)
    expect(sources.pickChat(owner, picked, cancelled)).toBeUndefined()
    stopPicking()
    mask.click()
    expect(picked).not.toHaveBeenCalled()
    expect(cancelled).not.toHaveBeenCalled()
    await otherFiber.dispose()
    expect(document.querySelector('[data-session-inspector-picker]')).toBeNull()
    await ctx.plugin({ apply, inject }).await()
    expect(inspectorInjector(ctx)(id).pickChat(owner, picked, cancelled)).toBeTypeOf('function')
    expect(document.querySelectorAll('[data-session-inspector-picker]')).toHaveLength(1)
  })
})
