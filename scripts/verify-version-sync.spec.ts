import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeVersions, mismatchedVersions, readVersions, releasedManifests, runVersionCheck, versionsSynchronized } from './verify-version-sync.ts'

/** Path of the command the pre-merge check spawns. */
const script = join(import.meta.dirname, 'verify-version-sync.ts')

/**
 * Build a repository holding the given manifests.
 * @param files - Manifest path to version, or to `null` for a manifest without one.
 * @returns The temporary root.
 */
function repository(files: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-version-sync-'))
  for (const [path, version] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, JSON.stringify(version === null ? { name: 'x' } : { name: 'x', version }))
  }
  return root
}

describe('released manifests', () => {
  it('collects the package groups and the applications, and nothing deeper or beside them', () => {
    const root = repository({
      'package.json': '1.0.0',
      'packages/core/session/package.json': '1.0.0',
      'packages/core/package.json': null,
      'packages/README.md': null,
      'apps/cli/package.json': '1.0.0',
      'apps/cli/nested/package.json': '1.0.0',
      'vendor/cordis/package.json': '4.0.5',
      'native/system/package.json': '0.1.2',
    })
    try {
      expect(releasedManifests(root)).toEqual(['apps/cli/package.json', 'packages/core/session/package.json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails instead of reporting a narrowed corpus', () => {
    const root = repository({ 'package.json': '1.0.0', 'packages/README.md': null, 'apps/README.md': null })
    try {
      expect(() => releasedManifests(root)).toThrow(/no released manifest/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails when a directory cannot be read', () => {
    const root = repository({ 'package.json': '1.0.0', 'packages/core/session/package.json': '1.0.0' })
    try {
      rmSync(join(root, 'apps'), { recursive: true, force: true })
      expect(() => releasedManifests(root)).toThrow(/cannot read apps\//)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('version synchronization', () => {
  it('accepts a tree whose released manifests all carry the root version', () => {
    const root = repository({ 'package.json': '3.0.0', 'packages/core/session/package.json': '3.0.0', 'apps/web/package.json': '3.0.0' })
    try {
      const report = readVersions(root)
      expect(mismatchedVersions(report.rootVersion ?? '', report.manifests)).toEqual([])
      expect(versionsSynchronized(report)).toBe(true)
      expect(describeVersions(report)).toEqual(['2 released manifest(s) carry 3.0.0'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a manifest on another version or without one', () => {
    const root = repository({
      'package.json': '2.0.0',
      'packages/core/session/package.json': '2.0.0',
      'packages/core/agent/package.json': '1.0.0',
      'apps/cli/package.json': null,
    })
    try {
      const report = readVersions(root)
      expect(versionsSynchronized(report)).toBe(false)
      expect(describeVersions(report)).toEqual([
        '2 of 3 released manifest(s) do not carry the root version 2.0.0:',
        '  apps/cli/package.json: no version',
        '  packages/core/agent/package.json: 1.0.0',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an empty corpus and a missing root version', () => {
    expect(versionsSynchronized({ rootVersion: '1.0.0', manifests: [] })).toBe(false)
    expect(versionsSynchronized({ rootVersion: undefined, manifests: [{ path: 'apps/cli/package.json', version: '1.0.0' }] })).toBe(false)
    expect(versionsSynchronized({ rootVersion: undefined, manifests: [] })).toBe(false)
  })
})

describe('verify-version-sync command', () => {
  it('exits 0 on a synchronized tree and 1 with the mismatch named', () => {
    const good = repository({ 'package.json': '1.0.0', 'packages/core/session/package.json': '1.0.0', 'apps/web/package.json': '1.0.0' })
    const bad = repository({ 'package.json': '2.0.0', 'packages/core/session/package.json': '1.0.0', 'apps/web/package.json': '2.0.0' })
    try {
      expect(runVersionCheck(good).ok).toBe(true)
      const passed = spawnSync(process.execPath, [script, good], { encoding: 'utf8' })
      expect(passed.status).toBe(0)
      expect(passed.stdout).toContain('2 released manifest(s) carry 1.0.0')
      const failed = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain('packages/core/session/package.json: 1.0.0')
    } finally {
      rmSync(good, { recursive: true, force: true })
      rmSync(bad, { recursive: true, force: true })
    }
  })

  it('exits 1 when the tree cannot be read', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-version-sync-empty-'))
    try {
      const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('verify-version-sync:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
