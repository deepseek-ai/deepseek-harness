import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import AgentPresets, { livePresetMounts, type Config } from '@deepseek-ai/dsh-agent-presets'
import * as AgentPresetsInvariant from '@deepseek-ai/dsh-agent-presets/invariant'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

async function harness(roster: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'standard', roots: ROOTS, includeShippedRoot: false, includeUserRoot: false, ...roster })
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentPresetsInvariant)
  return ctx
}

describe('agent-presets invariants', () => {
  it('keeps the standing composition alive across the agents that joined it', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('inv-live'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    expect(livePresetMounts().map(mount => mount.presetId)).toContain('standard')

    // A standing mount survives its agents: the composition a session joined
    // is shared, so one session ending must not strip it from the next.
    await handle.dispose()
    expect(livePresetMounts().map(mount => mount.presetId)).toContain('standard')

    // A second agent reuses the same mount rather than adding one.
    await ctx.agents.create({
      sessionId: SessionId('inv-live-2'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    expect(livePresetMounts().filter(mount => mount.presetId === 'standard')).toHaveLength(1)

    // Whole-tree teardown is the boundary that does reclaim it.
    await ctx.fiber.dispose()
    expect(livePresetMounts().map(mount => mount.presetId)).not.toContain('standard')
  })

  it('rejects a composition that publishes a process-global service after its audit', async () => {
    const ctx = await harness()
    await ctx.agents.create({
      sessionId: SessionId('inv-late'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'late'),
    })
    const publishLate = (globalThis as { __PUBLISH_LATE__?: () => void }).__PUBLISH_LATE__
    expect(publishLate).toBeTypeOf('function')

    expect(() => { publishLate?.() }).toThrow(/published process-global service\(s\) \[fixtureLateSvc\]/)
  })

  it('stays quiet while every composition keeps its services out of the root realm', async () => {
    const ctx = await harness()

    await expect(ctx.agents.create({
      sessionId: SessionId('inv-isolated'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'isolated'),
    })).resolves.toBeDefined()
  })

  it('rejects an agent that addresses a model without joining any preset', async () => {
    const ctx = await harness()
    // The delegation shape: an agent composed outside the roster joined no
    // standing mount, so every registry view it reads is the empty global
    // layer. Publication alone stays legal — `recompose` binds exactly such an
    // agent — so nothing fires until that empty world reaches a prompt.
    const handle = await ctx.agents.create({ sessionId: SessionId('inv-unjoined') })

    await expect(ctx.systemPrompt.assemble(assembleContextFor(handle.agent)))
      .rejects.toThrow(/without joining any agent preset/)
  })

  it('rejects one just the same when the derived home root is the whole roster', async () => {
    // The shape this plugin defaults to: an app configures nothing and the
    // roster is the harness home alone. A roster is a roster however its roots
    // were resolved, so the fail-loud half must not go quiet here — it read
    // `config.roots` once, which is empty in exactly this case.
    const ctx = await harness({ roots: [], includeUserRoot: true })
    const handle = await ctx.agents.create({ sessionId: SessionId('inv-derived-only') })

    await expect(ctx.systemPrompt.assemble(assembleContextFor(handle.agent)))
      .rejects.toThrow(/without joining any agent preset/)
  })

  it('stays silent for a composition that opted out of every root', async () => {
    // `includeUserRoot: false` with no configured roots is a deployment that
    // mounts the roster but keeps its agents on the host plane; there is no
    // roster to join, so an unjoined agent is not a violation.
    const ctx = await harness({ roots: [], includeUserRoot: false })
    const handle = await ctx.agents.create({ sessionId: SessionId('inv-no-roster') })

    await expect(ctx.systemPrompt.assemble(assembleContextFor(handle.agent))).resolves.toBeDefined()
  })

  it('admits a joined agent, a scopeless read, and a standing-key read', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('inv-joined'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    await expect(ctx.systemPrompt.assemble(assembleContextFor(handle.agent))).resolves.toBeDefined()
    // A scopeless assembly belongs to no agent, so it cannot be an unjoined one.
    await expect(ctx.systemPrompt.assemble({})).resolves.toBeDefined()
    // Neither can a scope that is not an agent at all: a standing preset key
    // has no parent of its own, so a chain-length rule would reject the cold
    // read that resolves presenters in it. `context.agent` is what keeps this
    // check to agent assemblies.
    const standing = await ctx.agentPresets.standingKeyFor('standard')
    await expect(ctx.systemPrompt.assemble({ scope: standing })).resolves.toBeDefined()
  })
})
