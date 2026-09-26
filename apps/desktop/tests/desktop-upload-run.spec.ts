import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import COS from 'cos-nodejs-sdk-v5'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopCos, DESKTOP_COS_REGION } from '../scripts/desktop-cos.ts'
import { uploadDesktopRelease } from '../scripts/desktop-upload-run.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { answer, cosError, startCosLoopback, type CosLoopback, type CosLoopbackRequest } from './cos-loopback.ts'

const roots: string[] = []
const loopbacks: CosLoopback[] = []
afterEach(async () => {
  const closers = loopbacks.splice(0)
  const paths = roots.splice(0)
  try { await Promise.all(closers.map(loopback => loopback.close())) }
  finally { await Promise.all(paths.map(path => rm(path, { recursive: true, force: true }))) }
})

const BINARY_BYTES = 'binary fixture'
const FEED_BYTES = 'version: 1.2.3\n'

async function fixture(environment: 'test' | 'production' = 'test') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-audit-'))
  roots.push(root)
  const binary = join(root, 'package.exe')
  await writeFile(binary, BINARY_BYTES)
  const bucket = `${environment}-fixture-1250000000`
  const plan: DesktopUploadPlan = {
    environment, target: 'win-x64', version: '1.2.3', bucket,
    publicUrl: `https://${environment}.invalid/feed/`, secretIdEnvName: 'UNREAD_ID', secretKeyEnvName: 'UNREAD_KEY',
    artifacts: [
      { path: binary, filename: 'package.exe', key: 'bin/package.exe', contentType: 'application/octet-stream', channelMetadata: false },
      { path: join(root, 'nightly.yml'), filename: 'nightly.yml', key: 'feeds/nightly.yml', contentType: 'application/yaml', channelMetadata: true,
        contents: FEED_BYTES },
    ],
  }
  const records = join(root, 'records')
  const directory = async () => join(records, (await readdir(records))[0]!)
  return { root, records, plan, bucket, directory }
}

/** Production client redirecting to one isolated loopback origin. */
async function transport(responder?: Parameters<typeof startCosLoopback>[0]) {
  const loopback = await startCosLoopback(responder)
  loopbacks.push(loopback)
  const cos = createDesktopCos({ secretId: 'test-credential-id', secretKey: 'test-credential-secret' })
  loopback.redirect(cos)
  return { cos, loopback }
}

interface RecordedPlan {
  environment: string
  artifacts: ({ contents?: string } & { md5: string; sha512: string; size: number })[]
  sourceSha256: Record<string, string>
}

async function json<T = unknown>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T }

async function journal(path: string): Promise<{ type: string; time: string }[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; time: string })
}

/** Assert the wire form shared by every upload: exact bytes, one content-length, no transfer encoding. */
function expectExactObject(request: CosLoopbackRequest, expected: string, contentType: string, bucket: string): void {
  expect(request.method).toBe('PUT')
  expect(request.body.toString('utf8')).toBe(expected)
  expect(request.headers['content-length']).toBe(String(Buffer.byteLength(expected)))
  expect(request.headers['content-type']).toBe(contentType)
  expect(request.headers['transfer-encoding']).toBeUndefined()
  expect(request.headers['content-encoding']).toBeUndefined()
  expect(request.headers['content-md5']).toBe(createHash('md5').update(expected).digest('base64'))
  const signed = new URL(request.signedUrl!)
  expect(signed.protocol).toBe('https:')
  expect(signed.host).toBe(`${bucket}.cos.${DESKTOP_COS_REGION}.myqcloud.com`)
  expect(signed.search).toBe('')
}

describe('release upload audit with the real COS SDK and an isolated loopback origin', () => {
  it.each(['test', 'production'] as const)('retains %s plan, feed bytes, intent, receipt and hashes before advancing', async (environment) => {
    const f = await fixture(environment)
    const { cos, loopback } = await transport(async (request, response) => {
      const directory = await f.directory()
      const plan = await json<RecordedPlan>(join(directory, 'plan.json'))
      expect(plan.environment).toBe(environment)
      expect(plan.artifacts[1]!.contents).toBe(FEED_BYTES)
      const lines = await journal(join(directory, 'events.jsonl'))
      expect(lines.at(-1)).toMatchObject({ type: 'put-intent', key: f.plan.artifacts[loopback.requests.length - 1]!.key })
      expect(request.headers['content-md5']).toBe(plan.artifacts[loopback.requests.length - 1]!.md5)
      answer(response, 200, '', { 'x-cos-request-id': 'fixture-request' })
    })
    const directory = await uploadDesktopRelease(f.plan, cos, f.records)
    expect(loopback.requests).toHaveLength(2)
    expectExactObject(loopback.requests[0]!, BINARY_BYTES, 'application/octet-stream', f.bucket)
    expectExactObject(loopback.requests[1]!, FEED_BYTES, 'application/yaml', f.bucket)
    expect(loopback.requests[0]!.path).toBe('/bin/package.exe')
    expect(loopback.requests[1]!.path).toBe('/feeds/nightly.yml')
    for (const request of loopback.requests) {
      const authorization = String(request.headers.authorization)
      expect(authorization).toContain('q-sign-algorithm=sha1')
      expect(authorization).toContain('content-md5')
      expect(authorization).not.toContain('test-credential-secret')
    }
    const plan = await json<RecordedPlan>(join(directory, 'plan.json'))
    expect(plan.artifacts[0]!.sha512).toBe(createHash('sha512').update(BINARY_BYTES).digest('base64'))
    expect(plan.sourceSha256['upload-target.ts']).toBe(createHash('sha256')
      .update(await readFile(join(import.meta.dirname, '../scripts/upload-target.ts'))).digest('hex'))
    expect(plan.sourceSha256['desktop-cos.ts']).toBe(createHash('sha256')
      .update(await readFile(join(import.meta.dirname, '../scripts/desktop-cos.ts'))).digest('hex'))
    const result = await json(join(directory, 'result.json'))
    expect(result).toMatchObject({ success: true, stage: 'complete', confirmedPuts: 2, publicReadback: 'not-performed' })
    const events = await journal(join(directory, 'events.jsonl'))
    expect(`${events.map(event => event.type).join('\n')}\n`).toBe(await readFile(join(import.meta.dirname, 'expected/desktop-upload-audit.txt'), 'utf8'))
    expect(events[2]).toMatchObject({ httpStatus: 200, requestId: 'fixture-request', attempts: 1 })
    for (const event of events) expect(Number.isFinite(Date.parse(event.time))).toBe(true)
    expect(JSON.stringify({ plan, result, events })).not.toMatch(/test-credential|authorization|UNREAD_KEY/iu)
  })

  it.each([1, 2])('retains failure at PUT %s without retry or later upload, excluding raw SDK diagnostics', async (failAt) => {
    const f = await fixture()
    const { cos, loopback } = await transport((_request, response) => {
      if (loopback.requests.length === failAt) {
        answer(response, 500, cosError('InternalError', 'test-credential-secret'),
          { 'content-type': 'application/xml', 'x-cos-request-id': 'fixture-request' })
        return
      }
      answer(response, 200, '', { 'x-cos-request-id': 'fixture-request' })
    })
    await expect(uploadDesktopRelease(f.plan, cos, f.records)).rejects.toThrow('stopped at put')
    expect(loopback.requests).toHaveLength(failAt)
    const directory = await f.directory()
    const result = await json(join(directory, 'result.json'))
    expect(result).toMatchObject({ success: false, confirmedPuts: failAt - 1, stage: 'put', failure: { errorCode: 'InternalError', httpStatus: 500, requestId: 'fixture-request' } })
    expect(await readFile(join(directory, 'result.json'), 'utf8')).not.toContain('test-credential-secret')
    expect((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(failAt * 2)
  })

  it('cannot repeat the write when a client leaves every SDK retry option at its default', async () => {
    const f = await fixture()
    const loopback = await startCosLoopback((_request, response) => {
      answer(response, 500, cosError('InternalError'), { 'content-type': 'application/xml', 'x-cos-request-id': 'fixture-request' })
    })
    loopbacks.push(loopback)
    // Deliberately retry-permissive: a buffer body for the manifest would let the SDK send it up to four times.
    const cos = new COS({ SecretId: 'test-credential-id', SecretKey: 'test-credential-secret', Protocol: 'https:' })
    loopback.redirect(cos)
    await expect(uploadDesktopRelease(f.plan, cos, f.records)).rejects.toThrow('stopped at put')
    expect(loopback.requests.map(request => request.path)).toEqual(['/bin/package.exe'])
    expect(loopback.requests[0]!.body.toString('utf8')).toBe(BINARY_BYTES)
  })

  it.each([1, 2])('reports a dropped connection at PUT %s once without sending the object again', async (dropAt) => {
    const f = await fixture()
    const { cos, loopback } = await transport((_request, response) => {
      if (loopback.requests.length === dropAt) { response.destroy(); return }
      answer(response, 200, '', { 'x-cos-request-id': 'fixture-request' })
    })
    await expect(uploadDesktopRelease(f.plan, cos, f.records)).rejects.toThrow('stopped at put')
    expect(loopback.requests).toHaveLength(dropAt)
    const result = await json(join(await f.directory(), 'result.json'))
    expect(result).toMatchObject({ success: false, confirmedPuts: dropAt - 1, stage: 'put', failure: { errorCode: 'ECONNRESET' } })
  })

  it('refuses networking when the audit parent cannot be created', async () => {
    const f = await fixture()
    const { cos, loopback } = await transport()
    await expect(uploadDesktopRelease(f.plan, cos, f.plan.artifacts[0]!.path)).rejects.toThrow()
    expect(loopback.requests).toHaveLength(0)
  })

  it('stops before the next PUT when a response cannot be recorded', async () => {
    const f = await fixture()
    const { cos, loopback } = await transport(async (_request, response) => {
      const directory = await f.directory()
      await rename(join(directory, 'events.jsonl'), join(directory, 'events-before-failure.jsonl'))
      await mkdir(join(directory, 'events.jsonl'))
      answer(response, 200, '', { 'x-cos-request-id': 'fixture-request' })
    })
    await expect(uploadDesktopRelease(f.plan, cos, f.records)).rejects.toThrow('stopped at record-response')
    expect(loopback.requests).toHaveLength(1)
    expect(await json(join(await f.directory(), 'result.json'))).toMatchObject({ success: false, stage: 'record-response', confirmedPuts: 1 })
  })

  it('keeps independent runs without overwriting prior evidence', async () => {
    const f = await fixture()
    const { cos } = await transport()
    const first = await uploadDesktopRelease(f.plan, cos, f.records)
    const before = await readFile(join(first, 'result.json'), 'utf8')
    const second = await uploadDesktopRelease(f.plan, cos, f.records)
    expect(second).not.toBe(first)
    expect(await readFile(join(first, 'result.json'), 'utf8')).toBe(before)
  })
})
