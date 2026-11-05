/** Fork registry: creator isolation, revocation without deletion, and default-deny prompts. */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { READ_ONLY_FORK_CEILING } from '../src/host/fork-policy.ts'
import { ForkRegistry, type ForkCreator } from '../src/host/fork-registry.ts'

const creator: ForkCreator = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }
const other: ForkCreator = { ...creator, subjectId: 'ou_other' }

function registry(): { readonly registry: ForkRegistry; readonly file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'liveshare-forks-')), 'forks.json')
  return { registry: new ForkRegistry(file), file }
}

function record(childSessionId: string, overrides: Partial<Parameters<ForkRegistry['record']>[0]> = {}) {
  return {
    childSessionId,
    shareId: 'share-1',
    sourceSessionId: 'session-1',
    boundary: 42,
    creator,
    createdAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('read-only fork registry', () => {
  it('refuses every prompt until the execution ceiling is installed', async () => {
    const { registry: forks } = registry()
    await forks.record(record('child-1'))

    expect(forks.allowsPrompt('child-1', creator)).toMatchObject({
      ok: false,
      code: 'fork-ceiling-uninstalled',
    })
    // Installed for this child only, which is what the caller does after registering its guard.
    expect(forks.installEnforcement('child-1', READ_ONLY_FORK_CEILING)).toBe(true)
    expect(forks.allowsPrompt('child-1', creator)).toEqual({ ok: true })
  })

  it('never opens a sibling, a cold-loaded child, or a released child', async () => {
    const { registry: forks, file } = registry()
    await forks.record(record('child-1'))
    await forks.record(record('child-2'))
    forks.installEnforcement('child-1', READ_ONLY_FORK_CEILING)

    // One child's guard says nothing about its sibling: a per-host flag would have opened this one.
    expect(forks.allowsPrompt('child-2', creator)).toMatchObject({
      ok: false,
      code: 'fork-ceiling-uninstalled',
    })
    // A child known from the file after a restart has no live guard, so it refuses until one is
    // registered again and recorded.
    const reopened = new ForkRegistry(file)
    expect(reopened.allowsPrompt('child-1', creator)).toMatchObject({
      ok: false,
      code: 'fork-ceiling-uninstalled',
    })
    // Disposing the guard returns exactly that child to refusing, while the other keeps its own state.
    forks.releaseEnforcement('child-1')
    expect(forks.allowsPrompt('child-1', creator)).toMatchObject({
      ok: false,
      code: 'fork-ceiling-uninstalled',
    })
    // An unknown child is refused as unknown, and its install is reported as a failure.
    expect(forks.installEnforcement('child-none', READ_ONLY_FORK_CEILING)).toBe(false)
  })

  it('shows one viewer only its own children', async () => {
    const { registry: forks } = registry()
    await forks.record(record('child-1'))
    await forks.record(record('child-2', { creator: other }))

    expect(forks.listForCreator(creator).map(entry => entry.childSessionId)).toEqual(['child-1'])
    expect(forks.listForCreator(other).map(entry => entry.childSessionId)).toEqual(['child-2'])
    // The source owner sees every child of its share, whoever created it.
    expect(forks.listForShare('share-1').map(entry => entry.childSessionId).sort())
      .toEqual(['child-1', 'child-2'])
  })

  it('keeps a child, and its record, when the source share is revoked', async () => {
    const { registry: forks, file } = registry()
    await forks.record(record('child-1'))
    forks.installEnforcement('child-1', READ_ONLY_FORK_CEILING)
    await forks.revokeShare('share-1', '2026-09-11T01:00:00.000Z')

    const record_ = forks.find('child-1')
    expect(record_?.revokedAt).toBe('2026-09-11T01:00:00.000Z')
    expect(forks.allowsPrompt('child-1', creator)).toMatchObject({ ok: false, code: 'fork-source-revoked' })
    // Revocation is recorded, not destructive: the row is still on disk for history.
    expect(readFileSync(file, 'utf8')).toContain('child-1')
    expect(forks.listForShare('share-1')).toHaveLength(1)
  })

  it('refuses another viewer’s child and an unknown child', async () => {
    const { registry: forks } = registry()
    await forks.record(record('child-1'))
    forks.installEnforcement('child-1', READ_ONLY_FORK_CEILING)

    expect(forks.allowsPrompt('child-1', other)).toMatchObject({ ok: false, code: 'fork-viewer-mismatch' })
    expect(forks.allowsPrompt('missing', creator)).toMatchObject({ ok: false, code: 'fork-unknown-child' })
  })

  it('survives a restart with its records and keeps refusing without a ceiling', async () => {
    const { registry: forks, file } = registry()
    await forks.record(record('child-1'))

    const reopened = new ForkRegistry(file)
    expect(reopened.find('child-1')?.shareId).toBe('share-1')
    // The ceiling is a property of the running Host, so a restart refuses until it is installed again.
    expect(reopened.allowsPrompt('child-1', creator)).toMatchObject({
      ok: false,
      code: 'fork-ceiling-uninstalled',
    })
  })
})
