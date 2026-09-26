/**
 * Model-facing whole-list replacement. Each call appends a `todo/write` snapshot to the calling
 * agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
 * caller has no owning list and is rejected. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from './types.ts'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

/** Model-facing todo tool configuration. */
export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected.
   */
  allowParallelInProgress: boolean
}

/** Schemastery configuration for the todo tool consumer. */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

const DESCRIPTION_HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial '
  + 'single-step tasks. Add one todo per concrete step before you start. '

const DESCRIPTION_PARALLEL =
  'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. '

const DESCRIPTION_SINGLE =
  'While work remains, keep exactly one todo `in_progress`. '

const DESCRIPTION_TAIL = 'Mark each todo `completed` as soon as it is done.'

/**
 * The model-facing description for one activation. The active-status clause is the only part that
 * varies, because it is the only instruction the parallel policy changes.
 * @param allowParallel - whether several todos may be `in_progress` at once.
 * @returns the composed tool description.
 */
function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL
}

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and build the canonical {@link
 * TodoItem}[]: trimmed non-empty unique content, and at most one `in_progress` item unless the
 * deployment allows parallel work. The registry has already enforced the status enum and rejected
 * unknown item keys (`additionalProperties: false` — the logged snapshot must equal what the model
 * believes it wrote, so a nested/extended item shape fails loud at the schema boundary instead of
 * silently flattening); the cast below records that guarantee.
 * @param raw - the model-supplied list, already schema-checked.
 * @param allowParallel - whether several items may be `in_progress` at once.
 * @returns the canonical list.
 */
function toTodoList(raw: { content: string; status: string }[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
  return todos
}

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([
  zod.array(zod.object({
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
  })),
  zod.null(),
])

/**
 * Register the `todo_write` tool on `ctx.tools` and the `todos` unit on
 * `ctx.sessionProjections`.
 * @param ctx - registrant context carrying the tool and session-projection registries.
 * @param config - deployment's explicit todo policy.
 */
export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  // Standing-plan fold: latest whole todo/write list, cleared by the next
  // turn/start (turn/end keeps the finished checklist visible); null before the
  // first write or after a later turn begins; every other event returns the
  // same state reference.
  ctx.sessionProjections.register<'todos', TodoItem[] | null>({
    key: 'todos',
    stateSchema: todosProjectionSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') return event.data.todos
      if (event.type === 'turn/start') return null
      return state
    },
    wire: { viewSchema: todosProjectionSchema, view: state => state },
    stateVersion: 2,
  })
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return Promise.resolve({
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}
