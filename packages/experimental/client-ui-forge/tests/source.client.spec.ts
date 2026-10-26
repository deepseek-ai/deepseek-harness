import { describe, expect, it, vi } from 'vitest'
import { createNoticeSource, createPanelSource, createVisibilitySource } from '../src/client/source.ts'
import type { PanelStream } from '../src/client/source.ts'
import type { ForgePanelState } from '../src/types.ts'
import { entry, ready, snapshot } from './client-fixtures.client.ts'

/** A stream the test feeds by hand. */
function feed() {
  const queue: ForgePanelState[] = []
  let wake: (() => void) | undefined
  let closed = false
  let failure: unknown
  const stream = {
    signal: undefined as AbortSignal | undefined,
    disposed: vi.fn(),
    push(state: ForgePanelState) { queue.push(state); wake?.() },
    fail(error: unknown) { failure = error; wake?.() },
    close() { closed = true; wake?.() },
    dispose() { stream.disposed(); closed = true; wake?.() },
    async *[Symbol.asyncIterator](): AsyncIterator<ForgePanelState> {
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
  return stream
}

function source() {
  const streams: ReturnType<typeof feed>[] = []
  const resets = new Set<() => void>()
  const panel = createPanelSource({
    open: (signal): PanelStream => {
      const stream = feed()
      stream.signal = signal
      streams.push(stream)
      return stream
    },
    subscribeReset: (listener) => {
      resets.add(listener)
      return () => { resets.delete(listener) }
    },
  })
  return { panel, streams, reset: () => { for (const listener of [...resets]) listener() }, resets }
}

/** Let the stream readers run every iteration that is ready. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('createPanelSource', () => {
  it('opens one stream for all subscribers and closes it with the last one', async () => {
    const { panel, streams, resets } = source()
    const observable = panel.hooks.panel
    expect(streams).toHaveLength(0)
    expect(observable.getSnapshot()).toEqual({ state: null, disconnected: false })
    const seen: unknown[] = []
    const first = observable.subscribe(() => { seen.push(observable.getSnapshot()) })
    const second = observable.subscribe(() => {})
    expect(streams).toHaveLength(1)
    expect(resets.size).toBe(1)

    streams[0]?.push(ready())
    await vi.waitFor(() => { expect(seen).toEqual([{ state: ready(), disconnected: false }]) })
    first()
    expect(streams[0]?.disposed).not.toHaveBeenCalled()
    second()
    expect(streams[0]?.disposed).toHaveBeenCalled()
    expect(streams[0]?.signal?.aborted).toBe(true)
    expect(resets.size).toBe(0)
    expect(observable.getSnapshot()).toEqual({ state: ready(), disconnected: false })

    const again = observable.subscribe(() => {})
    expect(streams).toHaveLength(2)
    again()
  })

  it('publishes every state of the running stream in order', async () => {
    const { panel, streams } = source()
    const seen: (ForgePanelState | null)[] = []
    const unsubscribe = panel.hooks.panel.subscribe(() => { seen.push(panel.hooks.panel.getSnapshot().state) })
    const later = ready({ changeRequests: [entry(1, snapshot(1))] })

    streams[0]?.push(ready())
    streams[0]?.push(later)
    await vi.waitFor(() => { expect(seen).toEqual([ready(), later]) })
    unsubscribe()
  })

  it('ignores frames from a stream it closed', async () => {
    const { panel, streams } = source()
    const unsubscribe = panel.hooks.panel.subscribe(() => {})
    const stream = streams[0]
    unsubscribe()
    stream?.push(ready({ directory: '/late' }))
    await settle()

    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: null, disconnected: false })
  })

  it.each([
    ['ends', (stream: ReturnType<typeof feed>) => { stream.close() }],
    ['fails', (stream: ReturnType<typeof feed>) => { stream.fail(new Error('lost')) }],
  ])('marks the snapshot disconnected when the stream %s and reopens on demand', async (_label, end) => {
    const { panel, streams } = source()
    const unsubscribe = panel.hooks.panel.subscribe(() => {})
    streams[0]?.push(ready())
    await vi.waitFor(() => { expect(panel.hooks.panel.getSnapshot().state).not.toBeNull() })

    end(streams[0]!)
    await vi.waitFor(() => { expect(panel.hooks.panel.getSnapshot().disconnected).toBe(true) })
    expect(panel.hooks.panel.getSnapshot().state).toEqual(ready())
    panel.reconnect()
    expect(streams).toHaveLength(2)
    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: ready(), disconnected: false })
    panel.reconnect()
    expect(streams).toHaveLength(2)
    unsubscribe()
    panel.reconnect()
    expect(streams).toHaveLength(2)
  })

  it('lets the next subscriber reopen a stream that ended after the last one left', async () => {
    const { panel, streams, resets } = source()
    const unsubscribe = panel.hooks.panel.subscribe(() => {})
    streams[0]?.push(ready())
    streams[0]?.close()
    await vi.waitFor(() => { expect(panel.hooks.panel.getSnapshot()).toEqual({ state: ready(), disconnected: true }) })

    unsubscribe()
    expect(resets.size).toBe(0)
    expect(streams[0]?.disposed).not.toHaveBeenCalled()
    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: ready(), disconnected: true })

    const again = panel.hooks.panel.subscribe(() => {})
    expect(streams).toHaveLength(2)
    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: ready(), disconnected: false })
    again()
  })

  it('replaces the stream after a transport reset and ignores the replaced one', async () => {
    const { panel, streams, reset } = source()
    const unsubscribe = panel.hooks.panel.subscribe(() => {})

    reset()

    expect(streams).toHaveLength(2)
    expect(streams[0]?.disposed).toHaveBeenCalled()
    expect(streams[0]?.signal?.aborted).toBe(true)
    streams[0]?.push(ready({ directory: '/stale' }))
    await settle()
    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: null, disconnected: false })
    streams[1]?.push(ready())
    await vi.waitFor(() => { expect(panel.hooks.panel.getSnapshot()).toEqual({ state: ready(), disconnected: false }) })
    unsubscribe()
  })

  it('reopens a stream that ended when the transport resets', async () => {
    const { panel, streams, reset } = source()
    const unsubscribe = panel.hooks.panel.subscribe(() => {})
    streams[0]?.fail(new Error('lost'))
    await vi.waitFor(() => { expect(panel.hooks.panel.getSnapshot().disconnected).toBe(true) })

    reset()

    expect(streams).toHaveLength(2)
    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: null, disconnected: false })
    unsubscribe()
  })

  it('closes the stream and drops every subscriber on close', async () => {
    const { panel, streams, resets } = source()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = panel.hooks.panel.subscribe(first)
    panel.hooks.panel.subscribe(second)

    panel.close()

    expect(streams).toHaveLength(1)
    expect(streams[0]?.disposed).toHaveBeenCalledOnce()
    expect(streams[0]?.signal?.aborted).toBe(true)
    expect(resets.size).toBe(0)
    panel.reconnect()
    expect(streams).toHaveLength(1)
    unsubscribe()
    panel.close()
    streams[0]?.push(ready())
    await settle()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(streams[0]?.disposed).toHaveBeenCalledOnce()
    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: null, disconnected: false })
  })

  it('closes a source nobody subscribed to', () => {
    const { panel, streams } = source()
    panel.close()
    expect(streams).toHaveLength(0)
    expect(panel.hooks.panel.getSnapshot()).toEqual({ state: null, disconnected: false })
  })
})

describe('createNoticeSource', () => {
  it('publishes numbered failure notices without values or undo by default, and their dismissal', () => {
    const notices = createNoticeSource()
    expect(notices.hooks.notice.getSnapshot()).toBeNull()
    const seen: unknown[] = []
    const unsubscribe = notices.hooks.notice.subscribe(() => { seen.push(notices.hooks.notice.getSnapshot()) })

    notices.report('toast.refreshFailed')
    notices.report('toast.refreshFailed')
    notices.dismiss()
    unsubscribe()
    notices.report('toast.copyFailed')

    const failure = { key: 'toast.refreshFailed', params: {}, tone: 'failure', undo: undefined }
    expect(seen).toEqual([{ ...failure, seq: 1 }, { ...failure, seq: 2 }, null])
    expect(notices.hooks.notice.getSnapshot()).toEqual({ ...failure, key: 'toast.copyFailed', seq: 3 })
  })

  it('carries the tone, values, and undo action a report names', () => {
    const notices = createNoticeSource()
    const undo = vi.fn()

    notices.report('toast.removed', { tone: 'success', params: { name: '#7' }, undo })

    expect(notices.hooks.notice.getSnapshot()).toEqual({ key: 'toast.removed', params: { name: '#7' }, tone: 'success', undo, seq: 1 })
    expect(undo).not.toHaveBeenCalled()
  })
})

describe('createVisibilitySource', () => {
  it('starts hidden and notifies only when the visibility changes', () => {
    const visibility = createVisibilitySource()
    const listener = vi.fn()
    const unsubscribe = visibility.hooks.visible.subscribe(listener)
    expect(visibility.hooks.visible.getSnapshot()).toBe(false)

    visibility.set(false)
    expect(listener).not.toHaveBeenCalled()
    visibility.set(true)
    visibility.set(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(visibility.hooks.visible.getSnapshot()).toBe(true)

    unsubscribe()
    visibility.set(false)
    expect(listener).toHaveBeenCalledOnce()
    expect(visibility.hooks.visible.getSnapshot()).toBe(false)
  })
})
