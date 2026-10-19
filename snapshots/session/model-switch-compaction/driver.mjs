/** Test-only request routing from a large model to a smaller model after tool execution. */
export const name = 'model-switch-compaction-driver'

/**
 * Route the next request before its model choice becomes durable.
 * @param {import('@deepseek-ai/cordis').Context} ctx - composition context.
 */
export function apply(ctx) {
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step < 2 ? config : { ...config, model: 'deepseek-v4-pro' }
  })
}
