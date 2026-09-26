# Connect an MCP server

Read `templates/mcp/` with the file-read tool and write its files into your bundle directory. A configuration-only bundle's manifest needs a unique name, version, and `dsh.bundle.patch`, but no Host/Client entry files. Its patch, `templates/mcp/cordis.patch.yml`, inserts the already installed `@deepseek-ai/dsh-mcp-client` with `serverName`, `transport: streamable-http`, `url`, and `failOnStartupError: true`.

Replace the endpoint, install the bundle through `plugin_manager`, then call `mcp__demo__ping` or another newly available `mcp__<serverName>__<tool>` tool to verify the connection. For stdio, use `transport: stdio`, `command`, and optional `args`, `env`, and `cwd`; `Config.listConfigs` on the installed row returns the complete client schema. Ambient credentials are scrubbed; reference existing credentials with Loader `!!js` rather than copying secrets into conversation text. Repair the same bundle on failure instead of creating duplicates.
