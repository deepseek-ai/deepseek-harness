/** Tool guidance: the system prompt section `ctx.tools.register()` registers with a tool. */
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as NativeRoot from '@deepseek-ai/dsh-tool-registry-native'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolGuidance } from '@deepseek-ai/dsh-tools'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeRoot)
  return ctx
}

async function agentScope(ctx: Context, id: string): Promise<{ scope: Scope; agent: Agent }> {
  const agent = { id: brandString<SessionId>(id) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

function tool(name: string, guidance?: ToolGuidance): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
    execute: (): Promise<string> => Promise.resolve(name),
    ...guidance === undefined ? {} : { guidance },
  }
}

async function sectionText(ctx: Context, name: string, agent?: Agent): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? {} : { scope: agent })
  return assembly.sections.find(section => section.name === name)?.text
}

const alpha: ToolGuidance = { order: 'TOOL_READ', text: 'Use alpha {{literally}}.', retirement: 'The alpha tool is gone.' }
const shared: ToolGuidance = {
  section: 'tool:shared',
  order: 'TOOL_SUBAGENT',
  text: available => `Delegate with ${available.join(' or ')}.`,
}

describe('tool guidance', () => {
  it('renders a literal section at its named order while the tool is available to the viewing scope', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('alpha', alpha))
    const restricted = await agentScope(ctx, 'restricted')
    const peer = await agentScope(ctx, 'peer')
    const assembly = await ctx.systemPrompt.assemble({ scope: peer.agent })
    expect(assembly.sections.find(section => section.name === 'tool:alpha')).toMatchObject({
      text: 'Use alpha {{literally}}.', order: ctx.systemPrompt.getSectionOrder('TOOL_READ'), interpolate: false,
    })
    const removeRestriction = restricted.scope.ctx.tools.restrict({ deny: ['alpha'] })
    expect(await sectionText(ctx, 'tool:alpha', restricted.agent)).toBe('')
    expect(await sectionText(ctx, 'tool:alpha', peer.agent)).toBe('Use alpha {{literally}}.')
    removeRestriction()
    expect(await sectionText(ctx, 'tool:alpha', restricted.agent)).toBe('Use alpha {{literally}}.')
  })

  it('shows the guidance of the definition the scope resolves, not of one a nearer scope shadows', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('alpha', alpha))
    const bare = await agentScope(ctx, 'bare-shadow')
    bare.scope.ctx.tools.register(tool('alpha'))
    const guided = await agentScope(ctx, 'guided-shadow')
    guided.scope.ctx.tools.register(tool('alpha', { order: 'TOOL_READ', text: 'Use the scoped alpha.' }))
    expect(await sectionText(ctx, 'tool:alpha', bare.agent)).toBe('')
    expect(await sectionText(ctx, 'tool:alpha', guided.agent)).toBe('Use the scoped alpha.')
    expect(await sectionText(ctx, 'tool:alpha')).toBe('Use alpha {{literally}}.')
  })

  it('renders one section for tools that share it, listing the available ones in name order', async () => {
    const ctx = await mount()
    const removeGamma = ctx.tools.register(tool('gamma', shared))
    const removeBeta = ctx.tools.register(tool('beta', shared))
    const { scope, agent } = await agentScope(ctx, 'sharing')
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(assembly.sections.filter(section => section.text.startsWith('Delegate')).map(section => [section.name, section.text]))
      .toEqual([['tool:shared', 'Delegate with beta or gamma.']])
    scope.ctx.tools.restrict({ deny: ['beta'] })
    expect(await sectionText(ctx, 'tool:shared', agent)).toBe('Delegate with gamma.')
    scope.ctx.tools.restrict({ deny: ['gamma'] })
    expect(await sectionText(ctx, 'tool:shared', agent)).toBe('')
    removeBeta()
    expect(await sectionText(ctx, 'tool:shared')).toBe('Delegate with gamma.')
    removeGamma()
    expect(await sectionText(ctx, 'tool:shared')).toBeUndefined()
  })

  it('retires the guidance a Session saw once its tool unregisters, with the tool\'s plugin or its own disposer', async () => {
    const ctx = await mount()
    const session = Session.create(brandString<SessionId>('guided-session'))
    const commit = async () => {
      const assembly = await ctx.systemPrompt.assemble({ session })
      for (const { message, intent } of assembly.systemUpdates(false)) session.append('system/message', { turn: 1, step: 1, message }, intent)
      return assembly
    }
    const remove = ctx.tools.register(tool('alpha', alpha))
    expect((await commit()).sections.find(section => section.name === 'tool:alpha')?.text).toBe('Use alpha {{literally}}.')
    remove()
    expect((await commit()).sections.find(section => section.name === 'tool:alpha')).toMatchObject({ text: 'The alpha tool is gone.', retire: true })

    const plugin = await ctx.plugin(Object.assign((inner: Context) => { inner.tools.register(tool('beta', shared)) }, { inject: ['tools'] }))
    expect(await sectionText(ctx, 'tool:shared')).toBe('Delegate with beta.')
    await plugin.dispose()
    expect(await sectionText(ctx, 'tool:shared')).toBeUndefined()
    expect(ctx.tools.getAll().map(definition => definition.name)).toEqual([])
  })
})
