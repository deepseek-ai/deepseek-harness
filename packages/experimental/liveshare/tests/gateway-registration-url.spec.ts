import { describe, expect, it } from 'vitest'
import { LIVESHARE_CAPABILITIES, LIVESHARE_PROTOCOL_VERSION } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { registrationUrl } from '../src/owner-gateway/registration-url.ts'
import type { TunnelShareSpec } from '@deepseek-ai/dsh-experimental-liveshare-protocol'

/** The share every case starts from: the required fields, and nothing optional. */
const minimal: TunnelShareSpec = {
  shareId: 'share-one',
  sessionId: 'session-one',
  sessionTitle: 'Review the migration',
  accessMode: 'open',
  relay: 'https://relay.example',
  gatewayToken: 'token-one',
  ownerDisplayName: 'Owner',
  allowedSubjectIds: [],
}

describe('Liveshare registration handshake', () => {
  it('states the protocol version and capabilities this build reads frames with', () => {
    const url = registrationUrl(minimal)

    expect(url.origin).toBe('wss://relay.example')
    expect(url.protocol).toBe('wss:')
    expect(url.pathname).toBe('/__tunnel_gateway__')
    expect(url.searchParams.get('protocolVersion')).toBe(String(LIVESHARE_PROTOCOL_VERSION))
    expect(url.searchParams.get('capabilities')).toBe(LIVESHARE_CAPABILITIES.join(','))
  })

  it('carries the base path of a Relay published under one', () => {
    const url = registrationUrl({ ...minimal, relay: 'https://relay.example/liveshare/' })

    expect(url.pathname).toBe('/liveshare/__tunnel_gateway__')
  })

  it('registers over the plain-socket scheme when the Relay itself is served over http', () => {
    // A Relay deployed without TLS is reached over `ws:`; the handshake scheme follows the address
    // the owner configured rather than being pinned to `wss:`.
    const url = registrationUrl({ ...minimal, relay: 'http://relay.example' })

    expect(url.protocol).toBe('ws:')
    expect(url.origin).toBe('ws://relay.example')
  })

  it('sends the required share facts unchanged', () => {
    const url = registrationUrl({ ...minimal, accessMode: 'selected' })

    expect(url.searchParams.get('shareId')).toBe('share-one')
    expect(url.searchParams.get('sessionId')).toBe('session-one')
    expect(url.searchParams.get('sessionTitle')).toBe('Review the migration')
    expect(url.searchParams.get('accessMode')).toBe('selected')
    expect(url.searchParams.get('ownerDisplayName')).toBe('Owner')
  })

  it('leaves every optional fact absent until the share states it', () => {
    const url = registrationUrl(minimal)

    for (const absent of ['sessionMode', 'allowsFork', 'dshVersion', 'ownerInstanceId', 'expiresAt', 'ownerProviderId', 'ownerTenantId', 'allowedSubjectId']) {
      expect(url.searchParams.get(absent), absent).toBeNull()
    }
  })

  it('carries exactly the optionals the share states', () => {
    const url = registrationUrl({
      ...minimal,
      sessionMode: 'write',
      allowsFork: true,
      dshVersion: '0.2.0-rc.2',
      ownerInstanceId: 'instance-one',
      expiresAt: '2026-10-03T00:00:00.000Z',
      ownerProviderId: 'feishu',
      ownerTenantId: 'tenant-a',
      allowedSubjectIds: ['ou_viewer', 'feishu:tenant-a:ou_other'],
    })

    expect(url.searchParams.get('sessionMode')).toBe('write')
    expect(url.searchParams.get('allowsFork')).toBe('1')
    expect(url.searchParams.get('dshVersion')).toBe('0.2.0-rc.2')
    expect(url.searchParams.get('ownerInstanceId')).toBe('instance-one')
    expect(url.searchParams.get('expiresAt')).toBe('2026-10-03T00:00:00.000Z')
    expect(url.searchParams.get('ownerProviderId')).toBe('feishu')
    expect(url.searchParams.get('ownerTenantId')).toBe('tenant-a')
    expect(url.searchParams.getAll('allowedSubjectId')).toEqual(['ou_viewer', 'feishu:tenant-a:ou_other'])
  })

  it('never sends the retired approval-card recipient parameters', () => {
    const url = registrationUrl({ ...minimal, ownerProviderId: 'feishu', ownerTenantId: 'tenant-a' })

    for (const gone of ['ownerFeishuId', 'ownerFeishuIdType']) {
      expect(url.searchParams.get(gone), gone).toBeNull()
    }
  })

  it('never sends a fork switch that is off, so an older Relay reads it as no forking', () => {
    expect(registrationUrl({ ...minimal, allowsFork: false }).searchParams.get('allowsFork')).toBeNull()
  })
})
