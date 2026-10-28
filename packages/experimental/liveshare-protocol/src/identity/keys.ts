/** Canonical ACL key for one identity triple, and the normalization every adapter applies first. */

import type { IdentityTriple } from './types.ts'

/**
 * Build the canonical identity key stored in share ACLs.
 *
 * The caller normalizes the identity first: {@link normalizeIdentity} fills the documented tenant
 * placeholder, while an unnormalized empty tenant renders an empty segment that
 * {@link identityFromKey} cannot parse.
 * @param identity Provider, tenant, and subject triple.
 * @returns Percent-encoded stable key with no user-controlled formatting.
 */
export function identityKeyOf(identity: IdentityTriple): string {
  return [
    encodeURIComponent(identity.providerId),
    encodeURIComponent(identity.tenantId),
    encodeURIComponent(identity.subjectId),
  ].join(':')
}

/**
 * Parse a canonical identity key created by {@link identityKeyOf}.
 * @param key Percent-encoded provider, tenant, and subject key.
 * @returns Identity triple, or undefined when the key is not canonical.
 */
export function identityFromKey(key: string): IdentityTriple | undefined {
  const parts = key.split(':')
  if (parts.length !== 3) return undefined
  try {
    const [providerId = '', tenantId = '', subjectId = ''] = parts.map(part => decodeURIComponent(part))
    if (providerId === '' || tenantId === '' || subjectId === '') return undefined
    return { providerId, tenantId, subjectId }
  } catch {
    return undefined
  }
}

/**
 * Tenant id recorded for a provider that issues no tenant of its own.
 *
 * An account adapter whose provider issues no tenant must reject an empty tenant instead of using
 * this placeholder; see {@link requireIdentityTenant}.
 */
export const IDENTITY_TENANT_PLACEHOLDER = 'default'

/**
 * Normalize one adapter-produced identity before Relay state stores it.
 * @param identity Provider-produced triple.
 * @param tenantFallback Tenant id used when the provider issued none.
 * @returns Normalized triple, or undefined when the provider or subject id is empty.
 */
export function normalizeIdentity<T extends IdentityTriple>(
  identity: T,
  tenantFallback: string = IDENTITY_TENANT_PLACEHOLDER,
): T | undefined {
  if (identity.providerId === '' || identity.subjectId === '') return undefined
  if (identity.tenantId !== '') return identity
  if (tenantFallback === '') return undefined
  return { ...identity, tenantId: tenantFallback }
}

/**
 * Validate one adapter-produced identity whose provider must issue a tenant id.
 * @param identity Provider-produced triple.
 * @returns The same triple, or undefined when the provider, tenant, or subject id is empty.
 */
export function requireIdentityTenant<T extends IdentityTriple>(identity: T): T | undefined {
  return identity.providerId === '' || identity.tenantId === '' || identity.subjectId === ''
    ? undefined
    : identity
}
