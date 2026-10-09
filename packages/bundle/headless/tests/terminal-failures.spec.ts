/** Headless exit status after parent summaries fail outside a durable terminal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { apply } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'

const originalInternals = { ...internals }
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  Object.assign(internals, originalInternals)
  vi.restoreAllMocks()
})

async function harness() {
  const context = new Context()
  ctx = context
  await mountAgentLoopTestDependencies(context)
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(AgentDefaultModelConfig, { provider: 'mock', model: 'mock' })
  context.llm.registerAdapter(['mock'], new MockAdapter([
    textResponse('waiting'), textResponse('summary'), textResponse('recovered'),
  ]))
  let out = ''
  let err = ''
  internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
  internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
  const exited = Promise.withResolvers<number>()
  context.provide('appExit', exited.resolve)
  return {
    ctx: context,
    async run(json = false) {
      apply(context, { task: 'delegate', json })
      return { code: await exited.promise, out, err }
    },
  }
}

function followup(parent: Agent): void {
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'user' } }))
}

describe('headless terminal failures', () => {
  it.each([
    { failedEvent: 'turn/start', json: false },
    { failedEvent: 'turn/end', json: false },
    { failedEvent: 'turn/start', json: true },
    { failedEvent: 'turn/end', json: true },
  ] as const)('fails after a later $failedEvent cannot commit (json=$json)', async ({ failedEvent, json }) => {
    const test = await harness()
    const failures: unknown[] = []
    test.ctx.on('agent/error', ({ error }) => { failures.push(error) })
    const waitForChildren = vi.fn().mockImplementationOnce((parent: Agent) => {
      const append = parent.session.append.bind(parent.session)
      const failAppend: typeof parent.session.append = (type, data, ...intent) => {
        if (type === failedEvent) throw new Error(`summary ${failedEvent} unavailable`)
        return append(type, data, ...intent)
      }
      vi.spyOn(parent.session, 'append').mockImplementation(failAppend)
      followup(parent)
      return Promise.resolve(true)
    }).mockResolvedValue(false)
    test.ctx.provide('subagents', { waitForChildren } as never)

    const result = await test.run(json)
    expect(failures).toHaveLength(1)
    expect(result.code).toBe(1)
    expect(result.err).toBe(`dsh: summary ${failedEvent} unavailable\n`)
    if (json) {
      const events = result.out.trim().split('\n').map(line => JSON.parse(line) as { type: string; message?: string })
      expect(events.at(-1)).toEqual({ type: 'error', message: `summary ${failedEvent} unavailable` })
      expect(events.some(event => event.type === 'final')).toBe(false)
    } else {
      expect(result.out).toBe('')
    }
  })

  it.each([false, true])('uses the durable outcome after a summary hook fails (recover=%s)', async (recover) => {
    const test = await harness()
    const waitForChildren = vi.fn().mockImplementationOnce((parent: Agent) => {
      const stop = test.ctx.on('agent/pre-step', () => {
        stop()
        throw new Error('summary hook failed')
      })
      followup(parent)
      return Promise.resolve(true)
    }).mockImplementationOnce((parent: Agent) => {
      if (recover) followup(parent)
      return Promise.resolve(recover)
    }).mockResolvedValue(false)
    test.ctx.provide('subagents', { waitForChildren } as never)

    await expect(test.run()).resolves.toEqual(recover
      ? { code: 0, out: 'summary\n', err: '' }
      : { code: 1, out: 'waiting\n', err: 'dsh: UNKNOWN: summary hook failed\n' })
  })

  it.each(['turn/start', 'turn/end'] as const)('accepts a recovered summary after a missing %s', async (failedEvent) => {
    const test = await harness()
    const waitForChildren = vi.fn().mockImplementationOnce((parent: Agent) => {
      const append = parent.session.append.bind(parent.session)
      let failed = false
      const failAppend: typeof parent.session.append = (type, data, ...intent) => {
        if (!failed && type === failedEvent) {
          failed = true
          throw new Error(`summary ${failedEvent} unavailable`)
        }
        return append(type, data, ...intent)
      }
      vi.spyOn(parent.session, 'append').mockImplementation(failAppend)
      followup(parent)
      return Promise.resolve(true)
    }).mockImplementationOnce((parent: Agent) => {
      followup(parent)
      return Promise.resolve(true)
    }).mockResolvedValue(false)
    test.ctx.provide('subagents', { waitForChildren } as never)

    await expect(test.run()).resolves.toEqual({
      code: 0,
      out: 'recovered\n',
      err: '',
    })
  })

  it('ignores a different Agent failure during root completion', async () => {
    const test = await harness()
    const { agent: other } = await test.ctx.agents.create({
      sessionId: SessionId('other'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    test.ctx.on('agent/pre-step', ({ agent }, next) => {
      if (agent === other) throw new Error('another Agent failed')
      return next()
    })
    const waitForChildren = vi.fn().mockImplementationOnce(async () => {
      followup(other)
      await other.whenIdle()
      return false
    }).mockResolvedValue(false)
    test.ctx.provide('subagents', { waitForChildren } as never)

    await expect(test.run()).resolves.toEqual({ code: 0, out: 'waiting\n', err: '' })
  })
})
