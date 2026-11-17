// @vitest-environment jsdom
/**
 * The `workspace.picker` Factory as another plugin renders it: a test-owned
 * dialog component inside the primitives Modal calls the standard
 * `renderFactorySlot` seat, while the real ui-workspace apply registers the
 * definition and a probe plugin fills its directory-flow hole the way a
 * picker package does. The menu's own arms stay with
 * workspace-picker.client.spec; this spec pins what crosses plugins: the
 * listed Workspaces, the occupancy-gated add entry, and the creation hop
 * before `onPick`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

const ALPHA = 'w-alpha' as WorkspaceId
const ADD = '添加工作区…'

/** Test-owned consumer surface: another plugin's dialog that owns the anchor, open state, and pick meaning. */
function ImportDialog({ renderFactorySlot }: PropsRenderFactories) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<WorkspaceId | undefined>(undefined)
  return (
    <Modal open title="import" closeLabel="close" onClose={() => {}}>
      <button ref={anchorRef} type="button" onClick={() => { setOpen(value => !value) }}>choose</button>
      <output>{picked ?? 'none'}</output>
      {renderFactorySlot('workspace.picker', {
        open,
        anchorRef,
        selectedId: picked,
        onPick: (workspaceId) => {
          setOpen(false)
          setPicked(workspaceId)
        },
        onClose: () => { setOpen(false) },
      })}
    </Modal>
  )
}

/** Probe directory-flow occupant: one button that reports a fixed picked path while the flow is open. */
function ProbeFlow({ open, busy, onPicked }: PropsRuntime<'workspace.picker.directoryFlow'>) {
  return open ? <button type="button" disabled={busy} onClick={() => { onPicked('/tmp/project') }}>probe pick</button> : null
}

/** A picker package's client half, reduced to the Factory hole it fills. */
const probeFlowPlugin = {
  inject: ['slots'],
  apply(ctx: Context) {
    ctx.slots.inject('workspace.picker.directoryFlow', () => ctx.slots.register({
      name: 'workspace.picker.directoryFlow',
    }, ProbeFlow))
  },
}

/**
 * The assembled consumer dialog over one existing Workspace.
 * @returns the runtime, with ui-workspace and its context-menu dependency mounted.
 */
async function bench(): Promise<SlotTestRuntime> {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
  runtime.ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
  runtime.releaseWorkspaceSource()
  // Directory picking goes through the probe occupant; the namespace only has
  // to be there for ui-workspace's inject to settle.
  runtime.remote.provideNamespaces({ directoryPicker: {} })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // Startup restoration opens a blank in the seeded Workspace; the picker
  // does not depend on that Session, so its creation stays pending.
  runtime.sessions.stubCreate(() => new Promise<SessionId>(() => {}))
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: ALPHA, title: 'Alpha', path: '/projects/alpha',
      sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.mount({ inject: [...inject], apply })
  await runtime.root.declare({} as never, ImportDialog as never)
  runtime.renderRoot()
  return runtime
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'choose' }))
}

describe('workspace.picker Factory', () => {
  it('lists the existing Workspaces inside a caller Modal and reports a chosen one through onPick', async () => {
    const runtime = await bench()
    try {
      await runtime.mount(probeFlowPlugin)
      openMenu()
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Alpha', ADD])
      fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
      expect(screen.getByRole('status').textContent).toBe(ALPHA)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(runtime.workspaces.calls.filter(call => call.method === 'create')).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it('creates the Workspace from the directory flow occupant before reporting it through onPick', async () => {
    const runtime = await bench()
    try {
      await runtime.mount(probeFlowPlugin)
      let resolve!: (workspace: WorkspaceView) => void
      runtime.workspaces.stub('create', () => new Promise<WorkspaceView>((settle) => { resolve = settle }))
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: ADD }))
      // Raising the flow closes the menu; the occupant's pick starts the adoption.
      expect(screen.queryByRole('menu')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'probe pick' }))
      expect(runtime.workspaces.calls.filter(call => call.method === 'create')).toEqual([
        { method: 'create', args: [{ path: '/tmp/project' }] },
      ])
      // The occupant sees the adoption in flight, and the caller hears nothing yet.
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'probe pick' }).disabled).toBe(true)
      expect(screen.getByRole('status').textContent).toBe('none')
      await act(async () => {
        resolve({
          workspaceId: 'w-project' as WorkspaceId, title: 'project', path: '/tmp/project',
          sessionIds: [], createdAt: '0', updatedAt: '0',
        })
      })
      expect(screen.getByRole('status').textContent).toBe('w-project')
      expect(screen.queryByRole('button', { name: 'probe pick' })).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })

  it('offers Add workspace only while a directory flow occupies the Factory hole', async () => {
    const runtime = await bench()
    try {
      openMenu()
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Alpha'])
      // A picker package activating later fills the hole; the open menu follows.
      const flow = await runtime.mount(probeFlowPlugin)
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Alpha', ADD])
      await flow.dispose()
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Alpha'])
    } finally {
      await runtime.dispose()
    }
  })
})
