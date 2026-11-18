/** Cancel after the PTC process completes a nested job_list call. */
export const name = 'ptc-cancel-fixture'
export const inject = ['tools']
export function apply(ctx) {
  ctx.on('tools/result', (exec) => {
    if (exec.name === 'job_list' && exec.parent !== undefined && exec.agent !== undefined) {
      exec.agent.cancel({ kind: 'user' })
    }
  })
}
