/**
 * The owner gateway entry: it boots the worker only when the host that spawned it provided the IPC
 * channel, and refuses loudly when the entry was started without one.
 *
 * The worker module is mocked: this spec covers the entry's own boot decision, not the socket work
 * `runGatewayWorker` does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const runGatewayWorker = vi.hoisted(() => vi.fn())

vi.mock('../src/owner-gateway/worker.ts', () => ({ runGatewayWorker }))

// Bracket access keeps the reference out of the unbound-method lint rule.
const originalSend = process['send']

afterEach(() => {
  Object.defineProperty(process, 'send', { value: originalSend, configurable: true, writable: true })
  vi.resetModules()
  runGatewayWorker.mockClear()
})

/** Install the IPC channel a spawned worker would have, or its absence. */
function stubIpcChannel(send: ((event: unknown) => void) | undefined): void {
  Object.defineProperty(process, 'send', { value: send, configurable: true, writable: true })
}

describe('owner gateway entry', () => {
  it('refuses to boot when it was started without the IPC channel the host owns', async () => {
    stubIpcChannel(undefined)
    vi.resetModules()

    await expect(import('../src/owner-gateway/cli.ts')).rejects
      .toThrow('Liveshare gateway requires the owner worker IPC channel')
    expect(runGatewayWorker).not.toHaveBeenCalled()
  })

  it('runs the worker once the host provided its IPC channel', async () => {
    stubIpcChannel(vi.fn())
    vi.resetModules()

    await import('../src/owner-gateway/cli.ts')

    expect(runGatewayWorker).toHaveBeenCalledOnce()
  })
})
