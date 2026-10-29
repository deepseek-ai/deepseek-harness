/**
 * The owner state file: what a restart restores, and what an unreadable file refuses to restore.
 *
 * Every case here writes a real file: the loader's job is deciding whether a document on disk may be
 * trusted, so a hand-built value would test the validator against itself.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { loadOwnerState, storedAccessMode, writeOwnerState } from '../src/host/owner-persistence.ts'
import type { OwnerShare } from '../src/host/owner-types.ts'

/** One private directory whose file this spec owns. */
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'liveshare-owner-state-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return join(dir, 'owner-state.json')
}

/** One persisted share with every optional fact stated. */
const share: OwnerShare = {
  shareId: 'share-one',
  sessionId: 'session-one',
  sessionTitle: 'Review the migration',
  accessMode: 'selected',
  link: 'https://relay.example/?shareId=share-one',
  relay: 'https://relay.example/',
  gatewayToken: 'gateway-token',
  allowedSubjectIds: ['feishu:tenant-a:ou_reader'],
  access: {
    mode: 'approval',
    selected: [{ providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_reader', identityKey: 'feishu:tenant-a:ou_reader' }],
    deploymentAllowedSubjectIds: [],
    shareAllowedSubjectIds: ['feishu:tenant-a:ou_reader'],
    broadenedByDeploymentSubjects: false,
    identityKeyAcl: true,
  },
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-11-01T00:00:00.000Z',
  allowsFork: true,
  sessionMode: 'write',
  viewerCapabilities: [{ plugin: 'ui-chat', readable: ['session/list'], writable: [] }],
  online: false,
}

describe('owner state round trip', () => {
  it('restores every stored fact, including the Relay rows the host still owes a deletion', async () => {
    const path = file()
    await writeOwnerState(
      path,
      'https://relay.example/',
      'instance-one',
      new Map([[share.shareId, share]]),
      new Map([['share-two', { relay: 'https://relay.example/', shareId: 'share-two', gatewayToken: 'token-two' }]]),
    )

    const loaded = loadOwnerState(path)

    expect(loaded.instanceId).toBe('instance-one')
    expect(loaded.relayUrl).toBe('https://relay.example')
    expect([...loaded.pendingRemovals]).toEqual([
      ['share-two', { relay: 'https://relay.example', shareId: 'share-two', gatewayToken: 'token-two' }],
    ])
    expect(loaded.shares.get('share-one')).toMatchObject({
      shareId: 'share-one',
      sessionId: 'session-one',
      // The retired `approval` spelling reads back as the mode this build uses.
      accessMode: 'selected',
      link: 'https://relay.example/?shareId=share-one',
      relay: 'https://relay.example',
      allowedSubjectIds: ['feishu:tenant-a:ou_reader'],
      expiresAt: '2026-11-01T00:00:00.000Z',
      allowsFork: true,
      sessionMode: 'write',
      viewerCapabilities: [{ plugin: 'ui-chat', readable: ['session/list'], writable: [] }],
      revision: 1,
      online: false,
    })
    expect(loaded.shares.get('share-one')?.access?.mode).toBe('selected')
  })

  it('mints a fresh instance and stores nothing when the host has never written its state', () => {
    const loaded = loadOwnerState(file())

    expect(loaded.instanceId).not.toBe('')
    expect(loaded.relayUrl).toBeUndefined()
    expect(loaded.shares.size).toBe(0)
    expect(loaded.pendingRemovals.size).toBe(0)
  })

  it('reads a stored record without its own tier as the view tier', async () => {
    const path = file()
    writeFileSync(path, JSON.stringify({
      shares: [{
        shareId: 'share-one', sessionId: 'session-one', sessionTitle: 'Review the migration',
        accessMode: 'approval', relay: 'https://relay.example/', gatewayToken: 'gateway-token',
        allowedSubjectIds: [], createdAt: 'now',
      }],
    }))

    // A file written before the mode was renamed reads back as the current spelling, and without a tier
    // as the narrowest one; the share's own Relay address is what the record has to carry.
    const loaded = loadOwnerState(path)
    expect(loaded.shares.get('share-one')).toMatchObject({
      relay: 'https://relay.example', accessMode: 'selected', allowsFork: false, sessionMode: 'view',
    })
  })

  it('writes a share that states no optional fact as the plain record it is', async () => {
    const path = file()
    const { access: _access, expiresAt: _expiresAt, viewerCapabilities: _capabilities, ...minimal } = share
    await writeOwnerState(path, undefined, 'instance-one', new Map([[minimal.shareId, { ...minimal, allowsFork: false }]]), new Map())

    const loaded = loadOwnerState(path)
    const restored = loaded.shares.get('share-one')
    expect(restored).toMatchObject({ allowsFork: false, sessionMode: 'write', relay: 'https://relay.example' })
    expect(restored?.access).toBeUndefined()
    expect(restored?.expiresAt).toBeUndefined()
    expect(restored?.viewerCapabilities).toBeUndefined()
    // A write with no override and no owed row states neither.
    expect(loaded.relayUrl).toBeUndefined()
    expect(loaded.pendingRemovals.size).toBe(0)
  })

  it('refuses a write the filesystem rejects, and keeps the chain usable for the next write', async () => {
    const blocked = `${file()}.blocked`
    // The parent name is a regular file, so the atomic write cannot land.
    writeFileSync(blocked, 'occupied')
    const path = join(blocked, 'state.json')

    await expect(writeOwnerState(path, undefined, 'instance-one', new Map(), new Map())).rejects.toBeDefined()
    // A failed write leaves the per-file chain settled, so the next write runs against it.
    await expect(writeOwnerState(path, undefined, 'instance-one', new Map(), new Map())).rejects.toBeDefined()
  })
})

describe('owner state validation', () => {
  /** Load one document and answer the failure it raised. */
  function refusal(document: string): string {
    const path = file()
    writeFileSync(path, document)
    try {
      loadOwnerState(path)
      return 'loaded'
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  it('refuses a document it cannot parse or that names no share list', () => {
    expect(refusal('{ not json')).toContain('invalid owner state file')
    expect(refusal('[]')).toContain('invalid owner state file')
    expect(refusal('{}')).toContain('invalid owner state file')
    expect(refusal('3')).toContain('invalid owner state file')
  })

  it('refuses a Relay override the Host could not use', () => {
    expect(refusal(JSON.stringify({ shares: [], relayUrl: 3 }))).toContain('invalid owner state file')
    expect(refusal(JSON.stringify({ shares: [], relayUrl: '' }))).toContain('invalid owner state file')
    // An absolute-looking value the Relay rules refuse fails as a binding error, not a document error.
    expect(refusal(JSON.stringify({ shares: [], relayUrl: 'not a url' }))).toContain('liveshare relayUrl must be an absolute URL')
  })

  it('refuses a share record that is not one this build can restore', () => {
    expect(refusal(JSON.stringify({ shares: [3] }))).toContain('invalid owner state file')
    // A tier this build cannot read, and an access summary that is not one.
    expect(refusal(JSON.stringify({
      shares: [{ ...share, accessMode: 'open', sessionMode: 'owner' }],
    }))).toContain('invalid owner state file')
    expect(refusal(JSON.stringify({
      shares: [{ shareId: 'share-one', sessionId: 's', sessionTitle: 't', accessMode: 'open', relay: 'https://relay.example/',
        gatewayToken: 'g', allowedSubjectIds: [], createdAt: 'now', access: 3 }],
    }))).toContain('invalid owner state file')
  })

  it('refuses a stored share that names no Relay address', () => {
    // This build has no configured address to read such a record against, and no released state file
    // omits the field, so the document is rejected rather than restored against a guessed address.
    const { relay: _relay, ...noRelay } = share
    expect(refusal(JSON.stringify({ shares: [noRelay] }))).toContain('invalid owner state file')
  })

  it('refuses an entry in the capability list that names no plugin or no endpoint lists', () => {
    const withCapabilities = (viewerCapabilities: unknown): string => JSON.stringify({
      shares: [{
        shareId: 'share-one', sessionId: 's', sessionTitle: 't', accessMode: 'open',
        relay: 'https://relay.example/', gatewayToken: 'g', allowedSubjectIds: [], createdAt: 'now', viewerCapabilities,
      }],
    })

    expect(refusal(withCapabilities(3))).toContain('invalid owner state file')
    for (const entry of [
      { plugin: 3, readable: [], writable: [] },
      { plugin: '', readable: [], writable: [] },
      { plugin: 'ui-chat', readable: 'session/list', writable: [] },
      { plugin: 'ui-chat', readable: [3], writable: [] },
      { plugin: 'ui-chat', readable: [], writable: 'session/prompt' },
      { plugin: 'ui-chat', readable: [], writable: [3] },
    ]) {
      expect(refusal(withCapabilities([entry])), JSON.stringify(entry)).toContain('invalid owner state file')
    }
  })

  it('refuses a Relay removal row that could not delete its row', () => {
    const withRemovals = (pendingRemovals: unknown): string => JSON.stringify({ shares: [], pendingRemovals })

    // A value that is not a list states no owed rows at all, which is the state a file without the
    // field carries.
    expect(refusal(withRemovals(3))).toBe('loaded')
    for (const entry of [
      3,
      { relay: 3, shareId: 's', gatewayToken: 'g' },
      { relay: '', shareId: 's', gatewayToken: 'g' },
      { relay: 'https://relay.example', shareId: 3, gatewayToken: 'g' },
      { relay: 'https://relay.example', shareId: '', gatewayToken: 'g' },
      { relay: 'https://relay.example', shareId: 's', gatewayToken: 3 },
      { relay: 'https://relay.example', shareId: 's', gatewayToken: '' },
    ]) {
      expect(refusal(withRemovals([entry])), JSON.stringify(entry)).toContain('invalid owner state file')
    }
  })

  it('reads the retired access-mode spelling as the mode this build uses', () => {
    expect(storedAccessMode('approval')).toBe('selected')
    expect(storedAccessMode('open')).toBe('open')
    expect(storedAccessMode('selected')).toBe('selected')
  })
})
