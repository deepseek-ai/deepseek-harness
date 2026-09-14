import { Duplex, PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'
import { JsonChannel } from '../src/channel.ts'
import { runNodeMain } from '../src/process.ts'
import type { ProgramProcess } from '../src/process.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'

function endpoints() {
  const first = new PassThrough()
  const second = new PassThrough()
  const child = Duplex.from({ readable: first, writable: second })
  const host = Duplex.from({ readable: second, writable: first })
  child.on('error', () => {})
  host.on('error', () => {})
  onTestFinished(() => { child.destroy(); host.destroy() })
  return { child, host }
}
function processState(): ProgramProcess { return { env: { FIXTURE_SECRET: 'test' }, stdout: { write: () => true }, stderr: { write: () => true }, exitCode: undefined } }

it('clears process environment, dispatches a binding reply and flushes the terminal frame', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const nativeEnvironment = state.env
  nativeEnvironment.SystemRoot = 'C:\\Windows'
  nativeEnvironment.PATH = '/native/bin'
  nativeEnvironment.TMP = 'C:\\sandbox-temp'
  nativeEnvironment.TEMP = 'C:\\sandbox-temp'
  const messages: Record<string, unknown>[] = []
  const peer = new JsonChannel(host, 4096, (raw) => {
    const message = raw as Record<string, unknown>
    messages.push(message)
    if (message.type === 'ready') void peer.send({ type: 'boot', data: { code: 'console.log("ready"); return await tools.echo({});', namespaces: [{ global: 'tools', names: ['echo'] }], maxOutputBytes: 1024 } })
    if (message.type === 'call') void peer.send({ type: 'reply', id: message.id, ok: true, value: encodePtcJsonWire(42) })
    if (message.type === 'done') host.end()
  }, () => {})
  onTestFinished(() => { peer.close() })
  await runNodeMain(child, 4096, state)
  expect(state.env).toEqual({})
  expect(state.env).not.toBe(nativeEnvironment)
  expect(Object.getPrototypeOf(state.env)).toBeNull()
  expect(nativeEnvironment).toEqual({ SystemRoot: 'C:\\Windows', PATH: '/native/bin', TMP: 'C:\\sandbox-temp', TEMP: 'C:\\sandbox-temp' })
  expect(state.exitCode).toBeUndefined()
  expect(decodePtcJsonWire(messages.find(message => message.type === 'done')?.value)).toBe(42)
})

it('keeps the control pipe open for a late binding reply until the host closes it', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const terminal = Promise.withResolvers<unknown>()
  const messages: string[] = []
  let callId: unknown
  const peer = new JsonChannel(host, 4096, (raw) => {
    const message = raw as Record<string, unknown>
    messages.push(String(message.type))
    if (message.type === 'ready') void peer.send({ type: 'boot', data: {
      code: 'void tools.echo({}).then(() => { throw new Error("late reply resumed the program") }); setImmediate(() => console.log("late timer")); return 42;',
      namespaces: [{ global: 'tools', names: ['echo'] }],
      maxOutputBytes: 1024,
    } })
    if (message.type === 'call') callId = message.id
    if (message.type === 'done') terminal.resolve(decodePtcJsonWire(message.value))
  }, (error) => { terminal.reject(error) })
  const main = runNodeMain(child, 4096, state)
  try {
    expect(await terminal.promise).toBe(42)
    // Settle the terminal write callbacks while the host still owns the open pipe.
    await nextTurn()
    expect(child.destroyed).toBe(false)
    await peer.send({ type: 'reply', id: callId, ok: true, value: encodePtcJsonWire(42) })
    await nextTurn()
    expect(messages).toEqual(['ready', 'call', 'done'])
  } finally {
    peer.close()
    await main
  }
  expect(state.exitCode).toBeUndefined()
})

it.each([0, -1, 1.5, 4294967296])('rejects an invalid bootstrap frame limit %i', async (limit) => {
  const { child } = endpoints()
  await expect(runNodeMain(child, limit, processState())).rejects.toThrow('invalid control message limit')
})

it('rejects an unexpected first control frame', async () => {
  const { child, host } = endpoints()
  const peer = new JsonChannel(host, 4096, () => { void peer.send({ type: 'reply' }) }, () => {})
  onTestFinished(() => { peer.close() })
  await expect(runNodeMain(child, 4096, processState())).rejects.toThrow('expected program boot')
})

it('records an I/O failure before the boot frame', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const peer = new JsonChannel(host, 4096, () => { peer.close() }, () => {})
  await expect(runNodeMain(child, 4096, state)).rejects.toBeInstanceOf(Error)
  expect(state.exitCode).toBe(1)
})

it('contains program writes that exceed queued control output', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const peer = new JsonChannel(host, 1024, (raw) => {
    if ((raw as { type: string }).type === 'ready') void peer.send({ type: 'boot', data: { code: 'for(let i=0;i<30;i++) console.log("x".repeat(100));', namespaces: [], maxOutputBytes: 8000 } })
  }, () => {})
  onTestFinished(() => { peer.close() })
  await runNodeMain(child, 1024, state)
  expect(state.exitCode).toBe(1)
})

it('records a terminal frame that cannot fit the control write budget as failure', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const peer = new JsonChannel(host, 1024, (raw) => {
    if ((raw as { type: string }).type === 'ready') void peer.send({ type: 'boot', data: {
      code: 'return "x".repeat(2000)', namespaces: [], maxOutputBytes: 8000,
    } })
  }, () => {})
  onTestFinished(() => { peer.close() })
  await runNodeMain(child, 1024, state)
  expect(state.exitCode).toBe(1)
})

it('retains a malformed host frame failure after the terminal frame', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const terminal = Promise.withResolvers<undefined>()
  const peer = new JsonChannel(host, 1024, (raw) => {
    const message = raw as { type: string }
    if (message.type === 'ready') void peer.send({ type: 'boot', data: {
      code: 'return 42', namespaces: [], maxOutputBytes: 1000,
    } })
    if (message.type === 'done') terminal.resolve(undefined)
  }, () => {})
  onTestFinished(() => { peer.close() })
  const main = runNodeMain(child, 1024, state)
  try {
    await terminal.promise
    host.write(Buffer.from([0, 0, 0, 1, 0xff]))
    await main
    expect(state.exitCode).toBe(1)
  } finally { peer.close(); await main }
})
