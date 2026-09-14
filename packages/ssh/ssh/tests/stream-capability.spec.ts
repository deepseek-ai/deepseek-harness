import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { connect as tlsConnect } from 'node:tls'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import type { SshStreamEndpoint } from '../src/schemas.ts'
import { authenticateStream, SSH_STREAM_TLS_OPTIONS } from '../src/stream-security.ts'

async function connect(endpoint: SshStreamEndpoint, capability: string): Promise<Socket> {
  const socket = createConnection(endpoint.path)
  socket.on('error', () => {})
  await once(socket, 'connect')
  return authenticateStream(socket, capability, 5000)
}

describe.skipIf(process.platform === 'win32')('SSH stream capabilities', () => {
  it('refuses an unknown TLS identity without consuming a legitimate reservation', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-identity-')
    const owner = new RemoteProcesses(new Context(), root, 1, 5000)
    let stream: Socket | undefined
    try {
      const prepared = await owner.prepare({ argv: ['true'], cwd: root, graceMs: 100, terminal: { terminalType: 'dumb', rows: 24, cols: 80 } })
      const endpoint = prepared.streams.terminal!
      const raw = createConnection(endpoint.path)
      await once(raw, 'connect')
      stream = tlsConnect({ ...SSH_STREAM_TLS_OPTIONS, socket: raw,
        pskCallback: () => ({ identity: 'unknown-client', psk: Buffer.from(endpoint.capability, 'hex') }),
      })
      await expect(once(stream, 'secureConnect')).rejects.toThrow()
      stream.destroy()
      stream = await connect(endpoint, endpoint.capability)
      expect(stream.destroyed).toBe(false)
    } finally { stream?.destroy(); await owner.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('publishes only one of two already-connected clients for the same reservation', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-duplicate-')
    const owner = new RemoteProcesses(new Context(), root, 1, 5000)
    const sockets: Socket[] = []
    try {
      const prepared = await owner.prepare({ argv: ['true'], cwd: root, graceMs: 100, terminal: { terminalType: 'dumb', rows: 24, cols: 80 } })
      const endpoint = prepared.streams.terminal!
      const raw = [createConnection(endpoint.path), createConnection(endpoint.path)]
      await Promise.all(raw.map(socket => once(socket, 'connect')))
      const clients = await Promise.allSettled(raw.map(socket => authenticateStream(socket, endpoint.capability, 5000)))
      for (const result of clients) if (result.status === 'fulfilled') {
        result.value.on('error', () => {})
        sockets.push(result.value)
      }
      await vi.waitFor(() => { expect(sockets.filter(socket => !socket.destroyed)).toHaveLength(1) })
    } finally {
      for (const socket of sockets) socket.destroy()
      await owner.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses another endpoint capability without consuming the legitimate reservation', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-auth-')
    const processes = new RemoteProcesses(new Context(), root, 4, 5000)
    const sockets: Socket[] = []
    try {
      const prepared = await processes.prepare({
        argv: ['true'], cwd: root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' },
      })
      const control = prepared.streams.control!
      await expect(connect(control, prepared.streams.stderr!.capability)).rejects.toThrow()
      const legitimate = await connect(control, control.capability)
      sockets.push(legitimate)
      expect(legitimate.destroyed).toBe(false)
      expect(control.capability).not.toBe(prepared.streams.stdout!.capability)
      expect(control.capability).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      for (const socket of sockets) socket.destroy()
      await processes.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat administrative-looking bytes as a helper request on a data listener', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-auth-')
    const processes = new RemoteProcesses(new Context(), root, 4, 5000)
    let socket: Socket | undefined
    try {
      const prepared = await processes.prepare({
        argv: ['true'], cwd: root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      })
      socket = createConnection(prepared.streams.stdout!.path)
      socket.on('error', () => {})
      await once(socket, 'connect')
      const closed = once(socket, 'close')
      // Drain a possible TLS alert so the raw peer can observe EOF.
      socket.resume()
      socket.end(Buffer.from('{"type":"request","method":"process.start","id":"forged","params":{}}'))
      await closed
      const legitimate = await connect(prepared.streams.stdout!, prepared.streams.stdout!.capability)
      socket = legitimate
      expect(legitimate.destroyed).toBe(false)
    } finally {
      socket?.destroy()
      await processes.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
