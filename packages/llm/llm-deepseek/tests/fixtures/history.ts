/** Exercise Messages request conversion with recorded responses from another protocol. */
import type { Context } from '@deepseek-ai/cordis'
import { resolveAdapterOptions } from '../../src/config.ts'
import { serialize } from '../../src/serialize.ts'

export const name = 'messages-history-snapshot'
export const inject = ['llm']

export function apply(ctx: Context): void {
  const connection = resolveAdapterOptions({})
  ctx.on('llm/stream', (options, next) => {
    serialize(options, connection, options.messages, new Map(), () => undefined)
    return next()
  })
}
