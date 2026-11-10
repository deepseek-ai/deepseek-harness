/**
 * Model-authored Session messages with runtime-owned sender attribution.
 * @module @deepseek-ai/dsh-tool-session-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-control'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-session-control'
/** Services used by Session message tools. */
export const inject = ['tools', 'sessionControl']

/**
 * Register Session message delivery for the current composition.
 * @param ctx - context providing the tool registry and Session control service.
 */
export function apply(ctx: Context): void {
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
      if (exec.agent === undefined) throw new ToolContextUnavailableError('session_send_message requires a calling agent')
      if (args.message.trim().length === 0) throw new ToolArgsError(['message must contain non-whitespace text'])
      const result = await ctx.sessionControl.sendMessage(
        { id: SessionId(args.session_id), message: args.message },
        { caller: exec.agent, signal: exec.signal },
      )
      return { message_id: result.messageId }
    },
  }))
}
