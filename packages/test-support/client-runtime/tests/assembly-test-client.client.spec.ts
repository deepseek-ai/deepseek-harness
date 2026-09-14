// @vitest-environment jsdom
/**
 * TestClient over the web profile's roster read from its bundles: production
 * `bootClient` over in-process modules, every Remote call answered by a
 * `RemoteMock` bound to that client's Connection instance, mount, HMR-style reload,
 * unload, and fail-loud teardown.
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteMock, ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AssemblyPlan, ClientPluginModule, TestClientOptions } from '../src/assembly/index.ts'
import { ClientRoster, TestClient, remoteDefaultResponses, webApp } from '../src/assembly/index.ts'

/** The Gateway client and what it injects: the Typert registry and the Connection. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const MODULES = '@deepseek-ai/dsh-client-modules'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const PARALLEL_PROBE = '@deepseek-ai/dsh-client-test-parallel-probe'
/** Declared by ui-sidebar, whose SlotMap merge is outside this package's compilation face. */
const SIDEBAR_SETTINGS = 'sidebar.settings' as never
const BRAND = '@deepseek-ai/dsh-client-ui-brand-official'
const globals = globalThis as { EventSource?: unknown; ResizeObserver?: unknown }
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000

async function started(plan: AssemblyPlan, options?: TestClientOptions): Promise<TestClient> {
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  const client = await TestClient.start(plan, mock, options)
  onTestFinished(() => client.dispose())
  return client
}

describe('TestClient (jsdom)', () => {
  it('boots the whole web-app roster, connects, mounts, and disposes with nothing unmatched', async () => {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: webApp }, mock, { mount: true })
    expect(client.connection.state.getSnapshot()).toBe('connected')
    expect(mock.log.streams('$events')).toHaveLength(1)
    const container = client.container!
    expect(document.body.contains(container)).toBe(true)
    expect(container.childElementCount).toBeGreaterThan(0)
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeDefined()
    expect(globals.ResizeObserver).toBeDefined()
    await client.dispose()
    expect(document.body.contains(container)).toBe(false)
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeUndefined()
    expect(globals.ResizeObserver).toBeUndefined()
    await client.dispose()
  }, COLD_BOOT_TIMEOUT_MS)

  it('leaves a pre-existing global alone and removes only the shims it installed', async () => {
    const existing = { existing: true }
    vi.stubGlobal('ResizeObserver', existing)
    onTestFinished(() => { vi.unstubAllGlobals() })
    const client = await started({ roster: API_ROSTER })
    expect(globals.ResizeObserver).toBe(existing)
    expect(globals.EventSource).toBeDefined()
    await client.dispose()
    expect(globals.ResizeObserver).toBe(existing)
    expect(globals.EventSource).toBeUndefined()
  })

  it('boots separate client instances against their own mocks and keeps shared shims until the last dispose', async () => {
    const mockA = RemoteMock.create().load(remoteDefaultResponses).unary('session/rename', ok({ title: 'a', seq: 1 }))
    const mockB = RemoteMock.create().load(remoteDefaultResponses).unary('session/rename', ok({ title: 'b', seq: 1 }))
    const [a, b] = await Promise.all([
      TestClient.start({ roster: API_ROSTER }, mockA),
      TestClient.start({ roster: API_ROSTER }, mockB),
    ])
    onTestFinished(() => a.dispose())
    onTestFinished(() => b.dispose())
    const rename = async (client: TestClient): Promise<unknown> =>
      (client.ctx as unknown as { remote: { session: { rename(request: unknown): Promise<unknown> } } }).remote.session.rename({ sessionId: 's', title: 't' })
    await expect(rename(a)).resolves.toEqual({ ok: true, value: { title: 'a', seq: 1 } })
    await expect(rename(b)).resolves.toEqual({ ok: true, value: { title: 'b', seq: 1 } })
    expect(mockA.log.calls('session/rename')).toHaveLength(1)
    expect(mockB.log.calls('session/rename')).toHaveLength(1)
    await a.reload('@deepseek-ai/dsh-client-connection')
    await vi.waitFor(() => { expect(a.connection.state.getSnapshot()).toBe('connected') })
    await expect(rename(a)).resolves.toEqual({ ok: true, value: { title: 'a', seq: 1 } })
    expect(mockA.log.calls('session/rename')).toHaveLength(2)
    expect(mockB.log.calls('session/rename')).toHaveLength(1)
    await a.dispose()
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeDefined()
    await b.dispose()
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
    expect(globals.EventSource).toBeUndefined()
  })

  it('boots two plugin trees concurrently instead of serializing the worker', async () => {
    let arrivals = 0
    const gate = Promise.withResolvers<undefined>()
    const probe: ClientPluginModule = {
      async apply() {
        arrivals += 1
        await gate.promise
      },
    }
    const roster = ClientRoster.of([
      { name: MODULES, inject: [], immediately: true },
      { name: PARALLEL_PROBE, inject: [], immediately: false },
    ])
    const first = TestClient.start({ roster, provide: { [PARALLEL_PROBE]: probe } }, RemoteMock.create(), { awaitConnected: false })
    const second = TestClient.start({ roster, provide: { [PARALLEL_PROBE]: probe } }, RemoteMock.create(), { awaitConnected: false })
    const starts = Promise.allSettled([first, second])
    let overlapFailure: unknown
    try {
      await vi.waitFor(() => { expect(arrivals).toBe(2) }, { timeout: 5_000 })
    } catch (error) {
      overlapFailure = error
    } finally {
      gate.resolve(undefined)
    }
    const results = await starts
    for (const result of results) {
      if (result.status === 'fulfilled') onTestFinished(() => result.value.dispose())
    }
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') {
      const reason: unknown = rejected.reason
      throw reason
    }
    if (overlapFailure !== undefined) throw overlapFailure
  }, COLD_BOOT_TIMEOUT_MS)

  it('reloads the bootstrap modules row against its own Loader internal', async () => {
    const roster = ClientRoster.of([{ name: MODULES, inject: [], immediately: true }])
    const a = await TestClient.start({ roster }, RemoteMock.create(), { awaitConnected: false })
    onTestFinished(() => a.dispose())
    const b = await TestClient.start({ roster }, RemoteMock.create(), { awaitConnected: false })
    onTestFinished(() => b.dispose())
    const modulesA = a.ctx.modules
    const modulesB = b.ctx.modules
    expect(modulesA).not.toBe(modulesB)
    expect(modulesA).toBe(a.ctx.loader.internal)
    expect(modulesB).toBe(b.ctx.loader.internal)
    await a.reload(MODULES)
    expect(a.ctx.modules).toBe(modulesA)
    expect(b.ctx.modules).toBe(modulesB)
  })

  it('boots the api subset without a mount and exposes the typed Remote', async () => {
    const client = await started({ roster: API_ROSTER })
    expect(client.container).toBeUndefined()
    expect(client.ctx.remote.session).toBeDefined()
    expect(client.connection.state.getSnapshot()).toBe('connected')
  })

  it('refuses to mount a roster that provides no uiRenderer instead of returning an empty container', async () => {
    const before = document.body.childElementCount
    await expect(TestClient.start({ roster: API_ROSTER }, RemoteMock.create().load(remoteDefaultResponses), { mount: true }))
      .rejects.toThrow('mount requested, but the roster provides no `uiRenderer`')
    expect(document.body.childElementCount).toBe(before)
  })

  it('creates no mount element when the roster cannot be loaded', async () => {
    const roster = ClientRoster.of([{ name: '@deepseek-ai/dsh-client-test-runtime-missing', inject: [], immediately: true }])
    const before = document.body.childElementCount
    await expect(TestClient.start({ roster }, RemoteMock.create(), { mount: true })).rejects.toThrow()
    expect(document.body.childElementCount).toBe(before)
  })

  it('mounts into a caller-supplied element and leaves it in place on dispose', async () => {
    const host = document.createElement('main')
    document.body.appendChild(host)
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: webApp }, mock, { mount: host })
    expect(client.container).toBe(host)
    expect(host.childElementCount).toBeGreaterThan(0)
    await client.dispose()
    expect(document.body.contains(host)).toBe(true)
    host.remove()
  })

  it('boots with a provided row in place of the real plugin', async () => {
    const apply = vi.fn()
    const client = await started({ roster: webApp, provide: { [BRAND]: { apply } } }, { mount: true })
    expect(apply).toHaveBeenCalledOnce()
    expect([...client.ctx.loader.entries()].some(entry => entry.options.name === BRAND)).toBe(true)
  })

  it('reload rebuilds the declaring entry; unload collapses it', async () => {
    const client = await started({ roster: webApp }, { mount: true })
    expect(client.ctx.slots.entries(SIDEBAR_SETTINGS)).toHaveLength(1)
    await client.reload(SIDEBAR)
    await client.flush()
    expect(client.ctx.slots.entries(SIDEBAR_SETTINGS)).toHaveLength(1)
    const cleanupStarted = Promise.withResolvers<undefined>()
    const releaseCleanup = Promise.withResolvers<undefined>()
    const sidebar = [...client.ctx.loader.entries()].find(entry => entry.options.name === SIDEBAR)!
    sidebar.fiber!.ctx.effect(() => async () => {
      cleanupStarted.resolve(undefined)
      await releaseCleanup.promise
    })
    let unloaded = false
    const unloading = client.unload(SIDEBAR).then(() => { unloaded = true })
    try {
      await cleanupStarted.promise
      await client.flush()
      expect(unloaded).toBe(false)
    } finally {
      releaseCleanup.resolve(undefined)
      await unloading
    }
    expect(unloaded).toBe(true)
    await client.flush()
    expect(client.ctx.slots.entries(SIDEBAR_SETTINGS)).toHaveLength(0)
    await expect(client.reload(SIDEBAR)).rejects.toThrow(`no Loader entry named ${SIDEBAR}`)
  })

  it('fails loud by teardown at the latest when a boot-time endpoint has no fixture', async () => {
    const mock = RemoteMock.create()
    const run = TestClient.start({ roster: webApp }, mock, { mount: true }).then(client => client.dispose())
    await expect(run).rejects.toThrow(/session\/control|workspace\/follow|session\/list|settings\/describe/)
  })

  it('waits through a carrier flap for the connection to become ready', async () => {
    let opens = 0
    const mock = RemoteMock.create().load(remoteDefaultResponses).stream('$events', (_args, stream) => {
      opens += 1
      const first = opens === 1
      setTimeout(() => {
        if (first) stream.fail(new Error('flap'))
        // Branded on the Gateway side; the test mints a plain string.
        else stream.push({ type: 'ready', clientId: 'reconnected' as never, host: { home: '/home/mock' } })
      }, 20)
    })
    const client = await TestClient.start({ roster: API_ROSTER }, mock)
    onTestFinished(() => client.dispose())
    expect(client.connection.state.getSnapshot()).toBe('connected')
    expect(mock.log.streams('$events')).toHaveLength(2)
  })

  it('reports the log when the connection never becomes ready', async () => {
    // No fixtures: workspace-controller's follow has no rule, so the proxy dispatches it as a unary call the mock
    // logs as unmatched, while $events never sends ready.
    const roster = webApp.closure(['@deepseek-ai/dsh-api-workspace-controller'])
    const mock = RemoteMock.create().stream('$events', openStream([]))
    await expect(TestClient.start({ roster }, mock, { connectTimeoutMs: 300 }))
      .rejects.toThrow(/connection state is \S+ after 300ms; unmatched: \[unary workspace\/follow\]; streams: \[.*\$events \(open\).*\]/)
    expect(globals.EventSource).toBeUndefined()
  })
})
