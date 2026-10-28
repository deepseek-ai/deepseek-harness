/** Owner identity status: what the dialog states, and what it refuses to invent. */

import { describe, expect, it } from 'vitest'
import { identitySubjectLabel } from '../src/owner-identity.ts'
import {
  loginReturnUrl, mayCreateShare, ownerLoginHref, readOwnerIdentity, UNKNOWN_OWNER_IDENTITY,
} from '../src/client/owner-identity.ts'

const RELAY = 'https://relay.example.test'

describe('owner identity status', () => {
  it('states a verified identity with its name, subject, expiry, and renewal', () => {
    const status = readOwnerIdentity({
      state: 'verified',
      relay: RELAY,
      displayName: '许翰翔',
      subjectId: 'feishu:tenant:ou_9f2c',
      avatarUrl: 'https://cdn.example/owner.png',
      expiresAt: '2026-09-11T22:00:00Z',
      renewed: true,
    }, RELAY)
    expect(status).toEqual({
      state: 'verified',
      relay: RELAY,
      displayName: '许翰翔',
      subjectId: 'feishu:tenant:ou_9f2c',
      avatarUrl: 'https://cdn.example/owner.png',
      expiresAt: '2026-09-11T22:00:00Z',
      renewed: true,
    })
    expect(mayCreateShare(status)).toBe(true)
    // A page that is offered no avatar renders without one instead of inventing a placeholder URL.
    expect(readOwnerIdentity({ state: 'verified', relay: RELAY }, RELAY)).not.toHaveProperty('avatarUrl')
  })

  it('states the two states that must verify before a share, and blocks creation', () => {
    for (const state of ['expired', 'unverified'] as const) {
      const status = readOwnerIdentity({ state, relay: RELAY }, RELAY)
      expect(status.state).toBe(state)
      expect(mayCreateShare(status)).toBe(false)
    }
  })

  it('refuses to reuse a status read for another Relay address', () => {
    const status = readOwnerIdentity({
      state: 'verified', relay: 'https://other.example.test', displayName: '许翰翔',
    }, RELAY)
    expect(status.state).toBe('relay-changed')
    expect(status.relay).toBe(RELAY)
    // The name is not carried over as if this address had verified it.
    expect(mayCreateShare(status)).toBe(false)
  })

  it('states a status read for another address with no name at all when the host named none', () => {
    expect(readOwnerIdentity({ state: 'unverified', relay: 'https://other.example.test' }, RELAY))
      .toEqual({ state: 'relay-changed', relay: RELAY })
  })

  it('states nothing it cannot read, and keeps the host as the authority then', () => {
    expect(readOwnerIdentity(undefined, RELAY)).toEqual({ state: 'unknown', relay: RELAY })
    expect(readOwnerIdentity({}, RELAY)).toEqual({ state: 'unknown', relay: RELAY })
    expect(readOwnerIdentity({ state: 3 }, RELAY)).toEqual({ state: 'unknown', relay: RELAY })
    expect(readOwnerIdentity({ state: 'who-knows' }, RELAY)).toEqual({ state: 'unknown', relay: RELAY })
    expect(readOwnerIdentity('verified', RELAY).state).toBe('unknown')
    expect(readOwnerIdentity(undefined, '')).toEqual(UNKNOWN_OWNER_IDENTITY)
    // An unreadable status refuses as well: a host that cannot state what it verified must not be
    // assumed to refuse on its own, so only a verified identity may submit.
    for (const state of ['expired', 'unverified', 'relay-changed', 'relay-unsupported', 'unknown'] as const) {
      expect(mayCreateShare({ state, relay: RELAY })).toBe(false)
    }
  })

  it('keeps an avatar only when the identity published an http url', () => {
    const withAvatar = readOwnerIdentity({
      state: 'verified', relay: RELAY, avatarUrl: 'https://avatar.example.test/owner.png',
    }, RELAY)
    expect(withAvatar.avatarUrl).toBe('https://avatar.example.test/owner.png')
    expect(readOwnerIdentity({ state: 'verified', relay: RELAY }, RELAY).avatarUrl).toBeUndefined()
    // A page renders an image from the identity provider, never from an arbitrary scheme.
    expect(readOwnerIdentity({ state: 'verified', relay: RELAY, avatarUrl: 'javascript:alert(1)' }, RELAY).avatarUrl)
      .toBeUndefined()
  })

  it('labels a nameless verified subject from the identity itself', () => {
    expect(identitySubjectLabel('feishu:tenant:ou_9f2c4d')).toBe('ou_9f2c4d')
    expect(identitySubjectLabel('short')).toBe('short')
  })

  it('keeps the whole subject when the identity leaves nothing after its last separator', () => {
    // A subject that ends at a separator has no trailing part to show; an empty label would render
    // as an owner nobody can tell apart.
    expect(identitySubjectLabel('feishu:tenant:')).toBe('feishu:tenant:')
    expect(identitySubjectLabel('')).toBe('')
  })

  it('refuses to create a share on a Relay that cannot verify identities', () => {
    const status = readOwnerIdentity({ state: 'relay-unsupported', relay: RELAY }, RELAY)
    expect(status.state).toBe('relay-unsupported')
    expect(mayCreateShare(status)).toBe(false)
  })

  it('never passes a credential or one-time hand-off back through a login round trip', () => {
    expect(loginReturnUrl('https://dsh.example.test/session?shareId=s1&ownerStartupToken=secret#/tab'))
      .toBe('https://dsh.example.test/session?shareId=s1')
    expect(loginReturnUrl('https://dsh.example.test/?code=abc&ticket=t&token=x&state=open'))
      .toBe('https://dsh.example.test/?state=open')
    expect(loginReturnUrl('https://dsh.example.test/?access_token=x&session=keep'))
      .toBe('https://dsh.example.test/?session=keep')
    // An address the browser cannot parse is returned unchanged rather than silently rewritten.
    expect(loginReturnUrl('not a url')).toBe('not a url')
  })

  it('names the Relay verification entry once, with this page as the return address', () => {
    expect(ownerLoginHref('https://relay.example.test/', 'https://dsh.example.test/?ownerStartupToken=s'))
      .toBe('https://relay.example.test/__liveshare/auth/start?returnTo=https%3A%2F%2Fdsh.example.test%2F')
  })
})
