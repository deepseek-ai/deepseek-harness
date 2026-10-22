/** Replay a complete replacement of the initially available tools through Messages serialization. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { projectToolUpdates } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { resolveAdapterOptions } from '../../src/config.ts'
import { serialize } from '../../src/serialize.ts'

export const name = 'messages-deferred-tools-snapshot'
export const inject = ['tools', 'llm']

/**
 * Replace the baseline after its first call and check the serialized replay requests.
 * @param ctx - Snapshot composition context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [] })
    const removeInitial = agent.ctx.tools.register(defineContentToolFixture({
      name: 'snapshot_initial', description: 'Make snapshot_ping available.', parameters: {},
      async execute() {
        removeInitial()
        agent.ctx.tools.register(defineContentToolFixture({
          name: 'snapshot_ping', description: 'Return pong once.', parameters: {},
          async execute() {
            return [{ type: 'text', text: 'pong' }]
          },
        }))
        return [{ type: 'text', text: 'snapshot_ping is available.' }]
      },
    }))
  })
  const connection = resolveAdapterOptions({})
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    const projected = projectToolUpdates(options.messages, options.tools, 'addition-only', options.toolHistory)
    assert.ok(projected.tools)
    const request = serialize({ ...options, tools: [...projected.tools] }, connection, projected.messages, new Map(), () => undefined)
    switch (++requests) {
      case 1:
        assert.deepEqual(request.tools?.map(tool => tool.name), ['snapshot_initial'])
        break
      case 2:
      case 3:
        assert.deepEqual(request.tools, [
          { name: 'DeferredToolPlaceholder', description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.', input_schema: { type: 'object', properties: {} } },
          { name: 'snapshot_ping', description: 'Return pong once.', input_schema: { type: 'object', properties: {} }, defer_loading: true },
        ])
        assert.deepEqual(request.messages.filter(message => message.role === 'system'), [
          { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'snapshot_ping' } }] },
        ])
        break
      default:
        assert.fail('Unexpected request after the replacement tool call completed')
    }
    return next()
  })
}
