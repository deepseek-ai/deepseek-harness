/** Generated client configurations embed the exact launch command and quote every value. */
import { describe, expect, it } from 'vitest'
import { CLIENT_CONFIG_TARGETS, MCP_SERVER_NAME, clientLaunch, renderClientConfig, type ClientLaunch } from '../src/client-config.ts'

const launch: ClientLaunch = {
  command: '/opt/node/bin/node',
  args: ['/opt/dsh/lib/bin.js', '--profile', 'cua-mcp'],
  env: { DSH_HOME: "/Users/o'neil/.dsh", DSH_CUA_CONSENT: 'elicit' },
  setup: 'dsh plugin --profile cua-mcp enable @deepseek-ai/dsh-cua-mcp',
}

describe('client configuration', () => {
  it('renders a Codex TOML fragment with the launch command, limits, and the setup command as a comment', () => {
    const toml = renderClientConfig('codex', launch)
    expect(toml).toMatchInlineSnapshot(`
      "# ~/.codex/config.toml — run once first: dsh plugin --profile cua-mcp enable @deepseek-ai/dsh-cua-mcp
      [mcp_servers.dsh_cua]
      command = "/opt/node/bin/node"
      args = ["/opt/dsh/lib/bin.js", "--profile", "cua-mcp"]
      env = { DSH_HOME = "/Users/o'neil/.dsh", DSH_CUA_CONSENT = "elicit" }
      startup_timeout_sec = 120
      tool_timeout_sec = 600
      enabled_tools = ["cua_run_code", "cua_reset"]
      omit_tools_from = ["code_mode", "deferred"]
      # default_tools_approval_mode = "auto"

      [mcp_servers.dsh_cua.tools.cua_run_code]
      output_token_limit = 25000
      "
    `)
  })

  it('renders a shell-safe claude mcp add-json command with the stdio entry', () => {
    const command = renderClientConfig('claude-code', launch)
    const [comment, line] = command.trimEnd().split('\n')
    expect(comment).toBe('# run once first: dsh plugin --profile cua-mcp enable @deepseek-ai/dsh-cua-mcp')
    const match = /^claude mcp add-json dsh_cua '(.*)'$/.exec(line ?? '')
    if (match === null) throw new Error(`unexpected command line: ${String(line)}`)
    // The single-quoted shell argument closes, escapes, and reopens around the apostrophe in the home path.
    const shellValue = match[1]!.replaceAll(String.raw`'\''`, "'")
    expect(JSON.parse(shellValue)).toEqual({
      type: 'stdio', command: launch.command, args: launch.args, env: launch.env, timeout: 600_000, alwaysLoad: true,
    })
  })

  it('renders a generic mcpServers document without comments', () => {
    expect(JSON.parse(renderClientConfig('json', launch))).toEqual({
      mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: launch.command, args: launch.args, env: launch.env } },
    })
    expect(CLIENT_CONFIG_TARGETS).toEqual(['codex', 'claude-code', 'json'])
    expect(() => renderClientConfig('cursor' as 'json', launch)).toThrow('unknown client configuration target cursor')
  })
})

describe('launch resolution', () => {
  const profile = { name: 'cua-mcp', home: '/home/me/.dsh' }

  it('embeds the Node executable, its options, and the launching script for a script launch', () => {
    expect(clientLaunch({ execPath: '/opt/node', execArgv: ['--import', 'tsx/esm'], argv: ['/opt/node', '/repo/apps/cli/src/bin.ts', 'cua-mcp'], sea: false }, profile, 'allow'))
      .toEqual({
        command: '/opt/node', args: ['--import', 'tsx/esm', '/repo/apps/cli/src/bin.ts', '--profile', 'cua-mcp'],
        env: { DSH_HOME: '/home/me/.dsh', DSH_CUA_CONSENT: 'allow' },
        setup: 'dsh plugin --profile cua-mcp enable @deepseek-ai/dsh-cua-mcp',
      })
  })

  it('embeds only the executable for a single-file runtime and rejects a script launch without a script', () => {
    expect(clientLaunch({ execPath: '/opt/dsh-runtime', execArgv: [], argv: ['/opt/dsh-runtime', '--profile', 'cua-mcp'], sea: true }, profile, 'elicit').args)
      .toEqual(['--profile', 'cua-mcp'])
    expect(() => clientLaunch({ execPath: '/opt/node', execArgv: [], argv: ['/opt/node'], sea: false }, profile, 'elicit'))
      .toThrow('launching script is unknown')
  })
})
