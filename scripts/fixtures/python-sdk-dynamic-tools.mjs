/** Add a native tool after a file read and unregister it after its first execution. */
export const name = 'python-sdk-dynamic-tools'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned tool registry. */
export function apply(ctx) {
  let removeTool
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError) return downstream
    if (exec.name === 'read' && exec.arguments.file_path === 'dynamic-tool-task.txt') {
      removeTool = ctx.effect(() => ctx.tools.register({
        name: 'snapshot_ping',
        description: 'Return pong once.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: value }] },
        },
        async execute() { return 'pong' },
      }))
    } else if (exec.name === 'snapshot_ping') {
      removeTool?.()
      removeTool = undefined
    }
    return downstream
  })
}
