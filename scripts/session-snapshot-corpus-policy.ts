/** Enforced current-writer majority and retained migration coverage. */

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
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

/** Counts returned after the corpus policy accepts the inventory. */
export interface SnapshotCorpusGenerationSummary {
  readonly currentRoles: number
  readonly retainedRoles: number
  readonly retainedScenarios: number
}

const MAX_RETAINED_ROLES = 10
const REQUIRED_V0_COVERAGE = new Set([
  'multi-hop',
  'packed-row',
  'retry-failure',
  'shipped-profile',
])
const REQUIRED_ADJACENT_COVERAGE = new Set(['adjacent-migration'])

/**
 * Require a current-writer majority and bounded coverage of each released migration source.
 *
 * @param scenarios - Every owning top-level recorded-session scenario.
 * @returns Accepted current and retained role counts.
 */
export function assertSnapshotCorpusPolicy(
  scenarios: readonly SnapshotCorpusScenarioGenerations[],
): SnapshotCorpusGenerationSummary {
  let currentRoles = 0
  let retainedRoles = 0
  let retainedScenarios = 0
  const coverageByVersion = new Map<number, Set<string>>()

  for (const scenario of scenarios) {
    if (scenario.selectedVersions.length === 0) {
      throw new Error(`${scenario.key}: scenario owns no selected Session role`)
    }
    const expectedVersion = scenario.retained?.version ?? SESSION_FORMAT_VERSION
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
    if (!Number.isSafeInteger(scenario.retained.version)
      || scenario.retained.version < 0 || scenario.retained.version >= SESSION_FORMAT_VERSION) {
      throw new Error(`${scenario.key}: retained Session format must precede current v${SESSION_FORMAT_VERSION}`)
    }
    const allowedCoverage = scenario.retained.version === 0
      ? REQUIRED_V0_COVERAGE
      : REQUIRED_ADJACENT_COVERAGE
    if (scenario.retained.coverage.some(item => !allowedCoverage.has(item))) {
      throw new Error(
        `${scenario.key}: v${scenario.retained.version} retained coverage must be ${[...allowedCoverage].join(', ')}`,
      )
    }
    retainedRoles += scenario.selectedVersions.length
    retainedScenarios += 1
    const coverage = coverageByVersion.get(scenario.retained.version) ?? new Set<string>()
    coverageByVersion.set(scenario.retained.version, coverage)
    for (const item of scenario.retained.coverage) coverage.add(item)
  }

  for (let version = 0; version < SESSION_FORMAT_VERSION; version += 1) {
    const required = version === 0 ? REQUIRED_V0_COVERAGE : REQUIRED_ADJACENT_COVERAGE
    const coverage = coverageByVersion.get(version)
    const missing = [...required].filter(item => !coverage?.has(item))
    if (missing.length > 0) {
      throw new Error(`Session corpus lacks v${version} coverage: ${missing.join(', ')}`)
    }
  }
  if (retainedRoles > MAX_RETAINED_ROLES) {
    throw new Error(`Session corpus retains ${retainedRoles} historical roles; maximum is ${MAX_RETAINED_ROLES}`)
  }
  if (currentRoles <= retainedRoles) {
    throw new Error(
      `Session corpus requires a current majority; current=${currentRoles}, retained=${retainedRoles}`,
    )
  }
  return { currentRoles, retainedRoles, retainedScenarios }
}
