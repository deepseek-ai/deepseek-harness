import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.ts'
import { isWorker } from './delegation.ts'
import type { OwnsAgent } from './delegation.ts'
import { languageText, outputLanguage } from './policy.ts'
import type { TimelineStorage } from './storage.ts'
import { prioritizedTasks } from './tasks.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'timeline-priority': { kind: 'timeline-priority'; form: 'notice'; summary: string }
  }
}

// Coalesce quick P0 edits before admitting one notice to the next step.
const PRIORITY_DEBOUNCE_MS = 750

interface Activity {
  turn: number
  step: number
  stale: number
}

/**
 * Count main-agent iterations, not tool calls or independent reporting requests.
 * @param ctx - owning plugin context.
 * @param config - current Timeline settings.
 * @param storage - Timeline's session data service.
 * @param owns - whether this installation owns the agent's planning tools.
 */
export function installReminders(ctx: Context, config: Config, storage: TimelineStorage, owns: OwnsAgent): void {
  const activity = new Map<Agent, Activity>()
  const urgent = new Map<
    Agent,
    { timer: ReturnType<typeof setTimeout> | undefined; pending: MessageId | undefined }
  >()
  let disposed = false
  ctx.on('timeline/priority', (session) => {
    for (const agent of ctx.agents.list()) {
      if (isWorker(agent) || agent.session.id !== session.id || agent.status !== 'running' || !owns(agent)) continue
      let state = urgent.get(agent)
      if (state === undefined) {
        state = { timer: undefined, pending: undefined }
        urgent.set(agent, state)
      }
      clearTimeout(state.timer)
      const current = state
      current.timer = setTimeout(() => {
        current.timer = undefined
        if (agent.status !== 'running') return
        try {
          if (current.pending !== undefined) agent.inbox.remove(current.pending)
          current.pending = undefined
          const message = createUserMessage({
            source: {
              kind: 'timeline-priority',
              form: 'notice',
              summary: languageText[outputLanguage(config.language, config.uiLanguage)].priority,
            },
            content: [
              {
                type: 'text',
                text: `Timeline priority update: P0 changed. At the next safe checkpoint, prefer the highest-priority eligible work within the current goal.\nEligible prioritized tasks: ${JSON.stringify(prioritizedTasks(storage.stateOf(session).view.trees))}`,
              },
            ],
          })
          agent.inject(message)
          current.pending = message.id
        } catch (error: unknown) {
          ctx.logger.warn('Timeline priority notice failed', error)
        }
      }, PRIORITY_DEBOUNCE_MS)
    }
  })
  // Refresh at request admission, without queuing input that could reopen a closing response.
  ctx.systemPrompt.context({
    name: 'timeline:maintenance',
    order: 121,
    required: true,
    interpolate: false,
    text: ({ agent }) => {
      if (agent === undefined || isWorker(agent) || !storage.available(agent.session)) return ''
      const state = activity.get(agent)
      if (state === undefined || state.stale < config.reminderIterations) return ''
      return 'Task progress checkpoint: Save changes to the current goal’s tree, or start one if this multi-step goal has none. Use timeline_pull when choosing the next task.'
    },
  })
  ctx.on(
    'agent/request',
    async ({ agent, turn, step, signal }, next) => {
      const callConfig = await next()
      if (signal.aborted || disposed || isWorker(agent) || !owns(agent)) return callConfig
      let state = activity.get(agent)
      if (state === undefined || state.turn !== turn) {
        state = { turn, step: -1, stale: 0 }
        activity.set(agent, state)
      }
      if (state.step === step) return callConfig
      state.step = step
      state.stale++
      return callConfig
    },
    { global: true },
  )
  ctx.on(
    'tools/result',
    (exec, result) => {
      const state = exec.agent === undefined ? undefined : activity.get(exec.agent)
      if (
        exec.name === 'timeline_tasks' &&
        !result.isError &&
        exec.agent !== undefined &&
        state !== undefined
      ) {
        state.stale = 0
      }
      return undefined
    },
    { global: true },
  )
  ctx.on(
    'agent/disposed',
    ({ agent }) => {
      activity.delete(agent)
      clearTimeout(urgent.get(agent)?.timer)
      urgent.delete(agent)
    },
    { global: true },
  )
  ctx.effect(
    () => () => {
      disposed = true
      for (const [agent, state] of urgent) {
        clearTimeout(state.timer)
        if (state.pending !== undefined) agent.inbox.remove(state.pending)
      }
      urgent.clear()
      activity.clear()
    },
    'timeline: task maintenance reminders',
  )
}
