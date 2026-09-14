import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'

describe('SSH protocol disposal during output backpressure', () => {
  it.each(['peer close', 'output close', 'input EOF'] as const)('settles queued requests after %s without a drain event', async (cause) => {
    const entered = Promise.withResolvers<undefined>()
    const input = new PassThrough()
    let releaseWrite: (() => void) | undefined
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        releaseWrite = callback
        entered.resolve(undefined)
      },
    })
    const peer = new SshRpcPeer(input, output, 4096, 8)
    onTestFinished(() => {
      peer.close()
      releaseWrite?.()
    })
    const first = peer.request('mutate', {}, z.null())
    const second = peer.request('inspect', {}, z.null())
    const rejected = Promise.all([
      expect(first).rejects.toThrow(/unknown|disconnected/),
      expect(second).rejects.toThrow(/unknown|disconnected/),
    ])
    await entered.promise
    expect(output.writableNeedDrain).toBe(true)
    if (cause === 'peer close') peer.close()
    else if (cause === 'output close') output.destroy()
    else input.end()
    await rejected
    expect(output.listenerCount('drain')).toBe(0)
    expect(peer.listenerCount('closed')).toBe(0)
    await expect(peer.request('mutate', {}, z.null())).rejects.toThrow(/unknown|disconnected/)
  })
})
