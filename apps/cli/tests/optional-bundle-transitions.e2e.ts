/** Optional bundles through the shipped Web Loader, live package manager, and real Agent loop. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-hmr'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const installAnchor = join(root, 'apps/cli/package.json')
const bundles = {
  search: '@deepseek-ai/dsh-experimental-session-search',
  ralph: '@deepseek-ai/dsh-experimental-ralph-bundle',
  terminal: '@deepseek-ai/dsh-experimental-terminal-bundle',
  badge: '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  titles: '@deepseek-ai/dsh-experimental-session-titles-bundle',
} as const
type Response = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[])

/** Only the external model is scripted; tools and child Agents use the shipped implementations. */
class BundleModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly scripts = new Map<string, Response[]>()
  private titleNumber = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (request.purpose === 'session-title') {
      yield* textResponse(`Bundle title ${String(++this.titleNumber)}`)
      return
    }
    if (request.tools?.some(tool => tool.name === 'structured_output')) {
      yield* toolCallResponse(`report-${randomUUID()}`, 'structured_output', {
        status: 'complete', summary: 'OPTIONAL_RALPH_DONE', evidence: ['The scripted worker completed.'], nextSteps: [], blocker: '',
      })
      return
    }
    const response = this.scripts.get(request.sessionId ?? '')?.shift()
    if (response === undefined) throw new Error(`No scripted model response for ${String(request.sessionId)}`)
    yield* typeof response === 'function' ? response(request) : response
  }
}

describe.skipIf(!existsSync(join(root, 'apps/cli/lib/bin.js')))('Official optional bundle transitions', { retry: 0 }, () => {
  let ctx: Context
  let temporary: string
  let workspace: string
  const model = new BundleModel()
  const handles = new Set<AgentHandle>()
  const selected = new Set<string>()
  let originalEnvironment: Record<string, string | undefined> = {}

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-optional-bundles-'))
    workspace = join(temporary, 'workspace')
    await mkdir(workspace)
    const home = join(temporary, 'home')
    const values = {
      DSH_HOME: home, DSH_AGENTS_HOME: join(temporary, 'agents'), DSH_BUNDLED_SKILL_DIR: join(temporary, 'skills'),
      DSH_TELEMETRY_DISABLED: '1', TMUX: '', TMUX_PANE: '',
    }
    originalEnvironment = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
    Object.assign(process.env, values)
    const require = createRequire(import.meta.url)
    const app = require(join(root, 'packages/boot/app-boot/lib/index.js')) as typeof import('@deepseek-ai/dsh-app-boot')
    const cmdline = require(join(root, 'packages/boot/cmdline/lib/index.js')) as typeof import('@deepseek-ai/dsh-cmdline')
    const directory = join(home, 'profiles', 'web')
    app.initProfile(directory, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    await writeFile(join(directory, 'cordis.yml'), '[]\n')
    await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'bundle-test', model: 'scripted' } },
    ]))
    const profile = app.loadProfileDirectory('bundle-test', directory, installAnchor)
    const profileContext: ProfileContext = {
      name: 'web', dir: directory, patchPath: profile.patchPath, installAnchor, cwd: workspace, home,
      startedBundles: profile.layers.map(layer => layer.packageName), overlays: [], telemetryDisabledEnv: '1',
    }
    const resolution = await app.createRuntimeResolution({ installAnchor, home, profile })
    const listeners = new Set<() => void>()
    let ready = false
    ctx = await app.boot('bundle-test', join(directory, 'cordis.yml'), app.readProfilePatches('bundle-test', profileContext), async (owner) => {
      owner.provide('profileContext', profileContext)
      owner.provide('appReady', { onReady: (listener) => {
        if (ready) { listener(); return () => {} }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      } })
      await owner.plugin(app.PluginPackages, { resolution })
      cmdline.provideCmdline(owner, { args: ['--no-open', '--port', '0'], exit: (code) => { throw new Error(`Web command exited ${String(code)}`) } })
    })
    ready = true
    for (const listener of listeners) listener()
    listeners.clear()
    ctx.llm.registerAdapter(['bundle-test'], model)
    expect(ctx.get('hmr')).toBeDefined()
  }, 120_000)

  afterEach(async () => {
    for (const handle of handles) await handle.dispose()
    handles.clear()
    for (const name of [...selected]) {
      expect(await ctx.pluginManager.setBundleEnabled(name, false)).toMatchObject({ application: 'applied' })
      selected.delete(name)
    }
  }, 120_000)

  afterAll(async () => {
    try {
      for (const handle of handles) await handle.dispose()
      await ctx?.fiber.dispose()
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
    }
  }, 120_000)

  async function agent(preset = 'standard', cwd = workspace): Promise<AgentHandle> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`optional-${preset}-${randomUUID()}`), meta: { cwd, agentPreset: preset },
      agentOptions: { provider: 'bundle-test', model: 'scripted' },
      setup: scoped => ctx.agentPresets.mount(scoped, preset).then(() => undefined),
    })
    handles.add(handle)
    ctx.permissionPresets.set(handle.agent.session, 'danger-full-access')
    return handle
  }

  async function turn(owner: Agent, prompt: string, responses: Response[]): Promise<void> {
    model.scripts.set(owner.session.id, [...responses])
    owner.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await owner.whenIdle()
    expect(model.scripts.get(owner.session.id)).toEqual([])
  }

  async function select(name: string, enabled: boolean): Promise<void> {
    if (enabled) selected.add(name)
    const result = await ctx.pluginManager.setBundleEnabled(name, enabled)
    if (!enabled && result.application === 'applied') selected.delete(name)
    expect(result, JSON.stringify(result)).toMatchObject({ changed: true, application: 'applied' })
  }

  const names = (owner?: Agent) => ctx.tools.schemas(owner).map(tool => tool.name).sort()
  const toolResult = (owner: Agent, callId: string) => owner.session.deriveMessages()
    .flatMap(message => message.role === 'tool' && message.toolCallId === callId ? message.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

  it('keeps the default host and minimal tool catalogs while every optional bundle is off', async () => {
    const minimal = await agent('minimal')
    const standard = await agent()
    expect(names()).toEqual(['working_directory'])
    expect(names(minimal.agent)).toEqual([process.platform === 'win32' ? 'pwsh' : 'bash', 'working_directory'])
    for (const name of ['str_replace_editor', 'session_search', 'terminal_open', 'ralph']) expect(names(standard.agent)).not.toContain(name)
    expect((await ctx.skills.list({ cwd: workspace, scope: standard.agent })).some(skill => skill.name === 'dsh-badge')).toBe(false)
  })

  it('generates and executes the PTC SDK for the selected search bundle', async () => {
    await select(bundles.search, true)
    const coded = await agent('ptc')
    const native = await agent('cordis')
    const minimal = await agent('minimal')
    const assembly = await ctx.systemPrompt.assemble({ scope: coded.agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('session_trace')
    expect(names(native.agent)).toContain('session_search')
    expect(names(minimal.agent)).toContain('session_search')
    await turn(coded.agent, 'Read this session lineage through run_code.', [
      toolCallResponse('ptc-search', 'run_code', {
        code: 'console.log(await tools.session_trace({}));',
        description: 'Read the current session lineage',
      }), textResponse('PTC_SEARCH_DONE'),
    ])
    expect(toolResult(coded.agent, 'ptc-search')).toContain(coded.agent.session.id)
    expect(coded.agent.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'session_trace')).toBe(true)
    await select(bundles.search, false)
  })

  it('searches persisted conversation content only through the selected search bundle', async () => {
    const seed = await agent()
    await turn(seed.agent, 'Remember OPTIONAL_SEARCH_MARKER for a later session.', [textResponse('Recorded the marker.')])
    const seedId = seed.agent.session.id
    await seed.dispose()
    handles.delete(seed)
    const live = await agent()
    await turn(live.agent, 'Keep OPTIONAL_SEARCH_MARKER in this live session.', [textResponse('Live marker recorded.')])
    const otherWorkspace = join(temporary, 'other-workspace')
    await mkdir(otherWorkspace)
    const foreign = await agent('standard', otherWorkspace)
    await turn(foreign.agent, 'Keep OPTIONAL_SEARCH_MARKER in the other workspace.', [textResponse('Other marker recorded.')])
    await select(bundles.search, true)
    expect(names(live.agent)).toContain('session_search')
    const searcher = await agent()
    await turn(searcher.agent, 'Find the previous marker in session history.', [
      toolCallResponse('search-history', 'session_search', { query: 'OPTIONAL_SEARCH_MARKER' }), textResponse('SEARCH_DONE'),
    ])
    expect(toolResult(searcher.agent, 'search-history')).toContain(seedId)
    expect(toolResult(searcher.agent, 'search-history')).toContain(live.agent.session.id)
    expect(toolResult(searcher.agent, 'search-history')).not.toContain(foreign.agent.session.id)
    expect(toolResult(searcher.agent, 'search-history')).toContain('OPTIONAL_SEARCH_MARKER')
    await select(bundles.search, false)
    expect(names(searcher.agent)).not.toContain('session_search')
    expect(names((await agent()).agent)).not.toContain('session_search')
    const sessionId = searcher.agent.session.id
    await searcher.dispose()
    handles.delete(searcher)
    const reopened = await ctx.agents.resume({ resumeSessionId: sessionId, setup: scoped => ctx.agentPresets.mount(scoped, 'standard').then(() => undefined) })
    handles.add(reopened)
    expect(names(reopened.agent)).not.toContain('session_search')
  })

  it('loads the actual badge asset only while its bundle is selected', async () => {
    const owner = await agent()
    const load = (callId: string) => ctx.tools.execute({
      callId: ToolCallId(callId), name: 'skill', arguments: { name: 'dsh-badge' },
      agent: owner.agent, signal: new AbortController().signal,
    })
    expect((await load('badge-before')).isError).toBe(true)
    await select(bundles.badge, true)
    await turn(owner.agent, 'Load the dsh badge skill.', [
      toolCallResponse('badge-on', 'skill', { name: 'dsh-badge' }), textResponse('BADGE_DONE'),
    ])
    expect(toolResult(owner.agent, 'badge-on')).toContain('powered by dsh')
    expect(toolResult(owner.agent, 'badge-on')).toContain('dsh-badge.png')
    const minimal = await agent('minimal')
    expect((await ctx.skills.list({ cwd: workspace, scope: minimal.agent })).map(skill => skill.name)).toContain('dsh-badge')
    expect(names(minimal.agent)).toEqual([process.platform === 'win32' ? 'pwsh' : 'bash', 'working_directory'])
    await select(bundles.badge, false)
    expect((await load('badge-after')).isError).toBe(true)
  })

  it('runs and closes a real persistent terminal delivered by its bundle', async () => {
    await select(bundles.terminal, true)
    const owner = await agent()
    const target = join(workspace, 'terminal-output.txt')
    let terminalId: string | undefined
    const id = () => {
      if (terminalId === undefined) throw new Error('terminal_open returned no terminal id')
      return terminalId
    }
    await turn(owner.agent, 'Use a persistent terminal to retain a variable, write its value, and close the terminal.', [
      toolCallResponse('terminal-open', 'terminal_open', { type: 'shell', name: 'optional', cwd: workspace }),
      (request) => {
        terminalId = /started terminal session (pty-\d+)/.exec(JSON.stringify(request.messages))?.[1]
        return toolCallResponse('terminal-set', 'terminal_send', {
          sessionId: id(), text: process.platform === 'win32' ? "$env:DSH_OPTIONAL = 'TERMINAL_BUNDLE_OK'" : 'export DSH_OPTIONAL=TERMINAL_BUNDLE_OK',
        })
      },
      () => toolCallResponse('terminal-write', 'terminal_send', {
        sessionId: id(), text: process.platform === 'win32'
          ? `Set-Content -NoNewline -Path '${target.replaceAll("'", "''")}' -Value $env:DSH_OPTIONAL`
          : `printf '%s' "$DSH_OPTIONAL" > ${JSON.stringify(target)}`,
      }),
      () => toolCallResponse('terminal-close', 'terminal_close', { sessionId: id() }),
      textResponse('TERMINAL_DONE'),
    ])
    expect(await readFile(target, 'utf8')).toBe('TERMINAL_BUNDLE_OK')
    expect(toolResult(owner.agent, 'terminal-close')).toContain('closed terminal session')
    await select(bundles.terminal, false)
    expect(names((await agent()).agent)).not.toContain('terminal_open')
  })

  it('runs a real fresh-Agent Ralph workflow through the selected bundle', async () => {
    await select(bundles.ralph, true)
    const owner = await agent()
    await turn(owner.agent, 'The human explicitly requests one Ralph loop.', [
      toolCallResponse('ralph-run', 'ralph', { objective: 'Report completion with the structured output tool.', maxRounds: 1 }),
      textResponse('RALPH_DONE'),
    ])
    expect(toolResult(owner.agent, 'ralph-run')).toContain('Ralph worker reported completion after 1 round')
    expect(toolResult(owner.agent, 'ralph-run')).toContain('OPTIONAL_RALPH_DONE')
    expect(model.requests.some(request => request.sessionId !== owner.agent.session.id && request.tools?.some(tool => tool.name === 'structured_output'))).toBe(true)
    await select(bundles.ralph, false)
    expect(names((await agent()).agent)).not.toContain('ralph')
  })

  it('switches title cadence off/on/off through the live manager', async () => {
    const titleRequests = (owner: Agent) => owner.session.snapshotEvents().filter(event => event.type === 'session/title-llm-request')
    const first = await agent()
    await turn(first.agent, 'First title prompt.', [textResponse('ONE')])
    await expect.poll(() => titleRequests(first.agent).length).toBe(1)
    await turn(first.agent, 'Second title prompt.', [textResponse('TWO')])
    expect(titleRequests(first.agent)).toHaveLength(1)
    await select(bundles.titles, true)
    const following = await agent()
    await turn(following.agent, 'Start a growing conversation.', [textResponse('ONE')])
    await expect.poll(() => titleRequests(following.agent).length).toBe(1)
    expect(titleRequests(following.agent)[0]?.data.titleProvider).toBe('session-title-all-prompts-llm')
    await expect.poll(() => ctx.sessionTitle.get(following.agent.session)?.source.kind).toBe('provider')
    const currentTitle = ctx.sessionTitle.get(following.agent.session)?.title
    const firstInput = titleRequests(following.agent)[0]?.data.messages[0]?.content[0]
    expect(firstInput?.type === 'text' && firstInput.text).toContain('Generate the session title from this JSON array')
    await turn(following.agent, 'Continue the growing conversation.', [textResponse('TWO')])
    await expect.poll(() => titleRequests(following.agent).length).toBe(2)
    expect(titleRequests(following.agent).every(event => event.data.titleProvider === 'session-title-all-prompts-llm')).toBe(true)
    const followingInput = titleRequests(following.agent)[1]?.data.messages[0]?.content[0]
    expect(followingInput?.type === 'text' && followingInput.text)
      .toContain(`Update the session title from this JSON object:\n{"currentTitle":${JSON.stringify(currentTitle)},`)
    await select(bundles.titles, false)
    const restored = await agent()
    await turn(restored.agent, 'Restore first-prompt titles.', [textResponse('ONE')])
    await expect.poll(() => titleRequests(restored.agent).length).toBe(1)
    await turn(restored.agent, 'The title stays on the first prompt.', [textResponse('TWO')])
    expect(titleRequests(restored.agent)).toHaveLength(1)
    expect(titleRequests(restored.agent)[0]?.data.titleProvider).toBe('session-title-first-prompt-llm')
  })

  it('composes all five bundles as global tools across every preset', async () => {
    for (const name of Object.values(bundles)) await select(name, true)
    let coded: Agent | undefined
    for (const preset of ['standard', 'cordis', 'ptc', 'minimal']) {
      const owner = await agent(preset)
      expect(names(owner.agent)).toEqual(expect.arrayContaining(['session_search', 'terminal_open', 'ralph']))
      if (preset === 'ptc') coded = owner.agent
    }
    if (coded === undefined) throw new Error('the PTC Agent was not created')
    await turn(coded, 'Read this session lineage and load the badge through one program.', [
      toolCallResponse('combined-program', 'run_code', {
        code: 'console.log(await tools.session_trace({})); console.log(await tools.skill({ name: "dsh-badge" }));',
        description: 'Use optional session search and badge together',
      }), textResponse('COMBINED_DONE'),
    ])
    expect(toolResult(coded, 'combined-program')).toContain(coded.session.id)
    expect(toolResult(coded, 'combined-program')).toContain('dsh-badge')
    expect(names()).toEqual(expect.arrayContaining(['session_search', 'terminal_open', 'ralph', 'working_directory']))
    for (const name of [...Object.values(bundles)].reverse()) await select(name, false)
    expect(names((await agent()).agent)).not.toContain('session_search')
  })
})
