/** The deterministic identity provider tests and loopback demos stand on. */

import { describe, expect, it } from 'vitest'
import {
  MockIdentityProvider,
  type MockIdentityPersona,
} from '../src/identity/mock.ts'

/** The personas one provider is built from; the array stays writable so a test can empty it. */
function personas(): MockIdentityPersona[] {
  return [
    { id: 'alice', tenantId: 'tenant-a', displayName: 'Alice', avatarUrl: 'https://avatar.example/alice.png' },
    { id: 'bob' },
  ]
}

describe('mock identity provider', () => {
  it('refuses a provider that names no id or carries no persona', () => {
    expect(() => new MockIdentityProvider('', personas())).toThrow('mock identity provider id must not be empty')
    expect(() => new MockIdentityProvider('mock', [])).toThrow('mock identity provider requires at least one persona')
    expect(new MockIdentityProvider('mock', personas()).scopes).toEqual([])
  })

  it('redirects to the callback with the selected persona code and the caller state', () => {
    const provider = new MockIdentityProvider('mock', personas())
    const url = provider.authorizationUrl({
      redirectUri: 'https://relay.example/__liveshare/auth/callback?existing=1',
      state: 'state-7',
      scopes: [],
      loginHint: 'bob',
    })
    expect(url.origin + url.pathname).toBe('https://relay.example/__liveshare/auth/callback')
    expect(Object.fromEntries(url.searchParams)).toEqual({ existing: '1', code: 'bob', state: 'state-7' })
    expect(provider.authorizationUrl({
      redirectUri: 'https://relay.example/callback', state: 'state-8', scopes: [],
    }).searchParams.get('code')).toBe('alice')
  })

  it('refuses a redirect when no persona is selectable', () => {
    const list = personas()
    const provider = new MockIdentityProvider('mock', list)
    list.length = 0
    expect(() => provider.authorizationUrl({ redirectUri: 'https://relay.example/callback', state: 's', scopes: [] }))
      .toThrow('mock identity provider has no selectable persona')
  })

  it('resolves a persona into a normalized actor, keeping what the provider issued', async () => {
    const provider = new MockIdentityProvider('mock', personas())
    await expect(provider.exchange({ code: 'alice', redirectUri: 'https://relay.example/callback' })).resolves.toEqual({
      providerId: 'mock',
      tenantId: 'tenant-a',
      subjectId: 'alice',
      displayName: 'Alice',
      avatarUrl: 'https://avatar.example/alice.png',
    })
    // A persona with no tenant, no display name, and no avatar receives the documented defaults.
    await expect(provider.exchange({ code: 'bob', redirectUri: 'https://relay.example/callback' })).resolves.toEqual({
      providerId: 'mock', tenantId: 'mock', subjectId: 'bob', displayName: 'bob',
    })
  })

  it('rejects an unknown callback code and an empty persona id', async () => {
    const provider = new MockIdentityProvider('mock', personas())
    await expect(provider.exchange({ code: 'nobody', redirectUri: 'https://relay.example/callback' })).rejects.toThrow('mock identity callback code is unknown')
    const empty = new MockIdentityProvider('mock', [{ id: '' }])
    await expect(empty.exchange({ code: '', redirectUri: 'https://relay.example/callback' })).rejects.toThrow('mock identity persona id must not be empty')
  })
})
