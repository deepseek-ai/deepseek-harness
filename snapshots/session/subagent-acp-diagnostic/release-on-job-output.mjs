/** Hold the scripted ACP background response until job_output owns its wait. */
import { rmSync, writeFileSync } from 'node:fs'

export const name = 'acp-diagnostic-release-on-job-output'
export const inject = ['tools', 'jobs']

const HOLD = '.dsh/acp-diagnostic-prompt-hold'

/** Install the scenario-local response barrier without changing tool output. */
export function apply(ctx) {
  ctx.on('tools/execute', (exec, next) => {
    if (exec.name === 'subagent_acp' && exec.arguments.run_in_background === true) {
      writeFileSync(HOLD, '', { flag: 'wx' })
    }
    return next()
  })
  ctx.effect(() => {
    const jobs = ctx.jobs
    const wait = jobs.wait
    jobs.wait = function (...args) {
      // The registry registers its waiter synchronously, unlike the tool middleware.
      const pending = wait.apply(this, args)
      rmSync(HOLD)
      return pending
    }
    return () => {
      jobs.wait = wait
      rmSync(HOLD, { force: true })
    }
  })
}
