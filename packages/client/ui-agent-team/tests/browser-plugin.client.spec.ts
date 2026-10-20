import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamModeToggle, type TeamModeToggleInjected } from '../src/client/TeamModeToggle.tsx'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamBoard } from '../src/client/TeamBoard.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const collapseHeader = ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions.subagent.footer': { kind: 'list', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = () => ctx.slots.entries('conversation.session.header.actions.subagent.footer')
    .find(candidate => candidate.component === TeamBoard)
  return { ctx, fiber, entry, collapseHeader }
}

describe('task-board browser plugin', () => {
  it('registers a disposable root task-board section without navigation or Team Remote services', async () => {
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale'])
    expect(b.entry()).toMatchObject({
      options: { id: 'agent-team' },
      locale: 'agent-team',
    })
    expect(b.entry()!.inject).toBeUndefined()
    expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const t = b.ctx.locale.bind('agent-team')
    expect(t('trigger')).toBe('Task board')
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(t('empty')).toBe('empty')
  })

  it('re-registers when the conversation header slot is declared again', async () => {
    const b = await bench()
    expect(b.entry()).toBeDefined()
    b.collapseHeader()
    expect(b.entry()).toBeUndefined()
    b.ctx.slots.register({
      name: 'root',
      children: { 'conversation.session.header.actions.subagent.footer': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(b.entry()).toBeDefined()
    await b.fiber.dispose()
  })

  it('registers the mode switch when Commands arrives and reports each execution outcome', async () => {
    const b = await bench()
    b.ctx.slots.register({
      name: 'conversation.input.model',
      children: { 'conversation.input.model.options': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    const entry = () => b.ctx.slots.entries('conversation.input.model.options')
      .find(candidate => candidate.component === TeamModeToggle)
    expect(entry()).toBeUndefined()
    const execute = vi.fn<Context['remote']['commands']['execute']>()
    new TestRemote(b.ctx, { commands: { execute } })
    await vi.waitFor(() => { expect(entry()).toBeDefined() })
    const injected = entry()!.inject as (sessionId: SessionId) => Record<string, unknown>
    const value: object = injected(SessionId('chosen-session'))
    const mode = value as TeamModeToggleInjected
    execute.mockResolvedValueOnce({ ok: true, value: { commandId: CommandId('team-mode'), result: { kind: 'success', text: 'saved' } } })
    await expect(mode.selectTeamMode(true)).resolves.toBeNull()
    expect(execute).toHaveBeenLastCalledWith('chosen-session', '/team on', [])
    execute.mockResolvedValueOnce({ ok: true, value: { commandId: CommandId('team-mode'), result: { kind: 'error', text: 'root required' } } })
    await expect(mode.selectTeamMode(false)).resolves.toBe('root required')
    expect(execute).toHaveBeenLastCalledWith('chosen-session', '/team off', [])
    execute.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(mode.selectTeamMode(true)).resolves.toBe(b.ctx.locale.bind('agent-team')('mode.unavailable'))
    execute.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'connection failed', {}) })
    await expect(mode.selectTeamMode(true)).resolves.toBe('connection failed')
    await b.fiber.dispose()
    expect(entry()).toBeUndefined()
  })

  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
