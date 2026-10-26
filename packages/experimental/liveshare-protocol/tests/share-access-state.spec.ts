/** Lifecycle authority frames are id-less and validated independently from RPC envelopes. */
import { describe, expect, it } from 'vitest'
import { parseGatewayFrame, parseRelayFrame, parseTunnelWorkerEvent, LIVESHARE_CAPABILITIES } from '../src/tunnel-protocol.ts'

const registrationToken = '12345678-1234-4123-8123-123456789abc'
const state = { type: 'share-access-state', version: 12, accessMode: 'selected',
  allowedSubjectIds: ['identity-key'], sessionMode: 'write', allowsFileUpload: false,
  expiresAt: '2026-10-09T00:00:00Z' }

describe('Relay authority snapshot frame', () => {
  it('accepts lifecycle wire and IPC snapshots without an RPC id', () => {
    expect(parseRelayFrame(JSON.stringify(state))).toEqual(state)
    expect(parseTunnelWorkerEvent({ ...state, registrationToken, shareId: 'share' })).toEqual({ ...state, registrationToken, shareId: 'share' })
    expect(parseGatewayFrame(JSON.stringify(state))).toBeUndefined()
    expect(LIVESHARE_CAPABILITIES).toContain('share-access-state')
  })
  it.each([
    { version: -1 }, { version: 0.5 }, { accessMode: 'future' }, { sessionMode: 'future' },
    { allowedSubjectIds: [1] }, { allowedSubjectIds: [''] }, { expiresAt: 'not-a-time' },
  ])('refuses malformed authority fields %j', (fields) => {
    expect(parseRelayFrame(JSON.stringify({ ...state, ...fields }))).toBeUndefined()
    expect(parseTunnelWorkerEvent({ ...state, registrationToken, shareId: 'share', ...fields })).toBeUndefined()
  })
})

describe('share access-state file uploads', () => {
  it('defaults uploads off when the frame omits the field', () => {
    const { allowsFileUpload: _ignored, ...legacy } = state
    expect(parseRelayFrame(JSON.stringify(legacy))).toMatchObject({ allowsFileUpload: false })
  })

  it('carries an explicit upload permission through', () => {
    expect(parseRelayFrame(JSON.stringify({ ...state, allowsFileUpload: true })))
      .toMatchObject({ allowsFileUpload: true })
  })
})
