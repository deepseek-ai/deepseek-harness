import { describe, expect, it } from 'vitest'
import {
  IDENTITY_TENANT_PLACEHOLDER,
  identityFromKey,
  identityKeyOf,
  normalizeIdentity,
  requireIdentityTenant,
  type IdentityActor,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'

const actor: IdentityActor = {
  providerId: 'example',
  tenantId: 'tenant/a',
  subjectId: 'user:one',
  displayName: 'Alice',
}

describe('identity keys', () => {
  it('derives one stable, encoded identity key from the provider triple', () => {
    expect(identityKeyOf(actor)).toBe('example:tenant%2Fa:user%3Aone')
    expect(identityKeyOf(actor)).toBe(identityKeyOf({
      providerId: actor.providerId,
      tenantId: actor.tenantId,
      subjectId: actor.subjectId,
    }))
    expect(identityFromKey(identityKeyOf(actor))).toEqual({
      providerId: actor.providerId,
      tenantId: actor.tenantId,
      subjectId: actor.subjectId,
    })
    expect(identityFromKey('example:only-two')).toBeUndefined()
    expect(identityFromKey('example:%E0%A4%A:user')).toBeUndefined()
    // The key codec reads the triple it is given: a caller that skips normalization can build a key
    // whose empty tenant segment its own parser refuses.
    expect(identityKeyOf({ providerId: 'example', tenantId: '', subjectId: 'user' })).toBe('example::user')
    expect(identityFromKey('example::user')).toBeUndefined()
  })

  it('fills the placeholder tenant only for a provider that issues none', () => {
    expect(normalizeIdentity({ providerId: 'example', tenantId: '', subjectId: 'user' }))
      .toEqual({ providerId: 'example', tenantId: IDENTITY_TENANT_PLACEHOLDER, subjectId: 'user' })
    expect(normalizeIdentity({ providerId: 'example', tenantId: 'tenant-a', subjectId: 'user' }))
      .toEqual({ providerId: 'example', tenantId: 'tenant-a', subjectId: 'user' })
    expect(normalizeIdentity({ providerId: '', tenantId: '', subjectId: 'user' })).toBeUndefined()
    expect(normalizeIdentity({ providerId: 'example', tenantId: '', subjectId: '' })).toBeUndefined()
    expect(normalizeIdentity({ providerId: 'example', tenantId: '', subjectId: 'user' }, ''))
      .toBeUndefined()
    expect(normalizeIdentity({ providerId: 'example', tenantId: '', subjectId: 'user' }, 'tenant-b'))
      .toEqual({ providerId: 'example', tenantId: 'tenant-b', subjectId: 'user' })
  })

  it('rejects any triple whose provider must issue a tenant but left it empty', () => {
    expect(requireIdentityTenant({ providerId: 'example', tenantId: 'tenant-a', subjectId: 'user' }))
      .toEqual({ providerId: 'example', tenantId: 'tenant-a', subjectId: 'user' })
    expect(requireIdentityTenant({ providerId: 'example', tenantId: '', subjectId: 'user' })).toBeUndefined()
    expect(requireIdentityTenant({ providerId: '', tenantId: 'tenant-a', subjectId: 'user' })).toBeUndefined()
    expect(requireIdentityTenant({ providerId: 'example', tenantId: 'tenant-a', subjectId: '' })).toBeUndefined()
  })
})
