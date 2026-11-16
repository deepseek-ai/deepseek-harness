// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamProjection, TeamTaskId, TeamTaskView as TeamTask } from '@deepseek-ai/dsh-agent-team/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TeamBoard, TeamProgress, type TeamBoardProps, type TeamProgressProps } from '../src/client/TeamBoard.tsx'
import { createTeamBoardStore } from '../src/client/team-board-store.ts'
import { en, zh } from '../src/client/locales.ts'
import type { PanelDetailsProps, PanelFoldProps } from '@deepseek-ai/dsh-client-ui-session-panel/client'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SESSION = 'root-session-id' as SessionId
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
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
const team: TeamProjection = { enabled: true, tasks: [task] }
type Projections = SessionListState['projectionsBySession']

function summary(id: SessionId, title?: string): SessionSummary {
  return {
    id, ...(title === undefined ? {} : { title }), displayTitle: title ?? id,
    running: false, retainedBy: {}, blank: false, updatedAt: 0,
  }
}

/** One Session's board store, as the registration mints it. */
type BoardStore = ReturnType<ReturnType<typeof createTeamBoardStore>['create']>

/**
 * The Session panel's Factories as this suite renders them: the fold control as a button with its state, name, and
 * label, and a row's details as one element per part in order. ui-session-panel's own suite owns their markup.
 */
function renderPanelFactory(name: string, input: object) {
  if (name === 'conversation.session.panel.details') {
    const { title, lines = [], status, facts = [] } = input as PanelDetailsProps
    return (
      <div data-session-panel-details="">
        {title !== undefined && <div>{title}</div>}
        {lines.map(line => <div key={line}>{line}</div>)}
        {status !== undefined && <div data-state={status.state}>{status.label}</div>}
        {facts.length > 0 && <div>{facts.map(fact => <span key={fact.kind} data-fact={fact.kind}>{fact.label}</span>)}</div>}
      </div>
    )
  }
  const fold = input as PanelFoldProps
  return <button type="button" data-fold="" aria-expanded={fold.expanded} aria-label={fold.name} onClick={fold.onToggle}>{fold.label}</button>
}

function bench(options: {
  projections?: Projections
  sessionId?: SessionId
  byId?: Record<SessionId, SessionSummary>
  value?: TeamProjection
  store?: BoardStore
} = {}) {
  const sessionId = options.sessionId ?? SESSION
  const byId = options.byId ?? { [SESSION]: summary(SESSION) }
  const sessions = createSnapshotStore<SessionListState>({
    ids: Object.keys(byId) as SessionId[], byId, phase: 'ready',
    projectionsBySession: options.projections ?? { [SESSION]: { state: 'ready', error: null, values: { agentTeam: options.value ?? team } } },
  })
  const useProjection = ((_key: 'agentTeam', selector?: (value: TeamProjection | undefined) => unknown) =>
    bindSnapshotSelector(sessions)((state) => {
      const value = state.projectionsBySession[sessionId]?.values.agentTeam
      return selector === undefined ? value : selector(value)
    })) as TeamBoardProps['useProjection']
  const store = options.store ?? createTeamBoardStore().create()
  const props = {
    sessionId, useProjection,
    useSessions: bindSnapshotSelector(sessions),
    useStore: bindSnapshotSelector(store), actions: store.actions, renderFactorySlot: renderPanelFactory,
    t: makeTranslate(zh, commonZh),
  } as TeamBoardProps
  return { props, sessions, store }
}

function setProjectionSnapshot(
  sessions: ReturnType<typeof bench>['sessions'], sessionId: SessionId, snapshot: Projections[SessionId],
): void {
  act(() => {
    const current = sessions.getSnapshot()
    sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [sessionId]: snapshot } })
  })
}

function setProjection(sessions: ReturnType<typeof bench>['sessions'], sessionId: SessionId, value: TeamProjection): void {
  setProjectionSnapshot(sessions, sessionId, { state: 'ready', error: null, values: { agentTeam: value } })
}

function row(subject = task.subject): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(subject, 'u') })
}

function ownerValue(): string | null {
  return document.querySelector('[data-team-task-owner] span:last-child')?.textContent ?? null
}

function enableTooltips(): void {
  class TooltipObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const size = { inlineSize: 160, blockSize: 30 }
      this.callback([{
        target, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size], contentRect: new DOMRect(),
      }], this)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', TooltipObserver)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
}

/** The text the progress beside the section title renders for these props. */
function progressText(props: TeamBoardProps): string {
  const progress: Pick<TeamProgressProps, 'useProjection' | 't'> = { useProjection: props.useProjection, t: props.t }
  const view = render(<TeamProgress {...progress as TeamProgressProps} />)
  const text = view.container.textContent
  view.unmount()
  return text
}

describe('TeamBoard', () => {
  it('leaves the title to the panel and shows compact initially closed rows', () => {
    const b = bench()
    render(<TeamBoard {...b.props} />)
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getAllByRole('button')).toEqual([row()])
    expect(row().getAttribute('aria-expanded')).toBe('false')
    expect(row().textContent).toBe(task.subject)
    expect(within(row()).getByRole('img', { name: zh['status.in_progress'] })).toBeTruthy()
    expect(row().querySelector('[data-state="ongoing"]')).toBeTruthy()
    expect(row().querySelector('[data-icon="dsw-icon-chevron-down-outline-regular"]')).toBeTruthy()
    expect(screen.queryByText(task.description)).toBeNull()
    expect(screen.queryByText(zh.owner)).toBeNull()
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull()
  })

  it('expands the full description before the owner and keeps only one task open', () => {
    const longSubject = 'A complete subject that must remain readable when the task is expanded'
    const description = 'First line\n'.repeat(30) + 'Final description line'
    const b = bench({ value: { ...team, tasks: [
      { ...task, subject: longSubject, description },
      { ...task, id: TASK_2, subject: 'Review implementation', ownerId: WORKER, ownerName: 'worker' },
    ] } })
    render(<TeamBoard {...b.props} />)
    const first = row(longSubject)
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(row(longSubject)).toBe(first)
    const details = document.getElementById(first.getAttribute('aria-controls')!)!
    const owner = details.querySelector('[data-team-task-owner]')!
    expect(owner.tagName).toBe('P')
    expect(owner.textContent).toBe(`${zh.owner}: lead`)
    expect(ownerValue()).toBe('lead')
    const paragraphs = details.querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]?.textContent).toBe(description)
    expect(paragraphs[1]).toBe(owner)
    expect(details.querySelector('dl, dt, dd')).toBeNull()
    expect(screen.queryByText(TASK_1)).toBeNull()
    expect(screen.queryByText('src')).toBeNull()
    expect(screen.queryByText(task.writeScopeWarnings[0]!)).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    fireEvent.click(row('Review implementation'))
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(ownerValue()).toBe('worker')
    expect(document.querySelectorAll('[data-team-task-details]')).toHaveLength(1)
    expect(screen.queryByText(description)).toBeNull()
    fireEvent.click(row('Review implementation'))
    expect(ownerValue()).toBeNull()
    expect(screen.getAllByRole('button').every(button => button.getAttribute('aria-expanded') === 'false')).toBe(true)
  })

  it('lists tasks in progress, then pending, then completed, and excludes deleted tombstones from rows and counts', () => {
    const b = bench({ value: { ...team, tasks: [
      { ...task, subject: 'Pending first', status: 'pending', ready: true },
      { ...task, id: TASK_2, subject: 'Completed second', status: 'completed' },
      { ...task, id: 'third' as TeamTaskId, subject: 'Active third' },
      { ...task, id: 'deleted' as TeamTaskId, subject: 'Deleted task', status: 'deleted' },
    ] } })
    render(<TeamBoard {...b.props} />)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Active third', 'Pending first', 'Completed second'])
    expect(progressText(b.props)).toBe([
      b.props.t('progress.completed', { count: 1 }), b.props.t('progress.active', { count: 1 }), b.props.t('progress.pending', { count: 1 }),
    ].join('\u2002·\u2002'))
    expect(screen.queryByText('Deleted task')).toBeNull()
    expect(row('Pending first').querySelector('[data-state="idle"]')).toBeTruthy()
    expect(row('Completed second').querySelector('[data-state="done"]')).toBeTruthy()
    fireEvent.click(row('Completed second'))
    expect(row('Completed second').getAttribute('aria-expanded')).toBe('true')
    expect(ownerValue()).toBe('lead')
    expect(screen.getByText(task.description)).toBeTruthy()
  })

  /** A task named by its id. */
  const named = (id: string, status: TeamTask['status']): TeamTask => ({ ...task, id: id as TeamTaskId, subject: id, status, ready: true })
  /** The task rows' names in display order. */
  const shownTasks = (): (string | null)[] => [...document.querySelectorAll('[data-team-task]')].map(item => item.getAttribute('data-team-task'))
  const fold = (): HTMLElement | null => document.querySelector('[data-fold]')

  it('keeps source order within the tasks in progress and the pending ones, and lists the latest completed task first', () => {
    const b = bench({ value: { ...team, tasks: [
      named('done-1', 'completed'), named('wait-1', 'pending'), named('run-1', 'in_progress'), named('done-2', 'completed'),
      named('wait-2', 'pending'), named('run-2', 'in_progress'),
    ] } })
    render(<TeamBoard {...b.props} />)
    expect(shownTasks()).toEqual(['run-1', 'run-2', 'wait-1', 'wait-2', 'done-2', 'done-1'])
    // Six tasks show in full: folding would hold back one task for a control that takes a row itself.
    expect(fold()).toBeNull()
  })

  it('holds two tasks back from seven, behind a fold control that shows them and folds again', () => {
    const tasks = [
      named('done-1', 'completed'), named('done-2', 'completed'), named('run-1', 'in_progress'), named('wait-1', 'pending'),
      named('wait-2', 'pending'), named('wait-3', 'pending'), named('wait-4', 'pending'),
    ]
    const b = bench({ value: { ...team, tasks } })
    render(<TeamBoard {...b.props} />)
    expect(shownTasks()).toEqual(['run-1', 'wait-1', 'wait-2', 'wait-3', 'wait-4'])
    const control = fold() as HTMLElement
    expect([control.textContent, control.getAttribute('aria-label'), control.getAttribute('aria-expanded')])
      .toEqual(['显示其余 2 个', '显示其余 2 个（共享任务）', 'false'])
    // The control follows the list instead of joining it, so the list holds only tasks.
    expect(screen.getByRole('list').contains(control)).toBe(false)
    fireEvent.click(control)
    expect(shownTasks()).toEqual(['run-1', 'wait-1', 'wait-2', 'wait-3', 'wait-4', 'done-2', 'done-1'])
    expect([fold()?.textContent, fold()?.getAttribute('aria-label'), fold()?.getAttribute('aria-expanded')]).toEqual(['收起', '收起（共享任务）', 'true'])
    fireEvent.click(fold() as HTMLElement)
    expect(shownTasks()).toHaveLength(5)
    // The progress beside the title counts every task, shown or held back.
    expect(progressText(b.props)).toBe([
      b.props.t('progress.completed', { count: 2 }), b.props.t('progress.active', { count: 1 }), b.props.t('progress.pending', { count: 4 }),
    ].join('\u2002·\u2002'))
  })

  it('keeps the fold in the Session store while the section is unmounted', () => {
    const store = createTeamBoardStore().create()
    const tasks = Array.from({ length: 8 }, (_, index) => named(`wait-${index}`, 'pending'))
    const first = render(<TeamBoard {...bench({ value: { ...team, tasks }, store }).props} />)
    fireEvent.click(fold() as HTMLElement)
    expect(store.getSnapshot()).toEqual({ unfolded: true })
    first.unmount()
    render(<TeamBoard {...bench({ value: { ...team, tasks }, store }).props} />)
    expect(shownTasks()).toHaveLength(8)
    expect(fold()?.getAttribute('aria-expanded')).toBe('true')
  })

  it.each(Object.entries({ zh, en }))('names the fold control with its visible text first in %s', (_locale, copy) => {
    for (const label of [copy['list.more'].replace('{count}', '3'), copy['list.less']]) {
      expect(copy['list.foldName'].replace('{label}', label).startsWith(label)).toBe(true)
    }
  })

  it('announces blocked status without displaying readiness, dependencies, scopes, warnings, or task ids', () => {
    const { ownerId: _ownerId, ownerName: _ownerName, ...unowned } = task
    const b = bench({ value: { ...team, tasks: [
      { ...unowned, status: 'pending', blockedBy: [TASK_2, 'missing' as TeamTaskId] },
      { ...task, id: TASK_2, subject: 'Prepare shared types', status: 'completed' },
    ] } })
    render(<TeamBoard {...b.props} />)
    expect(within(row()).getByRole('img', { name: zh.blocked })).toBeTruthy()
    expect(row().querySelector('[data-state="warning"]')).toBeTruthy()
    fireEvent.click(row())
    expect(ownerValue()).toBe(zh.unowned)
    const details = document.querySelector<HTMLElement>('[data-team-task-details]')!
    expect(details.textContent).toBe(`${task.description}${zh.owner}: ${zh.unowned}`)
    expect(details.querySelector('dl, dt, dd')).toBeNull()
    for (const metadata of [
      TASK_1, TASK_2, 'Prepare shared types', 'missing', 'src', task.writeScopeWarnings[0]!, zh.blocked,
    ]) expect(within(details).queryByText(metadata)).toBeNull()
    expect(b.sessions.getSnapshot().projectionsBySession[SESSION]!.values.agentTeam?.tasks[0]).toEqual({
      ...unowned, status: 'pending', blockedBy: [TASK_2, 'missing' as TeamTaskId],
    })
  })

  it('keeps the pending glyph and shows only the owner when description is empty', () => {
    render(<TeamBoard {...bench({ value: { ...team, tasks: [{
      ...task, status: 'pending', ready: true, description: '', writeScopes: [], writeScopeWarnings: [],
    }] } }).props} />)
    fireEvent.click(row())
    expect(within(row()).getByRole('img', { name: zh['status.pending'] })).toBeTruthy()
    expect(row().querySelector('[data-state="idle"]')).toBeTruthy()
    expect(ownerValue()).toBe('lead')
    expect(document.querySelector('[data-team-task-details]')?.children).toHaveLength(1)
    expect(document.querySelector('[data-team-task-details] p:not([data-team-task-owner])')).toBeNull()
  })

  it('renders a saved owner path without loading its parent catalog', () => {
    const b = bench({ value: { ...team, tasks: [{ ...task, ownerId: NESTED, ownerName: 'worker/checker' }] } })
    render(<TeamBoard {...b.props} />)
    fireEvent.click(row())
    expect(ownerValue()).toBe('worker/checker')
    act(() => { b.sessions.update((draft) => { draft.byId[NESTED] = { ...summary(NESTED), displayTitle: 'Display title' } }) })
    expect(ownerValue()).toBe('worker/checker')
  })

  it('uses the owner Session ID when the saved task has no name', () => {
    const { ownerName: _ownerName, ...historical } = task
    const b = bench({ value: { ...team, tasks: [{ ...historical, ownerId: WORKER }] }, projections: {
      [SESSION]: { state: 'ready', error: null, values: {
        agentTeam: { ...team, tasks: [{ ...historical, ownerId: WORKER }] },
        subagentCatalog: [{ id: WORKER, createdAt: 0, mode: 'continuable', label: 'Worker', name: 'worker' }],
      } },
    } })
    render(<TeamBoard {...b.props} />)
    fireEvent.click(row())
    expect(ownerValue()).toBe(WORKER)
  })

  it('hides retained tasks while Team is disabled and shows them when enabled', () => {
    const b = bench()
    render(<TeamBoard {...b.props} />)
    setProjection(b.sessions, SESSION, { ...team, enabled: false })
    expect(progressText(b.props)).toBe('')
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByText(task.subject)).toBeNull()
    setProjection(b.sessions, SESSION, team)
    expect(row()).toBeTruthy()
  })

  it('accepts absent baselines, capability removal, empty tasks, and deleted-only snapshots', () => {
    const b = bench({ projections: {} })
    render(<TeamBoard {...b.props} />)
    expect(screen.queryByRole('region')).toBeNull()
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: { agentTeam: team } })
    expect(row()).toBeTruthy()
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: {} })
    expect(screen.queryByRole('region')).toBeNull()
    for (const tasks of [[], [{ ...task, status: 'deleted' as const }]]) {
      setProjection(b.sessions, SESSION, { enabled: true, tasks })
      expect(screen.queryByText(zh.empty)).toBeNull()
      expect(screen.queryByRole('heading')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('region')).toBeNull()
      expect(document.querySelector('[data-team-panel]')).toBeNull()
    }
  })

  it('reads only the current Session projection', () => {
    const b = bench({ sessionId: WORKER })
    render(<TeamBoard {...b.props} />)
    expect(screen.queryByRole('region')).toBeNull()
    setProjection(b.sessions, WORKER, { ...team, tasks: [{ ...task, subject: 'Current task' }] })
    expect(row('Current task')).toBeTruthy()
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, subject: 'Other task' }] })
    expect(screen.queryByText('Other task')).toBeNull()
  })

  it('keeps failures beside valid tasks but shows only an alert without visible tasks', () => {
    const b = bench({ value: { ...team, failure: 'revision is not contiguous' } })
    const view = render(<TeamBoard {...b.props} />)
    expect(screen.getByRole('alert').textContent).toBe('任务记录无效：revision is not contiguous')
    expect(row()).toBeTruthy()
    for (const tasks of [[], [{ ...task, status: 'deleted' as const }]]) {
      setProjectionSnapshot(b.sessions, SESSION, { state: 'ready', error: null, values: {
        agentTeam: { enabled: true, tasks, failure: 'invalid task' },
        subagentCatalog: [{ id: WORKER, createdAt: 0, mode: 'continuable', label: 'Worker' }],
      } })
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe('任务记录无效：invalid task')
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(view.container.textContent).toBe(alert.textContent)
      expect(screen.queryByText(zh.empty)).toBeNull()
      expect(progressText(b.props)).toBe('')
    }
    setProjection(b.sessions, SESSION, { enabled: false, tasks: [], failure: 'invalid task' })
    expect(view.container.childElementCount).toBe(0)
  })

  it('renders nothing for empty or deleted-only tasks even when members exist', () => {
    const b = bench()
    const view = render(<TeamBoard {...b.props} />)
    for (const tasks of [[], [{ ...task, status: 'deleted' as const }]]) {
      setProjectionSnapshot(b.sessions, SESSION, { state: 'ready', error: null, values: {
        agentTeam: { enabled: true, tasks },
        subagentCatalog: [{ id: WORKER, createdAt: 0, mode: 'continuable', label: 'Worker' }],
      } })
      expect(view.container.childElementCount).toBe(0)
    }
  })

  it('keeps live updates and expansion tied to task identity without sorting or polling', () => {
    const b = bench()
    render(<TeamBoard {...b.props} />)
    fireEvent.click(row())
    setProjection(b.sessions, SESSION, { ...team, tasks: [
      { ...task, id: TASK_2, subject: 'New task', status: 'pending', ready: true },
      { ...task, status: 'completed', description: 'Updated details' },
    ] })
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['New task', task.subject])
    expect(row().getAttribute('aria-expanded')).toBe('true')
    expect(row('New task').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('Updated details')).toBeTruthy()
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, status: 'deleted' }] })
    expect(screen.queryByText('Updated details')).toBeNull()
  })

  it('uses translated English progress and details without Show more or Show less controls', () => {
    const b = bench()
    render(<TeamBoard {...b.props} t={makeTranslate(en)} />)
    expect(progressText({ ...b.props, t: makeTranslate(en) })).toBe(makeTranslate(en)('progress.active', { count: 1 }))
    fireEvent.click(row())
    expect(ownerValue()).toBe('lead')
    expect(document.querySelector('[data-team-task-owner]')?.textContent).toBe(`${en.owner}: lead`)
    expect(screen.queryByText(TASK_1)).toBeNull()
    expect(screen.queryByText('Show more')).toBeNull()
    expect(screen.queryByText('Show less')).toBeNull()
  })

  it('shows the clipped owner tooltip after 500ms of hover', () => {
    vi.useFakeTimers()
    enableTooltips()
    const ownerId = '8c0404a0-4c67-48ab-9513-50b4a755d6de' as SessionId
    const { ownerName: _ownerName, ...historical } = task
    const b = bench({
      value: { ...team, tasks: [{ ...historical, ownerId }] },
    })
    const view = render(<TeamBoard {...b.props} />)
    fireEvent.click(row())
    const owner = screen.getByText(ownerId)
    expect(owner.parentElement?.hasAttribute('data-team-task-owner')).toBe(true)
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(80)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(80)
    fireEvent.pointerEnter(owner)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerLeave(owner)
    scrollWidth.mockImplementation(function (this: Element) { return this === owner ? 240 : 80 })
    fireEvent.pointerEnter(owner)
    act(() => { vi.advanceTimersByTime(499) })
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('tooltip').textContent).toBe(ownerId)
    expect(view.container.contains(screen.getByRole('tooltip'))).toBe(false)
    expect(document.querySelectorAll('[data-team-task-owner]')).toHaveLength(1)
    fireEvent.click(row())
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(ownerValue()).toBeNull()
  })

  it('shows the subject, owner, description, and state in a hover card after 500ms, and none while the row is expanded', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(any-hover: hover)' })))
    render(<TeamBoard {...bench().props} />)
    const button = row()
    const anchor = button.parentElement as HTMLElement
    const details = (): string[] | null => {
      const card = document.querySelector('[data-session-panel-details]')
      return card === null ? null : [...card.children].map(child => child.textContent ?? '')
    }
    fireEvent.pointerEnter(anchor, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(499) })
    expect(details()).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(details()).toEqual([task.subject, '负责人：lead', task.description, '进行中'])
    // Expanding the row shows the same details in place, so the card closes and stays closed.
    fireEvent.click(button)
    act(() => { vi.advanceTimersByTime(200) })
    expect(details()).toBeNull()
    fireEvent.pointerLeave(anchor, { pointerType: 'mouse' })
    fireEvent.pointerEnter(anchor, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(500) })
    expect(details()).toBeNull()
  })
})
