/** Keep each ACP terminal record and notice before its delegation tool result. */
export const name = 'acp-diagnostic-settlement-order'
export const inject = ['tools', 'subagents']

/**
 * Install a scenario-local completion barrier without changing the tool result.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario host context.
 */
export function apply(ctx) {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'subagent_acp') await ctx.subagents.waitForChildren(exec.agent)
    return result
  })
}
