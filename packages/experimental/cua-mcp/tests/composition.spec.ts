/** A real Loader composition: the MCP connection runs retained Computer Use programs through a fixture desktop. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { describe, expect, it, onTestFinished } from 'vitest'
import { createNativeFixture } from '../../../../snapshots/session/cua-run-code/native-channel.mjs'
import type { ConsentMode } from '../src/consent.ts'
import { createCuaMcpServer } from '../src/server.ts'

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
  /** Elicitation handler of the client; omission advertises no elicitation capability. */
  elicit?: (request: ElicitationRequest) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string> }>
}

type Block = CallToolResult['content'][number]

function texts(result: CallToolResult): string[] {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : [])
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
        installCua(owner, config, { helperPath: process.execPath, createChannel: native.createChannel,
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
  const adapter = createCuaMcpServer(ctx, { consent: options.consent ?? 'allow', cwd: directory, signal: lifetime.signal })
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
  const run = (code: string, extra: { description?: string; timeoutMs?: number } = {}, signal?: AbortSignal) =>
    client.callTool({ name: 'cua_run_code', arguments: { code, ...extra } }, signal === undefined ? {} : { signal })
  return { ctx, native, directory, adapter, client, elicitations, run, lifetime }
}

describe('Computer Use MCP composition', () => {
  it('serves two tools, prefixes the first program result with the API reference, and retains program state', async () => {
    const { ctx, native, client, run } = await setup()
    expect(client.getInstructions()).toContain('cua_run_code')
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['cua_run_code', 'cua_reset'])
    expect(listed.tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['code'] })
    expect(listed.tools[0]?.description).toContain('complete `cua` API reference')

    const first = await run('globalThis.visits = 1; var app = await cua.getApp("test.fixture"); var win = await app.getWindow(7); '
      + 'await win.getAccessibilityTree({ emit: false }); await win.click("0"); await win.getScreenshot(); ({ visits, window: win.windowId, pid: process.pid })', { description: 'Open the fixture' })
    expect(first.isError).not.toBe(true)
    const [reference, ...rest] = first.content
    expect(reference).toMatchObject({ type: 'text' })
    const referenceText = (reference as Extract<Block, { type: 'text' }>).text
    expect(referenceText).toContain('## cua_run_code execution rules')
    expect(referenceText).toContain('remain in memory for this Agent across calls')
    expect(referenceText).toContain('## cua API reference')
    expect(referenceText).toContain('Fixture CUA guidance: select test.fixture and operate window 7.')
    expect(referenceText).toContain('Maximum click holdMs: 5000 ms.')
    const result = JSON.parse((rest[0] as Extract<Block, { type: 'text' }>).text) as { visits: number; window: number; pid: number }
    expect(result).toMatchObject({ visits: 1, window: 7 })
    expect(result.pid).not.toBe(process.pid)
    // The nested screenshot arrives after the program text: its metadata, then the image the program observed.
    expect(JSON.parse((rest[1] as Extract<Block, { type: 'text' }>).text)).toMatchObject({ windowId: 7, coordinateSpace: 'screenshot-pixels', pixelWidth: 1, pixelHeight: 1 })
    const image = rest[2]
    if (image?.type !== 'image') throw new Error(`expected an image block, got ${JSON.stringify(image)}`)
    expect(image.mimeType).toMatch(/^image\//)
    expect(Buffer.from(image.data, 'base64').length).toBeGreaterThan(0)
    expect(rest).toHaveLength(3)
    expect(native.state).toMatchObject({ count: 1, openedChannels: 1, closedChannels: 0 })

    const second = await run('globalThis.visits++; await win.getAccessibilityTree({ emit: false }); await win.click("0"); ({ visits, sameWindow: win.windowId === 7, pid: process.pid })')
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
      run('globalThis.order = ["a"]; await new Promise(resolve => setTimeout(resolve, 50)); "a"'),
      run('globalThis.order.push("b"); globalThis.order'),
    ])
    expect(a.isError).not.toBe(true)
    expect(lastJson(b)).toEqual(['a', 'b'])
    const failed = await run('throw new Error("boom")')
    expect(failed.isError).toBe(true)
    expect(texts(failed).join('\n')).toContain('boom')
    const controller = new AbortController()
    const hanging = run('await new Promise(resolve => setTimeout(resolve, 60_000))', {}, controller.signal)
    setTimeout(() => { controller.abort() }, 100)
    await expect(hanging).rejects.toThrow()
    expect(lastJson(await run('1 + 1'))).toBe(2)
    const invalid = await client.callTool({ name: 'cua_run_code', arguments: { code: '' } })
    expect(invalid.isError).toBe(true)
    expect(texts(invalid).join('\n')).toContain('Input validation error')
  })

  it('resets the program environment while keeping the native connection, then repeats the reference', async () => {
    const { native, run, client } = await setup()
    const first = await run('globalThis.visits = 1; var app = await cua.getApp("test.fixture"); process.pid')
    const pid = lastJson(first) as number
    const reset = await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(reset.isError).not.toBe(true)
    expect(texts(reset)[0]).toContain('Program environment cleared')
    const next = await run('({ visits: globalThis.visits ?? null, hasApp: typeof app !== "undefined", pid: process.pid })')
    expect(next.content).toHaveLength(2)
    expect(texts(next)[0]).toContain('## cua API reference')
    const state = lastJson(next) as { visits: null; hasApp: boolean; pid: number }
    expect(state).toMatchObject({ visits: null, hasApp: false })
    expect(state.pid).not.toBe(pid)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(native.state).toMatchObject({ openedChannels: 1, closedChannels: 0 })
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
    const result = await allowed.run('var app = await cua.getApp("test.fixture"); var win = await app.getWindow(7); win.windowId')
    expect(result.isError).not.toBe(true)
    expect(lastJson(result)).toBe(7)

    const unsupported = await setup({ consent: 'elicit', granted: false })
    const refused = await unsupported.run('var app = await cua.getApp("test.fixture"); app.appHandle')
    expect(refused.isError).toBe(true)
    expect(texts(refused).join('\n')).toContain('DSH_CUA_CONSENT=allow')
  })

  it('reports a Host without a CUA provider and releases the connection Agent on disposal', async () => {
    const { ctx, run, client, adapter } = await setup({ provider: false })
    const result = await run('1')
    expect(result.isError).toBe(true)
    expect(texts(result)[0]).toContain('no active CUA provider')
    const reset = await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(reset.isError).toBe(true)
    expect(ctx.agents.list()).toHaveLength(1)
    await client.close()
    await adapter.dispose()
    expect(ctx.agents.list()).toHaveLength(0)
  })
})
