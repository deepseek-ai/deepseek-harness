# Agent Note: Tool calls own preparation, dispatch, and results by callId

Status: implemented

English | [中文](2026-09-22-tool-call-three-phases.zh.md)

## Problem

The model often provides a tool name and call ID while it is still generating arguments, but `tool/call` arrives only after the entire Assistant stream ends. When one response contains several calls, an earlier call waits for later calls even after its own arguments are complete. File content is part of the arguments to `write`, so this delay can last several seconds.

Creating tool nodes only at `tool/call` presents that interval as no tool activity. Putting a preparing call in an Assistant part instead requires the Group to switch references between Assistant and Tool nodes. Preparation and dispatch belong to one tool lifecycle and do not require two cooperating nodes.

## Decision

### One Tool owns three stages

The [Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) groups calls by callId and supplies explicit stage data to tool components.

| Stage | Creation or update evidence | Available data and presentation |
|---|---|---|
| `preparing` | A live delta with a call ID and tool name | Call identity, name, time, and a lazy partial-argument view; one non-expandable row. |
| `start` | `tool/call` | Complete arguments; enables the tool's existing call presentation. |
| `result` | `tool/result` | The result and any complete arguments paired within the loaded window. |

An argument block ending does not trigger dispatch presentation. Showing preparation changes neither model requests, tool dispatch timing, Session events, nor the persisted format. An empty argument string does not stand in for a dispatched call.

### Start marks an initialization candidate

The [Conversation Definition](../../../../packages/client/ui-conversation/src/client/contract/conversation.ts) retains its match/start/update interface and existing roles. Durable events and transient deltas may both match as start. The earliest start in the current event sequence initializes State; every later Match, including another start for the same ID, goes through update.

Every tool delta and `tool/call` are initialization candidates. A named live delta creates the preparing row; a historical `tool/call` creates the dispatched stage directly. Matching still reads only the current event, without Context lookup, additional roles, registries, or separate caches.

Successful stream settlement publishes the final Assistant message while retaining transient deltas until `step/end`. Each `tool/call` updates its existing callId; the Assistant keeps its live ordering anchor until the same cleanup. Failed, interrupted, or abandoned streams retire their deltas immediately. On retirement the Assembler reselects starts and recomputes State from remaining Matches. Undispatched preparations hide without synthetic execution results.

### Converge on final state without replaying preparation

Historical pages do not expand settled Assistant messages into live deltas. Reconnection restores only an attempt that is still live. Live presentation may follow preparing → start → result, while history follows start → result directly. Equal durable events produce equal final state; intermediate presentation and preparation-group identity need not match.

Groups include Tool nodes from preparation onward and classify and count them by tool name. AssistantNodeView does not search tool blocks, and Groups neither encode tool groupPart values nor take over tool lifecycles. Grouping retains the [node-input grouping decision](2026-09-21-conversation-build-groups.md); the Builder does not interpret preparation business rules.

### Shared rows reuse their existing presentation

[ToolRow](../../../../packages/client/ui-tool/src/client/tool/components/ToolRow.tsx) reuses the existing icon, title, and row component across all stages. The shared row model selects the tool title and combines any generic tool-name prefix with the available argument summary. All stages expose the [lazy argument view](2026-09-24-preparing-tool-arguments.md); cards requiring dispatched arguments still return no call during preparation. ToolRow prevents preparation rows from expanding.

Read, read_image, write/edit, search, web, todo, question, details, and the generic fallback use this path. Bash shares its component across stages; Skill, Present, and Cordis retain their own preparation branches. No automatic/custom registration declaration or second tool-classification list in ToolTree is introduced.

### Relationship to existing records

This decision replaces the [business-node assembly](2026-08-09-client-conversation-node-assembly.md) restriction that starts must be durable and a Context may receive only one start. That record's stable IDs, business Definitions, Contexts, Locations, predecessor dependencies, and target Builder responsibilities remain applicable.

## Alternatives considered

**Create nodes only at `tool/call`.** This cannot show a known tool identity while arguments are being generated and leaves a visible wait in multi-call responses.

**Transfer presentation through Assistant parts and Groups.** A tool would need two presentation sources, additional deduplication, and identity transfer. Lifecycle ownership becomes distributed, and renderers must recover Assistant content from part identifiers.

**Persist or replay preparing.** Preparation describes current generation; durable calls and results already suffice to reconstruct the final presentation. Reproducing the same intermediate process adds unnecessary state and event interpretation.

**Add a preparation registration mechanism.** Generic tools already share ToolRow and argument models, including reusable icons and titles. Additional declarations or configuration for this stage would maintain another representation of tool presentation.

## Consequences

- A tool may appear before its arguments are complete, but preparation never implies execution. Interactions use only fields already available.
- Multiple starts with one ID belong to one lifecycle. Independent calls must use distinct IDs; a second-start error no longer detects identity reuse.
- The shared row primitive is reused across stages. Write/edit and Bash keep their component identity; custom rows may switch internal components by stage.
- Partial-argument access and its update policy follow the lazy argument view; no separate raw-prefix Hook is required.
- Assembly tests separately cover live preparation, withdrawal, active-stream reconstruction, durable history, and paged convergence. Component tests cover argument-free presentation and stage changes; a recorded session covers browser preparation and reload results.
