// @vitest-environment jsdom
/** Reading one Host stream from React: frames, key changes, retries, transport resets, and the reason a stream stopped. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { useHostStream } from '../src/client/review-page/host-stream.ts'
import type { HostStream } from '../src/client/source.ts'
import { fed, type Fed } from './review-fixtures.client.ts'

afterEach(cleanup)

/** Let the stream's loop take what was fed. */
async function flush(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

function harness(initialKey: string | null) {
  const streams: Fed<number>[] = []
  const open = vi.fn((key: string, signal: AbortSignal): HostStream<number> => {
    const stream = fed<number>(key, signal)
    streams.push(stream)
    return stream
  })
  const resets = new Set<() => void>()
  const unsubscribe = vi.fn()
  const subscribeReset = vi.fn((listener: () => void) => {
    resets.add(listener)
    return () => { unsubscribe(); resets.delete(listener) }
  })
  const hook = renderHook(({ key }: { key: string | null }) => useHostStream(open, key, subscribeReset), {
    initialProps: { key: initialKey },
  })
  const latest = (): Fed<number> => {
    const stream = streams.at(-1)
    if (stream === undefined) throw new Error('no stream opened')
    return stream
  }
  return { hook, streams, open, latest, resets, unsubscribe }
}

describe('useHostStream', () => {
  it('reads nothing without a key', () => {
    const h = harness(null)
    expect(h.open).not.toHaveBeenCalled()
    expect(h.hook.result.current).toMatchObject({ frame: undefined, stopped: null })
  })

  it('keeps the latest frame and reports a stream the Host ended, keeping its last frame', async () => {
    const h = harness('a')
    expect(h.open).toHaveBeenCalledWith('a', h.latest().signal)
    expect(h.hook.result.current.frame).toBeUndefined()
    h.latest().push(1)
    h.latest().push(2)
    await flush()
    expect(h.hook.result.current).toMatchObject({ frame: 2, stopped: null })
    h.latest().end()
    await flush()
    expect(h.hook.result.current).toMatchObject({ frame: 2, stopped: { code: 'ended', message: '' } })
  })

  it('names the Remote error code of a failed stream, and the message of any other failure', async () => {
    const h = harness('a')
    h.latest().fail(new RemoteError('forgePanel/unrecognized-url', 'no provider serves it', {}))
    await flush()
    expect(h.hook.result.current).toMatchObject({
      frame: undefined, stopped: { code: 'forgePanel/unrecognized-url', message: 'no provider serves it' },
    })
    act(() => { h.hook.result.current.retry() })
    h.latest().push(3)
    h.latest().fail(new Error('socket closed'))
    await flush()
    expect(h.hook.result.current).toMatchObject({ frame: 3, stopped: { code: 'ended', message: 'socket closed' } })
    act(() => { h.hook.result.current.retry() })
    h.latest().fail('gone')
    await flush()
    expect(h.hook.result.current.stopped).toEqual({ code: 'ended', message: 'gone' })
  })

  it('closes the open stream for a new key and shows no frame of the old key, then ignores what the closed stream delivers', async () => {
    const h = harness('a')
    const first = h.latest()
    first.push(1)
    await flush()
    h.hook.rerender({ key: 'b' })
    expect(first.disposed).toHaveBeenCalledOnce()
    expect(first.signal.aborted).toBe(true)
    expect(h.latest().key).toBe('b')
    expect(h.hook.result.current).toMatchObject({ frame: undefined, stopped: null })
    first.push(9)
    await flush()
    expect(h.hook.result.current).toMatchObject({ frame: undefined, stopped: null })
    h.latest().push(5)
    await flush()
    expect(h.hook.result.current.frame).toBe(5)
  })

  it('ignores the end or failure of a stream it closed', async () => {
    const h = harness('a')
    const first = h.latest()
    h.hook.rerender({ key: 'b' })
    const second = h.latest()
    h.hook.rerender({ key: null })
    first.end()
    second.fail(new Error('late'))
    await flush()
    expect(h.hook.result.current).toMatchObject({ frame: undefined, stopped: null })
  })

  it('opens the stream again on retry and after a transport reset, keeping the frame of its key, and closes it on unmount', async () => {
    const h = harness('a')
    h.latest().push(1)
    await flush()
    act(() => { h.hook.result.current.retry() })
    expect(h.streams).toHaveLength(2)
    expect(h.streams[0]?.disposed).toHaveBeenCalledOnce()
    expect(h.hook.result.current).toMatchObject({ frame: 1, stopped: null })
    act(() => { for (const listener of h.resets) listener() })
    expect(h.streams).toHaveLength(3)
    h.hook.unmount()
    expect(h.streams[2]?.disposed).toHaveBeenCalledOnce()
    expect(h.streams[2]?.signal.aborted).toBe(true)
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })
})
