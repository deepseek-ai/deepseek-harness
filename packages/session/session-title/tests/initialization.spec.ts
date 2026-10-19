/** Live title input remains owned while projection registration is pending. */
import { Context, FiberState } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, { SessionTitleProviderId, type SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const CONFIG = { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 }

async function setup(key: 'title' | 'titleInput') {
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
  const spy = vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
    const handle = await register(definition)
    if (definition.key === key) {
      entered.resolve(undefined)
      await release.promise
    }
    return handle
  })
  onTestFinished(() => { spy.mockRestore() })
  return { ctx, entered: entered.promise, release }
}

function message(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function titleWritten(ctx: Context, session: Session, kind: 'fallback' | 'provider') {
  const written = Promise.withResolvers<undefined>()
  ctx.on('session/event', (target, event) => {
    if (target === session && event.type === 'session/title' && event.data.source.kind === kind) written.resolve(undefined)
  })
  return written.promise
}

describe('SessionTitleService activation', () => {
  it.each(['title', 'titleInput'] as const)('retains the first message while %s registration is pending', async (key) => {
    const { ctx, entered, release } = await setup(key)
    const fiber = ctx.plugin(SessionTitleService, CONFIG)
    await entered
    expect(ctx.get('sessionTitle')).toBeUndefined()
    const session = ctx.sessions.create()
    const written = titleWritten(ctx, session, 'fallback')
    const first = message(session, 'First message during activation')
    message(session, 'Second message during activation')

    release.resolve(undefined)
    await fiber
    await written

    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'First message during activation', messageSeqs: [first.seq], source: { kind: 'fallback' },
    })
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })

  it('uses the fallback for input received before a provider registers', async () => {
    const { ctx, entered, release } = await setup('titleInput')
    const requests: SessionTitleProviderRequest[] = []
    const provider = ctx.inject(['sessionTitle'], (owner) => {
      owner.sessionTitle.register({
        id: SessionTitleProviderId('activation'), automatic: 'all-prompts',
        async generate(request) {
          requests.push(request)
          return { title: 'Generated after activation', messageSeqs: request.messages.map(item => item.seq) }
        },
      })
    })
    const fiber = ctx.plugin(SessionTitleService, CONFIG)
    await entered
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const fallbackWritten = titleWritten(ctx, session, 'fallback')
    const first = message(session, 'Prompt before provider registration')
    const route = { provider: 'main-provider', model: 'main-model' }
    session.append('request/header', { header: { config: route }, reason: 'initial' })
    void ctx.llm.stream(markAgentLoopRequest(deepFreeze({ ...route, sessionId: session.id, messages: session.deriveMessages() })))

    release.resolve(undefined)
    await fiber
    await provider
    await fallbackWritten

    expect(requests).toEqual([])
    expect(ctx.sessionTitle.get(session)).toMatchObject({ messageSeqs: [first.seq], source: { kind: 'fallback' } })

    const providerWritten = titleWritten(ctx, session, 'provider')
    const later = message(session, 'Prompt after provider registration')
    void ctx.llm.stream(markAgentLoopRequest(deepFreeze({ ...route, sessionId: session.id, messages: session.deriveMessages() })))
    await providerWritten

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ route, messages: [
      { seq: first.seq, text: 'Prompt before provider registration' },
      { seq: later.seq, text: 'Prompt after provider registration' },
    ] })
  })

  it('does not title a Session disposed before activation', async () => {
    const { ctx, entered, release } = await setup('title')
    const fiber = ctx.plugin(SessionTitleService, CONFIG)
    await entered
    const removed = ctx.sessions.prepare()
    const detach = ctx.sessions.enter(removed)
    ctx.sessions.announce(removed)
    message(removed, 'Removed during activation')
    detach()
    const live = ctx.sessions.create()
    const written = titleWritten(ctx, live, 'fallback')
    message(live, 'Still live')

    release.resolve(undefined)
    await fiber
    await written

    expect(ctx.sessionTitle.get(removed)).toBeUndefined()
    expect(ctx.sessionTitle.get(live)?.title).toBe('Still live')
  })

  it.each(['dispose', 'reject'] as const)('does not write a title after activation %s', async (ending) => {
    const { ctx, entered, release } = await setup('titleInput')
    const fiber = ctx.plugin(SessionTitleService, CONFIG)
    await entered
    const session = ctx.sessions.create()
    message(session, 'Never commit this title')
    if (ending === 'dispose') {
      const disposal = fiber.dispose()
      release.resolve(undefined)
      await disposal
    } else {
      const failed = expect(Promise.resolve(fiber)).rejects.toThrow('registration failed')
      release.reject(new Error('registration failed'))
      await failed
    }

    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toEqual([])
    expect(ctx.get('sessionTitle')).toBeUndefined()
  })

  it('reports one deferred fallback failure and still titles another Session', async () => {
    const { ctx, entered, release } = await setup('titleInput')
    const warn = vi.spyOn(ctx.logger, 'warn')
    onTestFinished(() => { warn.mockRestore() })
    ctx.on('internal/status', (fiber) => {
      if (fiber.runtime?.callback !== SessionTitleService || fiber.state !== FiberState.ACTIVE) return
      const get = vi.spyOn(ctx.sessionTitle, 'get').mockImplementationOnce(() => { throw new Error('title read failed') })
      onTestFinished(() => { get.mockRestore() })
    })
    const fiber = ctx.plugin(SessionTitleService, CONFIG)
    await entered
    message(ctx.sessions.create(), 'Failed title read')
    const live = ctx.sessions.create()
    const written = titleWritten(ctx, live, 'fallback')
    message(live, 'Unaffected title')
    release.resolve(undefined)
    await fiber
    await written

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session/event listener rejected: Error: title read failed'))
    expect(ctx.sessionTitle.get(live)?.title).toBe('Unaffected title')
  })
})
