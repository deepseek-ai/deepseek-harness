import { describe, expect, it } from 'vitest'
import { PendingRpc } from '../src/owner-gateway/pending-rpc.ts'

describe('Liveshare pending viewer requests', () => {
  it('distinguishes equal Relay ids across shares and socket generations', () => {
    const pending = new PendingRpc<object>()
    const aliceSocket = {}
    const alice = pending.add('share-a', 1, aliceSocket)
    const otherShare = pending.add('share-b', 1, {})
    expect(pending.clear(aliceSocket)).toEqual([alice])
    const bobSocket = {}
    const bob = pending.add('share-a', 1, bobSocket)

    expect(new Set([alice.token, bob.token, otherShare.token]).size).toBe(3)
    expect(pending.take(alice)).toBeUndefined()
    expect(pending.take(bob)?.owner).toBe(bobSocket)
    expect(pending.take(otherShare)).toBe(otherShare)
  })

  it('keeps pending work when a response mismatches share or Relay id', () => {
    const pending = new PendingRpc<object>()
    const request = pending.add('share-a', 1, {})
    expect(pending.take({ ...request, shareId: 'share-b' })).toBeUndefined()
    expect(pending.take({ ...request, id: 2 })).toBeUndefined()
    expect(pending.take(request)).toBe(request)
    expect(pending.take(request)).toBeUndefined()
  })

  it('cancels only the request on the specified socket', () => {
    const pending = new PendingRpc<object>()
    const socketA = {}
    const socketB = {}
    const a = pending.add('share', 1, socketA)
    const b = pending.add('share', 1, socketB)
    expect(pending.cancel(socketA, 2)).toBeUndefined()
    expect(pending.cancel(socketA, 1)).toBe(a)
    expect(pending.cancel(socketA, 1)).toBeUndefined()
    expect(pending.clear(socketA)).toEqual([])
    expect(pending.take(a)).toBeUndefined()
    expect(pending.take(b)).toBe(b)
  })

  it('removes all socket requests and refuses silent duplicate ids', () => {
    const pending = new PendingRpc<object>()
    const socket = {}
    const a = pending.add('share', 1, socket)
    const b = pending.add('share', 2, socket)
    expect(() => pending.add('share', 1, socket)).toThrow('already pending')
    expect(pending.clear(socket)).toEqual([a, b])
    expect(pending.take(a)).toBeUndefined()
    expect(pending.take(b)).toBeUndefined()
    expect(pending.add('share', 1, socket).token).not.toBe(a.token)
  })
})
