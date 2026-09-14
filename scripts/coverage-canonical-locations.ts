/**
 * Canonicalize coverage locations inside a coverage partition, before its
 * blob is written.
 *
 * Vitest reaches every reporter's `onCoverage` with the finished run's coverage
 * map and lets the blob reporter serialize that same map later, in
 * `onTestRunEnd`, so this reporter sees the locations while they are numeric.
 * ast-v8-to-istanbul ends a whole-line statement at column `Infinity`, which the
 * blob's JSON hop turns into `null`; istanbul-lib-coverage reconciles the
 * per-environment spellings of one statement only through numeric columns, so a
 * `null` column leaves a client-only spelling behind as a phantom uncovered
 * statement. Replacing each non-finite end column with
 * {@link END_OF_LINE_COLUMN} keeps the line-end meaning and keys identically in
 * every blob, so the merge attributes the coverage one process would have.
 *
 * @see ../.agents/notes/implemented/bug-fix/2026-09-13-partitioned-coverage-location-canonicalization.md
 * @module
 */

/**
 * End column of a location that spans to the end of its start line, and the
 * finite stand-in for ast-v8-to-istanbul's unrepresentable `Infinity`.
 */
export const END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER

/** Mutable structural view of the istanbul coverage map handed to reporters. */
type CoverageRecord = Record<string, unknown>

/** Whether a value is a non-null object usable as a mutable record. */
function isRecord(value: unknown): value is CoverageRecord {
  return typeof value === 'object' && value !== null
}

/** Rewrite one location's non-finite end column in place. */
function canonicalizeLocation(location: unknown): void {
  if (!isRecord(location)) return
  const end = location['end']
  if (!isRecord(end)) return
  const column = end['column']
  if (typeof column === 'number' && Number.isFinite(column)) return
  end['column'] = END_OF_LINE_COLUMN
}

/** Rewrite every location a statement, function, or branch entry carries. */
function canonicalizeEntry(entry: unknown): void {
  if (!isRecord(entry)) return
  // A statement is a location itself; a function carries `decl` plus `loc`, and
  // a branch carries `loc` plus one location per branch path.
  canonicalizeLocation(entry)
  canonicalizeLocation(entry['decl'])
  canonicalizeLocation(entry['loc'])
  const locations = entry['locations']
  if (Array.isArray(locations)) for (const location of locations) canonicalizeLocation(location)
}

/**
 * Replace every non-finite end column of an istanbul coverage map in place.
 * @param coverageMap - istanbul `CoverageMap` whose `data` holds per-file coverage.
 * @throws Error when the payload carries no istanbul `data` record, so a Vitest
 * change that stops handing reporters that map fails the partition instead of
 * leaving every location uncanonicalized. Inner structure a `CoverageMap`
 * always carries is read without further checks.
 */
export function canonicalizeEndOfLineColumns(coverageMap: unknown): void {
  const files = isRecord(coverageMap) ? coverageMap['data'] : undefined
  if (!isRecord(files)) {
    throw new Error('coverage-canonical-locations: onCoverage payload is not an istanbul CoverageMap')
  }
  for (const file of Object.values(files)) {
    if (!isRecord(file)) continue
    // FileCoverage keeps its maps on `data` and mirrors them as getters.
    const coverage = isRecord(file['data']) ? file['data'] : file
    for (const name of ['statementMap', 'fnMap', 'branchMap']) {
      const entries = coverage[name]
      if (!isRecord(entries)) continue
      for (const entry of Object.values(entries)) canonicalizeEntry(entry)
    }
  }
}

/**
 * Vitest reporter that canonicalizes a partition's coverage map in
 * {@link CanonicalCoverageLocationsReporter.onCoverage}, the hook Vitest runs
 * before the blob reporter serializes that map.
 */
export default class CanonicalCoverageLocationsReporter {
  /**
   * Canonicalize the finished run's coverage locations.
   * @param coverageMap - coverage map Vitest hands to every reporter.
   */
  public onCoverage(coverageMap: unknown): void {
    canonicalizeEndOfLineColumns(coverageMap)
  }
}
