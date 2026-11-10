/** Generated client configurations embed the exact launch command and quote every value. */
import { describe, expect, it } from 'vitest'
import { CLIENT_CONFIG_TARGETS, MCP_SERVER_NAME, clientLaunch, renderClientConfig, type ClientLaunch } from '../src/client-config.ts'

const launch: ClientLaunch = {
  command: '/opt/node/bin/node',
  args: ['/opt/dsh/lib/bin.js', '--profile', 'cua-mcp'],
  env: { DSH_HOME: "/Users/o'neil/.dsh", DSH_CUA_CONSENT: 'elicit' },
}

describe('client configuration', () => {
  it('renders a Codex TOML fragment with the launch command and limits', () => {
    const toml = renderClientConfig('codex', launch)
    expect(toml).toMatchInlineSnapshot(`
      "# ~/.codex/config.toml — the first start initializes the profile and prepares the Computer Use helper
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
    const lines = command.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    const match = /^claude mcp add-json dsh_cua '(.*)'$/.exec(lines[0] ?? '')
    if (match === null) throw new Error(`unexpected command line: ${String(lines[0])}`)
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
      })
  })

  it('embeds only the executable for a single-file runtime and rejects a script launch without a script', () => {
    expect(clientLaunch({ execPath: '/opt/dsh-runtime', execArgv: [], argv: ['/opt/dsh-runtime', '--profile', 'cua-mcp'], sea: true }, profile, 'elicit').args)
      .toEqual(['--profile', 'cua-mcp'])
    expect(() => clientLaunch({ execPath: '/opt/node', execArgv: [], argv: ['/opt/node'], sea: false }, profile, 'elicit'))
      .toThrow('launching script is unknown')
  })
})
