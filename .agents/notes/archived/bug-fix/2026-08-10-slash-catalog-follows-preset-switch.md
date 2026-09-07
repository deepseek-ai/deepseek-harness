# Agent Note: The slash catalog follows a blank session's preset switch

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-slash-catalog-follows-preset-switch.zh.md)

## Problem

Presets moved the rows that decide what a session's `/` menu contains. The Web composition disables host-plane `skill-filesystem`, `tool-skill`, `plan-mode`, and `command-compact`; a preset supplies them, so which commands and skills exist is a property of the session's composition rather than of the deployment.

Both browser catalogs cache per session — `CommandDirectory` in `dsh-client-ui-commands`, the single-flight fetch map in `dsh-client-ui-skill` — and the composer warms both at scope birth, under whatever preset the session was created with. The hero chip then lets the user recompose the still-blank session, and neither cache had an invalidation edge for that: `commands/change` is registry-wide and `connection/reset` needs a reconnect. `agentPresets.recompose` re-parents the agent's scope onto a standing mount that may already exist, so it registers nothing and the registry-wide signal never fires for it.

The menu therefore kept serving the composition the session no longer ran. Switching down left `compact`, `plan`, and every project skill listed; switching up left the narrower catalog — the four host-plane rows and the client's own `model` contribution — with no skills at all, which is what the bug report described. The catalog only healed when an unrelated registry change or a reconnect happened to invalidate it.

## Decision

The switch's commit point is the logged `agent-preset/selected` event. The preset owner re-emits that commit as the client-safe cordis owner event `agent-preset/selected(sessionId, agentPreset)`, the host stream forwards it verbatim, and each catalog subscribes directly through `ctx.remote.$on`: `ui-commands` soft-refreshes the key (the old snapshot keeps serving the open menu until the new one lands), while `ui-skill` invalidates it (aborting an in-flight prewarm, so a warm racing the switch cannot publish the stale catalog).

The owner event is per session and carries no catalog, only the preset id. `ui-agent-preset` folds it into the session row because the `agentPresets.select` echo reaches only the client that issued the switch and the row is what the session header labels itself from (and what the hero chip compares the next pick against).

Deriving the owner event from the logged event rather than from the RPC handler's return keeps one authority for "this session's composition changed": every connected client observes the switch, not only the tab that issued it, and a client that is not the switcher never has to infer it from a registry signal that will not come.

## Alternatives considered

**Invalidate in the client's own `agentPresets.select` callback.** Smallest change, and the preset is locked after the first turn, so the hero chip is the only place a switch can originate. Rejected because the invalidation would then live in the surface that happens to issue the RPC rather than at the commit point: a second tab on the same blank session keeps a stale menu, and any future host-side recomposition has no signal at all.

**Derive the client event from the existing `session/event` mux frame.** The logged event already reaches every subscribed client, so no new wire type would be needed. Rejected on face separation: narrowing `event.type` to `agent-preset/selected` requires the `SessionEventMap` augmentation, and the only ways to load it in the Client program are a project reference to `dsh-agent-presets` — which drags the host `ctx.sessions` merge into a program that publishes its own — or a cast that defeats the discriminant.

**Reuse forwarded `commands/change`.** It is the existing catalog-invalidation event, but it is registry-wide, carries no session, and says nothing about skills; a client would repull every session's commands and still never refresh a skill catalog.

## Consequences

The forwarding allowlist gains the preset owner's typed event, and every catalog a preset decides has one place to subscribe: a future per-session surface derived from the composition invalidates on the same signal instead of inventing another. The owner event remains a second publication of a logged fact, so a future switch path that recomposes without logging would go unannounced. `ui-commands` stays soft (the open menu never blanks) while `ui-skill` drops its entry outright, because a skill catalog has no partial-serve mode; a menu opened inside the refetch window shows no skills for that instant rather than the wrong ones.

## Testing

`api-proxy-agent-preset.spec.ts` asserts the committed switch is forwarded once with the session and its new preset; the `ui-agent-preset`, `ui-commands`, and `ui-skill` specs assert that direct Remote subscriptions merge the row or repull only the recomposed session. The `agent-preset-selection` web e2e seeds a project skill and, after the hero chip applies `minimal`, asserts the `/` menu drops `compact`, `plan`, and the skill while keeping the host-plane rows — the assembled-application evidence that the panel follows the composition.

That e2e also stopped reading its staged-pick assertion off the serialized session list: the seeded session records `minimal` too, so the substring answered before the switch had landed. It now addresses the live session by id.

## Related

Reaching the host on a SECOND switch is a separate defect with its own cause and fix: [the session-row identity guard](2026-08-10-session-row-identity-covers-the-preset.md). Until it landed, `agent-preset-selection.e2e.ts` could only exercise the first switch — the invalidation edge here is direction-blind, but the switch it reacts to has to happen.
