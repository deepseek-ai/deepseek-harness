/** Server behavior beyond the fixture desktop: registry projection, the reference tool, unknown tools, creation and reset failures. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { CuaPrograms } from '@deepseek-ai/dsh-cua'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolBatchInput, ToolBatchResult } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createCuaMcpServer } from '../src/server.ts'

const approval: AskUserQuestionItem = {
  id: 'cua-app-access', question: 'Allow computer use to control Notes?', detail: 'Session access to the application.',
  options: [{ label: 'Allow for this session' }, { label: 'Deny' }],
  intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny' },
}

/** The registration the fixture provider publishes for the connection's Agent. */
const registration = {
  name: 'cua_run_code',
  description: 'Run a program against the global cua object.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'number' },
      sandbox_permissions: { type: 'string', enum: ['danger-full-access'] }, justification: { type: 'string' },
    },
    required: ['code', 'description'], additionalProperties: false,
  },
}

/** The projection of that registration: the sandbox-escalation fields are not served. */
const projectedSchema = {
  type: 'object',
  properties: { code: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'number' } },
  required: ['code', 'description'], additionalProperties: false,
}

function batch(text: string, isError = false): ToolBatchResult {
  return {
    results: [{ callId: 'cua-mcp-1' as never, result: isError
      ? { isError: true, error: { message: text, info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } }, content: [{ type: 'text', text }] }
      : { isError: false, value: text, content: [{ type: 'text', text }] } }],
    additionalContexts: [], concluded: false,
  }
}

interface SetupOptions {
  createFailures?: number
  programs?: Partial<CuaPrograms> | false
  elicitation?: boolean
  /** Whether the provider registered `cua_run_code` for the Agent. */
  registered?: boolean
  /** Parameter schema of that registration; the default is representable as an MCP tool. */
  parameters?: Record<string, unknown>
  /** Whether the provider registered its `cua` guidance for the Agent. */
  reference?: boolean
}

function fixture(options: SetupOptions = {}) {
  const ctx = new Context()
  // The Agent runs a maintenance task at once and cancels it through this controller, as its disposal does.
  const maintenance = new AbortController()
  const members: Pick<Agent, 'id' | 'ctx' | 'runMaintenance'> = {
    id: SessionId('cua-mcp-fake'), ctx: new Context(), runMaintenance: task => task(maintenance.signal),
  }
  const runMaintenance = vi.spyOn(members, 'runMaintenance')
  const agent = members as Agent
  const dispose = vi.fn(async () => {})
  let failures = options.createFailures ?? 0
  const create = vi.fn(async (
    request: { setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> | undefined },
  ): Promise<AgentHandle> => {
    if (failures > 0) {
      failures -= 1
      throw new Error('registry refused the Agent')
    }
    await request.setup?.(agent.ctx, agent)
    return { agent, dispose }
  })
  const initiators: Agent[] = []
  const withInitiator = vi.fn(<T>(initiator: Agent, operation: () => T): T => { initiators.push(initiator); return operation() })
  const mount = vi.fn(async () => ({ id: 'cua-mcp' }))
  const execute = vi.fn(async (input: ToolBatchInput): Promise<ToolBatchResult> => {
    const call = input.calls[0]
    if (call === undefined) throw new Error('no call')
    return options.registered === false || call.name !== 'cua_run_code' ? batch(`unknown tool "${call.name}"`, true) : batch('program output')
  })
  const get = vi.fn(() => options.registered === false
    ? undefined
    : { ...registration, parameters: options.parameters ?? registration.parameters })
  const assemble = vi.fn(async () => ({
    sections: options.reference === false ? [] : [{ name: 'computer-use:dsh-cua', text: 'Fixture guidance' }], contexts: [], variables: {}, tools: [],
  }))
  const reset = vi.fn(async () => {})
  ctx.provide('agents', { create, withInitiator } as never)
  ctx.provide('agentPresets', { defaultId: 'cua-mcp', mount } as never)
  ctx.provide('tools', { execute, get } as never)
  ctx.provide('systemPrompt', { assemble } as never)
  ctx.provide('attachments', {} as never)
  if (options.programs !== false) ctx.provide('cuaPrograms', { reset, screenshotRequestTarget: () => undefined, ...options.programs } as never)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, agent, maintenance, runMaintenance, create, withInitiator, initiators, mount, execute, get, assemble, reset, dispose }
}

async function setup(options: SetupOptions = {}) {
  const parts = fixture(options)
  const lifetime = new AbortController()
  const adapter = await createCuaMcpServer(parts.ctx, { consent: 'elicit', cwd: '/workspace', signal: lifetime.signal })
  const client = new Client({ name: 'server-spec', version: '1' }, options.elicitation ? { capabilities: { elicitation: {} } } : {})
  const elicitations: unknown[] = []
  if (options.elicitation) {
    client.setRequestHandler('elicitation/create', async (request) => {
      elicitations.push(request.params)
      return { action: 'accept', content: { decision: 'Allow for this session' } }
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
  const run = (args: Record<string, unknown>) => client.callTool({ name: 'cua_run_code', arguments: args })
  return { ...parts, adapter, client, run, elicitations }
}

function texts(result: CallToolResult): string[] {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : [])
}

describe('Computer Use MCP server', () => {
  it('creates the Agent before serving, projects its registration verbatim, and runs programs as Agent maintenance inside the initiator scope', async () => {
    const { adapter, client, run, create, mount, execute, withInitiator, initiators, agent, runMaintenance, maintenance } = await setup()
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[0]).toMatchObject({ meta: { cwd: '/workspace', agentPreset: 'cua-mcp' } })
    expect(mount).toHaveBeenCalledWith(agent.ctx)
    expect(adapter.agent).toBe(agent)
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['cua_get_api_reference', 'cua_run_code', 'cua_reset'])
    const program = listed.tools[1]
    expect(program).toMatchObject({
      name: registration.name, description: registration.description, inputSchema: projectedSchema, title: 'Computer use program',
    })
    expect(program?.inputSchema.properties).not.toHaveProperty('sandbox_permissions')
    const escalation = await run({ code: '1', description: 'Escalate', sandbox_permissions: 'danger-full-access', justification: 'test' })
    expect(escalation.isError).toBe(true)
    expect(texts(escalation)[0]).toContain('remove sandbox_permissions and justification')
    expect(execute).not.toHaveBeenCalled()
    expect(runMaintenance).not.toHaveBeenCalled()
    const first = await run({ code: '1 + 1', description: 'Add', timeoutMs: 5000 })
    expect(texts(first)).toEqual(['program output'])
    expect(execute).toHaveBeenCalledOnce()
    expect(runMaintenance).toHaveBeenCalledOnce()
    const input = execute.mock.calls[0]?.[0]
    if (input === undefined) throw new Error('the executor was not called')
    expect(input.agent).toBe(agent)
    expect(input.calls[0]?.name).toBe('cua_run_code')
    expect(JSON.parse(input.calls[0]!.arguments)).toEqual({ code: '1 + 1', description: 'Add', timeoutMs: 5000 })
    expect(withInitiator).toHaveBeenCalledOnce()
    expect(initiators).toEqual([agent])
    expect(texts(await run({ code: '2', description: 'Again' }))).toEqual(['program output'])
    // Cancelling the Agent's maintenance activity, as its disposal does, cancels the program's execution.
    expect(input.signal.aborted).toBe(false)
    maintenance.abort()
    expect(input.signal.aborted).toBe(true)
  })

  it('fails the listing when the registration is not representable as an MCP tool', async () => {
    const { client } = await setup({ parameters: { type: 'string' } })
    await expect(client.listTools()).rejects.toThrow('The cua_run_code registration is not an MCP tool')
  })

  it('refuses to serve when the Agent cannot be created', async () => {
    const { ctx, dispose } = fixture({ createFailures: 1 })
    await expect(createCuaMcpServer(ctx, { consent: 'allow', cwd: '/workspace', signal: new AbortController().signal }))
      .rejects.toThrow('registry refused the Agent')
    expect(dispose).not.toHaveBeenCalled()
  })

  it('lists no program tool without a registration, names the missing provider, and refuses every unlisted name before the executor', async () => {
    const { client, run, execute } = await setup({ registered: false, programs: false, reference: false })
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['cua_get_api_reference', 'cua_reset'])
    const reference = await client.callTool({ name: 'cua_get_api_reference', arguments: {} })
    expect(reference.isError).toBe(true)
    expect(texts(reference).join('')).toContain('no active CUA provider')
    const unknown = await run({ code: '1', description: 'Probe' })
    expect(unknown.isError).toBe(true)
    expect(texts(unknown)).toEqual(['unknown tool "cua_run_code"'])
    const other = await client.callTool({ name: 'cua_other', arguments: {} })
    expect(other.isError).toBe(true)
    expect(texts(other)).toEqual(['unknown tool "cua_other"'])
    expect(execute).not.toHaveBeenCalled()
    const reset = await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(reset.isError).toBe(true)
    expect(texts(reset).join('')).toContain('no active CUA provider')
  })

  it('serves the API reference whenever asked, without running a program, waiting for one, or changing program results', async () => {
    const { client, run, execute, runMaintenance, assemble, agent } = await setup()
    const reference = () => client.callTool({ name: 'cua_get_api_reference', arguments: {} })
    expect(await reference()).toEqual({ content: [{ type: 'text', text: '## cua API reference\n\nFixture guidance' }] })
    expect(assemble).toHaveBeenCalledWith({ scope: agent })
    expect(execute).not.toHaveBeenCalled()
    expect(runMaintenance).not.toHaveBeenCalled()
    expect(texts(await run({ code: '1', description: 'First' }))).toEqual(['program output'])
    await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(texts(await reference())).toEqual(['## cua API reference\n\nFixture guidance'])
    expect(texts(await run({ code: '2', description: 'Second' }))).toEqual(['program output'])
    // A running program does not delay the reference: the read is not queued behind it.
    const held = Promise.withResolvers<ToolBatchResult>()
    execute.mockReturnValueOnce(held.promise)
    const running = run({ code: '3', description: 'Held' })
    expect(texts(await reference())).toEqual(['## cua API reference\n\nFixture guidance'])
    held.resolve(batch('held output'))
    expect(texts(await running)).toEqual(['held output'])
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('refuses a registered tool the listing does not carry', async () => {
    const { client, execute } = await setup()
    const other = await client.callTool({ name: 'cua_other', arguments: { sandbox_permissions: 'danger-full-access' } })
    expect(other.isError).toBe(true)
    expect(texts(other)).toEqual(['unknown tool "cua_other"'])
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails the call as a protocol error when the executor settles without a result and reports reset failures', async () => {
    const { run, client, reset, execute } = await setup()
    execute.mockResolvedValueOnce({ results: [], additionalContexts: [], concluded: false })
    await expect(run({ code: '2', description: 'Lost' })).rejects.toThrow('settled without a cua_run_code result')
    reset.mockRejectedValueOnce(new Error('cleanup is incomplete'))
    expect(await client.callTool({ name: 'cua_reset', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'cleanup is incomplete' }], isError: true })
    reset.mockRejectedValueOnce('opaque failure')
    expect(await client.callTool({ name: 'cua_reset', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'opaque failure' }], isError: true })
    expect(texts(await run({ code: '1', description: 'Still first environment' }))).toEqual(['program output'])
    expect(await client.callTool({ name: 'cua_reset', arguments: {} })).toEqual({ content: [{
      type: 'text',
      text: 'Program environment cleared. Application access and native connections are retained; the next cua_run_code call starts a fresh environment.',
    }] })
    expect(reset).toHaveBeenCalledTimes(3)
    expect(texts(await run({ code: '1', description: 'Fresh' }))).toEqual(['program output'])
  })

  it('answers consent only for its own Agent and forwards a request without a signal', async () => {
    const { ctx, agent, elicitations } = await setup({ elicitation: true })
    const next = vi.fn(async () => ({ answers: [] }))
    expect(await ctx.waterfall('user-questions/request', { questions: [approval] }, next)).toEqual({ answers: [] })
    expect(await ctx.waterfall('user-questions/request', { questions: [approval], agent: { id: SessionId('other') } as Agent }, next)).toEqual({ answers: [] })
    expect(next).toHaveBeenCalledTimes(2)
    const answer = await ctx.waterfall('user-questions/request', { questions: [approval], agent }, next)
    expect(answer).toEqual({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
    expect(elicitations).toHaveLength(1)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('disposes the Agent after the connection closes', async () => {
    const served = await setup()
    await served.client.close()
    await served.adapter.dispose()
    expect(served.dispose).toHaveBeenCalledOnce()
  })

  it('disposes the Agent when closing the protocol server fails', async () => {
    const served = await setup()
    vi.spyOn(served.adapter.server, 'close').mockRejectedValueOnce(new Error('transport is broken'))
    await expect(served.adapter.dispose()).rejects.toThrow('transport is broken')
    expect(served.dispose).toHaveBeenCalledOnce()
    await served.client.close()
  })
})
