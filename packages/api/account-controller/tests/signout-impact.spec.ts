/** Sign-out impact follows the latest logged provider of running tasks. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AccountController } from '../src/index.ts'

it('reports running account requests and excludes idle or unbound tasks', async () => {
  const ctx = new Context()
  const active: Array<Pick<Agent, 'status' | 'session'>> = []
  const task = (status: Agent['status'], provider?: string): Pick<Agent, 'status' | 'session'> => ({
    status, session: { requestContext: () => provider === undefined ? undefined : { provider, model: 'model' } } as Agent['session'],
  })
  ctx.provide('agents', { list: () => active } as Context['agents'])
  const controller = new AccountController(ctx)
  try {
    expect(controller.hasRunningAccountTasks()).toBe(false)
    active.push(task('running'), task('running', 'deepseek-official'), task('idle', 'deepseek-account'))
    expect(controller.hasRunningAccountTasks()).toBe(false)
    active.push(task('running', 'deepseek-account'))
    expect(controller.hasRunningAccountTasks()).toBe(true)
    active.pop()
    expect(controller.hasRunningAccountTasks()).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
