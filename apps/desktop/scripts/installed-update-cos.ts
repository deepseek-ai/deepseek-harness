/** Fixed test-COS transport; callers authorize writes separately from local planning. */
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { cosOperation } from './cos-operation.ts'
import { createDesktopCos, DESKTOP_COS_REGION } from './desktop-cos.ts'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import type { InstalledUpdatePublicationStore, InstalledUpdateRemoteObject } from './installed-update-publication.ts'

const BUCKET = 'bj-toc-download-test-1320056602'
const ORIGIN = 'https://download-test.deepseek.com'

/** COS reports a missing key through this error code; no other status means absence. */
function isMissingObject(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'NoSuchKey'
}

async function hashStream(stream: AsyncIterable<Uint8Array>): Promise<InstalledUpdateRemoteObject> {
  const hash = createHash('sha512')
  let size = 0
  for await (const bytes of stream) { hash.update(bytes); size += bytes.length }
  return { sha512: hash.digest('base64'), size }
}

/**
 * Create a fixed test transport from .env.windows, passing only test upload credentials to the SDK.
 * Version queries have a 30-second total deadline; object reads and PUTs have 15 minutes.
 * Expiration aborts HTTP requests and waits for closure before releasing the publication operation.
 * @returns Store whose writes are streamed and therefore cannot be repeated by the SDK.
 */
export function createInstalledUpdateCos(): InstalledUpdatePublicationStore {
  const environment = loadDesktopPackageEnvironment('win32')
  if (environment.DSH_DESKTOP_AUTO_UPDATE_ENV !== 'test' || environment.DOWNLOAD_TEST_ORIGIN !== ORIGIN
    || environment.DOWNLOAD_TEST_COS_BUCKET !== BUCKET || !environment.DOWNLOAD_TEST_COS_SECRET_ID?.trim()
    || !environment.DOWNLOAD_TEST_COS_SECRET_KEY?.trim()) throw new Error('installed update: complete test upload settings are required')
  const credentials = {
    secretId: environment.DOWNLOAD_TEST_COS_SECRET_ID,
    secretKey: environment.DOWNLOAD_TEST_COS_SECRET_KEY,
  }
  const client = () => createDesktopCos(credentials)
  const keyAllowed = (key: string): void => {
    if (!/^dsh-desk\/(?:bin|feeds)\/qualification\/[a-f0-9]{24}\/win-x64\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key)) {
      throw new Error('installed update: COS key must stay in the Windows qualification namespace')
    }
  }
  return {
    async versioningDisabled() {
      const cos = client()
      const response = await cosOperation(cos, 30_000, () => cos.getBucketVersioning({ Bucket: BUCKET, Region: DESKTOP_COS_REGION }))
      const status: 'Enabled' | 'Suspended' | undefined = response.VersioningConfiguration.Status
      return response.statusCode === 200 && status === undefined
    },
    async read(key) {
      keyAllowed(key)
      const hash = createHash('sha512')
      let size = 0
      // Output keeps the object out of memory and makes the SDK wait for the write to finish.
      const output = new Writable({
        write(bytes: Buffer, _encoding, done) { hash.update(bytes); size += bytes.length; done() },
      })
      try {
        const cos = client()
        await cosOperation(cos, 900_000, () => cos.getObject({ Bucket: BUCKET, Region: DESKTOP_COS_REGION, Key: key, Output: output }))
      } catch (error) {
        if (isMissingObject(error)) return null
        throw error
      } finally { output.destroy() }
      return { sha512: hash.digest('base64'), size }
    },
    async publicRead(url) {
      const parsed = new URL(url)
      if (parsed.origin !== ORIGIN || parsed.search || parsed.hash) throw new Error('installed update: exact test public URL is required')
      keyAllowed(parsed.pathname.slice(1))
      const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(900_000) })
      if (response.status === 404) { await response.body?.cancel(); return null }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('installed update: public object read failed') }
      const reader = response.body.getReader()
      async function* bytes() {
        try {
          for (;;) { const next = await reader.read(); if (next.done) return; yield next.value }
        } finally { try { await reader.cancel() } finally { reader.releaseLock() } }
      }
      return hashStream(bytes())
    },
    async put(key, object) {
      keyAllowed(key)
      const md5 = createHash('md5')
      const sha512 = createHash('sha512')
      let size = 0
      const add = (bytes: Buffer): void => { md5.update(bytes); sha512.update(bytes); size += bytes.length }
      if ('path' in object.source) {
        for await (const bytes of createReadStream(object.source.path)) add(bytes as Buffer)
      } else add(Buffer.from(object.source.contents))
      if (size !== object.size || sha512.digest('base64') !== object.sha512) {
        throw new Error('installed update: upload input bytes changed')
      }
      const headers: Record<string, string> = { 'Content-MD5': md5.digest('base64') }
      if (object.forbidOverwrite) headers['x-cos-forbid-overwrite'] = 'true'
      const body = 'path' in object.source
        ? createReadStream(object.source.path)
        : Readable.from([Buffer.from(object.source.contents)])
      try {
        const cos = client()
        const response = await cosOperation(cos, 900_000, () => cos.putObject({
          Bucket: BUCKET, Region: DESKTOP_COS_REGION, Key: key, Body: body,
          ContentLength: object.size, ContentType: key.endsWith('.yml') ? 'application/yaml' : 'application/octet-stream',
          CacheControl: 'no-store', Headers: headers }))
        return response.RequestId === undefined ? {} : { requestId: response.RequestId }
      } finally { body.destroy() }
    },
  }
}
