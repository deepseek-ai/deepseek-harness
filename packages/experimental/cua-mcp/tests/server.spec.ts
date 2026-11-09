/** Server behavior that the fixture desktop cannot reach: creation failures, missing references, reset failures, and disposal. */
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

function batch(text: string): ToolBatchResult {
  return {
    results: [{ callId: 'cua-mcp-1' as never, result: { isError: false, value: text, content: [{ type: 'text', text }] } }],
    additionalContexts: [], concluded: false,
  }
}

interface SetupOptions {
  createFailures?: number
  /** Agent creation waits for this promise before it settles. */
  createGate?: Promise<void>
  programs?: Partial<CuaPrograms> | false
  elicitation?: boolean
  reference?: boolean
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  const agent = { id: SessionId('cua-mcp-fake'), ctx: new Context() } as Agent
  const dispose = vi.fn(async () => {})
  let failures = options.createFailures ?? 0
  const create = vi.fn(async (
    request: { setup?: (agentCtx: Context, agent: Agent) => Promise<unknown> | undefined },
  ): Promise<AgentHandle> => {
    await options.createGate
    if (failures > 0) {
      failures -= 1
      throw new Error('registry refused the Agent')
    }
    await request.setup?.(agent.ctx, agent)
    return { agent, dispose }
  })
  const mount = vi.fn(async () => ({ id: 'cua-mcp' }))
  const execute = vi.fn(async (_input: ToolBatchInput): Promise<ToolBatchResult> => batch('program output'))
  const get = vi.fn(() => options.reference === false ? undefined : { name: 'cua_run_code', description: 'Run a program.' })
  const assemble = vi.fn(async () => ({
    sections: options.reference === false ? [] : [{ name: 'computer-use:dsh-cua', text: 'Fixture guidance' }], contexts: [], variables: {}, tools: [],
  }))
  const reset = vi.fn(async () => {})
  ctx.provide('agents', { create } as never)
  ctx.provide('agentPresets', { defaultId: 'cua-mcp', mount } as never)
  ctx.provide('tools', { execute, get } as never)
  ctx.provide('systemPrompt', { assemble } as never)
  ctx.provide('attachments', {} as never)
  if (options.programs !== false) ctx.provide('cuaPrograms', { reset, screenshotRequestTarget: () => undefined, ...options.programs } as never)
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const lifetime = new AbortController()
  const adapter = createCuaMcpServer(ctx, { consent: 'elicit', cwd: '/workspace', signal: lifetime.signal })
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
    await ctx.fiber.dispose()
  })
  const run = (args: Record<string, unknown>) => client.callTool({ name: 'cua_run_code', arguments: args })
  return { ctx, agent, adapter, client, run, create, mount, execute, get, assemble, reset, dispose, errors, elicitations }
}

function texts(result: CallToolResult): string[] {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : [])
}

describe('Computer Use MCP server', () => {
  it('creates the Agent once initialization completes, mounts the default preset, and forwards program arguments', async () => {
    const { run, create, mount, execute, agent } = await setup()
    await vi.waitFor(() => { expect(create).toHaveBeenCalledOnce() })
    expect(create.mock.calls[0]?.[0]).toMatchObject({ meta: { cwd: '/workspace', agentPreset: 'cua-mcp' } })
    expect(mount).toHaveBeenCalledWith(agent.ctx)
    const first = await run({ code: '1 + 1', timeoutMs: 5000 })
    expect(texts(first)).toEqual(['## cua_run_code execution rules\n\nRun a program.\n\n## cua API reference\n\nFixture guidance', 'program output'])
    expect(execute).toHaveBeenCalledOnce()
    const input = execute.mock.calls[0]?.[0]
    if (input === undefined) throw new Error('the executor was not called')
    expect(input.agent).toBe(agent)
    expect(input.calls[0]?.name).toBe('cua_run_code')
    expect(JSON.parse(input.calls[0]!.arguments)).toEqual({ code: '1 + 1', description: 'CUA program', timeoutMs: 5000 })
    expect(create).toHaveBeenCalledOnce()
  })

  it('retries Agent creation after a failure and reports an executor without a result', async () => {
    const { run, create, errors, execute } = await setup({ createFailures: 1 })
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledOnce() })
    expect(String(errors.mock.calls[0]?.[0])).toContain('Agent creation failed')
    const result = await run({ code: '1' })
    expect(result.isError).not.toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
    execute.mockResolvedValueOnce({ results: [], additionalContexts: [], concluded: false })
    const missing = await run({ code: '2' })
    expect(missing.isError).toBe(true)
    expect(texts(missing).join('')).toContain('settled without a cua_run_code result')
  })

  it('omits the preface when the provider registered no tool or guidance, and reports reset failures', async () => {
    const { run, client, reset } = await setup({ reference: false })
    expect(texts(await run({ code: '1' }))).toEqual(['program output'])
    reset.mockRejectedValueOnce(new Error('cleanup is incomplete'))
    expect(await client.callTool({ name: 'cua_reset', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'cleanup is incomplete' }], isError: true })
    reset.mockRejectedValueOnce('opaque failure')
    expect(await client.callTool({ name: 'cua_reset', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'opaque failure' }], isError: true })
    const ok = await client.callTool({ name: 'cua_reset', arguments: {} })
    expect(ok.isError).not.toBe(true)
    expect(texts(await run({ code: '1' }))).toEqual(['program output'])
  })

  it('answers consent only for its own Agent and forwards a request without a signal', async () => {
    const { ctx, agent, elicitations } = await setup({ elicitation: true })
    const next = vi.fn(async () => ({ answers: [] }))
    expect(await ctx.waterfall('user-questions/request', { questions: [approval] }, next)).toEqual({ answers: [] })
    expect(await ctx.waterfall('user-questions/request', { questions: [approval], agent: { id: SessionId('other') } as Agent }, next)).toEqual({ answers: [] })
    expect(next).toHaveBeenCalledTimes(2)
    // The connection Agent exists only after initialization; its requests reach the client.
    await vi.waitFor(() => { expect(ctx.get('agents')).toBeDefined() })
    const answer = await ctx.waterfall('user-questions/request', { questions: [approval], agent }, next)
    expect(answer).toEqual({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
    expect(elicitations).toHaveLength(1)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('disposes without an Agent, and after a creation that never succeeded', async () => {
    const idle = await setup()
    await vi.waitFor(() => { expect(idle.create).toHaveBeenCalledOnce() })
    await idle.client.close()
    await idle.adapter.dispose()
    expect(idle.dispose).toHaveBeenCalledOnce()

    const failing = await setup({ createFailures: 3, programs: false })
    const result = await failing.run({ code: '1' })
    expect(result.isError).toBe(true)
    expect(texts(result).join('')).toContain('no active CUA provider')
    await failing.client.close()
    await failing.adapter.dispose()
    expect(failing.dispose).not.toHaveBeenCalled()

    const neverCreated = await setup({ createFailures: 3 })
    const refused = await neverCreated.run({ code: '1' })
    expect(refused.isError).toBe(true)
    expect(texts(refused).join('')).toContain('registry refused the Agent')
    await neverCreated.client.close()
    await neverCreated.adapter.dispose()
    expect(neverCreated.dispose).not.toHaveBeenCalled()

    // Disposal during a pending creation that then fails releases nothing and does not reject.
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const racing = await setup({ createFailures: 1, createGate: gate.promise })
    await vi.waitFor(() => { expect(racing.create).toHaveBeenCalledOnce() })
    await racing.client.close()
    const disposing = racing.adapter.dispose()
    // Disposal observes the pending creation before the timer lets it fail.
    await new Promise(resolve => setTimeout(resolve, 20))
    gate.resolve()
    await disposing
    expect(racing.dispose).not.toHaveBeenCalled()
  })
})
