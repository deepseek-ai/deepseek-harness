/** Restore historical update feeds without uploading binaries or moving release tags. */
import { load } from 'js-yaml'
import { z } from 'zod'
import type { DesktopUploadPlan } from './desktop-upload-plan.ts'
import { desktopArtifactDigest, type DesktopPublishOperations, type DesktopRemoteObject } from './desktop-publish.ts'

/** Outcome of an explicitly requested channel restoration. */
export interface DesktopRollbackResult {
  readonly status: 'preview' | 'complete'
  readonly feeds: readonly { key: string; before: string; after: string }[]
}

/**
 * Verify historical binaries and restore only the selected feed YAML under a caller-held channel lock.
 * @param plan Previously published release reconstructed from retained immutable files.
 * @param expectedVersion Version the operator expects to find online; another version stops the operation.
 * @param execute False only inspects and previews; true writes after all historical bytes are verified.
 * @param operations Remote transport and audit sink. The tag operation is never called.
 * @returns Before/after YAML and whether it was written. Partial writes remain recorded for reconciliation.
 */
export async function rollbackDesktopChannel(
  plan: DesktopUploadPlan, expectedVersion: string, execute: boolean, operations: DesktopPublishOperations,
): Promise<DesktopRollbackResult> {
  const files = plan.artifacts.filter(file => !file.channelMetadata)
  const feeds = plan.artifacts.filter(file => file.channelMetadata)
  if (files.length === 0 || feeds.length === 0) throw new Error('desktop rollback: a complete historical release is required')
  const equal = (left: DesktopRemoteObject | null, right: { size: number; sha512: string }) =>
    left !== null && left.size === right.size && left.sha512 === right.sha512
  for (const file of files) {
    if (!equal(await operations.transport.read(file.key, false), await desktopArtifactDigest(file))) {
      throw new Error(`desktop rollback: historical object is missing or different: ${file.key}`)
    }
  }
  const changes = []
  for (const feed of feeds) {
    const before = await operations.transport.read(feed.key, true)
    if (!before || before.contents === undefined || feed.contents === undefined) throw new Error('desktop rollback: channel YAML is unavailable')
    if (equal(before, await desktopArtifactDigest(feed))) {
      await operations.record({ type: 'object-present', key: feed.key })
      continue
    }
    const current = z.object({ version: z.string() }).parse(load(before.contents)).version
    if (current !== expectedVersion) throw new Error('desktop rollback: current version differs from the expected version')
    changes.push({ key: feed.key, before: before.contents, after: feed.contents, observed: before, artifact: feed })
  }
  if (execute) {
    for (const change of changes) {
      if (!equal(await operations.transport.read(change.key, true), change.observed)) throw new Error('desktop rollback: channel changed after preview')
      await operations.record({ type: 'put-intent', key: change.key, before: change.before, after: change.after })
      const digest = await desktopArtifactDigest(change.artifact)
      await operations.transport.put(change.artifact, digest, false)
      if (!equal(await operations.transport.read(change.key, true), digest)) throw new Error('desktop rollback: restored channel could not be verified')
      await operations.record({ type: 'put-verified', key: change.key })
    }
    await operations.record({ type: 'complete' })
  }
  return { status: execute ? 'complete' : 'preview', feeds: changes.map(({ key, before, after }) => ({ key, before, after })) }
}
