Agents can call the tools of the Demo MCP server.

## How to use

- Ask the agent for a task that the server's tools perform. The agent decides when to call them.

## Good to know

- The server's tools and any instructions it sends are added to every model request, so they use some tokens even when the agent does not call them.
- Tool arguments the agent chooses are sent to the server, and its replies are added to the conversation.
- Turning the plugin off removes the tools from the agent's next request; that request cannot reuse cached input.
