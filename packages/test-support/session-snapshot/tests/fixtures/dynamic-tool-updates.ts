import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { projectToolUpdates } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

export const name = 'snapshot-dynamic-tool-updates'
export const inject = ['tools']

/** Activate a tool after reading, then disable it after use without changing prompt text. */
export function apply(ctx: Context): void {
  let active = false
  ctx.tools.register(defineContentToolFixture({
    name: 'snapshot_ping', description: 'Return pong once.', parameters: {},
    async execute() { return [{ type: 'text', text: 'pong' }] },
  }), { when: async () => active })
  let requests = 0
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError) return downstream
    switch (exec.name) {
      case 'read':
        active = true
        break
      case 'snapshot_ping':
        active = false
        break
    }
    return downstream
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(options.toolHistory)
    assert.equal(options.toolHistory.tools.some(tool => tool.name === 'snapshot_ping'), false)
    assert.equal(options.toolHistory.updates.length, requests - 1)
    for (const mode of ['in-history', 'addition-only'] as const) {
      const projected = projectToolUpdates(options.messages, options.tools, mode, options.toolHistory)
      const declaration = projected.tools?.find(tool => tool.name === 'snapshot_ping')
      const updates = projected.messages.filter(message => message.role === 'developer')
        .flatMap(message => message.content)
      switch (requests) {
        case 1:
          assert.equal(declaration, undefined)
          assert.deepEqual(updates, [])
          break
        case 2:
          // A new declaration stays deferred until its chronological activation.
          assert.equal(declaration?.deferLoading, true)
          assert.deepEqual(updates, [{ type: 'tool-addition', toolName: 'snapshot_ping' }])
          break
        case 3:
          if (mode === 'in-history') {
            assert.equal(declaration?.deferLoading, true)
            assert.deepEqual(updates, [
              { type: 'tool-addition', toolName: 'snapshot_ping' },
              { type: 'tool-removal', toolName: 'snapshot_ping' },
            ])
          } else {
            // Addition-only routes remove unavailable declarations and their activations.
            assert.equal(declaration, undefined)
            assert.deepEqual(updates, [])
          }
          break
        default:
          assert.fail('Unexpected model request after the tool lifecycle completed')
      }
    }
    return next()
  })
}
