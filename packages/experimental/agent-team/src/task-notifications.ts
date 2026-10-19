/** Coalesced task-board notices delivered through each live Agent's durable inbox. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TeamTaskNotificationError } from './error.ts'
import type { TeamTaskSnapshot } from './types.ts'

/** Runtime-authored notice that a shared task board needs to be read again. */
export interface TeamTaskChangeSource {
  readonly kind: 'team-task-change'
  readonly form: 'notice'
  readonly summary: string
  readonly rootSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-task-change': TeamTaskChangeSource
  }
}

/**
 * Notify other resident Agents after a task commit, without starting idle turns.
 * Pending board notices coalesce in the inbox itself; no separate delivery state is retained.
 * @param ctx - live Agent registry.
 * @param caller - Agent whose tool result already supplies the committed task.
 * @param root - exact runtime owner of the tree and task board.
 * @param task - task revision already committed to the root Session.
 * @throws TeamTaskNotificationError after attempting every recipient when delivery fails.
 */
export function notifyTaskChange(ctx: Context, caller: Agent, root: Agent, task: TeamTaskSnapshot): void {
  const failures: Array<{ id: SessionId; error: unknown }> = []
  for (const recipient of ctx.agents.list()) {
    if (recipient === caller || (recipient !== root && !ctx.agents.isOwnedBy(recipient.id, root))) continue
    try {
      const pending = recipient.inbox.nextStep.find(message =>
        message.source.kind === 'team-task-change' && message.source.rootSessionId === root.id)
      const summary = `Shared task board updated: ${task.id} revision ${task.revision}.`
      const message = createUserMessage({
        content: [{ type: 'text', text: `${summary} Use team_task_list or team_task_get to read the current tasks before acting.` }],
        source: { kind: 'team-task-change', form: 'notice', summary, rootSessionId: root.id },
      })
      if (pending === undefined) recipient.inject(message)
      else recipient.inbox.replace(pending.id, { ...message, id: pending.id })
    } catch (error: unknown) {
      failures.push({ id: recipient.id, error })
    }
  }
  if (failures.length > 0) {
    throw new TeamTaskNotificationError(task, failures.map(failure => failure.id), {
      cause: new AggregateError(failures.map(failure => failure.error)),
    })
  }
}
