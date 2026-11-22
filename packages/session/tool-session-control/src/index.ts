/**
 * Model-authored messages to ordinary Web Sessions with runtime-owned sender attribution.
 * @module @deepseek-ai/dsh-tool-session-control
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
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
    description: 'Send a message to an independent session. Use this tool only when the user explicitly asks you to send a message to another session.',
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
      const id = brandString<SessionId>(args.session_id)
      if (id === caller.id) {
        throw new SessionMessageError('session_send_message requires another session', 'SESSION_MESSAGE_SELF')
      }
      assertUnarchived(id)
      // The controller shares one restoration among its callers and owns the restored Agent.
      const found = await untilAborted(ctx.sessionController.resolveAgent(id), exec.signal)
      if ('error' in found) {
        if (found.error.code !== 'session/agent-busy') throw found.error
        throw new SessionMessageError(
          `session "${id}" is not available to session_send_message`,
          'SESSION_MESSAGE_SUBAGENT_OWNED',
          { cause: found.error },
        )
      }
      exec.signal.throwIfAborted()
      assertUnarchived(id)
      // The source is the agent-message kind dsh-subagent declares. The prefix differs from send_message,
      // whose `Agent <name>` senders resolve only inside the recipient's subagent tree.
      const message = createUserMessage({
        content: [{ type: 'text', text: `Session ${caller.id} sent a message: ` }, { type: 'text', text: args.message }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id },
      })
      found.agent.steer(message)
      return { message_id: message.id }
    },
  }))
}
