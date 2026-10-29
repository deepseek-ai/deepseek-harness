import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { runOperationReportJob } from '../src/operation-report-job.ts'

const create = vi.hoisted(() => vi.fn<(...args: unknown[]) => EventEmitter>())
vi.mock('node:worker_threads', () => ({ Worker: function (...args: unknown[]) { return create(...args) } }))
afterEach(() => { vi.useRealTimers(); create.mockReset() })
const input = { reportPath: 'saved.log', directory: 'history',
  limits: { bytes: 65536, recordBytes: 4096, records: 100, outputBytes: 65536 }, journal: null }

it('does not report cancellation complete until the terminated worker exits', async () => {
  vi.useFakeTimers()
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 1) })
  create.mockReturnValue(worker)
  let settled = false
  const result = runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, new AbortController().signal).then((value) => {
    settled = true
    return value
  })
  await vi.advanceTimersByTimeAsync(500)
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)
  worker.emit('exit', 1)
  expect(await result).toEqual({ appended: false, timedOut: true, cancelled: true })
  expect(vi.getTimerCount()).toBe(0)
})

it('requires successful worker exit after the complete append message', async () => {
  vi.useFakeTimers()
  const worker = new EventEmitter()
  create.mockReturnValue(worker)
  const result = runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, new AbortController().signal)
  worker.emit('message', true)
  worker.emit('exit', 0)
  expect(await result).toEqual({ appended: true, timedOut: false, cancelled: false })
  expect(vi.getTimerCount()).toBe(0)
})

it('contains startup and runtime worker failures', async () => {
  create.mockImplementationOnce(() => { throw new Error('worker unavailable') })
  expect(await runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, new AbortController().signal))
    .toEqual({ appended: false, timedOut: false, cancelled: false })
  const worker = new EventEmitter()
  create.mockReturnValue(worker)
  const result = runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, new AbortController().signal)
  worker.emit('error', new Error('collector failed'))
  worker.emit('exit', 1)
  expect(await result).toEqual({ appended: false, timedOut: false, cancelled: false })
})

it('retains ownership after termination rejects until the worker actually exits', async () => {
  vi.useFakeTimers()
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => { throw new Error('termination failed') }) })
  create.mockReturnValue(worker)
  let settled = false
  const result = runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, new AbortController().signal).then((value) => {
    settled = true
    return value
  })
  await vi.advanceTimersByTimeAsync(500)
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)
  worker.emit('exit', 1)
  expect(await result).toEqual({ appended: false, timedOut: true, cancelled: true })
  expect(vi.getTimerCount()).toBe(0)
})


it('allows cooperative exit during the reserved cleanup window', async () => {
  vi.useFakeTimers()
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn() })
  create.mockReturnValue(worker)
  const result = runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, new AbortController().signal)
  await vi.advanceTimersByTimeAsync(400)
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith('cancel')
  expect(worker.terminate).not.toHaveBeenCalled()
  worker.emit('exit', 0)
  expect(await result).toEqual({ appended: false, timedOut: true, cancelled: true })
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels on application shutdown without extending the cleanup window', async () => {
  vi.useFakeTimers()
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 1) })
  create.mockReturnValue(worker)
  const controller = new AbortController()
  const result = runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, controller.signal)
  await vi.advanceTimersByTimeAsync(200)
  controller.abort()
  controller.abort()
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith('cancel')
  await vi.advanceTimersByTimeAsync(100)
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  worker.emit('exit', 1)
  expect(await result).toEqual({ appended: false, timedOut: false, cancelled: true })
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start a collector after shutdown was requested', async () => {
  expect(await runOperationReportJob(input, { timeoutMs: 500, cancellationGraceMs: 100 }, AbortSignal.abort()))
    .toEqual({ appended: false, timedOut: false, cancelled: true })
  expect(create).not.toHaveBeenCalled()
})
