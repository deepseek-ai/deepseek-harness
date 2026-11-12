/** A real Loader composition: the MCP connection runs retained Computer Use programs through a fixture desktop. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { CuaConfig, installCua } from '@deepseek-ai/dsh-cua'
import type { NativeChannelFactory } from '@deepseek-ai/dsh-cua/native-client'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createNativeFixture } from '../../../../snapshots/session/cua-run-code/native-channel.mjs'
import type { ConsentMode } from '../src/consent.ts'
import { createCuaMcpServer, type CuaMcpServer } from '../src/server.ts'

/** The elicitation fields the consent tests inspect; the SDK's own form type stays behind its request handler. */
interface ElicitationRequest {
  readonly message: string
  readonly requestedSchema: unknown
}

interface SetupOptions {
  consent?: ConsentMode
  /** Pre-grant the fixture application through the provider's legacy grant list. */
  granted?: boolean
  /** Mount the CUA provider row; false composes a Host without Computer Use. */
  provider?: boolean
  /** Hold the fixture desktop's cancellation acknowledgements back this long, as a native operation that is slow to stop does. */
  cancellationAcknowledgementMs?: number
  /** How long the program runtime waits for a cancelled program to yield before it stops the process. */
  stopGraceMs?: number
  /** Elicitation handler of the client; omission advertises no elicitation capability. */
  elicit?: (request: ElicitationRequest) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string> }>
}

function texts(result: CallToolResult): string[] {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : [])
}

/** Forward a native channel's replies, delaying each cancellation acknowledgement and reporting its late delivery. */
function delayCancellation(create: NativeChannelFactory, delayMs: number, delivered: () => void): NativeChannelFactory {
  return (owner, config) => {
    const channel = create(owner, config)
    const stdout = new PassThrough()
    void (async () => {
      const held: Promise<void>[] = []
      for await (const line of createInterface({ input: channel.stdout })) {
        if (!line.includes('NATIVE_CANCELLED')) {
          stdout.write(`${line}\n`)
          continue
        }
        held.push(new Promise((resolve) => {
          setTimeout(() => {
            stdout.write(`${line}\n`)
            delivered()
            resolve()
          }, delayMs)
        }))
      }
      await Promise.all(held)
      stdout.end()
    })()
    return { ...channel, stdout }
  }
}

function lastJson(result: CallToolResult): unknown {
  const text = texts(result).at(-1)
  if (text === undefined) throw new Error('result carries no text')
  return JSON.parse(text)
}

async function setup(options: SetupOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-mcp-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const native = createNativeFixture()
  const modules = {
    llm: LlmRuntime, sessions: SessionStore, projections: SessionProjectionRegistry, systemPrompt: SystemPrompt,
    tools: ToolRuntime, agents: AgentRegistry, agentLoop: AgentLoop, agentPresets: AgentPresets, preset: AgentPreset,
    fs: FileSystem, workingDirectory: WorkingDirectory, subprocess: Subprocess, userQuestions: UserQuestions,
    sandbox: Sandbox, sandboxPolicy: SandboxPolicy, sharedRuntime: NodeRuntime,
    attachments: LocalAttachmentStore, computerUse: ComputerUseRegistry, native: NativeToolExecutor,
    cua: {
      inject: ['computerUse', 'subprocess', 'tools', 'systemPrompt', 'agents'], Config: CuaConfig,
      apply(owner: Context, config: CuaConfig) {
        installCua(owner, config, { helperPath: process.execPath,
          createChannel: options.cancellationAcknowledgementMs === undefined
            ? native.createChannel
            : delayCancellation(native.createChannel, options.cancellationAcknowledgementMs, () => { native.events.push('cancellation-acknowledged') }),
          getGuidance: () => 'Fixture CUA guidance: select test.fixture and operate window 7.',
          capabilities: { platform: 'macos', methods: ['getCapabilities', 'getApp', 'getState', 'click', 'screenshot'],
            appLevelAccessibility: true, keyboard: ['app'], browser: false, coordinateSpace: 'screenshot-pixels' },
          permissionParameters: (_method, permission, locale) => ({ permission, locale }),
        })
      },
    },
  }
  // The Host plane owns the native executor, as dsh-base does; the empty preset adds no model-facing rows.
  const entries = Object.keys(modules).filter(name => options.provider !== false || name !== 'cua').map(name => ({
    id: name, name: `cordis:${name}`,
    ...name === 'agentPresets' ? { config: { default: 'cua-mcp' } } : {},
    ...name === 'preset' ? { config: { id: 'cua-mcp', plugins: [] } } : {},
    ...name === 'sandboxPolicy' ? { config: { mode: 'danger-full-access', workspaceRoot: directory } } : {},
    ...name === 'sharedRuntime' ? { config: { executionMode: 'per-call' } } : {},
    ...name === 'attachments' ? { config: { dshHome: directory } } : {},
    ...name === 'cua' ? { config: {
      screenshotTarget: { longEdge: 1, maxBytes: 100_000 },
      allowedApps: options.granted === false ? [] : [{ id: 'a'.repeat(64), name: 'Fixture', executablePath: '/fixture/app' }],
      ...options.stopGraceMs === undefined ? {} : { standaloneRunCode: { runtime: { stopGraceMs: options.stopGraceMs } } },
    } } : {},
  }))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(entries, null, 2) + '\n')
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, modules, { include: Include })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()

  const lifetime = new AbortController()
  // The server is created from a fiber of its own, as the profile frontend creates it, so a test can unload that owner.
  const created = Promise.withResolvers<CuaMcpServer>()
  const frontend = await ctx.plugin({
    name: 'cua-mcp-composition-frontend',
    inject: ['agents', 'agentPresets', 'tools', 'systemPrompt', 'attachments'],
    apply(owner: Context) {
      createCuaMcpServer(owner, { consent: options.consent ?? 'allow', cwd: directory, signal: lifetime.signal })
        .then(created.resolve, created.reject)
    },
  })
  const adapter = await created.promise
  const client = new Client({ name: 'composition', version: '1' }, options.elicit === undefined ? {} : { capabilities: { elicitation: {} } })
  const elicitations: ElicitationRequest[] = []
  if (options.elicit !== undefined) {
    const answer = options.elicit
    client.setRequestHandler('elicitation/create', async (request) => {
      const params: ElicitationRequest = {
        message: request.params.message, requestedSchema: 'requestedSchema' in request.params ? request.params.requestedSchema : undefined,
      }
      elicitations.push(params)
      return answer(params)
    })
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await adapter.server.connect(serverTransport)
  await client.connect(clientTransport)
  onTestFinished(async () => {
    lifetime.abort()
    await client.close()
    await adapter.dispose()
  })
  // The native registration requires a description; tests name their programs unless they supply one.
  const run = (code: string, extra: { description?: string; timeoutMs?: number } = {}, signal?: AbortSignal) =>
    client.callTool({ name: 'cua_run_code', arguments: { code, description: 'Test program', ...extra } }, signal === undefined ? {} : { signal })
  return { ctx, native, directory, adapter, frontend, client, elicitations, run, lifetime }
}

describe('Computer Use MCP composition', () => {
  it('serves three tools, returns the API reference on request, and retains program state in the workspace', async () => {
    const { ctx, native, client, run, adapter, directory } = await setup()
    expect(client.getInstructions()).toContain('Start every conversation by calling cua_get_api_reference')
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['cua_get_api_reference', 'cua_run_code', 'cua_reset'])
    // The MCP tool is the Agent's registration: name, description, and parameters field for field.
    const registered = ctx.tools.schemas(adapter.agent).find(tool => tool.name === 'cua_run_code')
    if (registered === undefined) throw new Error('the provider registered no cua_run_code for the connection Agent')
    // Field for field, minus the sandbox-escalation controls the registration carries and this profile refuses.
    const { properties, ...schema } = registered.parameters as { properties: Record<string, unknown> }
    const { sandbox_permissions: escalationMode, justification, ...served } = properties
    expect(escalationMode).toBeDefined()
    expect(justification).toBeDefined()
    expect(listed.tools[1]).toMatchObject({
      name: registered.name, description: registered.description, inputSchema: { ...schema, properties: served },
    })
    expect(registered.parameters).toMatchObject({ required: expect.arrayContaining(['code', 'description']) as string[] })
    expect(registered.description.length).toBeGreaterThan(1000)

    // The reference is the provider's guidance for the connection Agent, served before any program has run.
    const reference = await client.callTool({ name: 'cua_get_api_reference', arguments: {} })
    expect(reference.isError).not.toBe(true)
    expect(reference.content).toHaveLength(1)
    const referenceText = texts(reference)[0] ?? ''
    expect(referenceText.startsWith('## cua API reference')).toBe(true)
    expect(referenceText).not.toContain('execution rules')
    expect(referenceText).toContain('Fixture CUA guidance: select test.fixture and operate window 7.')
    expect(referenceText).toContain('Maximum click holdMs: 5000 ms.')
    expect(native.calls).toEqual([])

    const first = await run('globalThis.visits = 1; var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); '
      + 'await win.getAccessibilityTree(); await win.click("0"); '
      + 'inspect(JSON.stringify({ visits, window: win.windowId, pid: process.pid, cwd: process.cwd() }), await win.getScreenshot())', { description: 'Open the fixture' })
    expect(first.isError).not.toBe(true)
    // A program result is the program's own output: the inspected text, then the screenshot the program observed.
    const result = JSON.parse(texts(first)[0] ?? '') as { visits: number; window: string; pid: number; cwd: string }
    expect(result).toMatchObject({ visits: 1, window: '7' })
    expect(result.pid).not.toBe(process.pid)
    // Programs start in the directory the connection's Agent was created in. Both spellings are resolved: the
    // temporary directory is a symlink on macOS and an 8.3 short name on Windows.
    expect(await realpath(result.cwd)).toBe(await realpath(directory))
    const image = first.content[1]
    if (image?.type !== 'image') throw new Error(`expected an image block, got ${JSON.stringify(image)}`)
    expect(image.mimeType).toMatch(/^image\//)
    expect(Buffer.from(image.data, 'base64').length).toBeGreaterThan(0)
    expect(first.content).toHaveLength(2)
    expect(native.state).toMatchObject({ count: 1, openedChannels: 1, closedChannels: 0 })

    const second = await run('globalThis.visits++; await win.getAccessibilityTree(); await win.click("0"); inspect(JSON.stringify({ visits, sameWindow: win.windowId === "7", pid: process.pid }))')
    expect(second.isError).not.toBe(true)
    expect(second.content).toHaveLength(1)
    expect(lastJson(second)).toEqual({ visits: 2, sameWindow: true, pid: result.pid })
    expect(native.state.count).toBe(2)
    // One connection owns one Agent; root calls stay out of its Session log while nested calls are logged.
    const agents = ctx.agents.list()
    expect(agents).toHaveLength(1)
    const events = agents[0]!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(0)
    const dispatches = events.filter(event => event.type === 'tool/ptc-dispatch')
    expect(dispatches.length).toBeGreaterThanOrEqual(5)
    expect(dispatches.every(event => event.data.name === 'cua' && !event.data.isError)).toBe(true)
  })

  it('serializes concurrent programs, reports program failures, and recovers after cancellation', async () => {
    const { run, client } = await setup()
    const [a, b] = await Promise.all([
      run('globalThis.order = ["a"]; await new Promise(resolve => setTimeout(resolve, 50)); inspect("a")'),
      run('globalThis.order.push("b"); inspect(JSON.stringify(globalThis.order))'),
    ])
    expect(a.isError).not.toBe(true)
    expect(lastJson(b)).toEqual(['a', 'b'])
    const failed = await run('throw new Error("boom")')
    expect(failed.isError).toBe(true)
    // The client marks the error; the text is DSH's failure message without its `Error: ` prefix.
    expect(texts(failed)[0]).toMatch(/^code run failed \(exception\): .*boom/s)
    const controller = new AbortController()
    const hanging = run('await new Promise(resolve => setTimeout(resolve, 60_000))', {}, controller.signal)
    setTimeout(() => { controller.abort() }, 100)
    await expect(hanging).rejects.toThrow()
    expect(lastJson(await run('inspect(1 + 1)'))).toBe(2)
    // Argument validation belongs to the DSH executor: a program without the required description is refused there.
    const invalid = await client.callTool({ name: 'cua_run_code', arguments: { code: '1' } })
    expect(invalid.isError).toBe(true)
    expect(texts(invalid)).toEqual(['invalid arguments: missing required property "description"'])
  })

  it('resets only the program environment: a fresh process and cua object, the same Agent and native connection', async () => {
    const { ctx, native, run, client, adapter } = await setup()
    const first = await run('globalThis.visits = 1; var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); inspect(process.pid)')
    const pid = lastJson(first) as number
    const { agent } = adapter
    const reset = await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(reset.isError).not.toBe(true)
    expect(texts(reset)).toEqual(['Program environment cleared: variables, imports, and application and window objects from earlier calls '
      + 'are gone. Application access granted earlier still applies; select applications again with cua.getApp.'])
    const next = await run('inspect(JSON.stringify({ visits: globalThis.visits ?? null, hasApp: typeof app !== "undefined", cua: typeof cua, pid: process.pid }))')
    expect(next.content).toHaveLength(1)
    const state = lastJson(next) as { visits: null; hasApp: boolean; cua: string; pid: number }
    // The fresh process re-created the cua object; the variables and application objects of the previous one are gone.
    expect(state).toMatchObject({ visits: null, hasApp: false, cua: 'object' })
    expect(state.pid).not.toBe(pid)
    expect(() => process.kill(pid, 0)).toThrow()
    // The program selects the application and its window again and operates them over the connection the Agent kept.
    const again = await run('var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.getAccessibilityTree(); await win.click("0"); inspect(JSON.stringify(win.windowId))')
    expect(lastJson(again)).toBe('7')
    expect(native.state).toMatchObject({ count: 1, openedChannels: 1, closedChannels: 0 })
    expect(ctx.agents.list()).toEqual([agent])
    expect(texts(await client.callTool({ name: 'cua_get_api_reference', arguments: {} }))[0]).toContain('## cua API reference')
  })

  it('keeps session consent across a reset: a granted application is selected again without a request, and a refusal stays', async () => {
    const select = (served: Awaited<ReturnType<typeof setup>>) => served.run('var app = await cua.getApp("test.fixture"); inspect("selected")')
    const granted = await setup({
      consent: 'elicit', granted: false, elicit: async () => ({ action: 'accept', content: { decision: 'Allow for this session' } }),
    })
    expect((await select(granted)).isError).not.toBe(true)
    await granted.client.callTool({ name: 'cua_reset', arguments: {} })
    expect((await select(granted)).isError).not.toBe(true)
    expect(granted.elicitations).toHaveLength(1)

    const refused = await setup({
      consent: 'elicit', granted: false, elicit: async () => ({ action: 'accept', content: { decision: 'Deny' } }),
    })
    expect((await select(refused)).isError).toBe(true)
    await refused.client.callTool({ name: 'cua_reset', arguments: {} })
    const again = await select(refused)
    expect(again.isError).toBe(true)
    expect(texts(again).join('\n')).toContain('APP_ACCESS_DENIED')
    expect(refused.elicitations).toHaveLength(1)
  })

  it('cancels the running program on reset, answers after it has settled, and runs a queued program in the fresh environment', async () => {
    // The native operation takes 200 ms to acknowledge cancellation, so the cancelled program stays in flight that long.
    const { native, run, client } = await setup({ cancellationAcknowledgementMs: 200 })
    const ready = await run('globalThis.generation = "first"; var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.getAccessibilityTree(); inspect(process.pid)')
    const pid = lastJson(ready) as number
    const held = native.holdNextClick()
    const running = run('await win.click("0")')
    await held
    // Queued behind the running program, before the reset arrives.
    const queued = run('inspect(JSON.stringify({ generation: globalThis.generation ?? null, pid: process.pid }))')
    const reset = await client.callTool({ name: 'cua_reset', arguments: {} })
    // The reset answered after the cancelled program's native operation had acknowledged the cancellation.
    expect(native.events).toEqual(['native-cancelled', 'cancellation-acknowledged'])
    expect(reset.isError).not.toBe(true)
    const cancelled = await running
    expect(cancelled.isError).toBe(true)
    expect(texts(cancelled).join('\n')).toContain('tool call aborted')
    const fresh = lastJson(await queued) as { generation: null; pid: number }
    expect(fresh.generation).toBeNull()
    expect(fresh.pid).not.toBe(pid)
    expect(() => process.kill(pid, 0)).toThrow()
    // Nothing closed the Agent's native connection.
    expect(native.events).not.toContain('native-close')
    expect(native.state).toMatchObject({ openedChannels: 1, closedChannels: 0 })
  })

  it('holds a program that arrives during a reset until the previous process has exited', async () => {
    const { run, client } = await setup()
    await run('globalThis.kept = 1; inspect("ready")')
    // The runtime rejects a program for an Agent whose previous process is still exiting.
    const [reset, program] = await Promise.all([
      client.callTool({ name: 'cua_reset', arguments: {} }),
      run('inspect(JSON.stringify({ kept: globalThis.kept ?? null }))'),
    ])
    expect(reset.isError).not.toBe(true)
    expect(program.isError).not.toBe(true)
    expect(lastJson(program)).toEqual({ kept: null })
  })

  it('ends a program that cannot be interrupted on reset without waiting for the runtime to stop it', async () => {
    // A cancelled program gets ten minutes to settle before the runtime stops its process, longer than any test
    // budget: this reset answers only because releasing the environment ends that wait.
    const { ctx, run, client, adapter } = await setup({ stopGraceMs: 600_000 })
    const pid = lastJson(await run('globalThis.kept = 1; inspect(process.pid)')) as number
    // The looping process below is stopped even when the reset fails to stop it.
    onTestFinished(() => {
      try { process.kill(pid, 'SIGKILL') } catch (_error: unknown) { /* The reset already ended the process. */ }
    })
    const observed: PromiseWithResolvers<void> = Promise.withResolvers()
    ctx.on('session/event', (candidate, event) => {
      if (candidate === adapter.agent.session && event.type === 'tool/ptc-dispatch' && event.data.rootCallId === 'cua-mcp-2') observed.resolve()
    })
    // The program enters its loop as soon as the nested call's result reaches it, before any later message.
    const looping = run('await cua.getCapabilities(); while (true) {}')
    await observed.promise
    const reset = await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(reset.isError).not.toBe(true)
    const cancelled = await looping
    expect(cancelled.isError).toBe(true)
    expect(texts(cancelled).join('\n')).toContain('tool call aborted')
    expect(() => process.kill(pid, 0)).toThrow()
    expect(lastJson(await run('inspect(JSON.stringify({ kept: globalThis.kept ?? null }))'))).toEqual({ kept: null })
  })

  it('cancels an in-flight program and waits for its nested call to settle before a disposed Agent releases anything', async () => {
    // The native operation takes 200 ms to acknowledge cancellation, so the cancelled call stays in flight that long.
    const { ctx, native, run, adapter, frontend } = await setup({ cancellationAcknowledgementMs: 200 })
    const opened = await run('var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); await win.getAccessibilityTree(); inspect("ready")')
    expect(opened.isError).not.toBe(true)
    const { session } = adapter.agent
    const order: string[] = []
    ctx.on('session/event', (candidate, event) => {
      if (candidate === session && event.type === 'tool/ptc-dispatch' && event.data.rootCallId === 'cua-mcp-2') order.push('nested call recorded')
    })
    const reported = vi.spyOn(ctx.logger, 'error')
    const held = native.holdNextClick()
    const program = run('await win.click("0")')
    await held
    // The fiber that owns the Agent unloads while the call is in flight; nothing has closed or drained the server.
    await frontend.dispose()
    order.push('Agent disposed')
    // The call was cancelled, its native operation acknowledged the cancellation, and its nested call was
    // recorded, all before the Agent released its native connection and closed its Session.
    expect(native.events).toEqual(['native-cancelled', 'cancellation-acknowledged', 'native-close'])
    expect(order).toEqual(['nested call recorded', 'Agent disposed'])
    const result = await program
    expect(result.isError).toBe(true)
    expect(texts(result).join('\n')).toContain('tool call aborted')
    expect(ctx.agents.list()).toHaveLength(0)
    const interrupted = session.snapshotEvents()
      .filter(event => (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') && event.data.rootCallId === 'cua-mcp-2')
    expect(interrupted.map(event => event.type)).toEqual(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
    expect(interrupted[1]?.data).toMatchObject({ name: 'cua', isError: true })
    expect(reported).not.toHaveBeenCalled()
  })

  it('forwards application consent to the client as an elicitation and records a refusal', async () => {
    const decisions = ['Deny', 'Allow for this session']
    const { run, elicitations, native } = await setup({
      consent: 'elicit', granted: false,
      elicit: async () => ({ action: 'accept', content: { decision: decisions.shift() ?? 'Deny' } }),
    })
    const denied = await run('var app = await cua.getApp("test.fixture"); app.appHandle')
    expect(denied.isError).toBe(true)
    expect(texts(denied).join('\n')).toContain('APP_ACCESS_DENIED')
    expect(elicitations).toHaveLength(1)
    expect(elicitations[0]).toMatchObject({
      message: expect.stringContaining('Fixture') as string,
      requestedSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['Allow for this session', 'Deny'] } }, required: ['decision'] },
    })
    // A refusal is remembered for this Agent; the provider does not ask again.
    const again = await run('var app = await cua.getApp("test.fixture"); app.appHandle')
    expect(again.isError).toBe(true)
    expect(elicitations).toHaveLength(1)
    expect(native.calls.map(call => call.method)).not.toContain('getState')
  })

  it('grants consent without a human in allow mode and explains a client without elicitation', async () => {
    const allowed = await setup({ consent: 'allow', granted: false })
    const result = await allowed.run('var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); inspect(JSON.stringify(win.windowId))')
    expect(result.isError).not.toBe(true)
    expect(lastJson(result)).toBe('7')

    const unsupported = await setup({ consent: 'elicit', granted: false })
    const refused = await unsupported.run('var app = await cua.getApp("test.fixture"); app.appHandle')
    expect(refused.isError).toBe(true)
    expect(texts(refused).join('\n')).toContain('DSH_CUA_CONSENT=allow')
  })

  it('lists no program tool on a Host without a CUA provider and releases the connection Agent on disposal', async () => {
    const { ctx, run, client, adapter } = await setup({ provider: false })
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['cua_get_api_reference', 'cua_reset'])
    const reference = await client.callTool({ name: 'cua_get_api_reference', arguments: {} })
    expect(reference.isError).toBe(true)
    expect(texts(reference)[0]).toContain('no active CUA provider')
    // No registration exists for the Agent, so the call is refused as an unknown tool before it reaches the executor.
    const result = await run('1')
    expect(result.isError).toBe(true)
    expect(texts(result)[0]).toContain('unknown tool "cua_run_code"')
    const reset = await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(reset.isError).toBe(true)
    expect(texts(reset)[0]).toContain('no active CUA provider')
    expect(ctx.agents.list()).toHaveLength(1)
    await client.close()
    await adapter.dispose()
    expect(ctx.agents.list()).toHaveLength(0)
  })
})
