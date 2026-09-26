import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { SessionFormatEventCollector, type SessionFormatEvent, type SessionFormatArtifact, type SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { releasedV4SessionFormatCodec as codec, assertV4RowAdmission, restoreReleasedV4Artifact } from '../src/index.ts'
import { assertV4ForkResult } from '../src/fork-result.ts'

type MutableResult = {
  data: {
    message: { id: string; role: 'tool'; toolCallId: string; isError: boolean; content: unknown[] }
    error: { name: string }
  }
  sourceEventSeqs?: number[]
}

function fork() {
  const source = Session.create(SessionId('fork-parent'))
  source.append('turn/start', { turn: 1 })
  source.append('step/start', { turn: 1, step: 1 })
  source.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: [{ type: 'tool-call', id: ToolCallId('read-one'), name: 'read', arguments: '{}' }] }),
  }, { surfaceOp: 'append' })
  const seed = buildForkSeed(source.snapshotEvents(), SessionSeq(2))
  return Session.create(SessionId('fork-child'), seed, {
    version: 4, id: SessionId('fork-child'), createdAt: 1, delegationDepth: 0, isSeeded: true, parentSession: source.id,
  }, SessionLogOffset(3))
}

function artifact(session = fork()): SessionFormatArtifact {
  return JSON.parse(JSON.stringify({
    header: session.header, events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount,
  })) as SessionFormatArtifact
}

function restore(events: readonly SessionFormatEvent[]) {
  return restoreReleasedV4Artifact({ ...artifact(), events }, new Set(events.map(event => event.type)))
}

describe('V4 fork results', () => {
  it('ignores non-object fork-result data and validates non-object sources', () => {
    expect(() => { assertV4ForkResult({ type: 'tool/result', data: null }) }).not.toThrow()
    expect(() => { assertV4ForkResult({
      type: 'tool/result', seq: 0, surfaceOp: 'append', data: {
        error: { code: 'TOOL_NOT_STARTED', name: 'ToolNotStartedError' },
        message: {
          id: 'forked-tool-result-undefined-0', role: 'tool', toolCallId: 'call-1', isError: true,
          source: null, content: [{ type: 'text', text: 'not started' }],
        },
      },
    }) }).toThrow('invalid V4 not-started fork result')
  })

  it('persists original fork IDs and wording, restores relationships and retains nested inherited cuts', () => {
    const child = fork()
    const original = artifact(child).events
    const before = JSON.stringify(original)
    const physical = codec.encodeHeader(artifact(child).header, child.inheritedEventCount)
    const decoder = codec.createDecoder(physical, 'strict')
    const output = new SessionFormatEventCollector()
    for (const event of original) {
      const row = codec.encodeEvent(event)
      expect(() => { assertV4RowAdmission(row) }).not.toThrow()
      decoder.decodeRow(row, output)
    }
    expect(decoder.finish(output)).toBe(3)
    expect(output.values).toEqual(original)
    expect(restore(output.values).events).toBe(output.values)
    expect(JSON.stringify(original)).toBe(before)
    const result = child.snapshotEvents().find(event => event.type === 'tool/result')!
    expect(result.data.message.id).toBe(`forked-tool-result-read-one-${result.seq}`)
    expect(JSON.stringify(result)).toContain('The parent session may have executed it after the fork point.')
    const nested = Session.create(SessionId('fork-grandchild'), buildForkSeed(child.snapshotEvents(), result.seq), {
      version: 4, id: SessionId('fork-grandchild'), createdAt: 1, delegationDepth: 0, isSeeded: true, parentSession: child.id,
    }, SessionLogOffset(result.seq + 1))
    expect(restoreReleasedV4Artifact(artifact(nested), new Set(original.map(event => event.type)))).toBeDefined()
  })

  it('round trips a pruned fork result while preserving its original message identity', async () => {
    const ctx = new Context()
    try {
      new SessionProjectionRegistry(ctx)
      new TokenMeter(ctx)
      const pruner = new ToolResultPruner(ctx, { thresholdChars: 300, headChars: 100, tailChars: 100 })
      const child = fork()
      const original = child.snapshotEvents().find(event => event.type === 'tool/result')!
      child.append('turn/start', { turn: 2 })
      child.append('step/start', { turn: 2, step: 1 })
      const pruned = pruner.pruneSession(child)
      expect(pruned.pruned).toHaveLength(1)
      child.append('step/end', { turn: 2, step: 1 })
      child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const events = artifact(child).events
      const replacement = events[pruned.pruned[0]!.replacementSeq]!
      expect(replacement.data).toMatchObject({ message: { id: original.data.message.id } })
      expect(replacement.sourceEventSeqs).toEqual([original.seq])
      expect(JSON.stringify(replacement)).toContain('pruned')
      const decoder = codec.createDecoder(codec.encodeHeader(artifact(child).header, child.inheritedEventCount), 'strict')
      const output = new SessionFormatEventCollector()
      for (const event of events) decoder.decodeRow(codec.encodeEvent(event), output)
      expect(decoder.finish(output)).toBe(child.inheritedEventCount)
      expect(output.values).toEqual(events)
      expect(restore(output.values).events).toEqual(events)
      const data = replacement.data as SessionFormatJsonObject
      const message = data['message'] as SessionFormatJsonObject
      const invalid = [
        { ...replacement, sourceEventSeqs: [replacement.seq] },
        { ...replacement, data: { ...data, message: { ...message, id: `forked-tool-result-read-one-${replacement.seq}` } } },
      ]
      for (const changed of invalid) {
        expect(() => restore(events.map(event => event === replacement ? changed : event))).toThrow()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects incomplete persisted result fields through V4 restoration', () => {
    const original = artifact().events
    const result = original.find(event => event.type === 'tool/result')!
    const data = result.data as SessionFormatJsonObject
    const message = data['message'] as SessionFormatJsonObject
    const variants = [
      null,
      { ...data, message: { ...message, source: null } },
    ]
    for (const invalid of variants) {
      const events = original.map(event => event === result ? { ...event, data: invalid } : event)
      expect(() => restore(events)).toThrow()
    }
  })

  it.each([
    ['ID sequence', (row: MutableResult) => { row.data.message.id = 'forked-tool-result-read-one-0' }],
    ['error name', (row: MutableResult) => { row.data.error.name = 'OtherError' }],
    ['call ID', (row: MutableResult) => { row.data.message.toolCallId = 'different' }],
    ['error result', (row: MutableResult) => { row.data.message.isError = false }],
    ['source references', (row: MutableResult) => { row.sourceEventSeqs = [2] }],
    ['content', (row: MutableResult) => { row.data.message.content = [] }],
  ] as const)('rejects malformed fork %s', (_name, mutate) => {
    const events = structuredClone(artifact().events)
    const result = events.find(event => event.type === 'tool/result')!
    mutate(result as unknown as MutableResult)
    expect(() => restore(events)).toThrow()
    expect(() => { assertV4RowAdmission(result) }).toThrow()
  })

})
