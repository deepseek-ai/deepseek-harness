/** Exercises the composed internal approval service. */
import { appendFile } from 'node:fs/promises'

export const name = 'sdk-approval-fixture'
export const inject = ['approval']

/** Ask once per turn and expose whether the guarded operation ran. */
export function apply(ctx, config) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const outcome = await ctx.approval.request({ agent, signal, toolName: 'fixture-write', reason: 'write approval marker' })
    if (outcome === 'allowed-once') await appendFile(config.path, 'approved\n')
    return config.stopAfterApproval ? { kind: 'reject' } : next()
  })
}
