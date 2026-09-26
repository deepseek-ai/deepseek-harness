import { describe, expect, it } from 'vitest'
import type {
  SessionFormatArtifact,
  SessionFormatHeader,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV4Header,
  restoreReleasedV4Artifact,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV4Artifact as assertReleasedV4PhysicalArtifact } from '../src/testing/validation.ts'

const KNOWN = new Set(['turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end', 'user/message', 'session/end-seed'])

function header(overrides: Partial<Record<string, unknown>> = {}): SessionFormatHeader {
  return {
    version: 4,
    id: 'v4-session',
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
    ...overrides,
  }
}

function artifact(events: readonly Record<string, unknown>[], h = header(), inherited = 0): SessionFormatArtifact {
  return {
    header: h,
    inheritedEventCount: inherited,
    events: events as unknown as SessionFormatArtifact['events'],
  }
}

/** One canonical released-v4 turn: call a tool and receive its result. */
function conversation(): Record<string, unknown>[] {
  const message = (
    id: string,
    role: string,
    content: SessionFormatJsonObject[],
    source: SessionFormatJsonObject,
  ): SessionFormatJsonObject => (
    { id, role, content, source }
  )
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 2, time: 3, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: message('assistant-1', 'assistant', [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
        ], { kind: 'model', provider: 'mock', model: 'mock' }),
        stream: [{ type: 'chunk', time: 3, chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' } } }],
      },
    },
    {
      type: 'tool/call', seq: 3, time: 4,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
    },
    {
      type: 'tool/result', seq: 4, time: 5, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: { ...message('tool-1', 'tool', [{ type: 'text', text: 'ok' }], { kind: 'tool', callId: 'call-1' }),
          toolCallId: 'call-1', isError: false },
      },
    },
    { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('assertReleasedV4Header', () => {
  it('accepts the minimal and complete header images', () => {
    expect(() => { assertReleasedV4Header(header()) }).not.toThrow()
    expect(() => { assertReleasedV4Header(header({
      cwd: '/work', parentSession: 'parent', origin: 'subagent', agentPreset: 'headless', isSeeded: true,
    })) }).not.toThrow()
  })

  it('refuses malformed headers', () => {
    const malformed: Array<[string, Record<string, unknown>, RegExp]> = [
      ['wrong version', { ...header(), version: 2 }, /expected format v4/],
      ['non-string id', { ...header(), id: 3 }, /id must be a string/],
      ['non-count createdAt', { ...header(), createdAt: 'x' }, /createdAt/],
      ['non-count delegationDepth', { ...header(), delegationDepth: -1 }, /delegationDepth/],
      ['non-boolean isSeeded', { ...header(), isSeeded: 1 }, /isSeeded must be boolean/],
      ['relative cwd', { ...header(), cwd: 'work' }, /cwd must be absolute/],
      ['non-string parentSession', { ...header(), parentSession: 3 }, /parentSession must be a string/],
      ['non-string agentPreset', { ...header(), agentPreset: 3 }, /agentPreset must be a string/],
      ['invalid origin', { ...header(), origin: 'other' }, /origin must be "subagent"/],
    ]
    for (const [name, value, message] of malformed) {
      expect(() => { assertReleasedV4Header(value) }, name).toThrow(message)
    }
  })
})

describe('restoreReleasedV4Artifact', () => {
  it('validates dense envelopes, cuts, and event vocabulary', () => {
    const valid = artifact(conversation())
    expect(restoreReleasedV4Artifact(valid, KNOWN)).toBe(valid)

    expect(() => restoreReleasedV4Artifact(artifact(conversation(), header({ isSeeded: true }), 20), KNOWN))
      .toThrow(/inherited event count exceeds its events/)
    expect(() => restoreReleasedV4Artifact(artifact([
      { type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } },
    ], header(), 0), KNOWN))
      .toThrow(/format v4 unseeded Session contains an inherited end-seed marker/)
    expect(() => restoreReleasedV4Artifact(artifact(conversation(), header(), 1), KNOWN))
      .toThrow(/unseeded format v4 Session has inherited events/)
  })

  it('retains unknown child membership and rejects invalid identities or duplicate child ids', () => {
    const known = new Set([...KNOWN, 'subagent/catalog'])
    const data = { version: 1, childId: 'unreadable', childCreatedAt: 2, mode: 'unknown' }
    const event = { type: 'subagent/catalog', seq: 0, time: 1, data }
    const valid = artifact([event])
    expect(restoreReleasedV4Artifact(valid, known)).toBe(valid)
    expect(() => restoreReleasedV4Artifact(artifact([{ ...event, data: { ...data, label: 'retained' } }]), known)).not.toThrow()
    for (const invalid of [null, { ...data, version: 0 }, { ...data, version: 2 }, { ...data, childId: 1 },
      { ...data, childCreatedAt: -1 }, { ...data, mode: 'invalid' }, { ...data, label: null }]) {
      expect(() => restoreReleasedV4Artifact(artifact([{ ...event, data: invalid }]), known)).toThrow()
    }
    expect(() => restoreReleasedV4Artifact(artifact([event, { ...event, seq: 1 }]), known)).toThrow('duplicate catalog child')
    expect(() => restoreReleasedV4Artifact(artifact([event, { type: 'subagent/catalog', seq: 1, time: 1,
      data: { ...data, mode: 'one-shot' } }]), known)).toThrow('duplicate catalog child')
  })

  it('validates only the envelope in physical mode', () => {
    const unknown = conversation()
    unknown.splice(2, 0, { type: 'campaign/unknown', seq: 0, time: 1, data: { x: 1 } })
    for (const [index, item] of unknown.entries()) (item as { seq: number }).seq = index
    expect(() => { assertReleasedV4PhysicalArtifact(artifact(unknown)) }).not.toThrow()
    expect(() => restoreReleasedV4Artifact(artifact(unknown), KNOWN))
      .toThrow(/unknown event type/)
  })

  it('refuses unknown non-ignorable types and admits ignorable ones', () => {
    const unknown = conversation()
    unknown.splice(2, 0, { type: 'campaign/unknown', seq: 99, time: 1, data: { x: 1 } })
    expect(() => restoreReleasedV4Artifact(artifact(unknown), KNOWN))
      .toThrow(/unknown event type/)
    const ignorable = conversation()
    ignorable.splice(0, 0, {
      type: 'campaign/unknown', seq: 0, time: 1, ignorable: true, data: { x: 1 },
    })
    for (const [index, item] of ignorable.entries()) (item as { seq: number }).seq = index
    expect(() => restoreReleasedV4Artifact(artifact(ignorable), new Set([...KNOWN, 'campaign/unknown'])))
      .not.toThrow()
  })

  it('enforces V4-owned event density', () => {
    expect(() => restoreReleasedV4Artifact(artifact([
      { type: 'turn/start', time: 1, data: {} },
    ]), KNOWN)).toThrow(/is not dense/)
    expect(() => restoreReleasedV4Artifact(artifact([
      conversation()[0]!, { ...conversation()[1]!, seq: 3 },
    ]), KNOWN)).toThrow(/is not dense/)
  })

  it('enforces end-seed marker agreement', () => {
    const marker = (seq: number, inherited: boolean) => ({
      type: 'session/end-seed', seq, time: 1, data: { ...(inherited ? { inherited: true } : {}) },
    })
    expect(() => restoreReleasedV4Artifact(
      artifact([marker(0, true)], header({ isSeeded: true }), 0),
      new Set([...KNOWN, 'session/end-seed']),
    )).not.toThrow()
    expect(() => restoreReleasedV4Artifact(
      artifact([marker(0, false), marker(1, true)], header({ isSeeded: true }), 0),
      new Set([...KNOWN, 'session/end-seed']),
    )).toThrow(/seeded header disagrees/)
    expect(() => restoreReleasedV4Artifact(
      artifact([marker(0, true)], header(), 0),
      new Set([...KNOWN, 'session/end-seed']),
    )).toThrow(/unseeded Session contains an inherited end-seed marker/)
  })

  it('refuses non-object records and non-string event types', () => {
    expect(() => restoreReleasedV4Artifact(artifact([{ type: 3, seq: 0, time: 1, data: {} }]), KNOWN))
      .toThrow(/unknown event type/)
    expect(() => restoreReleasedV4Artifact(artifact([null as never]), KNOWN))
      .toThrow()
  })
})
