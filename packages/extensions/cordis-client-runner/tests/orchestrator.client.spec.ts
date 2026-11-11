/**
 * Run-orchestration account: the order the halves run in (and what a host-only
 * definition skips), what each failure answers the host, and what a surface can
 * read while it happens. The host seam and the load engine are stood in, because
 * what is under test is the round trip itself — the engine has its own account in
 * runner.spec.
 */
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */

import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  DynamicCordisClientSource, DynamicCordisHostHalfResult, DynamicCordisResolveAck, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { CordisRunOrchestrator } from '../src/client/orchestrator.ts'
import type { CordisUserRunRequest } from '../src/client/orchestrator.ts'
import type { DynamicCordisLoadResult, DynamicCordisPackageRunner } from '../src/client/runtime.ts'

const PLUGIN = brandString<CordisDynamicPluginId>('dyn-1')
const PACKAGE = brandString<CordisDynamicPackageId>('pkg-1')
const RUN = brandString<CordisDynamicPluginRunId>('run-1')
const AGENT = 's-1' as SessionId
const REQ = brandString<ApprovalRequestId>('rr-1')
const HOST_OK: Extract<DynamicCordisHostHalfResult, { ok: true }> = {
  ok: true,
  pluginId: PLUGIN,
  packageId: PACKAGE,
  pluginRunId: RUN,
  waitingFor: [],
  startedHere: true,
}
/** A user's own run of a two-half definition: the host half, then this page's half. */
const DUAL: CordisUserRunRequest = {
  agentId: AGENT, pluginId: PLUGIN, packageId: PACKAGE, mode: 'run', hasClientHalf: true,
}
/** A user's own run of a host-only definition: nothing for this page to load. */
const HOST_ONLY: CordisUserRunRequest = { ...DUAL, hasClientHalf: false }

interface Bench {
  orchestrator: CordisRunOrchestrator
  host: {
    runHostHalf: ReturnType<typeof vi.fn>
    getClientCode: ReturnType<typeof vi.fn>
    resolveRequestRun: ReturnType<typeof vi.fn>
    settleUserRun: ReturnType<typeof vi.fn>
  }
  load: ReturnType<typeof vi.fn>
  /** Resolutions the host received, in order. */
  answers: unknown[]
}

function boot(overrides: {
  hostHalf?: () => Promise<DynamicCordisHostHalfResult>
  clientCode?: () => Promise<DynamicCordisClientSource>
  loaded?: () => Promise<DynamicCordisLoadResult>
  resolve?: () => Promise<DynamicCordisResolveAck>
} = {}): Bench {
  const answers: unknown[] = []
  const host = {
    runHostHalf: vi.fn(overrides.hostHalf ?? (() => Promise.resolve(HOST_OK))),
    getClientCode: vi.fn(overrides.clientCode ?? (() => Promise.resolve({
      code: 'return {}', name: 'demo', pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN,
    }))),
    resolveRequestRun: vi.fn((_requestId: unknown, resolution: unknown) => {
      answers.push(resolution)
      return (overrides.resolve ?? (() => Promise.resolve({ accepted: true })))()
    }),
    settleUserRun: vi.fn((_agentId: SessionId, _pluginId: CordisDynamicPluginId, resolution: unknown) =>
      Promise.resolve({
        ok: true as const,
        status: 'running' as const,
        pluginId: PLUGIN,
        packageId: PACKAGE,
        pluginRunId: (resolution as { pluginRunId: CordisDynamicPluginRunId }).pluginRunId,
        waitingFor: [],
        mode: 'run' as const,
      })),
  }
  const load = vi.fn(overrides.loaded ?? (() => Promise.resolve({ ok: true as const, pluginRunId: RUN })))
  const orchestrator = new CordisRunOrchestrator({
    runner: { load } as unknown as DynamicCordisPackageRunner,
    host,
  })
  return { orchestrator, host, load, answers }
}

/** Register one request the way the `cordis/request-run` event does. */
function ask(bench: Bench, requestId: ApprovalRequestId = REQ): void {
  bench.orchestrator.open({
    requestId,
    agentId: AGENT,
    pluginId: PLUGIN,
    packageId: PACKAGE,
    mode: 'run',
    name: 'demo',
    purpose: 'draw a clock',
    requiresApproval: true,
  })
}

describe('the waiting affordance', () => {
  it('publishes failures on their own observable', async () => {
    const bench = boot({ hostHalf: () => Promise.resolve({ ok: false, message: 'nope' }) })
    let notified = 0
    const unsubscribe = bench.orchestrator.lastRunError.subscribe(() => { notified++ })
    const empty = bench.orchestrator.lastRunError.getSnapshot()
    expect(bench.orchestrator.lastRunError.getSnapshot()).toBe(empty)
    await bench.orchestrator.startUserRun(DUAL)
    expect(notified).toBeGreaterThan(0)
    expect(bench.orchestrator.lastRunError.getSnapshot().get(PLUGIN)?.reason).toBe('host-half-failed')
    unsubscribe()
  })

  it('publishes one activity per definition, carrying the whole ask', () => {
    const bench = boot()
    ask(bench)
    // Everything a surface needs to show and group the row without a registry
    // read: the ask names the session, the plugin, and the model's reason.
    expect(bench.orchestrator.activeRuns.getSnapshot().get(PLUGIN)).toEqual({
      phase: 'awaiting-approval',
      requestId: REQ,
      agentId: AGENT,
      packageId: PACKAGE,
      mode: 'run',
      name: 'demo',
      purpose: 'draw a clock',
    })
  })

  it('keeps naming the session once the decision is made', async () => {
    let release = (): void => {}
    const bench = boot({ hostHalf: () => new Promise((resolve) => { release = (): void => { resolve(HOST_OK) } }) })
    const running = bench.orchestrator.startUserRun(DUAL)
    // A run must not fall out of its session group by advancing past the decision.
    expect(bench.orchestrator.activeRuns.getSnapshot().get(PLUGIN)).toEqual({
      phase: 'orchestrating',
      agentId: AGENT,
      packageId: PACKAGE,
      mode: 'run',
    })
    release()
    await running
  })

  it('keeps a stable snapshot reference between mutations, and notifies on each', () => {
    const bench = boot()
    let notified = 0
    const unsubscribe = bench.orchestrator.activeRuns.subscribe(() => { notified++ })
    const empty = bench.orchestrator.activeRuns.getSnapshot()
    expect(bench.orchestrator.activeRuns.getSnapshot()).toBe(empty)
    ask(bench)
    expect(notified).toBe(1)
    expect(bench.orchestrator.activeRuns.getSnapshot()).not.toBe(empty)
    unsubscribe()
    bench.orchestrator.close(REQ)
    expect(notified).toBe(1)
  })

  it('drops only the waiting affordance when the request settles elsewhere', async () => {
    const bench = boot()
    ask(bench)
    bench.orchestrator.close(REQ)
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
    // Answering a settled request is a no-op, not an error.
    await bench.orchestrator.approve(REQ, false)
    await bench.orchestrator.decline(REQ)
    expect(bench.host.runHostHalf).not.toHaveBeenCalled()
    expect(bench.answers).toEqual([])
  })

  it('leaves an orchestration alone when its own request settles elsewhere', async () => {
    let release = (): void => {}
    const bench = boot({ hostHalf: () => new Promise((resolve) => { release = (): void => { resolve(HOST_OK) } }) })
    ask(bench)
    const running = bench.orchestrator.approve(REQ, false)
    // The host announced the request settled (this page answered it) — the work
    // this page is doing owns its entry until it finishes.
    bench.orchestrator.close(REQ)
    expect(bench.orchestrator.activeRuns.getSnapshot().get(PLUGIN)).toEqual({
      phase: 'orchestrating', agentId: AGENT, packageId: PACKAGE, mode: 'run',
    })
    release()
    await running
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
  })

  it('refuses to decline a request whose definition is already orchestrating', async () => {
    let release = (): void => {}
    const bench = boot({ hostHalf: () => new Promise((resolve) => { release = (): void => { resolve(HOST_OK) } }) })
    const running = bench.orchestrator.startUserRun(DUAL)
    const late = brandString<ApprovalRequestId>('rr-late-decline')
    ask(bench, late)
    await bench.orchestrator.decline(late)
    expect(bench.answers).toEqual([]) // the decision was made; a refusal now would contradict it
    release()
    await running
  })

  it('ignores a close for a request it never saw', () => {
    const bench = boot()
    bench.orchestrator.close(brandString<ApprovalRequestId>('rr-unknown'))
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
  })

  it('closes a request whose activity is already gone', async () => {
    const bench = boot()
    const second = brandString<ApprovalRequestId>('rr-second')
    ask(bench)
    ask(bench, second) // same definition asked twice: the first keeps the affordance
    await bench.orchestrator.approve(REQ, false) // settles and clears the activity
    bench.orchestrator.close(second)
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
  })

  it('does not downgrade an orchestration to a waiting decision', async () => {
    let release = (): void => {}
    const bench = boot({ hostHalf: () => new Promise((resolve) => { release = (): void => { resolve(HOST_OK) } }) })
    const started = bench.orchestrator.startUserRun(DUAL)
    ask(bench, brandString<ApprovalRequestId>('rr-late'))
    // A request arriving mid-orchestration must not offer a decision already made.
    expect(bench.orchestrator.activeRuns.getSnapshot().get(PLUGIN)).toEqual({
      phase: 'orchestrating', agentId: AGENT, packageId: PACKAGE, mode: 'run',
    })
    release()
    await started
  })
})

describe('approve', () => {
  it('runs the host half first, then loads the browser half, then answers', async () => {
    const bench = boot()
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.host.runHostHalf).toHaveBeenCalledWith(AGENT, PLUGIN, PACKAGE, 'run', REQ, false)
    expect(bench.host.getClientCode).toHaveBeenCalledWith(AGENT, PLUGIN, RUN)
    // The load carries the session too: a crash while React renders it is
    // reported back to whoever the run was carried out for.
    expect(bench.load).toHaveBeenCalledWith({
      pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN, agentId: AGENT, name: 'demo', code: 'return {}',
    })
    expect(bench.answers).toEqual([{ ok: true, pluginRunId: RUN }])
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
  })

  it('carries the services a parked browser half waits for', async () => {
    const bench = boot({ loaded: () => Promise.resolve({ ok: true, pluginRunId: RUN, waitingFor: ['absent'] }) })
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.answers).toEqual([{ ok: true, pluginRunId: RUN, waitingFor: ['absent'] }])
  })

  it('short-circuits when the host half fails: nothing is fetched or loaded', async () => {
    const bench = boot({ hostHalf: () => Promise.resolve({ ok: false, message: 'vm exploded' }) })
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.host.getClientCode).not.toHaveBeenCalled()
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.answers).toEqual([{ ok: false, reason: 'host-half-failed', message: 'vm exploded' }])
    expect(bench.orchestrator.lastRunError.getSnapshot().get(PLUGIN))
      .toEqual({ packageId: PACKAGE, reason: 'host-half-failed', ok: false, message: 'vm exploded' })
  })

  it('folds a transport rejection of the host verb into its own failure shape', async () => {
    const bench = boot({ hostHalf: () => Promise.reject(new Error('socket closed')) })
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.answers).toEqual([{
      ok: false,
      reason: 'host-half-failed',
      message: 'socket closed',
      stack: expect.any(String),
    }])
  })

  it('reports a source fetch that failed as the browser half failing', async () => {
    const bench = boot({ clientCode: () => Promise.reject(new Error('definition vanished')) })
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.answers).toEqual([{
      ok: false, reason: 'client-half-failed', pluginRunId: RUN, startedHere: true,
      message: 'definition vanished', stack: expect.any(String),
    }])
  })

  it('carries the failing load stage into the answer', async () => {
    const bench = boot({ loaded: () => Promise.resolve({ ok: false, cause: 'activate', message: 'apply threw' }) })
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.answers).toEqual([{
      ok: false, reason: 'client-half-failed', pluginRunId: RUN, startedHere: true, message: 'activate: apply threw',
    }])
    expect(bench.orchestrator.lastRunError.getSnapshot().get(PLUGIN))
      .toEqual({ packageId: PACKAGE, reason: 'client-half-failed', message: 'activate: apply threw' })
  })

  it('treats a load that rejects outright as a browser-half failure', async () => {
    const bench = boot({ loaded: () => Promise.reject(new Error('module table missing')) })
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.answers).toEqual([{
      ok: false, reason: 'client-half-failed', pluginRunId: RUN, startedHere: true,
      message: 'evaluate: module table missing', stack: expect.any(String),
    }])
  })

  it('joins a second approve into the orchestration already in flight', async () => {
    let release = (): void => {}
    const bench = boot({ hostHalf: () => new Promise((resolve) => { release = (): void => { resolve(HOST_OK) } }) })
    ask(bench)
    const first = bench.orchestrator.approve(REQ, false)
    const second = bench.orchestrator.approve(REQ, false)
    release()
    await Promise.all([first, second])
    expect(bench.host.runHostHalf).toHaveBeenCalledTimes(1)
    expect(bench.answers).toHaveLength(1)
  })

  it('logs an answer the host refused, and settles anyway', async () => {
    const bench = boot({ resolve: () => Promise.reject(new Error('stream gone')) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    const complaints = logged.mock.calls.filter(call => String(call[0]).includes('answering run request'))
    logged.mockRestore()
    expect(complaints).toHaveLength(1)
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
  })

  it('clears a previous failure when the same definition is tried again', async () => {
    const outcomes: DynamicCordisLoadResult[] = [
      { ok: false, cause: 'activate', message: 'first try' },
      { ok: true, pluginRunId: RUN },
    ]
    const bench = boot({ loaded: () => Promise.resolve(outcomes.shift() ?? { ok: true, pluginRunId: RUN }) })
    ask(bench)
    await bench.orchestrator.approve(REQ, false)
    expect(bench.orchestrator.lastRunError.getSnapshot().size).toBe(1)
    await bench.orchestrator.startUserRun(DUAL)
    expect(bench.orchestrator.lastRunError.getSnapshot().size).toBe(0)
  })
})

describe('decline', () => {
  it('answers rejected without touching either half', async () => {
    const bench = boot()
    ask(bench)
    await bench.orchestrator.decline(REQ)
    expect(bench.host.runHostHalf).not.toHaveBeenCalled()
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.answers).toEqual([{ ok: false, reason: 'rejected' }])
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
    // A refusal is not this page failing.
    expect(bench.orchestrator.lastRunError.getSnapshot().size).toBe(0)
  })

  it('is a no-op once the decision was already made', async () => {
    let release = (): void => {}
    const bench = boot({ hostHalf: () => new Promise((resolve) => { release = (): void => { resolve(HOST_OK) } }) })
    ask(bench)
    const running = bench.orchestrator.approve(REQ, false)
    await bench.orchestrator.decline(REQ)
    expect(bench.answers).toEqual([])
    release()
    await running
    expect(bench.answers).toEqual([{ ok: true, pluginRunId: RUN }])
  })

  it('ignores an unknown request', async () => {
    const bench = boot()
    await bench.orchestrator.decline(brandString<ApprovalRequestId>('rr-unknown'))
    expect(bench.answers).toEqual([])
  })
})

describe('startUserRun', () => {
  it('orchestrates both halves with nothing to answer', async () => {
    const bench = boot()
    await bench.orchestrator.startUserRun(DUAL)
    expect(bench.host.runHostHalf).toHaveBeenCalledWith(AGENT, PLUGIN, PACKAGE, 'run', null, false)
    expect(bench.load).toHaveBeenCalledTimes(1)
    // No request was asked, so there is no blocked tool call to settle.
    expect(bench.host.resolveRequestRun).not.toHaveBeenCalled()
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
  })

  it('records its own failure for the surface to show', async () => {
    const bench = boot({ hostHalf: () => Promise.resolve({ ok: false, message: 'no definition' }) })
    await bench.orchestrator.startUserRun(DUAL)
    expect(bench.orchestrator.lastRunError.getSnapshot().get(PLUGIN))
      .toEqual({ packageId: PACKAGE, reason: 'host-half-failed', ok: false, message: 'no definition' })
    expect(bench.host.resolveRequestRun).not.toHaveBeenCalled()
  })

  it('records a source fetch failure with nothing to answer', async () => {
    const bench = boot({ clientCode: () => Promise.reject(new Error('gone')) })
    await bench.orchestrator.startUserRun(DUAL)
    expect(bench.host.resolveRequestRun).not.toHaveBeenCalled()
    expect(bench.orchestrator.lastRunError.getSnapshot().get(PLUGIN))
      .toEqual({
        packageId: PACKAGE,
        reason: 'client-half-failed',
        message: 'gone',
        stack: expect.any(String),
      })
  })

  it('records a load failure, stringifying a non-Error rejection', async () => {

    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    const bench = boot({ loaded: () => Promise.reject('plain rejection') })
    await bench.orchestrator.startUserRun(DUAL)
    expect(bench.host.resolveRequestRun).not.toHaveBeenCalled()
    expect(bench.orchestrator.lastRunError.getSnapshot().get(PLUGIN))
      .toEqual({ packageId: PACKAGE, reason: 'client-half-failed', message: 'evaluate: plain rejection' })
  })

  it('is idempotent per definition while one attempt is in flight', async () => {
    let release = (): void => {}
    const bench = boot({ hostHalf: () => new Promise((resolve) => { release = (): void => { resolve(HOST_OK) } }) })
    const first = bench.orchestrator.startUserRun(DUAL)
    const second = bench.orchestrator.startUserRun(DUAL)
    release()
    await Promise.all([first, second])
    expect(bench.host.runHostHalf).toHaveBeenCalledTimes(1)
  })

  it('brings a host-only definition up without fetching or loading anything', async () => {
    const bench = boot()
    await bench.orchestrator.startUserRun(HOST_ONLY)
    expect(bench.host.runHostHalf).toHaveBeenCalledWith(AGENT, PLUGIN, PACKAGE, 'run', null, false)
    // There is no second half: asking for source that does not exist would be a
    // mistake, and folding its error into `client-half-failed` would report a run
    // that succeeded as a failure of a half the definition never had.
    expect(bench.host.getClientCode).not.toHaveBeenCalled()
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.orchestrator.lastRunError.getSnapshot().size).toBe(0)
    expect(bench.orchestrator.activeRuns.getSnapshot().size).toBe(0)
  })

  it('publishes a host-only run while it is in flight, and its own failure', async () => {
    let release = (): void => {}
    const bench = boot({
      hostHalf: () => new Promise((resolve) => {
        release = (): void => { resolve({ ok: false, message: 'vm exploded' }) }
      }),
    })
    const running = bench.orchestrator.startUserRun(HOST_ONLY)
    // The control a surface disables comes from this entry, and a host half can
    // take real time to evaluate — so a host-only run is in flight like any other.
    expect(bench.orchestrator.activeRuns.getSnapshot().get(PLUGIN)).toEqual({
      phase: 'orchestrating', agentId: AGENT, packageId: PACKAGE, mode: 'run',
    })
    release()
    await running
    expect(bench.orchestrator.lastRunError.getSnapshot().get(PLUGIN))
      .toEqual({ packageId: PACKAGE, reason: 'host-half-failed', ok: false, message: 'vm exploded' })
  })
})
