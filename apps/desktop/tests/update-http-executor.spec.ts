import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientRequest } from 'electron'
import { DesktopUpdateHttpExecutor } from '../src/update-http-executor.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function fixture() {
  const request = Object.assign(new EventEmitter(), { abort: vi.fn(() => { request.emit('abort') }) })
  const reject = vi.fn()
  new DesktopUpdateHttpExecutor(1000).addErrorAndTimeoutHandlers(request as unknown as ClientRequest, reject)
  return { request, reject }
}

describe('Electron updater inactivity deadline', () => {
  it('aborts a request that never receives headers without waiting for a Node socket event', async () => {
    const { request, reject } = fixture()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ETIMEDOUT' }))
    expect(request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refreshes the deadline on actual response bytes rather than timing out a long active download', async () => {
    const { request, reject } = fixture()
    const response = new EventEmitter()
    request.emit('response', response)
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(900)
      response.emit('data', Buffer.from('data'))
    }
    expect(reject).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledOnce()
    expect(response.listenerCount('data')).toBe(0)
  })

  it.each(['abort', 'error'])('removes the deadline on request %s', async (event) => {
    const { request, reject } = fixture()
    request.emit(event, new Error('transport failure'))
    const count = reject.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request.abort).not.toHaveBeenCalled()
    expect(reject).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps waiting for headers after Electron closes the request writable stream', async () => {
    const { request, reject } = fixture()
    request.emit('finish')
    request.emit('close')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ETIMEDOUT' }))
  })

  it('does not leave a deadline running while completed bytes undergo verification', async () => {
    const { request, reject } = fixture()
    const response = new EventEmitter()
    request.emit('response', response)
    response.emit('end')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reject).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, 999, 1.5, NaN, 2_147_483_648])('rejects invalid inactivity configuration: %s', (value) => {
    expect(() => new DesktopUpdateHttpExecutor(value)).toThrow('idle timeout')
  })
})
