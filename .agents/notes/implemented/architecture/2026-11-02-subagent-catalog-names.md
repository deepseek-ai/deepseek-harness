# Agent Note: Subagent names live in the creator's catalog

Status: implemented

English | [中文](2026-11-02-subagent-catalog-names.zh.md)

## Problem

Models coordinate subagents through `send_message`, `interrupt_agent`, `list_agents`, and Team task owners. Those tools addressed every member by a 36-character Session id. Models copy such ids poorly: they cannot recall which id belongs to which task, they mistype ids, and every listing, receipt, notice, and identity statement spends tokens on them. Descriptions explain responsibilities but repeat and cannot address a member. Models need short, readable references that survive restarts and resolve to exactly one member, without a second execution identity.

## Decision

The Session id remains the only execution identity for routing, authorization, persistence, task ownership, and navigation. A name is a model-facing reference to it.

Each new child has a name that is unique among its creator's children. The name is a field of the `subagent/catalog` entry that the creator already appends when it creates the child, using catalog payload version 3. Local and parent-delivered external creation write it; caller-delivered external runs enter no catalog and take no name. A name is 1–32 lower-case letters, digits, or hyphens starting with a letter, and is never `lead`. A 36-character UUID therefore never parses as a name. Omission selects the first free `agent-N`. An explicit name already held by a sibling fails with `DUPLICATE_AGENT_NAME`, and an invalid name fails with `INVALID_AGENT_NAME`.

The creator reserves the name synchronously at admission, before startup awaits anything. The reservation lives in process memory beside the creator's committed catalog names and is released when the catalog entry commits or startup fails. Task assignment copies the immutable full name into optional `ownerName` beside `ownerId` in the same task event. Task reads use this saved value and fall back to `ownerId`, so display does not require catalog traversal.

The root is always `lead`. A descendant's full name is the slash-separated path of names from the root without a `lead/` prefix, such as `reviewer/checker`. Sibling-unique segments make full names unique in the tree. A child whose catalog entry predates names, and every descendant below it, keeps its Session id as its name.

`ctx.subagents.resolveName()` returns the Session id for `lead` or a full name by reading only the catalogs along the path; any other text is returned unchanged as a Session id. Tools resolve before they call messaging, interruption, or Team assignment, and those operations authorize the resulting Session id. Resolution grants no authority. Runtime-authored text names agents by full name, while durable attribution such as `senderSessionId` and Team `ownerId` keeps Session ids. The [subagent runtime](../../../../packages/subagent/subagent/README.md#agent-names) owns the API contract and the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.3/subagent-names/guide.md) owns caller migration.

This supersedes the rejection of "unique names as sibling-routing opt-in" and the statement that creation accepts no member name in [subagent teammates](2026-10-15-agent-teams-as-subagents.md), and the Session-id identity text in [required runtime-context identity](2026-10-13-team-identity-runtime-context.md). Their single-identity, Team, and runtime-context retention decisions remain active.

## Alternatives considered

**Optional naming plugin with a root-Session binding event.** A separate plugin would record a name-to-Session binding in the root Session after the child starts. That adds a second write that can fail independently after startup succeeds, so a started child can lack its binding, and binding after start can report errors for children that are already running. The presentation plugin would then own cancellation of a lifecycle it does not control, would rewrite runtime-authored messages that name agents, and would still change model-visible schemas when it is absent, because the core tools must accept and render either form. Recording the name in the creator's existing catalog fact needs no second write, no rollback protocol, and no optional service.

**Flat names unique across the tree.** A tree-wide flat namespace needs one registry at the root that every creation must consult and update, including creations by descendants whose root may be cold. Sibling-unique segments joined into paths are unique without a root registry, and each creator checks only its own catalog.

**Recyclable names.** Releasing a name when its child settles would let a later sibling take it. A model that still remembers the earlier child would then message or interrupt a different agent. A name stays taken for as long as the catalog entry exists.

**Automatic suffixes on conflict.** Turning a duplicate `reviewer` into `reviewer-2` would let creation succeed, but the model would believe it holds a name that the runtime never assigned. A duplicate fails so that the model chooses a name it knows.

## Consequences

Catalog payload version 3 is a same-format addition: `SESSION_FORMAT_VERSION` is unchanged, current readers accept versions 0 through 3, and releases that predate names reject version 3 loudly. The `subagentCatalog` projection state version remains 6 because old checkpoint facts keep their meaning and accept named suffix events; invalidating them would add full catalog folds to cold descendant observations without changing the recovered state. Native admission rejects a repeated sibling name in own catalog facts, so a log that could make name lookup ambiguous fails before any member is resolved. The [persistence acknowledgement](../../../../docs/persistence-changes/2026-11-02-subagent-catalog-names.md) records the type change.

Tool schemas grow by one optional `name` parameter on each delegation tool, and `send_message` and `interrupt_agent` rename `agent_id` to `agent`. These schema changes invalidate cached request prefixes once after upgrading. Identity runtime context, receipts, settlement notices, agent messages, and listing rows become shorter for shallow trees, while full names lengthen with nesting depth. `list_agents` drops parent ids and depth because a full name encodes both.

Names cannot be renamed or recycled. Historical children have no names, and no migration assigns them. Name reservations are process-local, as is subagent residency. Tools still accept Session ids, so recorded Session ids and members below unnamed creators remain addressable.

## Testing

Runtime tests cover requested and default names, duplicate and invalid names rejected before startup, reservation across concurrent startup and release after failed startup, nested paths and `namesOf`, resolution of names, unknown text, and Session ids without granting authority, cold restoration of a member's path from the catalogs along its creation chain, and Session-id addressing below an unnamed historical creator. Catalog tests restore version-3 names beside unnamed historical entries, and the V4 format reader admits native version-3 catalog facts. Control-tool and Team-tool tests cover name-addressed messaging, listing rows, owner names, and historical owners shown by Session id. Recorded sessions pin the tool schemas, identity runtime context, receipts, listing rows, and Team policy text.
