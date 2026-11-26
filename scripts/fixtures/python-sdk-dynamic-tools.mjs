/** Register a native tool for the steps after a file read and remove it after its first execution. */
export const name = 'python-sdk-dynamic-tools'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned tool registry. */
export function apply(ctx) {
  /** @type {(() => void) | undefined} */
  let remove
  const tool = {
    name: 'snapshot_ping',
    description: 'Return pong once.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute() { return 'pong' },
  }
  // The next step declares the tools registered when it starts; a call keeps its step's declaration.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError) return downstream
    if (exec.name === 'read' && exec.arguments.file_path === 'dynamic-tool-task.txt') {
      if (remove === undefined && exec.agent?.model.current()?.provider === 'deepseek-official') remove = ctx.tools.register(tool)
    } else if (exec.name === 'snapshot_ping' && remove !== undefined) {
      remove()
      remove = undefined
    }
    return downstream
  })
}
