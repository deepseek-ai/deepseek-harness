import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { bindScopeParent, createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it } from 'vitest'
import * as Persona from '@deepseek-ai/dsh-persona'
import { PERSONA_SUFFIX_SECTION, PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-persona'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(deploymentPersona: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: deploymentPersona })
  return ctx
}

/** The rendered text of the persona slot as one scope sees it. */
async function personaText(ctx: Context, scope?: ScopeKey): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return assembly.sections.find(section => section.name === PERSONA_PREFIX_SECTION)?.text
}

describe('the persona row', () => {
  it('shadows and interpolates the environment per scope, restoring both defaults on disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment.', personaSuffix: 'Global workspace.' })
      ctx.systemPrompt.variable('cwd', () => '/local')
      ctx.systemPrompt.section({ name: 'guidance', order: 100, text: 'Use tools.' })
      const key: ScopeKey = { agent: 'environment' }
      const scope = createScope(ctx, key)
      const fiber = await scope.ctx.plugin(Persona, { prefix: 'Preset.', suffix: 'Workspace {{cwd}}.' })
      const assembly = await ctx.systemPrompt.assemble({ scope: key })
      expect(assembly.sections.find(section => section.name === PERSONA_SUFFIX_SECTION)?.text).toBe('Workspace {{cwd}}.')
      expect(renderPrompt(assembly)).toBe('You are an AI agent powered by DeepSeek Harness.\n\nPreset.\n\nUse tools.\n\nWorkspace /local.')
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Global workspace.')
      await fiber.dispose()
      const restored = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
      expect(restored).toContain('Deployment.')
      expect(restored).toContain('Global workspace.')
      expect(restored).not.toContain('Workspace /local.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([{}, { suffix: '' }])('shadows the default environment with an omitted or empty value: %j', async (environment) => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt, { personaSuffix: 'Global workspace.' })
      const key: ScopeKey = { agent: 'empty-environment' }
      const scope = createScope(ctx, key)
      await scope.ctx.plugin(Persona, { prefix: 'Preset.', ...environment })
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).not.toContain('Global workspace.')
      expect((await ctx.systemPrompt.assemble({ scope: key })).sections.find(section => section.name === PERSONA_SUFFIX_SECTION)?.text).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('overrides deployment defaults globally and restores them on disposal', async () => {
    const ctx = await harness('deployment identity')
    const fiber = await ctx.plugin(Persona, { prefix: 'composition identity' })
    expect(await personaText(ctx)).toBe('composition identity')
    await fiber.dispose()
    expect(await personaText(ctx)).toBe('deployment identity')
  })

  it('resolves the nearest prefix and mode independently of suffix and registration order', async () => {
    const ctx = await harness('Deployment.')
    try {
      const parentKey = { preset: 'parent' }
      const childKey = { agent: 'child' }
      const parent = createScope(ctx, parentKey)
      const child = createScope(ctx, childKey)
      bindScopeParent(childKey, parentKey)
      const childPersona = await child.ctx.plugin(Object.assign((owner: Context) => {
        owner.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION, order: owner.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: 'Child.',
        })
      }, { inject: ['systemPrompt'] }))
      await parent.ctx.plugin(Persona, { prefix: 'Parent only.', suffix: 'Inherited policy.', complete: true })
      ctx.systemPrompt.section({ name: 'guidance', order: 100, text: 'Use tools.' })

      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey })))
        .toBe('You are an AI agent powered by DeepSeek Harness.\n\nChild.\n\nUse tools.\n\nInherited policy.')
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: parentKey }))).toBe('Parent only.')
      await childPersona.dispose()
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey }))).toBe('Parent only.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps captured persona values when its plugin is disposed during assembly', async () => {
    const ctx = await harness('Deployment.')
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const release: PromiseWithResolvers<void> = Promise.withResolvers()
    try {
      const key = { agent: 'captured-persona' }
      const scope = createScope(ctx, key)
      const fiber = await scope.ctx.plugin(Persona, { prefix: 'Captured.' })
      ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        entered.resolve()
        await release.promise
        return next()
      })
      const pending = ctx.systemPrompt.assemble({ scope: key })
      await entered.promise
      await fiber.dispose()
      release.resolve()
      expect(renderPrompt(await pending)).toContain('Captured.')
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toContain('Deployment.')
    } finally {
      release.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('inherits the prefix when a child configures only its suffix', async () => {
    const ctx = await harness('Deployment.')
    try {
      const parentKey = { preset: 'parent' }
      const childKey = { agent: 'child' }
      const parent = createScope(ctx, parentKey)
      const child = createScope(ctx, childKey)
      bindScopeParent(childKey, parentKey)
      await parent.ctx.plugin(Persona, { prefix: 'Parent.', suffix: 'Parent policy.' })
      const childPersona = await child.ctx.plugin(Object.assign((owner: Context) => {
        owner.systemPrompt.section({
          name: PERSONA_SUFFIX_SECTION, order: owner.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: 'Child policy.',
        })
      }, { inject: ['systemPrompt'] }))

      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey })))
        .toBe('You are an AI agent powered by DeepSeek Harness.\n\nParent.\n\nChild policy.')
      await childPersona.dispose()
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey })))
        .toBe('You are an AI agent powered by DeepSeek Harness.\n\nParent.\n\nParent policy.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stacks persona plugins in the same scope and restores the earlier registration', async () => {
    const ctx = await harness('Deployment.')
    const key = { agent: 'stacked-persona' }
    const scope = createScope(ctx, key)
    const first = await scope.ctx.plugin(Persona, { prefix: 'First.', suffix: 'First suffix.' })
    const second = await scope.ctx.plugin(Persona, { prefix: 'Second.', suffix: 'Second suffix.' })
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key })))
      .toBe('You are an AI agent powered by DeepSeek Harness.\n\nSecond.\n\nSecond suffix.')
    await second.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key })))
      .toBe('You are an AI agent powered by DeepSeek Harness.\n\nFirst.\n\nFirst suffix.')
    await first.dispose()
    expect(await personaText(ctx, key)).toBe('Deployment.')
  })

  it('shadows the deployment default for one scope only', async () => {
    const ctx = await harness('deployment identity')
    const key: ScopeKey = { agent: 'a1' }
    const scope = createScope(ctx, key)

    await scope.ctx.plugin(Persona, { prefix: 'preset identity' })

    expect(await personaText(ctx, key)).toBe('preset identity')
    expect(await personaText(ctx)).toBe('deployment identity')
  })

  it('gives two scopes independent personas', async () => {
    const ctx = await harness('')
    const first: ScopeKey = { agent: 'a1' }
    const second: ScopeKey = { agent: 'a2' }

    await createScope(ctx, first).ctx.plugin(Persona, { prefix: 'first identity' })
    await createScope(ctx, second).ctx.plugin(Persona, { prefix: 'second identity' })

    expect(await personaText(ctx, first)).toBe('first identity')
    expect(await personaText(ctx, second)).toBe('second identity')
  })

  it('shadows the deployment persona away entirely when its text is empty', async () => {
    const ctx = await harness('deployment identity')
    const key: ScopeKey = { agent: 'a1' }

    await createScope(ctx, key).ctx.plugin(Persona, { prefix: '' })

    // The slot is still occupied, so the deployment persona is gone for this
    // agent; an empty section is dropped when the prompt renders.
    expect(await personaText(ctx, key)).toBe('')
    expect(await personaText(ctx)).toBe('deployment identity')
  })

  it('restores the shadowed default when its fiber unloads', async () => {
    const ctx = await harness('deployment identity')
    const key: ScopeKey = { agent: 'a1' }
    const scope = createScope(ctx, key)
    const fiber = await scope.ctx.plugin(Persona, { prefix: 'preset identity' })
    expect(await personaText(ctx, key)).toBe('preset identity')

    await fiber.dispose()

    expect(await personaText(ctx, key)).toBe('deployment identity')
  })

  it('interpolates prompt variables strictly, like any other section', async () => {
    const ctx = await harness('')
    const key: ScopeKey = { agent: 'a1' }
    ctx.systemPrompt.variable('model', () => 'deepseek-v4-pro')

    await createScope(ctx, key).ctx.plugin(Persona, { prefix: 'You run on {{model}}.' })

    // `assemble()` keeps section text uninterpolated; `renderPrompt()` is the
    // stage that resolves `{{…}}` against the assembly's variables.
    expect(await personaText(ctx, key)).toBe('You run on {{model}}.')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key })))
      .toContain('You run on deepseek-v4-pro.')
  })

  it('makes a complete persona the exact prompt after every other contribution', async () => {
    const ctx = await harness('deployment identity')
    const key: ScopeKey = { agent: 'a1' }
    const scope = createScope(ctx, key)
    ctx.systemPrompt.section({ name: 'global:extra', order: 100, text: 'global guidance' })

    await scope.ctx.plugin(Persona, { prefix: 'Only this.', suffix: '{{unknown}}', complete: true })
    scope.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      assembly.sections.push({ name: 'late:extra', order: 100, text: 'late guidance' })
      return next()
    }, { prepend: true })

    const assembly = await ctx.systemPrompt.assemble({ scope: key })
    expect(assembly.sections).toEqual([{ name: PERSONA_PREFIX_SECTION, order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: 'Only this.', complete: true }])
    expect(renderPrompt(assembly)).toBe('Only this.')
  })

  it('can suppress runtime context for its scope without changing the global assembly', async () => {
    const ctx = await harness('deployment identity')
    const key: ScopeKey = { agent: 'a1' }
    const scope = createScope(ctx, key)
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'global policy' })

    const fiber = await scope.ctx.plugin(Persona, {
      prefix: 'Only this.',
      includeRuntimeContext: false,
    })
    const suppressed = await ctx.systemPrompt.assemble({ scope: key })
    expect(suppressed.contexts).toEqual([])
    const global = await ctx.systemPrompt.assemble()
    expect(global.contexts).toEqual([
      { name: 'policy', text: 'global policy' },
    ])

    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble({ scope: key })).contexts).toEqual([
      { name: 'policy', text: 'global policy' },
    ])
  })

  it('keeps runtime context by default when apply bypasses schema defaults', async () => {
    const ctx = await harness('deployment identity')
    const key: ScopeKey = { agent: 'a1' }
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'global policy' })

    await ctx.plugin(Object.assign((inner: Context) => {
      Persona.apply(createScope(inner, key).ctx, { prefix: 'Scoped identity.' })
    }, { inject: ['systemPrompt'] }))

    expect((await ctx.systemPrompt.assemble({ scope: key })).contexts).toEqual([
      { name: 'policy', text: 'global policy' },
    ])
  })
})
