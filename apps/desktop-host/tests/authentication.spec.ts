/** Desktop credential delivery and provider lifetime through the private IPC channel. */
import { EventEmitter, once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import WebSocket from 'ws'
import OperatorFixture from '../../../packages/api/gateway/tests/operator-connect-fixture.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DesktopAuthenticationEnd, receiveDesktopSecret } from '../src/authentication.ts'
import * as DesktopAuthentication from '@deepseek-ai/dsh-host-authentication-desktop'

class Channel extends EventEmitter {
  connected = true
}
const secret = (): string => randomBytes(32).toString('base64url')

it('listens before delivery and accepts one exact desktop credential message', async () => {
  const channel = new Channel()
  const received = receiveDesktopSecret(channel)
  onTestFinished(() => { received.dispose() })
  const value = secret()
  channel.emit('message', { type: 'unrelated' })
  channel.emit('message', { type: 'desktop-auth', secret: value })
  expect(await received.secret).toBe(value)
  expect(received.signal.aborted).toBe(false)
  expect(channel.listenerCount('message')).toBe(1)
  received.dispose()
  expect(channel.listenerCount('message')).toBe(0)
  expect(channel.listenerCount('disconnect')).toBe(0)
})

it.each([
  { type: 'desktop-auth' },
  { type: 'desktop-auth', secret: 'bad-secret' },
  { type: 'desktop-auth', secret: 'A'.repeat(42) + 'B' },
  { type: 'desktop-auth', secret: 'A'.repeat(43), extra: true },
])('rejects malformed desktop authentication without echoing input', async (message) => {
  const channel = new Channel()
  const received = receiveDesktopSecret(channel)
  channel.emit('message', message)
  await expect(received.secret).rejects.toThrow('Desktop authentication message is invalid')
  expect(received.signal.aborted).toBe(true)
  expect(received.signal.reason).not.toBeInstanceOf(DesktopAuthenticationEnd)
  expect(String(received.signal.reason)).not.toContain('bad-secret')
  expect(channel.listenerCount('message')).toBe(0)
})

it.each(['disconnected', 'shutdown'] as const)('distinguishes pending authentication ending on %s', async (kind) => {
  const channel = new Channel()
  const received = receiveDesktopSecret(channel)
  if (kind === 'disconnected') channel.emit('disconnect')
  else channel.emit('message', { type: 'shutdown' })
  await expect(received.secret).rejects.toBeInstanceOf(DesktopAuthenticationEnd)
  expect(received.signal.reason).toMatchObject({ kind })
  expect(received.signal.aborted).toBe(true)
  expect(channel.listenerCount('message')).toBe(0)
  expect(channel.listenerCount('disconnect')).toBe(0)
  channel.emit('message', { type: 'desktop-auth', secret: secret() })
  await expect(received.secret).rejects.toBe(received.signal.reason)
})

it.each(['disconnected', 'shutdown'] as const)('retains %s after credentials arrive before the receiver resumes', async (kind) => {
  const channel = new Channel()
  const received = receiveDesktopSecret(channel)
  const value = secret()
  channel.emit('message', { type: 'desktop-auth', secret: value })
  if (kind === 'disconnected') channel.emit('disconnect')
  else channel.emit('message', { type: 'shutdown' })
  expect(await received.secret).toBe(value)
  expect(() => { received.signal.throwIfAborted() }).toThrow(DesktopAuthenticationEnd)
  expect(received.signal.reason).toMatchObject({ kind })
  expect(channel.listenerCount('message')).toBe(0)
  expect(channel.listenerCount('disconnect')).toBe(0)
})

it('rejects disposal while waiting without treating it as parent shutdown', async () => {
  const channel = new Channel()
  const received = receiveDesktopSecret(channel)
  received.dispose()
  await expect(received.secret).rejects.toThrow('Desktop authentication receiver disposed')
  expect(received.signal.reason).not.toBeInstanceOf(DesktopAuthenticationEnd)
  expect(channel.listenerCount('message')).toBe(0)
  expect(channel.listenerCount('disconnect')).toBe(0)
})

it('refuses a channel already disconnected before waiting', async () => {
  const channel = new Channel()
  channel.connected = false
  const received = receiveDesktopSecret(channel)
  await expect(received.secret).rejects.toBeInstanceOf(DesktopAuthenticationEnd)
  expect(received.signal.reason).toMatchObject({ kind: 'disconnected' })
  expect(channel.listenerCount('message')).toBe(0)
  expect(channel.listenerCount('disconnect')).toBe(0)
})

it.each([true, false])('rejects duplicate credentials before the receiver resumes (same: %s)', async (same) => {
  const channel = new Channel()
  const received = receiveDesktopSecret(channel)
  const value = secret()
  channel.emit('message', { type: 'desktop-auth', secret: value })
  channel.emit('message', { type: 'desktop-auth', secret: same ? value : secret() })
  expect(await received.secret).toBe(value)
  expect(() => { received.signal.throwIfAborted() }).toThrow('Desktop authentication credential already received')
  expect(received.signal.reason).not.toBeInstanceOf(DesktopAuthenticationEnd)
  expect(channel.listenerCount('message')).toBe(0)
  expect(channel.listenerCount('disconnect')).toBe(0)
})

it.each([true, false])('ends the channel on duplicate credentials (same: %s)', async (same) => {
  const channel = new Channel()
  const received = receiveDesktopSecret(channel)
  const value = secret()
  channel.emit('message', { type: 'desktop-auth', secret: value })
  await received.secret
  channel.emit('message', { type: 'desktop-auth', secret: same ? value : secret() })
  expect(received.signal.aborted).toBe(true)
  expect(String(received.signal.reason)).toContain('already received')
  expect(String(received.signal.reason)).not.toContain(value)
  expect(channel.listenerCount('message')).toBe(0)
})

it('authenticates real HTTP requests using its own Peer and withdraws with its owner', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(Connection).await()
  await ctx.plugin(TypertRegistry).await()
  await ctx.plugin(RemoteAccess).await()
  await ctx.plugin(TypertGateway).await()
  await ctx.plugin(OperatorFixture).await()
  const value = secret()
  const desktop = ctx.plugin(DesktopAuthentication, { readSecret: () => value })
  await desktop.await()
  const admitted = ctx.connection.authentication.authenticate({ headers: { cookie: `dsh-desktop-session=${value}` } })
  if ('rejection' in admitted) throw new Error('Desktop fixture did not register its provider')
  const desktopPeer = admitted.peer
  expect(desktopPeer).not.toBe(ctx.connection.browserPeer)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/identity', handler(req, res) {
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) { res.writeHead(admitted.rejection).end(); return }
    res.end(admitted.peer.id)
  } }))
  const origin = ctx.webServer.getOrigin()
  const request = async (cookie?: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${origin}/identity`, { headers: cookie === undefined ? {} : { cookie } })
    return { status: response.status, body: await response.text() }
  }
  expect((await request()).status).toBe(401)
  expect((await request(`dsh-desktop-session=${secret()}`)).status).toBe(401)
  expect((await request(`dsh-desktop-session=${value}; dsh-desktop-session=${value}`)).status).toBe(401)
  expect(await request(`other=1; dsh-desktop-session=${value}`)).toEqual({ status: 200, body: desktopPeer.id })
  expect(await request(`dsh-desktop-session=${value}`)).toEqual({ status: 200, body: desktopPeer.id })
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, {
    headers: { cookie: `dsh-desktop-session=${value}` },
  })
  const closed = once(socket, 'close')
  onTestFinished(async () => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
    await closed
  })
  await once(socket, 'open')
  const ready = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'open', streamId: 'desktop', endpoint: 'fixture/follow', payload: { args: { label: 'desktop' } } }))
  await ready
  expect(ctx.operatorConnectFixture.calls.get('desktop')?.peer).toBe(desktopPeer)
  await desktop.dispose()
  await closed
  await vi.waitFor(() => { expect(ctx.operatorConnectFixture.calls.get('desktop')?.finished).toBe(true) })
  expect(desktopPeer.signal.aborted).toBe(true)
  expect((await request(`dsh-desktop-session=${value}`)).status).toBe(401)
})
