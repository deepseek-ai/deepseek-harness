import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { annotationId, annotationText, newId, patchSchema, statuses, treeId } from './records.ts'
import { measureAll, patchTasks, prioritiesOf, prioritizedTasks } from './tasks.ts'
import type { Config } from './config.ts'
import type { TimelineStorage } from './storage.ts'
import type { TaskReceipt, Tree } from './records.ts'
import { taskReceipt } from './receipts.ts'
import { parseArgument, TimelineError } from './error.ts'

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'string', required: true } },
  } as const,
  render: (_args: unknown, value: { content: string }) => [{ type: 'text' as const, text: value.content }],
}

const taskOutputSchema = {
  ...output.schema,
  properties: { ...output.schema.properties, receipt: { type: 'json', required: true } },
} as const
const taskOutput = {
  schema: taskOutputSchema,
  render: output.render,
  presentationMeta: (_args: unknown, value: InferValue<typeof taskOutputSchema>) => ({
    timeline: value.receipt,
  }),
}

/**
 * Keep planning, reading, and annotation replies separate from user-owned edits.
 * @param ctx - owning plugin context.
 * @param config - current Timeline settings.
 * @param storage - Timeline's session data service.
 */
export function installTools(ctx: Context, config: Config, storage: TimelineStorage): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'timeline_tree',
          description:
            'Start and select a new task tree, or select an existing tree for the goal. Add or edit tasks with timeline_tasks.',
          parameters: {
            action: { type: 'string', required: true, enum: ['start', 'select'] },
            id: {
              type: 'string',
              description: 'Existing tree ID. Required for select. The host assigns IDs on start.',
            },
            title: {
              type: 'string',
              description:
                'For start only. Required short goal label, usually 2–5 words, at most 120 characters.',
            },
            description: {
              type: 'string',
              description: 'For start only. Optional purpose, at most 320 characters.',
            },
          },
          output,
          async execute(args, exec) {
            if (exec.agent === undefined) throw new TimelineError('timeline_tree requires an agent session')
            const session = exec.agent.session
            if (!(await ctx.sessions.flush(session)))
              throw new TimelineError('Timeline requires durable session persistence', 'TIMELINE_PERSISTENCE')
            if (args.action === 'start') {
              if (args.id?.trim()) throw new TimelineError('The host assigns new tree IDs')
              const title = parseArgument(z.string().trim().min(1).max(120), args.title, 'title')
              const description = parseArgument(z.string().trim().max(320), args.description ?? '', 'description')
              const id = treeId.parse(newId('tree', createHash('sha256').update(exec.callId).digest('hex')))
              await storage.append(session, 'plugin:timeline/tree', (state) => {
                if (state.calls.some(call => call.id === exec.callId)) return
                if (!state.view.trees.some(tree => tree.id === id)) {
                  if (state.view.trees.length >= config.maxTrees)
                    throw new TimelineError(`At most ${config.maxTrees} task trees`)
                  return {
                    version: 1,
                    sessionId: session.id,
                    callId: exec.callId,
                    tree: { id, title, description, tasks: [], createdAt: Date.now() },
                  }
                }
                return undefined
              })
            } else {
              if (args.title !== undefined || args.description !== undefined)
                throw new TimelineError('Select accepts only an ID')
              const id = parseArgument(treeId, args.id, 'id')
              await storage.append(session, 'plugin:timeline/select', (state) => {
                if (state.calls.some(call => call.id === exec.callId)) return
                if (!state.view.trees.some(tree => tree.id === id)) throw new TimelineError('Unknown task tree')
                return {
                  version: 1,
                  sessionId: session.id,
                  callId: exec.callId,
                  treeId: id,
                }
              })
            }
            return {
              content: JSON.stringify({
                activeTree: storage.stateOf(session).view.activeTreeId,
                trees: storage.stateOf(session).view.trees.map(({ id, title }) => ({ id, title })),
              }),
            }
          },
          presentCall: args => ({
            card: 'generic',
            title: 'Timeline task tree',
            kind: 'other',
            rawInput: args.title ?? args.id,
          }),
        }),
      ),
    'timeline: tree tool',
  )
  ctx.effect(() => {
    const tool = defineTool({
      name: 'timeline_tasks',
      description:
        'Patch tasks in one tree. Send parents and children in the same batch when adding a branch. Groups derive status and progress from their leaves. The batch is atomic and omitted tasks and fields stay unchanged.',
      parameters: {
        tree: {
          type: 'string',
          description: 'Existing tree ID. Defaults to the selected tree. The write selects this tree.',
        },
        tasks: {
          type: 'array',
          required: true,
          description: 'Nonempty batch. New tasks need id and title; updates need id and changed fields.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                required: true,
                description:
                  'Stable task ID within this tree, 1–80 characters. Example: check-save. Reuse it for updates.',
              },
              parent: {
                oneOf: [{ type: 'string' }, { type: 'null' }],
                description:
                  'Parent task ID in this tree. Omit for a new root or to keep the parent on update. Use null to move to the root.',
              },
              title: {
                type: 'string',
                description: 'Required for new tasks: 1–120 characters. Optional for updates.',
              },
              description: { type: 'string', description: 'Task scope, at most 320 characters.' },
              status: {
                type: 'string',
                enum: [...statuses],
                description:
                  'Leaf state. pending means not started, paused means deferred, blocked means waiting for a dependency, and retired means removed from the plan. For groups, omit status unless retiring with subtree: true.',
              },
              done: {
                type: 'array',
                items: { type: 'number' },
                description:
                  'Leaf only. [completed, total], with 0 ≤ completed ≤ total and total > 0. If status is omitted, this sets pending, active, or done. Status done completes all units.',
              },
              weight: {
                type: 'number',
                description:
                  'Relative effort among siblings, including top-level tasks. A group’s weight covers all its work. Children divide that share. A group with weight 3 beside a task with weight 1 keeps its 75% share when you split its existing work into children. Use positive numbers, including fractions. New tasks default to 1.',
              },
              note: {
                type: 'string',
                description:
                  'Brief result or reason, at most 400 characters. Name what changed. Required when updating status, done, parent, or weight on an existing task, or entering paused, blocked, or retired.',
              },
              details: {
                type: 'string',
                description:
                  'Explain the result, evidence, limits, and impact on the goal in 2–4 self-contained sentences, at most 4000 characters.',
              },
              subtree: {
                type: 'boolean',
                description: 'With status retired, retire all descendants too. Omit for other updates.',
              },
            },
          },
        },
      },
      output: taskOutput,
      async execute(args, exec) {
        if (exec.agent === undefined) throw new TimelineError('timeline_tasks requires an agent session')
        const session = exec.agent.session
        if (!(await ctx.sessions.flush(session)))
          throw new TimelineError('Timeline requires durable session persistence', 'TIMELINE_PERSISTENCE')
        const patches = parseArgument(patchSchema.array(),
          args.tasks.map(({ weight, ...patch }) => ({
            ...patch,
            ...(weight === undefined ? {} : { timeShare: weight }),
          })),
          'tasks',
        )
        const requested = args.tree === undefined ? undefined : parseArgument(treeId, args.tree, 'tree')
        let edited: Tree['id'] | undefined
        let receipt: TaskReceipt | null = null
        await storage.append(session, 'plugin:timeline/tree', (state) => {
          const previous = state.calls.find(call => call.id === exec.callId)
          if (previous !== undefined) {
            edited = previous.tree
            receipt = previous.receipt ?? null
            return
          }
          const tree = state.view.trees.find(item => item.id === (requested ?? state.view.activeTreeId))
          if (tree === undefined)
            throw new TimelineError(
              requested === undefined ? 'Start a tree with timeline_tree first' : 'Unknown task tree',
            )
          edited = tree.id
          const at = Date.now()
          let tasks
          try {
            tasks = patchTasks(tree.tasks, patches, at, config.maxTasks)
          } catch (error: unknown) {
            throw new TimelineError(error instanceof Error ? error.message : 'Invalid task update', 'TIMELINE_INVALID_ARGUMENT', { cause: error })
          }
          receipt = taskReceipt(tree, tasks, patches, at)
          return {
            version: 1,
            sessionId: session.id,
            callId: exec.callId,
            tree: { ...tree, tasks: tasks.map(task => ({ ...task, history: [] })), ...(receipt === null ? {} : { lastTaskUpdate: at }) },
            receipt,
          }
        })
        const { trees } = storage.stateOf(session).view
        const current = trees.find(item => item.id === edited)
        const progress = current && measureAll(current.tasks).get(null)
        return {
          receipt,
          content: JSON.stringify({
            tree: edited,
            progress:
              progress === undefined ? null : { progress: progress.progress, status: progress.status },
            priorities: prioritizedTasks(trees),
          }),
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Update Timeline tasks',
        kind: 'other',
        rawInput: args.tasks,
      }),
    })
    const description = tool.description
    // Harness reads live description accessors, including in its generated tool SDK.
    Object.defineProperty(tool, 'description', {
      enumerable: true,
      get: () => {
        const prompt = config.taskPrompt.trim()
        return prompt ? `${description}\n\nTask writing guidance:\n${prompt}` : description
      },
    })
    return ctx.tools.register(tool)
  }, 'timeline: task tool')
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'timeline_pull',
          description:
            'Check what remains before closing the current goal. Returns active or pending leaves in priority order, or blocked leaves if none are runnable. Paused leaves are counted but never suggested.',
          parameters: {
            tree: {
              type: 'string',
              description:
                'Existing tree for the current goal; defaults to the selected tree. Does not select it.',
            },
            limit: {
              type: 'integer',
              description: `Maximum suggestions, 1–${config.maxTasks}. Default ${Math.min(12, config.maxTasks)}. hasMore indicates more candidates in the same category.`,
            },
          },
          output,
          execute(args, exec) {
            if (exec.agent === undefined) throw new TimelineError('timeline_pull requires an agent session')
            const { view } = storage.stateOf(exec.agent.session)
            const id = args.tree === undefined ? view.activeTreeId : parseArgument(treeId, args.tree, 'tree')
            const tree = view.trees.find(item => item.id === id)
            if (args.tree !== undefined && tree === undefined) throw new TimelineError('Unknown task tree')
            const limit = parseArgument(
              z.number().int().min(1).max(config.maxTasks), args.limit ?? Math.min(12, config.maxTasks), 'limit',
            )
            const readable = tree === undefined ? null : readableTree(tree)
            const leaves = readable?.tasks.filter(
              (task): task is typeof task & { status: Exclude<typeof task.status, 'retired'> } =>
                task.kind === 'leaf' && task.status !== 'retired',
            ) ?? []
            const counts = { active: 0, pending: 0, blocked: 0, paused: 0, done: 0 }
            for (const task of leaves) counts[task.status]++
            const work = leaves.filter(task => task.status === 'active' || task.status === 'pending')
            const blocked = leaves.filter(task => task.status === 'blocked')
            const candidates = (work.length === 0 ? blocked : work).sort(
              (a, b) =>
                (a.effectivePriority ?? 'P4').localeCompare(b.effectivePriority ?? 'P4') ||
                Number(b.status === 'active') - Number(a.status === 'active'),
            )
            return Promise.resolve({
              content: JSON.stringify({
                tree:
                  readable === null
                    ? null
                    : { id: readable.id, title: readable.title, progress: readable.progress },
                next:
                  work.length > 0
                    ? 'work'
                    : blocked.length > 0
                      ? 'recheck-blocked'
                      : counts.paused > 0
                        ? 'paused'
                        : leaves.length > 0
                          ? 'done'
                          : 'plan',
                counts,
                tasks: candidates
                  .slice(0, limit)
                  .map(({ id, parent, title, status, done, note, effectivePriority }) => ({
                    id,
                    parent,
                    title,
                    status,
                    done,
                    note,
                    priority: effectivePriority,
                  })),
                total: candidates.length,
                hasMore: candidates.length > limit,
                ...(view.error === null ? {} : { error: view.error }),
              }),
            })
          },
          presentCall: () => ({ card: 'generic', title: 'Check next work', kind: 'read' }),
        }),
      ),
    'timeline: pull tool',
  )
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'timeline_read',
          description:
            'Read the selected plan, its discussions, and up to three recent reports. Filter by task for details or status for a short leaf list. Read a report or discussion by ID with report or annotation alone.',
          parameters: {
            tree: {
              type: 'string',
              description: 'Optional existing tree ID to inspect without selecting it.',
            },
            task: {
              type: 'string',
              description:
                'Task ID in that tree. Returns its details, metrics, and discussions alongside the plan and report overview.',
            },
            report: { type: 'string', description: 'Inspect one saved report and its discussion.' },
            annotation: {
              type: 'string',
              description: 'Saved discussion or pause/continue request ID; use alone.',
            },
            status: {
              type: 'string',
              enum: ['unfinished', ...statuses],
              description:
                'Leaf filter; unfinished includes pending, active, paused and blocked. Cannot combine with task.',
            },
            limit: {
              type: 'integer',
              description:
                'Maximum leaves in a status query, 1–50. Default 12. Used alone, filters to unfinished leaves.',
            },
          },
          output,
          execute(args, exec) {
            if (exec.agent === undefined) throw new TimelineError('timeline_read requires an agent session')
            const { view } = storage.stateOf(exec.agent.session)
            if (args.annotation !== undefined || args.report !== undefined) {
              if (
                [args.tree, args.task, args.status, args.limit].some(value => value !== undefined) ||
                (args.annotation !== undefined && args.report !== undefined)
              )
                throw new TimelineError('Read one report or annotation without other filters')
              if (args.annotation !== undefined) {
                const annotation = view.annotations.find(annotation => annotation.id === args.annotation)
                if (annotation === undefined) throw new TimelineError('Unknown user annotation')
                const target = annotation.target
                const tree =
                  target.kind !== 'report' ? view.trees.find(tree => tree.id === target.tree) : undefined
                const context =
                  target.kind === 'report'
                    ? view.reports.find(report => report.id === target.report)
                    : tree === undefined
                      ? undefined
                      : target.kind === 'tree'
                        ? readableTree(tree)
                        : readableTree(tree).tasks.find(task => task.id === target.task)
                return Promise.resolve({ content: JSON.stringify({ annotation, context }) })
              }
              const report = view.reports.find(report => report.id === args.report)
              if (report === undefined) throw new TimelineError('Unknown Timeline report')
              return Promise.resolve({
                content: JSON.stringify({
                  report,
                  annotations: view.annotations.filter(
                    annotation =>
                      annotation.target.kind === 'report' && annotation.target.report === report.id,
                  ),
                }),
              })
            }
            const tree: Tree | undefined = view.trees.find(
              item => item.id === (args.tree ?? view.activeTreeId),
            )
            if (args.tree !== undefined && tree === undefined) throw new TimelineError('Unknown task tree')
            const readable = tree === undefined ? null : readableTree(tree)
            if (args.status !== undefined || args.limit !== undefined) {
              if (args.task !== undefined) throw new TimelineError('Use either task or a status query')
              const status = args.status ?? 'unfinished'
              const limit = parseArgument(z.number().int().min(1).max(50), args.limit ?? 12, 'limit')
              const tasks =
                readable?.tasks
                  .filter(
                    task =>
                      task.kind === 'leaf' &&
                      (status === 'unfinished'
                        ? !['done', 'retired'].includes(task.status)
                        : task.status === status),
                  )
                  .sort((a, b) => (a.effectivePriority ?? 'P4').localeCompare(b.effectivePriority ?? 'P4')) ??
                []
              return Promise.resolve({
                content: JSON.stringify({
                  tree:
                    readable === null
                      ? null
                      : { id: readable.id, title: readable.title, progress: readable.progress },
                  tasks: tasks
                    .slice(0, limit)
                    .map(({ id, parent, title, status, done, note, priority, effectivePriority }) => ({
                      id,
                      parent,
                      title,
                      status,
                      done,
                      note,
                      priority,
                      effectivePriority,
                      openAnnotations: view.annotations.filter(
                        annotation =>
                          annotation.reply === null &&
                          annotation.target.kind === 'task' &&
                          annotation.target.tree === tree?.id &&
                          annotation.target.task === id,
                      ).length,
                    })),
                  total: tasks.length,
                  hasMore: tasks.length > limit,
                }),
              })
            }
            const task =
              args.task === undefined ? undefined : readable?.tasks.find(item => item.id === args.task)
            if (args.task !== undefined && task === undefined) throw new TimelineError('Unknown task')
            return Promise.resolve({
              content: JSON.stringify({
                tree:
                  task === undefined
                    ? readable
                    : { id: tree?.id, title: tree?.title, progress: readable?.progress },
                ...(task === undefined ? {} : { task }),
                trees: view.trees.map(({ id, title }) => ({ id, title })),
                reports: { total: view.reports.length, recent: view.reports.slice(-3) },
                annotations: view.annotations.filter(
                  annotation =>
                    annotation.target.kind !== 'report' &&
                    annotation.target.tree === tree?.id &&
                    (args.task === undefined ||
                      (annotation.target.kind === 'task' && annotation.target.task === args.task)),
                ),
                error: view.error,
              }),
            })
          },
          presentCall: () => ({ card: 'generic', title: 'Read Timeline', kind: 'read' }),
        }),
      ),
    'timeline: read tool',
  )
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'timeline_reply',
          description:
            'Save one reply after addressing a discussion. For pause or continue, record the requested state on affected leaves before confirming it, or reply with the blocker. A reply alone leaves task state unchanged.',
          parameters: {
            id: {
              type: 'string',
              required: true,
              description: 'Discussion ID from the reply reference or timeline_read.',
            },
            text: {
              type: 'string',
              required: true,
              description:
                'Brief, self-contained result or blocker, usually 1–3 sentences, at most 4000 characters. Saved replies cannot be replaced.',
            },
          },
          output,
          async execute(args, exec) {
            if (exec.agent === undefined) throw new TimelineError('timeline_reply requires an agent session')
            const session = exec.agent.session
            if (!(await ctx.sessions.flush(session)))
              throw new TimelineError('Timeline requires durable session persistence', 'TIMELINE_PERSISTENCE')
            const id = parseArgument(annotationId, args.id, 'id')
            const text = parseArgument(annotationText, args.text, 'text')
            await storage.append(session, 'plugin:timeline/reply', (state) => {
              const annotation = state.view.annotations.find(annotation => annotation.id === id)
              if (annotation === undefined) throw new TimelineError('Unknown user annotation')
              if (annotation.reply !== null) {
                if (annotation.reply.text !== text)
                  throw new TimelineError('A saved annotation reply cannot be replaced')
                return
              }
              return { version: 1, sessionId: session.id, id, text, createdAt: Date.now() }
            })
            const annotation = storage.stateOf(session).view.annotations.find(item => item.id === id)
            return {
              content: JSON.stringify({
                annotation: id,
                ...(annotation?.control === undefined
                  ? { resolved: true }
                  : { replied: true, planState: annotation.control.outcome?.status ?? 'unconfirmed' }),
              }),
            }
          },
          presentCall: () => ({ card: 'generic', title: 'Reply to Timeline annotation', kind: 'other' }),
        }),
      ),
    'timeline: annotation reply tool',
  )
}

/** Derived group metrics replace internal leaf placeholders in model-facing output. */
function readableTree(tree: Tree) {
  const measures = measureAll(tree.tasks)
  const priorities = prioritiesOf(tree.tasks)
  const overall = measures.get(null)
  return {
    id: tree.id,
    title: tree.title,
    description: tree.description,
    progress: overall === undefined ? null : { progress: overall.progress, status: overall.status },
    tasks: tree.tasks.map((task) => {
      const group = tree.tasks.some(child => child.parent === task.id && child.status !== 'retired')
      const measure = measures.get(task.id)
      return {
        id: task.id,
        parent: task.parent,
        title: task.title,
        description: task.description,
        note: task.note,
        details: task.details,
        weight: task.timeShare,
        priority: task.priority,
        effectivePriority: priorities.get(task.id) ?? null,
        kind: group ? 'group' : 'leaf',
        status: measure?.status ?? task.status,
        progress: measure?.progress ?? (task.status === 'done' ? 1 : task.done[0] / task.done[1]),
        ...(group ? {} : { done: task.done }),
      }
    }),
  }
}
