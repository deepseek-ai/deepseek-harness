import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SurfaceIntent } from '@deepseek-ai/dsh-session'
import { SystemPromptProjection } from '../src/runtime-context.ts'
import type { SystemPromptCommit, SystemPromptDecisionInput } from '../src/runtime-context.ts'

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const REPLACING: SystemPromptDecisionInput = { inHistory: false, startsSeries: false }
const CONTINUING: SystemPromptDecisionInput = { inHistory: true, startsSeries: false }
const NEW_SERIES: SystemPromptDecisionInput = { inHistory: true, startsSeries: true }

async function sessionStore(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

function appendUser(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function commit(session: Session, turn: number, decision: SystemPromptCommit | undefined) {
  if (decision === undefined) throw new Error('expected a system prompt commit')
  return session.append('system/message', { turn, step: 1, message: decision.message }, decision.intent)
}

function replaceOf(seq: number): SurfaceIntent {
  const at = SessionSeq(seq)
  return { surfaceOp: { op: 'replace', startSeq: at, endSeq: at }, sourceEventSeqs: [at] }
}

describe('SystemPromptProjection', () => {
  it('clears multiblock and nontext system nodes rather than treating them as dormant', async () => {
    const ctx = await sessionStore()
    try {
      const session = ctx.sessions.create(SessionId('system-prompt-multiblock'))
      const base = createSystemMessage('old', SOURCE)
      session.append('system/message', { turn: 1, step: 1, message: {
        ...base, content: [{ type: 'text', text: 'old ' }, { type: 'text', text: 'instructions' }],
      } }, { surfaceOp: 'append' })
      appendUser(session, 'hello')
      session.append('system/message', { turn: 1, step: 1, message: {
        ...createSystemMessage('tail', SOURCE), content: [{ type: 'reasoning', text: 'retained content' }],
      } }, { surfaceOp: 'append' })
      const projection = new SystemPromptProjection(session)
      for (const update of projection.project('', CONTINUING)) commit(session, 2, update)
      expect(session.deriveMessages().map(message => message.role)).toEqual(['user'])
      expect(projection.project('', CONTINUING)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('appends the first rendered prompt, skips an unchanged one, and replaces the retained node on change', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-fresh'))
    const projection = new SystemPromptProjection(session)

    const first = projection.project('v1', REPLACING)[0]
    expect(first?.intent).toEqual({ surfaceOp: 'append' })
    expect(first?.message.role).toBe('system')
    expect(first?.message.source).toEqual({ kind: 'plugin', plugin: SOURCE })
    const head = commit(session, 1, first)
    appendUser(session, 'hello')

    expect(projection.project('v1', REPLACING)[0]).toBeUndefined()
    const second = projection.project('v2', REPLACING)[0]
    expect(second?.intent).toEqual(replaceOf(head.seq))
    const replaced = commit(session, 2, second)
    expect(session.surface.nodes[0]).toBe(replaced.seq)
    expect(projection.project('v2', REPLACING)[0]).toBeUndefined()

    // An emptied prompt keeps the head node with empty content, which projects to no wire message.
    const emptied = projection.project('', REPLACING)[0]
    expect(emptied?.message.content).toEqual([])
    commit(session, 3, emptied)
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user'])
    expect(projection.project('', REPLACING)[0]).toBeUndefined()
    expect(projection.project('v3', REPLACING)[0]?.intent).toMatchObject({ surfaceOp: { op: 'replace' } })
  })

  it('reserves an empty head before user history and replaces it when a prompt appears', async () => {
    const ctx = await sessionStore()
    try {
      const session = ctx.sessions.create(SessionId('system-prompt-empty-head'))
      const projection = new SystemPromptProjection(session)
      const first = projection.project('', REPLACING)[0]
      expect(first?.intent).toEqual({ surfaceOp: 'append' })
      expect(first?.message.content).toEqual([])
      const head = session.append('system/message', { turn: 1, step: 1, message: first!.message }, first!.intent)
      const user = appendUser(session, 'hello')
      expect(session.surface.nodes).toEqual([head.seq, user.seq])
      expect(session.deriveMessages().map(message => message.role)).toEqual(['user'])
      expect(projection.project('', REPLACING)).toEqual([])

      const next = projection.project('Follow this guidance.', REPLACING)[0]
      expect(next?.intent).toEqual({
        surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq },
        sourceEventSeqs: [head.seq],
      })
      const replacement = session.append('system/message', { turn: 2, step: 1, message: next!.message }, next!.intent)
      expect(session.surface.nodes).toEqual([replacement.seq, user.seq])
      expect(session.deriveMessages()).toEqual([next!.message, user.data])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads the surviving system node from the log, including one restored as "no prompt"', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-replay'))
    const stale = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('stale', SOURCE) }, { surfaceOp: 'append' })
    appendUser(session, 'hello')
    const current = session.append('system/message', { turn: 2, step: 1, message: createSystemMessage('current', SOURCE) }, replaceOf(stale.seq))

    const projection = new SystemPromptProjection(session)
    expect(projection.project('current', REPLACING)[0]).toBeUndefined()
    expect(projection.project('next', REPLACING)[0]?.intent).toEqual(replaceOf(current.seq))

    const emptySession = ctx.sessions.create(SessionId('system-prompt-empty-replay'))
    const empty = emptySession.append('system/message', { turn: 1, step: 1, message: createSystemMessage('', SOURCE) }, { surfaceOp: 'append' })
    appendUser(emptySession, 'hello')
    const emptyProjection = new SystemPromptProjection(emptySession)
    expect(emptyProjection.project('', REPLACING)[0]).toBeUndefined()
    expect(emptyProjection.project('now present', REPLACING)[0]?.intent).toEqual(replaceOf(empty.seq))
  })

  it('appends again after a replacement shadowed a system node that was not the head', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-shadowed'))
    const projection = new SystemPromptProjection(session)
    appendUser(session, 'before any prompt')
    const late = projection.project('late prompt', REPLACING)[0]
    expect(late?.intent).toEqual({ surfaceOp: 'append' })
    const node = commit(session, 1, late)
    expect(session.surface.nodes.indexOf(node.seq)).toBe(1)
    expect(projection.project('late prompt', REPLACING)[0]).toBeUndefined()

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), replaceOf(node.seq))
    expect(projection.project('late prompt', REPLACING)[0]?.intent).toEqual({ surfaceOp: 'append' })
  })

  it('appends a changed prompt after cached history on an in-history route while the series continues', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-in-history'))
    const projection = new SystemPromptProjection(session)
    const head = commit(session, 1, projection.project('v1', CONTINUING)[0])
    appendUser(session, 'hello')

    expect(projection.project('v1', CONTINUING)[0]).toBeUndefined()
    const update = projection.project('v2', CONTINUING)[0]
    expect(update?.intent).toEqual({ surfaceOp: 'append' })
    const appended = commit(session, 2, update)
    expect(session.surface.nodes).toEqual([head.seq, expect.any(Number), appended.seq])
    expect(session.deriveMessages().map(message => message.role)).toEqual(['system', 'user', 'system'])
    expect(projection.project('v2', CONTINUING)[0]).toBeUndefined()

    // The effective prompt is the latest surviving node: a further change compares against it.
    appendUser(session, 'more')
    const third = projection.project('v3', CONTINUING)[0]
    expect(third?.intent).toEqual({ surfaceOp: 'append' })
    commit(session, 3, third)
    expect(session.deriveMessages().flatMap(message => message.role === 'system' ? [message.content[0]] : []))
      .toEqual([{ type: 'text', text: 'v1' }, { type: 'text', text: 'v2' }, { type: 'text', text: 'v3' }])
  })

  it('re-baselines node 0 and empties later active nodes at a series start', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-series-start'))
    const projection = new SystemPromptProjection(session)
    const head = commit(session, 1, projection.project('v1', CONTINUING)[0])
    appendUser(session, 'hello')

    // A new series already costs the cache, so the change folds into node 0.
    const rebased = projection.project('v2', NEW_SERIES)[0]
    expect(rebased?.intent).toEqual(replaceOf(head.seq))
    const newHead = commit(session, 2, rebased)
    expect(session.surface.nodes[0]).toBe(newHead.seq)

    appendUser(session, 'again')
    const later = commit(session, 3, projection.project('v3', CONTINUING)[0])
    const updates = projection.project('v4', NEW_SERIES)
    expect(updates.map(update => update.intent)).toEqual([replaceOf(later.seq), replaceOf(newHead.seq)])
    for (const update of updates) commit(session, 4, update)
    expect(session.deriveMessages().filter(message => message.role === 'system').map(message => message.content))
      .toEqual([[{ type: 'text', text: 'v4' }]])
    expect(projection.project('v4', CONTINUING)).toEqual([])
  })

  it('empties all active nodes when clearing an in-history prompt', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-in-history-clear'))
    const projection = new SystemPromptProjection(session)
    commit(session, 1, projection.project('v1', CONTINUING)[0])
    appendUser(session, 'hello')
    const update = commit(session, 2, projection.project('v2', CONTINUING)[0])

    const cleared = projection.project('', CONTINUING)
    expect(cleared).toHaveLength(2)
    expect(cleared[0]?.intent).toEqual(replaceOf(update.seq))
    for (const empty of cleared) {
      expect(empty.message.content).toEqual([])
      commit(session, 3, empty)
    }
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user'])
    expect(projection.project('', CONTINUING)).toEqual([])
    expect(projection.project('v3', REPLACING).map(commit => commit.message.content)).toEqual([[{ type: 'text', text: 'v3' }]])
  })
})
