# Agent Note: MCP resource availability follows configured servers

Status: implemented

English | [中文](2026-09-13-mcp-resources-in-profiles.zh.md)

## Problem

Sessions without configured MCP servers need neither resource schemas nor MCP guidance. Requiring a separate resource-service entry also makes users configure shared resource access in addition to each connection. A shared tool set owned by the first server can disappear when that server unloads even though another server still needs it.

## Decision

Every shipped profile mounts `mcp-resources` once: base-backed profiles, including Desktop, inherit its row from `dsh-base`; standalone `sdk-minimal` owns its row. Users configure only their `mcp-client` entries. No MCP server is enabled by default.

The resource service uses configured provider registrations in the caller's scope, including MCP clients mounted by another provider. An empty visible registry contributes no resource prompt, native tool schemas, PTC declarations, or PTC bindings. The first provider in a scope enables its shared tools; removal of the last removes those local registrations while preserving inherited providers and tools. The resource service owns the shared tool effects independently of any server plugin.

Connection health does not determine this visibility. An active client remains configured through failed requests and reconnect attempts; its shared resource tools and server-name guidance stay available, and calls report connection failures. Server instructions retain their connection-owned publication rules.

This decision partially supersedes the separate opt-in mount in the [resource and instruction decision](2026-09-12-mcp-resources-and-instructions.md). That note retains the operation, scope-selection, canonical-result, binary-rendering, and logged-instruction rationale.

## Alternatives considered

**Keep the separate resource mount.** It makes a shared capability a second user configuration task and permits different defaults across shipped profiles.

**Keep resource tools visible without servers.** It adds unusable operations and prompt tokens to ordinary sessions, including the minimal SDK's single-shell default.

**Filter providers by negotiated resource capability.** This omits resource guidance for servers that declare no resources, but visibility then requires a successful capability exchange. The configured-client policy uses one criterion for direct and provider-mounted clients, including before the first successful connection and during recovery.

**Own shared tools under the first server plugin.** Disposing that server can remove tools still needed by another configured server. The service owns their lifetime instead.

## Verification

[Resource tests](../../../../packages/mcp/mcp-resources/tests/resources.spec.ts) cover empty native and PTC views, scoped inheritance, first/last-provider transitions, disposal, and failing configured providers. [Real SDK tests](../../../../packages/mcp/mcp-client/tests/protocol.spec.ts) pin empty discovery and unsupported read errors for a tools-only server. [Profile composition tests](../../../../apps/cli/tests/profile-mcp.spec.ts) resolve every shipped CLI template; [Desktop composition tests](../../../../apps/desktop/tests/profile-mcp.spec.ts) include its profile and Host overlay. The empty native and PTC recorded Sessions exercise the shipped headless composition without adding a resource entry.

## Consequences

An empty MCP configuration adds no MCP prompt or tool tokens. A configured server without resource capability still contributes its name and shared resource schemas. The SDK returns empty discovery lists; unsupported reads fail. Adding the first visible server or removing the last changes subsequent prompt and tool assembly. The minimal SDK advertises its single shell until the user adds MCP servers. Resource reads remain on demand, and no connection or durable Session format changes are required.
