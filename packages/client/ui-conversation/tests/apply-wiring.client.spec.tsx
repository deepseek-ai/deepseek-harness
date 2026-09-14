// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject, type ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'

usePinnedBrowserLanguages('zh-CN')

const SID = 'session-1' as SessionId

async function bench(options: { declareConversation?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: unknown, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      runtime.sessions.open(SID)
    }),
    openSession: (id: SessionId) => { runtime.sessions.open(id) },
  } as never)
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  if (options.declareConversation !== false) {
    await runtime.root.declare({
      'main': { kind: 'keyed', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    }, (_props: { renderSlot?: unknown }) => null)
  }
  const feature = await runtime.mount({ inject: [...inject], apply })
  return { runtime, feature }
}

function entry(
  runtime: SlotTestRuntime,
  key: 'main.conversation' | 'conversation.session' | 'conversation.session.header',
) {
  return runtime.slots.entries(key)[0] as { store?: unknown } | undefined
}

describe('target-neutral Conversation apply wiring', () => {
  it('waits for the layout-owned conversation declaration before registering its subtree', async () => {
    const b = await bench({ declareConversation: false })
    expect(b.runtime.slots.entries('main')).toHaveLength(0)
    expect(b.runtime.slots.entries('main.conversation')).toHaveLength(0)

    await b.runtime.root.declare({
      'main': { kind: 'keyed', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    }, (_props: { renderSlot?: unknown }) => null)

    expect(b.runtime.slots.entries('main').map(row => row.options.key)).toEqual(['conversation'])
    expect(b.runtime.slots.entries('main.conversation')).toHaveLength(1)
    expect(b.runtime.slots.spec('main.conversation'))
      .toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(b.runtime.slots.entries('conversation.session')).toHaveLength(1)
    expect(b.runtime.slots.entries('conversation.session.header')).toHaveLength(1)
    expect(b.runtime.slots.entries('conversation.composer.bar')).toHaveLength(1)
    await b.runtime.dispose()
  })

  it('provides both action and assembly services without installing Chat', async () => {
    const b = await bench()
    expect(b.runtime.ctx.get('conversation')).toBeDefined()
    expect(b.runtime.ctx.get('uiConversation')).toBeDefined()
    expect(b.runtime.slots.entries('conversation.view')).toHaveLength(0)
    await b.runtime.dispose()
  })

  it('owns shell slots and shares only the Conversation store', async () => {
    const b = await bench()
    const session = entry(b.runtime, 'conversation.session')
    const header = entry(b.runtime, 'conversation.session.header')
    expect(entry(b.runtime, 'main.conversation')?.store).toBeUndefined()
    expect(session?.store).toBeDefined()
    expect(header?.store).toBe(session?.store)
    expect(b.runtime.slots.spec('conversation.composer'))
      .toEqual({ kind: 'chain', scope: 'session' })
    expect(b.runtime.slots.entries('settings.general.item').map(row => row.options.id))
      .toEqual(['composer-enter'])
    await b.runtime.dispose()
  })

  it('binds a cached locale-aware View roster only to its shell entries', async () => {
    const b = await bench()
    await b.runtime.sessions.add({ id: SID }, { current: false })
    expect(b.runtime.ctx.uiSession.adapter.resolve(SID)?.hooks.conversationViews).toBeUndefined()
    const header = b.runtime.slots.entries('conversation.session.header')[0]
    const source = (header?.inject?.() as {
      hooks: { conversationViews: ObservableSnapshot<readonly ViewTab[]> }
    } | undefined)?.hooks.conversationViews
    expect(source).toBeDefined()
    expect(source?.getSnapshot()).toBe(source?.getSnapshot())

    const disposeView = b.runtime.slots.register({
      name: 'conversation.view',
      id: 'probe',
      label: () => b.runtime.ctx.locale.getSnapshot().active,
    }, (() => null) as never)
    await vi.waitFor(() => {
      expect(source?.getSnapshot()).toEqual([{ id: 'probe', label: 'zh' }])
    })
    const chinese = source?.getSnapshot()

    b.runtime.ctx.locale.setLocale('en')
    expect(source?.getSnapshot()).toEqual([{ id: 'probe', label: 'en' }])
    expect(source?.getSnapshot()).not.toBe(chinese)

    disposeView()
    await vi.waitFor(() => { expect(source?.getSnapshot()).toEqual([]) })
    await b.runtime.dispose()
  })

  it('removes services, entries, and declarations with the plugin fiber', async () => {
    const b = await bench()
    await b.feature.dispose()
    expect(b.runtime.ctx.get('conversation')).toBeUndefined()
    expect(b.runtime.ctx.get('uiConversation')).toBeUndefined()
    expect(b.runtime.slots.entries('main')).toHaveLength(0)
    expect(b.runtime.slots.entries('main.conversation')).toHaveLength(0)
    expect(b.runtime.slots.spec('main.conversation')).toBeUndefined()
    expect(b.runtime.slots.spec('conversation.view')).toBeUndefined()
    await b.runtime.dispose()
  })
})
