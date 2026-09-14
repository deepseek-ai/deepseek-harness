/** Output followers drain on process exit and discard queued data on detach. */
import { describe, expect, it } from 'vitest'
import { TerminalFollower } from '../src/stream.ts'
import type { TerminalFrame } from '../src/types.ts'

const frame: TerminalFrame = { type: 'output', sequence: 1, data: '终端' }
const signal = (): AbortSignal => new AbortController().signal

describe('TerminalFollower', () => {
  it('accepts the exact byte limit and restores capacity after each frame is consumed', async () => {
    const follower = new TerminalFollower(Buffer.byteLength(JSON.stringify(frame), 'utf8'))
    const stream = follower.read(signal())[Symbol.asyncIterator]()
    try {
      follower.push(frame)
      expect(await stream.next()).toEqual({ done: false, value: frame })
      follower.push(frame)
      follower.finish()
      follower.push({ ...frame, sequence: 2 })
      expect(await stream.next()).toEqual({ done: false, value: frame })
      expect(await stream.next()).toEqual({ done: true, value: undefined })
    } finally { follower.close(); await stream.return?.() }
  })

  it('fails accumulated overflow using encoded byte size', async () => {
    const follower = new TerminalFollower(Buffer.byteLength(JSON.stringify(frame), 'utf8'))
    follower.push(frame)
    follower.push(frame)
    await expect(follower.read(signal())[Symbol.asyncIterator]().next()).rejects.toThrow('reconnect to recover')
  })

  it('discards queued data when detached and ignores later output', async () => {
    const follower = new TerminalFollower(1000)
    follower.push(frame)
    follower.close()
    follower.push(frame)
    expect(await follower.read(signal())[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
  })

  it('does not deliver buffered output to an already-aborted request', async () => {
    const follower = new TerminalFollower(1000)
    follower.push(frame)
    const abort = new AbortController()
    abort.abort()
    expect(await follower.read(abort.signal)[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
  })

  it('wakes a waiting reader for output and then for graceful completion', async () => {
    const follower = new TerminalFollower(1000)
    const stream = follower.read(signal())[Symbol.asyncIterator]()
    try {
      const reading = stream.next()
      follower.push(frame)
      expect(await reading).toEqual({ done: false, value: frame })
      const finishing = stream.next()
      follower.finish()
      expect(await finishing).toEqual({ done: true, value: undefined })
    } finally { follower.close(); await stream.return?.() }
  })

  it('wakes a waiting reader on cancellation', async () => {
    const follower = new TerminalFollower(1000)
    const abort = new AbortController()
    const stream = follower.read(abort.signal)[Symbol.asyncIterator]()
    try {
      const reading = stream.next()
      abort.abort()
      expect(await reading).toEqual({ done: true, value: undefined })
    } finally { follower.close(); await stream.return?.() }
  })

  it('closes the follower when its consumer returns before EOF', async () => {
    const follower = new TerminalFollower(1000)
    const stream = follower.read(signal())[Symbol.asyncIterator]()
    follower.push(frame)
    await stream.next()
    await stream.return?.()
    follower.push(frame)
    expect(await follower.read(signal())[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
  })
})
