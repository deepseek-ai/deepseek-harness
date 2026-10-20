/** ui-subagent browser half: catalog actions and read-only composer routing. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  SessionListState, SessionSnapshot, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import {
  SubagentHeaderLineage, type SubagentCatalogInjected, type SubagentCatalogActionInjected,
} from '../src/client/SubagentHeaderLineage.tsx'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from '../src/client/SubagentReadOnlyComposer.tsx'
import { apply, inject } from '../src/client/index.ts'

function summary(partial: Partial<SessionSummary> & { id: SessionId }): SessionSummary {
  return {
    displayTitle: partial.id,
    running: false,
    retainedBy: {},
    updatedAt: 0,
    ...partial,
  } as SessionSummary
}

const sid = (id: string) => id as SessionId

/** Fake root sessions face for catalog actions. */
function sessionsWith(sessions: SessionSummary[]) {
  const byId: Record<string, SessionSummary> = {}
  for (const s of sessions) byId[s.id] = s
  const snapshot: SessionListState = { ids: sessions.map(s => s.id), byId, phase: 'ready', projectionsBySession: {} }
  const actionCalls: { method: string; args: unknown[] }[] = []
  const address: SubagentAddress = {
    parentSessionId: sid('parent'),
    childSessionId: sid('c1'),
    mode: 'continuable',
  }
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    actionCalls,
    subagentAddress: (childSessionId: SessionId) => childSessionId === address.childSessionId
      ? address
      : undefined,
    refreshProjections: (parentSessionId: SessionId) => {
      actionCalls.push({ method: 'refreshProjections', args: [parentSessionId] })
      return Promise.resolve()
    },
  }
}

async function provideSlotFaces(ctx: Context): Promise<void> {
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
    },
  } as never, () => null)
}

/** Boot the plugin over fake sessions and slot faces. */
async function fullBench(sessions: SessionSummary[]) {
  const ctx = new Context()
  const face = sessionsWith(sessions)
  ctx.provide('sessions', face)
  ctx.provide('uiWorkspace', {
    openSession: (address: SubagentAddress) => {
      face.actionCalls.push({ method: 'openSession', args: [address] })
    },
  } as never)
  ctx.provide('sidebarRight', {
    openResource: (address: string, options: unknown) => {
      face.actionCalls.push({ method: 'openResource', args: [address, options] })
    },
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await provideSlotFaces(ctx)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { face, ctx }
}

const FAMILY: SessionSummary[] = [
  summary({ id: sid('parent'), displayTitle: 'parent', running: true }),
  summary({ id: sid('c1'), parentId: sid('parent'), displayTitle: 'worker-1', running: true }),
  summary({ id: sid('c2'), parentId: sid('parent'), displayTitle: 'worker-2', running: true }),
  // Filtered out: not running / other parent / label miss.
  summary({ id: sid('c3'), parentId: sid('parent'), displayTitle: 'worker-3', running: false }),
  summary({ id: sid('c4'), parentId: sid('other'), displayTitle: 'worker-4', running: true }),
  summary({ id: sid('c5'), parentId: sid('parent'), displayTitle: 'scout', running: true }),
]

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight'])
  })

  it('keeps the root catalog extension available when optional Sidebar services arrive', async () => {
    const { ctx } = await fullBench(FAMILY)
    onTestFinished(() => ctx.fiber.dispose())
    ctx.slots.register({ name: 'conversation.session.header.actions.subagent.footer', id: 'test-content' }, () => null)
    const registerResource = vi.fn(() => () => {})
    const registerTab = vi.fn(() => () => {})
    ctx.provide('resources', { register: registerResource } as never)
    ctx.provide('sidebarRightTabs', { register: registerTab } as never)
    await vi.waitFor(() => { expect(registerResource).toHaveBeenCalledOnce() })
    expect(registerTab).toHaveBeenCalledOnce()
    expect(ctx.slots.entries('conversation.session.header.actions.subagent.footer')).toHaveLength(1)
  })

  it('registers catalog actions and selects read-only subagent composers from session facts', async () => {
    const { ctx, face } = await fullBench(FAMILY)
    const catalogEntry = ctx.slots.entries('conversation.session.header.lineage')
      .find(entry => entry.component === SubagentHeaderLineage)!
    const actions = (catalogEntry.inject as unknown as (id: SessionId) => SubagentCatalogInjected)(sid('parent'))
    const address: SubagentAddress = {
      parentSessionId: sid('parent'),
      childSessionId: sid('c1'),
      mode: 'continuable',
    }
    actions.openChild(address)
    actions.openChildAside(address)
    actions.refreshProjection(sid('parent'))
    expect(face.actionCalls).toEqual([
      { method: 'openSession', args: [address] },
      {
        method: 'openResource',
        args: [
          'dsh-resource://subagentchat/session/c1?parent=parent&mode=continuable',
          { kind: 'subagentchat', preferNewPane: true },
        ],
      },
      { method: 'refreshProjections', args: [sid('parent')] },
    ])

    // The root-session catalog seat registers in the actions band with the
    // same business face, between the preset label (-10) and background
    // tasks (20).
    const actionEntry = ctx.slots.entries('conversation.session.header.actions')
      .find(entry => entry.options.id === 'subagent-catalog')!
    expect(actionEntry.options.order).toBe(10)
    const actionProps = (actionEntry.inject as (id: SessionId) => SubagentCatalogActionInjected)(sid('parent'))
    const source = actionProps.hooks.footerAvailable
    const changed = vi.fn()
    const unsubscribe = source.subscribe(changed)
    expect(source.getSnapshot()).toBe(false)
    const remove = ctx.slots.register({
      name: 'conversation.session.header.actions.subagent.footer', id: 'test-footer',
    }, () => null)
    expect(source.getSnapshot()).toBe(true)
    await vi.waitFor(() => { expect(changed).toHaveBeenCalledOnce() })
    remove()
    expect(source.getSnapshot()).toBe(false)
    await vi.waitFor(() => { expect(changed).toHaveBeenCalledTimes(2) })
    unsubscribe()

    const composerEntry = ctx.slots.entries('conversation.composer')
      .find(entry => entry.component === SubagentReadOnlyComposer)!
    const select = composerEntry.select as (owner: ComposerChainProps) => SubagentReadOnlyMatch | null
    const owner = (
      subagent: SessionSnapshot['subagent'] | undefined,
      running = false,
    ): ComposerChainProps => ({
      sessionId: subagent?.address.childSessionId,
      session: subagent === undefined
        ? undefined
        : ({ subagent, running } as SessionSnapshot),
      pendingInteraction: undefined,
    })
    expect(select(owner(undefined))).toBeNull()
    expect(select(owner(null))).toBeNull()
    expect(select(owner({ address: { ...address, mode: 'one-shot' } })))
      .toEqual({ reason: 'one-shot' })
    // One-shot stays read-only even while running: it has no stop action.
    expect(select(owner({ address: { ...address, mode: 'one-shot' } }, true)))
      .toEqual({ reason: 'one-shot' })
    expect(select(owner({ address: { ...address, mode: 'unknown' } })))
      .toEqual({ reason: 'unknown' })
    expect(select(owner({ address }))).toBeNull()
    expect(select(owner({ address }, true))).toBeNull()
  })
})
