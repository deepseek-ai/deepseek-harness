import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setTimeout } from 'node:timers/promises'
import { logoutAccount } from '../src/protocol.ts'
import { revokeAccount } from '../src/logout.ts'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }))
vi.mock('../src/protocol.ts', () => ({ logoutAccount: vi.fn() }))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(setTimeout).mockResolvedValue(undefined)
})
afterEach(() => { vi.restoreAllMocks() })

const policy = { maxRetries: 5, delayMs: 1_000, requestTimeoutMs: 30_000 }

it('stops after one successful request without waiting', async () => {
  await revokeAccount('https://platform.deepseek.com', 'old-token', policy, new AbortController().signal, {})
  expect(logoutAccount).toHaveBeenCalledTimes(1)
  expect(setTimeout).not.toHaveBeenCalled()
})

it('makes at most six requests with five exponentially increasing delays and the captured token', async () => {
  vi.mocked(logoutAccount).mockRejectedValue(new Error('unavailable'))
  const controller = new AbortController()
  const headers = { cookie: 'test-gate' }
  await expect(revokeAccount('https://platform.deepseek.com', 'old-token', policy, controller.signal, headers))
    .resolves.toBeUndefined()
  expect(logoutAccount).toHaveBeenCalledTimes(6)
  expect(vi.mocked(setTimeout).mock.calls.map(args => args[0])).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  for (const args of vi.mocked(logoutAccount).mock.calls) {
    expect(args).toEqual(['https://platform.deepseek.com', 'old-token', expect.any(AbortSignal), headers])
  }
})

it('stops retrying as soon as a request succeeds', async () => {
  vi.mocked(logoutAccount).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  await revokeAccount('https://platform.deepseek.com', 'old-token', policy, new AbortController().signal, {})
  expect(logoutAccount).toHaveBeenCalledTimes(2)
  expect(setTimeout).toHaveBeenCalledTimes(1)
})

it('honors a disabled retry policy', async () => {
  vi.mocked(logoutAccount).mockRejectedValue(new Error('offline'))
  await revokeAccount('https://platform.deepseek.com', 'old-token', { ...policy, maxRetries: 0 }, new AbortController().signal, {})
  expect(logoutAccount).toHaveBeenCalledTimes(1)
  expect(setTimeout).not.toHaveBeenCalled()
})

it('cancels an in-flight request when the provider closes', async () => {
  const controller = new AbortController()
  vi.mocked(logoutAccount).mockImplementation((_origin, _token, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    controller.abort()
  }))
  await revokeAccount('https://platform.deepseek.com', 'old-token', policy, controller.signal, {})
  expect(logoutAccount).toHaveBeenCalledTimes(1)
  expect(setTimeout).not.toHaveBeenCalled()
})

it('cancels a pending delay and never starts another request', async () => {
  const controller = new AbortController()
  vi.mocked(logoutAccount).mockRejectedValue(new Error('offline'))
  vi.mocked(setTimeout).mockImplementation(async (_delay, _value, options) => {
    expect(options?.signal).toBe(controller.signal)
    controller.abort()
    throw controller.signal.reason
  })
  await revokeAccount('https://platform.deepseek.com', 'old-token', policy, controller.signal, {})
  expect(logoutAccount).toHaveBeenCalledTimes(1)
})

it('does not start work for an already closed provider', async () => {
  await revokeAccount('https://platform.deepseek.com', 'old-token', policy, AbortSignal.abort(), {})
  expect(logoutAccount).not.toHaveBeenCalled()
})
