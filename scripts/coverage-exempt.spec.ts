/**
 * Mechanical guard for the coverage-exempt roster: each entry's positional
 * filter and exclude glob must select the same non-empty file set out of the
 * repository's spec inventory, so a renamed suite cannot silently fall out of
 * the uninstrumented gate while its exclude goes stale.
 */

import { globSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coverageExemptHeavySuites } from './coverage-exempt.ts'

const root = resolve(import.meta.dirname, '..')

/** The spec inventory mirrored from vitest.config.ts testIncludes. */
const allSpecs = new Set([
  ...globSync('packages/*/*/tests/**/*.spec.ts', { cwd: root }),
  ...globSync('packages/*/*/tests/**/*.spec.tsx', { cwd: root }),
  ...globSync('apps/*/tests/**/*.spec.ts', { cwd: root }),
  ...globSync('scripts/**/*.spec.ts', { cwd: root }),
].map(path => path.replaceAll('\\', '/')))

function excludeMatches(exclude: string): string[] {
  return globSync(exclude, { cwd: root })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => allSpecs.has(path))
    .sort()
}

function filterMatches(filter: string): string[] {
  return [...allSpecs].filter(spec => spec.startsWith(filter)).sort()
}

describe('coverage-exempt roster', () => {
  it('selects every Typert suite for the uninstrumented gate', () => {
    const typertSpecs = filterMatches('packages/typert/')
    const exemptSpecs = coverageExemptHeavySuites.flatMap(suite => excludeMatches(suite.exclude))
      .filter(spec => spec.startsWith('packages/typert/')).sort()
    expect(typertSpecs.length).toBeGreaterThan(0)
    expect(exemptSpecs).toEqual(typertSpecs)
  })

  it.each(coverageExemptHeavySuites.map(suite => [suite.filter, suite] as const))(
    'filter and exclude select the same non-empty spec set for %s',
    (_filter, suite) => {
      const fromExclude = excludeMatches(suite.exclude)
      const fromFilter = filterMatches(suite.filter)
      expect(fromExclude.length).toBeGreaterThan(0)
      expect(fromFilter).toEqual(fromExclude)
    },
  )

  it('entries never overlap, so no suite is double-run or double-excluded', () => {
    const seen = new Map<string, string>()
    for (const suite of coverageExemptHeavySuites) {
      for (const spec of excludeMatches(suite.exclude)) {
        expect(seen.get(spec), `${spec} matched by ${seen.get(spec) ?? ''} and ${suite.exclude}`).toBeUndefined()
        seen.set(spec, suite.exclude)
      }
    }
  })
})
