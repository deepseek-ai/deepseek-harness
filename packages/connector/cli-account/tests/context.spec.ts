import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished } from 'vitest'
import { registerCliPathContext, type CliPathContext } from '../src/context.ts'

const CLI = { name: 'fixture:cli', product: 'Fixture', program: 'fixture-cli', executable: '/opt/fixture/bin/fixture-cli' }
const RUN = 'Fixture CLI: run `fixture-cli` by its absolute path "/opt/fixture/bin/fixture-cli"; the bare name may resolve to another installation or to none.'

/** A prompt registry with optional runtime context off, so only required context renders. */
async function requiredContextOnly(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
  return ctx
}

/** Register the context from its own plugin, as an app plugin does. */
async function register(ctx: Context, cli: CliPathContext) {
  return await ctx.plugin(Object.assign((inner: Context) => { registerCliPathContext(inner, cli) }, { inject: ['systemPrompt'] }))
}

async function rendered(ctx: Context) {
  return renderContextSections(await ctx.systemPrompt.assemble())
}

describe('registerCliPathContext', () => {
  it('names the executable by its absolute path in required context until its plugin is disposed', async () => {
    const ctx = await requiredContextOnly()
    const fiber = await register(ctx, CLI)

    expect(await rendered(ctx)).toEqual([{ name: 'fixture:cli', text: RUN }])
    await fiber.dispose()
    expect(await rendered(ctx)).toEqual([])
  })

  it('keeps the path literal', async () => {
    const ctx = await requiredContextOnly()
    await register(ctx, { ...CLI, executable: '/opt/{{tools}}/fixture-cli' })

    expect((await rendered(ctx))[0]?.text).toContain('"/opt/{{tools}}/fixture-cli"')
  })

  it('gives commands that run the skill scripts the executable directory first on PATH', async () => {
    const ctx = await requiredContextOnly()
    await register(ctx, { ...CLI, scripts: true })

    expect(await rendered(ctx)).toEqual([{
      name: 'fixture:cli',
      text: `${RUN}\nScripts in the Fixture skill call \`fixture-cli\` by name; prefix only the commands that run them with PATH="/opt/fixture/bin:$PATH", and never export PATH or run \`fixture-cli\` by name yourself.`,
    }])
  })

  it('contributes nothing while the executable is not ready', async () => {
    const ctx = await requiredContextOnly()
    let ready = false
    await register(ctx, { ...CLI, ready: () => ready })

    expect(await rendered(ctx)).toEqual([])
    ready = true
    expect(await rendered(ctx)).toEqual([{ name: 'fixture:cli', text: RUN }])
  })
})
