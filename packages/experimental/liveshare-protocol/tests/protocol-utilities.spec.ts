/** Every wire helper and additive-field parser branch, exercised without a recorded frame. */

import { describe, expect, it } from 'vitest'
import {
  parseRelayFrame,
  parseShareAccessState,
  parseTunnelWorkerCommand,
  parseTunnelWorkerEvent,
  rawText,
  rejectedCommandShareId,
  sendFrame,
  unsupportedFrameRefusal,
  viewerRequestFields,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'

/** One registration token; the parsers accept only this UUID-v4 shape. */
const REGISTRATION = '11111111-1111-4111-8111-111111111111'
/** One request token the IPC parsers require to be non-empty. */
const TOKEN = 'request-token'

/**
 * A share spec the worker accepts as written.
 * @returns Every required field, with no optional field present.
 */
function spec(): Record<string, unknown> {
  return {
    shareId: 'share-one',
    sessionId: 'session-one',
    sessionTitle: 'Title',
    accessMode: 'selected',
    relay: 'wss://relay.example',
    gatewayToken: 'token-one',
    ownerDisplayName: 'Owner',
    allowedSubjectIds: ['viewer'],
  }
}

/**
 * Wrap one share spec as the add-share command the host sends its worker.
 * @param share - Share spec to carry.
 * @returns The IPC command.
 */
function addShare(share: unknown): Record<string, unknown> {
  return { type: 'add-share', registrationToken: REGISTRATION, share }
}

/**
 * A committed authority snapshot the parser accepts.
 * @returns Every required field, with the optional additions left out.
 */
function state(): Record<string, unknown> {
  return {
    type: 'share-access-state',
    version: 3,
    accessMode: 'selected',
    allowedSubjectIds: ['viewer'],
    sessionMode: 'view',
  }
}

describe('wire helpers', () => {
  it('summarizes one opaque viewer request for logging', () => {
    expect(viewerRequestFields({ op: 'call', id: 7 })).toEqual({ op: 'call', streamId: '7' })
    expect(viewerRequestFields({ op: 4, id: 'seven' })).toEqual({ op: 'unknown', streamId: '-' })
    expect(viewerRequestFields({})).toEqual({ op: 'unknown', streamId: '-' })
    for (const body of [null, 'text', 3, undefined]) {
      expect(viewerRequestFields(body)).toEqual({ op: 'unknown', streamId: '-' })
    }
  })

  it('sends one frame only on an open socket', () => {
    const sent: string[] = []
    sendFrame({ readyState: 1, send: (data: string) => { sent.push(data) } }, { type: 'share-rpc-cancel', id: 1 })
    sendFrame({ readyState: 3, send: (data: string) => { sent.push(data) } }, { type: 'share-rpc-cancel', id: 1 })
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0] ?? '')).toEqual({ type: 'share-rpc-cancel', id: 1 })
  })

  it('decodes every representation ws hands the gateways', () => {
    expect(rawText(Buffer.from('a'))).toBe('a')
    expect(rawText(new TextEncoder().encode('bc').buffer)).toBe('bc')
    expect(rawText([Buffer.from('de'), Buffer.from('f')])).toBe('def')
  })

  it('reads the share a rejected command names', () => {
    expect(rejectedCommandShareId({ shareId: 'direct' })).toBe('direct')
    expect(rejectedCommandShareId({ share: { shareId: 'nested' } })).toBe('nested')
    expect(rejectedCommandShareId({ share: { shareId: '' } })).toBeUndefined()
    expect(rejectedCommandShareId({ share: 'not-an-object' })).toBeUndefined()
    expect(rejectedCommandShareId({})).toBeUndefined()
    expect(rejectedCommandShareId(null)).toBeUndefined()
  })
})

describe('Relay frame parsing', () => {
  it('parses the frames a gateway may receive', () => {
    expect(parseRelayFrame(JSON.stringify(state()))).toMatchObject({ type: 'share-access-state', version: 3 })
    expect(parseRelayFrame(JSON.stringify({
      type: 'share-rpc', id: 4, body: { op: 'call' }, actor: { providerId: 'p', tenantId: 't', subjectId: 's' },
    }))).toEqual({
      type: 'share-rpc', id: 4, body: { op: 'call' },
      actor: { providerId: 'p', tenantId: 't', subjectId: 's' },
    })
    expect(parseRelayFrame(JSON.stringify({
      type: 'share-rpc', id: 4, body: null,
      actor: { providerId: 'p', tenantId: 't', subjectId: 's', credential: 'signed' },
    }))).toMatchObject({ actor: { credential: 'signed' } })
    expect(parseRelayFrame(JSON.stringify({ type: 'share-rpc-cancel', id: 5 }))).toEqual({ type: 'share-rpc-cancel', id: 5 })
  })

  it('drops frames that carry no serveable request', () => {
    expect(parseRelayFrame('not json')).toBeUndefined()
    expect(parseRelayFrame('null')).toBeUndefined()
    expect(parseRelayFrame('[]')).toBeUndefined()
    expect(parseRelayFrame(JSON.stringify({ type: 'share-rpc', body: {} }))).toBeUndefined()
    expect(parseRelayFrame(JSON.stringify({ type: 'share-rpc', id: 1, actor: { providerId: 'p', tenantId: 't', subjectId: 's' } })))
      .toBeUndefined()
    const valid = { type: 'share-rpc', id: 1, body: {} }
    for (const actor of [
      undefined,
      'actor',
      { providerId: '', tenantId: 't', subjectId: 's' },
      { providerId: 'p', tenantId: '', subjectId: 's' },
      { providerId: 'p', tenantId: 't', subjectId: '' },
      { providerId: 'p', tenantId: 't', subjectId: 's', credential: 3 },
    ]) {
      expect(parseRelayFrame(JSON.stringify({ ...valid, actor }))).toBeUndefined()
    }
    expect(parseRelayFrame(JSON.stringify({ type: 'share-rpc-res', id: 1 }))).toBeUndefined()
    expect(parseRelayFrame(JSON.stringify({ type: 'future', id: 1 }))).toBeUndefined()
  })

  it('answers only a request it could not serve', () => {
    expect(unsupportedFrameRefusal(JSON.stringify({ type: 'share-rpc-cancel', id: 1 }))).toBeUndefined()
    expect(unsupportedFrameRefusal(JSON.stringify(state()))).toBeUndefined()
    expect(unsupportedFrameRefusal('not json')).toBeUndefined()
    expect(unsupportedFrameRefusal(JSON.stringify({ type: 'share-rpc', body: {} }))).toBeUndefined()
    expect(unsupportedFrameRefusal(JSON.stringify({ type: 'share-rpc', id: 1 }))).toEqual({
      type: 'share-rpc-res', id: 1, status: 400, body: { error: 'invalid-request' },
    })
    expect(unsupportedFrameRefusal(JSON.stringify({ type: 'share-rpc-res', id: 1 }))).toBeUndefined()
    expect(unsupportedFrameRefusal(JSON.stringify({ type: 'share-rpc-cancel', id: 1 }))).toBeUndefined()
    expect(unsupportedFrameRefusal(JSON.stringify({ type: 'future-frame', id: 2 }))).toEqual({
      type: 'share-rpc-res', id: 2, status: 501, body: { error: 'unsupported-frame' },
    })
    expect(unsupportedFrameRefusal(JSON.stringify({ type: '', id: 3 }))).toBeUndefined()
    expect(unsupportedFrameRefusal(JSON.stringify({ type: 4, id: 5 }))).toBeUndefined()
  })
})

describe('tunnel worker commands', () => {
  it('parses the commands a worker serves', () => {
    expect(parseTunnelWorkerCommand({ type: 'shutdown' })).toEqual({ type: 'shutdown' })
    expect(parseTunnelWorkerCommand({ type: 'remove-share', shareId: 'share-one' })).toEqual({
      type: 'remove-share', shareId: 'share-one',
    })
    expect(parseTunnelWorkerCommand({ type: 'remove-share', shareId: '' })).toBeUndefined()
    expect(parseTunnelWorkerCommand(addShare(spec()))).toMatchObject({
      type: 'add-share',
      share: { shareId: 'share-one', connection: { mode: 'relay' } },
    })
    expect(parseTunnelWorkerCommand(addShare({ ...spec(), connection: { mode: 'direct' } }))).toMatchObject({
      share: { connection: { mode: 'direct' } },
    })
    expect(parseTunnelWorkerCommand(addShare({ ...spec(), connection: { mode: 'carrier' } }))).toBeUndefined()
    expect(parseTunnelWorkerCommand(addShare({ ...spec(), connection: 'relay' }))).toBeUndefined()
    expect(parseTunnelWorkerCommand({ type: 'add-share', registrationToken: 'not-a-token', share: spec() })).toBeUndefined()
    expect(parseTunnelWorkerCommand({
      type: 'share-rpc-response', registrationToken: REGISTRATION, token: TOKEN, id: 1,
      shareId: 'share-one', status: 200, body: { ok: true },
    })).toMatchObject({ type: 'share-rpc-response', status: 200, body: { ok: true } })
    expect(parseTunnelWorkerCommand({
      type: 'share-rpc-response', registrationToken: REGISTRATION, token: TOKEN, id: 1,
      shareId: 'share-one', status: 200,
    })).not.toHaveProperty('body')
    for (const status of [99, 600, '200', 2_147_483_648]) {
      expect(parseTunnelWorkerCommand({
        type: 'share-rpc-response', registrationToken: REGISTRATION, token: TOKEN, id: 1,
        shareId: 'share-one', status,
      })).toBeUndefined()
    }
    expect(parseTunnelWorkerCommand({ type: 'future-command' })).toBeUndefined()
    expect(parseTunnelWorkerCommand(null)).toBeUndefined()
  })

  it('refuses every malformed field of a share spec', () => {
    const invalid: ReadonlyArray<Record<string, unknown>> = [
      {},
      { ...spec(), shareId: '' },
      { ...spec(), shareId: 4 },
      { ...spec(), sessionId: 4 },
      { ...spec(), sessionTitle: 4 },
      { ...spec(), accessMode: 'approval' },
      { ...spec(), relay: 4 },
      { ...spec(), gatewayToken: 4 },
      { ...spec(), ownerDisplayName: 4 },
      { ...spec(), ownerProviderId: 4 },
      { ...spec(), ownerTenantId: 4 },
      { ...spec(), dshVersion: 4 },
      { ...spec(), ownerInstanceId: 4 },
      { ...spec(), ownerCredential: 4 },
      { ...spec(), expiresAt: 4 },
      { ...spec(), expiresAt: 'banana' },
      { ...spec(), allowsFork: 'yes' },
      { ...spec(), sessionMode: 'fork-readonly' },
      { ...spec(), allowsFileUpload: 'yes' },
      { ...spec(), allowedSubjectIds: 'viewer' },
      { ...spec(), allowedSubjectIds: ['viewer', ''] },
      { ...spec(), allowedSubjectIds: ['viewer', 4] },
    ]
    for (const share of invalid) expect(parseTunnelWorkerCommand(addShare(share)), JSON.stringify(share)).toBeUndefined()
    for (const share of [null, 'share-one', []] as const) {
      expect(parseTunnelWorkerCommand(addShare(share))).toBeUndefined()
    }

    const allOptional = {
      ...spec(),
      ownerProviderId: 'p', ownerTenantId: 't', dshVersion: '1.0.0', ownerInstanceId: 'i',
      ownerCredential: 'credential', expiresAt: '2026-10-03T00:00:00.000Z',
      allowsFork: true, sessionMode: 'write', allowsFileUpload: false,
    }
    expect(parseTunnelWorkerCommand(addShare(allOptional))).toBeDefined()
    expect(parseTunnelWorkerCommand(addShare({ ...spec(), accessMode: 'open' }))).toBeDefined()
  })
})

describe('tunnel worker events', () => {
  it('parses the lifecycle events a host receives', () => {
    expect(parseTunnelWorkerEvent({ type: 'ready' })).toEqual({ type: 'ready' })
    for (const type of ['share-connected', 'share-closed'] as const) {
      expect(parseTunnelWorkerEvent({ type, registrationToken: REGISTRATION, shareId: 'share-one' }))
        .toEqual({ type, registrationToken: REGISTRATION, shareId: 'share-one' })
      expect(parseTunnelWorkerEvent({ type, registrationToken: 'bad', shareId: 'share-one' })).toBeUndefined()
      expect(parseTunnelWorkerEvent({ type, registrationToken: REGISTRATION, shareId: '' })).toBeUndefined()
    }
    expect(parseTunnelWorkerEvent({
      ...state(), registrationToken: REGISTRATION, shareId: 'share-one',
    })).toMatchObject({ type: 'share-access-state', registrationToken: REGISTRATION, shareId: 'share-one' })
    expect(parseTunnelWorkerEvent({
      ...state(), registrationToken: 'bad', shareId: 'share-one',
    })).toBeUndefined()
    expect(parseTunnelWorkerEvent({
      type: 'share-error', registrationToken: REGISTRATION, shareId: 'share-one', message: 'nope',
    })).toEqual({ type: 'share-error', registrationToken: REGISTRATION, shareId: 'share-one', message: 'nope' })
    expect(parseTunnelWorkerEvent({
      type: 'share-error', registrationToken: REGISTRATION, shareId: 'share-one',
    })).toBeUndefined()
    expect(parseTunnelWorkerEvent({
      type: 'share-rpc-cancel', registrationToken: REGISTRATION, token: TOKEN, id: 2, shareId: 'share-one',
    })).toEqual({ type: 'share-rpc-cancel', registrationToken: REGISTRATION, token: TOKEN, id: 2, shareId: 'share-one' })
    const actor = { providerId: 'p', tenantId: 't', subjectId: 's' }
    expect(parseTunnelWorkerEvent({
      type: 'share-rpc-request', registrationToken: REGISTRATION, token: TOKEN, id: 3,
      shareId: 'share-one', body: { op: 'call' }, actor,
    })).toMatchObject({ type: 'share-rpc-request', id: 3, actor })
    for (const malformed of [
      { type: 'share-rpc-request', registrationToken: REGISTRATION, token: TOKEN, id: 3, shareId: 'share-one', actor },
      { type: 'share-rpc-request', registrationToken: REGISTRATION, token: TOKEN, id: 3, shareId: 'share-one', body: {}, actor: 'actor' },
      { type: 'share-rpc-request', registrationToken: REGISTRATION, token: '', id: 3, shareId: 'share-one', body: {}, actor },
      { type: 'share-rpc-request', registrationToken: REGISTRATION, token: TOKEN, id: 0, shareId: 'share-one', body: {}, actor },
      { type: 'future-event' },
    ]) {
      expect(parseTunnelWorkerEvent(malformed)).toBeUndefined()
    }
    expect(parseTunnelWorkerEvent(null)).toBeUndefined()
  })
})

describe('committed authority parsing', () => {
  it('owns the snapshot fields a reader follows', () => {
    expect(parseShareAccessState(state())).toEqual({
      type: 'share-access-state', version: 3, accessMode: 'selected',
      allowedSubjectIds: ['viewer'], sessionMode: 'view', allowsFileUpload: false,
    })
    expect(parseShareAccessState({
      ...state(), version: 0, accessMode: 'open', sessionMode: 'write', allowsFork: true,
      allowsFileUpload: true, allowedSubjectIds: [], expiresAt: '2026-10-03T00:00:00.000Z',
    })).toEqual({
      type: 'share-access-state', version: 0, accessMode: 'open', allowedSubjectIds: [],
      sessionMode: 'write', allowsFork: true, allowsFileUpload: true,
      expiresAt: '2026-10-03T00:00:00.000Z',
    })
  })

  it('refuses a snapshot field this build cannot trust', () => {
    const invalid: ReadonlyArray<unknown> = [
      null,
      { ...state(), type: 'share-rpc' },
      { ...state(), version: -1 },
      { ...state(), version: 1.5 },
      { ...state(), accessMode: 'approval' },
      { ...state(), allowedSubjectIds: 'viewer' },
      { ...state(), allowedSubjectIds: [''] },
      { ...state(), allowedSubjectIds: [4] },
      { ...state(), sessionMode: 'fork-readonly' },
      { ...state(), allowsFork: 'yes' },
      { ...state(), allowsFileUpload: 'yes' },
      { ...state(), expiresAt: 4 },
      { ...state(), expiresAt: 'not-a-date' },
    ]
    for (const value of invalid) expect(parseShareAccessState(value), JSON.stringify(value)).toBeUndefined()
  })
})
