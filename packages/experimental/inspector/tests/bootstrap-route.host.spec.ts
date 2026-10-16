/** Host bootstrap route availability while the Inspector Worker is still starting. */

import { Context, FiberState } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import open from 'open'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import { startInspector, type InspectorHandle, type InspectorOptions } from '../src/host/bridge/controller.ts'
import { INSPECTOR_BOOTSTRAP_PATH } from '../src/shared/web.ts'

vi.mock('open', () => ({ default: vi.fn(async () => undefined), apps: { chrome: 'chrome' } }))

vi.mock('../src/host/bridge/controller.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/bridge/controller.ts')>()
  return { ...actual, startInspector: vi.fn(actual.startInspector) }
})

/** Startup failures the fixture can inject; only the platform code selects the unavailable state. */
const FAILURES = {
  fail: () => new Error('fixture Worker startup failed'),
  unavailable: () => Object.assign(new Error('web-preview: node:worker_threads.MessageChannel is not available in the worker host'), {
    code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
  }),
  'other-code': () => Object.assign(new Error('fixture Worker port is occupied'), { code: 'EADDRINUSE' }),
  'message-only': () => new Error('fixture ERR_FEATURE_UNAVAILABLE_ON_PLATFORM: worker host is not available'),
} satisfies Record<string, () => Error>

const UNAVAILABLE_WARNING = 'experimental-inspector: NodeJS Inspector is unavailable on this platform; Host inspection stays disabled'

describe('experimental Inspector Host bootstrap route', () => {
  let context: Context | undefined
  const gates: Array<PromiseWithResolvers<undefined>> = []

  afterEach(async () => {
    // A failed assertion can leave startup gated; disposal waits for the pending effect.
    for (const gate of gates.splice(0)) gate.resolve(undefined)
    await context?.fiber.dispose()
    context = undefined
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  /** Hold Worker startup until the returned gate opens. */
  function gateStartup(outcome: 'start' | keyof typeof FAILURES): PromiseWithResolvers<undefined> {
    const gate = Promise.withResolvers<undefined>()
    gates.push(gate)
    vi.mocked(startInspector).mockImplementationOnce(async (options?: InspectorOptions): Promise<InspectorHandle> => {
      await gate.promise
      if (outcome !== 'start') throw FAILURES[outcome]()
      const actual = await vi.importActual<typeof import('../src/host/bridge/controller.ts')>('../src/host/bridge/controller.ts')
      return actual.startInspector(options)
    })
    return gate
  }

  function mount(args: readonly string[] = []) {
    context = new Context()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const register = vi.fn<WebServer['register']>(() => () => {})
    const registerUpgrade = vi.fn<WebServer['registerUpgrade']>(() => () => {})
    context.provide('webServer', { register, registerUpgrade } as Pick<WebServer, 'register' | 'registerUpgrade'> as WebServer)
    context.provide('cmdlineArgs', { get: () => args })
    const connection = new HostConnectionService(context, [], {} as BrowserAuth)
    const api = connection.createSharedFetchHandler('/api')
    const messages: Message[] = []
    context.logger.exporter({ levels: { default: 3 }, export: (message) => { messages.push(message) } })
    const fiber = context.plugin({ name, inject: [...inject], Config, apply }, { port: 0, captureFetch: false })
    const bootstrap = (signal?: AbortSignal) => api.fetch(
      new Request(`http://localhost${INSPECTOR_BOOTSTRAP_PATH}`, signal === undefined ? {} : { signal }),
      connection.browserPeer,
    )
    const injected = () => {
      const rows: IndexInjection[] = []
      context!.emit('webserver/index-inject', rows)
      return rows.find(row => row.kind === 'global' && row.name === '__DSH_INSPECTOR__')
    }
    return { fiber, bootstrap, injected, register, registerUpgrade, messages, log }
  }

  it('accepts bootstrap requests before the Worker is ready and answers once it is', async () => {
    const gate = gateStartup('start')
    const { fiber, bootstrap, injected, register, registerUpgrade } = mount()
    await vi.waitFor(() => { expect(startInspector).toHaveBeenCalledOnce() })

    const early = bootstrap()
    expect(await settledWithin(early, 50)).toBe(false)
    expect(injected()).toBeUndefined()
    expect(register).not.toHaveBeenCalled()
    expect(registerUpgrade).not.toHaveBeenCalled()

    gate.resolve(undefined)
    await fiber.await()
    const response = await early
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const value = injected()
    expect(value).toMatchObject({ kind: 'global', name: '__DSH_INSPECTOR__' })
    expect(await response.json()).toEqual(value?.kind === 'global' ? value.value : undefined)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ path: '/inspector/devtools' }))
    expect(registerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ path: '/inspector/devtools/cdp' }))
  })

  for (const outcome of ['fail', 'other-code', 'message-only'] as const) {
    it(`answers waiting bootstrap requests with 503 and removes the route when Worker startup fails (${outcome})`, async () => {
      const gate = gateStartup(outcome)
      const { fiber, bootstrap, injected, messages } = mount()
      await vi.waitFor(() => { expect(startInspector).toHaveBeenCalledOnce() })

      const early = bootstrap()
      expect(await settledWithin(early, 50)).toBe(false)
      gate.resolve(undefined)
      await expect(fiber.await()).rejects.toThrow(FAILURES[outcome]().message)
      expect(fiber.state).toBe(FiberState.FAILED)
      const response = await early
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(injected()).toBeUndefined()
      expect((await bootstrap()).status).toBe(404)
      expect(messages.filter(message => message.args[0] === UNAVAILABLE_WARNING)).toEqual([])
    })
  }

  it('starts without the NodeJS Inspector when the platform cannot run its Worker', async () => {
    const gate = gateStartup('unavailable')
    const { fiber, bootstrap, injected, register, registerUpgrade, messages, log } = mount(['--inspect'])
    await vi.waitFor(() => { expect(startInspector).toHaveBeenCalledOnce() })

    const early = bootstrap()
    expect(await settledWithin(early, 50)).toBe(false)
    gate.resolve(undefined)
    await fiber.await()
    expect(fiber.state).toBe(FiberState.ACTIVE)
    for (const response of [await early, await bootstrap()]) {
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const warnings = messages.filter(message => message.type === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.args[0]).toBe(UNAVAILABLE_WARNING)
    expect(warnings[0]!.args[1]).toMatchObject({ code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
    expect(messages.filter(message => message.type === 'error')).toEqual([])
    expect(register).not.toHaveBeenCalled()
    expect(registerUpgrade).not.toHaveBeenCalled()
    expect(injected()).toBeUndefined()
    expect(context!.get('inspector')).toBeUndefined()
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^dsh inspector:/u))
    expect(open).not.toHaveBeenCalled()

    await fiber.dispose()
    expect((await bootstrap()).status).toBe(404)
    expect(messages.filter(message => message.type === 'error')).toEqual([])
  })

  it('stops waiting when a bootstrap request is aborted before the Worker is ready', async () => {
    const gate = gateStartup('start')
    const { fiber, bootstrap } = mount()
    await vi.waitFor(() => { expect(startInspector).toHaveBeenCalledOnce() })

    const abort = new AbortController()
    const abandoned = bootstrap(abort.signal)
    expect(await settledWithin(abandoned, 50)).toBe(false)
    abort.abort()
    expect((await abandoned).status).toBe(503)
    expect((await bootstrap(AbortSignal.abort())).status).toBe(503)

    gate.resolve(undefined)
    await fiber.await()
    expect((await bootstrap()).status).toBe(200)
  })
})

/** Report whether a promise settles before a real-time deadline. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => { setTimeout(() => { resolve(false) }, ms) })
  return Promise.race([promise.then(() => true, () => true), timeout])
}
