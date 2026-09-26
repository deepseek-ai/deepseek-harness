// contextBreakdown projection: heuristic system/tools/message composition,
// plus the shared estimator's pricing branches.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ContextBreakdownProjection } from '@deepseek-ai/dsh-token-meter/client'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { contextBreakdownProjectionDefinition } from '../src/breakdown-projection.ts'
import {
  estimateContent,
  estimateMessage,
  estimateSystemMessage,
  estimateToolsTokens,
} from '../src/estimate.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const CONFIG = { provider: 'test', model: 'test-model' }

const TOOLS: ToolSchema[] = [{
  name: 'bash',
  description: 'run a command',
  parameters: { type: 'object', properties: {} },
}]

const SYSTEM_SOURCE = { kind: 'system-prompt' } as const

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  contexts.push(ctx)
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

/** Append the rendered system prompt as surface node 0, the way the loop does before the first user message. */
function appendSystem(session: Session, text: string): SessionSeqType {
  return session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage(text),
  }, { surfaceOp: 'append' }).seq
}

/** Replace the system node in place, the way the loop does when the rendered prompt changes. */
function replaceSystem(session: Session, node: SessionSeqType, text: string): SessionSeqType {
  return session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage(text),
  }, { surfaceOp: { op: 'replace', startSeq: node, endSeq: node }, sourceEventSeqs: [node] }).seq
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

  it('prices the system node and the newest envelope last-wins and pushes no change for a restated envelope', async () => {
    const { ctx, session } = await harness()
    const systemNode = appendSystem(session, 'You are terse.')
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'initial',
    })
    // 'You are terse.' prices to 8 (4 text + 4 role): the same figure the
    // request envelope's former system field priced to.
    expect(projected(ctx, session)).toEqual({
      systemTokens: 8,
      toolsTokens: estimateToolsTokens({ config: CONFIG, tools: TOOLS }),
      messageTokens: 0,
    })

    const changed: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => { changed.push(key) })
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'change',
    })
    session.append('session/end-seed', {})
    expect(changed).not.toContain('contextBreakdown')

    // A tool-less envelope prices the tools figure back to zero and leaves
    // the system node's figure alone.
    session.append('request/header', { header: { config: CONFIG }, reason: 'change' })
    expect(projected(ctx, session)).toEqual({ systemTokens: 8, toolsTokens: 0, messageTokens: 0 })

    // Replacing node 0 follows the new prompt; an empty prompt records none.
    const longer = replaceSystem(session, systemNode, 'You are terse and answer in one line.')
    expect(projected(ctx, session).systemTokens).toBe(Math.ceil('You are terse and answer in one line.'.length / 4) + 4)
    replaceSystem(session, longer, '')
    expect(projected(ctx, session)).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('keeps the system node out of the message figure across appends and a system replacement', async () => {
    const { ctx, session } = await harness()
    const systemNode = appendSystem(session, 'You are terse.')
    appendUser(session, 'abcd')
    expect(projected(ctx, session)).toMatchObject({ systemTokens: 8, messageTokens: 9 })
    replaceSystem(session, systemNode, 'You are verbose and thorough.')
    expect(projected(ctx, session)).toMatchObject({
      systemTokens: Math.ceil('You are verbose and thorough.'.length / 4) + 4,
      messageTokens: 9,
    })
    // The service prices the same system node identically, so the two
    // figures partition its surface total.
    const { systemTokens, messageTokens } = projected(ctx, session)
    expect(systemTokens + messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
  })

  it('moves a superseded in-history prompt into the message figure and subtracts it with a compaction', async () => {
    const { ctx, session } = await harness()
    const agree = (): ContextBreakdownProjection => {
      const projection = projected(ctx, session)
      expect(projection.systemTokens + projection.messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
      return projection
    }
    appendSystem(session, 'You are terse.')
    const question = appendUser(session, 'abcd')
    expect(agree()).toMatchObject({ systemTokens: 8, messageTokens: 9 })

    // An in-history route appends the changed prompt; node 0 stays model-visible history.
    const verbose = 'You are verbose and thorough.'
    const superseded = appendSystem(session, verbose)
    expect(agree()).toMatchObject({ systemTokens: Math.ceil(verbose.length / 4) + 4, messageTokens: 9 + 8 })
    const followUp = appendUser(session, 'efgh')
    appendSystem(session, 'You are terse once more.')
    expect(agree()).toMatchObject({
      systemTokens: Math.ceil('You are terse once more.'.length / 4) + 4,
      messageTokens: 9 + 8 + 9 + Math.ceil(verbose.length / 4) + 4,
    })

    // Compacting the span that holds the superseded mid-history prompt shrinks the message figure by it.
    appendSummaryMeter(ctx, session, question, followUp)
    const summary = createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'test' },
    })
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', startSeq: question, endSeq: followUp },
      sourceEventSeqs: [question, superseded, followUp],
    })
    expect(agree().messageTokens).toBe(8 + estimateMessage(summary))
  })

  it('restores the surviving head when compaction removes the newest large prompt', async () => {
    const { ctx, session } = await harness()
    appendSystem(session, 'head')
    const question = appendUser(session, 'abcd')
    const newest = appendSystem(session, 'x'.repeat(4000))
    appendSummaryMeter(ctx, session, question, newest)
    const summary = createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } })
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', startSeq: question, endSeq: newest },
      sourceEventSeqs: [question, newest],
    })
    expect(projected(ctx, session)).toEqual({ systemTokens: 5, toolsTokens: 0, messageTokens: estimateMessage(summary) })
    expect(projected(ctx, session).systemTokens + projected(ctx, session).messageTokens)
      .toBe(ctx.tokenMeter.measure(session).nodes.reduce((sum, node) => sum + node.heuristicTokens, 0))
  })

  it('sums surface appends and skips an empty-content assistant message', async () => {
    const { ctx, session } = await harness()
    appendUser(session, 'abcd')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 9, outputTokens: 0 },
    }, { surfaceOp: 'append' })
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
      source: { kind: 'test' },
    })
    appendSummaryMeter(ctx, session, first, second)
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: second },
      sourceEventSeqs: [first, second],
    })
    expect(projected(ctx, session).messageTokens).toBe(estimateMessage(summary))
  })

  it('keeps the message figure equal to the service result across appends and a compaction', async () => {
    const { ctx, session } = await harness()
    // The panel's composition rows and `measure()` answer the same question in
    // the same vocabulary; one shared fold is what makes that true.
    const agree = (): number => {
      const { systemTokens, messageTokens } = projected(ctx, session)
      expect(systemTokens + messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
      return messageTokens
    }
    appendSystem(session, 'You are terse.')
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'initial',
    })
    expect(agree()).toBe(0)

    const question = appendUser(session, 'a first question, long enough to price above zero')
    session.append('step/start', { turn: 1, step: 1 })
    const answer = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a considered answer' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 40, outputTokens: 7 },
    }, { surfaceOp: 'append' }).seq
    session.append('step/end', { turn: 1, step: 1 })
    const grown = agree()
    expect(grown).toBeGreaterThan(0)

    appendSummaryMeter(ctx, session, question, answer)
    // The armed shadow price must not move the published figure by itself.
    expect(agree()).toBe(grown)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: question, endSeq: answer },
      sourceEventSeqs: [question, answer],
    })
    expect(agree()).toBeLessThan(grown)
  })

  it('prices unmetered replacements and rejects absent ranges without mutating prior state', async () => {
    const { session } = await harness()
    const first = appendUser(session, 'first message')
    const last = appendUser(session, 'last message')
    const definition = contextBreakdownProjectionDefinition
    const state = session.snapshotEvents().reduce(definition.apply, definition.init())
    const before = JSON.stringify(state)
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: [first, last] })
    expect(definition.wire.view(definition.apply(state, replacement)).messageTokens).toBe(10)
    expect(JSON.stringify(state)).toBe(before)
    const invalid = { ...replacement, surfaceOp: { op: 'replace', startSeq: SessionSeq(999), endSeq: last } } as SessionEvent
    expect(() => definition.apply(state, invalid)).toThrow('invalid current range')
    expect(JSON.stringify(state)).toBe(before)
  })

  it('classifies the last nonempty system by position despite rewrites and extra source citations', async () => {
    const { ctx, session } = await harness()
    let head = appendSystem(session, 'head')
    let question = appendUser(session, 'question')
    const middle = appendSystem(session, 'middle prompt')
    const tail = appendSystem(session, 'last prompt in surface order')
    head = replaceSystem(session, head, 'head rewritten at a newer event seq')
    const agree = (text: string): void => {
      const view = projected(ctx, session)
      expect(view.systemTokens).toBe(estimateSystemMessage(createSystemMessage(text)))
      expect(view.messageTokens).toBeGreaterThanOrEqual(0)
      expect(view.systemTokens + view.messageTokens)
        .toBe(ctx.tokenMeter.measure(session).nodes.reduce((total, node) => total + node.heuristicTokens, 0))
    }
    agree('last prompt in surface order')
    question = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'rewritten question' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: question, endSeq: question }, sourceEventSeqs: [question] }).seq
    expect(question).toBeGreaterThan(middle)
    // Source-event references can cite a surviving prompt outside the replaced span.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'middle summary' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: question, endSeq: middle }, sourceEventSeqs: [question, middle, tail] })
    agree('last prompt in surface order')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tail summary' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: tail, endSeq: tail }, sourceEventSeqs: [tail, head] })
    agree('head rewritten at a newer event seq')
    const repeated = appendSystem(session, 'head rewritten at a newer event seq')
    agree('head rewritten at a newer event seq')
    replaceSystem(session, repeated, '')
    agree('head rewritten at a newer event seq')
    replaceSystem(session, head, '')
    agree('')
  })

  it('ignores dormant empty system tails across per-node clearing and head fallback', async () => {
    const { ctx, session } = await harness()
    let head = appendSystem(session, 'head')
    appendUser(session, 'question')
    const middle = appendSystem(session, 'middle')
    const tail = appendSystem(session, 'tail')
    appendSystem(session, '')
    expect(projected(ctx, session).systemTokens).toBe(5)
    replaceSystem(session, tail, '')
    expect(projected(ctx, session).systemTokens).toBe(6)
    replaceSystem(session, middle, '')
    expect(projected(ctx, session)).toMatchObject({ systemTokens: 5, messageTokens: 10 })
    head = replaceSystem(session, head, 'fallback head')
    expect(projected(ctx, session)).toMatchObject({ systemTokens: 8, messageTokens: 10 })
    replaceSystem(session, head, '')
    expect(projected(ctx, session)).toMatchObject({ systemTokens: 0, messageTokens: 10 })
  })

  it('retains only compact current surface entries as history grows and compacts', async () => {
    const { ctx, session } = await harness()
    const first = appendUser(session, 'the first of many messages')
    for (let index = 0; index < 24; index += 1) appendUser(session, `message number ${index} with some text`)
    const last = appendUser(session, 'the last message before compaction')
    const state = () => {
      const current = ctx.sessionProjections.stateOf(session, 'contextBreakdown')
      if (current === undefined) throw new Error('registered context breakdown has no state')
      return current
    }
    expect(state().nodes).toHaveLength(26)
    expect(Object.keys(state().nodes[0]!).sort()).toEqual(['heuristicTokens', 'seq', 'system'])
    const shadowed = [...session.surface.nodes]
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'test' },
    }), { surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: shadowed })
    expect(state().nodes).toHaveLength(1)
    expect(projected(ctx, session).messageTokens).toBe(10)
  })

  it('retains wire identity when a same-price rewrite changes only checkpoint positions', async () => {
    const { session } = await harness()
    const head = appendSystem(session, 'head')
    const definition = contextBreakdownProjectionDefinition
    const state = session.snapshotEvents().reduce(definition.apply, definition.init())
    replaceSystem(session, head, 'same')
    const next = definition.apply(state, session.snapshotEvents().at(-1)!)
    expect(next).not.toBe(state)
    expect(definition.wire.view(next)).toBe(definition.wire.view(state))
    expect(state.nodes[0]?.seq).toBe(head)
  })

  it('replays late registration, resumes a compact checkpoint, and discards scalar version 2', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create()
    appendSystem(session, 'head')
    const first = appendUser(session, 'question')
    const last = appendSystem(session, 'x'.repeat(4000))
    await ctx.plugin(TokenMeter)
    expect(projected(ctx, session)).toMatchObject({ systemTokens: 1004, messageTokens: 15 })
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>
    const row = checkpoint['contextBreakdown']!
    expect(row.ver).toBe(5)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextBreakdown).toEqual(projected(ctx, session))
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: [first, last] })
    const restored = ctx.sessionProjections.restore(
      checkpoint, [replacement], SessionLogOffset(replacement.seq), session.header, session.inheritedEventCount,
    )
    expect(restored.snapshot.values.contextBreakdown).toEqual({ systemTokens: 5, toolsTokens: 0, messageTokens: 10 })
    const stale = { ...checkpoint, contextBreakdown: { ...row, ver: 2, val: { systemTokens: 1004, toolsTokens: 0, messageTokens: -989 } } }
    expect(ctx.sessionProjections.viewCheckpoint(stale).contextBreakdown).toBeUndefined()
    expect(ctx.sessionProjections.restoreFloor(stale)).toBe(0)
    expect(() => ctx.sessionProjections.restore(
      stale, [replacement], SessionLogOffset(replacement.seq), session.header, session.inheritedEventCount,
    )).toThrow('re-read from seq 0')
    const replayed = ctx.sessionProjections.restore(
      stale, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount,
    )
    expect(replayed.snapshot.values.contextBreakdown).toEqual(projected(ctx, session))
    expect(replayed.checkpoint['contextBreakdown']?.ver).toBe(5)
    const invalid = {
      ...checkpoint,
      contextBreakdown: {
        ...row,
        val: { nodes: [{ seq: 0, heuristicTokens: -1, system: true }], breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } },
      },
    }
    expect(() => ctx.sessionProjections.restore(
      invalid, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount,
    )).toThrow()
  })

  it('discards lower-layer version-3 scalar caches and refolds the full surface', async () => {
    const { ctx, session } = await harness()
    try {
      appendSystem(session, 'You are terse.')
      session.append('request/header', { header: { config: CONFIG, tools: TOOLS }, reason: 'initial' })
      appendUser(session, 'abcd')
      const current = ctx.sessionProjections.checkpoint(session)
      const staleValue = { systemTokens: 0, toolsTokens: estimateToolsTokens({ config: CONFIG, tools: TOOLS }), messageTokens: 17 }
      const checkpoint = {
        ...current,
        contextBreakdown: { ver: 3, seq: SessionSeq(session.seq - 1), val: staleValue },
      }
      expect.soft(ctx.sessionProjections.viewCheckpoint(checkpoint)).not.toHaveProperty('contextBreakdown')
      expect.soft(ctx.sessionProjections.restoreFloor(checkpoint)).toBe(0)
      const restored = ctx.sessionProjections.restore(
        checkpoint, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount,
      )
      expect(restored.snapshot.values.contextBreakdown).toEqual({
        systemTokens: 8, toolsTokens: staleValue.toolsTokens, messageTokens: 9,
      })
      expect(restored.checkpoint).toEqual(current)
      expect(restored.checkpoint['contextBreakdown']?.ver).toBe(5)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores from a JSON checkpoint and unregisters with the token-meter fiber', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    const session = ctx.sessions.create()
    appendSystem(session, 'You are terse.')
    appendUser(session, 'abcd')
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('contextBreakdown')

    await ctx.plugin(TokenMeter)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextBreakdown).toEqual({
      systemTokens: 8,
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
    expect(estimateContent([{ type: 'text', text: 'abcd' }])).toBe(5)
    const unknown = { type: 'mystery', payload: 'abc' } as unknown as ContentBlock
    expect(estimateContent([unknown])).toBe(4 + Math.ceil(JSON.stringify(unknown).length / 4))
  })

  it('prices the system node without block overhead and an empty prompt to zero', () => {
    expect(estimateSystemMessage(createSystemMessage(''))).toBe(0)
    expect(estimateSystemMessage(createSystemMessage('abcdefgh'))).toBe(6)
    // estimateMessage routes the system role to the same figure.
    expect(estimateMessage(createSystemMessage('abcdefgh'))).toBe(6)
    // A non-text block in a system message keeps a conservative JSON price.
    const image = { type: 'image', attachment: { attachmentId: 'a' } } as unknown as ContentBlock
    expect(estimateSystemMessage(createMessage({
      role: 'system',
      content: [{ type: 'text', text: 'abcd' }, image],
      source: SYSTEM_SOURCE,
    }))).toBe(Math.ceil((4 + JSON.stringify(image).length) / 4) + 4)
  })

  it('prices the envelope tool schemas and absent tools to zero', () => {
    expect(estimateToolsTokens(undefined)).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: [] })).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: TOOLS }))
      .toBe(Math.ceil(JSON.stringify(TOOLS).length / 4) + 4)
  })
})
