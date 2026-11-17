/**
 * The Computer Use MCP stdio application: the standalone cua-mcp profile's frontend, serving the `cua` API
 * reference, the Agent's `cua_run_code` registration, and `cua_reset` to an external MCP client. Help exits
 * without claiming stdio; a served connection owns one Agent, created in the configured workspace before the
 * transport opens, until the client closes stdin.
 * @module @deepseek-ai/dsh-cua-mcp
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-app-boot'
import { exitOnStdinEnd, internals, parseCmdline } from '@deepseek-ai/dsh-cmdline'
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
  /**
   * Absolute directory the connection's Agent works in: its programs start there, and it is their
   * `workspace-write` root. Startup creates it when missing; a relative path or a directory that cannot be
   * created is reported on stderr and ends the process with exit code 1.
   */
  workspace: string
}

/** Validate the consent mode and require a workspace; the bundle patch maps `DSH_CUA_CONSENT` and `DSH_CUA_WORKSPACE` onto them. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  consent: Schema.union([Schema.const('allow'), Schema.const('elicit')]).default('elicit'),
  workspace: Schema.string().required(),
})

/**
 * Create the directory a served connection works in.
 * @param workspace - Configured workspace path.
 * @returns After the directory exists.
 * @throws Error naming the configured path when it is relative or the directory cannot be created.
 */
async function prepareWorkspace(workspace: string): Promise<void> {
  if (!isAbsolute(workspace)) {
    throw new Error(`the workspace ${JSON.stringify(workspace)} is not an absolute directory path; set DSH_CUA_WORKSPACE to an absolute path`)
  }
  await mkdir(workspace, { recursive: true }).catch((error: unknown) => {
    throw new Error(`the workspace directory ${JSON.stringify(workspace)} cannot be created (${String(error)}); set DSH_CUA_WORKSPACE to a writable location`, { cause: error })
  })
}

/**
 * Accept the profile invocation and, once the launcher commits readiness, create the workspace and serve MCP over
 * stdio; help exits before anything starts. A startup failure, including a relative workspace path or a workspace
 * directory that cannot be created, is reported on stderr and ends the process with exit code 1. Stdin EOF ends the
 * process through the launcher's bounded shutdown.
 * @param ctx - Profile context carrying the command line, readiness, exit request, and profile identity.
 * @param config - Validated consent mode and workspace directory.
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
  ${commandName}                          serve one MCP client until it closes stdin
  DSH_CUA_CONSENT=allow ${commandName}    grant application access without a human
  DSH_CUA_WORKSPACE=/work ${commandName}  start programs in /work and let them write there
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
      // The workspace exists, and then the Agent with the provider's tools registered for it, before the client can
      // list or call anything.
      adapter = prepareWorkspace(config.workspace)
        .then(() => createCuaMcpServer(ctx, { consent: config.consent, cwd: config.workspace, signal: lifetime.signal }))
      opening = adapter.then(created => created.server.connect(new StdioServerTransport()))
      void opening.catch((error: unknown) => {
        if (lifetime.signal.aborted) return
        // The profile mounts no log sink, and stdout belongs to the protocol: stderr is the only place a client or its user sees this.
        internals.stderr.write(`dsh: MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
        exit(1)
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
