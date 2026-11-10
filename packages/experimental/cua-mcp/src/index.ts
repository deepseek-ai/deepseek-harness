/**
 * The Computer Use MCP stdio application: the standalone cua-mcp profile's frontend, serving the Agent's
 * `cua_run_code` registration and `cua_reset` to an external MCP client. Help exits without claiming stdio; a
 * served connection owns one Agent, created before the transport opens, until the client closes stdin.
 * @module @deepseek-ai/dsh-cua-mcp
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-app-boot'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { Command } from 'commander'
import type { ConsentMode } from './consent.ts'
import { createCuaMcpServer, type CuaMcpServer } from './server.ts'

/** Cordis frontend identity. */
export const name = 'cua-mcp'
/** Launcher facts and the Agent, preset, tool, prompt, and attachment services a served connection uses. */
export const inject = ['cmdlineArgs', 'appReady', 'appExit', 'profileContext', 'agents', 'agentPresets', 'tools', 'systemPrompt', 'attachments']

/** Connection policy configurable from the profile patch. */
export interface Config {
  /**
   * Who grants application and pointer consent for the connection's Agent: `allow` grants every request for
   * this session without a human; `elicit` forwards each request to the MCP client as a form elicitation.
   */
  consent: ConsentMode
}

/** Validate the consent mode; the bundle patch maps `DSH_CUA_CONSENT` onto it. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  consent: Schema.union([Schema.const('allow'), Schema.const('elicit')]).default('elicit'),
})

/**
 * Accept the profile invocation and serve MCP over stdio once the launcher commits readiness; help exits before
 * anything starts. Stdin EOF ends the process through the launcher's bounded shutdown.
 * @param ctx - Profile context carrying the command line, readiness, exit request, and profile identity.
 * @param config - Validated consent mode.
 * @throws Error when the plugin runs outside the dsh profile launcher.
 */
export function apply(ctx: Context, config: Config): void {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  const profile = ctx.get('profileContext')
  if (ready === undefined || exit === undefined || profile === undefined) throw new Error('Computer Use MCP requires the dsh profile launcher')
  const commandName = `dsh --profile ${profile.name}`
  const program = new Command(commandName)
    .description('Serve DeepSeek Harness Computer Use to an MCP client over stdio.')
    .addHelpText('after', `
Examples:
  ${commandName}                        serve one MCP client until it closes stdin
  DSH_CUA_CONSENT=allow ${commandName}  grant application access without a human
`)
  let accepted: true | undefined
  program.action(() => { accepted = true })
  parseCmdline(ctx, program)
  if (accepted === undefined) return
  exitOnStdinEnd(ctx, 'cua-mcp: stdin')
  ctx.effect(() => {
    const lifetime = new AbortController()
    let adapter: Promise<CuaMcpServer> | undefined
    let opening: Promise<void> | undefined
    const stopReady = ready.onReady(() => {
      // The Agent exists, with the provider's tools registered for it, before the client can list or call anything.
      adapter = createCuaMcpServer(ctx, { consent: config.consent, cwd: profile.cwd, signal: lifetime.signal })
      opening = adapter.then(created => created.server.connect(new StdioServerTransport()))
      void opening.catch((error: unknown) => {
        if (!lifetime.signal.aborted) {
          ctx.logger.error('MCP startup failed: %s', error)
          exit(1)
        }
      })
    })
    return async () => {
      stopReady()
      lifetime.abort()
      await opening?.catch(() => undefined)
      const created = await adapter?.catch(() => undefined)
      await created?.dispose()
    }
  }, 'cua-mcp: server')
}
