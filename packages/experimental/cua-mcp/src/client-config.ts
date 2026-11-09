/** Client configuration snippets for the Computer Use MCP server. @module */
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { ConsentMode } from './consent.ts'

/** Clients with a generated configuration. */
export type ClientConfigTarget = 'codex' | 'claude-code' | 'json'

/** Every client target, in the order help lists them. */
export const CLIENT_CONFIG_TARGETS: readonly ClientConfigTarget[] = ['codex', 'claude-code', 'json']

/** MCP server name clients address; external tool names become `mcp__dsh_cua__cua_run_code` in Claude Code. */
export const MCP_SERVER_NAME = 'dsh_cua'

/** The exact stdio command a client runs to start this profile. */
export interface ClientLaunch {
  /** Absolute executable path. */
  readonly command: string
  /** Arguments in order, ending with the profile selection. */
  readonly args: readonly string[]
  /** Environment the client passes to the process. */
  readonly env: Readonly<Record<string, string>>
  /** Shell command that installs the profile once; rendered as a comment where the format allows one. */
  readonly setup: string
}

/** The process facts a generated client configuration embeds. */
export interface LaunchFacts {
  readonly execPath: string
  readonly execArgv: readonly string[]
  readonly argv: readonly string[]
  /** Whether this process is a single-file executable, which takes no script argument. */
  readonly sea: boolean
}

/**
 * Resolve the stdio command a client runs to reach this exact installation and profile.
 * @param facts - Current process executable, Node options, and arguments.
 * @param profile - Launched profile.
 * @param consent - Consent mode the generated environment pins.
 * @returns Absolute command, arguments, environment, and the one-time profile setup command.
 * @throws Error when a script-launched process has no script argument.
 */
export function clientLaunch(facts: LaunchFacts, profile: Pick<ProfileContext, 'name' | 'home'>, consent: ConsentMode): ClientLaunch {
  const selection = ['--profile', profile.name]
  const script = facts.argv[1]
  if (!facts.sea && script === undefined) throw new Error('cua-mcp: the launching script is unknown, so no client command can be generated')
  return {
    command: facts.execPath,
    args: facts.sea ? selection : [...facts.execArgv, script as string, ...selection],
    env: { DSH_HOME: profile.home, DSH_CUA_CONSENT: consent },
    setup: `dsh plugin --profile ${profile.name} enable @deepseek-ai/dsh-cua-mcp`,
  }
}

/** Per-call limit a client should allow; the default `cua_run_code` maximum timeout is ten minutes. */
const TOOL_TIMEOUT_SECONDS = 600
/** Startup allowance covering first-run native helper preparation on macOS. */
const STARTUP_TIMEOUT_SECONDS = 120
/** Output budget matching the Claude Code default and the Codex Computer Use plugin. */
const OUTPUT_TOKEN_LIMIT = 25_000

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlInlineTable(values: Readonly<Record<string, string>>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`
}

/**
 * Render the configuration an MCP client needs to run this server.
 * @param target - Client whose configuration format is rendered.
 * @param launch - Resolved stdio command of this installation and profile.
 * @returns Complete text ending with one newline: a TOML fragment for Codex, a `claude mcp add-json` command
 *   for Claude Code, or a generic `mcpServers` JSON document.
 */
export function renderClientConfig(target: ClientConfigTarget, launch: ClientLaunch): string {
  const entry = {
    type: 'stdio' as const,
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
  }
  switch (target) {
    case 'codex':
      return [
        `# ~/.codex/config.toml — run once first: ${launch.setup}`,
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `command = ${tomlString(launch.command)}`,
        `args = [${launch.args.map(tomlString).join(', ')}]`,
        `env = ${tomlInlineTable(launch.env)}`,
        `startup_timeout_sec = ${String(STARTUP_TIMEOUT_SECONDS)}`,
        `tool_timeout_sec = ${String(TOOL_TIMEOUT_SECONDS)}`,
        'enabled_tools = ["cua_run_code", "cua_reset"]',
        'omit_tools_from = ["code_mode", "deferred"]',
        '# default_tools_approval_mode = "auto"',
        '',
        `[mcp_servers.${MCP_SERVER_NAME}.tools.cua_run_code]`,
        `output_token_limit = ${String(OUTPUT_TOKEN_LIMIT)}`,
        '',
      ].join('\n')
    case 'claude-code': {
      const json = JSON.stringify({ ...entry, timeout: TOOL_TIMEOUT_SECONDS * 1000, alwaysLoad: true })
      return [
        `# run once first: ${launch.setup}`,
        `claude mcp add-json ${MCP_SERVER_NAME} '${json.replaceAll("'", String.raw`'\''`)}'`,
        '',
      ].join('\n')
    }
    case 'json':
      return `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2)}\n`
    default:
      return assertNever(target)
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown client configuration target ${String(value)}`)
}
