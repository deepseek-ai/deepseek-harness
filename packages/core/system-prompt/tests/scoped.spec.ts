import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { TOOL_ORDER_REST, renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Config, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, config)
  return ctx
}

async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  // The scoped context resolves services through the MINTING plugin's
  // dependency chain — the minter must inject what scope holders will reach.
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

const schema = (name: string) => ({ name, description: `tool ${name}`, parameters: {} })

/** The key a test scope was minted with (scopeOf over the scope's own ctx). */
function scopeKeyOf(scope: Scope): ScopeKey {
  // scopeOf never answers undefined for a context the scope itself minted.

  return scopeOf(scope.ctx)!
}

describe('scoped sections', () => {
  it('a scoped persona shadows deployment:persona-prefix for that scope only (either order)', async () => {
    const ctx = await mount({ personaPrefix: 'You are the deployment.' })
    const scope = await mintScope(ctx, 'child')
    scope.ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'You run tests.' })

    const scoped = renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) }))
    const global = renderPrompt(await ctx.systemPrompt.assemble())
    expect(scoped).toContain('You run tests.')
    expect(scoped).not.toContain('You are the deployment.')
    expect(global).toContain('You are the deployment.')
    expect(global).not.toContain('You run tests.')
  })

  it('scoped-only sections join that scope alone; disposal removes them', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    scope.ctx.systemPrompt.section({ name: 'child:extra', order: 50, text: 'Extra guidance.' })

    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) }))).toContain('Extra guidance.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Extra guidance.')
    await scope.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) }))).not.toContain('Extra guidance.')
  })

  it('duplicate names throw per layer, naming agent.ctx for the global case', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    ctx.systemPrompt.section({ name: 'x', order: 1, text: 'a' })
    expect(() => ctx.systemPrompt.section({ name: 'x', order: 1, text: 'b' })).toThrow(/agent\.ctx/)
    scope.ctx.systemPrompt.section({ name: 'y', order: 1, text: 'a' })
    expect(() => scope.ctx.systemPrompt.section({ name: 'y', order: 1, text: 'b' })).toThrow(/already registered in this scope/)
  })

  it('shadows a global section before evaluating either text provider', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const globalText = vi.fn(() => 'global text')
    const scopedText = vi.fn(() => 'scoped text')
    ctx.systemPrompt.section({ name: 'shared', order: 1, text: globalText })
    scope.ctx.systemPrompt.section({ name: 'shared', order: 1, text: scopedText })

    const assembly = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })

    expect(assembly.sections.find(section => section.name === 'shared')?.text).toBe('scoped text')
    expect(globalText).not.toHaveBeenCalled()
    expect(scopedText).toHaveBeenCalledOnce()
  })

})

describe('scoped variables', () => {
  it('a scoped variable shadows its global name-twin for that scope', async () => {
    const ctx = await mount({ personaPrefix: 'Mode: {{mode}}.' })
    const scope = await mintScope(ctx, 'child')
    ctx.systemPrompt.variable('mode', () => 'normal')
    scope.ctx.systemPrompt.variable('mode', () => 'strict')

    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) }))).toContain('Mode: strict.')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Mode: normal.')
  })

  it('same-layer duplicates throw; scoped layer cleans up on dispose', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    scope.ctx.systemPrompt.variable('v', () => '1')
    expect(() => scope.ctx.systemPrompt.variable('v', () => '2')).toThrow(/already registered in this scope/)
    await scope.dispose()
    // Re-minting a scope with the SAME key starts clean.
    const again = await mintScope(ctx, 'child2')
    again.ctx.systemPrompt.variable('v', () => '3')
  })

  it('defers a scoped variable that replaces the last provider in its generation', async () => {
    const ctx = await mount({ personaPrefix: 'Mode: {{mode}}.' })
    const scope = await mintScope(ctx, 'child')
    const key = scopeKeyOf(scope)
    const calls: string[] = []
    scope.ctx.systemPrompt.section({ name: 'scope:sibling', order: 1, text: 'Scoped.' })
    const dispose = scope.ctx.systemPrompt.variable('mode', () => {
      calls.push('first')
      dispose()
      scope.ctx.systemPrompt.variable('mode', () => {
        calls.push('replacement')
        return 'replacement'
      })
      return 'first'
    })

    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toContain('Mode: first.')
    expect(calls).toEqual(['first'])
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toContain('Mode: replacement.')
    expect(calls).toEqual(['first', 'replacement'])
  })
})

describe('scoped cache-safe context', () => {
  it('shadows a global context for one scope and cleans up with that scope', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child-context')
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'global policy' })
    scope.ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'scoped policy' })
    expect(() => scope.ctx.systemPrompt.context({ name: 'policy', order: 2, text: 'duplicate' }))
      .toThrow('prompt context "policy" is already registered in this scope')

    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })))
      .toContain('scoped policy')
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toContain('global policy')

    await scope.dispose()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })))
      .toContain('global policy')
  })

  it('suppresses all context for one scope and restores it when disposed', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'suppressed-context')
    const key = scopeKeyOf(scope)
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'global policy' })
    const dispose = scope.ctx.systemPrompt.suppressRuntimeContext()

    const suppressed = await ctx.systemPrompt.assemble({ scope: key })
    expect(suppressed.contexts).toEqual([])
    const global = await ctx.systemPrompt.assemble()
    expect(renderContextSnapshot(global)).toContain('global policy')

    dispose()
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: key })))
      .toContain('global policy')
  })
})

describe('scoped tool providers and toolOrder × restriction', () => {
  it('scoped providers are consulted only for their scope', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    ctx.systemPrompt.tools(() => ({ schemas: [schema('global_tool')] }))
    scope.ctx.systemPrompt.tools(() => ({ schemas: [schema('scoped_tool')] }))

    const scoped = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })
    const global = await ctx.systemPrompt.assemble()
    expect(scoped.tools.map(t => t.name)).toEqual(['global_tool', 'scoped_tool'])
    expect(global.tools.map(t => t.name)).toEqual(['global_tool'])
  })

  it('disposing a scoped tool provider empties its layer without residue', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const dispose = scope.ctx.systemPrompt.tools(() => ({ schemas: [schema('scoped_tool')] }))
    dispose()
    const after = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })
    expect(after.tools.map(t => t.name)).toEqual([])
    // Re-registering through the same scope starts a fresh layer.
    scope.ctx.systemPrompt.tools(() => ({ schemas: [schema('again')] }))
    const again = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })
    expect(again.tools.map(t => t.name)).toEqual(['again'])
  })

  it('a toolOrder entry restricted away for a scope is a normal absence, while a typo still throws', async () => {
    const ctx = await mount({ toolOrder: ['bash', TOOL_ORDER_REST] })
    // A provider mimicking the registry's restriction split: bash exists
    // (knownNames) but is masked for this assembly (schemas).
    ctx.systemPrompt.tools(() => ({
      schemas: [schema('read')],
      knownNames: ['read', 'bash'],
    }))
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(t => t.name)).toEqual(['read'])

    const bad = await mount({ toolOrder: ['basj', TOOL_ORDER_REST] })
    bad.systemPrompt.tools(() => ({ schemas: [schema('read')], knownNames: ['read', 'bash'] }))
    await expect(bad.systemPrompt.assemble()).rejects.toThrow('toolOrder lists unregistered tool "basj"; known tools: bash, read')
  })
})

describe('scoped assemble dispatch', () => {
  it('an agent.ctx assemble listener shapes only its own scope\'s assemblies', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const shaped: (ScopeKey | undefined)[] = []
    scope.ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, context, next: () => Promise<PromptAssembly>) => {
      shaped.push(context.scope)
      const result = await next()
      result.sections.push({ name: 'listener:extra', text: 'listener text' })
      return result
    })

    const scoped = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })
    const global = await ctx.systemPrompt.assemble()
    expect(scoped.sections.some(s => s.name === 'listener:extra')).toBe(true)
    expect(global.sections.some(s => s.name === 'listener:extra')).toBe(false)
    expect(shaped).toHaveLength(1)
  })

})
