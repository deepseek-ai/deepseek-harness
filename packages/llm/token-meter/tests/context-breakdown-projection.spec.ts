// contextBreakdown projection: heuristic system/tools/message composition,
// plus the shared estimator's pricing branches.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ContextBreakdownProjection } from '@deepseek-ai/dsh-token-meter/client'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { contextBreakdownProjectionDefinition } from '../src/breakdown-projection.ts'
import {
  estimateContent,
  estimateHeader,
  estimateMessage,
  estimateSystemTokens,
  estimateToolsTokens,
} from '../src/estimate.ts'

const CONFIG = { provider: 'test', model: 'test-model' }

const TOOLS: ToolSchema[] = [{
  name: 'bash',
  description: 'run a command',
  parameters: { type: 'object', properties: {} },
}]

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

const projected = (ctx: Context, session: Session): ContextBreakdownProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.contextBreakdown
  if (value === undefined) throw new Error('contextBreakdown projection is not registered')
  return value
}

function appendUser(session: Session, text: string): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/**
 * Meter one upcoming replacement the way compaction-basic does: price the
 * replaced span from the measurement service's own nodes and log the
 * shadow-price event directly before the replace.
 */
function appendSummaryMeter(ctx: Context, session: Session, start: SessionSeqType, end: SessionSeqType): void {
  const nodes = ctx.tokenMeter.measure(session).nodes
  const startIdx = nodes.findIndex(node => node.seq === start)
  const endIdx = nodes.findIndex(node => node.seq === end)
  const shadowed = nodes.slice(startIdx, endIdx + 1)
  session.append('compaction/summary', {
    compactionId: CompactionId('context-breakdown-summary'),
    summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start, end },
    shadowedSeqs: shadowed.map(node => node.seq),
    shadowedTokenCount: shadowed.reduce((total, node) => total + node.tokens, 0),
    provider: 'mock',
    model: 'mock',
  })
}

describe('contextBreakdown session projection', () => {
  it('serves zeros for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('prices the newest envelope last-wins and pushes no change for a restated one', async () => {
    const { ctx, session } = await harness()
    session.append('request/header', {
      header: { config: CONFIG, system: 'You are terse.', tools: TOOLS },
      reason: 'initial',
    })
    expect(projected(ctx, session)).toEqual({
      systemTokens: estimateSystemTokens({ config: CONFIG, system: 'You are terse.' }),
      toolsTokens: estimateToolsTokens({ config: CONFIG, tools: TOOLS }),
      messageTokens: 0,
    })

    const changed: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => { changed.push(key) })
    session.append('request/header', {
      header: { config: CONFIG, system: 'You are terse.', tools: TOOLS },
      reason: 'change',
    })
    session.append('session/end-seed', {})
    expect(changed).not.toContain('contextBreakdown')

    // A system-less, tool-less envelope prices back to zero.
    session.append('request/header', { header: { config: CONFIG }, reason: 'change' })
    expect(projected(ctx, session)).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('sums surface appends and skips an empty-content assistant message', async () => {
    const { ctx, session } = await harness()
    appendUser(session, 'abcd')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 9, outputTokens: 0 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('step/end', { turn: 1, step: 1 })
    // 'abcd' prices to 9 (1 text + 4 block + 4 role); the usage-only assistant
    // message derives to no transcript entry and adds nothing.
    expect(projected(ctx, session).messageTokens).toBe(9)
  })

  it('shrinks the message figure when a metered replacement compacts the surface', async () => {
    const { ctx, session } = await harness()
    const first = appendUser(session, 'before compaction, a longer message')
    const second = appendUser(session, 'and a second entry')
    const summary = createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    appendSummaryMeter(ctx, session, first, second)
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', start: first, end: second },
      sourceEventSeqs: [first, second],
    })
    expect(projected(ctx, session).messageTokens).toBe(estimateMessage(summary))
  })

  it('keeps the message figure equal to the service result across appends and a compaction', async () => {
    const { ctx, session } = await harness()
    // The panel's composition rows and `measure()` answer the same question in
    // the same vocabulary; one shared fold is what makes that true.
    const agree = (): number => {
      const messageTokens = projected(ctx, session).messageTokens
      expect(messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
      return messageTokens
    }
    session.append('request/header', {
      header: { config: CONFIG, system: 'You are terse.', tools: TOOLS },
      reason: 'initial',
    })
    expect(agree()).toBe(0)

    const question = appendUser(session, 'a first question, long enough to price above zero')
    session.append('step/start', { turn: 1, step: 1 })
    const answer = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a considered answer' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 40, outputTokens: 7 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] }).seq
    session.append('step/end', { turn: 1, step: 1 })
    const grown = agree()
    expect(grown).toBeGreaterThan(0)

    appendSummaryMeter(ctx, session, question, answer)
    // The armed shadow price must not move the published figure by itself.
    expect(agree()).toBe(grown)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: question, end: answer },
      sourceEventSeqs: [question, answer],
    })
    expect(agree()).toBeLessThan(grown)
  })

  it('folds a replacement without a claim at zero and fails on a mismatched claim', () => {
    const definition = contextBreakdownProjectionDefinition
    const replace = (start: SessionSeq, end: SessionSeq): SessionEvent => ({
      type: 'user/message',
      seq: SessionSeq(9),
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [start, end],
    } as unknown as SessionEvent)
    const append = (seq: SessionSeq): SessionEvent => ({
      type: 'user/message',
      seq,
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    } as unknown as SessionEvent)
    const meter = (start: SessionSeq, end: SessionSeq, seq: SessionSeq): SessionEvent => ({
      type: 'compaction/prune',
      seq,
      time: 0,
      data: {
        shadowedRange: { start, end },
        shadowedSeqs: [start, end],
        shadowedTokenCount: 5,
      },
    } as unknown as SessionEvent)
    let state = definition.init()
    state = definition.apply(state, append(SessionSeq(1)))
    state = definition.apply(state, append(SessionSeq(3)))
    // No metering event: the replacement contributes zero instead of throwing.
    expect(definition.wire.view(definition.apply(state, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens)
    // An adjacent claim for another range contradicts the replacement.
    const mismatched = definition.apply(state, meter(SessionSeq(1), SessionSeq(1), SessionSeq(8)))
    expect(() => definition.apply(mismatched, replace(SessionSeq(1), SessionSeq(3))))
      .toThrow('no adjacent shadow price')
    // A claim expires after one intervening event, so replacement delta is zero.
    let expired = definition.apply(state, meter(SessionSeq(1), SessionSeq(3), SessionSeq(8)))
    expired = definition.apply(expired, {
      type: 'session/end-seed', seq: SessionSeq(9), time: 0, data: {},
    })
    expect(definition.wire.view(definition.apply(expired, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens)
    // The armed claim prices exactly the next event's matching replacement.
    const armed = definition.apply(state, meter(SessionSeq(1), SessionSeq(3), SessionSeq(8)))
    expect(definition.wire.view(definition.apply(armed, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens - 5 + estimateMessage(
        createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      ))
  })

  it('keeps the persisted checkpoint O(1) as the surface grows and compacts', async () => {
    const { ctx, session } = await harness()
    const first = appendUser(session, 'the first of many messages')
    for (let index = 0; index < 24; index += 1) appendUser(session, `message number ${index} with some text`)
    const last = appendUser(session, 'the last message before compaction')
    const stateKeys = (): string[] => {
      const row = ctx.sessionProjections.checkpoint(session)['contextBreakdown']
      if (row === undefined) throw new Error('contextBreakdown checkpoint row is missing')
      return Object.keys(row.val as Record<string, unknown>).sort()
    }
    // Growth adds no per-node bookkeeping to the durable state.
    expect(stateKeys()).toEqual(['messageTokens', 'systemTokens', 'toolsTokens'])
    const shadowed = session.surface.nodes.slice(
      session.surface.nodes.indexOf(first),
      session.surface.nodes.indexOf(last) + 1,
    )
    appendSummaryMeter(ctx, session, first, last)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: first, end: last },
      sourceEventSeqs: [...shadowed],
    })
    expect(stateKeys()).toEqual(['messageTokens', 'systemTokens', 'toolsTokens'])
    expect(projected(ctx, session).messageTokens)
      .toBe(ctx.tokenMeter.measure(session).surfaceTokens)
  })

  it('restores from a JSON checkpoint and unregisters with the token-meter fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    const session = ctx.sessions.create()
    session.append('request/header', {
      header: { config: CONFIG, system: 'You are terse.' },
      reason: 'initial',
    })
    appendUser(session, 'abcd')
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('contextBreakdown')

    await ctx.plugin(TokenMeter)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextBreakdown).toEqual({
      systemTokens: estimateSystemTokens({ config: CONFIG, system: 'You are terse.' }),
      toolsTokens: 0,
      messageTokens: 9,
    })
  })
})

describe('shared estimator', () => {
  it('prices every content-block shape under the fixed heuristic', () => {
    expect(estimateContent([{ type: 'text', text: 'abcd' }])).toBe(5)
    expect(estimateContent([{ type: 'reasoning', text: 'abcdefgh' }] as ContentBlock[])).toBe(6)
    expect(estimateContent([{ type: 'tool-call', id: 'c' as never, name: 'bash', arguments: '{"a":1}' }])).toBe(7)
    expect(estimateContent([{
      type: 'tool-result', toolCallId: 'c' as never,
      content: [{ type: 'text', text: 'abcd' }],
    }])).toBe(9)
    const unknown = { type: 'mystery', payload: 'abc' } as unknown as ContentBlock
    expect(estimateContent([unknown])).toBe(4 + Math.ceil(JSON.stringify(unknown).length / 4))
  })

  it('prices envelope parts independently and absent parts to zero', () => {
    expect(estimateSystemTokens(undefined)).toBe(0)
    expect(estimateSystemTokens({ config: CONFIG })).toBe(0)
    expect(estimateSystemTokens({ config: CONFIG, system: 'abcdefgh' })).toBe(6)
    expect(estimateToolsTokens(undefined)).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: [] })).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: TOOLS }))
      .toBe(Math.ceil(JSON.stringify(TOOLS).length / 4) + 4)
    expect(estimateHeader(undefined)).toBe(0)
    expect(estimateHeader({ config: CONFIG, system: 'abcdefgh', tools: TOOLS }))
      .toBe(6 + Math.ceil(JSON.stringify(TOOLS).length / 4) + 4)
  })
})
