// @vitest-environment jsdom
/**
 * Workspace header actions under a non-owner access snapshot, through the assembled renderer.
 *
 * Hand-built row props spread allow-all access Hooks, so they cannot show that the browsing region
 * reads the Hooks a page actually binds. This spec replaces the runtime's allow-all access row with the
 * remote-access snapshot owner itself and renders the real slot tree, so the global and Workspace
 * access Hooks are the renderer's bindings over one non-owner snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen } from '@testing-library/react'
import type { TypertResourceKind } from '@deepseek-ai/dsh-api-remote-access/client'
import { ClientAccessState } from '@deepseek-ai/dsh-api-remote-access/src/client/state.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccessPlugin, SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Test-owned sidebar shell role: declares and renders the browsing region. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

const WORKSPACE = 'w1' as WorkspaceId

/**
 * The assembled browsing region over one Workspace, answering access from one snapshot owner.
 * @param access - Snapshot owner the page's access Hooks read.
 * @returns The runtime.
 */
async function bench(access: ClientAccessState, options: { ungroupedSession?: SessionId } = {}) {
  const runtime = await SlotTestRuntime.create()
  await Promise.all([...runtime.ctx.registry.get(allowAllAccessPlugin)?.fibers ?? []].map(fiber => fiber.dispose()))
  await runtime.ctx.plugin({
    name: 'access-assembly:snapshot-access',
    inject: ['slots'],
    apply(ctx) {
      ctx.provide('remoteAccess', {
        source: (kind: TypertResourceKind, id: string, action: string) => access.resource(kind, id, action),
      })
      ctx.slots.provideRoot({ keyedHooks: { remoteAccess: action => access.global(action) } })
    },
  }).await()
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
  runtime.ctx.provide('uiConversation', {})
  runtime.ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
  runtime.releaseWorkspaceSource()
  runtime.remote.provideNamespaces({ directoryPicker: {} })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  if (options.ungroupedSession !== undefined) {
    await runtime.sessions.add({
      id: options.ungroupedSession,
      summary: { title: 'Loose', displayTitle: 'Loose', cwd: '/elsewhere' },
    })
  }
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: WORKSPACE, title: 'Project', path: '/projects/project',
      sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
  await runtime.root.declare(
    { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
    SidebarFrame as never,
  )
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

describe('Workspace header actions under the page access snapshot', () => {
  it('offers New Session, the Workspace menu, and the drag handle only where the snapshot grants them', async () => {
    const access = new ClientAccessState({
      type: 'baseline',
      owner: false,
      grants: [{ resource: { kind: 'workspace', id: WORKSPACE }, actions: ['workspace/follow'] }],
    })
    const runtime = await bench(access)
    try {
      runtime.renderRoot()
      const header = await screen.findByRole('treeitem')
      expect(screen.queryByRole('button', { name: '在“Project”中新建会话' })).toBeNull()
      expect(screen.getByRole('button', { name: '工作区“Project”的操作' })).toBeTruthy()
      const target = { kind: 'workspace' as const, value: { workspaceId: WORKSPACE, path: '/projects/project', displayTitle: 'Project' } }
      const deniedMenu = runtime.ctx.contextMenus.resolve(target)
      await deniedMenu.ready
      expect(deniedMenu.source.getSnapshot()).toEqual([])
      deniedMenu.dispose()
      expect(header.getAttribute('draggable')).toBe('false')

      // The Workspace's own grant moves its actions; the global answer is never consulted for them.
      act(() => {
        access.update({
          type: 'upsert',
          grant: {
            resource: { kind: 'workspace', id: WORKSPACE },
            actions: ['session/create', 'workspace/follow', 'workspace/insertBefore', 'workspace/rename'],
          },
        })
      })
      expect(screen.getByRole('button', { name: '在“Project”中新建会话' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '工作区“Project”的操作' })).toBeTruthy()
      expect(screen.getByRole('treeitem').getAttribute('draggable')).toBe('true')

      const grantedMenu = runtime.ctx.contextMenus.resolve(target)
      await grantedMenu.ready
      expect(grantedMenu.source.getSnapshot().map(item => item.id)).toEqual(['workspace.rename/rename'])
      act(() => { access.replace({ type: 'baseline', owner: false, grants: [] }) })
      grantedMenu.select('workspace.rename/rename')
      expect(screen.queryByRole('dialog')).toBeNull()
      grantedMenu.dispose()

      // The owner's snapshot answers every action.
      act(() => { access.replace({ type: 'baseline', owner: true }) })
      expect(screen.getByRole('button', { name: '在“Project”中新建会话' })).toBeTruthy()
    } finally {
      await runtime.dispose()
    }
  })

  it('asks the global resource before the Ungrouped header offers New Session', async () => {
    const access = new ClientAccessState({ type: 'baseline', owner: false, grants: [] })
    const runtime = await bench(access, { ungroupedSession: 'loose' as SessionId })
    try {
      runtime.renderRoot()
      await screen.findByText('未分组')
      expect(screen.queryByRole('button', { name: '在“未分组”中新建会话' })).toBeNull()
      act(() => {
        access.update({ type: 'upsert', grant: { resource: { kind: 'global' }, actions: ['session/create'] } })
      })
      expect(screen.getByRole('button', { name: '在“未分组”中新建会话' })).toBeTruthy()
    } finally {
      await runtime.dispose()
    }
  })
})
