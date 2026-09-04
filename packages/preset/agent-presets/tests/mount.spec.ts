import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPresets, {
  COMPOSITION_FILE, leakedServices, livePresetMounts, mountPreset, serviceForAgent,
} from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published by the `isolated` fixture preset behind an entry-local realm. */
    fixtureIsolatedSvc: { label: string }
  }
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

/**
 * A composition carrying the registries a preset contributes to, plus the
 * preset roster.
 * @param roster - roster config, defaulting to the fixture roots.
 * @returns the booted context.
 */
async function harness(roster: Config = { default: 'standard', roots: ROOTS, includeShippedRoot: false, includeUserRoot: false }): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // A preset outside this workspace cannot resolve `cordis-plugin-group` by
  // name, so the app registers it as a builtin; the fixtures compose the same
  // way real presets do, which needs it here too.
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return ctx
}

async function agentOn(ctx: Context, id: string, presetId?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

/** Every service registration in the runtime, regardless of which realm holds it. */
function providedServiceNames(ctx: Context): string[] {
  const store = ctx.reflect.store
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key]?.name)
    .filter((name): name is string => name !== undefined)
}

/** Whether the root realm maps `name` to a live registration. */
function rootResolves(ctx: Context, name: string): boolean {
  const key = ctx.root[Context.isolate][name]
  return key !== undefined && ctx.reflect.store[key] !== undefined
}

let ctx: Context

/** Every temp preset root created by this file, removed after each test. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  ctx = await harness()
})

describe('composing an agent from a preset', () => {
  it('hands an absolute plugin path to Node as a file URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-absolute-plugin-'))
    roots.push(root)
    const presetDir = join(root, 'absolute')
    const plugin = join(FIXTURES, 'plugins', 'contribute.js')
    await mkdir(presetDir)
    await writeFile(
      join(presetDir, COMPOSITION_FILE),
      `- id: only\n  name: ${plugin}\n  config:\n    tool: absolute\n`,
    )
    const scoped = await harness({ default: 'absolute', roots: [{ path: root, trust: 'user' }], includeShippedRoot: false, includeUserRoot: false })
    const imported = vi.spyOn(scoped.loader.internal!, 'import')

    await agentOn(scoped, 'sess-absolute-plugin')

    expect(imported).toHaveBeenCalledWith(pathToFileURL(plugin).href, expect.any(String), {})
  })

  it('gives each session only its own preset\'s tools', async () => {
    const alpha = await agentOn(ctx, 'sess-alpha', 'standard')
    const beta = await agentOn(ctx, 'sess-beta', 'minimal')

    expect(toolNames(ctx, alpha)).toEqual(['alpha'])
    expect(toolNames(ctx, beta)).toEqual(['beta'])
    expect(toolNames(ctx)).toEqual([])
  })

  it('scopes prompt sections and assembled schemas to the same session', async () => {
    const alpha = await agentOn(ctx, 'sess-alpha', 'standard')
    const beta = await agentOn(ctx, 'sess-beta', 'minimal')

    const alphaPrompt = await ctx.systemPrompt.assemble(assembleContextFor(alpha))
    const betaPrompt = await ctx.systemPrompt.assemble(assembleContextFor(beta))

    expect(alphaPrompt.sections.map(section => section.name)).toContain('preset:alpha')
    expect(alphaPrompt.sections.map(section => section.name)).not.toContain('preset:beta')
    expect(betaPrompt.sections.map(section => section.name)).toContain('preset:beta')
    expect(alphaPrompt.tools.map(schema => schema.name)).toEqual(['alpha'])
  })

  it('mounts the default preset when the caller names none', async () => {
    const agent = await agentOn(ctx, 'sess-default')

    expect(toolNames(ctx, agent)).toEqual(['alpha'])
  })

  it('lets two sessions share one preset without colliding', async () => {
    const first = await agentOn(ctx, 'sess-first', 'standard')
    const second = await agentOn(ctx, 'sess-second', 'standard')

    expect(toolNames(ctx, first)).toEqual(['alpha'])
    expect(toolNames(ctx, second)).toEqual(['alpha'])
  })

  it('unwinds one session\'s composition without touching another\'s', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-gone'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const survivor = await agentOn(ctx, 'sess-stays', 'minimal')
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])

    await handle.dispose()

    expect(ctx.agents.get(SessionId('sess-gone'))).toBeUndefined()
    expect(toolNames(ctx, survivor)).toEqual(['beta'])
    expect(toolNames(ctx)).toEqual([])
  })
})

describe('composing a child agent from its parent', () => {
  /** Create one agent joined to `parent`'s composition, as a child creation window does. */
  async function childOf(ctx: Context, id: string, parent: Agent): Promise<Agent> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      setup: (childCtx: Context) => void ctx.agentPresets.composeFrom(childCtx, parent.ctx),
    })
    return handle.agent
  }

  it('gives the child its parent\'s tools and prompt sections', async () => {
    const parent = await agentOn(ctx, 'sess-parent', 'standard')

    const child = await childOf(ctx, 'sess-child', parent)

    expect(toolNames(ctx, child)).toEqual(['alpha'])
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(child))
    expect(prompt.sections.map(section => section.name)).toContain('preset:alpha')
  })

  it('joins the parent\'s own generation rather than remounting its preset', async () => {
    const parent = await agentOn(ctx, 'sess-shared', 'standard')
    const before = livePresetMounts().length

    await childOf(ctx, 'sess-shared-child', parent)

    // A remount would compose a second copy of every row in the preset; the
    // child must run on the plugin instances its parent already runs on.
    expect(livePresetMounts()).toHaveLength(before)
  })

  it('keeps the child composed after its parent is disposed', async () => {
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('sess-dying-parent'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const child = await childOf(ctx, 'sess-orphan', parentHandle.agent)

    await parentHandle.dispose()

    // Standing mounts outlive the agents that joined them, so a child outliving
    // its parent — a background subagent — keeps the composition it started on.
    expect(toolNames(ctx, child)).toEqual(['alpha'])
  })

  it('reports the preset id the child joined, for the durable header', async () => {
    const parent = await agentOn(ctx, 'sess-named', 'minimal')

    const child = await childOf(ctx, 'sess-named-child', parent)

    expect(ctx.agentPresets.composedPreset(parent.ctx)).toBe('minimal')
    expect(ctx.agentPresets.composedPreset(child.ctx)).toBe('minimal')
  })

  it('composes nothing when the parent joined no preset', async () => {
    // The rosterless deployment: model-facing rows sit in the host composition
    // and the child already resolves them through the registry's global layer.
    const bare = (await ctx.agents.create({ sessionId: SessionId('sess-bare-parent') })).agent

    const child = await childOf(ctx, 'sess-bare-child', bare)

    expect(ctx.agentPresets.composedPreset(bare.ctx)).toBeUndefined()
    expect(ctx.agentPresets.composeFrom(child.ctx, bare.ctx)).toBeUndefined()
    expect(toolNames(ctx, child)).toEqual([])
  })

  it('refuses to compose an unscoped context', async () => {
    const parent = await agentOn(ctx, 'sess-unscoped-parent', 'standard')

    expect(() => ctx.agentPresets.composeFrom(ctx, parent.ctx)).toThrow(/unscoped context/)
  })
})

describe('rejecting a composition that cannot be used', () => {
  it('refuses to mount into a context that carries no agent scope', async () => {
    await expect(ctx.agentPresets.mount(ctx, 'standard'))
      .rejects.toThrow(/unscoped context/)
  })

  it('rolls the whole agent back when a row fails to load', async () => {
    await expect(agentOn(ctx, 'sess-broken', 'broken')).rejects.toThrow(/failed to mount/)

    expect(ctx.agents.get(SessionId('sess-broken'))).toBeUndefined()
    expect(toolNames(ctx)).toEqual([])
  })

  it('names every failed row, not just the count', async () => {
    // The Loader folds several failed rows into one AggregateError whose own
    // message names none of them; unflattened, the operator is told only that
    // "loader entries failed to apply" and has nothing to act on.
    await expect(agentOn(ctx, 'sess-two-broken', 'two-broken'))
      .rejects.toThrow(/first-refuses[\s\S]*second-refuses/)
  })

  it('names the rows inside a failed group, not the group alone', async () => {
    // The Loader's per-row wrapper keeps only `cause.message`, so a group's
    // own AggregateError arrives with its `errors` reachable through `cause`
    // alone. Reading the message stops at "loader entries failed to apply"
    // and names neither row that actually refused.
    await expect(agentOn(ctx, 'sess-nested-broken', 'nested-broken'))
      .rejects.toThrow(/outer[\s\S]*inner-first[\s\S]*inner-second/)
  })

  it('names the unresolved service when a row never activates', async () => {
    await expect(agentOn(ctx, 'sess-pending', 'pending'))
      .rejects.toThrow(/waiting for serviceThatDoesNotExist/)
  })

  it('rejects a row that publishes a process-global service', async () => {
    await expect(agentOn(ctx, 'sess-leaky', 'leaky'))
      .rejects.toThrow(/process-global service\(s\) \[aaaFixtureLeakedSvc, zzzFixtureLeakedSvc\]/)

    // The rejected subtree is fully unwound, so its registrations are gone from
    // the store rather than merely unreachable.
    expect(providedServiceNames(ctx)).not.toContain('aaaFixtureLeakedSvc')
    expect(providedServiceNames(ctx)).not.toContain('zzzFixtureLeakedSvc')
  })

  it('accepts the same provider behind an isolate realm', async () => {
    const agent = await agentOn(ctx, 'sess-isolated', 'isolated')

    expect(agent.id).toBe(SessionId('sess-isolated'))
    // The provider ran, but under a realm-private symbol the root cannot reach.
    expect(providedServiceNames(ctx)).toContain('fixtureIsolatedSvc')
    expect(rootResolves(ctx, 'fixtureIsolatedSvc')).toBe(false)
  })

  it('addresses the standing instance of a realm-private service through either agent', async () => {
    const first = await agentOn(ctx, 'sess-reach-a', 'isolated')
    const second = await agentOn(ctx, 'sess-reach-b', 'isolated')

    // The realm keeps the service out of every host context, so a caller
    // holding the agent is how a request from OUTSIDE the session reads the
    // instance it is about.
    expect(rootResolves(ctx, 'fixtureIsolatedSvc')).toBe(false)
    const mine = ctx.agentPresets.serviceFor(first, 'fixtureIsolatedSvc')
    const theirs = ctx.agentPresets.serviceFor(second, 'fixtureIsolatedSvc')
    expect(mine).toBeDefined()
    // ONE composition per preset: both agents joined the same standing mount,
    // so they address the same instance — sessions stay apart inside it by
    // the plugin's own Session/Agent keying, not by instance count.
    expect(theirs).toBe(mine)
  })

  it('answers undefined for a service the agent\'s preset does not mount', async () => {
    // The isolated preset's standing instance exists in the same runtime, so
    // the lookup finds the NAME and must still refuse it: the instance lives
    // under another mount's fiber, not this agent's composition.
    await agentOn(ctx, 'sess-reach-other', 'isolated')
    const agent = await agentOn(ctx, 'sess-reach-none', 'standard')

    expect(ctx.agentPresets.serviceFor(agent, 'fixtureIsolatedSvc')).toBeUndefined()
  })

  it('answers undefined for an agent outside the scope machinery', async () => {
    // Unscoped, scoped-but-unparented, and parented to a key no live mount
    // owns are the three ways a context can fail to name a standing mount;
    // each is an answer, not a throw, because the caller asked a question.
    expect(serviceForAgent(ctx, { ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
    const loner = createScope(ctx, { test: 'loner' })
    expect(serviceForAgent(ctx, { ctx: loner.ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
    const orphan = createScope(ctx, { test: 'orphan' })
    bindScopeParent(scopeOf(orphan.ctx)!, { agentPreset: 'never-mounted' })
    expect(serviceForAgent(ctx, { ctx: orphan.ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
  })

  it('refuses to mount a preset directly into an unscoped context', async () => {
    // The service's own mount() guards this before delegating; the exported
    // function is callable on its own, so the boundary holds there too.
    const preset = await ctx.agentPresets.resolve('standard')

    await expect(mountPreset(ctx, preset)).rejects.toThrow(/unscoped context/)
  })

  it('reports the known ids when a preset is unknown', async () => {
    await expect(ctx.agentPresets.resolve('nope'))
      .rejects.toThrow(/preset "nope" not found \(available: .*standard/)
  })
})

describe('the preset roster', () => {
  it('lists every root\'s presets with the earlier root winning', async () => {
    const listed = await ctx.agentPresets.list()

    // `not-a-preset` is the fixture ghost: no composition file, listed broken.
    expect(listed.map(preset => preset.id).sort())
      .toEqual(['broken', 'isolated', 'late', 'leaky', 'minimal', 'nested-broken', 'not-a-preset', 'pending', 'standard', 'two-broken'])
    expect(listed.find(preset => preset.id === 'standard')?.trust).toBe('system')
    expect(listed.find(preset => preset.id === 'not-a-preset')?.broken).toMatch(/is missing/)
  })

  it('exposes the configured default id', () => {
    expect(ctx.agentPresets.defaultId).toBe('standard')
  })
})

describe('composing from a broken preset', () => {
  /** A roster whose only user preset carries `composition`. */
  async function rosterWith(composition: string): Promise<Context> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-broken-'))
    roots.push(root)
    await mkdir(join(root, 'damaged'))
    await writeFile(join(root, 'damaged', COMPOSITION_FILE), composition)
    return await harness({ default: 'damaged', roots: [{ path: root, trust: 'user' as const }], includeShippedRoot: false, includeUserRoot: false })
  }

  it('refuses the mount up front with the discovery-reported reason', async () => {
    const scoped = await rosterWith('- id: x\n  name: [unclosed\n')

    // The refusal happens before the loader ever sees the file, so every
    // unloadable shape gets the same early agent-preset/invalid — and a
    // rejected setup rolls the whole agent creation back.
    await expect(agentOn(scoped, 'sess-broken', 'damaged'))
      .rejects.toMatchObject({ code: 'agent-preset/invalid' })
    await expect(agentOn(scoped, 'sess-broken-2', 'damaged')).rejects.toThrow(/not valid YAML/)
    expect(livePresetMounts().filter(mount => mount.presetId === 'damaged')).toHaveLength(0)
  })

  it('refuses the standing key a cold reader would mount by', async () => {
    const scoped = await rosterWith('rows: not-a-list\n')

    await expect(scoped.agentPresets.standingKeyFor('damaged'))
      .rejects.toThrow(/top-level list of plugin rows/)
  })

  it('still resolves the broken row for the surfaces that manage it', async () => {
    const scoped = await rosterWith('- id: x\n  name: [unclosed\n')

    // Deleting and reporting need the row; only composing refuses it.
    expect((await scoped.agentPresets.resolve('damaged')).broken).toMatch(/not valid YAML/)
  })
})

describe('a roster with nothing in it', () => {
  it('says so instead of naming an empty list of candidates', async () => {
    const bare = new Context()
    bare.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await bare.plugin(Loader)
    await bare.plugin(SessionProjectionRegistry)
    await bare.plugin(AgentPresets, { default: 'standard', roots: [], includeShippedRoot: false, includeUserRoot: false })

    await expect(bare.agentPresets.resolve())
      .rejects.toThrow(/preset "standard" not found \(available: none\)/)
  })
})

describe('a roster with no base to resolve from', () => {
  it('refuses at load rather than calling every preset broken', async () => {
    // Health answers "can this row be imported?", and the same package name
    // fails from a preset's own directory while resolving from the installed
    // harness. Without the base there is no answer, and the silent one is
    // exactly the failure the check exists to report.
    const baseless = new Context()
    await baseless.plugin(Loader)
    await baseless.plugin(SessionProjectionRegistry)

    await expect(baseless.plugin(AgentPresets, {
      default: 'standard', roots: ROOTS, includeShippedRoot: false, includeUserRoot: false,
    })).rejects.toThrow(/needs `ctx\.baseUrl`/)
  })
})

describe('the preset file is an input, never a persistence target', () => {
  it('survives a row that disposes itself, which makes the Loader persist a tree', async () => {
    // The preset lives in a temp root, not under `fixtures/`: without the
    // `write()` override the Loader REWRITES the composition it read, so a
    // committed fixture would be mutated by the very run that proves the bug
    // and every later run would compare against the damaged file and pass.
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-write-'))
    roots.push(root)
    const dir = join(root, 'self-disposing')
    await mkdir(dir)
    const path = join(dir, COMPOSITION_FILE)
    const composition = [
      '- id: tool-kept',
      `  name: ${join(FIXTURES, 'plugins', 'contribute.js')}`,
      '  config:',
      '    tool: kept',
      '- id: goes-away',
      `  name: ${join(FIXTURES, 'plugins', 'self-dispose.js')}`,
      '',
    ].join('\n')
    await writeFile(path, composition)

    const scoped = new Context()
    scoped.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await scoped.plugin(Loader)
    scoped.loader.builtins.include = Include
    scoped.loader.builtins.group = Group
    await scoped.plugin(LlmRuntime)
    await scoped.plugin(SessionStore)
    await scoped.plugin(SystemPrompt, { persona: '' })
    await scoped.plugin(ToolRuntime)
    await scoped.plugin(AgentRegistry)
    await scoped.plugin(SessionProjectionRegistry)
    await scoped.plugin(AgentLoop, { agents: [] })
    await scoped.plugin(AgentPresets, { default: 'self-disposing', roots: [{ path: root, trust: 'user' as const }], includeShippedRoot: false, includeUserRoot: false })

    await scoped.agents.create({
      sessionId: SessionId('sess-self-dispose'),
      setup: async (agentCtx: Context) => void await scoped.agentPresets.mount(agentCtx),
    })
    await (globalThis as { __SELF_DISPOSED__?: Promise<unknown> }).__SELF_DISPOSED__
    // Slack past the deterministic signal above, not a race the number has to
    // win. The write rides the Loader's fiber-unload listener, which stamps
    // `disabled: true` and calls `write()` in the same synchronous step; once
    // the self-dispose has settled, a regression has already written. Polling
    // would not help — the assertion is an ABSENCE, and no amount of waiting
    // proves one — so the wait only has to clear settlement.
    await new Promise(resolve => setTimeout(resolve, 50))

    // Inherited, `EntryTree.write()` persists the dying tree — stamping
    // `disabled: true` onto the row and, in the shipped case, truncating the
    // composition every session shares.
    expect(await readFile(path, 'utf8')).toBe(composition)
  })
})

describe('attributing a service to a subtree', () => {
  it('attributes nothing to a subtree that is already torn down', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-torn'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const [mount] = livePresetMounts().filter(entry => entry.presetId === 'standard')
    expect(mount).toBeDefined()

    await handle.dispose()

    // A disposed subtree owns nothing, so it can never be blamed for a service
    // some other subtree published under the same name afterwards.
    expect(leakedServices(ctx, mount!.fiber)).toEqual([])
  })
})

describe('replacing a composition', () => {
  it('publishes a committed preset selection for remote consumers', async () => {
    const agent = await agentOn(ctx, 'sess-selected', 'standard')
    const selected: Array<[SessionId, string]> = []
    ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
      selected.push([sessionId, agentPreset])
    })

    agent.session.append('agent-preset/selected', { agentPreset: 'minimal' })

    expect(selected).toEqual([[SessionId('sess-selected'), 'minimal']])
  })

  it('swaps the agent\'s tools without touching another session', async () => {
    const keeper = await agentOn(ctx, 'sess-keeper', 'standard')
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-swap'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])

    await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')

    expect(toolNames(ctx, handle.agent)).toEqual(['beta'])
    expect(toolNames(ctx, keeper)).toEqual(['alpha'])
    expect(toolNames(ctx)).toEqual([])
  })

  it('notifies tool views after reparenting and contains notification failures', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-tool-change'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    await ctx.agentPresets.standingKeyFor('minimal')
    let changes = 0
    const stopCounting = ctx.on('tools/change', () => { changes += 1 })
    await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')
    expect(changes).toBe(1)
    stopCounting()

    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const stopThrowing = ctx.on('tools/change', () => { throw new Error('listener failed') })
    await expect(ctx.agentPresets.recompose(handle.agent.ctx, 'standard')).resolves.toMatchObject({ id: 'standard' })
    expect(ctx.agentPresets.composedPreset(handle.agent.ctx)).toBe('standard')
    expect(warnings).toEqual([expect.stringContaining('tools/change listener failed')])
    stopThrowing()
  })

  it('leaves the agent on its previous composition when the new one is unknown', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-unknown'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    await expect(ctx.agentPresets.recompose(handle.agent.ctx, 'nope'))
      .rejects.toThrow(/not found/)

    // Resolution happens before any teardown, so an unknown id is a no-op.
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])
  })

  it('restores the previous composition when the new one fails to mount', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-restore'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    await expect(ctx.agentPresets.recompose(handle.agent.ctx, 'broken'))
      .rejects.toThrow(/failed to mount/)

    // The swap is unmount-then-mount, so a failure must put the old one back
    // rather than leave the agent with no tools at all.
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])
  })

  it('names an agent that was published without joining any preset', async () => {
    const ctx = await harness()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn

    await ctx.agents.create({ sessionId: SessionId('sess-unjoined-warn') })
    // Advisory, not fatal: a synchronous `agent/created` throw would veto
    // publication, and creating an agent outside the roster stays legal.
    expect(warnings.filter(line => line.includes('sess-unjoined-warn'))).toHaveLength(1)
    expect(warnings.at(-1)).toMatch(/without joining an agent preset/)

    warnings.length = 0
    await agentOn(ctx, 'sess-joined-quiet', 'minimal')
    expect(warnings).toEqual([])
  })

  it('says nothing when the composition opts out of every root', async () => {
    // Presets are optional: every surface except the Web bundle keeps its
    // model-facing rows in the host plane, so an agent with a chain of one is
    // exactly right there and the diagnostic must stay silent. Opting out is
    // what makes this rosterless — empty `roots` alone would still derive the
    // harness-home root, which is a roster like any other.
    const rosterless = await harness({ default: 'standard', roots: [], includeShippedRoot: false, includeUserRoot: false })
    const warnings: string[] = []
    rosterless.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof rosterless.logger.warn

    await rosterless.agents.create({ sessionId: SessionId('sess-no-roster') })

    expect(warnings).toEqual([])
  })

  it('composes an agent that had nothing installed', async () => {
    // An agent created without a preset has no binding to re-link, so the
    // switch is its first bind — exactly a mount — and once bound only the
    // roster's kept binding can move it again.
    const handle = await ctx.agents.create({ sessionId: SessionId('sess-bare') })

    await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')

    expect(toolNames(ctx, handle.agent)).toEqual(['beta'])
  })

  it('refuses a bare agent\'s broken composition without restoring anything', async () => {
    const handle = await ctx.agents.create({ sessionId: SessionId('sess-bare-broken') })

    await expect(ctx.agentPresets.recompose(handle.agent.ctx, 'broken'))
      .rejects.toThrow(/failed to mount/)

    // Nothing was installed, so there is nothing to put back.
    expect(toolNames(ctx, handle.agent)).toEqual([])
  })

  it('keeps the agent on its standing composition when a switch fails, even with the source deleted', async () => {
    // A preset root this test owns, so removing the composition mid-flight
    // cannot disturb the shipped fixtures.
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-restore-'))
    roots.push(root)
    const seeded: [string, string][] = [['first', `- id: only\n  name: ${join(FIXTURES, 'plugins', 'contribute.js')}\n  config:\n    tool: only\n`], ['broken', `- id: nope\n  name: ${join(FIXTURES, 'plugins', 'throws.js')}\n  config:\n    message: refuses\n`]]
    for (const [id, body] of seeded) {
      await mkdir(join(root, id))
      await writeFile(join(root, id, COMPOSITION_FILE), body)
    }
    const scoped = new Context()
    scoped.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await scoped.plugin(Loader)
    scoped.loader.builtins.include = Include
    scoped.loader.builtins.group = Group
    await scoped.plugin(LlmRuntime)
    await scoped.plugin(SessionStore)
    await scoped.plugin(SystemPrompt, { persona: '' })
    await scoped.plugin(ToolRuntime)
    await scoped.plugin(AgentRegistry)
    await scoped.plugin(SessionProjectionRegistry)
    await scoped.plugin(AgentLoop, { agents: [] })
    await scoped.plugin(AgentPresets, { default: 'first', roots: [{ path: root, trust: 'user' as const }], includeShippedRoot: false, includeUserRoot: false })
    const handle = await scoped.agents.create({
      sessionId: SessionId('sess-restore-gone'),
      setup: async (agentCtx: Context) => void await scoped.agentPresets.mount(agentCtx, 'first'),
    })

    // The roster is a live directory: the composition the agent came from can
    // be gone from DISK by the time a switch fails. The standing mount is not
    // the file — it outlives deletion, so there is nothing to "restore".
    await rm(join(root, 'first'), { recursive: true })

    await expect(scoped.agentPresets.recompose(handle.agent.ctx, 'broken'))
      .rejects.toThrow(/failed to mount/)

    // The failed switch left the agent EXACTLY as it was: the new standing
    // mount is ensured before the parent link moves, so a rejection never
    // strips the old composition.
    expect(toolNames(scoped, handle.agent)).toEqual(['only'])
  })

  it('refuses an unscoped context', async () => {
    await expect(ctx.agentPresets.recompose(ctx, 'minimal'))
      .rejects.toThrow(/unscoped context/)
  })
})

describe('editing a composition file', () => {
  /** One-row composition whose single tool is named `tool`. */
  const rowFor = (tool: string): string =>
    `- id: only\n  name: ${join(FIXTURES, 'plugins', 'contribute.js')}\n  config:\n    tool: ${tool}\n`

  /**
   * A context over a temp root holding one editable preset. The id is
   * per-test because `livePresetMounts()` is a process-global registry.
   */
  async function editable(id: string): Promise<{ scoped: Context; path: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-edit-'))
    roots.push(root)
    await mkdir(join(root, id))
    const path = join(root, id, COMPOSITION_FILE)
    await writeFile(path, rowFor('before'))
    const scoped = await harness({ default: id, roots: [{ path: root, trust: 'user' as const }], includeShippedRoot: false, includeUserRoot: false })
    return { scoped, path }
  }

  it('starts a new generation for later sessions while joined ones keep theirs', async () => {
    const { scoped, path } = await editable('edited')
    const first = await agentOn(scoped, 'sess-gen-first', 'edited')
    expect(toolNames(scoped, first)).toEqual(['before'])

    // Files are the only composition editor now (authoring is copy/delete),
    // so the standing mount notices the file's stamp changing on its own.
    await writeFile(path, rowFor('afterwards'))

    const second = await agentOn(scoped, 'sess-gen-second', 'edited')
    expect(toolNames(scoped, second)).toEqual(['afterwards'])
    // The joined session keeps the generation it runs on.
    expect(toolNames(scoped, first)).toEqual(['before'])
  })

  it('gives two sessions racing the refreshed file one shared new generation', async () => {
    const { scoped, path } = await editable('raced')
    await agentOn(scoped, 'sess-race-seed', 'raced')

    await writeFile(path, rowFor('afterwards'))

    // Whichever racer swaps the pointer first, the other must join it rather
    // than fork a third generation off the same edit.
    const [left, right] = await Promise.all([
      agentOn(scoped, 'sess-race-left', 'raced'),
      agentOn(scoped, 'sess-race-right', 'raced'),
    ])
    expect(toolNames(scoped, left)).toEqual(['afterwards'])
    expect(toolNames(scoped, right)).toEqual(['afterwards'])
    expect(livePresetMounts().filter(mount => mount.presetId === 'raced')).toHaveLength(2)
  })

  it('keeps a newer generation pointer when a stale refresh loses the swap race', async () => {
    const { scoped, path } = await editable('guarded-refresh')
    const preset = await scoped.agentPresets.resolve('guarded-refresh')
    await agentOn(scoped, 'sess-guarded-refresh-seed', 'guarded-refresh')
    const service = scoped.agentPresets as unknown as {
      standing: Map<string, Promise<{
        key: unknown
        scope: unknown
        stamp: { mtimeMs: number; size: number }
      }>>
      ensureStanding(current: typeof preset): Promise<unknown>
    }
    const stalePromise = service.standing.get(preset.id)!
    const stale = await stalePromise
    await writeFile(path, rowFor('afterwards'))
    const { mtimeMs, size } = await stat(path)
    const newer = { ...stale, stamp: { mtimeMs, size } }
    const newerPromise = Promise.resolve(newer)

    // `await pending` yields before the guarded delete, letting the winning
    // refresher replace the pointer deterministically instead of by timing.
    const refresh = service.ensureStanding(preset)
    service.standing.set(preset.id, newerPromise)

    expect(await refresh).toBe(newer)
    expect(service.standing.get(preset.id)).toBe(newerPromise)
  })

  it('hands a host reader the standing key without starting an agent', async () => {
    const { scoped } = await editable('cold-read')

    const key = await scoped.agentPresets.standingKeyFor('cold-read')

    // The mount exists for the reader; no agent, session, or turn started.
    expect(key).toEqual({ agentPreset: 'cold-read' })
    expect(livePresetMounts().filter(mount => mount.presetId === 'cold-read')).toHaveLength(1)
    expect(scoped.agents.get(SessionId('cold-read'))).toBeUndefined()
    // A second reader resolves the same generation, not a new mount.
    expect(await scoped.agentPresets.standingKeyFor('cold-read')).toBe(key)
  })

  it('refuses to mount a generation it cannot stamp', async () => {
    const { scoped, path } = await editable('unstampable')
    await rm(path)

    // Discovery would refuse the preset too; a caller that resolved just
    // before the deletion must get a mount failure, not an unstamped
    // generation that no later edit could ever refresh.
    const racer = scoped.agentPresets as unknown as {
      ensureStanding(preset: { id: string; trust: 'user'; path: string }): Promise<unknown>
    }
    await expect(racer.ensureStanding({ id: 'unstampable', trust: 'user', path }))
      .rejects.toMatchObject({ code: 'agent-preset/invalid' })
    expect(livePresetMounts().filter(mount => mount.presetId === 'unstampable')).toHaveLength(0)
  })

  it('keeps serving the mounted generation when the file cannot be statted', async () => {
    const { scoped, path } = await editable('stale')
    await agentOn(scoped, 'sess-stale-served', 'stale')
    expect(livePresetMounts().filter(mount => mount.presetId === 'stale')).toHaveLength(1)

    await rm(path)

    // Discovery refuses a preset whose composition cannot be statted, so the
    // public route cannot reach this state — but a caller that resolved just
    // before the deletion still can, and it must be served the standing
    // generation rather than failed over a stat.
    const racer = scoped.agentPresets as unknown as {
      ensureStanding(preset: { id: string; trust: 'user'; path: string }): Promise<unknown>
    }
    await racer.ensureStanding({ id: 'stale', trust: 'user', path })

    expect(livePresetMounts().filter(mount => mount.presetId === 'stale')).toHaveLength(1)
  })
})
