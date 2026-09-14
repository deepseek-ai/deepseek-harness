/** Baseline package selection through Node's real filesystem glob implementation. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES } from './experimental-package-policy.ts'
import { discoverNpmBaselineManifests } from './npm-baseline-packages.ts'

function fixture(manifests: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-baseline-discovery-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  for (const manifest of manifests) {
    const file = join(root, manifest)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{}\n')
  }
  return root
}

describe('npm baseline package discovery', () => {
  it('discovers ordinary package roots and unlisted experimental packages', () => {
    const expected = [
      'apps/cli/package.json',
      'packages/core/session/package.json',
      'packages/experimental/agent-team/package.json',
      'packages/experimental/new-prototype/package.json',
      'vendor/cordis/package.json',
    ]
    const root = fixture([
      ...expected,
      'package.json',
      'packages/experimental/new-prototype/nested/package.json',
      'website/package.json',
    ])

    expect(discoverNpmBaselineManifests(root)).toEqual(expected)
  })

  it('excludes every directory in the current publication denylist', () => {
    const allowed = 'packages/experimental/new-prototype/package.json'
    const root = fixture([
      allowed,
      ...PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES.map(directory => `${directory}/package.json`),
    ])

    expect(discoverNpmBaselineManifests(root)).toEqual([allowed])
  })

  it('excludes an exact configured directory without excluding nearby names', () => {
    const root = fixture([
      'packages/experimental/internal/package.json',
      'packages/experimental/internal-tools/package.json',
      'packages/experimental/other/package.json',
    ])
    expect(discoverNpmBaselineManifests(root, ['packages/experimental/internal'])).toEqual([
      'packages/experimental/internal-tools/package.json',
      'packages/experimental/other/package.json',
    ])
  })

  it('retains experimental packages when the configured denylist is empty', () => {
    const manifests = [
      'packages/experimental/inspector/package.json',
      'packages/experimental/new-prototype/package.json',
    ]
    expect(discoverNpmBaselineManifests(fixture(manifests), [])).toEqual(manifests)
  })

  it('leaves an empty package set for the baseline caller to reject', () => {
    expect(discoverNpmBaselineManifests(fixture([]))).toEqual([])
  })
})
