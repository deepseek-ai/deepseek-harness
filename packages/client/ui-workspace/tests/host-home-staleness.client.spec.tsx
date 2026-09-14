// @vitest-environment jsdom
/**
 * Host home reaches the browsing region through the assembled renderer, which
 * memoizes a root entry's inject result for the whole registration — so a home
 * read once at first render would freeze there. This spec drives the real slot
 * renderer (not a direct `entry.inject()` call, which bypasses that memo) and
 * pins that a home learned after first render reaches the rendered rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Test-owned sidebar shell role: declares and renders the browsing region. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

/** The assembled sidebar over one Workspace inside the POSIX home the Host reports. */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('layout', { selectPanel: vi.fn() })
  runtime.releaseWorkspaceSource()
  const directoryPicker = {}
  const remote = new TestRemote(runtime.ctx)
  Object.assign(remote, { directoryPicker })
  runtime.ctx.provide('remote.directoryPicker', directoryPicker as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: 'w1' as WorkspaceId, title: 'Project', path: '/home/u/Documents/project',
      sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
  await runtime.root.declare(
    { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
    SidebarFrame as never,
  )
  await runtime.mount({ inject: [...inject], apply })
  return { runtime, remote }
}

/** Open the Workspace row's hover card, which is where the home abbreviation shows. */
function openHoverCard(): void {
  const row = screen.getByRole('treeitem').parentElement as HTMLElement
  fireEvent.pointerEnter(row)
  act(() => { vi.advanceTimersByTime(500) })
}

/** Close it again, so the next hover rebuilds the card from current props. */
function closeHoverCard(): void {
  const row = screen.getByRole('treeitem').parentElement as HTMLElement
  fireEvent.pointerLeave(row)
  act(() => { vi.advanceTimersByTime(500) })
}

describe('Host home in the assembled browsing region', () => {
  it('abbreviates the path once a home learned after first render reaches the rows', async () => {
    // First render precedes the ready frame: the shell mounts while the carrier
    // is still handshaking, so the Host reports no home yet.
    const { runtime, remote } = await bench()
    remote.$host = { home: undefined, isLoopback: true }
    runtime.renderRoot()
    vi.useFakeTimers()
    try {
      openHoverCard()
      expect(screen.getByText('/home/u/Documents/project')).toBeTruthy()
      closeHoverCard()

      // The ready frame lands: `$host.home` now answers, and the generation is
      // announced through the reset every consumer already listens to.
      remote.$host = { home: '/home/u', isLoopback: true }
      act(() => { runtime.ctx.emit('connection/reset') })
      openHoverCard()

      expect(screen.getByText('~/Documents/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
