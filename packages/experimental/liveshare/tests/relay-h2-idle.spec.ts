import { EventEmitter } from 'node:events'
import diagnosticsChannel from 'node:diagnostics_channel'
import { describe, expect, it } from 'vitest'
import {
  armRelayH2Guard,
  isRelayH2IdleTimeout,
  runRelayH2Scoped,
} from '../src/host/relay-h2-idle.ts'

const connected = diagnosticsChannel.channel('undici:client:connected')

class FixtureSocket extends EventEmitter {
  alpnProtocol: string | false = 'h2'
}

function idleTimeout(): Error {
  return Object.assign(new Error('socket idle timeout'), { name: 'InformationalError', code: 'UND_ERR_INFO' })
}

describe('relay h2 idle guard', () => {
  it('recognizes only undici informational idle timeouts', () => {
    expect(isRelayH2IdleTimeout(idleTimeout())).toBe(true)
    expect(isRelayH2IdleTimeout(new Error('socket idle timeout'))).toBe(false)
    expect(isRelayH2IdleTimeout(null)).toBe(false)
  })

  it('instruments only sockets connected inside a Relay request', async () => {
    armRelayH2Guard()
    const outside = new FixtureSocket()
    outside.on('error', () => undefined)
    connected.publish({ connectParams: { version: 'h2' }, socket: outside })
    expect(outside.listenerCount('error')).toBe(1)

    const inside = new FixtureSocket()
    inside.on('error', () => undefined)
    await runRelayH2Scoped(async () => {
      connected.publish({ connectParams: { version: 'h2' }, socket: inside })
    })
    expect(inside.listenerCount('error')).toBe(2)
    expect(() => inside.emit('error', idleTimeout())).not.toThrow()
  })

  it('leaves every other socket error to the socket\'s own listener', async () => {
    armRelayH2Guard()
    const received: unknown[] = []
    const socket = new FixtureSocket()
    socket.on('error', (error: unknown) => { received.push(error) })
    await runRelayH2Scoped(async () => {
      connected.publish({ connectParams: { version: 'h2' }, socket })
    })
    const failure = new Error('read ECONNRESET')
    expect(() => socket.emit('error', failure)).not.toThrow()
    expect(received).toEqual([failure])
  })

  it('leaves an HTTP/1.1 socket untouched inside a Relay request', async () => {
    armRelayH2Guard()
    const socket = new FixtureSocket()
    socket.alpnProtocol = false
    socket.on('error', () => undefined)
    await runRelayH2Scoped(async () => {
      connected.publish({ connectParams: { version: 'h1' }, socket })
    })
    expect(socket.listenerCount('error')).toBe(1)
  })

  it('guards a socket whose ALPN negotiated h2 when the payload omits the connect parameters', async () => {
    armRelayH2Guard()
    const socket = new FixtureSocket()
    socket.on('error', () => undefined)
    await runRelayH2Scoped(async () => {
      connected.publish({ socket })
    })
    expect(socket.listenerCount('error')).toBe(2)
    expect(() => socket.emit('error', idleTimeout())).not.toThrow()
  })
})
