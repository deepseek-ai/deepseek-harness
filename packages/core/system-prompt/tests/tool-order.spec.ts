import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { PromptAssembly, TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

function tool(name: string, description = name): ToolSchema {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

async function mount(config: { personaPrefix?: string; toolOrder?: string[] } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, config)
  return ctx
}

function names(assembly: PromptAssembly): string[] {
  return assembly.tools.map(t => t.name)
}

describe('SystemPrompt tool order', () => {
  // The ONE place the public constant's value is pinned; everything else
  // (tests and deployment configs alike) references TOOL_ORDER_REST.
  it('exports the rest entry as "<unlisted-tools>"', () => {
    expect(TOOL_ORDER_REST).toBe('<unlisted-tools>')
  })

  it('assembles tools in lexicographic name order when no toolOrder is configured', async () => {
    const ctx = await mount()
    ctx.systemPrompt.tools(() => ({ schemas: [tool('charlie'), tool('alpha')] }))
    ctx.systemPrompt.tools(() => ({ schemas: [tool('bravo')] }))
    expect(names(await ctx.systemPrompt.assemble())).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('assembles the same order regardless of provider registration order', async () => {
    const forward = await mount()
    forward.systemPrompt.tools(() => ({ schemas: [tool('alpha')] }))
    forward.systemPrompt.tools(() => ({ schemas: [tool('zulu')] }))
    const backward = await mount()
    backward.systemPrompt.tools(() => ({ schemas: [tool('zulu')] }))
    backward.systemPrompt.tools(() => ({ schemas: [tool('alpha')] }))
    expect(names(await forward.systemPrompt.assemble())).toEqual(['alpha', 'zulu'])
    expect(names(await backward.systemPrompt.assemble())).toEqual(['alpha', 'zulu'])
  })

  it('applies a configured toolOrder: listed positions, rest at the rest entry lexicographically', async () => {
    const ctx = await mount({ toolOrder: ['todo_write', TOOL_ORDER_REST, 'bash'] })
    ctx.systemPrompt.tools(() => ({ schemas: [tool('bash'), tool('echo_b'), tool('todo_write'), tool('echo_a')] }))
    expect(names(await ctx.systemPrompt.assemble())).toEqual(['todo_write', 'echo_a', 'echo_b', 'bash'])
  })

  it('rejects the assembly when toolOrder names a tool that is not registered (misconfiguration blocks work)', async () => {
    const ctx = await mount({ toolOrder: ['todo_write', 'ghost', TOOL_ORDER_REST, 'wraith'] })
    ctx.systemPrompt.tools(() => ({ schemas: [tool('bash'), tool('todo_write')] }))
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow(
      'toolOrder lists unregistered tools "ghost", "wraith"; known tools: bash, todo_write')
  })

  it('names the single unregistered tool when no tools are registered at all', async () => {
    const ctx = await mount({ toolOrder: ['ghost', TOOL_ORDER_REST] })
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow(
      'toolOrder lists unregistered tool "ghost"; known tools: (none)')
  })

  it.each([
    ['without an explicit toolOrder', undefined],
    ['with only the rest entry configured', [TOOL_ORDER_REST]],
  ])('rejects a provider tool named like the reserved rest entry %s', async (_case, toolOrder) => {
    const ctx = await mount(toolOrder === undefined ? {} : { toolOrder })
    ctx.systemPrompt.tools(() => ({ schemas: [tool(TOOL_ORDER_REST)] }))
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow(
      `tool provider returned reserved tool name "${TOOL_ORDER_REST}"`)
  })

  it('keeps collection order between tools that share a name (stable sort)', async () => {
    const ctx = await mount()
    ctx.systemPrompt.tools(() => ({ schemas: [tool('dup', 'first'), tool('anchor'), tool('dup', 'second')] }))
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(t => t.description)).toEqual(['anchor', 'first', 'second'])
  })

  it('canonicalizes BEFORE the assemble waterfall: listeners see the ordered list and own their own edits', async () => {
    const ctx = await mount()
    ctx.systemPrompt.tools(() => ({ schemas: [tool('zulu'), tool('alpha')] }))
    let seen: string[] | undefined
    ctx.on('system-prompt/assemble', function (assembly, _context, next) {
      seen = assembly.tools.map(t => t.name)
      // A listener-appended tool is NOT re-sorted — same contract as sections:
      // canonicalization applies to what the registry contributed, and a
      // listener owns the determinism of what it emits.
      assembly.tools.push(tool('aardvark'))
      return next()
    })
    const assembly = await ctx.systemPrompt.assemble()
    expect(seen).toEqual(['alpha', 'zulu'])
    expect(names(assembly)).toEqual(['alpha', 'zulu', 'aardvark'])
  })

  it.each([
    ['an empty list', []],
    ['a list without the rest entry', ['bash', 'todo_write']],
  ])('rejects %s at load (the rest entry is required)', async (_case, toolOrder) => {
    await expect(new Context().plugin(SystemPrompt, { toolOrder })).rejects.toThrow(`must contain the "${TOOL_ORDER_REST}" rest entry`)
  })

  it.each([
    ['a duplicate tool name', ['bash', 'bash', TOOL_ORDER_REST]],
    ['a duplicate rest entry', [TOOL_ORDER_REST, 'bash', TOOL_ORDER_REST]],
  ])('rejects %s at load', async (_case, toolOrder) => {
    await expect(new Context().plugin(SystemPrompt, { toolOrder })).rejects.toThrow('more than once')
  })

  it('throws from direct construction too', () => {
    expect(() => new SystemPrompt(new Context(), { toolOrder: ['bash'] })).toThrow('rest entry')
  })
})
