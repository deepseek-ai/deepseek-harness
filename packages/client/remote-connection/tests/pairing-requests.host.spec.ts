/** Private ticket ownership, approval decisions, expiry, and retryable Cookie delivery. */

import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { PairingRequests } from '../src/pairing-requests.ts'
import type { PairingLimits } from '../src/pairing-requests.ts'
import type { PairingRequestId } from '../src/types.ts'

const AUTHORITY = 'https://example.test'
const SOURCE_IP = '192.0.2.24'
const limits: PairingLimits = { requestTtlMs: 10_000, maxRequests: 2, requestIntervalMs: 100, pollIntervalMs: 200 }

function credential() { return { id: randomUUID() as PairingRequestId, secret: randomBytes(32).toString('base64url') } }

function setup(overrides: Partial<PairingLimits> = {}) {
  vi.useFakeTimers()
  const requests = new PairingRequests({ ...limits, ...overrides })
  const ticket = requests.create(AUTHORITY, SOURCE_IP, credential())!
  const issue = vi.fn((): string | undefined => 'signed-cookie')
  const poll = (secret = ticket.secret, authority = AUTHORITY, cancel = false) => requests.poll(ticket.id, secret, authority, cancel, issue)
  return { requests, ticket, issue, poll }
}

afterEach(() => vi.useRealTimers())

it('retains each applicant connection IP independently of the shared application origin', () => {
  const { requests, ticket } = setup()
  vi.advanceTimersByTime(limits.requestIntervalMs)
  const second = requests.create(AUTHORITY, '2001:db8::24', credential())!
  expect(ticket.sourceIp).toBe(SOURCE_IP)
  expect(second.sourceIp).toBe('2001:db8::24')
  expect(requests.list().map(({ id, authority, sourceIp }) => ({ id, authority, sourceIp }))).toEqual([
    { id: ticket.id, authority: AUTHORITY, sourceIp: SOURCE_IP },
    { id: second.id, authority: AUTHORITY, sourceIp: '2001:db8::24' },
  ])
})

it('requires the private ticket and owner approval, then retries the same Cookie', () => {
  const { requests, ticket, issue, poll } = setup()
  expect(ticket.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u)
  expect(ticket.secret).toHaveLength(43)
  expect(requests.list()).toEqual([{ id: ticket.id, code: ticket.code, authority: AUTHORITY, sourceIp: SOURCE_IP, expiresInMs: 10_000 }])
  vi.advanceTimersByTime(200)
  expect(poll(ticket.code)).toEqual({ status: 'expired' })
  expect(poll('A'.repeat(43))).toEqual({ status: 'expired' })
  expect(poll(ticket.secret, 'https://other.test')).toEqual({ status: 'expired' })
  expect(requests.poll('absent' as PairingRequestId, ticket.secret, AUTHORITY, false, issue)).toEqual({ status: 'expired' })
  expect(poll()).toEqual({ status: 'pending' })
  expect(issue).not.toHaveBeenCalled()
  expect(requests.decide(ticket.id, 'allow')).toBe('approved')
  expect(requests.list()).toEqual([])
  vi.advanceTimersByTime(200)
  expect(poll()).toEqual({ status: 'completed', cookie: 'signed-cookie' })
  expect(requests.decide(ticket.id, 'deny')).toBe('unavailable')
  vi.advanceTimersByTime(200)
  expect(poll()).toEqual({ status: 'completed', cookie: 'signed-cookie' })
  expect(poll(ticket.secret, AUTHORITY, true)).toEqual({ status: 'completed', cookie: 'signed-cookie' })
  expect(issue).toHaveBeenCalledTimes(1)
})

it.each(['allow', 'deny'] as const)('retains the first decision when owner devices disagree: %s', (first) => {
  const { requests, ticket, poll, issue } = setup()
  const result = first === 'allow' ? 'approved' : 'denied'
  expect(requests.decide(ticket.id, first)).toBe(result)
  expect(requests.decide(ticket.id, first === 'allow' ? 'deny' : 'allow')).toBe(result)
  vi.advanceTimersByTime(200)
  expect(poll().status).toBe(first === 'allow' ? 'completed' : 'denied')
  expect(issue).toHaveBeenCalledTimes(first === 'allow' ? 1 : 0)
})

it('withdraws an uncollected approval and preserves denial on cancellation', () => {
  const { requests, ticket, poll, issue } = setup()
  requests.decide(ticket.id, 'allow')
  expect(poll(ticket.secret, AUTHORITY, true)).toEqual({ status: 'cancelled' })
  expect(requests.decide(ticket.id, 'allow')).toBe('unavailable')
  vi.advanceTimersByTime(200)
  expect(poll()).toEqual({ status: 'cancelled' })
  const denied = requests.create(AUTHORITY, SOURCE_IP, credential())!
  requests.decide(denied.id, 'deny')
  expect(requests.poll(denied.id, denied.secret, AUTHORITY, true, issue)).toEqual({ status: 'denied' })
  expect(issue).not.toHaveBeenCalled()
})

it.each(['allow', 'deny'] as const)('does not revive a cancelled request when an owner later chooses %s', (decision) => {
  const { requests, ticket, poll, issue } = setup()
  expect(poll(ticket.secret, AUTHORITY, true)).toEqual({ status: 'cancelled' })
  expect(requests.decide(ticket.id, decision)).toBe('unavailable')
  expect(requests.list()).toEqual([])
  vi.advanceTimersByTime(limits.pollIntervalMs)
  expect(poll()).toEqual({ status: 'cancelled' })
  expect(issue).not.toHaveBeenCalled()
})

it.each(['allow', 'deny'] as const)('rejects a first %s decision at the exact request deadline', (decision) => {
  const { requests, ticket, poll, issue } = setup()
  vi.advanceTimersByTime(limits.requestTtlMs - 1)
  expect(requests.list()).toEqual([{ id: ticket.id, code: ticket.code, authority: AUTHORITY, sourceIp: SOURCE_IP, expiresInMs: 1 }])
  vi.advanceTimersByTime(1)
  expect(requests.decide(ticket.id, decision)).toBe('unavailable')
  expect(poll()).toEqual({ status: 'expired' })
  expect(requests.list()).toEqual([])
  expect(issue).not.toHaveBeenCalled()
})

it('expires an approval exactly at its deadline and reclaims capacity', () => {
  const { requests, ticket, poll, issue } = setup({ maxRequests: 1 })
  requests.decide(ticket.id, 'allow')
  vi.advanceTimersByTime(10_000)
  expect(poll()).toEqual({ status: 'expired' })
  expect(requests.decide(ticket.id, 'allow')).toBe('unavailable')
  expect(requests.list()).toEqual([])
  expect(requests.create(AUTHORITY, SOURCE_IP, credential())).toBeDefined()
  expect(issue).not.toHaveBeenCalled()
})

it('bounds global creation, per-ticket polling, and retention of terminal requests', () => {
  const { requests, ticket, poll } = setup()
  expect(requests.create(AUTHORITY, SOURCE_IP, credential())).toBeUndefined()
  expect(poll()).toEqual({ status: 'slow-down' })
  vi.advanceTimersByTime(100)
  const second = requests.create(AUTHORITY, SOURCE_IP, credential())!
  expect(second.code).not.toBe(ticket.code)
  expect(second.secret).not.toBe(ticket.secret)
  requests.decide(ticket.id, 'deny')
  vi.advanceTimersByTime(100)
  expect(requests.create(AUTHORITY, SOURCE_IP, credential())).toBeUndefined()
})

it('keeps approval retryable when Cookie signing is refused or fails', () => {
  const { requests, ticket, issue, poll } = setup()
  requests.decide(ticket.id, 'allow')
  vi.advanceTimersByTime(200)
  issue.mockReturnValueOnce(undefined)
  expect(poll()).toEqual({ status: 'unavailable' })
  vi.advanceTimersByTime(200)
  issue.mockImplementationOnce(() => { throw new Error('signer unavailable') })
  expect(poll).toThrow('signer unavailable')
  vi.advanceTimersByTime(200)
  expect(poll()).toEqual({ status: 'completed', cookie: 'signed-cookie' })
})

it.each(['cancel', 'deny'] as const)('handles %s after Cookie signing fails without changing the first owner decision', (next) => {
  const { requests, ticket, issue, poll } = setup()
  expect(requests.decide(ticket.id, 'allow')).toBe('approved')
  vi.advanceTimersByTime(limits.pollIntervalMs)
  issue.mockReturnValueOnce(undefined)
  expect(poll()).toEqual({ status: 'unavailable' })
  expect(requests.list()).toEqual([])
  if (next === 'cancel') {
    expect(poll(ticket.secret, AUTHORITY, true)).toEqual({ status: 'cancelled' })
    expect(requests.decide(ticket.id, 'allow')).toBe('unavailable')
    vi.advanceTimersByTime(limits.pollIntervalMs)
    expect(poll()).toEqual({ status: 'cancelled' })
    expect(issue).toHaveBeenCalledOnce()
  } else {
    expect(requests.decide(ticket.id, 'deny')).toBe('approved')
    vi.advanceTimersByTime(limits.pollIntervalMs)
    expect(poll()).toEqual({ status: 'completed', cookie: 'signed-cookie' })
    expect(issue).toHaveBeenCalledTimes(2)
  }
})

it('forgets tickets and retained Cookies on unload', () => {
  const { requests, ticket, poll } = setup()
  requests.decide(ticket.id, 'allow')
  requests.clear()
  expect(requests.list()).toEqual([])
  expect(poll()).toEqual({ status: 'expired' })
})

it('replays creation before rate and capacity checks without extending expiry or replacing the source IP', () => {
  const { requests, ticket } = setup({ maxRequests: 1 })
  expect(requests.create(AUTHORITY, '198.51.100.42', ticket)).toEqual(ticket)
  vi.advanceTimersByTime(100)
  expect(requests.create(AUTHORITY, SOURCE_IP, ticket)).toEqual({ ...ticket, expiresInMs: 9900 })
  expect(requests.create('https://other.test', SOURCE_IP, ticket)).toBeUndefined()
  expect(requests.create(AUTHORITY, SOURCE_IP, { ...ticket, secret: 'b'.repeat(43) })).toBeUndefined()
  expect(requests.list()).toHaveLength(1)
})

it('does not revive a cancelled creation when its older HTTP request arrives after a replacement from the same IP', () => {
  const { requests, ticket, poll, issue } = setup()
  expect(poll(ticket.secret, AUTHORITY, true).status).toBe('cancelled')
  vi.advanceTimersByTime(limits.requestIntervalMs)
  const replacement = requests.create(AUTHORITY, SOURCE_IP, credential())!
  expect(replacement.id).not.toBe(ticket.id)
  expect(replacement.secret).not.toBe(ticket.secret)
  expect(requests.create(AUTHORITY, SOURCE_IP, ticket)).toMatchObject({ id: ticket.id, code: ticket.code })
  expect(requests.decide(ticket.id, 'allow')).toBe('unavailable')
  expect(requests.list().map(row => row.id)).toEqual([replacement.id])
  vi.advanceTimersByTime(limits.pollIntervalMs)
  expect(poll().status).toBe('cancelled')
  expect(requests.poll(replacement.id, ticket.secret, AUTHORITY, false, issue).status).toBe('expired')
  expect(requests.poll(replacement.id, replacement.secret, AUTHORITY, false, issue).status).toBe('pending')
  expect(issue).not.toHaveBeenCalled()
})
