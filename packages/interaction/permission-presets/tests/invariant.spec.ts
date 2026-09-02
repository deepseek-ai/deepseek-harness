import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as PermissionInvariant from '@deepseek-ai/dsh-permission-presets/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

class PermissionProbe extends Service {
  readonly names = ['safe', 'trusted']

  constructor(ctx: Context) {
    super(ctx, 'permissionPresets')
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(PermissionProbe)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(PermissionInvariant)
  return ctx
}

function presetEvent(preset: string): SessionEvent {
  return { type: 'permission/preset', seq: SessionSeq(0), time: 0, data: { preset } }
}

describe('permission invariants', () => {
  it('accepts configured preset events and ignores other session data', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, presetEvent('safe')) }).not.toThrow()
    expect(() => { ctx.emit('session/event', {} as Session, {
      type: 'turn/end', seq: SessionSeq(0), time: 0, data: {},
    } as SessionEvent) }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('rejects a durable preset that the active table cannot resolve', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, presetEvent('missing')) })
      .toThrow(/unknown preset "missing"/)
  })

  it('rejects an unknown preset already present on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(PermissionProbe)
    ctx.sessions.create().append('permission/preset', { preset: 'missing' })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(PermissionInvariant).then(() => undefined)).rejects.toThrow(/unknown preset "missing"/)
  })
})
