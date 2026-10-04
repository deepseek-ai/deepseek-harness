/** The band's registration: the Remote mount, one watch per session fed into the dock entry, and the press. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SurfaceSnapshot } from '@deepseek-ai/dsh-experimental-claude-code-mods/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { Band, type BandInjected } from '../src/client/Band.tsx'
import { inject, mountModsBand } from '../src/client/mount.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-claude-code-mods', descriptors: [] }

/** Narrow the erased registry payload before exercising the band's injected face. */
function assertBandInjected(value: Record<string, unknown>): asserts value is Record<string, unknown> & BandInjected {
  assert(typeof value.press === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

/** A fake `watchBand` stream handle the test feeds by hand. */
function stream() {
  const queue: SurfaceSnapshot[] = []
  let wake: (() => void) | undefined
  let closed = false
  let failure: unknown
  const handle = {
    disposed: vi.fn(),
    push(snapshot: SurfaceSnapshot) { queue.push(snapshot); wake?.() },
    fail(error: unknown) { failure = error; wake?.() },
    close() { closed = true; wake?.() },
    send() {},
    end() {},
    dispose() { handle.disposed(); closed = true; wake?.() },
    async *[Symbol.asyncIterator](): AsyncIterator<SurfaceSnapshot> {
      while (true) {
        const next = queue.shift()
        if (next !== undefined) { yield next; continue }
        if (failure !== undefined) throw failure
        if (closed) return
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    },
  }
  return handle
}

async function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const streams = new Map<string, ReturnType<typeof stream>>()
  const watchBand = vi.fn((sessionId: SessionId) => {
    const handle = stream()
    streams.set(sessionId, handle)
    return handle
  })
  const pressBand = vi.fn(async (_sessionId: SessionId, generation: number, actionId: string) => actionId === 'a0'
    ? { ok: true as const, value: { generation: generation + 1, tree: null } satisfies SurfaceSnapshot }
    : { ok: false as const, error: new RemoteError('gateway/bad-request', `no action ${actionId}`, {}) })
  ctx.provide('remote.claudeCodeMods', { watchBand, pressBand })
  ctx.provide('locale', new LocaleRuntime(ctx))
  const warn = vi.fn()
  ctx.logger.warn = warn as never
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } } } as never, () => null)
  let dispose: (() => Promise<void>) | undefined
  const fiber = ctx.plugin({ inject: [...inject], apply: async (plugin: Context) => { dispose = await mountModsBand(plugin, REMOTE) } })
  await fiber
  const entry = ctx.slots.entries('conversation.input.dock').find(candidate => candidate.component === Band)
  if (entry === undefined || dispose === undefined) throw new Error('the band registered no dock entry')
  const injectFace = entry.inject
  if (injectFace === undefined) throw new Error('the dock entry injects nothing')
  const injected = (sessionId: string): BandInjected => {
    const value = injectFace(sessionId as SessionId as never)
    assertBandInjected(value)
    return value
  }
  return { ctx, dispose, unmount, streams, watchBand, pressBand, warn, injected }
}

it('exposes the host marker and the browser inject list', () => {
  hostApply()
  expect(inject).toEqual(['remote', 'slots', 'locale'])
})

it('watches one stream per session, feeds snapshots into the dock entry, and ends the watches on dispose', async () => {
  const f = await fixture()
  const first = f.injected('s1')
  const again = f.injected('s1')
  expect(f.watchBand).toHaveBeenCalledTimes(1)
  expect(first.hooks.band).toBe(again.hooks.band)
  const seen: (SurfaceSnapshot | undefined)[] = []
  const unsubscribe = first.hooks.band.subscribe(() => { seen.push(first.hooks.band.getSnapshot()) })
  const ignored = first.hooks.band.subscribe(() => { throw new Error('unsubscribed listeners never run') })
  ignored()
  expect(first.hooks.band.getSnapshot()).toBeUndefined()
  const handle = f.streams.get('s1')
  if (handle === undefined) throw new Error('no stream')
  handle.push({ generation: 1, tree: null })
  await vi.waitFor(() => { expect(seen).toHaveLength(1) })
  handle.push({ generation: 2, tree: ['drawn'] })
  await vi.waitFor(() => { expect(seen).toHaveLength(2) })
  expect(seen[1]).toEqual({ generation: 2, tree: ['drawn'] })

  f.injected('s2')
  expect(f.watchBand).toHaveBeenCalledTimes(2)
  await f.dispose()
  expect(handle.disposed).toHaveBeenCalled()
  expect(f.streams.get('s2')?.disposed).toHaveBeenCalled()
  expect(f.unmount).toHaveBeenCalled()
  expect(f.warn).not.toHaveBeenCalled()
  unsubscribe()
})

it('withdraws the Remote mount when the registration fails', async () => {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount() { return unmount }
  }
  new Remote()
  ctx.provide('remote.claudeCodeMods', { watchBand: vi.fn(), pressBand: vi.fn() })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  const fiber = ctx.plugin({ inject: [...inject], apply: (plugin: Context) => mountModsBand(plugin, REMOTE) })
  await expect(fiber).rejects.toThrow('slot failed')
  expect(unmount).toHaveBeenCalled()
})

it('presses through the Remote, applies the returned drawing, and surfaces a refused press as an error', async () => {
  const f = await fixture()
  const band = f.injected('s1')
  await band.press(2, 'a0')
  expect(f.pressBand).toHaveBeenCalledWith('s1', 2, 'a0')
  expect(band.hooks.band.getSnapshot()).toEqual({ generation: 3, tree: null })
  await expect(band.press(3, 'a9')).rejects.toThrow('no action a9')
  await f.dispose()
})

it('logs a stream that fails while watched, but not one ended by disposal', async () => {
  const f = await fixture()
  f.injected('s1')
  const handle = f.streams.get('s1')
  if (handle === undefined) throw new Error('no stream')
  const stale = f.injected('s1').hooks.band
  handle.fail(new Error('connection lost'))
  await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith('claude-code-mods band: watch of s1 ended: connection lost') })
  // The ended watch is dropped: the next subscriber opens a fresh stream instead of reading the stale store.
  await vi.waitFor(() => { expect(f.injected('s1').hooks.band).not.toBe(stale) })
  expect(f.watchBand).toHaveBeenCalledTimes(2)
  // A stream the Host closes without failing is dropped the same way, without a report.
  f.streams.get('s1')?.close()
  await new Promise(resolve => setTimeout(resolve, 0))
  f.injected('s1')
  expect(f.watchBand).toHaveBeenCalledTimes(3)
  f.injected('s2')
  f.streams.get('s2')?.fail('text failure')
  await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith('claude-code-mods band: watch of s2 ended: text failure') })
  f.injected('s3')
  const third = f.streams.get('s3')
  if (third === undefined) throw new Error('no stream')
  // A failure after disposal is the stream closing, not a report.
  const disposing = f.dispose()
  third.fail(new Error('closed'))
  await disposing
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.warn).toHaveBeenCalledTimes(2)
})
