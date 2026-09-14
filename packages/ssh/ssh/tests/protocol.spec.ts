import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer, RemoteOperationError } from '../src/protocol.ts'

describe('SSH helper protocol', () => {
  it('validates responses and retains typed operation errors', async () => {
    const inbound = new PassThrough()
    const outbound = new PassThrough()
    const server = new SshRpcPeer(outbound, inbound, 4096, 8, async (method, raw) => {
      if (method === 'write') throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
      return z.object({ value: z.string() }).parse(raw).value
    })
    const client = new SshRpcPeer(inbound, outbound, 4096, 8)
    try {
      await expect(client.request('echo', { value: 'a\0b\n中文' }, z.string())).resolves.toBe('a\0b\n中文')
      await expect(client.request('write', {}, z.null())).rejects.toMatchObject({ code: 'FS_STALE_VERSION', message: 'stale' })
      await expect(client.request('echo', { value: 'not a number' }, z.number())).rejects.toThrow()
    } finally { client.close(); server.close() }
  })

  it('rejects excessive lengths before waiting for the payload', async () => {
    const inbound = new PassThrough()
    const outbound = new PassThrough()
    const client = new SshRpcPeer(inbound, outbound, 64, 2)
    const closed = once(client, 'closed')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(65)
    inbound.write(header)
    await expect(closed).resolves.toEqual([expect.objectContaining({ message: 'SSH helper sent an invalid frame length' })])
  })

  it('cancels an admitted operation without replaying it', async () => {
    const inbound = new PassThrough()
    const outbound = new PassThrough()
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    let calls = 0
    const server = new SshRpcPeer(outbound, inbound, 4096, 8, async (_method, _raw, signal) => {
      calls++
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(undefined)
      await aborted.promise
      return null
    })
    const client = new SshRpcPeer(inbound, outbound, 4096, 8)
    const controller = new AbortController()
    try {
      const response = client.request('mutate', {}, z.null(), controller.signal)
      const rejection = expect(response).rejects.toThrow('not rolled back')
      await entered.promise
      controller.abort()
      await rejection
      await aborted.promise
      expect(calls).toBe(1)
    } finally { client.close(); server.close() }
  })

  it('reports an unknown outcome when a connection disappears after admission', async () => {
    const inbound = new PassThrough()
    const outbound = new PassThrough()
    const entered = Promise.withResolvers<undefined>()
    const server = new SshRpcPeer(outbound, inbound, 4096, 8, async (_method, _raw, signal) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      return null
    })
    const client = new SshRpcPeer(inbound, outbound, 4096, 8)
    const pending = client.request('write', {}, z.null())
    const rejection = expect(pending).rejects.toThrow('unknown')
    await entered.promise
    client.close()
    server.close()
    await rejection
    expect(new RemoteOperationError('remote failure', 'FS_IO_ERROR').code).toBe('FS_IO_ERROR')
  })
})
