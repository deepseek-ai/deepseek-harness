/**
 * One side of the shared-texture native e2e, run in its own process so peer identity, process exit, and a blocked
 * JavaScript thread are real. `main` loads the ingress addon and `host` the hop addon; both load the texture probe.
 * Commands arrive as JSON lines `{ id, op, ...args }` on stdin and are handled one at a time; replies
 * `{ id, result }` or `{ id, error }` and unsolicited `{ event }` lines leave on stdout through synchronous writes, so
 * they are emitted even while the JavaScript thread is about to block.
 */
import { writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

const [role, addonPath, probePath] = process.argv.slice(2)
const load = createRequire(import.meta.url)
const addon = load(addonPath)
const probe = load(probePath)
const NO_REPLY = Symbol('no reply')

function send(message) { writeSync(1, `${JSON.stringify(message)}\n`) }

/** Texture handles local to this process, by probe tag. */
const textures = new Map()
/** Main: delivered handles JavaScript still owns, by request identifier. */
const frames = new Map()
let ingress
let connection
/** Host: the probe attached to the current connection's sink. */
let sinkProbe
/** Host: keys of presented frames, and the waiters for the sink's return code of each. */
let nextKey = 1
const returns = new Map()

/** Forward one sink report under the frame's key: `returned` with the sink's code, then `delivered` and `settled`. */
function report({ type, tag: key, ...fields }) {
  send({ event: { type, key, ...fields } })
  if (type !== 'returned') return
  returns.get(key)?.(fields)
  returns.delete(key)
}

function newTexture() {
  const texture = probe.createTexture()
  textures.set(texture.tag, texture.handle)
  return texture.tag
}

const mainHandlers = {
  open({ peerPid, autoReply = false }) {
    ingress = addon.open(peerPid, (event) => {
      if (event.type !== 'frame') { send({ event }); return }
      const { handle, ...fields } = event
      send({ event: { ...fields, handleBytes: handle.length, handleTag: probe.textureTag(handle) } })
      if (!autoReply) { frames.set(event.requestId, handle); return }
      addon.reply(ingress.native, event.requestId, 1, false, '')
      addon.reply(ingress.native, event.requestId, 3, false, '')
      addon.release(handle)
    })
    return ingress.endpoint
  },
  reply({ requestId, kind, noReferenceKept = false, error = '' }) { addon.reply(ingress.native, requestId, kind, noReferenceKept, error) },
  /**
   * Send delivery replies for `requestId` until one takes at least half the ingress reply timeout, which happens once
   * the Host stops reading and its queue is full, or until `limit` replies went out.
   */
  flood({ requestId, limit = 200_000 }) {
    for (let sent = 1; sent <= limit; sent++) {
      const started = performance.now()
      addon.reply(ingress.native, requestId, 1, false, '')
      if (performance.now() - started >= 50) return { sent, slow: true }
    }
    return { sent: limit, slow: false }
  },
  release({ requestId }) {
    addon.release(frames.get(requestId))
    frames.delete(requestId)
  },
  block({ ms }, id) {
    send({ id, result: 'blocking' })
    const end = Date.now() + ms
    while (Date.now() < end) { /* The JavaScript thread stays busy, as a blocked Electron Main would. */ }
    send({ event: { type: 'unblocked' } })
    return NO_REPLY
  },
  async closeIngress() {
    await Promise.all([addon.close(ingress.native), addon.close(ingress.native)])
    await addon.close(ingress.native)
  },
  /**
   * Read the adapter of a new texture through the ingress addon: `d3d` creates a shared Direct3D 11 texture (Windows
   * only) and also reports the adapter it was created on, `plain` the platform texture the other operations use, and
   * `zero` passes a zero handle.
   */
  adapterLuid({ kind }) {
    if (kind === 'zero') return addon.adapterLuid(Buffer.alloc(8))
    const texture = kind === 'd3d' ? probe.createD3DTexture() : probe.createTexture()
    try {
      return { read: addon.adapterLuid(texture.handle), created: texture.adapter ?? null }
    } finally {
      probe.releaseTexture(texture.handle)
    }
  },
}

const hostHandlers = {
  connect({ endpoint }) {
    if (sinkProbe !== undefined) probe.detach(sinkProbe)
    sinkProbe = undefined
    connection = addon.connect(endpoint, (event) => { send({ event }) })
    sinkProbe = probe.attach(connection.sink, report)
    return true
  },
  texture() { return newTexture() },
  /** Attach a second probe that expects sink ABI `version`, then detach it; throws when the sink reports another one. */
  checkSink({ version }) { probe.detach(probe.attach(connection.sink, () => {}, version)) },
  /**
   * Present frames in order from one native thread through the connection's sink, as a native consumer does. Each
   * frame gets a key that its events carry; a frame's `label` becomes its metadata as a JSON string unless it sets
   * `metadata`. Resolves with every key and, for a frame the sink refused, the reason; without `wait` it resolves
   * before the thread has presented them.
   */
  present({ tag, frames: requests, wait = true }) {
    if (sinkProbe === undefined) throw new Error('The Host peer has no connection')
    const frames = requests.map(({ noHandle = false, pixelFormat = 'bgra', label, ...frame }) => ({
      width: 64, height: 32, metadata: label === undefined ? '' : JSON.stringify(label), timeoutMs: 10_000, ...frame, tag: nextKey++,
      handle: noHandle ? Buffer.alloc(8) : textures.get(tag),
      pixelFormat: typeof pixelFormat === 'number' ? pixelFormat : pixelFormat === 'rgba' ? 1 : 0,
    }))
    const results = frames.map(({ tag: key }) => new Promise((resolve) => {
      returns.set(key, ({ code, error }) => { resolve(code === 0 ? { key } : { key, error }) })
    }))
    probe.present(sinkProbe, frames)
    return wait ? Promise.all(results) : frames.map(({ tag: key }) => ({ key }))
  },
  close() { addon.close(connection.native) },
  /** Windows: stop or continue every thread of another process, such as the Main peer. */
  suspend({ pid }) { probe.suspendProcess(pid) },
  resume({ pid }) { probe.resumeProcess(pid) },
  /** Windows: close texture `tag` and create another in the same native call; reports whether it took the old handle value. */
  replaceTexture({ tag }) {
    const previous = textures.get(tag)
    textures.delete(tag)
    const next = probe.replaceTexture(previous)
    textures.set(next.tag, next.handle)
    return { tag: next.tag, reused: next.handle.equals(previous) }
  },
  /** Drop JavaScript's references to the `sink` external and collect it, leaving only the probe's reference. */
  dropSink() {
    connection = { native: connection.native }
    globalThis.gc()
  },
  raw({ endpoint, tag, header, payload }) { probe.rawPresent(textures.get(tag), { endpoint, ...header }, Buffer.from(payload, 'utf8')) },
}

const handlers = role === 'main' ? mainHandlers : hostHandlers
send({ event: { type: 'ready', pid: process.pid } })
for await (const line of createInterface({ input: process.stdin })) {
  const { id, op, ...args } = JSON.parse(line)
  try {
    const handler = handlers[op]
    if (handler === undefined) throw new Error(`unknown operation ${op}`)
    const result = await handler(args, id)
    if (result !== NO_REPLY) send({ id, result: result ?? null })
  } catch (error) {
    send({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
// The test ended this process's input; an open ingress or connection must not keep it alive.
process.exit(0)
