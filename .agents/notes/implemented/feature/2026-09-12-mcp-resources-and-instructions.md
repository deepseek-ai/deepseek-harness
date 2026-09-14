# Agent Note: On-demand MCP resources and scoped server instructions

Status: implemented

English | [中文](2026-09-12-mcp-resources-and-instructions.zh.md)

## Problem

MCP servers expose documents and URI templates separately from tools. A tools-only client cannot read those documents or use a server that offers resources without tools. Servers also supply instructions that explain how their operations fit together; ignoring those instructions removes context needed to choose and combine operations.

## Decision

[`mcp-resources`](../../../../packages/mcp/mcp-resources/README.md) provides three shared tools for listing resources, listing templates, and reading a URI. Each requires an explicit configured server name. When system-prompt assembly is composed, a literal section derives the caller-visible names from the dispatch registry, so resource-only servers remain discoverable without server instructions. The existing system-message log records those names; provider disposal removes them from later assemblies. The execution path resolves that server in the calling agent's scope before dispatch; provider registrations use reversible Cordis effects.

The [profile availability decision](2026-09-13-mcp-resources-in-profiles.md) supersedes the separate opt-in resource mount and owns conditional tool visibility. This note retains the resource operations, result representation, and instruction decisions. Each [`mcp-client`](../../../../packages/mcp/mcp-client/README.md) instance owns its connection and registers a resource provider when the service is mounted. The SDK returns empty resource and template lists when the server lacks the resource capability; unsupported reads fail. Servers need not advertise tools. The official SDK owns protocol operations; list cursors and resource URIs remain opaque, and an explicit cursor requests one page while an omitted cursor lets the SDK collect pages.

Resource results preserve the complete canonical JSON for programmatic callers. Native text includes the configured server name and returned URI metadata. String-valued `blob` fields become binary descriptions instead of inline base64. Existing tool-result logging records the model projection; this package does not create a parallel resource log or a binary attachment store.

Server instructions contribute one scoped literal system-prompt section per configured MCP server. The existing logged system message records the assembled instructions that reach the model. Resource contents remain on demand, so connecting a server does not preload its documents into the prompt.

This decision supersedes only the resource deferral in the [original MCP client note](2026-07-07-mcp-client-plugin.md). That note remains active because its tool naming, canonical-result, environment, and transport rationale still apply. Prompts remain unsupported.

## Alternatives considered

**Separate resource tools for every server.** Rejected because every server would add another set of identical operation schemas. Three shared tools keep the catalog small; explicit server arguments and execution-time scope resolution select the provider.

**Automatically inject or refresh resource contents.** Rejected because resource listings do not establish which documents a task needs. On-demand reads let the model choose content, avoid unrelated documents, and retain the result it actually used. Resource subscriptions and update notifications remain unimplemented.

**Project binary resources as native content.** Deferred because images and audio require coordinated capability, persistence, and presentation support. Preserving canonical bytes while rendering metadata supplies useful text-resource access without inventing another content mechanism.

**Add MCP-specific durable events for instructions and reads.** Rejected because the assembled system message and tool results already record the model-visible inputs. A second event authority would duplicate those records.

## Verification

The [resource tests](../../../../packages/mcp/mcp-resources/tests/resources.spec.ts) pin all three operations, unchanged cursors, required server arguments, unavailable-server rejection, scoped provider selection, duplicate rejection, disposal, and lossless canonical results with binary-free model text. They also verify caller-visible server names without server instructions, literal names, and removal of prompt context when providers or the resource service are disposed. The [tool-result contract](../architecture/2026-07-20-canonical-tool-output-contract.md) owns the distinction between execution-time values and recorded model content.

## Consequences

Resource-only servers become useful without adding per-server model tools. Caller-visible server names and server instructions add prompt tokens; resource documents add tokens only when read. Shared schemas stay stable during connection failures while a caller-visible client remains configured, but a call still fails when its selected server is unavailable. Binary resources remain programmatic values, and pagination follows the SDK.
