# Agent Note: On-demand MCP tool loading

Status: implemented

English | [中文](2026-10-08-mcp-on-demand-tool-loading.zh.md)

## Problem

A connected MCP server sends every tool definition with every request. Notion's hosted server advertises 46 tools whose definitions total about 214,500 characters; one tool's input schema alone is about 83,000 characters. A Notion plugin that only registers the server therefore costs that context on every request, before the model uses a single Notion tool.

The existing `ToolSchema.deferLoading` marker does not solve this. Only routes that declare `toolUpdate` honor it, and the default `deepseek-flash` entry is the only catalog route that does. The marker keeps a prefix reusable; it does not reduce context.

## Decision

An mcp-client entry with `toolLoading: on-demand` keeps the server's tools out of the tool registry. The behavior lives in mcp-client; no session event, message type, or other package changes, and mcp-manager only passes the field to its instances.

**One loader per server.** The server registers `mcp__<serverName>__load_tools` where an eager server registers its tools, and withdraws it where an eager server removes them, so outages and reconnects follow the eager lifecycle. A server tool named `load_tools` is left out of the catalog with a logged warning.

**The catalog is a system prompt section.** The `mcp:<serverName>:tools` section lists each tool's raw name with the first line of its description, capped by `catalogDescriptionMaxLength`, and renders only for an agent that sees the loader. The session log already records the system prompt, so the catalog needs no new message type, and it changes only when the server's tool list does.

**Loading registers in the agent's own scope.** The loader validates every requested raw name before registering any, then registers the definitions in a scope the plugin creates for that agent. The plugin releases the scope on `agent/disposed`, and plugin unload disposes it. The next request header carries the definitions, and the agent loop records the addition. Subagents, forks, and resumed sessions start with no loaded tools.

**Each published generation carries loaded tools forward.** A tool definition calls the client of the generation that built it, so a reconnect must replace loaded definitions. Each published generation re-registers every agent's loaded names that it still offers and drops the rest. A failed re-registration drops only that agent's tool and logs the failure.

**The loader decides access.** Tool restrictions filter only inherited tools, so seeing the loader permits loading any listed tool, as seeing `skill` permits loading any listed skill. Execution guards and permissions still apply.

## Alternatives considered

**A shared `load_mcp_tools` tool in mcp-resources with a session catalog message.** Rejected after implementation: it needed a cross-package catalog interface, a Host-wide-only restriction, an `agent/pre-step` listener that scanned session history on every step of every agent, and a persisted message type.

**The catalog in the loader's tool description.** Rejected: OpenAI and Azure OpenAI Chat Completions reject tool descriptions longer than 1024 characters, pi-ai routes pass descriptions through unchanged, and a catalog of a dozen tools exceeds that limit.

**A static `includeTools` list per entry.** Rejected: each plugin must choose its tools ahead of time, and the model cannot use the other tools during a session.

**A proxy tool `call_mcp_tool(server, tool, args)`.** Rejected: the tool list never changes, but the model loses each tool's argument schema, and permissions, presentation, and guards that match tool names would need forwarding.

**Mark MCP tools with `deferLoading`.** Rejected: it saves no context and works only on routes that declare `toolUpdate`.

**Global registration hidden per agent with `tools.restrict({ deny })`.** Rejected: every agent needs a restriction scope, and every tool change rescans the registry and copies every schema.

**Restore loaded tools on resume.** Rejected: it needs a durable record of loaded names, which is a session format change. The agent loop already records which tools a resumed session lost.

## Testing

mcp-client specs cover the loader-only registration and the prompt catalog, catalog omission for agents that cannot see the loader, loading into one agent's scope, invalid loads, carrying loaded tools across generations, withdrawal and restoration, agent release, a contained re-registration failure, the excluded `load_tools` server tool, a loader-name conflict, and the plugin path from load through call to unload. A manager spec mounts an on-demand entry. The `mcp-tool-loading` session snapshot pins the catalog section, the loader schema, the tool-addition record, and a call after loading.

## Consequences

- An on-demand server costs the loader definition and one catalog line per tool until an agent loads tools.
- Each load changes the next request's tool list. Routes declaring tool updates keep the earlier prefix; other routes start a new request series once per load.
- The model needs one extra tool call before using a server's tools.
- Agent tool restrictions do not filter loaded tools; `tools.guard` denies a loadable tool by name.
- A PTC program sees a tool loaded inside `run_code` only from the next program.
