/**
 * Advisory reminders for unfinished session todo lists that remain unchanged across model steps.
 * Activated by `dsh-tool-todo` when `config.reminder.enabled` is true.
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { TodoItem } from './types.ts'

/** Model-facing name of the Todo replacement tool. */
export const TODO_WRITE_TOOL_NAME = 'todo_write'
/** Default completed assistant messages required between Todo writes or reminders. */
export const DEFAULT_REMINDER_INTERVAL_STEPS = 64
/** Default maximum character length for one complete model-visible reminder. */
export const DEFAULT_MAX_REMINDER_CHARS = 16 * 1024

const REMINDER_SOURCE_NAME = 'todo-reminder'

const REMINDER_GUIDANCE =
  'An open task list has remained unchanged while the work continued. Reconcile it with actual '
  + 'progress before proceeding when the list is still useful. Invoke `'
  + TODO_WRITE_TOOL_NAME
  + '` with `todos` set '
  + 'to the entire replacement array: move finished work to `completed` as soon as it finishes, '
  + 'mark work currently underway `in_progress`, and leave later work `pending`. Rebuild the array '
  + 'when its items no longer match the task. If tracking adds no value, clear the recorded list '
  + 'with `todos: []`. Keep this maintenance note out of the response to the user.'

const REMINDER_PREFIX = [
  '<system-reminder>',
  REMINDER_GUIDANCE,
  '',
  'Current todo list:',
].join('\n')
const REMINDER_SUFFIX = '</system-reminder>'
const TRUNCATION_NOTICE =
  '[todo items outside this excerpt omitted; rebuild or clear the list instead of guessing their contents]'

/** Minimum character cap required to retain fixed guidance and truncation marker. */
export const MIN_REMINDER_CHARS = [
  REMINDER_PREFIX,
  TRUNCATION_NOTICE,
  REMINDER_SUFFIX,
].join('\n').length

/** Runtime zod schema for one {@link TodoItem} projection entry. */
export const todoItemSchema = zod.object({
  content: zod.string(),
  status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
})

const todoReminderStateSchema = zod.object({
  unfinishedTodos: zod.array(todoItemSchema).nullable(),
  assistantMessagesSinceAnchor: zod.number(),
})

/** Resolved reminder configuration consumed when reminders are enabled. */
export interface ResolvedReminderConfig {
  intervalSteps: number
  maxReminderChars: number
}

function renderReminder(todos: readonly TodoItem[], maxChars: number): string {
  const lines = todos.map(
    (todo, index) => `${index + 1}. [${todo.status}] ${JSON.stringify(todo.content)}`,
  )
  const complete = [REMINDER_PREFIX, ...lines, REMINDER_SUFFIX].join('\n')
  if (complete.length <= maxChars) return complete

  const firstUnfinished = todos.findIndex(todo => todo.status !== 'completed')
  const before = lines.slice(0, firstUnfinished)
  const [anchor, ...after] = lines.slice(firstUnfinished) as [string, ...string[]]
  const kept: string[] = []
  let chars = MIN_REMINDER_CHARS
  const take = (line: string, prepend = false): boolean => {
    const lineChars = `\n${line}`.length
    if (chars + lineChars > maxChars) return false
    if (prepend) kept.unshift(line)
    else kept.push(line)
    chars += lineChars
    return true
  }
  if (take(anchor)) {
    const adjacent = before.at(-1)
    if (adjacent !== undefined) {
      if (take(adjacent, true)) before.pop()
      else before.length = 0
    }
    for (const line of after) {
      if (!take(line)) break
    }
    for (const line of before.reverse()) {
      if (!take(line, true)) break
    }
  }
  return [REMINDER_PREFIX, ...kept, TRUNCATION_NOTICE, REMINDER_SUFFIX].join('\n')
}

/**
 * Register the host-only `todoReminder` projection unit and pre-step reminder injection.
 * @param ctx - plugin context carrying the tool registry, session projections, and agent events.
 * @param config - resolved interval and character-limit settings.
 * @returns when the projection registration is ready.
 */
export async function installTodoReminder(
  ctx: Context,
  config: ResolvedReminderConfig,
): Promise<void> {
  const { intervalSteps: interval, maxReminderChars } = config

  const projectionReady = ctx.sessionProjections.register({
    key: 'todoReminder',
    stateVersion: 1,
    stateSchema: todoReminderStateSchema,
    init: () => ({
      unfinishedTodos: null,
      assistantMessagesSinceAnchor: 0,
    }),
    apply: (state, event) => {
      if (event.type === 'todo/write') {
        const todos = event.data.todos
        const unfinishedTodos = todos.some(todo => todo.status !== 'completed') ? todos : null
        return {
          unfinishedTodos,
          assistantMessagesSinceAnchor: 0,
        }
      }
      if (event.type === 'user/message' && event.data.source.kind === REMINDER_SOURCE_NAME) {
        return state.assistantMessagesSinceAnchor === 0
          ? state
          : { ...state, assistantMessagesSinceAnchor: 0 }
      }
      if (event.type === 'assistant/message' && state.unfinishedTodos !== null) {
        return {
          ...state,
          assistantMessagesSinceAnchor: state.assistantMessagesSinceAnchor + 1,
        }
      }
      return state
    },
  })

  // The outermost listener appends this snapshot after downstream pre-step context.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const projectionHandle = await projectionReady
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject'
      || signal.aborted
      || ctx.tools.get(TODO_WRITE_TOOL_NAME, agent) === undefined) return decision

    const schedule = projectionHandle.stateOf(agent.session)
    const todos = schedule.unfinishedTodos
    if (todos === null || schedule.assistantMessagesSinceAnchor < interval) return decision

    const text = renderReminder(todos, maxReminderChars)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: REMINDER_SOURCE_NAME,
            form: 'snapshot',
            sections: [{ name: REMINDER_SOURCE_NAME, text }],
          },
        }),
      ],
    }
  }, { prepend: true })

  await projectionReady
}
