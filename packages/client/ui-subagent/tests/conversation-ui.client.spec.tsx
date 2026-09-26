// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate, RemoteError, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  SessionListState, SessionSummary, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress, SubagentCatalogRow } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import {
  SubagentCatalogAction, SubagentHeaderLineage,
  type SubagentCatalogActionProps, type SubagentHeaderLineageProps,
} from '../src/client/SubagentHeaderLineage.tsx'
import { SubagentReadOnlyComposer } from '../src/client/SubagentReadOnlyComposer.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const PARENT = 'parent' as SessionId
const CHILD = 'child' as SessionId
const GRANDCHILD = 'grandchild' as SessionId
const t: SubagentHeaderLineageProps['t'] = makeTranslate(zh)

type CatalogFixture = { entries: readonly (SubagentCatalogRow | { id: SessionId; mode: 'unknown'; label?: string; activity: 'inactive' })[]; parentAvailable: boolean; state: 'loading' | 'ready' | 'error'; error: SessionListState['projectionsBySession'][SessionId]['error'] }

function catalog(over: Partial<CatalogFixture> = {}): CatalogFixture {
  return {
    entries: [
      {
        id: CHILD, mode: 'continuable', label: 'worker',
        activity: 'running',
      },
      {
        id: 'child-2' as SessionId, mode: 'one-shot',
        label: 'reviewer', activity: 'inactive',
      },
    ],
    parentAvailable: true,
    state: 'ready',
    error: null,
    ...over,
  }
}

function props(
  value: CatalogFixture | undefined,
  nested: Readonly<Record<SessionId, CatalogFixture>> = {},
  summaries?: Readonly<Record<SessionId, SessionSummary>>,
  boundAddress?: SubagentAddress,
) {
  const catalogs = value === undefined ? nested : { [PARENT]: value, ...nested }
  const statuses: SessionStatusSnapshot = new Map()
  const state = {
    ids: [CHILD],
    byId: summaries ?? {
      ...Object.fromEntries(Object.values(catalogs).flatMap(catalog => catalog.entries.map(entry => [entry.id, {
        id: entry.id, displayTitle: entry.label ?? entry.id, running: entry.activity === 'running', blank: false, updatedAt: 1, retainedBy: {},
      }]))),
      [CHILD]: {
        id: CHILD,
        title: '正在扫描项目文件',
        displayTitle: 'worker',
        running: Object.values(catalogs).some(catalog => catalog.entries.some(entry => entry.id === CHILD && entry.activity === 'running')),
        retainedBy: {},
        blank: false,
        updatedAt: Date.now(),
      },
    },
    phase: 'ready',
    projectionsBySession: Object.fromEntries(Object.entries(catalogs).map(([id, catalog]) => [id, {
      state: catalog.state, error: catalog.error,
      values: { subagentCatalog: catalog.entries.map(({ activity: _activity, ...entry }) => ({ ...entry, createdAt: 1 })) },
    }])) ,
  } satisfies SessionListState
  function useSessions<T>(select: (snapshot: SessionListState) => T): T {
    return select(state)
  }
  const snapshot: SessionSnapshot = {
    ...sessionSnapshot(PARENT),
    subagent: boundAddress === undefined ? null : { address: boundAddress },
  }
  const unused = (): never => { throw new Error('Subagent header fixture does not provide this slot source or action') }
  const standard = {
    usePanelInfo: unused,
    useSessionRetainInfo: unused,
    useWorkspaces: unused,
    useResource: unused,
    useProjection: unused,
    useConversation: unused,
    useInput: unused,
    useChat: unused,
    useTrajectory: unused,
    inputActions: {
      captureInsertion: unused,
      insertText: unused,
      setDraft: unused,
      addAttachments: unused,
      removeAttachment: unused,
      pruneAttachments: unused,
      submit: unused,
    },
  }
  return {
    ...standard,
    sessionId: PARENT,
    useSessions,
    useSessionStatus: <T,>(select: (snapshot: SessionStatusSnapshot) => T): T => select(statuses),
    useSession: <T,>(select: (snapshot: SessionSnapshot) => T): T => select(snapshot),
    openChild: vi.fn(),
    openChildAside: vi.fn(),
    refreshProjection: vi.fn(),
    lineageSessionId: PARENT,
    displayTitle: 'Parent title',
    t,
  } satisfies SubagentHeaderLineageProps
}

function summary(id: SessionId, updatedAt: number): SessionSummary {
  return {
    id,
    displayTitle: id,
    running: false,
    retainedBy: {},
    blank: false,
    updatedAt,
  }
}

function hoverCatalog(trigger: HTMLElement): void {
  vi.useFakeTimers()
  fireEvent.mouseEnter(trigger)
  act(() => { vi.advanceTimersByTime(150) })
}

/**
 * Both header seats as the real header composes them: the breadcrumb switcher
 * (child sessions, lineage slot) and the actions-band catalog entry (root
 * sessions) — exactly one renders per form. The actions seat sees the same
 * session the lineage renders.
 */
function HeaderCatalog(props: SubagentHeaderLineageProps) {
  const actionProps: SubagentCatalogActionProps = { ...props, sessionId: props.lineageSessionId }
  return (
    <>
      <SubagentHeaderLineage {...props} />
      <SubagentCatalogAction {...actionProps} />
    </>
  )
}

describe('SubagentHeaderLineage', () => {
  it('shows current catalog-only child status before Host list discovery', () => {
    const input = props(catalog({ entries: [{ id: CHILD, mode: 'continuable', label: 'worker', activity: 'inactive' }] }))
    const initial = input.useSessions(state => state)
    const statuses: SessionStatusSnapshot = new Map([[CHILD, {
      running: true, completionUnread: false, pendingInteraction: undefined,
    }]])
    render(<HeaderCatalog {...input}
      useSessions={select => select({ ...initial, ids: [] })}
      useSessionStatus={select => select(statuses)}
    />)
    expect(screen.getByRole('button', { name: '1 个子智能体，正在运行' })).toBeTruthy()
  })

  it('shows retained children while an idle projection awaits refresh', () => {
    const injected = props(catalog())
    const initial = injected.useSessions(state => state)
    let projections: SessionListState['projectionsBySession'] = {
      [PARENT]: { state: 'idle', error: null, values: {} },
    }
    const current: SubagentHeaderLineageProps = {
      ...injected,
      useSessions: select => select({ ...initial, projectionsBySession: projections }),
    }
    const view = render(<HeaderCatalog {...current} />)
    expect(screen.queryByRole('button')).toBeNull()

    projections = {
      [PARENT]: { ...initial.projectionsBySession[PARENT]!, state: 'idle' },
    }
    view.rerender(<HeaderCatalog {...current} />)
    hoverCatalog(screen.getByRole('button'))
    expect(screen.getByRole('treeitem', { name: /worker/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /reviewer/ })).toBeTruthy()
  })

  it('combines projected membership with Session activity on the closed trigger', () => {
    const summaries: Record<SessionId, SessionSummary> = {
      [CHILD]: {
        ...summary(CHILD, Date.now()), running: true,
        parentId: PARENT,
        origin: 'subagent',
      },
      [GRANDCHILD]: {
        ...summary(GRANDCHILD, Date.now()),
        parentId: CHILD,
        origin: 'subagent',
        running: true,
      },
      ['child-2' as SessionId]: {
        ...summary('child-2' as SessionId, Date.now()),
        parentId: PARENT,
        origin: 'subagent',
      },
    }
    const view = render(<HeaderCatalog {...props(catalog(), {}, summaries)} />)

    const trigger = screen.getByRole('button', { name: '1 个子智能体，正在运行' })
    expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()

    view.rerender(<HeaderCatalog {...props(catalog(), {}, {
      ...summaries, [CHILD]: { ...summaries[CHILD]!, running: false },
    })} />)
    const inactiveTrigger = screen.getByRole('button', { name: '2 个子智能体' })
    expect(inactiveTrigger.querySelector('[data-state="ongoing"]')).toBeNull()
  })

  it('does not count Sessions outside projected membership', () => {
    const fork = 'fork' as SessionId
    const forkChild = 'fork-child' as SessionId
    render(<HeaderCatalog {...props(catalog({
      entries: [{
        id: CHILD, mode: 'continuable', label: 'worker', activity: 'inactive',
      }],
    }), {}, {
      [CHILD]: { ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' },
      ['child-2' as SessionId]: {
        ...summary('child-2' as SessionId, 1), parentId: PARENT, origin: 'subagent',
      },
      [fork]: { ...summary(fork, 1), parentId: PARENT },
      [forkChild]: { ...summary(forkChild, 1), parentId: fork, origin: 'subagent', running: true },
    })} />)

    const trigger = screen.getByRole('button', { name: '1 个子智能体' })
    expect(trigger.querySelector('[data-state="ongoing"]')).toBeNull()
  })

  it('renders stable rows and catalog-addressed navigation', () => {
    const input = props(catalog())
    render(<HeaderCatalog {...input} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    hoverCatalog(trigger)

    expect(input.refreshProjection).not.toHaveBeenCalled()
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    expect(screen.getByText('正在扫描项目文件 · 可继续 · 正在运行')).toBeTruthy()
    expect(screen.getByText('一次性 · 当前未运行')).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开 worker 的下级子智能体' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开 reviewer 的下级子智能体' })).toBeTruthy()

    const sidebarButton = within(screen.getByRole('treeitem', { name: /worker/ }))
      .getByRole('button', { name: '在侧边栏打开 worker' })
    fireEvent.keyDown(sidebarButton, { key: 'Enter' })
    fireEvent.click(sidebarButton)
    expect(input.openChildAside).toHaveBeenCalledWith({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable',
    })

    hoverCatalog(trigger)
    fireEvent.click(screen.getByRole('treeitem', { name: /worker/ }))
    expect(input.openChild).toHaveBeenCalledWith({
      parentSessionId: PARENT,
      childSessionId: CHILD, mode: 'continuable',
    })
  })

  it('selects singular count keys for one direct child', () => {
    const base = props(catalog({
      entries: [{
        id: CHILD, mode: 'continuable', label: 'worker',
        activity: 'running',
      }],
    }), {}, {
      [CHILD]: {
        ...summary(CHILD, Date.now()), parentId: PARENT, origin: 'subagent', running: true,
      },
    })
    const translate = vi.fn(base.t)
    render(<HeaderCatalog {...base} t={translate} />)

    expect(translate).toHaveBeenCalledWith('count.running.one', { count: 1 })
    expect(translate).toHaveBeenCalledWith('count.total.one', { count: 1 })
  })

  it('removes the disclosure column from branchless catalog levels', () => {
    render(<HeaderCatalog {...props(catalog({
      entries: catalog().entries.slice(0, 1),
    }), { [CHILD]: catalog({ entries: [] }) })} />)
    hoverCatalog(screen.getByRole('button', { name: /1 个子智能体/ }))

    expect(screen.getByRole('treeitem', { name: /worker/ }).children).toHaveLength(1)
  })

  it('aligns a known leaf with siblings whose child catalog is still unknown', () => {
    render(<HeaderCatalog {...props(catalog(), { [CHILD]: catalog({ entries: [] }) })} />)
    hoverCatalog(screen.getByRole('button', { name: /1 个子智能体，正在运行/ }))

    expect(screen.getByRole('treeitem', { name: /worker/ }).children).toHaveLength(2)
    expect(screen.getByRole('button', { name: /展开 reviewer/ })).toBeTruthy()
  })

  it('supports trigger/menu keyboard traversal, Escape focus restore, and outside close', async () => {
    const input = props(catalog())
    render(<HeaderCatalog {...input} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await Promise.resolve()
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /worker/ }))

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /worker/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    await Promise.resolve()
    expect(screen.queryByRole('tree')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    hoverCatalog(trigger)
    fireEvent.pointerDown(screen.getByRole('tree'))
    expect(screen.getByRole('tree')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('opens on hover and preserves the portaled-menu crossing grace', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    const view = render(<HeaderCatalog {...props(catalog())} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    const triggerRect = vi.spyOn(trigger, 'getBoundingClientRect')
      .mockReturnValue({ bottom: 40, left: 50 } as DOMRect)

    fireEvent.mouseEnter(trigger)
    await advance(149)
    expect(screen.queryByRole('tree')).toBeNull()
    await advance(1)
    const menu = screen.getByRole('tree').parentElement!
    expect(menu.style.top).toBe('45px')
    expect(menu.style.left).toBe('50px')
    triggerRect.mockReturnValue({ bottom: 60, left: 70 } as DOMRect)
    fireEvent.resize(window)
    expect(menu.style.top).toBe('65px')
    expect(menu.style.left).toBe('70px')
    fireEvent.mouseLeave(trigger.parentElement!)
    fireEvent.mouseEnter(menu)
    await advance(120)
    expect(screen.getByRole('tree')).toBeTruthy()

    fireEvent.mouseLeave(menu)
    await advance(119)
    expect(screen.getByRole('tree')).toBeTruthy()
    await advance(1)
    expect(screen.queryByRole('tree')).toBeNull()

    hoverCatalog(trigger)
    fireEvent.mouseLeave(trigger.parentElement!)
    view.unmount()
    await advance(120)
  })

  it('pins a click-opened catalog through hover-out until outside pointer or Escape', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    render(<HeaderCatalog {...props(catalog())} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    const root = trigger.parentElement!

    fireEvent.click(trigger)
    const menu = screen.getByRole('tree')
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('tree')).toBe(menu)
    fireEvent.mouseEnter(menu.parentElement!)
    fireEvent.mouseLeave(menu.parentElement!)
    await advance(300)
    expect(screen.getByRole('tree')).toBe(menu)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('tree')).toBeNull()

    fireEvent.mouseEnter(trigger)
    await advance(150)
    const hovered = screen.getByRole('tree')
    fireEvent.click(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('tree')).toBe(hovered)
    fireEvent.keyDown(hovered, { key: 'Escape' })
    expect(screen.queryByRole('tree')).toBeNull()
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('keeps the hover catalog open when the pointer returns directly to its trigger', async () => {
    vi.useFakeTimers()
    render(<HeaderCatalog {...props(catalog())} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    fireEvent.mouseOver(trigger, { relatedTarget: document.body })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    const menu = screen.getByRole('tree').parentElement!
    fireEvent.mouseOut(trigger, { relatedTarget: menu })
    fireEvent.mouseOver(menu, { relatedTarget: trigger })
    fireEvent.mouseOut(menu, { relatedTarget: trigger })
    fireEvent.mouseOver(trigger, { relatedTarget: menu })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(screen.getByRole('tree').parentElement).toBe(menu)
  })

  it('cancels pending hover dismissal when the catalog trigger is activated from the keyboard', async () => {
    vi.useFakeTimers()
    render(<HeaderCatalog {...props(catalog())} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    fireEvent.mouseOver(trigger, { relatedTarget: document.body })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    fireEvent.mouseOut(trigger, { relatedTarget: document.body })
    fireEvent.click(trigger, { detail: 0 })
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(screen.getByRole('tree')).toBeTruthy()
  })

  it('repositions an open catalog after viewport resize and document scroll', () => {
    const view = render(<HeaderCatalog {...props(catalog())} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    const bounds = vi.spyOn(trigger, 'getBoundingClientRect')
    bounds.mockReturnValue({ bottom: 20, left: 30 } as DOMRect)
    hoverCatalog(trigger)
    const menu = screen.getByRole('tree').parentElement!
    expect(menu.style.top).toBe('25px')
    expect(menu.style.left).toBe('30px')

    bounds.mockReturnValue({ bottom: 70, left: 80 } as DOMRect)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(menu.style.top).toBe('75px')
    expect(menu.style.left).toBe('80px')

    bounds.mockReturnValue({ bottom: 90, left: 100 } as DOMRect)
    act(() => { document.dispatchEvent(new Event('scroll')) })
    expect(menu.style.top).toBe('95px')
    expect(menu.style.left).toBe('100px')
    view.unmount()
  })

  it('cancels a pending hover when the trigger becomes hidden', async () => {
    vi.useFakeTimers()
    const view = render(<HeaderCatalog {...props(catalog())} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })

    fireEvent.mouseEnter(trigger)
    await vi.advanceTimersByTimeAsync(149)
    view.rerender(<HeaderCatalog {...props(catalog({ entries: [] }))} />)
    expect(screen.queryByRole('button')).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    fireEvent.resize(window)
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('covers fallback labels and keyboard row activation', () => {
    const unlabeled = 'unlabeled' as SessionId
    const input = props(catalog({
      entries: [
        {
          id: CHILD, mode: 'continuable', label: 'worker',
          activity: 'running',
        },
        {
          id: unlabeled, mode: 'one-shot',
          activity: 'inactive',
        },
      ],
    }))
    render(<HeaderCatalog {...input} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.queryByRole('tree')).toBeNull()
    hoverCatalog(trigger)

    fireEvent.keyDown(screen.getByRole('treeitem', { name: /worker/ }), { key: 'Enter' })
    expect(input.openChild).toHaveBeenLastCalledWith({
      parentSessionId: PARENT,
      childSessionId: CHILD, mode: 'continuable',
    })
    hoverCatalog(trigger)
    fireEvent.keyDown(screen.getByRole('treeitem', { name: /unlabeled/ }), { key: ' ' })
    expect(input.openChild).toHaveBeenLastCalledWith({
      parentSessionId: PARENT,
      childSessionId: unlabeled, mode: 'one-shot',
    })
  })

  it('keeps unknown catalog children clickable by their durable parent address', () => {
    const input = props(catalog({ entries: [{ id: CHILD, mode: 'unknown', activity: 'inactive' }] }))
    render(<HeaderCatalog {...input} />)
    hoverCatalog(screen.getByRole('button', { name: /子智能体/ }))
    const row = screen.getByRole('treeitem', { name: new RegExp(CHILD) })
    expect(row.textContent).toContain('模式未知')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(input.openChild).toHaveBeenCalledWith({ parentSessionId: PARENT, childSessionId: CHILD, mode: 'unknown' })
  })

  it('shows durable completion and token totals, ticks active duration, and freezes inactive rows', async () => {
    const now = 2_000_000_000_000
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const rows = [
      ['running', 'running', 65_000, now - 5_000, now - 1_000, now],
      ['finished', 'inactive', 3_723_000, undefined, undefined, now - 60_000],
      ['interrupted', 'inactive', 2_000, now - 7_000, now - 3_000, now + 60_000],
      ['days', 'inactive', 12 * day + 5 * hour + 6 * minute + 7_000, undefined, undefined, now],
      ['whole-day', 'inactive', day, undefined, undefined, now],
      ['months', 'inactive', 192 * day, undefined, undefined, now],
      ['whole-month', 'inactive', 30 * day, undefined, undefined, now],
      ['years', 'inactive', 832 * day, undefined, undefined, now],
      ['whole-year', 'inactive', 365 * day, undefined, undefined, now],
    ] as const
    const usageById = {
      running: {
        uncachedInputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 3_000,
        cacheWriteTokens: 400,
      },
      finished: {
        uncachedInputTokens: 123,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      interrupted: {
        uncachedInputTokens: 123_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    } as const
    const entries = rows.map(([id, activity]) => ({
      id: id as SessionId,
      mode: 'continuable' as const,
      label: id,
      activity,
    }))
    const summaries = Object.fromEntries(rows.map(([
      id, activity, settledMs, activeSince, activeThrough, updatedAt,
    ]) => {
      const childId = id as SessionId
      return [id, {
        ...summary(childId, updatedAt),
        parentId: PARENT,
        origin: 'subagent' as const,
        running: activity === 'running',
        projectionValues: {
          subagentTiming: {
            settledMs,
            ...(id === 'finished'
              ? { lastTurnCompleted: true }
              : id === 'interrupted'
                ? { lastTurnCompleted: false }
                : {}),
            ...(activeSince === undefined || activeThrough === undefined
              ? {}
              : { active: { since: activeSince, through: activeThrough } }),
          },
          tokenUsage: id in usageById
            ? usageById[id as keyof typeof usageById]
            : undefined,
        },
      }]
    })) as Record<SessionId, SessionSummary>
    const input = props(catalog({ entries }), {}, summaries)
    render(<HeaderCatalog {...input} />)
    const trigger = screen.getByRole('button', { name: '1 个子智能体，正在运行' })
    expect(within(trigger).getByText('9 个子智能体')).toBeTruthy()
    hoverCatalog(trigger)

    const runningRow = screen.getByRole('treeitem', { name: /running.*4\.6K tok · 1分10秒/ })
    const runningMetrics = within(runningRow)
    const tokenMetric = runningMetrics.getByText('4.6K tok')
    const durationMetric = runningMetrics.getByText('1分10秒')
    expect(tokenMetric.parentElement).toBe(durationMetric.parentElement)
    expect(tokenMetric.nextElementSibling).toBe(durationMetric)
    const finishedRow = screen.getByRole('treeitem', { name: /finished.*已完成.*123 tok · 1小时02分03秒/ })
    expect(finishedRow.querySelector('[data-state="done"]')).not.toBeNull()
    const interruptedRow = screen.getByRole('treeitem', { name: /interrupted.*当前未运行.*123M tok · 6秒/ })
    expect(interruptedRow.querySelector('[data-state="idle"]')).not.toBeNull()
    for (const row of [runningRow, finishedRow, interruptedRow]) {
      expect(row.querySelector('[data-state]')?.parentElement?.className).toContain('rowActivitySlot')
    }
    expect(screen.getByRole('treeitem', { name: /days.*12天05小时06分07秒/ })).toBeTruthy()
    expect(screen.getByText('12天5小时').getAttribute('title'))
      .toBe('总活跃耗时：12天05小时06分07秒')
    expect(screen.getByText('1天')).toBeTruthy()
    expect(screen.getByText('约6个月12天')).toBeTruthy()
    expect(screen.getByText('约1个月')).toBeTruthy()
    expect(screen.getByText('约2年3个月')).toBeTruthy()
    expect(screen.getByText('约1年')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(screen.getByRole('treeitem', { name: /running.*4\.6K tok · 1分11秒/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /finished.*已完成.*123 tok · 1小时02分03秒/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /interrupted.*当前未运行.*123M tok · 6秒/ })).toBeTruthy()
  })

  it('ticks expanded running grandchildren under an idle child and releases their clock on collapse', async () => {
    const now = 2_000_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const input = props(catalog({ entries: [{
      id: CHILD, mode: 'continuable', label: 'worker', activity: 'inactive',
    }] }), {
      [CHILD]: catalog({ entries: [{
        id: GRANDCHILD, mode: 'continuable', label: 'indexer', activity: 'running',
      }] }),
    }, {
      [GRANDCHILD]: {
        ...summary(GRANDCHILD, now),
        parentId: CHILD,
        origin: 'subagent',
        running: true,
        projectionValues: {
          subagentTiming: { settledMs: 0, active: { since: now - 5_000, through: now } },
        },
      },
    })
    render(<HeaderCatalog {...input} />)
    hoverCatalog(screen.getByRole('button', { name: '1 个子智能体' }))
    const beforeExpand = vi.getTimerCount()
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子智能体' }))
    expect(screen.getByRole('treeitem', { name: /indexer.*5秒/ })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getByRole('treeitem', { name: /indexer.*6秒/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起 worker 的下级子智能体' }))
    expect(vi.getTimerCount()).toBe(beforeExpand)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子智能体' }))
    expect(screen.getByRole('treeitem', { name: /indexer.*7秒/ })).toBeTruthy()
  })

  it('lazily expands and collapses descendant catalogs with direct-parent navigation', () => {
    const childCatalog = catalog({
      entries: [
        {
          id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'inactive',
        },
      ],
    })
    const grandchildCatalog = catalog({ entries: [] })
    const input = props(catalog(), {
      [CHILD]: childCatalog,
      [GRANDCHILD]: grandchildCatalog,
    })
    render(<HeaderCatalog {...input} />)
    hoverCatalog(screen.getByRole('button', { name: /1 个子智能体，正在运行/ }))

    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子智能体' }))
    expect(input.refreshProjection).toHaveBeenCalledWith(CHILD)
    const nested = screen.getByRole('treeitem', { name: /indexer/ })
    expect(nested.getAttribute('aria-level')).toBe('2')

    fireEvent.click(nested)
    expect(input.openChild).toHaveBeenCalledWith({
      parentSessionId: CHILD,
      childSessionId: GRANDCHILD, mode: 'continuable',
    })
  })

  it('shows one generic state while a child catalog loads', () => {
    const secondGrandchild = 'grandchild-2' as SessionId
    const summaries = {
      [CHILD]: { ...summary(CHILD, 1), running: true },
      [GRANDCHILD]: {
        ...summary(GRANDCHILD, 1), parentId: CHILD, origin: 'subagent' as const,
      },
      [secondGrandchild]: {
        ...summary(secondGrandchild, 1), parentId: CHILD, origin: 'subagent' as const,
        running: true,
      },
    }
    const deferred = props(catalog(), {}, summaries)
    const view = render(<HeaderCatalog {...deferred} />)
    hoverCatalog(screen.getByRole('button', { name: /1 个子智能体，正在运行/ }))
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子智能体' }))

    expect(deferred.refreshProjection).toHaveBeenCalledWith(CHILD)
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('正在加载子智能体…')).toBeTruthy()
    expect(screen.queryByRole('treeitem', { name: '正在加载子智能体' })).toBeNull()

    const loading = props(catalog(), {
      [CHILD]: catalog({ entries: [], state: 'loading' }),
    }, summaries)
    view.rerender(<HeaderCatalog {...loading} />)
    expect(screen.getByText('正在加载子智能体…')).toBeTruthy()

    const ready = props(catalog(), {
      [CHILD]: catalog({
        entries: [
          {
            id: GRANDCHILD, mode: 'continuable',
            label: 'indexer', activity: 'inactive',
          },
          {
            id: secondGrandchild, mode: 'one-shot',
            label: 'critic', activity: 'running',
          },
        ],
      }),
    }, summaries)
    view.rerender(<HeaderCatalog {...ready} />)
    expect(screen.getByRole('group').getAttribute('aria-busy')).toBeNull()
    expect(screen.getByRole('treeitem', { name: /indexer/ }).querySelector('[data-state="idle"]')).not.toBeNull()
    expect(screen.getByRole('treeitem', { name: /critic/ }).querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.queryByText('正在加载子智能体…')).toBeNull()
  })

  it('uses ArrowRight and ArrowLeft for branch disclosure', async () => {
    const input = props(catalog(), {
      [CHILD]: catalog({
        entries: [{
          id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'running',
        }],
      }),
    })
    render(<HeaderCatalog {...input} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await Promise.resolve()
    const worker = screen.getByRole('treeitem', { name: /worker/ })
    fireEvent.keyDown(worker, { key: 'ArrowRight' })
    expect(screen.getByRole('treeitem', { name: /indexer/ })).toBeTruthy()
    fireEvent.keyDown(worker, { key: 'ArrowLeft' })
    expect(screen.queryByRole('treeitem', { name: /indexer/ })).toBeNull()
  })

  it('closes expanded descendants even when their own catalogs have not arrived', () => {
    const input = props(catalog(), {
      [CHILD]: catalog({
        entries: [{
          id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'running',
        }],
      }),
    })
    render(<HeaderCatalog {...input} />)
    hoverCatalog(screen.getByRole('button', { name: /1 个子智能体，正在运行/ }))
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子智能体' }))
    fireEvent.click(screen.getByRole('button', { name: '展开 indexer 的下级子智能体' }))
    fireEvent.click(screen.getByRole('button', { name: '收起 worker 的下级子智能体' }))

    expect(screen.queryByRole('treeitem', { name: /indexer/ })).toBeNull()
  })

  it('hides an arrived empty catalog and exposes retry for a failed one', () => {
    const absent = render(<HeaderCatalog {...props(undefined)} />)
    expect(screen.queryByRole('button')).toBeNull()
    absent.unmount()

    const empty = props(catalog({ entries: [] }))
    const view = render(<HeaderCatalog {...empty} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.unmount()

    const failed = props(catalog({
      entries: [],
      state: 'error',
      error: new RemoteError('gateway/internal', 'index down', {}),
    }))
    render(<HeaderCatalog {...failed} />)
    hoverCatalog(screen.getByRole('button', { name: /0 个子智能体/ }))
    expect(screen.getByText('index down')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(failed.refreshProjection).toHaveBeenCalledWith(PARENT)
  })

  it('does not expose summary-only descendants as catalog rows', () => {
    const second = 'child-2' as SessionId
    const summaries = {
      [CHILD]: {
        ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' as const,
      },
      [second]: {
        ...summary(second, 1), parentId: PARENT, origin: 'subagent' as const, running: true,
      },
    }
    const absent = props(undefined, {}, summaries)
    const view = render(<HeaderCatalog {...absent} />)
    expect(screen.queryByRole('button')).toBeNull()

    const staleEmpty = props(catalog({ entries: [] }), {}, summaries)
    view.rerender(<HeaderCatalog {...staleEmpty} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('hides a bare loading catalog and keeps the error fallback without focusable rows', async () => {
    // A loading snapshot without evidence of children must not flash the action in.
    const loading = props(catalog({ entries: [], state: 'loading' }))
    const view = render(<HeaderCatalog {...loading} />)
    expect(screen.queryByRole('button')).toBeNull()
    view.unmount()

    const failed = props(catalog({ entries: [], state: 'error', error: null }))
    render(<HeaderCatalog {...failed} />)
    const trigger = screen.getByRole('button', { name: /0 个子智能体/ })
    hoverCatalog(trigger)
    expect(screen.getByText('无法加载子智能体')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await Promise.resolve()
    expect(screen.getByRole('tree')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowUp' })
  })

  it('navigates from outside the tree and tolerates a deferred focus after unmount', async () => {
    const input = props(catalog())
    const view = render(<HeaderCatalog {...input} />)
    const trigger = screen.getByRole('button', { name: /1 个子智能体，正在运行/ })
    hoverCatalog(trigger)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /reviewer/ }))
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    view.unmount()
    await Promise.resolve()
  })

  it('closes every observed catalog when the root becomes empty', () => {
    const populated = props(catalog(), {
      [CHILD]: catalog({
        entries: [{
          id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'inactive',
        }],
      }),
    })
    const view = render(<HeaderCatalog {...populated} />)
    hoverCatalog(screen.getByRole('button', { name: /1 个子智能体，正在运行/ }))
    fireEvent.click(screen.getByRole('button', { name: '展开 worker 的下级子智能体' }))

    const empty = props(catalog({ entries: [] }))
    view.rerender(<HeaderCatalog {...empty} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders an ordinary-session direct-child count in the actions seat with no separator', () => {
    const view = render(<HeaderCatalog {...props(catalog())} />)

    expect(screen.queryByText('/')).toBeNull()
    expect(screen.getByRole('button', { name: /1 个子智能体，正在运行/ })).toBeTruthy()

    view.rerender(<HeaderCatalog {...props(catalog({ entries: [] }))} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('combines the current subagent title and chevron into the parent-catalog trigger', () => {
    const sibling = 'child-2' as SessionId
    const input = {
      ...props(catalog(), {}, {
        [CHILD]: {
          ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' as const,
        },
        [sibling]: {
          ...summary(sibling, 1), parentId: PARENT, origin: 'subagent' as const,
        },
      }),
      sessionId: CHILD,
      lineageSessionId: CHILD,
      displayTitle: 'worker',
    }
    render(<HeaderCatalog {...input} />)

    const switcher = screen.getByRole('button', { name: '切换子智能体：worker' })
    expect(switcher.className).toContain('switcherTrigger')
    expect(within(switcher).getByText('worker')).toBeTruthy()
    expect(switcher.querySelector('svg')).not.toBeNull()

    const switcherIcon = switcher.querySelector('svg')
    expect(switcherIcon?.getAttribute('width')).toBe('16')
    expect(switcherIcon?.getAttribute('height')).toBe('16')

    hoverCatalog(switcher)
    expect(input.refreshProjection).not.toHaveBeenCalled()
    const current = screen.getByRole('treeitem', { name: /worker/ })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(within(current).getByText('worker').className).toContain('currentLabel')
    fireEvent.click(screen.getByRole('treeitem', { name: /reviewer/ }))
    expect(input.openChild).toHaveBeenCalledWith({
      parentSessionId: PARENT,
      childSessionId: sibling, mode: 'one-shot',
    })
  })

  it('does not derive a subagent address from Session summary lineage', () => {
    const input = {
      ...props(undefined, {}, {
        [CHILD]: {
          ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' as const,
        },
      }),
      lineageSessionId: CHILD,
      displayTitle: 'worker',
    }
    render(<HeaderCatalog {...input} />)

    expect(screen.queryByRole('button', { name: '切换子智能体：worker' })).toBeNull()
  })

  it('falls back to the catalog session id when the selected row has no label', () => {
    const input = {
      ...props(catalog({ entries: [{
        id: CHILD, mode: 'one-shot',
        activity: 'inactive',
      }] }), {}, {
        [CHILD]: {
          ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' as const,
        },
      }),
      sessionId: CHILD,
      lineageSessionId: CHILD,
      displayTitle: 'summary title',
    }
    render(<HeaderCatalog {...input} />)

    expect(screen.getByRole('button', { name: `切换子智能体：${CHILD}` })).toBeTruthy()
  })

  it('keeps an ancestor switcher muted and omits its descendant count', () => {
    const input = {
      ...props(catalog(), {
        [CHILD]: catalog({ entries: [{
          id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'inactive',
        }] }),
      }, {
        [CHILD]: {
          ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' as const,
        },
        [GRANDCHILD]: {
          ...summary(GRANDCHILD, 1), parentId: CHILD, origin: 'subagent' as const,
        },
      }),
      lineageSessionId: CHILD,
      displayTitle: '正在扫描项目文件',
      openTitle: vi.fn(),
    }
    render(<HeaderCatalog {...input} />)

    const switcher = screen.getByRole('button', { name: '切换子智能体：worker' })
    expect(switcher.className).toContain('ancestorSwitcherTrigger')
    expect(screen.queryByRole('button', { name: /1 个子智能体/ })).toBeNull()
    vi.useFakeTimers()
    fireEvent.mouseEnter(switcher.parentElement!)
    fireEvent.click(switcher)
    expect(input.openTitle).toHaveBeenCalledOnce()
    act(() => { vi.advanceTimersByTime(150) })
    expect(screen.queryByRole('tree')).toBeNull()

    hoverCatalog(switcher)
    expect(screen.getByRole('tree')).toBeTruthy()
    fireEvent.click(switcher)
    expect(input.openTitle).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it.each([
    ['ancestor', vi.fn()],
    ['current', undefined],
  ] as const)('keeps an absent %s switcher catalog lazy until interaction', (_kind, openTitle) => {
    const input = {
      ...props(undefined, {}, {
        [CHILD]: {
          ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' as const,
          displayTitle: '正在扫描项目文件',
        },
      }, { parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable' }),
      lineageSessionId: CHILD,
      displayTitle: '正在扫描项目文件',
      ...(openTitle === undefined ? {} : { openTitle }),
    }
    render(<HeaderCatalog {...input} />)

    expect(screen.getByRole('button', { name: '切换子智能体：正在扫描项目文件' })).toBeTruthy()
    expect(input.refreshProjection).not.toHaveBeenCalled()
  })

  it('keeps a nested title switcher scoped to its direct-parent catalog', () => {
    const input = {
      ...props(catalog(), {
        [CHILD]: catalog({ entries: [{
          id: GRANDCHILD, mode: 'continuable',
          label: 'indexer', activity: 'inactive',
        }] }),
      }, {
        [CHILD]: {
          ...summary(CHILD, 1), parentId: PARENT, origin: 'subagent' as const,
        },
        [GRANDCHILD]: {
          ...summary(GRANDCHILD, 1), parentId: CHILD, origin: 'subagent' as const,
        },
      }),
      sessionId: GRANDCHILD,
      lineageSessionId: GRANDCHILD,
      displayTitle: 'indexer',
    }
    render(<HeaderCatalog {...input} />)

    hoverCatalog(screen.getByRole('button', { name: '切换子智能体：indexer' }))

    expect(input.refreshProjection).not.toHaveBeenCalled()
    const current = screen.getByRole('treeitem', { name: /indexer/ })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(within(current).getByText('indexer').className).toContain('currentLabel')
    expect(screen.queryByRole('treeitem', { name: /reviewer/ })).toBeNull()
  })
})

describe('SubagentReadOnlyComposer', () => {
  it('explains the exact missing-parent recovery path', () => {
    render(<SubagentReadOnlyComposer matched={{ reason: 'parent-unavailable' }} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('父会话当前不在线')
  })

  it('keeps an unknown child read-only until its descriptor is available', () => {
    render(<SubagentReadOnlyComposer matched={{ reason: 'unknown' }} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('读取子会话后才能确定是否可继续')
  })

  it('explains that one-shot histories never accept follow-ups', () => {
    render(<SubagentReadOnlyComposer matched={{ reason: 'one-shot' }} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('一次性任务不支持后续消息')
  })
})
