/** Owner identity status the owner host reports to its own browser, and to no one else. */

export type { ClaimOutcome, OwnerIdentityState, OwnerIdentityStatus } from './share-api-types.ts'

/**
 * Error code the owner host answers with when a creation request arrives without a verified
 * identity. The browser turns this into the same "go verify" affordance as an `expired` state.
 */
export const OWNER_LOGIN_REQUIRED = 'owner-login-required'

/**
 * Error code the owner host answers with when the Relay at the effective address does not bind owner
 * identity. The browser asks the deployment to upgrade instead of offering a verification retry.
 */
export const RELAY_UPGRADE_REQUIRED = 'relay-upgrade-required'

/**
 * Label a verified subject that carries no display name.
 *
 * The label comes from the identity itself, so no surface borrows the signed-in viewer's name and
 * none invents one from an unverified display name. The owner host names the owner a reader sees
 * with it when the credential carries no display name of its own.
 * @param subjectId - Verified subject the share belongs to.
 * @returns The trailing part of the subject, long enough to tell two subjects apart by eye.
 */
export function identitySubjectLabel(subjectId: string): string {
  const trimmed = subjectId.trim()
  const tail = trimmed.slice(trimmed.lastIndexOf(':') + 1)
  return tail === '' ? trimmed : tail
}
