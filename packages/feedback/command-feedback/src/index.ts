/**
 * Session feedback event plus the human-facing `/feedback` producer. Recording
 * appends one authoritative log-only event and does not start model work. The
 * append is eager but unflushed, so acknowledgement reports that the entry is
 * logged, not that it reached disk.
 * @module @deepseek-ai/dsh-command-feedback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'

export const name = 'command-feedback'
export const inject = ['commands']

const USAGE = 'Usage: /feedback <text>'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One recorded human remark about this session. Log-only and independent
     * of its trigger; it never enters model context or derived history.
     */
    'feedback/record': { text: string }
  }
}

/**
 * Record feedback independently of any UI trigger.
 * @param session - session the feedback describes.
 * @param text - human-authored feedback; surrounding whitespace is discarded.
 * @throws {TypeError} when the normalized text is empty.
 */
export function recordFeedback(session: Session, text: string): void {
  const normalized = text.trim()
  if (normalized.length === 0) throw new TypeError('feedback text must not be empty')
  session.append('feedback/record', { text: normalized })
}

/**
 * Validate, record, and acknowledge one feedback entry. Returning an error
 * leaves no `feedback/record` event.
 * @param invocation - receiving agent, raw command input, and UI cancellation.
 * @returns an acknowledgement containing the receiving session and anonymous
 * user ids, or a usage error when no feedback text was supplied.
 */
function executeFeedbackCommand(invocation: CommandInvocation): CommandResult {
  if (invocation.rawInput.trim().length === 0) {
    return { kind: 'error', text: `Feedback text is required. ${USAGE}` }
  }
  recordFeedback(invocation.agent.session, invocation.rawInput)
  return {
    kind: 'success',
    text: `Feedback recorded for session ${invocation.agent.session.id}\nAnonymous user: ${getOrCreateAnonymousUserId()}.`,
  }
}

/** Register the global `/feedback` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'feedback',
    description: 'record feedback about this session',
    input: { hint: '<text>' },
    recordInput: false,
    handler: executeFeedbackCommand,
  })
}
