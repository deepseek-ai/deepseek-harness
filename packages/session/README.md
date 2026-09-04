---
description: "Package map for the durable session data plane: the persistence seam and its backends, checkpoint policy, projections, log-backed titles, and outbound session telemetry."
kind: "package-group"
---

# session/ — durable session data plane

English | [中文](README.zh.md)

## Summary

The session group makes an agent's conversation durable and reusable outside the live loop: the static format chain restores released generations, the persistence seam stores the event log and restores it on resume, the checkpoint policy keeps requests, tool side effects, and completed steps durable before the next action, projections serve whole log-derived values to client carriers, titles name each session from its content, and telemetry reports session activity outbound. Mount the shipped JSONL persistence provider first, then add the checkpoint policy and any projection, title, or telemetry packages the deployment needs. This page maps the group; every package README owns its contract, and `session-query/` is a sibling group whose read/tool surface consumes persistence independently.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group splits into four families: durable storage (persistence seam, backends, checkpoint policy), projections, titles, and telemetry. Each package README owns its contract and configuration.

### Persistence

| Package | Role | ctx key |
|---|---|---|
| [`session-format/`](session-format/README.md) | Pure adjacent-format chain and artifact validation library | library — no ctx key |
| [`session-format-v0-to-v1/`](session-format-v0-to-v1/README.md) | Frozen released-v0 decoder and identity migration into released v1 | library — no ctx key |
| [`session-format-v1-to-v2/`](session-format-v1-to-v2/README.md) | Frozen released-v1 decoder and cardinality-changing Assistant-stream migration into released v2 | library — no ctx key |
| [`session-format-catalog/`](session-format-catalog/README.md) | Generated static catalog of shipped adjacent migrations | library — no ctx key |
| [`session-persistence/`](session-persistence/README.md) | Defines the durable session-storage service and the shared write coordination every backend composes | `ctx.sessionPersistence` |
| [`session-persistence-jsonl/`](session-persistence-jsonl/README.md) | Shipped backend: immutable canonical generation filenames per Session with exclusive successor publication, optionally Zstandard-compressed | registers on `ctx.sessionPersistence` |
| [`session-checkpoint-policy/`](session-checkpoint-policy/README.md) | Makes model requests, top-level tool side effects, and completed steps durable before the next action | wraps `ctx.llm` and `ctx.tools` |
| [`session-log-deepseek/`](session-log-deepseek/README.md) | Uploads the incremental canonical log as optional official DeepSeek request metadata | contributes `dsh_session_log` |

### Projection

| Package | Role | ctx key |
|---|---|---|
| [`session-projection/`](session-projection/README.md) | Defines and drives projection units that fold committed events into whole current values | `ctx.sessionProjections` |
| [`session-projection-cache/`](session-projection-cache/README.md) | Persists projection checkpoints so cold reads skip full log loads | `ctx.sessionProjectionCache` |
| [`session-stats/`](session-stats/README.md) | Serves whole-log conversation counts and wall times through the `sessionStats` unit | registers on `ctx.sessionProjections` |
| [`session-turn-outline/`](session-turn-outline/README.md) | Serves the whole-log turn outline (turn, `turn/start` seq, prompt preview) through the `turnOutline` unit | registers on `ctx.sessionProjections` |

### Titles

| Package | Role | ctx key |
|---|---|---|
| [`session-title/`](session-title/README.md) | Log-backed session titles with a deterministic fallback and one optional provider | `ctx.sessionTitle` |
| [`session-title-llm/`](session-title-llm/README.md) | Shared model-backed title-generation policy for the provider packages | library — no ctx key |
| [`session-title-first-prompt-llm/`](session-title-first-prompt-llm/README.md) | Titles a session from its first eligible human message | registers on `ctx.sessionTitle` |
| [`session-title-all-prompts-llm/`](session-title-all-prompts-llm/README.md) | Titles a session from all eligible human messages | registers on `ctx.sessionTitle` |

### Telemetry

| Package | Role | ctx key |
|---|---|---|
| [`session-telemetry/`](session-telemetry/README.md) | Captures session activity and hands records to a configured reporting backend | `ctx.sessionTelemetry` |
| [`session-telemetry-otel/`](session-telemetry-otel/README.md) | Delivers telemetry through OpenTelemetry logs in `FULL`, `FEEDBACK_ONLY`, or `DISABLED` mode | registers on `ctx.sessionTelemetry` |

Only one title provider may register at a time; without one, the title service keeps its deterministic fallback. The subsystem pages below are the backend-neutral references for each family.

-----

<a id="related-documentation"></a>
## Related documentation

- [Session persistence subsystem](../../docs/subsystems/persistence.md) — backend-neutral service semantics, the flush checkpoint, and crash recovery.
- [Session projections subsystem](../../docs/subsystems/session-projection.md) — the projection unit contract and drive semantics.
- [Session titles subsystem](../../docs/subsystems/session-title.md) — title eligibility, fallback, and provider flow.
- [Session telemetry subsystem](../../docs/subsystems/session-telemetry.md) — capture, redaction, and delivery modes.
- [Session subsystem](../../docs/subsystems/session.md) — the live event log every package in this group persists or derives from.

<a id="dev-note"></a>
## Dev Note

None.
