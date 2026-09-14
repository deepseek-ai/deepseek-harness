// @vitest-environment jsdom
/**
 * The plugin's wiring: `ctx.resources` is provided, the `resource` root keyed
 * hook reaches every slot component as `useResource`, and both leave with the
 * fiber so a reload of the plugin registers cleanly again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { apply, inject, type ResourceSnapshot, type UseResource } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { ResourceRegistry } from '../src/client/resources.ts'
import type { ResourceProvider } from '../src/client/contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'resources.probe': { kind: 'single'; scope: 'root' }
    'resources.sessionProbe': { kind: 'single'; scope: 'session' }
    'resources.sessionPeer': { kind: 'single'; scope: 'session' }
  }
  interface ResourceProtocolMap {
    feed: string
  }
}

const A = 'dsh-resource://feed/one'
let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

async function boot(): Promise<SlotTestRuntime> {
  const rt = await SlotTestRuntime.create()
  await rt.declare({
    'resources.probe': { kind: 'single', scope: 'root' },
    'resources.sessionProbe': { kind: 'single', scope: 'session' },
    'resources.sessionPeer': { kind: 'single', scope: 'session' },
  })
  return rt
}

describe('client-resources apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('provides ctx.resources and hands every slot component useResource over the shared source', async () => {
    runtime = await boot()
    await runtime.mount({ inject: [...inject], apply })
    expect(runtime.ctx.resources).toBeInstanceOf(ResourceRegistry)

    // A root-scope component reading one address through the standard hook.
    let seen: ResourceSnapshot<string> | undefined
    runtime.slots.register({ name: 'resources.probe' }, ({ useResource }: { useResource: UseResource }) => {
      seen = useResource<'feed'>(A)
      return null
    })
    runtime.renderSlot('resources.probe', {})
    expect(seen).toMatchObject({ status: 'none', value: undefined })

    let push: ((value: string) => void) | undefined
    await act(async () => {
      runtime!.ctx.effect(() => runtime!.ctx.resources.register<'feed'>({
        protocol: 'feed',
        open: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<RemoteResult<string>>>((resolve) => {
              push = (value) => { resolve({ done: false, value: { ok: true, value } }) }
            }),
          }),
        }),
      }), 'spec: feed provider')
    })
    expect(seen).toMatchObject({ status: 'loading' })
    // Rendering the hook is what holds the address: the provider's stream is open.
    expect(push).toBeDefined()
    await act(async () => { push!('v1'); await settle() })
    expect(seen).toMatchObject({ status: 'live', value: 'v1' })
    expect(runtime.ctx.resources.source(A).getSnapshot()).toBe(seen)
  })

  it('withdraws both on dispose, so a remount registers again without a duplicate', async () => {
    runtime = await boot()
    const handle = await runtime.mount({ inject: [...inject], apply })
    await handle.dispose()
    expect(runtime.ctx.get('resources')).toBeUndefined()

    // Records only whether the standard hook is present on a root-scope component's props.
    let hook: UseResource | undefined
    runtime.slots.register({ name: 'resources.probe' }, (props: { useResource?: UseResource }) => {
      hook = props.useResource
      return null
    })
    runtime.renderSlot('resources.probe', {})
    expect(hook).toBeUndefined()

    await runtime.mount({ inject: [...inject], apply })
    expect(hook).toBeTypeOf('function')
  })

  it('shares one address across Root and Session components without reopening on selection', async () => {
    runtime = await boot()
    const rt = runtime
    const firstId = await rt.sessions.add({ id: 'first-session' })
    const secondId = await rt.sessions.add({ id: 'second-session' }, { current: false })
    await rt.mount({ inject: [...inject], apply })
    const opened = Promise.withResolvers<undefined>()
    const open = vi.fn<ResourceProvider<'feed'>['open']>(async function* () {
      try { yield { ok: true as const, value: 'shared data' } } finally { opened.resolve(undefined) }
    })
    await act(async () => {
      rt.ctx.effect(() => rt.ctx.resources.register({ protocol: 'feed', open }), 'spec: shared address')
    })
    const source = rt.ctx.resources.source(A)
    const seen: {
      root?: ResourceSnapshot<string>
      first?: ResourceSnapshot<string>
      second?: ResourceSnapshot<string>
      firstSession?: string
      secondSession?: string
    } = {}
    rt.slots.register({ name: 'resources.probe' }, ({ useResource }: PropsRuntime<'resources.probe'>) => {
      seen.root = useResource<'feed'>(A)
      return null
    })
    rt.slots.register({ name: 'resources.sessionProbe' }, ({ sessionId, useResource }: PropsRuntime<'resources.sessionProbe'>) => {
      seen.firstSession = sessionId
      seen.first = useResource<'feed'>(A)
      return null
    })
    rt.slots.register({ name: 'resources.sessionPeer' }, ({ sessionId, useResource }: PropsRuntime<'resources.sessionPeer'>) => {
      seen.secondSession = sessionId
      seen.second = useResource<'feed'>(A)
      return null
    })
    rt.renderSlot('resources.probe', {})
    rt.renderSlot('resources.sessionProbe', {})
    rt.renderSlot('resources.sessionPeer', {})
    await act(async () => { await opened.promise })
    const snapshot = source.getSnapshot()
    expect(snapshot).toEqual({ status: 'live', value: 'shared data', failure: undefined })
    expect(seen.root).toBe(snapshot)
    expect(seen.first).toBe(snapshot)
    expect(seen.second).toBe(snapshot)
    expect([seen.firstSession, seen.secondSession]).toEqual([firstId, firstId])
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![0]).toBe(A)
    expect(open.mock.calls[0]![1]).toStrictEqual({ signal: expect.any(AbortSignal) as AbortSignal })

    await rt.sessions.setCurrent(secondId)
    expect([seen.firstSession, seen.secondSession]).toEqual([secondId, secondId])
    expect(rt.ctx.resources.source(A)).toBe(source)
    expect(seen.root).toBe(snapshot)
    expect(seen.first).toBe(snapshot)
    expect(seen.second).toBe(snapshot)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![1].signal.aborted).toBe(false)
  })
})
