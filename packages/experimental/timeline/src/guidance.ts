import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Config } from './config.ts'
import { delegationContext, isWorker } from './delegation.ts'
import type { OwnsAgent } from './delegation.ts'
import { taskLanguageInstruction } from './policy.ts'
import type { TimelineStorage } from './storage.ts'
import { measureAll, prioritiesOf, prioritizedTasks } from './tasks.ts'

// Keep the turn-start preview short; the model can query the full plan on demand.
const CONTEXT_ITEM_LIMIT = 12
const CONTEXT_NOTE_LIMIT = 160

const instructions = `## Task planning with Timeline

Before substantive multi-step work, reuse the goal's tree or start one with timeline_tree. Group work by deliverable and split large steps into checkable child tasks. Use timeline_tasks at meaningful checkpoints to update leaves and revise the tree as scope changes. Preserve completed work.

Before a final answer on planned work, save progress and call timeline_pull for that goal. Continue eligible work in scope and repeat the check. Recheck blocked dependencies once and record remaining blockers. Resume paused work only at the user's request.

Own the shared tree. Save tasks before delegating. Include "Timeline: tree=<id>; tasks=<ids>", scope, and completion criteria in assignments and reassignments. Relay relevant discussions and pause/continue requests. Save worker progress and blockers, verify results before marking tasks done, and save shared replies yourself. Save progress and yield when waiting for workers.

Interval reports run independently when enabled. Keep replies focused on the user's work.`

const workerInstructions = `## Shared task planning
The manager owns the shared Timeline tree. At milestones, blockers, and completion, report the assigned tree/task IDs, verified results, and remaining work to your parent through normal agent messages. Ask for missing IDs at the first checkpoint. Follow the latest assignment and pause/continue requests at safe checkpoints. Send discussion findings to your parent for a saved reply. Pass the same references if you delegate further.`

/**
 * Hide Todo through the public registry; both the agent and this plugin own each mask.
 * @param ctx - owning plugin context.
 * @param config - current Timeline settings.
 * @param storage - Timeline's session data service.
 * @param owns - whether this installation owns the agent's planning tools.
 */
export function installGuidance(ctx: Context, config: Config, storage: TimelineStorage, owns: OwnsAgent): void {
  // Harness re-evaluates context at each step. A turn keeps one snapshot; tool results supply later edits.
  const snapshots = new WeakMap<AbortSignal, string>()
  ctx.systemPrompt.section({
    name: 'timeline:planning',
    order: 120,
    text: ({ agent }) =>
      isWorker(agent)
        ? workerInstructions
        : `${instructions}\n\n${taskLanguageInstruction(config.language, config.uiLanguage)}`,
    interpolate: false,
  })
  ctx.systemPrompt.context({
    name: 'timeline:state',
    order: 120,
    required: true,
    interpolate: false,
    text: ({ agent, signal }) => {
      if (agent === undefined) return ''
      const saved = signal === undefined ? undefined : snapshots.get(signal)
      if (saved !== undefined) return saved
      if (isWorker(agent)) {
        const text = delegationContext(ctx, agent, storage)
        if (signal !== undefined) snapshots.set(signal, text)
        return text
      }
      if (!storage.available(agent.session)) {
        const text =
          'Timeline storage is unavailable. Continue ordinary work and report the error; preserve saved plans instead of creating replacements.'
        if (signal !== undefined) snapshots.set(signal, text)
        return text
      }
      const { view } = storage.stateOf(agent.session)
      const trees = view.trees.map((tree) => {
        const priorities = prioritiesOf(tree.tasks)
        const parents = new Set(
          tree.tasks.filter(task => task.status !== 'retired').map(task => task.parent),
        )
        const unfinished = tree.tasks
          .filter(task => !parents.has(task.id) && !['done', 'retired'].includes(task.status))
          .sort((a, b) => (priorities.get(a.id) ?? 'P4').localeCompare(priorities.get(b.id) ?? 'P4'))
        const tasks = unfinished.slice(0, CONTEXT_ITEM_LIMIT)
        const byId = new Map(tree.tasks.map(task => [task.id, task]))
        const groups = new Set<string>()
        for (const task of tasks) {
          let parent = task.parent
          while (parent !== null && !groups.has(parent) && groups.size < CONTEXT_ITEM_LIMIT) {
            groups.add(parent)
            parent = byId.get(parent)?.parent ?? null
          }
        }
        return {
          id: tree.id,
          title: tree.title,
          status: measureAll(tree.tasks).get(null)?.status ?? 'pending',
          ...(unfinished.length === 0 ? {} : { unfinished: unfinished.length }),
          ...(tree.id !== view.activeTreeId
            ? {}
            : {
              ...(groups.size === 0
                ? {}
                : {
                  groups: tree.tasks
                    .filter(task => groups.has(task.id))
                    .map(({ id, parent, title }) => ({
                      id,
                      ...(parent === null ? {} : { parent }),
                      title,
                    })),
                }),
              tasks: tasks.map(({ id, parent, title, status, done, note }) => ({
                id,
                ...(parent === null ? {} : { parent }),
                title,
                status,
                ...(done[0] === 0 && done[1] === 1 ? {} : { done }),
                ...(note.length === 0 ? {} : { note: note.slice(0, CONTEXT_NOTE_LIMIT) }),
                ...(priorities.get(id) == null ? {} : { priority: priorities.get(id) }),
              })),
            }),
        }
      })
      const openAnnotations = view.annotations.filter(
        annotation =>
          annotation.reply === null &&
          (annotation.control === undefined || annotation.control.outcome === null),
      )
      const priorities = prioritizedTasks(view.trees)
      const text =
        trees.length === 0 && openAnnotations.length === 0
          ? ''
          : `Current Timeline plan (turn-start state, not a new request): ${JSON.stringify({
            selectedTree: view.activeTreeId,
            trees,
            ...(priorities.length === 0 ? {} : { priorities }),
            ...(openAnnotations.length === 0
              ? {}
              : {
                openAnnotations: openAnnotations.slice(0, CONTEXT_ITEM_LIMIT).map(({ id, target, control }) => ({
                  id,
                  target,
                  ...(control === undefined ? {} : { requestedAction: control.action }),
                })),
              }),
          })}${openAnnotations.length === 0 ? '' : '\nAddress open discussions at a safe checkpoint. Use timeline_read with annotation set to the ID if you need the full message or context. Save replies with timeline_reply. Apply pause or continue to the requested scope before confirming it.'}`
      if (signal !== undefined) snapshots.set(signal, text)
      return text
    },
  })
  const masks = new Map<Agent, () => void>()
  let refreshing = false
  let disposed = false
  const refresh = () => {
    if (refreshing || disposed) return
    refreshing = true
    try {
      if (config.allowTodo) {
        for (const dispose of masks.values()) dispose()
        masks.clear()
        return
      }
      for (const [agent, dispose] of masks) {
        if (owns(agent) && storage.available(agent.session)) continue
        dispose()
        masks.delete(agent)
      }
      for (const agent of ctx.agents.list()) {
        if (!owns(agent) || !storage.available(agent.session)) continue
        if (masks.has(agent) || ctx.tools.get('todo_write', agent) === undefined) continue
        // Restrict inherited capabilities. An explicit agent-local override is guarded below;
        // the public registry deliberately exempts its owner from inherited restrictions.
        if (ctx.tools.get('todo_write', scopeParentOf(agent)) === undefined) continue
        masks.set(agent, agent.ctx.tools.restrict({ deny: ['todo_write'] }))
      }
    } finally {
      refreshing = false
    }
  }
  ctx.effect(
    () => () => {
      disposed = true
      for (const dispose of masks.values()) dispose()
      masks.clear()
    },
    'timeline: Todo masks',
  )
  ctx.on('agent/created', () => {
    refresh()
    return undefined
  }, { global: true })
  ctx.on('tools/change', refresh, { global: true })
  ctx.on('loader/volatile-update', refresh)
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = masks.get(agent)
    masks.delete(agent)
    dispose?.()
  }, { global: true })
  // A stale conversation may still request the old tool. Never execute a second task list.
  ctx.tools.guard(exec =>
    exec.name === 'todo_write' &&
    !config.allowTodo &&
    exec.agent !== undefined &&
    owns(exec.agent) &&
    storage.available(exec.agent.session)
      ? {
        reason: isWorker(exec.agent)
          ? 'The delegating agent owns the shared task tree. Report progress and blockers to your parent.'
          : 'Timeline replaces Todo. Use timeline_tree and timeline_tasks.',
        info: { name: 'TimelineError', code: 'TIMELINE_TOOL_UNAVAILABLE' },
      }
      : undefined,
  )
  refresh()
}
