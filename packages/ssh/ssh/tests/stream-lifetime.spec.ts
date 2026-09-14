/** Cancellation stays with TLS after it takes ownership of the underlying socket. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { authenticateStream } from '../src/stream-security.ts'

describe('SSH TLS cancellation ownership', () => {
  it('cancels an authenticated stream before closing its underlying socket', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-tls-life-')
    const owner = new RemoteProcesses(new Context(), root, 1, 5000)
    try {
      const prepared = await owner.prepare({ argv: ['true'], cwd: root, graceMs: 100, terminal: { terminalType: 'dumb', rows: 24, cols: 80 } })
      const endpoint = prepared.streams.terminal!
      const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
      raw.on('error', () => {})
      await once(raw, 'connect')
      const controller = new AbortController()
      const stream = await authenticateStream(raw, endpoint.capability, 5000, controller.signal)
      stream.on('error', () => {})
      const closed = new Promise<void>((resolve) => { stream.once('close', () => { resolve() }) })
      const rawClosed = new Promise<void>((resolve) => { raw.once('close', () => { resolve() }) })
      controller.abort(new Error('stream lifetime ended'))
      await Promise.all([closed, rawClosed])
      expect(stream.destroyed).toBe(true)
      expect(raw.destroyed).toBe(true)
    } finally { await owner.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('cancels TLS authentication with an arbitrary caller reason (already aborted: %s)', async (alreadyAborted) => {
    const peers = new Set<Socket>()
    const server = createServer((socket) => {
      peers.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => { peers.delete(socket) })
      socket.resume()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test listener')
    const raw = createConnection(address.port, '127.0.0.1')
    raw.on('error', () => {})
    try {
      await once(raw, 'connect')
      const closed = new Promise<void>((resolve) => { raw.once('close', () => { resolve() }) })
      const controller = new AbortController()
      if (alreadyAborted) controller.abort('caller stopped')
      const result = authenticateStream(raw, 'a'.repeat(64), 5000, controller.signal)
      const rejected = alreadyAborted
        ? expect(result).rejects.toBe('caller stopped')
        : expect(result).rejects.toThrow('caller stopped')
      if (!alreadyAborted) controller.abort('caller stopped')
      await rejected
      await closed
      expect(raw.destroyed).toBe(true)
    } finally {
      raw.destroy()
      for (const socket of peers) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})
