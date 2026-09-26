// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MenuOpenState, SessionRowOwnerProps } from '../src/client/contract/slots.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { RowDragProps } from '../src/client/rows/Rows.tsx'
import {
  ProjectRowItem, SearchResultItem, SessionNodeItem as SessionNodeItemComponent,
} from '../src/client/rows/Rows.tsx'
import type { GroupNode, SearchResultNode, SessionNode } from '../src/client/tree.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as never
const tEn = makeTranslate(en, commonEn) as never

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** The row lists and child seats a Session row renders. */
type RowSlotName =
  | 'sidebar.workspaces.session.menu.item'
  | 'sidebar.workspaces.session.row.action'
  | 'sidebar.session.row.leading'
  | 'sidebar.session.row.hover'
type RowRenderSlot = PropsRenderSlots<RowSlotName>['renderSlot']
type SessionNodeItemProps = ComponentProps<typeof SessionNodeItemComponent>

const renderNoRowEntries: RowRenderSlot = () => null

// Direct row specs use the real required Slot share, empty unless the case supplies entries.
function SessionNodeItem({ renderSlot = renderNoRowEntries, onRenameRequest = () => {}, ...props }: Omit<
  SessionNodeItemProps, 'renderSlot' | 'onRenameRequest'
> & Partial<Pick<SessionNodeItemProps, 'renderSlot' | 'onRenameRequest'>>) {
  return <SessionNodeItemComponent {...props} renderSlot={renderSlot} onRenameRequest={onRenameRequest} />
}

/** Half detection reads the row rect; jsdom rects are all-zero by default. */
function stubRect(row: HTMLElement): void {
  row.getBoundingClientRect = () => ({
    top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34,
    x: 0, y: 100, toJSON: () => ({}),
  })
}

function dragProps(overrides: Partial<RowDragProps> = {}): RowDragProps {
  return {
    start: vi.fn(), active: false, marker: null,
    hover: vi.fn(), drop: vi.fn(), end: vi.fn(),
    ...overrides,
  }
}

/** Install the async browser clipboard and restore its prior host shape. */
function installClipboard(writeText: (text: string) => Promise<void>): () => void {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return () => {
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', prior)
  }
}

const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { ...dataTransfer } })
  fireEvent(row, event)
}

describe('workspace browser rows', () => {
  it('keeps the leading status cell in the hierarchy-free flat list', () => {
    const idle: SessionNode = {
      id: sid('flat'), title: 'Flat Session', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const view = render(<SessionNodeItem node={idle} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
    // The cell is the row's first element and holds nothing while the row is
    // idle without an occupant; the title follows it.
    const cell = screen.getByText('Flat Session').previousElementSibling
    expect(cell?.className).toMatch(/slot/)
    expect(cell?.children).toHaveLength(0)

    view.rerender(<SessionNodeItem node={{ ...idle, running: true }} currentId={undefined} now={0}
      onOpen={vi.fn()} t={t} />)
    // A row that gains a state dot keeps that dot in the same cell.
    expect(screen.getByText('Flat Session').previousElementSibling?.querySelector('[data-state="ongoing"]')).toBeTruthy()
  })

  it('renders a selected content-search row and opens only its session', () => {
    const onOpen = vi.fn()
    const result: SearchResultNode = {
      id: sid('result'),
      title: 'Result title',
      workspace: 'Workspace context',
      running: true,
      runningSubagentCount: 0,
      completed: false,
      archived: false,
      snippet: 'matching message excerpt',
    }
    render(<SearchResultItem result={result} currentId={result.id} onOpen={onOpen} onUnarchive={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Workspace context')).toBeTruthy()
    expect(screen.getByText('matching message excerpt')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(row.hasAttribute('draggable')).toBe(false)
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(result.id)
  })

  it.each([
    ['approval', '等待审批'],
    ['plan-review', '计划待审'],
    ['question', '等待回答'],
  ] as const)('shows %s ahead of running in search results', (pendingInteraction, label) => {
    const result: SearchResultNode = {
      id: sid(pendingInteraction), title: 'Needs input', workspace: 'Project',
      pendingInteraction, running: true, runningSubagentCount: 0, completed: false, archived: false,
    }
    render(<SearchResultItem result={result} currentId={undefined} onOpen={vi.fn()} onUnarchive={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('renders an active Workspace and keeps its create action separate from toggling', () => {
    const onToggle = vi.fn()
    const onCreate = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 1, expanded: true, containsCurrent: true, sessions: [],
    }
    render(<ProjectRowItem group={group} onToggle={onToggle} onCreate={onCreate} t={t}
      newShortcut={{ id: 'session.new' as never, label: 'New', aliases: [], binding: null,
        keys: ['Ctrl', 'N'], aria: 'Control+N', modified: true, conflicts: [], issue: null }} />)

    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: '在“Project”中新建会话' }).getAttribute('aria-keyshortcuts')).toBe('Control+N')
    fireEvent.click(screen.getByRole('button', { name: '在“Project”中新建会话' }))
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Project'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('renders and opens a selected running Session row', () => {
    const node: SessionNode = {
      id: sid('session'), title: 'Session', blank: false, running: true,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const onOpen = vi.fn()
    render(
      <SessionNodeItem node={node} currentId={node.id} now={0} onOpen={onOpen} t={t} />,
    )

    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.hasAttribute('aria-expanded')).toBe(false)
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull()
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(node.id)
  })

  it('keeps a row.action entry click in the strip, so a plain button does not open the row', () => {
    const node: SessionNode = {
      id: sid('session'), title: 'Session', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const onOpen = vi.fn()
    const pluginAction = vi.fn()
    const renderSlot: RowRenderSlot = (name: RowSlotName) => (name === 'sidebar.workspaces.session.row.action'
      ? <button type="button" onClick={pluginAction}>plugin</button>
      : null)
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} renderSlot={renderSlot} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'plugin' }))
    expect(pluginAction).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('treeitem'))
    expect(onOpen).toHaveBeenCalledWith(node.id)
  })

  it('marquees a clipped session title at a constant speed while the row is hovered', () => {
    vi.useFakeTimers()
    // jsdom implements no matchMedia; the stub answers the reduced-motion probe.
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    try {
      const node: SessionNode = {
        id: sid('clipped'), title: 'A Session Title Long Enough To Be Clipped (1)', blank: false,
        running: false, runningSubagentCount: 0, completed: false, updatedAt: 0,
        pinned: false, archived: false,
      }
      render(
        <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />,
      )
      const row = screen.getByRole('treeitem')
      const title = screen.getByText(node.title)
      // jsdom lays out nothing: the title's clipped geometry is stated outright.
      const geometry = (scrollWidth: number, clientWidth: number): void => {
        Object.defineProperty(title, 'scrollWidth', { value: scrollWidth, configurable: true })
        Object.defineProperty(title, 'clientWidth', { value: clientWidth, configurable: true })
      }

      geometry(320, 180)
      fireEvent.pointerEnter(row)
      // The first frame only records the clock; travel begins on the second.
      vi.advanceTimersByTime(16)
      expect(title.scrollLeft).toBe(0)
      expect(title.hasAttribute('data-scrolled')).toBe(false)
      expect(title.hasAttribute('data-clipped')).toBe(true)
      // Constant 30px/s: 1600ms of frames crawl 48px, and the moved title
      // publishes both fade-mask hooks — off its start, short of its far edge.
      vi.advanceTimersByTime(1600)
      expect(title.scrollLeft).toBeCloseTo(48, 5)
      expect(title.hasAttribute('data-scrolled')).toBe(true)
      expect(title.hasAttribute('data-clipped')).toBe(true)
      // The crawl clamps at the far edge and rests there under the pointer;
      // the right fade lifts so the final character reads at full strength.
      vi.advanceTimersByTime(10_000)
      expect(title.scrollLeft).toBe(140)
      expect(title.hasAttribute('data-clipped')).toBe(false)
      fireEvent.pointerLeave(row)
      expect(title.scrollLeft).toBe(0)
      expect(title.hasAttribute('data-scrolled')).toBe(false)
      expect(title.hasAttribute('data-clipped')).toBe(false)

      // A title that fits has no scroll range: hovering leaves it at its start.
      geometry(180, 180)
      fireEvent.pointerEnter(row)
      vi.advanceTimersByTime(1000)
      expect(title.scrollLeft).toBe(0)
      fireEvent.pointerLeave(row)

      // Overflow at the 8px jitter threshold also stays put.
      geometry(188, 180)
      fireEvent.pointerEnter(row)
      vi.advanceTimersByTime(1000)
      expect(title.scrollLeft).toBe(0)
      fireEvent.pointerLeave(row)

      // One pixel past the threshold crawls to its 9px extent.
      geometry(189, 180)
      fireEvent.pointerEnter(row)
      vi.advanceTimersByTime(1000)
      expect(title.scrollLeft).toBe(9)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('jumps a clipped title to its far edge under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })))
    try {
      const node: SessionNode = {
        id: sid('reduced-motion'), title: 'A Session Title Long Enough To Be Clipped (1)', blank: false,
        running: false, runningSubagentCount: 0, completed: false, updatedAt: 0,
        pinned: false, archived: false,
      }
      render(
        <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />,
      )
      const row = screen.getByRole('treeitem')
      const title = screen.getByText(node.title)
      Object.defineProperty(title, 'scrollWidth', { value: 320, configurable: true })
      Object.defineProperty(title, 'clientWidth', { value: 180, configurable: true })

      fireEvent.pointerEnter(row)
      expect(title.scrollLeft).toBe(140)
      expect(title.hasAttribute('data-scrolled')).toBe(true)
      expect(title.hasAttribute('data-clipped')).toBe(false)
      fireEvent.pointerLeave(row)
      expect(title.scrollLeft).toBe(0)
      expect(title.hasAttribute('data-scrolled')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns a marqueed title to its start in one step and cancels the crawl', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    try {
      const node: SessionNode = {
        id: sid('instant-return'), title: 'A Session Title Long Enough To Be Clipped (1)', blank: false,
        running: false, runningSubagentCount: 0, completed: false, updatedAt: 0,
        pinned: false, archived: false,
      }
      render(
        <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />,
      )
      const row = screen.getByRole('treeitem')
      const title = screen.getByText(node.title)
      Object.defineProperty(title, 'scrollWidth', { value: 320, configurable: true })
      Object.defineProperty(title, 'clientWidth', { value: 180, configurable: true })
      const scrollTo = vi.fn()
      Object.defineProperty(title, 'scrollTo', { value: scrollTo, configurable: true })

      fireEvent.pointerEnter(row)
      vi.advanceTimersByTime(160)
      fireEvent.pointerLeave(row)
      // Browsers receive the explicit instant behavior so mid-crawl positions
      // never ease; the return is one step.
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'instant' })
      // Leaving cancels the crawl rather than letting it finish under the mask.
      const settled = scrollTo.mock.calls.length
      vi.advanceTimersByTime(1000)
      expect(scrollTo.mock.calls.length).toBe(settled)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('shows the green done dot only on a finished, unviewed session (live activity wins the slot)', () => {
    const renderRow = (over: Partial<SessionNode>) => render(
      <SessionNodeItem
        node={{
          id: sid('s1'), title: 'One', blank: false, running: false,
          runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false, ...over,
        }}
        currentId={undefined} now={0} onOpen={vi.fn()} t={t}
      />,
    )
    const stateDot = (view: ReturnType<typeof renderRow>) =>
      view.container.querySelector('[data-state]')
    // No completion reminder, not running: no state dot at all.
    const plain = renderRow({})
    expect(stateDot(plain)).toBeNull()
    plain.unmount()
    // Completed while unviewed: the green done dot.
    const done = renderRow({ completed: true })
    expect(done.container.querySelector('[data-state="done"]')).not.toBeNull()
    done.unmount()
    // Running wins the slot: the animated ongoing dot, no done dot.
    const running = renderRow({ completed: true, running: true })
    expect(running.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(running.container.querySelector('[data-state="done"]')).toBeNull()
    running.unmount()
    // Descendant activity also wins until the last running descendant stops.
    const delegated = renderRow({ completed: true, runningSubagentCount: 1 })
    expect(delegated.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(delegated.container.querySelector('[data-state="done"]')).toBeNull()
  })

  it('shows descendant activity without describing an idle parent as running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: false,
        runningSubagentCount: 2, completed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()
      expect(screen.getByText('2 个子智能体运行中')).toBeTruthy()
      expect(screen.queryByText('进行中')).toBeNull()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('2 个子智能体运行中')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps descendant activity secondary while the parent is running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: true,
        runningSubagentCount: 1, completed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelectorAll('[data-state="ongoing"]')).toHaveLength(1)
      expect(screen.getByText('进行中')).toBeTruthy()
      expect(screen.getByText('1 个子智能体运行中')).toBeTruthy()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('进行中')).toHaveLength(2)
      expect(screen.getAllByText('1 个子智能体运行中')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps child activity as a secondary status while user attention is primary', () => {
    const node: SessionNode = {
      id: sid('owner'), title: 'Needs input', blank: false, pendingInteraction: 'question',
      running: false, runningSubagentCount: 1, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).not.toBeNull()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(screen.getByText('1 个子智能体运行中')).toBeTruthy()
  })

  it('shows the green done dot on a finished search result row', () => {
    render(<SearchResultItem
      result={{
        id: sid('result'), title: 'Done', workspace: 'Workspace', running: false,
        runningSubagentCount: 0, completed: true, archived: false,
      }}
      currentId={undefined} onOpen={vi.fn()} onUnarchive={vi.fn()} t={t}
    />)
    expect(screen.getByRole('treeitem').querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('workspace row menu opens on the ellipsis, renames, and shows the danger delete row', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const onToggle = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: onRename, delete: onDelete }} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '工作区“Project”的操作' }))
    // Opening the menu neither toggles the group nor renames yet.
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: '删除工作区' }).className).toMatch(/danger/)
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(onRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '工作区“Project”的操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRename).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.click(screen.getByRole('button', { name: '工作区“Project”的操作' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('workspace hover card shows its details and copies the full directory path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      // Card body: full title + cwd + absolute creation time.
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText('/projects/project')).toBeTruthy()
      expect(screen.getByText(/^创建于 \d+年\d+月\d+日 /)).toBeTruthy()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制: /projects/project' })) })
      expect(writeText).toHaveBeenCalledWith('/projects/project')
      expect(screen.getByRole('status').textContent).toBe('已复制')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it.each(['hover', 'focus'] as const)('shows only the new Session tooltip while its action owns %s', (trigger) => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      const create = screen.getByRole('button', { name: '在“Project”中新建会话' })
      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('/projects/project')).toBeTruthy()

      if (trigger === 'hover') {
        fireEvent.mouseEnter(create)
        act(() => { vi.advanceTimersByTime(500) })
      } else {
        fireEvent.keyDown(document, { key: 'Tab' })
        fireEvent.focus(create)
      }
      expect(screen.getByRole('tooltip').textContent).toBe('新会话')
      expect(screen.queryByText('/projects/project')).toBeNull()

      if (trigger === 'hover') fireEvent.mouseLeave(create, { relatedTarget: row })
      else fireEvent.blur(create, { relatedTarget: row })
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(screen.getByText('/projects/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps workspace details hidden when the pointer first enters its new Session action', () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      const create = screen.getByRole('button', { name: '在“Project”中新建会话' })
      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      fireEvent.mouseEnter(create)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('tooltip').textContent).toBe('新会话')
      expect(screen.queryByText('/projects/project')).toBeNull()

      fireEvent.mouseLeave(create, { relatedTarget: row })
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(screen.getByText('/projects/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('workspace hover card shows a POSIX home descendant as ~ and still copies the full path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/home/u/Documents/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
      expect(screen.queryByText('/home/u/Documents/project')).toBeNull()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制: /home/u/Documents/project' })) })
      expect(writeText).toHaveBeenCalledWith('/home/u/Documents/project')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('workspace hover card without a directory omits the path and copy action', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: undefined, createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText(/^创建于 \d+年\d+月\d+日 /)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^复制:/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('workspace hover card leaves a Windows path verbatim', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: 'C:\\Users\\u\\project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="C:\\Users\\u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('C:\\Users\\u\\project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ungrouped bucket renders no workspace menu', () => {
    const group: GroupNode = {
      key: '', workspaceId: undefined, cwd: undefined, createdAt: undefined, label: 'Ungrouped',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    expect(screen.queryByRole('button', { name: /工作区/ })).toBeNull()
  })

  it('blank New Session rows carry no menu, no time label, and no hover-card time', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s-blank'), title: 'ignored', blank: true, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
      }
      const rendered = vi.fn()
      const renderSlot: RowRenderSlot = (name: RowSlotName) => { rendered(name); return null }
      render(<SessionNodeItem node={node} currentId={node.id} now={0} onOpen={vi.fn()} renderSlot={renderSlot} t={t} />)
      // The placeholder has no content yet: no row verbs (neither list is
      // asked for anything), no "now" stamp.
      expect(screen.queryByRole('button', { name: /会话.*的操作/ })).toBeNull()
      expect(rendered).not.toHaveBeenCalled()
      expect(screen.queryByText('刚刚')).toBeNull()
      // The hover card keeps title + status but drops the timestamp line.
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('新会话').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('空闲')).toBeTruthy()
      expect(screen.queryByText('刚刚')).toBeNull()
      expect(screen.getByText('空闲').closest('[role="button"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('session row menu opens without opening the session and Escape closes it', () => {
    const onOpen = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} t={t} />)
    const trigger = screen.getByRole('button', { name: '会话“One”的操作' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    // The trigger toggles: a second click closes the menu it opened.
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders the menu list with the row identity and open state, and returns focus to the trigger after an entry closes it', async () => {
    const onOpen = vi.fn()
    const onEntry = vi.fn()
    const rendered = vi.fn()
    // A stub satisfies the generic render signature only with erased parameter
    // types; it narrows the owner and the occurrence options itself.
    const renderSlot: RowRenderSlot = (name: RowSlotName, owner: object, opts?: object) => {
      const { sessionId, displayTitle } = owner as SessionRowOwnerProps
      const hookContext = opts !== undefined && 'hookContext' in opts ? opts.hookContext : undefined
      rendered(name, owner, hookContext)
      if (name !== 'sidebar.workspaces.session.menu.item') return null
      // The stub stands in for the renderer, which binds this occurrence's
      // hookContext into the entries' useMenuOpenState hook.
      const [open, setMenuOpen] = hookContext as MenuOpenState
      return (
        <MenuItemButton onSelect={() => {
          setMenuOpen(false)
          onEntry(sessionId, displayTitle, open)
        }}>
          Export
        </MenuItemButton>
      )
    }
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} renderSlot={renderSlot} t={t} />)

    // Both lists receive the row identity; only the menu list carries the open state.
    expect(rendered).toHaveBeenCalledWith(
      'sidebar.workspaces.session.menu.item', { sessionId: node.id, displayTitle: 'One' }, [false, expect.any(Function)],
    )
    expect(rendered).toHaveBeenCalledWith(
      'sidebar.workspaces.session.row.action', { sessionId: node.id, displayTitle: 'One' }, undefined,
    )
    expect(screen.queryByRole('menuitem')).toBeNull()
    const trigger = screen.getByRole('button', { name: '会话“One”的操作' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Export'])
    expect(rendered).toHaveBeenCalledWith(
      'sidebar.workspaces.session.menu.item', { sessionId: node.id, displayTitle: 'One' }, [true, expect.any(Function)],
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }))
    expect(onEntry).toHaveBeenCalledWith(node.id, 'One', true)
    // The entry dismissed the menu through the state pair; the list returns focus.
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(trigger)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders the row action list inside the actions area after the menu trigger', () => {
    const onOpen = vi.fn()
    const onQuick = vi.fn()
    const renderSlot: RowRenderSlot = (name: RowSlotName) => name === 'sidebar.workspaces.session.row.action'
      ? (
        <button type="button" aria-label="Quick action" onClick={(e) => { e.stopPropagation(); onQuick() }} />
      )
      : null
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} renderSlot={renderSlot} t={t} />)
    const trigger = screen.getByRole('button', { name: '会话“One”的操作' })
    const quick = screen.getByRole('button', { name: 'Quick action' })
    const actionsArea = trigger.closest('[class*="rowActions"]')
    expect(actionsArea).not.toBeNull()
    expect(actionsArea?.contains(quick)).toBe(true)
    expect(trigger.compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(quick)
    expect(onQuick).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('shows the hover card after the dwell and suppresses it while the row menu is open', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Hovered', blank: false, running: true,
        runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={60_000} onOpen={vi.fn()} t={t} />)
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(800) })
      // Card body: full title + relative time + running status.
      expect(screen.getAllByText('Hovered')).toHaveLength(2)
      expect(screen.getByText('1分钟前')).toBeTruthy()
      expect(screen.getAllByText('进行中')).toHaveLength(2)
      fireEvent.pointerLeave(wrapper)
      // Menu open (disabled=true) suppresses the card for the same hover.
      fireEvent.click(screen.getByRole('button', { name: '会话“Hovered”的操作' }))
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByText('1分钟前')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['approval', '等待审批', '待审批'],
    ['plan-review', '计划待审', '计划待审'],
    ['question', '等待回答', '待回答'],
  ] as const)('shows %s as warning and replaces the row time', (pendingInteraction, label, compactLabel) => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid(pendingInteraction), title: 'Needs input', blank: false,
        pendingInteraction, running: true, runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
      }
      const view = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      const title = screen.getByText('Needs input')
      expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
      expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
      expect(row.textContent).toContain(label)
      expect(title.nextElementSibling?.textContent).toBe(compactLabel)
      expect(title.nextElementSibling?.getAttribute('aria-hidden')).toBe('true')
      expect(row.textContent).not.toContain('刚刚')

      view.rerender(<SessionNodeItem node={{ ...node, running: false }} currentId={undefined} now={0}
        onOpen={vi.fn()} t={t} />)
      expect(screen.getByRole('treeitem').querySelector('[data-state="warning"]')).toBeTruthy()

      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('刚刚')).toBeTruthy()
      expect(document.querySelectorAll('[data-state="warning"]')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['approval', 'Approval'],
    ['plan-review', 'Plan review'],
    ['question', 'Answer'],
  ] as const)('uses the compact English %s row label', (pendingInteraction, compactLabel) => {
    const node: SessionNode = {
      id: sid(pendingInteraction), title: 'Needs input', blank: false,
      pendingInteraction, running: false, runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={tEn} />)
    const row = screen.getByRole('treeitem')
    expect(screen.getByText('Needs input').nextElementSibling?.textContent).toBe(compactLabel)
    expect(screen.getByText('Needs input').nextElementSibling?.getAttribute('aria-hidden')).toBe('true')
    expect(row.textContent).not.toContain('now')
  })

  it('idle hover card shows the Idle status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Quiet', blank: false, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('空闲').parentElement?.querySelector('[data-state="idle"]')).not.toBeNull()
      expect(screen.getAllByText('刚刚')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('completed hover card shows the Completed status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Done', blank: false, running: false,
        runningSubagentCount: 0, completed: true, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      // Row's visually-hidden reminder label plus the hover card's status line.
      expect(screen.getAllByText('已完成')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('archived hover card replaces the resting status with the archived line but keeps live activity', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Stored', blank: false, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: true,
      }
      const { rerender } = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      // Row indicator label plus the hover card's archived line; the idle
      // resting status would restate the same inactivity and stays out.
      expect(screen.getAllByText('已归档')).toHaveLength(1)
      expect(screen.queryByText('空闲')).toBeNull()

      // Live activity on an archived session still shows beside the line.
      rerender(<SessionNodeItem node={{ ...node, running: true }} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      expect(screen.getAllByText('进行中').length).toBeGreaterThan(0)
      expect(screen.getAllByText('已归档')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('draggable row wires start/end and gates hover/drop on an active same-group drag', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Drag me', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const inactive = dragProps()
    const { rerender } = render(
      <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={inactive} t={t} />,
    )
    const row = screen.getByRole('treeitem')
    stubRect(row)
    expect(row.getAttribute('draggable')).toBe('true')
    fireEvent.dragStart(row, { dataTransfer })
    expect(inactive.start).toHaveBeenCalledOnce()
    // Inactive drag: hover and drop are rejected.
    fireEvent.dragOver(row, { dataTransfer })
    fireEvent.drop(row, { dataTransfer })
    expect(inactive.hover).not.toHaveBeenCalled()
    expect(inactive.drop).not.toHaveBeenCalled()
    fireEvent.dragEnd(row)
    expect(inactive.end).toHaveBeenCalledOnce()

    const active = dragProps({ active: true, marker: 'before' })
    rerender(
      <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={active} t={t} />,
    )
    stubRect(screen.getByRole('treeitem'))
    // Top half hovers/drops 'before'; bottom half 'after' (row mid = 117).
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 105)
    expect(active.hover).toHaveBeenCalledWith('before')
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 130)
    expect(active.hover).toHaveBeenCalledWith('after')
    fireDrag(screen.getByRole('treeitem'), 'drop', 130)
    expect(active.drop).toHaveBeenCalledWith('after')

    const after = dragProps({ active: true, marker: 'after' })
    rerender(
      <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={after} t={t} />,
    )
    expect(screen.getByRole('treeitem').className).toMatch(/dropAfter/)
  })

  it('marks a pinned row and keeps it draggable', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Pinned', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: true, archived: false,
    }
    const view = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      drag={dragProps()} t={t} />)
    const row = screen.getByRole('treeitem')
    // Reorderable within the pinned block; the browser gates the targets.
    expect(row.getAttribute('draggable')).toBe('true')
    expect(screen.getByRole('img', { name: '已置顶' })).toBeTruthy()

    view.rerender(<SessionNodeItem node={{ ...node, pinned: false }} currentId={undefined} now={0} onOpen={vi.fn()}
      drag={dragProps()} t={t} />)
    expect(screen.queryByRole('img', { name: '已置顶' })).toBeNull()
  })

  it('marks an archived row and blocks dragging it', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Stored', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: true, archived: true,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      drag={dragProps()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.className).toMatch(/archived/)
    expect(row.getAttribute('draggable')).toBe('false')
    // No leading marker: the grayed row alone carries the archived look, and
    // the pin marker stays off an archived row.
    expect(screen.queryByRole('img', { name: '已归档' })).toBeNull()
    expect(screen.queryByRole('img', { name: '已置顶' })).toBeNull()
    expect(row.getAttribute('aria-description')).toBe('已归档对话暂时无法查看，请取消归档后查看')
  })

  it('double-clicking the title asks for the rename dialog with the current title, but not on a blank row', () => {
    const onRenameRequest = vi.fn()
    const onOpen = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'Named', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const view = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen}
      onRenameRequest={onRenameRequest} t={t} />)
    fireEvent.doubleClick(screen.getByText('Named'))
    expect(onRenameRequest).toHaveBeenCalledWith(node.id, 'Named')
    expect(onOpen).not.toHaveBeenCalled()

    // A blank placeholder has no content to rename: double-click is inert.
    view.rerender(<SessionNodeItem node={{ ...node, blank: true }} currentId={undefined} now={0}
      onOpen={onOpen} onRenameRequest={onRenameRequest} t={t} />)
    fireEvent.doubleClick(screen.getByText('新会话'))
    expect(onRenameRequest).toHaveBeenCalledOnce()
  })

  it('flags an archived content-search result', () => {
    const result: SearchResultNode = {
      id: sid('result'), title: 'Old result', workspace: 'Workspace context',
      running: false, runningSubagentCount: 0, completed: false, archived: true,
    }
    render(<SearchResultItem result={result} currentId={undefined} onOpen={vi.fn()} onUnarchive={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.className).toMatch(/archived/)
    // No leading marker: the grayed row alone carries the archived look.
    expect(screen.queryByRole('img', { name: '已归档' })).toBeNull()
  })
})

describe('session row schedule seats', () => {
  /**
   * Stand-in occupant: the real one lives in ui-schedule, which this package
   * must not import. The share's owner type covers every key it declares, so
   * the spy takes a bare object and reads the row seats' Session identity from
   * it; a key without one renders nothing.
   */
  function seatSpy(): RowRenderSlot {
    return vi.fn((key: RowSlotName, owner: object) => {
      if (!('sessionId' in owner) || typeof owner.sessionId !== 'string') return null
      return <span key={key} data-seat={key} data-owner={owner.sessionId} />
    })
  }

  const idle: SessionNode = {
    id: sid('idle'), title: 'Idle Session', blank: false, running: false,
    runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
  }

  function renderRow(node: SessionNode, renderSlot: RowRenderSlot) {
    return render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      renderSlot={renderSlot} t={t} />)
  }

  it('offers the leading seat only while the row is idle, and no state dot beside it', () => {
    const renderSlot = seatSpy()
    const view = renderRow(idle, renderSlot)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('sidebar.session.row.leading', { sessionId: idle.id })
    // Priority replacement: the idle row shows the clock seat INSTEAD of a dot.
    expect(row.querySelector('[data-state]')).toBeNull()
    // The seat sits in the leading 16px cell, before the clipped title: the
    // cell is the row's first element, and the title follows the cell.
    const assertPlacement = (): void => {
      const cell = screen.getByRole('treeitem')
        .querySelector('[data-seat="sidebar.session.row.leading"]')?.parentElement
      expect(cell?.previousElementSibling ?? null).toBeNull()
      expect(cell?.nextElementSibling?.textContent).toBe('Idle Session')
      expect(cell?.nextElementSibling?.nextElementSibling?.textContent).toBe('刚刚')
    }
    assertPlacement()
    // Rerender through the same row: the seat stays leading without the flat
    // list's own props, because the component has no view-specific branch.
    view.rerender(<SessionNodeItem node={idle} currentId={undefined} now={0} onOpen={vi.fn()}
      renderSlot={renderSlot} t={t} />)
    assertPlacement()
  })

  it.each<[string, SessionNode, string]>([
    ['an unviewed completion (new message)', { ...idle, completed: true }, 'done'],
    ['live activity', { ...idle, running: true }, 'ongoing'],
    ['a pending approval', { ...idle, pendingInteraction: 'approval' as const }, 'warning'],
    ['a running subagent', { ...idle, runningSubagentCount: 2 }, 'ongoing'],
  ])('replaces the leading seat with the %s dot', (_label, node, state) => {
    const renderSlot = seatSpy()
    renderRow(node, renderSlot)
    const row = screen.getByRole('treeitem')
    // The dot occupies the same leading cell the idle row gave the seat.
    const dotCell = row.firstElementChild
    expect(dotCell?.querySelector(`[data-state="${state}"]`)).toBeTruthy()
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeNull()
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it.each<[string, SessionNode]>([
    ['an idle archived row', { ...idle, archived: true }],
    ['an archived row with live activity', { ...idle, archived: true, running: true }],
    ['an archived row with a pending approval', { ...idle, archived: true, pendingInteraction: 'approval' as const }],
  ])('keeps the leading cell blank on %s: no status dot and no seat', (_label, node) => {
    const renderSlot = seatSpy()
    renderRow(node, renderSlot)
    const row = screen.getByRole('treeitem')
    // The archived rule: the grayed row carries the archived look and its live
    // status stays on the hover card alone, so the cell holds neither marker.
    expect(row.querySelector('[data-state]')).toBeNull()
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeNull()
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it('never offers the seat for a provisional blank row', () => {
    const renderSlot = seatSpy()
    renderRow({ ...idle, blank: true }, renderSlot)
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it('renders the schedule section between the relative time and the trailing status line', () => {
    vi.useFakeTimers()
    try {
      const renderSlot = seatSpy()
      renderRow(idle, renderSlot)
      // The row's leading seat draws first; the hover seat joins it when the
      // card opens, so the card section is selected by its data attribute.
      expect(renderSlot).toHaveBeenCalledWith('sidebar.session.row.leading', { sessionId: idle.id })
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(renderSlot).toHaveBeenCalledWith('sidebar.session.row.hover', { sessionId: idle.id })
      const section = document.querySelector('[data-seat="sidebar.session.row.hover"]')
      expect(section).toBeTruthy()
      expect(section?.previousElementSibling?.textContent).toBe('刚刚')
      expect(section?.nextElementSibling?.textContent).toBe('空闲')
    } finally {
      vi.useRealTimers()
    }
  })
})

it.each([['未命名', t], ['Untitled', tEn]])('labels unnamed history as %s', (label, translate) => {
  const node: SessionNode = { id: sid('unnamed'), title: '', blank: false, running: false,
    runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false }
  const onRenameRequest = vi.fn()
  render(<SessionNodeItem node={node} currentId={node.id} now={0} onOpen={vi.fn()}
    renderSlot={() => null} onRenameRequest={onRenameRequest} t={translate} />)
  expect(screen.getByText(label)).toBeTruthy()
  fireEvent.doubleClick(screen.getByText(label))
  expect(onRenameRequest).toHaveBeenCalledWith(node.id, '')
})

it.each([['未命名', t], ['Untitled', tEn]])('labels unnamed search results as %s', (label, translate) => {
  const result: SearchResultNode = { id: sid('unnamed-search'), title: '', workspace: 'Project',
    running: false, runningSubagentCount: 0, completed: false, archived: false }
  const onOpen = vi.fn()
  render(<SearchResultItem result={result} currentId={undefined} onOpen={onOpen}
    onUnarchive={vi.fn()} t={translate} />)
  fireEvent.click(screen.getByText(label))
  expect(onOpen).toHaveBeenCalledWith(result.id)
})
