// @vitest-environment jsdom

import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionListState, SessionSnapshot, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TeamAction, type TeamActionProps } from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'
import { teamRootId } from '../src/client/team-root.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SESSION = 'lead' as SessionId
const WORKER = 'worker-id' as SessionId
const NESTED = 'nested-id' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
const TASK_2 = 'task-2' as TeamTaskId
const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerId: SESSION,
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
const team: TeamProjection = { tasks: [task] }

type Projections = SessionListState['projectionsBySession']

function summary(id: SessionId, title?: string): SessionSummary {
  return {
    id, ...(title === undefined ? {} : { title }), displayTitle: title ?? id,
    running: false, retainedBy: {}, blank: false, updatedAt: 0,
  }
}

function bench(options: {
  projections?: Projections
  sessionId?: SessionId
  parentSessionId?: SessionId
  openState?: SessionSnapshot['openState']
  byId?: Record<SessionId, SessionSummary>
} = {}) {
  const sessionId = options.sessionId ?? SESSION
  const byId = options.byId ?? { [SESSION]: summary(SESSION) }
  const sessions = createSnapshotStore<SessionListState>({
    ids: Object.keys(byId) as SessionId[], byId, phase: 'ready',
    projectionsBySession: options.projections ?? { [SESSION]: { state: 'ready', error: null, values: { agentTeam: team } } },
  })
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId,
    pendingSubmissions: [],
    running: false,
    subagent: options.parentSessionId === undefined
      ? null
      : { address: { parentSessionId: options.parentSessionId, childSessionId: sessionId, mode: 'continuable' } },
    removed: false,
    openState: options.openState ?? 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  })
  const props = {
    sessionId,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    t: makeTranslate(zh, commonZh),
  } as TeamActionProps
  return { props, sessions, session }
}

function openPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
}

function setProjectionSnapshot(
  sessions: ReturnType<typeof bench>['sessions'],
  sessionId: SessionId,
  snapshot: Projections[SessionId],
): void {
  act(() => {
    const current = sessions.getSnapshot()
    sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [sessionId]: snapshot } })
  })
}

function setProjection(sessions: ReturnType<typeof bench>['sessions'], sessionId: SessionId, value: TeamProjection): void {
  setProjectionSnapshot(sessions, sessionId, { state: 'ready', error: null, values: { agentTeam: value } })
}

describe('TeamAction', () => {
  it('shows the task board without a roster or a subagent catalog', () => {
    const b = bench({ byId: { [SESSION]: summary(SESSION, 'Open the task board.') } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText(task.subject)).toBeTruthy()
    expect(screen.getByText(`负责人: ${SESSION}`)).toBeTruthy()
    expect(screen.getByRole('heading', { name: '共享任务1' })).toBeTruthy()
    expect(screen.queryByText('historical member')).toBeNull()
    expect(screen.queryByText('old failure')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: /打开成员会话/u })).toBeNull()
  })

  it('keeps owner identity independent of catalog labels and Session titles', () => {
    const b = bench({
      byId: {
        [SESSION]: summary(SESSION),
        [WORKER]: { ...summary(WORKER), origin: 'subagent', parentId: SESSION },
        [NESTED]: { ...summary(NESTED), origin: 'subagent', parentId: WORKER },
      },
      projections: {
        [SESSION]: { state: 'ready', error: null, values: {
          agentTeam: { ...team, tasks: [{ ...task, ownerId: NESTED }] },
        } },
        [WORKER]: { state: 'ready', error: null, values: {
          subagentCatalog: [{ id: NESTED, createdAt: 0, mode: 'continuable', label: 'Nested implementer' }],
        } },
      },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText(`负责人: ${NESTED}`)).toBeTruthy()
    act(() => { b.sessions.update((draft) => { draft.byId[NESTED] = { ...draft.byId[NESTED]!, title: 'Runtime work' } }) })
    expect(screen.getByText(`负责人: ${NESTED}`)).toBeTruthy()
    act(() => { b.sessions.update((draft) => { draft.projectionsBySession = { [SESSION]: draft.projectionsBySession[SESSION]! } }) })
    expect(screen.getByText(`负责人: ${NESTED}`)).toBeTruthy()
    act(() => { b.sessions.set({
      ...b.sessions.getSnapshot(), byId: { [SESSION]: summary(SESSION), [WORKER]: summary(WORKER) },
    }) })
    expect(screen.getByText(`负责人: ${NESTED}`)).toBeTruthy()
  })

  it('shows the owner id when the Session summary is unavailable', () => {
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: {
      agentTeam: { ...team, tasks: [{ ...task, ownerId: WORKER }] },
      subagentCatalog: [{ id: WORKER, createdAt: 0, mode: 'continuable', label: 'Current responsibility' }],
    } } } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText(`负责人: ${WORKER}`)).toBeTruthy()
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, ownerId: WORKER }] })
    expect(screen.getByText(`负责人: ${WORKER}`)).toBeTruthy()
  })

  it('applies later projection frames without a refresh action', () => {
    const b = bench()
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /刷新|Refresh/u })).toBeNull()
    setProjection(b.sessions, SESSION, {
      ...team,
      tasks: [task, { ...task, id: TASK_2, subject: 'Pushed task', status: 'pending', ready: true, writeScopeWarnings: [] }],
    })
    expect(screen.getByText('Pushed task')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '共享任务2' })).toBeTruthy()
  })

  it.each([false, true])('accepts shared baselines and capability updates (descendant page: %s)', (addressed) => {
    const b = bench({
      ...(addressed ? { sessionId: WORKER, parentSessionId: SESSION } : {}),
      projections: {}, openState: 'loading',
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    act(() => { b.session.set({ ...b.session.getSnapshot(), openState: 'open' }) })
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: { agentTeam: team } })
    expect(screen.getByText(task.subject)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: {} })
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
    setProjection(b.sessions, SESSION, { tasks: [] })
    expect(screen.getByText(zh.empty)).toBeTruthy()
  })

  it('reads the root board from nested descendants and withholds it when ancestry is unavailable', () => {
    const b = bench({
      sessionId: NESTED, parentSessionId: WORKER,
      byId: { [SESSION]: summary(SESSION), [WORKER]: { ...summary(WORKER), origin: 'subagent', parentId: SESSION } },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText(task.subject)).toBeTruthy()
    act(() => { b.sessions.set({ ...b.sessions.getSnapshot(), byId: {} }) })
    expect(screen.queryByText(task.subject)).toBeNull()
    expect(screen.getByText(zh.unavailable)).toBeTruthy()
    expect(teamRootId(WORKER, SESSION, {
      [SESSION]: { ...summary(SESSION), origin: 'subagent' },
    })).toBeUndefined()
    expect(teamRootId(WORKER, SESSION, {
      [SESSION]: { ...summary(SESSION), origin: 'subagent', parentId: WORKER },
    })).toBeUndefined()
  })

  it('waits for the shared Session list and accepts cached projections', () => {
    const b = bench({ projections: {} })
    b.sessions.update((draft) => { draft.phase = 'pending' })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    act(() => { b.sessions.set({
      ...b.sessions.getSnapshot(), phase: 'ready',
      projectionsBySession: { [SESSION]: { state: 'idle', error: null, values: { agentTeam: team } } },
    }) })
    expect(screen.getByText(task.subject)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([false, true])('ignores unrelated Session updates (descendant page: %s)', (addressed) => {
    const b = bench(addressed ? { sessionId: WORKER, parentSessionId: SESSION } : {})
    const onRender = vi.fn()
    render(<Profiler id="team" onRender={onRender}><TeamAction {...b.props} /></Profiler>)
    openPanel()
    onRender.mockClear()
    act(() => {
      const current = b.sessions.getSnapshot()
      b.sessions.set({
        ...current,
        byId: { ...current.byId, ['unrelated' as SessionId]: summary('unrelated' as SessionId) },
        projectionsBySession: {
          ...current.projectionsBySession,
          ['unrelated' as SessionId]: { state: 'ready', error: null, values: { agentTeam: { tasks: [] } } },
        },
      })
    })
    expect(onRender).not.toHaveBeenCalled()
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, subject: 'Updated parent task' }] })
    expect(screen.getByText('Updated parent task')).toBeTruthy()
  })

  it('surfaces projection failure beside the last valid tasks', () => {
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: {
      agentTeam: { ...team, failure: 'revision is not contiguous' },
    } } } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('alert').textContent).toBe('任务记录无效：revision is not contiguous')
    expect(screen.getByText(task.subject)).toBeTruthy()
  })

  it('renders ready, blocked, completed, and unassigned tasks', () => {
    const { ownerId: _ownerId, ...unownedTask } = task
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: {
      ...team,
      tasks: [
        { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
        { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false, blockedBy: [TASK_1] },
        { ...task, id: 'completed-task' as TeamTaskId, status: 'completed', ownerId: WORKER },
      ],
    } } } } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getAllByText('负责人: 未分配')).toHaveLength(2)
    expect(screen.getByText(`负责人: ${WORKER}`)).toBeTruthy()
    const tasks = [...document.querySelectorAll('article')]
    expect(tasks.map(card => card.querySelector('[data-state]')?.getAttribute('data-state')))
      .toEqual(['idle', 'warning', 'done'])
    for (const card of tasks) expect(card.querySelector('button, input, select, textarea')).toBeNull()
  })

  it('closes the panel when the conversation switches sessions', () => {
    const rendered = render(<TeamAction {...bench().props} />)
    openPanel()
    const next = bench({ sessionId: 'next-root' as SessionId, projections: {}, openState: 'loading' })
    rendered.rerender(<TeamAction {...next.props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
  })

  it('keeps panel interactions open and dismisses on outside pointer or Escape', () => {
    const b = bench()
    const rendered = render(<TeamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: zh.trigger })
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    expect(rendered.container.contains(panel)).toBe(false)
    expect(document.activeElement).toBe(panel)
    fireEvent.pointerDown(panel)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([true, false])('clamps a long task description behind an expand toggle (ResizeObserver: %s)', async (resizeObserver) => {
    if (!resizeObserver) vi.stubGlobal('ResizeObserver', undefined)
    const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(120)
    const clientHeight = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(60)
    try {
      render(<TeamAction {...bench().props} />)
      fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
      const expand = await screen.findByRole('button', { name: zh['task.expand'] })
      const description = screen.getByText('Build the Team runtime')
      expect(expand.getAttribute('aria-expanded')).toBe('false')
      expect(description.className).not.toBe('')

      fireEvent.click(expand)
      const collapse = screen.getByRole('button', { name: zh['task.collapse'] })
      expect(collapse.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('Build the Team runtime').className).toBe('')

      fireEvent.click(collapse)
      expect(screen.getByRole('button', { name: zh['task.expand'] })).toBeTruthy()
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })

  it('opens on hover and preserves the trigger-to-panel crossing grace', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    const b = bench()
    const rendered = render(<TeamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: zh.trigger })
    const root = trigger.parentElement!

    fireEvent.mouseEnter(trigger)
    await advance(149)
    expect(screen.queryByRole('dialog')).toBeNull()
    await advance(1)
    const panel = screen.getByRole('dialog')

    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)

    fireEvent.mouseLeave(root)
    fireEvent.mouseEnter(panel)
    await advance(120)
    expect(screen.getByRole('dialog')).toBe(panel)

    fireEvent.mouseLeave(panel)
    await advance(119)
    expect(screen.getByRole('dialog')).toBe(panel)
    await advance(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root, { relatedTarget: document.body })
    rendered.unmount()
    await advance(150)
  })

  it('pins a click-opened panel through hover-out until explicit dismissal', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    render(<TeamAction {...bench().props} />)
    const trigger = screen.getByRole('button', { name: zh.trigger })
    const root = trigger.parentElement!

    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.mouseEnter(panel)
    fireEvent.mouseLeave(panel)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.mouseEnter(trigger)
    await advance(150)
    const hovered = screen.getByRole('dialog')
    fireEvent.click(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(hovered)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens by click only while the trigger is collapsed to its icon', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    render(<TeamAction {...bench().props} />)
    const trigger = screen.getByRole('button', { name: zh.trigger })
    const label = screen.getByText(zh.trigger)
    const computedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element =>
      element === label ? { display: 'none' } as CSSStyleDeclaration : computedStyle(element))

    fireEvent.mouseEnter(trigger)
    await advance(300)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps projection updates live without polling while pinned', async () => {
    vi.useFakeTimers()
    const b = bench()
    render(<TeamAction {...b.props} />)
    openPanel()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, subject: 'Pushed while pinned' }] })
    expect(screen.getByText('Pushed while pinned')).toBeTruthy()
  })

  it('keeps an accessible trigger name when its label is collapsed', () => {
    render(<TeamAction {...bench().props} />)
    screen.getByText(zh.trigger).style.display = 'none'
    expect(screen.getByRole('button', { name: zh.trigger })).toBeTruthy()
  })

  it('dismisses a hovered panel with Escape without stealing composer focus', async () => {
    vi.useFakeTimers()
    render(<><textarea aria-label="Composer" /><TeamAction {...bench().props} /></>)
    const composer = screen.getByRole('textbox')
    composer.focus()
    fireEvent.mouseEnter(screen.getByRole('button', { name: zh.trigger }))
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'a' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
  })
})

it('keeps the hover panel open when the pointer returns directly to its trigger', async () => {
  vi.useFakeTimers()
  render(<TeamAction {...bench().props} />)
  const trigger = screen.getByRole('button', { name: zh.trigger })
  fireEvent.mouseOver(trigger, { relatedTarget: document.body })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  const panel = screen.getByRole('dialog')
  fireEvent.mouseOut(trigger, { relatedTarget: panel })
  fireEvent.mouseOver(panel, { relatedTarget: trigger })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(screen.getByRole('dialog')).toBe(panel)
  fireEvent.mouseOut(panel, { relatedTarget: trigger })
  fireEvent.mouseOver(trigger, { relatedTarget: panel })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(screen.getByRole('dialog')).toBe(panel)
})

it('cancels pending hover dismissal when the trigger is activated from the keyboard', async () => {
  vi.useFakeTimers()
  render(<TeamAction {...bench().props} />)
  const trigger = screen.getByRole('button', { name: zh.trigger })
  trigger.focus()
  fireEvent.mouseOver(trigger, { relatedTarget: document.body })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  fireEvent.mouseOut(trigger, { relatedTarget: document.body })
  fireEvent.click(trigger, { detail: 0 })
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  expect(screen.getByRole('dialog')).toBe(document.activeElement)
})

it('updates expansion availability on paragraph resize and disconnects its observer', () => {
  const observers: TestResizeObserver[] = []
  class TestResizeObserver implements ResizeObserver {
    observe = vi.fn<ResizeObserver['observe']>()
    unobserve = vi.fn<ResizeObserver['unobserve']>()
    disconnect = vi.fn()
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(36)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(36)
  const view = render(<TeamAction {...bench().props} />)
  openPanel()
  const paragraph = screen.getByText('Build the Team runtime')
  const observer = observers.find(item => item.observe.mock.calls.some(([target]) => target === paragraph))!
  expect(observer).toBeDefined()
  expect(screen.queryByRole('button', { name: zh['task.expand'] })).toBeNull()
  scrollHeight.mockReturnValue(72)
  act(() => { observer.callback([], observer) })
  expect(screen.getByRole('button', { name: zh['task.expand'] })).toBeTruthy()
  scrollHeight.mockReturnValue(36)
  act(() => { observer.callback([], observer) })
  expect(screen.queryByRole('button', { name: zh['task.expand'] })).toBeNull()
  view.unmount()
  expect(observer.disconnect).toHaveBeenCalledOnce()
})
