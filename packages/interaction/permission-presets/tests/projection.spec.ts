/**
 * The `permissions` projection unit and the `/permission` command: mounting
 * the permission service beside the projection registry serves the whole
 * select (table options + effective current value, `custom` appended exactly
 * while derived) folded from permission events over the composition defaults;
 * the command child registers `/permission` whose handler switches
 * through `permission.set` (bare invocation reports, unknown names error);
 * compositions without either registry are unaffected; unmounting the
 * service removes the key (HMR safety).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import type { Config } from '@deepseek-ai/dsh-permission-presets'
import ApprovalService from '@deepseek-ai/dsh-user-approval'

async function harness(options: { withPermission?: boolean; config?: Config } = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  await ctx.plugin(ApprovalService)
  if (options.withPermission !== false) await ctx.plugin(PermissionPresetService, options.config ?? {})
  return { ctx, session: ctx.sessions.create(SessionId('perm-projected')) }
}

/** Mint a scoped agent over a live session (the command executor's addressing shape). */
async function agentFor(ctx: Context, session: Session) {
  const inject = vi.fn<Agent['inject']>()
  const agent = { id: session.id, session, inject } as unknown as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return { agent, inject }
}

describe('permissions projection unit', () => {
  it('serves the pinned new-session default select', async () => {
    const { ctx, session } = await harness()
    const value = ctx.sessionProjections.snapshot(session).values.permissions
    expect(value).toMatchObject({ currentValue: 'workspace-write' })
    expect(value?.options.map(option => option.value)).toEqual(['workspace-write', 'danger-full-access'])
  })

  it('folds the knob events and notifies the change feed per knob append', async () => {
    const { ctx, session } = await harness()
    const changes: { key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      changes.push({ key, value, seq })
    })
    ctx.permissionPresets.set(session, 'danger-full-access')
    const permissionChanges = changes.filter(change => change.key === 'permissions')
    expect(permissionChanges).toHaveLength(3)
    expect(permissionChanges.at(-1)).toMatchObject({ key: 'permissions', value: { currentValue: 'danger-full-access' } })
    session.append('turn/start', { turn: 1 })
    expect(changes).toHaveLength(3)
  })

  it('appends custom as a current-only option when the knobs match no preset', async () => {
    const { ctx, session } = await harness()
    session.append('sandbox/mode', { mode: 'read-only' })
    const value = ctx.sessionProjections.snapshot(session).values.permissions
    expect(value?.currentValue).toBe('custom')
    expect(value?.options.at(-1)).toMatchObject({ value: 'custom', name: 'Custom' })
  })

  it('has no permissions key without the service, and drops it on unload (HMR safety)', async () => {
    const { ctx, session } = await harness({ withPermission: false })
    expect('permissions' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(PermissionPresetService, {})
    expect(ctx.sessionProjections.snapshot(session).values.permissions)
      .toMatchObject({ currentValue: 'workspace-write' })
    await fiber.dispose()
    expect('permissions' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })
})

describe('/permission command', () => {
  it('switches through permission.set and logs the lifecycle pair', async () => {
    const { ctx, session } = await harness()
    const { agent, inject } = await agentFor(ctx, session)
    const execution = await ctx.commands.execute(agent, '/permission danger-full-access', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'preset danger-full-access' })
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      content: [{
        type: 'text',
        text: 'The approval policy changed from "ask" to "never" (changed by the user).',
      }],
    })
    const run = session.snapshotEvents().find(event => event.type === 'command/run')
    expect(run?.data).toMatchObject({ name: 'permission', args: ' danger-full-access' })
  })

  it('reports the current preset and the table on bare invocation', async () => {
    const { ctx, session } = await harness()
    const { agent } = await agentFor(ctx, session)
    const execution = await ctx.commands.execute(agent, '/permission', [], new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'success',
      text: 'current preset workspace-write (available: workspace-write, danger-full-access)',
    })
    expect(session.snapshotEvents().filter(event => event.type === 'permission/preset')).toHaveLength(1)
  })

  it('rejects an unknown preset without touching the log', async () => {
    const { ctx, session } = await harness()
    const { agent } = await agentFor(ctx, session)
    const before = session.snapshotEvents().filter(event =>
      event.type !== 'command/run' && event.type !== 'command/done')
    const execution = await ctx.commands.execute(agent, '/permission yolo', [], new AbortController().signal)
    // The error text carries the same no-self-labelling rule as the success
    // texts: `permission · unknown preset "yolo" (…)`, not `unknown permission
    // preset`, which the row's own title already says.
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'unknown preset "yolo" (available: workspace-write, danger-full-access)',
    })
    expect(session.snapshotEvents().filter(event =>
      event.type !== 'command/run' && event.type !== 'command/done')).toEqual(before)
  })
})
