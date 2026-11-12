/** Change only the rollout percentage of an already published Desktop update feed. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { dump, load } from 'js-yaml'
import { z } from 'zod'
import { desktopUpdateMetadataFilename, resolveDesktopUploadConfig } from './desktop-auto-update-environment.mjs'
import type { DesktopRetainedManifest } from './desktop-release-store.ts'
import type { DesktopSingleUploadPlan } from './desktop-upload-types.ts'
import { desktopArtifactDigest, type DesktopPublishOperations, type DesktopRemoteObject } from './desktop-publish.ts'

const percentage = z.number().int().min(0).max(100)
const metadataSchema = z.object({
  version: z.string(),
  files: z.tuple([z.object({ url: z.string(), size: z.number().int().positive(), sha512: z.string() }).loose()]),
  path: z.string().optional(), sha512: z.string().optional(), stagingPercentage: percentage.optional(),
}).loose()

function metadata(contents: string) {
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('desktop rollout: metadata exceeds 1 MiB')
  try { return metadataSchema.parse(load(contents)) }
  // YAML parser details may include raw remote contents; keep them out of publication diagnostics.
  catch { throw new Error('desktop rollout: invalid update metadata') }
}

/** Validated immutable update identity; no installer bytes are read. */
export interface DesktopRolloutPlan {
  readonly upload: DesktopSingleUploadPlan
  readonly expected: string
}

/**
 * Read only the retained update YAML and bind it to its manifest and upload destination.
 * @param directory Original attempt's retained directory.
 * @param manifest Inventory verified against GitHub identity.
 * @param environment Deployment settings loaded from the original machine.
 * @returns A plan permitting only this channel metadata object.
 */
export async function prepareDesktopRollout(directory: string, manifest: DesktopRetainedManifest,
  environment: NodeJS.ProcessEnv): Promise<DesktopRolloutPlan> {
  const source = manifest.source
  const windows = source.target === 'win-x64'
  const platform = windows ? 'win32' : 'darwin'
  const update = resolveDesktopUploadConfig({ ...environment, DSH_DESKTOP_UPDATE_CHANNEL: source.channel },
    platform, source.target === 'mac-arm64' ? 'arm64' : 'x64')
  if (update.environment !== source.preset) throw new Error('desktop rollout: environment differs from original package')
  const filename = desktopUpdateMetadataFilename(source.version, platform, source.channel)
  const item = manifest.files.find(file => file.name === filename)
  if (!item) throw new Error(`desktop rollout: manifest has no update metadata ${filename}`)
  const contents = await readFile(join(directory, filename), 'utf8')
  if (item.size !== Buffer.byteLength(contents)
    || item.sha512 !== createHash('sha512').update(contents).digest('base64')) {
    throw new Error('desktop rollout: retained update metadata differs from manifest')
  }
  const parsed = metadata(contents)
  const payload = `deepseek-harness-${source.version}-${source.target}.${windows ? 'exe' : 'zip'}`
  const file = manifest.files.find(entry => entry.name === payload)
  const entry = parsed.files[0]
  if (parsed.version !== source.version || entry.url !== payload || !file
    || entry.size !== file.size || entry.sha512 !== file.sha512
    || (parsed.path !== undefined && parsed.path !== payload)
    || (parsed.sha512 !== undefined && parsed.sha512 !== file.sha512)) {
    throw new Error('desktop rollout: update metadata does not identify the retained payload')
  }
  const url = `${update.origin}/${update.binaryKeyPrefix}/${payload}`
  const expected = dump({ ...parsed, files: [{ ...entry, url }],
    ...(parsed.path === undefined ? {} : { path: url }) })
  return { expected, upload: {
    environment: source.preset, target: source.target, version: source.version, commit: source.commit, dirty: false,
    publicUrl: update.publicUrl, bucket: update.bucket,
    secretIdEnvName: update.secretIdEnvName, secretKeyEnvName: update.secretKeyEnvName,
    artifacts: [{ path: join(directory, filename), filename, key: `${update.keyPrefix}/${filename}`,
      contents: expected, contentType: 'application/yaml', channelMetadata: true }],
  } }
}

/**
 * Verify current remote metadata against the package, allowing only a different rollout percentage.
 * @param plan Approved package identity and channel destination.
 * @param remote Current COS metadata object.
 * @returns Parsed metadata and effective percentage (100 when absent).
 */
export function verifyDesktopRolloutFeed(plan: DesktopRolloutPlan, remote: DesktopRemoteObject | null) {
  if (!remote?.contents) throw new Error('desktop rollout: published update feed is missing')
  const actual = metadata(remote.contents)
  const expected = metadata(plan.expected)
  const { stagingPercentage: current = 100, ...identity } = actual
  const { stagingPercentage: _original, ...expectedIdentity } = expected
  if (!isDeepStrictEqual(identity, expectedIdentity)) {
    throw new Error('desktop rollout: current feed no longer identifies the selected published package')
  }
  return { metadata: actual, percentage: current }
}

/**
 * Update a published feed under the existing channel lock, or verify it for website-only publication.
 * @param plan Metadata-only plan approved for the selected original package.
 * @param target Target percentage; undefined only verifies current publication.
 * @param operations COS transport and durable audit sink; no binary reads or writes are issued.
 * @returns Current and requested percentage; identical requests perform no write.
 */
export async function rolloutDesktopRelease(plan: DesktopRolloutPlan, target: number | undefined,
  operations: Pick<DesktopPublishOperations, 'transport' | 'record'>) {
  if (target !== undefined) percentage.parse(target)
  const artifact = plan.upload.artifacts[0]
  const before = await operations.transport.read(artifact.key, true)
  if (!before?.contents) throw new Error('desktop rollout: published update feed is missing')
  const current = verifyDesktopRolloutFeed(plan, before)
  const next = target ?? current.percentage
  if (next < current.percentage) throw new Error('desktop rollout: percentage cannot decrease; inspect the current rollout')
  if (next === current.percentage) {
    await operations.record({ type: 'object-present', key: artifact.key })
    return { before: current.percentage, after: next }
  }
  const updated = { ...artifact, contents: dump({ ...current.metadata, stagingPercentage: next }) }
  const digest = await desktopArtifactDigest(updated)
  const confirmed = await operations.transport.read(artifact.key, true)
  if (confirmed?.contents !== before.contents) throw new Error('desktop rollout: feed changed before write; inspect and retry')
  await operations.record({ type: 'put-intent', key: artifact.key, before: before.contents, after: updated.contents })
  await operations.transport.put(updated, digest, false)
  const actual = await operations.transport.read(artifact.key, true)
  if (actual?.size !== digest.size || actual.sha512 !== digest.sha512) {
    throw new Error('desktop rollout: written feed is unconfirmed; inspect before retrying')
  }
  await operations.record({ type: 'put-verified', key: artifact.key })
  return { before: current.percentage, after: next }
}
