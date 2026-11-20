import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { TOOL_ORDER_REST, renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Config, PromptPresentation } from '@deepseek-ai/dsh-system-prompt'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
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
  it.each([true, false])('prefers the scoped definition with global-first=%s', async (globalFirst) => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const registerGlobal = () => ctx.systemPrompt.section({ name: 'shared', order: 0, text: 'Global instructions.' })
    const registerScoped = () => scope.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Scoped instructions.' })
    if (globalFirst) {
      registerGlobal()
      registerScoped()
    } else {
      registerScoped()
      registerGlobal()
    }
    const assembly = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })
    expect(assembly.sections.filter(section => section.name === 'shared')).toEqual([
      { name: 'shared', order: 1, text: 'Scoped instructions.' },
    ])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Global instructions.')
    await scope.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) }))).toContain('Global instructions.')
  })

  it.each([true, false])('prefers the descendant definition with ancestor-first=%s', async (ancestorFirst) => {
    const ctx = await mount()
    const parent = await mintScope(ctx, 'parent')
    const child = createScope(parent.ctx, { name: 'child' }, { parent: scopeKeyOf(parent) })
    const parentText = vi.fn(() => 'Parent instructions.')
    const registerParent = () => parent.ctx.systemPrompt.section({ name: 'shared', order: 1, text: parentText })
    const registerChild = () => child.ctx.systemPrompt.section({ name: 'shared', order: 1, text: 'Child instructions.' })
    if (ancestorFirst) {
      registerParent()
      registerChild()
    } else {
      registerChild()
      registerParent()
    }
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(child) }))).toContain('Child instructions.')
    expect(parentText).not.toHaveBeenCalled()
    await child.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(child) }))).toContain('Parent instructions.')
    expect(parentText).toHaveBeenCalledOnce()
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

  it.each(['bind', 'rebind'] as const)('resolves the nearest definition after a delayed scope %s', async (operation) => {
    const ctx = await mount()
    try {
      const parent = await mintScope(ctx, 'parent')
      const child = await mintScope(ctx, 'child')
      const childKey = scopeKeyOf(child)
      const binding = operation === 'rebind' ? bindScopeParent(childKey, {}) : undefined
      const parentText = vi.fn(() => 'Parent instructions.')
      const childText = vi.fn(() => 'Child instructions.')
      parent.ctx.systemPrompt.section({ name: 'shared', order: 1, text: parentText })
      const disposeChild = child.ctx.systemPrompt.section({ name: 'shared', order: 1, text: childText })
      if (binding === undefined) bindScopeParent(childKey, scopeKeyOf(parent))
      else binding.rebind(scopeKeyOf(parent))

      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey }))).toContain('Child instructions.')
      expect(parentText).not.toHaveBeenCalled()
      expect(childText).toHaveBeenCalledOnce()
      disposeChild()
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey }))).toContain('Parent instructions.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])('removes the exact registration within one scope, scoped=%s', async (scoped) => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const registrationContext = scoped ? scope.ctx : ctx
    const assemble = () => ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })
    const first = registrationContext.systemPrompt.section({ name: 'shared', order: 1, text: 'First.' })
    const middle = registrationContext.systemPrompt.section({ name: 'shared', order: 1, text: 'Middle.' })
    const last = registrationContext.systemPrompt.section({ name: 'shared', order: 1, text: 'Last.' })
    expect(renderPrompt(await assemble())).toContain('Last.')
    middle()
    middle()
    expect(renderPrompt(await assemble())).toContain('Last.')
    last()
    expect(renderPrompt(await assemble())).toContain('First.')
    first()
    expect((await assemble()).sections.some(section => section.name === 'shared')).toBe(false)
    registrationContext.systemPrompt.section({ name: 'shared', order: 1, text: 'New generation.' })
    expect(renderPrompt(await assemble())).toContain('New generation.')
  })

  it('isolates same-named sibling sections and evaluates only the selected provider', async () => {
    const ctx = await mount()
    const first = await mintScope(ctx, 'first')
    const second = await mintScope(ctx, 'second')
    const firstText = vi.fn(() => 'first text')
    const secondText = vi.fn(() => 'second text')
    const dispose = first.ctx.systemPrompt.section({ name: 'shared', order: 1, text: firstText })
    second.ctx.systemPrompt.section({ name: 'shared', order: 1, text: secondText })

    const assembly = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(first) })
    expect(assembly.sections.find(section => section.name === 'shared')?.text).toBe('first text')
    expect(firstText).toHaveBeenCalledOnce()
    expect(secondText).not.toHaveBeenCalled()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('first text')
    dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(first) }))).not.toContain('first text')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(second) }))).toContain('second text')
    expect(secondText).toHaveBeenCalledOnce()
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
  it('refreshes through the same scoped providers and suppression as assembly', async () => {
    const ctx = await mount()
    try {
      const scope = await mintScope(ctx, 'refresh')
      let current = 'before'
      ctx.systemPrompt.context({ name: 'fact', order: 0, text: 'global' })
      scope.ctx.systemPrompt.context({ name: 'fact', order: 0, required: true, text: () => current })
      scope.ctx.systemPrompt.context({ name: 'optional', order: 10, text: 'optional' })
      const context = { scope: scopeKeyOf(scope) }
      const accepted = await ctx.systemPrompt.assemble(context)
      current = 'after'
      const restore = scope.ctx.systemPrompt.suppressRuntimeContext()
      expect(ctx.systemPrompt.refreshContext(accepted, context).contexts).toEqual([{ name: 'fact', text: 'after' }])
      restore()
      expect(ctx.systemPrompt.refreshContext(await ctx.systemPrompt.assemble()).contexts).toEqual([{ name: 'fact', text: 'global' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })


  it('an agent.ctx assemble listener shapes only its own scope\'s assemblies', async () => {
    const ctx = await mount()
    const scope = await mintScope(ctx, 'child')
    const shaped: (ScopeKey | undefined)[] = []
    scope.ctx.on('system-prompt/assemble', async (_assembly: PromptPresentation, context, next: () => Promise<PromptPresentation>) => {
      shaped.push(context.scope)
      const result = await next()
      result.sections.push({ name: 'listener:extra', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 10, text: 'listener text' })
      return result
    })

    const scoped = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })
    const global = await ctx.systemPrompt.assemble()
    expect(scoped.sections.some(s => s.name === 'listener:extra')).toBe(true)
    expect(global.sections.some(s => s.name === 'listener:extra')).toBe(false)
    expect(shaped).toHaveLength(1)
  })

})
