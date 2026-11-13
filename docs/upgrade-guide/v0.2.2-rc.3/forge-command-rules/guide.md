---
kind: upgrade-guide
description: "forge-session no longer recognizes gh commands by itself; forge providers register the commands that bind change requests, and existing forgeChangeRequests checkpoints fold again once."
---

# Forge providers register the commands that bind change requests

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-experimental-forge-session` used to recognize `gh pr create`, `gh pr view`, `gh pr edit`, and `gh pr checkout` by itself. It now recognizes only the commands that forge providers register through `ctx.forgeSession.registerCommands(rule)`: `@deepseek-ai/dsh-experimental-forge-github` registers `gh`, and `@deepseek-ai/dsh-forge-gitlab` registers `glab`. A composition that loads forge-session without forge-github no longer binds pull requests from `gh` commands; `git push` discovery, `track`, and recorded bindings are unchanged. Once a rule registers, each Session's earlier commands bind as well.

The `forgeChangeRequests` projection's state version now derives from the registered rules, so every checkpointed row from an earlier release is discarded once: each Session folds its log again when next read, and until then the Session list shows no cached bindings for it. Bindings are not lost. The `gh` lookup for a number without a host now runs `gh pr view <number> --repo <repository> --json url --jq .url`.

This affects custom `cordis.yml` compositions and code that registers command rules. The forge bundle loads both providers and needs no change.

## Migration

1. In a composition that loads forge-session, also load `@deepseek-ai/dsh-experimental-forge-github` for `gh` commands, `@deepseek-ai/dsh-forge-gitlab` for `glab` commands, or both.
2. To bind the commands of another CLI, register a `ForgeCommandRule` with `ctx.forgeSession.registerCommands` from a plugin that injects `forgeSession`, as [`packages/experimental/forge-github/src/commands.ts`](../../../../packages/experimental/forge-github/src/commands.ts) does, and raise its `version` whenever it classifies any command differently.
3. Open a Session that ran `gh pr create`; the migration works when the forge panel lists the pull request that command printed.
