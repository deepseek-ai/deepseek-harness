# Agent Note: Forge provider command rules

Status: implemented

English | [中文](2026-11-11-forge-provider-command-rules.zh.md)

## Problem

[Session change request bindings](2026-10-09-session-change-request-bindings.md) recognized `gh` commands inside forge-session, so every new code host's CLI, such as `glab`, meant editing forge-session, and numeric selectors such as `glab mr view 7 -R group/app` need knowledge of that CLI's options and URL forms. Recognition feeds a Session projection, so it must stay deterministic for replay and checkpoints, and a provider enabled after a Session ran its commands should still bind them.

## Decision

Each provider registers a declarative `ForgeCommandRule` with `ctx.forgeSession.registerCommands`: its executable, creation subcommands, reference and raw API request subcommand groups with their own options, change request page path, JSON URL members, and a pure `select` that maps one parsed command to a URL or a read-only lookup. An API request, such as `glab api`, binds only the change request its path names, since its output can list many. [forge-github](../../../../packages/experimental/forge-github/src/commands.ts) registers `gh` and [forge-gitlab](../../../../packages/experimental/forge-gitlab/src/commands.ts) registers `glab`. forge-session keeps the shared parts: the literal shell tokenizer, option parsing, output reading, lookups in the call's shell, and the projection.

The `forgeChangeRequests` state version derives from the recognized rules, `5 × 2^32` plus a hash of the sorted `id@version` pairs, so a checkpoint folded under another rule set is discarded and the log folds again. A registration that changes the set releases the projection and registers it at the new version, then refreshes watchers; the released handle stays readable during the swap. Ending a registration keeps its rule recognized until the service restarts or another rule replaces its id or executable.

## Alternatives considered

**Recognition per CLI inside forge-session.** Every provider change would edit forge-session, and its tests would own other CLIs' option sets.

**Rules on `ForgeProvider`.** forge-session could read rules from `ctx.forge`, but the forge Service Definition would carry a field that only one Consumer uses.

**Rules for later events only.** Folding only events after a registration skips the commands a Session ran before the provider loaded.

**A fixed state version.** Folding with whatever rules are loaded breaks the rule that a restored checkpoint plus suffix replay equals full replay once the rules change.

**Rebuilding on unregistration.** Providers unload before forge-session at shutdown, so every exit would checkpoint a smaller rule set and every start would refold every Session.

**Option parsing in each provider.** The token walk would repeat in every provider.

## Consequences

A new provider rule or a raised rule version refolds every Session once; until a Session is opened again, the Session list shows no cached bindings for it, and re-registration emits no projection change event, so an open Session's summary shows the refolded bindings after a later event. Providers own their rule versions. Unloading a provider at runtime leaves its commands recognized until restart, though they run no lookup; starting without it removes the bindings that only its commands made, while binding records stay. Each start registers the projection without rules and once more after the providers register theirs. The [forge-session README](../../../../packages/experimental/forge-session/README.md#use-this-package) owns the recognition rules.
