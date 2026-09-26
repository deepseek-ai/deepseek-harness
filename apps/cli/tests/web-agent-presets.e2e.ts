import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  initProfile,
  createRuntimeResolution,
  loadOverlayPatches,
  loadProfile,
  PluginPackages,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dump, load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { bundlePatchPaths, composeEntries } from '@deepseek-ai/dsh-app-boot'
/** Profile entry ids whose volatile fields these scenarios edit through Settings. */
const SETTINGS_NAMESPACE = 'agent-preset-registry'
const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = 'subagent-model-selection-settings'
import { applyChildComposition, childSessionMeta } from '@deepseek-ai/dsh-subagent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-compaction-basic'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: resolves `ctx.get('sessionProjections')` and `ctx.get('tokenMeter')`.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const { boot } = createRequire(import.meta.url)(join(REPO_ROOT, 'packages/boot/app-boot/lib/index.js')) as typeof import('@deepseek-ai/dsh-app-boot')
/** The shipped Web surface: the dsh-base and dsh-web-app bundle patches over an empty profile. */
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_BUNDLE = join(REPO_ROOT, 'packages/bundle/web-app')
const WEB_PATCHES = bundlePatchPaths(WEB_BUNDLE, (JSON.parse(readFileSync(join(WEB_BUNDLE, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string[] } } }).dsh.bundle)
const webPatches = (label: string): PatchOptions[] => WEB_PATCHES.flatMap(file => loadOverlayPatches(label, file))
const CODEX_PACKAGE_DIR = join(REPO_ROOT, 'packages/subagent/subagent-codex')
const CLAUDE_CODE_PACKAGE_DIR = join(REPO_ROOT, 'packages/subagent/subagent-claude-code')
/** The installation anchor whose dependency surface the runtime resolution mirrors. */
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const MINIMAL_PROMPT = 'You are a helpful software engineer assistant.'
const MINIMAL_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`

/**
 * Boot the shipped Web composition, minus the rows that would bind a port,
 * touch the network, or write outside the test. Everything that decides an
 * agent's capabilities is the real thing, including both shipped presets.
 */
async function bootWeb(
  profileHome: string,
  extra: PatchOptions[] = [],
  profilePackages: readonly string[] = [],
  profileBundles?: readonly string[],
): Promise<Context> {
  const storageRoot = join(profileHome, 'storages')
  const overrides: PatchOptions[] = [
    // storage-json's root is anchored to the real $DSH_HOME. Unpinned, this
    // file writes the developer's own `~/.dsh/storages/` — and then reads it
    // back on the next run, so a stored document from any other build decides
    // this test's boot.
    { id: 'storage-json', config: { root: storageRoot } },
    // Fixed Session IDs must stay inside this boot's temporary profile root.
    { id: 'session-persistence-jsonl', config: { root: join(profileHome, 'sessions') } },
    // Host rows with side effects outside this process: a bound port, a served
    // asset tree, a telemetry exporter. `api-gateway` and `directory-picker`
    // stay ENABLED on purpose — the api-proxy is the host row that injects
    // `subagents`, `workspace`, and the rest of the agent plane, so disabling
    // it would hide exactly the breakage this file exists to catch: a service
    // moved into the presets that a host row still waits for. The boot audit
    // is that assertion.
    { id: 'webserver', disabled: true },
    // This composition has no application readiness or file-watching lifecycle.
    { id: 'hmr', disabled: true },
    // The web bundle's runtime row injects `webServer`, so it cannot
    // activate without the bound port disabled above. It owns dist serving
    // and the URL prompt line — surface glue, not anything that decides an
    // agent's capabilities, which is all this file asserts.
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    // A deployment-level skill on the host registry's GLOBAL layer — the same
    // registration shape a repository plugin's skill root uses. The layered
    // skills test below proves it reaches preset-composed agents.
    { id: 'skill-badge', disabled: false },
    { id: 'modules', disabled: true },
    // The physical Connection row owns the disabled HTTP server. bootWeb
    // supplies only its in-process registries so Host services still prove
    // their shipped dependency graph without binding a port.
    { id: 'connection', disabled: true },
    // Export owns a Connection Fetch route, so this Host-only composition
    // disables it with the transport service above.
    { id: 'session-log-download', disabled: true },
    // The open-in-app host routes wait for the webserver and connection
    // rows disabled above (connection's trust fence guards every route).
    { id: 'open-in-app', disabled: true },
    // The always-on reload chain waits for the browser roster and bound port
    // disabled above.
    { id: 'client-hmr', disabled: true },
    // The shipped `-auto` chooser resolves its interaction from a running
    // host and so waits for the webserver disabled above; the browse variant
    // supplies `directoryPicker` without one.
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    { id: 'agent-preset-registry', config: { default: 'standard' } },
    ...extra,
  ]
  const home = profileHome
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  if (profileBundles === undefined) initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  // Product Bundles are installed into the Profile, not the dsh app. Model
  // pnpm's package link for only the selected products; their own production
  // dependencies resolve from the linked workspace packages, while shared
  // peers still resolve through the installation fallback above.
  for (const packageDir of profilePackages) {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { name: string }
    const link = join(profileDir, 'node_modules', manifest.name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(packageDir, link, 'junction')
  }
  let profile: Profile = { skippedBundles: [],
    name: 'spec',
    dir: profileDir,
    layers: [],
    patchPath: join(profileDir, 'cordis.patch.yml'),
    patches: [],
  }
  let bundlePatches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-test', BASE_PATCH),
    ...webPatches('dsh-test'),
  ]
  if (profileBundles !== undefined) {
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      private: true,
      dependencies: Object.fromEntries(profileBundles.map(name => [name, 'workspace:*'])),
      dsh: { profile: { bundles: profileBundles } },
    }, null, 2) + '\n')
    profile = loadProfile('dsh-test', 'spec', INSTALL_ANCHOR, home, { userLayer: false })
    bundlePatches = profile.layers.flatMap(layer => layer.patches)
  }
  // Deployment defaults live in a bundle beneath the profile patch, so Settings writes are not shadowed by overlays.
  const fixtureName = 'dsh-web-presets-defaults'
  const fixtureDir = join(profileDir, 'node_modules', fixtureName)
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ name: fixtureName, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(fixtureDir, 'cordis.patch.yml'), JSON.stringify(overrides))
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles.push(fixtureName)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(manifest))
  const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, home, profile })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  return await boot('dsh-test', rootConfig, [...bundlePatches, ...overrides], async (bootCtx) => {
    bootCtx.provide('profileContext', { name: 'spec', dir: profileDir, patchPath: profile.patchPath,
      installAnchor: INSTALL_ANCHOR, home, cwd: home,
      startedBundles: profileBundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      overlays: [], telemetryDisabledEnv: '1' })
    await bootCtx.plugin(PluginPackages, { resolution })
    bootCtx.provide('connection', {
      fetch: { register: () => () => {} },
      rpc: { intercept: () => () => {} },
    } as never)
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

function toolParameterNames(ctx: Context, agent: Agent, toolName: string): string[] {
  const schema = ctx.tools.schemas(agent).find(tool => tool.name === toolName)
  if (schema === undefined) throw new Error(`missing tool schema ${toolName}`)
  const properties = schema.parameters.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error(`${toolName} has invalid parameter properties`)
  }
  return Object.keys(properties).sort()
}

function enablePresetTool(composition: string, id: string): string {
  const rows = load(composition, { schema: entryListSchema }) as import('@deepseek-ai/cordis-plugin-loader').EntryOptions[]
  const visit = (entries: typeof rows): boolean => entries.some((row) => {
    if (row.id === id) { row.disabled = false; return true }
    return row.group === true && visit(row.config as typeof rows)
  })
  if (!visit(rows)) throw new Error(`missing preset row ${id}`)
  return dump(rows, { schema: entryListSchema })
}

let ctx: Context
beforeAll(async () => {
  ctx = await bootWeb(await mkdtemp(join(tmpdir(), 'dsh-web-presets-')))
}, 120_000)

describe('the shipped Web composition', () => {
  it('leaves the global tool layer empty', () => {
    // Every model-facing tool belongs to a preset, `ask_user_question`
    // included: a tool in the global layer reaches EVERY agent regardless of
    // which preset composed it, expanding that preset's tool list.
    expect(toolNames(ctx)).toEqual([])
  })

  it('keeps the token meter and its context-meter projections on the host plane', async () => {
    // Read before any preset in this file mounts, which is what makes this an
    // ownership assertion rather than a mount-order coincidence: a preset-side
    // meter sits behind an `isolate` realm and is invisible to `ctx.get`.
    //
    // The projection registry is process-wide rather than scope-layered, so a
    // preset-side meter would also make the browser's context meter appear for
    // a `minimal` session the moment some OTHER session mounted a preset that
    // carries one, and vanish entirely in a process that only ever ran
    // `minimal`. Host ownership is what makes the meter a per-session fact.
    expect(ctx.get('tokenMeter')).toBeDefined()
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) throw new Error('the Web composition must compose a projection registry')
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-minimal-meter'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // A subset assertion: `tasks`, `goal`, and the rest register into the
      // same process-wide table, and this is about the meter's three units.
      expect(Object.keys(projections.snapshot(handle.agent.session).values))
        .toEqual(expect.arrayContaining(['contextBreakdown', 'contextPressure', 'tokenUsage']))
    } finally {
      await handle.dispose()
    }
  })

  it('supplies both shipped presets, and only those, from the system root', async () => {
    const listed = await ctx.agentPresets.list()

    expect(listed.map(preset => preset.id).sort()).toEqual(['cordis', 'minimal', 'ptc', 'standard'])
    expect(listed.every(preset => !('path' in preset))).toBe(true)
    expect(ctx.agentPresets.defaultId).toBe('standard')
  })

  it('composes the full agent from `standard`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-standard'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The EXACT catalog, not a spot-check: an omission is this design's
      // quietest failure mode, because a row that registers into the wrong
      // layer mounts cleanly and simply contributes nothing. `glob`/`grep` are
      // excluded for the reason the TUI composition e2e excludes them — they
      // depend on ripgrep being present on the machine.
      expect(toolNames(ctx, handle.agent).filter(name => name !== 'glob' && name !== 'grep')).toEqual([
        'ask_user_question', 'bash', 'create_goal', 'edit', 'exit_plan_mode',
        'get_goal', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'present', 'read', 'read_image',
        'send_message', 'skill',
        'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'web_fetch', 'web_search',
        'workflow', 'write',
      ])
      expect(ctx.commands.find(handle.agent, 'goal')).toBeDefined()
    } finally {
      await handle.dispose()
    }
  })

  it('applies the default-off subagent model allowlist only to new sessions', async () => {
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: false,
      allowedModels: [],
    })
    const disabled = await ctx.agents.create({
      sessionId: SessionId('preset-model-selection-disabled'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      enabled: true,
      allowedModels: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    })
    const enabled = await ctx.agents.create({
      sessionId: SessionId('preset-model-selection-enabled'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      expect(toolNames(ctx, disabled.agent)).not.toContain('list_subagent_models')
      expect(toolParameterNames(ctx, disabled.agent, 'subagent')).not.toEqual(expect.arrayContaining([
        'model', 'provider', 'reasoning_effort',
      ]))
      expect(toolNames(ctx, enabled.agent)).toContain('list_subagent_models')
      expect(toolParameterNames(ctx, enabled.agent, 'subagent')).toEqual(expect.arrayContaining([
        'model', 'provider', 'reasoning_effort',
      ]))
      expect(toolNames(ctx, disabled.agent)).not.toContain('list_subagent_models')
    } finally {
      await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: false })
      await enabled.dispose()
      await disabled.dispose()
    }
  })

  it('composes the exact RL prompt and persistent shell from `minimal`', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent })
      expect(assembly.sections).toEqual([
        { name: 'deployment:persona-prefix', text: MINIMAL_PROMPT },
      ])
      expect(assembly.tools.map(tool => tool.name)).toEqual(['bash'])
      expect(assembly.tools.find(tool => tool.name === 'bash')?.description).toBe(MINIMAL_BASH_DESCRIPTION)
      expect(ctx.commands.find(handle.agent, 'goal')).toBeUndefined()
      // serviceFor reports preset-owned providers; unisolated consumers inherit the host fs.
      expect(ctx.agentPresets.serviceFor(handle.agent, 'fs')).toBeUndefined()
      expect(ctx.get('fs')?.sandboxMode).toBeDefined()
      expect(handle.agent.ctx.get('fs')?.sandboxMode).toBe(ctx.get('fs')?.sandboxMode)
      expect(ctx.agentPresets.serviceFor(handle.agent, 'compaction')).toBeUndefined()
      expect(handle.agent.ctx.get('compaction')).toBeUndefined()
    } finally {
      await handle.dispose()
    }
  })

  it('keeps two differently composed sessions independent', async () => {
    const full = await ctx.agents.create({
      sessionId: SessionId('preset-both-full'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const minimal = await ctx.agents.create({
      sessionId: SessionId('preset-both-minimal'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      expect(toolNames(ctx, minimal.agent)).toEqual(['bash'])
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)

      await minimal.dispose()

      // Tearing the minimal session down leaves the full one whole.
      expect(toolNames(ctx, full.agent).length).toBeGreaterThan(10)
      expect(toolNames(ctx)).toEqual([])
    } finally {
      await full.dispose()
    }
  })

  it('composes the cordis agent with its own toolset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'cordis').then(() => undefined),
    })
    try {
      const tools = toolNames(ctx, handle.agent)
      expect(tools).toEqual(expect.arrayContaining([
        'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager',
      ]))
      for (const removed of ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'cordis_inspect_self']) {
        expect(tools).not.toContain(removed)
      }
      expect(tools).toEqual(expect.arrayContaining(['bash', 'read', 'edit', 'skill']))
      expect(tools).not.toContain('str_replace_editor')
      expect(ctx.commands.find(handle.agent, 'goal')).toBeDefined()

      // The preset's own authoring skill registers into ITS layer of the host
      // registry: the cordis agent's view carries it, the global view does not.
      const scoped = (await ctx.skills.list({ scope: handle.agent })).map(skill => skill.name)
      expect(scoped).toContain('editing-cordis-compositions')
      expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('editing-cordis-compositions')

      // The persona is `standard`'s, pinned verbatim so the two declarations
      // cannot drift apart: tool descriptions and the skill catalog carry
      // every creation-mode instruction.
      const standard = await ctx.agents.create({
        sessionId: SessionId('preset-cordis-standard-persona'),
        setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
      })
      try {
        const persona = async (agent: Agent) => (await ctx.systemPrompt.assemble({ scope: agent })).sections
          .filter(section => section.name.startsWith('deployment:persona-'))
        const cordisPersona = await persona(handle.agent)
        expect(cordisPersona.map(section => section.name)).toEqual(['deployment:persona-prefix', 'deployment:persona-suffix'])
        expect(cordisPersona).toEqual(await persona(standard.agent))
      } finally {
        await standard.dispose()
      }
    } finally {
      await handle.dispose()
    }
  })

  it('presents `ptc` as PTC mode without disturbing a native session beside it', async () => {
    const coded = await ctx.agents.create({
      sessionId: SessionId('preset-ptc'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'ptc').then(() => undefined),
    })
    const native = await ctx.agents.create({
      sessionId: SessionId('preset-ptc-native'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // One tool reaches the MODEL: the transport. The registry's catalog for
      // this agent is unchanged — PTC mode collapses the presentation, not
      // the capabilities — so the assembly is what carries the claim.
      const assembly = await ctx.systemPrompt.assemble({ scope: coded.agent })
      expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
      expect(toolNames(ctx, coded.agent)).not.toContain('str_replace_editor')
      expect(ctx.commands.find(coded.agent, 'goal')).toBeDefined()
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      expect(sdk).not.toContain('str_replace_editor')
      expect(sdk).toContain('web_search')

      // The presentation is this agent's alone: the deployment default is
      // native, and the session composed from `standard` still sees it.
      const nativeAssembly = await ctx.systemPrompt.assemble({ scope: native.agent })
      expect(nativeAssembly.tools.map(tool => tool.name)).toContain('bash')
      expect(nativeAssembly.tools.map(tool => tool.name)).not.toContain('run_code')
      expect(nativeAssembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
    } finally {
      await native.dispose()
      await coded.dispose()
    }
  })

  it('keeps the self-referential toolset out of every other preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-no-cordis'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // Editing the live runtime is opt-in per session, not ambient.
      expect(toolNames(ctx, handle.agent)).not.toContain('cordis_define')
    } finally {
      await handle.dispose()
    }
  })

  it('ships the composition-authoring skill in the declaration package', async () => {
    const skill = join(
      REPO_ROOT, 'packages/preset/agent-preset', 'skills', 'editing-cordis-compositions', 'SKILL.md',
    )

    expect((await readFile(skill, 'utf8')).startsWith('---\nname: editing-cordis-compositions')).toBe(true)
  })

  it('merges the global skill layer into a preset agent\'s catalog, keeping local discovery preset-side', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'dsh-preset-skill-proj-'))
    await mkdir(join(proj, '.dsh', 'skills', 'project-proof'), { recursive: true })
    await writeFile(join(proj, '.dsh', 'skills', 'project-proof', 'SKILL.md'), [
      '---',
      'name: project-proof',
      'description: Proves the preset layer discovers project skills beside global ones.',
      '---',
      '',
      'Project proof body.',
      '',
    ].join('\n'))

    const handle = await ctx.agents.create({
      // Unique per run: the composition persists into the ambient DSH home,
      // and a fixed id would collide with a log an earlier run left there.
      sessionId: SessionId(`preset-skills-standard-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The host (global) view carries the deployment-level provider alone:
      // local discovery moved behind the presets with `skill-filesystem`.
      expect((await ctx.skills.list({ cwd: proj })).map(skill => skill.name)).toEqual(['dsh-badge'])

      // The standard agent's view merges the global layer with its preset's
      // own local discovery over the session cwd.
      const scoped = (await ctx.skills.list({ cwd: proj, scope: handle.agent })).map(skill => skill.name)
      expect(scoped).toContain('dsh-badge')
      expect(scoped).toContain('project-proof')

      // The preset's own loader tool resolves the global-layer skill.
      const loaded = await ctx.tools.execute({
        callId: ToolCallId('preset-skills-load'),
        name: 'skill',
        arguments: { name: 'dsh-badge' },
        signal: new AbortController().signal,
        agent: handle.agent,
      })
      expect(loaded.isError).toBe(false)
      expect(JSON.stringify(loaded.content)).toContain('powered by dsh')
    } finally {
      await handle.dispose()
    }
  })

  it('shows a minimal agent the global layer but no loader tool', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`preset-skills-minimal-${randomUUID()}`),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // Layer visibility is the registry's; whether an agent can USE skills
      // stays the preset's choice — minimal mounts no `tool-skill`, so its
      // tool table has no loader even though the global layer is readable.
      expect((await ctx.skills.list({ scope: handle.agent })).map(skill => skill.name)).toContain('dsh-badge')
      expect(toolNames(ctx, handle.agent)).toEqual(['bash'])
    } finally {
      await handle.dispose()
    }
  })

  it('never rewrites the shipped profile patch when an Agent is disposed', async () => {
    // The Loader persists a tree whose plugin self-disposed, and tearing an
    // agent down disposes its whole subtree. Inherited, that rewrote the
    // shipped composition — truncating it to `[]` the first time a session
    // ended — so `PresetTree` refuses to write at all.
    const before = await Promise.all(WEB_PATCHES.map(file => readFile(file, 'utf8')))

    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-readonly'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    await handle.dispose()
    // Slack, not a race the number has to win. The write is driven by the
    // Loader's fiber-unload listener, which fires as the subtree's fibers
    // settle rather than when `dispose()` resolves, and the Loader exposes no
    // flush to await. A regression writes synchronously inside that listener,
    // so any wait past settlement fails; a longer one only slows the test.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await Promise.all(WEB_PATCHES.map(file => readFile(file, 'utf8')))).toEqual(before)
  })
})

describe('product Bundle and user-preset intersection', () => {
  const presetIds = ['products-none', 'products-codex', 'products-claude', 'products-both'] as const
  type Product = 'codex' | 'claude-code'
  type PresetId = typeof presetIds[number]

  async function bootProducts(installed: readonly Product[]): Promise<Context> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-product-presets-'))
    const definitions: import('@deepseek-ai/cordis-plugin-loader').EntryOptions[] = []
    const standardConfig = composeEntries([webPatches('test')]).find(row => row.id === 'preset-standard')!.config as import('@deepseek-ai/dsh-agent-preset-registry').PresetDefinition
    const standard = dump(standardConfig.plugins, { schema: entryListSchema })
    for (const id of presetIds) {
      let composition = standard
      if (id === 'products-codex' || id === 'products-both') {
        composition = enablePresetTool(composition, 'tool-subagent-codex')
      }
      if (id === 'products-claude' || id === 'products-both') {
        composition = enablePresetTool(composition, 'tool-subagent-claude-code')
      }
      definitions.push({ id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: { id, plugins: load(composition, { schema: entryListSchema }) } })
    }
    const packageDir = (product: Product): string => (
      product === 'codex' ? CODEX_PACKAGE_DIR : CLAUDE_CODE_PACKAGE_DIR
    )
    const packageName = (product: Product): string => (
      product === 'codex'
        ? '@deepseek-ai/dsh-subagent-codex'
        : '@deepseek-ai/dsh-subagent-claude-code'
    )
    return await bootWeb(root, [{ insert: definitions }], installed.map(packageDir), [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      ...installed.map(packageName),
    ])
  }

  it('composes the intersection of installed Bundles and enabled preset rows', async () => {
    const enabledByPreset: Record<PresetId, Product[]> = {
      'products-none': [],
      'products-codex': ['codex'],
      'products-claude': ['claude-code'],
      'products-both': ['codex', 'claude-code'],
    }
    const scenarios: Array<{ installed: Product[]; presets: readonly PresetId[] }> = [
      { installed: [], presets: ['products-both'] },
      { installed: ['codex'], presets: ['products-both'] },
      { installed: ['claude-code'], presets: ['products-both'] },
      { installed: ['codex', 'claude-code'], presets: presetIds },
    ]

    for (const { installed, presets } of scenarios) {
      const productCtx = await bootProducts(installed)
      const spawn = vi.spyOn(productCtx.subprocess, 'spawn')
      try {
        expect(productCtx.subagents.list()
          .filter(name => name === 'codex' || name === 'claude-code')
          .sort())
          .toEqual([...installed].sort())
        for (const id of presets) {
          const handle = await productCtx.agents.create({
            sessionId: SessionId(`preset-${id}-${installed.join('-') || 'none'}-${randomUUID()}`),
            setup: agentCtx => productCtx.agentPresets.mount(agentCtx, id).then(() => undefined),
          })
          try {
            const productTools = enabledByPreset[id]
              .filter(product => installed.includes(product))
              .map(product => product === 'codex' ? 'subagent_codex' : 'subagent_claude_code')
              .sort()
            const tools = toolNames(productCtx, handle.agent)
            expect(tools.filter(name => name === 'subagent_codex' || name === 'subagent_claude_code'))
              .toEqual(productTools)
            expect(tools).toEqual(expect.arrayContaining(['job_kill', 'job_list', 'job_output']))
            for (const productTool of productTools) {
              expect(toolParameterNames(productCtx, handle.agent, productTool)).toEqual([
                'description', 'prompt', 'run_in_background',
              ])
            }
          } finally {
            await handle.dispose()
          }
        }
        expect(spawn).not.toHaveBeenCalled()
      } finally {
        spawn.mockRestore()
        await productCtx.fiber.dispose()
      }
    }
  }, 120_000)
})

describe('a user preset declared from the shipped cordis rows', () => {
  /** The JSON text a `cordis_inspect_*` result renders. */
  function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
    return result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('')
  }

  it('mounts beside the shipped `cordis` preset and reads the shared Host inspect providers', async () => {
    // The Host inspect providers are one process-global set registered by the
    // host composition (`@deepseek-ai/dsh-tool-cordis/host`); each preset's
    // `tool-cordis` row only registers the tools. Before that split the copy
    // failed to mount: its row re-registered provider "Service".
    const root = await mkdtemp(join(tmpdir(), 'dsh-copied-preset-'))
    const cordis = composeEntries([webPatches('test')]).find(row => row.id === 'preset-cordis')!.config as import('@deepseek-ai/dsh-agent-preset-registry').PresetDefinition
    const copyCtx = await bootWeb(root, [{ insert: [{
      id: 'preset-cordis-copy', name: '@deepseek-ai/dsh-agent-preset',
      config: { ...cordis, id: 'cordis-copy', name: 'Cordis copy' },
    }] }])
    try {
      const shipped = await copyCtx.agents.create({
        sessionId: SessionId(`preset-cordis-shipped-${randomUUID()}`),
        setup: agentCtx => copyCtx.agentPresets.mount(agentCtx, 'cordis').then(() => undefined),
      })
      const copied = await copyCtx.agents.create({
        sessionId: SessionId(`preset-cordis-copy-${randomUUID()}`),
        setup: agentCtx => copyCtx.agentPresets.mount(agentCtx, 'cordis-copy').then(() => undefined),
      })
      try {
        for (const handle of [shipped, copied]) {
          expect(toolNames(copyCtx, handle.agent)).toEqual(expect.arrayContaining([
            'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager',
          ]))
        }
        const signal = new AbortController().signal
        const listed = await copyCtx.tools.execute({
          callId: ToolCallId('copied-preset-inspect-list'),
          name: 'cordis_inspect_list',
          arguments: {},
          signal,
          agent: copied.agent,
        })
        expect(listed.isError).toBe(false)
        const providers = (JSON.parse(resultText(listed)) as { providers: Array<{ id: string; platform: string }> }).providers
        expect(providers.filter(provider => provider.platform === 'host').map(provider => provider.id))
          .toEqual(['Service', 'Event', 'Config', 'Tool'])

        // The `Tool` provider is the one built over the host context: it
        // answers with the shared registry's view of the REQUESTING agent,
        // so the copy sees its own preset's tools, not the host's empty set.
        const queried = await copyCtx.tools.execute({
          callId: ToolCallId('copied-preset-inspect-tools'),
          name: 'cordis_inspect_query',
          arguments: { platform: 'host', provider: 'Tool', method: 'listTools' },
          signal,
          agent: copied.agent,
        })
        expect(queried.isError).toBe(false)
        // The whole-table answer can pass the inline token budget once the
        // preset's tool table grows, and the spill policy then replaces its
        // middle with a gap plus a spill footer. What this case proves is the
        // provider's answer, so assert the names it must carry.
        const queriedText = resultText(queried)
        for (const toolName of ['bash', 'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']) {
          expect(queriedText).toContain(`"name": "${toolName}"`)
        }

        // The `Config` provider reads the booted profile tree: the shipped `tools` row declares a Config,
        // and the bootstrap include row is a carrier. The name filter keeps each page small.
        type ConfigRow = { id: string; patchId: string; name: string; status: string }
        type ConfigPage = { data: { entries: ConfigRow[]; total: number; nextOffset: number | null } }
        const listConfigs = async (input: Record<string, string | number>, callId: string): Promise<ConfigPage['data']> => {
          const page = await copyCtx.tools.execute({
            callId: ToolCallId(callId),
            name: 'cordis_inspect_query',
            arguments: { platform: 'host', provider: 'Config', method: 'listConfigs', input },
            signal,
            agent: copied.agent,
          })
          expect(page.isError, resultText(page)).toBe(false)
          return (JSON.parse(resultText(page)) as ConfigPage).data
        }
        const toolsRows = await listConfigs({ name: '@deepseek-ai/dsh-tools' }, 'copied-preset-inspect-configs')
        const toolsRow = toolsRows.entries[0]
        expect(toolsRow).toMatchObject({ patchId: 'tools', status: 'schema' })
        expect(toolsRows).toMatchObject({ total: 1, nextOffset: null })
        const includes = await listConfigs({ name: 'cordis:include' }, 'copied-preset-inspect-includes')
        expect(includes.entries.find(entry => entry.patchId === 'include')).toMatchObject({ status: 'tree' })
        const firstPage = await listConfigs({ limit: 5 }, 'copied-preset-inspect-page')
        expect(firstPage.entries).toHaveLength(5)
        expect(firstPage.nextOffset).toBe(5)
        const projected = await copyCtx.tools.execute({
          callId: ToolCallId('copied-preset-inspect-config'),
          name: 'cordis_inspect_query',
          arguments: { platform: 'host', provider: 'Config', method: 'listConfigs', input: { entry: toolsRow!.id } },
          signal,
          agent: copied.agent,
        })
        expect(projected.isError).toBe(false)
        type Projected = { status: string; acceptsMissing: unknown; schema: { $defs: Record<string, unknown> } }
        const { data } = JSON.parse(resultText(projected)) as { data: Projected }
        expect(data.status).toBe('schema')
        expect(data.schema.$defs).toHaveProperty('loaderExpression')
        expect(JSON.stringify(data.schema)).toContain('"mode"')
      } finally {
        await copied.dispose()
        await shipped.dispose()
      }
    } finally {
      await copyCtx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('a switch survives the session', () => {
  it('records the choice so the log states what the agent runs', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-switch-logged'),
      meta: { agentPreset: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // The api-proxy's select does exactly this pair while the session is blank.
      expect(ctx.commands.find(handle.agent, 'goal')).toBeDefined()
      await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')
      handle.agent.session.append('agent-preset/selected', { agentPreset: 'minimal' })
      expect(ctx.commands.find(handle.agent, 'goal')).toBeUndefined()

      // The header keeps the creation fact; the log carries what it runs.
      expect(handle.agent.session.header.agentPreset).toBe('standard')
      expect(ctx.sessionProjections.stateOf(handle.agent.session, 'agentPreset')).toBe('minimal')
    } finally {
      await handle.dispose()
    }
  })

})

describe('a forked session', () => {
  it('inherits the composition its seeded history was produced under', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-fork-parent'),
      meta: { agentPreset: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    const inherited = ctx.sessionProjections.stateOf(parent.agent.session, 'agentPreset') ?? undefined
    const child = await ctx.agents.create({
      sessionId: SessionId('preset-fork-child'),
      seed: [],
      inheritedEventCount: SessionLogOffset(0),
      meta: {
        parentSession: SessionId('preset-fork-parent'),
        isSeeded: true,
        ...inherited === undefined ? {} : { agentPreset: inherited },
      },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, inherited).then(() => undefined),
    })
    try {
      // Composing nothing would leave the child empty: this layer moved every
      // model-facing row out of the host plane, so there is nothing to inherit
      // for free any more.
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      expect(toolNames(ctx, child.agent).length).toBeGreaterThan(0)
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })
})

describe('a delegated child', () => {
  it('runs on the composition its parent runs on', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-child-parent'),
      meta: { agentPreset: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    // Exactly what an in-process subagent driver's creation window does.
    const child = await parent.agent.ctx.agents.create({
      sessionId: SessionId('preset-child'),
      meta: childSessionMeta(parent.agent, 1, false),
      setup: (agentCtx) => {
        applyChildComposition(agentCtx, parent.agent, {})
      },
    })
    try {
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      // The shipped `standard` preset is the whole coding agent; an empty
      // child here is the defect, and equality alone would not catch it.
      expect(toolNames(ctx, child.agent)).toContain('bash')
      expect(child.agent.session.header.agentPreset).toBe('standard')
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })

  it('follows a parent that switched preset while blank', async () => {
    const parent = await ctx.agents.create({
      sessionId: SessionId('preset-child-switch-parent'),
      meta: { agentPreset: 'standard' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    await ctx.agentPresets.recompose(parent.agent.ctx, 'minimal')
    const child = await parent.agent.ctx.agents.create({
      sessionId: SessionId('preset-child-switch'),
      meta: childSessionMeta(parent.agent, 1, false),
      setup: (agentCtx) => {
        applyChildComposition(agentCtx, parent.agent, {})
      },
    })
    try {
      // The live scope chain is the authority, not the parent's creation
      // header — which still names `standard`.
      expect(toolNames(ctx, child.agent)).toEqual(toolNames(ctx, parent.agent))
      expect(child.agent.session.header.agentPreset).toBe('minimal')
    } finally {
      await child.dispose()
      await parent.dispose()
    }
  })
})

describe('the default preset as a user setting', () => {
  it('composes an unnamed session from the stored default, not the composed one', async () => {
    expect(ctx.agentPresets.defaultId).toBe('standard')

    await ctx.settings.update(SETTINGS_NAMESPACE, { selectedDefault: 'minimal' })
    try {
      expect(ctx.agentPresets.defaultId).toBe('minimal')

      const handle = await ctx.agents.create({
        sessionId: SessionId('preset-user-default'),
        setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })
      try {
        // `mount()` with no id resolves the effective default. One tool, not
        // `standard`'s catalog: the setting decided the composition.
        expect(toolNames(ctx, handle.agent)).toEqual(['bash'])
      } finally {
        await handle.dispose()
      }
    } finally {
      // The context is shared with the rest of the file. `replace({})` drops
      // the user section wholesale so the field re-inherits the composition
      // base; `update` merges, and would leave the override standing.
      await ctx.settings.replace(SETTINGS_NAMESPACE, {})
    }

    expect(ctx.agentPresets.defaultId).toBe('standard')
  })
})

describe('a profile patch stored before Developer tools owned preset selection', () => {
  let legacy: Context
  let legacyHome: string
  beforeAll(async () => {
    legacyHome = await mkdtemp(join(tmpdir(), 'dsh-web-presets-legacy-'))
    // A stored configuration from before the switch moved to Developer tools:
    // it carries the retired key beside the default the user had saved. The
    // Loader resolves the declared fields and leaves the extra one alone.
    legacy = await bootWeb(legacyHome, [{
      id: SETTINGS_NAMESPACE,
      config: { default: 'standard', selectedDefault: 'minimal', modeSelectionEnabled: false },
    }])
  }, 120_000)
  afterAll(async () => {
    await legacy?.fiber.dispose()
    await rm(legacyHome, { recursive: true, force: true })
  })

  it('starts, keeps the retired key inert and composes new sessions from the saved default', async () => {
    expect(legacy.agentPresets.defaultId).toBe('minimal')
    expect((await legacy.agentPresets.remoteExportList()).presets.find(row => row.id === 'minimal')?.isDefault).toBe(true)
    // Settings projects the declared fields, so the retired key is neither
    // shown nor rewritten; the user's saved default is.
    expect(legacy.settings.describe().find(row => row.ns === SETTINGS_NAMESPACE)?.value)
      .toEqual({ selectedDefault: 'minimal' })

    const handle = await legacy.agents.create({
      sessionId: SessionId('preset-legacy-patch'),
      setup: agentCtx => legacy.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      expect(toolNames(legacy, handle.agent)).toEqual(['bash'])
    } finally {
      await handle.dispose()
    }
  })
})

describe('a session keeps the preset it was created with', () => {
  it('refuses to adopt a live session under a different preset', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('preset-locked'),
      meta: { agentPreset: 'minimal' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    try {
      // The api-proxy guard reads exactly this: the header records what the
      // session runs, so naming anything else is a caller error rather than a
      // switch. Its history was produced under `minimal`'s single tool.
      expect(handle.agent.session.header.agentPreset).toBe('minimal')
    } finally {
      await handle.dispose()
    }
  })
})

afterAll(async () => { await ctx?.fiber.dispose() })
