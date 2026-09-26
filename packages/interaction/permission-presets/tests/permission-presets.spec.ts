import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, {
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import PermissionPresetService, {
  AUTO_PRESET, CUSTOM_PRESET,
} from '@deepseek-ai/dsh-permission-presets'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const configurations = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()

async function mounted(options: {
  config?: NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>
  bashDefault?: SandboxMode | undefined
  approvalDefault?: ApprovalPolicy | undefined
  projection?: boolean
} = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (options.projection !== false) await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', {
    sandboxMode: 'bashDefault' in options ? options.bashDefault : 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  ctx.provide('approval', { config: { policy: 'approvalDefault' in options ? options.approvalDefault : 'ask' } })
  await ctx.plugin(PermissionPresetService, options.config ?? {})
  return ctx
}

function freshSession(id: string): Session {
  return Session.create(SessionId(id))
}

async function mountAuto(ctx: Context, admit: () => void = () => {}) {
  return ctx.plugin(Object.assign((pluginCtx: Context) => {
    pluginCtx.permissionPresets.registerAuto(admit)
  }, { inject: ['permissionPresets'] }))
}

async function mountedStore(options: { approvalDefault?: ApprovalPolicy | undefined } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  ctx.provide('approval', {
    config: { policy: 'approvalDefault' in options ? options.approvalDefault : 'ask' },
  })
  configurations.set(ctx, await liveConfig(ctx, PermissionPresetService))
  return ctx
}

describe('permission preset fold', () => {
  it('folds the latest preset selection and steps over unrelated events', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-fold')
    const presetOf = () => ctx.sessionProjections.stateOf(session, 'permissions')?.preset ?? null
    expect(presetOf()).toBeNull()
    session.append('permission/preset', { preset: 'danger-full-access' })
    session.append('permission/preset', { preset: 'workspace-write' })
    expect(presetOf()).toBe('workspace-write')
    // The knob fold steps over non-preset events to the latest selection.
    session.append('sandbox/mode', { mode: 'read-only' })
    expect(presetOf()).toBe('workspace-write')

    const seeded = Session.create(SessionId('sess-fold-seeded'), [])
    expect(ctx.sessionProjections.stateOf(seeded, 'permissions')?.seeded).toBe(true)
  })
})

describe('PermissionPresetService', () => {
  it('does not activate without the required projection registry', async () => {
    const ctx = await mounted({ projection: false })
    expect(ctx.get('permissionPresets')).toBeUndefined()
  })

  it('fails when the permissions projection key is absent', async () => {
    const ctx = await mounted()
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)
    expect(() => ctx.permissionPresets.current(freshSession('missing-permission-projection-key')))
      .toThrow('permission: permissions session projection is not registered')
  })

  it('advertises the preset table in declaration order and resolves bundles', async () => {
    const ctx = await mounted()
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access'])
    expect(ctx.permissionPresets.resolve('danger-full-access')).toMatchObject({ sandbox: 'danger-full-access', approval: 'never' })
    expect(() => ctx.permissionPresets.resolve('plan')).toThrow(/unknown preset "plan"/)
  })

  it('publishes an effect-scoped current-session preset and removes it on unload', async () => {
    const ctx = await mounted()
    const fiber = await mountAuto(ctx)
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access', AUTO_PRESET])
    expect(ctx.permissionPresets.resolve(AUTO_PRESET)).toEqual({
      sandbox: 'danger-full-access', approval: 'ask',
    })
    expect(ctx.permissionPresets.optionOf(AUTO_PRESET)).toEqual({
      value: AUTO_PRESET,
      name: AUTO_PRESET,
    })

    await fiber.dispose()
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access'])
    expect(() => ctx.permissionPresets.resolve(AUTO_PRESET)).toThrow(/unknown preset "auto"/)
  })

  it('rejects a duplicate Auto integration', async () => {
    const ctx = await mounted()
    ctx.permissionPresets.registerAuto(() => {})
    expect(() => ctx.permissionPresets.registerAuto(() => {}))
      .toThrow(/already registered/)
  })

  it('runs Auto admission before any write, including a no-op selection', async () => {
    const ctx = await mounted()
    let admissions = 0
    await mountAuto(ctx, () => { admissions += 1 })
    const session = freshSession('sess-auto-admit')

    ctx.permissionPresets.set(session, AUTO_PRESET)
    expect(admissions).toBe(1)
    expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: AUTO_PRESET }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe(AUTO_PRESET)

    ctx.permissionPresets.set(session, AUTO_PRESET)
    expect(admissions).toBe(2)
    expect(session.snapshotEvents()).toHaveLength(2)
  })

  it('leaves the session untouched when dynamic admission rejects a selection', async () => {
    const ctx = await mounted()
    await mountAuto(ctx, () => {
      throw new Error('auto review is closing')
    })
    const session = freshSession('sess-auto-closed')
    expect(() => {
      ctx.permissionPresets.set(session, AUTO_PRESET)
    }).toThrow(/closing/)
    expect(session.snapshotEvents()).toEqual([])
  })

  it('switches between Auto and Full access through identity and approval policy', async () => {
    const config = { presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    } } satisfies NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>
    const ctx = await mounted({ config })
    await mountAuto(ctx)
    const session = freshSession('shared-bundle-switch')
    ctx.permissionPresets.set(session, AUTO_PRESET)
    const baselineLength = session.snapshotEvents().length

    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(session.snapshotEvents().slice(baselineLength).map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')

    ctx.permissionPresets.set(session, AUTO_PRESET)
    expect(session.snapshotEvents().slice(baselineLength + 2).map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: AUTO_PRESET }],
      ['approval/policy', { policy: 'ask' }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe(AUTO_PRESET)

    session.append('approval/policy', { policy: 'never' })
    expect(ctx.permissionPresets.current(session)).toBe(AUTO_PRESET)
  })

  it('current() derives from the effective knobs: composition defaults hit workspace-write, a switch hits its preset', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-current')
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
  })

  it('a knob state matching no table entry derives custom — a state, not an error', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-custom')
    session.append('sandbox/mode', { mode: 'read-only' })
    expect(ctx.permissionPresets.current(session)).toBe(CUSTOM_PRESET)
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
    expect(() => ctx.permissionPresets.resolve(CUSTOM_PRESET)).toThrow(/unknown preset/)
  })

  it('composition defaults outside the table still derive custom when an explicit new-session default is configured', async () => {
    const ctx = await mounted({
      approvalDefault: 'never',
      config: { defaultPreset: 'workspace-write' },
    })
    const session = freshSession('sess-defaults-custom')
    expect(ctx.permissionPresets.current(session)).toBe(CUSTOM_PRESET)
  })

  it('the fold breaks bundle ties; a stale fold no longer matching falls back to table order', async () => {
    const ctx = await mounted({ config: { presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      agentish: { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    } } })
    const session = freshSession('sess-tie')
    ctx.permissionPresets.set(session, 'agentish')
    expect(ctx.permissionPresets.current(session)).toBe('agentish')
    session.append('approval/policy', { policy: 'never' })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
  })

  it('set() writes through: one preset event plus both knob events', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-set')
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(session.snapshotEvents().map(e => [e.type, e.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
  })

  it('set() to the current preset is a no-op when the knobs already match (clicks are not switches)', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-noop')
    ctx.permissionPresets.set(session, 'workspace-write')
    expect(session.snapshotEvents()).toHaveLength(0)
  })

  it('re-asserting a preset from a drifted (custom) state re-records the choice and repairs the knob', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-drift')
    ctx.permissionPresets.set(session, 'danger-full-access')
    // Re-selecting from a drifted state records the choice and repairs only
    // the changed knob.
    session.append('sandbox/mode', { mode: 'read-only' })
    ctx.permissionPresets.set(session, 'danger-full-access')
    const tail = session.snapshotEvents().slice(4)
    expect(tail.map(e => [e.type, e.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
    ])
  })

  it('rejects composition over a non-confining executor at load', async () => {
    await expect(mounted({ bashDefault: undefined }))
      .rejects.toThrow(/does not confine/)
  })

  it('optionOf() presents shipped labels/descriptions, falls back to the raw key, and fixes custom', async () => {
    const ctx = await mounted()
    expect(ctx.permissionPresets.optionOf('danger-full-access')).toEqual({ value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access without approval prompts.' })
    expect(ctx.permissionPresets.optionOf('custom')).toEqual({ value: 'custom', name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' })
    const bare = await mounted({ config: { presets: { plain: { sandbox: 'workspace-write', approval: 'ask' } } } })
    expect(bare.permissionPresets.optionOf('plain')).toEqual({ value: 'plain', name: 'plain' })
    expect(() => ctx.permissionPresets.optionOf('plan')).toThrow(/unknown preset/)
  })

  it('rejects a table entry named custom (reserved for the derived state)', async () => {
    await expect(mounted({ config: { presets: { custom: { sandbox: 'read-only', approval: 'ask' } } } }))
      .rejects.toThrow(/reserved for the derived not-a-preset state/)
  })

  it('reserves auto for an integration contribution instead of configured defaults', async () => {
    await expect(mounted({ config: { presets: { auto: { sandbox: 'danger-full-access', approval: 'never' } } } }))
      .rejects.toThrow(/"auto" is reserved/)
  })

  it('requires an explicit default when composition defaults match no preset', async () => {
    await expect(mounted({ approvalDefault: 'never' }))
      .rejects.toThrow(/configure defaultPreset explicitly/)
  })

  it('reads a schema-less approval stand-in as the ask default', async () => {
    const ctx = await mounted({ approvalDefault: undefined })
    const session = freshSession('sess-standin')
    ctx.permissionPresets.set(session, 'workspace-write')
    expect(session.snapshotEvents()).toHaveLength(0)
    expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
  })
})

describe('new-session default', () => {
  it('rejects persisted Auto before publication when its integration is absent', async () => {
    const ctx = await mounted()
    const source = freshSession('auto-source')
    source.append('permission/preset', { preset: AUTO_PRESET })
    source.append('sandbox/mode', { mode: 'danger-full-access' })
    source.append('approval/policy', { policy: 'never' })

    const id = SessionId('auto-without-integration')
    expect(() => ctx.sessions.create(id, { seed: source.snapshotEvents() })).toThrow(/cannot restore preset "auto"/)
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(source.snapshotEvents().at(-1)).toMatchObject({ type: 'approval/policy' })
  })

  it('admits persisted Auto through the live integration without rewriting it', async () => {
    const ctx = await mounted()
    let admissions = 0
    await mountAuto(ctx, () => { admissions += 1 })
    const source = freshSession('auto-source-present')
    source.append('permission/preset', { preset: AUTO_PRESET })
    source.append('sandbox/mode', { mode: 'danger-full-access' })
    source.append('approval/policy', { policy: 'never' })

    const resumed = ctx.sessions.create(SessionId('auto-with-integration'), { seed: source.snapshotEvents() })
    expect(admissions).toBe(1)
    expect(ctx.permissionPresets.current(resumed)).toBe(AUTO_PRESET)
    expect(resumed.snapshotEvents().filter(event => event.type === 'permission/preset')).toHaveLength(1)
  })

  it('pins the current setting into each new session without changing earlier sessions', async () => {
    const ctx = await mountedStore()
    const first = ctx.sessions.create(SessionId('first'))
    expect(first.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'workspace-write' }],
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ])

    await configurations.get(ctx)!.update({
      defaultPreset: 'danger-full-access',
    })
    expect(ctx.permissionPresets.defaultPreset).toBe('danger-full-access')
    const second = ctx.sessions.create(SessionId('second'))
    expect(ctx.permissionPresets.current(first)).toBe('workspace-write')
    expect(ctx.permissionPresets.current(second)).toBe('danger-full-access')
    expect(second.snapshotEvents().map(event => event.type)).toEqual([
      'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
  })

  it('preserves a seeded legacy session instead of applying the latest user default', async () => {
    const ctx = await mountedStore()
    await configurations.get(ctx)!.update({
      defaultPreset: 'danger-full-access',
    })
    const legacy = freshSession('legacy-source')
    legacy.append('turn/start', { turn: 1 })
    legacy.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const resumed = ctx.sessions.create(SessionId('legacy-resumed'), { seed: legacy.snapshotEvents() })
    expect(ctx.permissionPresets.current(resumed)).toBe('workspace-write')
    expect(resumed.snapshotEvents().slice(-3).map(event => event.type)).toEqual([
      'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
  })

  it('preserves composition defaults when an empty stored session resumes', async () => {
    const ctx = await mountedStore()
    await configurations.get(ctx)!.update({
      defaultPreset: 'danger-full-access',
    })
    const resumed = ctx.sessions.create(SessionId('empty-resumed'), { seed: [] })
    expect(ctx.permissionPresets.current(resumed)).toBe('workspace-write')
    expect(resumed.snapshotEvents().map(event => event.type)).toEqual([
      'session/end-seed', 'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
  })

  it('pins sessions that already exist when the service remounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('permission tests do not execute bash') },
      run() { throw new Error('permission tests do not execute bash') },
      start() { throw new Error('permission tests do not execute bash') },
    })
    ctx.provide('approval', { config: { policy: 'ask' } })
    const existing = ctx.sessions.create(SessionId('existing-before-permission'))
    expect(existing.snapshotEvents()).toEqual([])

    configurations.set(ctx, await liveConfig(ctx, PermissionPresetService))
    expect(existing.snapshotEvents().map(event => event.type)).toEqual([
      'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
    expect(ctx.permissionPresets.current(existing)).toBe('workspace-write')
  })

  it('preserves existing knob overrides when the service remounts over a knob-bearing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('permission tests do not execute bash') },
      run() { throw new Error('permission tests do not execute bash') },
      start() { throw new Error('permission tests do not execute bash') },
    })
    ctx.provide('approval', { config: { policy: 'ask' } })
    const existing = ctx.sessions.create(SessionId('existing-knobs'))
    existing.append('sandbox/mode', { mode: 'read-only' })
    existing.append('approval/policy', { policy: 'never' })

    configurations.set(ctx, await liveConfig(ctx, PermissionPresetService))
    // The remount sweep must read the folded knob events instead of treating
    // the session as fresh; no default preset events may overwrite the
    // overrides (read-only + never matches no preset table entry).
    expect(existing.snapshotEvents().map(event => event.type)).toEqual([
      'sandbox/mode', 'approval/policy',
    ])
    expect(ctx.permissionPresets.current(existing)).toBe(CUSTOM_PRESET)
  })

  it('fills only missing legacy facts and preserves an unmatched seeded combination', async () => {
    const ctx = await mountedStore()
    const partial = freshSession('partial-source')
    partial.append('sandbox/mode', { mode: 'workspace-write' })
    partial.append('approval/policy', { policy: 'ask' })
    const resumed = ctx.sessions.create(SessionId('partial-resumed'), { seed: partial.snapshotEvents() })
    expect(resumed.snapshotEvents().at(-1)).toMatchObject({
      type: 'permission/preset',
      data: { preset: 'workspace-write' },
    })

    const custom = freshSession('custom-source')
    custom.append('sandbox/mode', { mode: 'read-only' })
    custom.append('approval/policy', { policy: 'never' })
    const unmatched = ctx.sessions.create(SessionId('custom-resumed'), { seed: custom.snapshotEvents() })
    expect(ctx.permissionPresets.current(unmatched)).toBe(CUSTOM_PRESET)
    expect(unmatched.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
  })

  it('materializes ask when a legacy seed and approval stand-in omit the policy', async () => {
    const ctx = await mountedStore({ approvalDefault: undefined })
    const partial = freshSession('approval-fallback-source')
    partial.append('sandbox/mode', { mode: 'workspace-write' })
    const resumed = ctx.sessions.create(SessionId('approval-fallback-resumed'), { seed: partial.snapshotEvents() })
    expect(resumed.snapshotEvents().at(-1)).toMatchObject({
      type: 'approval/policy',
      data: { policy: 'ask' },
    })
  })

  it('fails to read a stored default outside the configured preset table until it is repaired', async () => {
    const ctx = await mountedStore()
    await mountAuto(ctx)
    await configurations.get(ctx)!.update({ defaultPreset: AUTO_PRESET })
    expect(() => ctx.permissionPresets.defaultPreset).toThrow(/unknown default preset/)
    await configurations.get(ctx)!.update({ defaultPreset: 'workspace-write' })
    expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write')
  })
})
