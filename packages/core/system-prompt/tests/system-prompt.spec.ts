import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, {
  AssembleContext, PromptAssembly, renderContextSnapshot, renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'
import type { PromptContextOrderName, PromptSectionOrderName } from '@deepseek-ai/dsh-system-prompt'

/**
 * Every assembly carries the plugin's own built-ins — `harness:identity`
 * and `deployment:persona-prefix` / `deployment:persona-suffix` (from config). Tests about
 * registry MECHANICS strip them with {@link contributed} to stay focused on
 * their own sections; the built-ins' behavior is pinned by its own describe.
 */
const BUILT_IN = ['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix']
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const SECTION_ORDER_NAMES = [
  'HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_PREFIX',
  'PLAN_POLICY', 'TEAM_POLICY', 'PTC_ONLY', 'FILE_REFERENCE', 'TOOL_BASH',
  'TOOL_PWSH', 'TOOL_READ', 'TOOL_WRITE', 'TOOL_EDIT', 'TOOL_GLOB',
  'TOOL_GREP', 'TOOL_JOBS', 'TOOL_PTY', 'TOOL_WEB_SEARCH', 'TOOL_WEB_FETCH',
  'TOOL_LSP', 'TOOL_SESSION_QUERY', 'TOOL_GOAL', 'TOOL_CORDIS', 'TOOL_WORKFLOW',
  'TOOL_RALPH', 'TOOL_SUBAGENT', 'TOOL_REPORT', 'TOOLS_SDK',
  'DELIVERABLE_FILE_REFERENCES', 'STRUCTURED_OUTPUT',
  'HARNESS_SOURCE', 'WEB_SURFACE', 'DEPLOYMENT_PERSONA_SUFFIX',
] as const satisfies readonly PromptSectionOrderName[]
const CONTEXT_ORDER_NAMES = [
  'SANDBOX_POLICY', 'APPROVAL_POLICY', 'SUBAGENT_DELEGATION',
] as const satisfies readonly PromptContextOrderName[]
function contributed(assembly: PromptAssembly): PromptAssembly['sections'] {
  return assembly.sections.filter(section => !BUILT_IN.includes(section.name))
}

describe('SystemPrompt', () => {
  it('keeps repository section placements unique, integral, and at least ten apart', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const orders = SECTION_ORDER_NAMES.map(name => ctx.systemPrompt.getSectionOrder(name))
    expect(orders.every(Number.isInteger)).toBe(true)
    expect(new Set(orders).size).toBe(orders.length)
    const sorted = [...orders].sort((a, b) => a - b)
    expect(sorted.slice(1).every((order, index) => order - sorted[index]! >= 10)).toBe(true)
  })

  it('keeps reusable instructions identical across local environments', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { personaPrefix: 'Model {{model}}.', personaSuffix: 'In {{cwd}} on {{platform}}.' })
      let environment = { model: 'model-a', cwd: '/alice/project', platform: 'darwin', source: '/alice/dsh', url: 'http://127.0.0.1:3080' }
      for (const key of ['model', 'cwd', 'platform'] as const) {
        ctx.systemPrompt.variable(key, () => environment[key])
      }
      const reusable = SECTION_ORDER_NAMES.filter(name =>
        !['HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_PREFIX', 'HARNESS_SOURCE', 'WEB_SURFACE', 'DEPLOYMENT_PERSONA_SUFFIX'].includes(name))
      for (const name of [...reusable].reverse()) {
        ctx.systemPrompt.section({ name, order: ctx.systemPrompt.getSectionOrder(name), text: name })
      }
      ctx.systemPrompt.section({
        name: 'source', order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'), text: () => environment.source,
      })
      ctx.systemPrompt.section({
        name: 'web', order: ctx.systemPrompt.getSectionOrder('WEB_SURFACE'), text: () => environment.url,
      })
      const first = renderPrompt(await ctx.systemPrompt.assemble())
      environment = { model: 'model-a', cwd: 'C:/bob/project', platform: 'win32', source: 'C:/bob/dsh', url: 'http://127.0.0.1:4080' }
      const second = renderPrompt(await ctx.systemPrompt.assemble())
      const prefix = [IDENTITY, 'Model model-a.', ...reusable].join('\n\n') + '\n\n'
      expect(first).toBe(prefix + '/alice/dsh\n\nhttp://127.0.0.1:3080\n\nIn /alice/project on darwin.')
      expect(second).toBe(prefix + 'C:/bob/dsh\n\nhttp://127.0.0.1:4080\n\nIn C:/bob/project on win32.')
      environment.model = 'model-b'
      expect(renderPrompt(await ctx.systemPrompt.assemble()))
        .toBe(second.replace('Model model-a.', 'Model model-b.'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps repository context placements unique and integral', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const orders = CONTEXT_ORDER_NAMES.map(name => ctx.systemPrompt.getContextOrder(name))
    expect(orders.every(Number.isInteger)).toBe(true)
    expect(new Set(orders).size).toBe(orders.length)
  })

  describe('built-in sections', () => {
    it('renders the environment after guidance and reports its strict interpolation errors', async () => {
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt, { personaPrefix: 'Model {{model}}.', personaSuffix: 'Workspace {{cwd}}.' })
        ctx.systemPrompt.variable('model', () => 'm')
        ctx.systemPrompt.section({ name: 'guidance', order: 100, text: 'Use tools.' })
        const unresolved = await ctx.systemPrompt.assemble()
        expect(() => renderPrompt(unresolved))
          .toThrow('unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"')
        ctx.systemPrompt.variable('cwd', () => '/work')
        expect(renderPrompt(await ctx.systemPrompt.assemble()))
          .toBe(`${IDENTITY}\n\nModel m.\n\nUse tools.\n\nWorkspace /work.`)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('registers the harness identity and the configured deployment persona', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: 'You are DeepSeek Harness.' })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(s => s.name)).toEqual([
        'harness:identity',
        'deployment:persona-prefix',
        'deployment:persona-suffix',
      ])
      expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\nYou are DeepSeek Harness.`)
      // The names are reserved by the plugin — one owner per section.
      expect(() => ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'imposter' }))
        .toThrow('prompt section "deployment:persona-prefix" is already registered')
    })

    it('renders no persona section for a persona-less deployment (empty default)', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)
    })

    it('can omit the harness identity for a deployment that owns the complete persona', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        personaPrefix: 'You are a helpful software engineer assistant.',
      })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(section => section.name)).toEqual(['deployment:persona-prefix', 'deployment:persona-suffix'])
      expect(renderPrompt(assembly)).toBe('You are a helpful software engineer assistant.')
    })

    it('can suppress runtime context without evaluating providers or accepting waterfall additions', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
      let providerCalls = 0
      ctx.systemPrompt.context({
        name: 'policy',
        order: 0,
        text: () => `policy ${++providerCalls}`,
      })
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        assembly.contexts.push({ name: 'late', text: 'late context' })
        return next()
      })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.contexts).toEqual([])
      expect(providerCalls).toBe(0)
    })

    it('tolerates a schema-bypassing direct construction (persona omitted)', async () => {
      // ctx.plugin validates + defaults the config first; a direct construction
      // skips the schema, so the ctor's `?? ''` narrowing is what fires.
      const ctx = new Context()
      const service = new SystemPrompt(ctx, {})
      expect(renderPrompt(await service.assemble())).toBe(IDENTITY)
    })
  })

  it('assembles sections in order with context-resolved text and collected tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are DeepSeek Harness.' })

    ctx.systemPrompt.section({ name: 'cwd', order: 20, text: () => 'cwd: /tmp' })
    ctx.systemPrompt.section({ name: 'rules', order: 10, text: 'Be precise.' })
    ctx.systemPrompt.context({ name: 'later', order: 20, text: () => 'context 2' })
    ctx.systemPrompt.context({ name: 'earlier', order: 10, text: 'context 1' })
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'echo', description: 'echo back', parameters: {} }] }))

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(s => s.name)).toEqual(['harness:identity', 'deployment:persona-prefix', 'rules', 'cwd', 'deployment:persona-suffix'])
    expect(assembly.sections.map(s => s.text)).toEqual([IDENTITY, 'You are DeepSeek Harness.', 'Be precise.', 'cwd: /tmp', ''])
    expect(assembly.contexts).toEqual([
      { name: 'earlier', text: 'context 1' },
      { name: 'later', text: 'context 2' },
    ])
    expect(assembly.tools).toEqual([{ name: 'echo', description: 'echo back', parameters: {} }])
    expect(assembly.variables).toEqual({})
    expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\nYou are DeepSeek Harness.\n\nBe precise.\n\ncwd: /tmp`)
    expect(renderContextSnapshot(assembly)).toBe('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\ncontext 1\n\ncontext 2')
  })

  it('breaks equal section orders by code-unit name regardless of registration order', async () => {
    for (const names of [['äther', 'zeta'], ['zeta', 'äther']] as const) {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      for (const name of names) ctx.systemPrompt.section({ name, order: 10, text: name })
      expect(contributed(await ctx.systemPrompt.assemble()).map(section => section.name)).toEqual(['zeta', 'äther'])
    }
  })

  it('resolves section text providers against the assemble context, at each assemble call', async () => {
    // The context is HOW per-agent sections work (the loop passes { agent });
    // this spec stays agent-agnostic and smuggles a marker through a plain field.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let calls = 0
    ctx.systemPrompt.section({
      name: 'dynamic',
      order: 0,
      text: (context: AssembleContext) => `call ${++calls} for ${(context as { who?: string }).who ?? 'nobody'}`,
    })

    expect(contributed(await ctx.systemPrompt.assemble({ who: 'alice' } as AssembleContext))[0]!.text).toBe('call 1 for alice')
    expect(contributed(await ctx.systemPrompt.assemble())[0]!.text).toBe('call 2 for nobody')
  })

  it('removes contributions when the contributing fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.section({ name: 'scoped', order: 0, text: 'scoped section' })
      inner.systemPrompt.context({ name: 'scoped-context', order: 0, text: 'scoped context' })
      inner.systemPrompt.tools(() => ({ schemas: [{ name: 'scoped-tool', description: '', parameters: {} }] }))
      inner.systemPrompt.variable('scoped_var', () => 'v')
    }, { inject: ['systemPrompt'] }))

    const before = await ctx.systemPrompt.assemble()
    expect(contributed(before)).toHaveLength(1)
    expect(before.contexts).toHaveLength(1)
    expect(before.variables).toEqual({ scoped_var: 'v' })
    await fiber.dispose()
    const assembly = await ctx.systemPrompt.assemble()
    expect(contributed(assembly)).toHaveLength(0)
    expect(assembly.contexts).toHaveLength(0)
    // The built-ins belong to the service fiber, so they survive the plugin's disposal.
    expect(assembly.sections.map(s => s.name)).toEqual(BUILT_IN)
    expect(assembly.tools).toHaveLength(0)
    expect(assembly.variables).toEqual({})
  })

  it('rejects a duplicate section name (a double-loaded plugin must fail, not double its text)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'dup', order: 0, text: 'first' })
    expect(() => ctx.systemPrompt.section({ name: 'dup', order: 1, text: 'second' }))
      .toThrow('prompt section "dup" is already registered')
    // The failed registration leaked nothing; the original stays intact.
    const assembly = await ctx.systemPrompt.assemble()
    expect(contributed(assembly).map(s => s.text)).toEqual(['first'])
  })

  it('rejects a non-finite section order', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    expect(() => ctx.systemPrompt.section({ name: 'bad-order', order: Number.NaN, text: 'x' }))
      .toThrow('order must be a finite number')
    expect(contributed(await ctx.systemPrompt.assemble())).toEqual([])
  })

  it('rejects duplicate and non-finite context registrations without leaking', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'first' })
    expect(() => ctx.systemPrompt.context({ name: 'policy', order: 2, text: 'second' }))
      .toThrow('prompt context "policy" is already registered')
    expect(() => ctx.systemPrompt.context({ name: 'bad', order: Number.NaN, text: 'x' }))
      .toThrow('prompt context "bad" order must be a finite number')
    expect((await ctx.systemPrompt.assemble()).contexts).toEqual([{ name: 'policy', text: 'first' }])
  })

  it('rolls back a section when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    // Throw on the first emit only. Note the rollback path itself emits
    // system-prompt/change, so a multi-shot guard would also fire on rollback;
    // a single-shot guard isolates the register's own emit.
    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })).toThrow('boom change listener')
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(0) // nothing leaked

    // Subsequent listener-free register contributes exactly once.
    off()
    ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })
    expect(contributed(await ctx.systemPrompt.assemble()).map(s => s.name)).toEqual(['p'])
  })

  it('rolls back a tool provider when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: '', parameters: {} }] }))).toThrow('boom change listener')
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0) // nothing leaked

    off()
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: '', parameters: {} }] }))
    expect((await ctx.systemPrompt.assemble()).tools.map(t => t.name)).toEqual(['t'])
  })

  it('snapshots tool-provider membership before evaluating an assembly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let added = false
    ctx.systemPrompt.tools(() => {
      if (!added) {
        added = true
        ctx.systemPrompt.tools(() => ({
          schemas: [{ name: 'late', description: '', parameters: {} }],
        }))
      }
      return { schemas: [{ name: 'first', description: '', parameters: {} }] }
    })

    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['first'])
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['first', 'late'])
  })

  it('rolls back a variable when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.variable('v', () => 'x')).toThrow('boom change listener')
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({}) // nothing leaked

    off()
    ctx.systemPrompt.variable('v', () => 'x')
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({ v: 'x' })
  })

  it('composes multiple system-prompt/assemble waterfall listeners in order, with the context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 10, text: 'base' })

    // Listener A appends a section, then delegates.
    const contexts: AssembleContext[] = []
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, context, next) => {
      contexts.push(context)
      assembly.sections.push({ name: 'from-a', text: 'a' })
      return next()
    })
    // Listener B (registered later, runs after A) sees A's contribution.
    const seen: string[][] = []
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, _context, next) => {
      seen.push(assembly.sections.map(s => s.name))
      return next()
    })

    const passed: AssembleContext = {}
    const assembly = await ctx.systemPrompt.assemble(passed)
    expect(seen).toEqual([['harness:identity', 'deployment:persona-prefix', 'base', 'deployment:persona-suffix', 'from-a']])
    expect(assembly.sections.map(s => s.name)).toEqual(['harness:identity', 'deployment:persona-prefix', 'base', 'deployment:persona-suffix', 'from-a'])
    expect(contexts[0]).toBe(passed) // the caller's context reaches listeners
  })

  it('lets a waterfall listener short-circuit by not calling next()', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'real', order: 0, text: 'real' })

    ctx.on('system-prompt/assemble', async () => {
      return { sections: [], contexts: [], tools: [], variables: {} } satisfies PromptAssembly
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections).toHaveLength(0)
  })

  it('restores one complete section after the assembly waterfall', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'complete', order: 10, text: 'Exact prompt.', complete: true })
    ctx.systemPrompt.section({ name: 'extra', order: 20, text: 'extra' })
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const complete = assembly.sections.find(section => section.name === 'complete')
      if (complete === undefined) throw new Error('complete section missing before waterfall')
      complete.text = 'mutated'
      assembly.sections.push({ name: 'late', text: 'late' })
      return next()
    }, { prepend: true })

    expect((await ctx.systemPrompt.assemble()).sections).toEqual([
      { name: 'complete', text: 'Exact prompt.' },
    ])
  })

  it('rejects multiple effective complete sections', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'first', order: 10, text: 'first', complete: true })
    ctx.systemPrompt.section({ name: 'second', order: 20, text: 'second', complete: true })

    await expect(ctx.systemPrompt.assemble())
      .rejects.toThrow('multiple complete prompt sections are active: "first", "second"')
  })

  it('assembles snapshots so one-step mutations do not leak into future assemblies', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 10, text: 'base' })
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }] }))

    const first = await ctx.systemPrompt.assemble()
    first.sections[0]!.name = 'mutated'
    first.sections[0]!.text = 'mutated'
    first.contexts.push({ name: 'mutated', text: 'mutated' })
    first.tools[0]!.description = 'mutated'
    const firstParameters = first.tools[0]!.parameters as { properties: Record<string, unknown> }
    firstParameters.properties['leak'] = { type: 'string' }

    const second = await ctx.systemPrompt.assemble()
    expect(second.sections.map(section => section.name)).toEqual(['harness:identity', 'deployment:persona-prefix', 'base', 'deployment:persona-suffix'])
    expect(second.sections[0]!.text).toBe(IDENTITY)
    expect(second.contexts).toEqual([])
    expect(second.tools).toEqual([{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }])
  })

  it('filters out empty section text from renderPrompt', () => {
    const result = renderPrompt({
      sections: [
        { name: 'empty', text: '' },
        { name: 'real', text: 'content' },
      ],
      contexts: [],
      tools: [],
      variables: {},
    })
    expect(result).toBe('content')
  })

  it('filters empty context, interpolates variables, and returns empty without active context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.context({ name: 'empty', order: 0, text: '' })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toBe('')
    ctx.systemPrompt.variable('mode', () => 'read-only')
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'Mode: {{mode}}.' })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble()))
      .toBe('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nMode: read-only.')
  })

  it('attributes context interpolation failures to the contributing context', () => {
    expect(() => renderContextSnapshot({
      sections: [],
      contexts: [{ name: 'policy', text: 'Mode: {{missing}}.' }],
      tools: [],
      variables: {},
    })).toThrow('unknown prompt variable "{{missing}}" in context "policy"; registered variables: (none)')
  })

  it('emits system-prompt/change when a tool provider is registered and disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let changeCount = 0
    ctx.on('system-prompt/change', () => void changeCount++)

    const dispose = ctx.systemPrompt.tools(() => ({ schemas: [] }))
    // registration emits change
    expect(changeCount).toBe(1)

    dispose()
    // disposal emits change again
    expect(changeCount).toBe(2)
  })

  it('emits system-prompt/change when a context is registered and disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let changeCount = 0
    ctx.on('system-prompt/change', () => void changeCount++)
    const dispose = ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'current' })
    expect(changeCount).toBe(1)
    dispose()
    expect(changeCount).toBe(2)
  })

  it('cleans up tool providers on fiber dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.tools(() => ({ schemas: [{ name: 'fiber-tool', description: '', parameters: {} }] }))
    }, { inject: ['systemPrompt'] }))

    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })

  it('removes section when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.section({ name: 'direct', order: 0, text: 'direct section' })
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(1)

    dispose()
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(0)
  })

  it('removes tool provider when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'direct-tool', description: '', parameters: {} }] }))
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)

    dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })

  describe('prompt variables', () => {
    it('resolves each variable against the assemble context and emits change on register/unregister', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      let changeCount = 0
      ctx.on('system-prompt/change', () => void changeCount++)

      const dispose = ctx.systemPrompt.variable('who', context => (context as { who?: string }).who)
      expect(changeCount).toBe(1)

      expect((await ctx.systemPrompt.assemble({ who: 'alice' } as AssembleContext)).variables).toEqual({ who: 'alice' })
      // A provider returning undefined records "registered but no value here".
      expect((await ctx.systemPrompt.assemble()).variables).toEqual({ who: undefined })

      dispose()
      expect(changeCount).toBe(2)
      expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    })

    it('live-iterates variables registered by an earlier provider', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      let added = false
      ctx.systemPrompt.variable('first', () => {
        if (!added) {
          added = true
          ctx.systemPrompt.variable('late', () => 'second value')
        }
        return 'first value'
      })

      expect((await ctx.systemPrompt.assemble()).variables).toEqual({
        first: 'first value',
        late: 'second value',
      })
    })

    it('rejects a duplicate variable name and an unreferenceable name', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.variable('model', () => 'm1')
      expect(() => ctx.systemPrompt.variable('model', () => 'm2'))
        .toThrow('prompt variable "model" is already registered')
      expect(() => ctx.systemPrompt.variable('Not Valid', () => 'x'))
        .toThrow('invalid prompt variable name "Not Valid"')
      // Neither failed registration leaked.
      expect((await ctx.systemPrompt.assemble()).variables).toEqual({ model: 'm1' })
    })

    it('interpolates {{name}} references in section text at render — the persona included', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: 'You run on {{model}} in {{cwd}}.' })
      ctx.systemPrompt.variable('model', () => 'deepseek-v4')
      ctx.systemPrompt.variable('cwd', () => '/work')

      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\nYou run on deepseek-v4 in /work.`)
    })

    it('lets a waterfall listener add or override variables before render', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 's', order: 0, text: '{{extra}}' })
      ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, _context, next) => {
        assembly.variables['extra'] = 'from-waterfall'
        return next()
      })
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\nfrom-waterfall`)
    })

    it('throws on a reference to an unregistered variable, listing what exists', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 'persona', order: 0, text: 'on {{modle}}' })
      ctx.systemPrompt.variable('model', () => 'm')
      await expect(async () => renderPrompt(await ctx.systemPrompt.assemble()))
        .rejects.toThrow('unknown prompt variable "{{modle}}" in section "persona"; registered variables: model')
    })

    it('names "(none)" when no variables are registered at all', () => {
      expect(() => renderPrompt({ sections: [{ name: 's', text: '{{x}}' }], contexts: [], tools: [], variables: {} }))
        .toThrow('unknown prompt variable "{{x}}" in section "s"; registered variables: (none)')
    })

    it('throws when a referenced variable has no value for this assembly', () => {
      expect(() => renderPrompt({
        sections: [{ name: 'persona', text: 'in {{cwd}}' }],
        contexts: [],
        tools: [],
        variables: { cwd: undefined },
      })).toThrow('prompt variable "{{cwd}}" has no value for this assembly (section "persona")')
    })

    it('throws on a malformed complete reference, e.g. inner spaces', () => {
      expect(() => renderPrompt({
        sections: [{ name: 's', text: 'on {{ model }}' }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('malformed prompt variable reference "{{ model }}" in section "s"')
    })

    it('leaves a lone {{ verbatim only when NO }} follows anywhere after it', () => {
      const text = renderPrompt({
        sections: [{ name: 's', text: 'shell ${X:-{{fallback} stays' }],
        contexts: [],
        tools: [],
        variables: {},
      })
      expect(text).toBe('shell ${X:-{{fallback} stays')
    })

    it.each([
      { text: '{{{model}}}', label: 'extra outer braces' },
      { text: 'x {{a{b}} y {{model}}', label: 'nested brace inside a would-be group' },
    ])('throws on a mangled reference with a }} still following ($label)', ({ text }) => {
      expect(() => renderPrompt({
        sections: [{ name: 's', text }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('malformed prompt variable reference at')
    })

    it('rejects {{constructor}} as UNKNOWN — prototype properties are not variables', () => {
      // `in` would find Object.prototype.constructor and splice function
      // source into the prompt; Object.hasOwn must reject it instead.
      expect(() => renderPrompt({
        sections: [{ name: 's', text: 'on {{constructor}}' }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('unknown prompt variable "{{constructor}}"')
    })

    it('a variable NAMED like a prototype property works once actually registered', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 's', order: 0, text: '{{constructor}}' })
      ctx.systemPrompt.variable('constructor', () => 'own-value')
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\nown-value`)
    })

    it('never re-scans substituted values (a value containing {{sneaky}} stays literal)', () => {
      const text = renderPrompt({
        sections: [{ name: 's', text: 'v = {{model}}!' }],
        contexts: [],
        tools: [],
        variables: { model: 'literal {{sneaky}} inside' },
      })
      expect(text).toBe('v = literal {{sneaky}} inside!')
    })
  })
})
