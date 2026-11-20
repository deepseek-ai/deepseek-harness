// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { zh } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

const wid = (id: string) => id as WorkspaceId
function workspace(id: string, title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
const sessions: SessionListState = {
  ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
}
const noPendingInteraction: SessionStatusSnapshot = new Map()
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceSnapshot => ({
  items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})
function anchor(): { current: HTMLElement } {
  const element = document.createElement('button')
  element.getBoundingClientRect = () => ({
    top: 10, left: 20, width: 30, height: 40, right: 50, bottom: 50,
    x: 20, y: 10, toJSON: () => ({}),
  })
  return { current: element }
}

/**
 * Probe occupant of the directory-flow hole: records the latest owner
 * conversation so tests drive onPicked/onCancel/onError like a composed flow
 * package would, and renders a marker element while the flow is open.
 */
function flowProbe() {
  const probe: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => {
    probe.owner = owner
    return owner.open ? <div data-testid="directory-flow" data-busy={owner.busy} /> : null
  }) as never
  return { probe, renderSlot }
}

/** Manual occupancy source bound like the renderer would: flip() drives the hook like a real registration change. */
function occupancySource(initial = true) {
  let occupied = initial
  const listeners = new Set<() => void>()
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => occupied,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return {
    useDirectoryFlow,
    flip: (next: boolean) => {
      occupied = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function mount(
  items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')],
  createWorkspace = vi.fn(),
  occupancy = occupancySource(),
) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const anchorRef = anchor()
  document.body.append(anchorRef.current)
  onTestFinished(() => { anchorRef.current.remove() })
  const { probe, renderSlot } = flowProbe()
  let open = true
  let currentItems = items
  const renderPicker = () => (
    <WorkspacePicker
      open={open}
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useSessionStatus={hook(noPendingInteraction)}
      useSessionRetainInfo={() => undefined}
      usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
      useWorkspaces={hook(workspaceState(currentItems))}
      {...allowAllAccess}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
      useDirectoryFlow={occupancy.useDirectoryFlow}
      renderSlot={renderSlot}
      t={t}
    />
  )
  const view = render(renderPicker())
  return {
    view, onPick, onClose, createWorkspace, probe, occupancy, anchor: anchorRef.current,
    rerenderItems: (nextItems: readonly WorkspaceView[]) => {
      currentItems = nextItems
      view.rerender(renderPicker())
    },
    setOpen: (nextOpen: boolean) => {
      open = nextOpen
      view.rerender(renderPicker())
    },
  }
}

function chooseAdd(): void {
  fireEvent.click(screen.getByRole('menuitem', { name: '添加工作区…' }))
}

describe('WorkspacePicker', () => {
  it('shows the sole workspace without search and clears a query when the list shrinks', () => {
    const alpha = workspace('alpha', 'Alpha')
    const beta = workspace('beta', 'Beta')
    const b = mount([alpha])
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()

    b.rerenderItems([alpha, beta])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Beta' } })
    expect(screen.queryByRole('menuitem', { name: 'Alpha' })).toBeNull()
    b.rerenderItems([alpha])
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()

    b.rerenderItems([alpha, beta])
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toBeTruthy()
  })

  it('leaves search unfocused on touch and focuses it on mouse and keyboard reopen', () => {
    const choices = [workspace('alpha', 'Alpha'), workspace('beta', 'Beta')]
    const b = mount(choices)
    b.setOpen(false)
    const getSearch = () => screen.getByRole('searchbox', { name: '搜索工作区' })

    fireEvent.pointerDown(b.anchor, { pointerType: 'touch' })
    b.setOpen(true)
    expect(document.activeElement).not.toBe(getSearch())
    b.setOpen(false)

    fireEvent.pointerDown(b.anchor, { pointerType: 'mouse' })
    b.setOpen(true)
    expect(document.activeElement).toBe(getSearch())
    b.setOpen(false)

    fireEvent.pointerDown(b.anchor, { pointerType: 'touch' })
    fireEvent.keyDown(b.anchor, { key: 'Enter' })
    b.setOpen(true)
    expect(document.activeElement).toBe(getSearch())
  })

  it('filters the full list by displayed title and keeps matching workspaces in order', () => {
    const b = mount([
      workspace('late', 'Later Release'),
      ...Array.from({ length: 5 }, (_, index) => workspace(`workspace-${index}`, `Other ${index}`)),
      workspace('early', 'Earlier release'),
      workspace('default-workspace'),
    ])
    const search = screen.getByRole('searchbox', { name: '搜索工作区' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: '  rElEaSe  ' } })
    expect(screen.getAllByRole('menuitem', { name: /release/i }).map(entry => entry.textContent))
      .toEqual(['Later Release', 'Earlier release'])
    expect(screen.queryByRole('menuitem', { name: 'Other 0' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()

    fireEvent.change(search, { target: { value: '默认' } })
    expect(screen.getByRole('menuitem', { name: '默认工作区' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Later Release' })).toBeNull()
    fireEvent.change(search, { target: { value: '  ' } })
    expect(screen.getByRole('menuitem', { name: 'Other 0' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'release' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Later Release' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Earlier release' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('early'))
  })

  it('keeps the search and Add workspace available on a miss and clears the query on reopen', () => {
    const choices = [workspace('alpha', 'Alpha'), workspace('beta', 'Beta')]
    const b = mount(choices)
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索工作区' })
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toBe('未找到匹配的工作区')
    expect(screen.queryByRole('menuitem', { name: 'Alpha' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    fireEvent.keyDown(search, { key: 'Escape', isComposing: true })
    expect(b.onClose).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false)
    expect(b.onPick).not.toHaveBeenCalled()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(false)
    const add = screen.getByRole('menuitem', { name: '添加工作区…' })
    expect(document.activeElement).toBe(add)
    fireEvent.keyDown(add, { key: 'Escape' })
    expect(b.onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(b.anchor)
    b.setOpen(false)
    b.setOpen(true)

    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索工作区' }).value).toBe('')
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the no-match status when the directory flow is unavailable', () => {
    mount([workspace('alpha', 'Alpha'), workspace('beta', 'Beta')], vi.fn(), occupancySource(false))
    const search = screen.getByRole('searchbox', { name: '搜索工作区' })
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByRole('status').textContent).toBe('未找到匹配的工作区')
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
  })

  it('ranks name prefixes, substrings and fuzzy hits ahead of path matches', () => {
    const b = mount([
      { ...workspace('path', 'Archive'), path: '/projects/dsh/Archive' },
      workspace('fuzzy', 'deepseek-harness'),
      workspace('substring', 'Team DSH'),
      workspace('prefix', 'DSH release'),
    ])
    const search = screen.getByRole('searchbox', { name: '搜索工作区' })
    expect(screen.queryByRole('button', { name: '清除搜索' })).toBeNull()
    fireEvent.change(search, { target: { value: 'ＤＳＨ' } })
    expect(screen.getAllByRole('menuitem').map(entry => entry.textContent))
      .toEqual(['DSH release', 'Team DSH', 'deepseek-harness', 'Archive', '添加工作区…'])
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(b.onPick).toHaveBeenCalledWith(wid('prefix'))
  })

  it('matches every query term across names and paths while ignoring accents', () => {
    const b = mount([
      { ...workspace('first', 'Café'), path: '/projects/first/Café' },
      { ...workspace('second', 'Café'), path: '/checkouts/second/Café' },
    ])
    const search = screen.getByRole('searchbox', { name: '搜索工作区' })
    fireEvent.change(search, { target: { value: 'Cafe /checkouts/' } })
    expect(screen.getAllByRole('menuitem').map(entry => entry.textContent))
      .toEqual(['Café second/Café', '添加工作区…'])
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(b.onPick).toHaveBeenCalledWith(wid('second'))
  })

  it('filters same-title workspaces by a visible suffix or an undisplayed parent path', () => {
    const b = mount([
      { ...workspace('alpha', 'Shared'), path: '/projects/first/Shared' },
      { ...workspace('beta', 'Shared'), path: '/checkouts/second/Shared' },
    ])
    const search = screen.getByRole('searchbox', { name: '搜索工作区' })
    fireEvent.change(search, { target: { value: '  SECOND/SH  ' } })
    expect(screen.getAllByRole('menuitem').map(entry => entry.textContent))
      .toEqual(['Shared second/Shared', '添加工作区…'])

    fireEvent.change(search, { target: { value: '/checkouts/' } })
    expect(screen.getAllByRole('menuitem').map(entry => entry.textContent))
      .toEqual(['Shared second/Shared', '添加工作区…'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shared second/Shared' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('beta'))
  })

  it('labels same-title Workspaces with distinguishing path suffixes and forwards the selected id', () => {
    const b = mount([
      { ...workspace('alpha', 'Shared'), path: '/one/a/Shared' },
      { ...workspace('beta', 'Shared'), path: '/two/a/Shared' },
      workspace('gamma', 'Alone'),
    ])
    expect(screen.getAllByRole('menuitem').map(entry => entry.textContent))
      .toEqual(['Shared one/a/Shared', 'Shared two/a/Shared', 'Alone', '添加工作区…'])
    // The full path stays reachable when a narrow menu truncates the row.
    expect(screen.getByText('two/a/Shared').parentElement?.title).toBe('/two/a/Shared')
    expect(screen.getByRole('menuitem', { name: 'Alone' }).querySelector('[title]')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shared two/a/Shared' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('beta'))
  })

  it('opens the composed directory flow, adopts its picked path, and selects the returned Workspace', async () => {
    const created = { ...workspace('adopted'), path: '/tmp/project', title: 'project' }
    const createWorkspace = vi.fn(async () => created)
    const b = mount([workspace('alpha', 'Alpha')], createWorkspace)
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    chooseAdd()
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    await act(async () => { b.probe.owner!.onPicked('/tmp/project') })
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/tmp/project' })
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
    // Successful adoption withdraws the flow request.
    expect(screen.queryByTestId('directory-flow')).toBeNull()
  })

  it('raises the flow straight from the anchor gesture when adding is the only entry', () => {
    // Nothing to list and one action left: a one-row menu would offer no
    // choice, so the owner's open request lands in the flow itself.
    const b = mount([])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
    expect(b.onClose).toHaveBeenCalled()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
  })

  it('treats flow cancellation as a silent no-op', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onCancel() })
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
    expect(b.onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a non-Error adoption failure in the folder-error surface', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw 'permission denied' }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy()
    })
    expect(screen.getByRole('alert').textContent).toBe('permission denied')
    expect(b.probe.owner!.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(b.probe.owner!.open).toBe(true)
    expect(b.onPick).not.toHaveBeenCalled()
  })

  it('disables every menu action from flow open through adoption, and reports busy to the flow', async () => {
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    // The flow is open but nothing is picked yet: a chooser pending on the
    // host display must already block concurrent workspace actions.
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '添加工作区…' }).disabled).toBe(true)
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '添加工作区…' }).disabled).toBe(true)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('shows the flow-reported failure in the folder-error surface', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    expect(screen.getByRole('alert').textContent).toBe('no chooser installed')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('closes the folder-error surface when the user cancels', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    act(() => { b.probe.owner!.onError('no chooser installed') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits to show its menu until an optional anchor is available', () => {
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open useSessions={hook(sessions)} useWorkspaces={hook(workspaceState([workspace('alpha', 'Alpha')]))}
        useSessionStatus={hook(noPendingInteraction)}
        useSessionRetainInfo={() => undefined}
        usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
        {...allowAllAccess}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the menu up while the list baseline is still in flight', () => {
    const state: WorkspaceSnapshot = {
      ...workspaceState([]), phase: 'pending', state: 'loading',
    }
    const { renderSlot } = flowProbe()
    render(
      <WorkspacePicker
        open anchorRef={anchor()} useSessions={hook(sessions)} useWorkspaces={hook(state)}
        useSessionStatus={hook(noPendingInteraction)}
        useSessionRetainInfo={() => undefined}
        usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
        {...allowAllAccess}
        onPick={vi.fn()} onClose={vi.fn()} createWorkspace={vi.fn()}
        useDirectoryFlow={occupancySource().useDirectoryFlow} renderSlot={renderSlot} t={t}
      />,
    )
    // An empty list is not final yet: jumping into the directory flow here
    // would pre-empt the workspaces about to arrive.
    expect(screen.getByRole('status').textContent).toBe('正在加载工作区…')
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
  })

  it('shows no popover at all when nothing is listed and nothing can be added', () => {
    // A composition mounting this package without any directory-picker: the
    // hero anchor has neither a Workspace to pick nor a way to add one, so it
    // must not claim a choice with an empty menu.
    const b = mount([], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('holds the anchor gesture while an adoption is still settling', async () => {
    // The auto-open path obeys the same busy rule as the disabled menu entry:
    // an occupant that re-registers mid-adoption must not raise a second flow.
    let resolve!: (workspace: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>((settle) => { resolve = settle })
    const created = workspace('adopted')
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(() => pending))
    chooseAdd()
    act(() => { b.probe.owner!.onPicked('/tmp/project') })
    expect(b.probe.owner!.busy).toBe(true)
    // The list empties under the still-settling adoption (the workspace was
    // deleted elsewhere), which would otherwise make add the only entry.
    act(() => { b.rerenderItems([]) })
    expect(b.createWorkspace).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(created); await pending })
    expect(b.probe.owner!.busy).toBe(false)
  })

  it('hides the add entry while the directory-flow hole is empty', () => {
    mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
  })

  it('shows the add entry when a flow package activates after the first paint', () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
    // Registration changes flow through the subscription, no re-render needed.
    act(() => { b.occupancy.flip(true) })
    expect(screen.getByRole('menuitem', { name: '添加工作区…' })).toBeTruthy()
  })

  it('keeps Choose again inert while the flow occupant is gone, and snaps back a flow opened over an empty hole', async () => {
    const b = mount([workspace('alpha', 'Alpha')], vi.fn(async () => { throw new Error('adoption failed') }))
    chooseAdd()
    await act(async () => { b.probe.owner!.onPicked('/one/project') })
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '无法打开文件夹' })).toBeTruthy() })
    // The occupant unloads while the error dialog is up: retrying would open
    // a flow nobody can serve or cancel, so the button goes inert.
    act(() => { b.occupancy.flip(false) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新选择' }).disabled).toBe(true)
    // Cancel stays the way out, and the menu actions are usable again.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
  })

  it('withdraws an open flow when its occupant unloads, re-enabling the menu actions', () => {
    const b = mount([workspace('alpha', 'Alpha')])
    chooseAdd()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    // The flow plugin unloads mid-interaction (HMR): nobody is left to
    // cancel, so the owner withdraws and the actions come back.
    act(() => { b.occupancy.flip(false) })
    expect(b.probe.owner!.open).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Alpha' }).disabled).toBe(false)
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
  })
})
