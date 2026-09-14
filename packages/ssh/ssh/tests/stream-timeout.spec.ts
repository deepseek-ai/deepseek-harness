import { once } from 'node:events'
import { createConnection, createServer, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { authenticateStream } from '../src/stream-security.ts'

describe('SSH TLS authentication deadline', () => {
  it('closes a transport whose peer accepts a connection but never completes authentication', async () => {
    const accepted = new Set<Socket>()
    const server = createServer((socket) => {
      accepted.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => { accepted.delete(socket) })
      socket.resume()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test listener has no TCP address')
    const peerConnected = once(server, 'connection')
    const raw = createConnection(address.port, '127.0.0.1')
    try {
      await once(raw, 'connect')
      await peerConnected
      const closed = once(raw, 'close')
      await expect(authenticateStream(raw, 'a'.repeat(64), 25)).rejects.toThrow('authentication timed out')
      await closed
      expect(raw.destroyed).toBe(true)
    } finally {
      raw.destroy()
      for (const socket of accepted) socket.destroy()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    }
  })
})
