import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, {
  SessionTitleProviderId,
  type Config,
  type SessionTitleProvider,
  type SessionTitleProviderRequest,
  type SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function setup(config: Config = CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTitleService, config)
  return ctx
}

function startSession(ctx: Context, id: string): ReturnType<Context['sessions']['create']> {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', {
    turn: 1,
  })
  return session
}

function appendPrompt(session: ReturnType<Context['sessions']['create']>, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('SessionTitleService configuration and refresh boundaries', () => {
  it('requires explicit positive limits with a fallback cap no larger than the accepted-title cap', () => {
    expect(() => new SessionTitleService(new Context(), undefined as never))
      .toThrow('configuration is required')
    expect(() => new SessionTitleService(new Context(), null as never))
      .toThrow('configuration is required')
    expect(() => new SessionTitleService(new Context(), { ...CONFIG, fallbackMaxWords: 0 }))
      .toThrow(/fallbackMaxWords must be a positive integer/)
    expect(() => new SessionTitleService(new Context(), { ...CONFIG, fallbackMaxWords: 1.5 }))
      .toThrow(/fallbackMaxWords must be a positive integer/)
    expect(() => new SessionTitleService(new Context(), { ...CONFIG, fallbackMaxBytes: 81 }))
      .toThrow(/fallbackMaxBytes must not exceed maxTitleBytes/)
  })

  it('returns no title for empty input with or without a provider, and rejects detached or pre-aborted refreshes', async () => {
    const fallbackOnly = await setup()
    const empty = fallbackOnly.sessions.create(SessionId('empty-fallback'))
    await expect(fallbackOnly.sessionTitle.refresh(empty)).resolves.toBeUndefined()

    const withProvider = await setup()
    const generate = vi.fn(async (): Promise<SessionTitleProviderResult> => ({
      title: 'unused',
      messageSeqs: [0],
    }))
    withProvider.sessionTitle.register({
      id: SessionTitleProviderId('empty-provider'),
      automatic: 'first-prompt',
      generate,
    })
    const providerEmpty = withProvider.sessions.create(SessionId('empty-provider'))
    await expect(withProvider.sessionTitle.refresh(providerEmpty)).resolves.toBeUndefined()
    expect(generate).not.toHaveBeenCalled()

    await expect(withProvider.sessionTitle.refresh(Session.create(SessionId('detached'))))
      .rejects.toThrow(/not live in this store/)
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(withProvider.sessionTitle.refresh(providerEmpty, controller.signal))
      .rejects.toThrow('already cancelled')
  })

  it('passes an absent route and caller cancellation into explicit generation', async () => {
    const ctx = await setup()
    let observed: SessionTitleProviderRequest | undefined
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('explicit-no-route'),
      automatic: 'first-prompt',
      async generate(request) {
        observed = request
        return { title: 'Explicit title', messageSeqs: [request.messages[0]!.seq] }
      },
    })
    const session = startSession(ctx, 'explicit-no-route')
    appendPrompt(session, 'Refresh before any request header')
    await settle()
    const controller = new AbortController()

    await expect(ctx.sessionTitle.refresh(session, controller.signal))
      .resolves.toMatchObject({ title: 'Explicit title' })
    expect(observed?.route).toBeUndefined()
    expect(observed?.signal.aborted).toBe(false)
  })

  it('propagates explicit cancellation and session disposal to active work', async () => {
    const callerCtx = await setup()
    const callerPending = deferred<SessionTitleProviderResult>()
    let callerSignal: AbortSignal | undefined
    callerCtx.sessionTitle.register({
      id: SessionTitleProviderId('caller-cancel'),
      automatic: 'first-prompt',
      generate(request) {
        callerSignal = request.signal
        return callerPending.promise
      },
    })
    const callerSession = startSession(callerCtx, 'caller-cancel')
    const callerMessage = appendPrompt(callerSession, 'Cancel this refresh')
    await settle()
    const controller = new AbortController()
    const refresh = callerCtx.sessionTitle.refresh(callerSession, controller.signal)
    await settle()
    controller.abort(new Error('caller cancelled'))
    callerPending.resolve({ title: 'ignored', messageSeqs: [callerMessage.seq] })
    await expect(refresh).rejects.toThrow('caller cancelled')
    expect(callerSignal?.aborted).toBe(true)

    const disposeCtx = await setup()
    const disposePending = deferred<SessionTitleProviderResult>()
    let disposeSignal: AbortSignal | undefined
    disposeCtx.sessionTitle.register({
      id: SessionTitleProviderId('session-dispose'),
      automatic: 'first-prompt',
      generate(request) {
        disposeSignal = request.signal
        return disposePending.promise
      },
    })
    const disposed = disposeCtx.sessions.prepare(SessionId('session-dispose'))
    const detach = disposeCtx.sessions.enter(disposed)
    disposeCtx.sessions.announce(disposed)
    disposed.append('turn/start', {
      turn: 1,
    })
    const disposedMessage = appendPrompt(disposed, 'Dispose this session')
    await settle()
    const disposedRefresh = disposeCtx.sessionTitle.refresh(disposed)
    await settle()
    detach()
    disposePending.resolve({ title: 'ignored', messageSeqs: [disposedMessage.seq] })
    await expect(disposedRefresh).rejects.toThrow(/session disposed/)
    expect(disposeSignal?.aborted).toBe(true)
  })

  it('shares one fallback across concurrent refreshes', async () => {
    const ctx = await setup()
    const seed = Session.create(SessionId('fallback-concurrency-seed'))
    seed.append('turn/start', {
      turn: 1,
    })
    const source = appendPrompt(seed, 'Create exactly one fallback title')
    seed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const session = ctx.sessions.create(SessionId('fallback-concurrency'), { seed: seed.snapshotEvents() })

    const results = await Promise.all([
      ctx.sessionTitle.refresh(session),
      ctx.sessionTitle.refresh(session),
    ])

    expect(results[0]).toEqual(results[1])
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'turn/end',
      // The seeded constructor's end-seed marker.
      'session/end-seed',
      'session/title',
    ])
    expect(ctx.sessionTitle.get(session)?.messageSeqs).toEqual([source.seq])
  })

  it('reuses a title accepted before the queued fallback commits', async () => {
    const ctx = await setup()
    const session = startSession(ctx, 'fallback-already-accepted')
    const source = appendPrompt(session, 'Reuse the title that wins the fallback race')

    const refresh = ctx.sessionTitle.refresh(session)
    session.append('session/title', {
      title: 'Already accepted',
      messageSeqs: [source.seq],
      source: { kind: 'fallback' },
    })

    await expect(refresh).resolves.toMatchObject({ title: 'Already accepted' })
    expect(session.snapshotEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
  })

  it('lets the newest overlapping explicit refresh win', async () => {
    const ctx = await setup()
    const session = startSession(ctx, 'refresh-order')
    const source = appendPrompt(session, 'Keep the newest explicit refresh')
    await settle()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const requests: SessionTitleProviderRequest[] = []
    const results: Array<ReturnType<typeof deferred<SessionTitleProviderResult>>> = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('refresh-order'),
      automatic: 'first-prompt',
      generate(request) {
        requests.push(request)
        const result = deferred<SessionTitleProviderResult>()
        results.push(result)
        return result.promise
      },
    })

    const older = ctx.sessionTitle.refresh(session)
    await settle()
    const newer = ctx.sessionTitle.refresh(session)
    await settle()

    expect(requests).toHaveLength(2)
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(requests[1]?.signal.aborted).toBe(false)
    results[0]?.resolve({ title: 'Obsolete title', messageSeqs: [source.seq] })
    await expect(older).rejects.toThrow(/superseded/)
    results[1]?.resolve({ title: 'Newest explicit title', messageSeqs: [source.seq] })
    await expect(newer).resolves.toMatchObject({ title: 'Newest explicit title' })
  })

  it('cancels a queued fallback when the session-title service unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const lifecycle: { fiber?: Fiber; session?: Session; inactiveRefresh?: Promise<unknown> } = {}
    ctx.on('internal/plugin', (subject) => {
      if (subject !== lifecycle.fiber || subject.uid !== null || lifecycle.session === undefined) return
      appendPrompt(lifecycle.session, 'Ignore reentrant disposal prompt')
      lifecycle.session.append('request/header', {
        header: { config: { provider: 'main', model: 'main' } },
        reason: 'initial',
      })
      lifecycle.inactiveRefresh = ctx.sessionTitle.refresh(lifecycle.session).then(
        () => undefined,
        (error: unknown) => error,
      )
    })
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    lifecycle.fiber = fiber
    const session = startSession(ctx, 'service-dispose-fallback')
    lifecycle.session = session
    appendPrompt(session, 'Do not publish after service disposal')

    await fiber.dispose()
    await settle()

    expect(session.snapshotEvents().some(event => event.type === 'session/title')).toBe(false)
    const inactiveError = await lifecycle.inactiveRefresh
    expect(inactiveError).toBeInstanceOf(Error)
    if (!(inactiveError instanceof Error)) throw new Error('expected inactive refresh to reject')
    expect(inactiveError.message).toBe('session-title service disposed')
  })

  it('suppresses a queued fallback failure after service unload begins', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = startSession(ctx, 'service-unload-started-fallback')
    appendPrompt(session, 'Start fallback before unloading the service')

    await Promise.resolve()
    await fiber.dispose()

    expect(session.snapshotEvents().some(event => event.type === 'session/title')).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('aborts pending and active provider work and drains ignored cancellation during service unload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    const result = deferred<SessionTitleProviderResult>()
    const requests: SessionTitleProviderRequest[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('service-unload'),
      automatic: 'all-prompts',
      generate(request) {
        requests.push(request)
        return result.promise
      },
    })
    const active = startSession(ctx, 'service-unload-active')
    const activeMessage = appendPrompt(active, 'Active provider work')
    await settle()
    const refresh = ctx.sessionTitle.refresh(active)
    const refreshOutcome = refresh.then(
      () => undefined,
      (error: unknown) => error,
    )
    await settle()
    expect(requests).toHaveLength(1)
    const pending = startSession(ctx, 'service-unload-pending')
    appendPrompt(pending, 'Pending provider work')

    const disposal = fiber.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await settle()
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    result.resolve({ title: 'Ignored service abort', messageSeqs: [activeMessage.seq] })
    await disposal

    expect(disposed).toBe(true)
    await expect(refreshOutcome).resolves.toEqual(expect.objectContaining({ message: 'session-title service disposed' }))
  })

  it('warns when a detached session prevents queued fallback publication', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.prepare(SessionId('fallback-detach'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    ctx.on('session/event', (subject, event) => {
      if (subject === session && event.type === 'user/message') detach()
    })
    session.append('turn/start', {
      turn: 1,
    })
    appendPrompt(session, 'Detach before the fallback microtask')
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fallback title update failed'))
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
  })

  it('leaves a title absent when the byte cap cannot hold the first code point', async () => {
    const ctx = await setup({ fallbackMaxWords: 5, fallbackMaxBytes: 1, maxTitleBytes: 2 })
    const session = startSession(ctx, 'no-code-point')
    appendPrompt(session, '😀')
    await settle()
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    await expect(ctx.sessionTitle.refresh(session)).resolves.toBeUndefined()
  })
})

describe('SessionTitleService Provider validation and stale scheduling', () => {
  it('rejects malformed provider registrations before publishing them', async () => {
    const ctx = await setup()
    const generate = async (): Promise<SessionTitleProviderResult> => ({ title: 'title', messageSeqs: [0] })
    expect(() => ctx.sessionTitle.register(null as never)).toThrow(/must be an object/)
    expect(() => ctx.sessionTitle.register('provider' as never)).toThrow(/must be an object/)
    expect(() => ctx.sessionTitle.register({
      id: 1,
      automatic: 'first-prompt',
      generate,
    } as unknown as SessionTitleProvider)).toThrow(/id must be a non-empty string/)
    expect(() => ctx.sessionTitle.register({
      id: SessionTitleProviderId(''),
      automatic: 'first-prompt',
      generate,
    })).toThrow(/id must be a non-empty string/)
    expect(() => ctx.sessionTitle.register({
      id: SessionTitleProviderId('bad-mode'),
      automatic: 'sometimes' as never,
      generate,
    })).toThrow(/automatic mode is invalid/)
    expect(() => ctx.sessionTitle.register({
      id: SessionTitleProviderId('missing-generate'),
      automatic: 'first-prompt',
      generate: undefined,
    } as unknown as SessionTitleProvider)).toThrow(/requires generate/)
  })

  it('drops automatic work when its provider is disposed before the queued start', async () => {
    const ctx = await setup()
    const generate = vi.fn(async (request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult> => ({
      title: 'too late',
      messageSeqs: [request.messages[0]!.seq],
    }))
    const dispose = ctx.sessionTitle.register({
      id: SessionTitleProviderId('queued-dispose'),
      automatic: 'all-prompts',
      generate,
    })
    const session = startSession(ctx, 'queued-dispose')
    appendPrompt(session, 'Queue provider work')
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main' } },
      reason: 'initial',
    })
    const pending = startSession(ctx, 'pending-provider-dispose')
    appendPrompt(pending, 'Drop pending provider work')
    await dispose()
    await settle()
    expect(generate).not.toHaveBeenCalled()
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
    expect(ctx.sessionTitle.get(pending)?.source.kind).toBe('fallback')
  })

  it('rejects malformed provider results without replacing the fallback', async () => {
    const ctx = await setup()
    let result: unknown
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('invalid-results'),
      automatic: 'first-prompt',
      generate: async () => result as SessionTitleProviderResult,
    })
    const session = startSession(ctx, 'invalid-results')
    const first = appendPrompt(session, 'First source')
    await settle()
    const second = appendPrompt(session, 'Second source')
    await settle()

    const cases: Array<{ value: unknown; error: RegExp }> = [
      { value: null, error: /invalid result/ },
      { value: 1, error: /invalid result/ },
      { value: { title: 1, messageSeqs: [first.seq] }, error: /title must be a string/ },
      { value: { title: '\u001B[31m', messageSeqs: [first.seq] }, error: /empty title/ },
      { value: { title: 'valid', messageSeqs: undefined }, error: /at least one source message/ },
      { value: { title: 'valid', messageSeqs: [] }, error: /at least one source message/ },
      { value: { title: 'valid', messageSeqs: ['not-a-seq'] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [1.5] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [-1] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [999] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [first.seq, first.seq] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [second.seq, first.seq] }, error: /unique, ordered seqs/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: null }, error: /provider result model/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: 'route' }, error: /provider result model/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: 1, model: 'm' } }, error: /provider result model/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: '', model: 'm' } }, error: /provider result model/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: 'p', model: 1 } }, error: /provider result model/ },
      { value: { title: 'valid', messageSeqs: [first.seq], model: { provider: 'p', model: '' } }, error: /provider result model/ },
    ]
    for (const item of cases) {
      result = item.value
      await expect(ctx.sessionTitle.refresh(session)).rejects.toThrow(item.error)
      expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
    }
  })
})
