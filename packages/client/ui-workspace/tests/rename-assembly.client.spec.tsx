// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
/**
 * The session-rename assembly chain on SlotTestRuntime (real apply, real
 * WorkspaceBrowser occupying the sidebar hole, the shipped row actions and
 * the overlay surfaces registered by the same apply): row menu → rename
 * request → the `shell.overlay` dialog → the injected renameSession hop
 * (sessions.binding → ISession.rename) → on the accepted unary response the
 * dialog closes and the row re-labels from the list state — no push-frame
 * wait. Coverage split: the real Loader/Web e2e
 * (apps/web/tests/client-plugin-live.e2e.ts, with the ARIA golden under
 * apps/web/tests/expected/client-plugin-live/) pins the full-app menu;
 * the verb's wire behavior stays with the Session Controller client package
 * (session.spec.ts#rename), the entries' own arms with
 * session-actions.client.spec, the row's list rendering with rows.client.spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError, SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Runtime with the locale face installed (the browser entry declares `locale:` — zh default backs the t seat). */
async function createRuntime(): Promise<SlotTestRuntime> {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
  runtime.ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
  runtime.releaseWorkspaceSource()
  // The rename flow never picks a directory; the namespace only has to be there
  // for ui-workspace's inject to settle.
  const directoryPicker = {}
  runtime.remote.provideNamespaces({ directoryPicker })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  return runtime
}

/** Test-owned shell role: declares and renders the browsing region and the frame-wide overlay list. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces' | 'shell.overlay'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return (
    <>
      {renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}
      {renderSlot('shell.overlay', {})}
    </>
  )
}

/** Declare the sidebar hole and the overlay list the rename dialog and the row notices mount in. */
async function declareFrame(runtime: SlotTestRuntime): Promise<void> {
  await runtime.root.declare(
    {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    } as never,
    SidebarFrame as never,
  )
}

/** One Workspace holding the fixture Session. */
async function seedWorkspace(runtime: SlotTestRuntime): Promise<void> {
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: 'w1' as WorkspaceId, title: 'alpha', path: '/w/alpha',
      sessionIds: [SID], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
}

describe('session rename through the assembled browser', () => {
  it('renders independently registered Session actions in declared order', async () => {
    const runtime = await createRuntime()
    const selected = vi.fn()
    await runtime.sessions.add({
      id: SID,
      summary: { title: 'Persisted title', displayTitle: 'Session title', cwd: '/w/alpha' },
      session: { rename: vi.fn() },
    })
    await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
    await seedWorkspace(runtime)
    await declareFrame(runtime)
    await runtime.mount({ inject: [...inject], apply })
    const registerAction = (id: string, order: number, priority: number, label: string) => {
      runtime.slots.register(
        { name: 'sidebar.workspaces.session.menu.item', id, order, priority },
        ({ sessionId, displayTitle, useMenuOpenState }: PropsRuntime<'sidebar.workspaces.session.menu.item'>) => {
          const [, setMenuOpen] = useMenuOpenState()
          return (
            <MenuItemButton separatorBefore={order === 500} onSelect={() => {
              setMenuOpen(false)
              selected(id, sessionId, displayTitle)
            }}>
              {label}
            </MenuItemButton>
          )
        },
      )
    }
    // `order` places plugin rows after the shipped rows (100/200/300/400)
    // even when the later registration has the lower shadowing priority
    // assigned to dynamic browser packages; the first plugin row opens the
    // plugin group with a hairline.
    registerAction('export', 500, -1, 'Export action')
    registerAction('last', 600, -2, 'Last action')
    const view = runtime.renderRoot()

    const row = (await view.findByText('Persisted title')).closest('[role="treeitem"]')!
    const trigger = within(row as HTMLElement).getByLabelText('会话“Persisted title”的操作')
    fireEvent.click(trigger)
    expect(view.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '置顶会话', '重命名', '分叉会话', '归档会话', 'Export action', 'Last action',
    ])
    expect(view.getAllByRole('separator')).toHaveLength(1)
    const last = view.getByRole('menuitem', { name: 'Last action' })
    const exportRow = view.getByRole('menuitem', { name: 'Export action' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(exportRow)
    fireEvent.click(exportRow)
    expect(selected).toHaveBeenCalledWith('export', SID, 'Persisted title')
    // The plugin row dismissed the menu through the bound open-state hook;
    // the list returns focus to the trigger.
    expect(view.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(trigger)
    await runtime.dispose()
  })

  it('renames via the row menu: binding.session.rename fires, the dialog closes, the row re-labels from the list', async () => {
    const runtime = await createRuntime()
    const rename = vi.fn<ISession['rename']>(async title => ({
      ok: true, value: { title: title.trim().replace(/\s+/g, ' '), seq: SessionSeq(7) },
    }))
    await runtime.sessions.add({
      id: SID,
      summary: { title: '旧标题', displayTitle: '旧标题', cwd: '/w/alpha' },
      session: { rename },
    })
    await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
    await seedWorkspace(runtime)
    await declareFrame(runtime)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    // The current session's group auto-expands; open the row's action menu.
    const row = (await view.findByText('旧标题')).closest('[role="treeitem"]')!
    fireEvent.click(within(row as HTMLElement).getByLabelText('会话“旧标题”的操作'))
    fireEvent.click(view.getByRole('menuitem', { name: '重命名', hidden: true }))
    // The rename row dismissed the menu; the dialog lives in the overlay list.
    expect(view.queryByRole('menu')).toBeNull()

    // The dialog seeds from the current title; submit a padded value.
    const input = await view.findByLabelText('会话名称') as HTMLInputElement
    expect(input.value).toBe('旧标题')
    fireEvent.change(input, { target: { value: '  分叉  实验记录  ' } })
    fireEvent.click(view.getByRole('button', { name: '重命名' }))

    // The injected hop reached the session face with the edge-trimmed draft
    // (the dialog trims edges; interior normalization is host-side).
    await waitFor(() => { expect(rename).toHaveBeenCalledWith('分叉  实验记录') })
    // Acceptance closes the dialog without any push-frame wait.
    await waitFor(() => { expect(view.queryByLabelText('会话名称')).toBeNull() })
    // The manager lands the unary echo in the list store (its own package
    // tests own that hop); the row re-labels from list state alone.
    await runtime.sessions.updateSummary(SID, { displayTitle: '分叉 实验记录', title: '分叉 实验记录' })
    await view.findByText('分叉 实验记录')
    expect(view.queryByText('旧标题')).toBeNull()
    await runtime.dispose()
  })

  it('a rejected rename keeps the dialog open with the error surfaced', async () => {
    const runtime = await createRuntime()
    const rename = vi.fn<ISession['rename']>(async () => ({
      ok: false, error: new RemoteError('gateway/internal', 'title write failed', {}),
    }))
    await runtime.sessions.add({
      id: SID,
      summary: { title: '旧标题', displayTitle: '旧标题', cwd: '/w/alpha' },
      session: { rename },
    })
    await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
    await seedWorkspace(runtime)
    await declareFrame(runtime)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    await runtime.flush()

    const row = (await view.findByText('旧标题')).closest('[role="treeitem"]')!
    fireEvent.click(within(row as HTMLElement).getByLabelText('会话“旧标题”的操作'))
    fireEvent.click(view.getByRole('menuitem', { name: '重命名', hidden: true }))
    const input = await view.findByLabelText('会话名称')
    fireEvent.change(input, { target: { value: '新名' } })
    fireEvent.click(view.getByRole('button', { name: '重命名' }))

    // Failure: the injected hop rethrows the business error; the dialog
    // stays open with the alert and the row keeps its title.
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('title write failed')
    expect(view.getByLabelText('会话名称')).toBeTruthy()
    expect(view.getByText('旧标题')).toBeTruthy()
    await runtime.dispose()
  })
})
