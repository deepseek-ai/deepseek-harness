import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as CommandInvariant from '@deepseek-ai/dsh-commands/invariant'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { CommandId } from '@deepseek-ai/dsh-commands'

async function mount(installCompanion = true): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('commands-invariant'))
  await ctx.plugin(InvariantRegistry, { enabled: true })
  if (installCompanion) await ctx.plugin(CommandInvariant)
  return { ctx, session }
}

function appendRun(session: Session, id: string): void {
  session.append('command/run', {
    commandId: CommandId(id),
    name: 'linked',
    args: '',
    source: { kind: 'user' },
  })
}

describe('command lifecycle invariants', () => {
  it('accepts a success outcome linked to an earlier non-command domain event', async () => {
    const { session } = await mount()
    const source = session.append('turn/start', { turn: 1 })
    appendRun(session, 'cmd-valid')

    expect(() => {
      session.append('command/done', {
        commandId: CommandId('cmd-valid'),
        kind: 'success',
        sourceEventSeq: source.seq,
      })
    }).not.toThrow()
  })

  it.each([-1, 1.5, 1])('rejects invalid or non-prior sourceEventSeq %s', async (sourceEventSeq) => {
    const { session } = await mount()
    appendRun(session, 'cmd-invalid')

    expect(() => {
      session.append('command/done', {
        commandId: CommandId('cmd-invalid'),
        kind: 'success',
        sourceEventSeq: sourceEventSeq as never,
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-commands',
    }))
  })

  it('rejects an error settlement carrying a success-only source reference', async () => {
    const { session } = await mount()
    const source = session.append('turn/start', { turn: 1 })
    appendRun(session, 'cmd-error-source')

    expect(() => {
      session.append('command/done', {
        commandId: CommandId('cmd-error-source'),
        kind: 'error',
        text: 'failed',
        sourceEventSeq: source.seq,
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-commands',
    }))
  })

  it('attributes an invalid durable prefix during late companion loading', async () => {
    const { ctx, session } = await mount(false)
    appendRun(session, 'cmd-late')
    session.append('command/done', {
      commandId: CommandId('cmd-late'),
      kind: 'success',
      sourceEventSeq: SessionSeq(0),
    })

    await expect(ctx.plugin(CommandInvariant)).rejects.toMatchObject({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-commands',
    })
  })
})
