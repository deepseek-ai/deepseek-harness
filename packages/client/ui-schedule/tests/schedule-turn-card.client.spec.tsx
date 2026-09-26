// @vitest-environment jsdom
/**
 * ui-schedule turn-level created-task card: the Turn-scoped accumulation of
 * settled `schedule_create` results, the turn-tail election, and the card's
 * rendering and open wiring.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ConversationNodeAssembler, type ConversationLocationDataSource, type ConversationLocationDataStore,
  type ConversationMatch, type ConversationNodeDefinition, type ConversationStartMatch,
  type ConversationTimelineSnapshot, type ConversationTurnDataMap,
  type ConversationViewDefinition, type ConversationViewNode, type ToolResultNode, type TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleTurnCard, type ScheduleTurnCardProps } from '../src/client/ScheduleTurnCard.tsx'
import { zoneLabel } from '../src/client/schedule-format.ts'
import {
  scheduleTasksForClosing, scheduleTurnDefinition, selectScheduleTasks,
  type ScheduleTurnData, type ScheduleTurnOwner,
} from '../src/client/schedule-turn.ts'
import { en, zh } from '../src/client/task-manager-locales.ts'

const CALL = 'call-created'
const PROMPT = 'Check the deployment\nand report'
const ARGS = { prompt: PROMPT, daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } }

const dailyTask = {
  id: 'task-daily', kind: 'daily', prompt: PROMPT, scheduledAt: '2026-10-01T15:00:00.000Z',
  time: '23:00:00.000', timeZone: 'Asia/Shanghai',
}

const weeklyTask = {
  id: 'task-weekly', kind: 'weekly', prompt: PROMPT, scheduledAt: '2026-10-01T01:00:00.000Z',
  time: '09:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [1, 3],
}

afterEach(cleanup)

class TestTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()
  private readonly sources = new Map<string, ConversationLocationDataSource<unknown>>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  source<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined> {
    let source = this.sources.get(key)
    if (source === undefined) {
      source = { getSnapshot: () => this.get(key), subscribe: () => () => {} }
      this.sources.set(key, source)
    }
    return source as ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined>
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

function turnLocation(turn: number, data?: ScheduleTurnData, endSeq?: number): TurnLocation {
  const store = new TestTurnDataStore()
  if (data !== undefined) store.set('schedule-created', data)
  return {
    turn,
    start: undefined,
    status: 'closed',
    steps: [],
    data: store,
    end: endSeq === undefined ? undefined : at(endSeq, 'turn/end', { turn }).event as SessionEvent<'turn/end'>,
  }
}

/** Turn-tail owner currency over one hand-built Turn. */
function tailOwner(data: ScheduleTurnData | undefined, seq: number, turn = 1): ScheduleTurnOwner {
  return { seq, openFile: vi.fn(), turn: turnLocation(turn, data) }
}

interface TimelineSnapshot {
  readonly timeline: ConversationTimelineSnapshot
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [scheduleTurnDefinition] }
  fallbackEntry(): ConversationNodeDefinition | undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [timelineViewDefinition] }
}

const timelineViewDefinition: ConversationViewDefinition<ConversationViewNode, TimelineSnapshot> = {
  target: 'test',
  create: () => {
    let current: TimelineSnapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return {
      empty: current,
      replace: ({ timeline }) => (current = { timeline }),
      apply: ({ timeline }) => (current = { timeline }),
    }
  },
}

function at(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      seq, time: seq * 1_000, type, data,
      ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}),
    } as SessionEvent,
  }
}

function call(seq: number, callId: string, name: string, args: unknown, turn = 1): SessionLiveEventEntry {
  return at(seq, 'tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) })
}

function result(seq: number, callId: string, text: string, isError = false, turn = 1): SessionLiveEventEntry {
  return at(seq, 'tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      isError,
    }),
  })
}

function assembler(entries: readonly SessionLiveEventEntry[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, false)
  value.activateTarget('test')
  return value
}

/** One assembled event carrying an explicit surface operation. */
function surfaceEvent(entry: SessionLiveEventEntry, surfaceOp: string): SessionEvent {
  return { ...entry.event, surfaceOp } as SessionEvent
}

function scheduleOf(value: ConversationNodeAssembler, turn = 1): Readonly<ScheduleTurnData> | undefined {
  const snapshot = value.snapshot('test') as TimelineSnapshot
  return snapshot.timeline.turns.get(turn)?.data.get('schedule-created')
}

/** One settled result node as the Turn Definition records it. */
function settledBlock(task: unknown, callId = CALL): ToolResultNode {
  return {
    kind: 'tool-result', seq: 3, time: 3_000, callId,
    call: { name: 'schedule_create', argsRaw: JSON.stringify(ARGS) },
    callTime: 2_000,
    content: [{ type: 'text', text: JSON.stringify(task) }],
    isError: false,
    subCalls: [],
  }
}

/**
 * Component props over one settled task the Turn recorded.
 * @param created - settled result nodes the Turn published.
 * @param openTaskDetail - injected navigation spy.
 * @param t - active locale copy.
 * @param records - records the Host catalog read holds.
 * @param status - that read's status.
 * @param settled - whether a read has already succeeded; a first read can fail,
 * so a failed status alone states no settled read unless the case says so.
 * @returns the turn row's props.
 */
function cardProps(
  created: readonly ToolResultNode[],
  openTaskDetail = vi.fn(),
  t = makeTranslate(en),
  records: readonly ScheduleCatalogEntry[] = created.map((block) => {
    const task = JSON.parse(block.content[0]?.type === 'text' ? block.content[0].text : '{}') as {
      readonly prompt?: string
      readonly title?: string
    }
    return {
      ...task,
      title: task.title ?? task.prompt?.split('\n', 1)[0] ?? '',
      sessionId: 'session',
      status: 'active',
    } as ScheduleCatalogEntry
  }),
  status: 'loading' | 'ready' | 'error' = 'ready',
  settled = status === 'ready',
  readRequest = 0,
  readSettled = 0,
  onRetry = vi.fn(async () => {}),
): ScheduleTurnCardProps {
  const snapshot = { records, status, deleting: [], settled, readRequest, readSettled }
  // The card under test reads none of the session-standard kit the runtime also
  // delivers, so the fake leaves those members to the assertion below.
  const props: Partial<ScheduleTurnCardProps> = {
    ...tailOwner({ created }, 3),
    openTaskDetail,
    onRetry,
    t,
    useCatalog: <Selected,>(select: (value: typeof snapshot) => Selected) => select(snapshot),
  }
  return props as ScheduleTurnCardProps
}

describe('schedule-created Turn data', () => {
  it('folds the created task of one settled schedule_create call into its Turn', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, CALL, 'schedule_create', ARGS),
      result(3, CALL, JSON.stringify(dailyTask)),
    ])
    const data = scheduleOf(value)
    expect(data?.created).toHaveLength(1)
    expect(data?.created[0]?.seq).toBe(3)
    expect(data?.created[0]?.callId).toBe(CALL)
    expect(data?.created[0]?.call?.name).toBe('schedule_create')
    expect(data?.created[0]?.content).toEqual([{ type: 'text', text: JSON.stringify(dailyTask) }])
  })

  it('creates nothing for a running call or a result that names no created task', () => {
    for (const events of [
      // Running: the call has not settled, so the Turn publishes no task.
      [call(2, CALL, 'schedule_create', ARGS)],
      [call(2, CALL, 'schedule_create', ARGS), result(3, CALL, JSON.stringify(dailyTask), true)],
      [call(2, CALL, 'schedule_create', ARGS), result(3, CALL, JSON.stringify({ code: 'invalid_rule', message: 'no' }))],
      [call(2, CALL, 'schedule_create', ARGS), result(3, CALL, 'not json')],
      [call(2, CALL, 'schedule_create', ARGS), result(3, CALL, JSON.stringify({ kind: 'at', prompt: PROMPT }))],
      [call(2, CALL, 'write', { file_path: 'a.txt' }), result(3, CALL, JSON.stringify(dailyTask))],
      [result(3, 'unpaired', JSON.stringify(dailyTask))],
    ]) {
      expect(scheduleTasksForClosing(scheduleOf(assembler([at(1, 'turn/start', { turn: 1 }), ...events])))).toEqual([])
    }
  })

  it('keeps one failed call from hiding a later successful creation', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'failed', 'schedule_create', ARGS),
      result(3, 'failed', JSON.stringify({ code: 'invalid_rule' })),
      call(4, CALL, 'schedule_create', ARGS),
      result(5, CALL, JSON.stringify(dailyTask)),
    ])
    expect(scheduleOf(value)?.created).toHaveLength(1)
    expect(scheduleOf(value)?.created[0]?.callId).toBe(CALL)
  })

  it('tracks turns separately and stops at the closing Assistant seq', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, CALL, 'schedule_create', ARGS),
      result(3, CALL, JSON.stringify(dailyTask)),
      at(4, 'turn/start', { turn: 2 }),
      call(5, 'call-two', 'schedule_create', ARGS, 2),
      result(6, 'call-two', JSON.stringify(weeklyTask), false, 2),
    ])
    expect(scheduleTasksForClosing(scheduleOf(value, 1))).toHaveLength(1)
    expect(scheduleTasksForClosing(scheduleOf(value, 2))).toHaveLength(1)
    expect(scheduleTasksForClosing(scheduleOf(value, 1), 2)).toEqual([])
    expect(scheduleTasksForClosing(undefined)).toEqual([])
  })

  it('keeps a creation that settles after the closing Assistant text', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(5, CALL, 'schedule_create', ARGS),
      result(7, CALL, JSON.stringify(dailyTask)),
    ])
    const data = scheduleOf(value)
    // The closing Assistant text is seq 5 and the settled creation is seq 7: the
    // turn ended at seq 8, so the card must still claim this completed turn.
    const closed: ScheduleTurnOwner = { seq: 5, openFile: vi.fn(), turn: turnLocation(1, data, 8) }
    expect(selectScheduleTasks(closed)?.created.map(created => created.seq)).toEqual([7])
    // The same owner against an end before the settlement keeps excluding it.
    const endedEarlier: ScheduleTurnOwner = { seq: 5, openFile: vi.fn(), turn: turnLocation(1, data, 6) }
    expect(selectScheduleTasks(endedEarlier)).toBeNull()
    // A turn with no recorded end still bounds on the owner's own sequence.
    const open: ScheduleTurnOwner = { seq: 5, openFile: vi.fn(), turn: turnLocation(1, data) }
    expect(selectScheduleTasks(open)).toBeNull()
  })

  it('claims the turn tail only for a turn that created a task', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, CALL, 'schedule_create', ARGS),
      result(3, CALL, JSON.stringify(dailyTask)),
    ])
    const matched = selectScheduleTasks(tailOwner(scheduleOf(value), 3))
    expect(matched?.created).toHaveLength(1)
    expect(selectScheduleTasks(tailOwner(undefined, 3))).toBeNull()
    expect(selectScheduleTasks(tailOwner({ created: [] }, 3))).toBeNull()
    expect(selectScheduleTasks(tailOwner(scheduleOf(value), 2))).toBeNull()
  })
})

describe('ScheduleTurnCard', () => {
  /**
   * Mount one card and render the snapshot the read it asked for publishes.
   *
   * The card anchors the read revision it mounted at and requests a read itself,
   * so its answer is causal rather than a clock comparison: a case mounts under
   * one snapshot, the read this card asked for lands, and the next render carries
   * that read's snapshot.
   * @param created - settled result nodes the Turn published.
   * @param read - records the read that lands after the card reports.
   * @param mount - snapshot the card mounts under; an unsettled first read by default.
   * @returns the mounted view, a renderer for later snapshots, and the spies.
   */
  function mountTurnCard(
    created: readonly ToolResultNode[],
    read: readonly ScheduleCatalogEntry[],
    mount: {
      readonly records?: readonly ScheduleCatalogEntry[]
      readonly status?: 'loading' | 'ready' | 'error'
      readonly settled?: boolean
      readonly readRequest?: number
      readonly readSettled?: number
    } = {},
  ) {
    const openTaskDetail = vi.fn()
    const onRetry = vi.fn(async () => {})
    /** Props of the snapshot one later read publishes. */
    const snapshot = (next: {
      readonly records?: readonly ScheduleCatalogEntry[]
      readonly status?: 'loading' | 'ready' | 'error'
      readonly settled?: boolean
      readonly readRequest?: number
      readonly readSettled?: number
    } = {}): ScheduleTurnCardProps => cardProps(
      created, openTaskDetail, makeTranslate(en),
      next.records ?? read, next.status ?? 'ready', next.settled ?? true,
      next.readRequest ?? 1, next.readSettled ?? 1, onRetry,
    )
    const view = render(<ScheduleTurnCard {...cardProps(
      created, openTaskDetail, makeTranslate(en),
      mount.records ?? [], mount.status ?? 'loading', mount.settled ?? false,
      mount.readRequest ?? 0, mount.readSettled ?? 0, onRetry,
    )} />)
    return { view, snapshot, onRetry, openTaskDetail }
  }

  it('asks for one read when it appears', () => {
    // The card records the revision it mounted at and asks for the read that will
    // answer for it, so that query follows the cards by cause, not by clock.
    const { onRetry } = mountTurnCard([settledBlock(dailyTask)], [])
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('renders the created task beneath the turn with its frequency and open action', () => {
    const openTaskDetail = vi.fn()
    render(<ScheduleTurnCard {...cardProps([settledBlock(dailyTask)], openTaskDetail)} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Open' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open task details: Check the deployment' }))
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('task-daily' as ScheduleId)
  })

  it('renders the stored title of the created task rather than its instruction', () => {
    const openTaskDetail = vi.fn()
    render(<ScheduleTurnCard {...cardProps([settledBlock({ ...dailyTask, title: 'Deployment check' })], openTaskDetail)} />)
    expect(screen.getByText('Deployment check')).toBeDefined()
    expect(screen.queryByText('Check the deployment')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open task details: Deployment check' }))
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('task-daily' as ScheduleId)
  })

  it('replaces the creation result with the current task title and timing', async () => {
    const current = {
      ...weeklyTask,
      id: dailyTask.id,
      title: 'Updated deployment check',
      sessionId: 'session',
      status: 'active',
    } as ScheduleCatalogEntry
    const { view, snapshot } = mountTurnCard([settledBlock(dailyTask)], [current])
    await act(async () => {})
    view.rerender(<ScheduleTurnCard {...snapshot()} />)
    expect(screen.queryByText('Check the deployment')).toBeNull()
    expect(screen.getByText('Updated deployment check')).toBeDefined()
    expect(screen.getByText(`Weekly on Mon, Wed at 09:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
  })

  it('marks a removed task as deleted and removes its open action', async () => {
    const { view, snapshot } = mountTurnCard([settledBlock(dailyTask)], [])
    await act(async () => {})
    view.rerender(<ScheduleTurnCard {...snapshot()} />)
    expect(screen.getByText('Deleted')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open task details: Check the deployment' })).toBeNull()
  })

  it('keeps the created rule while the catalog answer predates the card', async () => {
    // The catalog already answered before this card appeared (revision 5), and that
    // answer holds no row for the task. Only a read that lands after the card may
    // state that absence, because an earlier read may predate the creation.
    const { view, snapshot } = mountTurnCard(
      [settledBlock(dailyTask)], [], { status: 'ready', settled: true, readRequest: 5, readSettled: 5 },
    )
    await act(async () => {})
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    expect(screen.queryByText('Deleted')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open task details: Check the deployment' })).toBeDefined()

    // The read this card asked for lands at the next revision and states it.
    view.rerender(<ScheduleTurnCard {...snapshot({ readRequest: 6, readSettled: 6 })} />)
    expect(screen.getByText('Deleted')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open task details: Check the deployment' })).toBeNull()
  })

  it('keeps the created rule while a read sent before it settles', async () => {
    // A read was already in flight when this card appeared, and the card anchored
    // the ordinal it saw at mount (6). That read settling holds no row for the task,
    // but it was sent before the card, so it cannot state the card's absence.
    const { view, snapshot, onRetry } = mountTurnCard(
      [settledBlock(dailyTask)], [], { status: 'loading', settled: true, readRequest: 6, readSettled: 5 },
    )
    // The card asks for the read that can answer for it by naming the ordinal it
    // observed at mount, so a read sent before it cannot be handed back.
    expect(onRetry).toHaveBeenCalledWith(6)
    await act(async () => {})
    view.rerender(<ScheduleTurnCard {...snapshot({ readRequest: 6, readSettled: 6 })} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    expect(screen.queryByText('Deleted')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open task details: Check the deployment' })).toBeDefined()

    // Only the read sent after the card settles past its anchor and states it.
    view.rerender(<ScheduleTurnCard {...snapshot({ readRequest: 7, readSettled: 7 })} />)
    expect(screen.getByText('Deleted')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open task details: Check the deployment' })).toBeNull()
  })

  it('does not state a deletion without a read that succeeded after it appeared', async () => {
    const { view, snapshot } = mountTurnCard([settledBlock(dailyTask)], [])

    // The read that failed leaves the revision where mounting found it, so nothing
    // has answered since this card appeared: its absence states no deletion, and
    // the card keeps the rule the creation call wrote with its open action.
    await act(async () => {})
    view.rerender(<ScheduleTurnCard {...snapshot({ status: 'error', settled: false, readRequest: 0, readSettled: 0 })} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    expect(screen.queryByText('Deleted')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open task details: Check the deployment' })).toBeDefined()

    // A read that succeeds afterwards and still holds no row states the deletion.
    view.rerender(<ScheduleTurnCard {...snapshot()} />)
    expect(screen.getByText('Deleted')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open task details: Check the deployment' })).toBeNull()
  })

  it('keeps a confirmed deletion across a refresh', async () => {
    const { view, snapshot } = mountTurnCard([settledBlock(dailyTask)], [])
    await act(async () => {})
    view.rerender(<ScheduleTurnCard {...snapshot()} />)
    // The read that landed after the card appeared reports no row for the task.
    expect(screen.getByText('Deleted')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open task details: Check the deployment' })).toBeNull()

    // A refresh republishes loading over the retained records, and a failed refresh
    // only changes the status: both keep the revision that already reconciled, so
    // the deletion stands and the open action stays away.
    for (const status of ['loading', 'error'] as const) {
      view.rerender(<ScheduleTurnCard {...snapshot({ status })} />)
      expect([status, screen.queryByText('Deleted') !== null]).toEqual([status, true])
      expect([status, screen.queryByRole('button', { name: 'Open task details: Check the deployment' })]).toEqual([status, null])
    }

    // A later successful read holds no row either, so it states the same.
    view.rerender(<ScheduleTurnCard {...snapshot({ readRequest: 2, readSettled: 2 })} />)
    expect(screen.getByText('Deleted')).toBeDefined()
  })

  it('keeps the created rule when the first catalog read failed', async () => {
    const { view, snapshot } = mountTurnCard([settledBlock(dailyTask)], [])

    // A first read that failed never succeeded, so nothing has answered since the
    // card appeared: it stays as the creation call wrote it.
    await act(async () => {})
    view.rerender(<ScheduleTurnCard {...snapshot({ status: 'error', settled: false, readRequest: 0, readSettled: 0 })} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    expect(screen.queryByText('Deleted')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open task details: Check the deployment' })).toBeDefined()

    // A read that succeeds afterwards and reports no row states the deletion.
    view.rerender(<ScheduleTurnCard {...snapshot()} />)
    expect(screen.getByText('Deleted')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Open task details: Check the deployment' })).toBeNull()
  })

  it('keeps the created rule until the catalog read settles', () => {
    // A read that has not settled cannot say the task is gone: the card stays as
    // the call wrote it instead of claiming a deletion it cannot establish.
    render(<ScheduleTurnCard {...cardProps([settledBlock(dailyTask)], vi.fn(), makeTranslate(en), [], 'loading')} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    expect(screen.queryByText('Deleted')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open task details: Check the deployment' })).toBeDefined()
  })

  it('renders a settled result that names no task as its own text', () => {
    // The Turn publishes every settled `schedule_create`; a result the card cannot
    // read as a task keeps the title its own arguments announced and its raw text,
    // and the catalog is not consulted for a task identity it does not have.
    const failed = settledBlock(undefined, CALL)
    failed.content = [{ type: 'text', text: 'no stored task' }]
    render(<ScheduleTurnCard {...cardProps([failed], vi.fn(), makeTranslate(en), [])} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText('no stored task')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('Deleted')).toBeNull()
  })

  it('renders one card per created task of the turn', () => {
    const openTaskDetail = vi.fn()
    const later = { ...weeklyTask, id: 'task-later', prompt: 'Summarize the incident' }
    const view = render(<ScheduleTurnCard {...cardProps([
      settledBlock(dailyTask),
      settledBlock(later, 'call-later'),
    ], openTaskDetail)} />)
    expect(view.container.querySelectorAll('[data-tool="schedule_create"]')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Open task details: Check the deployment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open task details: Summarize the incident' }))
    expect(openTaskDetail).toHaveBeenNthCalledWith(1, 'task-daily' as ScheduleId)
    expect(openTaskDetail).toHaveBeenNthCalledWith(2, 'task-later' as ScheduleId)
  })

  it.each([
    [dailyTask, `Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`],
    [weeklyTask, `Weekly on Mon, Wed at 09:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`],
  ])('formats the frequency line of one created task', (task, frequency) => {
    render(<ScheduleTurnCard {...cardProps([settledBlock(task)])} />)
    expect(screen.getByText(frequency)).toBeDefined()
  })

  it('opens the task and shows the weekly frequency in the active locale', () => {
    const openTaskDetail = vi.fn()
    render(<ScheduleTurnCard {...cardProps(
      [settledBlock(weeklyTask)], openTaskDetail, makeTranslate(zh),
    )} />)
    expect(screen.getByText(`每周一、三 09:00（${zoneLabel('Asia/Shanghai', makeTranslate(zh))}）`)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '打开任务详情：Check the deployment' }))
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('task-weekly' as ScheduleId)
  })

  it('renders no card when the turn created none', () => {
    const view = render(<ScheduleTurnCard {...cardProps([])} />)
    expect(view.container.querySelector('[data-tool="schedule_create"]')).toBeNull()
  })
})

describe('schedule-created Definition lifecycle', () => {
  const location = { kind: 'session' } as const

  function updateMatch(event: SessionEvent): ConversationMatch {
    return { event, role: 'update', location }
  }

  function startMatch(event: SessionEvent): ConversationStartMatch {
    return { event, role: 'start', location }
  }

  /** State the Definition adopts for one Turn start. */
  function startedTurn(turn = 1) {
    return scheduleTurnDefinition.start({} as never, startMatch(at(1, 'turn/start', { turn }).event), {} as never)
  }

  it('matches a turn start, a call, and an appended result, and nothing else', () => {
    expect(scheduleTurnDefinition.match(at(1, 'turn/start', { turn: 1 }).event))
      .toEqual({ id: '1', role: 'start' })
    expect(scheduleTurnDefinition.match(call(2, CALL, 'schedule_create', ARGS).event))
      .toEqual({ id: '1', role: 'update' })
    expect(scheduleTurnDefinition.match(result(3, CALL, JSON.stringify(dailyTask)).event))
      .toEqual({ id: '1', role: 'update' })
    // A replacement copy and an unrelated event belong to no created-task Turn.
    expect(scheduleTurnDefinition.match(surfaceEvent(result(4, CALL, JSON.stringify(dailyTask)), 'replace')))
      .toBeNull()
    expect(scheduleTurnDefinition.match(at(5, 'assistant/message', { turn: 1 }).event)).toBeNull()
  })

  it('refuses to start from an event that is not a turn start', () => {
    const refusing = startMatch(call(2, CALL, 'schedule_create', ARGS).event)
    expect(() => scheduleTurnDefinition.start({} as never, refusing, {} as never))
      .toThrow('schedule-created start requires turn/start')
  })

  it('accumulates only the results of matching calls and ignores an unmatched update', () => {
    const empty = startedTurn()
    const afterCall = scheduleTurnDefinition.update(
      { state: empty } as never,
      updateMatch(call(2, CALL, 'schedule_create', ARGS).event),
    )
    expect([...afterCall.calls.keys()]).toEqual([CALL])
    // An update that is neither a call nor a result keeps the accumulated state.
    expect(scheduleTurnDefinition.update(
      { state: afterCall } as never,
      updateMatch(at(3, 'assistant/message', { turn: 1 }).event),
    )).toBe(afterCall)
    const settled = scheduleTurnDefinition.update(
      { state: afterCall } as never,
      updateMatch(result(4, CALL, JSON.stringify(dailyTask)).event),
    )
    expect(settled.created).toHaveLength(1)
    expect(settled.created[0]?.callId).toBe(CALL)
  })

  it('publishes the created tasks at Turn scope and reuses an unchanged predecessor', () => {
    const state = startedTurn()
    const build = (from: unknown, scope: 'step' | 'turn', previous: unknown) =>
      scheduleTurnDefinition.buildLocationData!({ state: from } as never, scope, previous as never)

    // A Step phase and a Context without State publish nothing.
    expect(build(state, 'step', null)).toBeNull()
    expect(build(undefined, 'turn', null)).toBeNull()
    const built = build(state, 'turn', null)!
    expect(built).toEqual({ kind: 'turn', turn: 1, key: 'schedule-created', value: { created: [] } })
    // A predecessor from another location, Turn, or key is replaced.
    for (const stale of [
      { kind: 'step', turn: 1, step: 1, key: 'schedule-created', value: { created: [] } },
      { kind: 'turn', turn: 2, key: 'schedule-created', value: { created: [] } },
      { kind: 'turn', turn: 1, key: 'another-key', value: { created: [] } },
    ]) {
      expect(build(state, 'turn', stale)).not.toBe(built)
      expect(build(state, 'turn', stale)).toEqual({ kind: 'turn', turn: 1, key: 'schedule-created', value: { created: [] } })
    }
    // The identical predecessor value is preserved by reference.
    expect(build(state, 'turn', built)).toBe(built)
    // A different created array republishes.
    expect(build({ ...state, created: [] }, 'turn', built)).not.toBe(built)
  })
})
