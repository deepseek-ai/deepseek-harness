/** Order child completion before the parent's next request in recorded snapshots. */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'subagent-settlement-barrier'
export const inject = ['subagents', 'tools']

/**
 * Hold the tool response until activation settlement has queued its notice.
 * @param ctx - snapshot runtime carrying tool execution and subagent services.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name.startsWith('subagent') && exec.agent !== undefined) {
      await ctx.subagents.waitForChildren(exec.agent)
    }
    return result
  })
}
