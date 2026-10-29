import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { HostObservable, RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertRemoteContribution, TypertResource } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessFrame, RemoteAccessGrant } from '../src/types.ts'
import { ClientAccessState, parseInjectedBaseline, type Baseline } from '../src/client/state.ts'
import { mountAccess } from '../src/client/mount.ts'
import { whenAllowed } from '../src/client/when-allowed.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** Test-only resource kinds; the Client face itself names no kind. */
    'test-shelf': TypertResource<string>
    'test-desk': TypertResource<string>
  }
  interface TypertRemoteMap {
    /** Test-only endpoint the `whenAccess` specs guard effects on. */
    'test/guarded': () => Promise<never>
  }
}

const GRANTED: Extract<RemoteAccessFrame, { type: 'baseline' }> = {
  type: 'baseline',
  owner: false,
  grants: [
    { resource: { kind: 'global' }, actions: ['session/list'] },
    { resource: { kind: 'test-shelf', id: 's1' }, actions: ['session/fork', 'session/prompt'] },
    { resource: { kind: 'test-desk', id: 'd1' }, actions: ['workspace/follow'] },
  ],
}

describe('ClientAccessState', () => {
  it('answers false without a baseline and after a non-owner stream fails, and true for the owner', () => {
    const state = new ClientAccessState()
    expect(state.global('session/create').getSnapshot()).toBe(false)
    expect(state.resource('test-shelf', 's9', 'session/fork').getSnapshot()).toBe(false)
    state.replace({ type: 'baseline', owner: true })
    expect(state.resource('test-desk', 'd9', 'workspace/follow').getSnapshot()).toBe(true)
    state.unavailable()
    expect(state.resource('test-desk', 'd9', 'workspace/follow').getSnapshot()).toBe(true)
    state.replace(GRANTED)
    expect(state.global('session/list').getSnapshot()).toBe(true)
    state.unavailable()
    expect(state.global('session/list').getSnapshot()).toBe(false)
  })

  it('starts from the injected baseline before any stream frame', () => {
    expect(new ClientAccessState({ type: 'baseline', owner: true }).global('session/create').getSnapshot()).toBe(true)
    const granted = new ClientAccessState(GRANTED)
    expect(granted.global('session/list').getSnapshot()).toBe(true)
    expect(granted.resource('test-shelf', 's1', 'session/fork').getSnapshot()).toBe(true)
    expect(granted.global('session/create').getSnapshot()).toBe(false)
  })

  it('validates the injected baseline and refuses a malformed one', () => {
    expect(parseInjectedBaseline(undefined)).toBeUndefined()
    expect(parseInjectedBaseline({ type: 'baseline', owner: true, extra: 1 })).toEqual({ type: 'baseline', owner: true })
    expect(parseInjectedBaseline(JSON.parse(JSON.stringify(GRANTED)))).toEqual(GRANTED)
    for (const malformed of [
      null, 'baseline', [], { type: 'upsert' },
      { type: 'baseline' }, { type: 'baseline', owner: false }, { type: 'baseline', owner: false, grants: [7] },
      { type: 'baseline', owner: false, grants: [{ resource: { kind: 'test-shelf' }, actions: [] }] },
      { type: 'baseline', owner: false, grants: [{ resource: { kind: 7 }, actions: [] }] },
      { type: 'baseline', owner: false, grants: [{ resource: { kind: 'global' }, actions: 'session/list' }] },
      { type: 'baseline', owner: false, grants: [{ resource: { kind: 'global' }, actions: [7] }] },
      { type: 'baseline', owner: false, grants: [{ resource: { kind: 'global' } }] },
      { type: 'baseline', owner: false, grants: [{ scope: { kind: 'page' }, endpoints: ['session/list'] }] },
    ]) {
      expect(() => parseInjectedBaseline(malformed)).toThrow(TypeError)
    }
  })

  it('answers each resource from its own grant without falling back to the global resource', () => {
    const state = new ClientAccessState()
    state.replace(GRANTED)
    expect(state.global('session/list').getSnapshot()).toBe(true)
    expect(state.global('session/fork').getSnapshot()).toBe(false)
    expect(state.resource('test-shelf', 's1', 'session/fork').getSnapshot()).toBe(true)
    expect(state.resource('test-shelf', 's1', 'session/list').getSnapshot()).toBe(false)
    expect(state.resource('test-shelf', 's2', 'session/fork').getSnapshot()).toBe(false)
    expect(state.resource('test-desk', 'd1', 'workspace/follow').getSnapshot()).toBe(true)
    expect(state.resource('test-desk', 'd2', 'workspace/follow').getSnapshot()).toBe(false)
  })

  it('applies upserts and removals and notifies subscribers until they unsubscribe', () => {
    const state = new ClientAccessState()
    state.replace(GRANTED)
    const fork = state.resource('test-shelf', 's1', 'session/fork')
    const listener = vi.fn()
    const unsubscribe = fork.subscribe(listener)
    state.update({ type: 'upsert', grant: { resource: { kind: 'test-shelf', id: 's1' }, actions: ['session/prompt'] } })
    expect(fork.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    state.update({ type: 'upsert', grant: { resource: { kind: 'global' }, actions: ['session/create'] } })
    expect(state.global('session/create').getSnapshot()).toBe(true)
    state.update({ type: 'upsert', grant: { resource: { kind: 'test-desk', id: 'd2' }, actions: ['workspace/follow'] } })
    expect(state.resource('test-desk', 'd2', 'workspace/follow').getSnapshot()).toBe(true)
    state.update({ type: 'remove', resource: { kind: 'test-desk', id: 'd2' } })
    expect(state.resource('test-desk', 'd2', 'workspace/follow').getSnapshot()).toBe(false)
    state.update({ type: 'remove', resource: { kind: 'test-shelf', id: 's1' } })
    expect(state.resource('test-shelf', 's1', 'session/prompt').getSnapshot()).toBe(false)
    // Removing a kind that never had a grant leaves the other kinds intact.
    state.update({ type: 'remove', resource: { kind: 'test-shelf', id: 'absent' } })
    unsubscribe()
    state.update({ type: 'remove', resource: { kind: 'global' } })
    expect(listener).toHaveBeenCalledTimes(6)
    expect(state.global('session/create').getSnapshot()).toBe(false)
  })

  it('applies a baseline of many grants of one kind in one pass and notifies once', () => {
    const state = new ClientAccessState()
    const first = state.resource('test-shelf', 's0', 'session/fork')
    const listener = vi.fn()
    first.subscribe(listener)
    const grants: RemoteAccessGrant[] = Array.from({ length: 20_000 }, (_, index) => ({
      resource: { kind: 'test-shelf', id: `s${index}` },
      actions: ['session/fork'],
    }))
    // Copying the kind's grants once per grant takes seconds at this size and exceeds the spec timeout.
    state.replace({ type: 'baseline', owner: false, grants })
    expect(listener).toHaveBeenCalledOnce()
    expect(first.getSnapshot()).toBe(true)
    expect(state.resource('test-shelf', 's19999', 'session/fork').getSnapshot()).toBe(true)
    expect(state.resource('test-shelf', 's20000', 'session/fork').getSnapshot()).toBe(false)
  })

  it('ignores increments outside a non-owner generation and keeps source identity stable', () => {
    const state = new ClientAccessState()
    state.update({ type: 'upsert', grant: { resource: { kind: 'global' }, actions: ['session/list'] } })
    expect(state.global('session/list').getSnapshot()).toBe(false)
    state.replace({ type: 'baseline', owner: true })
    state.update({ type: 'remove', resource: { kind: 'global' } })
    expect(state.global('session/list').getSnapshot()).toBe(true)
    expect(state.global('session/list')).toBe(state.global('session/list'))
    expect(state.resource('test-shelf', 's1', 'session/fork')).toBe(state.resource('test-shelf', 's1', 'session/fork'))
    expect(state.resource('test-shelf', 's1', 'session/fork')).not.toBe(state.resource('test-desk', 's1', 'session/fork'))
  })
})

interface FakeStreamOptions {
  readonly name: string
  readonly open: (signal: AbortSignal) => unknown
  readonly ended: (accepted: boolean) => Error
}

/** One controllable generation of `remoteAccess/follow`, standing in for the Gateway-owned carrier. */
class FakeAccessStream {
  private readonly frames: RemoteAccessFrame[] = []
  private wake: (() => void) | undefined
  private done = false
  private failure: Error | undefined

  constructor(readonly options: FakeStreamOptions) {}

  push(frame: RemoteAccessFrame): void {
    this.frames.push(frame)
    this.wake?.()
  }

  fail(error: Error): void {
    this.failure = error
    this.wake?.()
  }

  restart(): void {}

  async dispose(): Promise<void> {
    this.done = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<{
    readonly generation: number
    readonly value: RemoteAccessFrame
    readonly accept: () => void
  }> {
    while (!this.done) {
      if (this.failure !== undefined) throw this.failure
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield { generation: 1, value: frame, accept: () => {} }
        continue
      }
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

function value(source: HostObservable<unknown> | undefined): unknown {
  if (source === undefined) throw new Error('missing source')
  return source.getSnapshot()
}

async function mounted(initial?: Baseline): Promise<{
  readonly ctx: Context
  readonly stream: () => FakeAccessStream
  readonly global: (action: string) => HostObservable<unknown> | undefined
  readonly follow: ReturnType<typeof vi.fn>
  readonly mount: ReturnType<typeof vi.fn>
  readonly unmount: ReturnType<typeof vi.fn>
  readonly contribution: TypertRemoteContribution
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  let stream: FakeAccessStream | undefined
  const follow = vi.fn()
  const unmount = vi.fn(async () => {})
  const remote = {
    $mount: vi.fn(async () => unmount),
    $stream: (options: FakeStreamOptions) => {
      stream = new FakeAccessStream(options)
      return stream
    },
    remoteAccess: { follow },
  }
  let root: RootStandardSourceContribution | undefined
  ctx.provide('remote', remote as never)
  ctx.provide('slots', {
    provideRoot: (contribution: RootStandardSourceContribution) => {
      root = contribution
      return () => {}
    },
  } as never)
  const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-api-remote-access', descriptors: [] }
  let dispose: (() => Promise<void>) | undefined
  await ctx.plugin({
    inject: ['remote', 'slots'],
    apply: async (pluginCtx: Context) => { dispose = await mountAccess(pluginCtx, contribution, initial) },
  })
  // The generated namespace arrives after the mount, as `$mount` provides it.
  ctx.provide('remote.remoteAccess', remote.remoteAccess as never)
  await vi.waitFor(() => { expect(stream).toBeDefined() })
  return {
    ctx,
    stream: () => stream as FakeAccessStream,
    global: action => root?.keyedHooks?.['remoteAccess']?.(action),
    follow,
    mount: remote.$mount,
    unmount,
    contribution,
    dispose: async () => { await dispose?.() },
  }
}

describe('remote-access Client mount', () => {
  it('provides the global-resource Hook and the remoteAccess service over the followed snapshot', async () => {
    const access = await mounted()
    expect(access.mount).toHaveBeenCalledWith(access.contribution)
    const globalFork = access.global('session/fork')
    const shelfFork = access.ctx.remoteAccess.source('test-shelf', 's1', 'session/fork')
    const deskFollow = access.ctx.remoteAccess.source('test-desk', 'd1', 'workspace/follow')
    expect(access.ctx.remoteAccess.source('test-shelf', 's1', 'session/fork')).toBe(shelfFork)
    expect([value(globalFork), value(shelfFork), value(deskFollow)]).toEqual([false, false, false])

    access.stream().push(GRANTED)
    await vi.waitFor(() => { expect(value(shelfFork)).toBe(true) })
    expect(value(globalFork)).toBe(false)
    expect(value(deskFollow)).toBe(true)
    access.stream().push({ type: 'remove', resource: { kind: 'test-shelf', id: 's1' } })
    await vi.waitFor(() => { expect(value(shelfFork)).toBe(false) })
    // Reading an answer never issues a request; only the stream factory reaches the namespace.
    expect(access.follow).not.toHaveBeenCalled()
    access.stream().options.open(new AbortController().signal)
    expect(access.follow).toHaveBeenCalledOnce()
    expect(access.stream().options.ended(true).message).toMatch(/without a terminal result/)
    expect(access.stream().options.ended(false).message).toMatch(/before its opening snapshot/)

    await access.dispose()
    expect(access.unmount).toHaveBeenCalledOnce()
  })

  it('answers from the injected baseline at once and false once a non-owner stream fails terminally', async () => {
    const access = await mounted(GRANTED)
    const report = vi.spyOn(access.ctx.logger, 'error').mockImplementation(() => undefined)
    const globalList = access.global('session/list')
    expect(value(globalList)).toBe(true)
    const failure = new Error('carrier closed for good')
    access.stream().fail(failure)
    await vi.waitFor(() => { expect(value(globalList)).toBe(false) })
    expect(report).toHaveBeenCalledWith('access snapshot stream failed; reload the page to reconnect', failure)
    await access.dispose()
  })

  it('keeps the owner\'s answers when its stream fails terminally', async () => {
    const access = await mounted({ type: 'baseline', owner: true })
    const report = vi.spyOn(access.ctx.logger, 'error').mockImplementation(() => undefined)
    const globalFork = access.global('session/fork')
    expect(value(globalFork)).toBe(true)
    const failure = new Error('carrier closed for good')
    access.stream().fail(failure)
    await vi.waitFor(() => { expect(report).toHaveBeenCalledOnce() })
    expect(report).toHaveBeenCalledWith('access snapshot stream failed; owner access answers are unaffected', failure)
    expect(value(globalFork)).toBe(true)
    await access.dispose()
  })
})

/** A baseline whose grants allow `test/guarded` on the listed resources. */
function followOn(...resources: RemoteAccessGrant['resource'][]): Extract<RemoteAccessFrame, { type: 'baseline' }> {
  return { type: 'baseline', owner: false, grants: resources.map(resource => ({ resource, actions: ['test/guarded'] })) }
}

describe('remote-access whenAccess', () => {
  it('installs the effects while the global resource allows the action, disposes them in reverse order on loss, and reinstalls on the next grant', async () => {
    const access = await mounted()
    const log: string[] = []
    const guarded = access.ctx.plugin({
      inject: ['remoteAccess'],
      apply: (ctx: Context) => {
        ctx.remoteAccess.whenAccess('test/guarded', function* () {
          log.push('install')
          yield () => { log.push('dispose first') }
          yield () => { log.push('dispose second') }
        })
      },
    })
    await guarded.await()
    expect(log).toEqual([])

    access.stream().push(followOn({ kind: 'global' }))
    await vi.waitFor(() => { expect(log).toEqual(['install']) })
    // A frame that leaves the answer unchanged installs nothing again.
    access.stream().push({ type: 'upsert', grant: { resource: { kind: 'test-shelf', id: 's1' }, actions: ['session/fork'] } })
    access.stream().push({ type: 'upsert', grant: { resource: { kind: 'global' }, actions: ['session/list'] } })
    await vi.waitFor(() => { expect(log).toEqual(['install', 'dispose second', 'dispose first']) })
    access.stream().push({ type: 'upsert', grant: { resource: { kind: 'global' }, actions: ['test/guarded'] } })
    await vi.waitFor(() => { expect(log).toHaveLength(4) })
    expect(log[3]).toBe('install')

    await guarded.dispose()
    expect(log.slice(4)).toEqual(['dispose second', 'dispose first'])
    await access.dispose()
  })

  it('runs the callback at once for the owner and disposes it with the returned disposer', async () => {
    const access = await mounted({ type: 'baseline', owner: true })
    const dispose = vi.fn()
    const callback = vi.fn(() => dispose)
    const stop = access.ctx.remoteAccess.whenAccess('test/guarded', callback)
    expect(callback).toHaveBeenCalledOnce()
    stop()
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })
    await access.dispose()
  })

  it('follows one resource of a declared kind through whenResourceAccess', async () => {
    const access = await mounted(followOn({ kind: 'test-shelf', id: 's1' }))
    const dispose = vi.fn()
    const shelf = vi.fn(() => dispose)
    const desk = vi.fn(() => () => {})
    access.ctx.remoteAccess.whenResourceAccess('test-shelf', 's1', 'test/guarded', shelf)
    access.ctx.remoteAccess.whenResourceAccess('test-desk', 's1', 'test/guarded', desk)
    expect(shelf).toHaveBeenCalledOnce()
    expect(desk).not.toHaveBeenCalled()
    access.stream().push({ type: 'remove', resource: { kind: 'test-shelf', id: 's1' } })
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })
    await access.dispose()
  })

  it('disposes a non-owner\'s effects once its stream fails terminally', async () => {
    const access = await mounted(followOn({ kind: 'global' }))
    vi.spyOn(access.ctx.logger, 'error').mockImplementation(() => undefined)
    const dispose = vi.fn()
    access.ctx.remoteAccess.whenAccess('test/guarded', () => dispose)
    access.stream().fail(new Error('carrier closed for good'))
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })
    await access.dispose()
  })

  it('throws a setup failure at once while allowed, and reports a later one without retrying it', async () => {
    const owner = await mounted({ type: 'baseline', owner: true })
    expect(() => owner.ctx.remoteAccess.whenAccess('test/guarded', () => { throw new Error('setup failed') }))
      .toThrow('setup failed')
    await owner.dispose()

    const access = await mounted()
    const failures: unknown[] = []
    const onLoud = (error: unknown): void => { failures.push(error) }
    process.on('uncaughtException', onLoud)
    try {
      const failing = vi.fn((): () => void => { throw new Error('late failure') })
      const throwsValue = vi.fn(function* (): Generator<() => void> {
        yield () => {}
        throw new Error('late value')
      })
      const later = vi.fn(() => () => {})
      access.ctx.remoteAccess.whenAccess('test/guarded', failing)
      access.ctx.remoteAccess.whenAccess('test/guarded', throwsValue)
      access.ctx.remoteAccess.whenAccess('test/guarded', later)
      access.stream().push(followOn({ kind: 'global' }))
      await vi.waitFor(() => { expect(failures).toHaveLength(2) })
      expect(failures.map(String)).toEqual(['Error: late failure', 'Error: late value'])
      expect(later).toHaveBeenCalledOnce()
      access.stream().push({ type: 'remove', resource: { kind: 'global' } })
      access.stream().push({ type: 'upsert', grant: { resource: { kind: 'global' }, actions: ['test/guarded'] } })
      await vi.waitFor(() => { expect(later).toHaveBeenCalledTimes(2) })
      expect(failing).toHaveBeenCalledOnce()
      expect(throwsValue).toHaveBeenCalledOnce()
    } finally {
      process.off('uncaughtException', onLoud)
    }
    await access.dispose()
  })

  it('skips a controller another installation stopped during the same notification', async () => {
    const access = await mounted()
    let stopLater = (): void => {}
    const first = vi.fn(() => {
      stopLater()
      return () => {}
    })
    const later = vi.fn(() => () => {})
    access.ctx.remoteAccess.whenAccess('test/guarded', first)
    stopLater = access.ctx.remoteAccess.whenAccess('test/guarded', later)
    access.stream().push(followOn({ kind: 'global' }))
    await vi.waitFor(() => { expect(first).toHaveBeenCalledOnce() })
    expect(later).not.toHaveBeenCalled()
    await access.dispose()
  })

  it('installs nothing for a grant that arrives while its caller is unloading', async () => {
    const access = await mounted()
    const callback = vi.fn(() => () => {})
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const pauseUnload = vi.fn(async () => { await blocked })
    const caller = access.ctx.plugin({
      inject: ['remoteAccess'],
      apply: (ctx: Context) => {
        ctx.remoteAccess.whenAccess('test/guarded', callback)
        ctx.effect(() => pauseUnload, 'pause caller unload')
      },
    })
    await caller.await()
    const disposing = caller.dispose()
    await vi.waitFor(() => { expect(pauseUnload).toHaveBeenCalledOnce() })
    access.stream().push(followOn({ kind: 'global' }))
    await vi.waitFor(() => { expect(value(access.global('test/guarded'))).toBe(true) })
    expect(callback).not.toHaveBeenCalled()
    release()
    await disposing
    await access.dispose()
  })
})

/** A hand-driven access answer that notifies synchronously. */
function drivenAnswer(): { readonly answer: HostObservable<boolean>; set(allowed: boolean): void } {
  let allowed = false
  const listeners = new Set<() => void>()
  return {
    answer: {
      getSnapshot: () => allowed,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(next) {
      allowed = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('whenAllowed', () => {
  it('installs nothing when the answer turns true while its caller is unloading', async () => {
    const root = new Context()
    const driven = drivenAnswer()
    const callback = vi.fn(() => () => {})
    const caller = root.plugin({
      apply: (ctx: Context) => {
        whenAllowed(ctx, driven.answer, callback, 'test')
        // Disposed before the controller: it turns the answer true mid-unload.
        ctx.effect(() => () => { driven.set(true) }, 'grant during unload')
      },
    })
    await caller.await()
    await caller.dispose()
    expect(callback).not.toHaveBeenCalled()
    await root.fiber.dispose()
  })

  it('ignores its disposer after a later failure retired it, and reports a non-Error failure as an Error', async () => {
    const root = new Context()
    const driven = drivenAnswer()
    const failures: unknown[] = []
    const onLoud = (error: unknown): void => { failures.push(error) }
    process.on('uncaughtException', onLoud)
    try {
      const stop = whenAllowed(root, driven.answer, () => { throw new Error('late failure') }, 'test')
      driven.set(true)
      await vi.waitFor(() => { expect(failures).toHaveLength(1) })
      expect(() => { stop() }).not.toThrow()
      // A faulty answer that throws a non-Error value is reported as an Error naming it.
      let reads = 0
      const listeners: (() => void)[] = []
      whenAllowed(root, {
        getSnapshot: () => {
          reads++
          if (reads > 1) throw 'unreadable answer'
          return false
        },
        subscribe: (listener) => {
          listeners.push(listener)
          return () => {}
        },
      }, () => () => {}, 'test')
      for (const listener of listeners) listener()
      await vi.waitFor(() => { expect(failures).toHaveLength(2) })
      expect(String(failures[1])).toBe('Error: unreadable answer')
    } finally {
      process.off('uncaughtException', onLoud)
    }
    await root.fiber.dispose()
  })
})
