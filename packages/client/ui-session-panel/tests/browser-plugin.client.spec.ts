/**
 * ui-session-panel plugin halves: the browser entry's dictionaries, header
 * toggle, panel, Environment section, and project row against the real
 * SlotRegistry, the inject faces those entries receive, the section roster
 * projection, fiber teardown removing every contribution (HMR safety), and
 * the inert node entry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { ConversationLayout } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { ProjectRowInjected, SessionPanelInjected, SessionPanelToggleInjected } from '../src/client/slots.ts'
import { apply as applyNode } from '../src/index.ts'

const SID = 'session-1' as SessionId

afterEach(() => {
  vi.restoreAllMocks()
})

/** Boot the browser half over a real slot tree that declares the header utilities and the panel seat. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
      'conversation.session.panel': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
  const layout = createSnapshotStore<ConversationLayout>({ endGutter: 400 })
  const layoutSources: SessionId[] = []
  ctx.provide('uiConversation', {
    layouts: {
      source: (sessionId: SessionId) => {
        layoutSources.push(sessionId)
        return layout
      },
    },
  } as never)
  const host = { home: '/Users/me', isLoopback: true }
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {}, $host: host } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, layout, layoutSources, host }
}

/** Inject face of one registration, called for the test Session. */
function faceOf(ctx: Context, slot: string, id: string | undefined): unknown {
  const entry = ctx.slots.entries(slot as never).find(candidate => candidate.options.id === id)
  const face = entry?.inject as ((sessionId: SessionId) => unknown) | undefined
  if (face === undefined) throw new Error(`${slot} entry ${id ?? '(single)'} registered no inject face`)
  return face(SID)
}

describe('ui-session-panel browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'uiConversation', 'remote'])
  })

  it('registers the toggle first among the header utilities, the panel, the Environment section, and the project row', async () => {
    const { ctx } = await bench()
    const toggle = ctx.slots.entries('conversation.session.header.utilities').find(entry => entry.options.id === 'session-panel')
    expect(toggle?.options.order).toBe(-10)
    expect(ctx.slots.entries('conversation.session.panel')).toHaveLength(1)
    const section = ctx.slots.entries('conversation.session.panel.section').find(entry => entry.options.id === 'environment')
    expect(section?.options.order).toBe(0)
    expect(ctx.slots.entries('conversation.session.panel.environment.row').map(entry => entry.options.id)).toEqual(['project'])
  })

  it('hands the toggle and the panel the shared visibility and the Session layout source', async () => {
    const { ctx, layout, layoutSources } = await bench()
    const toggle = faceOf(ctx, 'conversation.session.header.utilities', 'session-panel') as SessionPanelToggleInjected
    const panel = faceOf(ctx, 'conversation.session.panel', undefined) as SessionPanelInjected
    expect(toggle.hooks.layout).toBe(layout)
    expect(panel.hooks.layout).toBe(layout)
    expect(layoutSources).toEqual([SID, SID])
    expect(toggle.hooks.visibility).toBe(panel.hooks.visibility)
    toggle.toggle(SID, false)
    expect(panel.hooks.visibility.getSnapshot()).toEqual({ pinned: true, overlay: SID })
    panel.closeOverlay(SID)
    expect(panel.hooks.visibility.getSnapshot().overlay).toBeNull()
  })

  it('projects the section roster in the active locale and keeps it stable between changes', async () => {
    const { ctx } = await bench()
    const panel = faceOf(ctx, 'conversation.session.panel', undefined) as SessionPanelInjected
    const roster = panel.hooks.sections
    const first = roster.getSnapshot()
    expect(first).toEqual([{ id: 'environment', label: '环境' }])
    expect(roster.getSnapshot()).toBe(first)
    const listener = vi.fn()
    const off = roster.subscribe(listener)
    ctx.locale.setLocale('en')
    expect(listener).toHaveBeenCalled()
    expect(roster.getSnapshot()).toEqual([{ id: 'environment', label: 'Environment' }])

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dispose = ctx.slots.register({ name: 'conversation.session.panel.section', id: 'untitled', order: 5 }, () => null)
    expect(roster.getSnapshot()).toEqual([{ id: 'environment', label: 'Environment' }])
    roster.getSnapshot()
    expect(error).toHaveBeenCalledTimes(1)
    ctx.locale.setLocale('zh')
    roster.getSnapshot()
    expect(error).toHaveBeenCalledTimes(1)
    dispose()
    off()
  })

  it('gives the project row the Host facts and follows connection resets', async () => {
    const { ctx, host } = await bench()
    const row = faceOf(ctx, 'conversation.session.panel.environment.row', 'project') as ProjectRowInjected
    expect(row.hooks.host.getSnapshot()).toBe(host)
    const listener = vi.fn()
    const off = row.hooks.host.subscribe(listener)
    ctx.emit('connection/reset' as never)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('removes every contribution with the fiber (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.session.panel')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.session.panel.section')).toHaveLength(0)
  })
})

describe('ui-session-panel node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})
