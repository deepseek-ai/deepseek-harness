/** Real WS/IPC barriers observe which committed access state the gateway re-registers. */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  parseTunnelWorkerEvent,
  type ShareAccessStateFrame,
  type TunnelShareSpec,
  type TunnelRegistrationToken,
  type TunnelWorkerCommand,
  type TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'

type RequestEvent = Extract<TunnelWorkerEvent, { type: 'share-rpc-request' }>

async function harness() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets: Array<{ socket: WebSocket; registration: URL }> = []
  const processState: { child?: ChildProcess } = {}
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const child = processState.child
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'close')
        const kill = setTimeout(() => { child?.kill('SIGKILL') }, 2_000)
        child.kill('SIGTERM')
        try {
          await exited
        } finally {
          clearTimeout(kill)
        }
      }
      for (const { socket } of sockets) socket.terminate()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    })()
    return closing
  }
  onTestFinished(close)
  server.on('connection', (socket, request) => {
    sockets.push({ socket, registration: new URL(request.url ?? '/', 'http://relay.invalid') })
  })
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Relay fixture did not bind a TCP port')
  const child = processState.child = spawn(process.execPath, [
    '--import', 'tsx/esm', fileURLToPath(new URL('../src/owner-gateway/cli.ts', import.meta.url)),
  ], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout?.resume()
  let diagnostics = ''
  child.stderr?.on('data', (data: Buffer) => { diagnostics += data.toString() })
  const events: TunnelWorkerEvent[] = []
  child.on('message', (value) => {
    const event = parseTunnelWorkerEvent(value)
    if (event !== undefined) events.push(event)
  })
  const send = (command: TunnelWorkerCommand): void => { child?.send(command) }
  const share: TunnelShareSpec = {
    shareId: 'share', sessionId: 'session', sessionTitle: 'session', accessMode: 'open',
    relay: `http://127.0.0.1:${String(address.port)}`, gatewayToken: 'token', ownerDisplayName: 'owner',
    allowedSubjectIds: ['original-viewer'], sessionMode: 'write', allowsFork: true,
    expiresAt: '2030-01-01T00:00:00Z',
  }
  const registrationToken = randomUUID() as TunnelRegistrationToken
  const replacementToken = randomUUID() as TunnelRegistrationToken
  let markerId = 0
  const barrier = async (socket: WebSocket): Promise<void> => {
    const id = ++markerId
    socket.send(JSON.stringify({
      type: 'share-rpc', id, body: { marker: id },
      actor: { providerId: 'mock', tenantId: 'tenant', subjectId: 'barrier' },
    }))
    await expect.poll(() => events.some(event => event.type === 'share-rpc-request' && event.id === id)).toBe(true)
    const request = events.find((event): event is RequestEvent => event.type === 'share-rpc-request' && event.id === id)
    if (request === undefined) throw new Error('Gateway did not reach the WS observation barrier')
    send({ type: 'share-rpc-response', registrationToken: request.registrationToken, token: request.token, shareId: request.shareId, id,
      status: 200, body: { marker: id } })
  }
  await expect.poll(() => {
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Gateway exited: ${diagnostics}`)
    return events.some(event => event.type === 'ready')
  }, { timeout: 20_000 }).toBe(true)
  return { sockets, events, send, share, registrationToken, replacementToken, barrier, close }
}

function snapshot(version: number, sessionMode: ShareAccessStateFrame['sessionMode']): ShareAccessStateFrame {
  return { type: 'share-access-state', version, sessionMode, accessMode: 'selected',
    allowedSubjectIds: ['remaining-viewer'] }
}

function registrationFields(url: URL) {
  return {
    mode: url.searchParams.get('sessionMode'),
    fork: url.searchParams.get('allowsFork'),
    accessMode: url.searchParams.get('accessMode'),
    subjects: url.searchParams.getAll('allowedSubjectId'),
    expiry: url.searchParams.get('expiresAt'),
  }
}

describe('Gateway committed access-state replay', () => {
  it('keeps the newest socket snapshot for reconnect and rejects older or equal versions', async () => {
    const h = await harness()
    h.send({ type: 'add-share', registrationToken: h.registrationToken, share: h.share })
    await expect.poll(() => h.sockets.length).toBe(1)
    const original = h.sockets[0]!
    expect(original.registration.searchParams.has('registrationToken')).toBe(false)
    expect(original.registration.toString()).not.toContain(h.registrationToken)
    expect(registrationFields(original.registration)).toMatchObject({ mode: 'write', fork: '1' })
    original.socket.send(JSON.stringify(snapshot(10, 'view')))
    original.socket.send(JSON.stringify(snapshot(11, 'view')))
    original.socket.send(JSON.stringify(snapshot(10, 'write')))
    original.socket.send(JSON.stringify(snapshot(11, 'write')))
    await h.barrier(original.socket)
    expect(h.events.filter(event => event.type === 'share-access-state')).toEqual([
      { ...snapshot(10, 'view'), registrationToken: h.registrationToken, shareId: 'share' },
      { ...snapshot(11, 'view'), registrationToken: h.registrationToken, shareId: 'share' },
    ])
    expect(h.sockets).toHaveLength(1)
    const closed = once(original.socket, 'close')
    original.socket.close()
    await closed
    await expect.poll(() => h.sockets.length, { timeout: 10_000 }).toBe(2)
    const replacement = h.sockets[1]!
    expect(registrationFields(replacement.registration)).toEqual({
      mode: 'view', fork: null, accessMode: 'selected', subjects: ['remaining-viewer'], expiry: null,
    })
    // A fresh socket establishes its own version range, while its initial request preserves retained intent.
    replacement.socket.send(JSON.stringify(snapshot(1, 'view')))
    await h.barrier(replacement.socket)
    expect(h.events.filter(event => event.type === 'share-access-state').at(-1))
      .toEqual({ ...snapshot(1, 'view'), registrationToken: h.registrationToken, shareId: 'share' })
    const replacementClosed = once(replacement.socket, 'close')
    replacement.socket.close()
    await replacementClosed
    await expect.poll(() => h.sockets.length, { timeout: 10_000 }).toBe(3)
    // The retired word committed no forking, so the retained state carries none into the next socket.
    expect(registrationFields(h.sockets[2]!.registration)).toMatchObject({ mode: 'view', fork: null })
    await h.close()
  })

  it('uses an explicit owner remove/add specification instead of the prior socket snapshot', async () => {
    const h = await harness()
    h.send({ type: 'add-share', registrationToken: h.registrationToken, share: h.share })
    await expect.poll(() => h.sockets.length).toBe(1)
    const original = h.sockets[0]!
    original.socket.send(JSON.stringify(snapshot(20, 'view')))
    await h.barrier(original.socket)
    h.send({ type: 'remove-share', shareId: h.share.shareId })
    h.send({ type: 'add-share', registrationToken: h.replacementToken, share: { ...h.share, sessionMode: 'view', allowedSubjectIds: ['owner-choice'] } })
    await expect.poll(() => h.sockets.length).toBe(2)
    const replacement = h.sockets[1]!
    expect(registrationFields(replacement.registration)).toEqual({
      mode: 'view', fork: '1', accessMode: 'open', subjects: ['owner-choice'], expiry: h.share.expiresAt,
    })
    replacement.socket.send(JSON.stringify(snapshot(1, 'view')))
    await h.barrier(replacement.socket)
    expect(h.events.filter(event => event.type === 'share-access-state').at(-1))
      .toEqual({ ...snapshot(1, 'view'), registrationToken: h.replacementToken, shareId: 'share' })
    await h.close()
  })
})
