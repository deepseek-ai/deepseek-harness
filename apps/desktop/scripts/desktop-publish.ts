/** Resume Desktop publication by reconciling object bytes before changing update feeds. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { load } from 'js-yaml'
import { gt, valid } from 'semver'
import { z } from 'zod'
import type { DesktopUploadArtifact, DesktopUploadPlan } from './desktop-upload-plan.ts'

/** File identity computed from bytes, never inferred from COS ETags. */
export interface DesktopObjectDigest { readonly size: number; readonly sha512: string }
/** Remote object observation; channel objects additionally carry their exact YAML. */
export interface DesktopRemoteObject extends DesktopObjectDigest { readonly contents?: string }
/** Transport owned by the caller holding the destination channel lock. */
export interface DesktopPublishTransport {
  /** Read and hash remote bytes; only a confirmed missing object returns null. */
  read(key: string, channel: boolean): Promise<DesktopRemoteObject | null>
  /** Write once. Immutable binaries must use COS overwrite prevention. */
  put(artifact: DesktopUploadArtifact, digest: DesktopObjectDigest, forbidOverwrite: boolean): Promise<void>
}
/** Credential-free, durably flushed publication event. */
export interface DesktopPublishEvent {
  readonly type: 'object-present' | 'put-intent' | 'put-verified' | 'feeds-complete' | 'tag-pending' | 'complete' | 'failed'
  readonly failure?: { readonly phase: string; readonly code: string; readonly message: string }
  readonly key?: string
  readonly before?: string | null
  readonly after?: string
}
/** Caller owns audit persistence and the separately authorized GitHub App identity. */
export interface DesktopPublishOperations {
  readonly transport: DesktopPublishTransport
  record(event: DesktopPublishEvent): Promise<void>
  /** Ensure the production tag names the packaged commit; never move an existing tag. */
  tag(): Promise<void>
}
/** Published files and feeds can succeed even when tag creation remains outstanding. */
export type DesktopPublishResult = { readonly status: 'complete' } | { readonly status: 'published-tag-pending'; readonly cause: unknown }

/** A publication failure that requires reconciliation rather than a blind retry. */
export class DesktopPublishError extends Error {
  constructor(readonly code: 'conflict' | 'superseded' | 'invalid-plan' | 'remote-changed' | 'verification-failed', message: string) {
    super(message)
    this.name = 'DesktopPublishError'
  }
}

/**
 * Hash exactly the file or generated metadata selected by a validated upload plan.
 * @param artifact File-backed installer or in-memory channel metadata.
 * @returns Byte length and SHA-512 for input reconciliation.
 */
export async function desktopArtifactDigest(artifact: DesktopUploadArtifact): Promise<DesktopObjectDigest> {
  const hash = createHash('sha512')
  let size = 0
  const stream = artifact.contents === undefined ? createReadStream(artifact.path) : [Buffer.from(artifact.contents)]
  for await (const bytes of stream) { hash.update(bytes); size += bytes.length }
  return { size, sha512: hash.digest('base64') }
}

function same(left: DesktopObjectDigest | null, right: DesktopObjectDigest | null): boolean {
  return left === null || right === null ? left === right : left.size === right.size && left.sha512 === right.sha512
}

function version(contents: string, remote = false): string {
  try {
    const parsed = z.object({ version: z.string() }).parse(load(contents))
    if (valid(parsed.version) !== null) return parsed.version
  } catch (error) { /* Discard parser error details, which may include raw remote YAML. */ }
  throw new DesktopPublishError(remote ? 'verification-failed' : 'invalid-plan',
    `desktop publish: invalid ${remote ? 'remote' : 'planned'} channel version`)
}

/**
 * Reconcile every binary, then publish feeds, then create the production tag.
 * The caller must hold the channel lock through this entire operation. No writes are retried here;
 * a later invocation hashes remote bytes to recover confirmed and ambiguous earlier writes.
 * @param plan Validated package plan containing both binaries and channel metadata.
 * @param operations Locked transport, durable audit sink, and production tag operation.
 * @returns Complete or published-with-tag-pending; other failures stop all dependent work.
 */
export async function publishDesktopRelease(plan: DesktopUploadPlan, operations: DesktopPublishOperations): Promise<DesktopPublishResult> {
  const files = plan.artifacts.filter(file => !file.channelMetadata)
  const feeds = plan.artifacts.filter(file => file.channelMetadata)
  if (files.length === 0 || feeds.length === 0 || new Set(plan.artifacts.map(file => file.key)).size !== plan.artifacts.length) {
    throw new DesktopPublishError('invalid-plan', 'desktop publish: complete files and update feeds are required')
  }
  if (plan.environment === 'production' && (!plan.commit || !/^[a-f0-9]{40}$/u.test(plan.commit) || plan.dirty !== false)) {
    throw new DesktopPublishError('invalid-plan', 'desktop publish: production requires a clean packaged commit')
  }
  const snapshots = new Map<string, DesktopRemoteObject | null>()
  // Reject obsolete requests before even uploading their missing binary files.
  for (const feed of feeds) {
    if (feed.contents === undefined || version(feed.contents) !== plan.version) {
      throw new DesktopPublishError('invalid-plan', 'desktop publish: channel version differs from package')
    }
    const remote = await operations.transport.read(feed.key, true)
    if (remote !== null) {
      if (remote.contents === undefined) throw new DesktopPublishError('verification-failed', 'desktop publish: channel bytes were not returned')
      if (gt(version(remote.contents, true), plan.version)) throw new DesktopPublishError('superseded', 'desktop publish: a newer version already owns this channel')
      if (version(remote.contents, true) === plan.version && !same(remote, await desktopArtifactDigest(feed))) {
        throw new DesktopPublishError('conflict', 'desktop publish: same version has different channel metadata')
      }
    }
    snapshots.set(feed.key, remote)
  }
  for (const artifact of [...files, ...feeds]) {
    const digest = await desktopArtifactDigest(artifact)
    const remote = await operations.transport.read(artifact.key, artifact.channelMetadata)
    if (same(remote, digest)) {
      await operations.record({ type: 'object-present', key: artifact.key })
      continue
    }
    if (!artifact.channelMetadata && remote !== null) throw new DesktopPublishError('conflict', `desktop publish: object differs: ${artifact.key}`)
    if (artifact.channelMetadata && !same(remote, snapshots.get(artifact.key) ?? null)) {
      throw new DesktopPublishError('remote-changed', 'desktop publish: channel changed after preflight; inspect before retrying')
    }
    await operations.record({ type: 'put-intent', key: artifact.key,
      ...(artifact.channelMetadata ? { before: remote?.contents ?? null, after: artifact.contents } : {}) })
    await operations.transport.put(artifact, digest, !artifact.channelMetadata)
    const actual = await operations.transport.read(artifact.key, artifact.channelMetadata)
    if (!same(actual, digest)) throw new DesktopPublishError('verification-failed', `desktop publish: remote bytes differ: ${artifact.key}`)
    await operations.record({ type: 'put-verified', key: artifact.key })
  }
  await operations.record({ type: 'feeds-complete' })
  if (plan.environment === 'production') {
    try { await operations.tag() } catch (cause) {
      await operations.record({ type: 'tag-pending' })
      return { status: 'published-tag-pending', cause }
    }
  }
  await operations.record({ type: 'complete' })
  return { status: 'complete' }
}
