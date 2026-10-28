/**
 * The owner share-management Remote the share surfaces call.
 *
 * Every method resolves to a `RemoteResult`, so a refusal stays a typed error branch carrying the
 * Host's `liveshareShares/` code; the surfaces read the code instead of mapping an HTTP status. The
 * interface is stated here rather than derived from the generated namespace so the package's client
 * declarations name the request and result types directly.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/owner-shares
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CreatedShare,
  CreateShareRequest,
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

/** The `liveshareShares` Remote namespace, as the owner page calls it. */
export interface OwnerShares {
  /**
   * Publish one Session and store the share.
   * @param request - Session, title, access, lifetime, and both switches the owner chose.
   * @returns The created share's link and stored values.
   */
  create(request: CreateShareRequest): Promise<RemoteResult<CreatedShare>>

  /**
   * Refresh titles and Relay authority, then list this host's shares.
   * @returns Every share this host publishes.
   */
  list(): Promise<RemoteResult<OwnerShareList>>

  /**
   * Stop one share locally, revoke its forks, and delete its Relay row when reachable.
   * @param request - Share to stop.
   * @returns Whether the Relay row still needs a retry.
   */
  stop(request: StopShareRequest): Promise<RemoteResult<StopShareResult>>

  /**
   * Change one share's tier, fork switch, or both.
   * @param request - Share and the switches to change.
   * @returns The permissions the share now carries.
   */
  updatePermissions(request: UpdateSharePermissionsRequest): Promise<RemoteResult<SharePermissions>>

  /**
   * Replace one share's exposed plugin endpoints.
   * @param request - Share and the selection to store.
   * @returns The capability selection the share now carries.
   */
  setCapabilities(request: SetShareCapabilitiesRequest): Promise<RemoteResult<ShareCapabilities>>

  /**
   * Read the endpoints plugins currently offer.
   * @returns The live offer list.
   */
  capabilities(): Promise<RemoteResult<ShareCapabilityOffers>>

  /**
   * Read the address the owner saved, which is also the address new shares publish to.
   * @returns The current Relay state, with both address fields absent while none is saved.
   */
  relay(): Promise<RemoteResult<OwnerRelayState>>

  /**
   * Choose the Relay address later shares publish to.
   * @param request - Normalized address or null to clear the saved one.
   * @returns The Relay state after the change.
   */
  setRelay(request: SetRelayRequest): Promise<RemoteResult<OwnerRelayState>>

  /**
   * Report this host's owner identity for one Relay address.
   * @param request - Address to report, or the effective one when absent.
   * @returns The owner identity status, without the credential.
   */
  identity(request: OwnerIdentityRequest): Promise<RemoteResult<OwnerIdentityStatus>>

  /**
   * Read the Relay's durable audit trail for one share.
   * @param request - Share whose audit is read.
   * @returns The audit events, or a structured failure when the Relay cannot answer.
   */
  audit(request: ShareAuditRequest): Promise<RemoteResult<ShareAudit>>

  /**
   * Check that the effective Relay answers at all.
   * @returns The anonymous connectivity result.
   */
  testRelay(): Promise<RemoteResult<RelayConnectivityView>>

  /**
   * Register one throwaway share to check whether this host may publish.
   * @param request - Session the throwaway registration names.
   * @returns The Relay's decision about this host's credential.
   */
  testPublish(request: TestPublishRequest): Promise<RemoteResult<RelayPublishView>>
}
