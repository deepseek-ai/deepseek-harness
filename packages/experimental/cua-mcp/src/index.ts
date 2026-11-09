/**
 * The Computer Use MCP stdio application: a profile bundle over dsh-base whose one frontend serves
 * `cua_run_code` and `cua_reset` to an external MCP client. Help and `--print-client-config` exit without
 * claiming stdio; a served connection owns one Agent until the client closes stdin.
 * @module @deepseek-ai/dsh-cua-mcp
 */
import { isSea } from 'node:sea'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-app-boot'
import { exitOnStdinEnd, internals, parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { Command, Option } from 'commander'
import { CLIENT_CONFIG_TARGETS, clientLaunch, renderClientConfig, type ClientConfigTarget, type LaunchFacts } from './client-config.ts'
import type { ConsentMode } from './consent.ts'
import { createCuaMcpServer } from './server.ts'

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
 * Accept the profile invocation, print a client configuration on request, or serve MCP over stdio once the
 * launcher commits readiness. Stdin EOF ends the process through the launcher's bounded shutdown.
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
    .addOption(new Option('--print-client-config <client>', 'print the MCP client configuration for this installation and exit')
      .choices([...CLIENT_CONFIG_TARGETS]))
    .addHelpText('after', `
Examples:
  ${commandName}                                serve one MCP client until it closes stdin
  ${commandName} --print-client-config codex    print a ~/.codex/config.toml fragment
  DSH_CUA_CONSENT=allow ${commandName}          grant application access without a human
`)
  let accepted: { print: ClientConfigTarget | undefined } | undefined
  program.action(() => {
    accepted = { print: program.opts<{ printClientConfig?: ClientConfigTarget }>().printClientConfig }
  })
  parseCmdline(ctx, program)
  if (accepted === undefined) return
  if (accepted.print !== undefined) {
    const facts: LaunchFacts = { execPath: process.execPath, execArgv: process.execArgv, argv: process.argv, sea: isSea() }
    internals.stdout.write(renderClientConfig(accepted.print, clientLaunch(facts, profile, config.consent)))
    exit(0)
    return
  }
  exitOnStdinEnd(ctx, 'cua-mcp: stdin')
  ctx.effect(() => {
    const lifetime = new AbortController()
    const adapter = createCuaMcpServer(ctx, { consent: config.consent, cwd: profile.cwd, signal: lifetime.signal })
    let opening: Promise<void> | undefined
    const stopReady = ready.onReady(() => {
      opening = adapter.server.connect(new StdioServerTransport())
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
      await adapter.dispose()
    }
  }, 'cua-mcp: server')
}
