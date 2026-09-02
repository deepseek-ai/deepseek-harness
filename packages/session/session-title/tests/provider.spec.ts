import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SessionTitleService, {
  SessionTitleProviderId,
  type SessionTitleProvider,
  type SessionTitleProviderRequest,
  type SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 24,
  maxTitleBytes: 24,
} as const

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function appendHumanPrompt(session: ReturnType<Context['sessions']['create']>, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendRoute(session: ReturnType<Context['sessions']['create']>, reason: 'initial' | 'change' = 'initial'): void {
  session.append('request/header', {
    header: { config: { provider: 'main-route', model: 'chat-model' } },
    reason,
  })
}

describe('SessionTitleService Provider lifecycle', () => {
  it('inherits title events across forks, skips first-prompt retitling, and lets all-messages update later', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, CONFIG)
    const parent = ctx.sessions.create(SessionId('title-parent'))
    parent.append('turn/start', {
      turn: 1,
    })
    const inheritedMessage = appendHumanPrompt(parent, 'Inherited title prompt')
    await settle()
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const child = ctx.sessions.fork(parent, undefined, SessionId('title-child'))
    expect(ctx.sessionTitle.get(child)).toEqual(ctx.sessionTitle.get(parent))
    expect(child.snapshotEvents().find(event => event.type === 'session/title'))
      .toEqual(parent.snapshotEvents().find(event => event.type === 'session/title'))

    const firstGenerate = vi.fn(async (request: SessionTitleProviderRequest) => ({
      title: 'Should not run',
      messageSeqs: [request.messages[0]!.seq],
    }))
    const disposeFirst = ctx.sessionTitle.register({
      id: SessionTitleProviderId('fork-first'),
      automatic: 'first-prompt',
      generate: firstGenerate,
    })
    child.append('turn/start', {
      turn: 2,
    })
    const childMessage = appendHumanPrompt(child, 'Child follow-up prompt')
    await settle()
    appendRoute(child)
    await settle()
    child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(firstGenerate).not.toHaveBeenCalled()
    await disposeFirst()

    const allGenerate = vi.fn(async (request: SessionTitleProviderRequest) => ({
      title: 'Fork all prompts',
      messageSeqs: request.messages.map(message => message.seq),
    }))
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('fork-all'),
      automatic: 'all-prompts',
      generate: allGenerate,
    })
    child.append('turn/start', {
      turn: 3,
    })
    const latestMessage = appendHumanPrompt(child, 'Retitle the fork now')
    await settle()
    appendRoute(child, 'change')
    await settle()
    child.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    expect(allGenerate).toHaveBeenCalledOnce()
    expect(ctx.sessionTitle.get(child)).toMatchObject({
      title: 'Fork all prompts',
      messageSeqs: [inheritedMessage.seq, childMessage.seq, latestMessage.seq],
      source: { kind: 'provider', provider: SessionTitleProviderId('fork-all') },
    })
    expect(ctx.sessionTitle.get(parent)?.title).toBe('Inherited title prompt')
  })

  it('runs a first-prompt provider once after the routed request and retries only through refresh', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, CONFIG)
    const requests: SessionTitleProviderRequest[] = []
    const provider: SessionTitleProvider = {
      id: SessionTitleProviderId('first-model'),
      automatic: 'first-prompt',
      async generate(request) {
        requests.push(request)
        return {
          title: '\u001B[31m  A   model-generated title that is too long  ',
          messageSeqs: [request.messages[0]!.seq],
          model: { provider: 'aux-route', model: 'title-model' },
        }
      },
    }
    ctx.sessionTitle.register(provider)
    const session = ctx.sessions.create(SessionId('first-provider'))
    session.append('turn/start', {
      turn: 1,
    })
    const first = appendHumanPrompt(session, 'Explain asynchronous title generation')
    await settle()
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')

    appendRoute(session)
    await settle()

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      session,
      messages: [{ seq: first.seq, text: 'Explain asynchronous title generation' }],
      route: { provider: 'main-route', model: 'chat-model' },
    })
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'A model-generated title',
      messageSeqs: [first.seq],
      source: {
        kind: 'provider',
        provider: SessionTitleProviderId('first-model'),
        model: { provider: 'aux-route', model: 'title-model' },
      },
    })

    const second = appendHumanPrompt(session, 'A later prompt')
    appendRoute(session, 'change')
    await settle()
    expect(requests).toHaveLength(1)

    await ctx.sessionTitle.refresh(session)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.map(message => message.seq)).toEqual([first.seq, second.seq])
  })

  it('preserves provider input order across bounded title-input chunks', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, CONFIG)
    const session = ctx.sessions.create(SessionId('chunked-provider-input'))
    session.append('turn/start', { turn: 1 })
    const messages = Array.from({ length: 70 }, (_, index) =>
      appendHumanPrompt(session, `Prompt ${String(index)}`))
    await settle()
    const generate = vi.fn(async (request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult> => ({
      title: 'Chunked history',
      messageSeqs: request.messages.map(message => message.seq),
    }))
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('chunked-provider'),
      automatic: 'all-prompts',
      generate,
    })

    await ctx.sessionTitle.refresh(session)

    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]?.[0].messages).toEqual(messages.map((message, index) => ({
      seq: message.seq,
      text: `Prompt ${String(index)}`,
    })))
  })

  it('cuts a first-message provider request at its scheduled watermark when a newer prompt lands first', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, CONFIG)
    const requests: SessionTitleProviderRequest[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('watermark-cut'),
      automatic: 'first-prompt',
      async generate(request) {
        requests.push(request)
        return {
          title: 'Watermarked title',
          messageSeqs: request.messages.map(message => message.seq),
        }
      },
    })
    const session = ctx.sessions.create(SessionId('watermark-cut'))
    session.append('turn/start', {
      turn: 1,
    })
    const first = appendHumanPrompt(session, 'First prompt')
    await settle()
    appendHumanPrompt(session, 'A newer prompt before the route')
    appendRoute(session)
    await settle()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toEqual([{ seq: first.seq, text: 'First prompt' }])
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Watermarked title',
      messageSeqs: [first.seq],
      source: { kind: 'provider', provider: SessionTitleProviderId('watermark-cut') },
    })
  })

  it('rejects a second provider and drains stale work when the winner is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, CONFIG)
    const pending = deferred<SessionTitleProviderResult>()
    let observedSignal: AbortSignal | undefined
    const first: SessionTitleProvider = {
      id: SessionTitleProviderId('winner'),
      automatic: 'all-prompts',
      generate(request) {
        observedSignal = request.signal
        return pending.promise
      },
    }
    const dispose = ctx.sessionTitle.register(first)
    expect(() => ctx.sessionTitle.register({
      id: SessionTitleProviderId('duplicate'),
      automatic: 'first-prompt',
      generate: async () => ({ title: 'duplicate', messageSeqs: [SessionSeq(0)] }),
    })).toThrow(/already registered/)

    const session = ctx.sessions.create(SessionId('dispose-provider'))
    session.append('turn/start', {
      turn: 1,
    })
    const message = appendHumanPrompt(session, 'Generate this title')
    await settle()
    appendRoute(session)
    await settle()
    expect(observedSignal?.aborted).toBe(false)

    const disposal = dispose()
    expect(observedSignal?.aborted).toBe(true)
    let disposed = false
    void disposal.then(() => { disposed = true })
    await settle()
    expect(disposed).toBe(false)
    pending.resolve({ title: 'stale provider result', messageSeqs: [message.seq] })
    await disposal
    expect(disposed).toBe(true)
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')

    const replacement: SessionTitleProvider = {
      id: SessionTitleProviderId('replacement'),
      automatic: 'first-prompt',
      generate: async () => ({ title: 'replacement', messageSeqs: [message.seq] }),
    }
    const disposeReplacement = ctx.sessionTitle.register(replacement)
    await disposeReplacement()
  })

  it('supersedes an older all-messages revision and cannot commit an ignored abort', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, CONFIG)
    const firstResult = deferred<SessionTitleProviderResult>()
    const requests: SessionTitleProviderRequest[] = []
    const provider: SessionTitleProvider = {
      id: SessionTitleProviderId('all-model'),
      automatic: 'all-prompts',
      generate(request) {
        requests.push(request)
        if (requests.length === 1) return firstResult.promise
        return Promise.resolve({
          title: 'Newest complete title',
          messageSeqs: request.messages.map(message => message.seq),
        })
      },
    }
    ctx.sessionTitle.register(provider)
    const session = ctx.sessions.create(SessionId('supersede'))
    session.append('turn/start', {
      turn: 1,
    })
    const first = appendHumanPrompt(session, 'First prompt')
    await settle()
    appendRoute(session)
    await settle()

    const second = appendHumanPrompt(session, 'Second prompt')
    expect(requests[0]?.signal.aborted).toBe(true)
    appendRoute(session, 'change')
    await settle()
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Newest complete title',
      messageSeqs: [first.seq, second.seq],
    })

    firstResult.resolve({ title: 'Old ignored result', messageSeqs: [first.seq] })
    await settle()
    expect(ctx.sessionTitle.get(session)?.title).toBe('Newest complete title')
  })

  it('runs an all-messages revision when the next main request reuses its logged header', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    await ctx.plugin(SessionTitleService, CONFIG)
    const requests: SessionTitleProviderRequest[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('unchanged-route'),
      automatic: 'all-prompts',
      async generate(request) {
        requests.push(request)
        return {
          title: `Revision ${requests.length}`,
          messageSeqs: request.messages.map(message => message.seq),
        }
      },
    })
    const session = ctx.sessions.create(SessionId('unchanged-route'))
    session.append('turn/start', {
      turn: 1,
    })
    const first = appendHumanPrompt(session, 'First routed prompt')
    await settle()
    session.append('step/start', { turn: 1, step: 1 })
    appendRoute(session)
    await settle()
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    session.append('turn/start', {
      turn: 2,
    })
    const second = appendHumanPrompt(session, 'Second prompt on the same route')
    await settle()
    session.append('step/start', { turn: 2, step: 1 })
    void ctx.llm.stream(markAgentLoopRequest(deepFreeze({
      provider: 'main-route',
      model: 'chat-model',
      messages: session.deriveMessages(),
      sessionId: session.id,
    })))
    await settle()

    expect(session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      messages: [
        { seq: first.seq, text: 'First routed prompt' },
        { seq: second.seq, text: 'Second prompt on the same route' },
      ],
      route: { provider: 'main-route', model: 'chat-model' },
    })
  })

  it('ignores model streams that are not a matching loop request', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    await ctx.plugin(SessionTitleService, CONFIG)
    const generate = vi.fn(async (request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult> => ({
      title: 'Unexpected title',
      messageSeqs: request.messages.map(message => message.seq),
    }))
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('request-filter'),
      automatic: 'all-prompts',
      generate,
    })
    const options = { provider: 'main-route', model: 'chat-model', messages: [] }

    void ctx.llm.stream(deepFreeze(options))
    void ctx.llm.stream(markAgentLoopRequest(deepFreeze({ ...options, sessionId: SessionId('missing') })))
    const quiet = ctx.sessions.create(SessionId('quiet'))
    void ctx.llm.stream(markAgentLoopRequest(deepFreeze({ ...options, sessionId: quiet.id })))
    const pending = ctx.sessions.create(SessionId('unmatched-boundary'))
    pending.append('turn/start', {
      turn: 1,
    })
    appendHumanPrompt(pending, 'Wait for a matching request boundary')
    await settle()
    void ctx.llm.stream(markAgentLoopRequest(deepFreeze({ ...options, sessionId: pending.id })))
    await settle()

    expect(generate).not.toHaveBeenCalled()
  })

  it('contains automatic failures but lets explicit refresh reject', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, CONFIG)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const provider: SessionTitleProvider = {
      id: SessionTitleProviderId('failing'),
      automatic: 'all-prompts',
      generate: async () => { throw new Error('title backend failed') },
    }
    ctx.sessionTitle.register(provider)
    const session = ctx.sessions.create(SessionId('failure'))
    session.append('turn/start', {
      turn: 1,
    })
    appendHumanPrompt(session, 'Keep a fallback')
    await settle()
    appendRoute(session)
    await settle()

    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('automatic title generation failed'))
    await expect(ctx.sessionTitle.refresh(session)).rejects.toThrow('title backend failed')
    warn.mockRestore()
  })
})
