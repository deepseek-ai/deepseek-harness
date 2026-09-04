/** Session creation and adoption rules for Agent preset identity. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionTestRemote } from './test-remote.ts'

/** Booted contexts and their temp roots, torn down after each test. */
const contexts: Context[] = []
const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

function roster(ids: readonly string[]): unknown {
  const presetOf = (id: string): object => ({
    id,
    trust: 'system',
    path: `/presets/${id}/agent.cordis.yml`,
  })
  return {
    defaultId: ids[0],
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) {
        return Promise.reject(new RemoteError(
          'agent-preset/not-found',
          `agent-presets: preset "${wanted}" not found (available: ${ids.join(', ') || 'none'})`,
          { agentPreset: wanted, available: ids },
        ))
      }
      return Promise.resolve(presetOf(wanted))
    },
    mount: (_ctx: Context, id?: string) => Promise.resolve(presetOf(id ?? ids[0] ?? '')),
  }
}

async function harness(presets?: readonly string[]) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-')))
  tempDirs.push(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (presets !== undefined) {
    ctx.provide('agentPresets', roster(presets) as never)
  }

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      return { agent, dispose: () => { unregister(); return Promise.resolve() } }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
  })
  if (presets !== undefined) ctx.sessionProjections.register(agentPresetProjectionDefinition)
  return { ctx, remote }
}

describe('session.create Agent preset identity', () => {
  it('records the requested preset on the Session header', async () => {
    const { ctx, remote } = await harness(['standard', 'minimal'])

    const created = await remote.create({ sessionId: SessionId('s1'), agentPreset: 'minimal' })

    expect(created.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentPreset).toBe('minimal')
  })

  it('records the roster default when the caller names no preset', async () => {
    const { ctx, remote } = await harness(['standard', 'minimal'])

    await remote.create({ sessionId: SessionId('s2') })

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentPreset).toBe('standard')
  })

  it('rejects an unknown preset', async () => {
    const { remote } = await harness(['standard'])

    const response = await remote.create({ sessionId: SessionId('s3'), agentPreset: 'nope' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })
  })

  it('refuses to adopt a live Session under a different preset', async () => {
    const { remote } = await harness(['standard', 'minimal'])
    await remote.create({ sessionId: SessionId('s4'), agentPreset: 'minimal' })

    const response = await remote.create({ sessionId: SessionId('s4'), agentPreset: 'standard' })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'agent-preset/conflict',
        details: {
          sessionId: 's4',
          requestedPreset: 'standard',
          existingPreset: 'minimal',
        },
      },
    })
  })

  it('adopts a live Session under the preset selected in its log', async () => {
    const { ctx, remote } = await harness(['standard', 'minimal'])
    await remote.create({ sessionId: SessionId('s4b'), agentPreset: 'standard' })
    ctx.sessions.get(SessionId('s4b'))?.append('agent-preset/selected', { agentPreset: 'minimal' })

    const adopted = await remote.create({ sessionId: SessionId('s4b'), agentPreset: 'minimal' })
    const stale = await remote.create({ sessionId: SessionId('s4b'), agentPreset: 'standard' })

    expect(adopted).toMatchObject({ ok: true, value: { agentPreset: 'minimal' } })
    expect(stale).toMatchObject({
      ok: false,
      error: { details: { existingPreset: 'minimal' } },
    })
  })

  it('adopts a live Session unchanged when the caller names no preset', async () => {
    const { remote } = await harness(['standard', 'minimal'])
    await remote.create({ sessionId: SessionId('s5'), agentPreset: 'minimal' })

    await expect(remote.create({ sessionId: SessionId('s5') }))
      .resolves.toMatchObject({ ok: true })
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { ctx, remote } = await harness()

    await remote.create({ sessionId: SessionId('s6') })

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentPreset).toBeUndefined()
  })

  it('explains why a preset-less Session cannot be adopted under one', async () => {
    const { remote } = await harness()
    await remote.create({ sessionId: SessionId('s7') })

    const response = await remote.create({ sessionId: SessionId('s7'), agentPreset: 'standard' })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'agent-preset/conflict',
        details: {
          sessionId: 's7',
          requestedPreset: 'standard',
        },
      },
    })
    if (response.ok) throw new Error('unreachable')
    expect('existingPreset' in response.error.details).toBe(false)
    expect(response.error.message).toContain('records no agent preset')
  })
})
