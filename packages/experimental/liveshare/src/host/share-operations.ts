/**
 * Owner share-management operations behind the `liveshareShares` Remote.
 *
 * The implementation stays inside the Host's `apply()` closure, where it reads the same share map,
 * Relay authority, worker channel, and persistence queue the sign-in routes and the viewer reader
 * use. This module states the one interface the Remote service calls, so no surface owns a second
 * copy of a side effect.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/share-operations
 */

import type {
  CreateShareRequest,
  CreatedShare,
  OwnerIdentityRequest,
  OwnerIdentityStatus,
  OwnerRelayState,
  OwnerShareList,
  RelayConnectivityView,
  RelayPublishView,
  SetRelayRequest,
  SetShareCapabilitiesRequest,
  ShareAudit,
  ShareAuditRequest,
  ShareCapabilities,
  ShareCapabilityOffers,
  SharePermissions,
  StopShareRequest,
  StopShareResult,
  TestPublishRequest,
  UpdateSharePermissionsRequest,
} from '../share-api-types.ts'

/**
 * The twelve owner operations behind the share-management surface.
 *
 * Each method owns one operation's business order. Failures are thrown as `RemoteError` values with
 * a `liveshareShares/` code, which the Gateway carries to the Client unchanged.
 */
export interface OwnerShareOperations {
  /**
   * Publish one Session and store the share.
   * @param request - Session, title, access, lifetime, and both switches the owner chose.
   * @returns The created share's link and stored values.
   */
  create(request: CreateShareRequest): Promise<CreatedShare>

  /**
   * Refresh titles and Relay authority, then list this host's shares.
   * @returns Every share this host publishes.
   */
  list(): Promise<OwnerShareList>

  /**
   * Stop one share locally, revoke its forks, and delete its Relay row when reachable.
   * @param request - Share to stop.
   * @returns Whether the Relay row still needs a retry.
   */
  stop(request: StopShareRequest): Promise<StopShareResult>

  /**
   * Change one share's tier, fork switch, or both.
   * @param request - Share and the switches to change.
   * @returns The permissions the share now carries.
   */
  updatePermissions(request: UpdateSharePermissionsRequest): Promise<SharePermissions>

  /**
   * Replace one share's exposed plugin endpoints.
   * @param request - Share and the selection to store.
   * @returns The capability selection the share now carries.
   */
  setCapabilities(request: SetShareCapabilitiesRequest): Promise<ShareCapabilities>

  /**
   * Read the endpoints plugins currently offer.
   * @returns The live offer list.
   */
  capabilities(): ShareCapabilityOffers

  /**
   * Read the address the owner saved, which is also the address new shares publish to.
   * @returns The current Relay state, with both address fields absent while none is saved.
   */
  relay(): OwnerRelayState

  /**
   * Choose the Relay address later shares publish to.
   * @param request - Normalized address or null to clear the saved one.
   * @returns The Relay state after the change.
   */
  setRelay(request: SetRelayRequest): Promise<OwnerRelayState>

  /**
   * Report this host's owner identity for one Relay address.
   * @param request - Address to report, or the effective one when absent.
   * @returns The owner identity status, without the credential.
   */
  identity(request: OwnerIdentityRequest): Promise<OwnerIdentityStatus>

  /**
   * Read the Relay's durable audit trail for one share.
   * @param request - Share whose audit is read.
   * @returns The audit events, or a structured failure when the Relay cannot answer.
   */
  audit(request: ShareAuditRequest): Promise<ShareAudit>

  /**
   * Check that the effective Relay answers at all.
   * @returns The anonymous connectivity result.
   */
  testRelay(): Promise<RelayConnectivityView>

  /**
   * Register one throwaway share to check whether this host may publish.
   * @param request - Session the throwaway registration names.
   * @returns The Relay's decision about this host's credential.
   */
  testPublish(request: TestPublishRequest): Promise<RelayPublishView>
}
