import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseTunnelWorkerCommand, parseTunnelWorkerEvent } from '../src/tunnel-protocol.ts'

const registrationToken = '12345678-1234-4123-8123-123456789abc'
const identity = { registrationToken, token: 'worker-unique-request', shareId: 'share', id: 1 }
const frames = [
  { type: 'share-rpc-response', ...identity, status: 200, body: { answer: true } },
  { type: 'share-rpc-request', ...identity, body: { op: 'stream-read' }, actor: { providerId: 'mock', tenantId: 'mock', subjectId: 'alice' } },
  { type: 'share-rpc-cancel', ...identity },
]
const parse = (frame: Record<string, unknown>) => frame.type === 'share-rpc-response'
  ? parseTunnelWorkerCommand(frame)
  : parseTunnelWorkerEvent(frame)

describe('Host/worker request tokens', () => {
  it.each(frames)('accepts $type with complete request identity', (frame) => {
    expect(parse(frame)).toEqual(frame)
  })

  it.each(frames)('refuses $type without any correlation field', (frame) => {
    for (const field of ['registrationToken', 'token', 'id', 'shareId']) {
      expect(parse(Object.fromEntries(Object.entries(frame).filter(([key]) => key !== field)))).toBeUndefined()
    }
    for (const token of ['', null, 1]) expect(parse({ ...frame, token })).toBeUndefined()
    for (const id of [0, -1, 1.5, '1']) expect(parse({ ...frame, id })).toBeUndefined()
    expect(parse({ ...frame, shareId: '' })).toBeUndefined()
  })

  it('requires response status and request actor and body', () => {
    for (const status of [99, 600, 200.5]) expect(parse({ ...frames[0], status })).toBeUndefined()
    expect(parse({ ...frames[1], actor: undefined })).toBeUndefined()
    expect(parse({ ...frames[1], actor: { providerId: 'mock', tenantId: '', subjectId: 'alice' } })).toBeUndefined()
    expect(parse({ ...frames[1], body: undefined })).toBeUndefined()
  })
})

const share = { shareId: 'share', sessionId: 'session', sessionTitle: 'Session', accessMode: 'open',
  relay: 'http://relay.invalid', gatewayToken: 'gateway', ownerDisplayName: 'Owner', allowedSubjectIds: [],
  connection: { mode: 'relay' } }
const registrationFrames = [
  { type: 'add-share', registrationToken, share },
  { type: 'share-connected', registrationToken, shareId: 'share' },
  { type: 'share-closed', registrationToken, shareId: 'share' },
  { type: 'share-error', registrationToken, shareId: 'share', message: 'offline' },
  { type: 'share-access-state', registrationToken, shareId: 'share', version: 1, accessMode: 'open',
    allowedSubjectIds: [], sessionMode: 'view' },
]

describe('Host/worker registration identity', () => {
  it('rejects an empty subject in a share registration without rejecting an empty ACL', () => {
    expect(parseTunnelWorkerCommand({ type: 'add-share', registrationToken, share })).toBeDefined()
    expect(parseTunnelWorkerCommand({ type: 'add-share', registrationToken,
      share: { ...share, allowedSubjectIds: [''] } })).toBeUndefined()
  })
  const decode = (frame: Record<string, unknown>) => (frame.type === 'add-share' || frame.type === 'share-rpc-response')
    ? parseTunnelWorkerCommand(frame) : parseTunnelWorkerEvent(frame)
  it.each(registrationFrames)('accepts $type with its original registration UUID', (frame) => {
    expect(decode(frame)).toEqual(frame)
  })
  it.each([...registrationFrames, ...frames])('rejects $type without a valid registration UUID', (frame) => {
    for (const token of [undefined, '', 'not-a-uuid', 1, null,
      '12345678-1234-1123-8123-123456789abc', '12345678-1234-4123-0123-123456789abc']) {
      expect(decode({ ...frame, registrationToken: token })).toBeUndefined()
    }
  })
})

describe('unknown tier at the IPC boundary', () => {
  it('rejects a tier the current vocabulary does not name', () => {
    const share = {
      shareId: 'share', sessionId: 'session', sessionTitle: 'Source', accessMode: 'selected' as const,
      relay: 'https://relay.test', gatewayToken: 'token', ownerDisplayName: 'Owner',
      sessionMode: 'future', allowsFork: true, allowedSubjectIds: [],
    }
    expect(parseTunnelWorkerCommand({ type: 'add-share', registrationToken: randomUUID(), share })).toBeUndefined()
  })
})
