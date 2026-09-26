/** Retained V3 replay inputs, current-writer fixtures, and bounded older migration coverage. */

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
  readonly baselineRoles: number
  readonly retainedRoles: number
  readonly retainedScenarios: number
}

const RETAINED_BASELINE_VERSION = 3
const MAX_RETAINED_ROLES = 11
const REQUIRED_V0_COVERAGE = new Set([
  'multi-hop',
  'packed-row',
  'retry-failure',
  'shipped-profile',
])
const REQUIRED_ADJACENT_COVERAGE = new Set(['adjacent-migration'])

/**
 * Require a baseline/current majority and direct coverage of each historical migration source.
 *
 * @param scenarios - Every owning top-level recorded-session scenario.
 * @returns Accepted current, baseline, and explicitly retained role counts.
 */
export function assertSnapshotCorpusPolicy(
  scenarios: readonly SnapshotCorpusScenarioGenerations[],
): SnapshotCorpusGenerationSummary {
  let currentRoles = 0
  let baselineRoles = 0
  let retainedRoles = 0
  let retainedScenarios = 0
  const coverageByVersion = new Map<number, Set<string>>()

  for (const scenario of scenarios) {
    const selectedVersion = scenario.selectedVersions[0]
    if (selectedVersion === undefined) {
      throw new Error(`${scenario.key}: scenario owns no selected Session role`)
    }
    const expectedVersion = scenario.retained?.version ?? selectedVersion
    const mismatched = scenario.selectedVersions.find(version => version !== expectedVersion)
    if (mismatched !== undefined) {
      throw new Error(
        `${scenario.key}: selected Session generation v${mismatched} does not match expected v${expectedVersion}`,
      )
    }
    if (scenario.retained === undefined) {
      if (selectedVersion === RETAINED_BASELINE_VERSION) {
        baselineRoles += scenario.selectedVersions.length
      } else if (selectedVersion === SESSION_FORMAT_VERSION) {
        currentRoles += scenario.selectedVersions.length
      } else {
        throw new Error(
          `${scenario.key}: selected Session generation v${selectedVersion} must be retained baseline v${RETAINED_BASELINE_VERSION} or current v${SESSION_FORMAT_VERSION}`,
        )
      }
      continue
    }
    const retiredTools = scenario.retained.coverage.length === 1 && scenario.retained.coverage[0] === 'retired-tools'
    if (!Number.isSafeInteger(scenario.retained.version)
      || scenario.retained.version < 0 || scenario.retained.version > SESSION_FORMAT_VERSION
      || (scenario.retained.version === SESSION_FORMAT_VERSION && !retiredTools)) {
      throw new Error(`${scenario.key}: retained Session format must precede current v${SESSION_FORMAT_VERSION} unless it pins retired tools at that version`)
    }
    const allowedCoverage = retiredTools ? new Set(['retired-tools']) : scenario.retained.version === 0
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

  if (baselineRoles > 0) coverageByVersion.set(RETAINED_BASELINE_VERSION, new Set(REQUIRED_ADJACENT_COVERAGE))
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
  if (baselineRoles + currentRoles <= retainedRoles) {
    throw new Error(
      `Session corpus requires a baseline/current majority; baseline=${baselineRoles}, current=${currentRoles}, retained=${retainedRoles}`,
    )
  }
  return { currentRoles, baselineRoles, retainedRoles, retainedScenarios }
}
