import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ScopedLayers, bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobEvent, JobView } from '@deepseek-ai/dsh-jobs'
import { JobEventHub, JobLayer } from '../src/events.ts'

function agentIn(ctx: Context, rawId: string, presetScope?: ScopeKey): Agent {
  const id = SessionId(rawId)
  let agentCtx = ctx.plugin(() => {}).ctx
  if (presetScope !== undefined) {
    const key = {}
    bindScopeParent(key, presetScope)
    agentCtx = createScope(agentCtx, key).ctx
  }
  const session = Session.create(id)
  return {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function view(owner: Agent | undefined): JobView {
  return {
    id: JobId('bash-1'),
    kind: 'bash',
    label: 'x',
    ...owner !== undefined ? { owner: owner.id } : {},
    status: 'running',
    startedAt: 0,
    output: { total: 0, earliest: 0 },
  }
}

function bench() {
  const ctx = new Context()
  const warnings: string[] = []
  const layers = new ScopedLayers<JobLayer>(() => new JobLayer(), () => {})
  const hub = new JobEventHub(layers, message => warnings.push(message))
  return { ctx, hub, warnings }
}

describe('JobEventHub', () => {
  it('delivers by owner: that session plus every unowned job, never another session', () => {
    const { ctx, hub } = bench()
    const alice = agentIn(ctx, 'alice')
    const bob = agentIn(ctx, 'bob')
    const seen: (string | undefined)[] = []
    hub.subscribe(ctx, { owner: alice.id }, (event) => { seen.push(event.type === 'output' ? event.owner : event.job.owner) })

    hub.emit({ type: 'registered', job: view(alice) }, alice)
    hub.emit({ type: 'registered', job: view(bob) }, bob)
    hub.emit({ type: 'registered', job: view(undefined) }, undefined)
    hub.emit({ type: 'output', id: JobId('bash-1'), owner: bob.id, total: 1 }, bob)
    hub.emit({ type: 'output', id: JobId('bash-1'), total: 1 }, undefined)
    expect(seen).toEqual(['alice', undefined, undefined])
  })

  it("delivers 'all' everything and 'scope' only the owners composed under the subscriber", async () => {
    const { ctx, hub } = bench()
    const mount = createScope(ctx, {})
    const otherMount = createScope(ctx, {})
    const alice = agentIn(ctx, 'alice', scopeOf(mount.ctx))
    const bob = agentIn(ctx, 'bob', scopeOf(otherMount.ctx))

    const all: string[] = []
    hub.subscribe(ctx, { owners: 'all' }, (event) => { all.push(event.type === 'output' ? String(event.owner) : String(event.job.owner)) })
    const scoped: string[] = []
    await mount.ctx.plugin((pluginCtx: Context) => {
      hub.subscribe(pluginCtx, { owners: 'scope' }, (event) => { scoped.push(event.type === 'output' ? String(event.owner) : String(event.job.owner)) })
    })
    const unscoped: string[] = []
    hub.subscribe(ctx, { owners: 'scope' }, (event) => { unscoped.push(event.type === 'output' ? String(event.owner) : String(event.job.owner)) })

    hub.emit({ type: 'registered', job: view(alice) }, alice)
    hub.emit({ type: 'registered', job: view(bob) }, bob)
    hub.emit({ type: 'registered', job: view(undefined) }, undefined)
    expect(all).toEqual(['alice', 'bob', 'undefined'])
    // A preset-scoped subscription hears its own agents only; an unowned job
    // has no chain to walk, so only unscoped subscriptions hear it.
    expect(scoped).toEqual(['alice'])
    expect(unscoped).toEqual(['alice', 'bob', 'undefined'])
  })

  it('contains a throwing listener and keeps delivering to later ones', () => {
    const { ctx, hub, warnings } = bench()
    const seen: JobEvent[] = []
    hub.subscribe(ctx, { owners: 'all' }, () => { throw new Error('listener boom') })
    hub.subscribe(ctx, { owners: 'all' }, (event) => { seen.push(event) })
    hub.emit({ type: 'registered', job: view(undefined) }, undefined)
    expect(seen).toHaveLength(1)
    expect(warnings).toEqual([expect.stringContaining('event listener threw on registered: Error: listener boom')])
  })

  it('unregisters through the disposer and with the subscribing fiber', async () => {
    const { ctx, hub } = bench()
    const seen: number[] = []
    const detach = hub.subscribe(ctx, { owners: 'all' }, () => { seen.push(1) })
    const fiber = await ctx.plugin((pluginCtx: Context) => {
      hub.subscribe(pluginCtx, { owners: 'scope' }, () => { seen.push(2) })
      hub.subscribe(pluginCtx, { owner: SessionId('nobody') }, () => { seen.push(3) })
    })

    // Filter-kind order is not a contract; the assertion only fixes it for determinism.
    hub.emit({ type: 'registered', job: view(undefined) }, undefined)
    expect(seen).toEqual([1, 3, 2])
    detach()
    detach()
    hub.emit({ type: 'registered', job: view(undefined) }, undefined)
    expect(seen).toEqual([1, 3, 2, 3, 2])
    await fiber.dispose()
    hub.emit({ type: 'registered', job: view(undefined) }, undefined)
    expect(seen).toEqual([1, 3, 2, 3, 2])
  })

  it('keeps a scoped layer alive only while a subscription or controller remains in it', async () => {
    const { ctx, hub } = bench()
    const mount = createScope(ctx, {})
    const spy = vi.fn()
    const fiber = await mount.ctx.plugin((pluginCtx: Context) => {
      hub.subscribe(pluginCtx, { owners: 'scope' }, spy)
    })
    const alice = agentIn(ctx, 'alice', scopeOf(mount.ctx))
    hub.emit({ type: 'registered', job: view(alice) }, alice)
    expect(spy).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    hub.emit({ type: 'registered', job: view(alice) }, alice)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(new JobLayer().isEmpty()).toBe(true)
  })
})
