/**
 * Vitest sequencer that splits the web snapshot lane into capacity-weighted shards.
 *
 * Vitest's default `--shard` splits a hash-ordered file list into equal file counts, so one shard can
 * receive most of the long browser files. This sequencer assigns files longest-first to the shard with
 * the lowest load relative to its capacity share. A file's weight is its byte size, which tracks its
 * serial browser time closely enough for balancing and needs no recorded history. A slice project of a
 * long file (scripts/web-snapshot-projects.ts) weighs the file's size divided by its slice count. Every
 * shard computes the same assignment from the same checkout, so the shards partition the spec set exactly.
 *
 * `DSH_WEB_SNAPSHOT_SHARD_SHARES` lists one positive capacity share per shard, comma-separated; unset
 * gives every shard the same share.
 */
import { statSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer } from 'vitest/node'
import type { TestSpecification } from 'vitest/node'
import { WEB_SNAPSHOT_SLICE_COUNTS } from './web-snapshot-projects.ts'

/** Environment variable listing the capacity share of each web snapshot shard. */
export const WEB_SNAPSHOT_SHARD_SHARES_ENV = 'DSH_WEB_SNAPSHOT_SHARD_SHARES'

/** One spec to place, identified by its project name and root-relative path. */
export interface WeightedFile {
  readonly key: string
  readonly weight: number
}

/**
 * Parse the per-shard capacity shares.
 * @param raw - comma-separated positive numbers, or undefined for equal shares.
 * @param count - number of shards.
 * @returns one share per shard.
 * @throws If the list length differs from `count` or a share is not a positive finite number.
 */
export function parseShardShares(raw: string | undefined, count: number): number[] {
  if (raw === undefined || raw === '') return Array.from({ length: count }, () => 1)
  const shares = raw.split(',').map(part => Number(part.trim()))
  if (shares.length !== count || shares.some(share => !Number.isFinite(share) || share <= 0)) {
    throw new Error(`${WEB_SNAPSHOT_SHARD_SHARES_ENV} must list ${String(count)} positive numbers, got ${JSON.stringify(raw)}.`)
  }
  return shares
}

/**
 * Assign files to shards longest-first, each to the shard with the lowest load per unit of share.
 * Ties break by key and then by lower shard index, so the result depends only on the inputs.
 * @param files - files with their weights.
 * @param shares - capacity share of each shard.
 * @returns the file keys of each shard.
 */
export function assignWeightedShards(files: readonly WeightedFile[], shares: readonly number[]): string[][] {
  const loads = shares.map(() => 0)
  const shards: string[][] = shares.map(() => [])
  const ordered = [...files].sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const file of ordered) {
    let target = 0
    for (let index = 1; index < shares.length; index++) {
      if ((loads[index] ?? 0) / (shares[index] ?? 1) < (loads[target] ?? 0) / (shares[target] ?? 1)) target = index
    }
    loads[target] = (loads[target] ?? 0) + file.weight
    shards[target]?.push(file.key)
  }
  return shards
}

/** Web snapshot sequencer: weighted sharding, default ordering. */
export default class WebSnapshotSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 }
    const root = this.ctx.config.root
    const pathOf = (spec: TestSpecification) => relative(root, spec.moduleId).replaceAll('\\', '/')
    const keyOf = (spec: TestSpecification) => `${spec.project.name}:${pathOf(spec)}`
    // Only slice projects include a sliced file.
    const weightOf = (spec: TestSpecification) => statSync(spec.moduleId).size / (WEB_SNAPSHOT_SLICE_COUNTS[pathOf(spec)] ?? 1)
    const shards = assignWeightedShards(
      files.map(spec => ({ key: keyOf(spec), weight: weightOf(spec) })),
      parseShardShares(process.env[WEB_SNAPSHOT_SHARD_SHARES_ENV], count),
    )
    const selected = new Set(shards[index - 1])
    return Promise.resolve(files.filter(spec => selected.has(keyOf(spec))))
  }
}
