/**
 * @vitest-environment jsdom
 *
 * Plugin composition account: the dispatch family reaches the runner with its
 * envelope rpcId, the service face is provided for UI surfaces, a load failure
 * always reaches the console, the fiber owns the runner's teardown, and the
 * node half remains inert.
 */
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  DynamicCordisInvokeResult, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: resolves the `ctx.remote.$on` surface.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as NodeHalf from '../src/index.ts'
import * as ClientHalf from '../src/client/index.ts'

const PLUGIN = 'dyn-1' as CordisDynamicPluginId
const PACKAGE = 'pkg-1' as CordisDynamicPackageId
const RUN = 'run-1' as CordisDynamicPluginRunId
const AGENT = 's-1' as SessionId
const USER_RUN = {
  agentId: AGENT, pluginId: PLUGIN, packageId: PACKAGE, mode: 'run' as const, hasClientHalf: true,
}

interface Bench {
  ctx: Context
  /** Source the host hands over for the next run. */
  source: { current: {
    code: string
    name: string
    pluginId: CordisDynamicPluginId
    packageId: CordisDynamicPackageId
    pluginRunId: CordisDynamicPluginRunId
  } }
  /** Resolutions the host received. */
  resolved: { requestId: string; resolution: unknown }[]
  /** What the namespace received. */
  invoked: { pluginId: CordisDynamicPluginId; pluginRunId: CordisDynamicPluginRunId; method: string; args: unknown }[]
  /** Answer of the next invoke call. */
  invokeResult: { current: DynamicCordisInvokeResult }
  /** Rejection the namespace throws instead of answering (the codec refusing a payload). */
  invokeThrow: { current: unknown }
  /** Render failures the namespace received, in order. */
  renderFailures: {
    agentId: string
    pluginId: CordisDynamicPluginId
    pluginRunId: CordisDynamicPluginRunId
    failure: unknown
  }[]
  /** Whether the namespace refuses the next render-failure report. */
  reportRefused: { current: boolean }
  /** Drive one forwarded Host event through the test-owned subscription table. */
  forward: (event: string, payload: object) => void
  /**
   * Report one entry crash the way the renderer's boundary does. Production calls
   * this from ui-renderer's boundary through the render host; a test has no React
   * tree, so it stands in for that caller on the same core seam.
   */
  crash: (slot: string, entry: unknown, abdicate: boolean, error: unknown) => void
  dispose: () => Promise<void>
  settle: () => Promise<void>
}

/** Mount the browser half over a module table and a loader standing on real fibers. */
async function boot(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const factories = new Map<string, () => unknown>()
  const fibers = new Map<string, { fiber: unknown }>()
  let next = 0
  ;(globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__ = {
    load: (handoff: { id: string; factory: () => unknown }) => { factories.set(handoff.id, handoff.factory) },
  }
  ctx.reflect.provide('loader', {
    create: (options: { name: string }) => {
      const entryId = `entry-${++next}`
      const fiber = ctx.plugin(factories.get(options.name)?.() as Parameters<Context['plugin']>[0])
      // The runner reads activation failure through fiber.await(); terminate this
      // handle too, or a failing package also lands as an unhandled rejection.
      void Promise.resolve(fiber).catch(() => {})
      fibers.set(entryId, { fiber })
      return Promise.resolve(entryId)
    },
    resolve: (entryId: string) => fibers.get(entryId) ?? { fiber: undefined },
    remove: async (entryId: string) => {
      const entry = fibers.get(entryId)
      fibers.delete(entryId)
      await (entry?.fiber as { dispose(): Promise<void> } | undefined)?.dispose()
    },
  })
  ctx.reflect.provide('modules', { invalidate: () => {} })
  const invoked: Bench['invoked'] = []
  const invokeResult: { current: DynamicCordisInvokeResult } = { current: { ok: true, value: 'pong' } }
  const invokeThrow: { current: unknown } = { current: undefined }
  const source: Bench['source'] = { current: {
    code: 'return { apply(ctx) {} }',
    name: 'demo',
    pluginId: PLUGIN,
    packageId: PACKAGE,
    pluginRunId: RUN,
  } }
  const resolved: { requestId: string; resolution: unknown }[] = []
  const renderFailures: Bench['renderFailures'] = []
  const reportRefused = { current: false }
  // Every generated Remote method resolves to a RemoteResult: the carrier folds
  // its own failures into the error branch, and only an assembly fault rejects.
  const answered = <T>(value: T): Promise<{ ok: true; value: T }> => Promise.resolve({ ok: true as const, value })
  const namespace = {
    syncInspectManifest: () => answered(null),
    resolveInspectQuery: () => answered({ accepted: true }),
    runHostHalf: () => answered({
      ok: true, pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN, waitingFor: [], startedHere: true,
    }),
    settleUserRun: () => answered({
      ok: true, pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN, waitingFor: [],
    }),
    reportRenderFailure: (
      agentId: string,
      pluginId: CordisDynamicPluginId,
      pluginRunId: CordisDynamicPluginRunId,
      failure: unknown,
    ) => {
      renderFailures.push({ agentId, pluginId, pluginRunId, failure })
      return reportRefused.current ? Promise.reject(new Error('stream gone')) : answered(undefined)
    },
    getClientCode: () => answered(source.current),
    resolveRequestRun: (requestId: string, resolution: unknown) => {
      resolved.push({ requestId, resolution })
      return answered({ accepted: true })
    },
    invoke: (
      pluginId: CordisDynamicPluginId,
      pluginRunId: CordisDynamicPluginRunId,
      method: string,
      args: unknown,
    ) => {
      invoked.push({ pluginId, pluginRunId, method, args })
      const refusal = invokeThrow.current
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is a case under test
      if (refusal !== undefined) return Promise.reject(refusal)
      return answered(invokeResult.current)
    },
  }
  // Minimal stand-in for the gateway's Client Remote: the fan-out under test is
  // this plugin's subscriptions, so registration order and delivery are all the
  // stub owes (api-gateway covers isolation and disposal on the real one).
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const forward = (event: string, payload: object): void => {
    for (const listener of [...listeners.get(event) ?? []]) {
      (listener as (...args: readonly unknown[]) => void)(payload)
    }
  }
  const remote = {
    dynamicCordisRunner: namespace,
    $on: (event: string, listener: (...args: never[]) => void) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {
        const at = bucket.indexOf(listener)
        if (at >= 0) bucket.splice(at, 1)
      }
    },
  }
  ctx.reflect.provide('remote', remote)
  ctx.reflect.provide('remote.dynamicCordisRunner', namespace)
  const fiber = ctx.plugin(ClientHalf)
  await fiber
  return {
    ctx,
    source,
    resolved,
    invoked,
    invokeResult,
    invokeThrow,
    renderFailures,
    reportRefused,
    forward,
    crash: (slot, entry, abdicate, error) => {
      const core = (ctx.slots as unknown as {
        _core: { reportEntryError(key: string, entry: unknown, error: unknown, info: { abdicate: boolean }): void }
      })._core
      core.reportEntryError(slot, entry, error, { abdicate })
    },
    dispose: async () => { await fiber.dispose() },
    settle: async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) },
  }
}

describe('browser half', () => {
  it('provides the load engine as the page run-state face', async () => {
    const bench = await boot()
    expect(bench.ctx.dynamicCordisRunner.getSnapshot()).toEqual([])
    expect(bench.ctx.dynamicCordisRunner.isLoaded(PLUGIN)).toBe(false)
  })

  it('unloads on a forwarded withdrawal event', async () => {
    const bench = await boot()
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    expect(bench.ctx.dynamicCordisRunner.isLoaded(PLUGIN)).toBe(true)
    bench.forward('cordis/dynamic-retract', {
      pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN,
    })
    await bench.settle()
    expect(bench.ctx.dynamicCordisRunner.isLoaded(PLUGIN)).toBe(false)
  })

  it('runs a host-only definition through the face without loading anything here', async () => {
    const bench = await boot()
    await bench.ctx.dynamicCordisRunner.startUserRun({ ...USER_RUN, hasClientHalf: false })
    // The host half is up and this page has nothing — and no failure, which is
    // what the surface's control promised.
    expect(bench.ctx.dynamicCordisRunner.isLoaded(PLUGIN)).toBe(false)
    expect(bench.ctx.dynamicCordisRunner.lastRunError.getSnapshot().size).toBe(0)
  })

  it('routes host.call through the namespace and unwraps the result', async () => {
    const bench = await boot()
    bench.source.current = { ...bench.source.current,
      code: 'return { apply: () => { globalThis.__dynCall = host.call("ping", { a: 1 })'
        + '.then((value) => value, (error) => error.message) } }',
    }
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    const call = (globalThis as { __dynCall?: Promise<unknown> }).__dynCall
    delete (globalThis as { __dynCall?: Promise<unknown> }).__dynCall
    await expect(call).resolves.toBe('pong')
    expect(bench.invoked).toEqual([{
      pluginId: PLUGIN, pluginRunId: RUN, method: 'ping', args: { a: 1 },
    }])
  })

  it('carries an omitted host.call argument to the namespace as null', async () => {
    const bench = await boot()
    bench.source.current = { ...bench.source.current,
      code: 'return { apply: () => { globalThis.__dynCall = host.call("listServices") } }',
    }
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    const call = (globalThis as { __dynCall?: Promise<unknown> }).__dynCall
    delete (globalThis as { __dynCall?: Promise<unknown> }).__dynCall
    await call
    // `undefined` is not JSON, so the wire would refuse the call the model wrote
    // most naturally; the omission travels as null instead.
    expect(bench.invoked).toEqual([{
      pluginId: PLUGIN, pluginRunId: RUN, method: 'listServices', args: null,
    }])
  })

  it('teaches the JSON contract when the namespace refuses the payload', async () => {
    const bench = await boot()
    // What the generated codec throws for a value that is not JSON: a bare field
    // name, with no idea which call it belonged to or what to write instead.
    bench.invokeThrow.current = new Error('client api: dynamicCordisRunner/invoke rejected "args"')
    bench.source.current = { ...bench.source.current,
      code: 'return { apply: () => { globalThis.__dynCall = host.call("ping", 1)'
        + '.then(() => "resolved", (error) => error.message) } }',
    }
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    const call = (globalThis as { __dynCall?: Promise<string> }).__dynCall
    delete (globalThis as { __dynCall?: Promise<string> }).__dynCall
    await expect(call).resolves.toMatch(/host\.call\("ping"\) on dyn-1 did not complete: client api: .*rejected "args"/)
    await expect(call).resolves.toMatch(/omit it, and the handler receives null/)
    await expect(call).resolves.toMatch(/`return null` when there is nothing to report/)
  })

  it('stringifies a non-Error refusal into the same teaching error', async () => {
    const bench = await boot()
    bench.invokeThrow.current = 'stream gone'
    bench.source.current = { ...bench.source.current,
      code: 'return { apply: () => { globalThis.__dynCall = host.call("ping")'
        + '.then(() => "resolved", (error) => error.message) } }',
    }
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    const call = (globalThis as { __dynCall?: Promise<string> }).__dynCall
    delete (globalThis as { __dynCall?: Promise<string> }).__dynCall
    await expect(call).resolves.toMatch(/did not complete: stream gone/)
  })

  it('sends a render crash of its own entry to the host, and survives a refused report', async () => {
    const bench = await boot()
    bench.source.current = { ...bench.source.current,
      code: `return {
        inject: ['slots'],
        apply(ctx) { ctx.slots.register({ name: 'root' }, () => null) },
      }`,
    }
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    const [entry] = bench.ctx.slots.entries('root')
    bench.crash('root', entry, true, new Error('Cannot read properties of undefined'))
    expect(bench.renderFailures).toEqual([{
      agentId: AGENT,
      pluginId: PLUGIN,
      pluginRunId: RUN,
      failure: {
        slot: 'root',
        message: 'your entry in slot "root" crashed while React rendered it: Cannot read properties of undefined',
        stack: expect.any(String),
        abdicated: true,
      },
    }])
    // The same observation also reaches the page's own surface, so a row can show
    // it without reading the host back.
    expect(bench.ctx.dynamicCordisRunner.renderFailures.getSnapshot().get(PLUGIN)).toEqual(bench.renderFailures[0]?.failure)
    // A report the host refuses is logged and dropped: one crash must not become
    // two, and nothing waits on this answer.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    bench.reportRefused.current = true
    bench.crash('root', entry, false, new Error('again'))
    await bench.settle()
    const complaints = logged.mock.calls.filter(call => String(call[0]).includes('reporting a render failure'))
    logged.mockRestore()
    expect(complaints).toHaveLength(1)
  })

  it('turns each routing failure code into its own teaching error', async () => {
    const codes = [
      ['plugin-not-running', /found no active Host half/],
      ['stale-run', /activation that has already been replaced/],
      ['method-not-found', /must declare it with harness\.handle\("ping", fn\)/],
      ['handler-error', /failed inside the host handler: boom/],
    ] as const
    for (const [code, expected] of codes) {
      const bench = await boot()
      bench.invokeResult.current = { ok: false, code, message: 'boom' }
      bench.source.current = { ...bench.source.current,
        code: 'return { apply: () => { globalThis.__dynCall = host.call("ping", 1)'
          + '.then(() => "resolved", (error) => error.message) } }',
      }
      await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
      const call = (globalThis as { __dynCall?: Promise<string> }).__dynCall
      delete (globalThis as { __dynCall?: Promise<string> }).__dynCall
      await expect(call).resolves.toMatch(expected)
    }
  })

  it('answers a run request after the surface approves it', async () => {
    const bench = await boot()
    const request = 'rr-1' as ApprovalRequestId
    bench.forward('cordis/request-run', {
      requestId: request,
      agentId: AGENT,
      pluginId: PLUGIN,
      packageId: PACKAGE,
      mode: 'run',
      name: 'demo',
      purpose: 'show a clock',
      requiresApproval: true,
    })
    await bench.settle()
    // The event's own fields reach the activity: a surface groups the row by
    // session and shows the reason without a registry read.
    expect(bench.ctx.dynamicCordisRunner.activeRuns.getSnapshot().get(PLUGIN)).toEqual({
      phase: 'awaiting-approval',
      requestId: request,
      agentId: AGENT,
      packageId: PACKAGE,
      mode: 'run',
      name: 'demo',
      purpose: 'show a clock',
    })
    await bench.ctx.dynamicCordisRunner.approve(request, false)
    expect(bench.resolved).toEqual([{
      requestId: request, resolution: { ok: true, pluginRunId: RUN },
    }])
    expect(bench.ctx.dynamicCordisRunner.isLoaded(PLUGIN)).toBe(true)
    expect(bench.ctx.dynamicCordisRunner.activeRuns.getSnapshot().size).toBe(0)
  })

  it('drops the affordance when another page answers the request', async () => {
    const bench = await boot()
    const request = 'rr-2' as ApprovalRequestId
    bench.forward('cordis/request-run', {
      requestId: request,
      agentId: AGENT,
      pluginId: PLUGIN,
      packageId: PACKAGE,
      mode: 'run',
      name: 'demo',
      purpose: 'p',
      requiresApproval: true,
    })
    await bench.settle()
    bench.forward('cordis/request-run-resolved', {
      requestId: request, outcome: 'approved',
    })
    await bench.settle()
    expect(bench.ctx.dynamicCordisRunner.activeRuns.getSnapshot().size).toBe(0)
    // Answering a settled request is a no-op, not an error.
    await bench.ctx.dynamicCordisRunner.approve(request, false)
    expect(bench.resolved).toEqual([])
  })

  it('exposes the refusal and the load observer on the face', async () => {
    const bench = await boot()
    const request = 'rr-3' as ApprovalRequestId
    bench.forward('cordis/request-run', {
      requestId: request,
      agentId: AGENT,
      pluginId: PLUGIN,
      packageId: PACKAGE,
      mode: 'run',
      name: 'demo',
      purpose: 'p',
      requiresApproval: true,
    })
    await bench.settle()
    let loads = 0
    const unsubscribe = bench.ctx.dynamicCordisRunner.subscribe(() => { loads++ })
    await bench.ctx.dynamicCordisRunner.decline(request)
    expect(bench.resolved).toEqual([{ requestId: request, resolution: { ok: false, reason: 'rejected' } }])
    expect(bench.ctx.dynamicCordisRunner.isLoaded(PLUGIN)).toBe(false)
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    expect(loads).toBeGreaterThan(0)
    unsubscribe()
  })

  it('unloads every package when its own fiber goes away', async () => {
    const bench = await boot()
    await bench.ctx.dynamicCordisRunner.startUserRun(USER_RUN)
    const runner = bench.ctx.dynamicCordisRunner
    await bench.dispose()
    await bench.settle()
    expect(runner.getSnapshot()).toEqual([])
  })
})

describe('node half', () => {
  it('contributes nothing host-side', () => {
    NodeHalf.apply()
    expect(typeof NodeHalf.apply).toBe('function')
  })
})
