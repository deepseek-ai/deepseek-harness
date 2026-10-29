/**
 * Owner-facing share records shared by the Host routes and the Typert Remote contract.
 *
 * Every field is the JSON the owner browser already received from the same-origin routes, so the
 * Client face can import this module for the same records instead of restating them.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/share-api-types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/**
 * Whether this host currently holds an owner credential the Relay will accept.
 *
 * `relay-unsupported` means the Relay at this address predates identity binding: the host refuses to
 * create shares there instead of publishing one anonymously, and no amount of verifying locally
 * would help until the deployment is upgraded.
 */
export type OwnerIdentityState = 'verified' | 'expired' | 'unverified' | 'relay-unsupported'

/** Result of binding this host's existing shares to its verified identity. */
export interface ClaimOutcome {
  /** Shares the Relay bound to this identity. */
  readonly claimed: number
  /** Shares already bound to this identity, so the Relay left them untouched. */
  readonly skipped: number
}

/** One owner identity report. The credential itself is never part of it. */
export interface OwnerIdentityStatus {
  readonly state: OwnerIdentityState
  /**
   * Relay base URL the credential is bound to. A host keeps one credential per Relay address and
   * never presents it to another, so a viewer of this field compares it with the active address.
   */
  readonly relay: string
  /** Provider display name, when the credential carries one. */
  readonly displayName?: string
  /** Verified subject id, which a client may show as the identity label. */
  readonly subjectId?: string
  /** Provider-issued avatar URL the credential carried, when it carried one. */
  readonly avatarUrl?: string
  /** ISO expiry of the credential currently held. */
  readonly expiresAt?: string
  /** True when this report followed a renewal that pushed the expiry out. */
  readonly renewed?: boolean
  /** Automatic claim result, present once this host has run a claim pass. */
  readonly claim?: ClaimOutcome
}

/** One viewer identity selected by a share's ACL, resolved from its canonical key. */
export interface ShareAccessSelection {
  readonly providerId: string
  readonly tenantId: string
  readonly subjectId: string
  readonly identityKey: string
}

/** Confirmed ACL scope of one share, as the owner panel reads it back. */
export interface ShareAccess {
  readonly mode: 'open' | 'selected'
  readonly selected: readonly ShareAccessSelection[]
  readonly deploymentAllowedSubjectIds: readonly string[]
  readonly shareAllowedSubjectIds: readonly string[]
  readonly broadenedByDeploymentSubjects: boolean
  readonly identityKeyAcl: true
}

/** One plugin's endpoints offered to or selected for a share's viewers. */
export interface ShareCapabilityGroup {
  /** Declaring plugin's package name. */
  readonly plugin: string
  /** Readable endpoints that plugin offers. */
  readonly readable: readonly string[]
  /** Writable endpoints that plugin offers. */
  readonly writable: readonly string[]
}

/** One owner-created share as the management panel lists it. */
export interface OwnerShareView {
  readonly shareId: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly link: string
  readonly createdAt: string
  /** ISO time after which the Relay denies viewers; absent means the share never expires. */
  readonly expiresAt?: string
  readonly allowsFork: boolean
  readonly sessionMode: 'view' | 'write'
  /** Plugin endpoints this share exposes; an empty list means none. */
  readonly viewerCapabilities: readonly ShareCapabilityGroup[]
  readonly online: boolean
  /** Confirmed ACL scope, absent on records written before it was recorded. */
  readonly access?: ShareAccess
}

/** The owner's share list. */
export interface OwnerShareList {
  readonly shares: readonly OwnerShareView[]
}

/** One share-creation request. */
export interface CreateShareRequest {
  readonly sessionId: string
  /** Display title; the Session id is used when this is absent or empty. */
  readonly sessionTitle?: string
  /**
   * Access mode to store with the share. Legacy and direct-API use only: the shipped Share dialog
   * creates `open` shares and sends no access mode, while stored `selected` records and callers that
   * invoke this Remote directly still set it.
   */
  readonly accessMode?: 'open' | 'selected'
  /** Lifetime in minutes; absent means the share never expires. */
  readonly ttlMinutes?: number
  /**
   * Viewers named on a `selected` share, stored beside the deployment's allowed subjects. Legacy and
   * direct-API use only: the shipped Share dialog creates `open` shares and sends no subjects.
   */
  readonly allowedSubjectIds?: readonly string[]
  readonly allowsFork?: boolean
  readonly sessionMode?: 'view' | 'write'
}

/** One created share, echoing the values it was stored with. */
export interface CreatedShare {
  readonly link: string
  readonly shareId: string
  readonly sessionId: string
  readonly sessionMode: 'view' | 'write'
  readonly access: ShareAccess
}

/** One stop request. */
export interface StopShareRequest {
  readonly shareId: string
}

/** One stopped share; `unreachable` means the Relay row is still owed. */
export interface StopShareResult {
  readonly ok: true
  readonly relay?: 'unreachable'
}

/** One share permission update; every field may be omitted and keeps its stored value. */
export interface UpdateSharePermissionsRequest {
  readonly shareId: string
  readonly sessionMode?: 'view' | 'write'
  readonly allowsFork?: boolean
  /** New lifetime in minutes; null clears the deadline and means the share never expires. */
  readonly ttlMinutes?: number | null
}

/** Permissions one share now carries. */
export interface SharePermissions {
  readonly shareId: string
  readonly sessionMode: 'view' | 'write'
  readonly allowsFork: boolean
  /** New deadline; absent means the share never expires. */
  readonly expiresAt?: string
}

/** One share capability update; absent capabilities clear the selection. */
export interface SetShareCapabilitiesRequest {
  readonly shareId: string
  readonly capabilities?: readonly ShareCapabilityGroup[]
}

/** One share's stored capability selection. */
export interface ShareCapabilities {
  readonly shareId: string
  readonly viewerCapabilities: readonly ShareCapabilityGroup[]
}

/** The endpoints plugins currently offer to share viewers. */
export interface ShareCapabilityOffers {
  readonly capabilities: readonly ShareCapabilityGroup[]
}

/**
 * The address the owner saved in the Share dialog and the address new shares publish to.
 *
 * The owner-owned value is the only source: this build has no deployment-configured fallback, so both
 * fields are absent until the owner saves an address and after the owner clears it again.
 */
export interface OwnerRelayState {
  /**
   * Address a deployment configures directly.
   *
   * Retained so an older Host that still reports one can be read; this build never sets it, because the
   * owner's saved address is the only one in force.
   */
  readonly configured?: string
  /** Address the owner saved. */
  readonly override?: string
  /** Address new shares publish to; absent while no address is saved. */
  readonly effective?: string
}

/** One Relay address selection; null clears the override. */
export interface SetRelayRequest {
  readonly relayUrl: string | null
}

/** One owner identity read, optionally for another Relay address. */
export interface OwnerIdentityRequest {
  readonly relay?: string
}

/** Anonymous connectivity check of the effective Relay. */
export interface RelayConnectivityView {
  readonly ok: boolean
  /** True when the address answered at all, including with a refusal an anonymous request gets. */
  readonly httpReachable: boolean
  readonly blocking: boolean
  readonly error?: string
}

/** One owner identity read before a publish check. */
export interface TestPublishRequest {
  readonly sessionId: string
}

/** Permission check of one throwaway registration. */
export interface RelayPublishView {
  readonly ok: boolean
  readonly blocking: boolean
  readonly error?: string
}

/** One audit read for one share. */
export interface ShareAuditRequest {
  readonly shareId: string
}

/** One durable Relay audit entry. */
export interface ShareAuditEntryView {
  readonly id: string
  readonly action: string
  readonly createdAt: string
  readonly actor?: string
  readonly detail?: JsonValue
}

/** The Relay's durable audit trail for one share. */
export interface ShareAudit {
  readonly events: readonly ShareAuditEntryView[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No share this host publishes carries the requested id. */
    'liveshareShares/share-not-found': { readonly shareId: string }
    /** A share-writing request named no share. */
    'liveshareShares/missing-share-id': Record<string, never>
    /** A creation or publish check named no Session. */
    'liveshareShares/missing-session-id': Record<string, never>
    /** A permission update named neither the tier nor the fork switch. */
    'liveshareShares/missing-permission': Record<string, never>
    /** The requested access mode is not one this build stores. */
    'liveshareShares/invalid-access-mode': Record<string, never>
    /** The requested lifetime is not a positive safe-integer count of minutes within the ceiling. */
    'liveshareShares/invalid-ttl': Record<string, never>
    /** The requested fork switch is not a boolean. */
    'liveshareShares/invalid-allows-fork': Record<string, never>
    /** The requested tier is not one this build drives. */
    'liveshareShares/invalid-session-mode': Record<string, never>
    /** The submitted capability selection is not a list of plugin groups. */
    'liveshareShares/invalid-capabilities': Record<string, never>
    /** The requested Relay address is not a usable base URL. */
    'liveshareShares/invalid-relay': { readonly relay: string }
    /** The posted Relay address is neither null nor a string, or does not normalize. */
    'liveshareShares/invalid-relay-url': Record<string, never>
    /** No Liveshare server address is saved, so the request has nowhere to publish or probe. */
    'liveshareShares/relay-url-required': Record<string, never>
    /** Creating a share requires a verified owner credential at the effective Relay. */
    'liveshareShares/owner-login-required': { readonly identity: OwnerIdentityStatus }
    /** The effective Relay predates owner identity binding, so a verified credential cannot help. */
    'liveshareShares/relay-upgrade-required': { readonly identity: OwnerIdentityStatus }
    /** The Relay did not accept the registration this host attempted. */
    'liveshareShares/relay-unavailable': { readonly relay: string; readonly reason?: string }
    /** The owner state file could not be written; the previous record is still in force. */
    'liveshareShares/owner-state-unavailable': Record<string, never>
    /** A submitted capability names a plugin that offers no viewer endpoints. */
    'liveshareShares/unknown-plugin': { readonly plugin: string }
    /** A submitted capability names an endpoint the plugin does not offer under that kind. */
    'liveshareShares/endpoint-not-offered': {
      readonly plugin: string
      readonly kind: 'readable' | 'writable'
      readonly endpoint: string
    }
    /** The Relay's audit trail could not be read; `body` carries a relay answer unchanged. */
    'liveshareShares/audit-unavailable': {
      readonly relay: string
      readonly status?: number
      readonly contentType?: string
      readonly body?: string
    }
  }
}
