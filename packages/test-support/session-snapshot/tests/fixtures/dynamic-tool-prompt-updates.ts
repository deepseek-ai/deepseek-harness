import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { apply as registerDynamicTools } from './dynamic-tool-updates.ts'

export const name = 'snapshot-dynamic-tool-prompt-updates'
export const inject = ['tools', 'systemPrompt']

/** Add prompt guidance and a tool after reading, preserving the first request's history. */
export function apply(ctx: Context): void {
  registerDynamicTools(ctx)
  let guidance = ''
  ctx.systemPrompt.section({ name: 'snapshot:dynamic-tool-guidance', order: 400, text: () => guidance })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!result.isError && exec.name === 'read') {
      guidance = 'Dynamic tool guidance: call snapshot_ping once, then reply with the single word DONE.'
    }
    return downstream
  })
  let requests = 0
  let firstMessages: GenerateOptions['messages'] = []
  ctx.on('llm/stream', (options, next) => {
    if (++requests === 1) firstMessages = options.messages
    else if (requests === 2) {
      assert.deepEqual(options.messages.slice(0, firstMessages.length), firstMessages)
      assert.equal(options.messages.filter(message => message.role === 'system').length, 2)
    }
    return next()
  })
}
