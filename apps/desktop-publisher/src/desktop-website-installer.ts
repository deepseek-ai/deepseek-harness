/** Validate one production installer and hold its file handle through COS publication. */
import { createHash } from 'node:crypto'
import { open, lstat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { DesktopRetainedManifest } from './desktop-release-store.ts'
import type { DesktopPublishRoute } from './desktop-publish-route.ts'
import { desktopLatestInstallerFilename, desktopWebsiteInstallerUrl } from './desktop-auto-update-environment.mjs'
import { createDesktopCos, DESKTOP_COS_REGION, type DesktopCosCredentials } from './desktop-cos.ts'
import { cosOperation } from './cos-operation.ts'
import type { DesktopObjectDigest, DesktopPublishTransport } from './desktop-publish.ts'
import { DesktopCosOperationError } from './desktop-publication-failure.ts'
import type { DesktopSingleUploadPlan } from './desktop-upload-types.ts'

/** Verified file and destination; the caller closes the handle after publication. */
export interface DesktopWebsiteInstaller {
  readonly plan: DesktopSingleUploadPlan
  readonly digest: DesktopObjectDigest
  readonly md5: string
  readonly contentDisposition: string
  readonly handle: FileHandle
}

/**
 * Check production build identity and hash only the selected installer once.
 * @param directory Retained build directory on the original runner.
 * @param manifest Trusted retained build inventory matched against GitHub evidence.
 * @param route Pinned build identity from the credential-free routing job.
 * @param repository Repository expected by the workflow.
 * @param bucket Approved production COS bucket.
 * @returns An open verified installer; callers must close its handle in finally.
 */
export async function prepareWebsiteInstaller(directory: string, manifest: DesktopRetainedManifest,
  route: DesktopPublishRoute, repository: string, bucket: string): Promise<DesktopWebsiteInstaller> {
  const source = manifest.source
  if (route.preset !== 'production' || source.preset !== 'production'
    || source.repository !== repository || source.runId !== route.runId || source.attempt !== route.attempt
    || source.commit !== route.commit || source.runnerName !== route.runnerName || source.target !== route.target
    || source.sourceRef !== route.sourceRef || source.channel !== route.channel
    || source.qualification !== (route.target === 'win-x64' ? 'signed' : 'notarized')
    || !/^(?:master|dsh-v[0-9][0-9A-Za-z.-]*)$/u.test(source.sourceRef)) {
    throw new Error('website installer: build identity or production qualification mismatch')
  }
  const windows = route.target === 'win-x64'
  const filename = `deepseek-harness-${source.version}-${route.target}.${windows ? 'exe' : 'dmg'}`
  const file = manifest.files.find(item => item.name === filename)
  if (!file) throw new Error('website installer: selected installer is absent from build manifest')
  const path = join(directory, file.name)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('website installer: expected a regular installer file')
  const handle = await open(path, 'r')
  try {
    const sha512 = createHash('sha512')
    const md5 = createHash('md5')
    let size = 0
    for await (const bytes of handle.createReadStream({ autoClose: false, start: 0 }) as AsyncIterable<Buffer>) {
      size += bytes.length
      sha512.update(bytes)
      md5.update(bytes)
    }
    const digest = { size, sha512: sha512.digest('base64') }
    if (size !== file.size || digest.sha512 !== file.sha512) throw new Error('website installer: SHA-512 or size differs from build manifest')
    const key = `desktop/${desktopLatestInstallerFilename(route.target)}`
    const contentDisposition = `attachment; filename="${file.name}"`
    return { handle, digest, contentDisposition, md5: md5.digest('base64'), plan: {
      environment: 'production', target: route.target, version: source.version, commit: source.commit, dirty: false,
      bucket, publicUrl: desktopWebsiteInstallerUrl(route.target),
      secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID', secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
      artifacts: [{ path, filename: file.name, key, channelMetadata: false,
        contentDisposition,
        contentType: windows ? 'application/vnd.microsoft.portable-executable' : 'application/x-apple-diskimage' }],
    } }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * Reconcile an earlier upload or replace the fixed object once using the already verified handle.
 * @param installer Open installer verified against the selected build.
 * @param credentials Production upload credentials, never logged.
 * @param transport Read-only reconciliation adapter using the same destination.
 * @param record Durable event writer; intent must persist before the remote write.
 * @param options Optional COS factory and durable completion evidence; completed uploads cannot replace different remote bytes.
 * @returns Whether bytes were uploaded or an existing identical object was reused.
 */
export async function uploadWebsiteInstaller(installer: DesktopWebsiteInstaller, credentials: DesktopCosCredentials,
  transport: Pick<DesktopPublishTransport, 'read'>,
  record: (event: 'upload-intent' | 'uploaded') => Promise<void>,
  options: { createClient?: typeof createDesktopCos; previouslyUploaded?: boolean } = {},
): Promise<'uploaded' | 'present'> {
  const artifact = installer.plan.artifacts[0]
  const matches = (remote: DesktopObjectDigest | null) =>
    remote?.size === installer.digest.size && remote.sha512 === installer.digest.sha512
  const remote = await transport.read(artifact.key, false)
  if (options.previouslyUploaded && !matches(remote)) throw new Error(`website installer: recorded upload no longer matches remote bytes (${remote === null ? 'object missing' : 'bytes changed'}); select and approve a new publication`)
  if (matches(remote) && remote?.contentDisposition === installer.contentDisposition) {
    await record('uploaded')
    return 'present'
  }
  await record('upload-intent')
  const body = installer.handle.createReadStream({ autoClose: false, start: 0 })
  const cos = (options.createClient ?? createDesktopCos)(credentials)
  try {
    await cosOperation(cos, 900_000, () => cos.putObject({ Bucket: installer.plan.bucket, Region: DESKTOP_COS_REGION,
      Key: artifact.key, Body: body, ContentLength: installer.digest.size, ContentType: artifact.contentType,
      Headers: { 'Content-MD5': installer.md5, 'Content-Disposition': installer.contentDisposition },
    }))
  } catch (error) { throw new DesktopCosOperationError('PutObject', error) }
  finally { body.destroy() }
  const confirmed = await transport.read(artifact.key, false)
  if (!matches(confirmed)) throw new Error(`website installer: remote bytes unconfirmed; expected ${JSON.stringify(installer.digest)}, observed ${JSON.stringify(confirmed)}; reconcile before retrying`)
  if (confirmed?.contentDisposition !== installer.contentDisposition) throw new Error(`website installer: remote download filename unconfirmed; expected ${JSON.stringify(installer.contentDisposition)}, observed ${JSON.stringify(confirmed?.contentDisposition ?? null)}; inspect COS metadata before retrying`)
  await record('uploaded')
  return 'uploaded'
}
