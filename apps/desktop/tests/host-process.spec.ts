import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'

const roots: string[] = []

const HOST_WIRE = `
import { closeSync, createReadStream, createWriteStream } from 'node:fs'
const requestPipe = createReadStream('', { fd: 3, autoClose: false })
const responsePipe = createWriteStream('', { fd: 4, autoClose: false })
const MAGIC = 0x44534833
const HEADER = 13
function responseFrame(type, streamId, payload = Buffer.alloc(0)) {
  const frame = Buffer.allocUnsafe(HEADER + payload.length)
  frame.writeUInt32BE(MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(streamId, 5)
  frame.writeUInt32BE(payload.length, 9)
  payload.copy(frame, HEADER)
  return frame
}
function responseStart(streamId, options = {}) {
  const value = { status: options.status ?? 200, headers: options.headers ?? [], hasBody: options.hasBody ?? true }
  responsePipe.write(responseFrame(1, streamId, Buffer.from(JSON.stringify(value))))
}
function responseData(streamId, data) {
  responsePipe.write(responseFrame(2, streamId, Buffer.from(data)))
}
function responseEnd(streamId) { responsePipe.write(responseFrame(3, streamId)) }
function responseError(streamId, message) {
  responsePipe.write(responseFrame(4, streamId, Buffer.from(JSON.stringify({ message }))))
}
let requestBuffer = Buffer.alloc(0)
requestPipe.on('data', chunk => {
  requestBuffer = requestBuffer.length === 0 ? chunk : Buffer.concat([requestBuffer, chunk])
  while (requestBuffer.length >= HEADER) {
    if (requestBuffer.readUInt32BE(0) !== MAGIC) throw new Error('invalid request marker')
    const type = requestBuffer.readUInt8(4)
    const streamId = requestBuffer.readUInt32BE(5)
    const length = requestBuffer.readUInt32BE(9)
    if (requestBuffer.length < HEADER + length) return
    const payload = requestBuffer.subarray(HEADER, HEADER + length)
    requestBuffer = requestBuffer.subarray(HEADER + length)
    onRequestFrame({ type, streamId, payload })
  }
})
process.on('message', message => {
  if (message.type === 'shutdown') {
    requestPipe.destroy()
    closeSync(3)
    responsePipe.end(() => {
      responsePipe.destroy()
      closeSync(4)
      process.disconnect()
      process.exitCode = 0
    })
  }
})
`

function projectWithHost(source: string): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), `${HOST_WIRE}\n${source}`)
  return project
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('reports a fatal event after readiness once and stops the child', async () => {
    const runtime = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: '1.0.0' })
function onRequestFrame(frame) {
  if (frame.type === 1) process.send({ type: 'fatal', message: 'plugin unavailable' })
}
`)
    const failure = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, failure)
    try {
      await host.start()
      await expect(host.fetch(new Request('dsh-app://app/'))).rejects.toThrow('plugin unavailable')
      await host.stop()
      expect(failure).toHaveBeenCalledTimes(1)
      expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
    } finally { await host.stop() }
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost('function onRequestFrame() {}')
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    try { await expect(host.start()).rejects.toThrow() } finally { await host.stop() }
  })

  it('loads the resource entry with a separate profile and scrubs Node resolution overrides', async () => {
    const runtime = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'split-runtime' })
function onRequestFrame(frame) {
  if (frame.type !== 1) return
  responseStart(frame.streamId)
  responseData(frame.streamId, JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH}))
  responseEnd(frame.streamId)
}
`)
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--invalid-desktop-test-option', NODE_PATH: '/unowned',
    })
    try {
      const response = await host.fetch(new Request('dsh-app://app/environment'))
      expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile) })
    } finally { await host.stop() }
  })

  it('carries raw request and response bytes and shuts the child down cleanly', async () => {
    const project = projectWithHost(`
const bodies = new Map()
process.send({ type: 'ready', protocolVersion: 3, dshVersion: process.env.NODE_OPTIONS ?? 'clean' })
function onRequestFrame(frame) {
  if (frame.type === 1) {
    const request = JSON.parse(frame.payload)
    bodies.set(frame.streamId, Buffer.alloc(0))
    if (!request.hasBody) answer(frame.streamId)
  } else if (frame.type === 2) {
    bodies.set(frame.streamId, Buffer.concat([bodies.get(frame.streamId), frame.payload]))
  } else if (frame.type === 3) {
    answer(frame.streamId)
  }
}
function answer(streamId) {
  responseStart(streamId, { headers: [['content-type', 'text/plain']] })
  responseData(streamId, Buffer.concat([Buffer.from('desktop:'), bodies.get(streamId)]))
  responseEnd(streamId)
}
`)
    const previous = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require /path/that-must-not-reach-the-child'
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      await expect(host.start()).resolves.toMatchObject({ dshVersion: 'clean' })
      const response = await host.fetch(new Request('dsh-app://app/example', { method: 'POST', body: 'request' }))
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('desktop:request')
      await expect(host.stop()).resolves.toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
      await host.stop().catch(() => undefined)
    }
  })

  it('streams a large binary response in bounded raw frames', async () => {
    const size = 2 * 1024 * 1024
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'large-response' })
function onRequestFrame(frame) {
  if (frame.type !== 1) return
  responseStart(frame.streamId)
  const bytes = Buffer.alloc(${String(64 * 1024)}, 97)
  for (let offset = 0; offset < ${String(size)}; offset += bytes.length) responseData(frame.streamId, bytes)
  responseEnd(frame.streamId)
}
`)
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      const response = await host.fetch(new Request('dsh-app://app/large'))
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body).toHaveLength(size)
      expect(body[0]).toBe(97)
      expect(body.at(-1)).toBe(97)
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('stops an unfinished upload when the Host completes its response early', async () => {
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'early-response' })
function onRequestFrame(frame) {
  if (frame.type !== 2) return
  responseStart(frame.streamId)
  responseData(frame.streamId, 'accepted')
  responseEnd(frame.streamId)
}
`)
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('first')) },
      cancel() { canceled = true },
    })
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      const request = new Request('dsh-app://app/early', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      const response = await host.fetch(request)
      await expect(response.text()).resolves.toBe('accepted')
      await expect.poll(() => canceled).toBe(true)
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('ignores a response end that arrives after the renderer cancels its stream', async () => {
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'cancel-race' })
const urls = new Map()
function onRequestFrame(frame) {
  if (frame.type === 1) {
    const request = JSON.parse(frame.payload)
    urls.set(frame.streamId, request.url)
    responseStart(frame.streamId)
    if (request.url.endsWith('/after')) {
      responseData(frame.streamId, 'alive')
      responseEnd(frame.streamId)
    }
  } else if (frame.type === 4 && urls.get(frame.streamId).endsWith('/cancel')) {
    responseEnd(frame.streamId)
  }
}
`)
    const host = new DesktopHostProcess(process.execPath, project, project)
    try {
      const canceled = await host.fetch(new Request('dsh-app://app/cancel'))
      await canceled.body?.cancel()
      await new Promise(resolve => setTimeout(resolve, 25))
      const after = await host.fetch(new Request('dsh-app://app/after'))
      await expect(after.text()).resolves.toBe('alive')
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('rejects invalid response framing and a clean exit before readiness', async () => {
    const invalid = new DesktopHostProcess(process.execPath, projectWithHost(`
process.send({ type: 'ready', protocolVersion: 3, dshVersion: 'invalid-frame' })
function onRequestFrame(frame) {
  if (frame.type === 1) responsePipe.write(Buffer.alloc(13))
}
`), projectWithHost(''))
    await invalid.start()
    await expect(invalid.fetch(new Request('dsh-app://app/invalid'))).rejects.toThrow(/invalid Host response frame marker/u)
    await invalid.stop().catch(() => undefined)

    const earlyExit = new DesktopHostProcess(process.execPath, projectWithHost(`
function onRequestFrame() {}
process.exit(0)
`), projectWithHost(''))
    await expect(earlyExit.start()).rejects.toThrow(/response pipe ended/u)
  })
})
