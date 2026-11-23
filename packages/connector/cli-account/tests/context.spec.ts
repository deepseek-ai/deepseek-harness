import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished } from 'vitest'
import { cliPathContextText, registerCliPathContext, type CliPathContext } from '../src/context.ts'

const CLI = { product: 'Fixture', program: 'fixture-cli', executable: '/opt/fixture/bin/fixture-cli' }
const RUN = 'Fixture CLI: run `fixture-cli` by its absolute path "/opt/fixture/bin/fixture-cli"; the bare name may resolve to another installation or to none.'
const WINDOWS_CLI = { ...CLI, executable: 'C:\\Users\\O\'Brien\\.dsh\\fixture\\fixture-cli.exe' }
const WINDOWS_RUN = 'Fixture CLI: run `fixture-cli` by its absolute path with the call operator, & \'C:\\Users\\O\'\'Brien\\.dsh\\fixture\\fixture-cli.exe\'; the bare name may resolve to another installation or to none.'

/** A prompt registry with optional runtime context off, so only required context renders. */
async function requiredContextOnly(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
  return ctx
}

/** Register the context from its own plugin, so disposing that plugin removes it. */
async function register(ctx: Context, cli: CliPathContext, ready?: () => boolean) {
  return await ctx.plugin(Object.assign((inner: Context) => { registerCliPathContext(inner, 'fixture:cli', cli, ready) }, { inject: ['systemPrompt'] }))
}

async function rendered(ctx: Context) {
  return renderContextSections(await ctx.systemPrompt.assemble())
}

describe('cliPathContextText', () => {
  it('names the executable by its absolute path as a JSON string for a POSIX shell', () => {
    expect(cliPathContextText(CLI, 'darwin')).toBe(RUN)
  })

  it('gives the commands that run the skill scripts the executable directory first on PATH for a POSIX shell', () => {
    expect(cliPathContextText({ ...CLI, scripts: true }, 'linux')).toBe(
      `${RUN}\nScripts in the Fixture skill call \`fixture-cli\` by name; prefix only the commands that run them with PATH="/opt/fixture/bin:$PATH", and never export PATH or run \`fixture-cli\` by name yourself.`,
    )
  })

  it('runs the executable with the PowerShell call operator and a literal path on Windows', () => {
    expect(cliPathContextText(WINDOWS_CLI, 'win32')).toBe(WINDOWS_RUN)
  })

  it('gives the commands that run the skill scripts the executable directory first on $env:PATH on Windows', () => {
    expect(cliPathContextText({ ...WINDOWS_CLI, scripts: true }, 'win32')).toBe(
      `${WINDOWS_RUN}\nScripts in the Fixture skill call \`fixture-cli\` by name; start only the commands that run them with $env:PATH = 'C:\\Users\\O''Brien\\.dsh\\fixture;' + $env:PATH, and never run \`fixture-cli\` by name yourself.`,
    )
  })
})

describe('registerCliPathContext', () => {
  it('names the executable in the Host shell dialect in required context until its plugin is disposed', async () => {
    const ctx = await requiredContextOnly()
    const fiber = await register(ctx, CLI)

    expect(await rendered(ctx)).toEqual([{ name: 'fixture:cli', text: cliPathContextText(CLI, process.platform) }])
    await fiber.dispose()
    expect(await rendered(ctx)).toEqual([])
  })

  it('keeps the path literal', async () => {
    const ctx = await requiredContextOnly()
    await register(ctx, { ...CLI, executable: '/opt/{{tools}}/fixture-cli' })

    expect((await rendered(ctx))[0]?.text).toContain('/opt/{{tools}}/fixture-cli')
  })

  it('contributes nothing while the CLI is not ready', async () => {
    const ctx = await requiredContextOnly()
    let ready = false
    await register(ctx, { ...CLI, scripts: true }, () => ready)

    expect(await rendered(ctx)).toEqual([])
    ready = true
    expect(await rendered(ctx)).toEqual([{ name: 'fixture:cli', text: cliPathContextText({ ...CLI, scripts: true }, process.platform) }])
  })
})
