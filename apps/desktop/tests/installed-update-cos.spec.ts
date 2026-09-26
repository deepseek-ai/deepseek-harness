import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type COS from 'cos-nodejs-sdk-v5'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInstalledUpdateCos } from '../scripts/installed-update-cos.ts'
import { answer, cosError, startCosLoopback, type CosLoopback, type CosLoopbackResponder } from './cos-loopback.ts'

const state = vi.hoisted(() => ({
  settings: 'test',
  redirect: undefined as ((cos: COS) => void) | undefined,
}))

vi.mock('../scripts/desktop-package-environment.mjs', () => ({ loadDesktopPackageEnvironment: () => ({
  DSH_DESKTOP_AUTO_UPDATE_ENV: state.settings, DOWNLOAD_TEST_ORIGIN: 'https://download-test.deepseek.com',
  DOWNLOAD_TEST_COS_BUCKET: 'bj-toc-download-test-1320056602', DOWNLOAD_TEST_COS_SECRET_ID: 'fixture-id',
  DOWNLOAD_TEST_COS_SECRET_KEY: 'fixture-key', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin-not-for-sdk',
}) }))

vi.mock('../scripts/desktop-cos.ts', async (original) => {
  const actual = await original<typeof import('../scripts/desktop-cos.ts')>()
  return { ...actual, createDesktopCos: (credentials: Parameters<typeof actual.createDesktopCos>[0]) => {
    const cos = actual.createDesktopCos(credentials)
    state.redirect?.(cos)
    return cos
  } }
})

const loopbacks: CosLoopback[] = []
const roots: string[] = []
afterEach(async () => {
  const closers = loopbacks.splice(0)
  const paths = roots.splice(0)
  vi.useRealTimers()
  state.settings = 'test'
  state.redirect = undefined
  try {
    try { await Promise.all(closers.map(loopback => loopback.close())) }
    finally { vi.unstubAllGlobals() }
  }
  finally { await Promise.all(paths.map(path => rm(path, { recursive: true, force: true }))) }
})

const BUCKET = 'bj-toc-download-test-1320056602'
const key = `dsh-desk/bin/qualification/${'a'.repeat(24)}/win-x64/package.exe`

/** Store whose SDK client sends every request to a fresh loopback origin. */
async function store(responder: CosLoopbackResponder) {
  const loopback = await startCosLoopback(responder)
  loopbacks.push(loopback)
  state.redirect = (cos) => { loopback.redirect(cos) }
  return { store: createInstalledUpdateCos(), loopback }
}

function expectedHost(): string {
  return `${BUCKET}.cos.ap-beijing.myqcloud.com`
}

describe('qualification COS transport with real SDK serialization over a loopback origin', () => {
  it('sends one streamed PUT with explicit length, MD5, no-store policy and a signed non-overwrite header', async () => {
    const { store: cos, loopback } = await store((_request, response) => {
      answer(response, 200, '', { 'x-cos-request-id': 'fixture-request' })
    })
    expect(loopback.requests).toHaveLength(0)
    expect(await cos.put(key, { source: { contents: 'bytes' }, size: 5,
      sha512: createHash('sha512').update('bytes').digest('base64'), forbidOverwrite: true })).toEqual({ requestId: 'fixture-request' })
    expect(loopback.requests).toHaveLength(1)
    const request = loopback.requests[0]!
    expect(request.method).toBe('PUT')
    expect(request.path).toBe(`/${key}`)
    expect(request.body.toString('utf8')).toBe('bytes')
    expect(request.headers['content-length']).toBe('5')
    expect(request.headers['content-md5']).toBe(createHash('md5').update('bytes').digest('base64'))
    expect(request.headers['cache-control']).toBe('no-store')
    expect(request.headers['x-cos-forbid-overwrite']).toBe('true')
    expect(request.headers['transfer-encoding']).toBeUndefined()
    expect(request.headers['content-encoding']).toBeUndefined()
    const signed = new URL(request.signedUrl!)
    expect(signed.protocol).toBe('https:')
    expect(signed.host).toBe(expectedHost())
    const authorization = String(request.headers.authorization)
    expect(authorization).toContain('q-sign-algorithm=sha1')
    expect(authorization).toContain('x-cos-forbid-overwrite')
    expect(JSON.stringify(request.headers)).not.toContain('fixture-pin')
    expect(JSON.stringify(request.headers)).not.toContain('fixture-key')
  })

  it('streams a file-backed object with its declared length', async () => {
    const { store: cos, loopback } = await store((_request, response) => { answer(response, 200) })
    const root = await mkdtemp(join(tmpdir(), 'dsh-cos-file-'))
    roots.push(root)
    const path = join(root, 'package.exe')
    await writeFile(path, 'file bytes')
    expect(await cos.put(key, { source: { path }, size: 10,
      sha512: createHash('sha512').update('file bytes').digest('base64'), forbidOverwrite: true })).toEqual({})
    expect(loopback.requests).toHaveLength(1)
    expect(loopback.requests[0]!.body.toString('utf8')).toBe('file bytes')
    expect(loopback.requests[0]!.headers['content-length']).toBe('10')
    expect(loopback.requests[0]!.headers['content-type']).toBe('application/octet-stream')
    expect(loopback.requests[0]!.headers['x-cos-forbid-overwrite']).toBe('true')
  })

  it.each([
    ['', true],
    ['<Status>Enabled</Status>', false],
    ['<Status>Suspended</Status>', false],
  ] as const)('reads bucket versioning %j as disabled=%s', async (status, disabled) => {
    const { store: cos, loopback } = await store((_request, response) => {
      answer(response, 200, `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${status}</VersioningConfiguration>`,
        { 'content-type': 'application/xml' })
    })
    expect(await cos.versioningDisabled()).toBe(disabled)
    expect(loopback.requests).toHaveLength(1)
    expect(loopback.requests[0]!.path).toContain('versioning')
  })

  it('does not retry an uncertain PUT failure', async () => {
    const { store: cos, loopback } = await store((_request, response) => {
      answer(response, 500, cosError('InternalError'), { 'content-type': 'application/xml', 'x-cos-request-id': 'fixture-request' })
    })
    await expect(cos.put(key, { source: { contents: 'x' }, size: 1,
      sha512: createHash('sha512').update('x').digest('base64'), forbidOverwrite: true })).rejects.toThrow()
    expect(loopback.requests).toHaveLength(1)
  })

  it.each(['versioning', 'read', 'put'] as const)('enforces the qualification %s total deadline', async (operation) => {
    const received = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { store: cos, loopback } = await store((_request, response) => {
      response.once('close', () => { closed.resolve(undefined) })
      received.resolve(undefined)
    })
    const pending = operation === 'versioning' ? cos.versioningDisabled()
      : operation === 'read' ? cos.read(key)
        : cos.put(key, { source: { contents: 'x' }, size: 1,
          sha512: createHash('sha512').update('x').digest('base64'), forbidOverwrite: true })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await received.promise
    vi.advanceTimersByTime(operation === 'versioning' ? 30_000 : 900_000)
    await rejected
    await closed.promise
    expect(loopback.requests).toHaveLength(1)
  })

  it('hashes exact received object bytes without buffering the whole object', async () => {
    const { store: cos, loopback } = await store((_request, response) => { answer(response, 200, 'object bytes') })
    expect(await cos.read(key)).toEqual({ size: 12, sha512: createHash('sha512').update('object bytes').digest('base64') })
    expect(loopback.requests).toHaveLength(1)
    expect(loopback.requests[0]!.method).toBe('GET')
    expect(loopback.requests[0]!.path).toBe(`/${key}`)
  })

  it('distinguishes confirmed object absence from permission errors', async () => {
    const { store: cos, loopback } = await store((_request, response) => {
      const status = loopback.requests.length === 1 ? 404 : 403
      answer(response, status, cosError(status === 404 ? 'NoSuchKey' : 'AccessDenied'),
        { 'content-type': 'application/xml', 'x-cos-request-id': 'fixture-request' })
    })
    expect(await cos.read(key)).toBeNull()
    await expect(cos.read(key)).rejects.toThrow()
    expect(loopback.requests).toHaveLength(2)
  })

  it('fails a read whose transfer ends before the declared length', async () => {
    const { store: cos, loopback } = await store((_request, response) => {
      response.writeHead(200, { 'content-length': '12', connection: 'close' })
      response.write('part')
      response.socket?.destroy()
    })
    await expect(cos.read(key)).rejects.toThrow()
    expect(loopback.requests).toHaveLength(1)
  })

  it('hashes public response bytes at the exact URL and rejects redirects or unrelated destinations', async () => {
    const fetch = vi.fn(async () => new Response('public bytes'))
    vi.stubGlobal('fetch', fetch)
    const { store: cos } = await store((_request, response) => { answer(response) })
    const url = `https://download-test.deepseek.com/${key}`
    expect(await cos.publicRead(url)).toEqual({ size: 12, sha512: createHash('sha512').update('public bytes').digest('base64') })
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error', cache: 'no-store' }))
    await expect(cos.publicRead(`${url}?fresh=1`)).rejects.toThrow('exact test public URL')
    await expect(cos.publicRead(url.replace('download-test', 'download'))).rejects.toThrow('exact test public URL')
    await expect(cos.read('dsh-desk/feeds/nightly.yml')).rejects.toThrow('qualification namespace')
  })

  it('refuses production settings without creating a request', async () => {
    state.settings = 'production'
    const loopback = await startCosLoopback((_request, response) => { answer(response) })
    loopbacks.push(loopback)
    state.redirect = (cos) => { loopback.redirect(cos) }
    expect(() => createInstalledUpdateCos()).toThrow('test upload settings')
    expect(loopback.requests).toHaveLength(0)
  })

  it('rejects mismatched upload bytes and unsafe keys before sending a request', async () => {
    const { store: cos, loopback } = await store((_request, response) => { answer(response) })
    await expect(cos.put(key, { source: { contents: 'changed' }, size: 1, sha512: 'wrong', forbidOverwrite: true }))
      .rejects.toThrow('input bytes changed')
    await expect(cos.read(key.replace('package.exe', '..'))).rejects.toThrow('qualification namespace')
    expect(loopback.requests).toHaveLength(0)
  })
})
