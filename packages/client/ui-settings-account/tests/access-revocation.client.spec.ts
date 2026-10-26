// @vitest-environment jsdom
/** Account surfaces follow `account/watch` access: a revocation withdraws them and a later grant restores them. */
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { apply, type AccountSectionInjected } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllEnvs() })

type AccessEffect = (() => void) | Iterable<() => void>

/** One `whenAccess` controller: its callback and the disposers of its current installation. */
interface Guard {
  readonly action: string
  readonly install: () => AccessEffect
  installed: (() => void)[] | undefined
}

/**
 * Install every guard's current effect.
 * @param guards - Guards registering this run's access controllers.
 */
function grant(guards: readonly Guard[]): void {
  for (const guard of guards) {
    const effect = guard.install()
    guard.installed = typeof effect === 'function' ? [effect] : [...effect]
  }
}

/**
 * Dispose every installed effect in reverse install order.
 * @param guards - Guards registering this run's access controllers.
 */
function revoke(guards: readonly Guard[]): void {
  for (const guard of [...guards].reverse()) {
    for (const dispose of (guard.installed ?? []).reverse()) dispose()
    guard.installed = undefined
  }
}

it('withdraws every account surface and the account stream on revocation, and restores them on the next grant', async () => {
  vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test')
  const links = { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' }
  const signedIn: AccountView = { status: 'credential-stored', links, attempt: null }
  const guards: Guard[] = []
  const registered = new Map<string, number>()
  const streams: { readonly signal: AbortSignal; readonly accepted: Promise<undefined> }[] = []
  const lifetime: (() => void)[] = []
  const ctx = {
    effect: (install: () => (() => void) | undefined) => { const dispose = install(); if (dispose) lifetime.push(dispose) },
    locale: { register: () => () => {}, bind: () => (key: string) => key, getSnapshot: () => ({ active: 'en' }) },
    configForms: {
      get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'loading', value: undefined }) }),
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ error: null }) }),
    },
    slots: {
      inject: (_name: string, install: () => (() => void) | undefined) => {
        const dispose = install()
        return () => { dispose?.() }
      },
      register: (entry: { readonly name: string }) => {
        registered.set(entry.name, (registered.get(entry.name) ?? 0) + 1)
        return () => { registered.set(entry.name, registered.get(entry.name)! - 1) }
      },
    },
    remoteAccess: {
      whenAccess: (action: string, install: () => AccessEffect) => {
        guards.push({ action, install, installed: undefined })
        return () => {}
      },
    },
    remote: {
      $on: () => () => {},
      session: { initializeDefaultModel: async () => ({ ok: true, value: undefined }) },
      account: { getProfile: async () => ({ ok: true, value: null }), getBalance: async () => ({ ok: true, value: null }) },
      $stream: () => {
        const abort = new AbortController()
        const accepted = Promise.withResolvers<undefined>()
        streams.push({ signal: abort.signal, accepted: accepted.promise })
        return {
          signal: abort.signal,
          dispose: () => { abort.abort() },
          async *[Symbol.asyncIterator]() {
            yield { value: signedIn, accept: () => { accepted.resolve(undefined) } }
            await new Promise((resolve) => { abort.signal.addEventListener('abort', resolve) })
          },
        }
      },
    },
  }
  const surfaces = (): Record<string, number | undefined> => Object.fromEntries(
    ['settings.launcher', 'shell.quota-notice', 'settings.models.sign-in', 'settings.section'].map(name => [name, registered.get(name)]),
  )
  try {
    apply(ctx as never)
    expect(new Set(guards.map(guard => guard.action))).toEqual(new Set(['account/watch']))
    grant(guards)
    await streams[0]!.accepted
    expect(surfaces()).toEqual({ 'settings.launcher': 1, 'shell.quota-notice': 1, 'settings.models.sign-in': 1, 'settings.section': 1 })

    revoke(guards)
    expect(streams[0]!.signal.aborted).toBe(true)
    expect(surfaces()).toEqual({ 'settings.launcher': 0, 'shell.quota-notice': 0, 'settings.models.sign-in': 0, 'settings.section': 0 })

    grant(guards)
    await streams[1]!.accepted
    expect(surfaces()).toEqual({ 'settings.launcher': 1, 'shell.quota-notice': 1, 'settings.models.sign-in': 1, 'settings.section': 1 })
  } finally {
    revoke(guards)
    for (const dispose of lifetime.reverse()) dispose()
  }
})

it('drops reads a revoked grant started, and the next grant shows no account section before its first frame', async () => {
  vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test')
  const links = { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' }
  const signedIn: AccountView = { status: 'credential-stored', links, attempt: null }
  const guards: Guard[] = []
  const registered = new Map<string, number>()
  let operations: AccountSectionInjected | undefined
  const profile = Promise.withResolvers<{ ok: true; value: { status: 'failed' } }>()
  const firstFrames: { release: () => void; accepted: Promise<undefined> }[] = []
  const lifetime: (() => void)[] = []
  const ctx = {
    effect: (install: () => (() => void) | undefined) => { const dispose = install(); if (dispose) lifetime.push(dispose) },
    locale: { register: () => () => {}, bind: () => (key: string) => key, getSnapshot: () => ({ active: 'en' }) },
    configForms: {
      get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'loading', value: undefined }) }),
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ error: null }) }),
    },
    slots: {
      inject: (_name: string, install: () => (() => void) | undefined) => {
        const dispose = install()
        return () => { dispose?.() }
      },
      register: (entry: { readonly name: string; readonly inject?: () => AccountSectionInjected }) => {
        if (entry.name === 'settings.launcher') operations = entry.inject?.()
        registered.set(entry.name, (registered.get(entry.name) ?? 0) + 1)
        return () => { registered.set(entry.name, registered.get(entry.name)! - 1) }
      },
    },
    remoteAccess: {
      whenAccess: (action: string, install: () => AccessEffect) => {
        guards.push({ action, install, installed: undefined })
        return () => {}
      },
    },
    remote: {
      $on: () => () => {},
      session: { initializeDefaultModel: async () => ({ ok: true, value: undefined }) },
      account: { getProfile: async () => await profile.promise, getBalance: async () => ({ ok: true, value: null }) },
      $stream: () => {
        const abort = new AbortController()
        const gate = Promise.withResolvers<undefined>()
        const accepted = Promise.withResolvers<undefined>()
        firstFrames.push({ release: () => { gate.resolve(undefined) }, accepted: accepted.promise })
        return {
          signal: abort.signal,
          dispose: () => { abort.abort() },
          async *[Symbol.asyncIterator]() {
            await gate.promise
            yield { value: signedIn, accept: () => { accepted.resolve(undefined) } }
            await new Promise((resolve) => { abort.signal.addEventListener('abort', resolve) })
          },
        }
      },
    },
  }
  try {
    apply(ctx as never)
    grant(guards)
    firstFrames[0]!.release()
    await firstFrames[0]!.accepted
    expect(registered.get('settings.section')).toBe(1)

    // The profile read started under the first grant settles only after the revocation.
    revoke(guards)
    expect(operations!.hooks.account.getSnapshot()).toMatchObject({ view: undefined, details: undefined })
    profile.resolve({ ok: true, value: { status: 'failed' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(operations!.hooks.account.getSnapshot().details).toBeUndefined()

    grant(guards)
    expect(registered.get('settings.section')).toBe(0)
    firstFrames[1]!.release()
    await firstFrames[1]!.accepted
    expect(registered.get('settings.section')).toBe(1)
  } finally {
    revoke(guards)
    for (const dispose of lifetime.reverse()) dispose()
  }
})

/** Stream behaviour of one grant's account stream in {@link revocationHarness}. */
type StreamScript = (yieldFrame: () => void) => void

/**
 * The account plugin over hand-built services whose account streams follow `scripts`, one per grant.
 * @param scripts - per-grant hooks run right before that stream delivers its first frame.
 * @returns the plugin's access guards, Remote spies, slot counts, and teardown.
 */
function revocationHarness(scripts: StreamScript[]) {
  const links = { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' }
  const signedIn: AccountView = { status: 'credential-stored', links, attempt: null }
  const guards: Guard[] = []
  const registered = new Map<string, number>()
  const accepted: Promise<undefined>[] = []
  const lifetime: (() => void)[] = []
  let operations: AccountSectionInjected | undefined
  const getProfile = vi.fn(async () => ({ ok: true, value: null }))
  const getUnnotifiedBonuses = vi.fn(async () => ({ ok: true, value: null }))
  const startSignIn = vi.fn<() => Promise<{ ok: false }>>()
  const ctx = {
    effect: (install: () => (() => void) | undefined) => { const dispose = install(); if (dispose) lifetime.push(dispose) },
    locale: { register: () => () => {}, bind: () => (key: string) => key, getSnapshot: () => ({ active: 'en' }) },
    configForms: {
      get: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ status: 'loading', value: undefined }) }),
      describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ error: null }) }),
    },
    theme: { getTheme: () => ({ active: { colorScheme: 'light' } }) },
    slots: {
      inject: (_name: string, install: () => (() => void) | undefined) => {
        const dispose = install()
        return () => { dispose?.() }
      },
      register: (entry: { readonly name: string; readonly inject?: () => AccountSectionInjected }) => {
        if (entry.name === 'settings.launcher') operations = entry.inject?.()
        registered.set(entry.name, (registered.get(entry.name) ?? 0) + 1)
        return () => { registered.set(entry.name, registered.get(entry.name)! - 1) }
      },
    },
    remoteAccess: {
      whenAccess: (action: string, install: () => AccessEffect) => {
        guards.push({ action, install, installed: undefined })
        return () => {}
      },
    },
    remote: {
      $on: () => () => {},
      session: { initializeDefaultModel: async () => ({ ok: true, value: undefined }) },
      account: {
        getProfile, getBalance: async () => ({ ok: true, value: null }), getUnnotifiedBonuses, startSignIn,
      },
      $stream: () => {
        const abort = new AbortController()
        const delivered = Promise.withResolvers<undefined>()
        const script = scripts[accepted.length]!
        accepted.push(delivered.promise)
        return {
          signal: abort.signal,
          dispose: () => { abort.abort() },
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            script(() => {})
            yield { value: signedIn, accept: () => { delivered.resolve(undefined) } }
            await new Promise((resolve) => { abort.signal.addEventListener('abort', resolve) })
          },
        }
      },
    },
  }
  apply(ctx as never)
  return {
    guards, registered, accepted, getProfile, getUnnotifiedBonuses, startSignIn,
    operations: () => operations!,
    dispose: () => { revoke(guards); for (const dispose of lifetime.reverse()) dispose() },
  }
}

it('ignores a frame the stream delivered just before the revocation', async () => {
  vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test')
  // The stream hands out its first frame after access is already withdrawn.
  const b = revocationHarness([() => { revoke(b.guards) }])
  try {
    grant(b.guards)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.operations().hooks.account.getSnapshot().view).toBeUndefined()
    expect(b.registered.get('settings.section') ?? 0).toBe(0)
    expect(b.getProfile).not.toHaveBeenCalled()
    expect(b.getUnnotifiedBonuses).not.toHaveBeenCalled()
  } finally {
    b.dispose()
  }
})

it('closes the sign-in dialog, its failure, and the pending authorization tab on revocation', async () => {
  vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test')
  const popup = { opener: null, closed: false, close: vi.fn(), location: { replace: vi.fn() } }
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as never)
  const b = revocationHarness([() => {}, () => {}])
  try {
    grant(b.guards)
    await b.accepted[0]
    b.startSignIn.mockResolvedValueOnce({ ok: false })
    await expect(b.operations().start()).rejects.toThrow('account start failed')
    expect(b.operations().hooks.account.getSnapshot()).toMatchObject({ loginVisible: true, loginFailed: true })
    revoke(b.guards)
    expect(b.operations().hooks.account.getSnapshot().loginVisible).toBe(false)
    expect(b.operations().hooks.account.getSnapshot().loginFailed).toBeUndefined()

    grant(b.guards)
    await b.accepted[1]
    popup.close.mockClear()
    b.startSignIn.mockReturnValueOnce(new Promise(() => {}))
    void b.operations().start()
    expect(open).toHaveBeenCalledTimes(2)
    revoke(b.guards)
    expect(popup.close).toHaveBeenCalledOnce()
  } finally {
    b.dispose()
    open.mockRestore()
  }
})
