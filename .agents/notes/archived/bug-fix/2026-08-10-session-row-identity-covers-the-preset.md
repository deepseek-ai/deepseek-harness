# Agent Note: The session-row identity guard covers the preset

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-session-row-identity-covers-the-preset.zh.md)

## Problem

`SessionManager.buildListSnapshot` memoizes list rows by value: a wire refresh mints all-new summary objects, so an entry equal to the cached one is replaced by the cached instance, and every `SessionListItem` memo downstream keeps hitting. The stated contract is "reuse the cached object when every field matches"; the comparison enumerated the fields by hand and did not enumerate `agentPreset`.

A confirmed preset switch moves exactly that one field. `noteAgentPreset` upserts it and `applyMutation` merges it in — the merge deliberately does not take the mutation's `updatedAt`, so a switched row differs from its cached twin in the preset and in nothing else. The guard therefore judged the row unchanged and served the stale instance, permanently: the manager's own summaries said `minimal` while every reader of the projected snapshot went on reading `standard`.

The hero chip is one of those readers, and it compares the pick against that row before sending anything. Switching back to the preset the session was created under looked to it like "already on that preset", so it dropped the stage and sent no RPC at all — the chip label moved while the composition did not. A session could be switched away from its creation-time preset once and never back.

## Decision

The identity guard compares `agentPreset` alongside the other summary fields, which is what "every field matches" already claimed. Nothing else changes: the memoization, the merge, and the chip's no-op check all stay as they are, because each is correct once the row it reads is.

## Alternatives considered

**Have the chip re-read the host instead of the list row.** It would route around the stale row, but the row is also what the session header labels itself from, so the staleness would survive in the surface where it is most visible — and any future reader of `SessionSummary.agentPreset` would inherit the same trap.

**Drop the entry-identity memoization and rebuild rows every snapshot.** It removes the whole class of missing-field bugs, at the cost the memo exists to avoid: a wire refresh mints new objects for every row, so each refresh would re-render the entire session list.

**Compare summaries structurally rather than field by field.** A generic deep comparison cannot be added blind: the row carries `projectionValues`, whose reference identity is the deliberate signal that the projection store republished, and folding it into a value comparison would either re-render on every projection tick or mask a real one.

## Consequences

Every field a session row carries now participates in row identity, so a surface reading `SessionSummary.agentPreset` sees a switch as soon as the host confirms it — the header label included. The guard is still a hand-written enumeration, so a field added to `SessionSummary` later must be added here too; the `sessions-service` projection test names the failure mode for the next such field rather than only pinning this one.

## Testing

`sessions-service.spec.ts` feeds a blank row, notes a switch, and asserts the projected snapshot reports the new preset — it fails on the old guard because the row differs in nothing else. The `agent-preset-selection` web e2e switches down and back up, asserting the host honors the second switch and the `/` catalog returns with it; without this fix the second switch never reaches the host at all.

## Related

The same e2e covers [the catalog-invalidation fix](2026-08-10-slash-catalog-follows-preset-switch.md), which is what makes the menu follow either switch once the switch itself lands.
