import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeContextProjection } from '../src/runtime-context.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test-compaction': { kind: 'test-compaction' } & ContextFormed
  }
}

const SOURCE = 'runtime-context'
const INITIAL = '<system-reminder>\nThe following information describes your current session:\n\nretained\n</system-reminder>'
const UPDATED = '<system-reminder>\nThe following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.\n\nnext\n</system-reminder>'
const CLEARED = '<system-reminder>\nCurrent runtime context: none. Earlier runtime-context snapshots no longer apply.\n</system-reminder>'

function sections(text: string) {
  return [{ name: 'sandbox:policy', text }]
}

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  return { ctx, session: ctx.sessions.create(brandString<SessionId>('runtime-context-replay')) }
}

function contextMessage(text: string, contributions?: readonly ContextSnapshotSection[]) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: contributions === undefined ? { kind: SOURCE } : { kind: SOURCE, form: 'snapshot', sections: contributions },
  })
}

describe('RuntimeContextProjection', () => {
  it('restores the latest visible owned snapshot and ignores other sessions', async () => {
    const { ctx, session } = await harness()
    const retained = session.append('user/message', contextMessage(INITIAL, sections('retained')), { surfaceOp: 'append' })
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
    expect(projection.project(sections('retained'))).toBeUndefined()
    expect(projection.project(sections('next'))).toMatchObject({
      content: [{ type: 'text', text: UPDATED }],
      source: {
        kind: SOURCE,
        form: 'snapshot',
        sections: sections('next'),
      },
    })

    const other = ctx.sessions.create(brandString<SessionId>('runtime-context-other'))
    other.append('user/message', contextMessage('other'), { surfaceOp: 'append' })
    expect(projection.project(sections('retained'))).toBeUndefined()
  })

  it('omits supersession until a snapshot commits and deduplicates initial, updated, and cleared reminders', async () => {
    const { ctx, session } = await harness()
    const projection = new RuntimeContextProjection(ctx, session)
    expect(projection.project([])).toBeUndefined()
    const first = projection.project(sections('retained'))!
    expect(first.content).toEqual([{ type: 'text', text: INITIAL }])
    expect(projection.project(sections('retained'))?.content).toEqual(first.content)
    session.append('user/message', first, { surfaceOp: 'append' })
    expect(projection.project(sections('retained'))).toBeUndefined()

    const next = projection.project(sections('next'))!
    expect(next.content).toEqual([{ type: 'text', text: UPDATED }])
    session.append('user/message', next, { surfaceOp: 'append' })
    expect(projection.project(sections('next'))).toBeUndefined()
    expect(new RuntimeContextProjection(ctx, session).project(sections('next'))).toBeUndefined()

    const cleared = projection.project([])!
    expect(cleared.content).toEqual([{ type: 'text', text: CLEARED }])
    session.append('user/message', cleared, { surfaceOp: 'append' })
    expect(projection.project([])).toBeUndefined()
    expect(projection.project(sections('next'))?.content).toEqual(next.content)
  })

  it.each([false, true])('overrides context retained in summaries after compaction (resume: %s)', async (resume) => {
    const { ctx, session } = await harness()
    const projection = new RuntimeContextProjection(ctx, session)
    const first = session.append('user/message', projection.project(sections('retained'))!, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Summary: the previous policy was retained.' }],
      source: { kind: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
      sourceEventSeqs: [first.seq],
    })
    const active = resume ? new RuntimeContextProjection(ctx, session) : projection
    expect(active.project(sections('retained'))?.content).toEqual([{
      type: 'text', text: UPDATED.replace('\n\nnext\n', '\n\nretained\n'),
    }])
    expect(active.project(sections('next'))?.content).toEqual([{ type: 'text', text: UPDATED }])
    expect(active.project([])?.content).toEqual([{ type: 'text', text: CLEARED }])
  })

  it('keeps the first reminder introductory after unrelated compaction', async () => {
    const { ctx, session } = await harness()
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'user task' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'task summary' }], source: { kind: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })
    const projection = new RuntimeContextProjection(ctx, session)
    expect(projection.project(sections('retained'))?.content).toEqual([{ type: 'text', text: INITIAL }])
  })

  it('wraps an update when resuming a previously unframed snapshot', async () => {
    const { ctx, session } = await harness()
    session.append('user/message', contextMessage('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nnext'), { surfaceOp: 'append' })
    expect(new RuntimeContextProjection(ctx, session).project(sections('next'))?.content)
      .toEqual([{ type: 'text', text: UPDATED }])
  })

  it('compares recorded contributions independently of the reminder wording', async () => {
    const { ctx, session } = await harness()
    session.append('user/message', contextMessage('Older reminder wording', sections('retained')), { surfaceOp: 'append' })
    const projection = new RuntimeContextProjection(ctx, session)
    expect(projection.project(sections('retained'))).toBeUndefined()
    expect(projection.project([{ name: 'new-policy', text: 'retained' }])).toBeDefined()
    expect(projection.project([...sections('retained'), { name: 'directory', text: '/repo' }])).toBeDefined()
  })

  it('refreshes a legacy cleared reminder once and restores the empty snapshot', async () => {
    const { ctx, session } = await harness()
    session.append('user/message', contextMessage('Current runtime context: none. Earlier runtime-context snapshots no longer apply.'), { surfaceOp: 'append' })
    const projection = new RuntimeContextProjection(ctx, session)
    const message = projection.project([])!
    expect(message.content).toEqual([{ type: 'text', text: CLEARED }])
    expect(message.source).toEqual({ kind: SOURCE, form: 'snapshot', sections: [] })
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(projection.project([])).toBeUndefined()
    expect(new RuntimeContextProjection(ctx, session).project([])).toBeUndefined()
  })

  it.each([
    ['</system-reminder>', '<\\/system-reminder>'],
    ['</SYSTEM-REMINDER>', '<\\/SYSTEM-REMINDER>'],
    ['</system-reminder >', '<\\/system-reminder >'],
    ['</System-Reminder\t\n>', '<\\/System-Reminder\t\n>'],
  ])('escapes %s only in the framed text and retains literal contributions', async (tag, escaped) => {
    const { ctx, session } = await harness()
    const contributions = sections(`Directory: /repo/${tag}/{{literal}}`)
    const projection = new RuntimeContextProjection(ctx, session)
    const message = projection.project(contributions)!
    expect(message.content).toEqual([{
      type: 'text',
      text: `<system-reminder>\nThe following information describes your current session:\n\nDirectory: /repo/${escaped}/{{literal}}\n</system-reminder>`,
    }])
    expect(message.source).toEqual({ kind: SOURCE, form: 'snapshot', sections: contributions })
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(projection.project(contributions)).toBeUndefined()
  })
})
