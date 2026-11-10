import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createRunCodeTool, RunCodeConfig } from '../src/run-code.ts'

class ControlledRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  override get retainsState() { return true }
  override get programFormat() { return 'repl' as const }
  override get executionInstructions() { return 'Top-level await is supported; the last expression is returned.' }
  override get timeout() { return { defaultMs: 120_000, maxMs: 600_000 } }
  behavior: (spec: PtcRunSpec) => Promise<PtcRunResult> = async () => ({ logs: [] })

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? this.timeout.defaultMs }
  }

  run(spec: PtcRunSpec): Promise<PtcRunResult> { return this.behavior(spec) }
}

function privateTool(execute = vi.fn(async () => 'private result')) {
  return defineTool({
    name: 'cua', description: 'Operate the test computer.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute,
  })
}

async function setup(definition: ToolDefinition, limits?: Partial<RunCodeConfig>) {
  const ctx = new Context()
  const runtimeContext = new Context()
  const agentContext = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await agentContext.fiber.dispose()
    await runtimeContext.fiber.dispose()
  })
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  await runtimeContext.plugin(ControlledRuntime)
  const runtime = runtimeContext.ptcRuntime as ControlledRuntime
  const session = ctx.sessions.create(SessionId('private-program'))
  session.append('turn/start', { turn: 1 })
  const agent = { ctx: agentContext, id: session.id, session } as Agent
  const fiber = await ctx.plugin(Object.assign((owner: Context) => {
    owner.tools.register(createRunCodeTool(owner, {
      name: 'cua_run_code', description: 'Run computer operations through cua.',
      runtime, tools: [definition],
      ...limits === undefined ? {} : { limits },
    }))
  }, { inject: ['tools'] }))
  const execute = async (args: Record<string, unknown> = {}, name = 'cua_run_code') => {
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
    try {
      return await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: ToolCallId('program'), name, arguments: JSON.stringify({ code: 'await cua.inspect()', description: 'Inspect the current computer', ...args }) }],
        agent, toolSet, signal,
      })
    } finally { toolSet.dispose() }
  }
  return { ctx, runtime, agent, agentContext, session, fiber, execute }
}

describe('registered program tool factory', () => {
  it('uses the explicit runtime and binds only private definitions under native execution', async () => {
    const body = vi.fn(async () => 'private result')
    const definition = privateTool(body)
    const { ctx, runtime, agent, execute } = await setup(definition)
    const unrelated = vi.fn(async () => 'unrelated')
    ctx.tools.register({ ...privateTool(unrelated), name: 'other' })
    expect(ctx.get('ptcRuntime')).toBeUndefined()
    expect(ctx.tools.get('cua')).toBeUndefined()
    expect((await execute({}, 'cua')).results[0]?.result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    const schema = ctx.tools.schemas().find(tool => tool.name === 'cua_run_code')!
    expect(schema.description).toContain('Run computer operations through cua.')
    expect(schema.description).toContain(runtime.executionInstructions)
    expect(JSON.stringify(schema.parameters)).toContain('Default 120000; capped at 600000')
    runtime.behavior = async (request) => {
      expect(request.program).toBe('await cua.inspect()')
      expect(request.stateOwner).toBe(agent)
      expect(Object.keys(request.bindings[0]!.functions)).toEqual(['cua'])
      return { logs: [], value: await request.bindings[0]!.functions.cua!({}) }
    }
    expect((await execute()).results[0]?.result).toMatchObject({ isError: false, value: { logs: [], result: 'private result' } })
    expect(body).toHaveBeenCalledOnce()
    expect(unrelated).not.toHaveBeenCalled()
    expect(Object.isFrozen(definition.parameters)).toBe(false)
  })

  it('preserves approval rejection and guard identity for unregistered nested tools', async () => {
    const body = vi.fn(async () => 'private result')
    const { ctx, runtime, session, execute } = await setup(privateTool(body))
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    let approval: ApprovalOutcome = 'rejected'
    let guarded = false
    ctx.on('approval/request', () => Promise.resolve(approval))
    ctx.on('tools/pre-execute', (exec, next) => exec.name === 'cua'
      ? Promise.resolve({ kind: 'ask', reason: 'Confirm computer operation' }) : next())
    ctx.tools.guard(exec => exec.name === 'cua' && guarded
      ? { reason: 'Computer operation blocked', info: { name: 'ComputerGuardError', code: 'COMPUTER_BLOCKED' } } : undefined)
    runtime.behavior = async (request) => {
      await expect(request.bindings[0]!.functions.cua!({})).rejects.toThrow()
      return { logs: [] }
    }
    expect((await execute()).results[0]?.result.isError).toBe(false)
    approval = 'allowed-once'
    guarded = true
    expect((await execute()).results[0]?.result.isError).toBe(false)
    expect(body).not.toHaveBeenCalled()
    expect(session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.error))
      .toEqual([{ name: 'ApprovalError', code: 'APPROVAL_REJECTED' }, { name: 'ComputerGuardError', code: 'COMPUTER_BLOCKED' }])
  })

  it('uses its own name for escalation and omits the retained owner', async () => {
    const { ctx, runtime, execute } = await setup(privateTool())
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: process.cwd() })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    vi.spyOn(runtime, 'sandboxMode', 'get').mockReturnValue('read-only')
    const requested: string[] = []
    ctx.on('approval/request', (request) => {
      requested.push(request.toolName)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    runtime.behavior = async (request) => {
      expect(request.stateOwner).toBeUndefined()
      expect(request.sandboxPolicy?.mode).toBe('workspace-write')
      return { logs: [], sandbox: { mode: 'workspace-write', denied: true } }
    }
    const result = (await execute({ sandbox_permissions: 'workspace-write', justification: 'Write computer output' })).results[0]!.result
    expect(result.isError).toBe(false)
    expect(requested).toEqual(['cua_run_code'])
    expect(JSON.stringify(result.content)).toContain('Nested tools retain their own policies and approvals')
  })

  it('records nested results while forwarding screenshots and deferred context after the program', async () => {
    type Attachment = Extract<ContentBlock, { type: 'image' }>['attachment']
    const image: ContentBlock = { type: 'image', attachment: {
      attachmentId: brandString<Attachment['attachmentId']>('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      mediaType: 'image/png', width: 1, height: 1, bytes: 1,
    } }
    const definition = defineTool({
      name: 'cua', description: 'Capture the test computer.', parameters: {},
      output: {
        schema: { type: 'string' }, render: () => [image], presentationMeta: () => ({ screen: 1 }),
      },
      execute: async (_args, exec) => {
        exec.deferContext(createUserMessage({ source: { kind: 'ptc-mode' }, content: [{ type: 'text', text: 'capture context' }] }))
        exec.concludeTurn()
        return 'raw snapshot'
      },
    })
    const { ctx, runtime, session, execute } = await setup(definition)
    ctx.on('tools/ptc-dispatch-log', async () => [{ type: 'text', text: 'durable screenshot preview' }])
    runtime.behavior = async (request) => {
      expect(await request.bindings[0]!.functions.cua!({})).toBe('raw snapshot')
      return { logs: ['inspection complete'] }
    }
    const batch = await execute()
    expect(batch.results[0]?.result.content).toEqual([{ type: 'text', text: 'inspection complete' }])
    expect(batch.concluded).toBe(true)
    expect(batch.additionalContexts.map(context => context.content)).toEqual([[image], [{ type: 'text', text: 'capture context' }]])
    const events = session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')
    expect(events.map(event => event.type)).toEqual(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
    expect(events[1]?.data).toMatchObject({
      rootCallId: 'program', parentCallId: 'program', subCallId: 'program:ptc:1', name: 'cua', arguments: {},
      isError: false, content: [{ type: 'text', text: 'durable screenshot preview' }], meta: { screen: 1 },
    })
  })

  it('cancels on owner disposal and awaits nested cleanup before releasing the factory', async () => {
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    const definition = defineTool({
      name: 'cua', description: 'Wait for computer cleanup.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, exec) => {
        exec.signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
        entered.resolve(undefined)
        await cleanup.promise
        return 'cleaned'
      },
    })
    const { ctx, runtime, agent, agentContext, session, fiber, execute } = await setup(definition)
    const release = vi.spyOn(runtime, 'release')
    runtime.behavior = async (request) => {
      void request.bindings[0]!.functions.cua!({}).catch(() => undefined)
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return { logs: [], error: { kind: 'abort', message: 'runtime cancelled' } }
    }
    const running = execute()
    let disposing: Promise<void> | undefined
    try {
      await entered.promise
      let disposed = false
      disposing = fiber.dispose().then(() => { disposed = true })
      await aborted.promise
      expect(disposed).toBe(false)
      expect(session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(0)
      cleanup.resolve(undefined)
      expect((await running).results[0]?.result).toMatchObject({ isError: true, error: { info: { code: 'CODE_RUN_FAILED' } } })
      await disposing
      expect(ctx.tools.get('cua_run_code')).toBeUndefined()
      expect(session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')).toMatchObject([
        { data: { isError: true, error: { name: 'AbortError', code: 'ABORTED' } } },
      ])
      await agentContext.fiber.dispose()
      expect(release).toHaveBeenCalledExactlyOnceWith(agent)
    } finally {
      cleanup.resolve(undefined)
      await running
      await disposing
    }
  })

  it('applies configurable call allowances using the registered tool name', async () => {
    const body = vi.fn(async () => 'private result')
    const { runtime, session, execute } = await setup(privateTool(body), { maxSubCallsPerMinute: 60, maxParallelSubCalls: 1 })
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.cua!({})
      await expect(request.bindings[0]!.functions.cua!({})).rejects.toThrow('cua_run_code exceeded its limit of 1 tool calls')
      return { logs: [], error: { kind: 'abort', message: 'allowance exhausted' } }
    }
    const result = (await execute({ timeoutMs: 1000 })).results[0]!.result
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'CODE_RUN_FAILED' } } })
    expect(JSON.stringify(result.content)).toContain('smaller cua_run_code calls')
    expect(body).toHaveBeenCalledOnce()
    expect(session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch-start')).toHaveLength(1)
  })

  it('rejects duplicate private bindings and invalid limits before registering effects', async () => {
    const definition = privateTool()
    const { ctx, runtime } = await setup(definition)
    const options = { name: 'duplicate_program', description: 'Duplicate bindings.', runtime, tools: [definition, definition] }
    expect(() => createRunCodeTool(ctx, options)).toThrow('duplicate binding cua')
    expect(() => createRunCodeTool(ctx, { ...options, tools: [definition], limits: { maxParallelSubCalls: 0 } })).toThrow()
    expect(RunCodeConfig({})).toEqual({ maxSubCallsPerMinute: 1024, maxParallelSubCalls: 10 })
    expect(ctx.tools.get('duplicate_program')).toBeUndefined()
  })
})
