/** Recorded todo, goal, and schedule values for the compact detail body. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from './tool-call-model.ts'
import type { ToolDetailsModel } from '../components/ToolDetails.tsx'
import { parsedToolCall, singleResultText } from './raw-tool-call.ts'
import { controlDetails } from './control-details-model.ts'
import { inspectionDetails } from './inspection-details-model.ts'
import { detailJson, detailRecord, nonempty } from './detail-model-shared.ts'

type Translate = TranslateNS<'conversation'>
type DetailItem = ToolDetailsModel['items'][number]

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function formatDate(date: Date, locale: string, fallback: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(date)
  } catch {
    return fallback
  }
}

/**
 * Derive the compact todo list from a todo_write call.
 * @param args - Parsed todo_write arguments.
 * @param t - Conversation dictionary translator.
 * @returns Localized todo details, or null for unsupported input.
 */
export function todosDetail(args: Record<string, unknown>, t: Translate): ToolDetailsModel | null {
  if (!Array.isArray(args.todos)) return null
  const items: DetailItem[] = []
  const seen = new Set<string>()
  for (const todo of args.todos) {
    if (!detailRecord(todo) || !nonempty(todo.content)) return null
    const status = todo.status
    if (status !== 'completed' && status !== 'in_progress' && status !== 'pending') return null
    const title = todo.content.trim()
    if (seen.has(title)) return null
    seen.add(title)
    items.push({ title, status: { value: status, label: t(`detail.todo.${status}`) }, fields: [] })
  }
  return { items, empty: t('detail.todo.empty') }
}

function goalDetail(value: unknown, t: Translate): ToolDetailsModel | null {
  if (!detailRecord(value)) return null
  if (value.goal === null) return { items: [], empty: t('detail.goal.empty') }
  const goal = value.goal
  if (!detailRecord(goal) || !nonempty(goal.id) || !nonempty(goal.objective)
    || !count(goal.revision) || !count(goal.roundsStarted) || !count(goal.maxGoalRounds)) return null
  const phase = goal.phase
  if (phase !== 'active' && phase !== 'paused' && phase !== 'blocked' && phase !== 'complete') return null
  if (value.activation !== 'armed' && value.activation !== 'disarmed') return null
  const fields = [
    { label: t('detail.state'), value: t(phase === 'active' && value.activation === 'disarmed' ? 'detail.goal.disarmed' : `detail.goal.${phase}`) },
    { label: t('detail.goal.rounds'), value: `${goal.roundsStarted} / ${goal.maxGoalRounds}` },
  ]
  if (goal.blockedReason !== undefined) {
    if (!detailRecord(goal.blockedReason) || !nonempty(goal.blockedReason.code) || !nonempty(goal.blockedReason.message)) return null
    fields.push({ label: t('detail.goal.reason'), value: goal.blockedReason.message })
  }
  return { items: [{ title: goal.objective, fields }] }
}

/** ISO-weekday keys, Monday first: a stored weekly rule names days 1 through 7. */
const WEEKDAY_KEYS = [
  'detail.weekday.1', 'detail.weekday.2', 'detail.weekday.3', 'detail.weekday.4',
  'detail.weekday.5', 'detail.weekday.6', 'detail.weekday.7',
] as const

function interval(seconds: number, t: Translate): string {
  if (seconds % 86400 === 0) return t('detail.days', { count: seconds / 86400 })
  if (seconds % 3600 === 0) return t('detail.hours', { count: seconds / 3600 })
  if (seconds % 60 === 0) return t('detail.minutes', { count: seconds / 60 })
  return t('detail.seconds', { count: seconds })
}

/** A stored wall clock without its zero seconds, the figure the schedule surfaces state. */
function shortTime(time: string): string {
  return time.replace(/:00\.000$/, '').replace(/\.000$/, '')
}

/** Localized weekday list of a stored weekly rule, or undefined when the set is empty or out of range. */
function weekdayText(days: unknown, t: Translate): string | undefined {
  if (!Array.isArray(days) || days.length === 0) return undefined
  const labels: string[] = []
  for (const day of days) {
    if (typeof day !== 'number' || !Number.isInteger(day)) return undefined
    const key = WEEKDAY_KEYS[day - 1]
    if (key === undefined) return undefined
    labels.push(t(key))
  }
  // The reader's own enumeration separator, the one the Web detail states.
  return labels.join(t('detail.weekday.join'))
}

function scheduleItem(value: unknown, t: Translate, locale: string): DetailItem | null {
  if (!detailRecord(value) || !nonempty(value.id) || typeof value.scheduledAt !== 'string') return null
  const title = nonempty(value.title) ? value.title : value.prompt
  if (!nonempty(title)) return null
  const state = value.status ?? value.state
  if (value.status === undefined) {
    if (!nonempty(value.prompt) || (value.deliveryMode !== 'host' && value.deliveryMode !== 'session-local')
      || (state !== 'scheduled' && state !== 'overdue')) return null
  } else if (!nonempty(value.title) || (state !== 'active' && state !== 'paused' && state !== 'ended')) return null
  const date = new Date(value.scheduledAt)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.scheduledAt) return null
  let frequency: string
  switch (value.kind) {
    case 'rrule': {
      if (typeof value.rrule !== 'string') return null
      const rule = value.rrule.split('\n').find(line => line.startsWith('RRULE:'))?.slice('RRULE:'.length)
      if (!nonempty(rule)) return null
      frequency = t('detail.schedule.custom')
      break
    }
    case 'at': frequency = t('detail.schedule.once'); break
    case 'after':
      if (!count(value.afterSeconds) || value.afterSeconds === 0) return null
      frequency = t('detail.schedule.once')
      break
    case 'every':
      if (!count(value.everySeconds) || value.everySeconds === 0) return null
      frequency = t('detail.schedule.every', { interval: interval(value.everySeconds, t) })
      break
    case 'daily':
      if (!nonempty(value.time) || !nonempty(value.timeZone)) return null
      frequency = t('detail.schedule.daily', { time: shortTime(value.time), zone: value.timeZone })
      break
    case 'weekly': {
      const days = weekdayText(value.weekdays, t)
      if (!nonempty(value.time) || !nonempty(value.timeZone) || days === undefined) return null
      frequency = t('detail.schedule.weekly', { days, time: shortTime(value.time), zone: value.timeZone })
      break
    }
    case 'cron':
      if (!nonempty(value.expression) || !nonempty(value.timeZone)) return null
      frequency = t('detail.schedule.cron', { expression: value.expression, zone: value.timeZone })
      break
    default: return null
  }
  const dateText = formatDate(date, locale, value.scheduledAt)
  return {
    title,
    fields: [
      { label: t('detail.schedule.when'), value: dateText },
      { label: t('detail.schedule.frequency'), value: frequency },
      { label: t('detail.state'), value: t(`detail.schedule.${state}`) },
    ],
  }
}

function single(item: DetailItem | null): ToolDetailsModel | null {
  return item === null ? null : { items: [item] }
}

function deletedTask(value: unknown, t: Translate): ToolDetailsModel | null {
  if (!detailRecord(value) || !nonempty(value.id) || value.deleted !== true) return null
  return { items: [{ title: value.id, fields: [{ label: t('detail.state'), value: t('detail.schedule.deleted') }] }] }
}

/**
 * Derive a supported successful result, retaining generic output on unknown or malformed data.
 * @param block - Logged root or nested Tool call and its optional result.
 * @param t - Conversation dictionary translator.
 * @param locale - Display locale for absolute dates in the viewer's time zone.
 * @returns Localized detail data, or null for raw input/output.
 */
export function detailsCardModel(block: ToolCallBlock, t: Translate, locale: string): ToolDetailsModel | null {
  if (!('kind' in block) || block.isError) return null
  const call = parsedToolCall(block)
  if (call === null) return null
  const text = singleResultText(block)
  if (text === undefined) return null
  const value = detailJson(text)
  const details = controlDetails(call.name, call.args, text, value, t) ?? inspectionDetails(call.name, call.args, text, value, t, locale)
  if (details !== null) return details
  if (value === undefined) return null
  switch (call.name) {
    case 'create_goal':
    case 'get_goal':
    case 'update_goal': return goalDetail(value, t)
    // Retain readers for results in stored Sessions.
    case 'schedule_create':
    case 'schedule_update':
    case 'schedule_view': return single(scheduleItem(value, t, locale))
    case 'schedule_edit': return deletedTask(value, t) ?? single(scheduleItem(value, t, locale))
    case 'schedule_list': {
      const entries = Array.isArray(value) ? value : detailRecord(value) ? value.items : undefined
      if (!Array.isArray(entries)) return null
      const items: DetailItem[] = []
      for (const entry of entries) {
        const item = scheduleItem(entry, t, locale)
        if (item === null) return null
        items.push(item)
      }
      return { items, summary: t('detail.schedule.count', { count: items.length }), empty: t('detail.schedule.empty') }
    }
    case 'schedule_delete': return deletedTask(value, t)
    default: return null
  }
}
