import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { createUserMessage, ToolCallId, createMessage, createToolResultMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, TOOL_NOT_STARTED } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  const fiber = await ctx.plugin(SessionInvariant)
  return { ctx, fiber }
}

describe('session-log invariants', () => {
  it('keeps registration global when the companion is mounted under a scope', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    let scopedCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => {
      scopedCtx = createScope(inner, {}).ctx
    }, { inject: ['sessions', 'invariants'] }))
    await scopedCtx.plugin(SessionInvariant)
    const session = ctx.sessions.create(SessionId('global-under-scoped-invariants'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('accepts a well-formed turn, step, and tool sequence', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } })
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{}' }],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'echo', arguments: '{}' })
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c1'),
          content: [],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('does not advance committed trace state when a later dispatch listener vetoes', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('dispatch-veto-rollback'))
    let veto = true
    ctx.on('internal/dispatch', (_mode, name) => {
      if (name !== 'session/event' || !veto) return
      veto = false
      throw new Error('later dispatch veto')
    })
    expect(() => session.append('turn/start', {
      turn: 1,
    })).toThrow('later dispatch veto')
    expect(session.snapshotEvents()).toEqual([])
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('applies the committed transition after another postcommit observer throws', async () => {
    const { ctx } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const session = ctx.sessions.create(SessionId('postcommit-peer'))
    ctx.on('session/event', () => { throw new Error('hostile observer') }, { prepend: true })
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
    expect(warnings).toHaveLength(2)
  })

  it('rejects non-monotonic event sequence numbers', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    ctx.emit(scopeTarget(session, undefined), 'session/event', session, {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    } as never)
    expect(() => { ctx.emit(scopeTarget(session, undefined), 'session/event', session, {
      type: 'turn/end',
      seq: 0,
      time: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never) }).toThrow(/seq must strictly increase/)
  })

  it('enforces turn numbering and core execution enclosure', async () => {
    const first = await setup()
    const open = first.ctx.sessions.create()
    open.append('turn/start', { turn: 1 })
    expect(() => open.append('turn/start', { turn: 2 }))
      .toThrow(/turn 1 is still open/)
    expect(() => open.append('turn/end', { turn: 2, reason: { kind: 'completed' } }))
      .toThrow(/does not match open turn 1/)

    const second = (await setup()).ctx.sessions.create()
    second.append('turn/start', { turn: 1 })
    second.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => second.append('turn/start', { turn: 3 }))
      .toThrow(/expected turn 2, got 3/)

    const third = (await setup()).ctx.sessions.create()
    third.append('turn/start', { turn: 1 })
    third.append('step/start', { turn: 1, step: 1 })
    third.append('step/end', { turn: 1, step: 1 })
    expect(() => third.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      .not.toThrow()

    const enclosed = (await setup()).ctx.sessions.create()
    enclosed.append('turn/start', { turn: 1 })
    enclosed.append('step/start', { turn: 1, step: 1 })
    expect(() => enclosed.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock' } },
      reason: 'initial',
    } as never)).not.toThrow()
    expect(() => enclosed.append('request/context', {
      provider: 'mock', model: 'mock',
    })).not.toThrow()

    const outside = (await setup()).ctx.sessions.create()
    expect(() => outside.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'idle context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: 'append' })).not.toThrow()
    // Route capacity is core execution state like the header beside it.
    expect(() => outside.append('request/context', {
      provider: 'mock',
      model: 'm',
      contextWindow: 128_000,
    })).toThrow(/outside any open turn/)
    // The owning plugin decides whether a merge-extensible event is log-only.
    const appendUnknown = outside.append.bind(outside) as (type: string, data: unknown) => unknown
    expect(() => { appendUnknown('plugin/marker', {}) }).not.toThrow()
    expect(() => outside.append('turn/start', {
      turn: 1,
    })).not.toThrow()
  })

  it('enforces open-step identity and numbering', async () => {
    const wrongTurn = (await setup()).ctx.sessions.create()
    wrongTurn.append('turn/start', { turn: 1 })
    expect(() => wrongTurn.append('step/start', { turn: 2, step: 1 })).toThrow(/open turn is 1/)

    const nested = (await setup()).ctx.sessions.create()
    nested.append('turn/start', { turn: 1 })
    nested.append('step/start', { turn: 1, step: 1 })
    expect(() => nested.append('step/start', { turn: 1, step: 2 })).toThrow(/while step 1 is still open/)
    expect(() => nested.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      .toThrow(/while step 1 is still open/)
    expect(() => nested.append('step/end', { turn: 1, step: 2 })).toThrow(/open is turn 1\/step 1/)
    expect(() => nested.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })).toThrow(/open is turn 1\/step 1/)

    const skipped = (await setup()).ctx.sessions.create()
    skipped.append('turn/start', { turn: 1 })
    skipped.append('step/start', { turn: 1, step: 1 })
    skipped.append('step/end', { turn: 1, step: 1 })
    expect(() => skipped.append('step/start', { turn: 1, step: 3 }))
      .toThrow(/expected step 2 in turn 1, got 3/)

    expect(() => skipped.append('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    })).not.toThrow()
  })

  it('requires step-scoped stream and tool events to name the open step', async () => {
    const chunk = (await setup()).ctx.sessions.create()
    chunk.append('turn/start', { turn: 1 })
    expect(() => chunk.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x' },
    })).toThrow(/open is turn 1\/step null/)

    const tool = (await setup()).ctx.sessions.create()
    tool.append('turn/start', { turn: 1 })
    tool.append('step/start', { turn: 1, step: 1 })
    expect(() => tool.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('ghost'),
        content: [],
        isError: false,
      }),
    }, { surfaceOp: 'append' })).toThrow(/no prior tool\/call/)
  })

  it('keeps fresh tool-result appends open-step checked', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    expect(() => session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('closed'),
        content: [],
        isError: false,
      }),
    }, { surfaceOp: 'append' })).toThrow(/open is turn 1\/step null/)
  })

  it('treats a validated tool-result replacement as a turn-enclosed rewrite', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('rewrite'),
      name: 'echo',
      arguments: '{}',
    })
    const original = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('rewrite'),
        content: [{ type: 'text', text: 'original' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    session.append('turn/start', { turn: 2 })
    expect(() => session.append('tool/result', {
      ...original.data,
      message: freezeMessage({
        ...original.data.message,
        content: [{
          ...original.data.message.content[0],
          content: [{ type: 'text', text: 'pruned' }],
        }] satisfies typeof original.data.message.content,
      }),
    }, {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })).not.toThrow()
  })

  it('rejects a tool-result replacement outside a turn', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('rewrite'),
      name: 'echo',
      arguments: '{}',
    })
    const original = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('rewrite'),
        content: [{ type: 'text', text: 'original' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(() => session.append('tool/result', {
      ...original.data,
      message: freezeMessage({
        ...original.data.message,
        content: [{
          ...original.data.message.content[0],
          content: [{ type: 'text', text: 'pruned' }],
        }] satisfies typeof original.data.message.content,
      }),
    }, {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })).toThrow(/outside any open turn/)
  })

  it('allows not-started repair results and unresolved calls at step end', async () => {
    const repaired = (await setup()).ctx.sessions.create()
    expect(() => {
      repaired.append('turn/start', { turn: 1 })
      repaired.append('step/start', { turn: 1, step: 1 })
      repaired.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('crashed'),
          content: [],
          isError: true,
        }),
        error: { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      }, { surfaceOp: 'append' })
      repaired.append('step/end', { turn: 1, step: 1 })
      repaired.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    }).not.toThrow()

    const unresolved = (await setup()).ctx.sessions.create()
    expect(() => {
      unresolved.append('turn/start', { turn: 1 })
      unresolved.append('step/start', { turn: 1, step: 1 })
      unresolved.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'echo', arguments: '{}' })
      unresolved.append('step/end', { turn: 1, step: 1 })
      unresolved.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
    }).not.toThrow()
  })

  it('does not let a result in a later step satisfy an earlier call', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'echo', arguments: '{}' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    expect(() => session.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [],
        isError: false,
      }),
    }, { surfaceOp: 'append' })).toThrow(/no prior tool\/call in this step/)
  })

  it('replays seeded sessions and tracks each session independently', async () => {
    const { ctx } = await setup()
    const badSeed = [
      { type: 'turn/start' as const, seq: 0, time: 0, data: { turn: 1 } },
      { type: 'turn/start' as const, seq: 1, time: 0, data: { turn: 2 } },
    ]
    expect(() => ctx.sessions.create(undefined, { seed: badSeed })).toThrow(InvariantError)

    const a = ctx.sessions.create(SessionId('a'))
    const b = ctx.sessions.create(SessionId('b'))
    a.append('turn/start', { turn: 1 })
    expect(() => b.append('turn/start', { turn: 1 }))
      .not.toThrow()
  })

  it('rebuilds trace state for sessions that exist when the companion reloads', async () => {
    const { ctx, fiber } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    await fiber.dispose()
    await ctx.plugin(SessionInvariant)
    expect(() => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'h' },
    })).not.toThrow()
    expect(() => session.append('turn/start', { turn: 2 }))
      .toThrow(/turn 1 is still open/)
  })

  it('accepts end-seed whether or not a turn is open', async () => {
    const { ctx } = await setup()
    // Balanced seed: between turns.
    expect(() => ctx.sessions.create(SessionId('inherited-between-turns'), { seed: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] })).not.toThrow()
    // Unbalanced seed: inside the open turn, which the relation permits.
    const open = ctx.sessions.create(SessionId('inherited-inside-open-turn'), { seed: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ] })
    expect(open.snapshotEvents().map(event => event.type)).toEqual(['turn/start', 'session/end-seed'])
    // Still open afterwards: the boundary moves no cursor.
    expect(() => open.append('turn/start', { turn: 2 }))
      .toThrow(/turn 1 is still open/)
    expect(() => open.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).not.toThrow()
  })

  it('removes all listeners when the companion is disposed', async () => {
    const { ctx, fiber } = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    await fiber.dispose()
    expect(() => session.append('turn/start', {
      turn: 2,
    })).not.toThrow()
  })
})
