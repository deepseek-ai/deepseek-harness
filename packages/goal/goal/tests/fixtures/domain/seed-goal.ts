/** Test-only Loader plugin that creates a disarmed goal at the first real step edge. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-goal'

export const name = 'seed-goal'
export const inject = ['goals']

export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', ({ agent }, next) => {
    if (ctx.goals.get(agent) === undefined) {
      ctx.goals.create(agent, {
        objective: 'Prove the composed goal survives in the session log',
        maxGoalRounds: 7,
      })
      // An armed goal makes the shipped goal-round-driver start a round at
      // idle, racing the test driver's disposal. Activation is process-local,
      // so disarming leaves the persisted snapshot unchanged.
      ctx.goals.disarm(agent)
    }
    return next()
  })
}
