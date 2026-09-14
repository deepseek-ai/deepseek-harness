/**
 * The resource lifecycle: one address opens when its first holder arrives,
 * stays open across holder changes, and closes when the last one leaves.
 * Providers are scripted feeds so every transition is driven by the spec,
 * never by timing.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { protocolOf, RESOURCE_SCHEME, ResourceRegistry } from '../src/client/resources.ts'
import type { ResourceOpenContext, ResourceProvider } from '../src/client/contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    feed: string
    counter: number
  }
}

const A = `${RESOURCE_SCHEME}://feed/one`

/** One scripted stream: the spec pushes value frames, failure frames, or ends it. */
interface Feed {
  readonly ctx: ResourceOpenContext
  push(value: string): void
  fail(error: RemoteFailure): void
  end(): void
  /** Whether the consumer returned the iterator (its `finally` ran). */
  readonly returned: boolean
  readonly closed: Promise<undefined>
}

type Step = { readonly kind: 'frame'; readonly frame: RemoteResult<string> } | { readonly kind: 'end' }

function createFeed(ctx: ResourceOpenContext): { feed: Feed; stream: AsyncIterable<RemoteResult<string>> } {
  const steps: Step[] = []
  let wake: (() => void) | undefined
  let returned = false
  const closed = Promise.withResolvers<undefined>()
  const notify = (): void => { wake?.(); wake = undefined }
  async function* stream(): AsyncGenerator<RemoteResult<string>> {
    try {
      for (;;) {
        if (steps.length === 0) await new Promise<void>((resolve) => { wake = resolve })
        const step = steps.shift()
        if (step === undefined) continue
        if (step.kind === 'end') return
        yield step.frame
      }
    } finally {
      returned = true
      closed.resolve(undefined)
    }
  }
  const feed: Feed = {
    ctx,
    closed: closed.promise,
    push: (value) => { steps.push({ kind: 'frame', frame: { ok: true, value } }); notify() },
    fail: (error) => { steps.push({ kind: 'frame', frame: { ok: false, error } }); notify() },
    end: () => { steps.push({ kind: 'end' }); notify() },
    get returned() { return returned },
  }
  return { feed, stream: stream() }
}

/** A `feed` provider whose every `open` is recorded and spec-driven. */
function scriptedProvider() {
  const opens: Feed[] = []
  onTestFinished(async () => {
    for (const feed of opens) feed.end()
    await Promise.all(opens.map(feed => feed.closed))
  })
  const provider = {
    protocol: 'feed' as const,
    open: vi.fn((_address: string, ctx: ResourceOpenContext) => {
      const { feed, stream } = createFeed(ctx)
      opens.push(feed)
      return stream
    }),
  } satisfies ResourceProvider<'feed'>
  return { provider, opens, last: () => opens[opens.length - 1]! }
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

function bench() {
  const ctx = new Context()
  const registry = new ResourceRegistry(ctx)
  const scripted = scriptedProvider()
  const snapshot = (address = A) => registry.source(address).getSnapshot()
  return { ctx, registry, ...scripted, snapshot }
}

describe('protocolOf', () => {
  it('reads the dsh-resource host, lower-cased, and reports none for any other address', () => {
    expect(protocolOf('dsh-resource://file/session/s1/home/ys/b.txt')).toBe('file')
    expect(protocolOf('DSH-RESOURCE://File/session/s1/a')).toBe('file')
    expect(protocolOf('dsh-resource://chat/node/1')).toBe('chat')
    // A navigation address is not a resource.
    expect(protocolOf('sidebar://guide')).toBeUndefined()
    expect(protocolOf('file://sessions/s1/a.txt')).toBeUndefined()
    expect(protocolOf('dsh-resource:///no-host')).toBeUndefined()
    expect(protocolOf('/a/b.txt')).toBeUndefined()
    expect(protocolOf('')).toBeUndefined()
  })
})

describe('ResourceRegistry providers', () => {
  it('owns a protocol by exactly one provider, and frees it on dispose', () => {
    const b = bench()
    const dispose = b.registry.register(b.provider)
    expect(() => b.registry.register(scriptedProvider().provider)).toThrow('protocol "feed" already has a provider')
    dispose()
    dispose()
    expect(() => b.registry.register(scriptedProvider().provider)).not.toThrow()
  })

  it('reports none for an address whose protocol has no provider, and for a navigation address', () => {
    const b = bench()
    expect(b.snapshot()).toMatchObject({ status: 'none', value: undefined, failure: undefined })
    expect(b.snapshot('sidebar://guide')).toMatchObject({ status: 'none' })
    const unsubscribe = b.registry.source(A).subscribe(() => {})
    expect(b.snapshot().status).toBe('none')
    unsubscribe()
  })

  it('opens a held address when its provider arrives, and closes it when the provider leaves', async () => {
    const b = bench()
    const seen = vi.fn()
    b.registry.source(A).subscribe(seen)
    expect(b.snapshot().status).toBe('none')

    const dispose = b.registry.register(b.provider)
    expect(b.snapshot().status).toBe('loading')
    expect(b.provider.open).toHaveBeenCalledWith(A, { signal: expect.any(AbortSignal) as AbortSignal })
    b.last().push('v1')
    await vi.waitFor(() => { expect(b.snapshot()).toMatchObject({ status: 'live', value: 'v1' }) })

    dispose()
    expect(b.last().ctx.signal.aborted).toBe(true)
    expect(b.snapshot()).toMatchObject({ status: 'none', value: undefined })
    expect(seen).toHaveBeenCalled()
  })

  it('opens the arriving protocol\'s held addresses only, leaving another protocol\'s records as they were', () => {
    const b = bench()
    const other = `${RESOURCE_SCHEME}://other/one`
    b.registry.source(other).subscribe(() => {})
    b.registry.source(A).subscribe(() => {})
    b.registry.register(b.provider)
    expect(b.snapshot().status).toBe('loading')
    expect(b.snapshot(other).status).toBe('none')
    expect(b.provider.open).toHaveBeenCalledExactlyOnceWith(A, { signal: expect.any(AbortSignal) as AbortSignal })
  })

  it('turns an idle, unheld address to loading when its provider arrives, without opening it', () => {
    const b = bench()
    expect(b.snapshot().status).toBe('none')
    b.registry.register(b.provider)
    expect(b.snapshot().status).toBe('loading')
    expect(b.provider.open).not.toHaveBeenCalled()
  })

  it('drops a registration when the registering fiber is disposed', async () => {
    const b = bench()
    const fiber = b.ctx.plugin({
      apply: (child: Context) => { child.effect(() => b.registry.register(b.provider), 'spec: feed provider') },
    })
    await fiber.await()
    expect(b.snapshot().status).toBe('loading')
    await fiber.dispose()
    expect(b.snapshot().status).toBe('none')
    expect(() => b.registry.register(scriptedProvider().provider)).not.toThrow()
  })

  it('drops every registration when the registry\'s own fiber is disposed', async () => {
    const root = new Context()
    let registry: ResourceRegistry | undefined
    const fiber = root.plugin({ apply: (child: Context) => { registry = new ResourceRegistry(child) } })
    await fiber.await()
    const { provider } = scriptedProvider()
    registry!.register(provider)
    registry!.source(A).subscribe(() => {})
    expect(provider.open).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(registry!.source(A).getSnapshot().status).toBe('none')
  })
})

describe('ResourceRegistry holders', () => {
  it('opens on the first subscriber only, and closes after the last one leaves', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    expect(b.provider.open).not.toHaveBeenCalled()

    const first = source.subscribe(() => {})
    const second = source.subscribe(() => {})
    expect(b.provider.open).toHaveBeenCalledTimes(1)
    b.last().push('v1')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('v1') })

    first()
    first()
    expect(b.last().ctx.signal.aborted).toBe(false)
    expect(source.getSnapshot().value).toBe('v1')

    second()
    expect(b.last().ctx.signal.aborted).toBe(true)
    expect(source.getSnapshot()).toMatchObject({ status: 'loading', value: undefined })
  })

  it('keeps one source per address and separates addresses', () => {
    const b = bench()
    expect(b.registry.source(A)).toBe(b.registry.source(A))
    expect(b.registry.source(A)).not.toBe(b.registry.source(`${RESOURCE_SCHEME}://feed/two`))
  })

  it('pins hold the address open until the signal aborts; an aborted signal pins nothing', () => {
    const b = bench()
    b.registry.register(b.provider)
    const controller = new AbortController()
    b.registry.pin(A, controller.signal)
    expect(b.provider.open).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(b.last().ctx.signal.aborted).toBe(true)

    const aborted = new AbortController()
    aborted.abort()
    b.registry.pin(A, aborted.signal)
    expect(b.provider.open).toHaveBeenCalledTimes(1)
  })

  it('hands a remounting subscriber the latest value without reopening while a pin holds it', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const pin = new AbortController()
    b.registry.pin(A, pin.signal)
    const source = b.registry.source(A)

    const unsubscribe = source.subscribe(() => {})
    b.last().push('v1')
    b.last().push('v2')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('v2') })
    unsubscribe()
    b.last().push('v3')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('v3') })

    const seen = vi.fn()
    source.subscribe(seen)
    expect(source.getSnapshot()).toMatchObject({ status: 'live', value: 'v3' })
    expect(b.provider.open).toHaveBeenCalledTimes(1)
    expect(seen).not.toHaveBeenCalled()
  })

  it('reopens after the last holder left, as a fresh stream', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    const first = source.subscribe(() => {})
    b.last().push('v1')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('v1') })
    first()

    const second = source.subscribe(() => {})
    expect(b.provider.open).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toMatchObject({ status: 'loading', value: undefined })
    b.last().push('v2')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('v2') })
    second()
  })
})

describe('ResourceRegistry streams', () => {
  it('ignores what a released stream still yields, and returns its iterator', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    const unsubscribe = source.subscribe(() => {})
    const feed = b.last()
    unsubscribe()
    expect(feed.ctx.signal.aborted).toBe(true)

    feed.push('late')
    await settle()
    await settle()
    expect(source.getSnapshot()).toMatchObject({ status: 'loading', value: undefined })
    expect(feed.returned).toBe(true)
  })

  it('keeps the last value live when the stream ends on its own', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    source.subscribe(() => {})
    b.last().push('v1')
    b.last().end()
    await settle()
    await settle()
    expect(source.getSnapshot()).toMatchObject({ status: 'live', value: 'v1' })
  })

  it('reports a failure frame beside the last value, and the next ok frame clears it', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    source.subscribe(() => {})
    b.last().push('v1')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('v1') })
    const failure = new RemoteError('gateway/bad-request', 'refused', {})
    b.last().fail(failure)
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
    expect(source.getSnapshot()).toMatchObject({ value: 'v1', failure })
    b.last().push('v2')
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('live') })
    expect(source.getSnapshot()).toMatchObject({ value: 'v2', failure: undefined })
  })

  it('reports a failure frame that arrives first with no value', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    source.subscribe(() => {})
    b.last().fail(new RemoteError('gateway/bad-request', 'refused', {}))
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
    expect(source.getSnapshot()).toMatchObject({ value: undefined, failure: { code: 'gateway/bad-request' } })
  })

  it('drops a failure frame that follows the release that aborted the stream', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    const unsubscribe = source.subscribe(() => {})
    const feed = b.last()
    unsubscribe()
    feed.fail(new RemoteError('gateway/internal', 'after abort', {}))
    await settle()
    await settle()
    expect(source.getSnapshot()).toMatchObject({ status: 'loading', failure: undefined })
  })
})

describe('ResourceRegistry addresses', () => {
  it('opens different complete addresses independently and supplies only the lifetime signal', async () => {
    const b = bench()
    b.registry.register(b.provider)
    const other = A + '?variant=second'
    const first = b.registry.source(A)
    const second = b.registry.source(other)
    const releaseFirst = first.subscribe(() => {})
    const firstFeed = b.last()
    const releaseSecond = second.subscribe(() => {})
    const secondFeed = b.last()
    expect(first).not.toBe(second)
    expect(b.provider.open.mock.calls).toEqual([[A, firstFeed.ctx], [other, secondFeed.ctx]])
    expect(firstFeed.ctx).toStrictEqual({ signal: expect.any(AbortSignal) as AbortSignal })
    expect(secondFeed.ctx).toStrictEqual({ signal: expect.any(AbortSignal) as AbortSignal })
    firstFeed.push('first data')
    secondFeed.push('second data')
    await vi.waitFor(() => { expect(first.getSnapshot().value).toBe('first data') })
    await vi.waitFor(() => { expect(second.getSnapshot().value).toBe('second data') })
    releaseFirst()
    expect(firstFeed.ctx.signal.aborted).toBe(true)
    expect(secondFeed.ctx.signal.aborted).toBe(false)
    expect(second.getSnapshot().value).toBe('second data')
    releaseSecond()
    expect(secondFeed.ctx.signal.aborted).toBe(true)
  })
})

describe('ResourceRegistry stream generations', () => {
  it.each(['value', 'failure'] as const)('drops late %s frames after a released resource reopens', async (kind) => {
    const b = bench()
    b.registry.register(b.provider)
    const source = b.registry.source(A)
    const releaseFirst = source.subscribe(() => {})
    const oldFeed = b.last()
    oldFeed.push('old data')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('old data') })
    releaseFirst()
    const releaseCurrent = source.subscribe(() => {})
    const currentFeed = b.last()
    expect(currentFeed).not.toBe(oldFeed)
    currentFeed.push('current data')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('current data') })
    const current = source.getSnapshot()
    if (kind === 'value') oldFeed.push('late old data')
    else oldFeed.fail(new RemoteError('gateway/internal', 'late old failure', {}))
    await oldFeed.closed
    expect(oldFeed.returned).toBe(true)
    expect(source.getSnapshot()).toBe(current)
    releaseCurrent()
  })

  it.each(['value', 'failure'] as const)('drops old-provider %s frames after replacement', async (kind) => {
    const b = bench()
    const releaseProvider = b.registry.register(b.provider)
    const source = b.registry.source(A)
    const unsubscribe = source.subscribe(() => {})
    const oldFeed = b.last()
    oldFeed.push('old data')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('old data') })
    releaseProvider()
    expect(oldFeed.ctx.signal.aborted).toBe(true)
    expect(source.getSnapshot()).toEqual({ status: 'none', value: undefined, failure: undefined })
    const replacement = scriptedProvider()
    b.registry.register(replacement.provider)
    expect(source.getSnapshot()).toEqual({ status: 'loading', value: undefined, failure: undefined })
    replacement.last().push('replacement data')
    await vi.waitFor(() => { expect(source.getSnapshot().value).toBe('replacement data') })
    const current = source.getSnapshot()
    if (kind === 'value') oldFeed.push('late old data')
    else oldFeed.fail(new RemoteError('gateway/internal', 'late old failure', {}))
    await oldFeed.closed
    expect(oldFeed.returned).toBe(true)
    expect(source.getSnapshot()).toBe(current)
    unsubscribe()
  })

  it('streams another protocol as plain numbers', async () => {
    const b = bench()
    const closed = Promise.withResolvers<undefined>()
    const dispose = b.registry.register({
      protocol: 'counter',
      async *open() {
        try { yield { ok: true as const, value: 1 } } finally { closed.resolve(undefined) }
      },
    })
    onTestFinished(dispose)
    const source = b.registry.source('dsh-resource://counter/one')
    const unsubscribe = source.subscribe(() => {})
    await closed.promise
    expect(source.getSnapshot()).toEqual({ status: 'live', value: 1, failure: undefined })
    unsubscribe()
  })
})
