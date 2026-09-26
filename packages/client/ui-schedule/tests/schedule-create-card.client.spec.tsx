// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ScheduleCreateCard, type ScheduleCreateCardProps } from '../src/client/ScheduleCreateCard.tsx'
import { narrowScheduleRecord, scheduleCreateCardModel } from '../src/client/schedule-create-card.ts'
import { zoneLabel } from '../src/client/schedule-format.ts'
import { en, zh } from '../src/client/task-manager-locales.ts'

type ToolBlock = ToolCallViewProps['block']

const TOOL = 'schedule_create'
const CALL = 'call-created'
const PROMPT = 'Check the deployment\nand report'
const ARGS = { prompt: PROMPT, daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } }

const dailyTask = {
  id: 'task-daily', kind: 'daily', title: 'Check the deployment', prompt: PROMPT,
  scheduledAt: '2026-10-01T15:00:00.000Z', time: '23:00:00.000', timeZone: 'Asia/Shanghai',
}

const weeklyTask = {
  id: 'task-weekly', kind: 'weekly', title: 'Check the deployment', prompt: PROMPT,
  scheduledAt: '2026-10-01T01:00:00.000Z', time: '09:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [1, 3],
}

const cronTask = {
  id: 'task-cron', kind: 'cron', title: 'Check the deployment', prompt: PROMPT,
  scheduledAt: '2026-10-01T01:15:00.000Z', expression: '*/15 9-17 * * 1-5', timeZone: 'Asia/Shanghai',
}

afterEach(cleanup)

/** One running call block carrying the model's own arguments. */
function running(args: unknown = ARGS): ToolBlock {
  return {
    phase: 'start',
    callId: CALL, name: TOOL, argsRaw: typeof args === 'string' ? args : JSON.stringify(args),
    turn: 1, step: 1, time: 0, subCalls: [],
  }
}

/** One settled result block whose result text is the canonical value by default. */
function settled(value: unknown, options: {
  args?: unknown
  text?: string
  content?: readonly unknown[]
  isError?: boolean
  call?: boolean
} = {}): ToolBlock {
  return {
    kind: 'tool-result', seq: 1, time: 1, callId: CALL,
    call: options.call === false ? null : {
      name: TOOL,
      argsRaw: typeof options.args === 'string' ? options.args : JSON.stringify(options.args ?? ARGS),
    },
    callTime: 0,
    content: options.content ?? [{ type: 'text', text: options.text ?? JSON.stringify(value) }],
    isError: options.isError ?? false,
    subCalls: [],
  } as ToolBlock
}

/** One catalog entry the settled read holds for a narrowed fixture. */
function catalogEntry(fixture: unknown, status: ScheduleCatalogEntry['status'] = 'active'): ScheduleCatalogEntry {
  const task = narrowScheduleRecord(fixture)
  if (task === undefined) throw new Error('fixture must narrow to a rule')
  return { ...task, sessionId: 'session-alpha' as SessionId, status }
}

/** Component props with an injected open action; the framework fills the rest. */
function props(block: ToolBlock, openTaskDetail = vi.fn(), t = makeTranslate(en)): ScheduleCreateCardProps {
  return {
    callId: CALL, toolName: TOOL, block, openFile: vi.fn(), loadImage: vi.fn(), openTaskDetail, t,
  } as ScheduleCreateCardProps
}

describe('narrowScheduleRecord', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a scalar', 'task'],
    ['an array', []],
    ['no identity', { kind: 'at', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt }],
    ['an empty identity', { ...dailyTask, id: '' }],
    ['no prompt', { ...dailyTask, prompt: undefined }],
    ['an empty prompt', { ...dailyTask, prompt: '' }],
    ['a non-string prompt', { ...dailyTask, prompt: 7 }],
    ['a title and instruction whose first line is empty', { ...dailyTask, title: '', prompt: '\nCheck the deployment' }],
    ['no target', { ...dailyTask, scheduledAt: undefined }],
    ['an unknown kind', { ...dailyTask, kind: 'cronx' }],
    ['an after rule without its delay', { ...dailyTask, kind: 'after' }],
    ['an every rule without its interval', { ...dailyTask, kind: 'every' }],
    ['a daily rule without its time', { id: 'x', kind: 'daily', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt, timeZone: 'UTC' }],
    ['a daily rule without its zone', { id: 'x', kind: 'daily', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt, time: '09:00:00' }],
    ['a weekly rule without its weekdays', { ...dailyTask, kind: 'weekly' }],
    ['a weekly rule without its time', { ...weeklyTask, time: undefined }],
    ['a weekly rule without its zone', { ...weeklyTask, timeZone: undefined }],
    ['a weekly rule with a non-array weekday set', { ...weeklyTask, weekdays: 'Mon' }],
    ['a weekly rule with a non-number weekday', { ...weeklyTask, weekdays: ['Mon'] }],
    ['a cron rule without its expression', { ...cronTask, expression: undefined }],
    ['a cron rule without its zone', { ...cronTask, timeZone: undefined }],
  ])('rejects %s', (_name, value) => {
    expect(narrowScheduleRecord(value)).toBeUndefined()
  })

  it.each([
    [{ id: 'a', kind: 'after', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt, afterSeconds: 60 },
      { id: 'a', kind: 'after', title: 'Check the deployment', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt, afterSeconds: 60 }],
    [{ id: 'b', kind: 'at', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt },
      { id: 'b', kind: 'at', title: 'Check the deployment', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt }],
    [{ id: 'c', kind: 'every', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt, everySeconds: 300 },
      { id: 'c', kind: 'every', title: 'Check the deployment', prompt: PROMPT, scheduledAt: dailyTask.scheduledAt, everySeconds: 300 }],
    [dailyTask, dailyTask],
    [weeklyTask, weeklyTask],
    [cronTask, cronTask],
    [{ ...dailyTask, title: 'Deployment check' }, { ...dailyTask, title: 'Deployment check' }],
    // A result recorded before the stored field existed keeps its task; the card
    // names it from the instruction's first line.
    [{ ...dailyTask, title: '' }, dailyTask],
    [{ ...dailyTask, title: '   ' }, dailyTask],
    [Object.fromEntries(Object.entries(dailyTask).filter(([key]) => key !== 'title')), dailyTask],
  ])('accepts a complete %j rule', (value, expected) => {
    expect(narrowScheduleRecord(value)).toEqual(expected)
  })
})

describe('scheduleCreateCardModel', () => {
  it('names a pending call from its arguments and reads no result text', () => {
    expect(scheduleCreateCardModel(running(), TOOL)).toEqual({
      task: undefined, title: 'Check the deployment', output: null,
    })
  })

  it('names a still-preparing call by the tool until its arguments arrive', () => {
    expect(scheduleCreateCardModel({
      phase: 'preparing', callId: CALL, name: TOOL, turn: 1, step: 1, time: 0, subCalls: [],
    }, TOOL)).toEqual({ task: undefined, title: TOOL, output: null })
  })

  it('narrows the created task out of the settled result JSON', () => {
    expect(scheduleCreateCardModel(settled(dailyTask), TOOL)).toEqual({
      task: dailyTask, title: 'Check the deployment', output: JSON.stringify(dailyTask),
    })
  })

  it('names a settled result and a running call from the stored title', () => {
    const named = { ...dailyTask, title: 'Deployment check' }
    expect(scheduleCreateCardModel(settled(named), TOOL).title).toBe('Deployment check')
    expect(scheduleCreateCardModel(running({ ...ARGS, title: 'Deployment check' }), TOOL).title).toBe('Deployment check')
    expect(scheduleCreateCardModel(running({ ...ARGS, title: '   ' }), TOOL).title).toBe('Check the deployment')
  })

  it('keeps the result title when the paired call head fell outside the loaded window', () => {
    expect(scheduleCreateCardModel(settled(dailyTask, { call: false }), TOOL).title).toBe('Check the deployment')
  })

  it('falls back to the wire tool name for a running call without a usable prompt', () => {
    expect(scheduleCreateCardModel(running('not json'), TOOL).title).toBe(TOOL)
    expect(scheduleCreateCardModel(running({ after_seconds: 60 }), TOOL).title).toBe(TOOL)
    expect(scheduleCreateCardModel(running({ prompt: '   ' }), TOOL).title).toBe(TOOL)
  })

  it('reports no result text when the result is not exactly one non-empty text block', () => {
    expect(scheduleCreateCardModel(settled(dailyTask, { content: [] }), TOOL).output).toBeNull()
    expect(scheduleCreateCardModel(settled(dailyTask, { content: [{ type: 'image', data: 'x' }] }), TOOL).output).toBeNull()
    expect(scheduleCreateCardModel(settled(dailyTask, { text: '' }), TOOL).output).toBeNull()
    expect(scheduleCreateCardModel(settled(dailyTask, {
      content: [{ type: 'text', text: JSON.stringify(dailyTask) }, { type: 'text', text: 'extra' }],
    }), TOOL).output).toBeNull()
  })

  it('reads no task from a replayed result that is not a complete rule', () => {
    expect(scheduleCreateCardModel(settled({ code: 'invalid_rule', message: 'no' }), TOOL).task).toBeUndefined()
  })
})

describe('ScheduleCreateCard', () => {
  it('shows the task title, its frequency, and an open action carrying the exact task id', () => {
    const openTaskDetail = vi.fn()
    render(<ScheduleCreateCard {...props(settled(dailyTask), openTaskDetail)} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    const open = screen.getByRole('button', { name: 'Open task details: Check the deployment' })
    fireEvent.click(open)
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('task-daily' as ScheduleId)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(openTaskDetail).toHaveBeenCalledTimes(2)
    expect(openTaskDetail).toHaveBeenLastCalledWith('task-daily' as ScheduleId)
  })

  it('renders a created cron task with its described sentence and opens that exact task', () => {
    const openTaskDetail = vi.fn()
    render(<ScheduleCreateCard {...props(settled(cronTask), openTaskDetail)} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.getByText(`Mon–Fri every 15 minutes during hours 09–17 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Open' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open task details: Check the deployment' }))
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('task-cron' as ScheduleId)
  })

  it('renders the stored title rather than the instruction and opens that task', () => {
    const openTaskDetail = vi.fn()
    render(<ScheduleCreateCard {...props(settled({ ...dailyTask, title: 'Deployment check' }), openTaskDetail)} />)
    expect(screen.getByText('Deployment check')).toBeDefined()
    expect(screen.queryByText('Check the deployment')).toBeNull()
    const open = screen.getByRole('button', { name: 'Open task details: Deployment check' })
    fireEvent.click(open)
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('task-daily' as ScheduleId)
  })

  it.each([
    [{ ...dailyTask, kind: 'after', afterSeconds: 60 }, 'Once'],
    [{ ...dailyTask, kind: 'at' }, 'Once'],
    [{ ...dailyTask, kind: 'every', everySeconds: 300, time: undefined, timeZone: undefined }, 'Every 5 minutes'],
    [dailyTask, `Daily at 23:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`],
    [weeklyTask, `Weekly on Mon, Wed at 09:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`],
  ])('formats the frequency line of one created task', (task, frequency) => {
    render(<ScheduleCreateCard {...props(settled(task))} />)
    expect(screen.getByText(frequency)).toBeDefined()
  })

  it('opens the task in the active locale', () => {
    render(<ScheduleCreateCard {...props(settled(dailyTask), vi.fn(), makeTranslate(zh))} />)
    expect(screen.getByRole('button', { name: '打开任务详情：Check the deployment' })).toBeDefined()
    expect(screen.getByRole('button', { name: '打开' })).toBeDefined()
  })

  it('shows the weekly frequency in the active locale', () => {
    render(<ScheduleCreateCard {...props(settled(weeklyTask), vi.fn(), makeTranslate(zh))} />)
    expect(screen.getByText(`每周一、三 09:00（${zoneLabel('Asia/Shanghai', makeTranslate(zh))}）`)).toBeDefined()
  })

  it('keeps a pending call as a title row with no open action and no result body', () => {
    const view = render(<ScheduleCreateCard {...props(running())} />)
    expect(screen.getByText('Check the deployment')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('pre')).toBeNull()
  })

  it('shows a failed creation as its own result text without an open action', () => {
    const text = JSON.stringify({ code: 'invalid_rule', message: 'after_seconds must be positive.' })
    render(<ScheduleCreateCard {...props(settled(undefined, { text }))} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(text)).toBeDefined()
    expect(screen.getByText('Check the deployment')).toBeDefined()
  })

  it('falls back to the wire tool name when the call arguments are unreadable', () => {
    render(<ScheduleCreateCard {...props(settled(undefined, { args: 'not json', text: 'failed' }))} />)
    expect(screen.getByText(TOOL)).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('states a task the settled catalog no longer holds as deleted', () => {
    render(<ScheduleCreateCard {...props(settled(dailyTask))} currentTask={null} />)
    expect(screen.getByText(en['card.deleted'])).toBeDefined()
    expect(screen.queryByText('Daily at 23:00 (Asia/Shanghai)')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the current rule and name of a task that changed', () => {
    const current = catalogEntry({ ...weeklyTask, id: dailyTask.id, title: 'Updated deployment check' })
    const openTaskDetail = vi.fn()
    render(<ScheduleCreateCard {...props(settled(dailyTask), openTaskDetail)} currentTask={current} />)
    expect(screen.getByText('Updated deployment check')).toBeDefined()
    expect(screen.getByText(`Weekly on Mon, Wed at 09:00 (${zoneLabel('Asia/Shanghai', makeTranslate(en))})`))
      .toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open task details: Updated deployment check' }))
    expect(openTaskDetail).toHaveBeenCalledExactlyOnceWith('task-daily' as ScheduleId)
  })

  it('keeps the delivery card text steps, icon frame, and box', () => {
    const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/client/ScheduleCreateCard.module.css'), 'utf8')
    expect(stylesheet).toMatch(/\.title\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*20px;[^}]*font-weight:\s*500;/)
    const frequency = /\.frequency\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    expect(frequency).toMatch(/color:\s*var\(--dsw-alias-label-tertiary\);/)
    expect(frequency).toMatch(/font-size:\s*10px;/)
    expect(frequency).toMatch(/line-height:\s*16px;/)
    // The box is the delivery card's (ui-deliverables `.file`): fill/hover pair,
    // 8/10 padding, 18px corner, and a 60px row (8px insets around 44px).
    const card = /\.card\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? ''
    expect(card).toMatch(/padding:\s*8px 10px;/)
    expect(card).toMatch(/border-radius:\s*18px;/)
    expect(card).toMatch(/background:\s*var\(--card-fill\);/)
    expect(stylesheet).toMatch(/\.card:has\(\.cardOpen\):hover\s*\{[^}]*background:\s*var\(--card-hover\);/)
    expect(stylesheet).toMatch(/\.row\s*\{[^}]*min-height:\s*44px;/)
    expect(stylesheet).toMatch(/\.cardOpen\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/)
    expect(stylesheet).toMatch(/\.leading\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*border-radius:\s*10px;/)
  })
})
