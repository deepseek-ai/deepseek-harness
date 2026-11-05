/** Cancel after the PTC process completes a nested working_directory call. */
export const name = 'ptc-cancel-fixture'
export const inject = ['tools']
export function apply(ctx) {
  ctx.on('tools/result', (exec) => {
    if (exec.name === 'working_directory' && exec.parent !== undefined && exec.agent !== undefined) {
      exec.agent.cancel({ kind: 'user' })
    }
  })
}
