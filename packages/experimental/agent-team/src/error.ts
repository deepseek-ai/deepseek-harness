/** Typed Agent Teams failures. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamTaskSnapshot } from './types.ts'

/** Stable failure raised by the Team domain. */
export class TeamError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'TeamError'
  }
}

/** The task is committed; failed notices must never cause a duplicate task mutation. */
export class TeamTaskNotificationError extends TeamError {
  constructor(
    readonly committedTask: TeamTaskSnapshot,
    readonly failedRecipients: readonly SessionId[],
    options?: ErrorOptions,
  ) {
    super(
      `Task ${committedTask.id} revision ${committedTask.revision} was committed, but notifications failed for agents ${failedRecipients.join(', ')}. Read the task before continuing; do not repeat the mutation.`,
      'TEAM_TASK_NOTIFICATION_FAILED',
      options,
    )
    this.name = 'TeamTaskNotificationError'
  }
}
