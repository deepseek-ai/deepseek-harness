/** COS transport for resumable Desktop publication; callers authorize writes and own the channel lock. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import type COS from 'cos-nodejs-sdk-v5'
import { createDesktopCos, DESKTOP_COS_REGION, type DesktopCosCredentials } from './desktop-cos.ts'
import { cosOperation } from './cos-operation.ts'
import type { DesktopUploadPlan } from './desktop-upload-plan.ts'
import { desktopArtifactDigest, type DesktopPublishTransport } from './desktop-publish.ts'

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'NoSuchKey'
}

/**
 * Create a bounded COS transport restricted to the validated plan's object keys.
 * @param plan Destination and exact object inventory; arbitrary keys are rejected.
 * @param credentials Credentials for this deployment only.
 * @param createClient Client factory; absent uses the shared production client, tests supply a loopback client.
 * @returns Streaming reads and single-attempt writes; transport construction performs no requests.
 */
export function desktopPublishCos(
  plan: DesktopUploadPlan, credentials: DesktopCosCredentials,
  createClient: (credentials: DesktopCosCredentials) => COS = createDesktopCos,
): DesktopPublishTransport {
  const keys = new Map(plan.artifacts.map(artifact => [artifact.key, artifact.channelMetadata]))
  const client = () => createClient(credentials)
  const location = (key: string) => {
    if (!keys.has(key)) throw new Error('desktop publish: object is outside the selected plan')
    return { Bucket: plan.bucket, Region: DESKTOP_COS_REGION, Key: key }
  }
  return {
    async read(key, channel) {
      const address = location(key)
      if (keys.get(key) !== channel) throw new Error('desktop publish: object role mismatch')
      const sha512 = createHash('sha512')
      const chunks: Buffer[] = []
      let size = 0
      const output = new Writable({
        write(bytes: Buffer, _encoding, done) {
          size += bytes.length
          if (channel && size > 1024 * 1024) { done(new Error('desktop publish: channel metadata exceeds 1 MiB')); return }
          sha512.update(bytes)
          if (channel) chunks.push(Buffer.from(bytes))
          done()
        },
      })
      try {
        const cos = client()
        await cosOperation(cos, 900_000, () => cos.getObject({ ...address, Output: output }))
        return { size, sha512: sha512.digest('base64'), ...(channel ? { contents: Buffer.concat(chunks).toString('utf8') } : {}) }
      } catch (error) {
        if (missing(error)) return null
        throw error
      } finally { output.destroy() }
    },
    async put(artifact, digest, forbidOverwrite) {
      const address = location(artifact.key)
      if (keys.get(artifact.key) !== artifact.channelMetadata || forbidOverwrite === artifact.channelMetadata) {
        throw new Error('desktop publish: object write policy mismatch')
      }
      const actual = await desktopArtifactDigest(artifact)
      if (actual.size !== digest.size || actual.sha512 !== digest.sha512) throw new Error('desktop publish: local input changed')
      const cos = client()
      // COS overwrite prevention requires versioning to be absent, not enabled or suspended.
      if (forbidOverwrite) {
        const state = await cosOperation(cos, 30_000, () => cos.getBucketVersioning({ Bucket: plan.bucket, Region: DESKTOP_COS_REGION }))
        if (state.statusCode !== 200 || state.VersioningConfiguration.Status !== undefined) {
          throw new Error('desktop publish: immutable objects require bucket versioning to be disabled')
        }
      }
      const md5 = createHash('md5')
      const bytes = artifact.contents === undefined ? createReadStream(artifact.path) : [Buffer.from(artifact.contents)]
      for await (const chunk of bytes) md5.update(chunk)
      const body = artifact.contents === undefined ? createReadStream(artifact.path) : Readable.from([Buffer.from(artifact.contents)])
      try {
        await cosOperation(cos, 900_000, () => cos.putObject({
          ...address, Body: body, ContentLength: digest.size, ContentType: artifact.contentType,
          Headers: { 'Content-MD5': md5.digest('base64'), ...(forbidOverwrite ? { 'x-cos-forbid-overwrite': 'true' } : {}) },
        }))
      } finally { body.destroy() }
    },
  }
}
