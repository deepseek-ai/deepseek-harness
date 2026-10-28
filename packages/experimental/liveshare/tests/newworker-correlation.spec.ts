/** Real gateway IPC and loopback WS barriers pin request identity across Relay id reuse. */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import {
  parseGatewayFrame,
  parseTunnelWorkerEvent,
  rawText,
  type ShareRpcResFrame,
  type TunnelShareSpec,
  type TunnelRegistrationToken,
  type TunnelWorkerCommand,
  type TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'

type RequestEvent = Extract<TunnelWorkerEvent, { type: 'share-rpc-request' }>

async function harness() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets: WebSocket[] = []
  const wireFrames: Record<string, unknown>[] = []
  const replies = new Map<WebSocket, ShareRpcResFrame[]>()
  server.on('connection', (socket) => {
    sockets.push(socket)
    replies.set(socket, [])
    socket.on('message', (data) => {
      wireFrames.push(JSON.parse(rawText(data)) as Record<string, unknown>)
      const frame = parseGatewayFrame(rawText(data))
      if (frame?.type === 'share-rpc-res') replies.get(socket)?.push(frame)
    })
  })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Relay fixture did not bind a TCP port')
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', fileURLToPath(new URL('../src/owner-gateway/cli.ts', import.meta.url)),
  ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout?.resume()
  let diagnostics = ''
  child.stderr?.on('data', (data: Buffer) => { diagnostics += data.toString() })
  const exited = once(child, 'exit')
  const events: TunnelWorkerEvent[] = []
  child.on('message', (value) => {
    const event = parseTunnelWorkerEvent(value)
    if (event !== undefined) events.push(event)
  })
  const send = (command: TunnelWorkerCommand) => { child.send(command) }
  const share = (shareId = 'share'): TunnelShareSpec => ({
    shareId, sessionId: 'session', sessionTitle: 'session', accessMode: 'open',
    relay: `http://127.0.0.1:${String(address.port)}`, gatewayToken: 'token',
    ownerDisplayName: 'owner', allowedSubjectIds: [],
  })
  const request = async (socket: WebSocket, subjectId: string, id = 1): Promise<RequestEvent> => {
    const before = events.length
    socket.send(JSON.stringify({
      type: 'share-rpc', id, body: { op: 'stream-read', subject: subjectId },
      actor: { providerId: 'mock', tenantId: 'tenant', subjectId },
    }))
    await expect.poll(() => events.slice(before).some(event => event.type === 'share-rpc-request' && event.actor.subjectId === subjectId)).toBe(true)
    const event = events.slice(before).find(event => event.type === 'share-rpc-request' && event.actor.subjectId === subjectId)
    if (event?.type !== 'share-rpc-request') throw new Error('Gateway did not report a request')
    return event
  }
  const respond = (event: RequestEvent, body: unknown): void => { send({
    type: 'share-rpc-response', registrationToken: event.registrationToken, token: event.token, shareId: event.shareId, id: event.id, status: 200, body,
  }) }
  // IPC command order and WS send order make this response an observation barrier for prior answers.
  const barrier = async (socket: WebSocket) => {
    const marker = await request(socket, 'barrier', 999)
    respond(marker, 'barrier')
    await expect.poll(() => replies.get(socket)?.some(frame => frame.id === 999)).toBe(true)
  }
  const connect = async (shareId = 'share') => {
    const count = sockets.length
    send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: share(shareId) })
    await expect.poll(() => sockets.length).toBe(count + 1)
    return sockets[count]!
  }
  const cancelled = async (event: RequestEvent) => {
    await expect.poll(() => events.some(item => item.type === 'share-rpc-cancel' && item.token === event.token)).toBe(true)
  }
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    for (const socket of sockets) socket.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error) }) })
  }
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Gateway exited: ${diagnostics}`)
      return events.some(event => event.type === 'ready')
    }, { timeout: 20_000 }).toBe(true)
  } catch (error) {
    await close()
    throw error
  }
  return { sockets, wireFrames, replies, events, send, request, respond, barrier, connect, cancelled, close }
}

describe('Gateway request correlation', () => {
  it('drops Alice’s late response after reconnect gives Bob the same Relay id', async () => {
    const h = await harness()
    try {
      const oldSocket = await h.connect()
      const alice = await h.request(oldSocket, 'alice')
      const closed = once(oldSocket, 'close')
      oldSocket.close()
      await closed
      await h.cancelled(alice)
      await expect.poll(() => h.sockets.length).toBe(2)
      const newSocket = h.sockets[1]!
      const bob = await h.request(newSocket, 'bob')
      expect(bob.token).not.toBe(alice.token)
      expect(bob.id).toBe(alice.id)
      expect(bob.registrationToken).toBe(alice.registrationToken)
      expect(bob.token).not.toBe(bob.registrationToken)
      h.respond(alice, 'alice-secret')
      await h.barrier(newSocket)
      expect(h.replies.get(newSocket)?.filter(frame => frame.id === 1)).toEqual([])
      h.respond(bob, 'bob-answer')
      await expect.poll(() => h.replies.get(newSocket)?.find(frame => frame.id === 1)?.body).toBe('bob-answer')
    } finally {
      await h.close()
    }
  })

  it('propagates Relay cancel and isolates id reuse on the same socket', async () => {
    const h = await harness()
    try {
      const socket = await h.connect()
      const alice = await h.request(socket, 'alice')
      socket.send(JSON.stringify({ type: 'share-rpc-cancel', id: alice.id }))
      await h.cancelled(alice)
      const bob = await h.request(socket, 'bob')
      h.respond(alice, 'alice-secret')
      await h.barrier(socket)
      expect(h.replies.get(socket)?.filter(frame => frame.id === 1)).toEqual([])
      h.respond(bob, 'bob-answer')
      await expect.poll(() => h.replies.get(socket)?.find(frame => frame.id === 1)?.body).toBe('bob-answer')
    } finally {
      await h.close()
    }
  })

  it('cancels removed-share work without touching an equal id on another share', async () => {
    const h = await harness()
    try {
      const first = await h.connect('share-a')
      const second = await h.connect('share-b')
      const alice = await h.request(first, 'alice')
      const bob = await h.request(second, 'bob')
      h.send({ type: 'remove-share', shareId: 'share-a' })
      await h.cancelled(alice)
      const replacement = await h.connect('share-a')
      const carol = await h.request(replacement, 'carol')
      expect(carol.registrationToken).not.toBe(alice.registrationToken)
      expect(h.events.find(event => event.type === 'share-rpc-cancel' && event.token === alice.token))
        .toMatchObject({ registrationToken: alice.registrationToken, shareId: alice.shareId })
      h.respond(alice, 'alice-secret')
      h.respond(bob, 'bob-answer')
      await h.barrier(replacement)
      expect(h.events.some(event => event.type === 'share-rpc-cancel' && event.token === bob.token)).toBe(false)
      expect(h.replies.get(replacement)?.filter(frame => frame.id === 1)).toEqual([])
      await expect.poll(() => h.replies.get(second)?.find(frame => frame.id === 1)?.body).toBe('bob-answer')
      h.respond(carol, 'carol-answer')
      await expect.poll(() => h.replies.get(replacement)?.find(frame => frame.id === 1)?.body).toBe('carol-answer')
    } finally {
      await h.close()
    }
  })

  it('drops a prior worker process response when its replacement receives the same share and id', async () => {
    const old = await harness()
    let alice: RequestEvent
    try {
      alice = await old.request(await old.connect(), 'alice')
    } finally {
      await old.close()
    }
    const replacement = await harness()
    try {
      const socket = await replacement.connect()
      const bob = await replacement.request(socket, 'bob')
      expect(bob.token).not.toBe(alice.token)
      replacement.respond(alice, 'alice-secret')
      await replacement.barrier(socket)
      expect(replacement.replies.get(socket)?.filter(frame => frame.id === 1)).toEqual([])
      replacement.respond(bob, 'bob-answer')
      await expect.poll(() => replacement.replies.get(socket)?.find(frame => frame.id === 1)?.body).toBe('bob-answer')
    } finally {
      await replacement.close()
    }
  })

  it('requires matching token, share, and id without consuming the legitimate response', async () => {
    const h = await harness()
    try {
      const socket = await h.connect()
      const alice = await h.request(socket, 'alice')
      h.send({ type: 'share-rpc-response', registrationToken: alice.registrationToken, token: alice.token, shareId: 'other', id: alice.id, status: 200, body: 'wrong-share' })
      h.send({ type: 'share-rpc-response', registrationToken: alice.registrationToken, token: alice.token, shareId: alice.shareId, id: 2, status: 200, body: 'wrong-id' })
      h.send({ type: 'share-rpc-response', registrationToken: randomUUID() as TunnelRegistrationToken,
        token: alice.token, shareId: alice.shareId, id: alice.id, status: 200, body: 'wrong-registration' })
      await h.barrier(socket)
      expect(h.replies.get(socket)?.filter(frame => frame.id !== 999)).toEqual([])
      expect(h.wireFrames.every(frame => !('registrationToken' in frame) && !('token' in frame))).toBe(true)
      h.respond(alice, 'alice-answer')
      await expect.poll(() => h.replies.get(socket)?.find(frame => frame.id === 1)?.body).toBe('alice-answer')
    } finally {
      await h.close()
    }
  })
})
