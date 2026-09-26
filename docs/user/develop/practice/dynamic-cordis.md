# Configure persistent plugins from a prompt

English | [中文](dynamic-cordis.zh.md)

Creator mode provides [Plugin Manager](../../../../packages/boot/plugin-manager/README.md) and read-only [runtime inspection](../../../../packages/extensions/tool-cordis/README.md). Plugin configuration belongs to the current profile, affects its sessions, and survives process restarts.

## Connect an MCP server

Start the Web profile and select Creator mode. With a reachable Streamable HTTP MCP server that exposes `ping`, send this prompt using its actual endpoint:

> Configure the MCP server at `<endpoint>` in this profile as `demo`. Make its tools available now, then call its ping tool and tell me the result.

The agent writes a configuration-only bundle whose patch inserts `@deepseek-ai/dsh-mcp-client`, then installs it with `plugin_manager install_bundle`. With HMR enabled, the tools appear in the same running session. Verify both the management result (`application: applied`) and a successful `mcp__demo__ping` call. A saved entry with `restart-required` has not activated yet; a failed entry needs configuration repair.

Read the bundle patch before editing its configuration. Use Plugin Manager to disable entries or remove the bundle. See the [MCP client reference](../../../../packages/mcp/mcp-client/README.md) for accepted configuration and connection failure behavior.
