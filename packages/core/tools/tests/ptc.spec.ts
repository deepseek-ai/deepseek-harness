import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId  } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ToolRuntime, { CodeRunFailedError, RUN_CODE_NAME, TOOL_ABORTED_BEFORE_DISPATCH, defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import type { Config, JsonSchemaNode, PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const testToolSignal = new AbortController().signal

/**
 * PTC mode unit tier (per the Agent Note's plan): provider contribution per mode,
 * misconfiguration rejections, the run_code dispatch bridge (serialization,
 * abort, JSON normalization, error mapping, events, quiescence), and HMR
 * safety — all against an in-repo fake runtime, exactly the
 * Service Definition / Service Provider / Consumer roles the seam promises.
 */

/** A scriptable in-repo CodeRuntime: each test sets `behavior` to drive the bindings however it needs. */
class FakeRuntime extends CodeRuntime {
  readonly language: string
  readonly isolation = 'fake'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })
  lastRequest?: CodeRunRequest

  constructor(ctx: Context, config: { language?: string } = {}) {
    super(ctx)
    this.language = config.language ?? 'typescript'
  }

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    this.lastRequest = request
    return this.behavior(request)
  }
}

interface SetupOptions {
  mode?: Config['mode']
  maxParallelSubCalls?: number
  runtime?: false | { language?: string }
  toolOrder?: string[]
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { ...options.toolOrder ? { toolOrder: options.toolOrder } : {} })
  await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'ptc', ...options.maxParallelSubCalls !== undefined ? { maxParallelSubCalls: options.maxParallelSubCalls } : {} })
  let runtime: FakeRuntime | undefined
  if (options.runtime !== false) {
    await ctx.plugin(FakeRuntime, options.runtime ?? {})
    runtime = ctx.codeRuntime as FakeRuntime
  }
  return { ctx, tools: ctx.tools, systemPrompt: ctx.systemPrompt, runtime: runtime! }
}

/** Mint an agent scope configured like production that can register scoped tool policy. */
async function mintAgentScope(ctx: Context, name = 'scoped'): Promise<{ scope: Scope; agent: Agent }> {
  const agent = { id: SessionId(name) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

/** Register a trivial echo tool; returns the calls it received. */
function registerEcho(ctx: Context, name = 'echo'): unknown[] {
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Echo tool ${name}.`,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      calls.push(args)
      return Promise.resolve(`${name}:${args.value}`)
    },
  }))
  return calls
}

/** A structural fake of the owning agent: captures session appends. */
function fakeAgent(): { agent: Agent; events: { type: string; data: unknown }[] } {
  const events: { type: string; data: unknown }[] = []
  const agent = {
    session: {
      header: { cwd: '/workspace' },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  return { agent, events }
}

/** Dispatch run_code through the registry pipeline, as the loop would. */
async function runCode(
  ctx: Context,
  code: string,
  extras: { agent?: Agent; signal?: AbortSignal; description?: string } = {},
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('call-1'),
    name: RUN_CODE_NAME,
    arguments: { code, description: extras.description ?? 'Run the test program' },
    ...extras.agent ? { agent: extras.agent } : {},
    ...extras.signal ? { signal: extras.signal } : {},
  })
}

describe('mode-aware wire contribution', () => {
  it("mode 'native' contributes every schema, no run_code, no SDK section — and needs no runtime", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native', runtime: false })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })

  it("mode 'ptc' contributes exactly [run_code] plus the SDK section declaring the other tools", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
    expect(sdk?.text).toContain('declare const tools: {')
    expect(sdk?.text).toContain('echo: {')
    expect(sdk?.text).not.toContain('run_code:')
    expect(sdk?.text).not.toContain('tools.bash(')
  })

  it("mode 'ptc' states the run_code-only rule BEFORE the per-tool guidance that names each tool", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    // Stand in for a real tool's guidance section, which names its tool without
    // saying how it is reached.
    ctx.systemPrompt.section({
      name: 'tool:echo',
      order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
      text: 'Use the echo tool.',
    })

    const assembly = await systemPrompt.assemble()
    const names = assembly.sections.map(section => section.name)
    const rule = assembly.sections.find(section => section.name === 'tools:ptc-only')
    expect(rule?.text).toContain(`\`${RUN_CODE_NAME}\` is the only tool you can call directly`)
    // The rule is worthless after the guidance it qualifies.
    expect(names.indexOf('tools:ptc-only')).toBeLessThan(names.indexOf('tool:echo'))
    expect(names.indexOf('tools:ptc-only')).toBeLessThan(names.indexOf('tools:sdk'))
  })

  it("mode 'both' omits the run_code-only rule, because native calls do execute there", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'both' })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    // Registered (the deployment is non-native) but empty, so the renderer
    // drops it: `both` executes the native call the rule would forbid.
    expect(assembly.sections.find(section => section.name === 'tools:ptc-only')?.text).toBe('')
    expect(assembly.tools.map(tool => tool.name)).toContain('echo')
  })

  it('projects deeply nested output schemas into the PTC mode SDK without structured-clone recursion', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc' })
    let output: JsonSchemaNode = { type: 'string' }
    for (let depth = 0; depth < 5_000; depth++) {
      output = { oneOf: [output, { type: 'null' }] }
    }
    ctx.tools.register({
      name: 'deep_output',
      description: 'Return a deeply nested output union.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: output,
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'null' }],
      },
      execute() { return Promise.resolve('ok') },
    })

    const assembly = await systemPrompt.assemble()
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text

    expect(sdk).toContain('deep_output: Record<string, JsonValue>;')
    expect(sdk).toContain('deep_output: string | null')
  })

  it.each(['ptc', 'both'] as const)('treats expert assembly output as authoritative in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({ mode })
    registerEcho(ctx)
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return {
        ...assembly,
        sections: assembly.sections.filter(section => section.name !== 'tools:sdk'),
        tools: assembly.tools.filter(tool => tool.name !== RUN_CODE_NAME),
      }
    }, { prepend: true })

    const assembly = await systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
    expect(assembly.tools.some(tool => tool.name === RUN_CODE_NAME)).toBe(false)
  })

  it.each(['ptc', 'both'] as const)('lets one scope shadow the default SDK section in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({ mode })
    registerEcho(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.systemPrompt.section({
      name: 'tools:sdk',
      order: scope.ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      text: 'SCOPED SDK',
    })

    const scoped = await systemPrompt.assemble({ scope: agent })
    const global = await systemPrompt.assemble()
    expect(scoped.sections.find(section => section.name === 'tools:sdk')?.text).toBe('SCOPED SDK')
    expect(global.sections.find(section => section.name === 'tools:sdk')?.text).toContain('declare const tools:')
  })

  it("mode 'both' contributes every native schema plus run_code, and the SDK section", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'both' })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo', RUN_CODE_NAME])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(true)
  })

  it.each(['ptc', 'both'] as const)('keeps the run_code transport outside scoped allow-list filtering in mode %s', async (mode) => {
    const { ctx, systemPrompt, runtime } = await setup({ mode })
    registerEcho(ctx, 'echo')
    registerEcho(ctx, 'hidden')
    const { scope, agent } = await mintAgentScope(ctx)
    const lift = scope.ctx.tools.restrict({ allow: ['echo'] })

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(mode === 'ptc'
      ? [RUN_CODE_NAME]
      : ['echo', RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).toContain('echo: {')
    expect(sdk).not.toContain('hidden:')

    runtime.behavior = request => Promise.resolve({
      logs: [],
      value: Object.keys(request.bindings[0]!.functions).sort().join(','),
    })
    const result = await runCode(ctx, 'return Object.keys(tools)', { agent })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'echo' }])

    lift()
    const unrestricted = await systemPrompt.assemble({ scope: agent })
    expect(unrestricted.tools.map(tool => tool.name)).toEqual(mode === 'ptc'
      ? [RUN_CODE_NAME]
      : ['echo', 'hidden', RUN_CODE_NAME])
  })

  it.each(['ptc', 'both'] as const)('keeps the run_code transport outside scoped deny-list filtering in mode %s', async (mode) => {
    const { ctx, systemPrompt, runtime } = await setup({ mode })
    registerEcho(ctx, 'denied')
    registerEcho(ctx, 'kept')
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.restrict({ deny: ['denied'] })

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(mode === 'ptc'
      ? [RUN_CODE_NAME]
      : ['kept', RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(sdk).not.toContain('denied:')
    expect(sdk).toContain('kept: {')

    runtime.behavior = request => Promise.resolve({
      logs: [],
      value: Object.keys(request.bindings[0]!.functions).sort().join(','),
    })
    const result = await runCode(ctx, 'return Object.keys(tools)', { agent })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'kept' }])
  })

  it.each(['ptc', 'both'] as const)('reserves run_code against scoped shadows and explicit restrictions in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({ mode })
    const { scope, agent } = await mintAgentScope(ctx)
    const impostor = defineContentToolFixture({
      name: RUN_CODE_NAME,
      description: 'Scoped impostor.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text' as const, text: 'impostor' }]),
    })

    expect(() => scope.ctx.tools.register(impostor)).toThrow(/reserved for the PTC mode presentation transport/)
    expect(() => ctx.tools.register(impostor)).toThrow(/reserved for the PTC mode presentation transport/)
    expect(() => scope.ctx.tools.restrict({ allow: [RUN_CODE_NAME] })).toThrow(/cannot name reserved PTC mode presentation transport/)
    expect(() => scope.ctx.tools.restrict({ deny: [RUN_CODE_NAME] })).toThrow(/cannot name reserved PTC mode presentation transport/)
    scope.ctx.systemPrompt.section({
      name: 'scoped-note',
      order: scope.ctx.systemPrompt.getSectionOrder('TOOLS_SDK') - 10,
      text: 'safe note',
    })
    scope.ctx.tools.register(defineContentToolFixture({
      name: 'scoped_safe',
      description: 'Safe scoped tool.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text' as const, text: 'safe' }]),
    }))

    const assembly = await systemPrompt.assemble({ scope: agent })
    const transports = assembly.tools.filter(tool => tool.name === RUN_CODE_NAME)
    expect(transports).toHaveLength(1)
    expect(transports[0]?.description).toContain('Execute a TypeScript program')
    expect(assembly.sections.find(section => section.name === 'scoped-note')?.text).toBe('safe note')
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('scoped_safe:')
    expect(ctx.tools.get(RUN_CODE_NAME, agent)).toBe(ctx.tools.get(RUN_CODE_NAME))
    const result = await runCode(ctx, 'return 1', { agent })
    expect(result.content).toEqual([{ type: 'text', text: '(run_code completed with no output)' }])
  })

  it.each(['ptc', 'both'] as const)('keeps run_code in the toolOrder universe without exposing it as a restriction target in mode %s', async (mode) => {
    const { ctx, systemPrompt } = await setup({
      mode,
      toolOrder: [RUN_CODE_NAME, '<unlisted-tools>'],
    })
    registerEcho(ctx)
    const { agent } = await mintAgentScope(ctx)

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(mode === 'ptc'
      ? [RUN_CODE_NAME]
      : [RUN_CODE_NAME, 'echo'])
  })

  it("never exposes run_code to programs, even under mode 'both' (no recursive dispatch path)", async () => {
    const { ctx, runtime } = await setup({ mode: 'both' })
    registerEcho(ctx)
    runtime.behavior = (request) => {
      expect(request.bindings[0]!.errorClass).toEqual({
        name: 'ToolCallError',
        memberNameProperty: 'toolName',
      })
      const functions = request.bindings[0]!.functions
      return Promise.resolve({
        logs: [],
        value: JSON.stringify({
          names: Object.keys(functions).sort(),
          // Own-property AND prototype-chain reads both come back empty —
          // there is no handle a program could re-enter run_code through.
          runCode: String(functions[RUN_CODE_NAME]),
        }),
      })
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ names: ['echo'], runCode: 'undefined' })
  })

  it('renders byte-identical SDK text across consecutive assemblies of an unchanged tool set', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    const first = await systemPrompt.assemble()
    const second = await systemPrompt.assemble()
    const text = (assembly: typeof first) => assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(text(first)).toBe(text(second))
  })

  it('rejects every assembly when a non-native mode has no code runtime', async () => {
    const { systemPrompt } = await setup({ mode: 'ptc', runtime: false })
    await expect(systemPrompt.assemble()).rejects.toThrow(/requires a code runtime/)
  })

  it('rejects every assembly when the runtime language has no registered SDK renderer', async () => {
    const { systemPrompt } = await setup({ mode: 'ptc', runtime: { language: 'ruby' } })
    await expect(systemPrompt.assemble()).rejects.toThrow(/no SDK renderer registered for runtime language "ruby"/)
  })

  it('assembles under a python runtime by picking the Python SDK renderer', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc', runtime: { language: 'python' } })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
    expect(sdk?.text).toContain('class Tools(Protocol):')
    expect(sdk?.text).toContain('async def echo(self, args:')
    expect(sdk?.text).toContain('top-level `await`')
  })

  it("assembles under a python runtime in mode 'both' as well, SDK and schema together", async () => {
    // `both` reaches the same wireSchemas/requireCodeRuntime/SDK-section code
    // as `ptc`, so this pins the mode-by-language matrix rather than a
    // separate path — including that the `wireSchemas` projection behind
    // `assembly.tools` picks the Python flavor under `both` instead of hitting
    // the flavor-table guard.
    const { ctx, systemPrompt } = await setup({ mode: 'both', runtime: { language: 'python' } })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('class Tools(Protocol):')
    const runCodeSchema = assembly.tools.find(tool => tool.name === RUN_CODE_NAME)
    expect(runCodeSchema?.description).toContain('Execute a Python program')
    // `both` keeps the native tools alongside run_code; `ptc` does not.
    expect(assembly.tools.map(tool => tool.name)).toContain('echo')
  })

  it('emits a TypeScript-flavored run_code schema under a typescript runtime', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc', runtime: { language: 'typescript' } })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    const runCodeSchema = assembly.tools.find(tool => tool.name === RUN_CODE_NAME)
    expect(runCodeSchema?.description).toContain('Execute a TypeScript program')
    expect(runCodeSchema?.description).toContain('BODY of an')
    // Both required arguments are named here, not only in the parameter
    // schema: prose that describes the call as "pass the program" is what
    // leads a model to emit `{code}` alone and fail INVALID_ARGS.
    expect(runCodeSchema?.description).toContain('`description`')
    const codeParam = (runCodeSchema?.parameters as { properties: { code: { description: string } } }).properties.code
    expect(codeParam.description).toBe('The program: the body of an async TypeScript function.')
  })

  it('emits a Python-flavored run_code schema under a python runtime (matches the SDK language)', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc', runtime: { language: 'python' } })
    registerEcho(ctx)
    const assembly = await systemPrompt.assemble()
    const runCodeSchema = assembly.tools.find(tool => tool.name === RUN_CODE_NAME)
    expect(runCodeSchema?.description).toContain('Execute a Python program')
    expect(runCodeSchema?.description).toContain('`return <value>`')
    expect(runCodeSchema?.description).toContain('`description`')
    expect(runCodeSchema?.description).not.toContain('TypeScript')
    const codeParam = (runCodeSchema?.parameters as { properties: { code: { description: string } } }).properties.code
    expect(codeParam.description).toBe('The program: the body of an async Python function.')
  })

  it('resolves the run_code schema flavor lazily and fails loud on a language absent from the flavor table', async () => {
    // The flavor getter reads the runtime directly (peekRuntime), so it — not
    // requireCodeRuntime — owns the flavor-table guard. Keeping
    // RUN_CODE_FLAVORS in step with SDK_RENDERERS is the compiler's job (both
    // are `satisfies`-checked against CodeSdkLanguage), so what the guard
    // covers is a mounted runtime naming a language absent from both tables,
    // which throws when the schema is projected. Assembly's
    // requireCodeRuntime rejects such a language earlier; this reaches the
    // guard on its own.
    const { ctx } = await setup({ mode: 'ptc', runtime: { language: 'ruby' } })
    const definition = ctx.tools.get(RUN_CODE_NAME)
    // Names the known languages, symmetric with the SDK_RENDERERS guard: this
    // is the reachable rejection, so it must be at least as diagnosable.
    expect(() => definition?.description)
      .toThrow(/no run_code schema flavor registered for runtime language "ruby" \(known: "typescript", "python"\)/)
  })

  it('degrades the run_code flavor to TypeScript when no runtime is mounted', async () => {
    // Any reader of the definition without a mounted runtime uses this fallback; the
    // shipped one is the tool-catalog generator, which boots the registry under
    // `mode: ptc` and reads run_code's schema WITHOUT a runtime. peekRuntime
    // returns undefined there, so the flavor getter degrades to the TS default
    // rather than throwing. None of those readers feeds a model: assembly goes
    // through wireSchemas, which requires a runtime first.
    const { ctx } = await setup({ mode: 'ptc', runtime: false })
    const definition = ctx.tools.get(RUN_CODE_NAME)
    expect(definition?.description).toContain('Execute a TypeScript program')
    const params = definition?.parameters as { properties: { code: { description: string } } }
    expect(params.properties.code.description).toBe('The program: the body of an async TypeScript function.')
  })

  it("rejects the assembly when toolOrder names a native tool that mode 'ptc' no longer contributes", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc', toolOrder: ['echo', '<unlisted-tools>'] })
    registerEcho(ctx)
    await expect(systemPrompt.assemble()).rejects.toThrow(/toolOrder lists unregistered tool "echo"/)
  })

  it('removes run_code and the SDK section when the registry fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(FakeRuntime, {})
    const fiber = await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    expect(ctx.tools.get(RUN_CODE_NAME)).toBeDefined()
    await fiber.dispose()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools).toEqual([])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })
})

describe('the sub-dispatch scheduler (native concurrency contract)', () => {
  /** Register a tool whose calls resolve only when the test releases them; returns live-call telemetry. */
  function registerGated(ctx: Context, name: string, concurrencySafe: boolean) {
    const gates: (() => void)[] = []
    let live = 0
    let peak = 0
    const order: string[] = []
    ctx.tools.register(defineTool({
      name,
      description: `Gated tool ${name}.`,
      parameters: { id: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      ...concurrencySafe ? { isConcurrencySafe: () => true } : {},
      async execute(args, exec) {
        order.push(`start:${args.id}`)
        live++
        peak = Math.max(peak, live)
        // Abort-observing like a real tool: the run-scoped abort releases the
        // gate so the bridge's drain reaches quiescence.
        await new Promise<void>((release) => {
          gates.push(release)
          exec.signal.addEventListener('abort', () => { release() }, { once: true })
        })
        live--
        order.push(`end:${args.id}`)
        return `${name}:${args.id}`
      },
    }))
    const release = (): void => { gates.shift()?.() }
    const releaseAll = (): void => { while (gates.length > 0) gates.shift()!() }
    return { order, release, releaseAll, peakLive: () => peak, pending: () => gates.length }
  }

  it('overlaps concurrency-safe calls under Promise.all and logs a start event per dispatch', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const gated = registerGated(ctx, 'safe_read', true)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const all = Promise.all([
        tools.safe_read!({ id: 'a' }),
        tools.safe_read!({ id: 'b' }),
        tools.safe_read!({ id: 'c' }),
      ])
      // All three must be START-able without any completion (overlap proof).
      await expect.poll(() => gated.pending()).toBe(3)
      gated.releaseAll()
      return { logs: [], value: (await all).map(String).join(',') }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    expect(gated.peakLive()).toBe(3)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ result: 'safe_read:a,safe_read:b,safe_read:c' })
    // One start per dispatch, paired with its settle by subCallId, starts in submission order.
    const starts = events.filter(event => event.type === 'tool/code-dispatch-start').map(event => event.data as { subCallId: string })
    const settles = events.filter(event => event.type === 'tool/code-dispatch').map(event => event.data as { subCallId: string })
    expect(starts.map(start => start.subCallId)).toEqual(['call-1:code:1', 'call-1:code:2', 'call-1:code:3'])
    expect(new Set(settles.map(settle => settle.subCallId))).toEqual(new Set(starts.map(start => start.subCallId)))
  })

  it('an exclusive call bars overlap: safe calls drain first, it runs alone, later calls wait', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const safe = registerGated(ctx, 'safe_read', true)
    const unsafe = registerGated(ctx, 'writer', false)
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const reads = [tools.safe_read!({ id: 'r1' }), tools.safe_read!({ id: 'r2' })]
      const write = tools.writer!({ id: 'w' })
      const tail = tools.safe_read!({ id: 'r3' })
      await expect.poll(() => safe.pending()).toBe(2)
      // The exclusive call must NOT have started while the pool is live.
      expect(unsafe.pending()).toBe(0)
      safe.releaseAll()
      await expect.poll(() => unsafe.pending()).toBe(1)
      // The trailing safe call must NOT start while the exclusive one runs.
      expect(safe.pending()).toBe(0)
      unsafe.release()
      await expect.poll(() => safe.pending()).toBe(1)
      safe.releaseAll()
      await Promise.all([...reads, write, tail])
      return { logs: [], value: 'ordered' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(safe.order.slice(0, 2)).toEqual(['start:r1', 'start:r2'])
    expect(unsafe.order).toEqual(['start:w', 'end:w'])
    // r3 started only after w ended.
    expect(safe.order.indexOf('start:r3')).toBeGreaterThan(safe.order.indexOf('end:r1'))
  })

  it('maxParallelSubCalls caps the overlap window', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc', maxParallelSubCalls: 2 })
    const gated = registerGated(ctx, 'safe_read', true)
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const all = Promise.all([
        tools.safe_read!({ id: 'a' }),
        tools.safe_read!({ id: 'b' }),
        tools.safe_read!({ id: 'c' }),
      ])
      await expect.poll(() => gated.pending()).toBe(2)
      // The third call waits for a slot.
      expect(gated.pending()).toBe(2)
      gated.release()
      await expect.poll(() => gated.pending()).toBe(2)
      gated.releaseAll()
      await all
      return { logs: [], value: 'capped' }
    }
    const result = await runCode(ctx, 'program')
    if (result.isError) console.error('CAP-FAIL:', (result.content[0] as { text: string }).text)
    expect(result.isError).toBe(false)
    expect(gated.peakLive()).toBe(2)
  })

  it('a tool unregistered between binding enumeration and dispatch fails as unknown tool', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls: unknown[] = []
    const dispose = ctx.tools.register(defineTool({
      name: 'ephemeral',
      description: 'Unregistered between binding enumeration and dispatch.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute() {
        calls.push('ran')
        return Promise.resolve('ok')
      },
    }))
    runtime.behavior = async (request) => {
      // The binding exists (enumerated at run start); the registry mutation
      // makes prepare resolve UNKNOWN_TOOL as a final-result, which commits
      // through scheduler.finish (no post-execute).
      dispose()
      const message = await request.bindings[0]!.functions.ephemeral!({})
        .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      return { logs: [], value: message }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ result: 'unknown tool "ephemeral"' })
    expect(calls).toEqual([])
  })

  it('ordered pre-execute never overlaps: a slow policy on one call delays the next start', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const gated = registerGated(ctx, 'safe_read', true)
    const stages: string[] = []
    let releaseGate: (() => void) | undefined
    ctx.on('tools/pre-execute', async (preExec, next) => {
      if (preExec.name !== 'safe_read') return next()
      stages.push(`pre-enter:${String(preExec.callId)}`)
      if (releaseGate === undefined) {
        // The FIRST call's policy awaits an asynchronous decision.
        await new Promise<void>((resolve) => { releaseGate = resolve })
      }
      stages.push(`pre-exit:${String(preExec.callId)}`)
      return next()
    })
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const all = Promise.all([tools.safe_read!({ id: 'a' }), tools.safe_read!({ id: 'b' })])
      // Both submissions are in; the second pre-execute must NOT have entered
      // while the first is still awaiting its policy decision.
      await expect.poll(() => stages.length).toBeGreaterThanOrEqual(1)
      expect(stages).toEqual(['pre-enter:call-1:code:1'])
      releaseGate!()
      await expect.poll(() => gated.pending()).toBe(2)
      gated.releaseAll()
      await all
      return { logs: [], value: 'ordered-prepare' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(stages).toEqual([
      'pre-enter:call-1:code:1', 'pre-exit:call-1:code:1',
      'pre-enter:call-1:code:2', 'pre-exit:call-1:code:2',
    ])
  })

  it('an exclusive call holds its barrier through post-execute: the next start waits for the commit', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const writer = registerGated(ctx, 'writer', false)
    const reader = registerGated(ctx, 'safe_read', true)
    const stages: string[] = []
    let releasePost: (() => void) | undefined
    ctx.on('tools/post-execute', async (postExec, _result, next): Promise<PostToolDecision> => {
      if (postExec.name === 'writer') {
        stages.push('post-enter:writer')
        await new Promise<void>((resolve) => { releasePost = resolve })
        stages.push('post-exit:writer')
      }
      return next()
    })
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const w = tools.writer!({ id: 'w' })
      const r = tools.safe_read!({ id: 'r' })
      await expect.poll(() => writer.pending()).toBe(1)
      writer.release()
      // The writer's body is done and its async post-execute is running; the
      // parallel read must not have STARTED (no pre/body) while the exclusive
      // call's pipeline is still open.
      await expect.poll(() => stages).toContain('post-enter:writer')
      expect(reader.pending()).toBe(0)
      releasePost!()
      await w
      await expect.poll(() => reader.pending()).toBe(1)
      reader.releaseAll()
      await r
      return { logs: [], value: 'barrier-through-commit' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(stages).toEqual(['post-enter:writer', 'post-exit:writer'])
  })

  it('run settlement drains a commit already in progress: the settle event is appended inside the turn', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const gated = registerGated(ctx, 'safe_read', true)
    const { agent, events } = fakeAgent()
    let releasePost: (() => void) | undefined
    ctx.on('tools/post-execute', async (postExec, _result, next): Promise<PostToolDecision> => {
      if (postExec.name === 'safe_read') {
        await new Promise<void>((resolve) => { releasePost = resolve })
      }
      return next()
    })
    runtime.behavior = async (request) => {
      // Fire-and-forget: the program returns while the sub-call's async
      // post-execute commit is mid-flight.
      request.bindings[0]!.functions.safe_read!({ id: 'a' }).catch(() => 'run-over')
      await expect.poll(() => gated.pending()).toBe(1)
      gated.release()
      await expect.poll(() => releasePost !== undefined).toBe(true)
      queueMicrotask(() => { releasePost!() })
      return { logs: [], value: 'returned-early' }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    // The drain awaited the in-progress commit: the settle event exists and
    // preceded the run_code turn closing (all appends happen inside
    // execute()). The run's settlement aborted the sub-call's signal while
    // its post-execute was mid-flight, so the native cancellation contract
    // replaces the successful outcome with the aborted result — the event is
    // still durable and in-turn, which is the invariant under test.
    const settles = events.filter(event => event.type === 'tool/code-dispatch')
    expect(settles).toHaveLength(1)
    expect(settles[0]?.data).toMatchObject({ name: 'safe_read', isError: true })
  })

  it('post-execute and context commitment stay in submission order under out-of-order completion', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const gated = registerGated(ctx, 'safe_read', true)
    const postOrder: string[] = []
    ctx.on('tools/post-execute', async (postExec, _result, next): Promise<PostToolDecision> => {
      if (postExec.name === 'safe_read') {
        postOrder.push(String(postExec.callId))
        return {
          kind: 'accept' as const,
          additionalContexts: [createUserMessage({
            content: [{ type: 'text' as const, text: `ctx:${String(postExec.callId)}` }],
            source: { kind: 'plugin' as const, plugin: 'order-probe' },
          })],
        }
      }
      return next()
    })
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const all = Promise.all([tools.safe_read!({ id: 'a' }), tools.safe_read!({ id: 'b' })])
      await expect.poll(() => gated.pending()).toBe(2)
      // Complete b FIRST (out of submission order), then a.
      gated.release() // releases a (FIFO gate) — invert: release twice reversed is not possible;
      gated.releaseAll()
      await all
      return { logs: [], value: 'ordered-commit' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    // Post-execute observed submission order regardless of completion interleave.
    expect(postOrder).toEqual(['call-1:code:1', 'call-1:code:2'])
    // Deferred contexts reach the outer result in the same order.
    expect(result.additionalContexts?.map(c => (c.content[0] as { text: string }).text))
      .toEqual(['ctx:call-1:code:1', 'ctx:call-1:code:2'])
  })

  it('a queued-unstarted call abandoned by run settlement logs no start event', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const gated = registerGated(ctx, 'writer', false)
    const { agent, events } = fakeAgent()
    const abandoned: string[] = []
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      // First exclusive call occupies the pool; the second queues unstarted.
      // Both rejections are captured (abandonment fires only at settlement,
      // AFTER this program has already failed — awaiting it here would deadlock).
      tools.writer!({ id: 'w1' }).catch(() => 'settled-under-abort')
      tools.writer!({ id: 'w2' }).catch((error: unknown) => {
        abandoned.push(error instanceof Error ? error.message : String(error))
      })
      await expect.poll(() => gated.pending()).toBe(1)
      // Fail the program while w1 is in flight and w2 is queued unstarted.
      throw new Error('program failed with a queued call')
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(true)
    const starts = events.filter(event => event.type === 'tool/code-dispatch-start').map(event => (event.data as { subCallId: string }).subCallId)
    const settles = events.filter(event => event.type === 'tool/code-dispatch').map(event => (event.data as { subCallId: string }).subCallId)
    // w1 started and settled under the abort; w2 never started and never
    // settled — no start event, no settle event, binding rejected with the
    // abandonment message at drain time.
    expect(starts).toEqual(['call-1:code:1'])
    expect(settles).toEqual(['call-1:code:1'])
    expect(abandoned).toEqual(['run_code run is over (run_code settled); writer tool call abandoned'])
  })
})

describe('the run_code dispatch bridge', () => {
  it('bridges tool calls, returns only the curated output, and logs one event per dispatch', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const first = await tools.echo!({ value: 'one' })
      const second = await tools.echo!({ value: 'two' })
      if (typeof first !== 'string' || typeof second !== 'string') throw new Error('echo returned a non-string')
      return { logs: [`saw ${first}`], value: second }
    }
    const result = await runCode(ctx, 'const …: string = …', { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected run_code success')
    expect(result.value).toEqual({ logs: ['saw echo:one'], result: 'echo:two' })
    expect(result.content).toEqual([{ type: 'text', text: 'saw echo:one\necho:two' }])
    expect(calls).toEqual([{ value: 'one' }, { value: 'two' }])
    const dispatches = events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches.map(event => event.data)).toEqual([
      {
        rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:code:1', name: 'echo',
        arguments: { value: 'one' }, isError: false, content: [{ type: 'text', text: 'echo:one' }],
      },
      {
        rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:code:2', name: 'echo',
        arguments: { value: 'two' }, isError: false, content: [{ type: 'text', text: 'echo:two' }],
      },
    ])
    expect(result.meta).toBeUndefined()
  })

  it('exposes only an opaque parent token to nested result observers', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'nested' })
      return { logs: [], value: 'done' }
    }

    // Freeze the nested observer's parent correlation. If that were the live
    // outer execution object, the timeout-style wrapper could not restore it.
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== RUN_CODE_NAME) return next()
      const previous = exec.signal
      exec.signal = new AbortController().signal
      const result = await next()
      exec.signal = previous
      return result
    })
    ctx.on('tools/result', (exec) => {
      if (exec.parent !== undefined) Object.freeze(exec.parent)
    })

    const result = await runCode(ctx, 'await tools.echo({ value: "nested" })')
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('forwards a nested terminal conclusion onto the successful run_code result', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    ctx.tools.register(defineTool({
      name: 'finalize',
      description: 'Terminal tool.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute(_args, exec) {
        exec.concludeTurn()
        return Promise.resolve('done')
      },
    }))
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.finalize!({})
      return { logs: [], value: 'program complete' }
    }

    const concluded = await runCode(ctx, 'await tools.finalize({})')
    expect(concluded.isError).toBe(false)
    expect(concluded.concludesTurn).toBe(true)

    // A policy that converts the nested success into an error strips the
    // marker with the result type: the recovering program cannot conclude.
    const veto = ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name !== 'finalize') return next()
      return { kind: 'block', feedback: [{ type: 'text', text: 'terminal rejected' }] }
    })
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.finalize!({}).catch(() => undefined)
      return { logs: [], value: 'recovered' }
    }
    const recovered = await runCode(ctx, 'await tools.finalize({}).catch(() => {})')
    veto()
    expect(recovered.isError).toBe(false)
    expect(recovered.concludesTurn).toBeUndefined()
  })

  it('serializes Promise.all dispatches: tool executions never overlap, in submission order', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const intervals: [string, string][] = []
    let active = 0
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'Records execution overlap.',
      parameters: { id: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        active++
        expect(active, 'probe executions overlapped').toBe(1)
        intervals.push(['enter', args.id])
        await new Promise(resolve => setTimeout(resolve, 20))
        intervals.push(['exit', args.id])
        active--
        return args.id
      },
    }))
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const values = await Promise.all([tools.probe!({ id: 'a' }), tools.probe!({ id: 'b' }), tools.probe!({ id: 'c' })])
      if (!values.every(value => typeof value === 'string')) throw new Error('probe returned a non-string')
      return { logs: [], value: values.join(',') }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(intervals).toEqual([
      ['enter', 'a'], ['exit', 'a'],
      ['enter', 'b'], ['exit', 'b'],
      ['enter', 'c'], ['exit', 'c'],
    ])
    expect(result.content[0]).toEqual({ type: 'text', text: 'a,b,c' })
  })

  it('rejects the program-side call when the tool errors, with the tool error text', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    ctx.tools.register(defineContentToolFixture({
      name: 'fail',
      description: 'Always fails.',
      parameters: {},
      execute(): Promise<never> { return Promise.reject(new Error('deliberate failure')) },
    }))
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.fail!({})
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: `caught: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const result = await runCode(ctx, 'program')
    expect(result.content[0]).toEqual({ type: 'text', text: 'caught: deliberate failure' })
  })

  it('a throwing tools/ptc-dispatch-log listener is contained: the original settled content is logged', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    ctx.on('tools/ptc-dispatch-log', () => { throw new Error('log-content listener failed') })
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], value: value as string }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    const settle = events.find(event => event.type === 'tool/code-dispatch')
    expect(settle?.data).toMatchObject({ name: 'echo', isError: false, content: [{ type: 'text', text: 'echo:x' }] })
  })

  it('a throwing tools/pre-execute listener settles the sub-call without post-execute', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    const postExecuted: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'echo') throw new Error('gate exploded')
      return next()
    })
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name === 'echo') postExecuted.push(exec.name)
      return next()
    })
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const message = await request.bindings[0]!.functions.echo!({ value: 'x' })
        .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      return { logs: [], value: message }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ result: 'gate exploded' })
    // The pipeline failure is final: the body never ran and post-execute was
    // skipped, yet the settle event still carries the error outcome.
    expect(calls).toEqual([])
    expect(postExecuted).toEqual([])
    const settles = events.filter(event => event.type === 'tool/code-dispatch')
    expect(settles).toHaveLength(1)
    expect(settles[0]?.data).toMatchObject({ name: 'echo', isError: true })
  })

  it('a tools/pre-execute deny reaches the program as a binding rejection', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'echo') return Promise.resolve({ kind: 'deny' as const, reason: 'not on my watch' })
      return next()
    })
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.echo!({ value: 'x' })
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: `denied: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const result = await runCode(ctx, 'program')
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('not on my watch')
  })

  it('rejects a binding argument that is not lossless JSON, dispatching nothing', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.echo!({ value: 'x', big: 1n })
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: error instanceof Error ? error.message : String(error) }
      }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect((result.content[0] as { text: string }).text).toContain('lossless JSON')
    expect(calls).toEqual([])
    expect(events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })

  it('dispatches and logs independent snapshots of the same lossless JSON value', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const args = Object.assign(Object.create(null) as Record<string, unknown>, { value: 'x', nested: ['same'] })
      await request.bindings[0]!.functions.echo!(args)
      return { logs: [] }
    }
    await runCode(ctx, 'program', { agent })
    expect(calls).toEqual([{ value: 'x', nested: ['same'] }])
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.arguments).toEqual({ value: 'x', nested: ['same'] })
  })

  it('defers sub-call additionalContexts onto the outer run_code result', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name === 'echo') {
        return Promise.resolve({
          kind: 'accept' as const,
          additionalContexts: [createUserMessage({
            content: [{ type: 'text' as const, text: `context for ${exec.callId}` }],
            source: { kind: 'plugin' as const, plugin: 'test' },
          })],
        })
      }
      return next()
    })
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      await request.bindings[0]!.functions.echo!({ value: 'y' })
      return { logs: [], value: 'done' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(result.additionalContexts).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'context for call-1:code:1' }],
        source: { kind: 'plugin', plugin: 'test' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'context for call-1:code:2' }],
        source: { kind: 'plugin', plugin: 'test' },
      },
    ])
  })

  it('defers image-bearing final sub-call content onto the outer run_code result', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    ctx.tools.register(defineContentToolFixture({
      name: 'image_result',
      description: 'Return one durable image.',
      parameters: {},
      execute: () => Promise.resolve([
        { type: 'text', text: 'image result' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
            mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        },
      ]),
    }))
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.image_result!({})
      return { logs: [], value: 'done' }
    }

    const result = await runCode(ctx, 'program')

    expect(result.additionalContexts).toMatchObject([{
      role: 'user',
      source: { kind: 'plugin', plugin: 'tools-code-mode' },
      content: [
        { type: 'text', text: 'image result' },
        { type: 'image', attachment: { mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      ],
    }])
  })

  it('does not defer images removed by a nested post-execute decision', async () => {
    for (const decision of ['block', 'replace'] as const) {
      const { ctx, runtime } = await setup({ mode: 'ptc' })
      ctx.tools.register(defineContentToolFixture({
        name: 'image_result',
        description: 'Return one durable image.',
        parameters: {},
        execute: () => Promise.resolve([{
          type: 'image',
          attachment: {
            attachmentId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as never,
            mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        }]),
      }))
      ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
        if (exec.name !== 'image_result') return next()
        return Promise.resolve(decision === 'block'
          ? { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
          : { kind: 'accept', content: [{ type: 'text', text: 'replaced' }] })
      })
      runtime.behavior = async (request) => {
        await request.bindings[0]!.functions.image_result!({}).catch(() => undefined)
        return { logs: [], value: 'done' }
      }

      const result = await runCode(ctx, 'program')

      expect(result.additionalContexts).toBeUndefined()
      await ctx.fiber.dispose()
    }
  })

  it('keeps sub-call contexts when run_code fails after the nested dispatch', async () => {
    const { ctx, runtime } = await setup({ mode: 'both' })
    registerEcho(ctx)
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name !== 'echo') return next()
      return Promise.resolve({
        kind: 'accept',
        additionalContexts: [createUserMessage({
          content: [{ type: 'text', text: 'nested context' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })
    })
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], error: { kind: 'exception', message: 'program failed later' } }
    }

    const result = await runCode(ctx, 'program')

    expect(result.isError).toBe(true)
    expect(result.additionalContexts).toEqual([{
      id: expect.any(String) as unknown,
      role: 'user',
      content: [{ type: 'text', text: 'nested context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }])
  })

  it('converts a failed run into a structured isError result carrying kind, message, and captured logs', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    runtime.behavior = () => Promise.resolve({
      logs: ['got this far'],
      error: { kind: 'timeout', message: 'compute budget exhausted (300ms busy)' },
    })
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' } })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('code run failed (timeout)')
    expect(text).toContain('compute budget exhausted')
    expect(text).toContain('got this far')
  })

  it('CodeRunFailedError is a HarnessError with the CODE_RUN_FAILED code', () => {
    const error = new CodeRunFailedError('boom')
    expect(error.code).toBe('CODE_RUN_FAILED')
    expect(error.name).toBe('CodeRunFailedError')
  })

  it('aborting the outer signal aborts the in-flight sub-dispatch and abandons queued ones', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const seen: string[] = []
    let sawAbort = false
    ctx.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'Slow tool observing its signal.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args, exec) {
        seen.push(args.id)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          exec.signal.addEventListener('abort', () => { sawAbort = true; clearTimeout(timer); resolve() }, { once: true })
        })
        return [{ type: 'text' as const, text: args.id }]
      },
    }))
    const controller = new AbortController()
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const calls = [tools.slow!({ id: 'first' }).catch(() => 'rejected'), tools.slow!({ id: 'second' }).catch(() => 'rejected')]
      setTimeout(() => { controller.abort('user-cancel') }, 50)
      await Promise.all(calls)
      // A real runtime would be terminated by the abort; the fake honors the
      // contract by reporting the abort as the run failure.
      return { logs: [], error: { kind: 'abort', message: 'user-cancel' } }
    }
    const result = await runCode(ctx, 'program', { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('code run failed (abort)')
    expect(seen).toEqual(['first'])
    expect(sawAbort).toBe(true)
  })

  it('a runtime that starts a binding call and then REJECTS still reaches quiescence before returning', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const { agent, events } = fakeAgent()
    let sawAbort = false
    let started!: () => void
    const inFlight = new Promise<void>((resolve) => { started = resolve })
    ctx.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'Slow tool observing its signal.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args, exec) {
        started()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          exec.signal.addEventListener('abort', () => { sawAbort = true; clearTimeout(timer); resolve() }, { once: true })
        })
        return [{ type: 'text' as const, text: args.id }]
      },
    }))
    runtime.behavior = async (request) => {
      // Start a sub-dispatch, keep its rejection held, and fail the run once the tool is
      // genuinely in flight — a seam error after work has begun.
      request.bindings[0]!.functions.slow!({ id: 'orphan' }).catch(() => 'held')
      await inFlight
      throw new Error('backend exploded')
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('backend exploded')
    // Quiescence held: the in-flight sub-dispatch was aborted and its event
    // logged INSIDE the run_code execution, not after it returned.
    expect(sawAbort).toBe(true)
    expect(events.filter(event => event.type === 'tool/code-dispatch').map(event => (event.data as { name: string }).name)).toEqual(['slow'])
  })

  it('runs without an owning agent: dispatches work, event logging is skipped', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], value: 'ok' }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ value: 'x' }])
  })

  it('executing run_code under a missing runtime is a structured isError, not a crash', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a code runtime')
  })

  it('presents the model-authored description as the execute-card title over the program input', async () => {
    const { ctx } = await setup({ mode: 'ptc' })
    const tool = ctx.tools.get(RUN_CODE_NAME)!
    // The description labels the card (the bash description precedent); the
    // program itself remains the expanded raw input.
    expect(tool.presentCall?.({ code: 'return 1', description: 'Return the constant one' })).toEqual({
      card: 'generic',
      title: 'Return the constant one',
      kind: 'execute',
      rawInput: 'return 1',
    })
  })

  it('rejects a whitespace-only description with a structured isError', async () => {
    const { ctx } = await setup({ mode: 'ptc' })
    const result = await runCode(ctx, 'return 1', { description: '   ' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('invalid description')
  })

  it.each([
    ['logs only', { logs: ['printed'] }, 'printed'],
    ['result only', { logs: [], value: 'returned' }, 'returned'],
    ['logs plus result', { logs: ['printed'], value: 'returned' }, 'printed\nreturned'],
    ['no output', { logs: [] }, '(run_code completed with no output)'],
  ] as [string, CodeRunResult, string][])('keeps %s in durable content without a result presenter', async (_name, output, text) => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    runtime.behavior = () => Promise.resolve(output)

    const result = await runCode(ctx, 'return 1')
    const tool = ctx.tools.get(RUN_CODE_NAME)!

    expect(result.content).toEqual([{ type: 'text', text }])
    // Presenters keep the pending program title and render this durable content
    // through their generic fallback. Omitting a result view also prevents the
    // host frame from carrying the same raw content a second time.
    expect('presentResult' in tool).toBe(false)
  })

  it('keeps a post-policy spill preview in durable content without a result presenter', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const preview = 'HEAD\n\n(Omitted 100 bytes. Full formatted result stored at: /tmp/run-code.txt.)\n\nTAIL'
    runtime.behavior = () => Promise.resolve({ logs: ['printed'], value: 'returned' })
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name !== RUN_CODE_NAME) return next()
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: preview }] })
    })

    const result = await runCode(ctx, 'return 1')
    const tool = ctx.tools.get(RUN_CODE_NAME)!

    expect(result.content).toEqual([{ type: 'text', text: preview }])
    expect('presentResult' in tool).toBe(false)
  })

  it('keeps canonical failure content durable without a result presenter', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    runtime.behavior = () => Promise.resolve({
      logs: ['captured before failure'],
      error: { kind: 'output-limit', message: 'outer output exceeded 8 bytes' },
    })

    const result = await runCode(ctx, 'return 1')
    const tool = ctx.tools.get(RUN_CODE_NAME)!

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Error: code run failed (output-limit): outer output exceeded 8 bytes\nCaptured output:\ncaptured before failure',
    }])
    expect('presentResult' in tool).toBe(false)
  })

  it('logs the complete sub-result content verbatim, non-text blocks and long text included', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const { agent, events } = fakeAgent()
    const long = 'x'.repeat(300)
    ctx.tools.register(defineTool({
      name: 'mixed',
      description: 'Returns mixed content.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: () => [
          { type: 'text', text: long },
          { type: 'reasoning', text: 'hidden' },
        ],
      },
      execute() {
        return Promise.resolve('mixed-value')
      },
    }))
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.mixed!({})
      return { logs: [], value }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toBe('mixed-value')
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.content).toEqual([
      { type: 'text', text: long },
      { type: 'reasoning', text: 'hidden' },
    ])
  })

  it('rejects undefined, getter-throwing, exotic, and unrepresentable binding arguments before dispatch', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    const { agent, events } = fakeAgent()
    runtime.behavior = async (request) => {
      const echo = request.bindings[0]!.functions.echo!
      const catchMessage = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      return {
        logs: [],
        value: [
          // Root undefined must reject up front: the event log rejects it as
          // data, and nothing may execute unlogged.
          await catchMessage(echo(undefined)),
          await catchMessage(echo(Object.defineProperty({}, 'bad', { enumerable: true, get() { throw 'raw-throw' } }))),
          await catchMessage(echo(Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('error-throw') } }))),
          await catchMessage(echo(new Date(0))),
          // A bare function is a value JSON cannot represent at all.
          await catchMessage(echo(() => 1)),
        ].join(' | '),
      }
    }
    const result = await runCode(ctx, 'program', { agent })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('call the tool with an arguments object')
    expect(text).toContain('lossless JSON: raw-throw')
    expect(text).toContain('lossless JSON: error-throw')
    expect(text.match(/tool arguments must be lossless JSON/g)).toHaveLength(5)
    // None dispatched or logged.
    expect(calls).toEqual([])
    expect(events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })

  it('dispatches and durably logs binding arguments deeper than the structured-clone call stack', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const depth = 5_000
    let observedDepth = 0
    let observedLeaf: JsonValue | undefined
    ctx.tools.register(defineTool({
      name: 'deep_args',
      description: 'Measure a deeply nested JSON argument.',
      parameters: { nested: { type: 'json', required: true } },
      output: {
        schema: { type: 'integer' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute(args) {
        let cursor = args.nested
        while (Array.isArray(cursor)) {
          if (cursor.length !== 1) throw new Error('expected one item per nesting layer')
          observedDepth++
          cursor = cursor[0]!
        }
        observedLeaf = cursor
        return Promise.resolve(observedDepth)
      },
    }))
    const session = Session.create(SessionId('deep-code-arguments'))
    const agent = { session } as Agent
    runtime.behavior = async (request) => {
      let nested: JsonValue = 'leaf'
      for (let index = 0; index < depth; index++) nested = [nested]
      const value = await request.bindings[0]!.functions.deep_args!({ nested })
      return { logs: [], value }
    }

    const result = await runCode(ctx, 'return tools.deep_args(...)', { agent })

    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toEqual({ logs: [], result: depth })
    expect({ observedDepth, observedLeaf }).toEqual({ observedDepth: depth, observedLeaf: 'leaf' })
    const dispatch = session.snapshotEvents().find(event => event.type === 'tool/code-dispatch')
    if (dispatch === undefined) throw new Error('expected a durable tool/code-dispatch event')
    const logged = dispatch.data.arguments as { nested: JsonValue }
    let loggedDepth = 0
    let loggedCursor = logged.nested
    while (Array.isArray(loggedCursor)) {
      if (loggedCursor.length !== 1) throw new Error('expected one logged item per nesting layer')
      loggedDepth++
      loggedCursor = loggedCursor[0]!
    }
    expect({ loggedDepth, loggedCursor }).toEqual({ loggedDepth: depth, loggedCursor: 'leaf' })
  })

  it('gives the tool and durable log the same immutable argument value', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const { agent, events } = fakeAgent()
    let mutationSucceeded: boolean | undefined
    ctx.tools.register(defineContentToolFixture({
      name: 'mutator',
      description: 'Attempts to mutate its args object.',
      parameters: { list: { type: 'array', required: true } },
      execute(args) {
        mutationSucceeded = Reflect.set(args.list, 1, 'injected-by-tool')
        return Promise.resolve([{ type: 'text' as const, text: 'protected' }])
      },
    }))
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.mutator!({ list: ['original'] })
      return { logs: [] }
    }
    const result = await runCode(ctx, 'program', { agent })
    expect(result.isError).toBe(false)
    expect(mutationSucceeded).toBe(false)
    const dispatch = events.find(event => event.type === 'tool/code-dispatch')?.data as SessionEventMap['tool/code-dispatch']
    expect(dispatch.arguments).toEqual({ list: ['original'] })
  })

  it('exposes a tool named __proto__ as an ordinary own binding', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    ctx.tools.register(defineTool({
      name: '__proto__',
      description: 'A prototype-colliding tool name.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute() { return Promise.resolve('proto-tool-ok') },
    }))
    runtime.behavior = async (request) => {
      const functions = request.bindings[0]!.functions
      expect(Object.getPrototypeOf(functions)).toBeNull()
      const value = await functions['__proto__']!({})
      return { logs: [], value }
    }
    const result = await runCode(ctx, 'program')
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'proto-tool-ok' })
  })

  it('renders every non-string JSON root as pretty JSON while preserving strings raw', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: { n: 42, ok: true } })
    expect((await runCode(ctx, 'object')).content[0]).toEqual({ type: 'text', text: '{\n  "n": 42,\n  "ok": true\n}' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: {} })
    expect((await runCode(ctx, 'empty object')).content[0]).toEqual({ type: 'text', text: '{}' })
    const nested = { outer: [{ inner: true }] }
    runtime.behavior = () => Promise.resolve({ logs: [], value: nested })
    expect((await runCode(ctx, 'nested')).content[0]).toEqual({ type: 'text', text: JSON.stringify(nested, null, 2) })
    runtime.behavior = () => Promise.resolve({ logs: [], value: ['x', 2] })
    expect((await runCode(ctx, 'array')).content[0]).toEqual({ type: 'text', text: '[\n  "x",\n  2\n]' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: [] })
    expect((await runCode(ctx, 'empty array')).content[0]).toEqual({ type: 'text', text: '[]' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: null })
    expect((await runCode(ctx, 'null')).content[0]).toEqual({ type: 'text', text: 'null' })
    runtime.behavior = () => Promise.resolve({ logs: [], value: 'raw' })
    expect((await runCode(ctx, 'string')).content[0]).toEqual({ type: 'text', text: 'raw' })
    runtime.behavior = () => Promise.resolve({ logs: [] })
    const absent = await runCode(ctx, 'undefined')
    expect(absent.content[0]).toEqual({ type: 'text', text: '(run_code completed with no output)' })
    expect(absent.isError ? undefined : absent.value).toEqual({ logs: [] })
  })

  it('renders deeply nested JSON without recursive traversal or quadratic indentation', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    let value: JsonValue = {
      emptyArray: [],
      emptyObject: {},
      pair: ['leaf', 2],
      record: { first: true, second: null },
    }
    for (let depth = 0; depth < 5_000; depth++) value = [value]
    runtime.behavior = () => Promise.resolve({ logs: [], value })

    const result = await runCode(ctx, 'deep result')

    expect(result.isError).toBe(false)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text.startsWith('[\n  [\n    [')).toBe(true)
    expect(text).toContain('"leaf"')
    expect(text.endsWith(']')).toBe(true)
    expect(text.length).toBeLessThan(11_000)
  })

  it('short-circuits a pre-aborted outer signal before the code runtime', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    runtime.behavior = (request) => {
      // The fake honors the seam contract for an already-aborted signal.
      if (request.signal?.aborted) return Promise.resolve({ logs: [], error: { kind: 'abort' as const, message: String(request.signal.reason) } })
      return Promise.resolve({ logs: [], value: 'unreachable' })
    }
    const controller = new AbortController()
    controller.abort('too-late')
    const result = await runCode(ctx, 'program', { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      isError: true,
      error: {
        message: 'tool call aborted before dispatch',
        info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      },
    })
    expect(runtime.lastRequest).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('reports cancellation after rejecting a late binding without dispatching it', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc' })
    const calls = registerEcho(ctx)
    const controller = new AbortController()
    runtime.behavior = async (request) => {
      controller.abort('cancelled-mid-run')
      const message = await request.bindings[0]!.functions.echo!({ value: 'x' })
        .then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
      return { logs: [], value: message }
    }
    const result = await runCode(ctx, 'program', { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted',
      info: { name: 'AbortError', code: 'ABORTED' },
    })
    expect((result.content[0] as { text: string }).text).toBe('Error: tool call aborted')
    expect(calls).toEqual([])
  })

  it('a tool/code-dispatch event never derives a model message', () => {
    const session = Session.create(SessionId('ptc-derive'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('tool/code-dispatch', {
      rootCallId: ToolCallId('p1'),
      parentCallId: ToolCallId('p1'),
      subCallId: ToolCallId('p1:code:1'),
      name: 'echo',
      arguments: { value: 'x' },
      isError: false,
      content: [{ type: 'text', text: 'echo:x' }],
    })
    const derived = session.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.role).toBe('user')
  })

  it('direct construction rejects a non-positive parallel sub-call cap at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    expect(() => new ToolRuntime(ctx, { mode: 'ptc', maxParallelSubCalls: 0 }))
      .toThrow('maxParallelSubCalls must be a positive integer')
  })

  it('direct construction in PTC mode defaults the parallel sub-call cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const registry = new ToolRuntime(ctx, { mode: 'ptc' })
    expect(registry.get(RUN_CODE_NAME)).toBeDefined()
  })

  it('defaults to native mode under direct construction with no config', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const registry = new ToolRuntime(ctx)
    expect(registry.get(RUN_CODE_NAME)).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })
  it('denies a model-direct native-tool call under PTC mode as UNKNOWN_TOOL', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const registry = new ToolRuntime(ctx, { mode: 'ptc' })
    registerEcho(ctx, 'write')
    const result = await registry.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-1'),
      name: 'write',
      arguments: { text: 'hello' },
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
    // The name IS declared to this model, so a bare `unknown tool` reads as a
    // broken deployment. The denial carries the route instead.
    expect(result.error?.message).toBe(
      `unknown tool "write": only \`${RUN_CODE_NAME}\` is callable directly — call \`write\` from inside a \`${RUN_CODE_NAME}\` program instead`,
    )
  })

  it('routes a pre-aborted collapsed call through ABORTED_BEFORE_DISPATCH', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const registry = new ToolRuntime(ctx, { mode: 'ptc' })
    registerEcho(ctx, 'write')
    const aborted = new AbortController()
    aborted.abort()
    const result = await registry.execute({
      signal: aborted.signal,
      callId: ToolCallId('call-1'),
      name: 'write',
      arguments: { text: 'hello' },
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
  })

})

/**
 * Presentation is per agent, because an agent preset composes it: one
 * deployment runs a PTC mode agent beside native ones, and neither may see
 * the other's catalog. The deployment `mode` is the default those agents
 * shadow, not a process-wide fact.
 */
describe('per-agent presentation', () => {
  it('gives one agent PTC mode while the deployment stays native', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native' })
    const calls = registerEcho(ctx)
    const { scope, agent } = await mintAgentScope(ctx)

    scope.ctx.tools.presentAs('ptc')

    const coded = await systemPrompt.assemble({ scope: agent })
    expect(coded.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    expect(coded.sections.find(section => section.name === 'tools:sdk')?.text)
      .toContain('echo')
    // Announced surface and callable surface must agree for THIS agent, whose
    // mode is its own rather than the deployment's.
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('coded-direct'),
      name: 'echo',
      arguments: { value: 'coded' },
      agent,
    })
    expect(denied.error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
    expect(calls).toEqual([])
    // The deployment default is untouched: an agent that declared nothing —
    // and the global view behind it — still sees the native catalog.
    const native = await systemPrompt.assemble()
    expect(native.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(native.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })

  it('inherits a STANDING preset scope\'s mode down the chain, agents beside it unaffected', async () => {
    const { bindScopeParent } = await import('@deepseek-ai/dsh-scope')
    const { ctx, systemPrompt } = await setup({ mode: 'native' })
    const calls = registerEcho(ctx)
    // The preset's standing scope declares once; the agent only PARENTS to it
    // (the per-preset standing mount configuration has no per-agent declaration).
    const standing = await mintAgentScope(ctx, 'preset:ptc-like')
    standing.scope.ctx.tools.presentAs('ptc')
    const joined = await mintAgentScope(ctx, 'joined-agent')
    bindScopeParent(joined.agent, standing.agent)
    const loner = await mintAgentScope(ctx, 'loner-agent')

    expect(ctx.tools.get(RUN_CODE_NAME, joined.agent)).toBeDefined()
    const coded = await systemPrompt.assemble({ scope: joined.agent })
    expect(coded.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    // Through the EXECUTOR, not just the wire: the deployment default is
    // `native` here, so a collapse predicate reading it instead of this
    // scope's effective mode would announce [run_code] and still execute the
    // native call — the bypass, reopened for exactly the preset composition
    // `dsh-agent-tool-presentation` produces.
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: ToolCallId('preset-coded-schedule'),
      name: 'echo',
      arguments: { value: 'joined' },
      agent: joined.agent,
    })).toEqual({ kind: 'exclusive' })
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('preset-coded-direct'),
      name: 'echo',
      arguments: { value: 'joined' },
      agent: joined.agent,
    })
    expect(denied.error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
    expect(calls).toEqual([])
    // A sibling that never parented stays native, as does the global view.
    expect(ctx.tools.get(RUN_CODE_NAME, loner.agent)).toBeUndefined()
    const native = await systemPrompt.assemble({ scope: loner.agent })
    expect(native.tools.map(tool => tool.name)).toEqual(['echo'])
    const allowed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('native-sibling-direct'),
      name: 'echo',
      arguments: { value: 'loner' },
      agent: loner.agent,
    })
    expect(allowed).toMatchObject({ isError: false, value: 'echo:loner' })
    expect(calls).toEqual([{ value: 'loner' }])
  })

  it('keeps run_code out of a native agent\'s dispatch table', async () => {
    const { ctx } = await setup({ mode: 'native' })
    registerEcho(ctx)
    const coded = await mintAgentScope(ctx, 'coded')
    const plain = await mintAgentScope(ctx, 'plain')
    coded.scope.ctx.tools.presentAs('ptc')

    // Not merely hidden from the prompt: the transport one agent presents must
    // not be dispatchable by another that never presented it.
    expect(ctx.tools.get(RUN_CODE_NAME, coded.agent)).toBeDefined()
    expect(ctx.tools.get(RUN_CODE_NAME, plain.agent)).toBeUndefined()
    expect(ctx.tools.get(RUN_CODE_NAME)).toBeUndefined()
  })

  it('lets an agent opt out of a PTC mode deployment', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'ptc' })
    registerEcho(ctx)
    const { scope, agent } = await mintAgentScope(ctx)

    scope.ctx.tools.presentAs('native')

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
    // The deployment's global section still reaches this scope; rendering it
    // empty is what keeps the opted-out agent's prompt free of an SDK.
    expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toBe('')
  })

  it('restores the deployment default when the agent unloads', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native' })
    registerEcho(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    const dispose = scope.ctx.tools.presentAs('ptc')

    dispose()

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
  })

  it('refuses a second declaration for the same agent', async () => {
    const { ctx } = await setup({ mode: 'native' })
    const { scope } = await mintAgentScope(ctx)
    scope.ctx.tools.presentAs('ptc')

    // Two answers to "which form does the model see" is a contradiction, and
    // silently keeping either one would make the composition unreadable.
    expect(() => scope.ctx.tools.presentAs('both'))
      .toThrow('conflicts with "ptc" already declared')
  })

  it('refuses an unscoped declaration', async () => {
    const { ctx } = await setup({ mode: 'native' })

    expect(() => ctx.tools.presentAs('ptc'))
      .toThrow('requires a scoped context')
  })

  it('reserves run_code even where no agent presents it', async () => {
    const { ctx } = await setup({ mode: 'native' })

    // The name must stay free under a native deployment too: an agent preset
    // mounting later would otherwise collide with whatever took it.
    expect(() => registerEcho(ctx, RUN_CODE_NAME)).toThrow('is reserved')
  })

  it('reports the missing runtime against the agent\'s own mode', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native', runtime: false })
    registerEcho(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.presentAs('both')

    await expect(systemPrompt.assemble({ scope: agent }))
      .rejects.toThrow('mode "both" requires a code runtime')
  })
})
