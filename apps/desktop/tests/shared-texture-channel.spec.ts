/**
 * Main answers Host shared-texture control over the Host IPC channel, refuses invalid requests, and fails a Host that
 * sends a malformed envelope. Frames do not use this channel.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createSharedTextureChannel, parseSharedTextureHostRequest } from '../src/shared-texture/channel.ts'
import type { SharedTextureHostLink } from '../src/shared-texture/presenter.ts'
import type { SharedTextureHostRequest } from '@deepseek-ai/dsh-desktop-host/types'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostWith(
  source: string, handle: (request: SharedTextureHostRequest, host: SharedTextureHostLink) => Promise<unknown>,
  onFailure?: (error: Error) => void,
) {
  const runtime = mkdtempSync(join(tmpdir(), 'dsh-shared-texture-channel-'))
  roots.push(runtime)
  const packageRoot = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, {
    onFailure, channels: [createSharedTextureChannel(handle)],
  })
  hosts.push(host)
  return host
}

it('routes valid control to Main with the Host identity and answers each request with its result or error', async () => {
  const request = vi.fn(async (payload: SharedTextureHostRequest, host: SharedTextureHostLink) => {
    if (payload.op === 'adapter-luid') {
      if (payload.timeoutMs === 1) throw new Error('Desktop shared textures are unavailable: gpu-compositing-disabled')
      return '0:1234'
    }
    return { supported: true, pid: host.pid }
  })
  // Invalid requests, including the retired `probe`, `release-probe`, and `present` requests, get error replies
  // without reaching Main's handler.
  const host = hostWith(`
    process.send({ type: 'starting', runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8' })
    process.once('message', authentication => {
      if (authentication.type !== 'desktop-auth') throw new Error('expected authentication')
    process.send({ type: 'shared-texture', requestId: 17, request: { op: 'capabilities' } })
    process.send({ type: 'shared-texture', requestId: 18, request: { op: 'adapter-luid', timeoutMs: 1 } })
    process.send({ type: 'shared-texture', requestId: 19, request: { op: 'adapter-luid' } })
    process.send({ type: 'shared-texture', requestId: 20, request: { op: 'probe', holdMs: 1000 } })
    process.send({ type: 'shared-texture', requestId: 21, request: { op: 'release-probe', probeId: 'p' } })
    process.send({ type: 'shared-texture', requestId: 22, request: { op: 'present', presentation: { id: 'texture-1' }, timeoutMs: 1000 } })
    process.send({ type: 'shared-texture', requestId: 23, request: { op: 'adapter-luid', timeoutMs: 1000 } })
    const replies = new Map()
    process.on('message', message => {
      if (message.type === 'shared-texture') {
        replies.set(message.requestId, message)
        if (replies.size < 7) return
        const first = replies.get(17), unsupported = replies.get(18), adapter = replies.get(23)
        if (first.value.pid !== process.pid || !unsupported.error.includes('gpu-compositing-disabled') || adapter.value !== '0:1234') process.exit(9)
        for (const invalid of [19, 20, 21, 22]) if (typeof replies.get(invalid).error !== 'string') process.exit(8)
        process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
      }
      if (message.type === 'shutdown') {
        process.send({ type: 'shared-texture', requestId: 24, request: { op: 'adapter-luid', timeoutMs: 1000 } })
        process.on('message', late => {
          if (late.requestId !== 24 || late.error !== 'Desktop shared textures are unavailable') process.exit(10)
          process.send({ type: 'shutdown-complete' }, () => process.disconnect())
        })
      }
    })
    })
  `, request)
  await host.start()
  expect(request.mock.calls.map(([payload, link]) => [payload, typeof link.pid])).toEqual([
    [{ op: 'capabilities' }, 'number'], [{ op: 'adapter-luid', timeoutMs: 1 }, 'number'], [{ op: 'adapter-luid', timeoutMs: 1000 }, 'number'],
  ])
  await host.stop(true)
  expect(request).toHaveBeenCalledTimes(3)
})

it.each([
  "{ type: 'shared-texture', requestId: -1, request: { op: 'capabilities' } }",
  "{ type: 'shared-texture', requestId: 1.5, request: { op: 'capabilities' } }",
  "{ type: 'shared-texture', requestId: 1 }",
])('fails and terminates a Host that sends the malformed envelope %s', async (envelope) => {
  const failure = vi.fn()
  const request = vi.fn(async () => undefined)
  const host = hostWith(`process.send(${envelope}); setInterval(() => {}, 1000)`, request, failure)
  await expect(host.start()).rejects.toThrow('dsh desktop host sent invalid shared-texture control')
  expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host sent invalid shared-texture control'))
  expect(request).not.toHaveBeenCalled()
})

describe('request validation', () => {
  it('accepts only capability and bounded adapter requests', () => {
    expect(parseSharedTextureHostRequest({ op: 'capabilities' })).toEqual({ op: 'capabilities' })
    expect(parseSharedTextureHostRequest({ op: 'adapter-luid', timeoutMs: 10 })).toEqual({ op: 'adapter-luid', timeoutMs: 10 })
    // Main's presenter relies on this limit: a longer deadline is shortened, not refused.
    expect(parseSharedTextureHostRequest({ op: 'adapter-luid', timeoutMs: 2_000_000_000 })).toEqual({ op: 'adapter-luid', timeoutMs: 30_000 })
    expect(parseSharedTextureHostRequest({ op: 'adapter-luid', timeoutMs: 30_001 })).toEqual({ op: 'adapter-luid', timeoutMs: 30_000 })
    for (const invalid of [
      { op: 'adapter-luid' }, { op: 'adapter-luid', timeoutMs: 0 }, { op: 'adapter-luid', timeoutMs: 1.5 },
      { op: 'adapter-luid', timeoutMs: 2_147_483_647 }, { op: 'adapter-luid', timeoutMs: '1000' },
      { op: 'probe', holdMs: 1000 }, { op: 'release-probe', probeId: 'p' },
      { op: 'present', presentation: { id: 'texture-1', handle: { ntHandle: 1 }, width: 4, height: 2, pixelFormat: 'bgra', metadata: null }, timeoutMs: 1000 },
      { op: 'other' }, null,
    ])
      expect(() => parseSharedTextureHostRequest(invalid)).toThrow()
  })
})
