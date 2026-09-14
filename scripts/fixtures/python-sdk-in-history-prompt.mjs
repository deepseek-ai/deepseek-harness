/** Change one ordinary section after a successful persistent shell call. */
export const name = 'python-sdk-in-history-prompt'
export const inject = ['systemPrompt']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Composed runtime services. */
export function apply(ctx) {
  let version = 1
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'python-sdk:in-history',
    order: 400,
    text: () => `Python SDK prompt version ${version}.`,
  }))
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!result.isError && (exec.name === 'bash' || exec.name === 'pwsh')) version = 2
    return downstream
  })
}
