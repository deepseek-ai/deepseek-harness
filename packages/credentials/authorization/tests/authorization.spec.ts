import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, {
  AuthorizationDeclinedError,
  type AuthorizationFlow,
  type AuthorizationInteraction,
  type AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import { MemoryCredentials } from './memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const OTHER = credentialKey('llm-pi-ai', 'anthropic')

/** A context with the record store the seam confirms commits against. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  return ctx
}

/** An interaction that answers every prompt with the same string. */
function surface(answer = 'typed'): AuthorizationInteraction & {
  notices: unknown[]
  prompts: unknown[]
} {
  const notices: unknown[] = []
  const prompts: unknown[] = []
  return {
    notices,
    prompts,
    notify: (notice) => { notices.push(notice) },
    prompt: (prompt) => {
      prompts.push(prompt)
      return Promise.resolve(answer)
    },
  }
}

/** A flow that commits `key` through the record store and then resolves. */
function committingFlow(
  ctx: Context,
  key = KEY,
  run?: (session: AuthorizationSession) => Promise<void>,
): AuthorizationFlow {
  return {
    key,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
    async run(session) {
      await run?.(session)
      await ctx.credentials.modifyRecord(key, () =>
        Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
    },
  }
}

describe('AuthorizationService registry', () => {
  it('lists a registered flow and drops it when the registration is disposed', async () => {
    const ctx = await harness()

    const dispose = ctx.authorization.registerFlow(committingFlow(ctx))

    expect(ctx.authorization.list()).toEqual([{
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
      inFlight: false,
    }])
    expect(ctx.authorization.describe(KEY)?.label).toBe('ChatGPT (Codex)')
    expect(ctx.authorization.describe(OTHER)).toBeUndefined()

    dispose()

    expect(ctx.authorization.list()).toEqual([])
    expect(ctx.authorization.describe(KEY)).toBeUndefined()
  })

  it('refuses a second flow for the same key', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    expect(() => ctx.authorization.registerFlow(committingFlow(ctx)))
      .toThrow(/already registered/)
  })

  it('withdraws an attempt still running when its flow leaves', async () => {
    const ctx = await harness()
    let started: (() => void) | undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const dispose = ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        started?.()
        session.signal.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
      })))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await running
    dispose()

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('AuthorizationService.begin', () => {
  it('runs the flow, confirms the committed record, and reports the settlement', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })

    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'granted' } })
    expect(settled).toHaveBeenCalledWith(KEY, 'authorized')
  })

  it('runs the flow first method when the caller names none, and the named one when it does', async () => {
    const ctx = await harness()
    const seen: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      seen.push(session.method)
      return Promise.resolve()
    }))

    await ctx.authorization.begin({ key: KEY, interaction: surface() })
    await ctx.authorization.begin({ key: KEY, method: 'api-key', interaction: surface() })

    expect(seen).toEqual(['oauth', 'api-key'])
  })

  it('carries notices and prompts between the flow and the calling surface', async () => {
    const ctx = await harness()
    const answers: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
      answers.push(await session.prompt({ kind: 'text', message: 'Paste the code' }))
    }))
    const ui = surface('code-123')

    await ctx.authorization.begin({ key: KEY, interaction: ui })

    expect(ui.notices).toEqual([{ message: 'Continue in your browser', url: 'https://auth.example/start' }])
    expect(ui.prompts).toEqual([{ kind: 'text', message: 'Paste the code' }])
    expect(answers).toEqual(['code-123'])
  })

  it('refuses a key no flow claims', async () => {
    const ctx = await harness()

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/no authorization flow is registered/)
  })

  it('refuses a method the flow does not offer', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    await expect(ctx.authorization.begin({ key: KEY, method: 'device', interaction: surface() }))
      .rejects.toThrow(/offers no method "device"/)
  })

  it('refuses a second attempt while one is running, and admits one after it settles', async () => {
    const ctx = await harness()
    // Only the first attempt blocks; the later ones must be free to complete,
    // which is what shows the key was released rather than merely idle-looking.
    const held = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    let first = true
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      if (!first) return Promise.resolve()
      first = false
      started.resolve(undefined)
      return held.promise
    }))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await started.promise
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/already running/)

    held.resolve(undefined)
    await expect(attempt).resolves.toEqual({ status: 'authorized' })
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })
  })

  it('never starts a flow whose caller withdrew before begin', async () => {
    const ctx = await harness()
    const ran = vi.fn()
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      ran()
      return new Promise(() => {})
    }))

    await expect(ctx.authorization.begin({
      key: KEY,
      interaction: surface(),
      signal: AbortSignal.abort(),
    })).resolves.toEqual({ status: 'cancelled' })

    expect(ran).not.toHaveBeenCalled()
    // Nothing occupied the key, so nothing settled on it either.
    expect(settled).not.toHaveBeenCalled()
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('still reports an unknown method to a caller that already withdrew', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    await expect(ctx.authorization.begin({
      key: KEY,
      method: 'device',
      interaction: surface(),
      signal: AbortSignal.abort(),
    })).rejects.toThrow(/offers no method "device"/)
  })

  it('reports a caller that withdraws mid-flight as cancelled', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const reason = new Error('caller withdrew')
    let received: unknown
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { received = session.signal.reason; reject(reason) }, { once: true })
        controller.abort(reason)
      })))

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal }))
      .resolves.toEqual({ status: 'cancelled' })
    expect(received).toBe(reason)
  })

  it('withdraws a running attempt through cancel(), and ignores cancel() for an idle key', async () => {
    const ctx = await harness()
    const started = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        started.resolve(undefined)
      })))
    ctx.authorization.cancel(OTHER)

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await started.promise
    ctx.authorization.cancel(KEY)

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })

  it('settles a withdrawn attempt even when its flow never reacts to the signal', async () => {
    const ctx = await harness()
    const orphan = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      started.resolve(undefined)
      return orphan.promise
    }))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await started.promise
    ctx.authorization.cancel(KEY)

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    // The key is free again immediately, rather than at the mercy of a flow
    // that may never settle.
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    // The orphan's own failure is nobody's to await, and must not surface as an
    // unhandled rejection.
    orphan.reject(new Error('gave up long after the human left'))
    await expect(orphan.promise).rejects.toThrow('gave up long after the human left')
  })

  it('propagates a flow failure to its caller and settles the key as failed', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () =>
      Promise.reject(new Error('the token endpoint said no'))))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow('the token endpoint said no')

    expect(settled).toHaveBeenCalledWith(KEY, 'failed')
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('refuses a flow that resolves without committing its record', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Forgetful',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.resolve(),
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/resolved without committing a credential record/)
  })
})

describe('commit confirmation', () => {
  it('refuses a re-auth that left only the record of an earlier attempt', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(KEY, () =>
      Promise.resolve({ kind: 'grant', payload: { token: 'stale' } }))
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Forgetful',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      // A commit for another key is not this flow's commit either.
      async run() {
        await ctx.credentials.modifyRecord(OTHER, () =>
          Promise.resolve({ kind: 'grant', payload: { token: 'other' } }))
      },
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/without committing a credential record in this attempt/)
    // Refused, not cleaned up: the stale record still belongs to its owner.
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'stale' } })
  })

  it('refuses a flow that deleted its record instead of committing one', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(KEY, () =>
      Promise.resolve({ kind: 'grant', payload: { token: 'stale' } }))
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Destructive',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => ctx.credentials.deleteRecord(KEY),
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/deleted its credential record/)
  })
})

describe('declined prompts', () => {
  it('reports an attempt whose prompt the human declined as cancelled, not failed', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    }))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    const declining: AuthorizationInteraction = {
      notify: () => undefined,
      prompt: () => Promise.reject(new AuthorizationDeclinedError()),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: declining }))
      .resolves.toEqual({ status: 'cancelled' })

    expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
  })

  it('reads a decline through a flow that rewraps the rejection on its way out', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      session.prompt({ kind: 'text', message: 'Paste the code' }).then(
        () => undefined,
        () => {
          throw new Error('sign-in aborted')
        })))
    const declining: AuthorizationInteraction = {
      notify: () => undefined,
      prompt: () => Promise.reject(new AuthorizationDeclinedError()),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: declining }))
      .resolves.toEqual({ status: 'cancelled' })
  })

  it('keeps a prompt failure that is not a decline a flow failure', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    }))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    const broken: AuthorizationInteraction = {
      notify: () => undefined,
      prompt: () => Promise.reject(new Error('the transport dropped')),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: broken }))
      .rejects.toThrow('the transport dropped')

    expect(settled).toHaveBeenCalledWith(KEY, 'failed')
  })
})

describe('notice containment', () => {
  it('loses the notice, never the attempt, when the surface cannot render it', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      session.notify({ message: 'Continue in your browser' })
      return Promise.resolve()
    }))
    const broken: AuthorizationInteraction = {
      notify: () => {
        throw new Error('page connection closed')
      },
      prompt: () => Promise.resolve('unused'),
    }

    await expect(ctx.authorization.begin({ key: KEY, interaction: broken }))
      .resolves.toEqual({ status: 'authorized' })
  })
})

describe('the settled fan-out', () => {
  it('keeps a throwing listener from changing a finished attempt, and later listeners still run', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    ctx.on('authorization/settled', () => {
      throw new Error('watcher boom')
    })
    const second = vi.fn()
    ctx.on('authorization/settled', second)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })

    expect(second).toHaveBeenCalledWith(KEY, 'authorized')
  })

  it('contains an async listener rejection', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    // An unknown-returning function keeps the typed surface legal while the
    // runtime value is still the rejected promise the containment must handle.
    const boom = (): unknown => Promise.reject(new Error('async watcher boom'))
    ctx.on('authorization/settled', boom)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('rethrows an invariant-coded listener failure after the remaining listeners', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    ctx.on('authorization/settled', () => {
      throw Object.assign(new Error('forged relation'), { code: 'INVARIANT' })
    })
    const second = vi.fn()
    ctx.on('authorization/settled', second)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/forged relation/)
    // Harness-fatal by design — but the record itself committed first.
    expect(second).toHaveBeenCalledWith(KEY, 'authorized')
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'granted' } })
  })
})

it('rejects a commit attempted after local cancellation', async () => {
  const ctx = await harness()
  const ready = Promise.withResolvers<AuthorizationSession>()
  const finish = Promise.withResolvers<undefined>()
  ctx.authorization.registerFlow({
    key: KEY, label: 'Account', methods: [{ id: 'browser', label: 'Browser' }],
    run: (session) => { ready.resolve(session); return finish.promise },
  })
  const running = ctx.authorization.begin({ key: KEY, interaction: surface() })
  const session = await ready.promise
  ctx.authorization.cancel(KEY)
  try {
    await expect(running).resolves.toEqual({ status: 'cancelled' })
    await expect(session.commit({ kind: 'grant', payload: { token: 'late' } })).rejects.toThrow()
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  } finally { finish.resolve(undefined) }
})

it.each(['local', 'caller'] as const)('finishes an admitted commit during %s cancellation', async (source) => {
  const ctx = await harness()
  const admitted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
  const write = vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
    admitted.resolve(undefined)
    await release.promise
    return modify(key, mutate)
  })
  ctx.authorization.registerFlow({
    key: KEY, label: 'Account', methods: [{ id: 'browser', label: 'Browser' }],
    run: session => session.commit({ kind: 'grant', payload: { token: 'saved' } }),
  })
  const controller = new AbortController()
  const running = ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal })
  try {
    await admitted.promise
    if (source === 'local') ctx.authorization.cancel(KEY)
    else controller.abort()
    release.resolve(undefined)
    await expect(running).resolves.toEqual({ status: 'authorized' })
    expect(await ctx.credentials.readRecord(KEY)).toMatchObject({ payload: { token: 'saved' } })
  } finally { release.resolve(undefined); write.mockRestore() }
})

it('rejects a settled session commit before and during the next attempt', async () => {
  const ctx = await harness()
  const first = Promise.withResolvers<AuthorizationSession>()
  const second = Promise.withResolvers<AuthorizationSession>()
  const release = Promise.withResolvers<undefined>()
  let attempts = 0
  ctx.authorization.registerFlow({
    key: KEY, label: 'Account', methods: [{ id: 'browser', label: 'Browser' }],
    async run(session) {
      attempts += 1
      if (attempts === 1) first.resolve(session)
      else {
        second.resolve(session)
        await release.promise
      }
      await session.commit({ kind: 'grant', payload: { token: `grant-${String(attempts)}` } })
    },
  })
  await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
    .resolves.toEqual({ status: 'authorized' })
  const settled = await first.promise
  const late = { kind: 'grant' as const, payload: { token: 'late' } }
  await expect(settled.commit(late)).rejects.toMatchObject({ code: 'CANCELLED' })

  const running = ctx.authorization.begin({ key: KEY, interaction: surface() })
  try {
    await second.promise
    await expect(settled.commit(late)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await ctx.credentials.readRecord(KEY)).toMatchObject({ payload: { token: 'grant-1' } })
  } finally {
    release.resolve(undefined)
    await running
  }
  expect(await ctx.credentials.readRecord(KEY)).toMatchObject({ payload: { token: 'grant-2' } })
})
