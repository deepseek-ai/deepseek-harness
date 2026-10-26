/** Relay wire version 1; same-package Host/worker IPC requires request tokens. */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIVESHARE_PROTOCOL_VERSION,
  parseGatewayFrame,
  parseRelayFrame,
  parseTunnelWorkerCommand,
  parseTunnelWorkerEvent,
  rejectedCommandShareId,
  unsupportedFrameRefusal,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'

/** Which two endpoints exchanged a recorded frame, which also names the codec that reads it. */
type Direction = 'relay->gateway' | 'gateway->relay' | 'host->worker' | 'worker->host'

/** One frame the current build exchanges, with the fields it may omit. */
interface RecordedFrame {
  readonly dir: Direction
  readonly note: string
  readonly frame: Record<string, unknown>
  /** Raw socket text, when the recording pins bytes rather than the frame's fields. */
  readonly text?: string
  /** Top-level fields this build sends only when it has something to say. */
  readonly optional?: readonly string[]
}

/** One frame this build must refuse: a later build's addition, or a value the vocabulary rejects. */
interface RefusedFrame {
  readonly dir: Direction
  readonly note: string
  readonly frame: Record<string, unknown>
  readonly text?: string
  /**
   * The refusal this build answers with, or null when the frame states nothing to answer: an
   * unreadable envelope, or a frame that answers another rather than asking for one.
   */
  readonly refusal?: { readonly status: number; readonly body: { readonly error: string } } | null
}

const FRAMES_DIR = join(import.meta.dirname, 'frames')

/**
 * Read every recorded frame in one directory.
 * @param directory - Directory under `frames/`.
 * @returns Recordings in file-name order.
 */
function readFrames<T>(directory: string): T[] {
  return readdirSync(join(FRAMES_DIR, directory))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(readFileSync(join(FRAMES_DIR, directory, name), 'utf8')) as T)
}

/**
 * The socket text a recording stands for.
 * @param recorded - Recording holding either raw text or the frame it carried.
 * @returns The recorded text.
 */
function wireText(recorded: { readonly frame: Record<string, unknown>; readonly text?: string }): string {
  return recorded.text ?? JSON.stringify(recorded.frame)
}

/**
 * Read one recorded frame through the codec its direction names.
 * @param direction - Endpoints that exchanged the frame.
 * @param text - Raw socket text the recording carries.
 * @returns The parsed frame, or undefined when this build refuses it.
 */
function parseFrame(direction: Direction, text: string): unknown {
  switch (direction) {
    case 'relay->gateway':
      return parseRelayFrame(text)
    case 'gateway->relay':
      return parseGatewayFrame(text)
    // The worker's two directions cross a process boundary as values, not socket text, so the
    // codecs read the decoded value and the envelope is the caller's JSON parse.
    case 'host->worker':
      return parseTunnelWorkerCommand(JSON.parse(text))
    case 'worker->host':
      return parseTunnelWorkerEvent(JSON.parse(text))
  }
}

/**
 * One recorded frame without one top-level field.
 * @param frame - Recorded frame.
 * @param field - Field to remove.
 * @returns A copy without that field.
 */
function withoutField(frame: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frame).filter(([key]) => key !== field))
}

describe('recorded frames', () => {
  it('round-trips every current frame through the codec its direction names', () => {
    for (const recorded of readFrames<RecordedFrame>('v1')) {
      expect(parseFrame(recorded.dir, wireText(recorded)), recorded.note).toEqual(recorded.frame)
    }
  })

  it('keeps every recorded optional field optional', () => {
    for (const recorded of readFrames<RecordedFrame>('v1')) {
      if (parseFrame(recorded.dir, wireText(recorded)) === undefined) continue
      for (const field of recorded.optional ?? []) {
        const withoutOptional = { ...recorded, frame: withoutField(recorded.frame, field) }
        expect(parseFrame(recorded.dir, wireText(withoutOptional)), `${recorded.note} (without ${field})`)
          .toEqual(withoutField(recorded.frame, field))
      }
    }
  })

  it('refuses a frame this build does not know instead of throwing', () => {
    for (const recorded of readFrames<RefusedFrame>('unknown')) {
      expect(() => parseFrame(recorded.dir, wireText(recorded)), recorded.note).not.toThrow()
      expect(parseFrame(recorded.dir, wireText(recorded)), recorded.note).toBeUndefined()
    }
  })

  it('keeps the fields that carry a request identity required', () => {
    // `id` correlates an answer with its request and `actor` is the caller the owner may act on:
    // widening either one moves authority rather than convenience, so both stay required without
    // being recorded as optional elsewhere.
    const request = readFrames<RecordedFrame>('v1')
      .find(recorded => recorded.dir === 'relay->gateway' && recorded.frame.type === 'share-rpc')
    if (request === undefined) throw new Error('the relay->gateway share-rpc recording is missing')
    for (const field of ['id', 'actor']) {
      expect(parseFrame(request.dir, wireText({ ...request, frame: withoutField(request.frame, field) })), field)
        .toBeUndefined()
    }
  })

  it('answers a frame it cannot serve instead of leaving the peer to wait', () => {
    for (const recorded of readFrames<RefusedFrame>('unknown')) {
      if (recorded.dir !== 'relay->gateway') continue
      const refusal = unsupportedFrameRefusal(wireText(recorded))
      if (recorded.refusal === null || recorded.refusal === undefined) {
        expect(refusal, recorded.note).toBeUndefined()
        continue
      }
      expect(refusal, recorded.note).toMatchObject({ type: 'share-rpc-res', ...recorded.refusal })
    }
  })

  it('answers nothing for a frame it does serve', () => {
    for (const recorded of readFrames<RecordedFrame>('v1')) {
      if (recorded.dir !== 'relay->gateway') continue
      expect(unsupportedFrameRefusal(wireText(recorded)), recorded.note).toBeUndefined()
    }
  })

  it('names the share a refused owner command was about', () => {
    expect(rejectedCommandShareId({ type: 'set-share-mode', shareId: 'share-one' })).toBe('share-one')
    expect(rejectedCommandShareId({ type: 'add-share', share: { shareId: 'share-two' } })).toBe('share-two')
    expect(rejectedCommandShareId({ type: 'set-share-mode' })).toBeUndefined()
    expect(rejectedCommandShareId({ type: 'remove-share', shareId: '' })).toBeUndefined()
    expect(rejectedCommandShareId({ type: 'add-share', share: { sessionId: 'session-one' } })).toBeUndefined()
    expect(rejectedCommandShareId(null)).toBeUndefined()
    expect(rejectedCommandShareId('share-one')).toBeUndefined()
  })

  it('refuses malformed text without throwing', () => {
    const malformed = ['', '{', 'null', '[]', '"share-rpc"', '{"type":"share-rpc"}', '{"id":1}', '{"type":"share-rpc","id":"7"}']
    for (const text of malformed) {
      expect(() => parseRelayFrame(text), text).not.toThrow()
      expect(parseRelayFrame(text), text).toBeUndefined()
      expect(() => parseGatewayFrame(text), text).not.toThrow()
      expect(parseGatewayFrame(text), text).toBeUndefined()
    }
  })
})

describe('wire protocol version', () => {
  it('states the initial wire protocol version', () => {
    expect(LIVESHARE_PROTOCOL_VERSION).toBe(1)
  })
})

describe('additive wire fields reject invalid values', () => {
  const actor = { providerId: 'example', tenantId: 'tenant-a', subjectId: 'user-one' }
  const request = (overrides: Record<string, unknown>) => {
    const text = JSON.stringify({ type: 'share-rpc', id: 1, body: {}, actor: { ...actor, ...overrides } })
    return parseGatewayFrame(text) ?? parseRelayFrame(text)
  }

  it('accepts an absent actor credential and refuses a non-string one', () => {
    expect(request({})).toMatchObject({ actor })
    expect(request({ credential: 123 })).toBeUndefined()
  })

  it('refuses an unknown connection mode and defaults an absent one to relay', () => {
    const share = {
      shareId: 'share', sessionId: 'session', sessionTitle: 'Source', accessMode: 'selected',
      relay: 'wss://relay.test', gatewayToken: 'token', ownerDisplayName: 'Owner', allowedSubjectIds: [],
    }
    const token = '12345678-1234-4123-8123-123456789abc'
    expect(parseTunnelWorkerCommand({ type: 'add-share', registrationToken: token,
      share: { ...share, connection: { mode: 'bogus' } } })).toBeUndefined()
    expect(parseTunnelWorkerCommand({ type: 'add-share', registrationToken: token, share }))
      .toMatchObject({ share: { connection: { mode: 'relay' } } })
  })
})
