// @vitest-environment jsdom
/** Recorded detail cards, conservative fallback, and standard row interactions. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { detailsCardModel, todosDetail } from '../src/client/tool/models/details-card-model.ts'
import { DetailsRow, detailsToolview } from '../src/client/tool/toolviews/details-row.tsx'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'

const t = makeTranslate(en, commonEn)
const goal = { id: 'goal-1', revision: 2, objective: 'Ship compact cards', phase: 'active', roundsStarted: 2, maxGoalRounds: 8 }
const schedule = { id: 'schedule-1', prompt: 'Review the build', kind: 'every', everySeconds: 3600, scheduledAt: '2026-09-10T09:00:00.000Z', state: 'scheduled', deliveryMode: 'session-local' }

function result(name: string, value: unknown, args = '{}'): ToolResultNode {
  return { kind: 'tool-result', seq: 10, time: 2000, callTime: 1000, callId: 'c1', call: { name, argsRaw: args }, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false, subCalls: [] }
}

afterEach(cleanup)

describe('detailsCardModel', () => {
  it('reads the recorded goal phase and activation, including blockers and absence', () => {
    const model = (value: unknown) => detailsCardModel(result('get_goal', value), t, 'en')
    expect(model({ goal, activation: 'disarmed' })?.items[0]).toEqual({ title: 'Ship compact cards', fields: [{ label: 'Status', value: 'Awaiting continuation' }, { label: 'Rounds', value: '2 / 8' }] })
    expect(model({ goal: { ...goal, phase: 'blocked', blockedReason: { code: 'agent_blocked', message: 'Needs credentials' } }, activation: 'disarmed' })?.items[0]?.fields).toContainEqual({ label: 'Blocker', value: 'Needs credentials' })
    expect(model({ goal: null })).toEqual({ items: [], empty: 'No goal' })
  })

  it('keeps all reminders and their recorded state, including one-shot and empty lists', () => {
    const model = detailsCardModel(result('schedule_list', [schedule, { ...schedule, id: 'schedule-2', kind: 'at', state: 'overdue' }, { ...schedule, id: 'schedule-3', kind: 'after', afterSeconds: 30 }]), t, 'en')
    expect(model?.items).toHaveLength(3)
    expect(model?.summary).toBe('3 reminders')
    expect(model?.items[0]?.fields).toContainEqual({ label: 'Repeat', value: 'Every 1 h' })
    expect(model?.items[1]?.fields).toContainEqual({ label: 'Status', value: 'Overdue, awaiting session resume' })
    expect(model?.items[2]?.fields).toContainEqual({ label: 'Repeat', value: 'Once' })
    expect(detailsCardModel(result('schedule_list', []), t, 'en')).toMatchObject({ summary: '0 reminders', empty: 'No reminders' })
    expect(detailsCardModel(result('schedule_delete', { id: 'schedule-1', deleted: true }), t, 'en')?.items[0]?.fields).toContainEqual({ label: 'Status', value: 'Deleted' })
  })

  it('reads a Host-delivered reminder set beside a recorded session-local result', () => {
    const host = { id: 'schedule-9', prompt: 'Ship the weekly report', kind: 'weekly', time: '09:00:00.000', timeZone: 'Asia/Shanghai', weekdays: [1, 3], scheduledAt: '2026-09-10T01:00:00.000Z', state: 'scheduled', deliveryMode: 'host' }
    const model = detailsCardModel(result('schedule_list', [
      host,
      { ...host, id: 'schedule-10', kind: 'daily', time: '23:00:00.000', weekdays: undefined },
      { ...host, id: 'schedule-11', kind: 'cron', expression: '*/15 9-17 * * 1-5', time: undefined, weekdays: undefined },
      schedule,
    ]), t, 'en')
    expect(model?.items).toHaveLength(4)
    expect(model?.items[0]?.fields).toContainEqual({ label: 'Repeat', value: 'Weekly on Mon, Wed at 09:00 (Asia/Shanghai)' })
    expect(model?.items[1]?.fields).toContainEqual({ label: 'Repeat', value: 'Every day at 23:00 (Asia/Shanghai)' })
    expect(model?.items[2]?.fields).toContainEqual({ label: 'Repeat', value: 'Cron */15 9-17 * * 1-5 (Asia/Shanghai)' })
    // A result recorded before the Host owned delivery stays readable.
    expect(model?.items[3]?.fields).toContainEqual({ label: 'Repeat', value: 'Every 1 h' })
    // A Host view states its stored title; the instruction is only the recorded fallback.
    const titled = detailsCardModel(result('schedule_list', [{ ...host, title: 'Weekly report' }]), t, 'en')
    expect(titled?.items[0]?.title).toBe('Weekly report')
    const untitled = detailsCardModel(result('schedule_list', [{ ...host, title: undefined }]), t, 'en')
    expect(untitled?.items[0]?.title).toBe('Ship the weekly report')
  })

  it('presents an in-place update by the reminder it committed', () => {
    const model = detailsCardModel(result('schedule_update', {
      ...schedule, deliveryMode: 'host', kind: 'daily', time: '10:30:00.000', timeZone: 'Asia/Shanghai', everySeconds: undefined,
    }), t, 'en')
    expect(model?.items[0]?.title).toBe('Review the build')
    expect(model?.items[0]?.fields).toContainEqual({ label: 'Repeat', value: 'Every day at 10:30 (Asia/Shanghai)' })
  })

  it.each([
    ['get_goal', { goal: { ...goal, phase: 'unknown' }, activation: 'armed' }],
    ['get_goal', { goal, activation: 'unknown' }],
    ['get_goal', { goal: { ...goal, blockedReason: {} }, activation: 'armed' }],
    ['schedule_create', { ...schedule, scheduledAt: 'invalid' }],
    ['schedule_create', { ...schedule, kind: 'unknown' }],
    ['schedule_create', { ...schedule, everySeconds: -1 }],
    ['schedule_list', [schedule, {}]],
    ['schedule_list', { code: 'corrupt_schedule_log', message: 'The session schedule log is corrupt.' }],
    ['schedule_delete', { id: 'schedule-1', deleted: false, code: 'schedule_not_found' }],
    ['schedule_delete', { code: 'persistence_uncertain', operation: 'delete', id: 'schedule-1', message: 'Persistence is uncertain.' }],
    ['schedule_update', { ...schedule, kind: 'weekly', weekdays: [0], time: '09:00:00.000', timeZone: 'UTC' }],
    ['schedule_update', { ...schedule, kind: 'cron', expression: '', timeZone: 'UTC' }],
    ['unknown_tool', { goal, activation: 'armed' }],
  ])('retains raw output for unsupported %s results (%j)', (name, value) => {
    expect(detailsCardModel(result(name, value), t, 'en')).toBeNull()
  })

  it('does not present an unsuccessful, partial, mixed-content, or window-truncated result as applied', () => {
    const block = result('create_goal', { goal, activation: 'armed' })
    expect(detailsCardModel({ ...block, isError: true }, t, 'en')).toBeNull()
    expect(detailsCardModel({ ...block, call: null }, t, 'en')).toBeNull()
    expect(detailsCardModel({ ...block, call: { name: 'create_goal', argsRaw: '{' } }, t, 'en')).toBeNull()
    expect(detailsCardModel({ ...block, content: [{ type: 'text', text: 'partial {' }] }, t, 'en')).toBeNull()
    expect(detailsCardModel({ ...block, content: [...block.content, { type: 'text', text: 'Extra result' }] }, t, 'en')).toBeNull()
    expect(detailsCardModel({ phase: 'start' as const, callId: 'c1', name: 'create_goal', argsRaw: '{}', turn: 1, step: 1, time: 1000, subCalls: [] }, t, 'en')).toBeNull()
    expect(detailsCardModel({ ...block, parentCallId: 'parent' }, t, 'en')?.items[0]?.title).toBe(goal.objective)
  })
})

describe('todosDetail', () => {
  it('accepts valid to-do lists and uses the tool’s trimmed text', () => {
    expect(todosDetail({ todos: [{ content: '  Build the page  ', status: 'in_progress' }] }, t)?.items[0]).toEqual({ title: 'Build the page', status: { value: 'in_progress', label: 'In progress' }, fields: [] })
    for (const todos of [[{ content: 'x', status: 'unknown' }], [{ content: '', status: 'pending' }], [null], [{ content: 'x', status: 'pending' }, { content: ' x ', status: 'completed' }]]) {
      expect(todosDetail({ todos }, t)).toBeNull()
    }
    expect(todosDetail({ todos: [] }, t)?.empty).toBe('The to-do list is empty')
  })
})

describe('DetailsRow', () => {
  it('expands fields with the keyboard and keeps Inspect available', () => {
    const inspect = vi.fn()
    render(<DetailsRow {...{ useDisclosure, toolName: 'get_goal', block: result('get_goal', { goal, activation: 'armed' }), inspect, t } as Parameters<typeof DetailsRow>[0]} />)
    expect(screen.queryByText('Rounds')).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { expanded: false }), { key: 'Enter' })
    expect(screen.getByText('Rounds')).toBeTruthy()
    expect(screen.getByText('2 / 8')).toBeTruthy()
    expect(screen.queryByText('Output')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('presents teammate-coordination tools under the two-person team icon', () => {
    const inspect = vi.fn()
    const expectedIcon = render(<IconUsersOutlineRegular size={14} />).container.querySelector('svg')!.outerHTML
    const view = render(<DetailsRow {...{ useDisclosure, toolName: 'wait_agent', block: result('wait_agent', { timedOut: true }), inspect, t } as Parameters<typeof DetailsRow>[0]} />)
    expect(screen.getByText('Wait for subagent')).toBeTruthy()
    expect(view.container.querySelector('svg')?.outerHTML).toBe(expectedIcon)
  })

  it('registers the supported tool names through the scoped keyed slot', () => {
    const register = vi.fn((_spec: unknown, _component: unknown) => () => undefined)
    const inject = vi.fn((_name: string, callback: () => Iterable<() => void>) => {
      for (const dispose of callback()) dispose()
    })
    detailsToolview.apply({ slots: { inject, register } } as never)
    expect(register.mock.calls).toHaveLength(37)
    expect(register.mock.calls.map(([spec]) => spec)).toContainEqual({ name: 'tool.call.toolview', key: 'cordis_inspect_query', locale: 'conversation' })
    expect(register.mock.calls.map(([spec]) => spec)).toContainEqual({ name: 'tool.call.toolview', key: 'schedule_update', locale: 'conversation' })
  })
})
