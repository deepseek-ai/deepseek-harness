// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { DirectoryFlowOwnerProps, WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { createWorkspaceShortcutControls } from '../src/client/shortcuts.ts'
import { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } from '../src/client/stores.ts'
import { UNGROUPED_KEY } from '../src/client/tree.ts'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { en, zh } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)
const scrollIntoView = vi.fn()
beforeEach(() => {
  localStorage.clear()
  createWorkspaceViewStore().create().actions.setOrderBy('manual', {})
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
})

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: overrides.displayTitle ?? id, displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
  retainedBy: overrides.retainedBy ?? {},
})
const sessionState = (
  items: readonly SessionSummary[],
  overrides: Partial<SessionListState> & { main?: SessionId } = {},
): SessionListState => {
  const { main, ...stateOverrides } = overrides
  const state: SessionListState = {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    phase: 'ready',
    projectionsBySession: {},
    ...stateOverrides,
  }
  if (main === undefined) return state
  const row = state.byId[main]
  if (row === undefined) return state
  return {
    ...state,
    byId: { ...state.byId, [main]: { ...row, retainedBy: { ...row.retainedBy, mainView: 1 } } },
  }
}
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (
  items: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[] = [],
  pinnedSessionIds: readonly SessionId[] = [],
): WorkspaceSnapshot => ({
  items,
  archivedSessionIds,
  pinnedSessionIds,
  state: 'idle',
  phase: 'ready',
  error: null,
})
const noPendingInteraction: SessionStatusSnapshot = new Map()
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', dropEffect: '' } })
  fireEvent(row, event)
}

function dragData(): Pick<DataTransfer, 'effectAllowed' | 'dropEffect' | 'setData'> {
  return { effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn() }
}

// The default child stub: an open directory flow shows its marker; the two
// Session row lists stay empty (their entries have their own spec). A stub
// satisfies the generic render signature only with an erased owner type.
const renderDirectoryFlowOnly: WorkspaceBrowserProps['renderSlot'] = (name: string, owner: object) =>
  name === 'sidebar.workspaces.directoryFlow' && (owner as DirectoryFlowOwnerProps).open
    ? <div data-testid="directory-flow" />
    : null

function mount(overrides: Partial<WorkspaceBrowserProps> = {}) {
  const controls = createWorkspaceShortcutControls()
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    useShortcuts: select => select([]),
    useWorkspaceShortcuts: bindSnapshotSelector(controls.state),
    requestSearch: controls.search,
    requestAddWorkspace: controls.add,
    closeAddWorkspace: controls.closeAdd,
    setDirectoryBusy: controls.directoryBusy,
    requestSessionRename: controls.rename,
    dismissForkError: controls.dismissForkError,
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: hook(sessionState([])),
    useSessionStatus: hook(noPendingInteraction),
    useSessionRetainInfo: () => undefined,
    usePanelInfo, useResource,
    useWorkspaces: hook(workspaceState([])),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    startSession: vi.fn(),
    open: vi.fn(),
    searchSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
    notifyArchivedNotOpenable: vi.fn(),
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    unarchiveSession: vi.fn(async () => {}),
    insertWorkspaceBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace('created', [])),
    useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} }),
    useHostInfo: selector => selector({ home: undefined, isLoopback: true }),
    renderSlot: renderDirectoryFlowOnly,
    t,
    ...overrides,
  }
  const view = render(<WorkspaceBrowser {...props} />)
  return { view, props, store, controls }
}

/** Re-render with (possibly) changed props — WorkspaceBrowser has no side channel. */
function rerender(b: ReturnType<typeof mount>, overrides: Partial<WorkspaceBrowserProps>) {
  Object.assign(b.props, overrides)
  b.view.rerender(<WorkspaceBrowser {...b.props} />)
}

describe('WorkspaceBrowser', () => {
  it.each([{ messages: en, common: commonEn }, { messages: zh, common: commonZh }])('shows localized fork failures and dismisses them', ({ messages, common }) => {
    const b = mount({ t: makeTranslate(messages, common) })
    act(() => { b.controls.forkFailed('unavailable') })
    const first = screen.getByRole('alert')
    expect(first.textContent).toBe(messages['shortcut.noCompletedTurn'])
    act(() => { b.controls.dismissForkError(); b.controls.forkFailed('unavailable') })
    expect(screen.getByRole('alert')).not.toBe(first)
    act(() => { b.controls.forkFailed('failed') })
    expect(screen.getByRole('alert').textContent).toBe(messages['shortcut.forkFailed'])
    act(() => { b.controls.dismissForkError() })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['workspace', 'flat', 'ungrouped'] as const)('keeps %s recency independent of arrival order and saved manual positions', (mode) => {
    localStorage.clear()
    const preferences = createWorkspaceViewStore().create()
    preferences.actions.setGroupBy(mode === 'flat' ? 'flat' : 'workspace')
    const account = mode === 'ungrouped' ? UNGROUPED_KEY : 'alpha'
    preferences.actions.setSessionOrder(account, ['older', 'newer'], {})
    preferences.actions.setSessionOrder(UNGROUPED_KEY, ['older', 'newer'], {})
    preferences.actions.setSessionOrder(FLAT_SESSION_ORDER_KEY, ['older', 'newer'], {})
    preferences.actions.setGroupExpanded(account, true)
    preferences.actions.setGroupExpanded(UNGROUPED_KEY, true)
    localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ ...preferences.getSnapshot(), orderBy: 'updated' }))
    const b = mount({
      useSessions: hook(sessionState([summary('newer', 100)])),
      useWorkspaces: hook(workspaceState(mode === 'ungrouped' ? [] : [workspace(account, ['older', 'newer'])])),
    })
    const names = () => screen.getAllByRole('treeitem')
      .filter(row => row.getAttribute('aria-expanded') === null)
      .map(row => row.textContent?.includes('newer') ? 'newer' : 'older')
    expect(names()).toEqual(['newer'])
    rerender(b, { useSessions: hook(sessionState([summary('older', 20), summary('newer', 100)])) })
    expect(names()).toEqual(['newer', 'older'])
    rerender(b, { useSessions: hook(sessionState([summary('older', 80), summary('newer', 100)])) })
    expect(names()).toEqual(['newer', 'older'])
    rerender(b, { useSessions: hook(sessionState([summary('older', 120), summary('newer', 100)])) })
    expect(names()).toEqual(['older', 'newer'])
    rerender(b, { useSessions: hook(sessionState([summary('older', 80), summary('newer', 100)])) })
    expect(names()).toEqual(['newer', 'older'])
    expect(b.store.getSnapshot().sessionOrderByAccount[account]).toEqual(['older', 'newer'])
    b.view.unmount()
    const restored = mount({
      useSessions: hook(sessionState([summary('older', 80), summary('newer', 100)])),
      useWorkspaces: b.props.useWorkspaces,
    })
    expect(names()).toEqual(['newer', 'older'])
    act(() => { restored.store.actions.setOrderBy('manual', {}) })
    expect(names()).toEqual(['newer', 'older'])
  })

  it.each(['workspace', 'flat', 'ungrouped'] as const)('starts Manual from the current %s order and forgets discarded layouts', (mode) => {
    localStorage.clear()
    const preferences = createWorkspaceViewStore().create()
    preferences.actions.setGroupBy(mode === 'flat' ? 'flat' : 'workspace')
    const account = mode === 'flat' ? FLAT_SESSION_ORDER_KEY : mode === 'ungrouped' ? UNGROUPED_KEY : 'alpha'
    preferences.actions.setGroupExpanded(account, true)
    const b = mount({
      useSessions: hook(sessionState([summary('a', 30), summary('b', 20), summary('c', 10)])),
      useWorkspaces: hook(workspaceState(mode === 'ungrouped' ? [] : [workspace('alpha', ['c', 'a', 'b'])])),
    })
    const names = () => screen.getAllByRole('treeitem').filter(row => row.getAttribute('aria-expanded') === null)
      .map(row => row.querySelector('[class*="title"]')?.textContent)
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    expect(names()).toEqual(['a', 'b', 'c'])
    pick('手动排序')
    expect(names()).toEqual(['a', 'b', 'c'])
    const source = screen.getByText('c').closest('[role="treeitem"]') as HTMLElement
    const target = screen.getByText('a').closest('[role="treeitem"]') as HTMLElement
    target.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(target, 'drop', 102)
    expect(names()).toEqual(['c', 'a', 'b'])
    rerender(b, { useSessions: hook(sessionState([summary('a', 30), summary('b', 40), summary('c', 10)])) })
    expect(names()).toEqual(['c', 'a', 'b'])
    b.view.unmount()
    const restored = mount({ useSessions: b.props.useSessions, useWorkspaces: b.props.useWorkspaces })
    expect(names()).toEqual(['c', 'a', 'b'])
    expect(restored.store.getSnapshot().orderBy).toBe('manual')
    pick('最近更新')
    expect(names()).toEqual(['b', 'a', 'c'])
    pick('手动排序')
    expect(names()).toEqual(['b', 'a', 'c'])
  })

  it.each(['workspace', 'flat'] as const)('keeps the provisional blank first and time ties stable in %s recency', (groupBy) => {
    localStorage.clear()
    const preferences = createWorkspaceViewStore().create()
    preferences.actions.setGroupBy(groupBy)
    preferences.actions.setGroupExpanded('alpha', true)
    const b = mount({
      useSessions: hook(sessionState([
        summary('tie-b', 100), summary('blank', 1, { blank: true }), summary('tie-a', 100),
      ], { main: sid('blank') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['missing', 'tie-b', 'blank', 'tie-a'])])),
    })
    const rows = () => screen.getAllByRole('treeitem').filter(row => row.getAttribute('aria-expanded') === null)
    expect(rows().map(row => row.textContent)).toEqual([
      expect.stringContaining('新会话'), expect.stringContaining('tie-a'), expect.stringContaining('tie-b'),
    ])
    expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({})
    rerender(b, { useSessions: hook(sessionState([
      summary('tie-b', 100), summary('blank', 1), summary('tie-a', 100),
    ], { main: sid('blank') })) })
    expect(rows().map(row => row.textContent)).toEqual([
      expect.stringContaining('tie-a'), expect.stringContaining('tie-b'), expect.stringContaining('blank'),
    ])
    expect(b.store.getSnapshot().orderBy).toBe('updated')
  })

  it('moves focus into Workspace controls without selecting a Session while a main panel is active', () => {
    const panelInfo = { activePanelId: 'panel-a' as MainPanelId }
    const b = mount({
      usePanelInfo: hook(panelInfo),
      useSessions: hook(sessionState([summary('current', 1)], { main: sid('current') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['current'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const current = screen.getByText('current').closest('[role="treeitem"]')
    expect(current?.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
    const input = screen.getByPlaceholderText('搜索会话名称')
    expect(document.activeElement).toBe(input)
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    const add = screen.getByRole('button', { name: '添加工作区' })
    add.focus()
    fireEvent.click(add)
    expect(document.activeElement).toBe(add)
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    expect(panelInfo.activePanelId).toBe('panel-a')
    expect(b.props.open).not.toHaveBeenCalled()
    expect(b.props.startSession).not.toHaveBeenCalled()
  })

  it('workspace hover card shows a POSIX home descendant as ~', () => {
    vi.useFakeTimers()
    try {
      mount({
        useWorkspaces: hook(workspaceState([{
          ...workspace('project', []),
          path: '/home/u/Documents/project',
          title: 'Project',
        }])),
        useHostInfo: selector => selector({ home: '/home/u', isLoopback: true }),
      })
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes deleted Workspace view state only after the Workspace baseline is ready', async () => {
    const pending = {
      ...workspaceState([]),
      phase: 'pending' as const,
      state: 'loading' as const,
    }
    const b = mount({ useWorkspaces: hook(pending) })
    act(() => {
      b.store.actions.setGroupExpanded('deleted', true)
      b.store.actions.setSessionOrder('deleted', ['session'], {})
    })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ deleted: true })

    rerender(b, { useWorkspaces: hook(workspaceState([])) })
    await waitFor(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({})
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({})
    })
  })

  it.each(['workspace', 'flat', 'ungrouped'] as const)('retains the new Session position through a %s Workspace reconnect', (mode) => {
    const account = mode === 'flat' ? FLAT_SESSION_ORDER_KEY : mode === 'ungrouped' ? UNGROUPED_KEY : 'alpha'
    const old = summary('old', 10)
    const absent = summary('absent', 5)
    const blank = summary('blank', 1, { blank: true })
    const groups = (ids: string[]) => workspaceState(mode === 'ungrouped' ? [] : [workspace('alpha', ids)])
    const preferences = createWorkspaceViewStore().create()
    preferences.actions.setGroupBy(mode === 'flat' ? 'flat' : 'workspace')
    preferences.actions.setGroupExpanded(account, true)
    preferences.actions.setSessionOrder(account, ['old', 'absent'], {})
    const b = mount({
      useSessions: hook(sessionState([old, absent])),
      useWorkspaces: hook(groups(['old', 'absent'])),
    })
    const names = () => screen.getAllByRole('treeitem')
      .filter(row => row.getAttribute('aria-expanded') === null)
      .map(row => row.textContent)
    rerender(b, {
      useSessions: hook(sessionState([old, blank], { main: blank.id })),
      useWorkspaces: hook({ ...groups(['old', 'blank']), state: 'loading' }),
    })
    expect(names()).toEqual([expect.stringContaining('新会话'), expect.stringContaining('old')])
    expect(b.store.getSnapshot().sessionOrderByAccount[account]).toEqual(['blank', 'old', 'absent'])

    rerender(b, {
      useSessions: hook(sessionState([old, { ...blank, blank: false, updatedAt: 20 }], { main: blank.id })),
    })
    expect(names()).toEqual([expect.stringContaining('blank'), expect.stringContaining('old')])
    expect(b.store.getSnapshot().sessionOrderByAccount[account]).toEqual(['blank', 'old', 'absent'])

    rerender(b, {
      useSessions: hook(sessionState([old, absent, { ...blank, blank: false, updatedAt: 20 }], { main: blank.id })),
      useWorkspaces: hook(groups(['old', 'absent', 'blank'])),
    })
    expect(names()).toEqual([
      expect.stringContaining('blank'), expect.stringContaining('old'), expect.stringContaining('absent'),
    ])
    expect(b.store.getSnapshot().sessionOrderByAccount[account]).toEqual(['blank', 'old', 'absent'])
    rerender(b, {
      useSessions: hook(sessionState([old, { ...blank, blank: false, updatedAt: 20 }], { main: blank.id })),
      useWorkspaces: hook(groups(['old', 'blank'])),
    })
    expect(b.store.getSnapshot().sessionOrderByAccount[account]).toEqual(['blank', 'old', 'absent'])
  })

  it('reconciles a late blank and its first prompt while the sidebar is collapsed', async () => {
    const old = summary('old', 10)
    const blank = summary('blank', 1, { blank: true })
    const b = mount({
      wide: false,
      useSessions: hook(sessionState([old])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['old', 'blank'])])),
    })
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toBeUndefined()

    rerender(b, {
      useSessions: hook(sessionState([old, blank], { main: blank.id })),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old'])
    })

    rerender(b, {
      useSessions: hook(sessionState([old, { ...blank, blank: false, updatedAt: 20 }], { main: blank.id })),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old'])
    })

    rerender(b, { wide: true })
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining('blank'),
      expect.stringContaining('old'),
    ])
  })

  it('drops the obsolete timestamp ledger from persisted viewing state', async () => {
    localStorage.clear()
    localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
      groupBy: 'workspace',
      orderBy: 'manual',
      groupExpansion: {},
      sessionOrderByAccount: {},
      sessionUpdatedAtByAccount: { alpha: { old: 10 } },
    }))
    mount()
    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem('dsh.workspace.view.v5') ?? '{}') as Record<string, unknown>
      expect(persisted).not.toHaveProperty('sessionUpdatedAtByAccount')
    })
  })

  it('hides archived Sessions when a persisted v5 view has no archived filter', () => {
    const key = 'dsh.workspace.view.v5'
    const previous = localStorage.getItem(key)
    try {
      localStorage.setItem(key, JSON.stringify({
        groupBy: 'workspace', orderBy: 'manual', groupExpansion: { alpha: true }, sessionOrderByAccount: {},
      }))
      const b = mount({
        useSessions: hook(sessionState([summary('alive', 2), summary('gone', 1)])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['alive', 'gone'])], [sid('gone')])),
      })
      expect(b.store.getSnapshot().archivedFilter).toBeUndefined()
      expect(screen.getByText('alive')).toBeTruthy()
      expect(screen.queryByText('gone')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '全部对话（显示已归档）' }))
      expect(b.store.getSnapshot().archivedFilter).toBe('show')
      expect(screen.getByText('gone')).toBeTruthy()
    } finally {
      cleanup()
      if (previous === null) localStorage.removeItem(key)
      else localStorage.setItem(key, previous)
    }
  })

  it('renders the grouped tree by default and switches to the flat list via Group by', () => {
    const sessions = sessionState([summary('alpha-s', 2), summary('beta-s', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s']), workspace('beta', ['beta-s'])])),
    })
    expect(screen.getByText('工作区')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    // Sessions hidden while their group is folded.
    expect(screen.queryByText('alpha-s')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    expect(screen.getByText('分组方式')).toBeTruthy() // the menu heading label
    expect(screen.getAllByRole('separator')).toHaveLength(2)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '按工作区', '按工作区树', '单列表', '手动排序', '最近更新', '隐藏已归档', '全部对话（显示已归档）', '仅显示已归档',
    ])
    expect(screen.getByRole('menuitem', { name: '按工作区' }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '手动排序' }).querySelector('svg')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    // Store-driven flip: title changes, rows flatten newest-first, headers gone.
    expect(b.store.getSnapshot().groupBy).toBe('flat')
    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(screen.getByText('beta-s')).toBeTruthy()

    // Back to workspace grouping through the same menu.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    expect(screen.getByRole('menuitem', { name: '手动排序' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: '按工作区' }))
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
    expect(screen.getByText('工作区')).toBeTruthy()

    // Escape closes the menu without picking.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
  })

  it('picking 全部对话（显示已归档） keeps existing rows and reveals archived ones in place', () => {
    mount({
      useSessions: hook(sessionState([summary('kept', 2), summary('stored', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept', 'stored'])], [sid('stored')])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('kept')).toBeTruthy()
    expect(screen.queryByText('stored')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '全部对话（显示已归档）' }))
    expect(screen.getByText('kept')).toBeTruthy()
    expect(screen.getByText('stored')).toBeTruthy()
  })

  it('the archived filters are one exclusive choice and re-picking keeps it', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('kept', 2), summary('stored', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept', 'stored'])], [sid('stored')])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }

    // 仅显示已归档 hides the live rows and shows the archived one.
    pick('仅显示已归档')
    expect(b.store.getSnapshot().archivedFilter).toBe('only')
    expect(screen.queryByText('kept')).toBeNull()
    expect(screen.getByText('stored')).toBeTruthy()

    // Picking another filter replaces it: everything visible.
    pick('全部对话（显示已归档）')
    expect(b.store.getSnapshot().archivedFilter).toBe('show')
    expect(screen.getByText('kept')).toBeTruthy()
    expect(screen.getByText('stored')).toBeTruthy()

    // Re-picking the selected filter keeps it selected.
    pick('全部对话（显示已归档）')
    expect(b.store.getSnapshot().archivedFilter).toBe('show')
    expect(screen.getByText('kept')).toBeTruthy()
    expect(screen.getByText('stored')).toBeTruthy()

    // 隐藏已归档 is the explicit way back to the default hidden view.
    pick('隐藏已归档')
    expect(b.store.getSnapshot().archivedFilter).toBe('default')
    expect(screen.getByText('kept')).toBeTruthy()
    expect(screen.queryByText('stored')).toBeNull()
  })

  it('仅显示已归档 hides Workspaces without archived Sessions', () => {
    mount({
      useSessions: hook(sessionState([summary('kept', 2), summary('stored', 1)])),
      useWorkspaces: hook(workspaceState(
        [workspace('alpha', ['kept', 'stored']), workspace('beta', ['kept'])],
        [sid('stored')],
      )),
    })
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '仅显示已归档' }))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('beta')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '隐藏已归档' }))
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('the empty 仅显示已归档 view names its filter and offers the way back', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('kept', 2)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept'])])),
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '仅显示已归档' }))
    expect(screen.getByText('暂无已归档会话')).toBeTruthy()
    expect(screen.queryByText('暂无会话')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '查看其他会话' }))
    expect(b.store.getSnapshot().archivedFilter).toBe('default')
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('kept')).toBeTruthy()
    expect(screen.queryByText('暂无已归档会话')).toBeNull()
  })

  it('仅显示已归档 nests tree children of hidden Workspaces under the nearest shown ancestor', () => {
    mount({
      useSessions: hook(sessionState([summary('live', 2), summary('stored', 1)])),
      useWorkspaces: hook(workspaceState(
        [
          { ...workspace('root', ['live'], 'Projects'), path: '/projects' },
          workspace('child', ['stored'], 'Child'),
        ],
        [sid('stored')],
      )),
    })
    const choose = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    choose('按工作区树')
    const parentSection = screen.getByText('Projects').closest<HTMLElement>('[class*="groupSection"]')!
    expect(within(parentSection).getByText('Child')).toBeTruthy()

    // Projects keeps no archived Sessions, so Child rises to the top level.
    choose('仅显示已归档')
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.getByText('Child')).toBeTruthy()
  })

  it('keeps the picked archived filter across remounts through the view store', () => {
    const seats = {
      useSessions: hook(sessionState([summary('kept', 2), summary('stored', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept', 'stored'])], [sid('stored')])),
    }
    const b = mount(seats)
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '全部对话（显示已归档）' }))
    expect(b.store.getSnapshot().archivedFilter).toBe('show')

    cleanup()
    const remounted = mount(seats)
    expect(remounted.store.getSnapshot().archivedFilter).toBe('show')
    // The persisted group expansion also survives, so the rows are already out.
    expect(screen.getByText('stored')).toBeTruthy()
  })

  it('keeps Workspaces as siblings by default and restores the selected tree grouping', () => {
    const workspaces = hook(workspaceState([
      { ...workspace('root', [], 'Projects'), path: '/projects' },
      workspace('child', ['child-session'], 'Child'),
    ]))
    const sessions = hook(sessionState([summary('child-session', 1)]))
    const b = mount({ useWorkspaces: workspaces, useSessions: sessions })
    const parentSection = () => screen.getByText('Projects').closest<HTMLElement>('[class*="groupSection"]')!
    const choose = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
    expect(screen.getByText('Child')).toBeTruthy()
    expect(within(parentSection()).queryByText('Child')).toBeNull()
    choose('按工作区树')
    expect(b.store.getSnapshot().groupBy).toBe('workspace-tree')
    expect(within(parentSection()).getByText('Child')).toBeTruthy()
    fireEvent.click(screen.getByText('Projects'))
    expect(screen.queryByText('Child')).toBeNull()
    choose('按工作区')
    expect(screen.getByText('Child')).toBeTruthy()
    expect(within(parentSection()).queryByText('Child')).toBeNull()
    choose('按工作区树')
    expect(screen.queryByText('Child')).toBeNull()
    b.view.unmount()
    const restored = mount({ useWorkspaces: workspaces, useSessions: sessions })
    expect(restored.store.getSnapshot().groupBy).toBe('workspace-tree')
    expect(screen.queryByText('Child')).toBeNull()
    fireEvent.click(screen.getByText('Projects'))
    expect(within(parentSection()).getByText('Child')).toBeTruthy()
    choose('单列表')
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.getByText('child-session')).toBeTruthy()
  })

  it('persists flat-list drag order locally and applies Last updated within that account', async () => {
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const workspaces = workspaceState([
      workspace('alpha', ['one']),
      workspace('beta', ['two']),
    ])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaces),
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toBeUndefined()

    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const three = screen.getByText('three').closest('[role="treeitem"]') as HTMLElement
    three.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['two', 'three', 'one'])

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
        expect.stringContaining('one'), expect.stringContaining('two'), expect.stringContaining('three'),
      ])
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({})
    })

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '手动排序' }))
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    b.view.unmount()

    const restored = mount({ useSessions: hook(sessions), useWorkspaces: hook(workspaces) })
    expect(restored.store.getSnapshot().groupBy).toBe('flat')
    expect(restored.store.getSnapshot().orderBy).toBe('manual')
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('expands a group on click and opens a session row', () => {
    const open = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      open,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('alpha-s'))
    expect(open).toHaveBeenCalledWith(sid('alpha-s'))
    // Collapse hides the row again.
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('alpha-s')).toBeNull()
  })

  it('a title double-click asks for the rename dialog with the row title', () => {
    const requestSessionRename = vi.fn()
    const open = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 1, { displayTitle: 'Alpha session' })])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      requestSessionRename,
      open,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.doubleClick(screen.getByText('Alpha session'))
    expect(requestSessionRename).toHaveBeenCalledWith(sid('alpha-s'), 'Alpha session')
    expect(open).not.toHaveBeenCalled()
    // The flat list threads the same request.
    act(() => { b.store.actions.setGroupBy('flat') })
    fireEvent.doubleClick(screen.getByText('Alpha session'))
    expect(requestSessionRename).toHaveBeenCalledTimes(2)
  })

  it('renders both Session row lists for every visible row in the grouped tree and the flat list', () => {
    const rendered = vi.fn()
    const renderSlot: WorkspaceBrowserProps['renderSlot'] = (name: string, owner: object) => {
      rendered(name, owner)
      return null
    }
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      renderSlot,
    })
    expect(rendered).not.toHaveBeenCalledWith('sidebar.workspaces.session.menu.item', expect.anything())
    fireEvent.click(screen.getByText('alpha'))
    const owner = { sessionId: sid('alpha-s'), displayTitle: 'alpha-s' }
    expect(rendered).toHaveBeenCalledWith('sidebar.workspaces.session.menu.item', owner)
    expect(rendered).toHaveBeenCalledWith('sidebar.workspaces.session.row.action', owner)
    rendered.mockClear()
    act(() => { b.store.actions.setGroupBy('flat') })
    expect(rendered).toHaveBeenCalledWith('sidebar.workspaces.session.menu.item', owner)
    expect(rendered).toHaveBeenCalledWith('sidebar.workspaces.session.row.action', owner)
  })

  it('shows five sessions by default and clears transient show-all when the Workspace collapses', () => {
    const items = Array.from({ length: 7 }, (_, index) => summary(`session-${index + 1}`, 7 - index))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    fireEvent.click(screen.getByText('alpha'))
    for (const item of items.slice(0, 5)) expect(screen.getByText(item.displayTitle)).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.queryByText('session-7')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '展开其余 2 个会话' }))
    expect(screen.getByText('session-6')).toBeTruthy()
    expect(screen.getByText('session-7')).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()

    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: false })
    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 2 个会话' })).toBeTruthy()
  })

  it('keeps running sessions outside every batch quota and preserves their order after collapse', () => {
    const idle = Array.from({ length: 12 }, (_, index) => summary(`idle-${index + 1}`, 12 - index))
    const first = summary('running-first', 14, { running: true })
    const last = summary('running-last', 0, { running: true })
    const blank = summary('blank', 15, { blank: true })
    const items = [blank, first, ...idle, last]
    mount({
      useSessions: hook(sessionState(items, { main: blank.id })),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    const expectRows = (count: number) => {
      expect(screen.getAllByRole('treeitem').map(row =>
        within(row).getByText(/^(alpha|新会话|running-(first|last)|idle-\d+)$/u).textContent)).toEqual([
        'alpha', '新会话', 'running-first', ...idle.slice(0, count).map(item => item.displayTitle), 'running-last',
      ])
    }
    expectRows(5)
    fireEvent.click(screen.getByRole('button', { name: '展开其余 7 个会话' }))
    expectRows(10)
    fireEvent.click(screen.getByRole('button', { name: '展开其余 2 个会话' }))
    expectRows(12)
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expectRows(5)
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('alpha'))
    expectRows(5)
  })

  it('reveals a hidden session when live running status starts and folds it when the run ends', () => {
    const items = Array.from({ length: 12 }, (_, index) => summary(`session-${index + 1}`, 12 - index))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('session-12')).toBeNull()
    rerender(b, {
      useSessionStatus: hook<SessionStatusSnapshot>(new Map([[sid('session-12'), {
        running: true, pendingInteraction: undefined, completionUnread: false,
      }]])),
    })
    expect(screen.getByText('session-12')).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 6 个会话' })).toBeTruthy()
    rerender(b, {
      useSessionStatus: hook<SessionStatusSnapshot>(new Map([[sid('session-12'), {
        running: false, pendingInteraction: undefined, completionUnread: true,
      }]])),
    })
    expect(screen.queryByText('session-12')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 7 个会话' })).toBeTruthy()
  })

  it('keeps a parent with a running child visible outside the idle-session quota', () => {
    const items = Array.from({ length: 7 }, (_, index) => summary(`session-${index + 1}`, 7 - index))
    const child = summary('child', 0, { origin: 'subagent', running: true })
    mount({
      useSessions: hook(sessionState([...items, child], {
        projectionsBySession: {
          [sid('session-7')]: {
            state: 'ready', error: null,
            values: { subagentCatalog: [{ id: child.id, mode: 'continuable', label: 'child', createdAt: 1 }] },
          },
        },
      })),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('session-7')).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.queryByText('child')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 1 个会话' })).toBeTruthy()
  })

  it.each([false, true])('expands 17 ordinary sessions five at a time and resets after the final partial batch (blank: %s)', (withBlank) => {
    const ordinary = Array.from({ length: 17 }, (_, index) => summary(`session-${index + 1}`, 17 - index))
    const blank = summary('blank', 18, { blank: true })
    const items = withBlank ? [blank, ...ordinary] : ordinary
    mount({
      useSessions: hook(sessionState(items, withBlank ? { main: blank.id } : {})),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    if (!withBlank) fireEvent.click(screen.getByText('alpha'))
    const expectVisible = (count: number) => {
      for (const [index, item] of ordinary.entries()) {
        expect(screen.queryByText(item.displayTitle) !== null).toBe(index < count)
      }
      expect(screen.getAllByRole('treeitem')).toHaveLength(count + 1 + Number(withBlank))
      expect(screen.queryByText('新会话') !== null).toBe(withBlank)
    }
    expectVisible(5)
    const labels: string[] = []
    for (const [remaining, visible] of [[12, 10], [7, 15], [2, 17]] as const) {
      const overflow = screen.getByRole('button', { name: `展开其余 ${remaining} 个会话` })
      labels.push(overflow.textContent ?? '')
      expect(screen.queryByRole('button', { name: '收起' })).toBeNull()
      fireEvent.click(overflow)
      expectVisible(visible)
    }
    expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
    const collapse = screen.getByRole('button', { name: '收起' })
    labels.push(collapse.textContent ?? '')
    expect(labels).toMatchInlineSnapshot(`
      [
        "展开其余 12 个会话",
        "展开其余 7 个会话",
        "展开其余 2 个会话",
        "收起",
      ]
    `)
    fireEvent.click(collapse)
    expectVisible(5)
    fireEvent.click(screen.getByRole('button', { name: '展开其余 12 个会话' }))
    expectVisible(10)
    expect(screen.getByRole('button', { name: '展开其余 7 个会话' })).toBeTruthy()
  })

  it('keeps each Workspace batch limit independent when another Workspace expands or collapses', () => {
    const alpha = Array.from({ length: 17 }, (_, index) => summary(`alpha-${index + 1}`, 17 - index))
    const beta = Array.from({ length: 11 }, (_, index) => summary(`beta-${index + 1}`, 11 - index))
    mount({
      useSessions: hook(sessionState([...alpha, ...beta])),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', alpha.map(item => item.id)),
        workspace('beta', beta.map(item => item.id)),
      ])),
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('beta'))
    fireEvent.click(screen.getByRole('button', { name: '展开其余 12 个会话' }))
    expect(screen.getByText('alpha-10')).toBeTruthy()
    expect(screen.queryByText('alpha-11')).toBeNull()
    expect(screen.queryByText('beta-6')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开其余 6 个会话' }))
    expect(screen.getByText('beta-10')).toBeTruthy()
    expect(screen.queryByText('beta-11')).toBeNull()
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('alpha-6')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 12 个会话' })).toBeTruthy()
    expect(screen.getByText('beta-10')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '展开其余 1 个会话' }))
    expect(screen.getByText('beta-11')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText('beta-6')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 6 个会话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开其余 12 个会话' })).toBeTruthy()
  })

  it('keeps the blank New Session outside the five-row folding quota', () => {
    const ordinary = Array.from({ length: 6 }, (_, index) => summary(`session-${index + 1}`, 6 - index))
    const blank = summary('blank', 7, { blank: true })
    const b = mount({
      useSessions: hook(sessionState([blank, ...ordinary], { main: blank.id })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [blank.id, ...ordinary.map(item => item.id)])])),
    })
    expect(screen.getByText('新会话')).toBeTruthy()
    for (const item of ordinary.slice(0, 5)) expect(screen.getByText(item.displayTitle)).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 1 个会话' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '展开其余 1 个会话' }))
    expect(screen.getByText('session-6')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText('session-6')).toBeNull()

    rerender(b, {
      useSessions: hook(sessionState([{ ...blank, blank: false }, ...ordinary], { main: blank.id })),
    })
    expect(screen.getByText('blank')).toBeTruthy()
    expect(screen.queryByText('session-5')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 2 个会话' })).toBeTruthy()
  })

  it('pins the blank while collapsed drags keep an ordinary source visible', async () => {
    const ordinary = Array.from({ length: 6 }, (_, index) => summary(`session-${index + 1}`, 6 - index))
    const blank = summary('blank', 7, { blank: true })
    const b = mount({
      useSessions: hook(sessionState([blank, ...ordinary], { main: blank.id })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [blank.id, ...ordinary.map(item => item.id)])])),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha)
        .toEqual(['blank', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6'])
    })

    const blankRow = screen.getByText('新会话').closest('[role="treeitem"]') as HTMLElement
    expect(blankRow.draggable).toBe(false)
    fireEvent.dragStart(blankRow, { dataTransfer: dragData() })
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha)
      .toEqual(['blank', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6'])

    blankRow.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 200, toJSON: () => ({}),
    })
    const session5 = screen.getByText('session-5').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(session5, { dataTransfer: dragData() })
    fireDrag(blankRow, 'drop', 205)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha)
      .toEqual(['blank', 'session-5', 'session-1', 'session-2', 'session-3', 'session-4', 'session-6'])
    expect(screen.getByText('session-5')).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
  })

  it('reorders a newly exposed batch row while preserving the blank and hidden tail', () => {
    const ordinary = Array.from({ length: 12 }, (_, index) => summary(`session-${index + 1}`, 12 - index))
    const blank = summary('blank', 13, { blank: true })
    const b = mount({
      useSessions: hook(sessionState([blank, ...ordinary], { main: blank.id })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [blank.id, ...ordinary.map(item => item.id)])])),
    })
    fireEvent.click(screen.getByRole('button', { name: '展开其余 7 个会话' }))
    const source = screen.getByText('session-10').closest('[role="treeitem"]') as HTMLElement
    const target = screen.getByText('session-6').closest('[role="treeitem"]') as HTMLElement
    target.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(target, 'drop', 105)

    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual([
      'blank', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5',
      'session-10', 'session-6', 'session-7', 'session-8', 'session-9', 'session-11', 'session-12',
    ])
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.querySelector('[class*="title"]')?.textContent)).toEqual([
      '新会话', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5',
      'session-10', 'session-6', 'session-7', 'session-8', 'session-9',
    ])
    expect(screen.queryByText('session-11')).toBeNull()
    expect(screen.queryByText('session-12')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 2 个会话' })).toBeTruthy()
  })

  it('discards manual positions on recency selection and switches to Manual on drag', async () => {
    const initial = sessionState([summary('one', 3), summary('two', 2)])
    const b = mount({
      useSessions: hook(initial),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      const rows = screen.getAllByRole('treeitem').slice(1)
      expect(rows[0]?.textContent).toContain('one')
      expect(rows[1]?.textContent).toContain('two')
    })

    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(one, 'drop', 180)
    expect(b.store.getSnapshot().orderBy).toBe('updated')
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'drop', 180)
    expect(b.store.getSnapshot().orderBy).toBe('manual')
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '手动排序' }))
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    const updated = sessionState([summary('one', 4), summary('two', 2)])
    rerender(b, { useSessions: hook(updated) })
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({})
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('one')
    })

    const promoted = sessionState([summary('one', 4), summary('two', 5)])
    rerender(b, { useSessions: hook(promoted) })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({})
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
    })

    b.view.unmount()
    const restored = mount({
      useSessions: hook(promoted),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount).toEqual({})
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
  })

  it('hides archived rows in both modes once the archive set carries them', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('kept-s', 2), summary('gone-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('gone-s')).toBeTruthy()

    // The archive-set echo hides the row in grouped and flat modes.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])], [sid('gone-s')])) })
    expect(screen.queryByText('gone-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    expect(screen.getByText('kept-s')).toBeTruthy()
    expect(screen.queryByText('gone-s')).toBeNull()
  })

  it.each(['workspace', 'flat', 'ungrouped'] as const)(
    'keeps complete %s order through archived filters and both drag partitions',
    async (mode) => {
      const account = mode === 'flat' ? FLAT_SESSION_ORDER_KEY : mode === 'ungrouped' ? UNGROUPED_KEY : 'alpha'
      const saved = ['a', 'p', 'kept-archive', 'b', 'q', 'c']
      const preferences = createWorkspaceViewStore().create()
      preferences.actions.setGroupBy(mode === 'flat' ? 'flat' : 'workspace')
      preferences.actions.setGroupExpanded(account, true)
      preferences.actions.setSessionOrder(account, saved, {})
      const items = ['a', 'p', 'kept-archive', 'b', 'q', 'c', 'missing-archive']
        .map((id, index) => summary(id, 100 - index))
      const b = mount({
        useSessions: hook(sessionState(items)),
        useWorkspaces: hook(workspaceState(
          mode === 'ungrouped' ? [] : [workspace('alpha', items.map(item => item.id))],
          [sid('kept-archive'), sid('missing-archive')],
          [sid('p'), sid('q')],
        )),
      })
      const names = () => screen.getAllByRole('treeitem')
        .filter(row => row.getAttribute('aria-expanded') === null)
        .map(row => row.querySelector('[class*="title"]')?.textContent)
      expect(names()).toEqual(['p', 'q', 'a', 'b', 'c'])
      expect(b.store.getSnapshot().sessionOrderByAccount[account]).toEqual(saved)

      act(() => { b.store.actions.setArchivedFilter('only') })
      await waitFor(() => { expect(names()).toEqual(['kept-archive', 'missing-archive']) })
      expect(b.store.getSnapshot().sessionOrderByAccount[account]).toEqual(saved)
      act(() => { b.store.actions.setArchivedFilter('default') })
      await waitFor(() => { expect(names()).toEqual(['p', 'q', 'a', 'b', 'c']) })

      const dragBefore = (sourceId: string, targetId: string): void => {
        const source = screen.getByText(sourceId).closest('[role="treeitem"]') as HTMLElement
        const target = screen.getByText(targetId).closest('[role="treeitem"]') as HTMLElement
        target.getBoundingClientRect = () => ({
          top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
        })
        fireEvent.dragStart(source, { dataTransfer: dragData() })
        fireDrag(target, 'drop', 105)
      }
      dragBefore('b', 'a')
      expect(b.store.getSnapshot().sessionOrderByAccount[account])
        .toEqual(['b', 'a', 'p', 'kept-archive', 'q', 'c', 'missing-archive'])
      await waitFor(() => { expect(names()).toEqual(['p', 'q', 'b', 'a', 'c']) })
      dragBefore('q', 'p')
      expect(b.store.getSnapshot().sessionOrderByAccount[account])
        .toEqual(['b', 'a', 'q', 'p', 'kept-archive', 'c', 'missing-archive'])
      await waitFor(() => { expect(names()).toEqual(['q', 'p', 'b', 'a', 'c']) })
      b.view.unmount()

      const restored = mount({ useSessions: b.props.useSessions, useWorkspaces: b.props.useWorkspaces })
      expect(names()).toEqual(['q', 'p', 'b', 'a', 'c'])
      act(() => { restored.store.actions.setArchivedFilter('only') })
      await waitFor(() => { expect(names()).toEqual(['kept-archive', 'missing-archive']) })
    },
  )

  it('does not replace a saved flat order when the archived-only view is empty', () => {
    const preferences = createWorkspaceViewStore().create()
    preferences.actions.setGroupBy('flat')
    preferences.actions.setSessionOrder(FLAT_SESSION_ORDER_KEY, ['c', 'a', 'b'], {})
    const b = mount({
      useSessions: hook(sessionState([summary('a', 3), summary('b', 2), summary('c', 1)])),
    })
    act(() => { b.store.actions.setArchivedFilter('only') })
    expect(screen.queryByRole('treeitem')).toBeNull()
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['c', 'a', 'b'])
    act(() => { b.store.actions.setArchivedFilter('default') })
    expect(screen.getAllByRole('treeitem').map(row => row.querySelector('[class*="title"]')?.textContent))
      .toEqual(['c', 'a', 'b'])
  })

  it.each(['show', 'only'] as const)('does not open an archived row in the %s filter; it raises the not-openable notice instead', (filter) => {
    const open = vi.fn()
    const notifyArchivedNotOpenable = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('gone', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['gone'])], [sid('gone')])),
      open,
      notifyArchivedNotOpenable,
    })
    act(() => { b.store.actions.setArchivedFilter(filter) })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('gone'))
    expect(open).not.toHaveBeenCalled()
    expect(notifyArchivedNotOpenable).toHaveBeenCalledOnce()
    expect(screen.getByText('gone').closest('[role="treeitem"]')?.getAttribute('aria-description'))
      .toBe('已归档对话暂时无法查看，请取消归档后查看')
  })

  it('does not open an archived search result or clear its query; it raises the not-openable notice instead', async () => {
    const open = vi.fn()
    const notifyArchivedNotOpenable = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('gone', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['gone'])], [sid('gone')])),
      open,
      notifyArchivedNotOpenable,
    })
    act(() => { b.store.actions.setArchivedFilter('show') })
    fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
    const input = screen.getByPlaceholderText('搜索会话名称')
    fireEvent.change(input, { target: { value: 'gone' } })
    await act(async () => { await Promise.resolve() })
    const row = within(screen.getByRole('tree', { name: '搜索结果' })).getByRole('treeitem')
    fireEvent.click(row)
    expect(open).not.toHaveBeenCalled()
    expect(notifyArchivedNotOpenable).toHaveBeenCalledOnce()
    expect(row.getAttribute('aria-description')).toBe('已归档对话暂时无法查看，请取消归档后查看')
    expect((input as HTMLInputElement).value).toBe('gone')
  })

  it('offers unarchive on archived search results only', async () => {
    const unarchiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('alive', 2), summary('gone', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alive', 'gone'])], [sid('gone')])),
      unarchiveSession,
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '全部对话（显示已归档）' }))
    fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
    fireEvent.change(screen.getByPlaceholderText('搜索会话名称'), { target: { value: 'e' } })
    await act(async () => { await Promise.resolve() })
    const tree = screen.getByRole('tree', { name: '搜索结果' })
    expect(within(tree).getByText('alive')).toBeTruthy()
    expect(within(tree).getByText('gone')).toBeTruthy()
    const unarchive = within(tree).getAllByRole('button', { name: '取消归档' })
    expect(unarchive).toHaveLength(1)
    fireEvent.click(unarchive[0]!)
    expect(unarchiveSession).toHaveBeenCalledWith(sid('gone'))
  })

  it('renders a fork child as a top-level row without a session twist', () => {
    const parent = summary('parent-s', 2)
    const child = { ...summary('child-s', 1), parentId: parent.id }
    mount({
      useSessions: hook(sessionState([parent, child])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['parent-s', 'child-s'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('child-s')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull()
    expect(screen.getByText('child-s').closest('[role="treeitem"]')?.getAttribute('draggable')).toBe('true')
  })

  it('expands the target group before starting a session from its ＋', () => {
    const startSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      startSession,
    })
    startSession.mockImplementation(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    })
    expect(screen.queryByText('alpha-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在“alpha”中新建会话' }))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
  })

  it('auto-expands the Ungrouped bucket for a loose current session; its header has no menu and its ＋ is inert', () => {
    const startSession = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('loose', 1)], { main: sid('loose') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      startSession,
    })
    // The loose session's group is UNGROUPED_KEY: expanded by the effect.
    expect(screen.getByText('loose')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '工作区“未分组”的操作' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在“未分组”中新建会话' }))
    expect(startSession).not.toHaveBeenCalled()
  })

  it('keeps an already-expanded group when the selection moves within it', () => {
    const first = sessionState([summary('a', 2), summary('b', 1)], { main: sid('a') })
    const b = mount({
      useSessions: hook(first),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a', 'b'])])),
    })
    expect(screen.getByText('a')).toBeTruthy()
    // Selection hop inside the same group: the effect re-runs and leaves the
    // expansion list unchanged (no duplicate key, group still open).
    rerender(b, { useSessions: hook({ ...first, main: sid('b') }) })
    expect(screen.getByText('b')).toBeTruthy()
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('b')).toBeNull()
  })

  it('shows only the current blank session as the localized New Session, excluded from search', () => {
    const currentBlank = summary('alpha-blank', 9, { blank: true })
    const staleBlank = summary('beta-blank', 8, { blank: true })
    const sessions = sessionState(
      [currentBlank, staleBlank],
      { main: currentBlank.id },
    )
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['alpha-blank']), workspace('beta', ['beta-blank']),
      ])),
    })
    expect(screen.getByText('新会话')).toBeTruthy()
    expect(screen.queryByText('alpha-blank')).toBeNull()
    expect(screen.queryByText('beta-blank')).toBeNull()

    rerender(b, { useSessions: hook({ ...sessions, main: staleBlank.id }) })
    expect(screen.getAllByText('新会话')).toHaveLength(1)
    b.store.actions.setGroupBy('flat')
    rerender(b, {})
    expect(screen.getAllByText('新会话')).toHaveLength(1)
    // Search excludes blank rows entirely — neither the canonical stored
    // title nor the localized display label participates in matching.
    fireEvent.change(screen.getByPlaceholderText('搜索会话名称'), { target: { value: 'new session' } })
    expect(screen.queryByText('新会话')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('搜索会话名称'), { target: { value: '新会话' } })
    expect(screen.queryByText('新会话')).toBeNull()
  })

  it.each(['workspace', 'flat', 'ungrouped'] as const)('keeps a new blank first across %s mode switches and enables drag after the first prompt', (mode) => {
    localStorage.clear()
    const preferences = createWorkspaceViewStore().create()
    preferences.actions.setGroupBy(mode === 'flat' ? 'flat' : 'workspace')
    const account = mode === 'flat' ? FLAT_SESSION_ORDER_KEY : mode === 'ungrouped' ? UNGROUPED_KEY : 'alpha'
    preferences.actions.setGroupExpanded(account, true)
    const groups = (ids: string[]) => hook(workspaceState(mode === 'ungrouped' ? [] : [workspace('alpha', ids)]))
    const b = mount({
      useSessions: hook(sessionState([summary('old', 100), summary('mid', 200)])),
      useWorkspaces: groups(['old', 'mid']),
    })
    const names = () => screen.getAllByRole('treeitem').filter(row => row.getAttribute('aria-expanded') === null)
      .map(row => row.querySelector('[class*="title"]')?.textContent)
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    pick('手动排序')
    pick('最近更新')
    rerender(b, {
      useSessions: hook(sessionState([
        summary('old', 100), summary('mid', 200), summary('blank', 1, { blank: true }),
      ], { main: sid('blank') })),
      useWorkspaces: groups(['old', 'mid', 'blank']),
    })
    expect(names()).toEqual(['新会话', 'mid', 'old'])
    expect(b.store.getSnapshot().orderBy).toBe('updated')
    pick('手动排序')
    expect(names()).toEqual(['新会话', 'mid', 'old'])
    pick('最近更新')
    const blank = screen.getByText('新会话').closest('[role="treeitem"]') as HTMLElement
    expect(blank.draggable).toBe(false)
    const old = screen.getByText('old').closest('[role="treeitem"]') as HTMLElement
    old.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(blank, { dataTransfer: dragData() })
    fireDrag(old, 'drop', 180)
    expect(names()).toEqual(['新会话', 'mid', 'old'])
    b.view.unmount()
    const restored = mount({ useSessions: b.props.useSessions, useWorkspaces: b.props.useWorkspaces })
    expect(names()).toEqual(['新会话', 'mid', 'old'])
    rerender(restored, { useSessions: hook(sessionState([
      summary('old', 100), summary('mid', 200), summary('blank', 300),
    ], { main: sid('blank') })) })
    expect(names()).toEqual(['blank', 'mid', 'old'])
    const ordinaryBlank = screen.getByText('blank').closest('[role="treeitem"]') as HTMLElement
    expect(ordinaryBlank.draggable).toBe(true)
    const restoredOld = screen.getByText('old').closest('[role="treeitem"]') as HTMLElement
    restoredOld.getBoundingClientRect = () => old.getBoundingClientRect()
    fireEvent.dragStart(ordinaryBlank, { dataTransfer: dragData() })
    fireDrag(restoredOld, 'drop', 180)
    expect(names()).toEqual(['mid', 'old', 'blank'])
    rerender(restored, {
      useSessions: hook(sessionState([
        summary('old', 100), summary('mid', 200), summary('blank', 300), summary('new-blank', 1, { blank: true }),
      ], { main: sid('new-blank') })),
      useWorkspaces: groups(['old', 'mid', 'blank', 'new-blank']),
    })
    expect(names()).toEqual(['新会话', 'mid', 'old', 'blank'])
    pick('最近更新')
    expect(names()).toEqual(['新会话', 'blank', 'mid', 'old'])
    pick('手动排序')
    expect(names()).toEqual(['新会话', 'blank', 'mid', 'old'])
  })

  it('shows local metadata matches immediately, then clears back to the grouped tree', async () => {
    vi.useFakeTimers()
    try {
      const sessions = sessionState([
        summary('needle-row', 2, { displayTitle: 'Needle row' }),
        summary('other-row', 1, { displayTitle: 'Other row' }),
      ])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-row', 'other-row'])])),
      })
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
      fireEvent.change(input, { target: { value: 'needle' } })
      const resultTree = screen.getByRole('tree', { name: '搜索结果' })
      expect(screen.getByText('Needle row')).toBeTruthy()
      expect(screen.queryByText('Other row')).toBeNull()
      const status = screen.getByRole('status')
      expect(status.getAttribute('aria-label')).toBe('正在搜索会话历史…')
      // Local matches already show, so only one skeleton row trails them.
      expect(status.childElementCount).toBe(1)
      expect(resultTree.contains(status)).toBe(false)

      fireEvent.change(input, { target: { value: 'zzz' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('无匹配会话')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
      expect(input.value).toBe('')
      expect(screen.getByRole('tree', { name: '会话' })).toBeTruthy()
      // Clicking the field row focuses the input (wide mode).
      fireEvent.click(input.parentElement as HTMLElement)
      expect(document.activeElement).toBe(input)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses an empty search on outside click but keeps a non-empty query expanded', () => {
    mount()
    const search = screen.getByRole('button', { name: '搜索会话' })
    fireEvent.click(search)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    fireEvent.change(input, { target: { value: 'kept' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    expect(input.value).toBe('kept')
  })

  it('opens a Host content hit, exits search, and reveals its hidden grouped row', async () => {
    createWorkspaceViewStore().create().actions.setGroupBy('workspace-tree')
    createWorkspaceViewStore().create().actions.setGroupExpanded('root', false)
    vi.useFakeTimers()
    try {
      const open = vi.fn()
      const searchSessions = vi.fn(async () => ({
        items: [{ sessionId: sid('body-hit'), snippet: '…the waterfall token appears here…' }],
        hasMore: true,
      }))
      const b = mount({
        useSessions: hook(sessionState([
          summary('newest-1', 6),
          summary('newest-2', 5),
          summary('newest-3', 4),
          summary('newest-4', 3),
          summary('newest-5', 2),
          summary('body-hit', 1, { displayTitle: 'Research notes' }),
        ])),
        useWorkspaces: hook(workspaceState([
          { ...workspace('root', []), path: '/projects' },
          workspace('research', [
            'newest-1', 'newest-2', 'newest-3', 'newest-4', 'newest-5', 'body-hit',
          ], 'Research Workspace'),
        ])),
        open,
        searchSessions,
      })
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
      fireEvent.change(input, { target: { value: 'waterfall token' } })
      expect(screen.getByRole('status', { name: '正在搜索会话历史…' })).toBeTruthy()
      expect(screen.queryByText('Research notes')).toBeNull()

      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      expect(searchSessions).toHaveBeenCalledWith('waterfall token', expect.any(AbortSignal))
      expect(screen.getByText('Research notes')).toBeTruthy()
      expect(screen.getByText('Research Workspace')).toBeTruthy()
      expect(screen.getByText('…the waterfall token appears here…')).toBeTruthy()
      expect(screen.getByText('仅显示前 20 条结果，请缩小搜索范围。')).toBeTruthy()
      fireEvent.click(screen.getByRole('treeitem'))
      expect(open).toHaveBeenCalledWith(sid('body-hit'))
      expect(input.value).toBe('')
      expect(screen.queryByRole('tree', { name: '搜索结果' })).toBeNull()
      expect(screen.getByRole('tree', { name: '会话' })).toBeTruthy()
      expect(b.store.getSnapshot().groupExpansion).toEqual({ root: true, research: true })
      const targetRow = screen.getByText('Research notes').closest('[role="treeitem"]')
      expect(targetRow).toBeTruthy()
      expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.instances.at(-1)).toBe(targetRow)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for authoritative Workspace membership before revealing a grouped search result', async () => {
    const sessions = sessionState([
      summary('newest-1', 6),
      summary('newest-2', 5),
      summary('newest-3', 4),
      summary('newest-4', 3),
      summary('newest-5', 2),
      summary('target', 1, { displayTitle: 'Needle session' }),
    ])
    const pending = { ...workspaceState([]), phase: 'pending' as const, state: 'loading' as const }
    const b = mount({ useSessions: hook(sessions), useWorkspaces: hook(pending) })
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('treeitem'))

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(b.store.getSnapshot().groupExpansion).toEqual({})

    rerender(b, {
      useWorkspaces: hook(workspaceState([workspace('research', [
        'newest-1', 'newest-2', 'newest-3', 'newest-4', 'newest-5', 'target',
      ])])),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({ research: true })
      expect(screen.getByText('Needle session')).toBeTruthy()
    })
    const targetRow = screen.getByText('Needle session').closest('[role="treeitem"]')
    expect(scrollIntoView.mock.instances.at(-1)).toBe(targetRow)
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()
  })

  it('waits for the reconnect baseline before resolving reveal membership', async () => {
    const sessions = sessionState([
      summary('newest-1', 6),
      summary('newest-2', 5),
      summary('newest-3', 4),
      summary('newest-4', 3),
      summary('newest-5', 2),
      summary('target', 1, { displayTitle: 'Needle session' }),
    ])
    const reconnecting = {
      ...workspaceState([workspace('stale', [...sessions.ids])]),
      state: 'loading' as const,
    }
    const b = mount({ useSessions: hook(sessions), useWorkspaces: hook(reconnecting) })
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('treeitem'))

    expect(b.store.getSnapshot().groupExpansion).toEqual({})
    expect(scrollIntoView).not.toHaveBeenCalled()

    rerender(b, {
      useWorkspaces: hook(workspaceState([workspace('current', [...sessions.ids])])),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({ current: true })
      expect(screen.getByText('Needle session')).toBeTruthy()
    })
    const targetRow = screen.getByText('Needle session').closest('[role="treeitem"]')
    expect(scrollIntoView.mock.instances.at(-1)).toBe(targetRow)
    expect(b.store.getSnapshot().groupExpansion).not.toHaveProperty('stale')
  })

  it('reveals every session when a search result is beyond the initial five-row quota', () => {
    const items = Array.from({ length: 17 }, (_, index) => summary(`session-${index + 1}`, 17 - index))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
    fireEvent.change(input, { target: { value: 'session-11' } })
    fireEvent.click(screen.getByRole('treeitem'))

    expect(b.props.open).toHaveBeenCalledWith(sid('session-11'))
    expect(input.value).toBe('')
    for (const item of items) expect(screen.getByText(item.displayTitle)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
    expect(scrollIntoView.mock.instances.at(-1)).toBe(screen.getByText('session-11').closest('[role="treeitem"]'))
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.queryByText('session-11')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开其余 12 个会话' }))
    expect(screen.getByText('session-10')).toBeTruthy()
    expect(screen.queryByText('session-11')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 7 个会话' })).toBeTruthy()
  })

  it('keeps the bounded group projection when the revealed result is already within it', () => {
    const sessions = sessionState([
      summary('target', 6, { displayTitle: 'Needle session' }),
      summary('second', 5),
      summary('third', 4),
      summary('fourth', 3),
      summary('fifth', 2),
      summary('hidden', 1),
    ])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('research', [...sessions.ids])])),
    })
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('treeitem'))

    expect(screen.getByText('Needle session')).toBeTruthy()
    expect(screen.queryByText('hidden')).toBeNull()
    expect(screen.getByRole('button', { name: '展开其余 1 个会话' })).toBeTruthy()
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('cancels a pending row reveal when a new search begins', () => {
    const sessions = sessionState([summary('target', 1, { displayTitle: 'Needle session' })])
    const pending = { ...workspaceState([]), phase: 'pending' as const, state: 'loading' as const }
    const b = mount({ useSessions: hook(sessions), useWorkspaces: hook(pending) })
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('treeitem'))

    fireEvent.change(input, { target: { value: 'another query' } })
    fireEvent.change(input, { target: { value: '' } })
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('research', ['target'])])) })

    expect(b.store.getSnapshot().groupExpansion).toEqual({})
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('returns search navigation to the flat list and scrolls to the selected row', () => {
    const open = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([
        summary('target', 2, { displayTitle: 'Needle session' }),
        summary('other', 1),
      ])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['target', 'other'])])),
      open,
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
    fireEvent.change(input, { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('treeitem'))

    expect(open).toHaveBeenCalledWith(sid('target'))
    expect(input.value).toBe('')
    expect(screen.queryByRole('tree', { name: '搜索结果' })).toBeNull()
    const targetRow = screen.getByText('Needle session').closest('[role="treeitem"]')
    expect(targetRow).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(scrollIntoView.mock.instances.at(-1)).toBe(targetRow)
    expect(b.store.getSnapshot().groupExpansion).toEqual({})
  })

  it('bounds programmatic search input to a schema-valid request without splitting an astral character', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => ({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话名称')
      expect(input.maxLength).toBe(500)
      fireEvent.change(input, { target: { value: 'y'.repeat(501) } })
      expect(input.value).toBe('y'.repeat(500))
      const expected = `prefix${'x'.repeat(493)}`
      fireEvent.change(input, {
        target: { value: `prefix\0${'x'.repeat(493)}😀tail` },
      })

      expect(input.value).toBe(expected)
      expect(input.value.length).toBe(499)
      expect(input.value).not.toContain('\0')
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(searchSessions).toHaveBeenCalledOnce()
      expect(searchSessions).toHaveBeenCalledWith(expected, expect.any(AbortSignal))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps local matches without a warning when Host search fails', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => { throw new Error('index unavailable') })
      mount({
        useSessions: hook(sessionState([
          summary('local-hit', 1, { displayTitle: 'Needle title' }),
        ])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['local-hit'])])),
        searchSessions,
      })
      fireEvent.change(screen.getByPlaceholderText('搜索会话名称'), {
        target: { value: 'needle' },
      })
      expect(screen.getByText('Needle title')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Needle title')).toBeTruthy()
      expect(screen.queryByText('内容搜索暂不可用，仅显示名称匹配。')).toBeNull()
      expect(screen.queryByText('无匹配会话')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a superseded request and ignores its stale result', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst!: (value: {
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }) => void
      const first = new Promise<{
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }>((resolve) => { resolveFirst = resolve })
      const searchSessions = vi.fn((query: string, _signal: AbortSignal) => query === 'first'
        ? first
        : Promise.resolve({
          items: [{ sessionId: sid('second-hit'), snippet: 'second excerpt' }],
          hasMore: false,
        }))
      mount({
        useSessions: hook(sessionState([
          summary('first-hit', 2, { displayTitle: 'Old result' }),
          summary('second-hit', 1, { displayTitle: 'Fresh result' }),
        ])),
        searchSessions,
      })
      const input = screen.getByPlaceholderText('搜索会话名称')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      const firstSignal = searchSessions.mock.calls[0]?.[1] as AbortSignal
      expect(firstSignal.aborted).toBe(false)

      fireEvent.change(input, { target: { value: 'second' } })
      expect(firstSignal.aborted).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Fresh result')).toBeTruthy()

      await act(async () => {
        resolveFirst({
          items: [{ sessionId: sid('first-hit'), snippet: 'stale excerpt' }],
          hasMore: false,
        })
        await Promise.resolve()
      })
      expect(screen.queryByText('Old result')).toBeNull()
      expect(screen.getByText('Fresh result')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a rejected request after it has been superseded', async () => {
    vi.useFakeTimers()
    try {
      let rejectFirst!: (reason: Error) => void
      const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
      const searchSessions = vi.fn((query: string) => query === 'first'
        ? first
        : Promise.resolve({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText('搜索会话名称')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      fireEvent.change(input, { target: { value: 'second' } })
      await act(async () => {
        rejectFirst(new Error('stale failure'))
        await Promise.resolve()
      })
      expect(screen.queryByText('内容搜索暂不可用，仅显示名称匹配。')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the no-sessions empty state in both modes and resolves an empty search', async () => {
    vi.useFakeTimers()
    try {
      const b = mount()
      expect(screen.getByText('暂无会话')).toBeTruthy()
      b.store.actions.setGroupBy('flat')
      rerender(b, {})
      expect(screen.getByText('暂无会话')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText('搜索会话名称'), { target: { value: 'x' } })
      // No matches yet, so the empty list shows two skeleton rows.
      expect(screen.getByRole('status', { name: '正在搜索会话历史…' }).childElementCount).toBe(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('无匹配会话')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail state renders icon controls that request expansion', () => {
    vi.useFakeTimers()
    try {
      const expandSidebar = vi.fn()
      const b = mount({ wide: false, expandSidebar })
      // No wide chrome in rail state.
      expect(screen.queryByText('工作区')).toBeNull()
      expect(screen.queryByPlaceholderText('搜索会话名称')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
      // The wide flip mounts the input and focuses it after the slide.
      rerender(b, { wide: true })
      const input = screen.getByPlaceholderText('搜索会话名称')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(input)
      // Wide search button is decorative (tabIndex -1, no expand call).
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the rail-opened search expanded when the initiating click reaches document', () => {
    vi.useFakeTimers()
    try {
      const b = mount({ wide: false })
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      rerender(b, { wide: true })
      // In the browser the rail click keeps bubbling to document after the
      // wide flip mounted the outside-click listener, with the unmounted rail
      // button as its target — outside searchRoot. It must not dismiss the
      // search it just opened.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: '搜索会话' }).getAttribute('aria-expanded')).toBe('true')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(screen.getByPlaceholderText('搜索会话名称'))
      // The gesture has settled: outside clicks dismiss the search again.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: '搜索会话' }).getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail add-workspace raises the directory flow in place, with no menu and no expansion', () => {
    const expandSidebar = vi.fn()
    mount({ wide: false, expandSidebar, useWorkspaces: hook(workspaceState([workspace('alpha', [])])) })
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }))
    expect(expandSidebar).not.toHaveBeenCalled()
    // Adding is the header's only action, so the gesture IS that action: no
    // one-row popover, and existing workspaces stay in the tree below.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'alpha' })).toBeNull()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
  })

  it('hides the add button when no directory-flow occupant is composed', () => {
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => false, subscribe: () => () => {} }),
    })
    // Nothing to add with, so the header offers no dead button.
    expect(screen.queryByRole('button', { name: '添加工作区' })).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('uses the full expanded Workspace section when resolving a Workspace drop half', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    const sessions = sessionState(Array.from({ length: 5 }, (_, index) => summary(`beta-${index}`, index)))
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', sessions.ids),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    fireEvent.click(screen.getByText('beta'))
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let targetSection = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (targetSection.parentElement?.getAttribute('role') !== 'tree') {
      targetSection = targetSection.parentElement as HTMLElement
    }
    targetSection.getBoundingClientRect = () => ({
      top: 100, bottom: 300, left: 0, right: 200, width: 200, height: 200, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    // y=190 is below the header row but still in the top half of the whole
    // expanded section, so the target is before beta rather than after it.
    fireDrag(targetSection, 'drop', 190)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('draws the first Workspace insertion boundary on the scroll container', () => {
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
      ])),
    })
    const source = screen.getByText('beta').closest('[role="treeitem"]') as HTMLElement
    let firstSection = screen.getByText('alpha').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (firstSection.parentElement?.getAttribute('role') !== 'tree') {
      firstSection = firstSection.parentElement as HTMLElement
    }
    firstSection.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(firstSection, 'dragOver', 105)
    expect(firstSection.parentElement?.className).toContain('listTopDropActive')
    const marker = firstSection.parentElement?.previousElementSibling
    expect(marker?.className).toContain('listTopDropIndicator')
  })

  it('accepts a document-level drop and commits the last Workspace marker on drag end', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let target = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (target.parentElement?.getAttribute('role') !== 'tree') {
      target = target.parentElement as HTMLElement
    }
    target.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(target, 'dragOver', 105)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(source)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('persists a grouped drag locally and skips no-op drops', () => {
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const rows = screen.getAllByRole('treeitem').slice(1) // drop the group header
    const [one, , three] = rows as [HTMLElement, HTMLElement, HTMLElement]
    three.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34, x: 0, y: 200, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    // Drop on the top half of "three": insert one before three.
    fireDrag(three, 'dragOver', 205)
    fireDrag(three, 'drop', 205)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one', 'three'])

    // Dropping right back onto its own position is a no-op — top half
    // (anchor = itself) and bottom half (anchor = the next root) alike.
    fireEvent.dragStart(one, { dataTransfer })
    one.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one', 'three'])
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(one, 'drop', 130)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one', 'three'])
  })

  it('drags a pinned row by moving its position in the complete Session sequence', () => {
    const sessions = sessionState([
      summary('one', 4), summary('two', 3), summary('three', 2), summary('four', 1),
    ])
    createWorkspaceViewStore().create().actions.setSessionOrder('alpha', ['three', 'one', 'four', 'two'], {})
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState(
        [workspace('alpha', ['one', 'two', 'three', 'four'])], [], [sid('one'), sid('two')],
      )),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining('one'), expect.stringContaining('two'),
      expect.stringContaining('three'), expect.stringContaining('four'),
    ])
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    one.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(two, { dataTransfer: dragData() })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['three', 'two', 'one', 'four'])
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining('two'), expect.stringContaining('one'),
      expect.stringContaining('three'), expect.stringContaining('four'),
    ])

    // Dropping the trailing pinned row after the leading one restates the
    // current block: a no-op that writes nothing.
    const oneAgain = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const twoAgain = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    twoAgain.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(oneAgain, { dataTransfer: dragData() })
    fireDrag(twoAgain, 'drop', 130)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['three', 'two', 'one', 'four'])
  })

  it('keeps pinned and unpinned rows in separate drag domains', () => {
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])], [], [sid('one')])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    for (const row of [one, two]) {
      row.getBoundingClientRect = () => ({
        top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
      })
    }
    const before = b.store.getSnapshot().sessionOrderByAccount.alpha

    // A pinned source ignores unpinned targets…
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'dragOver', 105)
    fireDrag(two, 'drop', 105)
    fireEvent.dragEnd(one)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(before)

    // …and an unpinned source ignores pinned targets.
    fireEvent.dragStart(two, { dataTransfer: dragData() })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    fireEvent.dragEnd(two)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(before)
  })

  it('ignores a pinned drop whose pin state moved in flight', () => {
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState(
        [workspace('alpha', ['one', 'two', 'three'])], [], [sid('one'), sid('two')],
      )),
    })
    fireEvent.click(screen.getByText('alpha'))
    const before = b.store.getSnapshot().sessionOrderByAccount.alpha
    const markTarget = (): HTMLElement => {
      const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
      two.getBoundingClientRect = () => ({
        top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
      })
      return two
    }

    // The target unpins in flight: its id left the pinned block.
    let one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(markTarget(), 'dragOver', 105)
    rerender(b, {
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])], [], [sid('one')])),
    })
    fireEvent.dragEnd(screen.getByText('one').closest('[role="treeitem"]') as HTMLElement)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(before)

    // The source unpins in flight.
    rerender(b, {
      useWorkspaces: hook(workspaceState(
        [workspace('alpha', ['one', 'two', 'three'])], [], [sid('one'), sid('two')],
      )),
    })
    one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(markTarget(), 'dragOver', 105)
    rerender(b, {
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])], [], [sid('two')])),
    })
    fireEvent.dragEnd(screen.getByText('one').closest('[role="treeitem"]') as HTMLElement)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(before)
  })

  it('drags pinned rows within the flat pinned block and keeps cross-block targets inert', () => {
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([], [], [sid('one'), sid('two')])),
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toBeUndefined()
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    for (const row of [one, two]) {
      row.getBoundingClientRect = () => ({
        top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
      })
    }
    fireEvent.dragStart(two, { dataTransfer: dragData() })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['two', 'one', 'three'])

    // An unpinned source ignores pinned targets.
    const three = screen.getByText('three').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(three, { dataTransfer: dragData() })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    fireEvent.dragEnd(three)
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['two', 'one', 'three'])
  })

  it('persists Ungrouped drag order in both modes', async () => {
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
    })
    fireEvent.click(screen.getByText('未分组'))

    const dragAfter = (sourceTitle: string, targetTitle: string): void => {
      const source = screen.getByText(sourceTitle).closest('[role="treeitem"]') as HTMLElement
      const target = screen.getByText(targetTitle).closest('[role="treeitem"]') as HTMLElement
      target.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      fireEvent.dragStart(source, { dataTransfer: dragData() })
      fireDrag(target, 'drop', 180)
    }

    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    dragAfter('two', 'one')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['three', 'one', 'two'])

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
        expect.stringContaining('one'), expect.stringContaining('two'), expect.stringContaining('three'),
      ])
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({})
    })
    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])

    b.view.unmount()
    const restored = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('ignores a drag whose source left the group in flight', () => {
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    // The host dropped "one" from the workspace account while the drag is in
    // flight: the source index is gone but the drop still resolves its anchor.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['two'])])) })
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireDrag(two, 'drop', 155)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toBeUndefined()
  })

  it('drag end without a drop clears markers; bottom-half drop appends past the last row', () => {
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    fireEvent.dragEnd(one)
    // The drag ended: rows no longer accept drops.
    fireDrag(two, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toBeUndefined()

    // Bottom half of the last row: append (anchor omitted).
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(two, 'dragOver', 180)
    fireDrag(two, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
  })

  it('accepts a document-level drop and commits the last Session marker on drag end', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('one', 2), summary('two', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'dragOver', 180)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(one)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
  })

  it('labels an unrenamed default Workspace in the reader’s language and every other title verbatim', () => {
    const renameWorkspace = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', [], 'default-workspace'),
        workspace('beta', [], 'default-workspace backup'),
      ])),
      renameWorkspace,
    })
    expect(screen.getByRole('button', { name: '工作区“默认工作区”的操作' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '工作区“default-workspace backup”的操作' })).toBeTruthy()
    // The dialog edits the text on screen, and the stored title — not that
    // text — decides whether confirming saves. So confirming the untouched
    // prefill pins the localized name and the row stops following the language.
    fireEvent.click(screen.getByRole('button', { name: '工作区“默认工作区”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(screen.getByLabelText<HTMLInputElement>('工作区名称').value).toBe('默认工作区')
    expect(screen.queryByRole('alert')).toBeNull()
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '重命名' })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), '默认工作区')
  })

  it('renames a workspace through the row menu dialog', async () => {
    let resolveRename!: () => void
    const renameWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveRename = resolve }))
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha'), workspace('beta', [], 'Beta')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = screen.getByLabelText<HTMLInputElement>('工作区名称')
    expect(input.value).toBe('Alpha')
    // Unchanged and blank names stay blocked.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    // A duplicate of another workspace's title shows the inline conflict.
    fireEvent.change(input, { target: { value: ' Beta ' } })
    expect(screen.getByRole('alert').textContent).toBe('已存在名为“Beta”的工作区。')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Gamma')
    // While renaming: input disabled, close blocked, Enter ignored.
    expect(input.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { resolveRename() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rename via Enter, failure surfaces the error, Cancel closes', async () => {
    const renameWorkspace = vi.fn(async () => { throw new Error('rename conflict') })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = screen.getByLabelText<HTMLInputElement>('工作区名称')
    // Enter with a blocked draft (unchanged) does nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Renamed')
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('rename conflict') })
    // The dialog stays for retry; typing clears the error; Cancel closes.
    fireEvent.change(input, { target: { value: 'Renamed2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports non-Error rename failures as text', async () => {
    const renameWorkspace = vi.fn(async () => { throw 'denied' })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('confirms Workspace deletion, explains retention, and blocks duplicate submission', async () => {
    let resolveDelete!: () => void
    const deleteWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve }))
    const browser = mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', ['session'], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    const dialog = screen.getByRole('dialog', { name: '删除工作区' })
    expect(dialog.textContent).toContain('将把“Alpha”从工作区列表中移除')
    expect(dialog.textContent).toContain('文件夹与会话记录会保留')
    expect(dialog.textContent).toContain('其会话将显示在“未分组”下')

    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '删除工作区' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteWorkspace).toHaveBeenCalledOnce()
    expect(deleteWorkspace).toHaveBeenCalledWith(wid('alpha'))
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('正在删除工作区…')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    await act(async () => { resolveDelete() })
    // RPC success alone does not close: the component waits until its
    // useWorkspaces projection has committed the removal, preventing a stale
    // Workspace frame from leaking into the next gesture.
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    rerender(browser, { useWorkspaces: hook(workspaceState([])) })
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('keeps the delete dialog open on failure and allows retry or cancellation', async () => {
    const deleteWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockRejectedValueOnce('denied')
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '删除工作区' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('storage unavailable') })
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除工作区' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('Cancel, Escape, and Close dismiss deletion without calling the action', () => {
    const deleteWorkspace = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    }
    open()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    open()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(deleteWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('search hides drag affordances (rows are not draggable during search)', () => {
    const sessions = sessionState([summary('needle-a', 2, { displayTitle: 'Needle A' })])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-a'])])),
    })
    fireEvent.change(screen.getByPlaceholderText('搜索会话名称'), { target: { value: 'needle' } })
    const row = screen.getByText('Needle A').closest('[role="treeitem"]') as HTMLElement
    expect(row.hasAttribute('draggable')).toBe(false)
  })
})


describe('Workspace tree grouping', () => {
  beforeEach(() => {
    createWorkspaceViewStore().create().actions.setGroupBy('workspace-tree')
  })
  const root = { ...workspace('root', ['root-session'], 'Projects'), path: '/projects' }
  const team = workspace('team', ['team-session'], 'Team')
  const child = { ...workspace('child', ['child-session'], 'Child'), path: '/projects/team/child' }
  const section = (title: string) => screen.getByText(title).closest<HTMLElement>('[class*="groupSection"]')!

  it('adopts a parent directory and opens its Session without confirmation', async () => {
    const b = mount({
      useWorkspaces: hook(workspaceState([child])),
      createWorkspace: vi.fn(async () => root),
      renderSlot: ((_name: string, owner: DirectoryFlowOwnerProps) => owner.open
        ? <button onClick={() => { owner.onPicked('/projects') }}>Pick directory</button> : null) as WorkspaceBrowserProps['renderSlot'],
    })
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pick directory' }))
    await waitFor(() => { expect(b.props.startSession).toHaveBeenCalledWith(wid('root')) })
    expect(b.props.createWorkspace).toHaveBeenCalledWith({ path: '/projects' })
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(b, { useWorkspaces: hook(workspaceState([child, root])) })
    expect(within(section('Projects')).getByText('Child')).toBeTruthy()
  })

  it('nests newly registered ancestors and children while retaining each Workspace session', () => {
    const b = mount({
      useSessions: hook(sessionState([summary('root-session', 1), summary('team-session', 2), summary('child-session', 3)])),
      useWorkspaces: hook(workspaceState([child, root])),
    })
    expect(within(section('Projects')).getByText('Child')).toBeTruthy()
    rerender(b, { useWorkspaces: hook(workspaceState([child, team, root])) })
    expect(within(section('Projects')).getByText('Team')).toBeTruthy()
    expect(within(section('Team')).getByText('Child')).toBeTruthy()
    expect(within(section('Team')).queryByText('root-session')).toBeNull()
    expect(within(section('Projects')).getByText('root-session')).toBeTruthy()
    expect(within(section('Team')).getByText('team-session')).toBeTruthy()
    expect(screen.getAllByText('Child')).toHaveLength(1)
    fireEvent.click(screen.getByText('Child'))
    expect(within(section('Child')).getByText('child-session')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '在“Projects”中新建会话' }))
    expect(b.props.startSession).toHaveBeenCalledWith(root.workspaceId)
    rerender(b, { useWorkspaces: hook(workspaceState([child, root])) })
    expect(screen.queryByText('Team')).toBeNull()
    expect(within(section('Projects')).getByText('Child')).toBeTruthy()
  })

  it('restores collapsed ancestors and keeps the flat view independent', () => {
    const b = mount({ useWorkspaces: hook(workspaceState([root, team, child])) })
    fireEvent.click(screen.getByText('Projects'))
    expect(screen.queryByText('Team')).toBeNull()
    b.view.unmount()
    const restored = mount({ useWorkspaces: b.props.useWorkspaces })
    expect(screen.queryByText('Child')).toBeNull()
    fireEvent.click(screen.getByText('Projects'))
    expect(screen.getByText('Child')).toBeTruthy()
    act(() => { restored.store.actions.setGroupBy('flat') })
    expect(screen.queryByText('Projects')).toBeNull()
    act(() => { restored.store.actions.setGroupBy('workspace-tree') })
    expect(screen.getByText('Child')).toBeTruthy()
  })

  it('drops after an expanded parent through its last descendant', () => {
    const outside = { ...workspace('outside', []), path: '/outside' }
    const tail = { ...workspace('tail', []), path: '/tail' }
    const b = mount({ useWorkspaces: hook(workspaceState([outside, root, team, child, tail])) })
    section('Projects').getBoundingClientRect = () => ({
      top: 0, bottom: 200, left: 0, right: 200, width: 200, height: 200,
      x: 0, y: 0, toJSON: () => ({}),
    })
    const source = screen.getByText('outside').closest('[role="treeitem"]')!
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(section('Child'), 'dragOver', 190)
    fireDrag(section('Child'), 'drop', 190)
    fireEvent.dragEnd(source)
    expect(b.props.insertWorkspaceBefore).toHaveBeenCalledExactlyOnceWith(wid('outside'), wid('tail'))
  })

  it('avoids a Host reorder when only descendants separate adjacent siblings', () => {
    const outside = { ...workspace('outside', []), path: '/outside' }
    const b = mount({ useWorkspaces: hook(workspaceState([root, child, outside])) })
    section('outside').getBoundingClientRect = () => ({
      top: 0, bottom: 200, left: 0, right: 200, width: 200, height: 200,
      x: 0, y: 0, toJSON: () => ({}),
    })
    const source = screen.getByText('Projects').closest('[role="treeitem"]')!
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(section('outside'), 'drop', 10)
    fireEvent.dragEnd(source)
    expect(b.props.insertWorkspaceBefore).not.toHaveBeenCalled()
  })

  it('moves a parent with its descendants while preserving their order', () => {
    const outside = { ...workspace('outside', []), path: '/outside' }
    const other = workspace('other', [])
    const b = mount({ useWorkspaces: hook(workspaceState([root, team, child, other, outside])) })
    const source = screen.getByText('Projects').closest('[role="treeitem"]')!
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(section('outside'), 'drop', 100)
    fireEvent.dragEnd(source)
    expect(b.props.insertWorkspaceBefore).toHaveBeenCalledExactlyOnceWith(root.workspaceId, undefined)
    rerender(b, { useWorkspaces: hook(workspaceState([team, child, other, outside, root])) })
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      'outside', 'Projects', 'Team', 'Child', 'other',
    ])
    expect(within(section('Team')).getByText('Child')).toBeTruthy()
  })

  it('keeps a saved ancestor collapse and highlights the current descendant', () => {
    const b = mount({ useWorkspaces: hook(workspaceState([root, team, child])) })
    fireEvent.click(screen.getByText('Projects'))
    rerender(b, {
      useSessions: hook(sessionState([summary('child-session', 1)], { main: sid('child-session') })),
    })
    expect(screen.queryByText('Child')).toBeNull()
    expect(b.store.getSnapshot().groupExpansion.root).toBe(false)
    expect(section('Projects').querySelector('[class*="folderActive"]')).not.toBeNull()
  })

  it('reveals a search hit without persisting default-expanded ancestors', () => {
    const b = mount({
      useWorkspaces: hook(workspaceState([root, team, child])),
      useSessions: hook(sessionState([summary('child-session', 1)])),
    })
    fireEvent.change(screen.getByPlaceholderText('搜索会话名称'), { target: { value: 'child-session' } })
    fireEvent.click(screen.getByRole('treeitem'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ child: true })
    expect(screen.getByText('child-session')).toBeTruthy()
  })

  it('keeps Workspace drag within its parent and uses the next displayed sibling as anchor', () => {
    const b = mount({ useWorkspaces: hook(workspaceState([
      workspace('alpha', []), { ...workspace('outside', []), path: '/elsewhere/outside' },
      workspace('beta', []), workspace('gamma', []), root,
    ])) })
    const alpha = screen.getByText('alpha').closest('[role="treeitem"]') as HTMLElement
    const beta = screen.getByText('beta').closest('[role="treeitem"]') as HTMLElement
    const outside = screen.getByText('outside').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(alpha, { dataTransfer: dragData() })
    fireDrag(beta.parentElement as HTMLElement, 'dragOver', 100)
    fireDrag(outside.parentElement as HTMLElement, 'dragOver', 100)
    fireDrag(outside.parentElement as HTMLElement, 'drop', 100)
    fireEvent.dragEnd(alpha)
    expect(b.props.insertWorkspaceBefore).not.toHaveBeenCalled()
    fireEvent.dragStart(beta, { dataTransfer: dragData() })
    fireDrag(alpha.parentElement as HTMLElement, 'drop', 100)
    fireEvent.dragEnd(beta)
    expect(b.props.insertWorkspaceBefore).not.toHaveBeenCalled()
    fireEvent.dragStart(alpha, { dataTransfer: dragData() })
    fireDrag(beta.parentElement as HTMLElement, 'drop', 100)
    fireEvent.dragEnd(alpha)
    expect(b.props.insertWorkspaceBefore).toHaveBeenCalledOnce()
    expect(b.props.insertWorkspaceBefore).toHaveBeenCalledWith(wid('alpha'), wid('gamma'))
  })
})
