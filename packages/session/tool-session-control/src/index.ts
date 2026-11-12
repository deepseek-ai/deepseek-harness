/**
 * Model-authored messages to ordinary Web Sessions with runtime-owned sender attribution.
 * @module @deepseek-ai/dsh-tool-session-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { AgentInputClosedError } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAgentMessage } from '@deepseek-ai/dsh-subagent'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'

/** Cordis plugin name. */
export const name = 'tool-session-control'
/** Services used by Session message tools. */
export const inject = ['tools', 'sessionController', 'workspaceRegistry']

/** Failures callers distinguish without parsing a display message. */
export type SessionMessageErrorCode =
  | 'SESSION_MESSAGE_SELF'
  | 'SESSION_MESSAGE_ARCHIVED'
  | 'SESSION_MESSAGE_SUBAGENT_OWNED'
  | 'SESSION_MESSAGE_INPUT_CLOSED'

/** Rejection before the target inbox accepted the message; a retry repeats no accepted delivery. */
export class SessionMessageError extends HarnessError {
  override readonly code: SessionMessageErrorCode

  /**
   * @param message - actionable description of the rejected delivery.
   * @param code - stable failure classification.
   * @param options - original cause when converting a dependency failure.
   */
  constructor(message: string, code: SessionMessageErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SessionMessageError'
    this.code = code
  }
}

/** Stop waiting on shared work at cancellation; the operation itself keeps its owner. */
async function untilAborted<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Register Session message delivery for a Web composition.
 * @param ctx - context providing the tool registry, Session controller, and Workspace registry.
 */
export function apply(ctx: Context): void {
  const assertUnarchived = (id: SessionId): void => {
    if (!ctx.workspaceRegistry.archivedSessionIds.includes(id)) return
    throw new SessionMessageError(
      `session "${id}" is archived; unarchive it before sending a message`,
      'SESSION_MESSAGE_ARCHIVED',
    )
  }

  ctx.tools.register(defineTool({
    name: 'session_send_message',
    preserveSuccessOnCancellation: true,
    description: 'Send a message to an independent session. A working session receives it at its next input boundary; an idle session starts a turn, and an inactive session resumes first. Returns an acceptance receipt without waiting for a reply.',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'The target session ID.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Nonblank message to deliver.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { message_id: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'other',
      title: 'Send message',
      rawInput: args.session_id,
      content: [{ type: 'text', text: args.message }],
    }),
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new ToolContextUnavailableError('session_send_message requires a calling agent')
      if (args.message.trim().length === 0) throw new ToolArgsError(['message must contain non-whitespace text'])
      const id = SessionId(args.session_id)
      if (id === caller.id) {
        throw new SessionMessageError('session_send_message requires another session', 'SESSION_MESSAGE_SELF')
      }
      assertUnarchived(id)
      // The controller shares one restoration among its callers and owns the restored Agent.
      const found = await untilAborted(ctx.sessionController.resolveAgent(id), exec.signal)
      if ('error' in found) {
        if (found.error.code !== 'session/agent-busy') throw found.error
        throw new SessionMessageError(
          `session "${id}" is a subagent; message it with send_message and its agent name`,
          'SESSION_MESSAGE_SUBAGENT_OWNED',
          { cause: found.error },
        )
      }
      exec.signal.throwIfAborted()
      assertUnarchived(id)
      const message = createAgentMessage(caller, caller.id, [{ type: 'text', text: args.message }])
      try {
        found.agent.steer(message)
      } catch (error: unknown) {
        if (!(error instanceof AgentInputClosedError)) throw error
        throw new SessionMessageError(
          `session "${id}" is closing; the message was not accepted`,
          'SESSION_MESSAGE_INPUT_CLOSED',
          { cause: error },
        )
      }
      return { message_id: message.id }
    },
  }))
}
