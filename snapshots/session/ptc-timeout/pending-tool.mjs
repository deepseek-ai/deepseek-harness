/** Hold one tool until the executor cancels its dispatch after runtime cleanup. */
export const name = 'ptc-pending-tool-fixture'

/** Mount a controlled asynchronous tool wait without adding model capabilities. */
export function apply(ctx) {
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.callId === 'call_timeout:ptc:1' && !exec.signal.aborted) {
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
    }
    return next()
  })
}
