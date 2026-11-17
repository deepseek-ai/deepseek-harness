import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamModePane, TeamModeToggle, type TeamModePaneInjected } from '../src/client/TeamModeToggle.tsx'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamBoard, TeamProgress } from '../src/client/TeamBoard.tsx'
import { TeamCommandRow } from '../src/client/TeamCommandRow.tsx'
import { TeamDisableConfirmation, type TeamDisableConfirmationInjected } from '../src/client/TeamDisableConfirmation.tsx'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const collapseHeader = ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.panel.section': { kind: 'list', scope: 'session' },
      'conversation.session.panel.section.actions': { kind: 'keyed', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = () => ctx.slots.entries('conversation.session.panel.section')
    .find(candidate => candidate.component === TeamBoard)
  const progress = () => ctx.slots.entries('conversation.session.panel.section.actions')
    .find(candidate => candidate.component === TeamProgress)
  return { ctx, fiber, entry, progress, collapseHeader }
}

describe('task-board browser plugin', () => {
  it('registers a disposable shared tasks section with its progress, without navigation or Team Remote services', async () => {
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale'])
    expect(b.entry()).toMatchObject({
      options: { id: 'shared-tasks', order: 250 },
      locale: 'agent-team',
    })
    expect(b.entry()!.inject).toBeUndefined()
    expect(resolveSlotLabel(b.entry()!.options.label)).toBe('Shared tasks')
    expect(b.progress()).toMatchObject({ options: { key: 'shared-tasks' }, locale: 'agent-team' })
    expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const t = b.ctx.locale.bind('agent-team')
    expect(t('tasks')).toBe('Shared tasks')
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.progress()).toBeUndefined()
    expect(t('empty')).toBe('empty')
  })

  it('re-registers when the section slot is declared again', async () => {
    const b = await bench()
    expect(b.entry()).toBeDefined()
    b.collapseHeader()
    expect(b.entry()).toBeUndefined()
    b.ctx.slots.register({
      name: 'root',
      children: {
        'conversation.session.panel.section': { kind: 'list', scope: 'session' },
        'conversation.session.panel.section.actions': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)
    await Promise.resolve()
    expect(b.entry()).toBeDefined()
    await b.fiber.dispose()
  })

  it('registers the summary and settings pane when Agent Teams arrives and reports each execution outcome', async () => {
    const b = await bench()
    b.ctx.slots.register({
      name: 'conversation.input.model',
      children: {
        'conversation.input.model.options': { kind: 'list', scope: 'session' },
        'conversation.input.model.pane': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)
    const entry = () => b.ctx.slots.entries('conversation.input.model.options')
      .find(candidate => candidate.component === TeamModeToggle)
    const page = () => b.ctx.slots.entries('conversation.input.model.pane')
      .find(candidate => candidate.component === TeamModePane)
    expect(entry()).toBeUndefined()
    expect(page()).toBeUndefined()
    const setEnabled = vi.fn<Context['remote']['agentTeams']['setEnabled']>()
    new TestRemote(b.ctx, { agentTeams: { setEnabled } })
    await vi.waitFor(() => { expect(entry()).toBeDefined(); expect(page()).toBeDefined() })
    expect(entry()).toMatchObject({ options: { id: 'agent-team' }, locale: 'agent-team' })
    expect(entry()!.inject).toBeUndefined()
    expect(page()).toMatchObject({ options: { key: 'agent-team' }, locale: 'agent-team' })
    const injected = page()!.inject as (sessionId: SessionId) => Record<string, unknown>
    const value: object = injected(brandString<SessionId>('chosen-session'))
    const mode = value as TeamModePaneInjected
    setEnabled.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(mode.selectTeamMode(true)).resolves.toBeNull()
    expect(setEnabled).toHaveBeenLastCalledWith('chosen-session', true)
    setEnabled.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(mode.selectTeamMode(false)).resolves.toBeNull()
    expect(setEnabled).toHaveBeenLastCalledWith('chosen-session', false)
    setEnabled.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'connection failed', {}) })
    await expect(mode.selectTeamMode(true)).resolves.toBe('connection failed')
    const overlayEntry = () => b.ctx.slots.entries('shell.overlay').find(candidate => candidate.component === TeamDisableConfirmation)
    const overlayValue: object = overlayEntry()!.inject!()
    const overlay = overlayValue as TeamDisableConfirmationInjected
    const request = overlay.hooks.disableRequest
    expect(request.getSnapshot()).toBeNull()
    const beforeConfirmation = setEnabled.mock.calls.length
    mode.requestDisableConfirmation()
    expect(request.getSnapshot()).toEqual({ sessionId: 'chosen-session' })
    expect(setEnabled).toHaveBeenCalledTimes(beforeConfirmation)
    overlay.cancelDisable(brandString<SessionId>('other-session'))
    expect(request.getSnapshot()).toEqual({ sessionId: 'chosen-session' })
    setEnabled.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(overlay.disableTeam(brandString<SessionId>('chosen-session'))).resolves.toBeNull()
    expect(setEnabled).toHaveBeenLastCalledWith('chosen-session', false)
    overlay.cancelDisable(brandString<SessionId>('chosen-session'))
    expect(request.getSnapshot()).toBeNull()
    mode.requestDisableConfirmation()
    await b.fiber.dispose()
    expect(entry()).toBeUndefined()
    expect(page()).toBeUndefined()
    expect(overlayEntry()).toBeUndefined()
    expect(request.getSnapshot()).toBeNull()
  })

  it('binds Team command receipts to the command slot lifetime without Remote services', async () => {
    const b = await bench()
    const entry = () => b.ctx.slots.entries('conversation.chat.commandview').find(value => value.component === TeamCommandRow)
    expect(entry()).toBeUndefined()
    b.collapseHeader()
    const registerParent = () => b.ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
    } as never, () => null)
    const collapse = registerParent()
    await vi.waitFor(() => { expect(entry()).toBeDefined() })
    expect(entry()).toMatchObject({ options: { key: 'team' }, locale: 'agent-team' })
    expect(entry()!.inject).toBeUndefined()
    collapse()
    expect(entry()).toBeUndefined()
    registerParent()
    await vi.waitFor(() => { expect(entry()).toBeDefined() })
    await b.fiber.dispose()
    expect(entry()).toBeUndefined()
  })

  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
