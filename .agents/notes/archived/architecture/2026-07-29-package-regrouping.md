# Agent Note: Regroup packages/ by measured clustering

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-package-regrouping.zh.md)

## Problem

The two-level `packages/<group>/<pkg>` hierarchy ([original decision](../../archived/architecture/2026-06-20-package-hierarchy.md)) had drifted since June: 167 packages sat in 42 groups, and several group boundaries no longer matched how the packages actually cluster.

- `ui/` mixed four unrelated planes: the human terminal channel (`tui`), the SDK's JSON-RPC server half (`jsonrpc`, whose peer dependency on `dsh-sdk-protocol` binds it to the SDK wire stack), the human-interaction seams (`user-questions`, `user-approval`, `permission`, `tool-ask-user`, `commands`), and channel-neutral boot glue (`app-boot`). Its own README narrated the mixture instead of stating a role.
- The session family was fragmented across five groups — `session-persistence/`, `session-projection/`, `session-query/`, `session-title/`, and `telemetry/` — although the measured dependency edges tie them together (query → persistence, title → projection, projection → persistence; see [docs/module-graph.md](../../../../docs/module-graph.md)).
- The `timeout/` group for a tool-call guard collided with `util/timeout`, the generic promise utility.
- `cordis/` named its group after the framework every package is built on, so the name discriminated nothing; its single package `tool-cordis` is the runtime self-modification toolset.

The north star for the regrouping: **closely clustered packages share a group.** A cluster is measured — peer-dependency edges and co-change — not thematic. An isolated seam family may stand alone as a small group; the failure mode to avoid is the grab-bag whose name describes no single role.

## Decision

Five regrouping decisions remain current; every other group keeps its prior boundary and contents (the dependency analysis confirmed the capability families — `shell/`, `terminal/`, `code-runtime/`, `sandbox/`, `subprocess/`, `fs/`, `lsp/`, `web/`, `skill/`, and the rest — were already drawn correctly). The original sixth decision collected the SDK project initializer, launcher tooling, and runtime JSON-RPC packages under `scaffold/`; [removing that unreleased toolchain](../simplification/2026-08-11-remove-sdk-project-toolchain.md) deleted the project tooling and moved the surviving runtime trio to `sdk/`. The later [repository naming contract](2026-08-11-repository-naming-contract-and-rename-ledger.md) owns the `shell/`, `terminal/`, and `extensions/` group names and the two package names that this decision deferred.

| Group | Members (folder names) | From |
|---|---|---|
| `session/` | session-persistence, session-persistence-jsonl, session-checkpoint-policy, session-projection, session-projection-cache, session-title, session-title-llm, session-title-first-prompt-llm, session-title-all-prompts-llm, session-telemetry, session-telemetry-otel | `session-persistence/` + `session-projection/` + `session-title/` + `telemetry/` |
| `interaction/` | user-questions, user-approval, permission-presets, tool-ask-user, commands, tui | `ui/` |
| `boot/` | app-boot | `ui/` |
| `guard/` | repeat-tool-reminder, timeout-policy | `guard/` + `timeout/` |
| `extensions/` | tool-cordis | `cordis/` |

- **`session/`** is the durable session data plane: the persistence seam with its JSONL provider and checkpoint policy, the projection fold that serves whole values from that log, log-backed titles, and OTel reporting. The title fold is itself load-bearing for the read side (`session-query` peer-depends on `dsh-session-title`), so titles belong with the data plane, not in a derived-services annex. The plain name is deliberate (prefer names a human would say); the nearby `core/session` package remains the live in-memory service, while this group is the durable family around it. `session-query/` stays a standalone group — the read/tool surface has its own model tools and SQLite FTS backend and is consumed independently of persistence internals.
- **`interaction/`** is the human-collaboration plane plus the terminal channel that answers it: the question/approval seams, the permission preset, the model-facing `ask_user_question` tool, the human-command registry (`plan-mode` and `command-goal` already consume `commands` together with the interaction seams), and `tui` — the interactive channel is the plane's richest provider and consumer (peer edges to `commands` and `user-questions`), and a one-package `tui/` group would spend a top-level name on one plugin.
- **`boot/`** is a role-complete single-package group: the shared boot glue that belongs to no channel and no assembly (consumed by `apps/cli` and test-only Loader drivers).
- **`guard/`** keeps its documented role, loop-hygiene guards, and gains the tool-call timeout enforcer, dissolving the one-package `timeout/` group whose name collided with `util/timeout`.
- **`extensions/`** names the role `cordis/` obscured: the toolset with which the agent inspects and mounts plugins in its own live runtime, and the landing zone for future self-modification packages.

42 groups became 39; the win is clustering correctness and truthful names, not count.

## Later naming decisions

The [repository naming contract](2026-08-11-repository-naming-contract-and-rename-ledger.md) resolves the two names that this move deliberately deferred. `@deepseek-ai/dsh-sdk-jsonrpc-server` names the JSON-RPC server half of the runtime SDK protocol. `@deepseek-ai/dsh-tool-call-timeout-policy` names the exact operation limited by the policy while keeping its `guard/timeout-policy/` home. Their release-blocking `FIXME` markers are removed with those renames.

## What the move touched

The moves landed as pure `git mv` moves, so rename detection carries the history. A group move touched: the moved package's `tsconfig.json` relative `references` and every dependent's entry (including the `apps/cli` project references), the tsconfig aggregate and path maps, group READMEs, the [packages/README.md](../../../../packages/README.md) hierarchy table, the root `AGENTS.md` layout map, regenerated artifacts (`docs/module-graph.md`, path-embedding catalogs, and the lockfile's importer keys), and root-relative `packages/...` citations in prose and gate scripts. Remaining group-path referents (workspace configs, test globs, lint keys) were found mechanically by the acceptance gates failing loud — the repository's own misconfiguration rule.

A group move did not touch: npm names, imports, `cordis.yml` configs, snapshot fixtures, the `pnpm-workspace.yaml`/`tsdown` globs (both `packages/*/*`), or the Python runtime manifest — all reference packages by npm name.

`client/` and `host/` were out of scope and are unchanged.

## Alternatives considered

**Coarse domain buckets** (`exec/` = subprocess+sandbox+bash+pty+code-runtime, `workspace/` = fs+lsp+workspace, `orchestration/` = subagent+workflow+tasks, `knowledge/` = web+skill, `collab/` = plan+todo+goal; ~16 groups). Rejected: the measured graph contradicts the merges. `sandbox` and `subprocess` are shared infrastructure consumed across families (bash ×5, fs ×5, pty, lsp, mcp, and subagent edges), `web` ↔ `skill` have zero edges, and a large bucket reproduces the `ui/` grab-bag at a larger scale.

**Abstract layer names** (`capability/`, `policy/`, `extension/`, `provider/`). Rejected: they describe every plugin equally badly, and a `capability/` bucket would hold ~50 packages.

**A full npm rename sweep** (`dsh-<group>-<pkg>` for every package). Rejected: npm names are flat, so group-prefixing adds churn across imports, configs, and fixtures with no disambiguation gain; targeted FIXME-tracked renames cover the actual collisions.

**Performing the deferred renames inside the reorganization.** Rejected: renames multiply open-PR conflicts and destroy the pure-move review property. The remaining FIXME markers keep them visible release blockers to resolve as small follow-up PRs.

**A two-way session split** (`session-core/` + `session-utils/`). Rejected: query belongs to neither side cleanly, and `session-core` invites confusion with `core/session` (`dsh-session`, the live in-memory service, which stays in `core/`).

**A three-way session split** (`session-store/` + `session-query/` + `session-utils/`). Rejected: `session-utils/` was a negatively-defined annex ("derived, nothing load-bearing depends on it") — the grab-bag shape the north star forbids, and factually wrong besides (`session-query` peer-depends on `dsh-session-title`). The invented compound names also read machine-generated; one plain `session/` group says what a human would say. Query stays standalone regardless: it is an independently consumed read surface with its own tool package and backend.

**Recomposing `ui/` as a single `channels/` group** (tui + jsonrpc + acp + interaction seams + boot). Rejected: the same grab-bag under a new name — those packages serve four planes, `jsonrpc`'s measured cluster is the SDK wire stack, and `acp/` is an automation transport, not a human channel.

**A standalone one-package `tui/` group.** Rejected: `tui` is the interaction plane's primary provider/consumer (peer edges to `commands`, `user-questions`), and a top-level name spent on one plugin adds a group without adding information; it folds into `interaction/`.

**Moving `app-boot` to `apps/`.** Rejected: `apps/` is the assembly tier over the package tier, and `dsh-app-boot` is a package-tier library — placing it in `apps/` would invert the tiers and put a workspace library outside the `packages/*/*` build globs. It stays a package; `boot/` is its role-complete home.

**Moving `tool-cordis` into `core/`.** Rejected: self-modification is its own product seam, expected to grow; the spine stays minimal. The group was first named `self-evolve/`; the name settled on `extensions/` as the plainer term.

**Renaming `context/` to `request-context/`.** Rejected: within this tree the group is unambiguous in situ; the churn is unjustified.

## Consequences

- The five still-current regrouped families hold the listed members; the groups `ui/`, `telemetry/`, `timeout/`, `cordis/`, `session-persistence/`, `session-projection/`, and `session-title/` no longer exist. The regrouping itself changed no npm names. The later SDK toolchain removal intentionally changed the package set and restored `sdk/` as the precise home of the runtime SDK trio. Two FIXME markers pin the remaining deferred renames; a FIXME that later proves wrong must be removed explicitly with rationale, never silently dropped.
- What pins the result: `pnpm run typecheck`, the unit suites of every moved group, `verify-package-paths`, `verify-md-links`, and the corpus-wide translation pairing all pass on the moved tree; the group-scoped test globs in `vitest.snapshot.config.ts` were rewritten with the moves so the suites collect the same test files as before (a fail-open glob would silently drop coverage).
- Every open PR touching a moved file rebases across the move once; rename detection resolves most hunks mechanically.
- Single-package groups remain (`boot/`, `extensions/`, and existing ones such as `acp/`). Accepted deliberately: each is role-complete rather than a fragment of a family, and a truthful small group beats a nominal merge.
- The `sdk/` role folders map explicitly to their npm names in `tsconfig.base.json`; the `server/` mapping resolves to `@deepseek-ai/dsh-sdk-jsonrpc-server`.
- What this gave up: nothing functional — the change is navigational. Muscle memory and external links to old GitHub paths break, which is acceptable pre-release with no external consumers.
