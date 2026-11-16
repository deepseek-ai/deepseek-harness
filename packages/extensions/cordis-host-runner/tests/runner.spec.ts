import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ApprovalRequestId as ApprovalRequestIdType, CordisDynamicPluginId,
} from '../src/types.ts'
import { AGENT_A, AGENT_B, CLIENT_CODE, setup, running } from './helpers.ts'

/**
 * The runner's own chain on a real cordis tree: define records without running,
 * run starts a real host-half fiber and broadcasts one request, the first answer
 * settles it, and stop/undefine unwind both halves. Only the model and the
 * browser are stand-ins (code strings and a recording gateway).
 */

/** A host half that registers one invoke handler and provides a service. */
const HOST_CODE = `
  harness.handle('double', async (args) => args.value * 2)
  return {
    name: 'doubler',
    apply(ctx) {
      ctx.provide('dynDoubler', { ok: true })
    },
  }
`

type Runner = Awaited<ReturnType<typeof setup>>['runner']

function define(
  runner: Runner,
  request: {
    sessionId: typeof AGENT_A.id
    name: string
    purpose: string
    host?: string
    client?: string
  },
) {
  return runner.define({
    sessionId: request.sessionId,
    plugin: { kind: 'new', idPrefix: 'dyn' },
    name: request.name,
    purpose: request.purpose,
    code: {
      ...request.host === undefined ? {} : { host: request.host },
      ...request.client === undefined ? {} : { client: request.client },
    },
  })
}

describe('dynamic runner definitions', () => {
  it('lists the whole registry for a global surface, each row carrying its owning session', async () => {
    const { runner } = await setup()
    const mine = define(runner, { sessionId: AGENT_A.id, name: 'mine', purpose: 'ours', host: HOST_CODE })
    const theirs = define(runner, { sessionId: AGENT_B.id, name: 'theirs', purpose: 'not ours', client: CLIENT_CODE })

    // Global by design: a run-control surface that is not inside a session can
    // still name every package, and each row carries the address later verbs need.
    expect(runner.inventory()).toEqual([
      {
        pluginId: mine.pluginId,
        agentId: AGENT_A.id,
        packages: [{
          packageId: mine.packageId, name: 'mine', purpose: 'ours', hasHostHalf: true, hasClientHalf: false,
        }],
      },
      {
        pluginId: theirs.pluginId,
        agentId: AGENT_B.id,
        packages: [{
          packageId: theirs.packageId, name: 'theirs', purpose: 'not ours', hasHostHalf: false, hasClientHalf: true,
        }],
      },
    ])
    // Authority did not move with the listing: acting still needs the owner.
    await expect(runner.run(AGENT_A, theirs.pluginId, theirs.packageId, 'run'))
      .resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
  })

  it('tells a global surface which definitions even have a browser half to load', async () => {
    const { runner } = await setup()
    define(runner, { sessionId: AGENT_A.id, name: 'host only', purpose: 'no UI', host: HOST_CODE })
    define(runner, {
      sessionId: AGENT_A.id,
      name: 'both halves',
      purpose: 'UI too',
      host: HOST_CODE,
      client: CLIENT_CODE,
    })

    // A host-only package cannot be loaded into a page, so the surface must be
    // able to tell the two apart from the listing alone.
    expect(runner.inventory().map(row => [String(row.pluginId), row.packages[0]?.hasClientHalf])).toEqual([
      ['dyn-1', false],
      ['dyn-2', true],
    ])
  })

  it('records a definition without running it, and mints ids that are never reused', async () => {
    const { runner } = await setup()

    const first = define(runner, { sessionId: AGENT_A.id, name: 'first', purpose: 'do a thing', host: HOST_CODE })
    const second = define(runner, { sessionId: AGENT_A.id, name: 'second', purpose: 'do another', client: 'return () => {}' })

    expect(first).toEqual({
      pluginId: 'dyn-1', packageId: 'pkg-1', name: 'first', purpose: 'do a thing',
      hasHostHalf: true, hasClientHalf: false,
    })
    expect(second).toEqual({
      pluginId: 'dyn-2', packageId: 'pkg-2', name: 'second', purpose: 'do another',
      hasHostHalf: false, hasClientHalf: true,
    })
    expect(running(runner, AGENT_A)).toEqual([{ id: 'dyn-1', running: false }, { id: 'dyn-2', running: false }])
  })

  it.each([
    [{ name: ' ', purpose: 'p', host: 'return () => {}' }, 'non-empty `name`'],
    [{ name: 'n', purpose: '', host: 'return () => {}' }, 'non-empty `purpose`'],
    [{ name: 'n', purpose: 'p' }, 'needs `code.host`, `code.client`, or both'],
  ])('refuses an incomplete define request: %j', async (request, message) => {
    const { runner } = await setup()
    expect(() => define(runner, { sessionId: AGENT_A.id, ...request })).toThrow(message)
  })

  it('keeps unparseable code out of the registry, teaching the TypeScript removal', async () => {
    const { runner } = await setup()

    expect(() => define(runner, {
      sessionId: AGENT_A.id,
      name: 'broken',
      purpose: 'p',
      client: 'return { type: \'text\' as const }',
    })).toThrow('The sandbox runs plain JavaScript, not TypeScript')
    expect(running(runner, AGENT_A)).toEqual([])
  })

  it('hides another session\'s definition, so only its own card can address it', async () => {
    const { runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'owned', purpose: 'p', host: HOST_CODE,
    })

    expect(running(runner, AGENT_B)).toEqual([])
    await expect(runner.run(AGENT_B, pluginId, packageId, 'run'))
      .resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
    await expect(runner.stop(AGENT_B, pluginId)).resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
  })
})

describe('dynamic runner dispatch', () => {
  it('starts a host-only package immediately, with no request and no approval', async () => {
    const { ctx, runner, gateway } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'doubler', purpose: 'p', host: HOST_CODE,
    })

    const receipt = await runner.run(AGENT_A, pluginId, packageId, 'run')

    expect(receipt).toEqual({
      ok: true,
      status: 'running',
      pluginId,
      packageId,
      pluginRunId: 'run-1',
      waitingFor: [],
      currentPackageId: packageId,
      mode: 'run',
    })
    expect(ctx.get('dynDoubler')).toEqual({ ok: true })
    // Its own business: the only announcement is the run-state one.
    expect(gateway.events).toEqual([
      ['cordis/dynamic-package', { pluginId, packageId, pluginRunId: 'run-1', name: 'doubler' }],
    ])
    await expect(runner.invoke(pluginId, 'run-1' as never, 'double', { value: 21 }))
      .resolves.toEqual({ ok: true, value: 42 })
    expect(running(runner, AGENT_A)).toEqual([{ id: pluginId, running: true }])
  })

  it('returns awaiting approval, then records the page activation asynchronously', async () => {
    const { ctx, runner, gateway } = await setup()
    gateway.answer = 'approve'
    gateway.clientWaitingFor = ['slots']
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'both', purpose: 'p', host: HOST_CODE, client: CLIENT_CODE,
    })

    const receipt = await runner.run(AGENT_A, pluginId, packageId, 'run')

    expect(receipt).toEqual({
      ok: true,
      status: 'awaiting-approval',
      pluginId,
      packageId,
      pluginRunId: 'run-1',
      mode: 'run',
      waitingFor: [],
      nextPackageId: packageId,
    })
    await gateway.answering
    expect(ctx.get('dynDoubler')).toEqual({ ok: true })
    expect(runner.inventory()[0]?.latestRun).toMatchObject({
      status: 'waiting',
      client: { status: 'waiting', waitingFor: ['slots'] },
    })
    expect(gateway.events.map(([name]) => name)).toEqual([
      'cordis/request-run', 'cordis/dynamic-package', 'cordis/request-run-resolved',
    ])
    expect(gateway.events.at(-1)?.[1]).toMatchObject({ outcome: 'approved' })
  })

  it('returns awaiting approval, then records a refusal without starting', async () => {
    const { ctx, runner, gateway } = await setup()
    gateway.answer = 'reject'
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'both', purpose: 'p', host: HOST_CODE, client: CLIENT_CODE,
    })

    const receipt = await runner.run(AGENT_A, pluginId, packageId, 'run')

    expect(receipt).toMatchObject({ ok: true, status: 'awaiting-approval' })
    await gateway.answering
    expect(ctx.get('dynDoubler')).toBeUndefined()
    expect(running(runner, AGENT_A)).toEqual([{ id: pluginId, running: false }])
    expect(gateway.events.at(-1)).toMatchObject(['cordis/request-run-resolved', { outcome: 'rejected' }])
  })

  it('records an asynchronous Client failure and unwinds the Host half it started', async () => {
    const { ctx, runner, gateway } = await setup()
    gateway.answer = { clientFails: 'createElement is not defined' }
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'both', purpose: 'p', host: HOST_CODE, client: CLIENT_CODE,
    })

    const receipt = await runner.run(AGENT_A, pluginId, packageId, 'run')

    expect(receipt).toMatchObject({ ok: true, status: 'awaiting-approval' })
    await gateway.answering
    expect(runner.inventory()[0]?.latestRun).toMatchObject({
      status: 'failed',
      error: { message: 'createElement is not defined' },
    })
    // Rollback restores the state the request found: nothing was running before.
    expect(ctx.get('dynDoubler')).toBeUndefined()
    expect(running(runner, AGENT_A)).toEqual([{ id: pluginId, running: false }])
    expect(gateway.events.at(-1)?.[1]).toMatchObject({ outcome: 'failed' })
  })

  it('replaces a prior run and records failure when the repeated run cannot load Client code', async () => {
    const { ctx, runner, gateway } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'both', purpose: 'p', host: HOST_CODE, client: CLIENT_CODE,
    })
    // A first page ran it; a second request finds it already up.
    gateway.answer = 'approve'
    await runner.run(AGENT_A, pluginId, packageId, 'run')
    await gateway.answering
    gateway.answer = { clientFails: 'this page could not load it' }

    const receipt = await runner.run(AGENT_A, pluginId, packageId, 'run')

    expect(receipt).toMatchObject({ ok: true, status: 'starting' })
    await gateway.answering
    expect(runner.inventory()[0]?.latestRun).toMatchObject({
      status: 'failed',
      error: { message: 'this page could not load it' },
    })
    expect(ctx.get('dynDoubler')).toBeUndefined()
    expect(running(runner, AGENT_A)).toEqual([{ id: pluginId, running: false }])
  })

  it('binds a running host half instead of evaluating it twice', async () => {
    const { runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'doubler', purpose: 'p', host: HOST_CODE,
    })

    const first = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false)
    const second = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false)

    expect(first).toEqual({
      ok: true, pluginId, packageId, pluginRunId: 'run-1', waitingFor: [], startedHere: true,
    })
    // Re-evaluating would collide on the provided service; binding is what lets
    // a reloaded page take a live package back.
    expect(second).toEqual({
      ok: true, pluginId, packageId, pluginRunId: 'run-1', waitingFor: [], startedHere: false,
    })
  })

  it('shares one activation when two pages start the same Package concurrently', async () => {
    const { runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'doubler', purpose: 'p', host: HOST_CODE,
    })

    const [first, second] = await Promise.all([
      runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false),
      runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false),
    ])

    expect(first).toMatchObject({ ok: true, pluginRunId: 'run-1', startedHere: true })
    expect(second).toEqual(first)
  })

  it('hands the browser half\'s source only to the owning session, and only while it runs', async () => {
    const { runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'ui', purpose: 'p', client: CLIENT_CODE,
    })

    expect(() => runner.getClientCode(AGENT_A, pluginId, 'run-0' as never)).toThrow('is not running')
    const started = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false)
    if (!started.ok) throw new Error(started.message)
    expect(runner.getClientCode(AGENT_A, pluginId, started.pluginRunId)).toEqual({
      code: CLIENT_CODE, name: 'ui', pluginId, packageId, pluginRunId: started.pluginRunId,
    })
    expect(() => runner.getClientCode(AGENT_B, pluginId, started.pluginRunId)).toThrow('no dynamic plugin')
  })

  it('accepts and ignores an answer to a request nobody is waiting for', async () => {
    const { runner } = await setup()

    await expect(runner.resolveRequestRun(brandString<ApprovalRequestIdType>('approval-404'), {
      ok: true, pluginRunId: 'run-1' as never,
    }))
      .resolves.toEqual({ accepted: false })
  })

  it('refuses an answer after stop cancels the request and allows a fresh direct run', async () => {
    const { runner, gateway } = await setup()
    // No auto-answer: this suite drives the round trip by hand so the dispatch
    // can be replaced underneath the page that is still loading run 1.
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'ui', purpose: 'p', client: CLIENT_CODE,
    })
    const pending = await runner.run(AGENT_A, pluginId, packageId, 'run')
    expect(pending).toMatchObject({ ok: true, status: 'awaiting-approval' })
    await Promise.resolve()
    const asked = gateway.events.find(([name]) => name === 'cordis/request-run')?.[1]
    const requestId = (asked as { requestId: ApprovalRequestIdType }).requestId
    const first = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', requestId, false)
    if (!first.ok) throw new Error(first.message)
    expect(runner.getClientCode(AGENT_A, pluginId, first.pluginRunId).pluginRunId).toBe(first.pluginRunId)
    // The user stops it while that page is still loading, cancelling the request.
    await runner.stop(AGENT_A, pluginId)

    await expect(runner.resolveRequestRun(requestId, { ok: true, pluginRunId: first.pluginRunId }))
      .resolves.toEqual({ accepted: false })
    expect(gateway.events).toContainEqual([
      'cordis/request-run-resolved',
      { requestId, outcome: 'cancelled' },
    ])
    await expect(runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false))
      .resolves.toMatchObject({ ok: true, pluginRunId: 'run-2', startedHere: true })
  })

  it('cancels a pending request after its provisional activation is stopped', async () => {
    const { runner, gateway } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'ui', purpose: 'p', client: CLIENT_CODE,
    })
    const controller = new AbortController()
    const pending = await runner.run(AGENT_A, pluginId, packageId, 'run', controller.signal)
    expect(pending).toMatchObject({ ok: true, status: 'awaiting-approval' })
    await Promise.resolve()
    const asked = gateway.events.find(([name]) => name === 'cordis/request-run')?.[1]
    const requestId = (asked as { requestId: ApprovalRequestIdType }).requestId
    const started = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', requestId, false)
    if (!started.ok) throw new Error(started.message)
    await runner.stop(AGENT_A, pluginId)

    await expect(runner.resolveRequestRun(requestId, { ok: true, pluginRunId: started.pluginRunId }))
      .resolves.toEqual({ accepted: false })
    controller.abort()
    expect(gateway.events).toContainEqual([
      'cordis/request-run-resolved',
      { requestId, outcome: 'cancelled' },
    ])
  })

  it('keeps a published request answerable after the creating Tool call ends', async () => {
    const { runner, gateway } = await setup()
    // No answer configured: the request stays pending until the signal fires.
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'ui', purpose: 'p', client: CLIENT_CODE,
    })
    const controller = new AbortController()

    const pending = await runner.run(AGENT_A, pluginId, packageId, 'run', controller.signal)
    await Promise.resolve()
    controller.abort()

    expect(pending).toMatchObject({ ok: true, status: 'awaiting-approval' })
    const asked = gateway.events.find(([name]) => name === 'cordis/request-run')?.[1]
    const requestId = (asked as { requestId: ApprovalRequestIdType }).requestId
    const started = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', requestId, false)
    if (!started.ok) throw new Error(started.message)
    await expect(runner.resolveRequestRun(requestId, { ok: true, pluginRunId: started.pluginRunId }))
      .resolves.toEqual({ accepted: true })
    expect(running(runner, AGENT_A)).toEqual([{ id: pluginId, running: true }])
  })

  it('reports the sandbox failure and starts nothing when the host half throws', async () => {
    const { runner, gateway } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id,
      name: 'broken',
      purpose: 'p',
      host: 'harness.handle(\'never\', async () => 1)\nthrow new Error(\'host half exploded\')',
    })

    const receipt = await runner.run(AGENT_A, pluginId, packageId, 'run')

    expect(receipt).toMatchObject({ ok: false, reason: 'host-half-failed' })
    expect(gateway.events).toEqual([])
    expect(running(runner, AGENT_A)).toEqual([{ id: pluginId, running: false }])
    await expect(runner.invoke(pluginId, 'run-1' as never, 'never', null))
      .resolves.toMatchObject({ code: 'plugin-not-running' })
  })
})

describe('dynamic runner teardown', () => {
  it('stops both halves while keeping the definition runnable', async () => {
    const { ctx, runner, gateway } = await setup()
    gateway.answer = 'approve'
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'doubler', purpose: 'p', host: HOST_CODE, client: CLIENT_CODE,
    })
    const first = await runner.run(AGENT_A, pluginId, packageId, 'run')
    if (!first.ok) throw new Error(first.message)
    await gateway.answering

    await expect(runner.stop(AGENT_A, pluginId)).resolves.toEqual({ ok: true })

    expect(ctx.get('dynDoubler')).toBeUndefined()
    await expect(runner.invoke(pluginId, first.pluginRunId, 'double', { value: 1 }))
      .resolves.toMatchObject({ code: 'plugin-not-running' })
    expect(gateway.events.at(-1)).toEqual(['cordis/dynamic-retract', {
      pluginId, packageId, pluginRunId: first.pluginRunId,
    }])
    expect(running(runner, AGENT_A)).toEqual([{ id: pluginId, running: false }])
    // Runnable again, with a fresh activation identity.
    await expect(runner.run(AGENT_A, pluginId, packageId, 'run'))
      .resolves.toMatchObject({ ok: true, pluginRunId: 'run-2' })
  })

  it('announces the stop of a host-only package too, so a global surface drops its row', async () => {
    const { runner, gateway } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'doubler', purpose: 'p', host: HOST_CODE,
    })
    await runner.run(AGENT_A, pluginId, packageId, 'run')

    await expect(runner.stop(AGENT_A, pluginId)).resolves.toEqual({ ok: true })

    // The retract mirrors the start announcement: a run-control surface tracks
    // "is it running", which is independent of whether a browser half existed.
    expect(gateway.events).toEqual([
      ['cordis/dynamic-package', { pluginId, packageId, pluginRunId: 'run-1', name: 'doubler' }],
      ['cordis/dynamic-retract', { pluginId, packageId, pluginRunId: 'run-1' }],
    ])
  })

  it('refuses to stop a definition that is not running', async () => {
    const { runner } = await setup()
    const { pluginId } = define(runner, {
      sessionId: AGENT_A.id, name: 'idle', purpose: 'p', host: HOST_CODE,
    })

    await expect(runner.stop(AGENT_A, pluginId)).resolves.toMatchObject({ ok: false, reason: 'not-running' })
  })

  it('stops a running definition on undefine and forgets it', async () => {
    const { ctx, runner, gateway } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'doubler', purpose: 'p', host: HOST_CODE,
    })
    await runner.run(AGENT_A, pluginId, packageId, 'run')

    await expect(runner.undefine(AGENT_A, pluginId)).resolves.toEqual({ ok: true, wasRunning: true })

    expect(ctx.get('dynDoubler')).toBeUndefined()
    expect(running(runner, AGENT_A)).toEqual([])
    expect(gateway.events.map(([name]) => name))
      .toEqual(['cordis/dynamic-package', 'cordis/dynamic-retract'])
    await expect(runner.run(AGENT_A, pluginId, packageId, 'run'))
      .resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
  })

  it('answers a missing definition with the memory-only explanation', async () => {
    const { runner } = await setup()
    const receipt = await runner.undefine(AGENT_A, brandString<CordisDynamicPluginId>('dyn-404'))

    expect(receipt).toMatchObject({ ok: false, reason: 'plugin-missing' })
    expect((receipt as { message: string }).message).toContain('lost on DSH restart')
  })

  it('unwinds every host half when the runner itself is disposed', async () => {
    const { ctx, runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'doubler', purpose: 'p', host: HOST_CODE,
    })
    await runner.run(AGENT_A, pluginId, packageId, 'run')
    expect(ctx.get('dynDoubler')).toEqual({ ok: true })

    await ctx.fiber.dispose()

    expect(ctx.get('dynDoubler')).toBeUndefined()
  })
})

describe('render failure reports', () => {
  it('keeps the last report per package and shows it to a snapshot reader', async () => {
    const { runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'ui', purpose: 'renders', client: CLIENT_CODE,
    })
    const started = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false)
    if (!started.ok) throw new Error(started.message)

    await runner.reportRenderFailure(
      AGENT_A, pluginId, started.pluginRunId,
      { slot: 'settings.section', message: 'boom', abdicated: true },
    )
    // Cross-page and last-writer-wins: a second page reporting overwrites,
    // because "did this package's UI fail anywhere" has one answer.
    await runner.reportRenderFailure(
      AGENT_A, pluginId, started.pluginRunId,
      { slot: 'shell.overlay', message: 'later', abdicated: false },
    )

    expect(runner.snapshot(AGENT_A)[0]?.activeRun?.renderFailure)
      .toEqual({ slot: 'shell.overlay', message: 'later', abdicated: false })
  })

  it('drops a report for a definition the reporting session does not own', async () => {
    const { runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'ui', purpose: 'renders', client: CLIENT_CODE,
    })
    const started = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', null, false)
    if (!started.ok) throw new Error(started.message)

    // The reporting path must never fail a render, so a report it cannot place
    // is dropped rather than thrown.
    await expect(runner.reportRenderFailure(
      AGENT_B, pluginId, started.pluginRunId, { slot: 's', message: 'm', abdicated: true },
    ))
      .resolves.toBeNull()
    expect(runner.snapshot(AGENT_A)[0]?.activeRun?.renderFailure).toBeUndefined()
  })

  it('clears the report when a fresh dispatch starts and when one stops', async () => {
    const { runner } = await setup()
    const { pluginId, packageId } = define(runner, {
      sessionId: AGENT_A.id, name: 'ui', purpose: 'renders', host: 'return () => {}',
    })
    const first = await runner.run(AGENT_A, pluginId, packageId, 'run')
    if (!first.ok) throw new Error(first.message)
    await runner.reportRenderFailure(
      AGENT_A, pluginId, first.pluginRunId,
      { slot: 'settings.section', message: 'boom', abdicated: true },
    )
    expect(runner.snapshot(AGENT_A)[0]?.activeRun?.renderFailure).toBeDefined()

    // Stop clears it: nothing is mounted to have failed any more.
    await runner.stop(AGENT_A, pluginId)
    expect(runner.snapshot(AGENT_A)[0]?.activeRun?.renderFailure).toBeUndefined()

    await runner.reportRenderFailure(
      AGENT_A, pluginId, first.pluginRunId,
      { slot: 'settings.section', message: 'boom', abdicated: true },
    )
    // A fresh dispatch clears it too: a failure from the previous run would
    // describe something that is no longer there.
    await runner.run(AGENT_A, pluginId, packageId, 'run')
    expect(runner.snapshot(AGENT_A)[0]?.activeRun?.renderFailure).toBeUndefined()
  })
})
