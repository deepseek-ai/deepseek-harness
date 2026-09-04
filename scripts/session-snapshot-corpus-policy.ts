/** Enforced generation mix for the v2 recorded-session corpus. */

import type { SnapshotSessionFormatManifest } from '@deepseek-ai/dsh-session-snapshot'

/** One owning scenario's selected parent and child generations. */
export interface SnapshotCorpusScenarioGenerations {
  /** Corpus-relative profile/scenario key. */
  readonly key: string
  /** Highest selected generation for each contiguous role. */
  readonly selectedVersions: readonly number[]
  /** Explicit historical generation and the behavior it preserves. */
  readonly retained?: SnapshotSessionFormatManifest
}

/** Counts returned after the v2 corpus policy accepts the inventory. */
export interface SnapshotCorpusGenerationSummary {
  readonly currentRoles: number
  readonly retainedRoles: number
  readonly retainedScenarios: number
}

const CURRENT_VERSION = 2
const MAX_RETAINED_ROLES = 10
const REQUIRED_V0_COVERAGE = new Set([
  'multi-hop',
  'packed-row',
  'retry-failure',
  'shipped-profile',
])
const REQUIRED_V1_COVERAGE = new Set(['adjacent-migration'])

/**
 * Require a v2 majority plus a small explicit v0/v1 migration corpus.
 *
 * @param scenarios - Every owning top-level recorded-session scenario.
 * @returns Accepted current and retained role counts.
 */
export function assertV2SnapshotCorpusPolicy(
  scenarios: readonly SnapshotCorpusScenarioGenerations[],
): SnapshotCorpusGenerationSummary {
  let currentRoles = 0
  let retainedRoles = 0
  let retainedScenarios = 0
  const v0Coverage = new Set<string>()
  const v1Coverage = new Set<string>()

  for (const scenario of scenarios) {
    if (scenario.selectedVersions.length === 0) {
      throw new Error(`${scenario.key}: scenario owns no selected Session role`)
    }
    const expectedVersion = scenario.retained?.version ?? CURRENT_VERSION
    const mismatched = scenario.selectedVersions.find(version => version !== expectedVersion)
    if (mismatched !== undefined) {
      throw new Error(
        `${scenario.key}: selected Session generation v${mismatched} does not match expected v${expectedVersion}`,
      )
    }
    if (scenario.retained === undefined) {
      currentRoles += scenario.selectedVersions.length
      continue
    }
    if (scenario.retained.version !== 0 && scenario.retained.version !== 1) {
      throw new Error(`${scenario.key}: v2 corpus may retain only Session format v0 or v1`)
    }
    const allowedCoverage = scenario.retained.version === 0
      ? REQUIRED_V0_COVERAGE
      : REQUIRED_V1_COVERAGE
    if (scenario.retained.coverage.some(item => !allowedCoverage.has(item))) {
      throw new Error(
        `${scenario.key}: v${scenario.retained.version} retained coverage must be ${[...allowedCoverage].join(', ')}`,
      )
    }
    retainedRoles += scenario.selectedVersions.length
    retainedScenarios += 1
    const coverage = scenario.retained.version === 0 ? v0Coverage : v1Coverage
    for (const item of scenario.retained.coverage) coverage.add(item)
  }

  const missingV0Coverage = [...REQUIRED_V0_COVERAGE].filter(item => !v0Coverage.has(item))
  if (missingV0Coverage.length > 0) {
    throw new Error(`v2 Session corpus lacks v0 coverage: ${missingV0Coverage.join(', ')}`)
  }
  const missingV1Coverage = [...REQUIRED_V1_COVERAGE].filter(item => !v1Coverage.has(item))
  if (missingV1Coverage.length > 0) {
    throw new Error(`v2 Session corpus lacks v1 coverage: ${missingV1Coverage.join(', ')}`)
  }
  if (retainedRoles > MAX_RETAINED_ROLES) {
    throw new Error(`v2 Session corpus retains ${retainedRoles} historical roles; maximum is ${MAX_RETAINED_ROLES}`)
  }
  if (currentRoles <= retainedRoles) {
    throw new Error(
      `v2 Session corpus requires a current majority; current=${currentRoles}, retained=${retainedRoles}`,
    )
  }
  return { currentRoles, retainedRoles, retainedScenarios }
}
