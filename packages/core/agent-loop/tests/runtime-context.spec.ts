import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeContextProjection } from '../src/runtime-context.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test-compaction': { kind: 'test-compaction' } & ContextFormed
  }
}

const SOURCE = 'runtime-context'

function contextMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE },
  })
}

describe('RuntimeContextProjection', () => {
  it('restores the latest visible owned snapshot and ignores other sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('runtime-context-replay'))
    const retained = session.append('user/message', contextMessage('retained'), { surfaceOp: 'append' })
    const shadowed = session.append('user/message', contextMessage('shadowed'), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })

    const projection = new RuntimeContextProjection(ctx, session)
    expect(session.surface.nodes).toContain(retained.seq)
    expect(projection.project('retained', [])).toBeUndefined()
    expect(projection.project('next', [{ name: 'sandbox:policy', text: 'policy' }])?.source).toEqual({
      kind: SOURCE,
      form: 'snapshot',
      sections: [{ name: 'sandbox:policy', text: 'policy' }],
    })

    const other = ctx.sessions.create(SessionId('runtime-context-other'))
    other.append('user/message', contextMessage('other'), { surfaceOp: 'append' })
    expect(projection.project('retained', [])).toBeUndefined()
  })
})
