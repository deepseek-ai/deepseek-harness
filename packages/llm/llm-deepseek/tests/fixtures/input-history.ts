/** Replay persisted user input carrying assistant-only content through Messages. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '../../src/config.ts'
import { serialize } from '../../src/serialize.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:messages-input-history-snapshot': { kind: 'plugin:messages-input-history-snapshot' }
  }
}

export const name = 'messages-input-history-snapshot'
export const inject = ['llm']

/** Record legacy-style notices and verify their provider representation. */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const source = { kind: `plugin:${name}` } as const
    return { ...decision, messages: [
      ...decision.messages,
      createUserMessage({ source, content: [
        { type: 'text', text: 'Background subagent finished. Its closing message: Saved child answer.' },
        { type: 'reasoning', text: 'unforwarded-child-thought' },
        { type: 'tool-call', id: ToolCallId('unforwarded-child-call'), name: 'bash', arguments: '{}' },
      ] }),
      createUserMessage({ source, content: [{ type: 'reasoning', text: 'unforwarded-empty-notice' }] }),
    ] }
  })
  const connection = resolveAdapterOptions({})
  ctx.on('llm/stream', (options, next) => {
    const request = serialize(options, connection, options.messages, new Map(), () => undefined)
    const payload = JSON.stringify(request.messages)
    assert.ok(payload.includes('Saved child answer.'))
    assert.ok(!payload.includes('unforwarded-'))
    assert.ok(request.messages.every(message => message.content.length > 0))
    return next()
  })
}
