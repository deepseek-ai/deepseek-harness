/** Select PTC for the parent program, then restore native calls before child creation. */
export const name = 'advanced-toolchain-presentation'
export const inject = ['tools']

export function apply(ctx) {
  const selections = new WeakMap()
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || exec.parent !== undefined || result.error !== undefined) return
    if (exec.name === 'cordis_inspect_list' && !selections.has(exec.agent)) {
      selections.set(exec.agent, exec.agent.ctx.tools.presentAs('ptc'))
    } else if (exec.name === 'run_code') {
      selections.get(exec.agent)?.()
      selections.set(exec.agent, null)
    }
  })
}
