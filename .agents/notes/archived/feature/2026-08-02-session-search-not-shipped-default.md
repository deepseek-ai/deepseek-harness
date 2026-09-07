# Agent Note: Session search tools are not a shipped default

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-02-session-search-not-shipped-default.zh.md)

## Problem

The [shipped-roster decision](2026-07-31-even-out-shipped-tool-rosters.md) made `tool-session-query` a default row of the shared [`cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml), so the shipped TUI and Web surfaces put the five session-search tools (`session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read`) in front of the model. That contradicted the [model-facing session-query-tools decision](2026-07-24-model-facing-session-query-tools.md), whose opt-in stance the package README recorded as "shipped host compositions do not mount it by default". The default also shipped a prompt section teaching a prior-work search workflow that no user had asked for.

## Decision

The shipped TUI, Web, and headless surfaces do not mount `@deepseek-ai/dsh-tool-session-query`, and no shipped agent preset carries it. The consumer stays opt-in exactly as the model-facing-session-query-tools note describes: the [`session-query` snapshot composition](../../../../snapshots/session/session-query-spill/cordis.yml) remains the mounted reference, and a custom composition can mount the package with the timeout and spill policies.

The `ctx.sessionQuery` service itself stays mounted. `session-query-sqlite` remains a base row — the TUI's `session-reference` consumes it for `/resume` — with its full-text index off by default (`openAt: never`; the [content-search opt-in decision](../architecture/2026-08-13-session-content-search-opt-in.md)), and the Web overlay keeps its in-memory values for deployments that enable content search. Only the model-facing consumer is removed.

## Alternatives considered

- **Remove the `session-query-sqlite` index too** — rejected because `/resume` and the Web content-search box consume `ctx.sessionQuery` directly; those are host features, not model tools, and dropping the provider would break them.
- **Keep the row but disable it in each overlay** — rejected because a disabled base row still ships the dependency and invites a one-line re-enable; the recorded opt-in stance wants the consumer absent from shipped surfaces, with the ACP example as the mount reference.
- **Mount it on the TUI only** — rejected because the shared base is one row set for every surface; a surface-specific mount would reintroduce the roster split the shipped-roster decision removed.

## Consequences

Both surfaces return to the same twenty unconditional tools (plus `glob`/`grep` under ripgrep), and the five session-search schemas and their prompt section leave the default request. The shipped-composition tests on both surfaces pin the smaller catalog, so re-adding session search as a default touches the same tests. Users who want session search mount the consumer from a personal overlay or the ACP example, adding the dependency where they do.
