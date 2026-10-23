/** Replay explicitly deferred declarations without activating them. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { projectToolUpdates } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { resolveAdapterOptions } from '../../src/config.ts'
import { serialize } from '../../src/serialize.ts'

export const name = 'messages-all-deferred-tools-snapshot'
export const inject = ['tools', 'llm']

/**
 * Keep one real tool deferred and inspect the derived Messages request.
 * @param ctx - Snapshot composition context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [] })
    agent.ctx.tools.register(defineContentToolFixture({
      name: 'snapshot_pending', description: 'Wait for activation.', parameters: {}, deferLoading: true,
      async execute() { assert.fail('An unactivated tool must not be called') },
    }))
  })
  const connection = resolveAdapterOptions({})
  ctx.on('llm/stream', (options, next) => {
    const projected = projectToolUpdates(options.messages, options.tools, 'addition-only', options.toolHistory)
    assert.ok(projected.tools)
    assert.deepEqual(projected.tools, options.tools)
    const request = serialize({ ...options, tools: [...projected.tools] }, connection, projected.messages, new Map(), () => undefined)
    assert.deepEqual(request.tools, [
      { name: 'DeferredToolPlaceholder', description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.', input_schema: { type: 'object', properties: {} } },
      { name: 'snapshot_pending', description: 'Wait for activation.', input_schema: { type: 'object', properties: {} }, defer_loading: true },
    ])
    assert.deepEqual(request.messages.filter(message => message.role === 'system'), [])
    return next()
  })
}
