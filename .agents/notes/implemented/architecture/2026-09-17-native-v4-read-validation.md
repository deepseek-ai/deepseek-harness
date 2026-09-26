# Agent Note: Mandatory native V4 relationship validation

Status: implemented

English | [中文](2026-09-17-native-v4-read-validation.zh.md)

## Problem

Tool-role results cannot be checked through the released V3 user-role representation without projecting away current fields. Replacing that validation view requires a native reader to retain the earlier lifecycle, retired-syntax, and system-message checks. The representation change and its mandatory admission therefore belong together.

An event can satisfy its TypeScript declaration and message rules while contradicting earlier durable events. A tool result without an advertised call and a checkpoint naming another compaction both contain locally valid fields. Accepting either as a current Session makes later readers depend on damaged relationships, and tightening admission after release can strand already-written histories.

## Decision

The V4 format restorer and current JSONL scanner share one mandatory cross-event relationship pass before exposing a restored artifact or storage handle. It checks turn and step order, advertised tool calls and settlements, PTC parentage and settlement identity, retry chains and request providers, human-message title citations, command completion references, compaction ownership and current spans, and the protected system head. The installed event set controls semantic interpretation, including compaction prepasses and title references. Unknown ignorable records retain their payloads and original positions; known records remain validated even when marked ignorable. The check reads native event fields without altering artifacts or projecting them into a historical format. JSON argument comparisons inspect own properties in both Node and the worker; inherited prototype members cannot satisfy recorded fields. The [tool-role decision](2026-09-15-first-class-tool-role-messages.md) owns result representation.

An unfinished tail may retain an open turn, step, tool call, or compaction. A closing event must settle the relationships it closes. An inherited unfinished compaction ends at its `session/end-seed` marker; it does not constrain the child's lifecycle. Repair message identities retain their historical numeric suffix after earlier migrations change sequence coordinates. Fork repairs retain their separately validated native identities.

Installed Session adoption continues to own event envelopes, message roles and metadata, canonical request headers, and surface replacement reference coverage. Optional runtime invariants provide diagnostics; their installation is not required for durable admission. Native system-message admission also validates coordinates, identity, content blocks, and known image/tool-call fields before physical recovery can discard rows. Additional JSON fields and unknown nonempty content tags remain intact; retired tool-result wrappers are refused. Retired `request/header.header.system` and required `tool/code-dispatch*` tags remain hard refusals before recovery; obsolete ignorable PTC records remain opaque. Physical framing alone does not establish semantic validity.

A retired tool-result wrapper outside its owning `tool/result` row would require changing the event, role, or source to represent it in V4. The adjacent migration lifts only the canonical owned wrapper; target restoration refuses wrappers remaining in interpreted content. Native row admission applies the same refusal before recoverable tail suppression. The check follows declared message, content, and Assistant-stream slots instead of recursively inspecting JSON, so tool arguments, replay state, schema parameters, nested extensions, and unknown ignorable payloads retain their recorded values.

`EpochHeader.system` explicitly reserves the retired key as `system?: never` with `@persistenceReserved`. The catalog retains its empty value set so permitting a value is a change to a forbidden field, rather than an ordinary optional-field addition. The native reader and Session adoption continue to reject that key; system prompts remain `system/message` events.

## Alternatives considered

**Project V4 back into a frozen V3 validation view.** This couples current acceptance to retired representations and invites new fields to disappear in the projection. Frozen generations remain independently readable, while the current restorer interprets its own fields.

**Rely on optional runtime invariants.** Detached readers and restoration paths may not install diagnostic companions. A required relationship must be checked before publication or consumption of the restored Session.

## Consequences

The native restorer maintains one bounded state machine per read and rejects contradictions before successor publication. Frozen V0–V3 validators and committed Session generations remain unchanged. Public catalog regressions cover invalid relationships alongside partial tails, inherited cuts, immutable unknown attribution, and complete tool exchanges; these checks enforce the declared V4 representation without changing its schemas. Breaking changes require a successor; compatible additions use new acknowledgements, and implementation fixes preserve the declared meaning.
