# Agent Note: Developer messages for incremental session changes

Status: implemented

English | [中文](2026-09-17-developer-session-changes.zh.md)

## Problem

Dynamic tool changes need durable, ordered records before providers can preserve the cached conversation prefix while changing available tools. Encoding these changes as free-form reminders would lose their structured tool identity and couple session state to prompt wording.

## Decision

`DeveloperMessage` records admitted model-visible session changes in conversation order. Additions store only `toolName`; the containing event's `headerSeq` selects an earlier full `request/header` with exactly one schema for each added name. One event binds all its additions to one header revision. Additions replace the active same-name definition; removals identify the name without duplicating its schema. The header reference is absent when the message contains no additions. Same-name replacement, restart, fork, and surface replacement retain historical definition identity without consulting the current registry or latest request header. Intermediate registry changes that no admitted request exposes do not require developer records.

`developer/message` carries the message and its admitting turn/step coordinates. Native readers and Session admission reject missing, forward, unknown, non-header, and ambiguous schema references, incomplete referenced definitions, and reject retired inline definitions while preserving unrelated JSON fields. `sourceEventSeqs` remains independent derivation metadata. A replacement retains its selected header and cites the shadowed surface nodes; combining additions from different header revisions requires separate events. Forks retain the referenced prefix, and compaction does not delete header events. Future cardinality-changing migrations must remap `headerSeq` as a same-artifact event reference. Empty developer content retains its surface position without adding a model message or shadowing the protected system head. The tools package owns the `tool-registry` source kind under the [producer-owned source rules](2026-09-09-producer-owned-message-sources.md).

`ToolAdditionBlock.tool` is declared as optional `never` with `@persistenceReserved`. The schema history therefore records the rejected field: permitting any value later changes an existing value type and requires a format bump, while unrelated optional metadata remains additive.

`ToolSchema.deferLoading` requests deferred definition loading independently of tool-addition history. Tool construction, registry projection, and prompt assembly preserve the marker. Dynamic addition and definition loading are separate facts; a predeclared deferred definition need not acquire a fabricated addition record.

The V4 codec confines developer roles to the `developer/message` slot, including rejection from inbox and title-request arrays. Native validation checks required developer fields, historical header bindings, and developer-only tool-change blocks while preserving additional JSON properties. Optional metadata additions therefore remain readable under the persistence checker's optional-property rule; additional fields cannot weaken required-field, role, or open-step checks. An ignorable marker does not establish reader support: physical decoding preserves developer payloads until vocabulary-aware admission, while writers and native readers reject malformed known data. Developer admission leaves malformed ordinary message slots to decoder recovery. Installed Session adoption validates surface relationships without converting developer records into released-V3 user records. The [released migration rules](2026-08-31-released-session-format-migrations.md) continue to protect committed predecessor generations.

Session V4 reserves the persisted representation needed by issue #4146. Production emission, provider projection, UI presentation, and compaction integration are described in the [dynamic tool update decision](2026-09-20-dynamic-tool-updates.md).

## Alternatives considered

**Use text reminders as developer content.** The format represents structured session changes; model instructions belong in system messages. Future developer content is unspecified rather than constrained to reminders.

**Duplicate definitions in each addition.** Full request headers already preserve the exact schemas. A historical reference avoids a second persisted copy while retaining same-name replacement identity. Binding by the latest header or registry instead would reinterpret older additions.

**Treat deferred loading as proof of a tool-addition record.** That would prevent predeclared deferred tools. The schema flag describes loading, while the block records a dynamic addition.

## Consequences

Session V4 persists the tool-change representation for issue #4146. Emission, route projection, DeepSeek serialization, and Chat and Trajectory presentation are owned by the [dynamic tool update decision](2026-09-20-dynamic-tool-updates.md).
