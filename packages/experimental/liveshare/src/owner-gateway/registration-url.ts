/**
 * The registration handshake one share is published with.
 *
 * This URL is the one surface an older owner meets a newer Relay on, so what it states about the
 * owner — the protocol version it reads frames with, and the capabilities it offers beyond them — is
 * the only thing a Relay can compare instead of assuming. Keeping the whole handshake in one function
 * is what lets a check pin it: every parameter here is read by a peer this repository does not build.
 */

import {
  LIVESHARE_CAPABILITIES,
  LIVESHARE_PROTOCOL_VERSION,
  type TunnelShareSpec,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { relayEndpoint } from '../host/relay-url.ts'

/**
 * Build the WebSocket URL one share registers with.
 *
 * Absent optionals stay absent rather than being sent empty: the Relay reads a missing `sessionMode`
 * as view-only and a missing `allowsFork` as no forking, so an older owner publishes the narrower
 * share instead of a share whose fields a peer must interpret.
 * @param spec - Share the owner host asked this worker to carry.
 * @returns The registration URL, with this build's protocol version and capabilities stated.
 */
export function registrationUrl(spec: TunnelShareSpec): URL {
  const relay = relayEndpoint(spec.relay)
  const url = new URL(`${relay.basePath}/__tunnel_gateway__`, relay.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('shareId', spec.shareId)
  url.searchParams.set('sessionId', spec.sessionId)
  url.searchParams.set('sessionTitle', spec.sessionTitle)
  url.searchParams.set('accessMode', spec.accessMode)
  url.searchParams.set('ownerDisplayName', spec.ownerDisplayName)
  if (spec.dshVersion !== undefined && spec.dshVersion !== '') {
    url.searchParams.set('dshVersion', spec.dshVersion)
  }
  if (spec.ownerInstanceId !== undefined && spec.ownerInstanceId !== '') {
    url.searchParams.set('ownerInstanceId', spec.ownerInstanceId)
  }
  // State how this build reads frames and what it offers beyond them, so a Relay can compare rather
  // than assume, and can answer that this owner must upgrade instead of being met with silence. A
  // Relay older than these parameters ignores them, which is what keeps the declaration additive.
  url.searchParams.set('protocolVersion', String(LIVESHARE_PROTOCOL_VERSION))
  url.searchParams.set('capabilities', LIVESHARE_CAPABILITIES.join(','))
  // The Relay is the authority for the capability, so the owner's switch travels with registration.
  if (spec.allowsFork === true) url.searchParams.set('allowsFork', '1')
  if (spec.sessionMode !== undefined) url.searchParams.set('sessionMode', spec.sessionMode)
  if (spec.ownerProviderId !== undefined && spec.ownerProviderId !== '') {
    url.searchParams.set('ownerProviderId', spec.ownerProviderId)
  }
  if (spec.ownerTenantId !== undefined && spec.ownerTenantId !== '') {
    url.searchParams.set('ownerTenantId', spec.ownerTenantId)
  }
  for (const subject of spec.allowedSubjectIds) {
    url.searchParams.append('allowedSubjectId', subject)
  }
  if (spec.expiresAt !== undefined && spec.expiresAt !== '') {
    url.searchParams.set('expiresAt', spec.expiresAt)
  }
  return url
}
