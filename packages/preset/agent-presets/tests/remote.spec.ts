/**
 * The agent-preset Remote namespace: the path-free roster a client reads, the
 * composition view behind the read-only viewer, and the per-session switch —
 * which is the only one of the three that mutates an agent.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { remoteErrorOf, type RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, METADATA_FILE } from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]
// A row naming a package, the way an authored preset's rows do. Health
// resolves every row it can prove will start, so a path reaching outside the
// temp preset directory these tests seed would report the composition broken.
const VALID = '- id: prompt\n  name: \'@deepseek-ai/dsh-system-prompt\'\n'

afterEach(() => vi.restoreAllMocks())

async function remoteFailure(operation: Promise<unknown>): Promise<RemoteFailure> {
  try {
    await operation
  } catch (error: unknown) {
    const failure = remoteErrorOf(error)
    if (failure === undefined) throw error
    return failure
  }
  throw new Error('expected the Remote operation to fail')
}

function availableOf(failure: RemoteFailure): readonly string[] {
  if (!('available' in failure.details)) throw new Error('expected available preset ids')
  const available: unknown = failure.details.available
  if (!Array.isArray(available)
    || !available.every((value: unknown): value is string => typeof value === 'string')) {
    throw new Error('expected available preset ids')
  }
  return available
}

function reasonOf(failure: RemoteFailure): string {
  if (!('reason' in failure.details)) throw new Error('expected a preset failure reason')
  const reason: unknown = failure.details.reason
  if (typeof reason !== 'string') throw new Error('expected a preset failure reason')
  return reason
}

async function harness(
  roster: Config = { default: 'standard', roots: ROOTS, includeShippedRoot: false, includeUserRoot: false },
): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
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

/** The recorded preset a restart replays, which is what a switch must move. */
const recordedPreset = (agent: Agent): unknown =>
  agent.session.snapshotEvents().findLast(event => event.type === 'agent-preset/selected')?.data

describe('the roster a client reads', () => {
  it('projects path-free rows, marking the default and carrying published metadata', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-remote-'))
    await mkdir(join(userRoot, 'documented'), { recursive: true })
    await writeFile(join(userRoot, 'documented', COMPOSITION_FILE), VALID)
    await writeFile(join(userRoot, 'documented', METADATA_FILE), 'name: 我的模式\ndescription: 只做检索。\n')
    const ctx = await harness({
      default: 'minimal',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' }, { path: userRoot, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    const roster = await ctx.agentPresets.remoteExportList()

    expect(roster.authorable).toBe(true)
    expect(roster.presets).toEqual([
      { id: 'minimal', trust: 'system', isDefault: true },
      { id: 'standard', trust: 'system', isDefault: false },
      { id: 'documented', trust: 'user', isDefault: false, name: '我的模式', description: '只做检索。' },
    ])
    // No row carries the composition's location: a preset is addressed by id
    // everywhere off the Host.
    expect(roster.presets.every(row => !('path' in row))).toBe(true)
  })

  it('keeps a broken preset on the roster with its reason', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-remote-'))
    await mkdir(join(userRoot, 'damaged'), { recursive: true })
    const ctx = await harness({
      default: 'standard',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' }, { path: userRoot, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    const roster = await ctx.agentPresets.remoteExportList()

    // The directory still occupies the id, so a surface must be able to show
    // and delete it; offering it for selection is what the reason prevents.
    expect(roster.presets.find(row => row.id === 'damaged')?.broken).toEqual(expect.any(String))
  })

  it('answers an empty roster with nothing authorable', async () => {
    const ctx = await harness({ default: 'standard', roots: [], includeShippedRoot: false, includeUserRoot: false })

    const roster = await ctx.agentPresets.remoteExportList()

    // Composing no presets is a valid deployment: every session then shares
    // the host composition, and nothing can be written either.
    expect(roster).toEqual({ presets: [], authorable: false })
  })
})

describe('reading one composition', () => {
  it('rejects an empty id before resolving it', async () => {
    const ctx = await harness()
    const resolve = vi.spyOn(ctx.agentPresets, 'resolve')

    await expect(ctx.agentPresets.readDocument(''))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('answers the stored text with the row it belongs to', async () => {
    const ctx = await harness()

    const document = await ctx.agentPresets.readDocument('standard')

    // The shipped set is readable: it is the known-good composition a copy
    // starts from, and trust is what tells a surface to say so.
    expect(document).toEqual({
      agentPreset: 'standard',
      trust: 'system',
      content: await ctx.agentPresets.read('standard'),
    })
  })

  it('carries the display metadata a preset published', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-remote-'))
    await mkdir(join(userRoot, 'documented'), { recursive: true })
    await writeFile(join(userRoot, 'documented', COMPOSITION_FILE), VALID)
    await writeFile(join(userRoot, 'documented', METADATA_FILE), 'name: 我的模式\ndescription: 只做检索。\n')
    const ctx = await harness({
      default: 'documented',
      roots: [{ path: userRoot, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    const document = await ctx.agentPresets.readDocument('documented')

    // The viewer titles the dialog from the published name, so both optional
    // fields have to survive the projection rather than only the id.
    expect(document).toEqual({
      agentPreset: 'documented',
      trust: 'user',
      content: VALID,
      name: '我的模式',
      description: '只做检索。',
    })
  })

  it('refuses an id no root supplies', async () => {
    const ctx = await harness()

    const failure = await remoteFailure(ctx.agentPresets.readDocument('never-existed'))

    expect(failure).toMatchObject({
      code: 'agent-preset/not-found',
      details: {
        agentPreset: 'never-existed',
      },
    })
    expect(failure.message)
      .toMatch(/^agent-presets: preset "never-existed" not found \(available: .+\)$/)
    expect(availableOf(failure)).toEqual(expect.arrayContaining(['minimal', 'standard']))
  })

  it('raises an unrelated read failure exactly as it was thrown', async () => {
    const ctx = await harness()
    const thrown = new Error('disk failed')
    vi.spyOn(ctx.agentPresets, 'read').mockRejectedValueOnce(thrown)

    await expect(ctx.agentPresets.readDocument('standard')).rejects.toBe(thrown)
  })
})

describe('authoring over Remote', () => {
  it('rejects empty source, target, and delete ids before authoring', async () => {
    const ctx = await harness()
    const copy = vi.spyOn(ctx.agentPresets, 'copy')
    const remove = vi.spyOn(ctx.agentPresets, 'remove')

    for (const operation of [
      () => ctx.agentPresets.remoteExportCopy('', 'mine'),
      () => ctx.agentPresets.remoteExportCopy('standard', ''),
      () => ctx.agentPresets.remoteExportDelete(''),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(copy).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('copies and deletes through the Remote adapters', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-remote-'))
    const ctx = await harness({
      default: 'standard',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' }, { path: userRoot, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    await ctx.agentPresets.remoteExportCopy('standard', 'mine', '我的模式')
    expect((await ctx.agentPresets.resolve('mine')).name).toBe('我的模式')

    await ctx.agentPresets.remoteExportDelete('mine')
    await expect(ctx.agentPresets.resolve('mine')).rejects.toThrow(/not found/)
  })

  it('preserves not-found details for an unknown copy source', async () => {
    const ctx = await harness()

    const failure = await remoteFailure(ctx.agentPresets.remoteExportCopy('never-existed', 'mine'))

    expect(failure).toMatchObject({
      code: 'agent-preset/not-found',
      details: {
        agentPreset: 'never-existed',
      },
    })
    expect(failure.message)
      .toMatch(/^agent-presets: preset "never-existed" not found \(available: .+\)$/)
    expect(availableOf(failure)).toEqual(expect.arrayContaining(['minimal', 'standard']))
  })

  it('preserves invalid-id and occupied-id failures', async () => {
    const ctx = await harness()

    const invalid = await remoteFailure(ctx.agentPresets.remoteExportCopy('standard', '../escape'))
    expect(invalid).toMatchObject({
      code: 'agent-preset/invalid',
      details: { agentPreset: '../escape' },
    })
    expect(reasonOf(invalid)).toContain('must match')

    const occupied = await remoteFailure(ctx.agentPresets.remoteExportCopy('standard', 'minimal'))
    expect(occupied).toMatchObject({
      code: 'agent-preset/invalid',
      details: { agentPreset: 'minimal' },
    })
    expect(reasonOf(occupied)).toContain('already exists')
  })

  it('keeps the requested id when no writable root exists', async () => {
    const ctx = await harness({
      default: 'standard',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    const failure = await remoteFailure(ctx.agentPresets.remoteExportCopy('standard', 'mine'))

    expect(failure).toMatchObject({
      code: 'agent-preset/read-only',
      details: { agentPreset: 'mine' },
    })
    expect(reasonOf(failure)).toContain('no user-writable preset root')
  })

  it('preserves read-only and not-found delete failures', async () => {
    const ctx = await harness()

    const readOnly = await remoteFailure(ctx.agentPresets.remoteExportDelete('standard'))
    expect(readOnly).toMatchObject({
      code: 'agent-preset/read-only',
      details: { agentPreset: 'standard' },
    })
    expect(reasonOf(readOnly)).toContain('ships with the deployment')

    const missing = await remoteFailure(ctx.agentPresets.remoteExportDelete('never-existed'))
    expect(missing).toMatchObject({
      code: 'agent-preset/not-found',
      details: { agentPreset: 'never-existed' },
    })
    expect(availableOf(missing)).toEqual(expect.arrayContaining(['minimal', 'standard']))
  })

  it('raises an unrelated authoring failure exactly as it was thrown', async () => {
    const ctx = await harness()
    const thrown = new Error('copy failed')
    vi.spyOn(ctx.agentPresets, 'copy').mockRejectedValueOnce(thrown)

    await expect(ctx.agentPresets.remoteExportCopy('standard', 'mine')).rejects.toBe(thrown)
  })
})

describe('switching one session\'s composition', () => {
  it('rejects an empty preset id before queuing a switch', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-empty', 'standard')
    const recompose = vi.spyOn(ctx.agentPresets, 'recompose')

    await expect(ctx.agentPresets.select(agent, ''))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(recompose).not.toHaveBeenCalled()
  })

  it('recomposes a blank session and records what it now runs', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-1', 'standard')

    expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')

    // The header is written once at creation, so the switch lives in the log:
    // that is what a restart replays and what every projection resolves from.
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('minimal')
    expect(recordedPreset(agent)).toEqual({ agentPreset: 'minimal' })
  })

  it('treats an absent turn boundary as no prior turn', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-no-turn-boundary', 'standard')
    const stateOf = ctx.sessionProjections.stateOf.bind(ctx.sessionProjections)
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'turnBoundary' ? undefined : stateOf(session, key)
    ))

    expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')
  })

  it('serializes two concurrent switches on one session', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-race', 'standard')

    // Both pass the blank check; unserialized, the second re-link finds the
    // record the first already replaced and two compositions end up in one
    // agent layer. A client's busy flag is not enforcement.
    await Promise.all([
      ctx.agentPresets.select(agent, 'minimal'),
      ctx.agentPresets.select(agent, 'standard'),
    ])

    // One winner, and the log agrees with it: the last committed switch.
    expect(recordedPreset(agent)).toEqual({ agentPreset: 'standard' })
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
  })

  it('refuses once the conversation has started', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-locked', 'standard')
    // One turn is enough: the history from here on was produced under
    // `standard`'s tools, and a swap would strand those tool calls.
    agent.session.append('turn/start', { turn: 0 })

    const failure = await remoteFailure(ctx.agentPresets.select(agent, 'minimal'))

    expect(failure).toMatchObject({
      code: 'agent-preset/locked',
      message: 'session "sel-locked" has already started; its agent preset is fixed',
      details: { sessionId: SessionId('sel-locked'), agentPreset: 'minimal' },
    })
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
    expect(recordedPreset(agent)).toBeUndefined()
  })

  it('leaves the session on its composition when the named preset is unknown', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-unknown', 'standard')

    const failure = await remoteFailure(ctx.agentPresets.select(agent, 'nope'))

    expect(failure).toMatchObject({
      code: 'agent-preset/not-found',
      details: { agentPreset: 'nope' },
    })
    expect(availableOf(failure)).toEqual(expect.arrayContaining(['minimal', 'standard']))
    // Resolution happens before any re-link, and nothing is recorded until the
    // swap commits.
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
    expect(recordedPreset(agent)).toBeUndefined()
  })

  it('serves a later switch after one was refused', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-after-failure', 'standard')

    await expect(ctx.agentPresets.select(agent, 'nope')).rejects.toThrow(/not found/)

    // The queue holds a failure-swallowing guard, so a refused switch does not
    // reject the next caller's chain.
    expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')
  })

  it('reports an unusable composition with its discovery reason', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-remote-'))
    await mkdir(join(userRoot, 'damaged'), { recursive: true })
    const ctx = await harness({
      default: 'standard',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' }, { path: userRoot, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })
    const agent = await agentOn(ctx, 'sel-broken', 'standard')

    const failure = await remoteFailure(ctx.agentPresets.select(agent, 'damaged'))

    expect(failure).toMatchObject({
      code: 'agent-preset/invalid',
      details: { agentPreset: 'damaged' },
    })
    expect(reasonOf(failure)).not.toBe('')
  })

  it('raises an unrelated switch failure exactly as it was thrown', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sel-internal', 'standard')
    const thrown = new Error('mount failed')
    vi.spyOn(ctx.agentPresets, 'recompose').mockRejectedValueOnce(thrown)

    await expect(ctx.agentPresets.select(agent, 'minimal')).rejects.toBe(thrown)
  })
})
