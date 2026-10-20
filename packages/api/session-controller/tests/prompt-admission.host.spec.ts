/**
 * Session prompts through the Agent controller's admission stage: how the
 * `session/prompt` Remote reports a held, refused, or failed admission to the
 * client.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

let nextRequestId = 1

async function harness(options: { readonly refusal?: Error } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create()
  const inbox = createInboxStub()
  const deliver = (target: 'next-turn' | 'next-step', message: UserMessage): void => {
    if (options.refusal !== undefined) throw options.refusal
    inbox.append(target, message)
  }
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    status: 'idle',
    ctx,
    send: () => {},
    followup: (message) => { deliver('next-turn', message) },
    steer: (message) => { deliver('next-step', message) },
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const unregister = await ctx.agents.register(agent)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: '/tmp',
  })
  const prompt = (text: string, mode: SessionPromptRequest['mode'] = 'queue', requestId?: SessionRequestId) => ({
    requestId: requestId ?? `admission-${String(nextRequestId++)}` as SessionRequestId,
    sessionId: session.id,
    mode,
    content: [{ type: 'text' as const, text }],
  })
  return { ctx, agent, inbox, remote, prompt, unregister }
}

function textsOf(messages: readonly UserMessage[]): string[] {
  return messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('Session prompt admission', () => {
  it('admits a queued prompt into the next turn and a steered one into the next step', async () => {
    const { ctx, agent, inbox, remote, prompt } = await harness()
    const admitted: Agent[] = []
    ctx.on('agent-controller/admission', async ({ agent: subject }, next) => {
      admitted.push(subject)
      return await next()
    })

    expect(await remote.prompt(prompt('later'))).toEqual({ ok: true, value: { accepted: true } })
    expect(await remote.prompt(prompt('now', 'steer'))).toEqual({ ok: true, value: { accepted: true } })
    expect(admitted).toEqual([agent, agent])
    expect(textsOf(inbox.nextTurn)).toEqual(['later'])
    expect(textsOf(inbox.nextStep)).toEqual(['now'])
  })

  it('keeps the prompt call open while a listener holds it', async () => {
    const { ctx, inbox, remote, prompt } = await harness()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent-controller/admission', async (_admission, next) => {
      await release.promise
      return await next()
    })

    let settled = false
    const pending = remote.prompt(prompt('held')).finally(() => { settled = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(settled).toBe(false)
    expect(inbox.nextTurn).toEqual([])
    release.resolve(undefined)
    expect(await pending).toEqual({ ok: true, value: { accepted: true } })
    expect(textsOf(inbox.nextTurn)).toEqual(['held'])
  })

  it('returns a refusal with its reason and whether its plugin presents it, and keeps the inbox untouched', async () => {
    const { ctx, inbox, remote, prompt } = await harness()
    let presented = true
    ctx.on('agent-controller/admission', () => Promise.resolve({
      kind: 'reject' as const, reason: 'fixture/worktree-missing', message: 'The worktree was removed.', presented,
    }))

    expect(await remote.prompt(prompt('refused'))).toMatchObject({
      ok: false,
      error: {
        code: 'session/prompt-rejected',
        message: 'The worktree was removed.',
        details: { reason: 'fixture/worktree-missing', presented: true },
      },
    })
    presented = false
    expect(await remote.prompt(prompt('refused again'))).toMatchObject({
      ok: false,
      error: { code: 'session/prompt-rejected', details: { reason: 'fixture/worktree-missing', presented: false } },
    })
    expect(inbox.nextTurn).toEqual([])
  })

  it('reports a failed listener as a refusal the client explains', async () => {
    const { ctx, inbox, remote, prompt } = await harness()
    ctx.on('agent-controller/admission', () => Promise.reject(new Error('listener broke')))

    const result = await remote.prompt(prompt('broken'))
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'session/prompt-rejected', details: { reason: 'agent-controller/admission-failed', presented: false } },
    })
    expect(result.ok ? '' : result.error.message).toContain('listener broke')
    expect(inbox.nextTurn).toEqual([])
  })

  it('cancels a held prompt whose client went away', async () => {
    const { ctx, inbox, remote, prompt } = await harness()
    ctx.on('agent-controller/admission', async ({ signal }, next) => {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
      })
      return await next()
    })

    const client = new AbortController()
    const pending = remote.prompt(prompt('abandoned'), client.signal)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    client.abort(new Error('client left'))
    expect(await pending).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    expect(inbox.nextTurn).toEqual([])
  })

  it('reports a Session whose Agent was disposed while its prompt was held as not found', async () => {
    const { ctx, agent, remote, prompt, unregister } = await harness()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent-controller/admission', async (_admission, next) => {
      await release.promise
      return await next()
    })

    const pending = remote.prompt(prompt('orphaned'))
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await unregister()
    release.resolve(undefined)
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'session/not-found', details: { sessionId: agent.id } },
    })
  })

  it('maps a refusal from another copy of the agent-controller module by its code', async () => {
    const { ctx, agent, remote, prompt } = await harness()
    // Another copy of the module raises the same fields from its own class.
    const refusal = (reason: string): Error => Object.assign(new Error('The worktree was removed.'), {
      name: 'AgentAdmissionRejected', code: 'AGENT_ADMISSION_REJECTED', reason, presented: true,
    })
    vi.spyOn(ctx.agentController, 'deliver')
      .mockRejectedValueOnce(refusal('fixture/worktree-missing'))
      .mockRejectedValueOnce(refusal('agent-controller/agent-gone'))

    expect(await remote.prompt(prompt('refused'))).toMatchObject({
      ok: false,
      error: {
        code: 'session/prompt-rejected',
        message: 'The worktree was removed.',
        details: { reason: 'fixture/worktree-missing', presented: true },
      },
    })
    expect(await remote.prompt(prompt('orphaned'))).toMatchObject({
      ok: false,
      error: { code: 'session/not-found', details: { sessionId: agent.id } },
    })
  })

  it('acknowledges a repeated request without admitting it again', async () => {
    const { ctx, inbox, remote, prompt } = await harness()
    let admissions = 0
    ctx.on('agent-controller/admission', async (_admission, next) => {
      admissions += 1
      return await next()
    })

    const first = prompt('once')
    expect(await remote.prompt(first)).toEqual({ ok: true, value: { accepted: true } })
    expect(await remote.prompt(prompt('once', 'queue', first.requestId))).toEqual({ ok: true, value: { accepted: true } })
    expect(admissions).toBe(1)
    expect(textsOf(inbox.nextTurn)).toEqual(['once'])
  })

  it('reports the Agent refusing to queue a prompt as busy', async () => {
    const { remote, prompt } = await harness({ refusal: new Error('inbox closed') })

    expect(await remote.prompt(prompt('rejected'))).toMatchObject({
      ok: false,
      error: { code: 'session/agent-busy', details: { reason: 'Error: inbox closed' } },
    })
  })
})
