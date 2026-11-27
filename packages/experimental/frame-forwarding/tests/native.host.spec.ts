/**
 * The addon binding checks the build record, wraps the receiver's Node-API exports, reads the fields of presentation
 * errors, and rejects protocol mismatches before loading the addon.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  FRAME_FORWARDING_CAPABILITIES, FRAME_FORWARDING_PROTOCOL_VERSION, loadFrameForwardingBindings,
} from '../src/host/native.ts'
import type { FrameConnectionId } from '../src/types.ts'
import type { FrameForwardingReceiverEvent } from '../src/host/native.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const platform = `${process.platform}-${process.arch}`
const current = { platform, protocolVersion: FRAME_FORWARDING_PROTOCOL_VERSION, capabilities: FRAME_FORWARDING_CAPABILITIES }
const connection = 1 as FrameConnectionId

/** A CommonJS stand-in for the addon that records every call, with the build record the loader requires. */
async function fakeAddon(record: object | null = current): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'frame-forwarding-addon-'))
  roots.push(root)
  const file = join(root, 'frame-forwarding.cjs')
  await writeFile(join(root, 'frame-forwarding.json'), JSON.stringify(record))
  await writeFile(file, `
    const calls = []
    module.exports = {
      calls,
      createBudget: bytes => ({ bytes }),
      create: (maxFrames, maxBytes, onEvent, ...options) => {
        calls.push(['create', maxFrames, maxBytes, ...options])
        module.exports.emit = onEvent
        onEvent({ type: 'connected', connectionId: 1, pid: 7 })
        return { native: { id: 'native' }, tx: '1|7|secret|name' }
      },
      send: (native, connectionId, json) => calls.push(['send', native.id, connectionId, json]),
      release: (native, deliveryId) => { calls.push(['release', native.id, deliveryId]); return deliveryId === 1 },
      attachSink: (native, rx, sink, timeoutMs) => calls.push(['attachSink', native.id, rx, sink, timeoutMs]),
      setDeliverable: (native, state) => calls.push(['setDeliverable', native.id, state]),
      close: (native) => { calls.push(['close', native.id]); return Promise.resolve() },
    }
  `)
  return file
}

test('the loader expects the protocol version and handshake capabilities the native sources declare', async () => {
  const header = await readFile(new URL('../native/transport.h', import.meta.url), 'utf8')
  expect(FRAME_FORWARDING_PROTOCOL_VERSION).toBe(2)
  expect(Number(/DSH_FRAME_FORWARDING_PROTOCOL_VERSION (\d+)/u.exec(header)?.[1])).toBe(FRAME_FORWARDING_PROTOCOL_VERSION)
})

test.each([
  ['another platform', { ...current, platform: 'other-arch' }],
  ['another protocol version', { ...current, protocolVersion: FRAME_FORWARDING_PROTOCOL_VERSION + 1 }],
  ['the fixed-size packets of protocol 1', { ...current, protocolVersion: 1 }],
  ['a protocol 1 receiver without transferable channels', { platform, protocolVersion: FRAME_FORWARDING_PROTOCOL_VERSION }],
  ['other capabilities', { ...current, capabilities: ['transferable-tx', 'other'] }],
  ['the capabilities of the 0.2.2 receiver', { ...current, capabilities: ['transferable-tx'] }],
  ['capabilities that are not a list', { ...current, capabilities: 'transferable-tx' }],
  ['no fields', null],
])('refuses an addon whose build record names %s', async (_name, record) => {
  const path = await fakeAddon(record)
  expect(() => loadFrameForwardingBindings(path)).toThrow('install a compatible Desktop build')
})

test('requires an absolute addon path supplied by Desktop', () => {
  expect(() => loadFrameForwardingBindings('frame-forwarding.node')).toThrow('must be absolute')
})

test('refuses an addon without a build record', () => {
  expect(() => loadFrameForwardingBindings(join(tmpdir(), 'missing-frame-forwarding', 'frame-forwarding.node'))).toThrow()
})

test('wraps budgets and receivers over the addon exports', async () => {
  const bindings = loadFrameForwardingBindings(await fakeAddon())
  const events: FrameForwardingReceiverEvent[] = []
  const budget = bindings.createBudget(4096)
  const receiver = bindings.createReceiver({
    maxFrames: 2, maxBytes: 4096, budget, displayAdapter: null, readbackTimeoutMs: 500,
  }, event => events.push(event))
  expect(receiver.tx).toBe('1|7|secret|name')
  expect(events).toEqual([{ type: 'connected', connectionId: 1, pid: 7 }])
  receiver.send(connection, '{"type":"viewport"}')
  expect(receiver.release(1 as never)).toBe(true)
  expect(receiver.release(2 as never)).toBe(false)
  const first = receiver.close()
  expect(receiver.close()).toBe(first)
  await first
  expect(() => bindings.createReceiver({
    maxFrames: 1, maxBytes: 1, budget: Object.freeze({}) as never, displayAdapter: 'd' as never, readbackTimeoutMs: 1,
  }, () => {})).toThrow('budget from createBudget()')
})

test('passes a display adapter string and connection-scoped control through to the addon', async () => {
  const path = await fakeAddon()
  const bindings = loadFrameForwardingBindings(path)
  // The binding and the spec share Node's CommonJS cache, so this is the instance the binding drives.
  const addon = createRequire(import.meta.url)(path) as { calls: unknown[][] }
  const receiver = bindings.createReceiver({
    maxFrames: 3, maxBytes: 8192, budget: bindings.createBudget(8192), displayAdapter: '0:1' as never, readbackTimeoutMs: 10,
  }, () => {})
  receiver.send(4 as FrameConnectionId, '{"type":"viewport"}')
  receiver.release(1 as never)
  const sink = Object.freeze({ sink: true })
  receiver.attachSink('rx-1', sink, 5000)
  receiver.setDeliverable({ connectionId: 4 as FrameConnectionId, visible: true, maxGeneration: 2 })
  receiver.setDeliverable(null)
  await receiver.close()
  expect(addon.calls).toEqual([
    ['create', 3, 8192, { bytes: 8192 }, '0:1', 10], ['send', 'native', 4, '{"type":"viewport"}'],
    ['release', 'native', 1], ['attachSink', 'native', 'rx-1', sink, 5000],
    ['setDeliverable', 'native', { connectionId: 4, visible: true, maxGeneration: 2 }], ['setDeliverable', 'native', null],
    ['close', 'native'],
  ])
})

test('reads the source, request, and error of a presentation error, and passes other events unchanged', async () => {
  const path = await fakeAddon()
  const bindings = loadFrameForwardingBindings(path)
  const addon = createRequire(import.meta.url)(path) as { emit(event: object): void }
  const events: FrameForwardingReceiverEvent[] = []
  bindings.createReceiver({
    maxFrames: 1, maxBytes: 4096, budget: bindings.createBudget(4096), displayAdapter: null, readbackTimeoutMs: 10,
  }, event => events.push(event))
  const error = (text: string) => { addon.emit({ type: 'presentation-error', connectionId: 1, text }) }
  error('{"source":"presentation","requestId":"tile","error":"Native frame transfer failed: renderer import failed"}')
  error('{"source":"producer","error":"Invalid native frame metadata: metadata is not valid JSON"}')
  error('{"source":"producer","requestId":7,"error":"unnamed request"}')
  // Text the receiver did not write as presentation-error JSON is reported as a presentation failure.
  for (const text of ['not json', 'null', '{"source":"desktop","error":"x"}', '{"source":"producer","error":1}', '{"error":"x"}', '{"source":"producer"}'])
    error(text)
  addon.emit({ type: 'presentation-invalidated', connectionId: 1, text: 'Desktop invalidated a presented frame' })
  expect(events.slice(1)).toEqual([
    { type: 'presentation-error', connectionId: 1, source: 'presentation', requestId: 'tile', text: 'Native frame transfer failed: renderer import failed' },
    { type: 'presentation-error', connectionId: 1, source: 'producer', text: 'Invalid native frame metadata: metadata is not valid JSON' },
    { type: 'presentation-error', connectionId: 1, source: 'producer', text: 'unnamed request' },
    ...['not json', 'null', '{"source":"desktop","error":"x"}', '{"source":"producer","error":1}', '{"error":"x"}', '{"source":"producer"}']
      .map(text => ({ type: 'presentation-error', connectionId: 1, source: 'presentation', text })),
    { type: 'presentation-invalidated', connectionId: 1, text: 'Desktop invalidated a presented frame' },
  ])
})
