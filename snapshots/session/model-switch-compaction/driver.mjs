/** Test-only request routing from a large model to a smaller model after tool execution. */
export const name = 'model-switch-compaction-driver'
export const inject = ['tools']

/**
 * Select the smaller model after the first tool call, before the next step prepares.
 * @param {import('@deepseek-ai/cordis').Context} ctx - composition context.
 */
export function apply(ctx) {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'bash' && !result.isError) {
      if (exec.agent === undefined) throw new Error('model-switch compaction requires a calling Agent')
      exec.agent.model.select({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    }
    return result
  })
}
