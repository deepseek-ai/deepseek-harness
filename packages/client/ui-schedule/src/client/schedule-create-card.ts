/**
 * Pure card model for one `schedule_create` call in the Session transcript.
 *
 * The tool's model-facing result is its canonical task value serialized as
 * JSON (`renderValue`), so the created task's identity and rule are read from
 * that text. Presentation runs while a call streams and again on Session-log
 * replay of arbitrary logged arguments, so every step narrows wire JSON and
 * returns empty rather than throwing.
 */
import type { ScheduleId, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { taskName } from './schedule-format.ts'

/** One Tool call block as the card receives it: a running call or a settled result. */
type ToolBlock = ToolCallViewProps['block']

/** A settled Tool result; its call-time arguments live on the paired `call`. */
type SettledToolBlock = Extract<ToolBlock, { kind: 'tool-result' }>

/** Derived presentation of one `schedule_create` call. */
export interface ScheduleCreateCardModel {
  /** Created task narrowed from the settled result, or undefined when the result carries none. */
  readonly task: ScheduleRecord | undefined
  /** Single-line task title from the result, the call arguments, or the wire tool name. */
  readonly title: string
  /** Raw model-facing result text of a settled call, when it is one text block. */
  readonly output: string | null
}

/** JSON document of one raw wire text, or undefined when the text is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A streaming call's truncated JSON prefix and a manually edited Session
    // log both reach here; the card falls back instead of failing the render.
    return undefined
  }
}

/** Whether one wire value is a plain JSON object rather than an array or scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First physical line of one task instruction, without surrounding whitespace. */
function firstLine(text: string): string {
  const newline = text.search(/\r?\n/)
  return (newline === -1 ? text : text.slice(0, newline)).trim()
}

/** Concatenated text of a settled result, or null when it is not exactly one text block. */
function resultText(block: SettledToolBlock): string | null {
  const first = block.content[0]
  if (first === undefined || first.type !== 'text' || first.text === '') return null
  if (block.content.length !== 1) return null
  return first.text
}

/** Whether one wire value is an array whose entries are all numbers. */
function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'number')
}

/**
 * Narrow one opaque value to a complete Schedule rule.
 *
 * The value arrives from replayed wire JSON, so each rule kind is checked for
 * the fields `formatScheduleFrequency` reads. A missing identity or an
 * incomplete rule returns undefined and the card renders without a task.
 *
 * The result JSON normally carries the stored title. A result recorded before
 * that field existed carries none, so this narrowing derives the display title
 * from the instruction's first line; when the instruction has no such line it
 * returns undefined.
 * @param value - opaque value parsed from logged JSON.
 * @returns the narrowed rule, or undefined when it is not a complete task.
 */
export function narrowScheduleRecord(value: unknown): ScheduleRecord | undefined {
  if (!isRecord(value)) return undefined
  const { id, prompt, scheduledAt, kind } = value
  if (typeof id !== 'string' || id === ''
    || typeof prompt !== 'string' || prompt === ''
    || typeof scheduledAt !== 'string') return undefined
  const title = typeof value.title === 'string' && value.title.trim() !== '' ? value.title : firstLine(prompt)
  if (title === '') return undefined
  switch (kind) {
    case 'after':
      return typeof value.afterSeconds === 'number'
        ? { id: id as ScheduleId, kind: 'after', title, prompt, afterSeconds: value.afterSeconds, scheduledAt }
        : undefined
    case 'at':
      return { id: id as ScheduleId, kind: 'at', title, prompt, scheduledAt }
    case 'every':
      return typeof value.everySeconds === 'number'
        ? { id: id as ScheduleId, kind: 'every', title, prompt, everySeconds: value.everySeconds, scheduledAt }
        : undefined
    case 'daily':
      return typeof value.time === 'string' && typeof value.timeZone === 'string'
        ? {
          id: id as ScheduleId, kind: 'daily', title, prompt, time: value.time,
          timeZone: value.timeZone, scheduledAt,
        }
        : undefined
    case 'weekly':
      return typeof value.time === 'string' && typeof value.timeZone === 'string' && isNumberArray(value.weekdays)
        ? {
          id: id as ScheduleId, kind: 'weekly', title, prompt, time: value.time,
          timeZone: value.timeZone, weekdays: value.weekdays, scheduledAt,
        }
        : undefined
    case 'cron':
      return typeof value.expression === 'string' && typeof value.timeZone === 'string'
        ? {
          id: id as ScheduleId, kind: 'cron', title, prompt, expression: value.expression,
          timeZone: value.timeZone, scheduledAt,
        }
        : undefined
    default:
      return undefined
  }
}

/** Task title a still-running call announces from its own arguments. */
function pendingTitle(argsRaw: string): string | undefined {
  const parsed = parseJson(argsRaw)
  if (!isRecord(parsed)) return undefined
  if (typeof parsed.title === 'string' && parsed.title.trim() !== '') return parsed.title.trim()
  if (typeof parsed.prompt !== 'string') return undefined
  const title = firstLine(parsed.prompt)
  return title === '' ? undefined : title
}

/**
 * Derive the transcript card of one `schedule_create` call.
 * @param block - raw call or result block carried by the Session journal.
 * @param toolName - wire Tool name, used when no task title is available.
 * @returns the created task, its title, and the settled result text.
 */
export function scheduleCreateCardModel(block: ToolBlock, toolName: string): ScheduleCreateCardModel {
  const settled = 'kind' in block
  // A call still preparing carries no arguments, so its title falls back to the tool name.
  const argsRaw = settled
    ? block.call?.argsRaw ?? ''
    : block.phase === 'start' ? block.argsRaw : ''
  const output = settled ? resultText(block) : null
  const task = settled ? narrowScheduleRecord(parseJson(output ?? '')) : undefined
  return {
    task,
    title: task === undefined ? pendingTitle(argsRaw) ?? toolName : taskName(task),
    output,
  }
}
