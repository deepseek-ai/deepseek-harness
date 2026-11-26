# Agent Note: Tool reachability and initial disclosure

Status: proposed

English | [中文](2026-11-18-tool-reachability-and-initial-disclosure.zh.md)

## Problem

Both root registries disclose every reachable tool in full at every step: `tool-registry-native` through the request `tools` field, `tool-registry-ptc` through the `tools:sdk` section. No per-tool statement exists for how the model may call a tool and how much it receives before any discovery; `ToolSchema.deferLoading` names one provider mechanism instead.

## Proposal

Describe every reachable tool with two model-facing dimensions, defined by what the model receives, not by what the host or provider transmits.

### Reachability

| Value | Meaning |
|---|---|
| `native` | Callable only as a provider tool call. |
| `program` | Callable only from inside a `run_code` program. |
| `both` | Callable either way. |

Authorization is separate: a tool removed by `restrict()` or not added for the Agent by its provider is absent from this model; a guard denies one execution and changes neither dimension.

### Initial disclosure

| Value | What the model receives before any discovery |
|---|---|
| `none` | Nothing about this tool. |
| `name` | The tool name. |
| `summary` | A description without parameters; may be given per namespace. |
| `full` | Name, description, parameters, and for `program` reachability the return type. |

Every reachable tool is searchable; `none` only means absent from the initial disclosure.

## Alternatives considered

**A visibility axis of `invisible`, `discoverable`, `injected`, `system prompt`.** `injected` is the state a tool enters after a search hit, `system prompt` is a channel, and no name-only level exists; the axis mixed policy, state, and channel.

**A `discoverable` boolean.** Every case that seemed to need an unsearchable tool is authorization, search ranking, an alias, or a runtime builtin that is not a tool; omitting a schema is not enforcement ([packages/AGENTS.md](../../../../packages/AGENTS.md)).

## Acceptance criteria

- Each registered tool resolves to one value per dimension per step, and both root registries read the same resolution.
- A `none` tool is found through `tool_search` and then called under each root registry in a recorded snapshot; a `native` activation projects through [active tool headers](../../implemented/architecture/2026-09-20-dynamic-tool-updates.md).

## Risks

- Discovery adds a model round trip, and search quality depends on tool names and descriptions.
- Per-step recomputation moves tools between values and changes the declaration prefix the cache relies on.
