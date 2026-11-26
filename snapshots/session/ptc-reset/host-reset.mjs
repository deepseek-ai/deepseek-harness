/** Exercise host reset and a tool that remains pending until its evaluation ends. */
import { CodeResetFailedError, PtcToolRegistry, inject as executorInject } from '@deepseek-ai/dsh-tool-registry-ptc'

export const name = 'ptc-host-reset-fixture'
export const inject = executorInject

/** Mount the shipped PTC root and drive recovery through its host API. */
export function apply(ctx) {
  // `run_code` is the reserved entry name; built profiles do not resolve dsh-tools from scenario fixtures.
  const executor = new PtcToolRegistry(ctx, { name: 'run_code' })
  executor.mountRoot()
  const runtime = ctx.ptcRuntime
  const release = runtime.release.bind(runtime)
  let failRelease = true
  runtime.release = async owner => {
    if (failRelease) { failRelease = false; throw new Error('fixture process cleanup failed') }
    await release(owner)
  }
  ctx.effect(() => () => { runtime.release = release })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.callId === 'call_keep:ptc:2' && !exec.signal.aborted) {
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
    }
    const result = await next()
    if (exec.callId === 'call_isolated') {
      try { await executor.reset(exec.agent) } catch (error) {
        if (!(error instanceof CodeResetFailedError)) throw error
      }
    }
    if (exec.callId === 'call_blocked') await executor.reset(exec.agent)
    return result
  })
}
