/** Test-only explicit initial selection and model switch after the first step's tool call. */

const SELECTED = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }

export const name = 'model-switch-driver'
export const inject = ['tools']

/**
 * Record an explicit initial choice and a switch after `todo_write`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - composition context.
 */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const initial = agent.model.current()
    if (initial === undefined) throw new Error('model-switch driver requires an initial route')
    agent.model.select(initial)
    agent.model.select(initial)
  })
  ctx.on('agent/pre-step', ({ modelSelection }, next) => {
    if (modelSelection.model === SELECTED.model && modelSelection.reasoningEffort !== SELECTED.reasoningEffort) {
      throw new Error('model-switch driver requires the explicit effort before the second step')
    }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'todo_write' && !result.isError) {
      if (exec.agent === undefined) throw new Error('model-switch driver requires a calling Agent')
      exec.agent.model.select(SELECTED)
    }
    return result
  })
}
