/** Whole-window scheduling stays serial while view changes remain synchronous. */
import { afterEach, expect, test, vi } from 'vitest'
import { ViewportRenderer, renderWindow } from '../src/client/viewport-renderer.ts'
import type { FrameForwardingViewport } from '@deepseek-ai/dsh-frame-forwarding/types'

const settings = { operationTimeoutMs: 30000, overscanViewports: 0.5, reanchorHysteresis: 0.25, zoomSettleMs: 120, creditRetryLimit: 3,
  maxPagePreviewBytes: 1048576 }
const demand = { view: { x: 0, y: 10000, scale: 1 / 15 }, width: 800, height: 500, deviceScale: 2,
  document: { width: 100000, height: 100000 }, part: 0, visible: true }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture(overrides: Partial<typeof settings> = {}) {
  let viewport: FrameForwardingViewport = { version: 1, width: 1600, height: 1000, deviceScaleFactor: 2, visible: true }
  let window = ''
  const pending: ReturnType<typeof Promise.withResolvers<undefined>>[] = [], order: string[] = []
  type Owner = ConstructorParameters<typeof ViewportRenderer>[2]
  const owner = {
    setView: vi.fn(), setWindow: vi.fn<Owner['setWindow']>(async (value) => {
      order.push('window'); const key = JSON.stringify(value)
      if (window !== key) { window = key; viewport = { ...viewport, version: viewport.version + 1 } }
      return viewport
    }), viewport: () => viewport, ready: vi.fn(async () => {}),
    paint: vi.fn<Owner['paint']>(async () => { order.push('paint'); const task = Promise.withResolvers<undefined>(); pending.push(task); await task.promise; order.push('resolved') }),
    retry: (error: unknown) => error instanceof Error && error.message === 'stale' ? 'stale' : error instanceof Error && error.message === 'credit' ? 'credit' : undefined,
    rebuild: vi.fn(async () => {}), waiting: vi.fn(), failure: vi.fn(),
  } satisfies Owner
  const renderer = new ViewportRenderer({ ...settings, ...overrides }, 1000, owner)
  return { renderer, owner, pending, order, viewport: () => viewport,
    visibility: (visible: boolean) => { viewport = { ...viewport, visible }; renderer.viewportChanged() },
    resize: () => { viewport = { ...viewport, version: viewport.version + 1 }; renderer.viewportChanged() } }
}

test('scroll within overscan only updates view; newest out-of-window demand waits for paint then reanchors', async () => {
  const f = fixture()
  f.renderer.update(demand); await drain()
  expect(f.owner.paint).toHaveBeenCalledOnce()
  f.renderer.update({ ...demand, view: { ...demand.view, y: 10500 } })
  f.renderer.update({ ...demand, view: { ...demand.view, y: 22000 } })
  f.renderer.update({ ...demand, view: { ...demand.view, y: 33000 } })
  expect(f.owner.setView).toHaveBeenCalledTimes(4)
  expect(f.owner.setWindow).toHaveBeenCalledOnce()
  f.pending[0]!.resolve(undefined); await drain()
  expect(f.order).toEqual(['window', 'paint', 'resolved', 'window', 'paint'])
  expect(vi.mocked(f.owner.paint).mock.calls[1]![0].y).toBeGreaterThan(22000)
  f.pending[1]!.resolve(undefined); await drain()
  f.renderer.update({ ...demand, view: { ...demand.view, y: 33500 } }); await drain()
  expect(f.owner.paint).toHaveBeenCalledTimes(2)
  await f.renderer.stop()
})

test('hysteresis reanchors before the overscan edge and invalidation repaints the same generation', async () => {
  const f = fixture()
  f.renderer.update(demand); await drain(); f.pending[0]!.resolve(undefined); await drain()
  const first = f.viewport().version
  f.renderer.invalidate({ x: 99999, y: 99999, width: 1, height: 1 }); await drain()
  expect(f.owner.paint).toHaveBeenCalledOnce()
  f.renderer.invalidate({ x: 0, y: 10000, width: 1, height: 1 }); await drain()
  expect(vi.mocked(f.owner.paint).mock.calls[1]![1]).toBe(first)
  f.pending[1]!.resolve(undefined); await drain()
  f.renderer.update({ ...demand, view: { ...demand.view, y: 12900 } }); await drain()
  expect(f.viewport().version).toBeGreaterThan(first)
  f.pending[2]!.resolve(undefined); await f.renderer.stop()
})

test('window acknowledgement precedes paint and a mount resize requests its acknowledged version', async () => {
  const f = fixture(), gate = Promise.withResolvers<FrameForwardingViewport>()
  vi.mocked(f.owner.setWindow).mockReturnValueOnce(gate.promise)
  f.renderer.update(demand); await drain()
  expect(f.owner.paint).not.toHaveBeenCalled()
  gate.resolve(f.viewport()); await drain()
  f.resize(); expect(f.owner.paint).toHaveBeenCalledOnce()
  f.pending[0]!.resolve(undefined); await drain()
  expect(vi.mocked(f.owner.paint).mock.calls[1]![1]).toBe(f.viewport().version)
  f.pending[1]!.resolve(undefined); await f.renderer.stop()
})

test.each([1, 2, 3])('Kit edge bounds reduce overscan then DPR at device scale %s', (deviceScale) => {
  for (const [width, height] of [[800, 500], [2560, 1600], [3200, 4000], [8192, 8192]]) {
    const plan = renderWindow({ ...demand, width: width!, height: height!, deviceScale }, settings.overscanViewports)
    expect(plan.pixelWidth).toBeLessThanOrEqual(4096); expect(plan.pixelHeight).toBeLessThanOrEqual(4096)
    if (width! * deviceScale > 4096 || height! * deviceScale > 4096) expect(plan.deviceScale).toBeLessThan(deviceScale)
  }
  const zero = renderWindow({ ...demand, width: 4096, height: 4096, deviceScale: 1 }, 0.5)
  expect([zero.marginX, zero.marginY]).toEqual([0, 0])
})

test('zoom updates view immediately but painting waits for the configured settling time', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.renderer.update(demand); await drain(); f.pending[0]!.resolve(undefined); await drain()
  f.renderer.update({ ...demand, view: { ...demand.view, scale: 2 / 15 } }); await drain()
  await vi.advanceTimersByTimeAsync(119); expect(f.owner.paint).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1); expect(f.owner.paint).toHaveBeenCalledTimes(2)
  f.pending[1]!.resolve(undefined); await f.renderer.stop()
})

test('hidden and failed renderers keep view synchronized without new paints', async () => {
  const f = fixture()
  f.renderer.update({ ...demand, visible: false }); await drain(); expect(f.owner.paint).not.toHaveBeenCalled()
  f.renderer.update(demand); await drain(); f.pending[0]!.reject(new Error('engine stopped')); await drain()
  expect(f.owner.failure).toHaveBeenCalledOnce()
  f.renderer.update({ ...demand, view: { ...demand.view, scale: 0.77 / 15 }, width: 657 }); await drain()
  expect(f.owner.setView).toHaveBeenLastCalledWith({ ...demand.view, scale: 0.77 / 15 })
  expect(f.owner.paint).toHaveBeenCalledOnce()
  await f.renderer.stop()
})

test('credit timeout uses backoff and rebuilds only at the configured limit; stale errors retry without failure', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.renderer.update(demand); await drain()
  for (let i = 0; i < 3; i++) {
    f.pending[i]!.reject(new Error('credit')); await drain()
    expect(f.owner.rebuild).toHaveBeenCalledTimes(i === 2 ? 1 : 0)
    await vi.advanceTimersByTimeAsync(1000)
  }
  f.pending[3]!.reject(new Error('stale')); await drain(); await vi.advanceTimersByTimeAsync(120)
  expect(f.owner.failure).not.toHaveBeenCalled()
  expect(f.owner.waiting).toHaveBeenCalledWith(true)
  f.pending[4]!.resolve(undefined); await f.renderer.stop()
})

test('stop joins admitted paint and discards unsent demand', async () => {
  const f = fixture(); f.renderer.update(demand); await drain()
  f.renderer.update({ ...demand, view: { ...demand.view, y: 50000 } })
  let done = false; const stopped = f.renderer.stop().then(() => { done = true })
  await drain(); expect(done).toBe(false)
  f.pending[0]!.resolve(undefined); await stopped
  expect(f.owner.paint).toHaveBeenCalledOnce()
})

test('stale retry yields at least one millisecond when zoom settling is disabled', async () => {
  vi.useFakeTimers()
  const f = fixture({ zoomSettleMs: 0 })
  try {
    f.renderer.update(demand); await drain()
    f.pending[0]?.reject(new Error('stale')); await drain()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.owner.paint).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.owner.paint).toHaveBeenCalledTimes(2)
  } finally {
    for (const task of f.pending) task.resolve(undefined)
    await f.renderer.stop()
  }
})

test.each(['disabled', 'hidden', 'viewport-hidden', 'stopped'] as const)(
  'credit waiting clears when a retry is %s and resumes only with visible enabled demand', async (pause) => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      f.renderer.update(demand); await drain()
      f.pending[0]?.reject(new Error('credit')); await drain()
      expect(f.owner.waiting).toHaveBeenLastCalledWith(true)
      if (pause === 'disabled') f.renderer.enable(false)
      else if (pause === 'hidden') f.renderer.update({ ...demand, visible: false })
      else if (pause === 'viewport-hidden') f.visibility(false)
      else await f.renderer.stop()
      expect(f.owner.waiting).toHaveBeenLastCalledWith(false)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.owner.paint).toHaveBeenCalledOnce()
      if (pause === 'disabled') f.renderer.enable(true)
      else if (pause === 'hidden') f.renderer.update(demand)
      else if (pause === 'viewport-hidden') f.visibility(true)
      await drain()
      expect(f.owner.paint).toHaveBeenCalledTimes(pause === 'stopped' ? 1 : 2)
    } finally {
      for (const task of f.pending) task.resolve(undefined)
      await f.renderer.stop()
    }
  },
)

test.each(['disabled', 'hidden', 'viewport-hidden'] as const)(
  'credit rebuild settling after %s does not revive waiting or a retry timer', async (pause) => {
    vi.useFakeTimers()
    const f = fixture({ creditRetryLimit: 1 }), rebuild = Promise.withResolvers<undefined>()
    vi.mocked(f.owner.rebuild).mockReturnValueOnce(rebuild.promise)
    try {
      f.renderer.update(demand); await drain()
      f.pending[0]?.reject(new Error('credit')); await drain()
      expect(f.owner.rebuild).toHaveBeenCalledOnce()
      if (pause === 'disabled') f.renderer.enable(false)
      else if (pause === 'hidden') f.renderer.update({ ...demand, visible: false })
      else f.visibility(false)
      rebuild.resolve(undefined); await drain()
      expect(f.owner.waiting).toHaveBeenLastCalledWith(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(f.owner.paint).toHaveBeenCalledOnce()
    } finally {
      rebuild.resolve(undefined)
      for (const task of f.pending) task.resolve(undefined)
      await f.renderer.stop()
    }
  },
)

test.each(['disabled', 'hidden'] as const)('an in-flight credit retry rejected after %s cannot restore waiting', async (pause) => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.renderer.update(demand); await drain()
    f.pending[0]?.reject(new Error('credit')); await drain()
    await vi.advanceTimersByTimeAsync(240)
    expect(f.owner.paint).toHaveBeenCalledTimes(2)
    if (pause === 'disabled') f.renderer.enable(false)
    else f.renderer.update({ ...demand, visible: false })
    f.pending[1]?.reject(new Error('credit')); await drain()
    expect(f.owner.waiting).toHaveBeenLastCalledWith(false)
    expect(f.owner.failure).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    for (const task of f.pending) task.resolve(undefined)
    await f.renderer.stop()
  }
})


test.each(['window', 'ready'] as const)('stop during the %s acknowledgement prevents paint and later updates', async (phase) => {
  const f = fixture(), gate = Promise.withResolvers<undefined>()
  if (phase === 'window') f.owner.setWindow.mockImplementationOnce(async () => { await gate.promise; return f.viewport() })
  else f.owner.ready.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await gate.promise })
  try {
    f.renderer.update(demand); await drain()
    const stop = f.renderer.stop()
    gate.resolve(undefined); await stop
    f.renderer.update(demand)
    expect(f.owner.paint).not.toHaveBeenCalled()
    expect(f.owner.setView).toHaveBeenCalledOnce()
  } finally { gate.resolve(undefined); await f.renderer.stop() }
})

test.each([false, true])('failed credit reclamation stops retries and only reports to a live mount (stopped=%s)', async (stopped) => {
  const f = fixture({ creditRetryLimit: 1 }), failure = new Error('reclamation failed')
  const reclaim = Promise.withResolvers<undefined>()
  f.owner.rebuild.mockReturnValueOnce(reclaim.promise)
  try {
    f.renderer.update(demand); await drain()
    f.pending[0]!.reject(new Error('credit')); await drain()
    expect(f.owner.rebuild).toHaveBeenCalledOnce()
    const stop = stopped ? f.renderer.stop() : undefined
    reclaim.reject(failure); await drain(); await stop
    if (stopped) expect(f.owner.failure).not.toHaveBeenCalled()
    else expect(f.owner.failure).toHaveBeenCalledExactlyOnceWith(failure)
    f.renderer.invalidate(); await drain()
    expect(f.owner.paint).toHaveBeenCalledOnce()
  } finally {
    reclaim.resolve(undefined)
    for (const task of f.pending) task.resolve(undefined)
    await f.renderer.stop()
  }
})

/** Paint the first window and settle it; later paints resolve through `settle`. */
async function painted(f: ReturnType<typeof fixture>) {
  f.renderer.update(demand); await drain(); f.pending[0]!.resolve(undefined); await drain()
  const settle = async () => { for (const task of f.pending) task.resolve(undefined); await drain() }
  return settle
}

test('presentation failures repaint at once, then with shared backoff, and the fourth without a new image fails once', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture(), error = new Error('frame transfer failed')
  // A fixed clock keeps every failure inside the failure window however long the worker pauses.
  vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    const settle = await painted(f)
    f.renderer.presented()
    f.renderer.presentationFailed(error); await drain()
    expect(f.owner.paint).toHaveBeenCalledTimes(2)
    await settle()
    f.renderer.presentationFailed(error); f.renderer.presentationFailed(error); await drain()
    await vi.advanceTimersByTimeAsync(249)
    expect(f.owner.paint).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); await drain()
    expect(f.owner.paint).toHaveBeenCalledTimes(3)
    await settle()
    f.renderer.presentationFailed(error)
    expect(f.owner.failure).toHaveBeenCalledExactlyOnceWith(error)
    f.renderer.presentationFailed(error); f.renderer.invalidate(); await drain()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.owner.failure).toHaveBeenCalledOnce()
    expect(f.owner.paint).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  } finally { for (const task of f.pending) task.resolve(undefined); await f.renderer.stop() }
})

test('same-generation track writes reset each presentation failure within the retry window', async () => {
  const f = fixture(), error = new Error('frame transfer failed')
  vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    const settle = await painted(f), generation = f.viewport().version
    for (let attempt = 1; attempt <= 5; attempt++) {
      f.renderer.presentationFailed(error); await drain(); await settle()
      expect(f.owner.paint).toHaveBeenCalledTimes(1 + attempt)
      expect(f.viewport().version).toBe(generation)
      f.renderer.presented()
    }
    expect(f.owner.failure).not.toHaveBeenCalled()
  } finally { for (const task of f.pending) task.resolve(undefined); await f.renderer.stop() }
})

test('a track write or a quiet period restarts the presentation failure count', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture(), error = new Error('frame transfer failed')
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const settle = await painted(f)
    f.renderer.presented()
    for (const reset of [() => { f.renderer.presented() }, () => { now += 10_001 }]) {
      for (let failure = 0; failure < 3; failure++) f.renderer.presentationFailed(error)
      await drain(); await settle()
      const before = vi.mocked(f.owner.paint).mock.calls.length
      reset(); await drain(); await settle()
      f.renderer.presentationFailed(error); await drain(); await settle()
      expect(vi.mocked(f.owner.paint).mock.calls.length).toBeGreaterThan(before)
      expect(f.owner.failure).not.toHaveBeenCalled()
      now += 10_001
    }
    f.renderer.presentationFailed(error); f.renderer.presentationFailed(error)
    expect(vi.getTimerCount()).toBe(1)
    await f.renderer.stop()
    expect(vi.getTimerCount()).toBe(0)
    f.renderer.presentationFailed(error)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.owner.failure).not.toHaveBeenCalled()
  } finally { for (const task of f.pending) task.resolve(undefined); await f.renderer.stop() }
})
