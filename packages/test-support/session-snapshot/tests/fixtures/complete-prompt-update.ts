/** Complete-prompt transitions between recorded model requests. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'complete-prompt-update'
export const inject = ['systemPrompt']

/**
 * Enter, update, and leave a complete override after successive reads.
 * @param ctx - scenario plugin context.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'snapshot:blank', order: 399, text: ' \n\t ' })
  let reads = 0
  let guidance = 'Complete instructions: read task.txt again.'
  let leave: (() => void) | undefined
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError || exec.name !== 'read') return downstream
    reads++
    if (reads === 1) {
      leave = ctx.systemPrompt.section({
        name: 'snapshot:complete', order: 400, complete: true, text: () => ` \n${guidance}\t `,
        retirement: 'The complete task instructions no longer apply.',
      })
    } else if (reads === 2) {
      guidance = 'Updated complete instructions: read task.txt once more.'
    } else {
      leave?.()
    }
    return downstream
  })
}
