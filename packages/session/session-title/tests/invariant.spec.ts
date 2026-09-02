// Title-source invariant: `messageSeqs` is empty iff `source.kind` is `user`.
// — the durable relationship every appended session/title event must keep.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as SessionTitleInvariantCompanion from '@deepseek-ai/dsh-session-title/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SessionTitleInvariantCompanion)
  return ctx
}

describe('session-title source invariant', () => {
  it('accepts cited automatic titles and citation-free user renames', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('title-invariant-valid'))
    const source = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'title me' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => {
      session.append('session/title', { title: 'auto', messageSeqs: [source.seq], source: { kind: 'fallback' } })
      session.append('session/title', { title: 'named', messageSeqs: [], source: { kind: 'user' } })
    }).not.toThrow()
  })

  it('rejects a citation-free automatic title and a user rename that cites messages', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('title-invariant-invalid'))
    const source = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'title me' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => {
      session.append('session/title', { title: 'auto', messageSeqs: [], source: { kind: 'fallback' } })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session-title',
    }))
    expect(() => {
      session.append('session/title', { title: 'named', messageSeqs: [source.seq], source: { kind: 'user' } })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session-title',
    }))
    expect(session.seq).toBe(1)
  })

  it('requires automatic-title citations to name distinct earlier human messages', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('title-invariant-sources'))
    const boundary = session.append('turn/start', { turn: 1 })
    expect(() => session.append('session/title', {
      title: 'wrong source', messageSeqs: [boundary.seq], source: { kind: 'fallback' },
    })).toThrow(/must name an earlier human user\/message/)
    expect(() => session.append('session/title', {
      title: 'future source', messageSeqs: [SessionSeq(session.seq)], source: { kind: 'fallback' },
    })).toThrow(/must name an earlier human user\/message/)
    expect(() => session.append('session/title', {
      title: 'malformed source', messageSeqs: [-1 as never], source: { kind: 'fallback' },
    })).toThrow(/invalid message seq/)
    const pluginMessage = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plugin context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: 'append' })
    expect(() => session.append('session/title', {
      title: 'plugin source', messageSeqs: [pluginMessage.seq], source: { kind: 'fallback' },
    })).toThrow(/must name an earlier human user\/message/)
    const source = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'title me' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => session.append('session/title', {
      title: 'duplicate source', messageSeqs: [source.seq, source.seq], source: { kind: 'fallback' },
    })).toThrow(/repeats message seq/)
  })

  it('validates title relations when the companion loads after a Session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('title-invariant-existing'))
    const boundary = session.append('turn/start', { turn: 1 })
    session.append('session/title', {
      title: 'wrong source', messageSeqs: [boundary.seq], source: { kind: 'fallback' },
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SessionTitleInvariantCompanion).then(() => undefined))
      .rejects.toThrow(/must name an earlier human user\/message/)
  })
})
