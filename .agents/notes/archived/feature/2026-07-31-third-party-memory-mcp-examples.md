# Agent Note: Third-party memory MCP examples

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-third-party-memory-mcp-examples.zh.md)

## Problem

A direct vendor integration made one provider's API, configuration, health behavior, and tool semantics part of DSH. That was too much product surface for a capability already expressible through MCP, and it would require repeating the same adaptation for every memory system. Users instead need a small, inspectable way to opt into one external memory server while preserving the generic MCP boundary.

The acceptance bar is stronger than "the socket connects": each reference must support a real DSH write in session A, recall from the provider in a fresh DSH session B, and use of the recalled value. At the same time, provider downloads, accounts, models, embeddings, storage initialization, and separate HTTP processes must remain upstream responsibilities.

## Decision

Ship three default-off Cordis overlay examples under `apps/cli/config/examples/mcp-memory`: Memorix, MCP Reference Memory, and Engram. Every file inserts exactly one `@deepseek-ai/dsh-mcp-client` row. None is referenced by the default composition, and the CLI declares the generic bridge so an explicitly selected overlay resolves in installed and source launches. The [memory MCP guide](../../../../docs/user/guide/mcp-memory.md) owns setup and verification.

These third-party configurations are provided as interoperability examples only. Their inclusion does not imply endorsement, recommendation, partnership, or ongoing support by DeepSeek. There is no memory preset registry, vendor-specific DSH plugin, universal memory service, installation UI, migration layer, health checker, or reconnect controller. Another memory MCP server uses the same documented stdio or Streamable HTTP row.

## Responsibility boundary

| Concern | DSH | Upstream provider or user |
|---|---|---|
| Parse selected overlay | Yes | Select one file |
| Start stdio command and stop it on plugin disposal | Yes | Install the pinned executable |
| Connect to Streamable HTTP and discover tools | Yes | Run and supervise the HTTP service |
| Register tools as `mcp__<serverName>__<rawName>` | Yes | Define tool schemas and behavior |
| Account, auth, model, embedding, storage initialization | No | Yes |
| Vendor data migration, retry, crash recovery | No | Yes |

The generic stdio transport scrubs ambient credential-shaped and `DSH_*` variables while inheriting other ambient variables. Baseline examples add only required overrides; optional provider secrets must be added to `config.env` or configured in the provider's own files.

## Pins, storage, and identity

| Provider | Tested contract |
|---|---|
| Memorix | npm `1.3.0`, tag commit `500792cad3144142293bfbb20acb4841c9f7fcfa` |
| MCP Reference Memory | npm `2026.7.4`, package commit `6dd0a683e198783e30feabf7abaf42f925bd18b1` |
| Engram | tag `v1.20.0`, commit `ba9e46ced152c37a7cb9e576153c41995873e2fc` |

Storage remains provider-owned. Memorix uses `~/.memorix/data` and Engram uses `~/.engram` by default. The Reference Memory example sets a stable `$HOME/.dsh-mcp-reference-memory.jsonl` path instead of writing into the installed npm package directory. Each provider's own environment variable can override these locations before DSH starts.

Project identity remains provider-owned: Memorix and Engram use the DSH working directory's Git project, with Engram optionally accepting `ENGRAM_PROJECT`.

## Model guidance

The examples do not patch `@deepseek-ai/dsh-system-prompt`: a config patch replaces a row's complete config and could erase an existing persona. The README instead offers one optional additive instruction:

> When the user asks you to remember something, call a memory write tool. When historical information may be relevant, search memory and use relevant results.

Provider tool descriptions remain authoritative.

## Validation contract

Remote CI never contacts third-party services or consumes secrets. The keyless suite parses all three overlay files, checks their generic bridge and secret boundary, replaces the upstream endpoint with the package-owned MCP fixture server, boots the real Cordis Loader, and proves tool discovery.

Before merge, manual evidence for every pinned provider must separately show:

1. DSH session A calls a write tool and receives success for a unique value.
2. Fresh DSH session B, under the same provider storage scope, calls search or recall and returns that value without session A's transcript.
3. Session B uses the recalled value in a subsequent answer.

"Fresh session" means a new DSH session in the same Host. No Host restart is required. The generic MCP client discovers asynchronously and has no automatic reconnect after a child or HTTP transport closes; validation waits for tools before the first turn and uses HMR or a Host restart only after a crash.

## Alternatives considered

**One DSH plugin per provider.** Rejected because it repeats auth, configuration, lifecycle, and tool wrappers that MCP already standardizes and expands ownership for every added provider.

**A memory-provider preset registry.** Rejected because a registry would make third-party versions and recommendations look like a supported DSH product surface. Copyable overlays keep ownership and drift visible.

**Run `npx` or `go run` inside the MCP row.** Rejected after probes showed first-run npm downloads can exceed the MCP initialization timeout and an interrupted `npx` cache can become unusable. DSH starts a server process; it is not the provider package manager. Pinned installation commands are explicit prerequisites.

**Inject the common instruction from the generic MCP client.** Rejected because the bridge serves non-memory MCP servers too, and generic prompt mutation would reintroduce provider semantics into shared runtime code.

## Consequences

Selecting a file gives the model the provider's complete discovered MCP tool surface, with schema/token cost determined by that provider. Removing `--config` removes the memory server. Users accept each upstream license, data policy, cloud cost, and operational model directly.

The earlier vendor-specific change is superseded by this generic path. Future provider drift is handled by updating and revalidating a small example pin rather than adding runtime branches to DSH.
