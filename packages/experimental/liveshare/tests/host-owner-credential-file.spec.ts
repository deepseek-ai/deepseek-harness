/** The stored owner credential: what a readable file states, and what an unreadable one leaves unstated. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  clearOwnerCredential,
  decodeOwnerCredential,
  loadOwnerCredential,
  ownerCredentialState,
  reportedOwnerCredentialExpiry,
  saveOwnerCredential,
} from '../src/host/owner-credential-file.ts'

/** One private directory whose files this spec owns. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'liveshare-credential-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return join(dir, 'owner-credential.json')
}

/** One signed payload: base64url JSON, a dot, and a signature this host never reads. */
function credential(payload: unknown, signature = 'signature'): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`
}

describe('stored owner credential file', () => {
  it('saves the credential where it can be read back unchanged', () => {
    const file = workspace()
    const stored = {
      relay: 'https://relay.example',
      credential: credential({ expiresAt: 1_800_000_000_000, displayName: '许翰翔', subjectId: 'ou_owner' }),
      expiresAt: '2027-01-15T08:00:00.000Z',
      displayName: '许翰翔',
      subjectId: 'ou_owner',
      avatarUrl: 'https://cdn.example/owner.png',
    }

    saveOwnerCredential(file, stored)

    expect(loadOwnerCredential(file)).toEqual(stored)
    // The file is owner-only: another local user cannot read a verifiable credential.
    expect(readFileSync(file, 'utf8')).toContain(stored.credential)
  })

  it('reads no credential from an absent file, a corrupt one, or one missing its binding', () => {
    const file = workspace()
    expect(loadOwnerCredential(file)).toBeUndefined()

    writeFileSync(file, '{ not json')
    expect(loadOwnerCredential(file)).toBeUndefined()

    // A value that is not an object states no binding.
    writeFileSync(file, '3')
    expect(loadOwnerCredential(file)).toBeUndefined()
    writeFileSync(file, 'null')
    expect(loadOwnerCredential(file)).toBeUndefined()

    // A credential without the Relay address it belongs to cannot be reused safely.
    writeFileSync(file, JSON.stringify({ credential: 'token' }))
    expect(loadOwnerCredential(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ relay: '', credential: 'token' }))
    expect(loadOwnerCredential(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ relay: 'https://relay.example' }))
    expect(loadOwnerCredential(file)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ relay: 'https://relay.example', credential: '' }))
    expect(loadOwnerCredential(file)).toBeUndefined()
  })

  it('keeps only the optional facts the file states', () => {
    const file = workspace()
    writeFileSync(file, JSON.stringify({ relay: 'https://relay.example', credential: 'token', subjectId: 'ou_owner' }))
    expect(loadOwnerCredential(file)).toEqual({
      relay: 'https://relay.example', credential: 'token', subjectId: 'ou_owner',
    })

    // An empty avatar URL is no avatar: the page renders its own mark instead of an empty image.
    writeFileSync(file, JSON.stringify({
      relay: 'https://relay.example', credential: 'token', avatarUrl: '',
    }))
    expect(loadOwnerCredential(file)).toEqual({ relay: 'https://relay.example', credential: 'token' })
  })

  it('deletes the stored credential on sign-out', () => {
    const file = workspace()
    saveOwnerCredential(file, { relay: 'https://relay.example', credential: 'token' })

    clearOwnerCredential(file)

    expect(loadOwnerCredential(file)).toBeUndefined()
    // Clearing an absent credential is the state a second sign-out reaches, not a failure.
    expect(() => { clearOwnerCredential(file) }).not.toThrow()
  })
})

describe('decoding a credential payload', () => {
  it('reads the identity facts a signed payload carries', () => {
    expect(decodeOwnerCredential(credential({
      expiresAt: 1_767_225_600_000,
      displayName: '许翰翔',
      subjectId: 'ou_owner',
      avatarUrl: 'https://cdn.example/owner.png',
    }))).toEqual({
      expiresAt: '2026-01-01T00:00:00.000Z',
      displayName: '许翰翔',
      subjectId: 'ou_owner',
      avatarUrl: 'https://cdn.example/owner.png',
    })
  })

  it('leaves out an expiry that is not a finite instant, and every empty fact', () => {
    expect(decodeOwnerCredential(credential({
      expiresAt: 'tomorrow', displayName: '', subjectId: '', avatarUrl: '',
    }))).toEqual({})
    expect(decodeOwnerCredential(credential({}))).toEqual({})
  })

  it('reads nothing from a token that carries no payload', () => {
    expect(decodeOwnerCredential('token')).toBeUndefined()
    expect(decodeOwnerCredential('.signature')).toBeUndefined()
    expect(decodeOwnerCredential('not-base64!.signature')).toBeUndefined()
    // A payload that decodes to a JSON value other than an object names no facts.
    expect(decodeOwnerCredential(`${Buffer.from('3', 'utf8').toString('base64url')}.signature`)).toBeUndefined()
    expect(decodeOwnerCredential(`${Buffer.from('null', 'utf8').toString('base64url')}.signature`)).toBeUndefined()
  })
})

describe('credential horizon and state', () => {
  it('reads the horizon a Relay reported only when it names an instant', () => {
    expect(reportedOwnerCredentialExpiry('2027-01-15T08:00:00Z')).toBe('2027-01-15T08:00:00.000Z')
    for (const unreadable of [undefined, null, '', 'tomorrow', 1_767_225_600_000]) {
      expect(reportedOwnerCredentialExpiry(unreadable), String(unreadable)).toBeUndefined()
    }
  })

  it('states the credential’s state for the address in force', () => {
    const now = Date.parse('2026-10-23T00:00:00Z')
    expect(ownerCredentialState(undefined, 'https://relay.example', now)).toBe('unverified')
    // A credential minted by another Relay is not this address's credential.
    expect(ownerCredentialState({ relay: 'https://other.example', credential: 'token' }, 'https://relay.example', now))
      .toBe('unverified')
    expect(ownerCredentialState({ relay: 'https://relay.example', credential: 'token' }, 'https://relay.example', now))
      .toBe('verified')
    expect(ownerCredentialState({
      relay: 'https://relay.example', credential: 'token', expiresAt: '2026-12-01T00:00:00Z',
    }, 'https://relay.example', now)).toBe('verified')
    expect(ownerCredentialState({
      relay: 'https://relay.example', credential: 'token', expiresAt: '2026-01-01T00:00:00Z',
    }, 'https://relay.example', now)).toBe('expired')
    // A stored horizon the browser cannot parse cannot prove the credential is still valid.
    expect(ownerCredentialState({
      relay: 'https://relay.example', credential: 'token', expiresAt: 'not-a-date',
    }, 'https://relay.example', now)).toBe('expired')
  })
})
